package equipment

import (
	"context"
	"errors"
	"sort"

	"github.com/biker2000on/beez-trackz/backend/internal/app"
	"github.com/biker2000on/beez-trackz/backend/internal/db"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

// The equipment bill of materials.
//
// inventory_boms / inventory_bom_lines are the single authority (spec 3.6: the
// BOM tables absorb equipment_type_components, which Phase B drops). One BOM
// per equipment type — its output_item_id is that type's inventory item — and
// one role='input' line per component item. That is exactly the shape
// app/backfill mirrors into, so a database that has been backfilled and one the
// operator has edited hold the same rows.
//
// The operator still thinks in catalog types, so the surface here is stated in
// types and the item keys are resolved on the way in and out:
//
//   - a type's BOM key is equipment_types.item_id, the singular catalog link
//     EnsureItem sets on first use. app/backfill keys on the same column, so the
//     editor and the mirror never disagree about which item a split frame type's
//     recipe hangs off.
//   - a line's component type is inventory_items.source_id read back through the
//     equipment source types. Assembly then resolves that type to the item it
//     will actually consume with EnsureItem, exactly as it did when the recipe
//     was stated in catalog rows — so a split frame type keeps consuming the
//     identity it always did.
//
// While the legacy chain is alive the writer also mirrors each edit into
// equipment_type_components. That table is unfrozen until Phase B and is what a
// Phase A backfill reads, so letting the two drift would let the backfill undo
// an edit. Legacy migration 00054 seeds the ledger BOM from the catalog table
// once, so the reads below find the recipes an existing Phase A database
// already had.
//
// Cycles are refused twice, on purpose. CheckBOMCycle walks the ledger graph in
// Go before any write, so a database that has lost its trigger still refuses;
// inventory_bom_lines also carries a BEFORE INSERT/UPDATE trigger of its own
// (legacy 00054, and the same objects in 00001_baseline.sql) so a hand-run
// INSERT cannot make the graph undecidable either.

// itemSourceTypes is every inventory_items.source_type an equipment catalog row
// can carry — the plain type, and the two identities a frame type splits into.
const itemSourceTypes = `('equipment_type','equipment_type_frame_drawn','equipment_type_frame_fresh')`

// BOMLine is one input line of a recipe, in the catalog terms the operator
// edits. LineID is the inventory_bom_lines row it came from.
type BOMLine struct {
	LineID            uuid.UUID
	ParentTypeID      uuid.UUID
	ParentTypeName    string
	ComponentTypeID   uuid.UUID
	ComponentTypeName string
	Quantity          int
	UnitCostCents     *int
}

// bomSelect is the one profile-agnostic read of the ledger BOM. It names no
// table Phase B drops, so it serves both schemas unchanged.
const bomSelect = `
	SELECT l.id, pt.id, pt.name, ct.id, ct.name, l.quantity::int, ct.unit_cost_cents
	FROM inventory_bom_lines l
	JOIN inventory_boms b ON b.id = l.bom_id
	JOIN inventory_items pi ON pi.id = b.output_item_id
		AND pi.source_type IN ` + itemSourceTypes + `
	JOIN equipment_types pt ON pt.id = pi.source_id
	JOIN inventory_items ci ON ci.id = l.item_id
		AND ci.source_type IN ` + itemSourceTypes + `
	JOIN equipment_types ct ON ct.id = ci.source_id
	WHERE l.role = 'input'`

func scanBOMLines(rows pgx.Rows) ([]BOMLine, error) {
	defer rows.Close()
	out := make([]BOMLine, 0)
	for rows.Next() {
		var line BOMLine
		if err := rows.Scan(&line.LineID, &line.ParentTypeID, &line.ParentTypeName,
			&line.ComponentTypeID, &line.ComponentTypeName, &line.Quantity,
			&line.UnitCostCents); err != nil {
			return nil, err
		}
		out = append(out, line)
	}
	return out, rows.Err()
}

// AllComponents is every BOM line in the catalog, for the type-management page:
// parent name then component name, the order the old listing used.
func AllComponents(ctx context.Context, q app.Querier) ([]BOMLine, error) {
	const action = "list equipment components"
	rows, err := q.Query(ctx, bomSelect+` ORDER BY pt.name, ct.name`)
	if err != nil {
		return nil, app.Internal(action, err)
	}
	lines, err := scanBOMLines(rows)
	if err != nil {
		return nil, app.Internal(action, err)
	}
	return lines, nil
}

// Components is one type's recipe, ordered by component type id — the order
// Assembly built its movements in before the recipe moved to the ledger, kept
// so the same input still produces the same operation.
func Components(ctx context.Context, q app.Querier, typeID uuid.UUID) ([]BOMLine, error) {
	const action = "read equipment bill of materials"
	rows, err := q.Query(ctx, bomSelect+` AND pt.id = $1 ORDER BY ct.id`, typeID)
	if err != nil {
		return nil, app.Internal(action, err)
	}
	lines, err := scanBOMLines(rows)
	if err != nil {
		return nil, app.Internal(action, err)
	}
	return lines, nil
}

// SetLine is one requested input line. The caller has already validated the
// quantity; SetComponents enforces everything that needs the database.
type SetLine struct {
	ComponentTypeID uuid.UUID
	Quantity        int
}

// BOMItemID is the inventory item a type's recipe hangs off:
// equipment_types.item_id, created on demand. It is deliberately that column
// rather than EnsureItem's default identity, because for a split frame type the
// two can differ and app/backfill's mirror keys on the column — writing the
// other one would produce a second, disagreeing BOM.
func BOMItemID(ctx context.Context, uow *app.UnitOfWork, typeID uuid.UUID) (uuid.UUID, error) {
	const action = "resolve equipment bill-of-materials item"
	var itemID *uuid.UUID
	err := uow.QueryRow(ctx, `SELECT item_id FROM equipment_types WHERE id=$1`, typeID).Scan(&itemID)
	if errors.Is(err, pgx.ErrNoRows) {
		return uuid.Nil, app.NotFound(action, "equipment type %s does not exist", typeID)
	}
	if err != nil {
		return uuid.Nil, app.Internal(action, err)
	}
	if itemID != nil {
		return *itemID, nil
	}
	// EnsureItem sets equipment_types.item_id with COALESCE, so the type comes
	// back keyed on the identity it just created.
	item, err := EnsureItem(ctx, uow, typeID, "")
	if err != nil {
		return uuid.Nil, err
	}
	return item.ItemID, nil
}

// CheckBOMCycle refuses a recipe that would let an item (transitively) contain
// itself, which makes assembly cost and availability undecidable. It walks the
// ledger graph as it will be AFTER the write: parentItem's own lines are about
// to be replaced by newItems, so the walk skips them and starts from newItems.
func CheckBOMCycle(
	ctx context.Context, q app.Querier, parentItem uuid.UUID, newItems []uuid.UUID,
) error {
	const action = "set equipment bill of materials"
	if len(newItems) == 0 {
		return nil
	}
	// reached = every item building parentItem would consume, directly or
	// transitively. parentItem turning up in it is the cycle.
	var offender uuid.UUID
	err := q.QueryRow(ctx, `
		WITH RECURSIVE reached AS (
		  SELECT unnest($2::uuid[]) AS item_id
		  UNION
		  SELECT l.item_id
		  FROM inventory_bom_lines l
		  JOIN inventory_boms b ON b.id = l.bom_id
		  JOIN reached r ON r.item_id = b.output_item_id
		  WHERE l.role = 'input' AND b.output_item_id <> $1
		)
		SELECT item_id FROM reached WHERE item_id = $1 LIMIT 1`,
		parentItem, newItems).Scan(&offender)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil
	}
	if err != nil {
		return app.Internal(action, err)
	}
	return app.Precondition(action, "That component would make the type contain itself")
}

