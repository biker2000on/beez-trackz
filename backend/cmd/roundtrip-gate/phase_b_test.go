package main

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/biker2000on/beez-trackz/backend/internal/app/backfill"
	"github.com/biker2000on/beez-trackz/backend/internal/db"
	"github.com/biker2000on/beez-trackz/backend/internal/snapshot"
)

// Phase B of the ledger rearchitecture (spec section 9 steps 6-9): the squash
// is proven by the ordinary P0 gate, run with a baseline target instead of a
// chain target. These tests rehearse that on disposable databases; like every
// other database-backed test in this tree they skip without TEST_DATABASE_URL
// and never touch the database that URL names.
//
// The Phase A source keeps its legacy tables, frozen. The baseline target does
// not have them at all. That difference is the whole point of the squash, and
// it is declared rather than discovered: db.BaselineDroppedTables names the ten
// domains, and a round trip is only clean if the differences are exactly those
// ten, listed by name.

const (
	phaseBSourceDatabase = "beez_trackz_test_pb_gate_source"
	phaseBGateDatabase   = "beez_trackz_test_pb_gate_target"
)

// The declaration and the schema must agree. This test needs no importer and
// no artifact: it compares the named drop list against what the two chains
// actually build, so a list that drifts from the baseline fails here, in a
// second, rather than deep inside a round trip.
func TestPhaseBDroppedDomainsAreDeclaredByName(t *testing.T) {
	adminURL := requireDatabase(t)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
	defer cancel()

	_, sourcePool := phaseBSource(ctx, t, adminURL, false)
	targetPool := phaseBBaselineTarget(ctx, t, adminURL)

	declared := map[string]bool{}
	for _, name := range db.BaselineDroppedTables() {
		declared[name] = true
	}

	registered := map[string]bool{}
	for _, domain := range snapshot.RegisteredDomains() {
		registered[domain.Name] = true
	}

	// (1) Every declared drop is a real snapshot domain. A name that is not a
	// domain would silently explain nothing at compare time.
	for name := range declared {
		if !registered[name] {
			t.Errorf("%q is declared dropped-by-baseline but is not a registered snapshot domain", name)
		}
		if !tableExists(ctx, t, sourcePool, name) {
			t.Errorf("%q is declared dropped-by-baseline but does not exist on a Phase A database either", name)
		}
	}

	// (2) The difference between the two schemas, computed from the databases
	// themselves, is exactly the declared set — no more (an undeclared domain
	// would be an unexplained difference in the round trip) and no fewer (a
	// declared domain that still exists would make the declaration a lie).
	var missingFromBaseline []string
	for _, domain := range snapshot.RegisteredDomains() {
		onSource := tableExists(ctx, t, sourcePool, domain.Table)
		onTarget := tableExists(ctx, t, targetPool, domain.Table)
		switch {
		case onSource && !onTarget:
			missingFromBaseline = append(missingFromBaseline, domain.Name)
			if !db.BaselineDrops(domain.Name) {
				t.Errorf("domain %q is on the Phase A schema and not on the baseline, "+
					"and nothing declares why", domain.Name)
			}
		case !onSource && onTarget:
			t.Errorf("domain %q exists only on the baseline; the squash removes, it never invents", domain.Name)
		case !onSource && !onTarget:
			t.Errorf("registered domain %q exists on neither schema", domain.Name)
		}
	}
	sort.Strings(missingFromBaseline)
	if strings.Join(missingFromBaseline, ",") != strings.Join(db.BaselineDroppedTables(), ",") {
		t.Errorf("the declared transform does not match the schemas:\n  declared: %v\n  actual:   %v",
			db.BaselineDroppedTables(), missingFromBaseline)
	}

	// (3) The transform is named and versioned, because the report and the
	// runbook both quote it.
	if db.BaselineTransform == "" || db.BaselineTransformVersion == "" {
		t.Error("the dropped-by-baseline transform must carry a name and a version")
	}
}

