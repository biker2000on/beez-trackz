package httpapi

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

// Harvest sessions: an extraction day at one apiary. Per-hive entries record
// super weights (honey = before − after); a true-up records the authoritative
// extracted weight after bottling.

func (s *Server) mountHarvestSessions(r chi.Router) {
	r.Get("/harvest-sessions", s.hsList)
	r.Post("/harvest-sessions", s.hsCreate)
	r.With(s.requireEntityParamRole("harvest_session", false)).
		Get("/harvest-sessions/{id}", s.hsDetail)
	r.With(s.requireEntityParamRole("harvest_session", true)).
		Patch("/harvest-sessions/{id}", s.hsUpdate)
	r.With(s.requireEntityParamRole("harvest_session", true)).
		Post("/harvest-sessions/{id}/entries", s.hsAddEntry)
	r.With(s.requireEntityParamRole("harvest_session", true)).
		Post("/harvest-sessions/{id}/true-up", s.hsTrueUp)
	r.With(s.requireEntityParamRole("harvest_entry", true)).
		Delete("/harvest-entries/{id}", s.hsDeleteEntry)
}

func hsTrimPtr(p *string) *string {
	if p == nil {
		return nil
	}
	v := strings.TrimSpace(*p)
	if v == "" {
		return nil
	}
	return &v
}

func hsIsFKViolation(err error) bool {
	var pgErr *pgconn.PgError
	return errors.As(err, &pgErr) && pgErr.Code == "23503"
}

// GET /harvest-sessions — list with entryCount + calculatedTotal.
func (s *Server) hsList(w http.ResponseWriter, r *http.Request) {
	rows, err := s.pool.Query(r.Context(), `
		SELECT hs.id, hs.date, hs.total_extracted_weight, hs.notes, hs.moisture_pct, a.name,
		       COUNT(hh.id)::int, COALESCE(SUM(hh.calculated_honey_weight), 0)
		FROM harvest_sessions hs
		JOIN apiaries a ON a.id = hs.apiary_id
		LEFT JOIN honey_harvests hh ON hh.session_id = hs.id AND hh.deleted_at IS NULL
		WHERE ($1::boolean OR EXISTS (
			SELECT 1 FROM apiary_memberships membership
			WHERE membership.user_id=$2 AND membership.apiary_id=a.id
		))
		GROUP BY hs.id, a.name
		ORDER BY hs.date DESC`, principalFrom(r).IsAdmin, principalFrom(r).ID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	defer rows.Close()

	type sessionRow struct {
		ID                   uuid.UUID `json:"id"`
		Date                 time.Time `json:"date"`
		TotalExtractedWeight *float64  `json:"totalExtractedWeight"`
		Notes                *string   `json:"notes"`
		MoisturePct          *float64  `json:"moisturePct"`
		ApiaryName           string    `json:"apiaryName"`
		EntryCount           int       `json:"entryCount"`
		CalculatedTotal      float64   `json:"calculatedTotal"`
	}
	out := make([]sessionRow, 0)
	for rows.Next() {
		var row sessionRow
		if err := rows.Scan(&row.ID, &row.Date, &row.TotalExtractedWeight, &row.Notes,
			&row.MoisturePct, &row.ApiaryName, &row.EntryCount, &row.CalculatedTotal); err != nil {
			writeError(w, http.StatusInternalServerError, "database error")
			return
		}
		out = append(out, row)
	}
	if rows.Err() != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	writeJSON(w, http.StatusOK, out)
}

// POST /harvest-sessions {apiaryId, date, notes?}
func (s *Server) hsCreate(w http.ResponseWriter, r *http.Request) {
	var req struct {
		ApiaryID    string   `json:"apiaryId"`
		Date        string   `json:"date"`
		Notes       *string  `json:"notes"`
		MoisturePct *float64 `json:"moisturePct"`
	}
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if req.ApiaryID == "" {
		writeError(w, http.StatusBadRequest, "Apiary is required")
		return
	}
	apiaryID, err := uuid.Parse(req.ApiaryID)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid apiaryId")
		return
	}
	if !s.requireApiaryRole(w, r, apiaryID, true) {
		return
	}
	if req.Date == "" {
		writeError(w, http.StatusBadRequest, "Date is required")
		return
	}
	date, err := parseDate(req.Date)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid date")
		return
	}
	if msg, err := s.refuseHarvestMoisture(r.Context(), req.MoisturePct); err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	} else if msg != "" {
		writeError(w, http.StatusBadRequest, msg)
		return
	}

	var id uuid.UUID
	var createdAt time.Time
	err = s.pool.QueryRow(r.Context(), `
		INSERT INTO harvest_sessions (apiary_id, date, notes, moisture_pct, created_by)
		VALUES ($1, $2, $3, $4, $5)
		RETURNING id, created_at`,
		apiaryID, date, hsTrimPtr(req.Notes), req.MoisturePct, actorID(r)).Scan(&id, &createdAt)
	if err != nil {
		if hsIsFKViolation(err) {
			writeError(w, http.StatusBadRequest, "invalid apiaryId")
			return
		}
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{
		"id":                   id,
		"apiaryId":             apiaryID,
		"date":                 date,
		"totalExtractedWeight": nil,
		"notes":                hsTrimPtr(req.Notes),
		"moisturePct":          req.MoisturePct,
		"createdAt":            createdAt,
	})
}

