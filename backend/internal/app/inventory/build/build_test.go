package build

import (
	"testing"
	"time"

	"github.com/biker2000on/beez-trackz/backend/internal/app"
	"github.com/biker2000on/beez-trackz/backend/internal/app/inventory"
	"github.com/google/uuid"
)

func TestSingleSidedBuilders(t *testing.T) {
	tuple := inventory.Tuple{ItemID: uuid.New(), LocationID: uuid.New()}
	tests := []struct {
		name, kind, quantity string
		build                func(SingleParams) (inventory.Operation, error)
	}{
		{"receive", "receive", "2.5", Receive},
		{"opening", "opening_balance", "2.5", OpeningBalance},
		{"sale return", "sale_return", "2.5", SaleReturn},
		{"sale consume", "sale_consume", "-2.5", SaleConsume},
		{"shrink", "shrink", "-2.5", Shrink},
		{"count up", "count_adjust", "2.5", CountAdjust},
		{"count down", "count_adjust", "-2.5", CountAdjust},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			op, err := test.build(SingleParams{Base: testBase(), Line: inventory.Movement{Tuple: tuple, Quantity: test.quantity, QuantityScale: 1}})
			if err != nil {
				t.Fatal(err)
			}
			if op.Kind != test.kind || len(op.Lines) != 1 || op.Lines[0].Quantity != test.quantity {
				t.Fatalf("operation = %#v", op)
			}
		})
	}
}

func TestPairedBuilders(t *testing.T) {
	item, lot := uuid.New(), uuid.New()
	from := inventory.Tuple{ItemID: item, LocationID: uuid.New(), LotID: &lot}
	to := inventory.Tuple{ItemID: item, LocationID: uuid.New(), LotID: &lot}
	for _, test := range []struct {
		name, kind string
		build      func(TransferParams) (inventory.Operation, error)
	}{
		{"transfer", "transfer", Transfer}, {"deploy", "deploy", Deploy}, {"return", "return", Return},
	} {
		t.Run(test.name, func(t *testing.T) {
			op, err := test.build(TransferParams{Base: testBase(), From: from, To: to, Quantity: "3", QuantityScale: 0})
			if err != nil {
				t.Fatal(err)
			}
			if op.Kind != test.kind || op.Lines[0].Quantity != "-3" || op.Lines[1].Quantity != "3" {
				t.Fatalf("operation = %#v", op)
			}
		})
	}
}

func TestTransformsAndConditionChange(t *testing.T) {
	location := uuid.New()
	bulk, jars, packaging := uuid.New(), uuid.New(), uuid.New()
	p := TransformParams{Base: testBase(), Inputs: []inventory.Movement{
		{Tuple: inventory.Tuple{ItemID: bulk, LocationID: location}, Quantity: "-10", QuantityScale: 4},
		{Tuple: inventory.Tuple{ItemID: packaging, LocationID: location}, Quantity: "-12", QuantityScale: 0},
	}, Outputs: []inventory.Movement{{Tuple: inventory.Tuple{ItemID: jars, LocationID: location}, Quantity: "12", QuantityScale: 0}}}
	for _, fn := range []func(TransformParams) (inventory.Operation, error){Transform, BottlingTransform, BatchTransform, Assembly} {
		op, err := fn(p)
		if err != nil {
			t.Fatal(err)
		}
		if op.Kind != "transform" || len(op.Lines) != 3 {
			t.Fatalf("operation = %#v", op)
		}
	}
	tuple := inventory.Tuple{ItemID: uuid.New(), LocationID: location}
	op, err := ConditionChange(ConditionChangeParams{Base: testBase(), Tuple: tuple, FromCondition: "serviceable", ToCondition: "damaged", Quantity: "2", QuantityScale: 0})
	if err != nil {
		t.Fatal(err)
	}
	if *op.Lines[0].Tuple.Condition != "serviceable" || *op.Lines[1].Tuple.Condition != "damaged" {
		t.Fatalf("operation = %#v", op)
	}
}

func TestSaleConsumeOptionalContainerAndReversal(t *testing.T) {
	hive := uuid.New()
	line := inventory.Movement{Tuple: inventory.Tuple{ItemID: uuid.New(), LocationID: uuid.New(), ContainerHiveID: &hive}, Quantity: "-1", QuantityScale: 0}
	op, err := SaleConsume(SingleParams{Base: testBase(), Line: line})
	if err != nil {
		t.Fatal(err)
	}
	reverse, err := Reversal(testBase(), op)
	if err != nil {
		t.Fatal(err)
	}
	if reverse.ReversesOperationID == nil || *reverse.ReversesOperationID != op.ID || reverse.Lines[0].Quantity != "1" || reverse.Lines[0].Tuple.ContainerHiveID == nil {
		t.Fatalf("reversal = %#v", reverse)
	}
}

func TestBuildersRejectZeroScaleAndShapeViolations(t *testing.T) {
	tuple := inventory.Tuple{ItemID: uuid.New(), LocationID: uuid.New()}
	for _, quantity := range []string{"0", "1.1"} {
		_, err := Receive(SingleParams{Base: testBase(), Line: inventory.Movement{Tuple: tuple, Quantity: quantity, QuantityScale: 0}})
		if err == nil {
			t.Errorf("Receive quantity %s succeeded", quantity)
		}
	}
	_, err := Transform(TransformParams{Base: testBase(), Inputs: []inventory.Movement{{Tuple: tuple, Quantity: "-1", QuantityScale: 0}}})
	if err == nil {
		t.Error("input-only transform succeeded")
	}
}

func testBase() Base {
	return Base{ID: uuid.New(), OccurredAt: time.Date(2026, 9, 2, 12, 0, 0, 0, time.UTC), IdempotencyKey: uuid.NewString(), SourceType: "test", SourceID: uuid.New(), Reason: "none", Actor: app.SystemJobActor("inventory-test")}
}
