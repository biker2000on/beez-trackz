package production

import (
	"context"
	"time"

	"github.com/biker2000on/beez-trackz/backend/internal/app"
	"github.com/biker2000on/beez-trackz/backend/internal/app/inventory"
	"github.com/biker2000on/beez-trackz/backend/internal/app/inventory/build"
	"github.com/google/uuid"
)

// Reasons this package writes. Each is a row in inventory_operation_reasons,
// so reports group on a real column rather than on a free-text string.
const (
	ReasonNone      = "none"
	ReasonLoss      = "loss"
	ReasonFeeding   = "feeding"
	ReasonGiveAway  = "give_away"
	ReasonCount     = "count"
	ReasonSettled   = "settlement_shrink"
	ReasonPackaging = "packaging_consumed_untraced"
)

// BulkDrawInput is a draw of bulk honey out of one lot that produces nothing:
// feeding it back to the bees, a spill, a jar dropped on the floor.
type BulkDrawInput struct {
	HarvestLotID uuid.UUID
	AmountLbs    float64
	// Reason is a registry reason: "loss" for a loss, "feeding" or "none" for
	// an ordinary bulk use.
	Reason string
	Date   time.Time
	Notes  *string
}

// RecordBulkDraw writes the shrink for a bulk use or loss (spec 6.1). The
// lot's remaining pounds are the ledger's business; a draw larger than the
// lot holds is refused by the nonnegative invariant with the tuple named.
func (s *Service) RecordBulkDraw(
	ctx context.Context, uow *app.UnitOfWork, input BulkDrawInput, guards ...Guard,
) (uuid.UUID, error) {
	const op = "record bulk honey draw"
	if input.HarvestLotID == uuid.Nil {
		return uuid.Nil, app.Invalid(op, "a harvest lot is required")
	}
	if input.AmountLbs <= 0 {
		return uuid.Nil, app.Invalid(op, "amount must be greater than zero")
	}
	if err := runGuards(ctx, uow, guards); err != nil {
		return uuid.Nil, err
	}
	home, err := HomeLocationID(ctx, uow)
	if err != nil {
		return uuid.Nil, err
	}
	lotID, err := EnsureHarvestLot(ctx, uow, input.HarvestLotID)
	if err != nil {
		return uuid.Nil, err
	}
	reason := input.Reason
	if reason == "" {
		reason = ReasonNone
	}
	operationID := uuid.New()
	base := baseFor(uow, "honey_draw", operationID, "draw", 1, reason, input.Date, detailNotes(input.Notes))
	base.ID = operationID
	operation, err := build.Shrink(build.SingleParams{
		Base: base,
		Line: inventory.Movement{
			Tuple:         inventory.Tuple{ItemID: HoneyBulkItemID, LocationID: home, LotID: &lotID},
			Quantity:      Negate(Pounds(input.AmountLbs)),
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

// ErrGiveAwayNeedsLot is the refusal for a give-away line that names no lot.
const ErrGiveAwayNeedsLot = "every jar line needs a varietal / lot: choose the harvest lot the jars come off"

// JarLine is one jar size and a whole number of jars.
type JarLine struct {
	JarSizeID uuid.UUID
	Quantity  int
	// HarvestLotID pins a withdrawal to that harvest lot's jars (one
	// varietal). A pinned lot that is short is refused, never topped up from
	// another lot. Nil allocates oldest receipt first.
	HarvestLotID *uuid.UUID
}

// RecordGiveAway takes jars off the home shelf with reason give_away
// (spec 6.1). Every line names the harvest lot (varietal) the jars come off
// and draws from that lot only, so a gift is as traceable as a sale: there is
// no "some quarts, whichever" give-away.
func (s *Service) RecordGiveAway(
	ctx context.Context, uow *app.UnitOfWork, lines []JarLine, date time.Time,
	notes *string, guards ...Guard,
) (uuid.UUID, error) {
	return s.RecordGiveAwayFor(ctx, uow, GiveAwayInput{Lines: lines, Date: date, Notes: notes}, guards...)
}

// Give-away purposes. Both are the same zero-revenue outflow — a shrink with
// reason give_away, so every stock and "given away" total counts them alike —
// and the purpose rides in the operation's details so the sales register can
// tell a gift from jars the beekeeper kept for themselves. A details key, not
// a new registry reason: a new reason would drop own-use jars out of every
// read that filters on reason='give_away', and would need a migration.
const (
	GiveAwayPurposeGift   = "gift"
	GiveAwayPurposeOwnUse = "own_use"
)

// ValidGiveAwayPurpose reports whether purpose is one RecordGiveAwayFor
// accepts ("" means gift).
func ValidGiveAwayPurpose(purpose string) bool {
	return purpose == "" || purpose == GiveAwayPurposeGift || purpose == GiveAwayPurposeOwnUse
}

// GiveAwayInput is a give-away with its purpose and recipient.
type GiveAwayInput struct {
	Lines []JarLine
	Date  time.Time
	Notes *string
	// Purpose is GiveAwayPurposeGift (the default) or GiveAwayPurposeOwnUse.
	Purpose string
	// Recipient is who the jars went to, or why ("neighbors", "samples").
	Recipient *string
}

// RecordGiveAwayFor is RecordGiveAway with a purpose and a recipient, both
// kept in the operation's details (details.purpose, details.recipient).
func (s *Service) RecordGiveAwayFor(
	ctx context.Context, uow *app.UnitOfWork, input GiveAwayInput, guards ...Guard,
) (uuid.UUID, error) {
	const op = "record give-away"
	for _, line := range input.Lines {
		if line.Quantity > 0 && (line.HarvestLotID == nil || *line.HarvestLotID == uuid.Nil) {
			return uuid.Nil, app.Invalid(op, "%s", ErrGiveAwayNeedsLot)
		}
	}
	if !ValidGiveAwayPurpose(input.Purpose) {
		return uuid.Nil, app.Invalid(op, "purpose must be gift or own_use")
	}
	purpose := input.Purpose
	if purpose == "" {
		purpose = GiveAwayPurposeGift
	}
	extra := map[string]any{"purpose": purpose}
	if input.Recipient != nil && *input.Recipient != "" {
		extra["recipient"] = *input.Recipient
	}
	return s.recordJarWithdrawal(ctx, uow, "honey_give_away", "give_away",
		ReasonGiveAway, input.Lines, input.Date, input.Notes, extra, guards)
}

// AdjustJarCounts corrects a miscount (spec 6.1: count_adjust with reason
// "count"). A positive delta lands in the item's legacy-unassigned lot,
// because a jar that appears out of a recount has no provenance to claim; a
// negative delta is allocated oldest lot first.
//
// This is stricter than the movement ledger it replaces: a correction can no
// longer drive a size below zero, because the ledger refuses a negative
// balance. Correcting past that point now needs a receipt first.
func (s *Service) AdjustJarCounts(
	ctx context.Context, uow *app.UnitOfWork, lines []JarLine, date time.Time,
	notes *string, guards ...Guard,
) (uuid.UUID, error) {
	const op = "adjust jar counts"
	if len(lines) == 0 {
		return uuid.Nil, app.Invalid(op, "no changes to apply")
	}
	if err := runGuards(ctx, uow, guards); err != nil {
		return uuid.Nil, err
	}
	home, err := HomeLocationID(ctx, uow)
	if err != nil {
		return uuid.Nil, err
	}
	operationID := uuid.New()
	details := detailNotes(notes)
	movements := make([]inventory.Movement, 0, len(lines))
	inferred := false
	for _, line := range lines {
		if line.Quantity == 0 {
			continue
		}
		itemID, err := EnsureJarItem(ctx, uow, line.JarSizeID)
		if err != nil {
			return uuid.Nil, err
		}
		if line.Quantity > 0 {
			lotID, err := LegacyUnassignedLot(ctx, uow, itemID)
			if err != nil {
				return uuid.Nil, err
			}
			movements = append(movements, inventory.Movement{
				Tuple:         inventory.Tuple{ItemID: itemID, LocationID: home, LotID: &lotID},
				Quantity:      Quantity(line.Quantity),
				QuantityScale: CountScale,
			})
			inferred = true
			continue
		}
		allocations, method, err := AllocateFIFO(ctx, uow, "inventory_balances",
			itemID, home, -line.Quantity, nil)
		if err != nil {
			return uuid.Nil, err
		}
		if method == MethodFIFOInferred {
			inferred = true
		}
		for _, allocation := range allocations {
			lotID := allocation.LotID
			movements = append(movements, inventory.Movement{
				Tuple:         inventory.Tuple{ItemID: itemID, LocationID: home, LotID: &lotID},
				Quantity:      Negate(Quantity(allocation.Quantity)),
				QuantityScale: CountScale,
			})
		}
	}
	if len(movements) == 0 {
		return uuid.Nil, app.Invalid(op, "no changes to apply")
	}
	details["lot_allocation"] = map[string]any{"method": allocationMethod(inferred)}
	base := baseFor(uow, "jar_count_adjust", operationID, "adjust", 1, ReasonCount, date, details)
	base.ID = operationID
	// One operation per correction, one line per lot it touched. The builder
	// validates a single line, so every other line is checked the same way
	// before it is attached.
	operation, err := build.CountAdjust(build.SingleParams{Base: base, Line: movements[0]})
	if err != nil {
		return uuid.Nil, app.Invalid(op, "%v", err)
	}
	for _, line := range movements[1:] {
		if _, err := build.CountAdjust(build.SingleParams{Base: base, Line: line}); err != nil {
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

func (s *Service) recordJarWithdrawal(
	ctx context.Context, uow *app.UnitOfWork,
	sourceType, command, reason string, lines []JarLine, date time.Time,
	notes *string, extra map[string]any, guards []Guard,
) (uuid.UUID, error) {
	const op = "record jar withdrawal"
	if len(lines) == 0 {
		return uuid.Nil, app.Invalid(op, "add at least one jar line")
	}
	if err := runGuards(ctx, uow, guards); err != nil {
		return uuid.Nil, err
	}
	home, err := HomeLocationID(ctx, uow)
	if err != nil {
		return uuid.Nil, err
	}
	operationID := uuid.New()
	movements := make([]inventory.Movement, 0, len(lines))
	inferred := false
	for _, line := range lines {
		if line.Quantity <= 0 {
			continue
		}
		itemID, err := EnsureJarItem(ctx, uow, line.JarSizeID)
		if err != nil {
			return uuid.Nil, err
		}
		var allocations []Allocation
		if line.HarvestLotID != nil && *line.HarvestLotID != uuid.Nil {
			// The operator named the varietal: draw that lot's jars and refuse
			// a short lot by its code rather than spill into another one.
			lotID, err := EnsureJarLotForHarvestLot(ctx, uow, itemID, *line.HarvestLotID)
			if err != nil {
				return uuid.Nil, err
			}
			allocations, err = AllocateLot(ctx, uow, "inventory_balances",
				itemID, home, line.Quantity, lotID)
			if err != nil {
				return uuid.Nil, err
			}
		} else {
			var method string
			allocations, method, err = AllocateFIFO(ctx, uow, "inventory_balances",
				itemID, home, line.Quantity, nil)
			if err != nil {
				return uuid.Nil, err
			}
			if method == MethodFIFOInferred {
				inferred = true
			}
		}
		for _, allocation := range allocations {
			lotID := allocation.LotID
			movements = append(movements, inventory.Movement{
				Tuple:         inventory.Tuple{ItemID: itemID, LocationID: home, LotID: &lotID},
				Quantity:      Negate(Quantity(allocation.Quantity)),
				QuantityScale: CountScale,
			})
		}
	}
	if len(movements) == 0 {
		return uuid.Nil, app.Invalid(op, "add at least one jar line")
	}
	details := detailNotes(notes)
	for key, value := range extra {
		details[key] = value
	}
	details["lot_allocation"] = map[string]any{"method": allocationMethod(inferred)}
	base := baseFor(uow, sourceType, operationID, command, 1, reason, date, details)
	base.ID = operationID
	// One shrink, one line per lot the allocation touched; each line is put
	// through the builder so none skips its validation.
	operation, err := build.Shrink(build.SingleParams{Base: base, Line: movements[0]})
	if err != nil {
		return uuid.Nil, app.Invalid(op, "%v", err)
	}
	for _, line := range movements[1:] {
		if _, err := build.Shrink(build.SingleParams{Base: base, Line: line}); err != nil {
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

func allocationMethod(inferred bool) string {
	if inferred {
		return MethodFIFOInferred
	}
	return MethodRecorded
}

func detailNotes(notes *string) map[string]any {
	details := map[string]any{}
	if notes != nil && *notes != "" {
		details["notes"] = *notes
	}
	return details
}
