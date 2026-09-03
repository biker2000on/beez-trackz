package main

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/biker2000on/beez-trackz/backend/internal/db"
)

// The exporter is the only writer-free entry point in the tree, and therefore
// the only one that may read a database of the previous schema generation.
// This is the CLI half of that contract (design review OV3, section 12's
// "Generation guard" row): the flag has to exist, it has to be off by
// default, and the connection it opens has to be read only.

const exportGuardDatabase = "beez_trackz_test_guard_export"

func TestExportSnapshotRequiresLegacySourceForALegacyDatabase(t *testing.T) {
	adminURL := os.Getenv("TEST_DATABASE_URL")
	if adminURL == "" {
		t.Skip("TEST_DATABASE_URL is not configured")
	}
	t.Setenv("TZ", "UTC")
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()

	sourceURL := freshLegacyDatabase(ctx, t, adminURL, exportGuardDatabase)
	binary := buildExporter(ctx, t)
	workdir := t.TempDir()

	// Off by default: an ordinary export against a foreign generation is a
	// mistake, and the operator must be told which generation it found.
	stdout, stderr, err := runExporter(ctx, binary, workdir,
		"-database-url", sourceURL, "-output", filepath.Join(workdir, "strict"))
	if err == nil {
		t.Fatalf("export-snapshot exported a legacy database without --legacy-source\n%s", stdout)
	}
	combined := stdout + stderr
	for _, want := range []string{"schema generation guard", db.LegacyGeneration, db.Generation, "--legacy-source"} {
		if !strings.Contains(combined, want) {
			t.Errorf("the refusal does not mention %q:\n%s", want, combined)
		}
	}
	if _, statErr := os.Stat(filepath.Join(workdir, "strict")); statErr == nil {
		t.Error("the refused run still created a snapshot directory")
	}

	// With the flag: it exports, and it says out loud that the connection is
	// read only, because that is the only reason the exception is safe.
	output := filepath.Join(workdir, "legacy")
	stdout, stderr, err = runExporter(ctx, binary, workdir,
		"-database-url", sourceURL, "-legacy-source", "-output", output)
	if err != nil {
		t.Fatalf("export-snapshot --legacy-source failed: %v\n%s\n%s", err, stdout, stderr)
	}
	if !strings.Contains(stdout+stderr, "read only") {
		t.Errorf("the legacy export did not announce a read-only connection:\n%s", stdout+stderr)
	}
	for _, name := range []string{"manifest.json", "verification.json", "media-manifest.json"} {
		if _, statErr := os.Stat(filepath.Join(output, name)); statErr != nil {
			t.Errorf("the legacy export did not write %s: %v", name, statErr)
		}
	}
}

// freshLegacyDatabase creates a scratch database, migrates it to head, then
// removes the generation stamp so it presents exactly as a database from
// before migration 00051: no schema_generation table, goose head one short.
func freshLegacyDatabase(ctx context.Context, t *testing.T, adminURL, name string) string {
	t.Helper()
	admin, err := pgxpool.New(ctx, adminURL)
	if err != nil {
		t.Fatalf("connect admin: %v", err)
	}
	t.Cleanup(func() {
		_, _ = admin.Exec(context.WithoutCancel(ctx), "DROP DATABASE IF EXISTS "+name+" WITH (FORCE)")
		admin.Close()
	})
	if _, err := admin.Exec(ctx, "DROP DATABASE IF EXISTS "+name+" WITH (FORCE)"); err != nil {
		t.Fatalf("drop %s: %v", name, err)
	}
	if _, err := admin.Exec(ctx, "CREATE DATABASE "+name); err != nil {
		t.Skipf("cannot create a scratch database: %v", err)
	}

	base, query, hasQuery := strings.Cut(adminURL, "?")
	slash := strings.LastIndex(base, "/")
	url := base[:slash+1] + name
	if hasQuery {
		url += "?" + query
	}

	migrated, err := db.Connect(ctx, url)
	if err != nil {
		t.Fatalf("migrate %s: %v", name, err)
	}
	defer migrated.Close()
	if _, err := migrated.Exec(ctx, `DROP TABLE schema_generation`); err != nil {
		t.Fatalf("drop the generation stamp: %v", err)
	}
	if _, err := migrated.Exec(ctx,
		`DELETE FROM goose_db_version WHERE version_id >= $1`, db.ExpectedMaxMigration()); err != nil {
		t.Fatalf("rewind the goose head: %v", err)
	}
	return url
}

func buildExporter(ctx context.Context, t *testing.T) string {
	t.Helper()
	binary := filepath.Join(t.TempDir(), "export-snapshot")
	if runtime.GOOS == "windows" {
		binary += ".exe"
	}
	build := exec.CommandContext(ctx, "go", "build", "-o", binary, ".")
	if output, err := build.CombinedOutput(); err != nil {
		t.Fatalf("build export-snapshot: %v\n%s", err, output)
	}
	return binary
}

// runExporter runs the CLI with a scrubbed environment: the exporter reads
// DATABASE_URL and .env, and a developer's real database must never be what
// this test reaches.
func runExporter(ctx context.Context, binary, workdir string, args ...string) (string, string, error) {
	command := exec.CommandContext(ctx, binary, args...)
	command.Dir = workdir
	command.Env = append(os.Environ(),
		"DATABASE_URL=", "TZ=UTC", "MINIO_ACCESS_KEY=", "MINIO_SECRET_KEY=")
	var stdout, stderr strings.Builder
	command.Stdout = &stdout
	command.Stderr = &stderr
	err := command.Run()
	return stdout.String(), stderr.String(), err
}
