package db

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"strconv"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Generation is the schema generation of the legacy 00001-00053 chain — the
// Phase A ledger, and the schema every database in service today carries. It
// is stamped by migration 00051; a database claiming anything else is a
// different schema wearing the same goose chain (design review A6).
const Generation = "ledger-v1"

// BaselineGeneration is the schema generation of the Phase B squash
// (00001_baseline.sql). It is deliberately a different string from Generation:
// the baseline is goose version 1, so without a distinct stamp a database still
// sitting on the old chain would look "already migrated" to a baseline binary,
// which is exactly the hole A6 describes.
const BaselineGeneration = "ledger-v1-baseline"

// LegacyGeneration is the classification of a database that predates the
// stamp entirely — no schema_generation table. It is not a value any
// migration writes; it is what "no answer" means.
const LegacyGeneration = "legacy"

// ExpectedMaxMigration reports the goose version this binary expects a
// database of ActiveGeneration to be at: 53 on the legacy chain, 1 on the
// baseline. It is derived from the embedded FS rather than hardcoded, so
// adding a migration cannot leave the guard behind.
func ExpectedMaxMigration() int64 { return maxEmbeddedMigrationFor(ActiveProfile()) }

// Generation guard failure reasons. They are stable strings so callers and
// tests branch on the shape of the failure rather than on its prose.
const (
	// ReasonMissingTable: the database predates the stamp entirely.
	ReasonMissingTable = "missing-generation-table"
	// ReasonGenerationMismatch: the stamp exists but names another
	// generation, or has been deleted or duplicated.
	ReasonGenerationMismatch = "generation-mismatch"
	// ReasonMigrationMismatch: right generation, foreign goose chain head.
	ReasonMigrationMismatch = "migration-version-mismatch"
	// ReasonNotReadOnly: a legacy source was accepted onto a connection that
	// is not read only, which the exception never permits.
	ReasonNotReadOnly = "legacy-source-not-read-only"
)

// GenerationError is the typed refusal every entry point returns for a
// database this binary was not built for. It always names the actual value
// beside the expected one, because the operator's next action (recreate the
// database, deploy the matching binary, or pass --legacy-source) depends
// entirely on which of the two is wrong.
type GenerationError struct {
	Reason   string
	Actual   string
	Expected string
	// Hint is the operator-facing next step, appended to the message.
	Hint string
}

func (e *GenerationError) Error() string {
	message := fmt.Sprintf("schema generation guard: %s (actual %s, expected %s)",
		e.Reason, e.Actual, e.Expected)
	if e.Hint != "" {
		message += "; " + e.Hint
	}
	return message
}

// IsGenerationError reports whether err is a guard refusal, and yields it.
func IsGenerationError(err error) (*GenerationError, bool) {
	var target *GenerationError
	ok := errors.As(err, &target)
	return target, ok
}

// GenerationOptions tunes the guard for the one caller that is allowed a
// foreign schema.
type GenerationOptions struct {
	// AllowLegacy accepts LegacyGeneration in addition to Generation. It is
	// honoured ONLY on a connection whose default_transaction_read_only is
	// on: the exception exists so the translate gate can export the old
	// database, never so anything can write to it (design review OV3).
	AllowLegacy bool
}

// generationQuerier is the read surface the guard needs, so it works against
// a pool, a single connection, or a transaction.
type generationQuerier interface {
	QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
	Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error)
}

// CheckGeneration refuses a database that is not the generation this binary
// was built for. Every Connect path calls it after migrations, so no entry
// point can forget it.
func CheckGeneration(ctx context.Context, pool generationQuerier, opts GenerationOptions) error {
	generation, err := detectGeneration(ctx, pool)
	if err != nil {
		return err
	}

	expected := ActiveGeneration()
	switch generation {
	case expected:
		// Right generation: the goose head must match too, or this database
		// has been moved by some other build of the chain.
		return checkMigrationVersion(ctx, pool)

	case LegacyGeneration:
		if !opts.AllowLegacy {
			return &GenerationError{
				Reason: ReasonMissingTable, Actual: LegacyGeneration, Expected: expected,
				Hint: "this database predates the schema_generation stamp; recreate it from the current migrations, " +
					"or read it with export-snapshot --legacy-source",
			}
		}
		// The exception is read only or it is not granted.
		return requireReadOnly(ctx, pool)

	default:
		return &GenerationError{
			Reason: ReasonGenerationMismatch, Actual: generation, Expected: expected,
			Hint: "recreate the database from the current migrations, or run the binary built for that generation",
		}
	}
}

