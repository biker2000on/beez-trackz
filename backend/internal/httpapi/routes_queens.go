package httpapi

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

func (s *Server) mountQueens(r chi.Router) {
	r.Get("/queens", s.handleQueenList)
	r.Post("/queens", s.handleQueenCreate)
	r.Get("/queens/{id}", s.handleQueenGet)
	r.Put("/queens/{id}", s.handleQueenUpdate)
	r.Delete("/queens/{id}", s.handleQueenDelete)
	r.Get("/queens/{id}/lineage", s.handleQueenLineage)
	r.Get("/queens/{id}/descendants", s.handleQueenDescendants)
	r.Get("/hives/{id}/queens", s.handleQueensForHive)
}

// queenJSON is the queen response shape. HiveName/ApiaryName come from the
// left join on the queen's current hive.
type queenJSON struct {
	ID             string     `json:"id"`
	HiveID         *string    `json:"hiveId"`
	Origin         string     `json:"origin"`
	OriginHiveID   *string    `json:"originHiveId"`
	ParentQueenID  *string    `json:"parentQueenId"`
	IntroducedDate *time.Time `json:"introducedDate"`
	Status         string     `json:"status"`
	Notes          *string    `json:"notes"`
	CreatedAt      time.Time  `json:"createdAt"`
	UpdatedAt      time.Time  `json:"updatedAt"`
	HiveName       *string    `json:"hiveName"`
	ApiaryName     *string    `json:"apiaryName"`
}

const queenSelectSQL = `
	SELECT q.id, q.hive_id, q.origin, q.origin_hive_id, q.parent_queen_id, q.introduced_date,
	       q.status, q.notes, q.created_at, q.updated_at, h.position_label, a.name
	FROM queens q
	LEFT JOIN hives h ON h.id = q.hive_id
	LEFT JOIN apiaries a ON a.id = h.apiary_id`

func queenScanRow(row pgx.Row) (*queenJSON, error) {
	var q queenJSON
	if err := row.Scan(&q.ID, &q.HiveID, &q.Origin, &q.OriginHiveID, &q.ParentQueenID,
		&q.IntroducedDate, &q.Status, &q.Notes, &q.CreatedAt, &q.UpdatedAt,
		&q.HiveName, &q.ApiaryName); err != nil {
		return nil, err
	}
	return &q, nil
}

func queenCollectRows(rows pgx.Rows) ([]queenJSON, error) {
	defer rows.Close()
	items := []queenJSON{}
	for rows.Next() {
		q, err := queenScanRow(rows)
		if err != nil {
			return nil, err
		}
		items = append(items, *q)
	}
	return items, rows.Err()
}

func (s *Server) queenFetch(ctx context.Context, id any) (*queenJSON, error) {
	return queenScanRow(s.pool.QueryRow(ctx, queenSelectSQL+` WHERE q.id = $1`, id))
}

func queenValidOrigin(v string) bool {
	switch v {
	case "purchased", "swarm", "raised", "walked", "emergency_cell", "unknown":
		return true
	}
	return false
}

func queenValidStatus(v string) bool {
	switch v {
	case "active", "superseded", "dead", "missing":
		return true
	}
	return false
}

// queenPayload is the create/update request body. Optional references accept
// null/omitted (the legacy "__none__" sentinel is gone).
type queenPayload struct {
	HiveID         *string `json:"hiveId"`
	Origin         string  `json:"origin"`
	OriginHiveID   *string `json:"originHiveId"`
	ParentQueenID  *string `json:"parentQueenId"`
	IntroducedDate *string `json:"introducedDate"`
	Status         *string `json:"status"`
	Notes          *string `json:"notes"`
}

// queenResolvePayload validates the payload into insertable values.
func queenResolvePayload(req *queenPayload) (hiveID, originHiveID, parentQueenID *string,
	status string, introduced *time.Time, err error) {
	if strings.TrimSpace(req.Origin) == "" {
		return nil, nil, nil, "", nil, errors.New("Origin is required")
	}
	if !queenValidOrigin(req.Origin) {
		return nil, nil, nil, "", nil, errors.New("invalid origin")
	}
	status = "active"
	if req.Status != nil && strings.TrimSpace(*req.Status) != "" {
		status = strings.TrimSpace(*req.Status)
	}
	if !queenValidStatus(status) {
		return nil, nil, nil, "", nil, errors.New("invalid status")
	}
	for _, ref := range []struct {
		name string
		val  *string
		out  **string
	}{
		{"hiveId", req.HiveID, &hiveID},
		{"originHiveId", req.OriginHiveID, &originHiveID},
		{"parentQueenId", req.ParentQueenID, &parentQueenID},
	} {
		v := hiveTextOrNil(ref.val)
		if v == nil {
			continue
		}
		if _, pErr := uuid.Parse(*v); pErr != nil {
			return nil, nil, nil, "", nil, errors.New("invalid " + ref.name)
		}
		*ref.out = v
	}
	introduced, dErr := parseDatePtr(req.IntroducedDate)
	if dErr != nil {
		return nil, nil, nil, "", nil, errors.New("invalid introducedDate")
	}
	return hiveID, originHiveID, parentQueenID, status, introduced, nil
}

