package main

import (
	"testing"

	"github.com/biker2000on/beez-trackz/backend/internal/snapshot"
)

// The first real-data rehearsal (prod copy, 2026-09-01) failed with 81
// feeding_status_backfills FK errors: the inspections ↔ media_files reference
// pair formed a cycle even though zero media rows existed, every transitive
// dependent fell into the alphabetical fallback, and backfills sort before
// feedings. Unpopulated references must not constrain the order.
func TestDomainOrderIgnoresUnpopulatedReferenceCycles(t *testing.T) {
	artifact := &snapshot.Artifact{
		Verification: snapshot.Verification{
			ReferenceChecks: []snapshot.ReferenceCheck{
				// The populated chain that must be honored.
				{Name: "feeding_status_backfills_feeding_id_fkey", FromDomain: "feeding_status_backfills", ToDomain: "feedings", Required: true, PopulatedCount: 81, ResolvedCount: 81},
				{Name: "feedings_hive_id_fkey", FromDomain: "feedings", ToDomain: "hives", Required: true, PopulatedCount: 81, ResolvedCount: 81},
				// The zero-populated cycle that used to stall the graph.
				{Name: "inspections_media", FromDomain: "inspections", ToDomain: "media_files", PopulatedCount: 0},
				{Name: "media_files_inspection", FromDomain: "media_files", ToDomain: "inspections", PopulatedCount: 0},
				// A zero-populated edge into the chain must not stall it either.
				{Name: "feedings_source_media_file_id_fkey", FromDomain: "feedings", ToDomain: "media_files", PopulatedCount: 0},
			},
		},
	}
	order := domainOrder(artifact)
	position := map[string]int{}
	for i, name := range order {
		position[name] = i
	}
	for _, name := range []string{"hives", "feedings", "feeding_status_backfills", "inspections", "media_files"} {
		if _, ok := position[name]; !ok {
			t.Fatalf("domain %q missing from order", name)
		}
	}
	if !(position["hives"] < position["feedings"] && position["feedings"] < position["feeding_status_backfills"]) {
		t.Fatalf("populated chain out of order: hives=%d feedings=%d backfills=%d",
			position["hives"], position["feedings"], position["feeding_status_backfills"])
	}
	if len(order) != len(snapshot.RegisteredDomains()) {
		t.Fatalf("order lists %d domains, registry has %d", len(order), len(snapshot.RegisteredDomains()))
	}
}

// A populated cycle is a genuine data problem: it still resolves
// deterministically through the fallback rather than dropping domains.
func TestDomainOrderKeepsEveryDomainUnderAPopulatedCycle(t *testing.T) {
	artifact := &snapshot.Artifact{
		Verification: snapshot.Verification{
			ReferenceChecks: []snapshot.ReferenceCheck{
				{Name: "a", FromDomain: "inspections", ToDomain: "media_files", PopulatedCount: 3},
				{Name: "b", FromDomain: "media_files", ToDomain: "inspections", PopulatedCount: 3},
			},
		},
	}
	order := domainOrder(artifact)
	if len(order) != len(snapshot.RegisteredDomains()) {
		t.Fatalf("order lists %d domains, registry has %d", len(order), len(snapshot.RegisteredDomains()))
	}
}
