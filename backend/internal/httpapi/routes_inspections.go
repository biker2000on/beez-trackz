package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

// mountInspections wires the inspection CRUD + bulk endpoints.
func (s *Server) mountInspections(r chi.Router) {
	r.Post("/inspections", s.handleInspectionCreate)
	r.Get("/inspections/recent", s.handleInspectionsRecent)
	r.Post("/inspections/bulk", s.handleInspectionsBulk)
	r.Get("/inspections/{id}", s.handleInspectionGet)
	r.Put("/inspections/{id}", s.handleInspectionUpdate)
	r.Delete("/inspections/{id}", s.handleInspectionDelete)
	r.Get("/hives/{id}/inspections", s.handleInspectionsForHive)
}

// --- shared helpers (inspection-prefixed to avoid collisions in package) ---

// inspectionQuerier is satisfied by both *pgxpool.Pool and pgx.Tx so the
// insert/update write path is shared between CRUD, bulk, and future sync
// endpoints.
type inspectionQuerier interface {
	Exec(ctx context.Context, sql string, args ...any) (pgconn.CommandTag, error)
	QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
	Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error)
}

// inspectionTrimPtr trims an optional string; empty → nil (legacy `?.trim() || null`).
func inspectionTrimPtr(s *string) *string {
	if s == nil {
		return nil
	}
	t := strings.TrimSpace(*s)
	if t == "" {
		return nil
	}
	return &t
}

// inspectionIsFKViolation reports a Postgres foreign-key violation (23503),
// used to turn "referenced hive does not exist" into a 400 instead of a 500.
func inspectionIsFKViolation(err error) bool {
	var pgErr *pgconn.PgError
	return errors.As(err, &pgErr) && pgErr.Code == "23503"
}

type inspectionPest struct {
	Type  string `json:"type"`
	Count *int   `json:"count,omitempty"`
}

type inspectionTreatment struct {
	Product string  `json:"product"`
	Method  *string `json:"method,omitempty"`
}

// inspectionFields is the full set of writable inspection columns.
type inspectionFields struct {
	HiveID        uuid.UUID
	Date          time.Time
	InspectorName *string
	QueenSeen     *bool
	QueenHealth   *string
	BroodPattern  *string
	StoresHoney   *int
	StoresPollen  *int
	Temperament   *int
	Pests         []byte // JSON array or nil
	Treatments    []byte // JSON array or nil
	Notes         *string
	SourceMedia   []byte // JSON object or nil (passthrough)
}

// inspectionInsert is THE single insert path for inspections (CRUD, bulk, and
// future offline-sync endpoints all go through here).
func inspectionInsert(ctx context.Context, q inspectionQuerier, f inspectionFields) (uuid.UUID, error) {
	var id uuid.UUID
	err := q.QueryRow(ctx, `
		INSERT INTO inspections
			(hive_id, date, inspector_name, queen_seen, queen_health, brood_pattern,
			 stores_honey, stores_pollen, temperament, pests, treatments, notes, source_media)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
		RETURNING id`,
		f.HiveID, f.Date, f.InspectorName, f.QueenSeen, f.QueenHealth, f.BroodPattern,
		f.StoresHoney, f.StoresPollen, f.Temperament, f.Pests, f.Treatments, f.Notes,
		f.SourceMedia).Scan(&id)
	return id, err
}

// inspectionUpdate is THE single update path for inspections. cols are column
// names (trusted, package-internal), vals the matching values. updated_at bumps
// via the table trigger. Returns pgx.ErrNoRows when the id does not exist.
func inspectionUpdate(ctx context.Context, q inspectionQuerier, id uuid.UUID, cols []string, vals []any) error {
	if len(cols) == 0 {
		return nil
	}
	sets := make([]string, len(cols))
	for i, c := range cols {
		sets[i] = fmt.Sprintf("%s = $%d", c, i+2)
	}
	args := append([]any{id}, vals...)
	tag, err := q.Exec(ctx,
		"UPDATE inspections SET "+strings.Join(sets, ", ")+" WHERE id = $1", args...)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return pgx.ErrNoRows
	}
	return nil
}

