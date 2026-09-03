package httpapi

import (
	"context"
	"os"
	"testing"
	"time"

	"github.com/biker2000on/beez-trackz/backend/internal/app"
	"github.com/biker2000on/beez-trackz/backend/internal/app/inventory"
	"github.com/biker2000on/beez-trackz/backend/internal/app/inventory/build"
	"github.com/biker2000on/beez-trackz/backend/internal/app/production"
	"github.com/biker2000on/beez-trackz/backend/internal/db"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

// COGS snapshots after the inventory ledger landed. Two things changed and
// both are asserted here: an equipment line's cost basis comes from
// equipment_types.unit_cost_cents (review OV2 moved the column off the
// dissolving equipment_stock), and the sale's physical effects are ledger
// operations rather than adjustment rows, so "the snapshot survives a later
// price edit" is now a property of sale_items alone.

var cogsPool *pgxpool.Pool

func cogsUnitOfWork(t *testing.T, fn func(context.Context, *app.UnitOfWork)) {
	t.Helper()
	databaseURL := os.Getenv("TEST_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("TEST_DATABASE_URL is not configured")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	if cogsPool == nil {
		pool, err := db.Connect(ctx, databaseURL)
		if err != nil {
			t.Fatalf("connect test database: %v", err)
		}
		cogsPool = pool
	}
	// The suite's TRUNCATE ... CASCADE takes the seeded inventory locations
	// with it (they reference wholesale_price_lists), so make sure the two
	// migration 00050 writes are present before booking anything against home.
	if _, err := cogsPool.Exec(ctx, `
		INSERT INTO inventory_locations (id, kind, name, is_home)
		VALUES ('00000000-0000-0000-0000-000000000201', 'site', 'Home', true)
		ON CONFLICT (id) DO NOTHING;
		INSERT INTO inventory_locations (id, kind, name)
		VALUES ('00000000-0000-0000-0000-000000000202', 'deployed', 'Deployed')
		ON CONFLICT (id) DO NOTHING`); err != nil {
		t.Fatalf("seed inventory locations: %v", err)
	}
	// DryRun always rolls back, so each test leaves the ledger untouched while
	// still exercising every constraint, trigger, and tuple lock for real.
	err := app.NewRunner(cogsPool).DryRun(ctx, app.SystemJobActor("cogs-test"),
		func(ctx context.Context, uow *app.UnitOfWork) error {
			fn(ctx, uow)
			return nil
		})
	if err != nil {
		t.Fatalf("unit of work: %v", err)
	}
}

func cogsEquipmentType(t *testing.T, ctx context.Context, uow *app.UnitOfWork, unitCost *int) uuid.UUID {
	t.Helper()
	var id uuid.UUID
	if err := uow.QueryRow(ctx, `
		INSERT INTO equipment_types (name, category, unit_cost_cents)
		VALUES ($1, 'box', $2) RETURNING id`,
		"Test box "+uuid.NewString(), unitCost).Scan(&id); err != nil {
		t.Fatalf("insert equipment type: %v", err)
	}
	return id
}

// cogsStockItem books an opening count for an equipment type through the
// ledger, which is the only way a quantity is allowed in.
func cogsStockItem(
	t *testing.T, ctx context.Context, uow *app.UnitOfWork, typeID uuid.UUID, opening int,
) (uuid.UUID, uuid.UUID) {
	t.Helper()
	// A legacy stock row is still needed to satisfy migration 00020's
	// sale_items_target_check for kind='equipment'; it carries no quantity.
	var stockID uuid.UUID
	if err := uow.QueryRow(ctx, `
		INSERT INTO equipment_stock (type_id, total_owned) VALUES ($1, 0) RETURNING id`,
		typeID).Scan(&stockID); err != nil {
		t.Fatalf("insert equipment stock: %v", err)
	}
	itemID, err := production.EnsureEquipmentItem(ctx, uow, typeID)
	if err != nil {
		t.Fatalf("ensure equipment item: %v", err)
	}
	if opening == 0 {
		return itemID, stockID
	}
	home, err := production.HomeLocationID(ctx, uow)
	if err != nil {
		t.Fatalf("home location: %v", err)
	}
	condition := production.ConditionServiceable
	operation, err := build.Receive(build.SingleParams{
		Base: production.OperationBase(uow, "equipment_type", typeID, "opening", 1,
			production.ReasonNone, time.Now().UTC(), nil),
		Line: inventory.Movement{
			Tuple: inventory.Tuple{
				ItemID: itemID, LocationID: home, Condition: &condition,
			},
			Quantity:      production.Quantity(opening),
			QuantityScale: production.CountScale,
		},
	})
	if err != nil {
		t.Fatalf("build opening receipt: %v", err)
	}
	if _, err := inventory.NewService().Record(ctx, uow, operation); err != nil {
		t.Fatalf("record opening receipt: %v", err)
	}
	return itemID, stockID
}

func cogsHive(t *testing.T, ctx context.Context, uow *app.UnitOfWork) uuid.UUID {
	t.Helper()
	var apiaryID uuid.UUID
	if err := uow.QueryRow(ctx, `
		INSERT INTO apiaries (name, latitude, longitude)
		VALUES ($1, 40, -105) RETURNING id`, "Test yard "+uuid.NewString()).
		Scan(&apiaryID); err != nil {
		t.Fatalf("insert apiary: %v", err)
	}
	var hiveID uuid.UUID
	if err := uow.QueryRow(ctx, `
		INSERT INTO hives (apiary_id, position_label, status)
		VALUES ($1, $2, 'active') RETURNING id`, apiaryID, "A"+uuid.NewString()[:4]).
		Scan(&hiveID); err != nil {
		t.Fatalf("insert hive: %v", err)
	}
	return hiveID
}

func cogsSale(t *testing.T, ctx context.Context, uow *app.UnitOfWork) uuid.UUID {
	t.Helper()
	var id uuid.UUID
	if err := uow.QueryRow(ctx, `
		INSERT INTO sales (date, total_amount_cents, order_status)
		VALUES (now(), 0, 'paid') RETURNING id`).Scan(&id); err != nil {
		t.Fatalf("insert sale: %v", err)
	}
	return id
}

func cogsBasis(t *testing.T, ctx context.Context, uow *app.UnitOfWork, saleID uuid.UUID, kind string) *int64 {
	t.Helper()
	var basis *int64
	if err := uow.QueryRow(ctx, `
		SELECT cost_basis_cents FROM sale_items WHERE sale_id=$1 AND kind=$2`,
		saleID, kind).Scan(&basis); err != nil {
		t.Fatalf("read %s cost basis: %v", kind, err)
	}
	return basis
}

func TestSaleEquipmentCOGSSnapshotFromType(t *testing.T) {
	cogsUnitOfWork(t, func(ctx context.Context, uow *app.UnitOfWork) {
		unitCost := 1500
		typeID := cogsEquipmentType(t, ctx, uow, &unitCost)
		itemID, stockID := cogsStockItem(t, ctx, uow, typeID, 10)
		saleID := cogsSale(t, ctx, uow)
		if _, err := uow.Exec(ctx, `
			INSERT INTO sale_items (sale_id, kind, item_id, equipment_stock_id, quantity, unit_price_cents)
			VALUES ($1, 'equipment', $2, $3, 3, 4000)`, saleID, itemID, stockID); err != nil {
			t.Fatalf("insert equipment line: %v", err)
		}

		if err := saleApplyPhysical(ctx, uow, saleID, time.Now(), nil, []honeySaleLine{{
			Kind: saleKindEquipment, ItemID: itemID, Quantity: 3, UnitPrice: 4000,
		}}); err != nil {
			t.Fatalf("apply physical: %v", err)
		}

		if basis := cogsBasis(t, ctx, uow, saleID, "equipment"); basis == nil || *basis != 4500 {
			t.Fatalf("cost_basis_cents = %v, want 4500 (3 * 1500)", basis)
		}
		// The gear really left the shelf: seven of the ten remain.
		var onHand int
		if err := uow.QueryRow(ctx, `
			SELECT COALESCE(SUM(on_hand), 0)::int FROM inventory_balances WHERE item_id=$1`,
			itemID).Scan(&onHand); err != nil {
			t.Fatalf("read balance: %v", err)
		}
		if onHand != 7 {
			t.Fatalf("on hand after sale = %d, want 7", onHand)
		}

		// A later price edit must not rewrite the frozen basis.
		if _, err := uow.Exec(ctx,
			`UPDATE equipment_types SET unit_cost_cents = 9999 WHERE id = $1`, typeID); err != nil {
			t.Fatalf("edit live unit cost: %v", err)
		}
		if basis := cogsBasis(t, ctx, uow, saleID, "equipment"); basis == nil || *basis != 4500 {
			t.Fatalf("cost_basis_cents after price edit = %v, want 4500", basis)
		}
	})
}

func TestSaleEquipmentCOGSNilWhenTypeHasNoUnitCost(t *testing.T) {
	cogsUnitOfWork(t, func(ctx context.Context, uow *app.UnitOfWork) {
		typeID := cogsEquipmentType(t, ctx, uow, nil)
		itemID, stockID := cogsStockItem(t, ctx, uow, typeID, 4)
		saleID := cogsSale(t, ctx, uow)
		if _, err := uow.Exec(ctx, `
			INSERT INTO sale_items (sale_id, kind, item_id, equipment_stock_id, quantity, unit_price_cents)
			VALUES ($1, 'equipment', $2, $3, 2, 1000)`, saleID, itemID, stockID); err != nil {
			t.Fatalf("insert equipment line: %v", err)
		}
		if err := saleApplyPhysical(ctx, uow, saleID, time.Now(), nil, []honeySaleLine{{
			Kind: saleKindEquipment, ItemID: itemID, Quantity: 2, UnitPrice: 1000,
		}}); err != nil {
			t.Fatalf("apply physical: %v", err)
		}
		if basis := cogsBasis(t, ctx, uow, saleID, "equipment"); basis != nil {
			t.Fatalf("cost_basis_cents = %v, want NULL when the type has no unit cost", basis)
		}
	})
}

func TestSaleColonyCostBasisFromBeesQueens(t *testing.T) {
	cogsUnitOfWork(t, func(ctx context.Context, uow *app.UnitOfWork) {
		hiveID := cogsHive(t, ctx, uow)
		saleID := cogsSale(t, ctx, uow)
		if _, err := uow.Exec(ctx, `
			INSERT INTO sale_items (sale_id, kind, hive_id, quantity, unit_price_cents)
			VALUES ($1, 'colony', $2, 1, 25000)`, saleID, hiveID); err != nil {
			t.Fatalf("insert colony line: %v", err)
		}
		if _, err := uow.Exec(ctx, `
			INSERT INTO expenses (expense_date, category, description, amount_cents, hive_id)
			VALUES
				(CURRENT_DATE, 'bees_queens', 'Nuc', 12500, $1),
				(CURRENT_DATE, 'bees_queens', 'Queen', 3500, $1),
				(CURRENT_DATE, 'feed', 'Syrup', 800, $1)`, hiveID); err != nil {
			t.Fatalf("insert expenses: %v", err)
		}
		if _, err := uow.Exec(ctx, `
			INSERT INTO expenses (expense_date, category, description, amount_cents, hive_id, deleted_at)
			VALUES (CURRENT_DATE, 'bees_queens', 'voided nuc', 99999, $1, now())`,
			hiveID); err != nil {
			t.Fatalf("insert deleted expense: %v", err)
		}

		if err := saleApplyPhysical(ctx, uow, saleID, time.Now(), nil, []honeySaleLine{{
			Kind: saleKindColony, HiveID: hiveID, Quantity: 1, UnitPrice: 25000,
		}}); err != nil {
			t.Fatalf("apply physical: %v", err)
		}
		if basis := cogsBasis(t, ctx, uow, saleID, "colony"); basis == nil || *basis != 16000 {
			t.Fatalf("cost_basis_cents = %v, want 16000 (feed and deleted excluded)", basis)
		}
		var status string
		if err := uow.QueryRow(ctx, `SELECT status::text FROM hives WHERE id=$1`, hiveID).
			Scan(&status); err != nil {
			t.Fatalf("read hive status: %v", err)
		}
		if status != "sold" {
			t.Fatalf("hive status = %q, want sold", status)
		}
	})
}

func TestSaleColonyCostBasisNilWhenNoBeesQueens(t *testing.T) {
	cogsUnitOfWork(t, func(ctx context.Context, uow *app.UnitOfWork) {
		hiveID := cogsHive(t, ctx, uow)
		saleID := cogsSale(t, ctx, uow)
		if _, err := uow.Exec(ctx, `
			INSERT INTO sale_items (sale_id, kind, hive_id, quantity, unit_price_cents)
			VALUES ($1, 'colony', $2, 1, 25000)`, saleID, hiveID); err != nil {
			t.Fatalf("insert colony line: %v", err)
		}
		if err := saleApplyPhysical(ctx, uow, saleID, time.Now(), nil, []honeySaleLine{{
			Kind: saleKindColony, HiveID: hiveID, Quantity: 1, UnitPrice: 25000,
		}}); err != nil {
			t.Fatalf("apply physical: %v", err)
		}
		if basis := cogsBasis(t, ctx, uow, saleID, "colony"); basis != nil {
			t.Fatalf("cost_basis_cents = %v, want NULL with no bees_queens expenses", basis)
		}
	})
}

func TestSaleUnapplyClearsCostBasisAndReapplyResnapshots(t *testing.T) {
	cogsUnitOfWork(t, func(ctx context.Context, uow *app.UnitOfWork) {
		hiveID := cogsHive(t, ctx, uow)
		unitCost := 2000
		typeID := cogsEquipmentType(t, ctx, uow, &unitCost)
		itemID, stockID := cogsStockItem(t, ctx, uow, typeID, 6)
		saleID := cogsSale(t, ctx, uow)
		if _, err := uow.Exec(ctx, `
			INSERT INTO sale_items (sale_id, kind, hive_id, quantity, unit_price_cents)
			VALUES ($1, 'colony', $2, 1, 25000)`, saleID, hiveID); err != nil {
			t.Fatalf("insert colony line: %v", err)
		}
		if _, err := uow.Exec(ctx, `
			INSERT INTO sale_items (sale_id, kind, item_id, equipment_stock_id, quantity, unit_price_cents)
			VALUES ($1, 'equipment', $2, $3, 2, 4000)`, saleID, itemID, stockID); err != nil {
			t.Fatalf("insert equipment line: %v", err)
		}
		if _, err := uow.Exec(ctx, `
			INSERT INTO expenses (expense_date, category, description, amount_cents, hive_id)
			VALUES (CURRENT_DATE, 'bees_queens', 'Nuc', 10000, $1)`, hiveID); err != nil {
			t.Fatalf("insert expense: %v", err)
		}
		lines := []honeySaleLine{
			{Kind: saleKindColony, HiveID: hiveID, Quantity: 1, UnitPrice: 25000},
			{Kind: saleKindEquipment, ItemID: itemID, Quantity: 2, UnitPrice: 4000},
		}
		if err := saleApplyPhysical(ctx, uow, saleID, time.Now(), nil, lines); err != nil {
			t.Fatalf("apply physical: %v", err)
		}
		if err := saleUnapplyPhysical(ctx, uow, saleID, nil); err != nil {
			t.Fatalf("unapply: %v", err)
		}
		if basis := cogsBasis(t, ctx, uow, saleID, "colony"); basis != nil {
			t.Fatalf("colony basis after unapply = %v, want NULL", basis)
		}
		if basis := cogsBasis(t, ctx, uow, saleID, "equipment"); basis != nil {
			t.Fatalf("equipment basis after unapply = %v, want NULL", basis)
		}
		// The reversal put the gear back and released the hive.
		var onHand int
		if err := uow.QueryRow(ctx, `
			SELECT COALESCE(SUM(on_hand), 0)::int FROM inventory_balances WHERE item_id=$1`,
			itemID).Scan(&onHand); err != nil {
			t.Fatalf("read balance: %v", err)
		}
		if onHand != 6 {
			t.Fatalf("on hand after unapply = %d, want 6", onHand)
		}

		if _, err := uow.Exec(ctx, `
			INSERT INTO expenses (expense_date, category, description, amount_cents, hive_id)
			VALUES (CURRENT_DATE, 'bees_queens', 'extra queen', 2500, $1)`, hiveID); err != nil {
			t.Fatalf("insert extra expense: %v", err)
		}
		if _, err := uow.Exec(ctx,
			`UPDATE equipment_types SET unit_cost_cents = 3000 WHERE id = $1`, typeID); err != nil {
			t.Fatalf("update unit cost: %v", err)
		}
		if err := saleApplyPhysical(ctx, uow, saleID, time.Now(), nil, lines); err != nil {
			t.Fatalf("re-apply physical: %v", err)
		}
		if basis := cogsBasis(t, ctx, uow, saleID, "colony"); basis == nil || *basis != 12500 {
			t.Fatalf("colony basis after re-apply = %v, want 12500", basis)
		}
		if basis := cogsBasis(t, ctx, uow, saleID, "equipment"); basis == nil || *basis != 6000 {
			t.Fatalf("equipment basis after re-apply = %v, want 6000 (2 * 3000)", basis)
		}
	})
}

func TestSaleRestoreClearsCostBasis(t *testing.T) {
	cogsUnitOfWork(t, func(ctx context.Context, uow *app.UnitOfWork) {
		hiveID := cogsHive(t, ctx, uow)
		saleID := cogsSale(t, ctx, uow)
		if _, err := uow.Exec(ctx, `
			INSERT INTO sale_items (sale_id, kind, hive_id, quantity, unit_price_cents)
			VALUES ($1, 'colony', $2, 1, 25000)`, saleID, hiveID); err != nil {
			t.Fatalf("insert colony line: %v", err)
		}
		if _, err := uow.Exec(ctx, `
			INSERT INTO expenses (expense_date, category, description, amount_cents, hive_id)
			VALUES (CURRENT_DATE, 'bees_queens', 'Nuc', 8000, $1)`, hiveID); err != nil {
			t.Fatalf("insert expense: %v", err)
		}
		if err := saleApplyPhysical(ctx, uow, saleID, time.Now(), nil, []honeySaleLine{{
			Kind: saleKindColony, HiveID: hiveID, Quantity: 1, UnitPrice: 25000,
		}}); err != nil {
			t.Fatalf("apply physical: %v", err)
		}
		if err := saleRestorePhysical(ctx, uow, saleID, nil); err != nil {
			t.Fatalf("restore: %v", err)
		}
		if basis := cogsBasis(t, ctx, uow, saleID, "colony"); basis != nil {
			t.Fatalf("cost_basis after restore = %v, want NULL", basis)
		}
	})
}