// SetComponents replaces one type's whole recipe.
//
// The ledger BOM is the authority: the type's inventory_boms row is created on
// demand, its input lines are replaced, and an empty recipe takes the BOM row
// with it — which is the state app/backfill's NOT EXISTS guard expects for a
// type with no components. On the legacy chain the same edit is mirrored into
// equipment_type_components, row for row.
func SetComponents(
	ctx context.Context, uow *app.UnitOfWork, typeID uuid.UUID, lines []SetLine,
) error {
	const action = "set equipment bill of materials"
	if uow == nil || !uow.Actor().Valid() {
		return app.Forbidden(action, "an active unit of work with an actor is required")
	}
	var name string
	err := uow.QueryRow(ctx, `SELECT name FROM equipment_types WHERE id=$1 FOR UPDATE`,
		typeID).Scan(&name)
	if errors.Is(err, pgx.ErrNoRows) {
		return app.NotFound(action, "type not found")
	}
	if err != nil {
		return app.Internal(action, err)
	}

	parentItem, err := BOMItemID(ctx, uow, typeID)
	if err != nil {
		return err
	}
	componentItems := make([]uuid.UUID, 0, len(lines))
	quantities := make(map[uuid.UUID]int, len(lines))
	for _, line := range lines {
		if line.ComponentTypeID == typeID {
			return app.Invalid(action, "A type cannot be a component of itself")
		}
		item, err := BOMItemID(ctx, uow, line.ComponentTypeID)
		if err != nil {
			if app.KindOf(err) == app.KindNotFound {
				return app.Invalid(action, "invalid componentTypeId")
			}
			return err
		}
		if item == parentItem {
			return app.Invalid(action, "A type cannot be a component of itself")
		}
		if _, seen := quantities[item]; seen {
			// Two catalog rows sharing one inventory item would collide on the
			// (bom_id, role, item_id) key. Say so rather than let the second
			// line silently overwrite the first.
			return app.Invalid(action, "Duplicate component type")
		}
		quantities[item] = line.Quantity
		componentItems = append(componentItems, item)
	}
	if err := CheckBOMCycle(ctx, uow, parentItem, componentItems); err != nil {
		return err
	}

	if _, err := uow.Exec(ctx,
		`DELETE FROM inventory_boms WHERE output_item_id=$1`, parentItem); err != nil {
		return app.Internal(action, err)
	}
	if len(componentItems) > 0 {
		var bomID uuid.UUID
		if err := uow.QueryRow(ctx, `
			INSERT INTO inventory_boms(name,output_item_id,created_by)
			VALUES($1,$2,$3) RETURNING id`,
			name, parentItem, auditID(uow)).Scan(&bomID); err != nil {
			return app.Internal(action, err)
		}
		// Sorted so two editors writing the same recipe produce the same row
		// order, and so a failure names a deterministic line.
		sort.Slice(componentItems, func(i, j int) bool {
			return componentItems[i].String() < componentItems[j].String()
		})
		for _, item := range componentItems {
			if _, err := uow.Exec(ctx, `
				INSERT INTO inventory_bom_lines(bom_id,role,item_id,quantity,created_by)
				VALUES($1,'input',$2,$3,$4)`,
				bomID, item, quantities[item], auditID(uow)); err != nil {
				return bomWriteError(action, err)
			}
		}
	}
	return mirrorLegacyComponents(ctx, uow, action, typeID, lines)
}

