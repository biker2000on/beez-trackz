package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/biker2000on/beez-trackz/backend/internal/app"
	appequipment "github.com/biker2000on/beez-trackz/backend/internal/app/equipment"
	"github.com/biker2000on/beez-trackz/backend/internal/db"
	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

// Equipment: a type catalog whose quantities live in the inventory ledger
// (docs/plans/2026-09-01-inventory-ledger-design.md). Every count a handler
// reports comes from inventory_balances and inventory_available, and every
// write goes through app/equipment, which records an operation under the
// caller's unit of work and holds the ledger's tuple locks while it does.
//
// Nothing here reads equipment_stock, equipment_stock_adjustments,
// equipment_state_changes, equipment_deployments, or the three views over them
// any more: those are the tables Phase B drops (spec section 8), and an
// endpoint that still named one could not serve a baseline database. The two
// places that still MAY name equipment_stock — resolving a pre-ledger stock id
// handed in as {id} — compose it in only while the legacy chain is active; see
// equipItemSelect. The Phase A regression suite for the dropped tables, and the
// helpers it needs, live in routes_equipment_db_test.go.
//
// The descriptive attributes (storage location, needed quantity, unit cost,
// first deployed year) moved onto equipment_types when the stock row dissolved
// (review OV2), so an "update stock" PATCH lands on the catalog row.

