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

func equipBOMLine(t *testing.T, ctx context.Context, uow *app.UnitOfWork, parent, component uuid.UUID, quantity int) {
	t.Helper()
	if _, err := uow.Exec(ctx, `INSERT INTO equipment_type_components(parent_type_id,component_type_id,quantity) VALUES($1,$2,$3)`, parent, component, quantity); err != nil {
		t.Fatalf("insert BOM line: %v", err)
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
