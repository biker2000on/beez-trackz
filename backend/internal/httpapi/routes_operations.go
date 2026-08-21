package httpapi

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

func (s *Server) mountOperations(r chi.Router) {
	r.Get("/mite-counts", s.miteCountList)
	r.Post("/mite-counts", s.miteCountCreate)
	r.Post("/mite-counts/batch", s.miteCountBatchReplace)
	r.With(s.requireEntityParamRole("mite", true)).
		Patch("/mite-counts/{id}", s.miteCountUpdate)
	r.With(s.requireEntityParamRole("mite", true)).
		Delete("/mite-counts/{id}", s.miteCountDelete)
	r.Post("/treatment-events", s.treatmentEventCreate)
	r.With(s.requireEntityParamRole("treatment", true)).
		Patch("/treatment-events/{id}", s.treatmentEventUpdate)
	r.With(s.requireEntityParamRole("treatment", true)).
		Delete("/treatment-events/{id}", s.treatmentEventDelete)
	r.Post("/queen-events", s.queenEventCreate)
	r.With(s.requireEntityParamRole("queen_event", true)).
		Delete("/queen-events/{id}", s.queenEventDelete)
	r.With(s.requireHiveParamRole(false)).
		Get("/hives/{id}/timeline", s.hiveTimeline)
	r.Get("/analytics/varroa", s.varroaAnalytics)
	r.Get("/analytics/survival", s.survivalAnalytics)
	r.Get("/analytics/yield", s.yieldAnalytics)
	r.Get("/operations/yard-queue", s.yardQueue)
	r.Get("/treatment-products", s.treatmentProductList)
	r.With(s.requireAdmin).Patch("/treatment-products/{id}", s.treatmentProductUpdate)
}

var miteMethods = map[string]bool{
	"alcohol_wash": true,
	"sugar_roll":   true,
	"sticky_board": true,
	"visual":       true,
}

type miteCountPayload struct {
	HiveID       uuid.UUID  `json:"hiveId"`
	InspectionID *uuid.UUID `json:"inspectionId"`
	Date         string     `json:"date"`
	Method       string     `json:"method"`
	MitesCount   int        `json:"mitesCount"`
	SampleSize   *int       `json:"sampleSize"`
	DaysOnBoard  *int       `json:"daysOnBoard"`
	Notes        *string    `json:"notes"`
	Overwrite    bool       `json:"overwrite"`
}

var queenEventTypes = map[string]bool{
	"observed": true, "introduced": true, "superseded": true,
	"missing": true, "dead": true, "requeened": true,
}

