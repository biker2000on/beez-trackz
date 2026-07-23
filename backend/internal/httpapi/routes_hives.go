package httpapi

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

func (s *Server) mountHives(r chi.Router) {
	r.Get("/hives", s.handleHiveList)
	r.Post("/hives", s.handleHiveCreate)
	r.Post("/hives/bulk", s.handleHiveBulkCreate)
	r.Patch("/hives/bulk", s.handleHiveBulkUpdate)
	r.Get("/hives/{id}", s.handleHiveGet)
	r.Put("/hives/{id}", s.handleHiveUpdate)
	r.Delete("/hives/{id}", s.handleHiveDelete)
	r.Post("/hives/{id}/move", s.handleHiveMove)
	r.Post("/hives/{id}/archive", s.handleHiveArchive)
	r.Post("/hives/{id}/unarchive", s.handleHiveUnarchive)
	r.Post("/hives/{id}/deadout", s.handleHiveDeadout)
	r.Get("/hives/{id}/location-history", s.handleHiveLocationHistory)
}

// hiveJSON is the hive response shape (list and detail).
type hiveJSON struct {
	ID            string     `json:"id"`
	ApiaryID      string     `json:"apiaryId"`
	ApiaryName    string     `json:"apiaryName"`
	PositionLabel string     `json:"positionLabel"`
	StandID       *string    `json:"standId"`
	SlotRow       *int       `json:"slotRow"`
	SlotCol       *int       `json:"slotCol"`
	Placement     *string    `json:"placement"`
	FacingDegrees *int       `json:"facingDegrees"`
	Status        string     `json:"status"`
	InstalledDate *time.Time `json:"installedDate"`
	IsArchived    bool       `json:"isArchived"`
	DeadoutDate   *time.Time `json:"deadoutDate"`
	Notes         *string    `json:"notes"`
	CreatedAt     time.Time  `json:"createdAt"`
	UpdatedAt     time.Time  `json:"updatedAt"`
}

const hiveSelectSQL = `
	SELECT h.id, h.apiary_id, a.name, h.position_label, h.stand_id, h.slot_row, h.slot_col,
	       h.placement, h.facing_degrees, h.status, h.installed_date, h.is_archived,
	       h.deadout_date, h.notes, h.created_at, h.updated_at
	FROM hives h
	JOIN apiaries a ON a.id = h.apiary_id`

func hiveScanRow(row pgx.Row) (*hiveJSON, error) {
	var h hiveJSON
	if err := row.Scan(&h.ID, &h.ApiaryID, &h.ApiaryName, &h.PositionLabel, &h.StandID,
		&h.SlotRow, &h.SlotCol, &h.Placement, &h.FacingDegrees, &h.Status, &h.InstalledDate,
		&h.IsArchived, &h.DeadoutDate, &h.Notes, &h.CreatedAt, &h.UpdatedAt); err != nil {
		return nil, err
	}
	return &h, nil
}

func (s *Server) hiveFetch(ctx context.Context, id any) (*hiveJSON, error) {
	return hiveScanRow(s.pool.QueryRow(ctx, hiveSelectSQL+` WHERE h.id = $1`, id))
}

func hiveValidStatus(v string) bool {
	switch v {
	case "active", "dead", "sold", "combined":
		return true
	}
	return false
}

func hiveValidPlacement(v string) bool {
	switch v {
	case "full", "top", "bottom", "left", "right":
		return true
	}
	return false
}

// hiveTextOrNil trims an optional string; empty becomes nil (stored as NULL).
func hiveTextOrNil(v *string) *string {
	if v == nil {
		return nil
	}
	t := strings.TrimSpace(*v)
	if t == "" {
		return nil
	}
	return &t
}

