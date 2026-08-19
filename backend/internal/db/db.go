package db

import (
	"context"
	"embed"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/jackc/pgx/v5/stdlib"
	"github.com/pressly/goose/v3"
)

//go:embed migrations/*.sql
var migrationsFS embed.FS

// Connect opens a pgx pool and runs pending migrations. It is for the API
// process, which owns schema changes during startup.
func Connect(ctx context.Context, databaseURL string) (*pgxpool.Pool, error) {
	pool, err := openPool(ctx, databaseURL)
	if err != nil {
		return nil, err
	}
	if err := migrate(ctx, pool); err != nil {
		pool.Close()
		return nil, err
	}
	return pool, nil
}

// ConnectWithoutMigrations opens a pool without changing the schema. Workers
// must use this so they never race the API process during a deployment.
func ConnectWithoutMigrations(ctx context.Context, databaseURL string) (*pgxpool.Pool, error) {
	return openPool(ctx, databaseURL)
}

func openPool(ctx context.Context, databaseURL string) (*pgxpool.Pool, error) {
	pool, err := pgxpool.New(ctx, databaseURL)
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

func migrate(parent context.Context, pool *pgxpool.Pool) error {
	goose.SetBaseFS(migrationsFS)
	if err := goose.SetDialect("postgres"); err != nil {
		return err
	}
	sqlDB := stdlib.OpenDBFromPool(pool)
	defer sqlDB.Close()

	// parent is cancelled on SIGTERM/SIGINT, so an operator can abort a
	// startup that is stuck waiting on the lock instead of having to kill
	// the container.
	ctx, cancel := context.WithTimeout(parent, migrationTimeout)
	defer cancel()

	// Serialise migrators behind one advisory lock. Two API processes coming
	// up together during a rolling deploy (or two test packages sharing a
	// database) otherwise race on the same DDL and one of them fails.
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

	// Each migration runs in its own transaction, so a cancel (SIGTERM) or
	// the timeout rolls the in-flight one back rather than leaving a
	// half-applied schema.
	if err := goose.UpContext(ctx, sqlDB, "migrations"); err != nil {
		return fmt.Errorf("run migrations: %w", err)
	}
	return nil
}
