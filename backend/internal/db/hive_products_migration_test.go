package db

import (
	"context"
	"os"
	"testing"
	"time"

	"github.com/google/uuid"
)

// TestHiveProductsKindCheckAcceptsNewKinds proves 00020 extends
// sale_items.kind to catalog products and still rejects unknown kinds.
func TestHiveProductsKindCheckAcceptsNewKinds(t *testing.T) {
	if os.Getenv("TEST_DATABASE_URL") == "" {
		t.Skip("TEST_DATABASE_URL is not configured")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
	defer cancel()

	pool, cleanup := freshDatabase(ctx, t, "beez_hive_products")
	defer cleanup()

	if err := migrateTo(pool, 15); err != nil {
		t.Fatalf("migrate to pre-catalog schema: %v", err)
	}

	jarSizeID := uuid.New()
	saleID := uuid.New()
	mustExec(ctx, t, pool, `
		INSERT INTO jar_sizes (id,label,honey_oz,default_price_cents)
		VALUES ($1,'Pint',16,1200)`, jarSizeID)
	mustExec(ctx, t, pool, `
		INSERT INTO sales (id,date,total_amount_cents,discount_amount_cents,amount_paid_cents)
		VALUES ($1, now(), 1200, 0, 1200)`, saleID)
	mustExec(ctx, t, pool, `
		INSERT INTO sale_items (sale_id,kind,jar_size_id,quantity,unit_price_cents)
		VALUES ($1,'jar',$2,1,1200)`, saleID, jarSizeID)

	if _, err := pool.Exec(ctx, `
		INSERT INTO sale_items (sale_id,kind,jar_size_id,quantity,unit_price_cents)
		VALUES ($1,'mead',$2,1,1800)`, saleID, jarSizeID); err == nil {
		t.Fatal("mead kind was accepted before 00020")
	}

	if err := migrate(ctx, pool); err != nil {
		t.Fatalf("migrate forward: %v", err)
	}

	kinds := []string{"creamed_honey", "hot_honey", "mead", "propolis", "tincture"}
	for _, kind := range kinds {
		productID := uuid.New()
		mustExec(ctx, t, pool, `
			INSERT INTO product_catalog (id,name,kind,unit,default_price_cents)
			VALUES ($1,$2,$3,'bottle',1500)`, productID, "Test "+kind, kind)
		mustExec(ctx, t, pool, `
			INSERT INTO sale_items
				(sale_id,kind,product_id,quantity,unit_price_cents)
			VALUES ($1,$2,$3,1,1500)`, saleID, kind, productID)
	}

	var accepted int
	if err := pool.QueryRow(ctx, `
		SELECT COUNT(*) FROM sale_items
		WHERE sale_id=$1 AND kind = ANY($2)`, saleID, kinds).Scan(&accepted); err != nil {
		t.Fatalf("count catalog lines: %v", err)
	}
	if accepted != len(kinds) {
		t.Fatalf("accepted catalog kinds = %d, want %d", accepted, len(kinds))
	}

	if _, err := pool.Exec(ctx, `
		INSERT INTO sale_items (sale_id,kind,product_id,quantity,unit_price_cents)
		VALUES ($1,'soap',$2,1,500)`, saleID, uuid.New()); err == nil {
		t.Fatal("unknown kind soap was accepted after 00020")
	}
}
