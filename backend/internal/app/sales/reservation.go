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

// CheckAvailabilityExcluding is CheckAvailability for a sale whose lines are
// already stored (spec 12.1 open item 4).
//
// A draft or pending sale's own lines ARE a reservation: inventory_reservations
// counts every line of an unapplied, uncancelled sale, and inventory_available
// subtracts it. So re-validating a stored sale with CheckAvailability charges
// the sale for its own units and refuses an edit that changes nothing. This
// variant credits the sale back its own reservation before asking the ledger,
// which is what "does this sale still fit?" means for a sale that is already
// on the books.
//
// The credit is exact where the reservation is exact. inventory_reservations
// keys on (item, location, lot, NULL condition, container), so:
//
//   - a need that pins a lot is credited that lot's stored quantity;
//   - a need that pins a CONDITION (equipment sells serviceable) is credited
//     nothing, because the reservation sits on the condition-null tuple and
//     never offset that need in the first place;
//   - an unpinned need is credited what the sale holds of that item anywhere
//     at this location, because an unpinned need is by definition satisfied
//     from any of the location's lots, oldest first.
//
// What is left after the credit goes through CheckAvailability, so the tuple
// locks, the FIFO spread, and the refusal message are the ordinary ones. A
// need the sale already covers is dropped rather than locked: the credit comes
// from a row that is committed and visible to every other reader, so no
// concurrent sale can take those units out from under this one.
func (s *Service) CheckAvailabilityExcluding(
	ctx context.Context, uow *app.UnitOfWork, locationID, saleID uuid.UUID, needs []Need,
) error {
	credit, err := s.storedReservation(ctx, uow, saleID)
	if err != nil {
		return err
	}
	remaining := make([]Need, 0, len(needs))
	// Lot-pinned needs first: their credit is exact, and spending it before
	// the unpinned needs see the per-item pool keeps a pinned line from being
	// charged for units an unpinned line already claimed.
	for _, need := range needs {
		if need.Quantity <= 0 || need.LotID == nil || need.Condition != nil {
			continue
		}
		need.Quantity -= credit.spendLot(need.ItemID, *need.LotID, need.Quantity)
		if need.Quantity > 0 {
			remaining = append(remaining, need)
		}
	}
	for _, need := range needs {
		if need.Quantity <= 0 || (need.LotID != nil && need.Condition == nil) {
			continue
		}
		if need.Condition == nil {
			need.Quantity -= credit.spendItem(need.ItemID, need.Quantity)
		}
		if need.Quantity > 0 {
			remaining = append(remaining, need)
		}
	}
	if len(remaining) == 0 {
		return nil
	}
	return s.CheckAvailability(ctx, uow, locationID, remaining)
}

// saleReservation is what one stored sale currently holds, per item and per
// (item, lot). Only lines the reservation view actually counts are in it.
type saleReservation struct {
	byItem map[uuid.UUID]int
	byLot  map[lotKey]int
}

type lotKey struct{ item, lot uuid.UUID }

// spendLot draws up to want units from the credit held against one lot,
// returning what it could give and taking the same amount off the item pool so
// no unit is credited twice.
func (r *saleReservation) spendLot(itemID, lotID uuid.UUID, want int) int {
	key := lotKey{item: itemID, lot: lotID}
	got := r.byLot[key]
	if got > want {
		got = want
	}
	if got <= 0 {
		return 0
	}
	r.byLot[key] -= got
	r.byItem[itemID] -= got
	return got
}

// spendItem draws up to want units from the credit held against an item at any
// lot. The per-lot map is not decremented: an unpinned need is served after
// every pinned one, so nothing reads it again.
func (r *saleReservation) spendItem(itemID uuid.UUID, want int) int {
	got := r.byItem[itemID]
	if got > want {
		got = want
	}
	if got <= 0 {
		return 0
	}
	r.byItem[itemID] -= got
	return got
}

