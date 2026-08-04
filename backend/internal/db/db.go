package db

import (
	"context"
	"embed"
	"fmt"

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
	if err := migrate(pool); err != nil {
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

func migrate(pool *pgxpool.Pool) error {
	goose.SetBaseFS(migrationsFS)
	if err := goose.SetDialect("postgres"); err != nil {
		return err
	}
	sqlDB := stdlib.OpenDBFromPool(pool)
	defer sqlDB.Close()

	// Serialise migrators behind one advisory lock. Two API processes coming
	// up together during a rolling deploy (or two test packages sharing a
	// database) otherwise race on the same DDL and one of them fails.
	ctx := context.Background()
	conn, err := sqlDB.Conn(ctx)
	if err != nil {
		return fmt.Errorf("acquire migration connection: %w", err)
	}
	defer conn.Close()
	if _, err := conn.ExecContext(ctx, `SELECT pg_advisory_lock($1)`, migrationLockID); err != nil {
		return fmt.Errorf("acquire migration lock: %w", err)
	}
	defer func() {
		_, _ = conn.ExecContext(ctx, `SELECT pg_advisory_unlock($1)`, migrationLockID)
	}()

	if err := goose.Up(sqlDB, "migrations"); err != nil {
		return fmt.Errorf("run migrations: %w", err)
	}
	return nil
}