// inspectionJSON mirrors the legacy drizzle row shape (camelCase).
type inspectionJSON struct {
	ID            uuid.UUID `json:"id"`
	HiveID        uuid.UUID `json:"hiveId"`
	Date          time.Time `json:"date"`
	InspectorName *string   `json:"inspectorName"`
	QueenSeen     *bool     `json:"queenSeen"`
	QueenHealth   *string   `json:"queenHealth"`
	BroodPattern  *string   `json:"broodPattern"`
	StoresHoney   *int      `json:"storesHoney"`
	StoresPollen  *int      `json:"storesPollen"`
	Temperament   *int      `json:"temperament"`
	Pests         any       `json:"pests"`
	Treatments    any       `json:"treatments"`
	Notes         *string   `json:"notes"`
	SourceMedia   any       `json:"sourceMedia"`
	CreatedAt     time.Time `json:"createdAt"`
	UpdatedAt     time.Time `json:"updatedAt"`
}

const inspectionSelectCols = `id, hive_id, date, inspector_name, queen_seen, queen_health,
	brood_pattern, stores_honey, stores_pollen, temperament, pests, treatments, notes,
	source_media, created_at, updated_at`

func inspectionScan(row pgx.Row) (inspectionJSON, error) {
	var v inspectionJSON
	err := row.Scan(&v.ID, &v.HiveID, &v.Date, &v.InspectorName, &v.QueenSeen, &v.QueenHealth,
		&v.BroodPattern, &v.StoresHoney, &v.StoresPollen, &v.Temperament, &v.Pests,
		&v.Treatments, &v.Notes, &v.SourceMedia, &v.CreatedAt, &v.UpdatedAt)
	return v, err
}

func (s *Server) inspectionByID(ctx context.Context, id uuid.UUID) (inspectionJSON, error) {
	return inspectionScan(s.pool.QueryRow(ctx,
		`SELECT `+inspectionSelectCols+` FROM inspections WHERE id = $1`, id))
}

// inspectionMarshal marshals an optional typed slice/object to jsonb bytes; nil in → nil out.
func inspectionMarshal(v any, present bool) []byte {
	if !present {
		return nil
	}
	b, err := json.Marshal(v)
	if err != nil {
		return nil
	}
	return b
}

// --- handlers ---

type inspectionCreateReq struct {
	HiveID        string                `json:"hiveId"`
	Date          string                `json:"date"`
	InspectorName *string               `json:"inspectorName"`
	QueenSeen     *bool                 `json:"queenSeen"`
	QueenHealth   *string               `json:"queenHealth"`
	BroodPattern  *string               `json:"broodPattern"`
	StoresHoney   *int                  `json:"storesHoney"`
	StoresPollen  *int                  `json:"storesPollen"`
	Temperament   *int                  `json:"temperament"`
	Pests         []inspectionPest      `json:"pests"`
	Treatments    []inspectionTreatment `json:"treatments"`
	Notes         *string               `json:"notes"`
	SourceMedia   json.RawMessage       `json:"sourceMedia"`
}

