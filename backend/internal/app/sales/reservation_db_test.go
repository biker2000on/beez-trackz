package sales

import (
	"context"
	"errors"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/biker2000on/beez-trackz/backend/internal/app"
	"github.com/biker2000on/beez-trackz/backend/internal/app/production"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/jackc/pgx/v5/stdlib"
	"github.com/pressly/goose/v3"
)

// Spec section 12, "Reservations": a draft sale is a claim on stock even
// though it records no operation. These tests pin the four properties the
// claim has to have — a second draft cannot claim the same jars, applying
// converts the claim into consumption, cancelling releases it, and a sale
// located at a consignee claims that consignee's shelf, not home's.

type reservationFixture struct {
	pool      *pgxpool.Pool
	runner    *app.Runner
	service   *Service
	actor     app.Actor
	home      uuid.UUID
	consignee uuid.UUID
	shopID    uuid.UUID
	jarSizeID uuid.UUID
	jarItem   uuid.UUID
	jarLot    uuid.UUID
}

// TestReservationHoldsTheLastJars is the "two drafts for the last N jars" row.
func TestReservationHoldsTheLastJars(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Minute)
	defer cancel()
	fixture, cleanup := newReservationFixture(ctx, t, "beez_sales_reservation")
	defer cleanup()

	// Ten jars at home, and a draft that claims all ten.
	first := fixture.draftSale(ctx, t, nil, 10)
	if got := fixture.available(ctx, t, fixture.home); got != 0 {
		t.Fatalf("available with a draft for every jar = %d, want 0", got)
	}

	// A second draft for even one jar has nothing left to claim. The check
	// runs under the same tuple locks a sale takes, so this is the same
	// refusal two concurrent buyers would race into.
	err := fixture.checkNeed(ctx, fixture.home, 1)
	if !app.IsKind(err, app.KindPrecondition) {
		t.Fatalf("second draft for the last jars = %v, want a precondition refusal", err)
	}
	var shortfall Shortfall
	if !errors.As(err, &shortfall) {
		t.Fatalf("refusal %v does not name the item that fell short", err)
	}
	if shortfall.ItemID != fixture.jarItem || shortfall.Needed != 1 || shortfall.Available != 0 {
		t.Errorf("shortfall = %+v, want 1 needed and 0 available of the jar item", shortfall)
	}

	// The jars are held, not gone: the first draft still owns all ten, and
	// applying it consumes exactly those.
	if got := fixture.reserved(ctx, t, fixture.home); got != 10 {
		t.Errorf("reserved by the holding draft = %d, want 10", got)
	}
	fixture.apply(ctx, t, first)
	if got := fixture.onHand(ctx, t, fixture.home); got != 0 {
		t.Errorf("on hand after the holding draft applied = %d, want 0", got)
	}
}

// TestApplyConvertsTheReservation is the "apply converts the reservation to
// consumption" row: the claim disappears from inventory_reservations at the
// same moment the movement appears, so on-hand and available never
// double-count the sale.
func TestApplyConvertsTheReservation(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Minute)
	defer cancel()
	fixture, cleanup := newReservationFixture(ctx, t, "beez_sales_reservation_apply")
	defer cleanup()

	saleID := fixture.draftSale(ctx, t, nil, 4)
	if got := fixture.reserved(ctx, t, fixture.home); got != 4 {
		t.Fatalf("reserved by the draft = %d, want 4", got)
	}
	if got := fixture.onHand(ctx, t, fixture.home); got != 10 {
		t.Fatalf("on hand while only reserved = %d, want the jars still there", got)
	}

	fixture.apply(ctx, t, saleID)

	if got := fixture.reserved(ctx, t, fixture.home); got != 0 {
		t.Errorf("reserved after apply = %d, want 0", got)
	}
	if got := fixture.onHand(ctx, t, fixture.home); got != 6 {
		t.Errorf("on hand after apply = %d, want 6", got)
	}
	if got := fixture.available(ctx, t, fixture.home); got != 6 {
		t.Errorf("available after apply = %d, want 6", got)
	}
	// The jars left through one sale_consume operation, not through the
	// reservation quietly becoming permanent.
	var consumed float64
	if err := fixture.pool.QueryRow(ctx, `
		SELECT COALESCE(SUM(m.quantity), 0)::float8
		FROM inventory_operations o JOIN inventory_movements m ON m.operation_id = o.id
		WHERE o.source_type='sale' AND o.source_id=$1 AND o.kind='sale_consume'`,
		saleID).Scan(&consumed); err != nil {
		t.Fatalf("read sale consumption: %v", err)
	}
	if consumed != -4 {
		t.Errorf("sale_consume quantity = %v, want -4", consumed)
	}
}

