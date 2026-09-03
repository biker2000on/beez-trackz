package sales

import (
	"context"
	"testing"
	"time"

	"github.com/biker2000on/beez-trackz/backend/internal/app"
	"github.com/biker2000on/beez-trackz/backend/internal/app/production"
	"github.com/google/uuid"
)

// Spec 12.1 open item 4: re-validating a STORED sale has to credit the sale
// its own reservation back.
//
// inventory_reservations counts every line of an unapplied, uncancelled sale,
// and inventory_available subtracts it. So a sale that already holds the last
// ten jars looks, to CheckAvailability, like a sale asking for ten jars that
// are not there — the plain check refuses an edit that changes nothing.
// CheckAvailabilityExcluding is the variant the sale-edit path uses.
func TestCheckAvailabilityExcludingCreditsTheSaleItsOwnReservation(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Minute)
	defer cancel()
	fixture, cleanup := newReservationFixture(ctx, t, "beez_sales_reservation_excluding")
	defer cleanup()

	// One draft claims all ten jars at home.
	saleID := fixture.draftSale(ctx, t, nil, 10)
	if got := fixture.available(ctx, t, fixture.home); got != 0 {
		t.Fatalf("available with the draft standing = %d, want 0", got)
	}

	needs := func(quantity int) []Need {
		return []Need{{ItemID: fixture.jarItem, Quantity: quantity}}
	}
	run := func(fn func(context.Context, *app.UnitOfWork) error) error {
		return app.NewRunner(fixture.pool).Run(ctx, fixture.actor, fn)
	}

	// The plain check charges the sale for its own units and refuses.
	if err := run(func(ctx context.Context, uow *app.UnitOfWork) error {
		return fixture.service.CheckAvailability(ctx, uow, fixture.home, needs(10))
	}); !app.IsKind(err, app.KindPrecondition) {
		t.Fatalf("plain re-check of a stored sale = %v, want a precondition refusal", err)
	}

	// The excluding variant sees the same ten jars as the sale's own hold.
	if err := run(func(ctx context.Context, uow *app.UnitOfWork) error {
		return fixture.service.CheckAvailabilityExcluding(ctx, uow, fixture.home, saleID, needs(10))
	}); err != nil {
		t.Fatalf("re-checking the sale for what it already holds = %v, want no refusal", err)
	}

	// Shrinking the sale is always fine.
	if err := run(func(ctx context.Context, uow *app.UnitOfWork) error {
		return fixture.service.CheckAvailabilityExcluding(ctx, uow, fixture.home, saleID, needs(4))
	}); err != nil {
		t.Fatalf("shrinking the sale = %v, want no refusal", err)
	}

	// Growing it past what the shelf holds is still refused: the credit is the
	// sale's own ten, not a blank cheque.
	err := run(func(ctx context.Context, uow *app.UnitOfWork) error {
		return fixture.service.CheckAvailabilityExcluding(ctx, uow, fixture.home, saleID, needs(11))
	})
	if !app.IsKind(err, app.KindPrecondition) {
		t.Fatalf("growing the sale past the shelf = %v, want a precondition refusal", err)
	}

	// A DIFFERENT sale gets no credit from this one, so the hold still holds.
	other := uuid.New()
	if err := run(func(ctx context.Context, uow *app.UnitOfWork) error {
		return fixture.service.CheckAvailabilityExcluding(ctx, uow, fixture.home, other, needs(1))
	}); !app.IsKind(err, app.KindPrecondition) {
		t.Fatalf("another sale asking for one jar = %v, want a precondition refusal", err)
	}

	// Once the sale is applied it reserves nothing, so the credit disappears
	// with the reservation and the variant collapses onto the plain check.
	fixture.apply(ctx, t, saleID)
	if err := run(func(ctx context.Context, uow *app.UnitOfWork) error {
		return fixture.service.CheckAvailabilityExcluding(ctx, uow, fixture.home, saleID, needs(1))
	}); !app.IsKind(err, app.KindPrecondition) {
		t.Fatalf("re-checking an APPLIED sale = %v, want a precondition refusal", err)
	}
}

