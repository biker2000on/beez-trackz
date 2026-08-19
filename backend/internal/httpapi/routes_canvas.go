package httpapi

import (
	"context"
	"encoding/json"
	"math"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

func (s *Server) mountCanvas(r chi.Router) {
	r.With(s.requireApiaryParamRole(true)).
		Put("/apiaries/{id}/canvas-layout", s.handleCanvasSaveLayout)
	r.Post("/canvas/hives", s.handleCanvasCreateHive)
	r.With(s.requireHiveParamRole(true)).
		Patch("/canvas/hives/{id}", s.handleCanvasUpdateHive)
	r.With(s.requireHiveParamRole(true)).
		Post("/canvas/hives/{id}/assign-slot", s.handleCanvasAssignSlot)
	r.With(s.requireHiveParamRole(true)).
		Post("/canvas/hives/{id}/placement", s.handleCanvasSetPlacement)
	r.With(s.requireHiveParamRole(true)).
		Post("/canvas/hives/{id}/remove-slot", s.handleCanvasRemoveSlot)
	r.With(s.requireHiveParamRole(true)).
		Post("/canvas/hives/{id}/facing", s.handleCanvasSetFacing)
}

// canvasStand is the persisted stand geometry (see src/lib/canvas/types.ts).
type canvasStand struct {
	ID        string   `json:"id"`
	Label     string   `json:"label"`
	X         float64  `json:"x"`
	Y         float64  `json:"y"`
	Rotation  float64  `json:"rotation"`
	Rows      int      `json:"rows"`
	Cols      int      `json:"cols"`
	Latitude  *float64 `json:"latitude,omitempty"`
	Longitude *float64 `json:"longitude,omitempty"`
}

type canvasNorthArrow struct {
	X        float64 `json:"x"`
	Y        float64 `json:"y"`
	Rotation float64 `json:"rotation"`
}

// canvasRegistration is the stand-layer transform relative to the apiary pin.
// Occupied slots derive lat/lng from this plus stand geometry — never a
// second stored layout.
type canvasRegistration struct {
	OriginX  float64 `json:"originX"`
	OriginY  float64 `json:"originY"`
	OffsetX  float64 `json:"offsetX"`
	OffsetY  float64 `json:"offsetY"`
	Rotation float64 `json:"rotation"`
	Scale    float64 `json:"scale"`
}

// canvasMapView is the last Leaflet center/zoom (Leaflet owns pan/zoom).
type canvasMapView struct {
	CenterLat float64 `json:"centerLat"`
	CenterLng float64 `json:"centerLng"`
	Zoom      float64 `json:"zoom"`
}

// canvasLayoutJSON is the geometry-only blob persisted to
// apiaries.canvas_layout. Hive slot occupancy lives in relational hive
// columns and is never written here.
type canvasLayoutJSON struct {
	Stands       []canvasStand       `json:"stands"`
	NorthArrow   *canvasNorthArrow   `json:"northArrow,omitempty"`
	Zoom         *float64            `json:"zoom,omitempty"`
	OffsetX      *float64            `json:"offsetX,omitempty"`
	OffsetY      *float64            `json:"offsetY,omitempty"`
	Registration *canvasRegistration `json:"registration,omitempty"`
	MapView      *canvasMapView      `json:"mapView,omitempty"`
}

// canvasSlotLabel mirrors getSlotLabel: "{standLabel}{row*cols+col+1}".
func canvasSlotLabel(standLabel string, row, col, cols int) string {
	return standLabel + strconv.Itoa(row*cols+col+1)
}

// PUT /apiaries/{id}/canvas-layout — persists geometry only, stripping any
// legacy embedded occupancy (stands[].slots, flat hives map, etc.).
func (s *Server) handleCanvasSaveLayout(w http.ResponseWriter, r *http.Request) {
	id, err := uuidParam(r, "id")
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	// Lenient decode on purpose: unknown fields (legacy occupancy) are dropped.
	var layout canvasLayoutJSON
	if err := json.NewDecoder(r.Body).Decode(&layout); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if layout.Stands == nil {
		layout.Stands = []canvasStand{}
	}
	for _, stand := range layout.Stands {
		if !canvasValidLatLng(stand.Latitude, stand.Longitude) {
			writeError(w, http.StatusBadRequest, "stand latitude/longitude out of range")
			return
		}
	}
	blob, err := json.Marshal(layout)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid layout")
		return
	}
	tag, err := s.pool.Exec(r.Context(),
		`UPDATE apiaries SET canvas_layout = $1 WHERE id = $2`, blob, id)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	if tag.RowsAffected() == 0 {
		writeError(w, http.StatusNotFound, "apiary not found")
		return
	}
	if err := s.syncYardGps(r.Context(), id, layout.Stands); err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"success": true})
}

