package httpapi

import (
	"context"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/biker2000on/beez-trackz/backend/internal/app"
	appequipment "github.com/biker2000on/beez-trackz/backend/internal/app/equipment"
	"github.com/biker2000on/beez-trackz/backend/internal/db"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// Type management and the bill of materials. A BOM line says a parent type is
// built from N of a component type; assembling and disassembling write plain
// ownership-ledger adjustments ('assembled' / 'disassembled') on the parent
// and every component inside one transaction, so availability, the reconcile
// guard, and the loss report all keep working with no special cases.

// equipCheckVariantBase verifies a variant target: it must exist and must not
// itself be a variant (varieties stay one level deep).
func (s *Server) equipCheckVariantBase(ctx context.Context, baseID uuid.UUID) error {
	var baseIsVariant bool
	err := s.pool.QueryRow(ctx, `
		SELECT variant_of_type_id IS NOT NULL FROM equipment_types WHERE id = $1`,
		baseID).Scan(&baseIsVariant)
	if err == pgx.ErrNoRows {
		return equipBadRequest("invalid variantOfTypeId")
	}
	if err != nil {
		return err
	}
	if baseIsVariant {
		return equipBadRequest("A variant cannot be based on another variant")
	}
	return nil
}

// PATCH /equipment/types/{id} {name?, category?, framesPerBox?, variantOfTypeId?}
func (s *Server) equipUpdateType(w http.ResponseWriter, r *http.Request) {
	id, err := uuidParam(r, "id")
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	var req struct {
		Name            *string `json:"name"`
		Category        *string `json:"category"`
		FramesPerBox    *int    `json:"framesPerBox"`
		VariantOfTypeID *string `json:"variantOfTypeId"`
		// clear* distinguish "unset the value" from "leave it".
		ClearFramesPerBox bool `json:"clearFramesPerBox"`
		ClearVariantOf    bool `json:"clearVariantOf"`
	}
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}

	sets := make([]string, 0, 3)
	args := make([]any, 0, 4)
	if req.Name != nil {
		name := strings.TrimSpace(*req.Name)
		if name == "" {
			writeError(w, http.StatusBadRequest, "Name cannot be empty")
			return
		}
		args = append(args, name)
		sets = append(sets, fmt.Sprintf("name = $%d", len(args)))
	}
	if req.Category != nil {
		if !equipCategories[*req.Category] {
			writeError(w, http.StatusBadRequest, "invalid category")
			return
		}
		args = append(args, *req.Category)
		sets = append(sets, fmt.Sprintf("category = $%d", len(args)))
	}
	if req.ClearFramesPerBox {
		sets = append(sets, "frames_per_box = NULL")
	} else if req.FramesPerBox != nil {
		if *req.FramesPerBox < 1 {
			writeError(w, http.StatusBadRequest, "Frames per box must be at least 1")
			return
		}
		args = append(args, *req.FramesPerBox)
		sets = append(sets, fmt.Sprintf("frames_per_box = $%d", len(args)))
	}
	if req.ClearVariantOf {
		sets = append(sets, "variant_of_type_id = NULL")
	} else if v := equipTrimPtr(req.VariantOfTypeID); v != nil {
		baseID, err := uuid.Parse(*v)
		if err != nil || baseID == id {
			writeError(w, http.StatusBadRequest, "invalid variantOfTypeId")
			return
		}
		if err := s.equipCheckVariantBase(r.Context(), baseID); err != nil {
			equipWriteError(w, err)
			return
		}
		// One level deep: a type that already has variants cannot itself
		// become a variant.
		var hasVariants bool
		if err := s.pool.QueryRow(r.Context(), `
			SELECT EXISTS (SELECT 1 FROM equipment_types WHERE variant_of_type_id = $1)`,
			id).Scan(&hasVariants); err != nil {
			writeError(w, http.StatusInternalServerError, "database error")
			return
		}
		if hasVariants {
			writeError(w, http.StatusBadRequest,
				"This type has variants of its own — detach them first")
			return
		}
		args = append(args, baseID)
		sets = append(sets, fmt.Sprintf("variant_of_type_id = $%d", len(args)))
	}
	if len(sets) == 0 {
		writeJSON(w, http.StatusOK, map[string]any{"success": true})
		return
	}

	args = append(args, id)
	tag, err := s.pool.Exec(r.Context(), fmt.Sprintf(
		"UPDATE equipment_types SET %s WHERE id = $%d",
		strings.Join(sets, ", "), len(args)), args...)
	if err != nil {
		if equipPgErrCode(err, "23505") {
			writeError(w, http.StatusConflict, "A type with that name already exists")
			return
		}
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	if tag.RowsAffected() == 0 {
		writeError(w, http.StatusNotFound, "type not found")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"success": true})
}

