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
	"github.com/biker2000on/beez-trackz/backend/internal/snapshot"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

func TestEquipmentBackfillFreezesAndRekeys(t *testing.T) {
	adminURL := os.Getenv("TEST_DATABASE_URL")
	if adminURL == "" {
		t.Skip("TEST_DATABASE_URL is not configured")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Minute)
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

func TestEquipmentBackfillSynthesizesPositiveOpeningResidual(t *testing.T) {
	adminURL := os.Getenv("TEST_DATABASE_URL")
	if adminURL == "" {
		t.Skip("TEST_DATABASE_URL is not configured")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Minute)
	defer cancel()
	url, cleanup := freshImportDatabase(ctx, t, adminURL, "beez_eq_opening_"+strings.ReplaceAll(uuid.NewString()[:8], "-", ""))
	defer cleanup()
	pool, err := db.Connect(ctx, url)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	var typeID, stockID uuid.UUID
	if err := pool.QueryRow(ctx, `INSERT INTO equipment_types(name,category)VALUES($1,'box')RETURNING id`, "Opening box "+uuid.NewString()).Scan(&typeID); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `ALTER TABLE equipment_stock DISABLE TRIGGER equipment_stock_reconcile`); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `INSERT INTO equipment_stock(type_id,total_owned)VALUES($1,7)RETURNING id`, typeID).Scan(&stockID); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `ALTER TABLE equipment_stock ENABLE TRIGGER equipment_stock_reconcile`); err != nil {
		t.Fatal(err)
	}

	report, err := ledgerbackfill.Run(ctx, pool, ledgerbackfill.Options{})
	if err != nil {
		t.Fatalf("backfill: %v", err)
	}
	if report.Operations != 1 {
		t.Fatalf("operations=%d, want one opening balance", report.Operations)
	}
	var kind, reason, provenance, detailReason, legacyType string
	var legacyID uuid.UUID
	var quantity int
	if err := pool.QueryRow(ctx, `
		SELECT o.kind,o.reason,o.provenance,o.details->>'reason',o.legacy_ref_type,o.legacy_ref_id,m.quantity::int
		FROM inventory_operations o JOIN inventory_movements m ON m.operation_id=o.id
		WHERE o.legacy_ref_type='equipment_stock' AND o.legacy_ref_id=$1`, stockID).
		Scan(&kind, &reason, &provenance, &detailReason, &legacyType, &legacyID, &quantity); err != nil {
		t.Fatal(err)
	}
	if kind != "opening_balance" || reason != "none" || provenance != "legacy-import" || detailReason != "equipment-opening-residual" || legacyType != "equipment_stock" || legacyID != stockID || quantity != 7 {
		t.Fatalf("opening operation=%s/%s/%s detail=%q legacy=%s/%s quantity=%d", kind, reason, provenance, detailReason, legacyType, legacyID, quantity)
	}
}

