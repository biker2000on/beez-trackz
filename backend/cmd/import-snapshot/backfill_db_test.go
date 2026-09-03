package main

import (
	"context"
	"errors"
	"os"
	"strings"
	"testing"
	"time"

	ledgerbackfill "github.com/biker2000on/beez-trackz/backend/internal/app/backfill"
	"github.com/biker2000on/beez-trackz/backend/internal/db"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgconn"
)

func TestEquipmentBackfillFreezesAndRekeys(t *testing.T) {
	adminURL := os.Getenv("TEST_DATABASE_URL")
	if adminURL == "" {
		t.Skip("TEST_DATABASE_URL is not configured")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	url, cleanup := freshImportDatabase(ctx, t, adminURL, "beez_eq_backfill_"+strings.ReplaceAll(uuid.NewString()[:8], "-", ""))
	defer cleanup()
	pool, err := db.Connect(ctx, url)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	var typeID, stockID, adjustmentID uuid.UUID
	if err := pool.QueryRow(ctx, `INSERT INTO equipment_types(name,category)VALUES($1,'box')RETURNING id`, "Backfill box "+uuid.NewString()).Scan(&typeID); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `INSERT INTO equipment_stock(type_id,total_owned)VALUES($1,0)RETURNING id`, typeID).Scan(&stockID); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `INSERT INTO equipment_stock_adjustments(stock_id,quantity,reason,date)VALUES($1,7,'purchased',now())RETURNING id`, stockID).Scan(&adjustmentID); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO external_sync(entity_type,entity_id,sync_state)VALUES('equipment_stock_adjustment',$1,'synced')`, adjustmentID); err != nil {
		t.Fatal(err)
	}
	report, err := ledgerbackfill.Run(ctx, pool, ledgerbackfill.Options{})
	if err != nil {
		t.Fatalf("backfill: %v", err)
	}
	if report.Operations != 1 || report.ExternalSyncRekeyed != 1 {
		t.Fatalf("report=%+v", report)
	}
	var qty int
	if err := pool.QueryRow(ctx, `SELECT SUM(m.quantity)::int FROM inventory_movements m JOIN inventory_operations o ON o.id=m.operation_id WHERE o.legacy_ref_type='equipment_stock_adjustment' AND o.legacy_ref_id=$1`, adjustmentID).Scan(&qty); err != nil || qty != 7 {
		t.Fatalf("translated quantity=%d err=%v", qty, err)
	}
	var entityType string
	if err := pool.QueryRow(ctx, `SELECT entity_type FROM external_sync WHERE id=(SELECT id FROM external_sync LIMIT 1)`).Scan(&entityType); err != nil || entityType != "inventory_operation" {
		t.Fatalf("entity type=%q err=%v", entityType, err)
	}
	var triggers int
	if err := pool.QueryRow(ctx, `SELECT COUNT(*) FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid WHERE t.tgname='inventory_legacy_freeze' AND NOT t.tgisinternal`).Scan(&triggers); err != nil || triggers != len(ledgerbackfill.FreezeTables) {
		t.Fatalf("freeze triggers=%d err=%v", triggers, err)
	}
	_, err = pool.Exec(ctx, `INSERT INTO equipment_stock_adjustments(stock_id,quantity,reason,date)VALUES($1,1,'purchased',now())`, stockID)
	var pgErr *pgconn.PgError
	if !errors.As(err, &pgErr) || pgErr.Code != "55000" {
		t.Fatalf("frozen write error=%v", err)
	}
	replayed, err := ledgerbackfill.Run(ctx, pool, ledgerbackfill.Options{})
	if err != nil || !replayed.AlreadyFrozen || replayed.Operations != 0 {
		t.Fatalf("idempotent rerun report=%+v err=%v", replayed, err)
	}
}

func TestNegativeResidualRollsBackLedgerAndFreeze(t *testing.T) {
	adminURL := os.Getenv("TEST_DATABASE_URL")
	if adminURL == "" {
		t.Skip("TEST_DATABASE_URL is not configured")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	url, cleanup := freshImportDatabase(ctx, t, adminURL, "beez_eq_residual_"+strings.ReplaceAll(uuid.NewString()[:8], "-", ""))
	defer cleanup()
	pool, err := db.Connect(ctx, url)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	if _, err := pool.Exec(ctx, `INSERT INTO harvest_lots(lot_code,public_slug,extraction_date,honey_weight_lbs)VALUES($1,$2,current_date,10)`, "NEG-"+uuid.NewString(), "neg-"+uuid.NewString()); err != nil {
		t.Fatal(err)
	}
	if _, err := ledgerbackfill.Run(ctx, pool, ledgerbackfill.Options{}); err == nil || !strings.Contains(err.Error(), "negative unassigned bulk residual") {
		t.Fatalf("error=%v", err)
	}
	var operations int
	if err := pool.QueryRow(ctx, `SELECT COUNT(*) FROM inventory_operations`).Scan(&operations); err != nil || operations != 0 {
		t.Fatalf("operations=%d err=%v", operations, err)
	}
	var frozen bool
	if err := pool.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM pg_trigger WHERE tgname='inventory_legacy_freeze' AND NOT tgisinternal)`).Scan(&frozen); err != nil || frozen {
		t.Fatalf("frozen=%v err=%v", frozen, err)
	}
}
