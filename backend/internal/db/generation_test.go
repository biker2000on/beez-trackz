package db

import (
	"context"
	"errors"
	"io/fs"
	"os"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgconn"
)

// The generation guard's test row in the design's section 12 plan. Every
// database-backed test here skips cleanly without TEST_DATABASE_URL and
// builds its own scratch database beside the configured one, because it
// deliberately leaves that database in states no other test may see.

func requireGuardDatabase(t *testing.T) string {
	t.Helper()
	url := os.Getenv("TEST_DATABASE_URL")
	if url == "" {
		t.Skip("TEST_DATABASE_URL is not configured")
	}
	return url
}

func guardContext(t *testing.T) context.Context {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Minute)
	t.Cleanup(cancel)
	return ctx
}

// requireGenerationError asserts the refusal is the typed one, with the named
// reason, and that its message actually names the actual value beside the
// expected one — an error that says only "wrong generation" leaves the
// operator with nothing to act on.
func requireGenerationError(t *testing.T, err error, reason string, actualSubstring string) {
	t.Helper()
	if err == nil {
		t.Fatalf("expected a generation guard refusal (%s), got nil", reason)
	}
	guardErr, ok := IsGenerationError(err)
	if !ok {
		t.Fatalf("expected a *GenerationError, got %T: %v", err, err)
	}
	if guardErr.Reason != reason {
		t.Fatalf("reason = %q, want %q (%v)", guardErr.Reason, reason, err)
	}
	if actualSubstring != "" && !strings.Contains(guardErr.Actual, actualSubstring) {
		t.Fatalf("actual = %q, want it to name %q", guardErr.Actual, actualSubstring)
	}
	if guardErr.Expected == "" {
		t.Fatalf("the refusal did not name an expected value: %v", err)
	}
	if !strings.Contains(err.Error(), guardErr.Actual) || !strings.Contains(err.Error(), guardErr.Expected) {
		t.Fatalf("the message must name actual and expected: %v", err)
	}
}

// The expected goose head is derived from the embedded FS, not written down.
// A hardcoded number is the exact failure the guard exists to catch: it would
// keep passing after the next migration lands.
func TestExpectedMaxMigrationIsDerivedFromTheEmbeddedChain(t *testing.T) {
	entries, err := fs.ReadDir(legacyChainFS, LegacyChainDir)
	if err != nil {
		t.Fatalf("read embedded migrations: %v", err)
	}
	var highest int64
	var stampFound bool
	for _, entry := range entries {
		name := entry.Name()
		if !strings.HasSuffix(name, ".sql") {
			continue
		}
		if strings.HasSuffix(name, "_schema_generation.sql") {
			stampFound = true
		}
		version, err := strconv.ParseInt(name[:strings.IndexByte(name, '_')], 10, 64)
		if err != nil {
			t.Fatalf("migration %q has no numeric prefix: %v", name, err)
		}
		if version > highest {
			highest = version
		}
	}
	if !stampFound {
		t.Fatal("no *_schema_generation.sql migration is embedded")
	}
	if got := ExpectedMaxMigration(); got != highest {
		t.Fatalf("ExpectedMaxMigration() = %d, want %d", got, highest)
	}
	if highest < 51 {
		t.Fatalf("the stamp migration is 00051; embedded head is %d", highest)
	}
}

