package db

import (
	"context"
	"embed"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/jackc/pgx/v5/stdlib"
	"github.com/pressly/goose/v3"
)

// Two migration chains ship in the binary during the Phase B rehearsal
// (spec section 9 steps 6-9).
//
//   - legacy-00001-00052 contains the 00001-00053 chain that builds the
//     current Phase A ledger. It stays the default, so
//     the same tree keeps serving, testing, and migrating on the current
//     schema while the squash is being rehearsed.
//   - migrations holds the single 00001_baseline.sql: the post-00053 schema
//     minus the dropped legacy quantity tables, stamped as its own generation.
//     It is selected explicitly, never by accident.
//
// Embedding both is deliberate. The alternative — a build tag — would mean the
// baseline could only be exercised by a second build, and the round-trip that
// proves the squash needs one process that can migrate a Phase A source and a
// baseline target in the same test run.
//
//go:embed legacy-00001-00052/*.sql
var legacyChainFS embed.FS

//go:embed migrations/*.sql
var baselineFS embed.FS

// Directory names inside the two embedded filesystems, and equally the two
// directory names under backend/internal/db on disk. goose needs the directory
// as well as the FS, and a handful of tests elsewhere in the tree drive goose
// straight off the working tree with os.DirFS("../../db") — they name the
// chain they mean through these constants rather than a bare "migrations",
// which after the squash means the baseline and not the chain.
const (
	LegacyChainDir = "legacy-00001-00052"
	BaselineDir    = "migrations"
)

// SchemaProfile names one of the two embedded chains.
type SchemaProfile string

const (
	// ProfileLegacyChain is 00001-00053: the schema every live database is
	// on today. Default.
	ProfileLegacyChain SchemaProfile = "legacy-chain"
	// ProfileBaseline is the squashed 00001_baseline.sql.
	ProfileBaseline SchemaProfile = "baseline"
)

// BaselineEnvVar selects ProfileBaseline when it is set to a true value
// (1, true, yes, on; case-insensitive). Anything else — including unset —
// leaves the binary on the legacy chain. There is deliberately no way to end
// up on the baseline by default: an operator who has not said "baseline" is
// working on the current schema.
const BaselineEnvVar = "BEEZ_SCHEMA_BASELINE"

type chainDefinition struct {
	profile    SchemaProfile
	fs         fs.FS
	dir        string
	generation string
}

var chains = map[SchemaProfile]chainDefinition{
	ProfileLegacyChain: {
		profile:    ProfileLegacyChain,
		fs:         legacyChainFS,
		dir:        LegacyChainDir,
		generation: Generation,
	},
	ProfileBaseline: {
		profile:    ProfileBaseline,
		fs:         baselineFS,
		dir:        BaselineDir,
		generation: BaselineGeneration,
	},
}

// ActiveProfile reports which chain this process migrates and guards against.
// It reads the environment on every call rather than caching at init so a test
// can switch profiles with t.Setenv; the read is a map lookup in libc's environ
// and never appears in a profile.
func ActiveProfile() SchemaProfile {
	switch strings.ToLower(strings.TrimSpace(os.Getenv(BaselineEnvVar))) {
	case "1", "true", "yes", "on":
		return ProfileBaseline
	default:
		return ProfileLegacyChain
	}
}

func activeChain() chainDefinition { return chains[ActiveProfile()] }

// ActiveGeneration is the schema generation this process expects. Under the
// default profile it is Generation; under the baseline it is
// BaselineGeneration. Every guard decision goes through here.
func ActiveGeneration() string { return activeChain().generation }

// GenerationFor reports the generation a database migrated with the named
// profile carries. Unknown profiles yield the empty string rather than a
// panic, because the only caller that can pass one is a test.
func GenerationFor(profile SchemaProfile) string { return chains[profile].generation }

var (
	maxVersionOnce sync.Map // SchemaProfile -> int64
)

