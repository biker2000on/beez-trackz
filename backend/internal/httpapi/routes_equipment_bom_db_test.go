package httpapi

import (
	"context"
	"testing"
	"time"

	"github.com/biker2000on/beez-trackz/backend/internal/app"
	appequipment "github.com/biker2000on/beez-trackz/backend/internal/app/equipment"
	"github.com/google/uuid"
)

func withEquipmentBOMUOW(t *testing.T, test func(context.Context, *app.UnitOfWork)) {
	t.Helper()
	err := app.NewRunner(equipPool(t)).DryRun(context.Background(), app.SystemRestoreActor(uuid.Nil),
		func(ctx context.Context, uow *app.UnitOfWork) error {
			if _, err := uow.Exec(ctx, `INSERT INTO inventory_locations(id,kind,name,is_home) VALUES($1,'site','Home',true) ON CONFLICT(id) DO NOTHING`, appequipment.HomeLocation); err != nil {
				return err
			}
			test(ctx, uow)
			return nil
		})
	if err != nil {
		t.Fatalf("equipment BOM transaction: %v", err)
	}
}

func equipBOMType(t *testing.T, ctx context.Context, uow *app.UnitOfWork, category string) uuid.UUID {
	t.Helper()
	var id uuid.UUID
	if err := uow.QueryRow(ctx, `INSERT INTO equipment_types(name,category) VALUES($1,$2) RETURNING id`, "BOM "+category+" "+uuid.NewString(), category).Scan(&id); err != nil {
		t.Fatalf("insert equipment type: %v", err)
	}
	return id
}

// equipBOMLine appends one line to a parent's recipe through the writer the
// operator uses, so these tests exercise the same rows assembly reads: the
// ledger BOM, mirrored into equipment_type_components on the legacy chain.
func equipBOMLine(t *testing.T, ctx context.Context, uow *app.UnitOfWork, parent, component uuid.UUID, quantity int) {
	t.Helper()
	existing, err := appequipment.Components(ctx, uow, parent)
	if err != nil {
		t.Fatalf("read BOM: %v", err)
	}
	lines := make([]appequipment.SetLine, 0, len(existing)+1)
	for _, line := range existing {
		lines = append(lines, appequipment.SetLine{
			ComponentTypeID: line.ComponentTypeID, Quantity: line.Quantity})
	}
	lines = append(lines, appequipment.SetLine{ComponentTypeID: component, Quantity: quantity})
	if err := appequipment.SetComponents(ctx, uow, parent, lines); err != nil {
		t.Fatalf("set BOM line: %v", err)
	}
	// The legacy mirror has to agree, or a Phase A backfill would undo the edit.
	var mirrored int
	if err := uow.QueryRow(ctx, `SELECT quantity FROM equipment_type_components WHERE parent_type_id=$1 AND component_type_id=$2`, parent, component).Scan(&mirrored); err != nil {
		t.Fatalf("read the legacy mirror: %v", err)
	}
	if mirrored != quantity {
		t.Fatalf("legacy mirror quantity=%d, want %d", mirrored, quantity)
	}
}

func equipBOMReceive(t *testing.T, ctx context.Context, uow *app.UnitOfWork, typeID uuid.UUID, quantity int) uuid.UUID {
	t.Helper()
	item, err := appequipment.EnsureItem(ctx, uow, typeID, "")
	if err != nil {
		t.Fatalf("ensure inventory item: %v", err)
	}
	if quantity > 0 {
		if _, err := appequipment.NewService().Receive(ctx, uow, appequipment.Command{Reference: item.ItemID, Quantity: quantity, OccurredAt: time.Now().UTC(), Reason: "purchased"}); err != nil {
			t.Fatalf("receive equipment: %v", err)
		}
	}
	return item.ItemID
}

func equipBOMAvailable(t *testing.T, ctx context.Context, uow *app.UnitOfWork, itemID uuid.UUID) int {
	t.Helper()
	var available int
	if err := uow.QueryRow(ctx, `SELECT COALESCE(SUM(a.available),0)::int FROM inventory_available a WHERE a.item_id=$1 AND a.location_id=$2 AND a.condition='serviceable' AND a.container_hive_id IS NULL`, itemID, appequipment.HomeLocation).Scan(&available); err != nil {
		t.Fatalf("read equipment availability: %v", err)
	}
	return available
}

