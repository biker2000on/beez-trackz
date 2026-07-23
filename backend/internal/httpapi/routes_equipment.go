package httpapi

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgconn"
)

// Equipment v2: a type catalog, stock rows with an auditable adjustment
// ledger (total_owned is kept in sync transactionally), and deployments onto
// hives. Availability is derived: available = totalOwned − active deployments.

func (s *Server) mountEquipment(r chi.Router) {
	r.Get("/equipment/types", s.equipListTypes)
	r.Post("/equipment/types", s.equipCreateType)

	r.Get("/equipment/stock", s.equipListStock)
	r.Post("/equipment/stock", s.equipCreateStock)
	r.Post("/equipment/stock/bulk-adjust", s.equipBulkAdjustStock)
	r.Patch("/equipment/stock/{id}", s.equipUpdateStock)
	r.Post("/equipment/stock/{id}/adjust", s.equipAdjustStock)
	r.Get("/equipment/stock/{id}/adjustments", s.equipListAdjustments)

	r.Post("/equipment/deployments", s.equipDeploy)
	r.Post("/equipment/deployments/{id}/remove", s.equipRemoveDeployment)
	r.Get("/equipment/deployments/active", s.equipActiveDeployments)
	r.Get("/hives/{id}/deployments", s.equipHiveDeployments)

	r.Get("/equipment/frame-summary", s.equipFrameSummary)
	r.Post("/equipment/seed-defaults", s.equipSeedDefaults)
}

func equipTrimPtr(p *string) *string {
	if p == nil {
		return nil
	}
	v := strings.TrimSpace(*p)
	if v == "" {
		return nil
	}
	return &v
}

func equipPgErrCode(err error, code string) bool {
	var pgErr *pgconn.PgError
	return errors.As(err, &pgErr) && pgErr.Code == code
}

var equipCategories = map[string]bool{
	"box": true, "cover": true, "bottom": true, "accessory": true, "frame": true, "other": true,
}

var equipAdjustmentReasons = map[string]bool{
	"purchased": true, "built": true, "discarded": true, "broken": true, "gifted": true, "other": true,
}

// --- types ---

type equipTypeRow struct {
	ID           uuid.UUID `json:"id"`
	Name         string    `json:"name"`
	Category     string    `json:"category"`
	FramesPerBox *int      `json:"framesPerBox"`
	IsDefault    bool      `json:"isDefault"`
	CreatedAt    time.Time `json:"createdAt"`
}

