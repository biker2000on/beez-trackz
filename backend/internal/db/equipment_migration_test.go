package db

import (
	"context"
	"fmt"
	"net/url"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/jackc/pgx/v5/stdlib"
	"github.com/pressly/goose/v3"
)

// The equipment ledger migration (00006) has to be safe on a database that
// already carries the mess it is fixing: several stock rows for one type, a
// total_owned that no longer matches its adjustments, and returns recorded as
// a bare date. This test builds exactly that database at the pre-equipment
// schema version and then migrates it forward.
func TestEquipmentLedgerMigrationOnLegacyData(t *testing.T) {
	databaseURL := os.Getenv("TEST_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("TEST_DATABASE_URL is not configured")
	}

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
	defer cancel()

	legacyName := "beez_equip_legacy_" + strings.ReplaceAll(uuid.NewString()[:8], "-", "")
	admin, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	if _, err := admin.Exec(ctx, "CREATE DATABASE "+legacyName); err != nil {
		admin.Close()
		t.Skipf("cannot create a scratch database: %v", err)
	}
	admin.Close()
	defer func() {
		cleanup, err := pgxpool.New(context.Background(), databaseURL)
		if err != nil {
			return
		}
		defer cleanup.Close()
		_, _ = cleanup.Exec(context.Background(),
			"DROP DATABASE IF EXISTS "+legacyName+" WITH (FORCE)")
	}()

	legacyURL, err := replaceDatabaseName(databaseURL, legacyName)
	if err != nil {
		t.Fatalf("build scratch database URL: %v", err)
	}
	pool, err := openPool(ctx, legacyURL)
	if err != nil {
		t.Fatalf("connect scratch database: %v", err)
	}
	defer pool.Close()

	// Stop at the last migration before the equipment ledger existed.
	goose.SetBaseFS(legacyChainFS)
	if err := goose.SetDialect("postgres"); err != nil {
		t.Fatalf("set dialect: %v", err)
	}
	sqlDB := stdlib.OpenDBFromPool(pool)
	if err := goose.UpTo(sqlDB, LegacyChainDir, 3); err != nil {
		sqlDB.Close()
		t.Fatalf("migrate to the pre-equipment-ledger schema: %v", err)
	}

	// --- legacy data, warts included ---

	var typeID uuid.UUID
	if err := pool.QueryRow(ctx, `
		INSERT INTO equipment_types (name, category, frames_per_box)
		VALUES ('Legacy Deep Box', 'box', 10) RETURNING id`).Scan(&typeID); err != nil {
		t.Fatalf("insert type: %v", err)
	}

	// Two stock rows for one type — the split the migration has to collapse.
	var stockA, stockB uuid.UUID
	if err := pool.QueryRow(ctx, `
		INSERT INTO equipment_stock (type_id, total_owned, storage_location)
		VALUES ($1, 12, 'Garage') RETURNING id`, typeID).Scan(&stockA); err != nil {
		t.Fatalf("insert stock A: %v", err)
	}
	if err := pool.QueryRow(ctx, `
		INSERT INTO equipment_stock (type_id, total_owned) VALUES ($1, 5) RETURNING id`,
		typeID).Scan(&stockB); err != nil {
		t.Fatalf("insert stock B: %v", err)
	}

	// Row A's ledger only accounts for 10 of its 12 units: two units of drift.
	if _, err := pool.Exec(ctx, `
		INSERT INTO equipment_stock_adjustments (stock_id, quantity, reason, date)
		VALUES ($1, 10, 'purchased', now())`, stockA); err != nil {
		t.Fatalf("insert adjustment A: %v", err)
	}
	if _, err := pool.Exec(ctx, `
		INSERT INTO equipment_stock_adjustments (stock_id, quantity, reason, date)
		VALUES ($1, 5, 'built', now())`, stockB); err != nil {
		t.Fatalf("insert adjustment B: %v", err)
	}

	var apiaryID, hiveID uuid.UUID
	if err := pool.QueryRow(ctx,
		`INSERT INTO apiaries (name) VALUES ('Legacy') RETURNING id`).Scan(&apiaryID); err != nil {
		t.Fatalf("insert apiary: %v", err)
	}
	if err := pool.QueryRow(ctx,
		`INSERT INTO hives (apiary_id, position_label) VALUES ($1, 'L1') RETURNING id`,
		apiaryID).Scan(&hiveID); err != nil {
		t.Fatalf("insert hive: %v", err)
	}
	// One deployment still out, one already returned the old date-only way.
	if _, err := pool.Exec(ctx, `
		INSERT INTO equipment_deployments (stock_id, hive_id, quantity, date_deployed)
		VALUES ($1, $2, 4, now())`, stockB, hiveID); err != nil {
		t.Fatalf("insert active deployment: %v", err)
	}
	if _, err := pool.Exec(ctx, `
		INSERT INTO equipment_deployments
			(stock_id, hive_id, quantity, date_deployed, date_removed)
		VALUES ($1, $2, 2, now() - interval '30 days', now() - interval '2 days')`,
		stockA, hiveID); err != nil {
		t.Fatalf("insert returned deployment: %v", err)
	}

	// --- migrate forward ---

	if err := goose.Up(sqlDB, LegacyChainDir); err != nil {
		sqlDB.Close()
		t.Fatalf("apply the equipment ledger migration: %v", err)
	}
	sqlDB.Close()

	var rows int
	if err := pool.QueryRow(ctx,
		`SELECT count(*) FROM equipment_stock WHERE type_id = $1`, typeID).Scan(&rows); err != nil {
		t.Fatalf("count stock rows: %v", err)
	}
	if rows != 1 {
		t.Fatalf("%d stock rows survived the merge, want 1", rows)
	}

	var owned, deployed, available int
	var location *string
	if err := pool.QueryRow(ctx, `
		SELECT total_owned, deployed, available, storage_location
		FROM equipment_stock_status WHERE type_id = $1`, typeID).
		Scan(&owned, &deployed, &available, &location); err != nil {
		t.Fatalf("read merged status: %v", err)
	}
	// 12 (stored, drift preserved) + 5 = 17 owned, 4 still deployed.
	if owned != 17 {
		t.Fatalf("merged totalOwned = %d, want 17", owned)
	}
	if deployed != 4 {
		t.Fatalf("merged deployed = %d, want 4 (the returned deployment must not count)", deployed)
	}
	if available != 13 {
		t.Fatalf("merged available = %d, want 13", available)
	}
	if location == nil || *location != "Garage" {
		t.Fatalf("storage location = %v, want it carried onto the surviving row", location)
	}

	var reconciled bool
	if err := pool.QueryRow(ctx, `
		SELECT bool_and(reconciled) FROM equipment_stock_reconciliation`).Scan(&reconciled); err != nil {
		t.Fatalf("read reconciliation: %v", err)
	}
	if !reconciled {
		t.Fatal("stock rows did not reconcile with their ledgers after migrating")
	}

	// The drift was written into the ledger instead of being silently dropped.
	var reconciliationEntries int
	if err := pool.QueryRow(ctx, `
		SELECT count(*) FROM equipment_stock_adjustments
		WHERE notes LIKE 'Ledger reconciliation (migration 00006)%'`).
		Scan(&reconciliationEntries); err != nil {
		t.Fatalf("count reconciliation entries: %v", err)
	}
	if reconciliationEntries != 1 {
		t.Fatalf("%d reconciliation entries, want 1", reconciliationEntries)
	}

	// The old date-only return became a real return ledger entry.
	var returns, returnedQuantity int
	if err := pool.QueryRow(ctx, `
		SELECT count(*), COALESCE(SUM(quantity), 0)::int
		FROM equipment_deployment_returns`).Scan(&returns, &returnedQuantity); err != nil {
		t.Fatalf("count migrated returns: %v", err)
	}
	if returns != 1 || returnedQuantity != 2 {
		t.Fatalf("migrated returns = %d rows / %d units, want 1 / 2", returns, returnedQuantity)
	}
}

// replaceDatabaseName swaps the database in a Postgres URL.
func replaceDatabaseName(raw, name string) (string, error) {
	parsed, err := url.Parse(raw)
	if err != nil {
		return "", fmt.Errorf("parse database url: %w", err)
	}
	parsed.Path = "/" + name
	return parsed.String(), nil
}