// hiveGeneratePositionLabel mirrors legacy src/lib/hive-location.ts:
// "{stand}{row}-{col}" with a " (placement)" suffix when not full;
// "Unassigned" when nothing is set.
func hiveGeneratePositionLabel(standLabel *string, slotRow, slotCol *int, placement string) string {
	if (standLabel == nil || *standLabel == "") && slotRow == nil && slotCol == nil {
		return "Unassigned"
	}
	stand := "?"
	if standLabel != nil && *standLabel != "" {
		stand = *standLabel
	}
	label := stand
	if slotRow != nil {
		label += strconv.Itoa(*slotRow)
	}
	if slotCol != nil {
		label += "-" + strconv.Itoa(*slotCol)
	}
	if placement != "" && placement != "full" {
		label += " (" + placement + ")"
	}
	return label
}

// hivePayload is the create/update request body. ApiaryID is create-only
// (accepted but ignored on update, matching the legacy action).
type hivePayload struct {
	ApiaryID      string  `json:"apiaryId"`
	PositionLabel *string `json:"positionLabel"`
	StandID       *string `json:"standId"`
	SlotRow       *int    `json:"slotRow"`
	SlotCol       *int    `json:"slotCol"`
	Placement     *string `json:"placement"`
	Status        *string `json:"status"`
	InstalledDate *string `json:"installedDate"`
	Notes         *string `json:"notes"`
}

// hiveResolvePayload validates the shared create/update fields and
// auto-generates the position label from stand/slot when blank.
func hiveResolvePayload(req *hivePayload) (label, placement, status string, installed *time.Time, err error) {
	placement = "full"
	if req.Placement != nil && strings.TrimSpace(*req.Placement) != "" {
		placement = strings.TrimSpace(*req.Placement)
	}
	if !hiveValidPlacement(placement) {
		return "", "", "", nil, fmt.Errorf("invalid placement")
	}
	status = "active"
	if req.Status != nil && strings.TrimSpace(*req.Status) != "" {
		status = strings.TrimSpace(*req.Status)
	}
	if !hiveValidStatus(status) {
		return "", "", "", nil, fmt.Errorf("invalid status")
	}
	if req.PositionLabel != nil {
		label = strings.TrimSpace(*req.PositionLabel)
	}
	if label == "" && hiveTextOrNil(req.StandID) != nil {
		label = hiveGeneratePositionLabel(hiveTextOrNil(req.StandID), req.SlotRow, req.SlotCol, placement)
	}
	if label == "" {
		return "", "", "", nil, fmt.Errorf("Position label or location is required")
	}
	installed, dErr := parseDatePtr(req.InstalledDate)
	if dErr != nil {
		return "", "", "", nil, fmt.Errorf("invalid installedDate")
	}
	return label, placement, status, installed, nil
}

// GET /hives?apiaryId=&status=&includeArchived=
func (s *Server) handleHiveList(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	where := []string{}
	args := []any{}
	if v := q.Get("includeArchived"); v != "true" && v != "1" {
		where = append(where, "h.is_archived = false")
	}
	if v := q.Get("apiaryId"); v != "" {
		if _, err := uuid.Parse(v); err != nil {
			writeError(w, http.StatusBadRequest, "invalid apiaryId")
			return
		}
		args = append(args, v)
		where = append(where, fmt.Sprintf("h.apiary_id = $%d", len(args)))
	}
	if v := q.Get("status"); v != "" {
		if !hiveValidStatus(v) {
			writeError(w, http.StatusBadRequest, "invalid status")
			return
		}
		args = append(args, v)
		where = append(where, fmt.Sprintf("h.status = $%d", len(args)))
	}
	query := hiveSelectSQL
	if len(where) > 0 {
		query += " WHERE " + strings.Join(where, " AND ")
	}
	query += " ORDER BY a.name, h.position_label"

	rows, err := s.pool.Query(r.Context(), query, args...)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	defer rows.Close()

	items := []hiveJSON{}
	for rows.Next() {
		h, err := hiveScanRow(rows)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "database error")
			return
		}
		items = append(items, *h)
	}
	if rows.Err() != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	writeJSON(w, http.StatusOK, items)
}