// GET /harvest-sessions/{id} — session + entries + calculatedTotal + difference.
func (s *Server) hsDetail(w http.ResponseWriter, r *http.Request) {
	id, err := uuidParam(r, "id")
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	ctx := r.Context()

	var (
		apiaryID             uuid.UUID
		date, createdAt      time.Time
		totalExtractedWeight *float64
		notes                *string
		moisturePct          *float64
	)
	err = s.pool.QueryRow(ctx, `
		SELECT apiary_id, date, total_extracted_weight, notes, moisture_pct, created_at
		FROM harvest_sessions WHERE id = $1`, id).
		Scan(&apiaryID, &date, &totalExtractedWeight, &notes, &moisturePct, &createdAt)
	if errors.Is(err, pgx.ErrNoRows) {
		writeError(w, http.StatusNotFound, "session not found")
		return
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}

	type entryRow struct {
		ID                    uuid.UUID `json:"id"`
		HiveID                uuid.UUID `json:"hiveId"`
		SuperWeightBefore     float64   `json:"superWeightBefore"`
		SuperWeightAfter      float64   `json:"superWeightAfter"`
		CalculatedHoneyWeight float64   `json:"calculatedHoneyWeight"`
		DirectWeight          bool      `json:"directWeight"`
		Notes                 *string   `json:"notes"`
		HiveName              string    `json:"hiveName"`
	}
	rows, err := s.pool.Query(ctx, `
		SELECT hh.id, hh.hive_id, hh.super_weight_before, hh.super_weight_after,
		       hh.calculated_honey_weight, hh.direct_weight, hh.notes, h.position_label
		FROM honey_harvests hh
		JOIN hives h ON h.id = hh.hive_id
		WHERE hh.session_id = $1 AND hh.deleted_at IS NULL
		ORDER BY hh.created_at`, id)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	defer rows.Close()
	entries := make([]entryRow, 0)
	calculatedTotal := 0.0
	for rows.Next() {
		var e entryRow
		if err := rows.Scan(&e.ID, &e.HiveID, &e.SuperWeightBefore, &e.SuperWeightAfter,
			&e.CalculatedHoneyWeight, &e.DirectWeight, &e.Notes, &e.HiveName); err != nil {
			writeError(w, http.StatusInternalServerError, "database error")
			return
		}
		calculatedTotal += e.CalculatedHoneyWeight
		entries = append(entries, e)
	}
	if rows.Err() != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}

	// difference = calculated − extracted, null until a true-up records a
	// non-zero extracted weight (matches legacy truthiness check).
	var difference *float64
	if totalExtractedWeight != nil && *totalExtractedWeight != 0 {
		d := calculatedTotal - *totalExtractedWeight
		difference = &d
	}

	// Every true-up keeps the value it replaced, so a correction is auditable
	// instead of silently overwriting the authoritative weight.
	trueUps, err := s.hsTrueUpHistory(ctx, id)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"id":                   id,
		"apiaryId":             apiaryID,
		"date":                 date,
		"totalExtractedWeight": totalExtractedWeight,
		"notes":                notes,
		"moisturePct":          moisturePct,
		"createdAt":            createdAt,
		"entries":              entries,
		"calculatedTotal":      calculatedTotal,
		"difference":           difference,
		"trueUpHistory":        trueUps,
	})
}

