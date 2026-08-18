package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

// Equipment v3: a type catalog and exactly one stock row per type, driven by
// two append-only ledgers —
//
//	equipment_stock_adjustments : ownership (total_owned)
//	equipment_state_changes     : condition (damaged / retired quantities)
//
// plus deployments (which support partial returns through
// equipment_deployment_returns). Every count a handler reports is derived from
// those ledgers by the equipment_stock_status view, and migration 00006 puts a
// database trigger between the ledgers and the materialised columns so the two
// cannot drift. Handlers therefore never write total_owned, damaged_quantity
// or retired_quantity directly; they append ledger entries.
//
// Every write that can consume stock locks its stock row and re-derives
// availability inside the transaction (the pattern the honey sale path uses),
// so concurrent requests cannot both spend the same units.

func (s *Server) mountEquipment(r chi.Router) {
	admin := r.With(s.requireAdmin)
	admin.Get("/equipment/types", s.equipListTypes)
	admin.Post("/equipment/types", s.equipCreateType)

	admin.Get("/equipment/stock", s.equipListStock)
	admin.Post("/equipment/stock", s.equipCreateStock)
	admin.Patch("/equipment/stock/{id}", s.equipUpdateStock)
	admin.Get("/equipment/stock/{id}/adjustments", s.equipListAdjustments)
	admin.Get("/equipment/stock/{id}/state-changes", s.equipListStateChanges)

	// Ledger actions. Each one appends an entry that says what happened and
	// why, replacing the old opaque quantity edits.
	admin.Post("/equipment/stock/{id}/receive", s.equipReceiveStock)
	admin.Post("/equipment/stock/{id}/adjust", s.equipAdjustStock)
	admin.Post("/equipment/stock/{id}/damage", s.equipMarkDamaged)
	admin.Post("/equipment/stock/{id}/repair", s.equipRepairStock)
	admin.Post("/equipment/stock/{id}/retire", s.equipRetireStock)

	// Physical count replaces bulk-adjust: counted quantities in, signed
	// 'physical_count' adjustments out, unresolvable lines reported as errors.
	admin.Post("/equipment/physical-count", s.equipPhysicalCount)

	admin.Post("/equipment/deployments", s.equipDeploy)
	admin.Post("/equipment/deployments/{id}/remove", s.equipReturnDeployment)
	admin.Post("/equipment/deployments/{id}/return", s.equipReturnDeployment)
	admin.Get("/equipment/deployments/active", s.equipActiveDeployments)
	r.With(s.requireHiveParamRole(false)).
		Get("/hives/{id}/deployments", s.equipHiveDeployments)

	admin.Get("/equipment/frame-summary", s.equipFrameSummary)
	admin.Get("/equipment/loss-report", s.equipLossReport)
	admin.Get("/equipment/reconciliation", s.equipReconciliation)
	admin.Post("/equipment/seed-defaults", s.equipSeedDefaults)
}

// --- small shared helpers ---

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

func equipIntPtr(v int) *int { return &v }

// equipActor is the app user to stamp on a ledger entry. It is nil-safe so
// handler logic stays testable without a session.
func equipActor(r *http.Request) *uuid.UUID {
	user := principalFrom(r)
	if user == nil {
		return nil
	}
	id := user.ID
	return &id
}

// decodeOptionalJSON accepts an absent or empty body. The legacy return
// endpoint is called with no body at all by the hive equipment tab.
func decodeOptionalJSON(r *http.Request, v any) error {
	err := decodeJSON(r, v)
	if errors.Is(err, io.EOF) {
		return nil
	}
	return err
}

var equipCategories = map[string]bool{
	"box": true, "cover": true, "bottom": true, "accessory": true, "frame": true, "other": true,
}

// Reasons a person may pick. 'physical_count' is deliberately absent: only the
// count flow may write it, so that reason always means "a real count happened".
var equipAdjustmentReasons = map[string]bool{
	"purchased": true, "built": true, "discarded": true, "broken": true,
	"gifted": true, "other": true, "sold": true,
}

