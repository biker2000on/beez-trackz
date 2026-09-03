package snapshot

import (
	"os"
	"path/filepath"
	"reflect"
	"regexp"
	"sort"
	"strings"
	"testing"
)

func TestPreLedgerAddedColumnsMatchLegacyMigrations(t *testing.T) {
	files, err := filepath.Glob(filepath.Join("..", "db", "legacy-00001-00052", "0005[0-4]_*.sql"))
	if err != nil {
		t.Fatal(err)
	}
	if len(files) != 5 {
		t.Fatalf("migration files = %d, want 5: %v", len(files), files)
	}

	retained := make(map[string]bool, len(Domains))
	for _, domain := range Domains {
		retained[domain.Table] = true
	}
	alterTable := regexp.MustCompile(`(?is)\bALTER\s+TABLE\s+([a-z_][a-z0-9_]*)\s+(.*?);`)
	addColumn := regexp.MustCompile(`(?i)\bADD\s+COLUMN\s+(?:IF\s+NOT\s+EXISTS\s+)?([a-z_][a-z0-9_]*)`)
	got := map[string][]string{}
	for _, path := range files {
		contents, err := os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		up := strings.SplitN(string(contents), "-- +goose Down", 2)[0]
		for _, statement := range alterTable.FindAllStringSubmatch(up, -1) {
			table := strings.ToLower(statement[1])
			if !retained[table] {
				continue
			}
			for _, addition := range addColumn.FindAllStringSubmatch(statement[2], -1) {
				got[table] = append(got[table], strings.ToLower(addition[1]))
			}
		}
	}

	want := make(map[string][]string, len(PreLedgerAddedColumns))
	for domain, columns := range PreLedgerAddedColumns {
		want[domain] = append([]string(nil), columns...)
	}
	for _, columns := range got {
		sort.Strings(columns)
	}
	for _, columns := range want {
		sort.Strings(columns)
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("PreLedgerAddedColumns drifted from migrations 00050-00054\n got: %#v\nwant: %#v", got, want)
	}
}