// POST /hives — creates the hive plus its initial location-history row.
func (s *Server) handleHiveCreate(w http.ResponseWriter, r *http.Request) {
	var req hivePayload
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if strings.TrimSpace(req.ApiaryID) == "" {
		writeError(w, http.StatusBadRequest, "Apiary is required")
		return
	}
	if _, err := uuid.Parse(req.ApiaryID); err != nil {
		writeError(w, http.StatusBadRequest, "invalid apiaryId")
		return
	}
	label, placement, status, installed, err := hiveResolvePayload(&req)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}

	ctx := r.Context()
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	defer tx.Rollback(ctx)

	var apiaryExists bool
	if err := tx.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM apiaries WHERE id = $1)`,
		req.ApiaryID).Scan(&apiaryExists); err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	if !apiaryExists {
		writeError(w, http.StatusBadRequest, "Apiary not found")
		return
	}

	var id string
	if err := tx.QueryRow(ctx, `
		INSERT INTO hives (apiary_id, position_label, stand_id, slot_row, slot_col,
			placement, status, installed_date, notes)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
		RETURNING id`,
		req.ApiaryID, label, hiveTextOrNil(req.StandID), req.SlotRow, req.SlotCol,
		placement, status, installed, hiveTextOrNil(req.Notes)).Scan(&id); err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}

	dateFrom := time.Now()
	if installed != nil {
		dateFrom = *installed
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO hive_location_history (hive_id, apiary_id, position_label, date_from)
		VALUES ($1, $2, $3, $4)`, id, req.ApiaryID, label, dateFrom); err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	if err := tx.Commit(ctx); err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}

	hive, err := s.hiveFetch(ctx, id)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	writeJSON(w, http.StatusCreated, hive)
}

