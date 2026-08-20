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
	r.With(s.requireEntityParamRole("queen", false)).
		Get("/queens/{id}", s.handleQueenGet)
	r.With(s.requireEntityParamRole("queen", true)).
		Put("/queens/{id}", s.handleQueenUpdate)
	r.With(s.requireEntityParamRole("queen", true)).
		Delete("/queens/{id}", s.handleQueenDelete)
	r.With(s.requireEntityParamRole("queen", false)).
		Get("/queens/{id}/lineage", s.handleQueenLineage)
	r.With(s.requireEntityParamRole("queen", false)).
		Get("/queens/{id}/descendants", s.handleQueenDescendants)
	r.With(s.requireHiveParamRole(false)).
		Get("/hives/{id}/queens", s.handleQueensForHive)
}

// queenJSON is the queen response shape. HiveName/ApiaryName come from the
// left join on the queen's current hive.
type queenJSON struct {
	ID                string     `json:"id"`
	HiveID            *string    `json:"hiveId"`
	Origin            string     `json:"origin"`
	OriginHiveID      *string    `json:"originHiveId"`
	ParentQueenID     *string    `json:"parentQueenId"`
	IntroducedDate    *time.Time `json:"introducedDate"`
	Status            string     `json:"status"`
	Notes             *string    `json:"notes"`
	MatedAtApiaryID   *string    `json:"matedAtApiaryId"`
	MatedAtApiaryName *string    `json:"matedAtApiaryName"`
	DroneSourceNote   *string    `json:"droneSourceNote"`
	CreatedAt         time.Time  `json:"createdAt"`
	UpdatedAt         time.Time  `json:"updatedAt"`
	HiveName          *string    `json:"hiveName"`
	ApiaryName        *string    `json:"apiaryName"`
}

const queenSelectSQL = `
	SELECT q.id, q.hive_id, q.origin, q.origin_hive_id, q.parent_queen_id, q.introduced_date,
	       q.status, q.notes, q.mated_at_apiary_id, q.drone_source_note, q.created_at, q.updated_at,
	       h.position_label, a.name, ma.name
	FROM queens q
	LEFT JOIN hives h ON h.id = q.hive_id
	LEFT JOIN apiaries a ON a.id = h.apiary_id
	LEFT JOIN apiaries ma ON ma.id = q.mated_at_apiary_id`

func queenScanRow(row pgx.Row) (*queenJSON, error) {
	var q queenJSON
	if err := row.Scan(&q.ID, &q.HiveID, &q.Origin, &q.OriginHiveID, &q.ParentQueenID,
		&q.IntroducedDate, &q.Status, &q.Notes, &q.MatedAtApiaryID, &q.DroneSourceNote,
		&q.CreatedAt, &q.UpdatedAt, &q.HiveName, &q.ApiaryName, &q.MatedAtApiaryName); err != nil {
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
	HiveID          *string `json:"hiveId"`
	Origin          string  `json:"origin"`
	OriginHiveID    *string `json:"originHiveId"`
	ParentQueenID   *string `json:"parentQueenId"`
	IntroducedDate  *string `json:"introducedDate"`
	Status          *string `json:"status"`
	Notes           *string `json:"notes"`
	MatedAtApiaryID *string `json:"matedAtApiaryId"`
	DroneSourceNote *string `json:"droneSourceNote"`
}

// queenResolvePayload validates the payload into insertable values.
func queenResolvePayload(req *queenPayload) (hiveID, originHiveID, parentQueenID, matedAtApiaryID *string,
	status string, introduced *time.Time, err error) {
	if strings.TrimSpace(req.Origin) == "" {
		return nil, nil, nil, nil, "", nil, errors.New("Origin is required")
	}
	if !queenValidOrigin(req.Origin) {
		return nil, nil, nil, nil, "", nil, errors.New("invalid origin")
	}
	status = "active"
	if req.Status != nil && strings.TrimSpace(*req.Status) != "" {
		status = strings.TrimSpace(*req.Status)
	}
	if !queenValidStatus(status) {
		return nil, nil, nil, nil, "", nil, errors.New("invalid status")
	}
	for _, ref := range []struct {
		name string
		val  *string
		out  **string
	}{
		{"hiveId", req.HiveID, &hiveID},
		{"originHiveId", req.OriginHiveID, &originHiveID},
		{"parentQueenId", req.ParentQueenID, &parentQueenID},
		{"matedAtApiaryId", req.MatedAtApiaryID, &matedAtApiaryID},
	} {
		v := hiveTextOrNil(ref.val)
		if v == nil {
			continue
		}
		if _, pErr := uuid.Parse(*v); pErr != nil {
			return nil, nil, nil, nil, "", nil, errors.New("invalid " + ref.name)
		}
		*ref.out = v
	}
	introduced, dErr := parseDatePtr(req.IntroducedDate)
	if dErr != nil {
		return nil, nil, nil, nil, "", nil, errors.New("invalid introducedDate")
	}
	return hiveID, originHiveID, parentQueenID, matedAtApiaryID, status, introduced, nil
}

// authorizeQueenLineageRefs checks originHiveId / parentQueenId with the same
// editor-on-apiary rule as hiveId. Cross-apiary pedigree links are rejected.
func (s *Server) authorizeQueenLineageRefs(
	w http.ResponseWriter, r *http.Request, originHiveID, parentQueenID *string,
) bool {
	if originHiveID != nil {
		value, err := uuid.Parse(*originHiveID)
		if err != nil || !s.requireHiveRole(w, r, value, true) {
			return false
		}
	}
	if parentQueenID == nil {
		return true
	}
	queenID, err := uuid.Parse(*parentQueenID)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid parentQueenId")
		return false
	}
	var hiveID, originID *uuid.UUID
	err = s.pool.QueryRow(r.Context(),
		`SELECT hive_id, origin_hive_id FROM queens WHERE id=$1`, queenID).
		Scan(&hiveID, &originID)
	if errors.Is(err, pgx.ErrNoRows) {
		writeError(w, http.StatusBadRequest, "invalid parentQueenId")
		return false
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return false
	}
	ref := hiveID
	if ref == nil {
		ref = originID
	}
	if ref == nil {
		if !principalFrom(r).IsAdmin {
			writeError(w, http.StatusForbidden, "parent queen is not in an editable apiary")
			return false
		}
		return true
	}
	return s.requireHiveRole(w, r, *ref, true)
}