const (
	canvasCellSize     = 60.0
	canvasPxPerMeter   = canvasCellSize / 0.75
	canvasMetersPerLat = 111320.0
)

func canvasStandHasGPS(stand canvasStand) bool {
	return stand.Latitude != nil && stand.Longitude != nil
}

func canvasOffsetLatLng(lat, lng, eastM, southM float64) (float64, float64) {
	return lat - southM/canvasMetersPerLat,
		lng + eastM/(canvasMetersPerLat*math.Cos(lat*math.Pi/180))
}

func canvasSlotGPS(stand canvasStand, row, col int) (lat, lng float64, ok bool) {
	if !canvasStandHasGPS(stand) {
		return 0, 0, false
	}
	w := float64(stand.Cols) * canvasCellSize
	h := float64(stand.Rows) * canvasCellSize
	localX := float64(col)*canvasCellSize + canvasCellSize/2 - w/2
	localY := float64(row)*canvasCellSize + canvasCellSize/2 - h/2
	rad := stand.Rotation * math.Pi / 180
	east := (localX*math.Cos(rad) - localY*math.Sin(rad)) / canvasPxPerMeter
	south := (localX*math.Sin(rad) + localY*math.Cos(rad)) / canvasPxPerMeter
	lat, lng = canvasOffsetLatLng(*stand.Latitude, *stand.Longitude, east, south)
	return lat, lng, true
}

func canvasYardCentroid(stands []canvasStand) (lat, lng float64, ok bool) {
	n := 0
	for _, stand := range stands {
		if !canvasStandHasGPS(stand) {
			continue
		}
		lat += *stand.Latitude
		lng += *stand.Longitude
		n++
	}
	if n == 0 {
		return 0, 0, false
	}
	return lat / float64(n), lng / float64(n), true
}

// canvasDB is the slice of pgx shared by *pgxpool.Pool and pgx.Tx that the
// GPS sync needs, so it can run inside a caller's transaction.
type canvasDB interface {
	Exec(ctx context.Context, sql string, args ...any) (pgconn.CommandTag, error)
	Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error)
	QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
}

// canvasValidLatLng reports whether an optional lat/lng pair is usable: both
// present or both absent, finite, and inside the WGS84 range.
func canvasValidLatLng(lat, lng *float64) bool {
	if lat == nil && lng == nil {
		return true
	}
	if lat == nil || lng == nil {
		return false
	}
	if math.IsNaN(*lat) || math.IsInf(*lat, 0) || math.IsNaN(*lng) || math.IsInf(*lng, 0) {
		return false
	}
	return *lat >= -90 && *lat <= 90 && *lng >= -180 && *lng <= 180
}