func (s *Server) mountEquipment(r chi.Router) {
	admin := r.With(s.requireAdmin)
	admin.Get("/equipment/types", s.equipListTypes)
	admin.Post("/equipment/types", s.equipCreateType)
	admin.Patch("/equipment/types/{id}", s.equipUpdateType)
	admin.Delete("/equipment/types/{id}", s.equipDeleteType)

	// Bill of materials + assembly (see routes_equipment_bom.go).
	admin.Get("/equipment/components", s.equipListComponents)
	admin.Put("/equipment/types/{id}/components", s.equipSetComponents)
	admin.Post("/equipment/assemblies", s.equipAssemble)

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

// --- identity resolution ---

// equipItemSourceTypes is every inventory_items.source_type an equipment
// catalog row can carry: the plain type, and the two frame identities a frame
// type splits into (decision 5 as amended by OV5 — condition is the state
// axis, drawn and fresh are items).
const equipItemSourceTypes = `('equipment_type','equipment_type_frame_drawn','equipment_type_frame_fresh')`

// equipItemSelect is a scalar subquery that resolves ONE placeholder — an
// inventory item id, an equipment type id, or the pre-ledger
// equipment_stock id — to the inventory item behind it. Every equipment
// endpoint takes {id} in any of those three shapes, which is what keeps the
// Phase A HTTP surface stable while the writers moved to the ledger.
//
// The equipment_stock arm is emitted only while that table exists. On the
// baseline schema (spec section 9) it is gone, and a query that named it would
// fail for EVERY caller rather than only for the callers still passing a stock
// id, so the arm is dropped and a stale stock id simply resolves to nothing.
// An item id names one identity exactly and always wins. A type or stock id
// can match both halves of a split frame type, and the ORDER BY settles it on
// the drawn one — arbitrary, but stable, where the query it replaced left the
// choice to the planner.
func equipItemSelect(placeholder string) string {
	legacy := ""
	if db.ActiveProfile() != db.ProfileBaseline {
		legacy = `OR ii.source_id=(SELECT es.type_id FROM equipment_stock es WHERE es.id=` +
			placeholder + `) `
	}
	return `(SELECT ii.id FROM inventory_items ii
		WHERE ii.source_type IN ` + equipItemSourceTypes + `
		  AND (ii.id=` + placeholder + ` OR ii.source_id=` + placeholder + ` ` + legacy + `)
		ORDER BY CASE WHEN ii.id=` + placeholder + ` THEN 0 ELSE 1 END, ii.source_type
		LIMIT 1)`
}

// equipTypeSelect is equipItemSelect for the catalog row rather than the item.
// The descriptive attributes moved onto equipment_types when equipment_stock
// dissolved (review OV2), so a PATCH addressed by any of the three identities
// has to land there.
func equipTypeSelect(placeholder string) string {
	legacy := ""
	if db.ActiveProfile() != db.ProfileBaseline {
		legacy = `OR et.id=(SELECT es.type_id FROM equipment_stock es WHERE es.id=` +
			placeholder + `) `
	}
	return `(SELECT et.id FROM equipment_types et
		LEFT JOIN inventory_items ii ON ii.source_id=et.id
			AND ii.source_type IN ` + equipItemSourceTypes + `
		WHERE et.id=` + placeholder + ` OR ii.id=` + placeholder + ` ` + legacy + `
		LIMIT 1)`
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
	"box": true, "cover": true, "bottom": true, "accessory": true, "frame": true,
	// Empty jars, lids, and labels. They ride the equipment ledger so filling
	// a jar size can draw them down (migration 00048).
	"packaging": true, "other": true,
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
	switch app.KindOf(err) {
	case app.KindInvalid:
		writeError(w, http.StatusBadRequest, err.Error())
		return
	case app.KindNotFound:
		writeError(w, http.StatusNotFound, err.Error())
		return
	case app.KindConflict:
		writeError(w, http.StatusConflict, err.Error())
		return
	case app.KindForbidden:
		writeError(w, http.StatusForbidden, err.Error())
		return
	case app.KindPrecondition:
		writeError(w, http.StatusConflict, err.Error())
		return
	}
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

func equipAppActor(r *http.Request) app.Actor {
	user := principalFrom(r)
	if user == nil || user.ID == uuid.Nil {
		return app.Actor{}
	}
	return app.UserActor(user.ID, user.DisplayName)
}

func (s *Server) equipInUOW(w http.ResponseWriter, r *http.Request, action func(context.Context, *app.UnitOfWork) (map[string]any, error)) {
	var body map[string]any
	err := app.NewRunner(s.pool).Run(r.Context(), equipAppActor(r), func(ctx context.Context, uow *app.UnitOfWork) error {
		var err error
		body, err = action(ctx, uow)
		return err
	})
	if err != nil {
		equipWriteError(w, err)
		return
	}
	if body == nil {
		body = map[string]any{}
	}
	body["success"] = true
	writeJSON(w, http.StatusOK, body)
}

// --- types ---

type equipTypeRow struct {
	ID              uuid.UUID  `json:"id"`
	Name            string     `json:"name"`
	Category        string     `json:"category"`
	FramesPerBox    *int       `json:"framesPerBox"`
	IsDefault       bool       `json:"isDefault"`
	VariantOfTypeID *uuid.UUID `json:"variantOfTypeId"`
	CreatedAt       time.Time  `json:"createdAt"`
	UpdatedAt       time.Time  `json:"updatedAt"`
}

// GET /equipment/types
func (s *Server) equipListTypes(w http.ResponseWriter, r *http.Request) {
	rows, err := s.pool.Query(r.Context(), `
		SELECT id, name, category, frames_per_box, is_default, variant_of_type_id,
		       created_at, updated_at
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
			&row.IsDefault, &row.VariantOfTypeID, &row.CreatedAt, &row.UpdatedAt); err != nil {
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

// POST /equipment/types {name, category, framesPerBox?, variantOfTypeId?}
func (s *Server) equipCreateType(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Name            string  `json:"name"`
		Category        string  `json:"category"`
		FramesPerBox    *int    `json:"framesPerBox"`
		VariantOfTypeID *string `json:"variantOfTypeId"`
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
	var variantOf *uuid.UUID
	if v := equipTrimPtr(req.VariantOfTypeID); v != nil {
		parsed, err := uuid.Parse(*v)
		if err != nil {
			writeError(w, http.StatusBadRequest, "invalid variantOfTypeId")
			return
		}
		if err := s.equipCheckVariantBase(r.Context(), parsed); err != nil {
			equipWriteError(w, err)
			return
		}
		variantOf = &parsed
	}

	var id uuid.UUID
	err := s.pool.QueryRow(r.Context(), `
		INSERT INTO equipment_types
			(name, category, frames_per_box, variant_of_type_id, created_by)
		VALUES ($1, $2, $3, $4, $5)
		RETURNING id`,
		name, req.Category, req.FramesPerBox, variantOf, equipActor(r)).Scan(&id)
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
	ID                uuid.UUID `json:"id"`
	TypeID            uuid.UUID `json:"typeId"`
	TypeName          string    `json:"typeName"`
	TypeCategory      string    `json:"typeCategory"`
	TotalOwned        int       `json:"totalOwned"`
	StorageLocation   *string   `json:"storageLocation"`
	Notes             *string   `json:"notes"`
	FrameCondition    *string   `json:"frameCondition"`
	FramesPerBox      *int      `json:"framesPerBox"`
	Deployed          int       `json:"deployed"`
	Available         int       `json:"available"`
	Damaged           int       `json:"damaged"`
	Retired           int       `json:"retired"`
	Needed            int       `json:"needed"`
	Shortfall         int       `json:"shortfall"`
	UnitCostCents     *int      `json:"unitCostCents"`
	FirstDeployedYear *int      `json:"firstDeployedYear"`
	CombAgeYears      *int      `json:"combAgeYears"`
	PullRecommended   bool      `json:"pullRecommended"`
	UpdatedAt         time.Time `json:"updatedAt"`
}

// GET /equipment/stock
func (s *Server) equipListStock(w http.ResponseWriter, r *http.Request) {
	rows, err := s.pool.Query(r.Context(), `
		WITH balances AS (
		 SELECT i.id item_id,COALESCE(SUM(b.on_hand),0)::int total_owned,
		  COALESCE(SUM(b.on_hand) FILTER(WHERE l.kind='deployed'),0)::int deployed,
		  COALESCE(SUM(b.on_hand) FILTER(WHERE b.condition='damaged'),0)::int damaged,
		  COALESCE(SUM(b.on_hand) FILTER(WHERE b.condition='retired'),0)::int retired
		 FROM inventory_items i LEFT JOIN inventory_balances b ON b.item_id=i.id
		 LEFT JOIN inventory_locations l ON l.id=b.location_id GROUP BY i.id
		), available AS (
		 SELECT a.item_id,COALESCE(SUM(a.available) FILTER(WHERE l.is_home AND a.condition='serviceable' AND a.container_hive_id IS NULL),0)::int available
		 FROM inventory_available a JOIN inventory_locations l ON l.id=a.location_id GROUP BY a.item_id)
		SELECT i.id,et.id,et.name,et.category,b.total_owned,et.storage_location,
		       NULL::text,CASE WHEN i.source_type LIKE 'equipment_type_frame_%' THEN replace(i.source_type,'equipment_type_frame_','') END,
		       et.frames_per_box,b.deployed,COALESCE(a.available,0),b.damaged,b.retired,
		       COALESCE(et.needed_quantity,0),et.unit_cost_cents,et.first_deployed_year,et.updated_at
		FROM inventory_items i JOIN equipment_types et ON et.id=i.source_id
		JOIN balances b ON b.item_id=i.id LEFT JOIN available a ON a.item_id=i.id
		WHERE i.source_type IN('equipment_type','equipment_type_frame_drawn','equipment_type_frame_fresh')
		ORDER BY et.category,et.name,i.source_type`)
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
			&row.Retired, &row.Needed, &row.UnitCostCents, &row.FirstDeployedYear,
			&row.UpdatedAt); err != nil {
			writeError(w, http.StatusInternalServerError, "database error")
			return
		}
		if gap := row.Needed - row.Available; gap > 0 {
			row.Shortfall = gap
		}
		if row.FirstDeployedYear != nil {
			age := time.Now().Year() - *row.FirstDeployedYear
			if age < 0 {
				age = 0
			}
			row.CombAgeYears = &age
			row.PullRecommended = age >= 5 && (row.TypeCategory == "box" || row.TypeCategory == "frame")
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
		TypeID            string  `json:"typeId"`
		InitialQuantity   *int    `json:"initialQuantity"`
		StorageLocation   *string `json:"storageLocation"`
		Notes             *string `json:"notes"`
		FrameCondition    *string `json:"frameCondition"`
		NeededQuantity    *int    `json:"neededQuantity"`
		UnitCostCents     *int    `json:"unitCostCents"`
		FirstDeployedYear *int    `json:"firstDeployedYear"`
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
	if req.FirstDeployedYear != nil && (*req.FirstDeployedYear < 1900 || *req.FirstDeployedYear > time.Now().Year()+1) {
		writeError(w, http.StatusBadRequest, "First deployed year is invalid")
		return
	}

	equipFrame := ""
	if condition != nil {
		equipFrame = *condition
	}
	s.equipInUOW(w, r, func(ctx context.Context, uow *app.UnitOfWork) (map[string]any, error) {
		item, err := appequipment.EnsureItem(ctx, uow, typeID, equipFrame)
		if err != nil {
			return nil, err
		}
		_, err = uow.Exec(ctx, `UPDATE equipment_types SET storage_location=$2,needed_quantity=$3,unit_cost_cents=$4,first_deployed_year=$5 WHERE id=$1`, typeID, equipTrimPtr(req.StorageLocation), needed, req.UnitCostCents, req.FirstDeployedYear)
		if err != nil {
			return nil, app.Internal("create equipment stock", err)
		}
		if initial > 0 {
			notes := "Opening count"
			if req.Notes != nil {
				notes = *req.Notes
			}
			_, err = appequipment.NewService().Receive(ctx, uow, appequipment.Command{Reference: item.ItemID, Quantity: initial, OccurredAt: time.Now().UTC(), Reason: "purchased", Notes: notes, UnitCostCents: req.UnitCostCents})
			if err != nil {
				return nil, err
			}
		}
		return map[string]any{"id": item.ItemID}, nil
	})
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
		StorageLocation   json.RawMessage `json:"storageLocation"`
		Notes             json.RawMessage `json:"notes"`
		FrameCondition    json.RawMessage `json:"frameCondition"`
		NeededQuantity    *int            `json:"neededQuantity"`
		UnitCostCents     json.RawMessage `json:"unitCostCents"`
		FirstDeployedYear json.RawMessage `json:"firstDeployedYear"`
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
	if req.Notes != nil {
		writeError(w, http.StatusBadRequest, "notes are not a catalog attribute")
		return
	}
	if req.FrameCondition != nil {
		writeError(w, http.StatusBadRequest, "frameCondition is item identity and cannot be patched; record a fresh-to-drawn transform")
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
	if req.FirstDeployedYear != nil {
		var year *int
		if err := json.Unmarshal(req.FirstDeployedYear, &year); err != nil ||
			(year != nil && (*year < 1900 || *year > time.Now().Year()+1)) {
			writeError(w, http.StatusBadRequest, "invalid firstDeployedYear")
			return
		}
		args = append(args, year)
		sets = append(sets, fmt.Sprintf("first_deployed_year = $%d", len(args)))
	}
	if len(sets) == 0 {
		writeJSON(w, http.StatusOK, map[string]any{"success": true})
		return
	}

	args = append(args, id)
	query := fmt.Sprintf(`UPDATE equipment_types SET %s WHERE id=%s`,
		strings.Join(sets, ", "), equipTypeSelect(fmt.Sprintf("$%d", len(args))))
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
		SELECT o.id,i.id,m.quantity::int,COALESCE(o.details->>'legacy_reason',o.reason),
		       o.details->>'notes',et.unit_cost_cents,o.occurred_at,o.created_at
		FROM inventory_operations o JOIN inventory_movements m ON m.operation_id=o.id
		JOIN inventory_items i ON i.id=m.item_id JOIN equipment_types et ON et.id=i.source_id
		WHERE o.kind IN('receive','count_adjust','shrink','opening_balance')
		  AND i.id=`+equipItemSelect("$1")+`
		ORDER BY o.occurred_at DESC,o.created_at DESC`, stockID)
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
		SELECT o.id,i.id,
		       MAX(m.condition) FILTER(WHERE m.quantity<0),MAX(m.condition) FILTER(WHERE m.quantity>0),
		       (MAX(m.quantity) FILTER(WHERE m.quantity>0))::int,o.reason,o.details->>'notes',
		       et.unit_cost_cents,o.occurred_at,o.created_at
		FROM inventory_operations o JOIN inventory_movements m ON m.operation_id=o.id
		JOIN inventory_items i ON i.id=m.item_id JOIN equipment_types et ON et.id=i.source_id
		WHERE o.kind='condition_change' AND i.id=`+equipItemSelect("$1")+`
		GROUP BY o.id,i.id,et.unit_cost_cents
		ORDER BY o.occurred_at DESC,o.created_at DESC`, stockID)
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
// POST /equipment/deployments {stockId, hiveId, quantity?, notes?, date?}
func (s *Server) equipDeploy(w http.ResponseWriter, r *http.Request) {
	var req struct {
		StockID        string  `json:"stockId"`
		HiveID         string  `json:"hiveId"`
		Quantity       *int    `json:"quantity"`
		Notes          *string `json:"notes"`
		Date           *string `json:"date"`
		IdempotencyKey *string `json:"idempotencyKey"`
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

	s.equipInUOW(w, r, func(ctx context.Context, uow *app.UnitOfWork) (map[string]any, error) {
		cmd := appequipment.DeployCommand{Command: appequipment.Command{Reference: stockID, Quantity: quantity, OccurredAt: date}, HiveID: hiveID}
		if req.Notes != nil {
			cmd.Notes = *req.Notes
		}
		if req.IdempotencyKey != nil {
			cmd.IdempotencyKey = *req.IdempotencyKey
		}
		recorded, err := appequipment.NewService().Deploy(ctx, uow, cmd)
		if err != nil {
			return nil, err
		}
		return map[string]any{"id": recorded.Operation.ID, "replayed": recorded.Existing}, nil
	})
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
		Quantity       *int    `json:"quantity"`
		Reason         *string `json:"reason"`
		Condition      *string `json:"condition"`
		Notes          *string `json:"notes"`
		Date           *string `json:"date"`
		IdempotencyKey *string `json:"idempotencyKey"`
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

	s.equipInUOW(w, r, func(ctx context.Context, uow *app.UnitOfWork) (map[string]any, error) {
		quantity := 0
		if req.Quantity != nil {
			quantity = *req.Quantity
		}
		cmd := appequipment.Command{OccurredAt: date, Reason: reason}
		if req.Notes != nil {
			cmd.Notes = *req.Notes
		}
		if req.IdempotencyKey != nil {
			cmd.IdempotencyKey = *req.IdempotencyKey
		}
		recorded, err := appequipment.NewService().Return(ctx, uow, id, quantity, cmd)
		if err != nil {
			return nil, err
		}
		returned, _ := strconv.Atoi(strings.Split(strings.TrimPrefix(recorded.Operation.Lines[1].Quantity, "+"), ".")[0])
		itemID := recorded.Operation.Lines[1].Tuple.ItemID
		if condition == "damaged" || condition == "retired" {
			key := cmd.IdempotencyKey
			if key != "" {
				key += ":condition"
			}
			_, err = appequipment.NewService().ConditionChange(ctx, uow, appequipment.ConditionCommand{Command: appequipment.Command{Reference: itemID, Quantity: returned, OccurredAt: date, IdempotencyKey: key, Reason: "returned_damaged", Notes: cmd.Notes}, From: "serviceable", To: condition})
			if err != nil {
				return nil, err
			}
		}
		var outstanding, total int
		err = uow.QueryRow(ctx, `SELECT d.qty-COALESCE(r.qty,0),COALESCE(r.qty,0) FROM (SELECT quantity::int qty FROM inventory_movements WHERE operation_id=$1 AND quantity>0)d CROSS JOIN LATERAL(SELECT SUM(m.quantity)::int qty FROM inventory_operations o JOIN inventory_movements m ON m.operation_id=o.id WHERE o.kind='return' AND o.source_type='inventory_operation' AND o.source_id=$1 AND m.quantity>0)r`, id).Scan(&outstanding, &total)
		if err != nil {
			return nil, app.Internal("return equipment", err)
		}
		return map[string]any{"id": recorded.Operation.ID, "quantityReturned": returned, "totalReturned": total, "outstanding": outstanding, "fullyReturned": outstanding == 0, "replayed": recorded.Existing}, nil
	})
}

// GET /equipment/deployments/active — anything still on a hive.
func (s *Server) equipActiveDeployments(w http.ResponseWriter, r *http.Request) {
	rows, err := s.pool.Query(r.Context(), `
		SELECT first_deploy.id,b.item_id,b.on_hand::int,0,
		       h.position_label,et.name,et.category,first_deploy.occurred_at
		FROM inventory_balances b
		JOIN inventory_locations l ON l.id=b.location_id AND l.kind='deployed'
		JOIN inventory_items i ON i.id=b.item_id
		JOIN equipment_types et ON et.id=i.source_id
		JOIN hives h ON h.id=b.container_hive_id
		JOIN LATERAL(SELECT o.id,o.occurred_at FROM inventory_operations o
		 JOIN inventory_movements m ON m.operation_id=o.id
		 WHERE o.kind='deploy' AND m.item_id=b.item_id AND m.container_hive_id=b.container_hive_id AND m.quantity>0
		 ORDER BY o.occurred_at,o.id LIMIT 1)first_deploy ON true
		WHERE b.on_hand>0 AND b.condition='serviceable'
		ORDER BY h.position_label,et.name`)
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
		SELECT o.id,m.item_id,m.quantity::int,COALESCE(returned.quantity,0),
		       o.occurred_at,CASE WHEN COALESCE(returned.quantity,0)>=m.quantity THEN returned.last_at END,
		       o.details->>'notes',et.name,et.category
		FROM inventory_operations o JOIN inventory_movements m ON m.operation_id=o.id AND m.quantity>0
		JOIN inventory_items i ON i.id=m.item_id JOIN equipment_types et ON et.id=i.source_id
		LEFT JOIN LATERAL(SELECT SUM(rm.quantity)::int quantity,MAX(ro.occurred_at) last_at FROM inventory_operations ro JOIN inventory_movements rm ON rm.operation_id=ro.id WHERE ro.kind='return' AND ro.source_type='inventory_operation' AND ro.source_id=o.id AND rm.quantity>0)returned ON true
		WHERE o.kind='deploy' AND m.container_hive_id=$1
		ORDER BY o.occurred_at DESC`, hiveID)
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
		SELECT replace(i.source_type,'equipment_type_frame_',''),COALESCE(SUM(a.available),0)::int
		FROM inventory_items i LEFT JOIN inventory_available a ON a.item_id=i.id
		JOIN inventory_locations l ON l.id=a.location_id
		WHERE i.source_type IN('equipment_type_frame_drawn','equipment_type_frame_fresh') AND l.is_home AND a.condition='serviceable'
		GROUP BY i.id,i.source_type`)
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
		SELECT et.name,et.frames_per_box,COALESCE(SUM(b.on_hand),0)::int
		FROM inventory_balances b JOIN inventory_locations l ON l.id=b.location_id AND l.kind='deployed'
		JOIN inventory_items i ON i.id=b.item_id JOIN equipment_types et ON et.id=i.source_id
		WHERE b.on_hand>0 AND b.condition='serviceable' AND et.category='box'
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