// GET /equipment/types
func (s *Server) equipListTypes(w http.ResponseWriter, r *http.Request) {
	rows, err := s.pool.Query(r.Context(), `
		SELECT id, name, category, frames_per_box, is_default, created_at
		FROM equipment_types
		ORDER BY category, name`)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	defer rows.Close()
	out := make([]equipTypeRow, 0)
	for rows.Next() {
		var row equipTypeRow
		if err := rows.Scan(&row.ID, &row.Name, &row.Category, &row.FramesPerBox,
			&row.IsDefault, &row.CreatedAt); err != nil {
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

// POST /equipment/types {name, category, framesPerBox?}
func (s *Server) equipCreateType(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Name         string `json:"name"`
		Category     string `json:"category"`
		FramesPerBox *int   `json:"framesPerBox"`
	}
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	name := strings.TrimSpace(req.Name)
	if name == "" {
		writeError(w, http.StatusBadRequest, "Name is required")
		return
	}
	if req.Category == "" {
		writeError(w, http.StatusBadRequest, "Category is required")
		return
	}
	if !equipCategories[req.Category] {
		writeError(w, http.StatusBadRequest, "invalid category")
		return
	}

	var id uuid.UUID
	err := s.pool.QueryRow(r.Context(), `
		INSERT INTO equipment_types (name, category, frames_per_box)
		VALUES ($1, $2, $3)
		RETURNING id`,
		name, req.Category, req.FramesPerBox).Scan(&id)
	if err != nil {
		if equipPgErrCode(err, "23505") {
			writeError(w, http.StatusConflict, fmt.Sprintf("%q already exists", name))
			return
		}
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"success": true, "id": id})
}

// --- stock ---

// GET /equipment/stock — with deployed / available derived per row.
func (s *Server) equipListStock(w http.ResponseWriter, r *http.Request) {
	rows, err := s.pool.Query(r.Context(), `
		SELECT es.id, es.type_id, et.name, et.category, es.total_owned,
		       es.storage_location, es.notes, es.frame_condition, et.frames_per_box,
		       COALESCE(d.deployed, 0)
		FROM equipment_stock es
		JOIN equipment_types et ON et.id = es.type_id
		LEFT JOIN (
			SELECT stock_id, SUM(quantity) AS deployed
			FROM equipment_deployments
			WHERE date_removed IS NULL
			GROUP BY stock_id
		) d ON d.stock_id = es.id
		ORDER BY et.category, et.name`)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	defer rows.Close()

	type stockRow struct {
		ID              uuid.UUID `json:"id"`
		TypeID          uuid.UUID `json:"typeId"`
		TypeName        string    `json:"typeName"`
		TypeCategory    string    `json:"typeCategory"`
		TotalOwned      int       `json:"totalOwned"`
		StorageLocation *string   `json:"storageLocation"`
		Notes           *string   `json:"notes"`
		FrameCondition  *string   `json:"frameCondition"`
		FramesPerBox    *int      `json:"framesPerBox"`
		Deployed        int       `json:"deployed"`
		Available       int       `json:"available"`
	}
	out := make([]stockRow, 0)
	for rows.Next() {
		var row stockRow
		if err := rows.Scan(&row.ID, &row.TypeID, &row.TypeName, &row.TypeCategory,
			&row.TotalOwned, &row.StorageLocation, &row.Notes, &row.FrameCondition,
			&row.FramesPerBox, &row.Deployed); err != nil {
			writeError(w, http.StatusInternalServerError, "database error")
			return
		}
		row.Available = row.TotalOwned - row.Deployed
		out = append(out, row)
	}
	if rows.Err() != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	writeJSON(w, http.StatusOK, out)
}

// POST /equipment/stock {typeId, initialQuantity?, storageLocation?, notes?, frameCondition?}
func (s *Server) equipCreateStock(w http.ResponseWriter, r *http.Request) {
	var req struct {
		TypeID          string  `json:"typeId"`
		InitialQuantity *int    `json:"initialQuantity"`
		StorageLocation *string `json:"storageLocation"`
		Notes           *string `json:"notes"`
		FrameCondition  *string `json:"frameCondition"`
	}
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if req.TypeID == "" {
		writeError(w, http.StatusBadRequest, "Equipment type is required")
		return
	}
	typeID, err := uuid.Parse(req.TypeID)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid typeId")
		return
	}
	condition := equipTrimPtr(req.FrameCondition)
	if condition != nil && *condition != "drawn" && *condition != "fresh" {
		writeError(w, http.StatusBadRequest, "invalid frameCondition")
		return
	}
	initial := 0
	if req.InitialQuantity != nil {
		initial = *req.InitialQuantity
	}

	ctx := r.Context()
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	defer tx.Rollback(ctx)

	var stockID uuid.UUID
	err = tx.QueryRow(ctx, `
		INSERT INTO equipment_stock (type_id, total_owned, frame_condition, storage_location, notes)
		VALUES ($1, $2, $3, $4, $5)
		RETURNING id`,
		typeID, initial, condition, equipTrimPtr(req.StorageLocation), equipTrimPtr(req.Notes)).
		Scan(&stockID)
	if err != nil {
		if equipPgErrCode(err, "23503") {
			writeError(w, http.StatusBadRequest, "invalid typeId")
			return
		}
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	if initial > 0 {
		if _, err := tx.Exec(ctx, `
			INSERT INTO equipment_stock_adjustments (stock_id, quantity, reason, notes, date)
			VALUES ($1, $2, 'purchased', 'Initial stock', now())`,
			stockID, initial); err != nil {
			writeError(w, http.StatusInternalServerError, "database error")
			return
		}
	}
	if err := tx.Commit(ctx); err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"success": true, "id": stockID})
}

