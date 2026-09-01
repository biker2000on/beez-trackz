package main

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/biker2000on/beez-trackz/backend/internal/snapshot"
)

// The comparator half of the matrix. Each case mutates the re-export in one
// way and asserts the coded classification, because "the gate failed" without
// a reason is not an operator-actionable result.
func TestComparatorClassifiesDifferences(t *testing.T) {
	load := func(t *testing.T, model *fixtureModel) *artifact {
		t.Helper()
		loaded, findings := loadArtifact(model.write(t, t.TempDir()))
		if loaded == nil || len(failures(findings)) != 0 {
			t.Fatalf("fixture did not load cleanly: %v", findings)
		}
		return loaded
	}

	t.Run("identical artifacts differ only in the export timestamp", func(t *testing.T) {
		source := load(t, baselineFixture())
		restored := load(t, baselineFixture())
		findings := compareArtifacts(source, restored, compareOptions{})
		if got := failures(findings); len(got) != 0 {
			t.Fatalf("two identical artifacts compared unequal: %v", got)
		}
		if len(explanations(findings)) == 0 {
			t.Fatal("the run-level timestamps were not recorded as an explained difference")
		}
	})

	t.Run("a dropped record", func(t *testing.T) {
		source := load(t, baselineFixture())
		model := baselineFixture()
		model.Domains["hives"] = nil
		model.References[0].PopulatedCount, model.References[0].ResolvedCount = 0, 0
		model.References[1].PopulatedCount, model.References[1].ResolvedCount = 0, 0
		model.Media = nil
		model.Domains["photos"] = nil
		restored := load(t, model)
		findings := compareArtifacts(source, restored, compareOptions{})
		if !hasCode(findings, "absent-record") {
			t.Fatalf("a dropped record was not reported: %v", codes(findings))
		}
		if !hasCode(findings, "record-count-mismatch") {
			t.Fatalf("the count difference was not reported: %v", codes(findings))
		}
	})

	t.Run("a changed field", func(t *testing.T) {
		source := load(t, baselineFixture())
		model := baselineFixture()
		model.Domains["apiaries"][0].Data["name"] = "Renamed yard"
		restored := load(t, model)
		findings := compareArtifacts(source, restored, compareOptions{})
		if !hasCode(findings, "record-digest-mismatch") {
			t.Fatalf("a changed field was not reported: %v", codes(findings))
		}
		if detail := detailFor(findings, "record-digest-mismatch"); !contains(detail, "name") {
			t.Fatalf("the digest mismatch does not name the field: %q", detail)
		}
	})

	t.Run("an extra record the source never had", func(t *testing.T) {
		source := load(t, baselineFixture())
		model := baselineFixture()
		model.Domains["apiaries"] = append(model.Domains["apiaries"], fixtureRecord{
			Data: map[string]any{"id": "44444444-4444-4444-8444-444444444444", "name": "Reseeded"}})
		restored := load(t, model)
		if !hasCode(compareArtifacts(source, restored, compareOptions{}), "additional-record") {
			t.Fatal("a record the restore invented was not reported")
		}
	})

	t.Run("an aggregate that moved", func(t *testing.T) {
		source := load(t, baselineFixture())
		model := baselineFixture()
		restored := load(t, model)
		family := restored.Verification.AggregateFamilies["legacy"]
		family.Definitions[0].Value = json.RawMessage(`12.5`)
		restored.Verification.AggregateFamilies["legacy"] = family
		findings := compareArtifacts(source, restored, compareOptions{})
		if !hasCode(findings, "aggregate-value-mismatch") {
			t.Fatalf("a moved aggregate was not reported: %v", codes(findings))
		}
	})

	t.Run("an aggregate whose definition version drifted", func(t *testing.T) {
		source := load(t, baselineFixture())
		restored := load(t, baselineFixture())
		family := restored.Verification.AggregateFamilies["legacy"]
		family.Definitions[0].Version = "legacy-v2"
		restored.Verification.AggregateFamilies["legacy"] = family
		findings := compareArtifacts(source, restored, compareOptions{})
		// Equal numbers under unequal definitions are not equality.
		if !hasCode(findings, "aggregate-definition-drift") {
			t.Fatalf("a definition version change was not reported: %v", codes(findings))
		}
	})

	t.Run("media hashing disabled is explained, a real hash change is not", func(t *testing.T) {
		source := load(t, baselineFixture())
		model := baselineFixture()
		model.Media[0].HashState = "verified"
		model.Media[0].SHA256 = "abc"
		restored := load(t, model)
		skipped := compareArtifacts(source, restored, compareOptions{SkipMedia: true})
		if len(failures(skipped)) != 0 {
			t.Fatalf("-skip-media did not explain the hash-state difference: %v", failures(skipped))
		}
		strict := compareArtifacts(source, restored, compareOptions{})
		if !hasCode(strict, "media-hash-mismatch") {
			t.Fatalf("a hash-state difference was not a failure without -skip-media: %v", codes(strict))
		}
	})
}