// maxEmbeddedMigrationFor is the highest goose version in a chain, derived
// from the embedded FS rather than written down: a hardcoded number would keep
// passing after the next migration lands, which is exactly the drift the
// generation guard exists to catch.
func maxEmbeddedMigrationFor(profile SchemaProfile) int64 {
	if cached, ok := maxVersionOnce.Load(profile); ok {
		return cached.(int64)
	}
	chain, ok := chains[profile]
	if !ok {
		panic(fmt.Sprintf("unknown schema profile %q", profile))
	}
	version, err := highestVersion(chain)
	if err != nil {
		// An embedded FS that does not parse is a build-time defect: there is
		// no runtime recovery and no safe default, because a wrong default
		// disables the guard silently.
		panic(err)
	}
	maxVersionOnce.Store(profile, version)
	return version
}

func highestVersion(chain chainDefinition) (int64, error) {
	entries, err := fs.ReadDir(chain.fs, chain.dir)
	if err != nil {
		return 0, fmt.Errorf("read embedded migrations %s: %w", chain.dir, err)
	}
	var highest int64
	var found bool
	for _, entry := range entries {
		name := entry.Name()
		if entry.IsDir() || !strings.HasSuffix(name, ".sql") {
			continue
		}
		digits := name
		if cut := strings.IndexByte(name, '_'); cut >= 0 {
			digits = name[:cut]
		}
		version, err := strconv.ParseInt(digits, 10, 64)
		if err != nil {
			return 0, fmt.Errorf("embedded migration %q has no numeric version prefix", name)
		}
		if !found || version > highest {
			highest, found = version, true
		}
	}
	if !found {
		return 0, errors.New("embedded migrations FS holds no .sql migrations")
	}
	return highest, nil
}

// MigrateProfile migrates the database at databaseURL to the head of the named
// chain, without the generation guard. It exists for the Phase B tests and the
// rehearsal tooling, which have to build a Phase A source and a baseline target
// in one process; ordinary callers use Connect and get the guard.
func MigrateProfile(ctx context.Context, databaseURL string, profile SchemaProfile) error {
	if _, ok := chains[profile]; !ok {
		return fmt.Errorf("unknown schema profile %q", profile)
	}
	pool, err := openPool(ctx, databaseURL)
	if err != nil {
		return err
	}
	defer pool.Close()
	return migrateChain(ctx, pool, chains[profile])
}

// migrateChain applies one chain to an already-open pool. It is the single
// place goose's process-global dialect and base FS are set, so two chains can
// never be half-mixed: the base FS is set immediately before the run, under
// the same advisory lock that serialises migrators.
func migrateChain(parent context.Context, pool *pgxpool.Pool, chain chainDefinition) error {
	if err := goose.SetDialect("postgres"); err != nil {
		return err
	}
	sqlDB := stdlib.OpenDBFromPool(pool)
	defer sqlDB.Close()

	ctx, cancel := context.WithTimeout(parent, migrationTimeout)
	defer cancel()

	conn, err := sqlDB.Conn(ctx)
	if err != nil {
		return fmt.Errorf("acquire migration connection: %w", err)
	}
	defer conn.Close()
	if _, err := conn.ExecContext(ctx, `SELECT pg_advisory_lock($1)`, migrationLockID); err != nil {
		return fmt.Errorf("acquire migration lock: %w", err)
	}
	defer func() {
		// The unlock must not inherit a cancelled or expired ctx, or the
		// session-scoped lock would only be released when the pooled
		// connection is eventually closed — blocking the next deploy.
		unlockCtx, unlockCancel := context.WithTimeout(
			context.WithoutCancel(parent), 10*time.Second)
		defer unlockCancel()
		_, _ = conn.ExecContext(unlockCtx, `SELECT pg_advisory_unlock($1)`, migrationLockID)
	}()

	goose.SetBaseFS(chain.fs)
	// Each migration runs in its own transaction, so a cancel (SIGTERM) or
	// the timeout rolls the in-flight one back rather than leaving a
	// half-applied schema.
	if err := goose.UpContext(ctx, sqlDB, chain.dir); err != nil {
		return fmt.Errorf("run migrations: %w", err)
	}
	return nil
}
