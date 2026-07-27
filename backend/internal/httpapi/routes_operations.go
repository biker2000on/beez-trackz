package httpapi

import (
	"encoding/json"
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
	r.Post("/mite-counts", s.miteCountCreate)
	r.With(s.requireEntityParamRole("mite", true)).
		Delete("/mite-counts/{id}", s.miteCountDelete)
	r.Post("/treatment-events", s.treatmentEventCreate)
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
	Notes        *string    `json:"notes"`
}

func (s *Server) miteCountCreate(w http.ResponseWriter, r *http.Request) {
	var req miteCountPayload
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	date, err := parseDate(req.Date)
	if err != nil || req.HiveID == uuid.Nil || !miteMethods[req.Method] ||
		req.MitesCount < 0 || (req.SampleSize != nil && *req.SampleSize <= 0) {
		writeError(w, http.StatusBadRequest, "hiveId, date, method, and a non-negative mite count are required")
		return
	}
	if !s.requireHiveRole(w, r, req.HiveID, true) {
		return
	}
	var id uuid.UUID
	var per100 *float64
	err = s.pool.QueryRow(r.Context(), `
		INSERT INTO mite_counts
			(hive_id, inspection_id, date, method, mites_count, sample_size, notes)
		VALUES ($1, $2, $3, $4, $5, $6, $7)
		ON CONFLICT (inspection_id, method) DO UPDATE SET
			hive_id = EXCLUDED.hive_id, date = EXCLUDED.date, method = EXCLUDED.method,
			mites_count = EXCLUDED.mites_count, sample_size = EXCLUDED.sample_size,
			notes = EXCLUDED.notes
		RETURNING id, mites_per_100`,
		req.HiveID, req.InspectionID, date, req.Method, req.MitesCount,
		req.SampleSize, honeyTrimPtr(req.Notes)).Scan(&id, &per100)
	if err != nil {
		if honeyIsFKViolation(err) {
			writeError(w, http.StatusBadRequest, "invalid hiveId or inspectionId")
			return
		}
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"id": id, "mitesPer100": per100})
}

func (s *Server) miteCountDelete(w http.ResponseWriter, r *http.Request) {
	deleteSimpleRecord(s, w, r, "mite_counts", "mite count")
}

var queenEventTypes = map[string]bool{
	"observed": true, "introduced": true, "superseded": true,
	"missing": true, "dead": true, "requeened": true,
}