func TestEquipmentAssembleConsumesComponents(t *testing.T) {
	withEquipmentBOMUOW(t, func(ctx context.Context, uow *app.UnitOfWork) {
		superType := equipBOMType(t, ctx, uow, "box")
		boxType := equipBOMType(t, ctx, uow, "box")
		frameType := equipBOMType(t, ctx, uow, "frame")
		equipBOMLine(t, ctx, uow, superType, boxType, 1)
		equipBOMLine(t, ctx, uow, superType, frameType, 9)
		boxItem := equipBOMReceive(t, ctx, uow, boxType, 5)
		frameItem := equipBOMReceive(t, ctx, uow, frameType, 50)
		if _, err := uow.Exec(ctx, `UPDATE equipment_types SET unit_cost_cents=2000 WHERE id=$1`, boxType); err != nil {
			t.Fatal(err)
		}
		if _, err := uow.Exec(ctx, `UPDATE equipment_types SET unit_cost_cents=300 WHERE id=$1`, frameType); err != nil {
			t.Fatal(err)
		}

		result, err := equipApplyAssembly(ctx, uow, equipAssemblyRequest{TypeID: superType, Quantity: 3, Action: "assemble", Date: time.Now().UTC()})
		if err != nil {
			t.Fatalf("assemble: %v", err)
		}
		if result["quantity"] != 3 || equipBOMAvailable(t, ctx, uow, boxItem) != 2 || equipBOMAvailable(t, ctx, uow, frameItem) != 23 {
			t.Fatalf("unexpected assembly result=%v box=%d frame=%d", result, equipBOMAvailable(t, ctx, uow, boxItem), equipBOMAvailable(t, ctx, uow, frameItem))
		}
		var parentItem uuid.UUID
		var cost *int
		if err := uow.QueryRow(ctx, `SELECT item_id,unit_cost_cents FROM equipment_types WHERE id=$1`, superType).Scan(&parentItem, &cost); err != nil {
			t.Fatal(err)
		}
		if equipBOMAvailable(t, ctx, uow, parentItem) != 3 || cost == nil || *cost != 4700 {
			t.Fatalf("parent available/cost=%d/%v, want 3/4700", equipBOMAvailable(t, ctx, uow, parentItem), cost)
		}
		var legacyWrites int
		if err := uow.QueryRow(ctx, `SELECT COUNT(*) FROM equipment_stock_adjustments a JOIN equipment_stock s ON s.id=a.stock_id WHERE s.type_id=ANY($1)`, []uuid.UUID{superType, boxType, frameType}).Scan(&legacyWrites); err != nil || legacyWrites != 0 {
			t.Fatalf("legacy adjustment writes=%d err=%v", legacyWrites, err)
		}
	})
}

func TestEquipmentAssembleInsufficientComponents(t *testing.T) {
	withEquipmentBOMUOW(t, func(ctx context.Context, uow *app.UnitOfWork) {
		superType := equipBOMType(t, ctx, uow, "box")
		frameType := equipBOMType(t, ctx, uow, "frame")
		equipBOMLine(t, ctx, uow, superType, frameType, 9)
		equipBOMReceive(t, ctx, uow, frameType, 8)
		_, err := equipApplyAssembly(ctx, uow, equipAssemblyRequest{TypeID: superType, Quantity: 1, Action: "assemble", Date: time.Now().UTC()})
		if !app.IsKind(err, app.KindPrecondition) {
			t.Fatalf("expected precondition conflict, got %v", err)
		}
	})
}

