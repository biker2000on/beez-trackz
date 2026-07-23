package httpapi

import (
	"context"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// mountFeedings wires the feeding endpoints.
func (s *Server) mountFeedings(r chi.Router) {
	r.Post("/feedings", s.handleFeedingCreate)
	r.Post("/feedings/bulk", s.handleFeedingsBulk)
	r.Get("/feedings/active", s.handleFeedingsActive)
	r.Post("/feedings/{id}/empty", s.handleFeedingEmpty)
	r.Delete("/feedings/{id}", s.handleFeedingDelete)
	r.Get("/hives/{id}/feedings", s.handleFeedingsForHive)
}

// --- feeding enums (mirror the Postgres enum types for human 400s) ---

var feedingTypes = map[string]bool{
	"sugar_syrup_1to1": true, "sugar_syrup_2to1": true, "dry_sugar": true,
	"pollen_patty": true, "fondant": true, "other": true,
}

var feedingFeederTypes = map[string]bool{
	"entrance": true, "top": true, "frame": true, "baggie": true,
	"bucket": true, "open": true, "other": true,
}

var feedingQuantityUnits = map[string]bool{
	"lbs": true, "oz": true, "quarts": true, "gallons": true,
}

type feedingJSON struct {
	ID           uuid.UUID  `json:"id"`
	HiveID       uuid.UUID  `json:"hiveId"`
	DateFed      time.Time  `json:"dateFed"`
	Type         string     `json:"type"`
	Quantity     float64    `json:"quantity"`
	QuantityUnit string     `json:"quantityUnit"`
	FeederType   *string    `json:"feederType"`
	DateEmpty    *time.Time `json:"dateEmpty"`
	Notes        *string    `json:"notes"`
	CreatedAt    time.Time  `json:"createdAt"`
}

const feedingSelectCols = `id, hive_id, date_fed, type, quantity, quantity_unit,
	feeder_type, date_empty, notes, created_at`

func feedingScan(row pgx.Row) (feedingJSON, error) {
	var v feedingJSON
	err := row.Scan(&v.ID, &v.HiveID, &v.DateFed, &v.Type, &v.Quantity, &v.QuantityUnit,
		&v.FeederType, &v.DateEmpty, &v.Notes, &v.CreatedAt)
	return v, err
}

// feedingFields is the writable feeding column set shared by single + bulk create.
type feedingFields struct {
	HiveID       uuid.UUID
	DateFed      time.Time
	Type         string
	Quantity     float64
	QuantityUnit string
	FeederType   *string
	Notes        *string
}

// feedingInsert is the single insert path for feedings.
func feedingInsert(ctx context.Context, q inspectionQuerier, f feedingFields) (uuid.UUID, error) {
	var id uuid.UUID
	err := q.QueryRow(ctx, `
		INSERT INTO feedings (hive_id, date_fed, type, quantity, quantity_unit, feeder_type, notes)
		VALUES ($1, $2, $3, $4, $5, $6, $7)
		RETURNING id`,
		f.HiveID, f.DateFed, f.Type, f.Quantity, f.QuantityUnit, f.FeederType, f.Notes).Scan(&id)
	return id, err
}

type feedingCreateReq struct {
	HiveID       string   `json:"hiveId"`
	DateFed      string   `json:"dateFed"`
	Type         string   `json:"type"`
	Quantity     *float64 `json:"quantity"`
	QuantityUnit string   `json:"quantityUnit"`
	FeederType   *string  `json:"feederType"`
	Notes        *string  `json:"notes"`
}

// feedingValidate checks the shared required fields; returns a human message or "".
func feedingValidate(req *feedingCreateReq) string {
	switch {
	case strings.TrimSpace(req.DateFed) == "":
		return "Date is required"
	case req.Type == "":
		return "Feed type is required"
	case !feedingTypes[req.Type]:
		return "Invalid feed type"
	case req.Quantity == nil:
		return "Quantity is required"
	case *req.Quantity <= 0:
		return "Quantity must be greater than zero"
	case req.QuantityUnit == "":
		return "Unit is required"
	case !feedingQuantityUnits[req.QuantityUnit]:
		return "Invalid unit"
	}
	if req.FeederType != nil && *req.FeederType != "" && !feedingFeederTypes[*req.FeederType] {
		return "Invalid feeder type"
	}
	return ""
}

// feedingFeederPtr normalizes an optional feeder type: empty → nil.
func feedingFeederPtr(s *string) *string {
	if s == nil || *s == "" {
		return nil
	}
	return s
}

// POST /feedings
func (s *Server) handleFeedingCreate(w http.ResponseWriter, r *http.Request) {
	var req feedingCreateReq
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	hiveID, err := uuid.Parse(req.HiveID)
	if err != nil {
		writeError(w, http.StatusBadRequest, "Hive is required")
		return
	}
	if msg := feedingValidate(&req); msg != "" {
		writeError(w, http.StatusBadRequest, msg)
		return
	}
	dateFed, err := parseDate(req.DateFed)
	if err != nil {
		writeError(w, http.StatusBadRequest, "Invalid date")
		return
	}
	id, err := feedingInsert(r.Context(), s.pool, feedingFields{
		HiveID:       hiveID,
		DateFed:      dateFed,
		Type:         req.Type,
		Quantity:     *req.Quantity,
		QuantityUnit: req.QuantityUnit,
		FeederType:   feedingFeederPtr(req.FeederType),
		Notes:        inspectionTrimPtr(req.Notes),
	})
	if err != nil {
		if inspectionIsFKViolation(err) {
			writeError(w, http.StatusBadRequest, "Hive not found")
			return
		}
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	created, err := feedingScan(s.pool.QueryRow(r.Context(),
		`SELECT `+feedingSelectCols+` FROM feedings WHERE id = $1`, id))
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	writeJSON(w, http.StatusCreated, created)
}

// POST /feedings/bulk {hiveIds[], dateFed, type, quantity, quantityUnit, feederType?, notes?}
func (s *Server) handleFeedingsBulk(w http.ResponseWriter, r *http.Request) {
	var req struct {
		HiveIDs []string `json:"hiveIds"`
		feedingCreateReq
	}
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if len(req.HiveIDs) == 0 {
		writeError(w, http.StatusBadRequest, "Select at least one hive")
		return
	}
	if msg := feedingValidate(&req.feedingCreateReq); msg != "" {
		writeError(w, http.StatusBadRequest, msg)
		return
	}
	dateFed, err := parseDate(req.DateFed)
	if err != nil {
		writeError(w, http.StatusBadRequest, "Invalid date")
		return
	}
	hiveIDs := make([]uuid.UUID, 0, len(req.HiveIDs))
	for _, raw := range req.HiveIDs {
		id, err := uuid.Parse(raw)
		if err != nil {
			writeError(w, http.StatusBadRequest, "invalid hive id: "+raw)
			return
		}
		hiveIDs = append(hiveIDs, id)
	}
	fields := feedingFields{
		DateFed:      dateFed,
		Type:         req.Type,
		Quantity:     *req.Quantity,
		QuantityUnit: req.QuantityUnit,
		FeederType:   feedingFeederPtr(req.FeederType),
		Notes:        inspectionTrimPtr(req.Notes),
	}

	ctx := r.Context()
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	defer func() { _ = tx.Rollback(ctx) }()
	for _, hiveID := range hiveIDs {
		fields.HiveID = hiveID
		if _, err := feedingInsert(ctx, tx, fields); err != nil {
			if inspectionIsFKViolation(err) {
				writeError(w, http.StatusBadRequest, "Hive not found")
				return
			}
			writeError(w, http.StatusInternalServerError, "database error")
			return
		}
	}
	if err := tx.Commit(ctx); err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"success": true, "count": len(hiveIDs)})
}