// syncYardGps recomputes every placed hive's lat/lng in the apiary from the
// stand geometry, inside one transaction. Unplaced hives and hives on stands
// without GPS get NULL — no invented coordinates. The apiary pin itself is
// operator-set (apiary form / SetLocationDialog) and is never touched here.
func (s *Server) syncYardGps(ctx context.Context, apiaryID uuid.UUID, stands []canvasStand) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if err := canvasSyncYardGps(ctx, tx, apiaryID, stands); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func canvasSyncYardGps(ctx context.Context, db canvasDB, apiaryID uuid.UUID, stands []canvasStand) error {
	byID := make(map[string]canvasStand, len(stands))
	for _, stand := range stands {
		byID[stand.ID] = stand
	}
	rows, err := db.Query(ctx, `
		SELECT id, stand_id, slot_row, slot_col
		FROM hives
		WHERE apiary_id = $1 AND stand_id IS NOT NULL
		  AND slot_row IS NOT NULL AND slot_col IS NOT NULL`, apiaryID)
	if err != nil {
		return err
	}
	type placed struct {
		id       uuid.UUID
		lat, lng float64
	}
	var updates []placed
	for rows.Next() {
		var (
			hiveID           uuid.UUID
			standID          string
			slotRow, slotCol int
		)
		if err := rows.Scan(&hiveID, &standID, &slotRow, &slotCol); err != nil {
			rows.Close()
			return err
		}
		stand, ok := byID[standID]
		if !ok {
			continue
		}
		if lat, lng, ok := canvasSlotGPS(stand, slotRow, slotCol); ok {
			updates = append(updates, placed{hiveID, lat, lng})
		}
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return err
	}
	if _, err := db.Exec(ctx, `
		UPDATE hives SET latitude = NULL, longitude = NULL
		WHERE apiary_id = $1`, apiaryID); err != nil {
		return err
	}
	for _, u := range updates {
		if _, err := db.Exec(ctx, `
			UPDATE hives SET latitude = $1, longitude = $2 WHERE id = $3`,
			u.lat, u.lng, u.id); err != nil {
			return err
		}
	}
	return nil
}

// canvasSyncHiveGps derives one hive's lat/lng from its current slot and the
// apiary's stored stand geometry. Call after the slot columns are written,
// in the same transaction.
func canvasSyncHiveGps(ctx context.Context, db canvasDB, hiveID uuid.UUID) error {
	var (
		standID          *string
		slotRow, slotCol *int
		blob             []byte
	)
	if err := db.QueryRow(ctx, `
		SELECT h.stand_id, h.slot_row, h.slot_col, a.canvas_layout
		FROM hives h JOIN apiaries a ON a.id = h.apiary_id
		WHERE h.id = $1`, hiveID).Scan(&standID, &slotRow, &slotCol, &blob); err != nil {
		return err
	}
	var lat, lng *float64
	if standID != nil && slotRow != nil && slotCol != nil && len(blob) > 0 {
		var layout canvasLayoutJSON
		if err := json.Unmarshal(blob, &layout); err == nil {
			for _, stand := range layout.Stands {
				if stand.ID != *standID {
					continue
				}
				if la, ln, ok := canvasSlotGPS(stand, *slotRow, *slotCol); ok {
					lat, lng = &la, &ln
				}
				break
			}
		}
	}
	_, err := db.Exec(ctx, `
		UPDATE hives SET latitude = $1, longitude = $2 WHERE id = $3`, lat, lng, hiveID)
	return err
}