func TestEquipmentDisassembleReturnsComponents(t *testing.T) {
	withEquipmentBOMUOW(t, func(ctx context.Context, uow *app.UnitOfWork) {
		builtType := equipBOMType(t, ctx, uow, "frame")
		bareType := equipBOMType(t, ctx, uow, "frame")
		foundationType := equipBOMType(t, ctx, uow, "accessory")
		equipBOMLine(t, ctx, uow, builtType, bareType, 1)
		equipBOMLine(t, ctx, uow, builtType, foundationType, 1)
		builtItem := equipBOMReceive(t, ctx, uow, builtType, 10)

		if _, err := equipApplyAssembly(ctx, uow, equipAssemblyRequest{TypeID: builtType, Quantity: 4, Action: "disassemble", Date: time.Now().UTC()}); err != nil {
			t.Fatalf("disassemble: %v", err)
		}
		if got := equipBOMAvailable(t, ctx, uow, builtItem); got != 6 {
			t.Fatalf("built available=%d, want 6", got)
		}
		for _, componentType := range []uuid.UUID{bareType, foundationType} {
			var itemID uuid.UUID
			if err := uow.QueryRow(ctx, `SELECT item_id FROM equipment_types WHERE id=$1`, componentType).Scan(&itemID); err != nil {
				t.Fatal(err)
			}
			if got := equipBOMAvailable(t, ctx, uow, itemID); got != 4 {
				t.Fatalf("component available=%d, want 4", got)
			}
		}
		_, err := equipApplyAssembly(ctx, uow, equipAssemblyRequest{TypeID: builtType, Quantity: 7, Action: "disassemble", Date: time.Now().UTC()})
		if !app.IsKind(err, app.KindPrecondition) {
			t.Fatalf("expected precondition conflict, got %v", err)
		}
	})
}

func TestEquipmentAssembleIdempotentReplay(t *testing.T) {
	withEquipmentBOMUOW(t, func(ctx context.Context, uow *app.UnitOfWork) {
		superType := equipBOMType(t, ctx, uow, "box")
		frameType := equipBOMType(t, ctx, uow, "frame")
		equipBOMLine(t, ctx, uow, superType, frameType, 9)
		frameItem := equipBOMReceive(t, ctx, uow, frameType, 20)
		key := "assemble-" + uuid.NewString()
		req := equipAssemblyRequest{TypeID: superType, Quantity: 2, Action: "assemble", Date: time.Now().UTC(), IdempotencyKey: &key}
		if _, err := equipApplyAssembly(ctx, uow, req); err != nil {
			t.Fatalf("first assemble: %v", err)
		}
		result, err := equipApplyAssembly(ctx, uow, req)
		if err != nil || result["replayed"] != true || equipBOMAvailable(t, ctx, uow, frameItem) != 2 {
			t.Fatalf("replay result=%v err=%v available=%d", result, err, equipBOMAvailable(t, ctx, uow, frameItem))
		}
	})
}

func TestEquipmentComponentCycleGuard(t *testing.T) {
	// Two refusals, both meaningful. The writer walks the ledger BOM graph in
	// Go and returns a typed precondition; underneath it the trigger legacy
	// 00054 installs on inventory_bom_lines refuses the same shape written by
	// hand, and 00046's trigger still guards the legacy mirror table.
	withEquipmentBOMUOW(t, func(ctx context.Context, uow *app.UnitOfWork) {
		a := equipBOMType(t, ctx, uow, "box")
		b := equipBOMType(t, ctx, uow, "frame")
		c := equipBOMType(t, ctx, uow, "accessory")
		equipBOMLine(t, ctx, uow, a, b, 1)
		equipBOMLine(t, ctx, uow, b, c, 1)

		err := appequipment.SetComponents(ctx, uow, c, []appequipment.SetLine{{ComponentTypeID: a, Quantity: 1}})
		if !app.IsKind(err, app.KindPrecondition) {
			t.Fatalf("expected a precondition refusal for the cycle, got %v", err)
		}
		// Nothing was written by the refused edit.
		lines, err := appequipment.Components(ctx, uow, c)
		if err != nil || len(lines) != 0 {
			t.Fatalf("refused edit left %d lines (err %v)", len(lines), err)
		}

		// Straight at the tables, bypassing the Go rule entirely.
		cItem, err := appequipment.BOMItemID(ctx, uow, c)
		if err != nil {
			t.Fatal(err)
		}
		aItem, err := appequipment.BOMItemID(ctx, uow, a)
		if err != nil {
			t.Fatal(err)
		}
		var bomID uuid.UUID
		if err := uow.QueryRow(ctx, `INSERT INTO inventory_boms(name,output_item_id) VALUES('cycle',$1) RETURNING id`, cItem).Scan(&bomID); err != nil {
			t.Fatal(err)
		}
		_, err = uow.Exec(ctx, `INSERT INTO inventory_bom_lines(bom_id,role,item_id,quantity) VALUES($1,'input',$2,1)`, bomID, aItem)
		if !equipPgErrCode(err, "23514") {
			t.Fatalf("expected the inventory_bom_lines trigger to raise 23514, got %v", err)
		}
	})

	// The legacy mirror keeps its own guard until Phase B drops the table.
	ctx, tx := equipTx(t)
	a := equipFixtureType(t, ctx, tx, "box")
	b := equipFixtureType(t, ctx, tx, "frame")
	c := equipFixtureType(t, ctx, tx, "accessory")
	if _, err := tx.Exec(ctx, `INSERT INTO equipment_type_components(parent_type_id,component_type_id,quantity) VALUES($1,$2,1),($2,$3,1)`, a, b, c); err != nil {
		t.Fatal(err)
	}
	_, err := tx.Exec(ctx, `INSERT INTO equipment_type_components(parent_type_id,component_type_id,quantity) VALUES($1,$2,1)`, c, a)
	if !equipPgErrCode(err, "23514") {
		t.Fatalf("expected 23514 cycle rejection, got %v", err)
	}
}