var equipReceiveReasons = map[string]bool{"purchased": true, "built": true}

var equipStateReasons = map[string]bool{
	"broken": true, "worn_out": true, "pest_damage": true, "weather": true,
	"lost": true, "obsolete": true, "repaired": true, "sold": true,
	"disposed": true, "returned_damaged": true, "other": true,
}

var equipReturnReasons = map[string]bool{
	"season_end": true, "no_longer_needed": true, "maintenance": true,
	"damaged": true, "hive_removed": true, "other": true, "sold_with_hive": true,
}

var equipReturnConditions = map[string]bool{"good": true, "damaged": true, "retired": true}

// --- error plumbing ---

// equipError carries the HTTP status a failed ledger action should produce, so
// the core write functions can be reused by handlers and tests alike.
type equipError struct {
	status  int
	message string
}

func (e equipError) Error() string { return e.message }

func equipFail(status int, format string, args ...any) error {
	return equipError{status: status, message: fmt.Sprintf(format, args...)}
}

func equipBadRequest(format string, args ...any) error {
	return equipFail(http.StatusBadRequest, format, args...)
}

// equipWriteError maps a core error onto the response.
func equipWriteError(w http.ResponseWriter, err error) {
	var known equipError
	if errors.As(err, &known) {
		writeError(w, known.status, known.message)
		return
	}
	if errors.Is(err, pgx.ErrNoRows) {
		writeError(w, http.StatusNotFound, "not found")
		return
	}
	writeError(w, http.StatusInternalServerError, "database error")
}

// --- stock state (the one availability formula) ---

// equipStockState is a stock row plus everything derived from its ledgers.
type equipStockState struct {
	ID            uuid.UUID
	TypeID        uuid.UUID
	TypeName      string
	TotalOwned    int
	Damaged       int
	Retired       int
	Deployed      int
	UnitCostCents *int
}

// Available is the only definition of "ready to deploy" in the backend.
func (s equipStockState) Available() int {
	return s.TotalOwned - s.Damaged - s.Retired - s.Deployed
}

// equipLockStock takes a row lock on the stock row and reads its derived
// counts inside the caller's transaction. Callers that will consume stock must
// use this before validating, so a concurrent writer cannot spend the same
// units between the check and the insert.
func equipLockStock(ctx context.Context, tx pgx.Tx, stockID uuid.UUID) (equipStockState, error) {
	var state equipStockState
	err := tx.QueryRow(ctx, `
		SELECT es.id, es.type_id, et.name, es.total_owned, es.damaged_quantity,
		       es.retired_quantity, es.unit_cost_cents,
		       COALESCE((
		         SELECT SUM(d.quantity - d.quantity_returned)::int
		         FROM equipment_deployments d WHERE d.stock_id = es.id), 0)
		FROM equipment_stock es
		JOIN equipment_types et ON et.id = es.type_id
		WHERE es.id = $1
		FOR UPDATE OF es`, stockID).
		Scan(&state.ID, &state.TypeID, &state.TypeName, &state.TotalOwned,
			&state.Damaged, &state.Retired, &state.UnitCostCents, &state.Deployed)
	if errors.Is(err, pgx.ErrNoRows) {
		return state, equipFail(http.StatusNotFound, "stock not found")
	}
	return state, err
}

// --- ledger writes ---

type equipAdjustmentEntry struct {
	StockID       uuid.UUID
	Quantity      int
	Reason        string
	Notes         *string
	UnitCostCents *int
	Date          time.Time
	CreatedBy     *uuid.UUID
}

func equipInsertAdjustment(ctx context.Context, q inspectionQuerier, e equipAdjustmentEntry) error {
	_, err := q.Exec(ctx, `
		INSERT INTO equipment_stock_adjustments
			(stock_id, quantity, reason, notes, unit_cost_cents, date, created_by)
		VALUES ($1, $2, $3, $4, $5, $6, $7)`,
		e.StockID, e.Quantity, e.Reason, e.Notes, e.UnitCostCents, e.Date, e.CreatedBy)
	return err
}

