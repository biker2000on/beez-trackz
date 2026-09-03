package production

import (
	"context"
	"fmt"
	"sort"
	"time"

	"github.com/biker2000on/beez-trackz/backend/internal/app"
	"github.com/biker2000on/beez-trackz/backend/internal/app/inventory"
	"github.com/biker2000on/beez-trackz/backend/internal/app/inventory/build"
	"github.com/google/uuid"
)

// ConditionServiceable is the only condition a producer in this package ever
// writes. Damage and retirement are app/equipment's condition_change.
const ConditionServiceable = "serviceable"

// BottlingInput is one bottling run: pounds out of a harvest lot, jars into
// the jar-size item under that lot's code, and the empties the run used up.
type BottlingInput struct {
	RunID        uuid.UUID
	HarvestLotID uuid.UUID
	JarSizeID    uuid.UUID
	Quantity     int
	HoneyLbs     float64
	Date         time.Time
	// PackagingTypes maps an equipment type id to the number of empties the
	// run consumed. It comes from the jar size's packaging BOM.
	PackagingTypes map[uuid.UUID]int
	Notes          *string
}

// BottlingResult reports the operation and any empties the run ran short of.
type BottlingResult struct {
	OperationID uuid.UUID
	// PackagingWarnings names each packaging type the run outran. Short
	// packaging is reported, never refused: the jars were really filled, and
	// bookkeeping must not block work that already happened. Only the stock
	// that existed is consumed, so the ledger stays nonnegative.
	PackagingWarnings []string
}

// RecordBottling writes the transform for one bottling run: bulk honey and
// packaging in, jars out (spec 6.1). The caller owns the bottling_runs row
// and its serials; this command owns the quantities.
func (s *Service) RecordBottling(
	ctx context.Context, uow *app.UnitOfWork, input BottlingInput, guards ...Guard,
) (BottlingResult, error) {
	const op = "record bottling run"
	var result BottlingResult
	if input.RunID == uuid.Nil || input.HarvestLotID == uuid.Nil || input.JarSizeID == uuid.Nil {
		return result, app.Invalid(op, "run, harvest lot, and jar size are required")
	}
	if input.Quantity <= 0 {
		return result, app.Invalid(op, "quantity must be greater than zero")
	}
	if input.HoneyLbs < 0 {
		return result, app.Invalid(op, "honey pounds must not be negative")
	}
	if err := runGuards(ctx, uow, guards); err != nil {
		return result, err
	}

	home, err := HomeLocationID(ctx, uow)
	if err != nil {
		return result, err
	}
	bulkLot, err := EnsureHarvestLot(ctx, uow, input.HarvestLotID)
	if err != nil {
		return result, err
	}
	jarItem, err := EnsureJarItem(ctx, uow, input.JarSizeID)
	if err != nil {
		return result, err
	}
	jarLot, err := EnsureJarLotForHarvestLot(ctx, uow, jarItem, input.HarvestLotID)
	if err != nil {
		return result, err
	}

	inputs := make([]inventory.Movement, 0, 1+len(input.PackagingTypes))
	if input.HoneyLbs > 0 {
		inputs = append(inputs, inventory.Movement{
			Tuple:         inventory.Tuple{ItemID: HoneyBulkItemID, LocationID: home, LotID: &bulkLot},
			Quantity:      Negate(Pounds(input.HoneyLbs)),
			QuantityScale: MassScale,
		})
	}
	packaging, warnings, err := s.packagingDraws(ctx, uow, home, input.PackagingTypes)
	if err != nil {
		return result, err
	}
	result.PackagingWarnings = warnings
	inputs = append(inputs, packaging...)

	outputs := []inventory.Movement{{
		Tuple:         inventory.Tuple{ItemID: jarItem, LocationID: home, LotID: &jarLot},
		Quantity:      Quantity(input.Quantity),
		QuantityScale: CountScale,
	}}

	attempt, err := attemptFor(ctx, uow, "bottling_run", input.RunID, "bottle")
	if err != nil {
		return result, err
	}
	base := baseFor(uow, "bottling_run", input.RunID, "bottle", attempt, "none",
		input.Date, map[string]any{"lot_allocation": map[string]any{"method": MethodRecorded}})

	var operation inventory.Operation
	if len(inputs) == 0 {
		// A jar size with no honey weight and no packaging attributes nothing
		// to consume; the jars still have to enter inventory, so the run is a
		// plain receipt rather than a transform with no input.
		operation, err = build.Receive(build.SingleParams{Base: base, Line: outputs[0]})
	} else {
		operation, err = build.BottlingTransform(build.TransformParams{
			Base: base, Inputs: inputs, Outputs: outputs,
		})
	}
	if err != nil {
		return result, app.Invalid(op, "%v", err)
	}
	recorded, err := s.inventory.Record(ctx, uow, operation)
	if err != nil {
		return result, err
	}
	result.OperationID = recorded.Operation.ID
	return result, nil
}