// A database this binary migrated is stamped with this binary's generation
// and sits at this binary's chain head. Both Connect paths accept it.
func TestFreshDatabaseIsStampedLedgerV1(t *testing.T) {
	adminURL := requireGuardDatabase(t)
	ctx := guardContext(t)

	const name = "beez_trackz_test_guard_fresh"
	_, cleanup := freshDatabase(ctx, t, name)
	defer cleanup()
	url := replaceDatabase(adminURL, name)

	pool, err := Connect(ctx, url)
	if err != nil {
		t.Fatalf("Connect a fresh database: %v", err)
	}
	defer pool.Close()

	var generation string
	if err := pool.QueryRow(ctx, `SELECT generation FROM schema_generation`).Scan(&generation); err != nil {
		t.Fatalf("read the generation stamp: %v", err)
	}
	if generation != Generation {
		t.Fatalf("generation = %q, want %q", generation, Generation)
	}
	var gooseMax int64
	if err := pool.QueryRow(ctx,
		`SELECT COALESCE(MAX(version_id) FILTER (WHERE is_applied), 0) FROM goose_db_version`).Scan(&gooseMax); err != nil {
		t.Fatalf("read goose head: %v", err)
	}
	if gooseMax != ExpectedMaxMigration() {
		t.Fatalf("goose head = %d, want %d", gooseMax, ExpectedMaxMigration())
	}

	// The worker's entry point (and the importer's dry run) must accept it.
	worker, err := ConnectWithoutMigrations(ctx, url)
	if err != nil {
		t.Fatalf("ConnectWithoutMigrations a fresh database: %v", err)
	}
	worker.Close()
}

// The stamp is only useful if tampering with it is refused. Deleting the row
// and rewriting it to another generation are the two shapes an operator
// actually produces (a hand-run DELETE, or a restore from another chain).
func TestRewrittenGenerationStampIsRefused(t *testing.T) {
	adminURL := requireGuardDatabase(t)
	ctx := guardContext(t)

	const name = "beez_trackz_test_guard_stamp"
	scratch, cleanup := freshDatabase(ctx, t, name)
	defer cleanup()
	url := replaceDatabase(adminURL, name)

	migrated, err := Connect(ctx, url)
	if err != nil {
		t.Fatalf("migrate the scratch database: %v", err)
	}
	migrated.Close()

	// (1) the row is gone.
	mustExec(ctx, t, scratch, `DELETE FROM schema_generation`)
	_, err = Connect(ctx, url)
	requireGenerationError(t, err, ReasonGenerationMismatch, "no row")
	_, err = ConnectWithoutMigrations(ctx, url)
	requireGenerationError(t, err, ReasonGenerationMismatch, "no row")

	// (2) the row names another generation. Migrations are already applied,
	// so goose has nothing to say and only the stamp catches this.
	mustExec(ctx, t, scratch, `INSERT INTO schema_generation (generation) VALUES ('ledger-v0')`)
	_, err = Connect(ctx, url)
	requireGenerationError(t, err, ReasonGenerationMismatch, "ledger-v0")
	_, err = ConnectWithoutMigrations(ctx, url)
	requireGenerationError(t, err, ReasonGenerationMismatch, "ledger-v0")

	// (3) two generations claimed at once is as wrong as none.
	mustExec(ctx, t, scratch, `INSERT INTO schema_generation (generation) VALUES ($1)`, Generation)
	_, err = ConnectWithoutMigrations(ctx, url)
	requireGenerationError(t, err, ReasonGenerationMismatch, "2 rows")
}

// A database carrying the right stamp but a goose head this binary does not
// know was migrated by a different build of the chain. Serving it would mean
// running against a schema this code has never seen.
func TestForeignGooseMaxIsRefused(t *testing.T) {
	adminURL := requireGuardDatabase(t)
	ctx := guardContext(t)

	const name = "beez_trackz_test_guard_goosemax"
	scratch, cleanup := freshDatabase(ctx, t, name)
	defer cleanup()
	url := replaceDatabase(adminURL, name)

	migrated, err := Connect(ctx, url)
	if err != nil {
		t.Fatalf("migrate the scratch database: %v", err)
	}
	migrated.Close()

	mustExec(ctx, t, scratch,
		`INSERT INTO goose_db_version (version_id, is_applied, tstamp) VALUES (99999, true, now())`)

	_, err = Connect(ctx, url)
	requireGenerationError(t, err, ReasonMigrationMismatch, "99999")
	_, err = ConnectWithoutMigrations(ctx, url)
	requireGenerationError(t, err, ReasonMigrationMismatch, "99999")
}

