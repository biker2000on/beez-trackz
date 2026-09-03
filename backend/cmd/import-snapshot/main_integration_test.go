package main

import (
	"context"
	"database/sql"
	"fmt"
	"os"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/biker2000on/beez-trackz/backend/internal/app"
	"github.com/biker2000on/beez-trackz/backend/internal/db"
	"github.com/biker2000on/beez-trackz/backend/internal/snapshot"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	_ "github.com/jackc/pgx/v5/stdlib"
	"github.com/pressly/goose/v3"
)

func TestExportImportReexportDigestEquality(t *testing.T) {
	adminURL := os.Getenv("TEST_DATABASE_URL")
	if adminURL == "" {
		t.Skip("TEST_DATABASE_URL is not configured")
	}
	// Export, restore, re-import, and re-export of ~80 domain files over the
	// remote test server takes several minutes; the budget is generous so a
	// slow link fails on a real assertion, never on this deadline.
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Minute)
	defer cancel()
	suffix := strings.ReplaceAll(uuid.NewString()[:8], "-", "")
	sourceURL, sourceCleanup := freshImportDatabase(ctx, t, adminURL, "beez_snapshot_src_"+suffix)
	defer sourceCleanup()
	targetURL, targetCleanup := freshImportDatabase(ctx, t, adminURL, "beez_snapshot_dst_"+suffix)
	defer targetCleanup()

	source, err := db.Connect(ctx, sourceURL)
	if err != nil {
		t.Fatalf("migrate source: %v", err)
	}
	now := time.Date(2025, 11, 2, 5, 30, 0, 123456000, time.UTC)
	apiaryID, customerID, expenseID := uuid.New(), uuid.New(), uuid.New()
	lotID, jarID, runID := uuid.New(), uuid.New(), uuid.New()
	movementID, reversalID := uuid.New(), uuid.New()
	commands := []struct {
		sql  string
		args []any
	}{
		{`INSERT INTO apiaries(id,name,canvas_layout,created_at,updated_at) VALUES($1,'Round trip',$2,$3,$3)`, []any{apiaryID, []byte(`{"z":1,"a":{"n":100}}`), now}},
		{`INSERT INTO customers(id,name,email_opt_in,created_at,updated_at) VALUES($1,'Soft history customer',false,$2,$2)`, []any{customerID, now}},
		{`INSERT INTO expenses(id,expense_date,category,description,amount_cents,created_at,updated_at,deleted_at,deletion_reason) VALUES($1,'2025-11-02','feed','Archived sugar',1234,$2,$2,$2,'duplicate receipt')`, []any{expenseID, now}},
		{`INSERT INTO jar_sizes(id,label,honey_oz,created_at,updated_at) VALUES($1,'Fixture 12 oz',12,$2,$2)`, []any{jarID, now}},
		{`INSERT INTO harvest_lots(id,lot_code,public_slug,extraction_date,honey_weight_lbs,testing_data,created_at,updated_at) VALUES($1,'LOT-RT','lot-rt','2025-10-01',20,$2,$3,$3)`, []any{lotID, []byte(`{"b":2,"a":1}`), now}},
		{`INSERT INTO bottling_runs(id,lot_id,bottled_date,jar_size_id,quantity,honey_lbs,created_at,voided_at,void_reason) VALUES($1,$2,'2025-11-01',$3,2,1.5,$4,$4,'fixture void')`, []any{runID, lotID, jarID, now}},
		{`INSERT INTO honey_movements(id,date,kind,amount_lbs,reason,created_at,lot_id) VALUES($1,$2,'bulk_use',-2,'fixture original',$2,$3)`, []any{movementID, now, lotID}},
		{`INSERT INTO honey_movements(id,date,kind,amount_lbs,reason,created_at,lot_id,reverses_movement_id) VALUES($1,$2,'bulk_use',2,'fixture reversal',$2,$3,$4)`, []any{reversalID, now.Add(time.Second), lotID, movementID}},
	}
	for _, command := range commands {
		if _, err := source.Exec(ctx, command.sql, command.args...); err != nil {
			source.Close()
			t.Fatalf("seed fixture: %v\n%s", err, command.sql)
		}
	}
	sourceArtifact := t.TempDir() + "-source"
	exported, err := snapshot.Export(ctx, source, snapshot.ExportOptions{OutputDirectory: sourceArtifact, AppCommit: "integration", BusinessTimezone: "UTC", Currency: "USD"})
	if err != nil {
		source.Close()
		t.Fatalf("export source: %v", err)
	}
	source.Close()

	reportPath := t.TempDir() + "/restore-report.json"
	report := newReport(false)
	if err := execute(ctx, options{input: sourceArtifact, database: targetURL, conflict: "fail", report: reportPath}, report); err != nil {
		t.Fatalf("import: %v; validation=%v; records=%+v", err, report.ValidationErrors, report.Records)
	}
	if report.Counts["failed"] != 0 || report.Counts["conflicted"] != 0 {
		t.Fatalf("restore report: %+v", report.Counts)
	}
	second := newReport(false)
	if err := execute(ctx, options{input: sourceArtifact, database: targetURL, conflict: "skip", report: reportPath}, second); err != nil {
		t.Fatalf("idempotent re-import: %v", err)
	}
	if second.Counts["created"] != 0 || second.Counts["updated"] != 0 || second.Counts["skipped"] != 0 {
		t.Fatalf("second import was not a zero-write unchanged pass: %+v", second.Counts)
	}

	target, err := db.ConnectWithoutMigrations(ctx, targetURL)
	if err != nil {
		t.Fatalf("connect target: %v", err)
	}
	var syncEnabled bool
	if err := target.QueryRow(ctx, `SELECT COALESCE(bool_or(sync_enabled),false) FROM gnucash_sync_settings`).Scan(&syncEnabled); err != nil {
		t.Fatal(err)
	}
	if syncEnabled {
		t.Fatal("GnuCash sync was enabled by restore")
	}
	targetArtifact := t.TempDir() + "-target"
	reexported, err := snapshot.Export(ctx, target, snapshot.ExportOptions{OutputDirectory: targetArtifact, AppCommit: "integration", BusinessTimezone: "UTC", Currency: "USD"})
	target.Close()
	if err != nil {
		t.Fatalf("re-export target: %v", err)
	}
	want, got := digestSet(exported.Verification.RecordDigests), digestSet(reexported.Verification.RecordDigests)
	if strings.Join(want, "\n") != strings.Join(got, "\n") {
		t.Fatalf("record digests differ\nsource-only/target-only comparison:\nsource=%s\ntarget=%s", strings.Join(want, "\n"), strings.Join(got, "\n"))
	}
}

