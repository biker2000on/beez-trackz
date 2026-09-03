package db

import (
	"context"
	"os"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/stdlib"
	"github.com/pressly/goose/v3"
)

// TestExternalSyncMigrationRenamesHoneySaleRows proves 00041 can rewrite a
// live honey_sale row. The old CHECK still forbids 'sale' while it is in
// force, so the rename UPDATEs must run after DROP CONSTRAINT; seeding the
// pre-00015 spelling before 00041 applies is what an empty-table migration
// would miss.
func TestExternalSyncMigrationRenamesHoneySaleRows(t *testing.T) {
	if os.Getenv("TEST_DATABASE_URL") == "" {
		t.Skip("TEST_DATABASE_URL is not configured")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
	defer cancel()

	pool, cleanup := freshDatabase(ctx, t, "beez_ext_sync_types")
	defer cleanup()

	if err := migrateTo(pool, 40); err != nil {
		t.Fatalf("migrate to pre-00041 schema: %v", err)
	}

	saleEntity := uuid.New()
	itemEntity := uuid.New()
	mustExec(ctx, t, pool, `
		INSERT INTO external_sync (system, entity_type, entity_id)
		VALUES ('gnucash_web', 'honey_sale', $1)`, saleEntity)
	mustExec(ctx, t, pool, `
		INSERT INTO external_sync (system, entity_type, entity_id)
		VALUES ('gnucash_web', 'honey_sale_item', $1)`, itemEntity)

	if err := migrate(ctx, pool); err != nil {
		t.Fatalf("migrate forward: %v", err)
	}

	var saleType, itemType string
	if err := pool.QueryRow(ctx, `
		SELECT entity_type FROM external_sync WHERE entity_id=$1`, saleEntity).
		Scan(&saleType); err != nil {
		t.Fatalf("read renamed sale row: %v", err)
	}
	if saleType != "sale" {
		t.Errorf("entity_type = %q, want sale", saleType)
	}
	if err := pool.QueryRow(ctx, `
		SELECT entity_type FROM external_sync WHERE entity_id=$1`, itemEntity).
		Scan(&itemType); err != nil {
		t.Fatalf("read renamed sale_item row: %v", err)
	}
	if itemType != "sale_item" {
		t.Errorf("entity_type = %q, want sale_item", itemType)
	}

	// Down has the mirror CHECK problem: 'honey_sale' is not on the new
	// allowlist, so the constraint must drop before the reverse UPDATEs.
	goose.SetBaseFS(migrationsFS)
	if err := goose.SetDialect("postgres"); err != nil {
		t.Fatalf("set dialect: %v", err)
	}
	sqlDB := stdlib.OpenDBFromPool(pool)
	if err := goose.DownTo(sqlDB, "migrations", 40); err != nil {
		sqlDB.Close()
		t.Fatalf("migrate 00041 down: %v", err)
	}
	sqlDB.Close()

	if err := pool.QueryRow(ctx, `
		SELECT entity_type FROM external_sync WHERE entity_id=$1`, saleEntity).
		Scan(&saleType); err != nil {
		t.Fatalf("read sale row after down: %v", err)
	}
	if saleType != "honey_sale" {
		t.Errorf("entity_type after down = %q, want honey_sale", saleType)
	}
}