// PATCH /harvest-sessions/{id} {moisturePct?, notes?}
func (s *Server) hsUpdate(w http.ResponseWriter, r *http.Request) {
	id, err := uuidParam(r, "id")
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	var req struct {
		MoisturePct *float64 `json:"moisturePct"`
		Notes       *string  `json:"notes"`
	}
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if req.MoisturePct == nil && req.Notes == nil {
		writeError(w, http.StatusBadRequest, "moisturePct or notes is required")
		return
	}
	if msg, err := s.refuseHarvestMoisture(r.Context(), req.MoisturePct); err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	} else if msg != "" {
		writeError(w, http.StatusBadRequest, msg)
		return
	}
	tag, err := s.pool.Exec(r.Context(), `
		UPDATE harvest_sessions
		SET moisture_pct = COALESCE($2, moisture_pct),
		    notes = COALESCE($3, notes)
		WHERE id = $1`, id, req.MoisturePct, hsTrimPtr(req.Notes))
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	if tag.RowsAffected() == 0 {
		writeError(w, http.StatusNotFound, "session not found")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"success": true})
}

func (s *Server) hsTrueUpHistory(ctx context.Context, sessionID uuid.UUID) ([]map[string]any, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT t.id, t.previous_weight_lbs, t.new_weight_lbs, t.reason,
			t.created_at, u.display_name
		FROM harvest_session_true_ups t
		LEFT JOIN app_users u ON u.id = t.created_by
		WHERE t.session_id = $1
		ORDER BY t.created_at DESC`, sessionID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]map[string]any, 0)
	for rows.Next() {
		var id uuid.UUID
		var previous *float64
		var next float64
		var reason, actor *string
		var createdAt time.Time
		if err := rows.Scan(&id, &previous, &next, &reason, &createdAt, &actor); err != nil {
			return nil, err
		}
		out = append(out, map[string]any{
			"id": id, "previousWeightLbs": previous, "newWeightLbs": next,
			"reason": reason, "recordedAt": createdAt, "recordedBy": actor,
		})
	}
	return out, rows.Err()
}

// hsEntryReq is one hive line of a harvest-entry submission. A line carries
// either a super-weight pair (honey = before − after) or a directly measured
// harvested weight — never both.
type hsEntryReq struct {
	HiveID            string   `json:"hiveId"`
	SuperWeightBefore *float64 `json:"superWeightBefore"`
	SuperWeightAfter  *float64 `json:"superWeightAfter"`
	HarvestedWeight   *float64 `json:"harvestedWeight"`
	Notes             *string  `json:"notes"`
}

// hsEntryWeights resolves a line to (before, after, honey, direct) or a
// user-facing validation message.
func hsEntryWeights(entry hsEntryReq) (before, after, honey float64, direct bool, msg string) {
	hasPair := entry.SuperWeightBefore != nil || entry.SuperWeightAfter != nil
	switch {
	case entry.HarvestedWeight != nil && hasPair:
		return 0, 0, 0, false, "Enter either super weights or a harvested weight, not both"
	case entry.HarvestedWeight != nil:
		if *entry.HarvestedWeight <= 0 {
			return 0, 0, 0, false, "Harvested weight must be greater than zero"
		}
		return *entry.HarvestedWeight, 0, *entry.HarvestedWeight, true, ""
	case entry.SuperWeightBefore == nil || entry.SuperWeightAfter == nil:
		return 0, 0, 0, false, "Both super weights are required"
	default:
		honey = *entry.SuperWeightBefore - *entry.SuperWeightAfter
		if honey < 0 {
			return 0, 0, 0, false, "Super weight before must be greater than super weight after"
		}
		return *entry.SuperWeightBefore, *entry.SuperWeightAfter, honey, false, ""
	}
}

// POST /harvest-sessions/{id}/entries
//
// Accepts a batch — {entries: [{hiveId, superWeightBefore, superWeightAfter |
// harvestedWeight, notes?}, ...]} — saved in one transaction so a walkthrough
// of the whole yard is one operation. The legacy single-entry body (the same
// fields at the top level) still works and returns the legacy shape.
func (s *Server) hsAddEntry(w http.ResponseWriter, r *http.Request) {
	sessionID, err := uuidParam(r, "id")
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	var req struct {
		hsEntryReq
		Entries []hsEntryReq `json:"entries"`
	}
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	batch := req.Entries != nil
	entries := req.Entries
	if !batch {
		entries = []hsEntryReq{req.hsEntryReq}
	}
	if len(entries) == 0 {
		writeError(w, http.StatusBadRequest, "Add at least one hive entry")
		return
	}

	ctx := r.Context()
	var sessionDate time.Time
	var sessionApiaryID uuid.UUID
	var totalExtractedWeight *float64
	err = s.pool.QueryRow(ctx, `
		SELECT date, apiary_id, total_extracted_weight
		FROM harvest_sessions WHERE id = $1`, sessionID).
		Scan(&sessionDate, &sessionApiaryID, &totalExtractedWeight)
	if errors.Is(err, pgx.ErrNoRows) {
		writeError(w, http.StatusNotFound, "Session not found")
		return
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	// A trued-up session is finalized: its extracted weight is authoritative,
	// so a new entry would be silently ignored by every total. Refuse rather
	// than accept a record that changes nothing.
	if totalExtractedWeight != nil && *totalExtractedWeight != 0 {
		writeError(w, http.StatusConflict,
			"This session is finalized by a true-up; adjust the true-up instead of adding entries")
		return
	}

	type resolvedEntry struct {
		hiveID        uuid.UUID
		before, after float64
		honey         float64
		direct        bool
		notes         *string
	}
	resolved := make([]resolvedEntry, 0, len(entries))
	for i, entry := range entries {
		lineName := fmt.Sprintf("Entry %d: ", i+1)
		if !batch {
			lineName = ""
		}
		if entry.HiveID == "" {
			writeError(w, http.StatusBadRequest, lineName+"Hive is required")
			return
		}
		hiveID, err := uuid.Parse(entry.HiveID)
		if err != nil {
			writeError(w, http.StatusBadRequest, lineName+"invalid hiveId")
			return
		}
		before, after, honey, direct, msg := hsEntryWeights(entry)
		if msg != "" {
			writeError(w, http.StatusBadRequest, lineName+msg)
			return
		}
		var hiveApiaryID uuid.UUID
		if err := s.pool.QueryRow(ctx,
			`SELECT apiary_id FROM hives WHERE id=$1`, hiveID).Scan(&hiveApiaryID); err != nil {
			writeError(w, http.StatusBadRequest, lineName+"invalid hiveId")
			return
		}
		if hiveApiaryID != sessionApiaryID {
			writeError(w, http.StatusBadRequest,
				lineName+"hive must belong to the harvest session apiary")
			return
		}
		if msg, err := refuseHiveHarvest(ctx, s.pool, hiveID, sessionDate); err != nil {
			writeError(w, http.StatusInternalServerError, "database error")
			return
		} else if msg != "" {
			writeError(w, http.StatusConflict, lineName+msg)
			return
		}
		resolved = append(resolved, resolvedEntry{
			hiveID: hiveID, before: before, after: after,
			honey: honey, direct: direct, notes: hsTrimPtr(entry.Notes),
		})
	}

	tx, err := s.pool.Begin(ctx)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	defer tx.Rollback(ctx)
	actor := actorID(r)
	created := make([]map[string]any, 0, len(resolved))
	for _, entry := range resolved {
		var id uuid.UUID
		err = tx.QueryRow(ctx, `
			INSERT INTO honey_harvests
				(session_id, hive_id, date, super_weight_before, super_weight_after,
				 calculated_honey_weight, direct_weight, notes, created_by)
			VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
			RETURNING id`,
			sessionID, entry.hiveID, sessionDate, entry.before, entry.after,
			entry.honey, entry.direct, entry.notes, actor).Scan(&id)
		if err != nil {
			if hsIsFKViolation(err) {
				writeError(w, http.StatusBadRequest, "invalid hiveId")
				return
			}
			writeError(w, http.StatusInternalServerError, "database error")
			return
		}
		created = append(created, map[string]any{
			"id":                    id,
			"sessionId":             sessionID,
			"hiveId":                entry.hiveID,
			"date":                  sessionDate,
			"superWeightBefore":     entry.before,
			"superWeightAfter":      entry.after,
			"calculatedHoneyWeight": entry.honey,
			"directWeight":          entry.direct,
			"notes":                 entry.notes,
		})
	}
	if err := tx.Commit(ctx); err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	if !batch {
		writeJSON(w, http.StatusCreated, created[0])
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{
		"entries": created, "count": len(created),
	})
}

// POST /harvest-sessions/{id}/true-up {totalExtractedWeight, reason?}
//
// The true-up sets the authoritative extracted weight. It used to overwrite the
// previous value with no record of what it replaced, and accepted negatives.
// The prior value is now written to harvest_session_true_ups first, inside the
// same transaction, and negatives are rejected.
func (s *Server) hsTrueUp(w http.ResponseWriter, r *http.Request) {
	id, err := uuidParam(r, "id")
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	var req struct {
		TotalExtractedWeight *float64 `json:"totalExtractedWeight"`
		Reason               *string  `json:"reason"`
	}
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if req.TotalExtractedWeight == nil {
		writeError(w, http.StatusBadRequest, "Total weight is required")
		return
	}
	if *req.TotalExtractedWeight < 0 {
		writeError(w, http.StatusBadRequest, "Total weight must be zero or greater")
		return
	}
	// The bulk formula treats a stored 0 as "no true-up" (NULLIF) and falls
	// back to the per-entry sum, so a zero true-up would silently not stick.
	if *req.TotalExtractedWeight == 0 {
		writeError(w, http.StatusBadRequest,
			"A true-up of exactly 0 lbs cannot be recorded; delete the session's harvest entries instead")
		return
	}

	ctx := r.Context()
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	defer tx.Rollback(ctx)

	var previous *float64
	if err := tx.QueryRow(ctx,
		`SELECT total_extracted_weight FROM harvest_sessions WHERE id = $1 FOR UPDATE`, id).
		Scan(&previous); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			writeError(w, http.StatusNotFound, "session not found")
			return
		}
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}

	// The extracted weight feeds TotalHarvestedLbs directly, so shrinking it
	// is a bulk withdrawal: it must hold the bulk advisory lock like every
	// other bulk-affecting writer and cannot take back pounds that were
	// already jarred or used.
	bulk, err := honeyLockBulk(ctx, tx)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	var entrySum float64
	if err := tx.QueryRow(ctx, `
		SELECT COALESCE(SUM(calculated_honey_weight), 0)
		FROM honey_harvests WHERE session_id = $1 AND deleted_at IS NULL`, id).
		Scan(&entrySum); err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	oldContribution := entrySum
	if previous != nil && *previous != 0 {
		oldContribution = *previous
	}
	if delta := *req.TotalExtractedWeight - oldContribution; delta < 0 &&
		bulk.BulkOnHandLbs+delta < -honeyPoundTolerance {
		writeError(w, http.StatusBadRequest, fmt.Sprintf(
			"True-up would remove %.2f lbs from bulk honey but only %.2f lbs remain unjarred",
			-delta, bulk.BulkOnHandLbs))
		return
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO harvest_session_true_ups
			(session_id, previous_weight_lbs, new_weight_lbs, reason, created_by)
		VALUES ($1,$2,$3,$4,$5)`,
		id, previous, *req.TotalExtractedWeight, hsTrimPtr(req.Reason), actorID(r)); err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	if _, err := tx.Exec(ctx,
		`UPDATE harvest_sessions SET total_extracted_weight = $1 WHERE id = $2`,
		*req.TotalExtractedWeight, id); err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	if err := tx.Commit(ctx); err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"success":              true,
		"previousWeightLbs":    previous,
		"totalExtractedWeight": *req.TotalExtractedWeight,
	})
}