func TestRestoreLegacySnapshotRefusesFrozenDatabase(t *testing.T) {
	adminURL := os.Getenv("TEST_DATABASE_URL")
	if adminURL == "" {
		t.Skip("TEST_DATABASE_URL is not configured")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Minute)
	defer cancel()
	suffix := strings.ReplaceAll(uuid.NewString()[:8], "-", "")
	sourceURL, sourceCleanup := freshImportDatabase(ctx, t, adminURL, "beez_restore_legacy_src_"+suffix)
	defer sourceCleanup()
	targetURL, targetCleanup := freshImportDatabase(ctx, t, adminURL, "beez_restore_frozen_dst_"+suffix)
	defer targetCleanup()

	source, err := db.Connect(ctx, sourceURL)
	if err != nil {
		t.Fatal(err)
	}
	var typeID uuid.UUID
	if err := source.QueryRow(ctx, `INSERT INTO equipment_types(name,category) VALUES($1,'box') RETURNING id`, "Frozen restore "+suffix).Scan(&typeID); err != nil {
		t.Fatal(err)
	}
	if _, err := source.Exec(ctx, `INSERT INTO equipment_stock(type_id,total_owned) VALUES($1,0)`, typeID); err != nil {
		t.Fatal(err)
	}
	artifact := t.TempDir() + "-legacy"
	if _, err := snapshot.Export(ctx, source, snapshot.ExportOptions{OutputDirectory: artifact, BusinessTimezone: "UTC", Currency: "USD"}); err != nil {
		t.Fatal(err)
	}
	source.Close()

	target, err := db.Connect(ctx, targetURL)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := target.Exec(ctx, `CREATE OR REPLACE FUNCTION inventory_legacy_freeze_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NULL; END $$`); err != nil {
		t.Fatal(err)
	}
	if _, err := target.Exec(ctx, `CREATE TRIGGER inventory_legacy_freeze BEFORE INSERT OR UPDATE OR DELETE ON equipment_stock FOR EACH ROW EXECUTE FUNCTION inventory_legacy_freeze_guard()`); err != nil {
		t.Fatal(err)
	}
	target.Close()

	report := newReport(true)
	err = execute(ctx, options{input: artifact, database: targetURL, conflict: "fail", report: t.TempDir() + "/report.json", dryRun: true}, report)
	if !app.IsKind(err, app.KindPrecondition) || !strings.Contains(err.Error(), "inventory_legacy_freeze") {
		t.Fatalf("restore into frozen target returned %v, want named precondition", err)
	}
}

