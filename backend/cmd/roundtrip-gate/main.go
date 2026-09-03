// Command roundtrip-gate executes the P0 portable-snapshot round-trip gate
// described in docs/plans/2026-09-01-roundtrip-gate-design.md.
//
// It exports the source database, checksums that artifact independently of
// the exporter, dry-runs the importer and proves the dry run wrote nothing,
// restores into a disposable database it creates and drops itself, proves a
// second identical import is a no-op, re-exports, and compares the complete
// (domain, id, digest) sets, record counts, reference checks, media states,
// and the legacy aggregate family. Every difference is classified as
// explained or as a failure; the process exits non-zero listing every
// failure.
//
// It never restores into the database named in -database. That URL is used
// only to CREATE and DROP the disposable gate database.
//
//	roundtrip-gate -database <admin-postgres-url> -workdir <dir> [-keep] [-skip-media] [-legacy-source]
//
// The source database is read only, and comes from -source, SNAPSHOT_SOURCE_URL,
// or DATABASE_URL, in that order.
//
// Every connection is checked against the binary's schema generation
// (internal/db.CheckGeneration). -legacy-source relaxes that for the SOURCE
// alone, and only onto a connection with default_transaction_read_only = on,
// which is how the pre-reset rehearsal reads a database of the previous
// generation. The disposable target is always strict.
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"

	"github.com/biker2000on/beez-trackz/backend/internal/config"
)

func main() {
	config.LoadDotEnv()
	// The design requires the driver to set its own process timezone rather
	// than trusting the shell: CI does not set TZ on the Go step today, and a
	// comparator that re-derives a year bucket in local time compares two
	// different calendars.
	if err := os.Setenv("TZ", "UTC"); err != nil {
		log.Fatalf("set TZ=UTC: %v", err)
	}

	databaseURL := flag.String("database", os.Getenv("TEST_DATABASE_URL"),
		"admin-capable Postgres URL used ONLY to CREATE/DROP the disposable gate database "+
			"(defaults to TEST_DATABASE_URL)")
	sourceURL := flag.String("source", firstNonempty(os.Getenv("SNAPSHOT_SOURCE_URL"), os.Getenv("DATABASE_URL")),
		"Postgres URL of the database to snapshot; read only (or SNAPSHOT_SOURCE_URL / DATABASE_URL)")
	workdir := flag.String("workdir", "", "directory for the artifact, re-export, and gate report")
	keep := flag.Bool("keep", false, "keep the disposable gate database instead of dropping it")
	skipMedia := flag.Bool("skip-media", false,
		"do not treat media hash-state differences as failures; originals are compared by reference only")
	gateDatabase := flag.String("gate-database", gateDatabaseName,
		"name of the disposable database to create, restore into, and drop")
	// The SOURCE only. The disposable target is created and migrated by this
	// binary, so it is always of the current generation and always strict.
	legacySource := flag.Bool("legacy-source", false,
		"accept a SOURCE database of the previous schema generation, read only (the target stays strict)")
	flag.Parse()

	if strings.TrimSpace(*databaseURL) == "" {
		log.Fatal("-database is required (an admin-capable Postgres URL, e.g. TEST_DATABASE_URL)")
	}
	if strings.TrimSpace(*sourceURL) == "" {
		log.Fatal("-source is required (or set SNAPSHOT_SOURCE_URL / DATABASE_URL)")
	}
	if strings.TrimSpace(*workdir) == "" {
		log.Fatal("-workdir is required; the artifact and gate report must live outside both databases")
	}

	repoRoot, err := findRepoRoot(".")
	if err != nil {
		if executable, execErr := os.Executable(); execErr == nil {
			repoRoot, err = findRepoRoot(filepath.Dir(executable))
		}
	}
	if err != nil {
		log.Fatalf("locate the backend module (needed to build %s): %v", importerPackage, err)
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	report, err := run(ctx, options{
		AdminURL:     *databaseURL,
		SourceURL:    *sourceURL,
		Workdir:      *workdir,
		GateDatabase: *gateDatabase,
		RepoRoot:     repoRoot,
		Keep:         *keep,
		SkipMedia:    *skipMedia,
		LegacySource: *legacySource,
		Logf:         func(format string, args ...any) { log.Printf(format, args...) },
	})
	if err != nil {
		if errors.Is(err, errImporterMissing) {
			log.Fatalf("%v", err)
		}
		log.Fatalf("round-trip gate: %v", err)
	}
	if writeErr := writeReports(report, *workdir); writeErr != nil {
		log.Fatalf("write gate report: %v", writeErr)
	}
	fmt.Print(report.summary())
	if !report.Passed {
		os.Exit(1)
	}
}

func firstNonempty(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return strings.TrimSpace(value)
		}
	}
	return ""
}