// TestCancelReleasesTheReservation is the "cancel releases it" row.
func TestCancelReleasesTheReservation(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Minute)
	defer cancel()
	fixture, cleanup := newReservationFixture(ctx, t, "beez_sales_reservation_cancel")
	defer cleanup()

	saleID := fixture.draftSale(ctx, t, nil, 10)
	if got := fixture.available(ctx, t, fixture.home); got != 0 {
		t.Fatalf("available under a full claim = %d, want 0", got)
	}

	// Cancelling is a status change on the sale: the lines stay for the
	// record, and the reservation view stops counting them.
	if _, err := fixture.pool.Exec(ctx,
		`UPDATE sales SET order_status='cancelled' WHERE id=$1`, saleID); err != nil {
		t.Fatalf("cancel sale: %v", err)
	}
	if got := fixture.available(ctx, t, fixture.home); got != 10 {
		t.Errorf("available after cancel = %d, want the 10 jars back", got)
	}
	// And a fresh draft for all ten now clears the check that the live
	// reservation was failing a moment ago.
	if err := fixture.checkNeed(ctx, fixture.home, 10); err != nil {
		t.Errorf("draft after cancel was refused: %v", err)
	}
}

// TestConsigneeSaleReservesAtTheConsignee is the "consignee-located sale
// reserves at the consignee" row. The shop's shelf is the stock the report
// draws on; claiming home's jars for a shop's sale would let the same jar be
// sold twice.
func TestConsigneeSaleReservesAtTheConsignee(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Minute)
	defer cancel()
	fixture, cleanup := newReservationFixture(ctx, t, "beez_sales_reservation_consignee")
	defer cleanup()

	// Six of the ten jars go out to the shop.
	fixture.transferToShop(ctx, t, 6)
	if got := fixture.onHand(ctx, t, fixture.consignee); got != 6 {
		t.Fatalf("shop shelf after transfer = %d, want 6", got)
	}

	fixture.draftSale(ctx, t, &fixture.shopID, 6)
	if got := fixture.reserved(ctx, t, fixture.consignee); got != 6 {
		t.Errorf("reserved at the shop = %d, want 6", got)
	}
	if got := fixture.reserved(ctx, t, fixture.home); got != 0 {
		t.Errorf("reserved at home = %d, want 0 — the shop's sale is not home's", got)
	}
	if got := fixture.available(ctx, t, fixture.consignee); got != 0 {
		t.Errorf("shop available = %d, want 0 — its own draft holds the shelf", got)
	}
	// Home keeps exactly the four that never left, and never had to cover the
	// shop's six.
	if got := fixture.available(ctx, t, fixture.home); got != 4 {
		t.Errorf("home available = %d, want the 4 that never left", got)
	}
	if err := fixture.checkNeed(ctx, fixture.home, 4); err != nil {
		t.Errorf("home draft for its own 4 was refused: %v", err)
	}
	if err := fixture.checkNeed(ctx, fixture.home, 5); !app.IsKind(err, app.KindPrecondition) {
		t.Errorf("home draft for 5 of the remaining 4 = %v, want a refusal", err)
	}
}

// --- fixture ---

// checkNeed asks whether a location could still cover a demand for that many
// jars, holding the inventory service's tuple locks for the length of the
// transaction — the check a new draft or an edit runs before it is stored.
//
// A stored draft's own lines are part of what inventory_available subtracts,
// so this deliberately asks about a *prospective* need rather than re-checking
// a sale against a reservation it is itself holding.
func (f reservationFixture) checkNeed(ctx context.Context, locationID uuid.UUID, quantity int) error {
	return f.runner.Run(ctx, f.actor, func(ctx context.Context, uow *app.UnitOfWork) error {
		return f.service.CheckAvailability(ctx, uow, locationID,
			[]Need{{ItemID: f.jarItem, Quantity: quantity}})
	})
}