// DELETE /harvest-entries/{id} SOFT-deletes. The row keeps the actor, the time,
// and an optional reason, and is excluded from every listing and aggregate.
//
// Optional body: {"reason": "..."}.
func (s *Server) hsDeleteEntry(w http.ResponseWriter, r *http.Request) {
	id, err := uuidParam(r, "id")
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	var req struct {
		Reason *string `json:"reason"`
	}
	_ = decodeJSON(r, &req)

	ctx := r.Context()
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	defer tx.Rollback(ctx)

	// Deleting an entry shrinks TotalHarvestedLbs unless the session has an
	// authoritative trued-up weight, so it is a bulk withdrawal too: hold the
	// bulk advisory lock and refuse to remove pounds that were already jarred.
	var weight float64
	var countsTowardBulk bool
	err = tx.QueryRow(ctx, `
		SELECT hh.calculated_honey_weight,
		       hh.session_id IS NULL OR COALESCE(hs.total_extracted_weight, 0) = 0
		FROM honey_harvests hh
		LEFT JOIN harvest_sessions hs ON hs.id = hh.session_id
		WHERE hh.id = $1 AND hh.deleted_at IS NULL
		FOR UPDATE OF hh`, id).Scan(&weight, &countsTowardBulk)
	if errors.Is(err, pgx.ErrNoRows) {
		writeError(w, http.StatusNotFound, "entry not found")
		return
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	if countsTowardBulk && weight > 0 {
		bulk, err := honeyLockBulk(ctx, tx)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "database error")
			return
		}
		if bulk.BulkOnHandLbs-weight < -honeyPoundTolerance {
			writeError(w, http.StatusBadRequest, fmt.Sprintf(
				"Deleting this entry would remove %.2f lbs from bulk honey but only %.2f lbs remain unjarred",
				weight, bulk.BulkOnHandLbs))
			return
		}
	}

	if _, err := tx.Exec(ctx, `
		UPDATE honey_harvests
		SET deleted_at=now(), deleted_by=$2, deletion_reason=$3
		WHERE id = $1 AND deleted_at IS NULL`,
		id, actorID(r), hsTrimPtr(req.Reason)); err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	if err := tx.Commit(ctx); err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"success": true, "softDeleted": true})
}
