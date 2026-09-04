package main

import (
	"context"
	"database/sql"
	"errors"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	_ "github.com/jackc/pgx/v5/stdlib"
	"github.com/pressly/goose/v3"

	"github.com/biker2000on/beez-trackz/backend/internal/db"
	"github.com/biker2000on/beez-trackz/backend/internal/snapshot"
)

// TestRoundTripGatePassesAgainstAPreLedgerSource is the production rollback
// artifact shape: goose 00048 has no inventory_* tables, while the disposable
// restore target is migrated to the current ledger-bearing head.
func TestRoundTripGatePassesAgainstAPreLedgerSource(t *testing.T) {
	adminURL := requireDatabase(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Minute)
	defer cancel()

	repoRoot, err := findRepoRoot(".")
	if err != nil {
		t.Fatalf("locate the backend module: %v", err)
	}
	workdir := t.TempDir()
	if _, err := buildImporter(ctx, repoRoot, workdir); err != nil {
		if errors.Is(err, errImporterMissing) {
			t.Skipf("%v; the pre-ledger round trip needs the importer", err)
		}
		t.Fatalf("build the importer: %v", err)
	}

	suffix := strings.ReplaceAll(uuid.NewString()[:8], "-", "")
	sourceURL, cleanup, err := freshDatabase(ctx, adminURL, "beez_preledger_gate_src_"+suffix)
	if err != nil {
		t.Fatalf("create pre-ledger source: %v", err)
	}
	t.Cleanup(cleanup)
	migrateGateDatabaseTo(t, sourceURL, snapshot.LedgerSchemaMigration-2)
	pool, err := pgxpool.New(ctx, sourceURL)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO apiaries(id,name) VALUES('10000000-0000-4000-8000-000000000048','Pre-ledger yard')`); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO hives(id,apiary_id,position_label) VALUES('11000000-0000-4000-8000-000000000048','10000000-0000-4000-8000-000000000048','A48')`); err != nil {
		t.Fatal(err)
	}
	fixtureStatements := []string{
		`INSERT INTO jar_sizes(id,label,honey_oz) VALUES('12000000-0000-4000-8000-000000000048','Pre-ledger pint',16)`,
		`INSERT INTO equipment_types(id,name,category,frames_per_box) VALUES('13000000-0000-4000-8000-000000000048','Pre-ledger deep box','box',10)`,
		`INSERT INTO sales(id,date,total_amount_cents,amount_paid_cents,order_status) VALUES('14000000-0000-4000-8000-000000000048','2026-01-10T16:00:00Z',1200,0,'pending')`,
		`INSERT INTO sale_items(id,sale_id,jar_size_id,quantity,unit_price_cents,kind) VALUES('15000000-0000-4000-8000-000000000048','14000000-0000-4000-8000-000000000048','12000000-0000-4000-8000-000000000048',1,1200,'jar')`,
	}
	for _, statement := range fixtureStatements {
		if _, err := pool.Exec(ctx, statement); err != nil {
			t.Fatalf("seed pre-ledger retained record: %v\n%s", err, statement)
		}
	}
	pool.Close()

	report, err := run(ctx, options{
		AdminURL: adminURL, SourceURL: sourceURL, Workdir: workdir,
		GateDatabase: "beez_preledger_gate_dst_" + suffix, RepoRoot: repoRoot,
		LegacySource: true,
		Logf:         func(format string, args ...any) { t.Logf(format, args...) },
	})
	if err != nil {
		t.Fatalf("run pre-ledger gate: %v", err)
	}
	if err := writeReports(report, workdir); err != nil {
		t.Fatalf("write pre-ledger gate reports: %v", err)
	}
	if !report.Passed {
		t.Log(report.summary())
		t.Fatalf("pre-ledger gate failed with %d findings", len(report.Failures))
	}

	var transformed []finding
	for _, item := range report.Explained {
		if item.Code == snapshot.PreLedgerTransform {
			transformed = append(transformed, item)
		}
	}
	sourceArtifact, sourceFindings := loadArtifact(report.SourceArtifact)
	restoredArtifact, restoredFindings := loadArtifact(report.RestoredArtifac)
	if sourceArtifact == nil || restoredArtifact == nil || len(failures(sourceFindings)) != 0 || len(failures(restoredFindings)) != 0 {
		t.Fatalf("reload gate artifacts: source=%v restored=%v", sourceFindings, restoredFindings)
	}
	sourceChecks := indexReferences(sourceArtifact.Verification.ReferenceChecks)
	addedZeroLedgerChecks := 0
	for name, check := range indexReferences(restoredArtifact.Verification.ReferenceChecks) {
		if _, present := sourceChecks[name]; !present && referenceTouchesLedger(check) &&
			check.PopulatedCount == 0 && check.ResolvedCount == 0 && check.DanglingCount == 0 {
			addedZeroLedgerChecks++
		}
	}
	wantTransforms := len(snapshot.LedgerDomains) + addedZeroLedgerChecks + 1 + 3
	if len(transformed) != wantTransforms {
		t.Fatalf("pre-ledger explanations = %d, want %d domains/checks plus aggregate: %v",
			len(transformed), wantTransforms, transformed)
	}
	for _, domain := range snapshot.LedgerDomains {
		found := false
		for _, item := range transformed {
			found = found || strings.Contains(item.Detail, domain.Name)
		}
		if !found {
			t.Errorf("pre-ledger explanation does not name %s", domain.Name)
		}
	}
	summaryBytes, err := os.ReadFile(workdir + "/gate-summary.txt")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(summaryBytes), snapshot.PreLedgerTransform) {
		t.Fatalf("gate-summary.txt does not name %s", snapshot.PreLedgerTransform)
	}
	summary := string(summaryBytes)
	for domain, columns := range map[string]string{
		"equipment_types": "first_deployed_year, item_id, needed_quantity, storage_location, unit_cost_cents",
		"jar_sizes":       "item_id",
		"sale_items":      "inventory_lot_id, item_id",
	} {
		want := "domain " + domain + ": 1 records gained only declared null columns absent from the pre-ledger source: " + columns
		if strings.Count(summary, want) != 1 {
			t.Errorf("gate-summary.txt does not contain exactly one %s summary:\n%s", domain, summary)
		}
	}
}

