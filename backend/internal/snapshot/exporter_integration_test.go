package snapshot

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/biker2000on/beez-trackz/backend/internal/db"
)

func TestExporterIntegration(t *testing.T) {
	databaseURL := os.Getenv("TEST_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("TEST_DATABASE_URL is unset")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	pool, err := db.Connect(ctx, databaseURL)
	if err != nil {
		t.Fatalf("connect/migrate test database: %v", err)
	}
	defer pool.Close()
	root := filepath.Join(t.TempDir(), "snapshot")
	result, err := Export(ctx, pool, ExportOptions{
		OutputDirectory: root, AppCommit: "integration-test", BusinessTimezone: "America/New_York",
		Currency: "USD", ExportedAt: time.Date(2026, 9, 1, 12, 0, 0, 0, time.UTC),
	})
	if err != nil {
		t.Fatalf("export: %v", err)
	}
	if result.Manifest.FormatVersion != 1 || result.Manifest.SchemaMigration < 48 {
		t.Fatalf("manifest versions: %+v", result.Manifest)
	}
	if len(result.Manifest.Files) != len(Domains)+len(LedgerDomains) {
		t.Fatalf("domain files = %d, want %d", len(result.Manifest.Files), len(Domains)+len(LedgerDomains))
	}
	for _, relative := range []string{"manifest.json", "verification.json", "media-manifest.json"} {
		if _, err := os.Stat(filepath.Join(root, relative)); err != nil {
			t.Errorf("%s: %v", relative, err)
		}
	}
	verificationBytes, err := os.ReadFile(filepath.Join(root, "verification.json"))
	if err != nil {
		t.Fatal(err)
	}
	if SHA256Hex(verificationBytes) != result.Manifest.Verification.SHA256 {
		t.Fatal("manifest verification.json hash does not match file")
	}
	if _, ok := result.Verification.AggregateFamilies["legacy"]; !ok {
		t.Fatal("legacy aggregate family missing")
	}
	if _, ok := result.Verification.AggregateFamilies["newLedger"]; !ok {
		t.Fatal("new-ledger aggregate family missing")
	}
}
