package sales

import (
	"context"
	"fmt"

	"github.com/biker2000on/beez-trackz/backend/internal/app"
	"github.com/biker2000on/beez-trackz/backend/internal/app/inventory"
	"github.com/biker2000on/beez-trackz/backend/internal/app/production"
	"github.com/google/uuid"
)

// Need is one line's demand on the ledger, as the reservation check sees it.
type Need struct {
	ItemID uuid.UUID
	// LotID pins the demand to one lot (a jar line off a named bottling run).
	// Nil means "from this location, oldest first".
	LotID *uuid.UUID
	// Condition pins a condition-tracked item; equipment sells serviceable.
	Condition *string
	Quantity  int
}

// Shortfall is a typed refusal naming the item that could not cover a line,
// so the edge can format it with the label the operator recognises.
type Shortfall struct {
	ItemID    uuid.UUID
	Needed    int
	Available int
}

func (s Shortfall) Error() string {
	return fmt.Sprintf("item %s has %d available; %d required", s.ItemID, s.Available, s.Needed)
}

// CheckAvailability validates a draft or pending sale's lines against
// on hand minus reservations, holding the inventory service's tuple locks
// until the caller's transaction ends (review OV1).
//
// A need with no lot is spread across the location's lots oldest first and
// each resulting tuple is locked and checked, so the guarantee is per tuple
// rather than per total: two drafts racing for the last jars of one lot
// serialize exactly as two sales do.
func (s *Service) CheckAvailability(
	ctx context.Context, uow *app.UnitOfWork, locationID uuid.UUID, needs []Need,
) error {
	tuples := make([]inventory.TupleQuantity, 0, len(needs))
	for _, need := range needs {
		if need.Quantity <= 0 {
			continue
		}
		if need.LotID != nil || need.Condition != nil {
			tuples = append(tuples, inventory.TupleQuantity{
				Tuple: inventory.Tuple{
					ItemID: need.ItemID, LocationID: locationID,
					LotID: need.LotID, Condition: need.Condition,
				},
				Quantity: production.Quantity(need.Quantity),
			})
			continue
		}
		allocations, _, err := production.AllocateFIFO(ctx, uow, "inventory_available",
			need.ItemID, locationID, need.Quantity, nil)
		if err != nil {
			available, readErr := s.availableUnits(ctx, uow, need.ItemID, locationID)
			if readErr != nil {
				return readErr
			}
			return app.Wrap(app.KindPrecondition, "check sale availability",
				Shortfall{ItemID: need.ItemID, Needed: need.Quantity, Available: available})
		}
		for _, allocation := range allocations {
			lotID := allocation.LotID
			tuples = append(tuples, inventory.TupleQuantity{
				Tuple: inventory.Tuple{
					ItemID: need.ItemID, LocationID: locationID, LotID: &lotID,
				},
				Quantity: production.Quantity(allocation.Quantity),
			})
		}
	}
	if len(tuples) == 0 {
		return nil
	}
	return s.inventory.CheckAvailable(ctx, uow, tuples)
}

// availableUnits is the location-wide available count for one item, used to
// format a refusal the operator can act on.
func (s *Service) availableUnits(
	ctx context.Context, uow *app.UnitOfWork, itemID, locationID uuid.UUID,
) (int, error) {
	var available int
	err := uow.QueryRow(ctx, `
		SELECT COALESCE(SUM(GREATEST(available, 0)), 0)::int FROM inventory_available
		WHERE item_id=$1 AND location_id=$2`, itemID, locationID).Scan(&available)
	if err != nil {
		return 0, app.Wrap(app.KindInternal, "read availability", err)
	}
	return available, nil
}

// AvailableUnits reports what a location can still sell of one item, for the
// edge's own messages and for the shelf projections.
func (s *Service) AvailableUnits(
	ctx context.Context, uow *app.UnitOfWork, itemID, locationID uuid.UUID,
) (int, error) {
	return s.availableUnits(ctx, uow, itemID, locationID)
}