// TestEquipmentSetComponentsIsTheLedgerBOM pins the writer's row shape against
// the shape app/backfill mirrors into: one inventory_boms row keyed on
// equipment_types.item_id, role='input' lines keyed on the component items, and
// an empty recipe that takes the BOM row with it.
func TestEquipmentSetComponentsIsTheLedgerBOM(t *testing.T) {
	withEquipmentBOMUOW(t, func(ctx context.Context, uow *app.UnitOfWork) {
		parent := equipBOMType(t, ctx, uow, "box")
		boxes := equipBOMType(t, ctx, uow, "box")
		frames := equipBOMType(t, ctx, uow, "frame")
		if err := appequipment.SetComponents(ctx, uow, parent, []appequipment.SetLine{
			{ComponentTypeID: boxes, Quantity: 1},
			{ComponentTypeID: frames, Quantity: 9},
		}); err != nil {
			t.Fatalf("set components: %v", err)
		}

		var parentItem uuid.UUID
		if err := uow.QueryRow(ctx, `SELECT item_id FROM equipment_types WHERE id=$1`, parent).Scan(&parentItem); err != nil {
			t.Fatal(err)
		}
		var boms, lines int
		if err := uow.QueryRow(ctx, `
			SELECT (SELECT COUNT(*) FROM inventory_boms WHERE output_item_id=$1),
			       (SELECT COUNT(*) FROM inventory_bom_lines l JOIN inventory_boms b ON b.id=l.bom_id
			        WHERE b.output_item_id=$1 AND l.role='input')`, parentItem).Scan(&boms, &lines); err != nil {
			t.Fatal(err)
		}
		if boms != 1 || lines != 2 {
			t.Fatalf("boms=%d lines=%d, want 1/2", boms, lines)
		}

		// Replacing the recipe replaces the rows rather than adding to them.
		if err := appequipment.SetComponents(ctx, uow, parent, []appequipment.SetLine{
			{ComponentTypeID: frames, Quantity: 10},
		}); err != nil {
			t.Fatalf("replace components: %v", err)
		}
		read, err := appequipment.Components(ctx, uow, parent)
		if err != nil {
			t.Fatal(err)
		}
		if len(read) != 1 || read[0].ComponentTypeID != frames || read[0].Quantity != 10 {
			t.Fatalf("after replace: %+v", read)
		}
		var mirrored int
		if err := uow.QueryRow(ctx, `SELECT COUNT(*) FROM equipment_type_components WHERE parent_type_id=$1`, parent).Scan(&mirrored); err != nil {
			t.Fatal(err)
		}
		if mirrored != 1 {
			t.Fatalf("legacy mirror holds %d lines, want 1", mirrored)
		}

		// An empty recipe deletes the BOM row, which is the state
		// app/backfill's NOT EXISTS guard expects for a type with no
		// components.
		if err := appequipment.SetComponents(ctx, uow, parent, nil); err != nil {
			t.Fatalf("clear components: %v", err)
		}
		if err := uow.QueryRow(ctx, `SELECT COUNT(*) FROM inventory_boms WHERE output_item_id=$1`, parentItem).Scan(&boms); err != nil {
			t.Fatal(err)
		}
		if boms != 0 {
			t.Fatalf("cleared recipe left %d BOM rows", boms)
		}
	})
}