// POST /hives/bulk {apiaryId, quantity, startLabel?}
func (s *Server) handleHiveBulkCreate(w http.ResponseWriter, r *http.Request) {
	var req struct {
		ApiaryID   string  `json:"apiaryId"`
		Quantity   int     `json:"quantity"`
		StartLabel *string `json:"startLabel"`
	}
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if strings.TrimSpace(req.ApiaryID) == "" || req.Quantity < 1 {
		writeError(w, http.StatusBadRequest, "Apiary and valid quantity required")
		return
	}
	if _, err := uuid.Parse(req.ApiaryID); err != nil {
		writeError(w, http.StatusBadRequest, "invalid apiaryId")
		return
	}

	ctx := r.Context()
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	defer tx.Rollback(ctx)

	var apiaryExists bool
	if err := tx.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM apiaries WHERE id = $1)`,
		req.ApiaryID).Scan(&apiaryExists); err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	if !apiaryExists {
		writeError(w, http.StatusBadRequest, "Apiary not found")
		return
	}

	now := time.Now()
	startLabel := ""
	if req.StartLabel != nil {
		startLabel = *req.StartLabel
	}
	for i := 0; i < req.Quantity; i++ {
		label := fmt.Sprintf("Hive %d", i+1)
		if startLabel != "" {
			label = fmt.Sprintf("%s%d", startLabel, i+1)
		}
		var id string
		if err := tx.QueryRow(ctx, `
			INSERT INTO hives (apiary_id, position_label, status)
			VALUES ($1, $2, 'active') RETURNING id`, req.ApiaryID, label).Scan(&id); err != nil {
			writeError(w, http.StatusInternalServerError, "database error")
			return
		}
		if _, err := tx.Exec(ctx, `
			INSERT INTO hive_location_history (hive_id, apiary_id, position_label, date_from)
			VALUES ($1, $2, $3, $4)`, id, req.ApiaryID, label, now); err != nil {
			writeError(w, http.StatusInternalServerError, "database error")
			return
		}
	}
	if err := tx.Commit(ctx); err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"success": true, "count": req.Quantity})
}

// PATCH /hives/bulk {hiveIds[], status?, isArchived?}
func (s *Server) handleHiveBulkUpdate(w http.ResponseWriter, r *http.Request) {
	var req struct {
		HiveIDs    []string `json:"hiveIds"`
		Status     *string  `json:"status"`
		IsArchived *bool    `json:"isArchived"`
	}
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	ids := []string{}
	for _, id := range req.HiveIDs {
		if strings.TrimSpace(id) == "" {
			continue
		}
		if _, err := uuid.Parse(id); err != nil {
			writeError(w, http.StatusBadRequest, "invalid hive id")
			return
		}
		ids = append(ids, id)
	}
	if len(ids) == 0 {
		writeError(w, http.StatusBadRequest, "No hives selected")
		return
	}
	if req.Status == nil && req.IsArchived == nil {
		writeError(w, http.StatusBadRequest, "Nothing to change")
		return
	}

	sets := []string{}
	args := []any{}
	if req.Status != nil {
		if !hiveValidStatus(*req.Status) {
			writeError(w, http.StatusBadRequest, "invalid status")
			return
		}
		args = append(args, *req.Status)
		sets = append(sets, fmt.Sprintf("status = $%d", len(args)))
		if *req.Status == "dead" {
			sets = append(sets, "deadout_date = now()")
		}
	}
	if req.IsArchived != nil {
		args = append(args, *req.IsArchived)
		sets = append(sets, fmt.Sprintf("is_archived = $%d", len(args)))
	}
	args = append(args, ids)
	query := "UPDATE hives SET " + strings.Join(sets, ", ") +
		fmt.Sprintf(" WHERE id = ANY($%d::uuid[])", len(args))

	tag, err := s.pool.Exec(r.Context(), query, args...)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"success": true, "count": tag.RowsAffected()})
}

// GET /hives/{id}
func (s *Server) handleHiveGet(w http.ResponseWriter, r *http.Request) {
	id, err := uuidParam(r, "id")
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	hive, err := s.hiveFetch(r.Context(), id)
	if errors.Is(err, pgx.ErrNoRows) {
		writeError(w, http.StatusNotFound, "hive not found")
		return
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	writeJSON(w, http.StatusOK, hive)
}

// PUT /hives/{id} — updates details (not the apiary; use /move for that).
func (s *Server) handleHiveUpdate(w http.ResponseWriter, r *http.Request) {
	id, err := uuidParam(r, "id")
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	var req hivePayload
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	label, placement, status, installed, err := hiveResolvePayload(&req)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	tag, err := s.pool.Exec(r.Context(), `
		UPDATE hives SET position_label = $1, stand_id = $2, slot_row = $3, slot_col = $4,
			placement = $5, status = $6, installed_date = $7, notes = $8
		WHERE id = $9`,
		label, hiveTextOrNil(req.StandID), req.SlotRow, req.SlotCol,
		placement, status, installed, hiveTextOrNil(req.Notes), id)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	if tag.RowsAffected() == 0 {
		writeError(w, http.StatusNotFound, "hive not found")
		return
	}
	hive, err := s.hiveFetch(r.Context(), id)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	writeJSON(w, http.StatusOK, hive)
}

// DELETE /hives/{id} — location history first, then the hive.
func (s *Server) handleHiveDelete(w http.ResponseWriter, r *http.Request) {
	id, err := uuidParam(r, "id")
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	ctx := r.Context()
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	defer tx.Rollback(ctx)

	if _, err := tx.Exec(ctx,
		`DELETE FROM hive_location_history WHERE hive_id = $1`, id); err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	tag, err := tx.Exec(ctx, `DELETE FROM hives WHERE id = $1`, id)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	if tag.RowsAffected() == 0 {
		writeError(w, http.StatusNotFound, "hive not found")
		return
	}
	if err := tx.Commit(ctx); err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"success": true})
}

// POST /hives/{id}/move {apiaryId, positionLabel} — closes the open
// location-history row, opens a new one, updates the hive.
func (s *Server) handleHiveMove(w http.ResponseWriter, r *http.Request) {
	id, err := uuidParam(r, "id")
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	var req struct {
		ApiaryID      string `json:"apiaryId"`
		PositionLabel string `json:"positionLabel"`
	}
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if strings.TrimSpace(req.ApiaryID) == "" {
		writeError(w, http.StatusBadRequest, "New apiary is required")
		return
	}
	if _, err := uuid.Parse(req.ApiaryID); err != nil {
		writeError(w, http.StatusBadRequest, "invalid apiaryId")
		return
	}
	label := strings.TrimSpace(req.PositionLabel)
	if label == "" {
		writeError(w, http.StatusBadRequest, "New position label is required")
		return
	}

	ctx := r.Context()
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	defer tx.Rollback(ctx)

	var hiveExists, apiaryExists bool
	if err := tx.QueryRow(ctx, `
		SELECT EXISTS (SELECT 1 FROM hives WHERE id = $1),
		       EXISTS (SELECT 1 FROM apiaries WHERE id = $2)`,
		id, req.ApiaryID).Scan(&hiveExists, &apiaryExists); err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	if !hiveExists {
		writeError(w, http.StatusNotFound, "hive not found")
		return
	}
	if !apiaryExists {
		writeError(w, http.StatusBadRequest, "Apiary not found")
		return
	}

	now := time.Now()
	if _, err := tx.Exec(ctx, `
		UPDATE hive_location_history SET date_to = $1
		WHERE hive_id = $2 AND date_to IS NULL`, now, id); err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO hive_location_history (hive_id, apiary_id, position_label, date_from)
		VALUES ($1, $2, $3, $4)`, id, req.ApiaryID, label, now); err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	if _, err := tx.Exec(ctx, `
		UPDATE hives SET apiary_id = $1, position_label = $2 WHERE id = $3`,
		req.ApiaryID, label, id); err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	if err := tx.Commit(ctx); err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}

	hive, err := s.hiveFetch(ctx, id)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	writeJSON(w, http.StatusOK, hive)
}

