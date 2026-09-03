package db

import (
	"context"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// ConnectOptions is the single knob set every entry point in the tree turns.
// The zero value is the strict path: no migrations, current generation only,
// no runtime parameters.
type ConnectOptions struct {
	// RunMigrations migrates to the head of the embedded chain before the
	// generation check. Only the API process and the importer do this.
	RunMigrations bool
	// AllowLegacy accepts a database of the previous generation. It forces
	// the pool read only; see ConnectLegacySource.
	AllowLegacy bool
	// RuntimeParams are extra GUCs for every connection in the pool (the
	// round-trip gate pins timezone=UTC this way).
	RuntimeParams map[string]string
}

// Connect opens a pgx pool, runs pending migrations, and refuses a database
// that is not this binary's schema generation. It is for the API process,
// which owns schema changes during startup.
func Connect(ctx context.Context, databaseURL string) (*pgxpool.Pool, error) {
	return ConnectWithOptions(ctx, databaseURL, ConnectOptions{RunMigrations: true})
}

// ConnectWithoutMigrations opens a pool without changing the schema. Workers
// must use this so they never race the API process during a deployment. The
// generation guard still applies: a worker attached to a database of another
// generation is exactly the failure review A6 describes, and it never gets
// the legacy exception (review OV3).
func ConnectWithoutMigrations(ctx context.Context, databaseURL string) (*pgxpool.Pool, error) {
	return ConnectWithOptions(ctx, databaseURL, ConnectOptions{})
}

// ConnectWithOptions is the one place a pool is opened. Every other Connect
// in this package delegates here, so the generation guard cannot be skipped
// by adding an entry point.
func ConnectWithOptions(ctx context.Context, databaseURL string, opts ConnectOptions) (*pgxpool.Pool, error) {
	pool, err := openPoolWithOptions(ctx, databaseURL, opts)
	if err != nil {
		return nil, err
	}
	if opts.RunMigrations {
		if err := migrate(ctx, pool); err != nil {
			pool.Close()
			return nil, err
		}
	}
	if err := CheckGeneration(ctx, pool, GenerationOptions{AllowLegacy: opts.AllowLegacy}); err != nil {
		pool.Close()
		return nil, err
	}
	return pool, nil
}

// openPool opens an unguarded pool with no options. The in-package migration
// tests use it to build deliberately half-migrated scratch databases, which
// by construction cannot pass the generation guard.
func openPool(ctx context.Context, databaseURL string) (*pgxpool.Pool, error) {
	return openPoolWithOptions(ctx, databaseURL, ConnectOptions{})
}

func openPoolWithOptions(ctx context.Context, databaseURL string, opts ConnectOptions) (*pgxpool.Pool, error) {
	config, err := pgxpool.ParseConfig(databaseURL)
	if err != nil {
		return nil, fmt.Errorf("connect postgres: %w", err)
	}
	if len(opts.RuntimeParams) > 0 {
		if config.ConnConfig.RuntimeParams == nil {
			config.ConnConfig.RuntimeParams = map[string]string{}
		}
		for key, value := range opts.RuntimeParams {
			config.ConnConfig.RuntimeParams[key] = value
		}
	}
	if opts.AllowLegacy {
		// The read-only exception is applied per connection rather than
		// through the URL, so it survives a pool growing new connections and
		// cannot be dropped by a caller-supplied connection string.
		previous := config.AfterConnect
		config.AfterConnect = func(ctx context.Context, conn *pgx.Conn) error {
			if previous != nil {
				if err := previous(ctx, conn); err != nil {
					return err
				}
			}
			_, err := conn.Exec(ctx, `SET default_transaction_read_only = on`)
			return err
		}
	}
	pool, err := pgxpool.NewWithConfig(ctx, config)
	if err != nil {
		return nil, fmt.Errorf("connect postgres: %w", err)
	}
	if err := pool.Ping(ctx); err != nil {
		pool.Close()
		return nil, fmt.Errorf("ping postgres: %w", err)
	}
	return pool, nil
}

// migrationLockID is an arbitrary constant that identifies the advisory lock
// guarding schema changes. Any value works as long as it never changes.
const migrationLockID int64 = 8123471290347123

// migrationTimeout bounds startup migrations. Generous, because one of them
// may rewrite a large table, but finite: without it a process that lost the
// race for the advisory lock to a wedged migrator waits forever, and the
// container never reports unhealthy (API-012).
const migrationTimeout = 15 * time.Minute

// migrate applies the chain this process was configured for. The two-chain
// selection lives in schema_profile.go; everything else about a startup
// migration (advisory lock, timeout, per-migration transactions) is shared.
func migrate(parent context.Context, pool *pgxpool.Pool) error {
	return migrateChain(parent, pool, activeChain())
}