// POST /canvas/hives — create a hive directly in a stand slot.
func (s *Server) handleCanvasCreateHive(w http.ResponseWriter, r *http.Request) {
	var req struct {
		ApiaryID   string `json:"apiaryId"`
		StandID    string `json:"standId"`
		StandLabel string `json:"standLabel"`
		SlotRow    *int   `json:"slotRow"`
		SlotCol    *int   `json:"slotCol"`
		StandCols  int    `json:"standCols"`
	}
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	switch {
	case strings.TrimSpace(req.ApiaryID) == "":
		writeError(w, http.StatusBadRequest, "Apiary is required")
		return
	case strings.TrimSpace(req.StandID) == "" || strings.TrimSpace(req.StandLabel) == "":
		writeError(w, http.StatusBadRequest, "Stand is required")
		return
	case req.SlotRow == nil || req.SlotCol == nil || *req.SlotRow < 0 || *req.SlotCol < 0:
		writeError(w, http.StatusBadRequest, "Slot row and column are required")
		return
	case req.StandCols < 1:
		writeError(w, http.StatusBadRequest, "standCols must be at least 1")
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
	label := canvasSlotLabel(strings.TrimSpace(req.StandLabel), *req.SlotRow, *req.SlotCol, req.StandCols)

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
		INSERT INTO hives (apiary_id, position_label, stand_id, slot_row, slot_col, placement, status)
		VALUES ($1, $2, $3, $4, $5, 'full', 'active')
		RETURNING id`,
		req.ApiaryID, label, strings.TrimSpace(req.StandID), *req.SlotRow, *req.SlotCol).Scan(&id); err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	// Unlike the legacy action, canvas creation also records location history
	// (rewrite unifies all hive-creation write paths).
	if _, err := tx.Exec(ctx, `
		INSERT INTO hive_location_history (hive_id, apiary_id, position_label, date_from)
		VALUES ($1, $2, $3, $4)`, id, req.ApiaryID, label, time.Now()); err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	if err := canvasSyncHiveGps(ctx, tx, uuid.MustParse(id)); err != nil {
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

// PATCH /canvas/hives/{id} {positionLabel, status, notes, placement?} —
// placement is only written when explicitly provided (legacy bug reset it).
func (s *Server) handleCanvasUpdateHive(w http.ResponseWriter, r *http.Request) {
	id, err := uuidParam(r, "id")
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	var req struct {
		PositionLabel string  `json:"positionLabel"`
		Status        string  `json:"status"`
		Notes         string  `json:"notes"`
		Placement     *string `json:"placement"`
	}
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	label := strings.TrimSpace(req.PositionLabel)
	if label == "" {
		writeError(w, http.StatusBadRequest, "Position label is required")
		return
	}
	if !hiveValidStatus(req.Status) {
		writeError(w, http.StatusBadRequest, "invalid status")
		return
	}
	if req.Placement != nil && !hiveValidPlacement(*req.Placement) {
		writeError(w, http.StatusBadRequest, "invalid placement")
		return
	}

	var tag pgconn.CommandTag
	if req.Placement != nil {
		tag, err = s.pool.Exec(r.Context(), `
			UPDATE hives SET position_label = $1, status = $2, notes = $3, placement = $4
			WHERE id = $5`, label, req.Status, hiveTextOrNil(&req.Notes), *req.Placement, id)
	} else {
		tag, err = s.pool.Exec(r.Context(), `
			UPDATE hives SET position_label = $1, status = $2, notes = $3
			WHERE id = $4`, label, req.Status, hiveTextOrNil(&req.Notes), id)
	}
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

// POST /canvas/hives/{id}/assign-slot — THE single write path for canvas
// placement: closes the open location-history row, opens a new one with the
// slot label, and updates the hive's slot columns.
func (s *Server) handleCanvasAssignSlot(w http.ResponseWriter, r *http.Request) {
	id, err := uuidParam(r, "id")
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	var req struct {
		ApiaryID   string  `json:"apiaryId"`
		StandID    string  `json:"standId"`
		StandLabel string  `json:"standLabel"`
		SlotRow    *int    `json:"slotRow"`
		SlotCol    *int    `json:"slotCol"`
		StandCols  int     `json:"standCols"`
		Placement  *string `json:"placement"`
	}
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	switch {
	case strings.TrimSpace(req.ApiaryID) == "":
		writeError(w, http.StatusBadRequest, "Apiary is required")
		return
	case strings.TrimSpace(req.StandID) == "" || strings.TrimSpace(req.StandLabel) == "":
		writeError(w, http.StatusBadRequest, "Stand is required")
		return
	case req.SlotRow == nil || req.SlotCol == nil || *req.SlotRow < 0 || *req.SlotCol < 0:
		writeError(w, http.StatusBadRequest, "Slot row and column are required")
		return
	case req.StandCols < 1:
		writeError(w, http.StatusBadRequest, "standCols must be at least 1")
		return
	}
	if _, err := uuid.Parse(req.ApiaryID); err != nil {
		writeError(w, http.StatusBadRequest, "invalid apiaryId")
		return
	}
	placement := "full"
	if req.Placement != nil && *req.Placement != "" {
		placement = *req.Placement
	}
	if !hiveValidPlacement(placement) {
		writeError(w, http.StatusBadRequest, "invalid placement")
		return
	}
	label := canvasSlotLabel(strings.TrimSpace(req.StandLabel), *req.SlotRow, *req.SlotCol, req.StandCols)

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

	// A slot holds at most two hives, split by placement. Enforce here so
	// concurrent tabs (or clients with stale occupancy) can't pile hives on
	// top of each other. The client's stack-choice dialog picks the pair.
	var occupants int
	var placementTaken bool
	if err := tx.QueryRow(ctx, `
		SELECT count(*),
		       COALESCE(bool_or(placement = $1), false)
		FROM hives
		WHERE stand_id = $2 AND slot_row = $3 AND slot_col = $4 AND id <> $5
		  AND status = 'active' AND NOT is_archived`,
		placement, strings.TrimSpace(req.StandID), *req.SlotRow, *req.SlotCol, id).
		Scan(&occupants, &placementTaken); err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	if occupants >= 2 {
		writeError(w, http.StatusConflict, "That slot already holds two hives")
		return
	}
	if occupants == 1 && (placement == "full" || placementTaken) {
		writeError(w, http.StatusConflict, "That slot position is already taken — pick the other half")
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
		UPDATE hives SET position_label = $1, stand_id = $2, slot_row = $3, slot_col = $4,
			placement = $5
		WHERE id = $6`,
		label, strings.TrimSpace(req.StandID), *req.SlotRow, *req.SlotCol, placement, id); err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	if err := canvasSyncHiveGps(ctx, tx, id); err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	if err := tx.Commit(ctx); err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"positionLabel": label})
}