type equipStateEntry struct {
	StockID       uuid.UUID
	From          string
	To            string
	Quantity      int
	Reason        string
	Notes         *string
	UnitCostCents *int
	Date          time.Time
	CreatedBy     *uuid.UUID
}

func equipInsertStateChange(ctx context.Context, q inspectionQuerier, e equipStateEntry) error {
	_, err := q.Exec(ctx, `
		INSERT INTO equipment_state_changes
			(stock_id, from_state, to_state, quantity, reason, notes,
			 unit_cost_cents, date, created_by)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
		e.StockID, e.From, e.To, e.Quantity, e.Reason, e.Notes,
		e.UnitCostCents, e.Date, e.CreatedBy)
	return err
}

// --- types ---

type equipTypeRow struct {
	ID           uuid.UUID `json:"id"`
	Name         string    `json:"name"`
	Category     string    `json:"category"`
	FramesPerBox *int      `json:"framesPerBox"`
	IsDefault    bool      `json:"isDefault"`
	CreatedAt    time.Time `json:"createdAt"`
	UpdatedAt    time.Time `json:"updatedAt"`
}

// GET /equipment/types
func (s *Server) equipListTypes(w http.ResponseWriter, r *http.Request) {
	rows, err := s.pool.Query(r.Context(), `
		SELECT id, name, category, frames_per_box, is_default, created_at, updated_at
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
			&row.IsDefault, &row.CreatedAt, &row.UpdatedAt); err != nil {
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
		INSERT INTO equipment_types (name, category, frames_per_box, created_by)
		VALUES ($1, $2, $3, $4)
		RETURNING id`,
		name, req.Category, req.FramesPerBox, equipActor(r)).Scan(&id)
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

// equipStockRow is the wire shape of a stock row. The pre-existing keys are
// unchanged so the hive equipment tab keeps working; owned / deployed /
// available / needed / damaged / retired are all present now.
type equipStockRow struct {
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
	Damaged         int       `json:"damaged"`
	Retired         int       `json:"retired"`
	Needed          int       `json:"needed"`
	Shortfall       int       `json:"shortfall"`
	UnitCostCents   *int      `json:"unitCostCents"`
	UpdatedAt       time.Time `json:"updatedAt"`
}

// GET /equipment/stock
func (s *Server) equipListStock(w http.ResponseWriter, r *http.Request) {
	rows, err := s.pool.Query(r.Context(), `
		SELECT stock_id, type_id, type_name, type_category, total_owned,
		       storage_location, notes, frame_condition, frames_per_box,
		       deployed, available, damaged_quantity, retired_quantity,
		       needed_quantity, unit_cost_cents, updated_at
		FROM equipment_stock_status
		ORDER BY type_category, type_name`)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	defer rows.Close()

	out := make([]equipStockRow, 0)
	for rows.Next() {
		var row equipStockRow
		if err := rows.Scan(&row.ID, &row.TypeID, &row.TypeName, &row.TypeCategory,
			&row.TotalOwned, &row.StorageLocation, &row.Notes, &row.FrameCondition,
			&row.FramesPerBox, &row.Deployed, &row.Available, &row.Damaged,
			&row.Retired, &row.Needed, &row.UnitCostCents, &row.UpdatedAt); err != nil {
			writeError(w, http.StatusInternalServerError, "database error")
			return
		}
		if gap := row.Needed - row.Available; gap > 0 {
			row.Shortfall = gap
		}
		out = append(out, row)
	}
	if rows.Err() != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	writeJSON(w, http.StatusOK, out)
}

// POST /equipment/stock
// {typeId, initialQuantity?, storageLocation?, notes?, frameCondition?,
//
//	neededQuantity?, unitCostCents?}
func (s *Server) equipCreateStock(w http.ResponseWriter, r *http.Request) {
	var req struct {
		TypeID          string  `json:"typeId"`
		InitialQuantity *int    `json:"initialQuantity"`
		StorageLocation *string `json:"storageLocation"`
		Notes           *string `json:"notes"`
		FrameCondition  *string `json:"frameCondition"`
		NeededQuantity  *int    `json:"neededQuantity"`
		UnitCostCents   *int    `json:"unitCostCents"`
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
	if initial < 0 {
		writeError(w, http.StatusBadRequest, "Initial quantity cannot be negative")
		return
	}
	needed := 0
	if req.NeededQuantity != nil {
		needed = *req.NeededQuantity
	}
	if needed < 0 {
		writeError(w, http.StatusBadRequest, "Needed quantity cannot be negative")
		return
	}
	if req.UnitCostCents != nil && *req.UnitCostCents < 0 {
		writeError(w, http.StatusBadRequest, "Unit cost cannot be negative")
		return
	}

	ctx := r.Context()
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	defer tx.Rollback(ctx)

	// total_owned is ledger-derived, so the row is created empty and the
	// opening count is written as an adjustment.
	var stockID uuid.UUID
	err = tx.QueryRow(ctx, `
		INSERT INTO equipment_stock
			(type_id, total_owned, frame_condition, storage_location, notes,
			 needed_quantity, unit_cost_cents, created_by)
		VALUES ($1, 0, $2, $3, $4, $5, $6, $7)
		RETURNING id`,
		typeID, condition, equipTrimPtr(req.StorageLocation), equipTrimPtr(req.Notes),
		needed, req.UnitCostCents, equipActor(r)).
		Scan(&stockID)
	if err != nil {
		switch {
		case equipPgErrCode(err, "23503"):
			writeError(w, http.StatusBadRequest, "invalid typeId")
		case equipPgErrCode(err, "23505"):
			writeError(w, http.StatusConflict,
				"This equipment type already has a stock row — adjust it instead")
		default:
			writeError(w, http.StatusInternalServerError, "database error")
		}
		return
	}
	if initial > 0 {
		notes := "Opening count"
		if err := equipInsertAdjustment(ctx, tx, equipAdjustmentEntry{
			StockID:       stockID,
			Quantity:      initial,
			Reason:        "purchased",
			Notes:         &notes,
			UnitCostCents: req.UnitCostCents,
			Date:          time.Now(),
			CreatedBy:     equipActor(r),
		}); err != nil {
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

// PATCH /equipment/stock/{id} — descriptive fields only. Quantities move
// through the ledger actions, never through an edit.
func (s *Server) equipUpdateStock(w http.ResponseWriter, r *http.Request) {
	id, err := uuidParam(r, "id")
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	var req struct {
		StorageLocation json.RawMessage `json:"storageLocation"`
		Notes           json.RawMessage `json:"notes"`
		FrameCondition  json.RawMessage `json:"frameCondition"`
		NeededQuantity  *int            `json:"neededQuantity"`
		UnitCostCents   json.RawMessage `json:"unitCostCents"`
	}
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}

	sets := make([]string, 0, 5)
	args := make([]any, 0, 6)
	addString := func(column string, raw json.RawMessage, validate func(string) bool) bool {
		var v *string
		if err := json.Unmarshal(raw, &v); err != nil {
			return false
		}
		trimmed := equipTrimPtr(v)
		if trimmed != nil && validate != nil && !validate(*trimmed) {
			return false
		}
		args = append(args, trimmed)
		sets = append(sets, fmt.Sprintf("%s = $%d", column, len(args)))
		return true
	}
	if req.StorageLocation != nil && !addString("storage_location", req.StorageLocation, nil) {
		writeError(w, http.StatusBadRequest, "invalid storageLocation")
		return
	}
	if req.Notes != nil && !addString("notes", req.Notes, nil) {
		writeError(w, http.StatusBadRequest, "invalid notes")
		return
	}
	if req.FrameCondition != nil && !addString("frame_condition", req.FrameCondition,
		func(v string) bool { return v == "drawn" || v == "fresh" }) {
		writeError(w, http.StatusBadRequest, "invalid frameCondition")
		return
	}
	if req.NeededQuantity != nil {
		if *req.NeededQuantity < 0 {
			writeError(w, http.StatusBadRequest, "Needed quantity cannot be negative")
			return
		}
		args = append(args, *req.NeededQuantity)
		sets = append(sets, fmt.Sprintf("needed_quantity = $%d", len(args)))
	}
	if req.UnitCostCents != nil {
		var cost *int
		if err := json.Unmarshal(req.UnitCostCents, &cost); err != nil {
			writeError(w, http.StatusBadRequest, "invalid unitCostCents")
			return
		}
		if cost != nil && *cost < 0 {
			writeError(w, http.StatusBadRequest, "Unit cost cannot be negative")
			return
		}
		args = append(args, cost)
		sets = append(sets, fmt.Sprintf("unit_cost_cents = $%d", len(args)))
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

// GET /equipment/stock/{id}/adjustments
func (s *Server) equipListAdjustments(w http.ResponseWriter, r *http.Request) {
	stockID, err := uuidParam(r, "id")
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	rows, err := s.pool.Query(r.Context(), `
		SELECT id, stock_id, quantity, reason, notes, unit_cost_cents, date, created_at
		FROM equipment_stock_adjustments
		WHERE stock_id = $1
		ORDER BY date DESC, created_at DESC`, stockID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	defer rows.Close()

	type adjustmentRow struct {
		ID            uuid.UUID `json:"id"`
		StockID       uuid.UUID `json:"stockId"`
		Quantity      int       `json:"quantity"`
		Reason        string    `json:"reason"`
		Notes         *string   `json:"notes"`
		UnitCostCents *int      `json:"unitCostCents"`
		Date          time.Time `json:"date"`
		CreatedAt     time.Time `json:"createdAt"`
	}
	out := make([]adjustmentRow, 0)
	for rows.Next() {
		var row adjustmentRow
		if err := rows.Scan(&row.ID, &row.StockID, &row.Quantity, &row.Reason,
			&row.Notes, &row.UnitCostCents, &row.Date, &row.CreatedAt); err != nil {
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

// GET /equipment/stock/{id}/state-changes
func (s *Server) equipListStateChanges(w http.ResponseWriter, r *http.Request) {
	stockID, err := uuidParam(r, "id")
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	rows, err := s.pool.Query(r.Context(), `
		SELECT id, stock_id, from_state, to_state, quantity, reason, notes,
		       unit_cost_cents, date, created_at
		FROM equipment_state_changes
		WHERE stock_id = $1
		ORDER BY date DESC, created_at DESC`, stockID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	defer rows.Close()

	type stateRow struct {
		ID            uuid.UUID `json:"id"`
		StockID       uuid.UUID `json:"stockId"`
		FromState     string    `json:"fromState"`
		ToState       string    `json:"toState"`
		Quantity      int       `json:"quantity"`
		Reason        string    `json:"reason"`
		Notes         *string   `json:"notes"`
		UnitCostCents *int      `json:"unitCostCents"`
		Date          time.Time `json:"date"`
		CreatedAt     time.Time `json:"createdAt"`
	}
	out := make([]stateRow, 0)
	for rows.Next() {
		var row stateRow
		if err := rows.Scan(&row.ID, &row.StockID, &row.FromState, &row.ToState,
			&row.Quantity, &row.Reason, &row.Notes, &row.UnitCostCents,
			&row.Date, &row.CreatedAt); err != nil {
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

// --- deployments ---

// equipDeployInput is the validated form of a deploy request.
type equipDeployInput struct {
	StockID   uuid.UUID
	HiveID    uuid.UUID
	Quantity  int
	Notes     *string
	Date      time.Time
	CreatedBy *uuid.UUID
}

// equipDeployTx locks the stock row, refuses to deploy more than is available,
// and records the deployment.
func equipDeployTx(ctx context.Context, tx pgx.Tx, in equipDeployInput) (uuid.UUID, error) {
	state, err := equipLockStock(ctx, tx, in.StockID)
	if err != nil {
		return uuid.Nil, err
	}
	if available := state.Available(); in.Quantity > available {
		return uuid.Nil, equipBadRequest(
			"Not enough %s available: need %d, have %d",
			state.TypeName, in.Quantity, available)
	}
	var id uuid.UUID
	err = tx.QueryRow(ctx, `
		INSERT INTO equipment_deployments
			(stock_id, hive_id, quantity, date_deployed, notes, created_by)
		VALUES ($1, $2, $3, $4, $5, $6)
		RETURNING id`,
		in.StockID, in.HiveID, in.Quantity, in.Date, in.Notes, in.CreatedBy).Scan(&id)
	if err != nil {
		if equipPgErrCode(err, "23503") {
			return uuid.Nil, equipBadRequest("invalid stockId or hiveId")
		}
		return uuid.Nil, err
	}
	return id, nil
}

// POST /equipment/deployments {stockId, hiveId, quantity?, notes?, date?}
func (s *Server) equipDeploy(w http.ResponseWriter, r *http.Request) {
	var req struct {
		StockID  string  `json:"stockId"`
		HiveID   string  `json:"hiveId"`
		Quantity *int    `json:"quantity"`
		Notes    *string `json:"notes"`
		Date     *string `json:"date"`
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

	id, err := equipDeployTx(ctx, tx, equipDeployInput{
		StockID:   stockID,
		HiveID:    hiveID,
		Quantity:  quantity,
		Notes:     equipTrimPtr(req.Notes),
		Date:      date,
		CreatedBy: equipActor(r),
	})
	if err != nil {
		equipWriteError(w, err)
		return
	}
	if err := tx.Commit(ctx); err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"success": true, "id": id})
}

// equipReturnInput is the validated form of a (possibly partial) return.
type equipReturnInput struct {
	DeploymentID uuid.UUID
	// Quantity nil means "everything still out".
	Quantity  *int
	Reason    string
	Condition string
	Notes     *string
	Date      time.Time
	CreatedBy *uuid.UUID
	SaleID    *uuid.UUID
}

type equipReturnResult struct {
	Quantity      int
	TotalReturned int
	Outstanding   int
	FullyReturned bool
	StockID       uuid.UUID
	DeployedTotal int
}

// equipReturnTx returns equipment from a hive. The `date_removed IS NULL`
// guard is what makes a second return fail loudly instead of silently
// overwriting the first return date.
func equipReturnTx(ctx context.Context, tx pgx.Tx, in equipReturnInput) (equipReturnResult, error) {
	var result equipReturnResult

	// Lock the stock row first (and always in that order) so return and
	// deploy cannot deadlock against each other.
	var stockID uuid.UUID
	err := tx.QueryRow(ctx,
		`SELECT stock_id FROM equipment_deployments WHERE id = $1`, in.DeploymentID).
		Scan(&stockID)
	if errors.Is(err, pgx.ErrNoRows) {
		return result, equipFail(http.StatusNotFound, "deployment not found")
	}
	if err != nil {
		return result, err
	}
	if _, err := equipLockStock(ctx, tx, stockID); err != nil {
		return result, err
	}

	var deployed, returned int
	err = tx.QueryRow(ctx, `
		SELECT quantity, quantity_returned
		FROM equipment_deployments
		WHERE id = $1 AND date_removed IS NULL
		FOR UPDATE`, in.DeploymentID).Scan(&deployed, &returned)
	if errors.Is(err, pgx.ErrNoRows) {
		return result, equipFail(http.StatusConflict,
			"This deployment has already been returned")
	}
	if err != nil {
		return result, err
	}

	outstanding := deployed - returned
	quantity := outstanding
	if in.Quantity != nil {
		quantity = *in.Quantity
	}
	if quantity < 1 {
		return result, equipBadRequest("Quantity must be at least 1")
	}
	if quantity > outstanding {
		return result, equipBadRequest(
			"Only %d still deployed: cannot return %d", outstanding, quantity)
	}

	if _, err := tx.Exec(ctx, `
		INSERT INTO equipment_deployment_returns
			(deployment_id, quantity, reason, condition, notes, date, created_by, sale_id)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
		in.DeploymentID, quantity, in.Reason, in.Condition, in.Notes,
		in.Date, in.CreatedBy, in.SaleID); err != nil {
		return result, err
	}

	total := returned + quantity
	full := total >= deployed
	tag, err := tx.Exec(ctx, `
		UPDATE equipment_deployments
		SET quantity_returned = $2,
		    date_removed = CASE WHEN $3 THEN $4::timestamptz ELSE NULL END
		WHERE id = $1 AND date_removed IS NULL`,
		in.DeploymentID, total, full, in.Date)
	if err != nil {
		return result, err
	}
	if tag.RowsAffected() == 0 {
		// Another transaction completed the return between our read and write.
		return result, equipFail(http.StatusConflict,
			"This deployment has already been returned")
	}

	// Equipment that came back broken or worn out does not silently rejoin the
	// serviceable pool: it lands in a real state with a quantity.
	if in.Condition == "damaged" || in.Condition == "retired" {
		if err := equipInsertStateChange(ctx, tx, equipStateEntry{
			StockID:   stockID,
			From:      "serviceable",
			To:        in.Condition,
			Quantity:  quantity,
			Reason:    "returned_damaged",
			Notes:     in.Notes,
			Date:      in.Date,
			CreatedBy: in.CreatedBy,
		}); err != nil {
			return result, err
		}
	}

	result = equipReturnResult{
		Quantity:      quantity,
		TotalReturned: total,
		Outstanding:   deployed - total,
		FullyReturned: full,
		StockID:       stockID,
		DeployedTotal: deployed,
	}
	return result, nil
}

