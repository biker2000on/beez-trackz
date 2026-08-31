package httpapi

import (
	"context"
	"errors"
	"net/http"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// Bill-of-materials integration tests, in the same rolled-back-transaction
// style as the ledger tests in routes_equipment_db_test.go.

func equipFixtureBOMLine(
	t *testing.T, ctx context.Context, tx pgx.Tx,
	parentTypeID, componentTypeID uuid.UUID, quantity int,
) {
	t.Helper()
	if _, err := tx.Exec(ctx, `
		INSERT INTO equipment_type_components (parent_type_id, component_type_id, quantity)
		VALUES ($1, $2, $3)`, parentTypeID, componentTypeID, quantity); err != nil {
		t.Fatalf("insert BOM line: %v", err)
	}
}

func equipSetUnitCost(
	t *testing.T, ctx context.Context, tx pgx.Tx, stockID uuid.UUID, cents int,
) {
	t.Helper()
	if _, err := tx.Exec(ctx,
		`UPDATE equipment_stock SET unit_cost_cents = $1 WHERE id = $2`,
		cents, stockID); err != nil {
		t.Fatalf("set unit cost: %v", err)
	}
}

// A honey super = 1 box + 9 frames. Assembling 3 consumes 3 boxes and 27
// frames, produces 3 supers, and prices each super at the sum of its parts.
func TestEquipmentAssembleConsumesComponents(t *testing.T) {
	ctx, tx := equipTx(t)
	superType := equipFixtureType(t, ctx, tx, "box")
	boxType := equipFixtureType(t, ctx, tx, "box")
	frameType := equipFixtureType(t, ctx, tx, "frame")
	equipFixtureBOMLine(t, ctx, tx, superType, boxType, 1)
	equipFixtureBOMLine(t, ctx, tx, superType, frameType, 9)
	boxStock := equipFixtureStock(t, ctx, tx, boxType, 5)
	frameStock := equipFixtureStock(t, ctx, tx, frameType, 50)
	equipSetUnitCost(t, ctx, tx, boxStock, 2000)
	equipSetUnitCost(t, ctx, tx, frameStock, 300)

	result, err := equipApplyAssembly(ctx, tx, equipAssemblyRequest{
		TypeID: superType, Quantity: 3, Action: "assemble", Date: time.Now(),
	})
	if err != nil {
		t.Fatalf("assemble: %v", err)
	}
	if result["quantity"] != 3 {
		t.Fatalf("expected quantity 3 in result, got %v", result["quantity"])
	}

	if box := equipReadState(t, ctx, tx, boxStock); box.Available() != 2 {
		t.Fatalf("box available = %d, want 2", box.Available())
	}
	if frame := equipReadState(t, ctx, tx, frameStock); frame.Available() != 23 {
		t.Fatalf("frame available = %d, want 23", frame.Available())
	}

	var superStock uuid.UUID
	if err := tx.QueryRow(ctx,
		`SELECT id FROM equipment_stock WHERE type_id = $1`, superType).
		Scan(&superStock); err != nil {
		t.Fatalf("assemble should have created the parent stock row: %v", err)
	}
	parent := equipReadState(t, ctx, tx, superStock)
	if parent.TotalOwned != 3 || parent.Available() != 3 {
		t.Fatalf("super owned/available = %d/%d, want 3/3",
			parent.TotalOwned, parent.Available())
	}
	// 1 × 2000 + 9 × 300 = 4700 per assembled super.
	if parent.UnitCostCents == nil || *parent.UnitCostCents != 4700 {
		t.Fatalf("super unit cost = %v, want 4700", parent.UnitCostCents)
	}
}

func TestEquipmentAssembleInsufficientComponents(t *testing.T) {
	ctx, tx := equipTx(t)
	superType := equipFixtureType(t, ctx, tx, "box")
	frameType := equipFixtureType(t, ctx, tx, "frame")
	equipFixtureBOMLine(t, ctx, tx, superType, frameType, 9)
	equipFixtureStock(t, ctx, tx, frameType, 8)

	_, err := equipApplyAssembly(ctx, tx, equipAssemblyRequest{
		TypeID: superType, Quantity: 1, Action: "assemble", Date: time.Now(),
	})
	var known equipError
	if !errors.As(err, &known) || known.status != http.StatusConflict {
		t.Fatalf("expected 409 conflict, got %v", err)
	}
}

func TestEquipmentDisassembleReturnsComponents(t *testing.T) {
	ctx, tx := equipTx(t)
	builtFrame := equipFixtureType(t, ctx, tx, "frame")
	bareFrame := equipFixtureType(t, ctx, tx, "frame")
	foundation := equipFixtureType(t, ctx, tx, "accessory")
	equipFixtureBOMLine(t, ctx, tx, builtFrame, bareFrame, 1)
	equipFixtureBOMLine(t, ctx, tx, builtFrame, foundation, 1)
	builtStock := equipFixtureStock(t, ctx, tx, builtFrame, 10)

	if _, err := equipApplyAssembly(ctx, tx, equipAssemblyRequest{
		TypeID: builtFrame, Quantity: 4, Action: "disassemble", Date: time.Now(),
	}); err != nil {
		t.Fatalf("disassemble: %v", err)
	}

	if parent := equipReadState(t, ctx, tx, builtStock); parent.Available() != 6 {
		t.Fatalf("built frame available = %d, want 6", parent.Available())
	}
	for _, componentType := range []uuid.UUID{bareFrame, foundation} {
		var stockID uuid.UUID
		if err := tx.QueryRow(ctx,
			`SELECT id FROM equipment_stock WHERE type_id = $1`, componentType).
			Scan(&stockID); err != nil {
			t.Fatalf("disassemble should have created component stock: %v", err)
		}
		if state := equipReadState(t, ctx, tx, stockID); state.Available() != 4 {
			t.Fatalf("component available = %d, want 4", state.Available())
		}
	}

	// More than is available must be refused.
	_, err := equipApplyAssembly(ctx, tx, equipAssemblyRequest{
		TypeID: builtFrame, Quantity: 7, Action: "disassemble", Date: time.Now(),
	})
	var known equipError
	if !errors.As(err, &known) || known.status != http.StatusConflict {
		t.Fatalf("expected 409 conflict, got %v", err)
	}
}

func TestEquipmentAssembleIdempotentReplay(t *testing.T) {
	ctx, tx := equipTx(t)
	superType := equipFixtureType(t, ctx, tx, "box")
	frameType := equipFixtureType(t, ctx, tx, "frame")
	equipFixtureBOMLine(t, ctx, tx, superType, frameType, 9)
	frameStock := equipFixtureStock(t, ctx, tx, frameType, 20)

	key := "assemble-" + uuid.NewString()
	req := equipAssemblyRequest{
		TypeID: superType, Quantity: 2, Action: "assemble",
		Date: time.Now(), IdempotencyKey: &key,
	}
	if _, err := equipApplyAssembly(ctx, tx, req); err != nil {
		t.Fatalf("first assemble: %v", err)
	}
	result, err := equipApplyAssembly(ctx, tx, req)
	if err != nil {
		t.Fatalf("replayed assemble: %v", err)
	}
	if result["replayed"] != true {
		t.Fatalf("expected replay marker, got %v", result)
	}
	if frame := equipReadState(t, ctx, tx, frameStock); frame.Available() != 2 {
		t.Fatalf("frame available = %d after replay, want 2 (no double spend)",
			frame.Available())
	}
}

// The database trigger refuses a BOM line that would let a type contain
// itself, directly or through another type.
func TestEquipmentComponentCycleGuard(t *testing.T) {
	ctx, tx := equipTx(t)
	a := equipFixtureType(t, ctx, tx, "box")
	b := equipFixtureType(t, ctx, tx, "frame")
	c := equipFixtureType(t, ctx, tx, "accessory")
	equipFixtureBOMLine(t, ctx, tx, a, b, 1)
	equipFixtureBOMLine(t, ctx, tx, b, c, 1)

	_, err := tx.Exec(ctx, `
		INSERT INTO equipment_type_components (parent_type_id, component_type_id, quantity)
		VALUES ($1, $2, 1)`, c, a)
	if !equipPgErrCode(err, "23514") {
		t.Fatalf("expected 23514 cycle rejection, got %v", err)
	}
}
