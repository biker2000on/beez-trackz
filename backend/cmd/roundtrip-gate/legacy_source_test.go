package main

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/biker2000on/beez-trackz/backend/internal/db"
)

// The generation guard's gate row of the design's section 12 plan. The gate
// is the one caller allowed to read a database of the previous generation,
// and only through its SOURCE connection: the disposable target it creates
// and migrates itself is always strict.

const legacyFixtureDatabase = "beez_trackz_test_guard_gate_source"

// demoteToLegacy turns a fully migrated fixture into one shaped like a
// database from before the generation stamp: no schema_generation table and a
// goose head one short of this binary's. Rewinding a real chain would need
// the migrations FS, which lives unexported in internal/db; removing the
// stamp produces the same two facts the guard actually reads.
func demoteToLegacy(ctx context.Context, t *testing.T, pool *pgxpool.Pool) {
	t.Helper()
	if _, err := pool.Exec(ctx, `DROP TABLE schema_generation`); err != nil {
		t.Fatalf("drop the generation stamp: %v", err)
	}
	if _, err := pool.Exec(ctx,
		`DELETE FROM goose_db_version WHERE version_id >= $1`, db.ExpectedMaxMigration()); err != nil {
		t.Fatalf("rewind the goose head: %v", err)
	}
}

// The gate's source connection refuses a legacy database by default and
// accepts it under -legacy-source — read only, provably.
func TestGateSourceConnectionHonoursLegacySourceOnlyReadOnly(t *testing.T) {
	adminURL := requireDatabase(t)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()

	sourceURL, pool := seededSourceNamed(ctx, t, adminURL, legacyFixtureDatabase)
	demoteToLegacy(ctx, t, pool)
	pool.Close()

	// Default: the gate treats a foreign generation as a broken run.
	if _, err := openSourcePool(ctx, sourceURL, false); err == nil {
		t.Fatal("the gate opened a legacy source without -legacy-source")
	} else if guardErr, ok := db.IsGenerationError(err); !ok {
		t.Fatalf("expected a generation guard refusal, got %T: %v", err, err)
	} else if guardErr.Reason != db.ReasonMissingTable {
		t.Fatalf("reason = %q, want %q", guardErr.Reason, db.ReasonMissingTable)
	}

	// The disposable target never gets the exception, whatever the source is.
	if _, err := openUTCPool(ctx, sourceURL); err == nil {
		t.Fatal("the strict target path accepted a legacy database")
	}

	legacy, err := openSourcePool(ctx, sourceURL, true)
	if err != nil {
		t.Fatalf("open the legacy source: %v", err)
	}
	defer legacy.Close()

	// UTC still holds: -legacy-source relaxes the generation, not the
	// calendar the comparison depends on.
	var timezone string
	if err := legacy.QueryRow(ctx, `SHOW timezone`).Scan(&timezone); err != nil {
		t.Fatalf("read timezone: %v", err)
	}
	if timezone != "UTC" {
		t.Fatalf("timezone = %q, want UTC", timezone)
	}

	_, err = legacy.Exec(ctx, `DELETE FROM apiaries`)
	var pgErr *pgconn.PgError
	if !errors.As(err, &pgErr) || pgErr.Code != "25006" {
		t.Fatalf("writing to the legacy source returned %v, want SQLSTATE 25006", err)
	}
}

// The P0 runbook, end to end, against a source of the previous generation
// through -legacy-source. This is the shape the pre-reset rehearsal actually
// has: an old database exported, restored into a disposable target at the
// current chain head, and compared.
func TestRoundTripGatePassesAgainstALegacySource(t *testing.T) {
	adminURL := requireDatabase(t)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
	defer cancel()

	repoRoot, err := findRepoRoot(".")
	if err != nil {
		t.Fatalf("locate the backend module: %v", err)
	}
	workdir := t.TempDir()
	if _, err := buildImporter(ctx, repoRoot, workdir); err != nil {
		if errors.Is(err, errImporterMissing) {
			t.Skipf("%v; the round-trip gate needs the importer to restore anything", err)
		}
		t.Fatalf("build the importer: %v", err)
	}

	sourceURL, pool := seededSourceNamed(ctx, t, adminURL, legacyFixtureDatabase)
	demoteToLegacy(ctx, t, pool)
	pool.Close()

	report, err := run(ctx, options{
		AdminURL: adminURL, SourceURL: sourceURL, Workdir: workdir,
		GateDatabase: "beez_trackz_test_guard_gate_target", RepoRoot: repoRoot,
		LegacySource: true,
		Logf:         func(format string, args ...any) { t.Logf(format, args...) },
	})
	if err != nil {
		t.Fatalf("run the gate: %v", err)
	}
	if !report.Passed {
		t.Log(report.summary())
		t.Fatalf("the gate failed against a legacy source with %d findings", len(report.Failures))
	}
	// The target is one migration ahead of the legacy source; the gate must
	// classify that as explained, not as a failure, and must have said so.
	explainedAhead := false
	for _, item := range report.Explained {
		if item.Code == "schema-migration-ahead" {
			explainedAhead = true
		}
	}
	if !explainedAhead {
		t.Error("a legacy source restored into the current chain did not record schema-migration-ahead")
	}
}