// TestPreLedgerRollbackRestoreAndBackfillEndToEnd is the executable proof of
// restore-runbook section 6.5: restore the artifact taken before migration
// 00050 into a fresh head database, then run the canonical ledger backfill.
func TestPreLedgerRollbackRestoreAndBackfillEndToEnd(t *testing.T) {
	adminURL := os.Getenv("TEST_DATABASE_URL")
	if adminURL == "" {
		t.Skip("TEST_DATABASE_URL is not configured")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Minute)
	defer cancel()
	suffix := strings.ReplaceAll(uuid.NewString()[:8], "-", "")
	sourceURL, sourceCleanup := freshImportDatabase(ctx, t, adminURL, "beez_preledger_src_"+suffix)
	defer sourceCleanup()
	targetURL, targetCleanup := freshImportDatabase(ctx, t, adminURL, "beez_preledger_dst_"+suffix)
	defer targetCleanup()
	migrateImportDatabaseTo(t, sourceURL, snapshot.LedgerSchemaMigration-2)

	source, err := pgxpool.New(ctx, sourceURL)
	if err != nil {
		t.Fatal(err)
	}
	var typeID, stockID uuid.UUID
	if err := source.QueryRow(ctx, `INSERT INTO equipment_types(name,category) VALUES($1,'box') RETURNING id`, "Pre-ledger box "+suffix).Scan(&typeID); err != nil {
		t.Fatal(err)
	}
	if err := source.QueryRow(ctx, `INSERT INTO equipment_stock(type_id,total_owned) VALUES($1,0) RETURNING id`, typeID).Scan(&stockID); err != nil {
		t.Fatal(err)
	}
	if _, err := source.Exec(ctx, `INSERT INTO equipment_stock_adjustments(stock_id,quantity,reason,date) VALUES($1,7,'purchased','2026-09-01T00:00:00Z')`, stockID); err != nil {
		t.Fatal(err)
	}
	artifactDir := t.TempDir() + "-pre-ledger"
	if _, err := snapshot.Export(ctx, source, snapshot.ExportOptions{OutputDirectory: artifactDir, BusinessTimezone: "UTC", Currency: "USD"}); err != nil {
		t.Fatalf("export migration-48 source: %v", err)
	}
	source.Close()
	artifact, err := snapshot.OpenArtifact(artifactDir)
	if err != nil {
		t.Fatalf("read pre-ledger artifact: %v", err)
	}
	if len(artifact.PreLedgerDomains) != len(snapshot.LedgerDomains) {
		t.Fatalf("pre-ledger domains = %v, want all %d ledger domains", artifact.PreLedgerDomains, len(snapshot.LedgerDomains))
	}

	target, err := db.Connect(ctx, targetURL)
	if err != nil {
		t.Fatalf("migrate target to head: %v", err)
	}
	target.Close()
	reportPath := t.TempDir() + "/restore-report.json"
	dryRun := newReport(true)
	if err := execute(ctx, options{input: artifactDir, database: targetURL, conflict: "fail", report: reportPath, dryRun: true}, dryRun); err != nil {
		t.Fatalf("dry-run pre-ledger restore: %v", err)
	}
	probe, err := db.ConnectWithoutMigrations(ctx, targetURL)
	if err != nil {
		t.Fatal(err)
	}
	var legacyRows, operations int
	if err := probe.QueryRow(ctx, `SELECT COUNT(*) FROM equipment_stock`).Scan(&legacyRows); err != nil {
		t.Fatal(err)
	}
	if err := probe.QueryRow(ctx, `SELECT COUNT(*) FROM inventory_operations`).Scan(&operations); err != nil {
		t.Fatal(err)
	}
	probe.Close()
	if legacyRows != 0 || operations != 0 {
		t.Fatalf("dry-run wrote legacy rows=%d ledger operations=%d", legacyRows, operations)
	}

	restore := newReport(false)
	if err := execute(ctx, options{input: artifactDir, database: targetURL, conflict: "fail", report: reportPath}, restore); err != nil {
		t.Fatalf("restore pre-ledger artifact: %v", err)
	}
	transformed := map[string]bool{}
	for _, record := range restore.Records {
		if record.Transform == snapshot.PreLedgerTransform {
			transformed[record.Domain] = true
		}
	}
	if len(transformed) != len(snapshot.LedgerDomains) {
		t.Fatalf("restore report names %d pre-ledger domains, want %d: %v", len(transformed), len(snapshot.LedgerDomains), transformed)
	}
	probe, err = db.ConnectWithoutMigrations(ctx, targetURL)
	if err != nil {
		t.Fatal(err)
	}
	for _, domain := range snapshot.LedgerDomains {
		var records int
		if err := probe.QueryRow(ctx, "SELECT COUNT(*) FROM "+quoteIdent(domain.Table)).Scan(&records); err != nil {
			probe.Close()
			t.Fatalf("count %s after pre-ledger restore: %v", domain.Name, err)
		}
		if records != 0 {
			t.Errorf("ledger domain %s has %d records after pre-ledger restore, want 0", domain.Name, records)
		}
	}
	probe.Close()

	backfill := newReport(false)
	if err := execute(ctx, options{database: targetURL, report: reportPath, backfillLedger: true}, backfill); err != nil {
		t.Fatalf("backfill restored pre-ledger artifact: %v; report=%+v", err, backfill.LedgerBackfill)
	}
	if backfill.LedgerBackfill == nil || backfill.LedgerBackfill.Operations == 0 {
		t.Fatalf("backfill did not translate restored legacy inventory: %+v", backfill.LedgerBackfill)
	}

	frozenRestore := newReport(true)
	err = execute(ctx, options{input: artifactDir, database: targetURL, conflict: "skip", report: reportPath, dryRun: true}, frozenRestore)
	if !app.IsKind(err, app.KindPrecondition) || !strings.Contains(err.Error(), "inventory_legacy_freeze") || !strings.Contains(err.Error(), "section 6.5") {
		t.Fatalf("pre-ledger restore into frozen target returned %v, want section 6.5 typed precondition", err)
	}
}

