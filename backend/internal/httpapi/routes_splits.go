package httpapi

import (
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
)

func (s *Server) mountSplits(r chi.Router) {
	r.Post("/splits", s.handleSplitCreate)
	r.Delete("/splits/{id}", s.handleSplitDelete)
	r.Get("/hives/{id}/splits", s.handleSplitListForHive)
}

func splitValidType(v string) bool {
	switch v {
	case "walk-away", "vertical", "nuc", "cutdown", "other":
		return true
	}
	return false
}

// splitJSON is one hive_splits row enriched with parent/child labels.
type splitJSON struct {
	ID           string    `json:"id"`
	ParentHiveID string    `json:"parentHiveId"`
	ChildHiveID  string    `json:"childHiveId"`
	SplitDate    time.Time `json:"splitDate"`
	SplitType    string    `json:"splitType"`
	FramesMoved  *int      `json:"framesMoved"`
	Notes        *string   `json:"notes"`
	ParentLabel  string    `json:"parentLabel"`
	ChildLabel   string    `json:"childLabel"`
}

// POST /splits — creates the child hive (status active, installed on the
// split date), its location history, and the hive_splits record in one
// transaction. Returns the child hive id.
func (s *Server) handleSplitCreate(w http.ResponseWriter, r *http.Request) {
	var req struct {
		ParentHiveID  string  `json:"parentHiveId"`
		ApiaryID      string  `json:"apiaryId"`
		PositionLabel string  `json:"positionLabel"`
		SplitDate     string  `json:"splitDate"`
		SplitType     string  `json:"splitType"`
		FramesMoved   *int    `json:"framesMoved"`
		Notes         *string `json:"notes"`
	}
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	label := strings.TrimSpace(req.PositionLabel)
	if strings.TrimSpace(req.ParentHiveID) == "" || strings.TrimSpace(req.ApiaryID) == "" ||
		label == "" || strings.TrimSpace(req.SplitDate) == "" || strings.TrimSpace(req.SplitType) == "" {
		writeError(w, http.StatusBadRequest,
			"Parent hive, apiary, position, date, and split type are required")
		return
	}
	if _, err := uuid.Parse(req.ParentHiveID); err != nil {
		writeError(w, http.StatusBadRequest, "invalid parentHiveId")
		return
	}
	if _, err := uuid.Parse(req.ApiaryID); err != nil {
		writeError(w, http.StatusBadRequest, "invalid apiaryId")
		return
	}
	if !splitValidType(req.SplitType) {
		writeError(w, http.StatusBadRequest, "invalid splitType")
		return
	}
	splitDate, err := parseDate(req.SplitDate)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid splitDate")
		return
	}

	ctx := r.Context()
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	defer tx.Rollback(ctx)

	var parentExists, apiaryExists bool
	if err := tx.QueryRow(ctx, `
		SELECT EXISTS (SELECT 1 FROM hives WHERE id = $1),
		       EXISTS (SELECT 1 FROM apiaries WHERE id = $2)`,
		req.ParentHiveID, req.ApiaryID).Scan(&parentExists, &apiaryExists); err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	if !parentExists {
		writeError(w, http.StatusNotFound, "parent hive not found")
		return
	}
	if !apiaryExists {
		writeError(w, http.StatusBadRequest, "Apiary not found")
		return
	}

	var childID string
	if err := tx.QueryRow(ctx, `
		INSERT INTO hives (apiary_id, position_label, status, installed_date)
		VALUES ($1, $2, 'active', $3)
		RETURNING id`, req.ApiaryID, label, splitDate).Scan(&childID); err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO hive_location_history (hive_id, apiary_id, position_label, date_from)
		VALUES ($1, $2, $3, $4)`, childID, req.ApiaryID, label, splitDate); err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO hive_splits (parent_hive_id, child_hive_id, split_date, split_type,
			frames_moved, notes)
		VALUES ($1, $2, $3, $4, $5, $6)`,
		req.ParentHiveID, childID, splitDate, req.SplitType, req.FramesMoved,
		hiveTextOrNil(req.Notes)); err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	if err := tx.Commit(ctx); err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"success": true, "id": childID})
}

// GET /hives/{id}/splits — splits where the hive is parent OR child,
// enriched with both position labels, newest first.
func (s *Server) handleSplitListForHive(w http.ResponseWriter, r *http.Request) {
	id, err := uuidParam(r, "id")
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	rows, err := s.pool.Query(r.Context(), `
		SELECT sp.id, sp.parent_hive_id, sp.child_hive_id, sp.split_date, sp.split_type,
		       sp.frames_moved, sp.notes, p.position_label, c.position_label
		FROM hive_splits sp
		JOIN hives p ON p.id = sp.parent_hive_id
		JOIN hives c ON c.id = sp.child_hive_id
		WHERE sp.parent_hive_id = $1 OR sp.child_hive_id = $1
		ORDER BY sp.split_date DESC`, id)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	defer rows.Close()

	items := []splitJSON{}
	for rows.Next() {
		var sp splitJSON
		if err := rows.Scan(&sp.ID, &sp.ParentHiveID, &sp.ChildHiveID, &sp.SplitDate,
			&sp.SplitType, &sp.FramesMoved, &sp.Notes, &sp.ParentLabel, &sp.ChildLabel); err != nil {
			writeError(w, http.StatusInternalServerError, "database error")
			return
		}
		items = append(items, sp)
	}
	if rows.Err() != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	writeJSON(w, http.StatusOK, items)
}

// DELETE /splits/{id}
func (s *Server) handleSplitDelete(w http.ResponseWriter, r *http.Request) {
	id, err := uuidParam(r, "id")
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	tag, err := s.pool.Exec(r.Context(), `DELETE FROM hive_splits WHERE id = $1`, id)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	if tag.RowsAffected() == 0 {
		writeError(w, http.StatusNotFound, "split not found")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"success": true})
}