// storedReservation reads what inventory_reservations currently attributes to
// one sale. A sale that is applied or cancelled reserves nothing, so it gets
// no credit and this degenerates into CheckAvailability.
func (s *Service) storedReservation(
	ctx context.Context, uow *app.UnitOfWork, saleID uuid.UUID,
) (*saleReservation, error) {
	held := &saleReservation{byItem: map[uuid.UUID]int{}, byLot: map[lotKey]int{}}
	rows, err := uow.Query(ctx, `
		SELECT si.item_id, si.inventory_lot_id, SUM(si.quantity)::int
		FROM sale_items si
		JOIN sales s ON s.id = si.sale_id
		WHERE si.sale_id = $1 AND si.item_id IS NOT NULL
		  AND s.physical_applied_at IS NULL AND s.order_status <> 'cancelled'
		GROUP BY si.item_id, si.inventory_lot_id`, saleID)
	if err != nil {
		return nil, app.Wrap(app.KindInternal, "read sale reservation", err)
	}
	defer rows.Close()
	for rows.Next() {
		var itemID uuid.UUID
		var lotID *uuid.UUID
		var quantity int
		if err := rows.Scan(&itemID, &lotID, &quantity); err != nil {
			return nil, app.Wrap(app.KindInternal, "read sale reservation", err)
		}
		if quantity <= 0 {
			continue
		}
		held.byItem[itemID] += quantity
		if lotID != nil {
			held.byLot[lotKey{item: itemID, lot: *lotID}] += quantity
		}
	}
	return held, app.Wrap(app.KindInternal, "read sale reservation", rows.Err())
}

// NeedsForSale turns a stored sale's lines into the demands the reservation
// check works from. Colony lines have no item (a hive is not stock) and
// raw-propolis lines are measured in grams rather than in SKU units, so
// neither appears; equipment sells serviceable off the shelf.
func NeedsForSale(ctx context.Context, uow *app.UnitOfWork, saleID uuid.UUID) ([]Need, error) {
	lines, err := LoadLines(ctx, uow, saleID)
	if err != nil {
		return nil, err
	}
	needs := make([]Need, 0, len(lines))
	for _, line := range lines {
		if line.ItemID == nil || line.Quantity <= 0 || line.Kind == KindPropolis {
			continue
		}
		need := Need{ItemID: *line.ItemID, Quantity: line.Quantity}
		if line.Kind == KindEquipment {
			condition := production.ConditionServiceable
			need.Condition = &condition
		} else {
			need.LotID = line.LotID
		}
		needs = append(needs, need)
	}
	return needs, nil
}

// PropolisReservedGrams is the one reservation inventory_reservations cannot
// express (spec 12.1 open item 5).
//
// A raw-propolis line sells a packaged SKU, but its stock is harvested grams
// against the propolis_raw item: two bags of a 10 g SKU take 20 g off the
// harvest, not two units of anything. inventory_reservations reserves
// SUM(sale_items.quantity) — SKU units — so giving these lines an item_id
// today would reserve 2 where 20 is owed, and every reader of
// inventory_available for propolis would be wrong by the difference.
//
// Until the view multiplies by product_catalog.net_grams, the grams an
// unapplied sale is holding are computed here, and the propolis on-hand
// formula subtracts them itself. This is that formula's only home, so the
// report, the availability guard, and the Phase A parity check cannot drift
// apart.
//
// When the view does express it, this function is what the migration has to
// reproduce, and its callers become the ones to delete.
func PropolisReservedGrams(ctx context.Context, q app.Querier) (float64, error) {
	var grams float64
	err := q.QueryRow(ctx, `
		SELECT COALESCE(SUM(si.quantity * pc.net_grams), 0)::float8
		FROM sale_items si
		JOIN sales s ON s.id = si.sale_id
		JOIN product_catalog pc ON pc.id = si.product_id
		WHERE si.kind = $1 AND pc.net_grams IS NOT NULL
		  AND s.order_status <> 'cancelled' AND s.physical_applied_at IS NULL`,
		KindPropolis).Scan(&grams)
	if err != nil {
		return 0, app.Wrap(app.KindInternal, "read propolis reservation", err)
	}
	return grams, nil
}