// The restore report's counter names are fixed by the CLI contract; where
// they sit in the document is not. The extractor takes the shallowest object
// that has them, which is the totals object and never a per-domain breakdown.
func TestExtractCountersFindsTheTotals(t *testing.T) {
	cases := []struct {
		name   string
		body   string
		want   importCounters
		absent bool
	}{
		{name: "top level",
			body: `{"created":3,"unchanged":1,"updated":0,"skipped":0,"conflicted":0,"failed":0}`,
			want: importCounters{Found: true, Created: 3, Unchanged: 1}},
		{name: "nested totals",
			body: `{"domains":{"hives":{"created":9,"unchanged":9}},
			        "totals":{"created":0,"unchanged":12,"failed":0}}`,
			want: importCounters{Found: true, Created: 0, Unchanged: 12}},
		{name: "no counters", body: `{"dryRun":true,"errors":[]}`, absent: true},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			report := map[string]any{}
			if err := json.Unmarshal([]byte(testCase.body), &report); err != nil {
				t.Fatal(err)
			}
			got := extractCounters(report)
			if testCase.absent {
				if got.Found {
					t.Fatalf("counters were invented from %s", testCase.body)
				}
				return
			}
			if got.Found != testCase.want.Found || got.Created != testCase.want.Created ||
				got.Unchanged != testCase.want.Unchanged {
				t.Fatalf("got %+v, want %+v", got, testCase.want)
			}
		})
	}
}

// The no-write oracle itself (design section 4.1). A transaction that inserts
// and rolls back must leave the fingerprint identical — this is exactly the
// case pg_stat_user_tables gets wrong, since it counts the aborted tuple.
func TestContentFingerprintIgnoresRolledBackWritesAndSeesCommittedOnes(t *testing.T) {
	adminURL := requireDatabase(t)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()
	_, pool := seededSource(ctx, t, adminURL)

	before, err := fingerprintDatabase(ctx, pool)
	if err != nil {
		t.Fatalf("fingerprint: %v", err)
	}
	transaction, err := pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := transaction.Exec(ctx,
		`INSERT INTO apiaries (name) VALUES ('rolled back')`); err != nil {
		t.Fatal(err)
	}
	if err := transaction.Rollback(ctx); err != nil {
		t.Fatal(err)
	}
	afterRollback, err := fingerprintDatabase(ctx, pool)
	if err != nil {
		t.Fatalf("fingerprint: %v", err)
	}
	if differences := diffFingerprints(before, afterRollback); len(differences) != 0 {
		t.Fatalf("a rolled-back insert moved the fingerprint: %v", differences)
	}

	if _, err := pool.Exec(ctx, `INSERT INTO apiaries (name) VALUES ('committed')`); err != nil {
		t.Fatal(err)
	}
	afterCommit, err := fingerprintDatabase(ctx, pool)
	if err != nil {
		t.Fatalf("fingerprint: %v", err)
	}
	differences := diffFingerprints(before, afterCommit)
	if len(differences) != 1 || !contains(differences[0], "apiaries") {
		t.Fatalf("a committed insert was not seen: %v", differences)
	}
}

// The gate refuses to make the database it was handed into the restore
// target, whatever else is misconfigured.
func TestFreshDatabaseRefusesToReuseTheAdminDatabase(t *testing.T) {
	if _, _, err := freshDatabase(context.Background(),
		"postgres://beez@example:5432/beez_roundtrip_gate?sslmode=disable",
		gateDatabaseName); err == nil {
		t.Fatal("the gate was willing to restore into the database it was given")
	}
	if _, _, err := freshDatabase(context.Background(),
		"postgres://beez@example:5432/postgres?sslmode=disable",
		"beez; DROP DATABASE postgres"); err == nil {
		t.Fatal("a database name that is not a plain identifier was accepted")
	}
}

// A manifest whose canonicalization declarations moved is a failure even
// though nothing else did: the two sides no longer mean the same thing by a
// digest.
func TestComparatorRejectsCanonicalizationDrift(t *testing.T) {
	sourceLoaded, _ := loadArtifact(baselineFixture().write(t, t.TempDir()))
	restoredLoaded, _ := loadArtifact(baselineFixture().write(t, t.TempDir()))
	restoredLoaded.Manifest.Canonical.Units = map[string]string{"honeyMass": "kg"}
	if !hasCode(compareManifests(sourceLoaded, restoredLoaded), "canonical-declaration-drift") {
		t.Fatal("a changed unit declaration compared equal")
	}
	restoredLoaded.Manifest.Canonical.Units = map[string]string{"honeyMass": "lb"}
	restoredLoaded.Manifest.SchemaMigration = snapshot.FormatVersion
	if !hasCode(compareManifests(sourceLoaded, restoredLoaded), "schema-migration-drift") {
		t.Fatal("a different migration ceiling compared equal")
	}
}

func contains(haystack, needle string) bool { return indexOf(haystack, needle) >= 0 }
