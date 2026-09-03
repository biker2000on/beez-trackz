package production

import (
	"context"
	"time"

	"github.com/biker2000on/beez-trackz/backend/internal/app"
	"github.com/biker2000on/beez-trackz/backend/internal/app/inventory"
	"github.com/biker2000on/beez-trackz/backend/internal/app/inventory/build"
	"github.com/google/uuid"
)

// BatchInput is one product batch: honey or propolis in, finished units out.
type BatchInput struct {
	BatchID   uuid.UUID
	ProductID uuid.UUID
	// HarvestLotID names the honey the batch drew. Nil on a honey-consuming
	// batch means the pounds cannot be traced, so they come out of the
	// legacy-unassigned lot and the allocation is marked inferred.
	HarvestLotID *uuid.UUID
	HoneyLbs     float64
	// PropolisHarvestID and PropolisGrams describe a tincture's input.
	PropolisHarvestID *uuid.UUID
	PropolisGrams     float64
	QuantityOut       int
	Date              time.Time
	Notes             *string
}

// RecordBatch writes the transform for a product batch (spec 6.2): the honey
// or propolis it consumed, and the finished units it produced into the
// batch's own lot.
func (s *Service) RecordBatch(
	ctx context.Context, uow *app.UnitOfWork, input BatchInput, guards ...Guard,
) (uuid.UUID, error) {
	const op = "record product batch"
	if input.BatchID == uuid.Nil || input.ProductID == uuid.Nil {
		return uuid.Nil, app.Invalid(op, "batch and product are required")
	}
	if input.QuantityOut <= 0 {
		return uuid.Nil, app.Invalid(op, "quantityOut must be greater than zero")
	}
	if err := runGuards(ctx, uow, guards); err != nil {
		return uuid.Nil, err
	}
	home, err := HomeLocationID(ctx, uow)
	if err != nil {
		return uuid.Nil, err
	}
	productItem, err := EnsureProductItem(ctx, uow, input.ProductID)
	if err != nil {
		return uuid.Nil, err
	}
	batchLot, err := EnsureBatchLot(ctx, uow, productItem, input.BatchID)
	if err != nil {
		return uuid.Nil, err
	}

	inferred := false
	inputs := make([]inventory.Movement, 0, 2)
	if input.HoneyLbs > 0 {
		var lotID uuid.UUID
		if input.HarvestLotID != nil {
			lotID, err = EnsureHarvestLot(ctx, uow, *input.HarvestLotID)
		} else {
			inferred = true
			lotID, err = LegacyUnassignedLot(ctx, uow, HoneyBulkItemID)
		}
		if err != nil {
			return uuid.Nil, err
		}
		inputs = append(inputs, inventory.Movement{
			Tuple:         inventory.Tuple{ItemID: HoneyBulkItemID, LocationID: home, LotID: &lotID},
			Quantity:      Negate(Pounds(input.HoneyLbs)),
			QuantityScale: MassScale,
		})
	}
	if input.PropolisGrams > 0 && input.PropolisHarvestID != nil {
		lotID, err := EnsurePropolisLot(ctx, uow, *input.PropolisHarvestID)
		if err != nil {
			return uuid.Nil, err
		}
		inputs = append(inputs, inventory.Movement{
			Tuple:         inventory.Tuple{ItemID: PropolisItemID, LocationID: home, LotID: &lotID},
			Quantity:      Negate(Pounds(input.PropolisGrams)),
			QuantityScale: MassScale,
		})
	}
	output := inventory.Movement{
		Tuple:         inventory.Tuple{ItemID: productItem, LocationID: home, LotID: &batchLot},
		Quantity:      Quantity(input.QuantityOut),
		QuantityScale: CountScale,
	}

	details := detailNotes(input.Notes)
	details["lot_allocation"] = map[string]any{"method": allocationMethod(inferred)}
	attempt, err := attemptFor(ctx, uow, "product_batch", input.BatchID, "make")
	if err != nil {
		return uuid.Nil, err
	}
	base := baseFor(uow, "product_batch", input.BatchID, "make", attempt, ReasonNone, input.Date, details)

	var operation inventory.Operation
	if len(inputs) == 0 {
		// A batch that consumed nothing the ledger tracks still produces
		// units; recording it as a receipt keeps the transform contract
		// (at least one input) honest instead of faking an input line.
		operation, err = build.Receive(build.SingleParams{Base: base, Line: output})
	} else {
		operation, err = build.BatchTransform(build.TransformParams{
			Base: base, Inputs: inputs, Outputs: []inventory.Movement{output},
		})
	}
	if err != nil {
		return uuid.Nil, app.Invalid(op, "%v", err)
	}
	recorded, err := s.inventory.Record(ctx, uow, operation)
	if err != nil {
		return uuid.Nil, err
	}
	return recorded.Operation.ID, nil
}