// POST /equipment/deployments/{id}/remove (legacy path)
// POST /equipment/deployments/{id}/return
// {quantity?, reason?, condition?, notes?, date?} — an absent body returns
// everything still out, which is what the hive equipment tab sends.
func (s *Server) equipReturnDeployment(w http.ResponseWriter, r *http.Request) {
	id, err := uuidParam(r, "id")
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	var req struct {
		Quantity  *int    `json:"quantity"`
		Reason    *string `json:"reason"`
		Condition *string `json:"condition"`
		Notes     *string `json:"notes"`
		Date      *string `json:"date"`
	}
	if err := decodeOptionalJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	reason := "other"
	if v := equipTrimPtr(req.Reason); v != nil {
		reason = *v
	}
	if !equipReturnReasons[reason] {
		writeError(w, http.StatusBadRequest, "invalid reason")
		return
	}
	condition := "good"
	if v := equipTrimPtr(req.Condition); v != nil {
		condition = *v
	}
	if !equipReturnConditions[condition] {
		writeError(w, http.StatusBadRequest, "invalid condition")
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

	result, err := equipReturnTx(ctx, tx, equipReturnInput{
		DeploymentID: id,
		Quantity:     req.Quantity,
		Reason:       reason,
		Condition:    condition,
		Notes:        equipTrimPtr(req.Notes),
		Date:         date,
		CreatedBy:    equipActor(r),
	})
	if err != nil {
		equipWriteError(w, err)
		return
	}
	if err := tx.Commit(ctx); err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"success":          true,
		"quantityReturned": result.Quantity,
		"totalReturned":    result.TotalReturned,
		"outstanding":      result.Outstanding,
		"fullyReturned":    result.FullyReturned,
	})
}