// detectGeneration classifies the database. A missing table is not an error:
// it is the definition of LegacyGeneration.
func detectGeneration(ctx context.Context, pool generationQuerier) (string, error) {
	var stamped *string
	if err := pool.QueryRow(ctx,
		`SELECT to_regclass('public.schema_generation')::text`).Scan(&stamped); err != nil {
		return "", fmt.Errorf("look up schema_generation: %w", err)
	}
	if stamped == nil {
		return LegacyGeneration, nil
	}

	rows, err := pool.Query(ctx, `SELECT generation FROM public.schema_generation ORDER BY generation`)
	if err != nil {
		return "", fmt.Errorf("read schema_generation: %w", err)
	}
	defer rows.Close()
	var generations []string
	for rows.Next() {
		var value string
		if err := rows.Scan(&value); err != nil {
			return "", fmt.Errorf("read schema_generation: %w", err)
		}
		generations = append(generations, value)
	}
	if err := rows.Err(); err != nil {
		return "", fmt.Errorf("read schema_generation: %w", err)
	}

	switch len(generations) {
	case 1:
		return generations[0], nil
	case 0:
		// A table with no row is a rewritten stamp, not a legacy database:
		// somebody deleted the row. Refusing is the whole point.
		return "", &GenerationError{
			Reason: ReasonGenerationMismatch, Actual: "no row in schema_generation", Expected: ActiveGeneration(),
			Hint: "the generation stamp was deleted; recreate the database from the current migrations",
		}
	default:
		sort.Strings(generations)
		return "", &GenerationError{
			Reason:   ReasonGenerationMismatch,
			Actual:   fmt.Sprintf("%d rows in schema_generation (%s)", len(generations), strings.Join(generations, ", ")),
			Expected: ActiveGeneration(),
			Hint:     "exactly one generation row is expected; recreate the database from the current migrations",
		}
	}
}

// checkMigrationVersion compares the goose chain head against the embedded
// migrations. A database ahead of this binary was migrated by a newer build
// and may hold a schema this one cannot read; a database behind it never
// finished migrating.
func checkMigrationVersion(ctx context.Context, pool generationQuerier) error {
	var actual *int64
	err := pool.QueryRow(ctx, `
		SELECT COALESCE(MAX(version_id) FILTER (WHERE is_applied), 0)
		FROM public.goose_db_version`).Scan(&actual)
	if err != nil {
		// A stamped database without goose_db_version is incoherent: the
		// stamp is only ever written by a migration.
		return &GenerationError{
			Reason: ReasonMigrationMismatch, Actual: "no goose_db_version table",
			Expected: strconv.FormatInt(ExpectedMaxMigration(), 10),
			Hint:     "recreate the database from the current migrations",
		}
	}
	var version int64
	if actual != nil {
		version = *actual
	}
	if version != ExpectedMaxMigration() {
		return &GenerationError{
			Reason:   ReasonMigrationMismatch,
			Actual:   strconv.FormatInt(version, 10),
			Expected: strconv.FormatInt(ExpectedMaxMigration(), 10),
			Hint: "this database was migrated by a different build of the chain; " +
				"deploy the matching binary or recreate the database",
		}
	}
	return nil
}

// requireReadOnly proves the legacy exception is actually read only. Setting
// the GUC and then trusting it is not enough: a role default, a connection
// string parameter, or a pool option could have overridden it, and the
// exception is only safe because writes are impossible.
func requireReadOnly(ctx context.Context, pool generationQuerier) error {
	var setting string
	if err := pool.QueryRow(ctx, `SHOW default_transaction_read_only`).Scan(&setting); err != nil {
		return fmt.Errorf("read default_transaction_read_only: %w", err)
	}
	if setting != "on" {
		return &GenerationError{
			Reason: ReasonNotReadOnly, Actual: "default_transaction_read_only=" + setting,
			Expected: "default_transaction_read_only=on",
			Hint:     "a legacy-generation database may only be opened read only",
		}
	}
	return nil
}

// ConnectLegacySource opens the ONE connection in the system allowed to reach
// a database of the previous generation: read only, for
// export-snapshot --legacy-source and the round-trip gate's source. Every
// other entry point uses Connect or ConnectWithoutMigrations and refuses.
func ConnectLegacySource(ctx context.Context, databaseURL string) (*pgxpool.Pool, error) {
	return ConnectWithOptions(ctx, databaseURL, ConnectOptions{AllowLegacy: true})
}