// NeedsForSale is what the edit path hands the generic item-unit check. The
// colony line has no stock item, while the propolis line stays on the product
// endpoint's cumulative grams check even though LinkLines gives it an item.
func TestNeedsForSaleSkipsColonyAndPropolisLines(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Minute)
	defer cancel()
	fixture, cleanup := newReservationFixture(ctx, t, "beez_sales_reservation_needs")
	defer cleanup()

	saleID := fixture.draftSale(ctx, t, nil, 3)

	// A colony line: the hive is not stock, so it is not a demand on the
	// ledger even though it is very much a thing being sold.
	var apiaryID, hiveID uuid.UUID
	if err := fixture.pool.QueryRow(ctx,
		`INSERT INTO apiaries (name) VALUES ('Needs yard') RETURNING id`).Scan(&apiaryID); err != nil {
		t.Fatalf("seed apiary: %v", err)
	}
	if err := fixture.pool.QueryRow(ctx,
		`INSERT INTO hives (apiary_id, position_label) VALUES ($1,'N1') RETURNING id`,
		apiaryID).Scan(&hiveID); err != nil {
		t.Fatalf("seed hive: %v", err)
	}
	if _, err := fixture.pool.Exec(ctx, `
		INSERT INTO sale_items (sale_id, kind, hive_id, quantity, unit_price_cents)
		VALUES ($1,'colony',$2,1,20000)`, saleID, hiveID); err != nil {
		t.Fatalf("seed colony line: %v", err)
	}

	// A raw-propolis line: its stock is harvested grams against the propolis
	// item, not units of the SKU, so it has no generic unit demand.
	var propolisID uuid.UUID
	if err := fixture.pool.QueryRow(ctx, `
		INSERT INTO product_catalog (name, kind, unit, default_price_cents, net_grams)
		VALUES ('Raw propolis 10g','propolis','bag',600,10) RETURNING id`).
		Scan(&propolisID); err != nil {
		t.Fatalf("seed propolis SKU: %v", err)
	}
	if _, err := fixture.pool.Exec(ctx, `
		INSERT INTO sale_items (sale_id, kind, product_id, quantity, unit_price_cents)
		VALUES ($1,'propolis',$2,2,600)`, saleID, propolisID); err != nil {
		t.Fatalf("seed propolis line: %v", err)
	}

	var needs []Need
	if err := app.NewRunner(fixture.pool).Run(ctx, fixture.actor,
		func(ctx context.Context, uow *app.UnitOfWork) error {
			if err := fixture.service.LinkLines(ctx, uow, saleID, fixture.home); err != nil {
				return err
			}
			var err error
			needs, err = NeedsForSale(ctx, uow, saleID)
			return err
		}); err != nil {
		t.Fatalf("build needs: %v", err)
	}
	if len(needs) != 1 {
		t.Fatalf("needs = %+v, want only the jar line", needs)
	}
	if needs[0].ItemID != fixture.jarItem || needs[0].Quantity != 3 {
		t.Errorf("need = %+v, want 3 of the jar item", needs[0])
	}
}

// Spec 12.1 open item 5: inventory_reservations expresses raw-propolis holds
// in the singleton item's canonical unit. Two units of a 25 g SKU reserve 50
// grams, never two packaged units, and LinkLines leaves the lot unpinned.
func TestPropolisReservationViewUsesItemGrams(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Minute)
	defer cancel()
	fixture, cleanup := newReservationFixture(ctx, t, "beez_sales_propolis_reserved")
	defer cleanup()

	var skuID uuid.UUID
	if err := fixture.pool.QueryRow(ctx, `
		INSERT INTO product_catalog (name, kind, unit, default_price_cents, net_grams)
		VALUES ('Raw propolis 25g','propolis','bag',900,25) RETURNING id`).
		Scan(&skuID); err != nil {
		t.Fatalf("seed propolis SKU: %v", err)
	}

	seedSale := func(status string, applied bool, quantity int) uuid.UUID {
		t.Helper()
		saleID := uuid.New()
		appliedAt := "NULL"
		if applied {
			appliedAt = "now()"
		}
		if _, err := fixture.pool.Exec(ctx, `
			INSERT INTO sales (id, date, customer_name, order_number, channel,
				payment_method, total_amount_cents, amount_paid_cents, order_status,
				physical_applied_at)
			VALUES ($1, now(), 'Propolis buyer', $2, 'direct', 'cash', 900, 900, $3, `+
			appliedAt+`)`, saleID, "BT-"+saleID.String()[:8], status); err != nil {
			t.Fatalf("seed sale: %v", err)
		}
		if _, err := fixture.pool.Exec(ctx, `
			INSERT INTO sale_items (sale_id, kind, product_id, quantity, unit_price_cents)
			VALUES ($1,'propolis',$2,$3,900)`, saleID, skuID, quantity); err != nil {
			t.Fatalf("seed propolis line: %v", err)
		}
		return saleID
	}

	heldSale := seedSale("pending", false, 2) // 50 g held
	seedSale("paid", true, 4)                 // applied: consumed, not reserved
	seedSale("cancelled", false, 8)

	if err := fixture.runner.Run(ctx, fixture.actor,
		func(ctx context.Context, uow *app.UnitOfWork) error {
			return fixture.service.LinkLines(ctx, uow, heldSale, fixture.home)
		}); err != nil {
		t.Fatalf("link propolis sale: %v", err)
	}

	var linkedItem uuid.UUID
	var linkedLot *uuid.UUID
	if err := fixture.pool.QueryRow(ctx, `
		SELECT item_id, inventory_lot_id FROM sale_items
		WHERE sale_id=$1`, heldSale).Scan(&linkedItem, &linkedLot); err != nil {
		t.Fatalf("read linked propolis line: %v", err)
	}
	if linkedItem != production.PropolisItemID {
		t.Fatalf("linked item = %s, want raw propolis %s", linkedItem, production.PropolisItemID)
	}
	if linkedLot != nil {
		t.Fatalf("linked lot = %s, want nil item-level reservation", *linkedLot)
	}

	var reserved float64
	var lotID *uuid.UUID
	if err := fixture.pool.QueryRow(ctx, `
		SELECT reserved::float8, lot_id
		FROM inventory_reservations
		WHERE item_id=$1 AND location_id=$2`,
		production.PropolisItemID, fixture.home).Scan(&reserved, &lotID); err != nil {
		t.Fatalf("read propolis reservation view: %v", err)
	}
	if reserved != 50 {
		t.Fatalf("reserved = %v g, want 50 (2 bags x 25 g)", reserved)
	}
	if lotID != nil {
		t.Fatalf("reservation lot = %s, want nil", *lotID)
	}
}