// VoidBatch reverses a batch's transform. Marking the row voided stays with
// the caller. The reversal un-makes the batch's output, so it is refused once
// those units have been drawn down — the same rule the old handler enforced
// by comparing home on-hand to quantity_out, now enforced by the ledger.
func (s *Service) VoidBatch(
	ctx context.Context, uow *app.UnitOfWork, batchID uuid.UUID, guards ...Guard,
) (int, error) {
	if err := runGuards(ctx, uow, guards); err != nil {
		return 0, err
	}
	operations, err := liveOperations(ctx, uow, "product_batch", batchID)
	if err != nil {
		return 0, err
	}
	for _, id := range operations {
		if _, err := s.inventory.Reverse(ctx, uow, id, id.String()+":void", ReasonNone); err != nil {
			return 0, err
		}
	}
	return len(operations), nil
}

// ProductAdjustInput is a signed correction to one catalog SKU's count.
type ProductAdjustInput struct {
	ProductID uuid.UUID
	// LocationID is the inventory location the correction applies to; the
	// caller resolves home or a consignee.
	LocationID uuid.UUID
	Delta      int
	// Reason must be a registry reason: "count" for an operator correction,
	// "settlement_shrink" for the half a consignment report writes.
	Reason       string
	SourceType   string
	SourceID     uuid.UUID
	Command      string
	Date         time.Time
	Notes        *string
	SettlementID *uuid.UUID
}