// hiveSimpleUpdate applies a fixed SET clause to one hive.
func (s *Server) hiveSimpleUpdate(w http.ResponseWriter, r *http.Request, set string) {
	id, err := uuidParam(r, "id")
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	tag, err := s.pool.Exec(r.Context(), "UPDATE hives SET "+set+" WHERE id = $1", id)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	if tag.RowsAffected() == 0 {
		writeError(w, http.StatusNotFound, "hive not found")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"success": true})
}

// POST /hives/{id}/archive
func (s *Server) handleHiveArchive(w http.ResponseWriter, r *http.Request) {
	s.hiveSimpleUpdate(w, r, "is_archived = true")
}

// POST /hives/{id}/unarchive
func (s *Server) handleHiveUnarchive(w http.ResponseWriter, r *http.Request) {
	s.hiveSimpleUpdate(w, r, "is_archived = false")
}

// POST /hives/{id}/deadout
func (s *Server) handleHiveDeadout(w http.ResponseWriter, r *http.Request) {
	s.hiveSimpleUpdate(w, r, "status = 'dead', is_archived = true, deadout_date = now()")
}

// GET /hives/{id}/location-history
func (s *Server) handleHiveLocationHistory(w http.ResponseWriter, r *http.Request) {
	id, err := uuidParam(r, "id")
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	rows, err := s.pool.Query(r.Context(), `
		SELECT lh.id, lh.apiary_id, a.name, lh.position_label, lh.date_from, lh.date_to
		FROM hive_location_history lh
		JOIN apiaries a ON a.id = lh.apiary_id
		WHERE lh.hive_id = $1
		ORDER BY lh.date_from DESC`, id)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	defer rows.Close()

	type hiveLocationEntry struct {
		ID            string     `json:"id"`
		ApiaryID      string     `json:"apiaryId"`
		ApiaryName    string     `json:"apiaryName"`
		PositionLabel string     `json:"positionLabel"`
		DateFrom      time.Time  `json:"dateFrom"`
		DateTo        *time.Time `json:"dateTo"`
	}
	items := []hiveLocationEntry{}
	for rows.Next() {
		var e hiveLocationEntry
		if err := rows.Scan(&e.ID, &e.ApiaryID, &e.ApiaryName, &e.PositionLabel,
			&e.DateFrom, &e.DateTo); err != nil {
			writeError(w, http.StatusInternalServerError, "database error")
			return
		}
		items = append(items, e)
	}
	if rows.Err() != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	writeJSON(w, http.StatusOK, items)
}