// TestRoundTripGatePassesFromPhaseBArtifactBoundary is the production Phase B
// rollback shape: the final Phase A artifact was exported at legacy migration
// 00054, then migrations 00056 and 00057 changed portable record shapes.
func TestRoundTripGatePassesFromPhaseBArtifactBoundary(t *testing.T) {
	adminURL := requireDatabase(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Minute)
	defer cancel()

	repoRoot, err := findRepoRoot(".")
	if err != nil {
		t.Fatalf("locate the backend module: %v", err)
	}
	workdir := t.TempDir()
	if _, err := buildImporter(ctx, repoRoot, workdir); err != nil {
		t.Fatalf("build the importer: %v", err)
	}

	suffix := strings.ReplaceAll(uuid.NewString()[:8], "-", "")
	sourceURL, cleanup, err := freshDatabase(ctx, adminURL, "beez_phase_b_boundary_src_"+suffix)
	if err != nil {
		t.Fatalf("create migration-54 source: %v", err)
	}
	t.Cleanup(cleanup)
	migrateGateDatabaseTo(t, sourceURL, 54)
	pool, err := pgxpool.New(ctx, sourceURL)
	if err != nil {
		t.Fatal(err)
	}
	statements := []string{
		`INSERT INTO app_users(id,username,display_name,email,is_admin) VALUES
		 ('10000000-0000-4000-8000-000000000001','beek-one','Beek One','one@example.com',true),
		 ('10000000-0000-4000-8000-000000000002','beek-two','Beek Two','two@example.com',false)`,
		`INSERT INTO user_settings(id,display_name,theme,date_format,weight_unit,units,temperature_unit)
		 VALUES('00000000-0000-4000-8000-000000000054','Phase B boundary','dark','YYYY-MM-DD','kg','metric','c')`,
	}
	for _, statement := range statements {
		if _, err := pool.Exec(ctx, statement); err != nil {
			pool.Close()
			t.Fatalf("seed migration-54 source: %v\n%s", err, statement)
		}
	}
	pool.Close()

	report, err := run(ctx, options{
		AdminURL: adminURL, SourceURL: sourceURL, Workdir: workdir,
		GateDatabase: "beez_phase_b_boundary_dst_" + suffix, RepoRoot: repoRoot,
		LegacySource: true,
		Logf:         func(format string, args ...any) { t.Logf(format, args...) },
	})
	if err != nil {
		t.Fatalf("run migration-54 gate: %v", err)
	}
	if err := writeReports(report, workdir); err != nil {
		t.Fatalf("write migration-54 gate reports: %v", err)
	}
	if !report.Passed {
		t.Log(report.summary())
		t.Fatalf("migration-54 gate failed with %d findings", len(report.Failures))
	}
	for _, transform := range []string{
		snapshot.InventoryLocationsConsigneeAttrsTransform,
		snapshot.UserPreferencesTransform,
	} {
		found := false
		for _, item := range report.Explained {
			found = found || item.Code == transform
		}
		if !found {
			t.Errorf("gate report does not name transform %s", transform)
		}
	}

	restored, findings := loadArtifact(report.RestoredArtifac)
	if restored == nil || len(failures(findings)) != 0 {
		t.Fatalf("reload restored artifact: %v", findings)
	}
	preferences := restored.Records["user_preferences"]
	if len(preferences) != 2 {
		t.Fatalf("restored user_preferences = %d, want one per app user", len(preferences))
	}
	for _, preference := range preferences {
		for key, want := range map[string]any{
			"theme": "dark", "date_format": "YYYY-MM-DD", "weight_unit": "kg",
			"units": "metric", "temperature_unit": "c",
		} {
			if got := preference.Fields[key]; got != want {
				t.Errorf("preference %s %s = %#v, want %#v", preference.IDKey, key, got, want)
			}
		}
	}
	summaryBytes, err := os.ReadFile(workdir + "/gate-summary.txt")
	if err != nil {
		t.Fatal(err)
	}
	summary := string(summaryBytes)
	for _, want := range []string{
		"domain inventory_locations:",
		"domain user_settings: 1 records dropped only columns",
		"domain user_preferences: 2 rows equal the declared derivation",
	} {
		if !strings.Contains(summary, want) {
			t.Errorf("gate-summary.txt does not contain %q:\n%s", want, summary)
		}
	}
}

func migrateGateDatabaseTo(t *testing.T, databaseURL string, version int64) {
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