// AdjustProductCount records a count_adjust (or the settlement's shrink) for
// one catalog SKU. Stock found lands in the legacy-unassigned lot; stock lost
// is allocated oldest lot first.
func (s *Service) AdjustProductCount(
	ctx context.Context, uow *app.UnitOfWork, input ProductAdjustInput, guards ...Guard,
) (uuid.UUID, error) {
	const op = "adjust product count"
	if input.Delta == 0 {
		return uuid.Nil, app.Invalid(op, "delta must not be zero")
	}
	if err := runGuards(ctx, uow, guards); err != nil {
		return uuid.Nil, err
	}
	itemID, err := EnsureProductItem(ctx, uow, input.ProductID)
	if err != nil {
		return uuid.Nil, err
	}
	location := input.LocationID
	if location == uuid.Nil {
		if location, err = HomeLocationID(ctx, uow); err != nil {
			return uuid.Nil, err
		}
	}
	movements := make([]inventory.Movement, 0, 2)
	inferred := false
	if input.Delta > 0 {
		lotID, err := LegacyUnassignedLot(ctx, uow, itemID)
		if err != nil {
			return uuid.Nil, err
		}
		inferred = true
		movements = append(movements, inventory.Movement{
			Tuple:         inventory.Tuple{ItemID: itemID, LocationID: location, LotID: &lotID},
			Quantity:      Quantity(input.Delta),
			QuantityScale: CountScale,
		})
	} else {
		allocations, method, err := AllocateFIFO(ctx, uow, "inventory_balances",
			itemID, location, -input.Delta, nil)
		if err != nil {
			return uuid.Nil, err
		}
		inferred = method == MethodFIFOInferred
		for _, allocation := range allocations {
			lotID := allocation.LotID
			movements = append(movements, inventory.Movement{
				Tuple:         inventory.Tuple{ItemID: itemID, LocationID: location, LotID: &lotID},
				Quantity:      Negate(Quantity(allocation.Quantity)),
				QuantityScale: CountScale,
			})
		}
	}

	sourceType, sourceID := input.SourceType, input.SourceID
	operationID := uuid.New()
	if sourceType == "" {
		sourceType, sourceID = "product_adjustment", operationID
	}
	command := input.Command
	if command == "" {
		command = "adjust"
	}
	attempt, err := attemptFor(ctx, uow, sourceType, sourceID, command)
	if err != nil {
		return uuid.Nil, err
	}
	details := detailNotes(input.Notes)
	details["lot_allocation"] = map[string]any{"method": allocationMethod(inferred)}
	if input.SettlementID != nil {
		details["settlement_id"] = input.SettlementID.String()
	}
	reason := input.Reason
	if reason == "" {
		reason = ReasonCount
	}
	base := baseFor(uow, sourceType, sourceID, command, attempt, reason, input.Date, details)
	base.ID = operationID

	var operation inventory.Operation
	if reason == ReasonSettled {
		operation, err = build.Shrink(build.SingleParams{Base: base, Line: movements[0]})
	} else {
		operation, err = build.CountAdjust(build.SingleParams{Base: base, Line: movements[0]})
	}
	if err != nil {
		return uuid.Nil, app.Invalid(op, "%v", err)
	}
	operation.Lines = movements
	recorded, err := s.inventory.Record(ctx, uow, operation)
	if err != nil {
		return uuid.Nil, err
	}
	return recorded.Operation.ID, nil
}

// ReceivePropolis records a propolis harvest as a receipt into its own lot
// (spec 6.2). Grams are the canonical unit; ounces are converted by the
// caller so the ledger never carries two units for one item.
func (s *Service) ReceivePropolis(
	ctx context.Context, uow *app.UnitOfWork, harvestID uuid.UUID, grams float64, date time.Time,
) (uuid.UUID, error) {
	const op = "receive propolis"
	if grams <= 0 {
		return uuid.Nil, app.Invalid(op, "amount must be greater than zero")
	}
	home, err := HomeLocationID(ctx, uow)
	if err != nil {
		return uuid.Nil, err
	}
	lotID, err := EnsurePropolisLot(ctx, uow, harvestID)
	if err != nil {
		return uuid.Nil, err
	}
	attempt, err := attemptFor(ctx, uow, "propolis_harvest", harvestID, "receive")
	if err != nil {
		return uuid.Nil, err
	}
	base := baseFor(uow, "propolis_harvest", harvestID, "receive", attempt, ReasonNone, date, nil)
	operation, err := build.Receive(build.SingleParams{
		Base: base,
		Line: inventory.Movement{
			Tuple:         inventory.Tuple{ItemID: PropolisItemID, LocationID: home, LotID: &lotID},
			Quantity:      Pounds(grams),
			QuantityScale: MassScale,
		},
	})
	if err != nil {
		return uuid.Nil, app.Invalid(op, "%v", err)
	}
	recorded, err := s.inventory.Record(ctx, uow, operation)
	if err != nil {
		return uuid.Nil, err
	}
	return recorded.Operation.ID, nil
}

// ReleasePropolis reverses a propolis receipt, which is what deleting the
// harvest means for the ledger.
func (s *Service) ReleasePropolis(
	ctx context.Context, uow *app.UnitOfWork, harvestID uuid.UUID,
) error {
	operations, err := liveOperations(ctx, uow, "propolis_harvest", harvestID)
	if err != nil {
		return err
	}
	for _, id := range operations {
		if _, err := s.inventory.Reverse(ctx, uow, id, id.String()+":deleted", ReasonNone); err != nil {
			return err
		}
	}
	return nil
}