// VoidBottling reverses a run's transform. Unlinking serials and marking the
// run voided stay with the caller, in the same unit of work (spec 5.3).
// The reversal takes the jars back off the shelf, so it is refused by the
// nonnegative invariant once they have been drawn down.
func (s *Service) VoidBottling(
	ctx context.Context, uow *app.UnitOfWork, runID uuid.UUID, reason string, guards ...Guard,
) (int, error) {
	if err := runGuards(ctx, uow, guards); err != nil {
		return 0, err
	}
	operations, err := liveOperations(ctx, uow, "bottling_run", runID)
	if err != nil {
		return 0, err
	}
	for _, id := range operations {
		if _, err := s.inventory.Reverse(ctx, uow, id, id.String()+":void", "none"); err != nil {
			return 0, err
		}
	}
	return len(operations), nil
}

// packagingDraws turns the jar size's packaging BOM into negative lines,
// clamped to what is actually on the shelf.
func (s *Service) packagingDraws(
	ctx context.Context, uow *app.UnitOfWork, home uuid.UUID, needed map[uuid.UUID]int,
) ([]inventory.Movement, []string, error) {
	warnings := make([]string, 0)
	if len(needed) == 0 {
		return nil, warnings, nil
	}
	typeIDs := make([]uuid.UUID, 0, len(needed))
	for id := range needed {
		typeIDs = append(typeIDs, id)
	}
	sort.Slice(typeIDs, func(i, j int) bool { return typeIDs[i].String() < typeIDs[j].String() })

	lines := make([]inventory.Movement, 0, len(typeIDs))
	condition := ConditionServiceable
	for _, typeID := range typeIDs {
		itemID, err := EnsureEquipmentItem(ctx, uow, typeID)
		if err != nil {
			return nil, nil, err
		}
		var name string
		var onHand int
		if err := uow.QueryRow(ctx, `
			SELECT i.name,
			       COALESCE((SELECT b.on_hand FROM inventory_balances b
			                 WHERE b.item_id=i.id AND b.location_id=$2
			                   AND b.lot_id IS NULL AND b.condition=$3
			                   AND b.container_hive_id IS NULL), 0)::int
			FROM inventory_items i WHERE i.id=$1`, itemID, home, condition).
			Scan(&name, &onHand); err != nil {
			return nil, nil, wrapDB("read packaging balance", err)
		}
		want := needed[typeID]
		take := want
		if take > onHand {
			take = onHand
			warnings = append(warnings, fmt.Sprintf(
				"%s: filled %d but only %d were on hand", name, want, max(onHand, 0)))
		}
		if take <= 0 {
			continue
		}
		lines = append(lines, inventory.Movement{
			Tuple: inventory.Tuple{
				ItemID: itemID, LocationID: home, Condition: &condition,
			},
			Quantity:      Negate(Quantity(take)),
			QuantityScale: CountScale,
		})
	}
	return lines, warnings, nil
}
