package snapshot

import (
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"testing"
)

// TestFinanceCategorySeedsMatchMigration keeps the seed rows the post-artifact
// declaration hands an older artifact equal to what migration 00068/00015
// actually inserts, in both chains.
func TestFinanceCategorySeedsMatchMigration(t *testing.T) {
	row := regexp.MustCompile(`\('([0-9a-f-]{36})', '(expense|income)', '([a-z_]+)', '([^']+)', (\d+), (true|false)\)`)
	for _, path := range []string{
		filepath.Join("..", "db", "migrations", "00015_finance_categories.sql"),
		filepath.Join("..", "db", "legacy-00001-00052", "00068_finance_categories.sql"),
	} {
		contents, err := os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		up := strings.SplitN(string(contents), "-- +goose Down", 2)[0]
		matches := row.FindAllStringSubmatch(up, -1)
		seeds := FinanceCategorySeeds()
		if len(matches) != len(seeds) {
			t.Fatalf("%s inserts %d categories, the declaration has %d", path, len(matches), len(seeds))
		}
		for index, match := range matches {
			order, _ := strconv.Atoi(match[5])
			want := seeds[index]
			if want["id"] != match[1] || want["kind"] != match[2] || want["key"] != match[3] ||
				want["label"] != match[4] || want["sort_order"] != order ||
				want["is_system"] != (match[6] == "true") {
				t.Errorf("%s row %d = %v, declaration %v", path, index, match[1:], want)
			}
		}
	}
}

// TestFinanceCategoriesSeedAnOlderArtifact: an artifact taken before the
// table existed gains exactly the seeded categories, and the declaration is
// skipped for an artifact that already carries the domain.
func TestFinanceCategoriesSeedAnOlderArtifact(t *testing.T) {
	artifact := &Artifact{
		Manifest: Manifest{SchemaMigration: 67},
		Records:  map[string][]RecordEnvelope{},
	}
	applied, err := ApplyPostArtifactMigrations(artifact)
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, migration := range applied {
		if migration.Name == FinanceCategoriesTransform {
			found = migration.Migration == 68 && len(migration.Domains) == 1 && migration.Domains[0] == "finance_categories"
		}
	}
	if !found {
		t.Fatalf("finance categories transform not applied: %+v", applied)
	}
	records := artifact.Records["finance_categories"]
	if len(records) != len(FinanceCategorySeeds()) {
		t.Fatalf("finance_categories = %d records, want %d", len(records), len(FinanceCategorySeeds()))
	}
	keys := map[string]bool{}
	for _, record := range records {
		fields, err := decodeRecordData(record.Data)
		if err != nil {
			t.Fatal(err)
		}
		if _, present := fields["created_at"]; present {
			t.Fatal("generated created_at must be left to the target")
		}
		keys[fields["kind"].(string)+"/"+fields["key"].(string)] = true
	}
	for _, key := range []string{"expense/uncategorized", "expense/bees_queens", "expense/grocery", "income/sales_deposit", "income/grant"} {
		if !keys[key] {
			t.Errorf("seeded categories lack %s", key)
		}
	}

	current := &Artifact{Manifest: Manifest{SchemaMigration: 68}, Records: map[string][]RecordEnvelope{"finance_categories": {}}}
	applied, err = ApplyPostArtifactMigrations(current)
	if err != nil {
		t.Fatal(err)
	}
	for _, migration := range applied {
		if migration.Name == FinanceCategoriesTransform {
			t.Fatalf("a migration-68 artifact was given seeds: %+v", applied)
		}
	}
}

func TestFinanceCategoriesIsRegistered(t *testing.T) {
	for _, domain := range Domains {
		if domain.Name == "finance_categories" && domain.Table == "finance_categories" {
			return
		}
	}
	t.Fatal("finance_categories is not a registered snapshot domain")
}