// POST /canvas/hives/{id}/placement {placement}
func (s *Server) handleCanvasSetPlacement(w http.ResponseWriter, r *http.Request) {
	id, err := uuidParam(r, "id")
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	var req struct {
		Placement string `json:"placement"`
	}
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if !hiveValidPlacement(req.Placement) {
		writeError(w, http.StatusBadRequest, "invalid placement")
		return
	}
	tag, err := s.pool.Exec(r.Context(),
		`UPDATE hives SET placement = $1 WHERE id = $2`, req.Placement, id)
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

// POST /canvas/hives/{id}/remove-slot — clears the slot assignment, keeps the hive.
func (s *Server) handleCanvasRemoveSlot(w http.ResponseWriter, r *http.Request) {
	id, err := uuidParam(r, "id")
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	tag, err := s.pool.Exec(r.Context(), `
		UPDATE hives SET stand_id = NULL, slot_row = NULL, slot_col = NULL, placement = 'full',
			latitude = NULL, longitude = NULL
		WHERE id = $1`, id)
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

// POST /canvas/hives/{id}/facing {facingDegrees}
func (s *Server) handleCanvasSetFacing(w http.ResponseWriter, r *http.Request) {
	id, err := uuidParam(r, "id")
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	var req struct {
		FacingDegrees float64 `json:"facingDegrees"`
	}
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	normalized := ((int(math.Round(req.FacingDegrees)) % 360) + 360) % 360
	tag, err := s.pool.Exec(r.Context(),
		`UPDATE hives SET facing_degrees = $1 WHERE id = $2`, normalized, id)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	if tag.RowsAffected() == 0 {
		writeError(w, http.StatusNotFound, "hive not found")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"success": true, "facingDegrees": normalized})
}