// POST /feedings/{id}/empty — marks the feeder empty now.
func (s *Server) handleFeedingEmpty(w http.ResponseWriter, r *http.Request) {
	id, err := uuidParam(r, "id")
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	tag, err := s.pool.Exec(r.Context(),
		`UPDATE feedings SET date_empty = now() WHERE id = $1`, id)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	if tag.RowsAffected() == 0 {
		writeError(w, http.StatusNotFound, "Feeding not found")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"success": true})
}

// DELETE /feedings/{id}
func (s *Server) handleFeedingDelete(w http.ResponseWriter, r *http.Request) {
	id, err := uuidParam(r, "id")
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	tag, err := s.pool.Exec(r.Context(), `DELETE FROM feedings WHERE id = $1`, id)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	if tag.RowsAffected() == 0 {
		writeError(w, http.StatusNotFound, "Feeding not found")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"success": true})
}

// GET /hives/{id}/feedings — full rows, date_fed desc.
func (s *Server) handleFeedingsForHive(w http.ResponseWriter, r *http.Request) {
	hiveID, err := uuidParam(r, "id")
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	rows, err := s.pool.Query(r.Context(),
		`SELECT `+feedingSelectCols+` FROM feedings WHERE hive_id = $1 ORDER BY date_fed DESC`,
		hiveID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	defer rows.Close()
	list := []feedingJSON{}
	for rows.Next() {
		v, err := feedingScan(rows)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "database error")
			return
		}
		list = append(list, v)
	}
	if rows.Err() != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	writeJSON(w, http.StatusOK, list)
}

// GET /feedings/active — date_empty null, joined hive + apiary (oldest first,
// matching the legacy dashboard ordering).
func (s *Server) handleFeedingsActive(w http.ResponseWriter, r *http.Request) {
	rows, err := s.pool.Query(r.Context(), `
		SELECT f.id, f.hive_id, f.date_fed, f.type, f.quantity, f.quantity_unit,
		       f.feeder_type, h.position_label, a.name
		FROM feedings f
		JOIN hives h ON h.id = f.hive_id
		JOIN apiaries a ON a.id = h.apiary_id
		WHERE f.date_empty IS NULL
		ORDER BY f.date_fed`)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	defer rows.Close()
	type activeJSON struct {
		ID           uuid.UUID `json:"id"`
		HiveID       uuid.UUID `json:"hiveId"`
		DateFed      time.Time `json:"dateFed"`
		Type         string    `json:"type"`
		Quantity     float64   `json:"quantity"`
		QuantityUnit string    `json:"quantityUnit"`
		FeederType   *string   `json:"feederType"`
		HiveName     string    `json:"hiveName"`
		ApiaryName   string    `json:"apiaryName"`
	}
	list := []activeJSON{}
	for rows.Next() {
		var v activeJSON
		if err := rows.Scan(&v.ID, &v.HiveID, &v.DateFed, &v.Type, &v.Quantity,
			&v.QuantityUnit, &v.FeederType, &v.HiveName, &v.ApiaryName); err != nil {
			writeError(w, http.StatusInternalServerError, "database error")
			return
		}
		list = append(list, v)
	}
	if rows.Err() != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	writeJSON(w, http.StatusOK, list)
}