func migrateImportDatabaseTo(t *testing.T, databaseURL string, version int64) {
	t.Helper()
	if err := goose.SetDialect("postgres"); err != nil {
		t.Fatal(err)
	}
	goose.SetBaseFS(os.DirFS("../../internal/db"))
	sqlDB, err := sql.Open("pgx", databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	defer sqlDB.Close()
	if err := goose.UpTo(sqlDB, db.LegacyChainDir, version); err != nil {
		t.Fatalf("migrate source to %d: %v", version, err)
	}
}

func digestSet(records []snapshot.RecordDigest) []string {
	out := make([]string, 0, len(records))
	for _, record := range records {
		out = append(out, record.Domain+"\x00"+string(record.ID)+"\x00"+record.Digest)
	}
	sort.Strings(out)
	return out
}

func freshImportDatabase(ctx context.Context, t *testing.T, adminURL, name string) (string, func()) {
	t.Helper()
	admin, err := pgxpool.New(ctx, adminURL)
	if err != nil {
		t.Fatalf("connect database admin: %v", err)
	}
	quoted := `"` + strings.ReplaceAll(name, `"`, `""`) + `"`
	if _, err := admin.Exec(ctx, "CREATE DATABASE "+quoted); err != nil {
		admin.Close()
		t.Fatalf("create %s: %v", name, err)
	}
	databaseURL := replaceImportDatabase(adminURL, name)
	return databaseURL, func() {
		cleanupCtx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		_, _ = admin.Exec(cleanupCtx, "DROP DATABASE IF EXISTS "+quoted+" WITH (FORCE)")
		admin.Close()
	}
}

func replaceImportDatabase(databaseURL, name string) string {
	base, query, hasQuery := strings.Cut(databaseURL, "?")
	slash := strings.LastIndex(base, "/")
	if slash < 0 {
		panic(fmt.Sprintf("database URL has no path: %s", databaseURL))
	}
	replaced := base[:slash+1] + name
	if hasQuery {
		return replaced + "?" + query
	}
	return replaced
}
