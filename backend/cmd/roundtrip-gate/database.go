package main

import (
	"context"
	"fmt"
	"net/url"
	"regexp"
	"strings"

	"github.com/jackc/pgx/v5/pgxpool"
)

// gateDatabaseName is the disposable database this driver creates, uses, and
// drops. It is deliberately distinct from the sibling names the in-process
// migration tests use (beez_money_migration and friends) so a gate run and a
// `go test ./internal/db` run cannot collide, and it is never the database
// named in the URL the operator passed.
const gateDatabaseName = "beez_roundtrip_gate"

var databaseNamePattern = regexp.MustCompile(`^[a-z_][a-z0-9_]{0,62}$`)

// replaceDatabase rewrites the database path of a Postgres URL, keeping the
// query string (sslmode and friends). It is the freshDatabase rewrite from
// backend/internal/db/money_migration_test.go, which is the pattern the gate
// design tells this driver to copy.
func replaceDatabase(databaseURL, name string) string {
	base, query, hasQuery := strings.Cut(databaseURL, "?")
	slash := strings.LastIndex(base, "/")
	if slash < 0 {
		return databaseURL
	}
	replaced := base[:slash+1] + name
	if hasQuery {
		return replaced + "?" + query
	}
	return replaced
}

// databaseNameOf reports the database a URL points at, for the refusal below
// and for the report.
func databaseNameOf(databaseURL string) string {
	parsed, err := url.Parse(databaseURL)
	if err != nil {
		return ""
	}
	return strings.TrimPrefix(parsed.Path, "/")
}

// redactURL keeps credentials out of the gate report, which is written to
// operator storage and pasted into tickets.
func redactURL(databaseURL string) string {
	parsed, err := url.Parse(databaseURL)
	if err != nil {
		return "(unparseable url)"
	}
	if parsed.User != nil {
		parsed.User = url.User(parsed.User.Username())
	}
	parsed.RawQuery = ""
	return parsed.String()
}

// freshDatabase drops and creates the disposable database and returns its
// URL plus a cleanup. The admin URL is only ever used to issue CREATE/DROP:
// the gate never restores into it, and never touches its tables.
func freshDatabase(ctx context.Context, adminURL, name string) (string, func(), error) {
	if !databaseNamePattern.MatchString(name) {
		return "", nil, fmt.Errorf("refusing to create database %q: not a plain lowercase identifier", name)
	}
	if existing := databaseNameOf(adminURL); existing == name {
		// The whole point of the disposable database is that the gate never
		// writes into a database somebody handed it.
		return "", nil, fmt.Errorf(
			"refusing to use %q as the disposable gate database: it is the database in -database", name)
	}
	admin, err := pgxpool.New(ctx, adminURL)
	if err != nil {
		return "", nil, fmt.Errorf("connect admin database: %w", err)
	}
	if _, err := admin.Exec(ctx, "DROP DATABASE IF EXISTS "+name); err != nil {
		admin.Close()
		return "", nil, fmt.Errorf("drop %s: %w", name, err)
	}
	if _, err := admin.Exec(ctx, "CREATE DATABASE "+name); err != nil {
		admin.Close()
		return "", nil, fmt.Errorf("create %s: %w", name, err)
	}
	cleanup := func() {
		_, _ = admin.Exec(context.WithoutCancel(ctx), "DROP DATABASE IF EXISTS "+name)
		admin.Close()
	}
	return replaceDatabase(adminURL, name), cleanup, nil
}

// openUTCPool opens a pool whose every connection is in UTC, matching
// cmd/migrate-legacy and the export/restore/comparison sessions the design
// requires. A comparison probe that ran in the operator's local timezone
// would re-derive year buckets differently from the exporter.
func openUTCPool(ctx context.Context, databaseURL string) (*pgxpool.Pool, error) {
	config, err := pgxpool.ParseConfig(databaseURL)
	if err != nil {
		return nil, fmt.Errorf("parse database url: %w", err)
	}
	if config.ConnConfig.RuntimeParams == nil {
		config.ConnConfig.RuntimeParams = map[string]string{}
	}
	config.ConnConfig.RuntimeParams["timezone"] = "UTC"
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

// fingerprintDatabase is the content contract of design section 4.1: per
// table, a row count plus an order-independent digest of every row's md5.
//
// pg_stat_user_tables is explicitly not used. PostgreSQL counts tuples that a
// later ROLLBACK discards, so a dry run that inserted and rolled back would
// look identical to one that committed. This fingerprint answers the question
// the counters cannot: are the rows still exactly the rows that were there.
func fingerprintDatabase(ctx context.Context, pool *pgxpool.Pool) (fingerprintSet, error) {
	rows, err := pool.Query(ctx, `
		SELECT c.relname
		FROM pg_class c
		JOIN pg_namespace n ON n.oid = c.relnamespace
		WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relname <> 'goose_db_version'
		ORDER BY c.relname`)
	if err != nil {
		return nil, fmt.Errorf("list tables: %w", err)
	}
	var tables []string
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			rows.Close()
			return nil, err
		}
		tables = append(tables, name)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}
	out := make(fingerprintSet, len(tables))
	for _, table := range tables {
		if !databaseNamePattern.MatchString(table) {
			return nil, fmt.Errorf("refusing to fingerprint table %q: unexpected identifier", table)
		}
		query := fmt.Sprintf(`
			SELECT COUNT(*)::bigint,
				COALESCE(md5(string_agg(sub.h, ',' ORDER BY sub.h)), 'empty')
			FROM (SELECT md5(t::text) AS h FROM public.%s t) sub`, table)
		var item tableFingerprint
		if err := pool.QueryRow(ctx, query).Scan(&item.Rows, &item.Fingerprint); err != nil {
			return nil, fmt.Errorf("fingerprint %s: %w", table, err)
		}
		out[table] = item
	}
	return out, nil
}

// countRows is the "is this database empty" probe of design step 4.4. Goose
// seeds stock_locations and treatment_products, so emptiness is asserted on
// tables no seed writes.
func countRows(ctx context.Context, pool *pgxpool.Pool, table string) (int64, error) {
	if !databaseNamePattern.MatchString(table) {
		return 0, fmt.Errorf("refusing to count %q", table)
	}
	var count int64
	err := pool.QueryRow(ctx, "SELECT COUNT(*)::bigint FROM public."+table).Scan(&count)
	return count, err
}
