package db

import (
	"context"
	"fmt"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/jackc/pgx/v5/stdlib"
	"github.com/pressly/goose/v3"
)

// TestMoneyMigrationConvertsExistingRows is the production-safety check for
// migration 00004. It migrates a database to the pre-cents schema, writes the
// kind of rows the live database already holds (sales, sale items, expenses,
// jar prices, price lists), then migrates forward and asserts that every amount
// survived as the exact integer cents it should be.
func TestMoneyMigrationConvertsExistingRows(t *testing.T) {
	databaseURL := os.Getenv("TEST_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("TEST_DATABASE_URL is not configured")
	}

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
	defer cancel()

	pool, cleanup := freshDatabase(ctx, t, "beez_money_migration")
	defer cleanup()

	if err := migrateTo(pool, 3); err != nil {
		t.Fatalf("migrate to pre-cents schema: %v", err)
	}

	apiaryID := uuid.New()
	jarSizeID := uuid.New()
	saleID := uuid.New()
	priceListID := uuid.New()
	mustExec(ctx, t, pool, `INSERT INTO apiaries (id,name) VALUES ($1,'Money test')`, apiaryID)
	// 12.34 and 0.1+0.2-style values are exactly the cases float dollars get
	// wrong; 1.005 is the classic binary-representation trap.
	mustExec(ctx, t, pool, `
		INSERT INTO jar_sizes (id,label,honey_oz,default_price) VALUES ($1,'Pint',22,12.34)`, jarSizeID)
	mustExec(ctx, t, pool, `
		INSERT INTO honey_sales (id,date,total_amount,discount_amount,amount_paid)
		VALUES ($1, now(), 61.70, 1.005, 60.695)`, saleID)
	mustExec(ctx, t, pool, `
		INSERT INTO honey_sale_items (sale_id,jar_size_id,quantity,unit_price)
		VALUES ($1,$2,5,12.34)`, saleID, jarSizeID)
	mustExec(ctx, t, pool, `
		INSERT INTO expenses (expense_date,category,description,amount)
		VALUES (CURRENT_DATE,'feed','Sugar',249.99)`)
	mustExec(ctx, t, pool, `
		INSERT INTO wholesale_price_lists (id,name,minimum_order_amount)
		VALUES ($1,'Co-op',150.00)`, priceListID)
	mustExec(ctx, t, pool, `
		INSERT INTO wholesale_price_list_items (price_list_id,jar_size_id,unit_price)
		VALUES ($1,$2,9.75)`, priceListID, jarSizeID)

	if err := migrate(ctx, pool); err != nil {
		t.Fatalf("migrate forward: %v", err)
	}

	checks := []struct {
		name  string
		query string
		want  int64
	}{
		{"sale total", `SELECT total_amount_cents FROM sales`, 6170},
		{"sale discount (half-up)", `SELECT discount_amount_cents FROM sales`, 101},
		{"sale amount paid", `SELECT amount_paid_cents FROM sales`, 6070},
		{"sale item unit price", `SELECT unit_price_cents FROM sale_items`, 1234},
		{"jar default price", `SELECT default_price_cents FROM jar_sizes`, 1234},
		{"expense amount", `SELECT amount_cents FROM expenses`, 24999},
		{"price list minimum", `SELECT minimum_order_amount_cents FROM wholesale_price_lists`, 15000},
		{"price list item", `SELECT unit_price_cents FROM wholesale_price_list_items`, 975},
	}
	for _, check := range checks {
		var got int64
		if err := pool.QueryRow(ctx, check.query).Scan(&got); err != nil {
			t.Fatalf("%s: %v", check.name, err)
		}
		if got != check.want {
			t.Errorf("%s = %d cents, want %d", check.name, got, check.want)
		}
	}

	// No row was lost.
	for table, want := range map[string]int{
		"sales": 1, "sale_items": 1, "expenses": 1,
		"jar_sizes": 1, "wholesale_price_lists": 1, "wholesale_price_list_items": 1,
	} {
		var count int
		if err := pool.QueryRow(ctx, "SELECT COUNT(*) FROM "+table).Scan(&count); err != nil {
			t.Fatalf("count %s: %v", table, err)
		}
		if count != want {
			t.Errorf("%s has %d rows after migration, want %d", table, count, want)
		}
	}

	// tax_cents is added but never invented.
	var taxIsNull bool
	if err := pool.QueryRow(ctx, `SELECT tax_cents IS NULL FROM sales`).Scan(&taxIsNull); err != nil {
		t.Fatalf("read tax_cents: %v", err)
	}
	if !taxIsNull {
		t.Error("tax_cents was populated for a historical sale")
	}
}

