package main

import (
	"context"
	"fmt"
	"os"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/biker2000on/beez-trackz/backend/internal/db"
	"github.com/biker2000on/beez-trackz/backend/internal/snapshot"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

func TestExportImportReexportDigestEquality(t *testing.T) {
	adminURL := os.Getenv("TEST_DATABASE_URL")
	if adminURL == "" {
		t.Skip("TEST_DATABASE_URL is not configured")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
	defer cancel()
	suffix := strings.ReplaceAll(uuid.NewString()[:8], "-", "")
	sourceURL, sourceCleanup := freshImportDatabase(ctx, t, adminURL, "beez_snapshot_src_"+suffix)
	defer sourceCleanup()
	targetURL, targetCleanup := freshImportDatabase(ctx, t, adminURL, "beez_snapshot_dst_"+suffix)
	defer targetCleanup()

	source, err := db.Connect(ctx, sourceURL)
	if err != nil {
		t.Fatalf("migrate source: %v", err)
	}
	now := time.Date(2025, 11, 2, 5, 30, 0, 123456000, time.UTC)
	apiaryID, customerID, expenseID := uuid.New(), uuid.New(), uuid.New()
	lotID, jarID, runID := uuid.New(), uuid.New(), uuid.New()
	movementID, reversalID := uuid.New(), uuid.New()
	commands := []struct {
		sql  string
		args []any
	}{
		{`INSERT INTO apiaries(id,name,canvas_layout,created_at,updated_at) VALUES($1,'Round trip',$2,$3,$3)`, []any{apiaryID, []byte(`{"z":1,"a":{"n":100}}`), now}},
		{`INSERT INTO customers(id,name,email_opt_in,created_at,updated_at) VALUES($1,'Soft history customer',false,$2,$2)`, []any{customerID, now}},
		{`INSERT INTO expenses(id,expense_date,category,description,amount_cents,created_at,updated_at,deleted_at,deletion_reason) VALUES($1,'2025-11-02','feed','Archived sugar',1234,$2,$2,$2,'duplicate receipt')`, []any{expenseID, now}},
		{`INSERT INTO jar_sizes(id,label,honey_oz,created_at,updated_at) VALUES($1,'Fixture 12 oz',12,$2,$2)`, []any{jarID, now}},
		{`INSERT INTO harvest_lots(id,lot_code,public_slug,extraction_date,honey_weight_lbs,testing_data,created_at,updated_at) VALUES($1,'LOT-RT','lot-rt','2025-10-01',20,$2,$3,$3)`, []any{lotID, []byte(`{"b":2,"a":1}`), now}},
		{`INSERT INTO bottling_runs(id,lot_id,bottled_date,jar_size_id,quantity,honey_lbs,created_at,voided_at,void_reason) VALUES($1,$2,'2025-11-01',$3,2,1.5,$4,$4,'fixture void')`, []any{runID, lotID, jarID, now}},
		{`INSERT INTO honey_movements(id,date,kind,amount_lbs,reason,created_at,lot_id) VALUES($1,$2,'bulk_use',-2,'fixture original',$2,$3)`, []any{movementID, now, lotID}},
		{`INSERT INTO honey_movements(id,date,kind,amount_lbs,reason,created_at,lot_id,reverses_movement_id) VALUES($1,$2,'bulk_use',2,'fixture reversal',$2,$3,$4)`, []any{reversalID, now.Add(time.Second), lotID, movementID}},
	}
	for _, command := range commands {
		if _, err := source.Exec(ctx, command.sql, command.args...); err != nil {
			source.Close()
			t.Fatalf("seed fixture: %v\n%s", err, command.sql)
		}
	}
	sourceArtifact := t.TempDir() + "-source"
	exported, err := snapshot.Export(ctx, source, snapshot.ExportOptions{OutputDirectory: sourceArtifact, AppCommit: "integration", BusinessTimezone: "UTC", Currency: "USD"})
	if err != nil {
		source.Close()
		t.Fatalf("export source: %v", err)
	}
	source.Close()

	reportPath := t.TempDir() + "/restore-report.json"
	report := newReport(false)
	if err := execute(ctx, options{input: sourceArtifact, database: targetURL, conflict: "fail", report: reportPath}, report); err != nil {
		t.Fatalf("import: %v; validation=%v", err, report.ValidationErrors)
	}
	if report.Counts["failed"] != 0 || report.Counts["conflicted"] != 0 {
		t.Fatalf("restore report: %+v", report.Counts)
	}
	second := newReport(false)
	if err := execute(ctx, options{input: sourceArtifact, database: targetURL, conflict: "skip", report: reportPath}, second); err != nil {
		t.Fatalf("idempotent re-import: %v", err)
	}
	if second.Counts["created"] != 0 || second.Counts["updated"] != 0 || second.Counts["skipped"] != 0 {
		t.Fatalf("second import was not a zero-write unchanged pass: %+v", second.Counts)
	}

	target, err := db.ConnectWithoutMigrations(ctx, targetURL)
	if err != nil {
		t.Fatalf("connect target: %v", err)
	}
	var syncEnabled bool
	if err := target.QueryRow(ctx, `SELECT COALESCE(bool_or(sync_enabled),false) FROM gnucash_sync_settings`).Scan(&syncEnabled); err != nil {
		t.Fatal(err)
	}
	if syncEnabled {
		t.Fatal("GnuCash sync was enabled by restore")
	}
	targetArtifact := t.TempDir() + "-target"
	reexported, err := snapshot.Export(ctx, target, snapshot.ExportOptions{OutputDirectory: targetArtifact, AppCommit: "integration", BusinessTimezone: "UTC", Currency: "USD"})
	target.Close()
	if err != nil {
		t.Fatalf("re-export target: %v", err)
	}
	want, got := digestSet(exported.Verification.RecordDigests), digestSet(reexported.Verification.RecordDigests)
	if strings.Join(want, "\n") != strings.Join(got, "\n") {
		t.Fatalf("record digests differ\nsource-only/target-only comparison:\nsource=%s\ntarget=%s", strings.Join(want, "\n"), strings.Join(got, "\n"))
	}
}

func digestSet(records []snapshot.RecordDigest) []string {
	out := make([]string, 0, len(records))
	for _, record := range records {
		out = append(out, record.Domain+"\x00"+string(record.ID)+"\x00"+record.Digest)
	}
	sort.Strings(out)
	return out
}

func freshImportDatabase(ctx context.Context, t *testing.T, adminURL, name string) (string, func()) {
	t.Helper()
	admin, err := pgxpool.New(ctx, adminURL)
	if err != nil {
		t.Fatalf("connect database admin: %v", err)
	}
	quoted := `"` + strings.ReplaceAll(name, `"`, `""`) + `"`
	if _, err := admin.Exec(ctx, "CREATE DATABASE "+quoted); err != nil {
		admin.Close()
		t.Fatalf("create %s: %v", name, err)
	}
	databaseURL := replaceImportDatabase(adminURL, name)
	return databaseURL, func() {
		cleanupCtx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		_, _ = admin.Exec(cleanupCtx, "DROP DATABASE IF EXISTS "+quoted+" WITH (FORCE)")
		admin.Close()
	}
}

func replaceImportDatabase(databaseURL, name string) string {
	base, query, hasQuery := strings.Cut(databaseURL, "?")
	slash := strings.LastIndex(base, "/")
	if slash < 0 {
		panic(fmt.Sprintf("database URL has no path: %s", databaseURL))
	}
	replaced := base[:slash+1] + name
	if hasQuery {
		return replaced + "?" + query
	}
	return replaced
}