func (f reservationFixture) apply(ctx context.Context, t *testing.T, saleID uuid.UUID) {
	t.Helper()
	if err := f.runner.Run(ctx, f.actor, func(ctx context.Context, uow *app.UnitOfWork) error {
		// physical_applied_at first, so the lines stop being a reservation
		// before the consumption is recorded and the two never overlap.
		if _, err := uow.Exec(ctx,
			`UPDATE sales SET physical_applied_at=now(), order_status='paid' WHERE id=$1`,
			saleID); err != nil {
			return err
		}
		return f.service.Apply(ctx, uow, ApplyInput{
			SaleID: saleID, Date: time.Now().UTC(), LocationID: f.home,
		})
	}); err != nil {
		t.Fatalf("apply sale: %v", err)
	}
}

// draftSale stores a draft with one jar line and links it, which is what makes
// it visible to inventory_reservations.
func (f reservationFixture) draftSale(
	ctx context.Context, t *testing.T, stockLocationID *uuid.UUID, quantity int,
) uuid.UUID {
	t.Helper()
	saleID := uuid.New()
	if err := f.runner.Run(ctx, f.actor, func(ctx context.Context, uow *app.UnitOfWork) error {
		if _, err := uow.Exec(ctx, `
			INSERT INTO sales (id, date, channel, payment_method, order_status,
			                   total_amount_cents, stock_location_id)
			VALUES ($1, now(), 'direct', 'cash', 'draft', 0, $2)`,
			saleID, stockLocationID); err != nil {
			return err
		}
		if _, err := uow.Exec(ctx, `
			INSERT INTO sale_items (sale_id, kind, jar_size_id, quantity, unit_price_cents)
			VALUES ($1, 'jar', $2, $3, 1200)`, saleID, f.jarSizeID, quantity); err != nil {
			return err
		}
		location := f.home
		if stockLocationID != nil {
			id, err := production.EnsureLocationForStockLocation(ctx, uow, *stockLocationID)
			if err != nil {
				return err
			}
			location = id
		}
		return f.service.LinkLines(ctx, uow, saleID, location)
	}); err != nil {
		t.Fatalf("draft sale: %v", err)
	}
	return saleID
}

func (f reservationFixture) transferToShop(ctx context.Context, t *testing.T, quantity int) {
	t.Helper()
	if err := f.runner.Run(ctx, f.actor, func(ctx context.Context, uow *app.UnitOfWork) error {
		_, err := f.service.Transfer(ctx, uow, TransferInput{
			TransferID: uuid.New(), From: f.home, To: f.consignee,
			Date:  time.Now().UTC(),
			Lines: []TransferLine{{ItemID: f.jarItem, Quantity: quantity}},
		})
		return err
	}); err != nil {
		t.Fatalf("transfer to shop: %v", err)
	}
}

func (f reservationFixture) onHand(ctx context.Context, t *testing.T, locationID uuid.UUID) int {
	return f.sumColumn(ctx, t, "on_hand", locationID)
}
func (f reservationFixture) reserved(ctx context.Context, t *testing.T, locationID uuid.UUID) int {
	return f.sumColumn(ctx, t, "reserved", locationID)
}
func (f reservationFixture) available(ctx context.Context, t *testing.T, locationID uuid.UUID) int {
	return f.sumColumn(ctx, t, "available", locationID)
}

func (f reservationFixture) sumColumn(
	ctx context.Context, t *testing.T, column string, locationID uuid.UUID,
) int {
	t.Helper()
	var total int
	// column is one of three literals chosen above, never caller input.
	if err := f.pool.QueryRow(ctx, `
		SELECT COALESCE(SUM(`+column+`), 0)::int FROM inventory_available
		WHERE item_id=$1 AND location_id=$2`, f.jarItem, locationID).Scan(&total); err != nil {
		t.Fatalf("read %s: %v", column, err)
	}
	return total
}