func TestEquipmentBackfillRejectsNegativeOpeningResidual(t *testing.T) {
	adminURL := os.Getenv("TEST_DATABASE_URL")
	if adminURL == "" {
		t.Skip("TEST_DATABASE_URL is not configured")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Minute)
	defer cancel()
	url, cleanup := freshImportDatabase(ctx, t, adminURL, "beez_eq_neg_opening_"+strings.ReplaceAll(uuid.NewString()[:8], "-", ""))
	defer cleanup()
	pool, err := db.Connect(ctx, url)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	var typeID, stockID uuid.UUID
	if err := pool.QueryRow(ctx, `INSERT INTO equipment_types(name,category)VALUES($1,'box')RETURNING id`, "Negative opening box "+uuid.NewString()).Scan(&typeID); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `INSERT INTO equipment_stock(type_id,total_owned)VALUES($1,0)RETURNING id`, typeID).Scan(&stockID); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO equipment_stock_adjustments(stock_id,quantity,reason,date)VALUES($1,3,'purchased',now())`, stockID); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `ALTER TABLE equipment_stock DISABLE TRIGGER equipment_stock_reconcile`); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `UPDATE equipment_stock SET total_owned=2 WHERE id=$1`, stockID); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `ALTER TABLE equipment_stock ENABLE TRIGGER equipment_stock_reconcile`); err != nil {
		t.Fatal(err)
	}
	if _, err := ledgerbackfill.Run(ctx, pool, ledgerbackfill.Options{}); err == nil || !strings.Contains(err.Error(), "negative opening residual -1") {
		t.Fatalf("error=%v", err)
	}
	var operations int
	if err := pool.QueryRow(ctx, `SELECT COUNT(*) FROM inventory_operations`).Scan(&operations); err != nil || operations != 0 {
		t.Fatalf("operations=%d err=%v", operations, err)
	}
}

func TestNegativeResidualRollsBackLedgerAndFreeze(t *testing.T) {
	adminURL := os.Getenv("TEST_DATABASE_URL")
	if adminURL == "" {
		t.Skip("TEST_DATABASE_URL is not configured")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Minute)
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

func TestDrawBeforeReceiptInjectsReconcilesAndFreezes(t *testing.T) {
	adminURL := os.Getenv("TEST_DATABASE_URL")
	if adminURL == "" {
		t.Skip("TEST_DATABASE_URL is not configured")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Minute)
	defer cancel()
	url, cleanup := freshImportDatabase(ctx, t, adminURL, "beez_draw_before_receipt_"+strings.ReplaceAll(uuid.NewString()[:8], "-", ""))
	defer cleanup()
	pool, err := db.Connect(ctx, url)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()

	apiaryID, hiveID, harvestID, jarSizeID := uuid.New(), uuid.New(), uuid.New(), uuid.New()
	saleAt := time.Date(2022, 9, 11, 0, 0, 0, 0, time.UTC)
	jarringAt := time.Date(2023, 7, 3, 0, 0, 0, 0, time.UTC)
	commands := []struct {
		sql  string
		args []any
	}{
		{`INSERT INTO apiaries(id,name)VALUES($1,$2)`, []any{apiaryID, "Draw-before-receipt apiary " + uuid.NewString()}},
		{`INSERT INTO hives(id,apiary_id,position_label)VALUES($1,$2,'A1')`, []any{hiveID, apiaryID}},
		{`INSERT INTO honey_harvests(id,hive_id,date,super_weight_before,super_weight_after,calculated_honey_weight)VALUES($1,$2,$3,1,0,1)`, []any{harvestID, hiveID, saleAt.Add(-24 * time.Hour)}},
		{`INSERT INTO jar_sizes(id,label,honey_oz)VALUES($1,$2,8)`, []any{jarSizeID, "Draw-before-receipt jar " + uuid.NewString()}},
		{`INSERT INTO honey_movements(date,kind,amount_lbs,jar_size_id,quantity)VALUES($1,'jarring',1,$2,2)`, []any{jarringAt, jarSizeID}},
	}
	for _, command := range commands {
		if _, err := pool.Exec(ctx, command.sql, command.args...); err != nil {
			t.Fatalf("seed fixture: %v\n%s", err, command.sql)
		}
	}
	var saleID uuid.UUID
	if err := pool.QueryRow(ctx, `INSERT INTO sales(date,total_amount_cents,amount_paid_cents,order_status,physical_applied_at)VALUES($1,1000,1000,'paid',$1)RETURNING id`, saleAt).Scan(&saleID); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO sale_items(sale_id,jar_size_id,quantity,unit_price_cents,kind)VALUES($1,$2,2,500,'jar')`, saleID, jarSizeID); err != nil {
		t.Fatal(err)
	}

	report, err := ledgerbackfill.Run(ctx, pool, ledgerbackfill.Options{})
	if err != nil {
		t.Fatalf("backfill: %v", err)
	}
	if len(report.DrawBeforeReceiptInjections) != 1 || len(report.DrawBeforeReceiptReconciles) != 1 {
		t.Fatalf("draw-before-receipt report=%+v", report)
	}
	injection, reconcile := report.DrawBeforeReceiptInjections[0], report.DrawBeforeReceiptReconciles[0]
	if injection.ItemID == uuid.Nil || injection.LocationID == uuid.Nil || injection.LotID == uuid.Nil || injection.Quantity != "2" || !strings.HasPrefix(injection.Source, "sale_item:") {
		t.Fatalf("injection=%+v", injection)
	}
	if reconcile.ItemID != injection.ItemID || reconcile.LocationID != injection.LocationID || reconcile.LotID != injection.LotID || reconcile.Quantity != "-2" || reconcile.Source != "home_jar:"+jarSizeID.String() {
		t.Fatalf("reconcile=%+v injection=%+v", reconcile, injection)
	}
	var injectionReason, reconcileReason string
	var injectionAt, reconcileAt time.Time
	if err := pool.QueryRow(ctx, `SELECT details->>'reason',occurred_at FROM inventory_operations WHERE id=$1`, injection.OperationID).Scan(&injectionReason, &injectionAt); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `SELECT details->>'reason',occurred_at FROM inventory_operations WHERE id=$1`, reconcile.OperationID).Scan(&reconcileReason, &reconcileAt); err != nil {
		t.Fatal(err)
	}
	if injectionReason != "draw-before-receipt" || !injectionAt.Equal(saleAt) || reconcileReason != "draw-before-receipt-reconcile" || !reconcileAt.Equal(jarringAt) {
		t.Fatalf("injection=%q@%s reconcile=%q@%s", injectionReason, injectionAt, reconcileReason, reconcileAt)
	}
	var available, triggers int
	if err := pool.QueryRow(ctx, `SELECT COALESCE(SUM(a.available),0)::int FROM inventory_available a JOIN inventory_items i ON i.id=a.item_id WHERE i.source_type='jar_size' AND i.source_id=$1`, jarSizeID).Scan(&available); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `SELECT COUNT(*) FROM pg_trigger WHERE tgname='inventory_legacy_freeze' AND NOT tgisinternal`).Scan(&triggers); err != nil {
		t.Fatal(err)
	}
	if available != 0 || triggers != len(ledgerbackfill.FreezeTables) {
		t.Fatalf("parity available=%d freeze triggers=%d", available, triggers)
	}
}

