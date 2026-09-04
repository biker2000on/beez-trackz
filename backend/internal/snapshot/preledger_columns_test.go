package snapshot

import (
	"os"
	"path/filepath"
	"reflect"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"testing"
)

type portableMigrationShape struct {
	Added   map[string][]string
	Removed map[string][]string
	Created []string
}

// TestPostArtifactMigrationsMatchLegacySQL is the mechanical guard for every
// ADD COLUMN, DROP COLUMN, and CREATE TABLE after migration 00049. A migration
// that changes an exported domain cannot land without updating the one
// versioned declaration used by both importer and comparator.
func TestPostArtifactMigrationsMatchLegacySQL(t *testing.T) {
	files, err := filepath.Glob(filepath.Join("..", "db", "legacy-00001-00052", "0005[0-8]_*.sql"))
	if err != nil {
		t.Fatal(err)
	}
	if len(files) != 9 {
		t.Fatalf("migration files = %d, want 9: %v", len(files), files)
	}

	registered := map[string]bool{}
	for _, domain := range RegisteredDomains() {
		registered[domain.Table] = true
	}
	omitted := map[string]bool{}
	for _, domain := range OmittedDomains() {
		omitted[domain.Domain] = true
	}

	alterTable := regexp.MustCompile(`(?is)\bALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?([a-z_][a-z0-9_]*)\s+(.*?);`)
	addColumn := regexp.MustCompile(`(?i)\bADD\s+COLUMN\s+(?:IF\s+NOT\s+EXISTS\s+)?([a-z_][a-z0-9_]*)`)
	dropColumn := regexp.MustCompile(`(?i)\bDROP\s+COLUMN\s+(?:IF\s+EXISTS\s+)?([a-z_][a-z0-9_]*)`)
	createTable := regexp.MustCompile(`(?i)\bCREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([a-z_][a-z0-9_]*)`)

	got := map[int64]portableMigrationShape{}
	for _, path := range files {
		base := filepath.Base(path)
		migration, err := strconv.ParseInt(base[:5], 10, 64)
		if err != nil {
			t.Fatal(err)
		}
		contents, err := os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		up := strings.SplitN(string(contents), "-- +goose Down", 2)[0]
		shape := portableMigrationShape{Added: map[string][]string{}, Removed: map[string][]string{}}
		for _, match := range createTable.FindAllStringSubmatch(up, -1) {
			table := strings.ToLower(match[1])
			switch {
			case registered[table]:
				shape.Created = append(shape.Created, table)
			case omitted[table]:
				// Explicitly omitted tables are reviewed portable-boundary decisions.
			default:
				t.Errorf("migration %05d creates unclassified table %s", migration, table)
			}
		}
		for _, statement := range alterTable.FindAllStringSubmatch(up, -1) {
			table := strings.ToLower(statement[1])
			if !registered[table] {
				continue
			}
			for _, match := range addColumn.FindAllStringSubmatch(statement[2], -1) {
				shape.Added[table] = append(shape.Added[table], strings.ToLower(match[1]))
			}
			for _, match := range dropColumn.FindAllStringSubmatch(statement[2], -1) {
				shape.Removed[table] = append(shape.Removed[table], strings.ToLower(match[1]))
			}
		}
		normalizeMigrationShape(&shape)
		got[migration] = shape
	}

	want := map[int64]portableMigrationShape{}
	if len(PostArtifactMigrations) != 9 {
		t.Fatalf("PostArtifactMigrations has %d entries, want one for each migration 00050-00058", len(PostArtifactMigrations))
	}
	for index, migration := range PostArtifactMigrations {
		if migration.LegacyMigration != int64(50+index) || migration.Name == "" {
			t.Fatalf("declaration %d is not the named migration %05d: %+v", index, 50+index, migration)
		}
		shape := portableMigrationShape{Added: cloneColumns(migration.AddedColumns), Removed: cloneColumns(migration.RemovedColumns)}
		for _, domain := range migration.NewDomains {
			shape.Created = append(shape.Created, domain.Domain)
		}
		normalizeMigrationShape(&shape)
		want[migration.LegacyMigration] = shape
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("PostArtifactMigrations drifted from legacy SQL 00050-00058\n got: %#v\nwant: %#v", got, want)
	}
}

func cloneColumns(input map[string][]string) map[string][]string {
	out := map[string][]string{}
	for domain, columns := range input {
		out[domain] = append([]string(nil), columns...)
	}
	return out
}

func normalizeMigrationShape(shape *portableMigrationShape) {
	for _, columns := range shape.Added {
		sort.Strings(columns)
	}
	for _, columns := range shape.Removed {
		sort.Strings(columns)
	}
	sort.Strings(shape.Created)
}
