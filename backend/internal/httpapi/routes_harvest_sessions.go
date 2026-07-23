package httpapi

import (
	"errors"
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
	r.Get("/harvest-sessions/{id}", s.hsDetail)
	r.Post("/harvest-sessions/{id}/entries", s.hsAddEntry)
	r.Post("/harvest-sessions/{id}/true-up", s.hsTrueUp)
	r.Delete("/harvest-entries/{id}", s.hsDeleteEntry)
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
		SELECT hs.id, hs.date, hs.total_extracted_weight, hs.notes, a.name,
		       COUNT(hh.id)::int, COALESCE(SUM(hh.calculated_honey_weight), 0)
		FROM harvest_sessions hs
		JOIN apiaries a ON a.id = hs.apiary_id
		LEFT JOIN honey_harvests hh ON hh.session_id = hs.id
		GROUP BY hs.id, a.name
		ORDER BY hs.date DESC`)
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
		ApiaryName           string    `json:"apiaryName"`
		EntryCount           int       `json:"entryCount"`
		CalculatedTotal      float64   `json:"calculatedTotal"`
	}
	out := make([]sessionRow, 0)
	for rows.Next() {
		var row sessionRow
		if err := rows.Scan(&row.ID, &row.Date, &row.TotalExtractedWeight, &row.Notes,
			&row.ApiaryName, &row.EntryCount, &row.CalculatedTotal); err != nil {
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
		ApiaryID string  `json:"apiaryId"`
		Date     string  `json:"date"`
		Notes    *string `json:"notes"`
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
	if req.Date == "" {
		writeError(w, http.StatusBadRequest, "Date is required")
		return
	}
	date, err := parseDate(req.Date)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid date")
		return
	}

	var id uuid.UUID
	var createdAt time.Time
	err = s.pool.QueryRow(r.Context(), `
		INSERT INTO harvest_sessions (apiary_id, date, notes)
		VALUES ($1, $2, $3)
		RETURNING id, created_at`,
		apiaryID, date, hsTrimPtr(req.Notes)).Scan(&id, &createdAt)
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
	)
	err = s.pool.QueryRow(ctx, `
		SELECT apiary_id, date, total_extracted_weight, notes, created_at
		FROM harvest_sessions WHERE id = $1`, id).
		Scan(&apiaryID, &date, &totalExtractedWeight, &notes, &createdAt)
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
		Notes                 *string   `json:"notes"`
		HiveName              string    `json:"hiveName"`
	}
	rows, err := s.pool.Query(ctx, `
		SELECT hh.id, hh.hive_id, hh.super_weight_before, hh.super_weight_after,
		       hh.calculated_honey_weight, hh.notes, h.position_label
		FROM honey_harvests hh
		JOIN hives h ON h.id = hh.hive_id
		WHERE hh.session_id = $1
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
			&e.CalculatedHoneyWeight, &e.Notes, &e.HiveName); err != nil {
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
	writeJSON(w, http.StatusOK, map[string]any{
		"id":                   id,
		"apiaryId":             apiaryID,
		"date":                 date,
		"totalExtractedWeight": totalExtractedWeight,
		"notes":                notes,
		"createdAt":            createdAt,
		"entries":              entries,
		"calculatedTotal":      calculatedTotal,
		"difference":           difference,
	})
}

// POST /harvest-sessions/{id}/entries {hiveId, superWeightBefore, superWeightAfter, notes?}
func (s *Server) hsAddEntry(w http.ResponseWriter, r *http.Request) {
	sessionID, err := uuidParam(r, "id")
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	var req struct {
		HiveID            string   `json:"hiveId"`
		SuperWeightBefore *float64 `json:"superWeightBefore"`
		SuperWeightAfter  *float64 `json:"superWeightAfter"`
		Notes             *string  `json:"notes"`
	}
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if req.HiveID == "" {
		writeError(w, http.StatusBadRequest, "Hive is required")
		return
	}
	hiveID, err := uuid.Parse(req.HiveID)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid hiveId")
		return
	}
	if req.SuperWeightBefore == nil || req.SuperWeightAfter == nil {
		writeError(w, http.StatusBadRequest, "Both weights are required")
		return
	}
	honeyWeight := *req.SuperWeightBefore - *req.SuperWeightAfter
	if honeyWeight < 0 {
		writeError(w, http.StatusBadRequest, "Weight before must be greater than weight after")
		return
	}

	ctx := r.Context()
	var sessionDate time.Time
	err = s.pool.QueryRow(ctx, `SELECT date FROM harvest_sessions WHERE id = $1`, sessionID).
		Scan(&sessionDate)
	if errors.Is(err, pgx.ErrNoRows) {
		writeError(w, http.StatusNotFound, "Session not found")
		return
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}

	var id uuid.UUID
	err = s.pool.QueryRow(ctx, `
		INSERT INTO honey_harvests (session_id, hive_id, date, super_weight_before, super_weight_after, calculated_honey_weight, notes)
		VALUES ($1, $2, $3, $4, $5, $6, $7)
		RETURNING id`,
		sessionID, hiveID, sessionDate, *req.SuperWeightBefore, *req.SuperWeightAfter,
		honeyWeight, hsTrimPtr(req.Notes)).Scan(&id)
	if err != nil {
		if hsIsFKViolation(err) {
			writeError(w, http.StatusBadRequest, "invalid hiveId")
			return
		}
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{
		"id":                    id,
		"sessionId":             sessionID,
		"hiveId":                hiveID,
		"date":                  sessionDate,
		"superWeightBefore":     *req.SuperWeightBefore,
		"superWeightAfter":      *req.SuperWeightAfter,
		"calculatedHoneyWeight": honeyWeight,
		"notes":                 hsTrimPtr(req.Notes),
	})
}

// POST /harvest-sessions/{id}/true-up {totalExtractedWeight}
func (s *Server) hsTrueUp(w http.ResponseWriter, r *http.Request) {
	id, err := uuidParam(r, "id")
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	var req struct {
		TotalExtractedWeight *float64 `json:"totalExtractedWeight"`
	}
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if req.TotalExtractedWeight == nil {
		writeError(w, http.StatusBadRequest, "Total weight is required")
		return
	}
	tag, err := s.pool.Exec(r.Context(),
		`UPDATE harvest_sessions SET total_extracted_weight = $1 WHERE id = $2`,
		*req.TotalExtractedWeight, id)
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

// DELETE /harvest-entries/{id}
func (s *Server) hsDeleteEntry(w http.ResponseWriter, r *http.Request) {
	id, err := uuidParam(r, "id")
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	tag, err := s.pool.Exec(r.Context(), `DELETE FROM honey_harvests WHERE id = $1`, id)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	if tag.RowsAffected() == 0 {
		writeError(w, http.StatusNotFound, "entry not found")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"success": true})
}
