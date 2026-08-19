package db

import (
	"context"
	"math"
	"os"
	"testing"
	"time"

	"github.com/google/uuid"
)

func TestMigrationsOnCleanPostgres(t *testing.T) {
	databaseURL := os.Getenv("TEST_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("TEST_DATABASE_URL is not configured")
	}

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	pool, err := Connect(ctx, databaseURL)
	if err != nil {
		t.Fatalf("run migrations: %v", err)
	}
	defer pool.Close()

	// Lower bound rather than an exact match: migrations land from several
	// branches and pinning the number here turns every new migration into a
	// merge conflict. The column/table assertions below are the real check.
	var version int64
	if err := pool.QueryRow(ctx, `SELECT MAX(version_id) FROM goose_db_version WHERE is_applied`).Scan(&version); err != nil {
		t.Fatalf("read migration version: %v", err)
	}
	// Migrations are additive: assert the full roadmap set (00001-00007) is
	// applied; the column/table assertions below are the real check.
	if version < 7 {
		t.Fatalf("migration version = %d, want at least 7", version)
	}

	var lotColumnExists bool
	if err := pool.QueryRow(ctx, `
		SELECT EXISTS(
			SELECT 1 FROM information_schema.columns
			WHERE table_schema='public' AND table_name='sales'
				AND column_name='harvest_lot_id'
		)`).Scan(&lotColumnExists); err != nil {
		t.Fatalf("inspect sales: %v", err)
	}
	if !lotColumnExists {
		t.Fatal("sales.harvest_lot_id was not created")
	}

	// Money is integer cents and the float columns are gone.
	for _, column := range []struct{ table, name string }{
		{"sales", "total_amount_cents"},
		{"sales", "discount_amount_cents"},
		{"sales", "amount_paid_cents"},
		{"sales", "tax_cents"},
		{"sale_items", "unit_price_cents"},
		{"jar_sizes", "default_price_cents"},
		{"expenses", "amount_cents"},
		{"wholesale_price_lists", "minimum_order_amount_cents"},
		{"wholesale_price_list_items", "unit_price_cents"},
		{"honey_movements", "reverses_movement_id"},
		{"honey_movements", "bottling_run_id"},
		{"honey_movements", "product_batch_id"},
		{"sale_items", "product_id"},
		{"product_catalog", "default_price_cents"},
		{"honey_harvests", "deleted_at"},
		{"expenses", "deleted_at"},
		{"sales", "cancelled_at"},
	} {
		var dataType string
		if err := pool.QueryRow(ctx, `
			SELECT data_type FROM information_schema.columns
			WHERE table_schema='public' AND table_name=$1 AND column_name=$2`,
			column.table, column.name).Scan(&dataType); err != nil {
			t.Fatalf("%s.%s missing: %v", column.table, column.name, err)
		}
	}
	for _, column := range []struct{ table, name string }{
		{"sales", "total_amount"},
		{"sale_items", "unit_price"},
		{"jar_sizes", "default_price"},
		{"expenses", "amount"},
	} {
		var exists bool
		if err := pool.QueryRow(ctx, `
			SELECT EXISTS(SELECT 1 FROM information_schema.columns
				WHERE table_schema='public' AND table_name=$1 AND column_name=$2)`,
			column.table, column.name).Scan(&exists); err != nil {
			t.Fatalf("inspect %s.%s: %v", column.table, column.name, err)
		}
		if exists {
			t.Fatalf("float column %s.%s survived the cents migration", column.table, column.name)
		}
	}
	// updated_at + created_by reached every honey/commerce table.
	for _, table := range []string{
		"sales", "sale_items", "honey_movements", "honey_harvests",
		"harvest_sessions", "jar_sizes", "expenses", "bottling_runs",
		"wholesale_price_lists", "wholesale_price_list_items",
		"product_catalog", "propolis_harvests", "product_batches",
	} {
		for _, column := range []string{"updated_at", "created_by"} {
			var exists bool
			if err := pool.QueryRow(ctx, `
				SELECT EXISTS(SELECT 1 FROM information_schema.columns
					WHERE table_schema='public' AND table_name=$1 AND column_name=$2)`,
				table, column).Scan(&exists); err != nil {
				t.Fatalf("inspect %s.%s: %v", table, column, err)
			}
			if !exists {
				t.Fatalf("%s.%s was not created", table, column)
			}
		}
	}

	for _, table := range []string{
		"app_users",
		"apiary_memberships",
		"api_tokens",
		"offline_mutation_receipts",
		"apiary_weather_cache",
		"harvest_session_true_ups",
		"external_sync",
		"product_catalog",
		"propolis_harvests",
		"product_batches",
		"product_batch_expenses",
	} {
		var exists bool
		if err := pool.QueryRow(ctx, `
			SELECT EXISTS(
				SELECT 1 FROM information_schema.tables
				WHERE table_schema='public' AND table_name=$1
			)`, table).Scan(&exists); err != nil {
			t.Fatalf("inspect %s: %v", table, err)
		}
		if !exists {
			t.Fatalf("%s was not created", table)
		}
	}

	apiaryID := uuid.New()
	hiveID := uuid.New()
	inspectionID := uuid.New()
	if _, err := pool.Exec(ctx,
		`INSERT INTO apiaries (id,name) VALUES ($1,'Migration test')`,
		apiaryID); err != nil {
		t.Fatalf("insert test apiary: %v", err)
	}
	if _, err := pool.Exec(ctx,
		`INSERT INTO hives (id,apiary_id,position_label) VALUES ($1,$2,'T1')`,
		hiveID, apiaryID); err != nil {
		t.Fatalf("insert test hive: %v", err)
	}
	if _, err := pool.Exec(ctx,
		`INSERT INTO inspections (id,hive_id,date) VALUES ($1,$2,now())`,
		inspectionID, hiveID); err != nil {
		t.Fatalf("insert test inspection: %v", err)
	}
	if _, err := pool.Exec(ctx, `
		INSERT INTO mite_counts
			(hive_id,inspection_id,date,method,mites_count,sample_size)
		VALUES ($1,$2,now(),'alcohol_wash',6,300)`,
		hiveID, inspectionID); err != nil {
		t.Fatalf("insert roadmap records: %v", err)
	}
	var mitesPer100 float64
	if err := pool.QueryRow(ctx, `
		SELECT mites_per_100 FROM mite_counts WHERE inspection_id=$1`,
		inspectionID).Scan(&mitesPer100); err != nil {
		t.Fatalf("read generated mite rate: %v", err)
	}
	if math.Abs(mitesPer100-2) > 0.0001 {
		t.Fatalf("mites_per_100 = %v, want 2", mitesPer100)
	}

	// The suite may run against a reused database; clear our own fixture row
	// so the uniqueness probe below tests the index, not a previous run.
	if _, err := pool.Exec(ctx,
		`DELETE FROM customers WHERE lower(email)='case@example.com'`); err != nil {
		t.Fatalf("clear customer fixture: %v", err)
	}
	if _, err := pool.Exec(ctx, `
		INSERT INTO customers (name,email) VALUES ('First','CASE@example.com')`); err != nil {
		t.Fatalf("insert first customer: %v", err)
	}
	if _, err := pool.Exec(ctx, `
		INSERT INTO customers (name,email) VALUES ('Duplicate','case@example.com')`); err == nil {
		t.Fatal("case-insensitive customer email uniqueness was not enforced")
	}
}