// GET /queens — all queens for the genealogy tree.
func (s *Server) handleQueenList(w http.ResponseWriter, r *http.Request) {
	rows, err := s.pool.Query(r.Context(),
		queenSelectSQL+` ORDER BY q.introduced_date DESC`)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	items, err := queenCollectRows(rows)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	writeJSON(w, http.StatusOK, items)
}

// POST /queens
func (s *Server) handleQueenCreate(w http.ResponseWriter, r *http.Request) {
	var req queenPayload
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	hiveID, originHiveID, parentQueenID, status, introduced, err := queenResolvePayload(&req)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	var id string
	if err := s.pool.QueryRow(r.Context(), `
		INSERT INTO queens (hive_id, origin, origin_hive_id, parent_queen_id,
			introduced_date, status, notes)
		VALUES ($1, $2, $3, $4, $5, $6, $7)
		RETURNING id`,
		hiveID, req.Origin, originHiveID, parentQueenID, introduced, status,
		hiveTextOrNil(req.Notes)).Scan(&id); err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	queen, err := s.queenFetch(r.Context(), id)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	writeJSON(w, http.StatusCreated, queen)
}

// GET /queens/{id}
func (s *Server) handleQueenGet(w http.ResponseWriter, r *http.Request) {
	id, err := uuidParam(r, "id")
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	queen, err := s.queenFetch(r.Context(), id)
	if errors.Is(err, pgx.ErrNoRows) {
		writeError(w, http.StatusNotFound, "queen not found")
		return
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	writeJSON(w, http.StatusOK, queen)
}

// PUT /queens/{id}
func (s *Server) handleQueenUpdate(w http.ResponseWriter, r *http.Request) {
	id, err := uuidParam(r, "id")
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	var req queenPayload
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	hiveID, originHiveID, parentQueenID, status, introduced, err := queenResolvePayload(&req)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	tag, err := s.pool.Exec(r.Context(), `
		UPDATE queens SET hive_id = $1, origin = $2, origin_hive_id = $3,
			parent_queen_id = $4, introduced_date = $5, status = $6, notes = $7
		WHERE id = $8`,
		hiveID, req.Origin, originHiveID, parentQueenID, introduced, status,
		hiveTextOrNil(req.Notes), id)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	if tag.RowsAffected() == 0 {
		writeError(w, http.StatusNotFound, "queen not found")
		return
	}
	queen, err := s.queenFetch(r.Context(), id)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	writeJSON(w, http.StatusOK, queen)
}

// DELETE /queens/{id}
func (s *Server) handleQueenDelete(w http.ResponseWriter, r *http.Request) {
	id, err := uuidParam(r, "id")
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	tag, err := s.pool.Exec(r.Context(), `DELETE FROM queens WHERE id = $1`, id)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	if tag.RowsAffected() == 0 {
		writeError(w, http.StatusNotFound, "queen not found")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"success": true})
}

const queenRecursiveHead = `
	SELECT q.id, q.hive_id, q.origin, q.origin_hive_id, q.parent_queen_id, q.introduced_date,
	       q.status, q.notes, q.created_at, q.updated_at,
	       h.position_label AS hive_name, a.name AS apiary_name
	FROM queens q
	LEFT JOIN hives h ON h.id = q.hive_id
	LEFT JOIN apiaries a ON a.id = h.apiary_id`

// GET /queens/{id}/lineage — the queen plus her ancestors (recursive CTE up
// parent_queen_id).
func (s *Server) handleQueenLineage(w http.ResponseWriter, r *http.Request) {
	id, err := uuidParam(r, "id")
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	rows, err := s.pool.Query(r.Context(), `
		WITH RECURSIVE lineage AS (
			`+queenRecursiveHead+`
			WHERE q.id = $1
			UNION ALL
			`+queenRecursiveHead+`
			JOIN lineage l ON q.id = l.parent_queen_id
		)
		SELECT * FROM lineage`, id)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	items, err := queenCollectRows(rows)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	writeJSON(w, http.StatusOK, items)
}

// GET /queens/{id}/descendants — the queen plus all descendants (recursive
// CTE down parent_queen_id).
func (s *Server) handleQueenDescendants(w http.ResponseWriter, r *http.Request) {
	id, err := uuidParam(r, "id")
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	rows, err := s.pool.Query(r.Context(), `
		WITH RECURSIVE descendants AS (
			`+queenRecursiveHead+`
			WHERE q.id = $1
			UNION ALL
			`+queenRecursiveHead+`
			JOIN descendants d ON q.parent_queen_id = d.id
		)
		SELECT * FROM descendants`, id)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	items, err := queenCollectRows(rows)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	writeJSON(w, http.StatusOK, items)
}

// GET /hives/{id}/queens
func (s *Server) handleQueensForHive(w http.ResponseWriter, r *http.Request) {
	id, err := uuidParam(r, "id")
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	rows, err := s.pool.Query(r.Context(),
		queenSelectSQL+` WHERE q.hive_id = $1 ORDER BY q.introduced_date DESC`, id)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	items, err := queenCollectRows(rows)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	writeJSON(w, http.StatusOK, items)
}
