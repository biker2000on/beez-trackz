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
	wantTransforms := len(snapshot.LedgerDomains) + addedZeroLedgerChecks + 1
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
