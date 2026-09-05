package sales

import (
	"context"
	"time"

	"github.com/biker2000on/beez-trackz/backend/internal/app"
	"github.com/biker2000on/beez-trackz/backend/internal/app/inventory"
	"github.com/biker2000on/beez-trackz/backend/internal/app/inventory/build"
	"github.com/biker2000on/beez-trackz/backend/internal/app/production"
	"github.com/google/uuid"
)

// TransferLine is one SKU moving between two locations.
type TransferLine struct {
	ItemID uuid.UUID
	// LotID pins the move to one lot; nil takes the source's oldest receipts.
	LotID    *uuid.UUID
	Quantity int
}

// TransferInput is a consignment shipment or a return.
type TransferInput struct {
	// TransferID is the domain identity the two halves share, and the source
	// of the operation's idempotency key.
	TransferID uuid.UUID
	SourceType string
	// Returning marks the move as stock coming back from a consignee, which
	// the ledger records as a `return` rather than a `transfer` so a
	// settlement statement can tell the two apart.
	Returning bool
	From, To  uuid.UUID
	Date      time.Time
	Lines     []TransferLine
	Reason    *string
	Notes     *string
}

// Transfer moves finished goods between two inventory locations, lot by lot
// (spec 6.3). No revenue and no COGS: a transfer is stock changing shelves.
//
// The pair nets to zero per (item, lot, condition, container), which is what
// makes "home is never a residual of a second ledger" true — each location's
// balance is its own movements and nothing else.
func (s *Service) Transfer(
	ctx context.Context, uow *app.UnitOfWork, input TransferInput,
) (uuid.UUID, error) {
	const op = "transfer stock"
	if input.From == input.To {
		return uuid.Nil, app.Invalid(op, "a transfer needs two different locations")
	}
	if len(input.Lines) == 0 {
		return uuid.Nil, app.Invalid(op, "add at least one line")
	}
	movements := make([]inventory.Movement, 0, len(input.Lines)*2)
	inferred := false
	for _, line := range input.Lines {
		if line.Quantity <= 0 {
			return uuid.Nil, app.Invalid(op, "quantity must be greater than zero")
		}
		allocations, err := allocateLine(ctx, uow, line.ItemID, input.From, line.Quantity, line.LotID)
		if err != nil {
			return uuid.Nil, err
		}
		if line.LotID == nil {
			inferred = true
		}
		for _, allocation := range allocations {
			lotID := allocation.LotID
			from := inventory.Tuple{ItemID: line.ItemID, LocationID: input.From, LotID: &lotID}
			to := inventory.Tuple{ItemID: line.ItemID, LocationID: input.To, LotID: &lotID}
			movements = append(movements,
				inventory.Movement{
					Tuple:         from,
					Quantity:      production.Negate(production.Quantity(allocation.Quantity)),
					QuantityScale: production.CountScale,
				},
				inventory.Movement{
					Tuple:         to,
					Quantity:      production.Quantity(allocation.Quantity),
					QuantityScale: production.CountScale,
				})
		}
	}

	sourceType := input.SourceType
	if sourceType == "" {
		sourceType = "stock_transfer"
	}
	attempt, err := production.AttemptFor(ctx, uow, sourceType, input.TransferID, "transfer")
	if err != nil {
		return uuid.Nil, err
	}
	details := production.DetailNotes(input.Notes)
	if input.Reason != nil && *input.Reason != "" {
		details["reason_text"] = *input.Reason
	}
	details["lot_allocation"] = map[string]any{"method": production.AllocationMethod(inferred)}
	base := production.OperationBase(uow, sourceType, input.TransferID, "transfer", attempt,
		production.ReasonNone, input.Date, details)

	// Transfer is a paired shape; the builder validates one pair, and the rest
	// are checked against the same identity rule before being attached.
	pair := build.Transfer
	if input.Returning {
		pair = build.Return
	}
	operation, err := pair(build.TransferParams{
		Base: base, From: movements[0].Tuple, To: movements[1].Tuple,
		Quantity:      trimSign(movements[0].Quantity),
		QuantityScale: production.CountScale,
	})
	if err != nil {
		return uuid.Nil, app.Invalid(op, "%v", err)
	}
	for i := 2; i < len(movements); i += 2 {
		if _, err := pair(build.TransferParams{
			Base: base, From: movements[i].Tuple, To: movements[i+1].Tuple,
			Quantity:      trimSign(movements[i].Quantity),
			QuantityScale: production.CountScale,
		}); err != nil {
			return uuid.Nil, app.Invalid(op, "%v", err)
		}
	}
	operation.Lines = movements
	recorded, err := s.inventory.Record(ctx, uow, operation)
	if err != nil {
		return uuid.Nil, err
	}
	return recorded.Operation.ID, nil
}