func (s *Server) treatmentEventCreate(w http.ResponseWriter, r *http.Request) {
	var req struct {
		HiveID         uuid.UUID  `json:"hiveId"`
		InspectionID   *uuid.UUID `json:"inspectionId"`
		DateApplied    string     `json:"dateApplied"`
		Product        string     `json:"product"`
		Method         *string    `json:"method"`
		DateRemoved    *string    `json:"dateRemoved"`
		Notes          *string    `json:"notes"`
		WithdrawalDays *int       `json:"withdrawalDays"`
	}
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	date, err := parseDate(req.DateApplied)
	if err != nil || req.HiveID == uuid.Nil || strings.TrimSpace(req.Product) == "" {
		writeError(w, http.StatusBadRequest, "hiveId, dateApplied, and product are required")
		return
	}
	if !s.requireHiveRole(w, r, req.HiveID, true) {
		return
	}
	var removed *time.Time
	if req.DateRemoved != nil && *req.DateRemoved != "" {
		v, err := parseDate(*req.DateRemoved)
		if err != nil {
			writeError(w, http.StatusBadRequest, "invalid dateRemoved")
			return
		}
		removed = &v
	}
	days := 0
	if req.WithdrawalDays != nil {
		if *req.WithdrawalDays < 0 {
			writeError(w, http.StatusBadRequest, "withdrawalDays must be zero or greater")
			return
		}
		days = *req.WithdrawalDays
	} else {
		resolved, err := s.resolveWithdrawalDays(r.Context(), req.Product)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "database error")
			return
		}
		days = resolved
	}
	var id uuid.UUID
	err = s.pool.QueryRow(r.Context(), `
		INSERT INTO treatment_events
			(hive_id, inspection_id, date_applied, product, method, date_removed, notes, withdrawal_days)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
		req.HiveID, req.InspectionID, date, strings.TrimSpace(req.Product),
		honeyTrimPtr(req.Method), removed, honeyTrimPtr(req.Notes), days).Scan(&id)
	if err != nil {
		if honeyIsFKViolation(err) {
			writeError(w, http.StatusBadRequest, "invalid hiveId or inspectionId")
			return
		}
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"id": id})
}

// treatmentEventUpdate ends (or re-opens) a treatment. dateRemoved omitted
// keeps the current value; explicit null clears it and re-locks the hive.
func (s *Server) treatmentEventUpdate(w http.ResponseWriter, r *http.Request) {
	id, err := uuidParam(r, "id")
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	var body struct {
		DateRemoved json.RawMessage `json:"dateRemoved"`
		Notes       *string         `json:"notes"`
	}
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	var (
		hiveID         uuid.UUID
		applied        time.Time
		removed        *time.Time
		product        string
		method, notes  *string
		withdrawalDays int
	)
	err = s.pool.QueryRow(r.Context(), `
		SELECT hive_id, date_applied, date_removed, product, method, notes, withdrawal_days
		FROM treatment_events WHERE id = $1 AND deleted_at IS NULL`, id).Scan(
		&hiveID, &applied, &removed, &product, &method, &notes, &withdrawalDays)
	if errors.Is(err, pgx.ErrNoRows) {
		writeError(w, http.StatusNotFound, "treatment event not found")
		return
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	if len(body.DateRemoved) > 0 {
		if string(body.DateRemoved) == "null" {
			removed = nil
		} else {
			var raw string
			if err := json.Unmarshal(body.DateRemoved, &raw); err != nil {
				writeError(w, http.StatusBadRequest, "invalid dateRemoved")
				return
			}
			v, err := parseDate(raw)
			if err != nil {
				writeError(w, http.StatusBadRequest, "invalid dateRemoved")
				return
			}
			if calendarDate(v).Before(calendarDate(applied)) {
				writeError(w, http.StatusBadRequest, "dateRemoved must be on or after dateApplied")
				return
			}
			removed = &v
		}
	}
	if body.Notes != nil {
		notes = honeyTrimPtr(body.Notes)
	}
	if _, err := s.pool.Exec(r.Context(), `
		UPDATE treatment_events SET date_removed = $2, notes = $3 WHERE id = $1`,
		id, removed, notes); err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"id":             id,
		"hiveId":         hiveID,
		"dateApplied":    applied,
		"dateRemoved":    removed,
		"product":        product,
		"method":         method,
		"notes":          notes,
		"withdrawalDays": withdrawalDays,
	})
}

func (s *Server) treatmentEventDelete(w http.ResponseWriter, r *http.Request) {
	deleteSimpleRecord(s, w, r, "treatment_events", "treatment event")
}

func (s *Server) queenEventCreate(w http.ResponseWriter, r *http.Request) {
	var req struct {
		HiveID    uuid.UUID  `json:"hiveId"`
		QueenID   *uuid.UUID `json:"queenId"`
		EventDate string     `json:"eventDate"`
		EventType string     `json:"eventType"`
		Notes     *string    `json:"notes"`
	}
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	date, err := parseDate(req.EventDate)
	if err != nil || req.HiveID == uuid.Nil || !queenEventTypes[req.EventType] {
		writeError(w, http.StatusBadRequest, "hiveId, eventDate, and a valid eventType are required")
		return
	}
	if !s.requireHiveRole(w, r, req.HiveID, true) {
		return
	}
	var id uuid.UUID
	err = s.pool.QueryRow(r.Context(), `
		INSERT INTO queen_events (hive_id, queen_id, event_date, event_type, notes)
		VALUES ($1, $2, $3, $4, $5) RETURNING id`,
		req.HiveID, req.QueenID, date, req.EventType, honeyTrimPtr(req.Notes)).Scan(&id)
	if err != nil {
		if honeyIsFKViolation(err) {
			writeError(w, http.StatusBadRequest, "invalid hiveId or queenId")
			return
		}
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"id": id})
}

func (s *Server) queenEventDelete(w http.ResponseWriter, r *http.Request) {
	deleteSimpleRecord(s, w, r, "queen_events", "queen event")
}

func deleteSimpleRecord(s *Server, w http.ResponseWriter, r *http.Request, table, label string) {
	id, err := uuidParam(r, "id")
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	// table is selected exclusively by internal callers above.
	tag, err := s.pool.Exec(r.Context(), "DELETE FROM "+table+" WHERE id = $1", id)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	if tag.RowsAffected() == 0 {
		writeError(w, http.StatusNotFound, label+" not found")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"success": true})
}

type hiveTimelinePhoto struct {
	ID      uuid.UUID `json:"id"`
	URL     string    `json:"url"`
	Caption *string   `json:"caption"`
}

type hiveTimelineEntry struct {
	ID      uuid.UUID           `json:"id"`
	Type    string              `json:"type"`
	Date    time.Time           `json:"date"`
	Title   string              `json:"title"`
	Details *string             `json:"details"`
	Photos  []hiveTimelinePhoto `json:"photos"`
	Meta    json.RawMessage     `json:"meta"`
}

func (s *Server) hiveTimeline(w http.ResponseWriter, r *http.Request) {
	hiveID, err := uuidParam(r, "id")
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	limit := 200
	if raw := r.URL.Query().Get("limit"); raw != "" {
		if v, err := strconv.Atoi(raw); err == nil && v > 0 && v <= 500 {
			limit = v
		}
	}
	rows, err := s.pool.Query(r.Context(), `
		SELECT event_id, event_type, event_date, title, details, photos, meta
		FROM (
			SELECT i.id AS event_id, 'inspection'::text AS event_type, i.date AS event_date,
				'Inspection'::text AS title,
				COALESCE(i.notes, i.brood_pattern, i.queen_health) AS details,
				COALESCE((
					SELECT jsonb_agg(jsonb_build_object(
						'id', p.id,
						'url', COALESCE(
							CASE WHEN p.medium_key IS NOT NULL AND p.medium_key <> ''
								THEN '/api/v1/photos/file/' || p.medium_key END,
							CASE WHEN p.thumbnail_key IS NOT NULL AND p.thumbnail_key <> ''
								THEN '/api/v1/photos/file/' || p.thumbnail_key END,
							'/api/v1/photos/' || p.id::text || '/original'
						),
						'caption', p.caption
					) ORDER BY p.created_at)
					FROM photos p WHERE p.owner_type = 'inspection' AND p.owner_id = i.id
				), '[]'::jsonb) AS photos,
				jsonb_build_object(
					'queenSeen', i.queen_seen, 'storesHoney', i.stores_honey,
					'storesPollen', i.stores_pollen, 'temperament', i.temperament
				) AS meta
			FROM inspections i WHERE i.hive_id = $1
			UNION ALL
			SELECT f.id, 'feeding', f.date_fed, 'Feeding',
				concat_ws(' · ', replace(f.type::text, '_', ' '),
					f.quantity::text || ' ' || f.quantity_unit::text, f.notes),
				'[]'::jsonb, jsonb_build_object('dateEmpty', f.date_empty)
			FROM feedings f WHERE f.hive_id = $1
			UNION ALL
			SELECT t.id, 'treatment', t.date_applied, 'Treatment: ' || t.product,
				concat_ws(' · ', t.method, t.notes), '[]'::jsonb,
				jsonb_build_object(
					'dateRemoved', t.date_removed,
					'withdrawalDays', t.withdrawal_days,
					'lockoutUntil', CASE WHEN t.date_removed IS NULL THEN NULL
						ELSE (t.date_removed::date + t.withdrawal_days)::date END
				)
			FROM treatment_events t WHERE t.hive_id = $1 AND t.deleted_at IS NULL
			UNION ALL
			SELECT m.id, 'mite_count', m.date, 'Varroa count',
				m.mites_count::text || ' mites via ' || replace(m.method, '_', ' '),
				'[]'::jsonb,
				jsonb_build_object('method', m.method, 'mitesCount', m.mites_count,
					'sampleSize', m.sample_size, 'daysOnBoard', m.days_on_board,
					'mitesPer100', m.mites_per_100, 'mitesPerDay', m.mites_per_day)
			FROM mite_counts m WHERE m.hive_id = $1 AND m.deleted_at IS NULL
			UNION ALL
			SELECT q.id, 'queen_event', q.event_date,
				'Queen ' || replace(q.event_type, '_', ' '), q.notes,
				'[]'::jsonb, '{}'::jsonb
			FROM queen_events q WHERE q.hive_id = $1
			UNION ALL
			SELECT hs.id, 'harvest', hs.date, 'Honey harvest',
				round(hs.calculated_honey_weight::numeric, 2)::text || ' lb', '[]'::jsonb,
				jsonb_build_object('weightLbs', hs.calculated_honey_weight)
			FROM honey_harvests hs WHERE hs.hive_id = $1 AND hs.deleted_at IS NULL
			UNION ALL
			SELECT sp.id, 'split', sp.split_date,
				CASE WHEN sp.parent_hive_id = $1 THEN 'Split created'
					ELSE 'Created from split' END,
				concat_ws(' · ', replace(sp.split_type::text, '-', ' '), sp.notes),
				'[]'::jsonb,
				jsonb_build_object('parentHiveId', sp.parent_hive_id, 'childHiveId', sp.child_hive_id)
			FROM hive_splits sp WHERE sp.parent_hive_id = $1 OR sp.child_hive_id = $1
			UNION ALL
			SELECT lh.id, 'move', lh.date_from, 'Moved to ' || a.name,
				lh.position_label, '[]'::jsonb,
				jsonb_build_object('apiaryId', lh.apiary_id, 'dateTo', lh.date_to)
			FROM hive_location_history lh
			JOIN apiaries a ON a.id = lh.apiary_id
			WHERE lh.hive_id = $1
		) timeline
		ORDER BY event_date DESC
		LIMIT $2`, hiveID, limit)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	defer rows.Close()
	out := make([]hiveTimelineEntry, 0)
	for rows.Next() {
		var item hiveTimelineEntry
		var photosJSON []byte
		if err := rows.Scan(&item.ID, &item.Type, &item.Date, &item.Title,
			&item.Details, &photosJSON, &item.Meta); err != nil {
			writeError(w, http.StatusInternalServerError, "database error")
			return
		}
		item.Photos = []hiveTimelinePhoto{}
		_ = json.Unmarshal(photosJSON, &item.Photos)
		out = append(out, item)
	}
	if rows.Err() != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	writeJSON(w, http.StatusOK, out)
}

func (s *Server) varroaAnalytics(w http.ResponseWriter, r *http.Request) {
	rawHive := strings.TrimSpace(r.URL.Query().Get("hiveId"))
	if rawHive == "" {
		s.varroaFleetAnalytics(w, r)
		return
	}
	hiveID, err := uuid.Parse(rawHive)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid hiveId")
		return
	}
	if !s.requireHiveRole(w, r, hiveID, false) {
		return
	}
	settings := s.loadVarroaSettings(r)
	rows, err := s.pool.Query(r.Context(), `
		SELECT id, hive_id, date, method, mites_count, sample_size, days_on_board,
			mites_per_100, mites_per_day, notes
		FROM mite_counts WHERE hive_id = $1 AND deleted_at IS NULL ORDER BY date`, hiveID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	counts := make([]miteCountJSON, 0)
	var latest *miteCountJSON
	for rows.Next() {
		var row miteCountJSON
		if err := rows.Scan(&row.ID, &row.HiveID, &row.Date, &row.Method, &row.MitesCount,
			&row.SampleSize, &row.DaysOnBoard, &row.MitesPer100, &row.MitesPerDay, &row.Notes); err != nil {
			rows.Close()
			writeError(w, http.StatusInternalServerError, "database error")
			return
		}
		counts = append(counts, row)
		last := row
		latest = &last
	}
	rows.Close()
	if rows.Err() != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}

	paired, err := queryVarroaEfficacy(r.Context(), s.pool, &hiveID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	treatments := make([]map[string]any, 0, len(paired))
	for _, row := range paired {
		treatments = append(treatments, treatmentJSON(row))
	}

	over := false
	if latest != nil {
		over = countOverThreshold(latest.Method, latest.MitesPer100, latest.MitesPerDay, settings)
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"counts":            counts,
		"treatments":        treatments,
		"thresholdPer100":   settings.ThresholdPer100,
		"thresholdPerDay":   settings.ThresholdPerDay,
		"checkIntervalDays": settings.CheckIntervalDays,
		"overThreshold":     over,
		"latest":            latest,
	})
}

func (s *Server) varroaFleetAnalytics(w http.ResponseWriter, r *http.Request) {
	settings := s.loadVarroaSettings(r)
	user := principalFrom(r)
	rows, err := s.pool.Query(r.Context(), `
		SELECT h.id, h.position_label, a.id, a.name,
			m.id, m.date, m.method, m.mites_count, m.sample_size, m.days_on_board,
			m.mites_per_100, m.mites_per_day, m.notes
		FROM hives h
		JOIN apiaries a ON a.id = h.apiary_id
		LEFT JOIN LATERAL (
			SELECT id, date, method, mites_count, sample_size, days_on_board,
				mites_per_100, mites_per_day, notes
			FROM mite_counts
			WHERE hive_id = h.id AND deleted_at IS NULL
			ORDER BY date DESC
			LIMIT 1
		) m ON true
		WHERE NOT h.is_archived
		  AND ($1::boolean OR EXISTS (
			SELECT 1 FROM apiary_memberships membership
			WHERE membership.user_id=$2 AND membership.apiary_id=a.id
		  ))
		ORDER BY a.name, h.position_label`, user.IsAdmin, user.ID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	defer rows.Close()

	hives := make([]map[string]any, 0)
	overCount := 0
	for rows.Next() {
		var hiveID, apiaryID uuid.UUID
		var hiveName, apiaryName string
		var countID *uuid.UUID
		var date *time.Time
		var method *string
		var mitesCount *int
		var sample, daysOnBoard *int
		var per100, perDay *float64
		var notes *string
		if err := rows.Scan(&hiveID, &hiveName, &apiaryID, &apiaryName,
			&countID, &date, &method, &mitesCount, &sample, &daysOnBoard,
			&per100, &perDay, &notes); err != nil {
			writeError(w, http.StatusInternalServerError, "database error")
			return
		}
		over := false
		var last map[string]any
		if countID != nil && method != nil && date != nil && mitesCount != nil {
			over = countOverThreshold(*method, per100, perDay, settings)
			last = map[string]any{
				"id": *countID, "date": *date, "method": *method,
				"mitesCount": *mitesCount, "sampleSize": sample,
				"daysOnBoard": daysOnBoard, "mitesPer100": per100,
				"mitesPerDay": perDay, "notes": notes,
			}
		}
		if over {
			overCount++
		}
		hives = append(hives, map[string]any{
			"hiveId": hiveID, "hiveName": hiveName,
			"apiaryId": apiaryID, "apiaryName": apiaryName,
			"lastCount": last, "overThreshold": over,
		})
	}
	if rows.Err() != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}

	paired, err := queryVarroaEfficacy(r.Context(), s.pool, nil)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	// Fleet efficacy is limited to visible hives; skip treatments the caller
	// cannot see by intersecting with the hive list already loaded.
	visible := make(map[uuid.UUID]struct{}, len(hives))
	for _, hive := range hives {
		visible[hive["hiveId"].(uuid.UUID)] = struct{}{}
	}
	treatments := make([]map[string]any, 0)
	for _, row := range paired {
		if _, ok := visible[row.HiveID]; !ok {
			continue
		}
		treatments = append(treatments, treatmentJSON(row))
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"hives":              hives,
		"overThresholdCount": overCount,
		"treatments":         treatments,
		"thresholdPer100":    settings.ThresholdPer100,
		"thresholdPerDay":    settings.ThresholdPerDay,
		"checkIntervalDays":  settings.CheckIntervalDays,
	})
}

type survivalGroup struct {
	Key           string  `json:"key"`
	Label         string  `json:"label"`
	EnteredWinter int     `json:"enteredWinter"`
	Survived      int     `json:"survived"`
	SurvivalRate  float64 `json:"survivalRate"`
}

type survivalAccumulator struct {
	label    string
	entered  int
	survived int
}

func requestedYear(r *http.Request) int {
	year := time.Now().Year() - 1
	if raw := r.URL.Query().Get("year"); raw != "" {
		if v, err := strconv.Atoi(raw); err == nil && v >= 2000 && v <= 2200 {
			year = v
		}
	}
	return year
}

func (s *Server) survivalAnalytics(w http.ResponseWriter, r *http.Request) {
	year := requestedYear(r)
	winterStart := time.Date(year, time.October, 1, 0, 0, 0, 0, time.UTC)
	survivalDate := time.Date(year+1, time.April, 1, 0, 0, 0, 0, time.UTC)
	rows, err := s.pool.Query(r.Context(), `
		WITH RECURSIVE ancestry AS (
			SELECT q.id AS queen_id, q.id AS ancestor_id, q.parent_queen_id, q.origin::text
			FROM queens q
			UNION ALL
			SELECT a.queen_id, parent.id, parent.parent_queen_id, parent.origin::text
			FROM ancestry a JOIN queens parent ON parent.id = a.parent_queen_id
		), roots AS (
			SELECT DISTINCT ON (queen_id) queen_id, ancestor_id, origin
			FROM ancestry ORDER BY queen_id, parent_queen_id NULLS FIRST
		), current_queen AS (
			SELECT DISTINCT ON (hive_id) hive_id, id
			FROM queens WHERE hive_id IS NOT NULL
			ORDER BY hive_id, introduced_date DESC NULLS LAST, created_at DESC
		)
		SELECT h.id, a.id, a.name, COALESCE(h.stand_id, h.position_label),
			h.installed_date, h.deadout_date,
			roots.ancestor_id, roots.origin
		FROM hives h
		JOIN apiaries a ON a.id = h.apiary_id
		LEFT JOIN current_queen cq ON cq.hive_id = h.id
		LEFT JOIN roots ON roots.queen_id = cq.id
		WHERE (h.installed_date IS NULL OR h.installed_date <= $1)
		  AND ($2::boolean OR EXISTS (
			SELECT 1 FROM apiary_memberships membership
			WHERE membership.user_id=$3 AND membership.apiary_id=a.id
		  ))`,
		winterStart, principalFrom(r).IsAdmin, principalFrom(r).ID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	defer rows.Close()
	apiaries := map[string]*survivalAccumulator{}
	stands := map[string]*survivalAccumulator{}
	queenLines := map[string]*survivalAccumulator{}
	totalEntered, totalSurvived := 0, 0
	for rows.Next() {
		var hiveID, apiaryID uuid.UUID
		var apiaryName, stand string
		var installed, deadout *time.Time
		var rootID *uuid.UUID
		var rootOrigin *string
		if err := rows.Scan(&hiveID, &apiaryID, &apiaryName, &stand, &installed,
			&deadout, &rootID, &rootOrigin); err != nil {
			writeError(w, http.StatusInternalServerError, "database error")
			return
		}
		if deadout != nil && deadout.Before(winterStart) {
			continue
		}
		survived := deadout == nil || !deadout.Before(survivalDate)
		totalEntered++
		if survived {
			totalSurvived++
		}
		addSurvival(apiaries, apiaryID.String(), apiaryName, survived)
		addSurvival(stands, apiaryID.String()+":"+stand, apiaryName+" · "+stand, survived)
		lineKey, lineLabel := "unknown", "Unknown queen line"
		if rootID != nil {
			lineKey = rootID.String()
			origin := "unknown"
			if rootOrigin != nil {
				origin = *rootOrigin
			}
			lineLabel = fmt.Sprintf("%s line · %s", strings.Title(strings.ReplaceAll(origin, "_", " ")), rootID.String()[:8])
		}
		addSurvival(queenLines, lineKey, lineLabel, survived)
	}
	if rows.Err() != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	rate := 0.0
	if totalEntered > 0 {
		rate = float64(totalSurvived) / float64(totalEntered) * 100
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"winterYear": year, "enteredWinter": totalEntered, "survived": totalSurvived,
		"survivalRate": rate, "byApiary": finishSurvival(apiaries),
		"byStand": finishSurvival(stands), "byQueenLine": finishSurvival(queenLines),
	})
}

func addSurvival(groups map[string]*survivalAccumulator, key, label string, survived bool) {
	item := groups[key]
	if item == nil {
		item = &survivalAccumulator{label: label}
		groups[key] = item
	}
	item.entered++
	if survived {
		item.survived++
	}
}

func finishSurvival(groups map[string]*survivalAccumulator) []survivalGroup {
	out := make([]survivalGroup, 0, len(groups))
	for key, item := range groups {
		rate := 0.0
		if item.entered > 0 {
			rate = float64(item.survived) / float64(item.entered) * 100
		}
		out = append(out, survivalGroup{
			Key: key, Label: item.label, EnteredWinter: item.entered,
			Survived: item.survived, SurvivalRate: rate,
		})
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].SurvivalRate == out[j].SurvivalRate {
			return out[i].Label < out[j].Label
		}
		return out[i].SurvivalRate > out[j].SurvivalRate
	})
	return out
}

func (s *Server) yieldAnalytics(w http.ResponseWriter, r *http.Request) {
	year := requestedYear(r)
	rows, err := s.pool.Query(r.Context(), `
		SELECT h.id, h.position_label, a.id, a.name,
			COALESCE(SUM(hh.calculated_honey_weight), 0) AS pounds
		FROM hives h
		JOIN apiaries a ON a.id = h.apiary_id
		LEFT JOIN honey_harvests hh ON hh.hive_id = h.id
			AND EXTRACT(YEAR FROM hh.date)::integer = $1 AND hh.deleted_at IS NULL
		WHERE ($2::boolean OR EXISTS (
			SELECT 1 FROM apiary_memberships membership
			WHERE membership.user_id=$3 AND membership.apiary_id=a.id
		))
		GROUP BY h.id, h.position_label, a.id, a.name
		HAVING COALESCE(SUM(hh.calculated_honey_weight), 0) > 0
		ORDER BY pounds DESC`, year, principalFrom(r).IsAdmin, principalFrom(r).ID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	defer rows.Close()
	hives := make([]map[string]any, 0)
	apiaryTotals := map[uuid.UUID]map[string]any{}
	total := 0.0
	for rows.Next() {
		var hiveID, apiaryID uuid.UUID
		var hiveName, apiaryName string
		var pounds float64
		if err := rows.Scan(&hiveID, &hiveName, &apiaryID, &apiaryName, &pounds); err != nil {
			writeError(w, http.StatusInternalServerError, "database error")
			return
		}
		total += pounds
		hives = append(hives, map[string]any{
			"hiveId": hiveID, "hiveName": hiveName, "apiaryId": apiaryID,
			"apiaryName": apiaryName, "pounds": pounds,
		})
		row := apiaryTotals[apiaryID]
		if row == nil {
			row = map[string]any{"apiaryId": apiaryID, "apiaryName": apiaryName, "pounds": 0.0}
			apiaryTotals[apiaryID] = row
		}
		row["pounds"] = row["pounds"].(float64) + pounds
	}
	apiaries := make([]map[string]any, 0, len(apiaryTotals))
	for _, row := range apiaryTotals {
		apiaries = append(apiaries, row)
	}
	sort.Slice(apiaries, func(i, j int) bool {
		return apiaries[i]["pounds"].(float64) > apiaries[j]["pounds"].(float64)
	})

	yearRows, err := s.pool.Query(r.Context(), `
		SELECT EXTRACT(YEAR FROM harvest.date)::integer,
			SUM(harvest.calculated_honey_weight)
		FROM honey_harvests harvest
		JOIN hives hive ON hive.id=harvest.hive_id
		WHERE harvest.deleted_at IS NULL AND ($1::boolean OR EXISTS (
			SELECT 1 FROM apiary_memberships membership
			WHERE membership.user_id=$2 AND membership.apiary_id=hive.apiary_id
		))
		GROUP BY 1 ORDER BY 1`, principalFrom(r).IsAdmin, principalFrom(r).ID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	defer yearRows.Close()
	byYear := make([]map[string]any, 0)
	for yearRows.Next() {
		var y int
		var pounds float64
		if err := yearRows.Scan(&y, &pounds); err != nil {
			writeError(w, http.StatusInternalServerError, "database error")
			return
		}
		byYear = append(byYear, map[string]any{"year": y, "pounds": pounds})
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"year": year, "totalPounds": total, "byHive": hives,
		"byApiary": apiaries, "byYear": byYear,
	})
}

func (s *Server) treatmentProductList(w http.ResponseWriter, r *http.Request) {
	rows, err := s.pool.Query(r.Context(), `
		SELECT id, name, aliases, withdrawal_days, notes
		FROM treatment_products ORDER BY name`)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	defer rows.Close()
	type product struct {
		ID             uuid.UUID `json:"id"`
		Name           string    `json:"name"`
		Aliases        []string  `json:"aliases"`
		WithdrawalDays int       `json:"withdrawalDays"`
		Notes          *string   `json:"notes"`
	}
	out := make([]product, 0)
	for rows.Next() {
		var item product
		if err := rows.Scan(&item.ID, &item.Name, &item.Aliases, &item.WithdrawalDays, &item.Notes); err != nil {
			writeError(w, http.StatusInternalServerError, "database error")
			return
		}
		if item.Aliases == nil {
			item.Aliases = []string{}
		}
		out = append(out, item)
	}
	if rows.Err() != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	writeJSON(w, http.StatusOK, out)
}

func (s *Server) treatmentProductUpdate(w http.ResponseWriter, r *http.Request) {
	id, err := uuidParam(r, "id")
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	var req struct {
		WithdrawalDays *int `json:"withdrawalDays"`
	}
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if req.WithdrawalDays == nil {
		writeError(w, http.StatusBadRequest, "withdrawalDays is required")
		return
	}
	if *req.WithdrawalDays < 0 {
		writeError(w, http.StatusBadRequest, "withdrawalDays must be zero or greater")
		return
	}
	tag, err := s.pool.Exec(r.Context(), `
		UPDATE treatment_products SET withdrawal_days = $2 WHERE id = $1`,
		id, *req.WithdrawalDays)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	if tag.RowsAffected() == 0 {
		writeError(w, http.StatusNotFound, "treatment product not found")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"success": true})
}

// Make sure the pgx import remains tied to an actual error classification in
// this domain file; callers receive a clean 404 for missing referenced rows.
var _ = pgx.ErrNoRows