// The rehearsal proper: a Phase A database with frozen legacy tables, exported,
// restored into a baseline database, re-exported, compared. Everything the gate
// already does — the checksum pass, the no-write dry run, the idempotent second
// import, the digest comparison — applies unchanged; the only new thing is that
// ten domains have nowhere to land, by design.
func TestPhaseBRoundTripIntoABaselineDatabase(t *testing.T) {
	adminURL := requireDatabase(t)
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Minute)
	defer cancel()

	repoRoot, err := findRepoRoot(".")
	if err != nil {
		t.Fatalf("locate the backend module: %v", err)
	}
	workdir := t.TempDir()
	if _, err := buildImporter(ctx, repoRoot, workdir); err != nil {
		if errors.Is(err, errImporterMissing) {
			t.Skipf("%v; the Phase B round trip needs the importer to restore anything", err)
		}
		t.Fatalf("build the importer: %v", err)
	}

	// The source is a Phase A database: legacy tables present and frozen, which
	// is the state the final snapshot is taken from (spec section 9 step 9).
	sourceURL, _ := phaseBSource(ctx, t, adminURL, true)

	// Selecting the baseline for this process makes the gate's own step 3 —
	// "create and migrate the disposable database" — build a baseline target.
	t.Setenv(db.BaselineEnvVar, "1")
	if db.ActiveProfile() != db.ProfileBaseline {
		t.Fatalf("ActiveProfile() = %s, want %s", db.ActiveProfile(), db.ProfileBaseline)
	}

	if reason := phaseBConsumerGap(ctx, t, adminURL); reason != "" {
		t.Skipf("the Phase B reader/importer transform is not in this tree yet: %s", reason)
	}

	report, err := run(ctx, options{
		AdminURL: adminURL, SourceURL: sourceURL, Workdir: workdir,
		GateDatabase: phaseBGateDatabase, RepoRoot: repoRoot,
		Logf: func(format string, args ...any) { t.Logf(format, args...) },
	})
	if err != nil {
		t.Fatalf("run the Phase B gate: %v", err)
	}
	if err := writeReports(report, workdir); err != nil {
		t.Fatalf("write the gate report: %v", err)
	}
	if !report.Passed {
		t.Log(report.summary())
		t.Fatalf("the Phase B round trip failed with %d findings", len(report.Failures))
	}

	// "Zero unexplained differences" is the gate's own bar. The extra Phase B
	// requirement is that the explained ones are exactly the declared drops,
	// listed by name — an explanation that says "some domains are missing" is
	// not an explanation.
	explainedDomains := map[string]bool{}
	for _, item := range report.Explained {
		for _, name := range db.BaselineDroppedTables() {
			if strings.Contains(item.Detail, name) || strings.Contains(item.Code, name) {
				explainedDomains[name] = true
			}
		}
	}
	for _, name := range db.BaselineDroppedTables() {
		if !explainedDomains[name] {
			t.Errorf("the gate report never names %q as a dropped-by-baseline domain; "+
				"a difference nobody named is not an explained difference", name)
		}
	}
}

// phaseBSource builds a Phase A database (the legacy chain) with the standard
// gate fixture in it, optionally frozen the way app/backfill leaves it at the
// end of a successful Phase A backfill.
func phaseBSource(ctx context.Context, t *testing.T, adminURL string, frozen bool) (string, *pgxpool.Pool) {
	t.Helper()
	// The fixture is seeded through db.Connect, which migrates with whatever
	// profile is active; the source must be Phase A regardless of what the
	// caller has selected for the target.
	t.Setenv(db.BaselineEnvVar, "")
	sourceURL, pool := seededSourceNamed(ctx, t, adminURL, phaseBSourceDatabase)
	if !frozen {
		return sourceURL, pool
	}
	// The same guard app/backfill installs, applied here directly: this test is
	// about the squash, not about re-running the backfill, and the exporter
	// keys its "legacy family is stale" decision off exactly this trigger name.
	if _, err := pool.Exec(ctx, `CREATE OR REPLACE FUNCTION inventory_legacy_freeze_guard() RETURNS trigger
		LANGUAGE plpgsql AS $$ BEGIN
			RAISE EXCEPTION 'legacy inventory table % is frozen; write inventory_operations instead',
				TG_TABLE_NAME USING ERRCODE='55000';
		END $$`); err != nil {
		t.Fatalf("create the freeze guard: %v", err)
	}
	for _, table := range backfill.FreezeTables {
		if _, err := pool.Exec(ctx, fmt.Sprintf(
			`DROP TRIGGER IF EXISTS inventory_legacy_freeze ON %s;
			 CREATE TRIGGER inventory_legacy_freeze BEFORE INSERT OR UPDATE OR DELETE ON %s
			 FOR EACH ROW EXECUTE FUNCTION inventory_legacy_freeze_guard()`, table, table)); err != nil {
			t.Fatalf("freeze %s: %v", table, err)
		}
	}
	return sourceURL, pool
}