// The legacy exception: refused everywhere except an explicitly read-only
// source connection, and read-only there for real.
func TestLegacyDatabaseIsRefusedExceptAsAReadOnlySource(t *testing.T) {
	adminURL := requireGuardDatabase(t)
	ctx := guardContext(t)

	const name = "beez_trackz_test_guard_legacy"
	scratch, cleanup := freshDatabase(ctx, t, name)
	defer cleanup()
	url := replaceDatabase(adminURL, name)

	// Everything up to but not including the stamp migration (00051): no
	// schema_generation table at all, which is the definition of 'legacy'.
	// Named rather than derived from the chain head so later migrations
	// (00052 onward) cannot silently move the fixture past the stamp.
	const stampMigration int64 = 51
	if err := migrateTo(scratch, stampMigration-1); err != nil {
		t.Fatalf("migrate to the pre-stamp schema: %v", err)
	}
	var stamped *string
	if err := scratch.QueryRow(ctx,
		`SELECT to_regclass('public.schema_generation')::text`).Scan(&stamped); err != nil {
		t.Fatalf("look up schema_generation: %v", err)
	}
	if stamped != nil {
		t.Fatalf("the pre-stamp schema already has schema_generation (%q)", *stamped)
	}

	// The worker's entry point — and the importer's dry run, which shares it
	// — refuse a legacy database outright. Neither ever gets the exception.
	_, err := ConnectWithoutMigrations(ctx, url)
	requireGenerationError(t, err, ReasonMissingTable, LegacyGeneration)

	// The exception, granted.
	legacy, err := ConnectLegacySource(ctx, url)
	if err != nil {
		t.Fatalf("ConnectLegacySource: %v", err)
	}
	defer legacy.Close()

	var readOnly string
	if err := legacy.QueryRow(ctx, `SHOW default_transaction_read_only`).Scan(&readOnly); err != nil {
		t.Fatalf("read default_transaction_read_only: %v", err)
	}
	if readOnly != "on" {
		t.Fatalf("default_transaction_read_only = %q, want on", readOnly)
	}

	// Reading is the whole point, and must work.
	var apiaries int64
	if err := legacy.QueryRow(ctx, `SELECT COUNT(*) FROM apiaries`).Scan(&apiaries); err != nil {
		t.Fatalf("read from the legacy source: %v", err)
	}

	// Writing must be impossible, and impossible for the reason we claim:
	// SQLSTATE 25006, read_only_sql_transaction.
	_, err = legacy.Exec(ctx,
		`INSERT INTO apiaries (id, name) VALUES ('99000000-0000-4000-8000-000000000001','nope')`)
	var pgErr *pgconn.PgError
	if !errors.As(err, &pgErr) {
		t.Fatalf("writing to the legacy source returned %v, want a PgError", err)
	}
	if pgErr.Code != "25006" {
		t.Fatalf("write to the legacy source failed with SQLSTATE %s, want 25006", pgErr.Code)
	}

	// The exception is not granted on a connection that is not read only,
	// even when the caller asks for it. Setting the GUC and trusting it would
	// let a role default or a connection string silently re-arm writes.
	readWrite, err := openPool(ctx, url)
	if err != nil {
		t.Fatalf("open an unguarded pool: %v", err)
	}
	defer readWrite.Close()
	requireGenerationError(t,
		CheckGeneration(ctx, readWrite, GenerationOptions{AllowLegacy: true}),
		ReasonNotReadOnly, "default_transaction_read_only=off")

	// Migrating a pre-stamp database forward is still the ordinary path: the
	// guard refuses a foreign generation, it does not refuse the chain.
	forward, err := Connect(ctx, url)
	if err != nil {
		t.Fatalf("Connect must migrate a pre-stamp database forward: %v", err)
	}
	defer forward.Close()
	var generation string
	if err := forward.QueryRow(ctx, `SELECT generation FROM schema_generation`).Scan(&generation); err != nil {
		t.Fatalf("read the generation stamp: %v", err)
	}
	if generation != Generation {
		t.Fatalf("generation after migrating forward = %q, want %q", generation, Generation)
	}
}