// POST /inspections
func (s *Server) handleInspectionCreate(w http.ResponseWriter, r *http.Request) {
	var req inspectionCreateReq
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	hiveID, err := uuid.Parse(req.HiveID)
	if err != nil {
		writeError(w, http.StatusBadRequest, "Hive is required")
		return
	}
	if strings.TrimSpace(req.Date) == "" {
		writeError(w, http.StatusBadRequest, "Date is required")
		return
	}
	date, err := parseDate(req.Date)
	if err != nil {
		writeError(w, http.StatusBadRequest, "Invalid date")
		return
	}
	var sourceMedia []byte
	if len(req.SourceMedia) > 0 && string(req.SourceMedia) != "null" {
		sourceMedia = req.SourceMedia
	}
	fields := inspectionFields{
		HiveID:        hiveID,
		Date:          date,
		InspectorName: inspectionTrimPtr(req.InspectorName),
		QueenSeen:     req.QueenSeen,
		QueenHealth:   inspectionTrimPtr(req.QueenHealth),
		BroodPattern:  inspectionTrimPtr(req.BroodPattern),
		StoresHoney:   clampRating(req.StoresHoney),
		StoresPollen:  clampRating(req.StoresPollen),
		Temperament:   clampRating(req.Temperament),
		Pests:         inspectionMarshal(req.Pests, req.Pests != nil),
		Treatments:    inspectionMarshal(req.Treatments, req.Treatments != nil),
		Notes:         inspectionTrimPtr(req.Notes),
		SourceMedia:   sourceMedia,
	}
	id, err := inspectionInsert(r.Context(), s.pool, fields)
	if err != nil {
		if inspectionIsFKViolation(err) {
			writeError(w, http.StatusBadRequest, "Hive not found")
			return
		}
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	created, err := s.inspectionByID(r.Context(), id)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	writeJSON(w, http.StatusCreated, created)
}

// GET /inspections/{id}
func (s *Server) handleInspectionGet(w http.ResponseWriter, r *http.Request) {
	id, err := uuidParam(r, "id")
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	v, err := s.inspectionByID(r.Context(), id)
	if errors.Is(err, pgx.ErrNoRows) {
		writeError(w, http.StatusNotFound, "Inspection not found")
		return
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	writeJSON(w, http.StatusOK, v)
}

// inspectionUpdatableCols maps JSON field names to their column + decoder.
// hiveId is intentionally not updatable.
var inspectionUpdatableCols = map[string]string{
	"date":          "date",
	"inspectorName": "inspector_name",
	"queenSeen":     "queen_seen",
	"queenHealth":   "queen_health",
	"broodPattern":  "brood_pattern",
	"storesHoney":   "stores_honey",
	"storesPollen":  "stores_pollen",
	"temperament":   "temperament",
	"pests":         "pests",
	"treatments":    "treatments",
	"notes":         "notes",
	"sourceMedia":   "source_media",
}

// PUT /inspections/{id} — partial update: only fields present in the body are
// written; explicit nulls clear nullable columns. updated_at bumps via trigger.
func (s *Server) handleInspectionUpdate(w http.ResponseWriter, r *http.Request) {
	id, err := uuidParam(r, "id")
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	var body map[string]json.RawMessage
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	var cols []string
	var vals []any
	for key, raw := range body {
		col, ok := inspectionUpdatableCols[key]
		if !ok {
			writeError(w, http.StatusBadRequest, "unknown field: "+key)
			return
		}
		isNull := string(raw) == "null"
		switch key {
		case "date":
			if isNull {
				writeError(w, http.StatusBadRequest, "Date is required")
				return
			}
			var ds string
			if err := json.Unmarshal(raw, &ds); err != nil {
				writeError(w, http.StatusBadRequest, "Invalid date")
				return
			}
			t, err := parseDate(ds)
			if err != nil {
				writeError(w, http.StatusBadRequest, "Invalid date")
				return
			}
			vals = append(vals, t)
		case "queenSeen":
			var v *bool
			if err := json.Unmarshal(raw, &v); err != nil {
				writeError(w, http.StatusBadRequest, "queenSeen must be a boolean")
				return
			}
			vals = append(vals, v)
		case "storesHoney", "storesPollen", "temperament":
			var v *int
			if err := json.Unmarshal(raw, &v); err != nil {
				writeError(w, http.StatusBadRequest, key+" must be an integer 1-5")
				return
			}
			vals = append(vals, clampRating(v))
		case "pests":
			var v []inspectionPest
			if err := json.Unmarshal(raw, &v); err != nil {
				writeError(w, http.StatusBadRequest, "pests must be an array of {type, count?}")
				return
			}
			vals = append(vals, inspectionMarshal(v, !isNull && v != nil))
		case "treatments":
			var v []inspectionTreatment
			if err := json.Unmarshal(raw, &v); err != nil {
				writeError(w, http.StatusBadRequest, "treatments must be an array of {product, method?}")
				return
			}
			vals = append(vals, inspectionMarshal(v, !isNull && v != nil))
		case "sourceMedia":
			if isNull {
				vals = append(vals, []byte(nil))
			} else {
				vals = append(vals, []byte(raw))
			}
		default: // free-text fields: inspectorName, queenHealth, broodPattern, notes
			var v *string
			if err := json.Unmarshal(raw, &v); err != nil {
				writeError(w, http.StatusBadRequest, key+" must be a string")
				return
			}
			vals = append(vals, inspectionTrimPtr(v))
		}
		cols = append(cols, col)
	}
	if len(cols) == 0 {
		writeError(w, http.StatusBadRequest, "No fields to update")
		return
	}
	err = inspectionUpdate(r.Context(), s.pool, id, cols, vals)
	if errors.Is(err, pgx.ErrNoRows) {
		writeError(w, http.StatusNotFound, "Inspection not found")
		return
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	updated, err := s.inspectionByID(r.Context(), id)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	writeJSON(w, http.StatusOK, updated)
}

// DELETE /inspections/{id}
func (s *Server) handleInspectionDelete(w http.ResponseWriter, r *http.Request) {
	id, err := uuidParam(r, "id")
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	tag, err := s.pool.Exec(r.Context(), `DELETE FROM inspections WHERE id = $1`, id)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	if tag.RowsAffected() == 0 {
		writeError(w, http.StatusNotFound, "Inspection not found")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"success": true})
}

// GET /hives/{id}/inspections — full rows, date desc.
func (s *Server) handleInspectionsForHive(w http.ResponseWriter, r *http.Request) {
	hiveID, err := uuidParam(r, "id")
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	rows, err := s.pool.Query(r.Context(),
		`SELECT `+inspectionSelectCols+` FROM inspections WHERE hive_id = $1 ORDER BY date DESC`,
		hiveID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	defer rows.Close()
	list := []inspectionJSON{}
	for rows.Next() {
		v, err := inspectionScan(rows)
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

// GET /inspections/recent?limit= — joined with hive position label + apiary name.
func (s *Server) handleInspectionsRecent(w http.ResponseWriter, r *http.Request) {
	limit := 10
	if raw := r.URL.Query().Get("limit"); raw != "" {
		n, err := strconv.Atoi(raw)
		if err != nil || n < 1 {
			writeError(w, http.StatusBadRequest, "invalid limit")
			return
		}
		limit = n
	}
	rows, err := s.pool.Query(r.Context(), `
		SELECT i.id, i.hive_id, i.date, i.queen_seen, i.notes, h.position_label, a.name
		FROM inspections i
		JOIN hives h ON h.id = i.hive_id
		JOIN apiaries a ON a.id = h.apiary_id
		ORDER BY i.date DESC
		LIMIT $1`, limit)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	defer rows.Close()
	type recentJSON struct {
		ID         uuid.UUID `json:"id"`
		HiveID     uuid.UUID `json:"hiveId"`
		Date       time.Time `json:"date"`
		QueenSeen  *bool     `json:"queenSeen"`
		Notes      *string   `json:"notes"`
		HiveName   string    `json:"hiveName"`
		ApiaryName string    `json:"apiaryName"`
	}
	list := []recentJSON{}
	for rows.Next() {
		var v recentJSON
		if err := rows.Scan(&v.ID, &v.HiveID, &v.Date, &v.QueenSeen, &v.Notes, &v.HiveName, &v.ApiaryName); err != nil {
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

// POST /inspections/bulk {hiveIds[], date, notes?} — one minimal inspection per
// hive, in a single transaction, through the shared insert path.
func (s *Server) handleInspectionsBulk(w http.ResponseWriter, r *http.Request) {
	var req struct {
		HiveIDs []string `json:"hiveIds"`
		Date    string   `json:"date"`
		Notes   *string  `json:"notes"`
	}
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if len(req.HiveIDs) == 0 {
		writeError(w, http.StatusBadRequest, "Select at least one hive")
		return
	}
	if strings.TrimSpace(req.Date) == "" {
		writeError(w, http.StatusBadRequest, "Hives and date are required")
		return
	}
	date, err := parseDate(req.Date)
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
	notes := inspectionTrimPtr(req.Notes)

	ctx := r.Context()
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	defer func() { _ = tx.Rollback(ctx) }()
	for _, hiveID := range hiveIDs {
		if _, err := inspectionInsert(ctx, tx, inspectionFields{HiveID: hiveID, Date: date, Notes: notes}); err != nil {
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