// equipComponentParentSQL asks "does some OTHER type list $1 in its bill of
// materials, and what is that type called" — one row or none.
//
// The two schemas keep that fact in different places. On the legacy chain it
// is equipment_type_components, the table the operator edits. Phase B drops
// that table (spec section 9; db.BaselineDroppedDomains) and the recipe lives
// in inventory_boms / inventory_bom_lines instead, keyed on inventory items
// rather than catalog rows — the shape backfill.go mirrors into. Naming the
// dropped table unconditionally would fail this endpoint outright on a
// baseline database, which is what it used to do (wave-3c finding F2).
//
// NOTE: the rest of the bill-of-materials surface (equipListComponents,
// equipSetComponents, and the component read inside app/equipment.Assembly)
// still names equipment_type_components unconditionally and therefore still
// fails on a baseline database. Moving those is a separate change — it has to
// decide whether the operator edits inventory_boms directly and where the
// 00046 cycle trigger goes once its table is gone.
func equipComponentParentSQL() string {
	if db.ActiveProfile() != db.ProfileBaseline {
		return `
			SELECT pt.name FROM equipment_type_components c
			JOIN equipment_types pt ON pt.id = c.parent_type_id
			WHERE c.component_type_id = $1 LIMIT 1`
	}
	return `
		SELECT pt.name
		FROM inventory_bom_lines l
		JOIN inventory_boms b ON b.id = l.bom_id
		JOIN inventory_items pi ON pi.id = b.output_item_id
			AND pi.source_type IN ` + equipItemSourceTypes + `
		JOIN equipment_types pt ON pt.id = pi.source_id
		JOIN inventory_items ci ON ci.id = l.item_id
			AND ci.source_type IN ` + equipItemSourceTypes + `
		WHERE l.role = 'input' AND ci.source_id = $1
		LIMIT 1`
}

// DELETE /equipment/types/{id}
//
// A type disappears only when nothing depends on it: it may not appear in
// another type's bill of materials, and the inventory items behind it must
// carry no ledger history. Anything the ledger has recorded should be retired,
// not deleted.
//
// Phase B (spec section 9) dissolved equipment_stock and the three history
// tables this used to probe, so "has history" is now "has any
// inventory_movements" — asked of every item the type split into, because a
// frame type is two items (drawn and fresh). With no movements the item rows
// hold nothing, so they go with the type, along with the ledger BOM keyed on
// them. equipment_type_components goes too (it is dropped at Phase B), which
// is why the "is this a component of something" check is composed rather than
// written out — see equipComponentParentSQL.
//
// The pre-ledger equipment_stock row is deliberately NOT deleted, on either
// profile. Nothing writes that table any more, and after the Phase A freeze
// (spec section 9 step 3) a DELETE against it raises — so the old delete
// could not have run on a frozen database anyway. The consequence on a legacy
// chain that still holds a stock row for this type is that
// equipment_stock.type_id refuses the catalog delete, and the operator gets
// the "still referenced elsewhere" conflict instead of a silent cascade. That
// is the honest answer while both schemas exist; the row disappears with the
// table at Phase B.
//
// Order matters: equipment_types.item_id references inventory_items ON DELETE
// RESTRICT, so the catalog row has to go first, and inventory_boms references
// the item too, so it has to go before the item. Anything else still pointing
// at the item (a sale line, a checkpoint) surfaces as 23503 and becomes the
// same "referenced elsewhere" conflict the catalog delete already returned.
func (s *Server) equipDeleteType(w http.ResponseWriter, r *http.Request) {
	id, err := uuidParam(r, "id")
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	s.equipInTx(w, r, func(ctx context.Context, tx pgx.Tx) (map[string]any, error) {
		var parentName string
		err := tx.QueryRow(ctx, equipComponentParentSQL(), id).Scan(&parentName)
		if err == nil {
			return nil, equipFail(http.StatusConflict,
				"This type is a component of %q — remove it from that bill of materials first", parentName)
		} else if err != pgx.ErrNoRows {
			return nil, err
		}

		itemRows, err := tx.Query(ctx, `
			SELECT id FROM inventory_items
			WHERE source_type IN `+equipItemSourceTypes+`
			  AND source_id = $1
			FOR UPDATE`, id)
		if err != nil {
			return nil, err
		}
		itemIDs, err := pgx.CollectRows(itemRows, pgx.RowTo[uuid.UUID])
		if err != nil {
			return nil, err
		}
		if len(itemIDs) > 0 {
			var hasHistory bool
			if err := tx.QueryRow(ctx,
				`SELECT EXISTS (SELECT 1 FROM inventory_movements WHERE item_id = ANY($1))`,
				itemIDs).Scan(&hasHistory); err != nil {
				return nil, err
			}
			if hasHistory {
				return nil, app.Conflict("equipment.deleteType",
					"This type has recorded inventory history — retire the stock instead of deleting the type")
			}
		}

		tag, err := tx.Exec(ctx, `DELETE FROM equipment_types WHERE id = $1`, id)
		if err != nil {
			if equipPgErrCode(err, "23503") {
				return nil, app.Conflict("equipment.deleteType",
					"This type is still referenced elsewhere and cannot be deleted")
			}
			return nil, err
		}
		if tag.RowsAffected() == 0 {
			return nil, equipFail(http.StatusNotFound, "type not found")
		}

		if len(itemIDs) > 0 {
			// The mirrored ledger BOM is this type's own recipe; its lines
			// cascade. Lines in SOMEBODY ELSE's recipe are the component case
			// the bill-of-materials check above already refused.
			if _, err := tx.Exec(ctx,
				`DELETE FROM inventory_boms WHERE output_item_id = ANY($1)`, itemIDs); err != nil {
				return nil, err
			}
			if _, err := tx.Exec(ctx,
				`DELETE FROM inventory_items WHERE id = ANY($1)`, itemIDs); err != nil {
				if equipPgErrCode(err, "23503") {
					return nil, app.Conflict("equipment.deleteType",
						"This type is still referenced elsewhere and cannot be deleted")
				}
				return nil, err
			}
		}
		return nil, nil
	})
}