// TestLedgerMigrationBackfillsJarringPounds proves migration 00005 gives the
// shared bulk-on-hand formula a defined value for jarring rows written before
// amount_lbs was always populated.
func TestLedgerMigrationBackfillsJarringPounds(t *testing.T) {
	databaseURL := os.Getenv("TEST_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("TEST_DATABASE_URL is not configured")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
	defer cancel()

	pool, cleanup := freshDatabase(ctx, t, "beez_ledger_migration")
	defer cleanup()

	if err := migrateTo(pool, 3); err != nil {
		t.Fatalf("migrate to pre-ledger schema: %v", err)
	}
	withOz := uuid.New()
	withoutOz := uuid.New()
	mustExec(ctx, t, pool, `INSERT INTO jar_sizes (id,label,honey_oz) VALUES ($1,'Pint',16)`, withOz)
	mustExec(ctx, t, pool, `INSERT INTO jar_sizes (id,label) VALUES ($1,'Unknown')`, withoutOz)
	mustExec(ctx, t, pool, `
		INSERT INTO honey_movements (date,kind,jar_size_id,quantity)
		VALUES (now(),'jarring',$1,10), (now(),'jarring',$2,4)`, withOz, withoutOz)

	if err := migrate(ctx, pool); err != nil {
		t.Fatalf("migrate forward: %v", err)
	}

	var knownLbs, unknownLbs float64
	if err := pool.QueryRow(ctx, `
		SELECT
			(SELECT amount_lbs FROM honey_movements WHERE jar_size_id=$1),
			(SELECT amount_lbs FROM honey_movements WHERE jar_size_id=$2)`,
		withOz, withoutOz).Scan(&knownLbs, &unknownLbs); err != nil {
		t.Fatalf("read backfilled pounds: %v", err)
	}
	if knownLbs != 10 {
		t.Errorf("backfilled pounds = %v, want 10", knownLbs)
	}
	if unknownLbs != 0 {
		t.Errorf("pounds for a size with no honey_oz = %v, want an explicit 0", unknownLbs)
	}
}

// --- helpers ---

// freshDatabase creates an empty database beside the configured test database
// so a partial-migration test never disturbs the shared one.
func freshDatabase(ctx context.Context, t *testing.T, name string) (*pgxpool.Pool, func()) {
	t.Helper()
	adminURL := os.Getenv("TEST_DATABASE_URL")
	admin, err := pgxpool.New(ctx, adminURL)
	if err != nil {
		t.Fatalf("connect admin: %v", err)
	}
	// WITH (FORCE): pgxpool.Close returns before Postgres reaps the backends,
	// so a straggler from the previous run would otherwise fail the drop
	// with 55006 and take the whole test with it.
	if _, err := admin.Exec(ctx, fmt.Sprintf("DROP DATABASE IF EXISTS %s WITH (FORCE)", name)); err != nil {
		admin.Close()
		t.Fatalf("drop database: %v", err)
	}
	if _, err := admin.Exec(ctx, fmt.Sprintf("CREATE DATABASE %s", name)); err != nil {
		admin.Close()
		t.Fatalf("create database: %v", err)
	}

	pool, err := pgxpool.New(ctx, replaceDatabase(adminURL, name))
	if err != nil {
		admin.Close()
		t.Fatalf("connect %s: %v", name, err)
	}
	return pool, func() {
		pool.Close()
		_, _ = admin.Exec(context.Background(), fmt.Sprintf("DROP DATABASE IF EXISTS %s WITH (FORCE)", name))
		admin.Close()
	}
}

func replaceDatabase(databaseURL, name string) string {
	base, query, hasQuery := strings.Cut(databaseURL, "?")
	slash := strings.LastIndex(base, "/")
	replaced := base[:slash+1] + name
	if hasQuery {
		return replaced + "?" + query
	}
	return replaced
}

func migrateTo(pool *pgxpool.Pool, version int64) error {
	goose.SetBaseFS(legacyChainFS)
	if err := goose.SetDialect("postgres"); err != nil {
		return err
	}
	sqlDB := stdlib.OpenDBFromPool(pool)
	defer sqlDB.Close()
	return goose.UpTo(sqlDB, LegacyChainDir, version)
}

func mustExec(ctx context.Context, t *testing.T, pool *pgxpool.Pool, sql string, args ...any) {
	t.Helper()
	if _, err := pool.Exec(ctx, sql, args...); err != nil {
		t.Fatalf("exec %q: %v", sql, err)
	}
}
