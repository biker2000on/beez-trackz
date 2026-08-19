package db

import (
	"context"
	"os"
	"testing"
	"time"

	"github.com/google/uuid"
)

// TestSalesKindsMigrationCarriesJarRows proves 00015 renames honey_sales to
// sales and stamps existing line items as kind=jar with jar_size_id set.
func TestSalesKindsMigrationCarriesJarRows(t *testing.T) {
	if os.Getenv("TEST_DATABASE_URL") == "" {
		t.Skip("TEST_DATABASE_URL is not configured")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()

	pool, cleanup := freshDatabase(ctx, t, "beez_sales_kinds")
	defer cleanup()

	if err := migrateTo(pool, 14); err != nil {
		t.Fatalf("migrate to pre-kinds schema: %v", err)
	}

	jarSizeID := uuid.New()
	saleID := uuid.New()
	mustExec(ctx, t, pool, `
		INSERT INTO jar_sizes (id,label,honey_oz,default_price_cents)
		VALUES ($1,'Pint',16,1200)`, jarSizeID)
	mustExec(ctx, t, pool, `
		INSERT INTO honey_sales (id,date,total_amount_cents,discount_amount_cents,amount_paid_cents)
		VALUES ($1, now(), 2400, 0, 2400)`, saleID)
	mustExec(ctx, t, pool, `
		INSERT INTO honey_sale_items (sale_id,jar_size_id,quantity,unit_price_cents)
		VALUES ($1,$2,2,1200)`, saleID, jarSizeID)

	if err := migrate(ctx, pool); err != nil {
		t.Fatalf("migrate forward: %v", err)
	}

	var kind string
	var jarID uuid.UUID
	var hiveID, stockID *uuid.UUID
	if err := pool.QueryRow(ctx, `
		SELECT kind, jar_size_id, hive_id, equipment_stock_id
		FROM sale_items WHERE sale_id=$1`, saleID).
		Scan(&kind, &jarID, &hiveID, &stockID); err != nil {
		t.Fatalf("read migrated sale item: %v", err)
	}
	if kind != "jar" {
		t.Errorf("kind = %q, want jar", kind)
	}
	if jarID != jarSizeID {
		t.Errorf("jar_size_id = %s, want %s", jarID, jarSizeID)
	}
	if hiveID != nil || stockID != nil {
		t.Errorf("hive/stock targets should be null, got %v / %v", hiveID, stockID)
	}

	var oldExists bool
	if err := pool.QueryRow(ctx, `
		SELECT EXISTS(
			SELECT 1 FROM information_schema.tables
			WHERE table_schema='public' AND table_name='honey_sales')`).
		Scan(&oldExists); err != nil {
		t.Fatalf("inspect old table: %v", err)
	}
	if oldExists {
		t.Error("honey_sales still exists after 00015")
	}
}