func (s *Server) authorizeQueenMatingYard(w http.ResponseWriter, r *http.Request, matedAtApiaryID *string) bool {
	if matedAtApiaryID == nil {
		return true
	}
	value, err := uuid.Parse(*matedAtApiaryID)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid matedAtApiaryId")
		return false
	}
	return s.requireApiaryRole(w, r, value, false)
}

// GET /queens — all queens for the genealogy tree.
func (s *Server) handleQueenList(w http.ResponseWriter, r *http.Request) {
	rows, err := s.pool.Query(r.Context(),
		queenSelectSQL+` WHERE ($1::boolean OR EXISTS (
			SELECT 1 FROM apiary_memberships membership
			WHERE membership.user_id=$2 AND membership.apiary_id=a.id
		)) ORDER BY q.introduced_date DESC`,
		principalFrom(r).IsAdmin, principalFrom(r).ID)
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
	hiveID, originHiveID, parentQueenID, matedAtApiaryID, status, introduced, err := queenResolvePayload(&req)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	if hiveID == nil {
		if !principalFrom(r).IsAdmin {
			writeError(w, http.StatusForbidden, "a hive with editor access is required")
			return
		}
	} else {
		value, parseErr := uuid.Parse(*hiveID)
		if parseErr != nil || !s.requireHiveRole(w, r, value, true) {
			return
		}
	}
	if !s.authorizeQueenLineageRefs(w, r, originHiveID, parentQueenID) {
		return
	}
	if !s.authorizeQueenMatingYard(w, r, matedAtApiaryID) {
		return
	}
	var id string
	if err := s.pool.QueryRow(r.Context(), `
		INSERT INTO queens (hive_id, origin, origin_hive_id, parent_queen_id,
			introduced_date, status, notes, mated_at_apiary_id, drone_source_note)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
		RETURNING id`,
		hiveID, req.Origin, originHiveID, parentQueenID, introduced, status,
		hiveTextOrNil(req.Notes), matedAtApiaryID, hiveTextOrNil(req.DroneSourceNote)).Scan(&id); err != nil {
		writeDBError(w, err, "database error", "invalid hive, parent queen, or mating yard")
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
	hiveID, originHiveID, parentQueenID, matedAtApiaryID, status, introduced, err := queenResolvePayload(&req)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	if hiveID == nil {
		if !principalFrom(r).IsAdmin {
			writeError(w, http.StatusForbidden, "a hive with editor access is required")
			return
		}
	} else {
		value, parseErr := uuid.Parse(*hiveID)
		if parseErr != nil || !s.requireHiveRole(w, r, value, true) {
			return
		}
	}
	if !s.authorizeQueenLineageRefs(w, r, originHiveID, parentQueenID) {
		return
	}
	if !s.authorizeQueenMatingYard(w, r, matedAtApiaryID) {
		return
	}
	tag, err := s.pool.Exec(r.Context(), `
		UPDATE queens SET hive_id = $1, origin = $2, origin_hive_id = $3,
			parent_queen_id = $4, introduced_date = $5, status = $6, notes = $7,
			mated_at_apiary_id = $8, drone_source_note = $9
		WHERE id = $10`,
		hiveID, req.Origin, originHiveID, parentQueenID, introduced, status,
		hiveTextOrNil(req.Notes), matedAtApiaryID, hiveTextOrNil(req.DroneSourceNote), id)
	if err != nil {
		writeDBError(w, err, "database error", "invalid hive, parent queen, or mating yard")
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
	       q.status, q.notes, q.mated_at_apiary_id, q.drone_source_note, q.created_at, q.updated_at,
	       h.position_label AS hive_name, a.name AS apiary_name, ma.name AS mated_at_apiary_name
	FROM queens q
	LEFT JOIN hives h ON h.id = q.hive_id
	LEFT JOIN apiaries a ON a.id = h.apiary_id
	LEFT JOIN apiaries ma ON ma.id = q.mated_at_apiary_id`

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