// phaseBBaselineTarget creates a disposable database and migrates it with the
// baseline chain, whatever profile the process is otherwise running.
func phaseBBaselineTarget(ctx context.Context, t *testing.T, adminURL string) *pgxpool.Pool {
	t.Helper()
	targetURL, cleanup, err := freshDatabase(ctx, adminURL, phaseBGateDatabase)
	if err != nil {
		t.Fatalf("create the baseline target: %v", err)
	}
	t.Cleanup(cleanup)
	if err := db.MigrateProfile(ctx, targetURL, db.ProfileBaseline); err != nil {
		t.Fatalf("migrate the baseline target: %v", err)
	}
	// Deliberately not openUTCPool: that goes through the generation guard,
	// and this inspection pool exists precisely so a legacy-profile process
	// can look at a baseline database. Nothing here writes.
	pool, err := pgxpool.New(ctx, targetURL)
	if err != nil {
		t.Fatalf("connect the baseline target: %v", err)
	}
	t.Cleanup(pool.Close)
	return pool
}

// phaseBConsumerGap reports why the Phase B round trip cannot run yet, or "" if
// it can. It probes rather than hardcodes, so the moment the reader learns to
// accept a declared dropped-by-baseline domain this test starts running for
// real instead of skipping.
//
// The probe is the cheapest possible statement of the requirement: export an
// empty baseline database and read the artifact back with the same reader the
// gate uses. A baseline export legitimately omits the ten dropped domains, so a
// reader that still demands every registered domain rejects its own output.
func phaseBConsumerGap(ctx context.Context, t *testing.T, adminURL string) string {
	t.Helper()
	var gaps []string

	// Static gaps first, so one run reports all of them rather than the first.
	// The gate probes tables the baseline does not have before it restores
	// anything; if that list still names a dropped table the run dies in step 3.
	for _, probe := range emptyProbes {
		if db.BaselineDrops(probe) {
			gaps = append(gaps, fmt.Sprintf(
				"the gate's emptyProbes list still names %q, which the baseline drops", probe))
		}
	}

	probeDatabase := phaseBGateDatabase + "_probe"
	probeURL, cleanup, err := freshDatabase(ctx, adminURL, probeDatabase)
	if err != nil {
		t.Fatalf("create the probe database: %v", err)
	}
	defer cleanup()
	if err := db.MigrateProfile(ctx, probeURL, db.ProfileBaseline); err != nil {
		t.Fatalf("migrate the probe database: %v", err)
	}
	pool, err := openUTCPool(ctx, probeURL)
	if err != nil {
		gaps = append(gaps, fmt.Sprintf(
			"a baseline database is not connectable under the baseline profile: %v", err))
		return strings.Join(gaps, "; ")
	}
	defer pool.Close()

	directory := filepath.Join(t.TempDir(), "baseline-probe")
	if _, err := snapshot.Export(ctx, pool, snapshot.ExportOptions{
		OutputDirectory: directory, BusinessTimezone: "UTC", Currency: "USD",
	}); err != nil {
		gaps = append(gaps, fmt.Sprintf("snapshot.Export refuses a baseline database: %v", err))
		return strings.Join(gaps, "; ")
	}
	if _, err := snapshot.OpenArtifact(directory); err != nil {
		gaps = append(gaps, fmt.Sprintf("snapshot.OpenArtifact refuses a baseline export: %v", err))
	}
	if _, err := os.Stat(directory); err != nil {
		gaps = append(gaps, fmt.Sprintf("the probe export vanished: %v", err))
	}
	return strings.Join(gaps, "; ")
}

func tableExists(ctx context.Context, t *testing.T, pool *pgxpool.Pool, table string) bool {
	t.Helper()
	var present bool
	if err := pool.QueryRow(ctx,
		`SELECT to_regclass('public.' || $1) IS NOT NULL`, table).Scan(&present); err != nil {
		t.Fatalf("look up %s: %v", table, err)
	}
	return present
}