// PATCH /equipment/stock/{id} {storageLocation?, notes?} — only fields present
// in the body are touched (empty string or null clears).
func (s *Server) equipUpdateStock(w http.ResponseWriter, r *http.Request) {
	id, err := uuidParam(r, "id")
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	var req struct {
		StorageLocation json.RawMessage `json:"storageLocation"`
		Notes           json.RawMessage `json:"notes"`
	}
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}

	sets := make([]string, 0, 2)
	args := make([]any, 0, 3)
	addRaw := func(column string, raw json.RawMessage) bool {
		var v *string
		if err := json.Unmarshal(raw, &v); err != nil {
			return false
		}
		args = append(args, equipTrimPtr(v))
		sets = append(sets, fmt.Sprintf("%s = $%d", column, len(args)))
		return true
	}
	if req.StorageLocation != nil && !addRaw("storage_location", req.StorageLocation) {
		writeError(w, http.StatusBadRequest, "invalid storageLocation")
		return
	}
	if req.Notes != nil && !addRaw("notes", req.Notes) {
		writeError(w, http.StatusBadRequest, "invalid notes")
		return
	}
	if len(sets) == 0 {
		writeJSON(w, http.StatusOK, map[string]any{"success": true})
		return
	}

	args = append(args, id)
	query := fmt.Sprintf("UPDATE equipment_stock SET %s WHERE id = $%d",
		strings.Join(sets, ", "), len(args))
	tag, err := s.pool.Exec(r.Context(), query, args...)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	if tag.RowsAffected() == 0 {
		writeError(w, http.StatusNotFound, "stock not found")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"success": true})
}