func (s *Server) treatmentEventCreate(w http.ResponseWriter, r *http.Request) {
	var req struct {
		HiveID       uuid.UUID  `json:"hiveId"`
		InspectionID *uuid.UUID `json:"inspectionId"`
		DateApplied  string     `json:"dateApplied"`
		Product      string     `json:"product"`
		Method       *string    `json:"method"`
		DateRemoved  *string    `json:"dateRemoved"`
		Notes        *string    `json:"notes"`
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
	var id uuid.UUID
	err = s.pool.QueryRow(r.Context(), `
		INSERT INTO treatment_events
			(hive_id, inspection_id, date_applied, product, method, date_removed, notes)
		VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
		req.HiveID, req.InspectionID, date, strings.TrimSpace(req.Product),
		honeyTrimPtr(req.Method), removed, honeyTrimPtr(req.Notes)).Scan(&id)
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
						'url', '/api/v1/photos/file/' || COALESCE(p.medium_key, p.thumbnail_key, p.original_key),
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
				jsonb_build_object('dateRemoved', t.date_removed)
			FROM treatment_events t WHERE t.hive_id = $1
			UNION ALL
			SELECT m.id, 'mite_count', m.date, 'Varroa count',
				m.mites_count::text || ' mites via ' || replace(m.method, '_', ' '),
				'[]'::jsonb,
				jsonb_build_object('method', m.method, 'mitesCount', m.mites_count,
					'sampleSize', m.sample_size, 'mitesPer100', m.mites_per_100)
			FROM mite_counts m WHERE m.hive_id = $1
			UNION ALL
			SELECT q.id, 'queen_event', q.event_date,
				'Queen ' || replace(q.event_type, '_', ' '), q.notes,
				'[]'::jsonb, '{}'::jsonb
			FROM queen_events q WHERE q.hive_id = $1
			UNION ALL
			SELECT hs.id, 'harvest', hs.date, 'Honey harvest',
				round(hs.calculated_honey_weight::numeric, 2)::text || ' lb', '[]'::jsonb,
				jsonb_build_object('weightLbs', hs.calculated_honey_weight)
			FROM honey_harvests hs WHERE hs.hive_id = $1
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
	hiveID, err := uuid.Parse(r.URL.Query().Get("hiveId"))
	if err != nil {
		writeError(w, http.StatusBadRequest, "hiveId is required")
		return
	}
	if !s.requireHiveRole(w, r, hiveID, false) {
		return
	}
	rows, err := s.pool.Query(r.Context(), `
		SELECT id, date, method, mites_count, sample_size, mites_per_100, notes
		FROM mite_counts WHERE hive_id = $1 ORDER BY date`, hiveID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	counts := make([]map[string]any, 0)
	for rows.Next() {
		var id uuid.UUID
		var date time.Time
		var method string
		var count int
		var sample *int
		var per100 *float64
		var notes *string
		if err := rows.Scan(&id, &date, &method, &count, &sample, &per100, &notes); err != nil {
			rows.Close()
			writeError(w, http.StatusInternalServerError, "database error")
			return
		}
		counts = append(counts, map[string]any{
			"id": id, "date": date, "method": method, "mitesCount": count,
			"sampleSize": sample, "mitesPer100": per100, "notes": notes,
		})
	}
	rows.Close()
	if rows.Err() != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}

	treatmentRows, err := s.pool.Query(r.Context(), `
		SELECT t.id, t.date_applied, t.product, t.method,
			before_count.mites_per_100, after_count.mites_per_100
		FROM treatment_events t
		LEFT JOIN LATERAL (
			SELECT mites_per_100 FROM mite_counts
			WHERE hive_id = t.hive_id AND date <= t.date_applied
				AND mites_per_100 IS NOT NULL
			ORDER BY date DESC LIMIT 1
		) before_count ON true
		LEFT JOIN LATERAL (
			SELECT mites_per_100 FROM mite_counts
			WHERE hive_id = t.hive_id AND date > t.date_applied
				AND mites_per_100 IS NOT NULL
			ORDER BY date LIMIT 1
		) after_count ON true
		WHERE t.hive_id = $1 ORDER BY t.date_applied`, hiveID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	defer treatmentRows.Close()
	treatments := make([]map[string]any, 0)
	for treatmentRows.Next() {
		var id uuid.UUID
		var date time.Time
		var product string
		var method *string
		var before, after *float64
		if err := treatmentRows.Scan(&id, &date, &product, &method, &before, &after); err != nil {
			writeError(w, http.StatusInternalServerError, "database error")
			return
		}
		var efficacy *float64
		if before != nil && after != nil && *before > 0 {
			v := (*before - *after) / *before * 100
			efficacy = &v
		}
		treatments = append(treatments, map[string]any{
			"id": id, "dateApplied": date, "product": product, "method": method,
			"beforeMitesPer100": before, "afterMitesPer100": after,
			"efficacyPercent": efficacy,
		})
	}
	writeJSON(w, http.StatusOK, map[string]any{"counts": counts, "treatments": treatments})
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
			AND EXTRACT(YEAR FROM hh.date)::integer = $1
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
		WHERE ($1::boolean OR EXISTS (
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

// Make sure the pgx import remains tied to an actual error classification in
// this domain file; callers receive a clean 404 for missing referenced rows.
var _ = pgx.ErrNoRows
