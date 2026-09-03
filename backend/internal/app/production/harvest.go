package production

import (
	"context"
	"math"
	"time"

	"github.com/biker2000on/beez-trackz/backend/internal/app"
	"github.com/biker2000on/beez-trackz/backend/internal/app/inventory"
	"github.com/biker2000on/beez-trackz/backend/internal/app/inventory/build"
	"github.com/google/uuid"
)

// PoundTolerance is the mass comparison tolerance the ledger uses (decision 4).
const PoundTolerance = 0.0001

// SetLotCeiling makes a harvest lot's weight a receipt into its bulk-honey
// lot (decision 6). The lot's stored honey_weight_lbs stays the domain fact;
// the pounds that can actually be drawn are this receipt's balance.
//
// Changing the ceiling — a re-linked harvest, a corrected manual weight — is
// a new receipt for the new weight followed by a reversal of the old one, in
// that order, so the lot never dips negative in between. Lowering the ceiling
// below what has already been drawn is refused by the nonnegative invariant,
// which is the same rule the old "cannot drop below what its runs bottled"
// check enforced by hand.
func (s *Service) SetLotCeiling(
	ctx context.Context, uow *app.UnitOfWork,
	harvestLotID uuid.UUID, weightLbs float64, occurredAt time.Time, guards ...Guard,
) error {
	const op = "set harvest lot ceiling"
	if weightLbs < 0 {
		return app.Invalid(op, "lot weight must not be negative")
	}
	if err := runGuards(ctx, uow, guards); err != nil {
		return err
	}
	lotID, err := EnsureHarvestLot(ctx, uow, harvestLotID)
	if err != nil {
		return err
	}
	previousID, hasPrevious, err := liveOperation(ctx, uow, "harvest_lot", harvestLotID, "ceiling")
	if err != nil {
		return err
	}
	current := 0.0
	if hasPrevious {
		if current, err = s.ceilingPounds(ctx, uow, previousID); err != nil {
			return err
		}
	}
	if math.Abs(current-weightLbs) <= PoundTolerance {
		return nil
	}

	if weightLbs > 0 {
		home, err := HomeLocationID(ctx, uow)
		if err != nil {
			return err
		}
		attempt, err := attemptFor(ctx, uow, "harvest_lot", harvestLotID, "ceiling")
		if err != nil {
			return err
		}
		base := baseFor(uow, "harvest_lot", harvestLotID, "ceiling", attempt, "none", occurredAt, nil)
		operation, err := build.Receive(build.SingleParams{
			Base: base,
			Line: inventory.Movement{
				Tuple:         inventory.Tuple{ItemID: HoneyBulkItemID, LocationID: home, LotID: &lotID},
				Quantity:      Pounds(weightLbs),
				QuantityScale: MassScale,
			},
		})
		if err != nil {
			return app.Invalid(op, "%v", err)
		}
		if _, err := s.inventory.Record(ctx, uow, operation); err != nil {
			return err
		}
	}
	if hasPrevious {
		key := previousID.String() + ":ceiling-replaced"
		if _, err := s.inventory.Reverse(ctx, uow, previousID, key, "none"); err != nil {
			return err
		}
	}
	return nil
}

// ReleaseLotCeiling reverses a lot's receipt outright, which is what deleting
// a harvest lot means for the ledger.
func (s *Service) ReleaseLotCeiling(
	ctx context.Context, uow *app.UnitOfWork, harvestLotID uuid.UUID,
) error {
	previousID, hasPrevious, err := liveOperation(ctx, uow, "harvest_lot", harvestLotID, "ceiling")
	if err != nil || !hasPrevious {
		return err
	}
	_, err = s.inventory.Reverse(ctx, uow, previousID, previousID.String()+":ceiling-released", "none")
	return err
}

func (s *Service) ceilingPounds(ctx context.Context, uow *app.UnitOfWork, operationID uuid.UUID) (float64, error) {
	var pounds float64
	err := uow.QueryRow(ctx,
		`SELECT COALESCE(SUM(quantity), 0)::float8 FROM inventory_movements WHERE operation_id=$1`,
		operationID).Scan(&pounds)
	return pounds, wrapDB("read lot ceiling", err)
}