// POST /equipment/stock/{id}/adjust {quantity, reason, notes?, date?}
func (s *Server) equipAdjustStock(w http.ResponseWriter, r *http.Request) {
	stockID, err := uuidParam(r, "id")
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	var req struct {
		Quantity int     `json:"quantity"`
		Reason   string  `json:"reason"`
		Notes    *string `json:"notes"`
		Date     *string `json:"date"`
	}
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if req.Quantity == 0 {
		writeError(w, http.StatusBadRequest, "Quantity must be non-zero")
		return
	}
	if req.Reason == "" {
		writeError(w, http.StatusBadRequest, "Reason is required")
		return
	}
	if !equipAdjustmentReasons[req.Reason] {
		writeError(w, http.StatusBadRequest, "invalid reason")
		return
	}
	date := time.Now()
	if d, err := parseDatePtr(req.Date); err != nil {
		writeError(w, http.StatusBadRequest, "invalid date")
		return
	} else if d != nil {
		date = *d
	}

	ctx := r.Context()
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	defer tx.Rollback(ctx)

	tag, err := tx.Exec(ctx,
		`UPDATE equipment_stock SET total_owned = total_owned + $1 WHERE id = $2`,
		req.Quantity, stockID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	if tag.RowsAffected() == 0 {
		writeError(w, http.StatusNotFound, "stock not found")
		return
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO equipment_stock_adjustments (stock_id, quantity, reason, notes, date)
		VALUES ($1, $2, $3, $4, $5)`,
		stockID, req.Quantity, req.Reason, equipTrimPtr(req.Notes), date); err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	if err := tx.Commit(ctx); err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"success": true})
}

// GET /equipment/stock/{id}/adjustments
func (s *Server) equipListAdjustments(w http.ResponseWriter, r *http.Request) {
	stockID, err := uuidParam(r, "id")
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	rows, err := s.pool.Query(r.Context(), `
		SELECT id, stock_id, quantity, reason, notes, date, created_at
		FROM equipment_stock_adjustments
		WHERE stock_id = $1
		ORDER BY date DESC`, stockID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	defer rows.Close()

	type adjustmentRow struct {
		ID        uuid.UUID `json:"id"`
		StockID   uuid.UUID `json:"stockId"`
		Quantity  int       `json:"quantity"`
		Reason    string    `json:"reason"`
		Notes     *string   `json:"notes"`
		Date      time.Time `json:"date"`
		CreatedAt time.Time `json:"createdAt"`
	}
	out := make([]adjustmentRow, 0)
	for rows.Next() {
		var row adjustmentRow
		if err := rows.Scan(&row.ID, &row.StockID, &row.Quantity, &row.Reason,
			&row.Notes, &row.Date, &row.CreatedAt); err != nil {
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

// POST /equipment/stock/bulk-adjust {date?, reason?, lines:[{stockId, newTotal}]}
// Deltas vs current totals are recorded as 'other' adjustments so the history
// stays auditable.
func (s *Server) equipBulkAdjustStock(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Date   *string `json:"date"`
		Reason *string `json:"reason"`
		Lines  []struct {
			StockID  string `json:"stockId"`
			NewTotal int    `json:"newTotal"`
		} `json:"lines"`
	}
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	type bulkLine struct {
		StockID  uuid.UUID
		NewTotal int
	}
	lines := make([]bulkLine, 0, len(req.Lines))
	for _, l := range req.Lines {
		if l.StockID == "" || l.NewTotal < 0 {
			continue
		}
		id, err := uuid.Parse(l.StockID)
		if err != nil {
			writeError(w, http.StatusBadRequest, "invalid stockId")
			return
		}
		lines = append(lines, bulkLine{StockID: id, NewTotal: l.NewTotal})
	}
	if len(lines) == 0 {
		writeError(w, http.StatusBadRequest, "No changes to apply")
		return
	}
	date := time.Now()
	if d, err := parseDatePtr(req.Date); err != nil {
		writeError(w, http.StatusBadRequest, "invalid date")
		return
	} else if d != nil {
		date = *d
	}
	notes := "bulk edit"
	if v := equipTrimPtr(req.Reason); v != nil {
		notes = *v
	}

	ctx := r.Context()
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	defer tx.Rollback(ctx)

	for _, line := range lines {
		var current int
		err := tx.QueryRow(ctx,
			`SELECT total_owned FROM equipment_stock WHERE id = $1 FOR UPDATE`,
			line.StockID).Scan(&current)
		if err != nil {
			// Missing rows are skipped, mirroring the legacy behavior.
			continue
		}
		delta := line.NewTotal - current
		if delta == 0 {
			continue
		}
		if _, err := tx.Exec(ctx, `
			INSERT INTO equipment_stock_adjustments (stock_id, quantity, reason, notes, date)
			VALUES ($1, $2, 'other', $3, $4)`,
			line.StockID, delta, notes, date); err != nil {
			writeError(w, http.StatusInternalServerError, "database error")
			return
		}
		if _, err := tx.Exec(ctx,
			`UPDATE equipment_stock SET total_owned = $1 WHERE id = $2`,
			line.NewTotal, line.StockID); err != nil {
			writeError(w, http.StatusInternalServerError, "database error")
			return
		}
	}
	if err := tx.Commit(ctx); err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"success": true})
}

// --- deployments ---

// POST /equipment/deployments {stockId, hiveId, quantity?, notes?}
func (s *Server) equipDeploy(w http.ResponseWriter, r *http.Request) {
	var req struct {
		StockID  string  `json:"stockId"`
		HiveID   string  `json:"hiveId"`
		Quantity *int    `json:"quantity"`
		Notes    *string `json:"notes"`
	}
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if req.StockID == "" {
		writeError(w, http.StatusBadRequest, "Equipment stock is required")
		return
	}
	stockID, err := uuid.Parse(req.StockID)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid stockId")
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
	quantity := 1
	if req.Quantity != nil {
		quantity = *req.Quantity
	}
	if quantity < 1 {
		writeError(w, http.StatusBadRequest, "Quantity must be at least 1")
		return
	}

	var id uuid.UUID
	err = s.pool.QueryRow(r.Context(), `
		INSERT INTO equipment_deployments (stock_id, hive_id, quantity, date_deployed, notes)
		VALUES ($1, $2, $3, now(), $4)
		RETURNING id`,
		stockID, hiveID, quantity, equipTrimPtr(req.Notes)).Scan(&id)
	if err != nil {
		if equipPgErrCode(err, "23503") {
			writeError(w, http.StatusBadRequest, "invalid stockId or hiveId")
			return
		}
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"success": true, "id": id})
}

// POST /equipment/deployments/{id}/remove
func (s *Server) equipRemoveDeployment(w http.ResponseWriter, r *http.Request) {
	id, err := uuidParam(r, "id")
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	tag, err := s.pool.Exec(r.Context(),
		`UPDATE equipment_deployments SET date_removed = now() WHERE id = $1`, id)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	if tag.RowsAffected() == 0 {
		writeError(w, http.StatusNotFound, "deployment not found")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"success": true})
}

// GET /equipment/deployments/active — active deployments with type + hive labels.
func (s *Server) equipActiveDeployments(w http.ResponseWriter, r *http.Request) {
	rows, err := s.pool.Query(r.Context(), `
		SELECT ed.id, ed.stock_id, ed.quantity, h.position_label, et.name, et.category
		FROM equipment_deployments ed
		JOIN hives h ON h.id = ed.hive_id
		JOIN equipment_stock es ON es.id = ed.stock_id
		JOIN equipment_types et ON et.id = es.type_id
		WHERE ed.date_removed IS NULL
		ORDER BY h.position_label`)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	defer rows.Close()

	type activeRow struct {
		ID           uuid.UUID `json:"id"`
		StockID      uuid.UUID `json:"stockId"`
		Quantity     int       `json:"quantity"`
		HiveLabel    string    `json:"hiveLabel"`
		TypeName     string    `json:"typeName"`
		TypeCategory string    `json:"typeCategory"`
	}
	out := make([]activeRow, 0)
	for rows.Next() {
		var row activeRow
		if err := rows.Scan(&row.ID, &row.StockID, &row.Quantity, &row.HiveLabel,
			&row.TypeName, &row.TypeCategory); err != nil {
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

// GET /hives/{id}/deployments — full deployment history for one hive.
func (s *Server) equipHiveDeployments(w http.ResponseWriter, r *http.Request) {
	hiveID, err := uuidParam(r, "id")
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	rows, err := s.pool.Query(r.Context(), `
		SELECT ed.id, ed.stock_id, ed.quantity, ed.date_deployed, ed.date_removed,
		       ed.notes, et.name, et.category
		FROM equipment_deployments ed
		JOIN equipment_stock es ON es.id = ed.stock_id
		JOIN equipment_types et ON et.id = es.type_id
		WHERE ed.hive_id = $1
		ORDER BY ed.date_deployed DESC`, hiveID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	defer rows.Close()

	type deploymentRow struct {
		ID           uuid.UUID  `json:"id"`
		StockID      uuid.UUID  `json:"stockId"`
		Quantity     int        `json:"quantity"`
		DateDeployed time.Time  `json:"dateDeployed"`
		DateRemoved  *time.Time `json:"dateRemoved"`
		Notes        *string    `json:"notes"`
		TypeName     string     `json:"typeName"`
		TypeCategory string     `json:"typeCategory"`
	}
	out := make([]deploymentRow, 0)
	for rows.Next() {
		var row deploymentRow
		if err := rows.Scan(&row.ID, &row.StockID, &row.Quantity, &row.DateDeployed,
			&row.DateRemoved, &row.Notes, &row.TypeName, &row.TypeCategory); err != nil {
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

// --- frame summary ---

// GET /equipment/frame-summary — standalone frames (by condition, minus active
// deployments) plus frame capacity of deployed boxes.
func (s *Server) equipFrameSummary(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()

	// Standalone frame stock by condition, minus what is deployed.
	rows, err := s.pool.Query(ctx, `
		SELECT es.frame_condition, es.total_owned - COALESCE(d.deployed, 0)
		FROM equipment_stock es
		JOIN equipment_types et ON et.id = es.type_id
		LEFT JOIN (
			SELECT stock_id, SUM(quantity) AS deployed
			FROM equipment_deployments
			WHERE date_removed IS NULL
			GROUP BY stock_id
		) d ON d.stock_id = es.id
		WHERE et.category = 'frame'`)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	var drawn, fresh, unspecified int
	for rows.Next() {
		var condition *string
		var available int
		if err := rows.Scan(&condition, &available); err != nil {
			rows.Close()
			writeError(w, http.StatusInternalServerError, "database error")
			return
		}
		switch {
		case condition != nil && *condition == "drawn":
			drawn += available
		case condition != nil && *condition == "fresh":
			fresh += available
		default:
			unspecified += available
		}
	}
	rows.Close()
	if rows.Err() != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}

	// Deployed boxes with a frames-per-box capacity.
	boxRows, err := s.pool.Query(ctx, `
		SELECT et.name, et.frames_per_box, COALESCE(SUM(ed.quantity), 0)::int
		FROM equipment_deployments ed
		JOIN equipment_stock es ON es.id = ed.stock_id
		JOIN equipment_types et ON et.id = es.type_id
		WHERE ed.date_removed IS NULL
		  AND et.category = 'box'
		  AND et.frames_per_box IS NOT NULL
		GROUP BY et.name, et.frames_per_box`)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	defer boxRows.Close()

	type boxBreakdownRow struct {
		BoxType            string `json:"boxType"`
		FramesPerBox       int    `json:"framesPerBox"`
		DeployedBoxes      int    `json:"deployedBoxes"`
		TotalFrameCapacity int    `json:"totalFrameCapacity"`
	}
	boxBreakdown := make([]boxBreakdownRow, 0)
	totalBoxFrameCapacity := 0
	for boxRows.Next() {
		var row boxBreakdownRow
		if err := boxRows.Scan(&row.BoxType, &row.FramesPerBox, &row.DeployedBoxes); err != nil {
			writeError(w, http.StatusInternalServerError, "database error")
			return
		}
		row.TotalFrameCapacity = row.FramesPerBox * row.DeployedBoxes
		totalBoxFrameCapacity += row.TotalFrameCapacity
		boxBreakdown = append(boxBreakdown, row)
	}
	if boxRows.Err() != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}

	standaloneTotal := drawn + fresh + unspecified
	writeJSON(w, http.StatusOK, map[string]any{
		"standalone": map[string]int{
			"drawn":       drawn,
			"fresh":       fresh,
			"unspecified": unspecified,
			"total":       standaloneTotal,
		},
		"boxFrameCapacity": totalBoxFrameCapacity,
		"boxBreakdown":     boxBreakdown,
		"grandTotal":       standaloneTotal + totalBoxFrameCapacity,
	})
}

// --- defaults ---

// POST /equipment/seed-defaults — idempotent: inserts missing default types and
// backfills framesPerBox on existing box types that lack it.
func (s *Server) equipSeedDefaults(w http.ResponseWriter, r *http.Request) {
	defaults := []struct {
		Name         string
		Category     string
		FramesPerBox *int
	}{
		{"Deep Box", "box", equipIntPtr(10)},
		{"Medium Super", "box", equipIntPtr(10)},
		{"Shallow Super", "box", equipIntPtr(10)},
		{"Queen Excluder", "accessory", nil},
		{"Inner Cover", "cover", nil},
		{"Outer Cover", "cover", nil},
		{"Bottom Board", "bottom", nil},
		{"Screened Bottom Board", "bottom", nil},
		{"Entrance Reducer", "accessory", nil},
		{"Feeder", "accessory", nil},
		{"Mouse Guard", "accessory", nil},
		{"Deep Frame", "frame", nil},
		{"Medium Frame", "frame", nil},
		{"Shallow Frame", "frame", nil},
	}

	ctx := r.Context()
	for _, d := range defaults {
		if _, err := s.pool.Exec(ctx, `
			INSERT INTO equipment_types (name, category, frames_per_box, is_default)
			VALUES ($1, $2, $3, true)
			ON CONFLICT (name) DO UPDATE
			SET frames_per_box = COALESCE(equipment_types.frames_per_box, EXCLUDED.frames_per_box)`,
			d.Name, d.Category, d.FramesPerBox); err != nil {
			writeError(w, http.StatusInternalServerError, "database error")
			return
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{"success": true})
}

func equipIntPtr(v int) *int { return &v }
