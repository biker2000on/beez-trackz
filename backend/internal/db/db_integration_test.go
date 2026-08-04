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

	var version int64
	if err := pool.QueryRow(ctx, `SELECT MAX(version_id) FROM goose_db_version WHERE is_applied`).Scan(&version); err != nil {
		t.Fatalf("read migration version: %v", err)
	}
	// Migrations are additive: assert the baseline schema this test covers is
	// applied rather than pinning the newest version number, which every new
	// migration would otherwise break.
	if version < 3 {
		t.Fatalf("migration version = %d, want at least 3", version)
	}

	var lotColumnExists bool
	if err := pool.QueryRow(ctx, `
		SELECT EXISTS(
			SELECT 1 FROM information_schema.columns
			WHERE table_schema='public' AND table_name='honey_sales'
				AND column_name='harvest_lot_id'
		)`).Scan(&lotColumnExists); err != nil {
		t.Fatalf("inspect honey_sales: %v", err)
	}
	if !lotColumnExists {
		t.Fatal("honey_sales.harvest_lot_id was not created")
	}

	for _, table := range []string{
		"app_users",
		"apiary_memberships",
		"api_tokens",
		"offline_mutation_receipts",
		"apiary_weather_cache",
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

	if _, err := pool.Exec(ctx, `
		INSERT INTO customers (name,email) VALUES ('First','CASE@example.com')`); err != nil {
		t.Fatalf("insert first customer: %v", err)
	}
	if _, err := pool.Exec(ctx, `
		INSERT INTO customers (name,email) VALUES ('Duplicate','case@example.com')`); err == nil {
		t.Fatal("case-insensitive customer email uniqueness was not enforced")
	}
}