// newReservationFixture stands up a migrated database holding ten jars of one
// size at home, bottled out of a real harvest lot so every quantity in the
// test arrived through the ledger.
func newReservationFixture(
	ctx context.Context, t *testing.T, name string,
) (reservationFixture, func()) {
	t.Helper()
	url := os.Getenv("TEST_DATABASE_URL")
	if url == "" {
		t.Skip("TEST_DATABASE_URL is not configured")
	}
	admin, err := pgxpool.New(ctx, url)
	if err != nil {
		t.Fatalf("connect admin: %v", err)
	}
	dropDatabase(ctx, admin, name)
	if _, err := admin.Exec(ctx, "CREATE DATABASE "+name); err != nil {
		admin.Close()
		t.Fatal(err)
	}
	pool, err := pgxpool.New(ctx, replaceReservationDatabase(url, name))
	if err != nil {
		admin.Close()
		t.Fatal(err)
	}
	goose.SetBaseFS(os.DirFS("../../db"))
	if err := goose.SetDialect("postgres"); err != nil {
		t.Fatal(err)
	}
	sqlDB := stdlib.OpenDBFromPool(pool)
	if err := goose.Up(sqlDB, "migrations"); err != nil {
		sqlDB.Close()
		pool.Close()
		admin.Close()
		t.Fatalf("migrate: %v", err)
	}
	sqlDB.Close()

	fixture := reservationFixture{
		pool: pool, runner: app.NewRunner(pool), service: New(),
		actor: app.SystemJobActor("sales-reservation-test"),
	}
	if err := pool.QueryRow(ctx,
		`SELECT id FROM inventory_locations WHERE is_home`).Scan(&fixture.home); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `
		INSERT INTO jar_sizes (label, honey_oz, default_price_cents)
		VALUES ('Pint', 16, 1200) RETURNING id`).Scan(&fixture.jarSizeID); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `
		INSERT INTO stock_locations (name, slug, is_consignment, commission_bps)
		VALUES ('Bike shop', 'bike-shop', true, 3000) RETURNING id`).Scan(&fixture.shopID); err != nil {
		t.Fatal(err)
	}

	var lotID, runID uuid.UUID
	if err := app.NewRunner(pool).Run(ctx, fixture.actor,
		func(ctx context.Context, uow *app.UnitOfWork) error {
			if err := uow.QueryRow(ctx, `
				INSERT INTO harvest_lots (lot_code, public_slug, extraction_date, honey_weight_lbs)
				VALUES ('LOT-RES','lot-res',CURRENT_DATE, 100) RETURNING id`).Scan(&lotID); err != nil {
				return err
			}
			// A lot's weight IS a receive, so the ceiling has to be booked
			// before anything can be bottled out of it.
			commands := production.New()
			if err := commands.SetLotCeiling(ctx, uow, lotID, 100, time.Now().UTC()); err != nil {
				return err
			}
			if err := uow.QueryRow(ctx, `
				INSERT INTO bottling_runs (lot_id, bottled_date, quantity, jar_size_id)
				VALUES ($1, CURRENT_DATE, 10, $2) RETURNING id`,
				lotID, fixture.jarSizeID).Scan(&runID); err != nil {
				return err
			}
			// Ten pint jars: 10 lbs out of the lot's 100.
			if _, err := commands.RecordBottling(ctx, uow, production.BottlingInput{
				RunID: runID, HarvestLotID: lotID, JarSizeID: fixture.jarSizeID,
				Quantity: 10, HoneyLbs: 10, Date: time.Now().UTC(),
			}); err != nil {
				return err
			}
			jarItem, err := production.EnsureJarItem(ctx, uow, fixture.jarSizeID)
			if err != nil {
				return err
			}
			fixture.jarItem = jarItem
			jarLot, err := production.EnsureJarLotForHarvestLot(ctx, uow, jarItem, lotID)
			if err != nil {
				return err
			}
			fixture.jarLot = jarLot
			id, err := production.EnsureLocationForStockLocation(ctx, uow, fixture.shopID)
			if err != nil {
				return err
			}
			fixture.consignee = id
			return nil
		}); err != nil {
		pool.Close()
		admin.Close()
		t.Fatalf("seed jars: %v", err)
	}

	cleanup := func() {
		pool.Close()
		dropDatabase(context.Background(), admin, name)
		admin.Close()
	}
	return fixture, cleanup
}

// dropDatabase removes a fixture database, evicting any connection that has
// not finished closing yet.
//
// pgxpool.Close returns before Postgres has necessarily reaped the backends,
// and a single straggler makes DROP DATABASE fail with 55006 — which would
// then fail the NEXT run of this test at its own drop, for a reason that has
// nothing to do with the code under test.
func dropDatabase(ctx context.Context, admin *pgxpool.Pool, name string) {
	_, _ = admin.Exec(ctx, `
		SELECT pg_terminate_backend(pid) FROM pg_stat_activity
		WHERE datname = $1 AND pid <> pg_backend_pid()`, name)
	_, _ = admin.Exec(ctx, "DROP DATABASE IF EXISTS "+name)
}

func replaceReservationDatabase(url, name string) string {
	base, query, ok := strings.Cut(url, "?")
	slash := strings.LastIndex(base, "/")
	result := base[:slash+1] + name
	if ok {
		return result + "?" + query
	}
	return result
}
