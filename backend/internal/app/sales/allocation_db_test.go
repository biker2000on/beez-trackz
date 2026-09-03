package sales

import (
	"context"
	"testing"
	"time"

	"github.com/biker2000on/beez-trackz/backend/internal/app"
	"github.com/biker2000on/beez-trackz/backend/internal/app/production"
	"github.com/google/uuid"
)

// Spec section 12, Producers: "FIFO-inferred allocation flagged and reported"
// (design review A3).
//
// A jar line that names its bottling run has recorded provenance; a line that
// names none is FIFO-guessed. The difference has to be visible after the fact,
// because Honey Story and the compliance packet may only present the first
// kind as a lot fact. This test writes one of each and then runs the report a
// filter would run: select the operations whose allocation was inferred.
func TestInferredAllocationIsFlaggedAndReportable(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Minute)
	defer cancel()
	fixture, cleanup := newReservationFixture(ctx, t, "beez_sales_allocation")
	defer cleanup()

	// A second lot of the same jar size, bottled after the fixture's, so
	// "oldest receipt first" has something to choose between.
	secondRunID, secondLotID := fixture.secondBottlingRun(ctx, t, 6)

	traced := fixture.tracedSale(ctx, t, secondRunID, 2)
	untraced := fixture.draftSale(ctx, t, nil, 3)
	fixture.apply(ctx, t, traced)
	fixture.apply(ctx, t, untraced)

	// The traced line took the run's own lot and says so.
	method, lots := fixture.allocation(ctx, t, traced)
	if method != production.MethodRecorded {
		t.Errorf("traced sale allocation method = %q, want %q", method, production.MethodRecorded)
	}
	if len(lots) != 1 || lots[0] != secondLotID {
		t.Errorf("traced sale drew lots %v, want just the run's lot %v", lots, secondLotID)
	}

	// The untraced line was guessed, and is labelled as a guess.
	method, lots = fixture.allocation(ctx, t, untraced)
	if method != production.MethodFIFOInferred {
		t.Errorf("untraced sale allocation method = %q, want %q",
			method, production.MethodFIFOInferred)
	}
	if len(lots) == 0 {
		t.Error("untraced sale recorded no lots at all")
	}

	// The report: every operation whose provenance is an inference, and only
	// those. This is the query an inferred-allocation filter runs.
	rows, err := fixture.pool.Query(ctx, `
		SELECT source_id FROM inventory_operations
		WHERE details->'lot_allocation'->>'method' = $1
		ORDER BY occurred_at, created_at`, production.MethodFIFOInferred)
	if err != nil {
		t.Fatalf("inferred-allocation report: %v", err)
	}
	defer rows.Close()
	reported := map[uuid.UUID]bool{}
	for rows.Next() {
		var sourceID uuid.UUID
		if err := rows.Scan(&sourceID); err != nil {
			t.Fatalf("scan report row: %v", err)
		}
		reported[sourceID] = true
	}
	if err := rows.Err(); err != nil {
		t.Fatalf("inferred-allocation report: %v", err)
	}
	if !reported[untraced] {
		t.Error("the untraced sale is missing from the inferred-allocation report")
	}
	if reported[traced] {
		t.Error("a traced sale was reported as an inferred allocation")
	}
}

// allocation reads back what a sale's consumption recorded about how its lots
// were chosen.
func (f reservationFixture) allocation(
	ctx context.Context, t *testing.T, saleID uuid.UUID,
) (method string, lots []uuid.UUID) {
	t.Helper()
	if err := f.pool.QueryRow(ctx, `
		SELECT COALESCE(o.details->'lot_allocation'->>'method', ''),
		       COALESCE(ARRAY_AGG(DISTINCT m.lot_id) FILTER (WHERE m.lot_id IS NOT NULL),
		                ARRAY[]::uuid[])
		FROM inventory_operations o
		JOIN inventory_movements m ON m.operation_id = o.id
		WHERE o.source_type='sale' AND o.source_id=$1 AND o.kind='sale_consume'
		GROUP BY o.id`, saleID).Scan(&method, &lots); err != nil {
		t.Fatalf("read allocation for %s: %v", saleID, err)
	}
	return method, lots
}

// secondBottlingRun bottles a second harvest lot into the same jar size and
// returns the run and the jar lot its jars landed in.
func (f reservationFixture) secondBottlingRun(
	ctx context.Context, t *testing.T, quantity int,
) (runID, jarLotID uuid.UUID) {
	t.Helper()
	if err := f.runner.Run(ctx, f.actor, func(ctx context.Context, uow *app.UnitOfWork) error {
		var harvestLotID uuid.UUID
		if err := uow.QueryRow(ctx, `
			INSERT INTO harvest_lots (lot_code, public_slug, extraction_date, honey_weight_lbs)
			VALUES ('LOT-RES-2','lot-res-2',CURRENT_DATE, 100) RETURNING id`).
			Scan(&harvestLotID); err != nil {
			return err
		}
		commands := production.New()
		if err := commands.SetLotCeiling(ctx, uow, harvestLotID, 100, time.Now().UTC()); err != nil {
			return err
		}
		if err := uow.QueryRow(ctx, `
			INSERT INTO bottling_runs (lot_id, bottled_date, quantity, jar_size_id)
			VALUES ($1, CURRENT_DATE, $2, $3) RETURNING id`,
			harvestLotID, quantity, f.jarSizeID).Scan(&runID); err != nil {
			return err
		}
		if _, err := commands.RecordBottling(ctx, uow, production.BottlingInput{
			RunID: runID, HarvestLotID: harvestLotID, JarSizeID: f.jarSizeID,
			Quantity: quantity, HoneyLbs: float64(quantity), Date: time.Now().UTC(),
		}); err != nil {
			return err
		}
		id, err := production.EnsureJarLotForHarvestLot(ctx, uow, f.jarItem, harvestLotID)
		if err != nil {
			return err
		}
		jarLotID = id
		return nil
	}); err != nil {
		t.Fatalf("second bottling run: %v", err)
	}
	return runID, jarLotID
}

// tracedSale is draftSale with the line pinned to a bottling run, which is
// what makes its lot recorded provenance rather than an inference.
func (f reservationFixture) tracedSale(
	ctx context.Context, t *testing.T, runID uuid.UUID, quantity int,
) uuid.UUID {
	t.Helper()
	saleID := uuid.New()
	if err := f.runner.Run(ctx, f.actor, func(ctx context.Context, uow *app.UnitOfWork) error {
		if _, err := uow.Exec(ctx, `
			INSERT INTO sales (id, date, channel, payment_method, order_status,
			                   total_amount_cents)
			VALUES ($1, now(), 'direct', 'cash', 'draft', 0)`, saleID); err != nil {
			return err
		}
		if _, err := uow.Exec(ctx, `
			INSERT INTO sale_items (sale_id, kind, jar_size_id, quantity,
			                        unit_price_cents, bottling_run_id)
			VALUES ($1, 'jar', $2, $3, 1200, $4)`,
			saleID, f.jarSizeID, quantity, runID); err != nil {
			return err
		}
		return f.service.LinkLines(ctx, uow, saleID, f.home)
	}); err != nil {
		t.Fatalf("traced sale: %v", err)
	}
	return saleID
}