// --- bill of materials ---

type equipComponentRow struct {
	ID                uuid.UUID `json:"id"`
	ParentTypeID      uuid.UUID `json:"parentTypeId"`
	ParentTypeName    string    `json:"parentTypeName"`
	ComponentTypeID   uuid.UUID `json:"componentTypeId"`
	ComponentTypeName string    `json:"componentTypeName"`
	Quantity          int       `json:"quantity"`
}

// GET /equipment/components — every BOM line, for the type-management page.
func (s *Server) equipListComponents(w http.ResponseWriter, r *http.Request) {
	rows, err := s.pool.Query(r.Context(), `
		SELECT c.id, c.parent_type_id, pt.name, c.component_type_id, ct.name, c.quantity
		FROM equipment_type_components c
		JOIN equipment_types pt ON pt.id = c.parent_type_id
		JOIN equipment_types ct ON ct.id = c.component_type_id
		ORDER BY pt.name, ct.name`)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	defer rows.Close()
	out := make([]equipComponentRow, 0)
	for rows.Next() {
		var row equipComponentRow
		if err := rows.Scan(&row.ID, &row.ParentTypeID, &row.ParentTypeName,
			&row.ComponentTypeID, &row.ComponentTypeName, &row.Quantity); err != nil {
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

// PUT /equipment/types/{id}/components {components: [{componentTypeId, quantity}]}
// Replaces the whole bill of materials for one parent type.
func (s *Server) equipSetComponents(w http.ResponseWriter, r *http.Request) {
	parentID, err := uuidParam(r, "id")
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	var req struct {
		Components []struct {
			ComponentTypeID string `json:"componentTypeId"`
			Quantity        int    `json:"quantity"`
		} `json:"components"`
	}
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	type line struct {
		typeID   uuid.UUID
		quantity int
	}
	lines := make([]line, 0, len(req.Components))
	seen := make(map[uuid.UUID]bool, len(req.Components))
	for _, c := range req.Components {
		typeID, err := uuid.Parse(c.ComponentTypeID)
		if err != nil {
			writeError(w, http.StatusBadRequest, "invalid componentTypeId")
			return
		}
		if typeID == parentID {
			writeError(w, http.StatusBadRequest, "A type cannot be a component of itself")
			return
		}
		if seen[typeID] {
			writeError(w, http.StatusBadRequest, "Duplicate component type")
			return
		}
		seen[typeID] = true
		if c.Quantity < 1 {
			writeError(w, http.StatusBadRequest, "Component quantity must be at least 1")
			return
		}
		lines = append(lines, line{typeID: typeID, quantity: c.Quantity})
	}

	s.equipInTx(w, r, func(ctx context.Context, tx pgx.Tx) (map[string]any, error) {
		var exists bool
		if err := tx.QueryRow(ctx,
			`SELECT EXISTS (SELECT 1 FROM equipment_types WHERE id = $1)`, parentID).
			Scan(&exists); err != nil {
			return nil, err
		}
		if !exists {
			return nil, equipFail(http.StatusNotFound, "type not found")
		}
		if _, err := tx.Exec(ctx,
			`DELETE FROM equipment_type_components WHERE parent_type_id = $1`,
			parentID); err != nil {
			return nil, err
		}
		for _, l := range lines {
			if _, err := tx.Exec(ctx, `
				INSERT INTO equipment_type_components
					(parent_type_id, component_type_id, quantity, created_by)
				VALUES ($1, $2, $3, $4)`,
				parentID, l.typeID, l.quantity, equipActor(r)); err != nil {
				switch {
				case equipPgErrCode(err, "23503"):
					return nil, equipBadRequest("invalid componentTypeId")
				case equipPgErrCode(err, "23514"):
					return nil, equipBadRequest(
						"That component would make the type contain itself")
				}
				return nil, err
			}
		}
		return map[string]any{"count": len(lines)}, nil
	})
}

// --- assemble / disassemble ---

// POST /equipment/assemblies
// {typeId, quantity, action: "assemble"|"disassemble", date?, notes?, idempotencyKey?}
//
// Assemble consumes `quantity × line.quantity` of every component and produces
// `quantity` of the parent; disassemble is the exact inverse. The equipment
// command delegates availability serialization to the inventory tuple locks.
func (s *Server) equipAssemble(w http.ResponseWriter, r *http.Request) {
	var req struct {
		TypeID         string  `json:"typeId"`
		Quantity       int     `json:"quantity"`
		Action         string  `json:"action"`
		Date           *string `json:"date"`
		Notes          *string `json:"notes"`
		IdempotencyKey *string `json:"idempotencyKey"`
	}
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	typeID, err := uuid.Parse(req.TypeID)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid typeId")
		return
	}
	if req.Quantity < 1 {
		writeError(w, http.StatusBadRequest, "Quantity must be at least 1")
		return
	}
	if req.Action != "assemble" && req.Action != "disassemble" {
		writeError(w, http.StatusBadRequest, "action must be assemble or disassemble")
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
		return equipApplyAssembly(ctx, uow, equipAssemblyRequest{
			TypeID:         typeID,
			Quantity:       req.Quantity,
			Action:         req.Action,
			Date:           date,
			Notes:          equipTrimPtr(req.Notes),
			IdempotencyKey: equipTrimPtr(req.IdempotencyKey),
		})
	})
}

// equipAssemblyRequest is the parsed form of an assemble/disassemble call, so
// the core write is reusable by handlers and tests alike.
type equipAssemblyRequest struct {
	TypeID         uuid.UUID
	Quantity       int
	Action         string
	Date           time.Time
	Notes          *string
	IdempotencyKey *string
}

func equipApplyAssembly(
	ctx context.Context, uow *app.UnitOfWork, req equipAssemblyRequest,
) (map[string]any, error) {
	typeID, date := req.TypeID, req.Date
	notes, key := "", ""
	if req.Notes != nil {
		notes = *req.Notes
	}
	if req.IdempotencyKey != nil {
		key = *req.IdempotencyKey
	}
	recorded, err := appequipment.NewService().Assembly(ctx, uow, appequipment.AssemblyCommand{
		TypeID: typeID, Quantity: req.Quantity, Disassemble: req.Action == "disassemble",
		OccurredAt: date, IdempotencyKey: key, Notes: notes,
	})
	if err != nil {
		return nil, err
	}
	if recorded.Existing {
		return map[string]any{"replayed": true}, nil
	}
	var parentName string
	if err := uow.QueryRow(ctx, `SELECT name FROM equipment_types WHERE id=$1`, typeID).Scan(&parentName); err != nil {
		return nil, err
	}
	rows, err := uow.Query(ctx, `SELECT c.component_type_id,ct.name,c.quantity FROM equipment_type_components c JOIN equipment_types ct ON ct.id=c.component_type_id WHERE c.parent_type_id=$1 ORDER BY ct.id`, typeID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	components := make([]map[string]any, 0)
	sign := -1
	if req.Action == "disassemble" {
		sign = 1
	}
	for rows.Next() {
		var componentTypeID uuid.UUID
		var componentName string
		var componentQuantity int
		if err := rows.Scan(&componentTypeID, &componentName, &componentQuantity); err != nil {
			return nil, err
		}
		components = append(components, map[string]any{"typeId": componentTypeID, "typeName": componentName, "quantity": sign * componentQuantity * req.Quantity})
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return map[string]any{
		"operationId": recorded.Operation.ID,
		"typeId":      typeID,
		"typeName":    parentName,
		"action":      req.Action,
		"quantity":    req.Quantity,
		"components":  components,
	}, nil
}