func TestDrawBeforeReceiptDoesNotTopUpNamedLot(t *testing.T) {
	adminURL := os.Getenv("TEST_DATABASE_URL")
	if adminURL == "" {
		t.Skip("TEST_DATABASE_URL is not configured")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Minute)
	defer cancel()
	url, cleanup := freshImportDatabase(ctx, t, adminURL, "beez_named_draw_"+strings.ReplaceAll(uuid.NewString()[:8], "-", ""))
	defer cleanup()
	pool, err := db.Connect(ctx, url)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()

	apiaryID, hiveID, harvestID, harvestLotID := uuid.New(), uuid.New(), uuid.New(), uuid.New()
	jarSizeID, runID := uuid.New(), uuid.New()
	saleAt := time.Date(2022, 9, 11, 0, 0, 0, 0, time.UTC)
	jarringAt := time.Date(2023, 7, 3, 0, 0, 0, 0, time.UTC)
	commands := []struct {
		sql  string
		args []any
	}{
		{`INSERT INTO apiaries(id,name)VALUES($1,$2)`, []any{apiaryID, "Named draw apiary " + uuid.NewString()}},
		{`INSERT INTO hives(id,apiary_id,position_label)VALUES($1,$2,'A1')`, []any{hiveID, apiaryID}},
		{`INSERT INTO honey_harvests(id,hive_id,date,super_weight_before,super_weight_after,calculated_honey_weight)VALUES($1,$2,$3,1,0,1)`, []any{harvestID, hiveID, saleAt.Add(-24 * time.Hour)}},
		{`INSERT INTO harvest_lots(id,lot_code,public_slug,extraction_date,honey_weight_lbs)VALUES($1,$2,$3,$4,1)`, []any{harvestLotID, "NAMED-" + uuid.NewString(), "named-" + uuid.NewString(), saleAt.Add(-24 * time.Hour)}},
		{`INSERT INTO harvest_lot_harvests(lot_id,harvest_id)VALUES($1,$2)`, []any{harvestLotID, harvestID}},
		{`INSERT INTO jar_sizes(id,label,honey_oz)VALUES($1,$2,8)`, []any{jarSizeID, "Named draw jar " + uuid.NewString()}},
		{`INSERT INTO bottling_runs(id,lot_id,bottled_date,jar_size_id,quantity,honey_lbs)VALUES($1,$2,$3,$4,2,1)`, []any{runID, harvestLotID, jarringAt, jarSizeID}},
		{`INSERT INTO honey_movements(date,kind,amount_lbs,jar_size_id,quantity,bottling_run_id,lot_id)VALUES($1,'jarring',1,$2,2,$3,$4)`, []any{jarringAt, jarSizeID, runID, harvestLotID}},
	}
	for _, command := range commands {
		if _, err := pool.Exec(ctx, command.sql, command.args...); err != nil {
			t.Fatalf("seed fixture: %v\n%s", err, command.sql)
		}
	}
	var saleID uuid.UUID
	if err := pool.QueryRow(ctx, `INSERT INTO sales(date,total_amount_cents,amount_paid_cents,order_status,physical_applied_at)VALUES($1,1000,1000,'paid',$1)RETURNING id`, saleAt).Scan(&saleID); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO sale_items(sale_id,jar_size_id,quantity,unit_price_cents,kind,bottling_run_id)VALUES($1,$2,2,500,'jar',$3)`, saleID, jarSizeID, runID); err != nil {
		t.Fatal(err)
	}

	report, err := ledgerbackfill.Run(ctx, pool, ledgerbackfill.Options{})
	if err == nil || !strings.Contains(err.Error(), "named lot") {
		t.Fatalf("named-lot overdraw report=%+v error=%v", report, err)
	}
	var operations, triggers int
	if err := pool.QueryRow(ctx, `SELECT COUNT(*) FROM inventory_operations`).Scan(&operations); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `SELECT COUNT(*) FROM pg_trigger WHERE tgname='inventory_legacy_freeze' AND NOT tgisinternal`).Scan(&triggers); err != nil {
		t.Fatal(err)
	}
	if operations != 0 || triggers != 0 {
		t.Fatalf("failed gate left operations=%d triggers=%d", operations, triggers)
	}
}

func TestCompleteLedgerBackfillFixtureAndFrozenNoOp(t *testing.T) {
	adminURL := os.Getenv("TEST_DATABASE_URL")
	if adminURL == "" {
		t.Skip("TEST_DATABASE_URL is not configured")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Minute)
	defer cancel()
	url, cleanup := freshImportDatabase(ctx, t, adminURL, "beez_full_backfill_"+strings.ReplaceAll(uuid.NewString()[:8], "-", ""))
	defer cleanup()
	pool, err := db.Connect(ctx, url)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()

	ids := make([]uuid.UUID, 26)
	for i := range ids {
		ids[i] = uuid.New()
	}
	now := time.Date(2026, 1, 2, 12, 0, 0, 0, time.UTC)
	commands := []struct {
		sql  string
		args []any
	}{
		{`INSERT INTO apiaries(id,name,canvas_layout)VALUES($1,'Backfill apiary',$2)`, []any{ids[0], []byte(`{"z":2,"a":{"n":1}}`)}},
		{`INSERT INTO hives(id,apiary_id,position_label)VALUES($1,$2,'A1')`, []any{ids[1], ids[0]}},
		// The five-pound session true-up becomes the positive unassigned-bulk split.
		{`INSERT INTO harvest_sessions(id,apiary_id,date,total_extracted_weight)VALUES($1,$2,$3,25)`, []any{ids[2], ids[0], now}},
		{`INSERT INTO honey_harvests(id,session_id,hive_id,date,super_weight_before,super_weight_after,calculated_honey_weight)VALUES($1,$2,$3,$4,30,10,20)`, []any{ids[3], ids[2], ids[1], now}},
		{`INSERT INTO honey_harvests(id,hive_id,date,super_weight_before,super_weight_after,calculated_honey_weight,direct_weight)VALUES($1,$2,$3,0,0,10,true)`, []any{ids[4], ids[1], now.Add(time.Hour)}},
		{`INSERT INTO harvest_lots(id,lot_code,public_slug,extraction_date,honey_weight_lbs,testing_data)VALUES($1,'BF-LOT','bf-lot','2026-01-02',20,$2)`, []any{ids[5], []byte(`{"moisture":17.2,"trace":{"b":2,"a":1}}`)}},
		{`INSERT INTO harvest_lot_harvests(lot_id,harvest_id)VALUES($1,$2)`, []any{ids[5], ids[3]}},
		{`INSERT INTO jar_sizes(id,label,honey_oz)VALUES($1,'Backfill pint',16)`, []any{ids[6]}},
		{`INSERT INTO bottling_runs(id,lot_id,bottled_date,jar_size_id,quantity,honey_lbs)VALUES($1,$2,'2026-01-03',$3,10,5)`, []any{ids[7], ids[5], ids[6]}},
		{`INSERT INTO honey_movements(id,date,kind,amount_lbs,jar_size_id,quantity,bottling_run_id,lot_id)VALUES($1,$2,'jarring',5,$3,10,$4,$5)`, []any{ids[8], now.Add(24 * time.Hour), ids[6], ids[7], ids[5]}},
		// Historical jarring with no run or lot exercises legacy-unassigned.
		{`INSERT INTO honey_movements(id,date,kind,amount_lbs,jar_size_id,quantity,reason)VALUES($1,$2,'jarring',2,$3,4,'untraced fixture')`, []any{ids[9], now.Add(25 * time.Hour), ids[6]}},
		{`INSERT INTO honey_movements(id,date,kind,amount_lbs,lot_id)VALUES($1,$2,'loss',1,$3)`, []any{ids[10], now.Add(26 * time.Hour), ids[5]}},
		{`INSERT INTO honey_movements(id,date,kind,amount_lbs,lot_id,reverses_movement_id)VALUES($1,$2,'loss',-1,$3,$4)`, []any{ids[11], now.Add(27 * time.Hour), ids[5], ids[10]}},
		// A voided run remains historical and its movement pair nets to zero.
		{`INSERT INTO bottling_runs(id,lot_id,bottled_date,jar_size_id,quantity,honey_lbs,voided_at,void_reason)VALUES($1,$2,'2026-01-04',$3,2,1,$4,'fixture void')`, []any{ids[12], ids[5], ids[6], now.Add(72 * time.Hour)}},
		{`INSERT INTO honey_movements(id,date,kind,amount_lbs,jar_size_id,quantity,bottling_run_id,lot_id)VALUES($1,$2,'jarring',1,$3,2,$4,$5)`, []any{ids[13], now.Add(48 * time.Hour), ids[6], ids[12], ids[5]}},
		{`INSERT INTO honey_movements(id,date,kind,amount_lbs,jar_size_id,quantity,bottling_run_id,lot_id,reverses_movement_id)VALUES($1,$2,'jarring',-1,$3,-2,$4,$5,$6)`, []any{ids[14], now.Add(72 * time.Hour), ids[6], ids[12], ids[5], ids[13]}},
		{`INSERT INTO product_catalog(id,name,kind,unit,default_price_cents)VALUES($1,'Backfill hot honey','hot_honey','bottle',900)`, []any{ids[15]}},
		{`INSERT INTO product_batches(id,kind,product_id,harvest_lot_id,started_at,honey_lbs,quantity_out,voided_at,void_reason)VALUES($1,'hot_honey',$2,$3,$4,1,5,$5,'fixture void')`, []any{ids[16], ids[15], ids[5], now.Add(50 * time.Hour), now.Add(51 * time.Hour)}},
		{`INSERT INTO honey_movements(id,date,kind,amount_lbs,lot_id,product_batch_id)VALUES($1,$2,'bulk_use',1,$3,$4)`, []any{ids[24], now.Add(50 * time.Hour), ids[5], ids[16]}},
		{`INSERT INTO honey_movements(id,date,kind,amount_lbs,lot_id,product_batch_id,reverses_movement_id)VALUES($1,$2,'bulk_use',-1,$3,$4,$5)`, []any{ids[25], now.Add(51 * time.Hour), ids[5], ids[16], ids[24]}},
		{`INSERT INTO product_adjustments(id,product_id,date,delta,reason)VALUES($1,$2,$3,3,'opening count')`, []any{ids[17], ids[15], now.Add(52 * time.Hour)}},
		{`INSERT INTO product_adjustments(id,product_id,date,delta,reason,deleted_at)VALUES($1,$2,$3,99,'soft deleted',$4)`, []any{ids[18], ids[15], now.Add(52 * time.Hour), now.Add(53 * time.Hour)}},
		{`INSERT INTO propolis_harvests(id,hive_id,date,amount,unit)VALUES($1,$2,$3,100,'grams')`, []any{ids[19], ids[1], now.Add(2 * time.Hour)}},
		{`INSERT INTO stock_locations(id,name,slug,is_consignment,price_basis)VALUES($1,'Backfill shop','backfill-shop',true,'retail')`, []any{ids[20]}},
		{`INSERT INTO stock_movements(id,date,kind,location_id,counterparty_location_id,transfer_id,jar_size_id,quantity) SELECT $1,$2,'transfer',id,$3,$4,$5,-2 FROM stock_locations WHERE is_home`, []any{ids[21], now.Add(80 * time.Hour), ids[20], ids[23], ids[6]}},
		{`INSERT INTO stock_movements(id,date,kind,location_id,counterparty_location_id,transfer_id,jar_size_id,quantity) SELECT $1,$2,'transfer',$3,id,$4,$5,2 FROM stock_locations WHERE is_home`, []any{ids[22], now.Add(80 * time.Hour), ids[20], ids[23], ids[6]}},
	}
	for _, command := range commands {
		if _, err := pool.Exec(ctx, command.sql, command.args...); err != nil {
			t.Fatalf("seed fixture: %v\n%s", err, command.sql)
		}
	}
	var appliedSale, draftSale uuid.UUID
	if err := pool.QueryRow(ctx, `INSERT INTO sales(date,total_amount_cents,amount_paid_cents,order_status,stock_location_id,physical_applied_at)VALUES($1,900,900,'paid',$2,$1)RETURNING id`, now.Add(90*time.Hour), ids[20]).Scan(&appliedSale); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO sale_items(sale_id,jar_size_id,quantity,unit_price_cents,kind,bottling_run_id)VALUES($1,$2,1,900,'jar',$3)`, appliedSale, ids[6], ids[7]); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `INSERT INTO sales(date,total_amount_cents,order_status)VALUES($1,900,'draft')RETURNING id`, now.Add(91*time.Hour)).Scan(&draftSale); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO sale_items(sale_id,product_id,quantity,unit_price_cents,kind)VALUES($1,$2,1,900,'hot_honey')`, draftSale, ids[15]); err != nil {
		t.Fatal(err)
	}

	report, err := ledgerbackfill.Run(ctx, pool, ledgerbackfill.Options{})
	if err != nil {
		t.Fatalf("complete backfill: %v", err)
	}
	if report.Operations == 0 || len(report.FrozenTables) != len(ledgerbackfill.FreezeTables) || len(report.ResidualSplits) != 1 || report.ResidualSplits[0].Amount != "5" {
		t.Fatalf("report=%+v", report)
	}
	var unattributed, reversals, transfers, appliedSales int
	if err := pool.QueryRow(ctx, `SELECT COUNT(*) FROM inventory_operations WHERE provenance='legacy-unattributed'`).Scan(&unattributed); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `SELECT COUNT(*) FROM inventory_operations WHERE kind='reversal'`).Scan(&reversals); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `SELECT COUNT(*) FROM inventory_operations WHERE kind='transfer'`).Scan(&transfers); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `SELECT COUNT(*) FROM inventory_operations WHERE source_type='sale' AND source_id=$1`, appliedSale).Scan(&appliedSales); err != nil {
		t.Fatal(err)
	}
	if unattributed < 6 || reversals < 3 || transfers != 1 || appliedSales != 1 {
		t.Fatalf("translated unattributed=%d reversals=%d transfers=%d appliedSales=%d", unattributed, reversals, transfers, appliedSales)
	}
	var draftOps int
	if err := pool.QueryRow(ctx, `SELECT COUNT(*) FROM inventory_operations WHERE source_type='sale' AND source_id=$1`, draftSale).Scan(&draftOps); err != nil || draftOps != 0 {
		t.Fatalf("draft sale operations=%d err=%v", draftOps, err)
	}
	second, err := ledgerbackfill.Run(ctx, pool, ledgerbackfill.Options{})
	if err != nil || !second.AlreadyFrozen || second.Operations != 0 {
		t.Fatalf("frozen rerun=%+v err=%v", second, err)
	}

	// The Phase-A artifact carries both frozen legacy history and the ledger.
	// Restore it into a fresh migrated target and prove every operation keeps
	// its identity rather than being rebuilt under a new UUID.
	operationIDs, err := queryUUIDColumn(ctx, pool, `SELECT id FROM inventory_operations ORDER BY id`)
	if err != nil {
		t.Fatal(err)
	}
	artifact := t.TempDir() + "-phase-a"
	if _, err := snapshot.Export(ctx, pool, snapshot.ExportOptions{OutputDirectory: artifact, BusinessTimezone: "UTC", Currency: "USD"}); err != nil {
		t.Fatalf("export Phase-A database: %v", err)
	}
	targetURL, targetCleanup := freshImportDatabase(ctx, t, adminURL, "beez_full_backfill_rt_"+strings.ReplaceAll(uuid.NewString()[:8], "-", ""))
	defer targetCleanup()
	restore := newReport(false)
	if err := execute(ctx, options{input: artifact, database: targetURL, conflict: "fail", report: t.TempDir() + "/restore.json"}, restore); err != nil {
		t.Fatalf("restore Phase-A artifact: %v", err)
	}
	target, err := db.ConnectWithoutMigrations(ctx, targetURL)
	if err != nil {
		t.Fatal(err)
	}
	defer target.Close()
	var preserved int
	if err := target.QueryRow(ctx, `SELECT COUNT(*) FROM inventory_operations WHERE id=ANY($1)`, operationIDs).Scan(&preserved); err != nil || preserved != len(operationIDs) {
		t.Fatalf("preserved ledger operation ids=%d/%d err=%v", preserved, len(operationIDs), err)
	}
}

func queryUUIDColumn(ctx context.Context, pool *pgxpool.Pool, query string) ([]uuid.UUID, error) {
	rows, err := pool.Query(ctx, query)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var ids []uuid.UUID
	for rows.Next() {
		var id uuid.UUID
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		ids = append(ids, id)
	}
	return ids, rows.Err()
}