// mirrorLegacyComponents keeps the unfrozen equipment_type_components table
// agreeing with the ledger BOM while the legacy chain is alive. Phase B drops
// the table and this becomes a no-op by construction.
func mirrorLegacyComponents(
	ctx context.Context, uow *app.UnitOfWork, action string,
	typeID uuid.UUID, lines []SetLine,
) error {
	if db.ActiveProfile() == db.ProfileBaseline {
		return nil
	}
	if _, err := uow.Exec(ctx,
		// legacy-chain-only
		`DELETE FROM equipment_type_components WHERE parent_type_id=$1`, typeID); err != nil {
		return app.Internal(action, err)
	}
	for _, line := range lines {
		if _, err := uow.Exec(ctx,
			// legacy-chain-only
			`
			INSERT INTO equipment_type_components
				(parent_type_id,component_type_id,quantity,created_by)
			VALUES($1,$2,$3,$4)`,
			typeID, line.ComponentTypeID, line.Quantity, auditID(uow)); err != nil {
			return bomWriteError(action, err)
		}
	}
	return nil
}

// bomWriteError turns the two constraint violations a BOM insert can raise into
// the typed errors this surface already speaks: 23503 is an unknown component,
// 23514 is a cycle the database caught after the Go walk — a graph that moved
// under a concurrent editor, or a caller that skipped the walk.
func bomWriteError(action string, err error) error {
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) {
		switch pgErr.Code {
		case "23503":
			return app.Invalid(action, "invalid componentTypeId")
		case "23514":
			return app.Precondition(action, "That component would make the type contain itself")
		}
	}
	return app.Internal(action, err)
}