// GET /equipment/deployments/active — anything still on a hive.
func (s *Server) equipActiveDeployments(w http.ResponseWriter, r *http.Request) {
	rows, err := s.pool.Query(r.Context(), `
		SELECT ed.id, ed.stock_id, ed.quantity, ed.quantity_returned,
		       h.position_label, et.name, et.category, ed.date_deployed
		FROM equipment_deployments ed
		JOIN hives h ON h.id = ed.hive_id
		JOIN equipment_stock es ON es.id = ed.stock_id
		JOIN equipment_types et ON et.id = es.type_id
		WHERE ed.date_removed IS NULL AND ed.quantity > ed.quantity_returned
		ORDER BY h.position_label`)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	defer rows.Close()

	type activeRow struct {
		ID               uuid.UUID `json:"id"`
		StockID          uuid.UUID `json:"stockId"`
		Quantity         int       `json:"quantity"`
		QuantityReturned int       `json:"quantityReturned"`
		Outstanding      int       `json:"outstanding"`
		HiveLabel        string    `json:"hiveLabel"`
		TypeName         string    `json:"typeName"`
		TypeCategory     string    `json:"typeCategory"`
		DateDeployed     time.Time `json:"dateDeployed"`
	}
	out := make([]activeRow, 0)
	for rows.Next() {
		var row activeRow
		if err := rows.Scan(&row.ID, &row.StockID, &row.Quantity, &row.QuantityReturned,
			&row.HiveLabel, &row.TypeName, &row.TypeCategory, &row.DateDeployed); err != nil {
			writeError(w, http.StatusInternalServerError, "database error")
			return
		}
		row.Outstanding = row.Quantity - row.QuantityReturned
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
		SELECT ed.id, ed.stock_id, ed.quantity, ed.quantity_returned,
		       ed.date_deployed, ed.date_removed, ed.notes, et.name, et.category
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
		ID               uuid.UUID  `json:"id"`
		StockID          uuid.UUID  `json:"stockId"`
		Quantity         int        `json:"quantity"`
		QuantityReturned int        `json:"quantityReturned"`
		Outstanding      int        `json:"outstanding"`
		DateDeployed     time.Time  `json:"dateDeployed"`
		DateRemoved      *time.Time `json:"dateRemoved"`
		Notes            *string    `json:"notes"`
		TypeName         string     `json:"typeName"`
		TypeCategory     string     `json:"typeCategory"`
	}
	out := make([]deploymentRow, 0)
	for rows.Next() {
		var row deploymentRow
		if err := rows.Scan(&row.ID, &row.StockID, &row.Quantity, &row.QuantityReturned,
			&row.DateDeployed, &row.DateRemoved, &row.Notes, &row.TypeName,
			&row.TypeCategory); err != nil {
			writeError(w, http.StatusInternalServerError, "database error")
			return
		}
		row.Outstanding = row.Quantity - row.QuantityReturned
		out = append(out, row)
	}
	if rows.Err() != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	writeJSON(w, http.StatusOK, out)
}

// --- frame summary ---

// GET /equipment/frame-summary — standalone frames (by condition, minus what is
// deployed, damaged, or retired) plus frame capacity of deployed boxes.
func (s *Server) equipFrameSummary(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()

	rows, err := s.pool.Query(ctx, `
		SELECT frame_condition, available
		FROM equipment_stock_status
		WHERE type_category = 'frame'`)
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

	boxRows, err := s.pool.Query(ctx, `
		SELECT et.name, et.frames_per_box,
		       COALESCE(SUM(ed.quantity - ed.quantity_returned), 0)::int
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
			INSERT INTO equipment_types (name, category, frames_per_box, is_default, created_by)
			VALUES ($1, $2, $3, true, $4)
			ON CONFLICT (name) DO UPDATE
			SET frames_per_box = COALESCE(equipment_types.frames_per_box, EXCLUDED.frames_per_box)`,
			d.Name, d.Category, d.FramesPerBox, equipActor(r)); err != nil {
			writeError(w, http.StatusInternalServerError, "database error")
			return
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{"success": true})
}