// allocateLine chooses the lots one consignment line moves. A pinned lot is
// honoured exactly (production.AllocateLot); a line with no lot takes the
// location's oldest receipts first.
func allocateLine(
	ctx context.Context, uow *app.UnitOfWork,
	itemID, locationID uuid.UUID, quantity int, lotID *uuid.UUID,
) ([]production.Allocation, error) {
	if lotID != nil {
		return production.AllocateLot(ctx, uow, "inventory_balances",
			itemID, locationID, quantity, *lotID)
	}
	allocations, _, err := production.AllocateFIFO(ctx, uow, "inventory_balances",
		itemID, locationID, quantity, nil)
	return allocations, err
}

// SettlementShrinkInput is the difference between what the operator thinks is
// on a consignee's shelf and what the shop counted.
type SettlementShrinkInput struct {
	SettlementID uuid.UUID
	LocationID   uuid.UUID
	ItemID       uuid.UUID
	// LotID pins the shrink (or the found stock) to one lot; nil takes the
	// oldest receipts for a loss and the legacy-unassigned lot for a find.
	LotID *uuid.UUID
	// Quantity is positive for stock that has gone missing and negative for
	// stock the shop found.
	Quantity int
	Date     time.Time
	Reason   *string
	Index    int
}

// RecordSettlementShrink writes the shrink a consignment report discovered
// (spec 6.3). Only one half is written now: the consignee's shelf IS the
// stock, so there is no global counterpart to keep in step.
func (s *Service) RecordSettlementShrink(
	ctx context.Context, uow *app.UnitOfWork, input SettlementShrinkInput,
) (uuid.UUID, error) {
	const op = "record settlement shrink"
	if input.Quantity == 0 {
		return uuid.Nil, nil
	}
	details := map[string]any{}
	if input.Reason != nil && *input.Reason != "" {
		details["reason_text"] = *input.Reason
	}
	command := "shrink"
	reason := production.ReasonSettled
	if input.Quantity < 0 {
		command = "found"
		reason = production.ReasonCount
	}
	attempt, err := production.AttemptFor(ctx, uow, "consignment_settlement", input.SettlementID, command)
	if err != nil {
		return uuid.Nil, err
	}
	base := production.OperationBase(uow, "consignment_settlement", input.SettlementID,
		command, attempt, reason, input.Date, details)

	var movements []inventory.Movement
	if input.Quantity > 0 {
		allocations, err := allocateLine(ctx, uow, input.ItemID, input.LocationID, input.Quantity, input.LotID)
		if err != nil {
			return uuid.Nil, err
		}
		details["lot_allocation"] = map[string]any{"method": production.AllocationMethod(input.LotID == nil)}
		for _, allocation := range allocations {
			lotID := allocation.LotID
			movements = append(movements, inventory.Movement{
				Tuple: inventory.Tuple{
					ItemID: input.ItemID, LocationID: input.LocationID, LotID: &lotID,
				},
				Quantity:      production.Negate(production.Quantity(allocation.Quantity)),
				QuantityScale: production.CountScale,
			})
		}
	} else {
		var lotID uuid.UUID
		if input.LotID != nil {
			lotID = *input.LotID
		} else if lotID, err = production.LegacyUnassignedLot(ctx, uow, input.ItemID); err != nil {
			return uuid.Nil, err
		}
		details["lot_allocation"] = map[string]any{"method": production.AllocationMethod(input.LotID == nil)}
		movements = append(movements, inventory.Movement{
			Tuple: inventory.Tuple{
				ItemID: input.ItemID, LocationID: input.LocationID, LotID: &lotID,
			},
			Quantity:      production.Quantity(-input.Quantity),
			QuantityScale: production.CountScale,
		})
	}

	var operation inventory.Operation
	if input.Quantity > 0 {
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

// ReverseSource reverses every live operation one domain record produced. It
// is the undo path for a transfer, a settlement, and a voided report.
func (s *Service) ReverseSource(
	ctx context.Context, uow *app.UnitOfWork, sourceType string, sourceID uuid.UUID,
) (int, error) {
	operations, err := production.LiveOperations(ctx, uow, sourceType, sourceID)
	if err != nil {
		return 0, err
	}
	for i := len(operations) - 1; i >= 0; i-- {
		id := operations[i]
		if _, err := s.inventory.Reverse(ctx, uow, id, id.String()+":reversed",
			production.ReasonNone); err != nil {
			return 0, err
		}
	}
	return len(operations), nil
}
