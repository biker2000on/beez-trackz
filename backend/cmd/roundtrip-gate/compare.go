package main

import (
	"bytes"
	"encoding/json"
	"sort"
	"strings"

	"github.com/biker2000on/beez-trackz/backend/internal/db"
	"github.com/biker2000on/beez-trackz/backend/internal/snapshot"
)

const stepCompare = "step6-compare"

// compareOptions carries the knobs that change what counts as explained.
type compareOptions struct {
	// SkipMedia was passed to the driver: originals were not resolved or
	// hashed on either side, so a hash state of "unhashed" on both sides is
	// equality, and a state that only one side could compute is explained
	// rather than a failure.
	SkipMedia bool
}

// compareArtifacts implements the comparison matrix of design section 3 for
// the same-schema rehearsal: the aggregate family is legacy, no
// formatVersion transform applies, and no residual splits apply.
//
// Every difference is classified. Explained differences carry a code and do
// not fail the gate; everything else fails.
func compareArtifacts(source, restored *artifact, options compareOptions) []finding {
	var findings []finding
	findings = append(findings, compareManifests(source, restored)...)
	findings = append(findings, compareRecords(source, restored)...)
	findings = append(findings, compareReferences(source, restored)...)
	findings = append(findings, compareMedia(source, restored, options)...)
	findings = append(findings, compareAggregates(source, restored)...)
	return findings
}

func compareManifests(source, restored *artifact) []finding {
	var findings []finding
	if source.Manifest.FormatVersion != restored.Manifest.FormatVersion {
		findings = append(findings, fail(stepCompare, "format-version-drift",
			"source formatVersion %d, re-export %d",
			source.Manifest.FormatVersion, restored.Manifest.FormatVersion))
	}
	if source.Manifest.ExporterVersion != restored.Manifest.ExporterVersion {
		findings = append(findings, fail(stepCompare, "exporter-version-drift",
			"source exporter %q, re-export %q",
			source.Manifest.ExporterVersion, restored.Manifest.ExporterVersion))
	}
	if source.Manifest.SchemaMigration != restored.Manifest.SchemaMigration {
		// The importer always migrates the disposable target to the head of
		// the chain, so a target that is AHEAD of the source is the normal
		// rehearsal shape (e.g. a 48-schema prod export restored into 49).
		// Record-digest equality is what proves the newer schema changed
		// nothing exported. A target BEHIND the source is impossible without
		// a broken migration step and stays a failure.
		if restored.Manifest.SchemaMigration > source.Manifest.SchemaMigration {
			findings = append(findings, explained(stepCompare, "schema-migration-ahead",
				"source schema migration %d, disposable target %d (importer migrates to head; record digests prove equivalence)",
				source.Manifest.SchemaMigration, restored.Manifest.SchemaMigration))
		} else if db.ActiveProfile() == db.ProfileBaseline {
			findings = append(findings, explained(stepCompare, "schema-migration-baseline",
				"source schema migration %d, disposable target %d under the %s profile (%s)",
				source.Manifest.SchemaMigration, restored.Manifest.SchemaMigration,
				db.ProfileBaseline, db.BaselineGeneration))
		} else {
			findings = append(findings, fail(stepCompare, "schema-migration-drift",
				"source schema migration %d, disposable target %d — the rehearsal restores into the same chain",
				source.Manifest.SchemaMigration, restored.Manifest.SchemaMigration))
		}
	}
	if !equalJSON(source.Manifest.Canonical, restored.Manifest.Canonical) {
		findings = append(findings, fail(stepCompare, "canonical-declaration-drift",
			"the two exports declare different canonicalization rules"))
	}
	if !equalJSON(source.Manifest.OmittedDomains, restored.Manifest.OmittedDomains) {
		findings = append(findings, fail(stepCompare, "omitted-domain-drift",
			"the two exports declare different intentional omissions"))
	}
	if !equalJSON(source.Manifest.ExcludedConfiguration, restored.Manifest.ExcludedConfiguration) {
		findings = append(findings, fail(stepCompare, "excluded-configuration-drift",
			"the two exports declare different excluded configuration"))
	}
	// Two facts about the run, not about the data.
	findings = append(findings, explained(stepCompare, "export-timestamp",
		"exportedAt %s -> %s; verification generatedAt %s -> %s",
		source.Manifest.ExportedAt.UTC().Format("2006-01-02T15:04:05Z"),
		restored.Manifest.ExportedAt.UTC().Format("2006-01-02T15:04:05Z"),
		source.Verification.GeneratedAt.UTC().Format("2006-01-02T15:04:05Z"),
		restored.Verification.GeneratedAt.UTC().Format("2006-01-02T15:04:05Z")))
	return findings
}

// compareRecords is the equality oracle: the complete (domain, id, digest)
// set on both sides. Aggregates never substitute for it.
func compareRecords(source, restored *artifact) []finding {
	var findings []finding
	for _, domain := range sortedDomains(source.Records, restored.Records) {
		sourceIndex, inSource := source.ByID[domain]
		restoredIndex, inRestored := restored.ByID[domain]
		if !inSource {
			findings = append(findings, fail(stepCompare, "extra-domain",
				"the re-export contains domain %s, which the source artifact does not", domain))
			continue
		}
		if !inRestored {
			if db.ActiveProfile() == db.ProfileBaseline && db.BaselineDrops(domain) {
				findings = append(findings, explained(stepCompare, db.BaselineTransform,
					"domain %s is absent from the re-export under %s", domain, db.BaselineTransformVersion))
				continue
			}
			findings = append(findings, fail(stepCompare, "missing-domain",
				"the re-export is missing domain %s", domain))
			continue
		}
		if len(sourceIndex) != len(restoredIndex) {
			findings = append(findings, fail(stepCompare, "record-count-mismatch",
				"domain %s: source has %d records, re-export has %d",
				domain, len(sourceIndex), len(restoredIndex)))
		}
		ids := make([]string, 0, len(sourceIndex))
		for id := range sourceIndex {
			ids = append(ids, id)
		}
		sort.Strings(ids)
		for _, id := range ids {
			want := sourceIndex[id]
			got, present := restoredIndex[id]
			if !present {
				findings = append(findings, fail(stepCompare, "absent-record",
					"%s %s is in the source artifact and not in the re-export", domain, id))
				continue
			}
			if got.Digest != want.Digest {
				findings = append(findings, fail(stepCompare, "record-digest-mismatch",
					"%s %s: source digest %s, re-export %s; first difference: %s",
					domain, id, want.Digest, got.Digest, firstFieldDifference(want, got)))
			}
		}
		extras := make([]string, 0)
		for id := range restoredIndex {
			if _, present := sourceIndex[id]; !present {
				extras = append(extras, id)
			}
		}
		sort.Strings(extras)
		for _, id := range extras {
			// A goose seed that came back under a new UUID lands here. The
			// design requires preserved IDs to win, so this is a failure and
			// not a seed-identity remap: a remap rewrites the pointers and
			// keeps one row, it does not add one.
			findings = append(findings, fail(stepCompare, "additional-record",
				"%s %s is in the re-export and not in the source artifact", domain, id))
		}
	}
	return findings
}

// firstFieldDifference names one differing field so a digest mismatch is
// actionable instead of two hex strings.
func firstFieldDifference(want, got artifactRecord) string {
	names := make([]string, 0, len(want.Fields))
	for name := range want.Fields {
		names = append(names, name)
	}
	for name := range got.Fields {
		if _, present := want.Fields[name]; !present {
			names = append(names, name)
		}
	}
	sort.Strings(names)
	for _, name := range names {
		left, leftPresent := want.Fields[name]
		right, rightPresent := got.Fields[name]
		if leftPresent != rightPresent || !equalJSON(left, right) {
			return name + " " + jsonString(left) + " -> " + jsonString(right)
		}
	}
	return "no field difference found (envelope encoding differs)"
}

func compareReferences(source, restored *artifact) []finding {
	var findings []finding
	sourceChecks := indexReferences(source.Verification.ReferenceChecks)
	restoredChecks := indexReferences(restored.Verification.ReferenceChecks)
	names := make([]string, 0, len(sourceChecks))
	for name := range sourceChecks {
		names = append(names, name)
	}
	sort.Strings(names)
	for _, name := range names {
		want := sourceChecks[name]
		got, present := restoredChecks[name]
		if !present {
			if db.ActiveProfile() == db.ProfileBaseline &&
				(db.BaselineDrops(want.FromDomain) || db.BaselineDrops(want.ToDomain)) {
				findings = append(findings, explained(stepCompare, "reference-"+db.BaselineTransform,
					"reference check %s is absent because baseline transform %s drops %s or %s",
					name, db.BaselineTransformVersion, want.FromDomain, want.ToDomain))
				continue
			}
			findings = append(findings, fail(stepCompare, "reference-check-missing",
				"the re-export does not carry reference check %s", name))
			continue
		}
		if want.PopulatedCount != got.PopulatedCount || want.ResolvedCount != got.ResolvedCount ||
			want.DanglingCount != got.DanglingCount {
			findings = append(findings, fail(stepCompare, "reference-count-mismatch",
				"%s: source %d populated / %d resolved / %d dangling, re-export %d / %d / %d",
				name, want.PopulatedCount, want.ResolvedCount, want.DanglingCount,
				got.PopulatedCount, got.ResolvedCount, got.DanglingCount))
		}
		if got.DanglingCount != 0 {
			findings = append(findings, fail(stepCompare, "dangling-reference",
				"%s: the restored database has %d dangling references", name, got.DanglingCount))
		}
	}
	for name := range restoredChecks {
		if _, present := sourceChecks[name]; !present {
			findings = append(findings, fail(stepCompare, "reference-check-additional",
				"the re-export carries reference check %s, which the source does not", name))
		}
	}
	return findings
}

func indexReferences(checks []snapshot.ReferenceCheck) map[string]snapshot.ReferenceCheck {
	out := make(map[string]snapshot.ReferenceCheck, len(checks))
	for _, check := range checks {
		out[check.Name] = check
	}
	return out
}

func compareMedia(source, restored *artifact, options compareOptions) []finding {
	var findings []finding
	sourceObjects := indexMedia(source.Media.Objects)
	restoredObjects := indexMedia(restored.Media.Objects)
	keys := make([]string, 0, len(sourceObjects))
	for key := range sourceObjects {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	for _, key := range keys {
		want := sourceObjects[key]
		got, present := restoredObjects[key]
		if !present {
			findings = append(findings, fail(stepCompare, "missing-required-media",
				"%s %s original %q is not in the restored media manifest",
				want.RecordDomain, want.RecordID, want.Reference))
			continue
		}
		if want.Reference != got.Reference || want.StorageBackend != got.StorageBackend ||
			want.Disposition != got.Disposition || want.Required != got.Required ||
			want.Role != got.Role || want.MediaType != got.MediaType {
			findings = append(findings, fail(stepCompare, "media-reference-mismatch",
				"%s %s: source %s/%s/%s, re-export %s/%s/%s",
				want.RecordDomain, want.RecordID, want.Reference, want.StorageBackend, want.Disposition,
				got.Reference, got.StorageBackend, got.Disposition))
		}
		if want.HashState != got.HashState || want.SHA256 != got.SHA256 {
			switch {
			case options.SkipMedia:
				findings = append(findings, explained(stepCompare, "media-hashing-disabled",
					"%s %s: hash state %s -> %s while -skip-media was set",
					want.RecordDomain, want.RecordID, want.HashState, got.HashState))
			case want.HashState == "missing-or-unreadable" && want.OmissionReason != "":
				findings = append(findings, explained(stepCompare, "accepted-media-omission",
					"%s %s original %q: classified omission (%s)",
					want.RecordDomain, want.RecordID, want.Reference, want.OmissionReason))
			default:
				findings = append(findings, fail(stepCompare, "media-hash-mismatch",
					"%s %s original %q: source %s/%s, re-export %s/%s",
					want.RecordDomain, want.RecordID, want.Reference,
					want.HashState, want.SHA256, got.HashState, got.SHA256))
			}
		}
		if !equalJSON(want.DerivedRenditions, got.DerivedRenditions) {
			// Thumbnails and medium renditions are regenerable and are
			// excluded from every content-hash gate by the format spec.
			findings = append(findings, explained(stepCompare, "rendition-regenerable",
				"%s %s: derived renditions %v -> %v",
				want.RecordDomain, want.RecordID, want.DerivedRenditions, got.DerivedRenditions))
		}
	}
	for key, object := range restoredObjects {
		if _, present := sourceObjects[key]; !present {
			findings = append(findings, fail(stepCompare, "additional-media",
				"the restored media manifest lists %s %s, which the source does not",
				object.RecordDomain, object.RecordID))
		}
	}
	return findings
}

func indexMedia(objects []snapshot.MediaObject) map[string]snapshot.MediaObject {
	out := make(map[string]snapshot.MediaObject, len(objects))
	for _, object := range objects {
		out[object.RecordDomain+"\x1f"+object.RecordID] = object
	}
	return out
}

// compareAggregates compares the legacy family strictly. Equal numbers under
// unequal definition versions are not equality, so the definition metadata is
// compared alongside the value.
//
// The newLedger family is reserved in format v1: both sides must declare it
// with a null value, because the new schema does not exist yet. A non-null
// value here would mean somebody filled it in on one side only.
func compareAggregates(source, restored *artifact) []finding {
	var findings []finding
	families := []string{"newLedger"}
	if db.ActiveProfile() != db.ProfileBaseline {
		if _, sourceHasLegacy := source.Verification.AggregateFamilies["legacy"]; sourceHasLegacy {
			families = append([]string{"legacy"}, families...)
		}
	}
	for _, family := range families {
		want, hasWant := source.Verification.AggregateFamilies[family]
		got, hasGot := restored.Verification.AggregateFamilies[family]
		if !hasWant || !hasGot {
			findings = append(findings, fail(stepCompare, "aggregate-family-missing",
				"aggregate family %q present in source=%v, re-export=%v", family, hasWant, hasGot))
			continue
		}
		if want.Version != got.Version || want.Label != got.Label {
			findings = append(findings, fail(stepCompare, "aggregate-definition-drift",
				"family %q: source %s/%s, re-export %s/%s",
				family, want.Label, want.Version, got.Label, got.Version))
		}
		if !equalJSON(want.Mapping, got.Mapping) {
			findings = append(findings, fail(stepCompare, "aggregate-mapping-drift",
				"family %q declares different mappings on the two sides", family))
		}
		wantDefinitions := indexAggregates(want.Definitions)
		gotDefinitions := indexAggregates(got.Definitions)
		names := make([]string, 0, len(wantDefinitions))
		for name := range wantDefinitions {
			names = append(names, name)
		}
		sort.Strings(names)
		for _, name := range names {
			left := wantDefinitions[name]
			right, present := gotDefinitions[name]
			if !present {
				findings = append(findings, fail(stepCompare, "aggregate-definition-missing",
					"family %q: the re-export has no definition %q", family, name))
				continue
			}
			if left.Version != right.Version || left.Unit != right.Unit ||
				left.Rounding != right.Rounding || left.SignConvention != right.SignConvention ||
				left.QueryVersion != right.QueryVersion || left.Currency != right.Currency ||
				!equalJSON(left.Statuses, right.Statuses) ||
				!equalJSON(left.Dimensions, right.Dimensions) {
				findings = append(findings, fail(stepCompare, "aggregate-definition-drift",
					"family %q definition %q: the two sides describe it differently "+
						"(version %s/%s, unit %s/%s, rounding %s/%s, sign %s/%s, query %s/%s)",
					family, name, left.Version, right.Version, left.Unit, right.Unit,
					left.Rounding, right.Rounding, left.SignConvention, right.SignConvention,
					left.QueryVersion, right.QueryVersion))
				continue
			}
			if !equalCanonical(left.Value, right.Value) {
				findings = append(findings, fail(stepCompare, "aggregate-value-mismatch",
					"family %q definition %q: source value %s, re-export %s",
					family, name, string(left.Value), string(right.Value)))
			}
		}
		for name := range gotDefinitions {
			if _, present := wantDefinitions[name]; !present {
				findings = append(findings, fail(stepCompare, "aggregate-definition-additional",
					"family %q: the re-export adds definition %q", family, name))
			}
		}
	}
	return findings
}

func indexAggregates(definitions []snapshot.AggregateDefinition) map[string]snapshot.AggregateDefinition {
	out := make(map[string]snapshot.AggregateDefinition, len(definitions))
	for _, definition := range definitions {
		out[definition.Name] = definition
	}
	return out
}

func sortedDomains(left, right map[string][]artifactRecord) []string {
	seen := map[string]bool{}
	for domain := range left {
		seen[domain] = true
	}
	for domain := range right {
		seen[domain] = true
	}
	out := make([]string, 0, len(seen))
	for domain := range seen {
		out = append(out, domain)
	}
	sort.Strings(out)
	return out
}

// equalCanonical compares two raw JSON values under the artifact's own
// canonicalization, so key order and number spelling cannot make equal values
// look different (design section 4.2).
func equalCanonical(left, right json.RawMessage) bool {
	if len(left) == 0 || len(right) == 0 {
		return len(left) == len(right)
	}
	leftCanonical, leftErr := snapshot.CanonicalJSON(left)
	rightCanonical, rightErr := snapshot.CanonicalJSON(right)
	if leftErr != nil || rightErr != nil {
		return bytes.Equal(left, right)
	}
	return bytes.Equal(leftCanonical, rightCanonical)
}

func equalJSON(left, right any) bool {
	leftBytes, leftErr := json.Marshal(left)
	rightBytes, rightErr := json.Marshal(right)
	if leftErr != nil || rightErr != nil {
		return false
	}
	return equalCanonical(leftBytes, rightBytes)
}

func jsonString(value any) string {
	encoded, err := json.Marshal(value)
	if err != nil {
		return "?"
	}
	text := string(encoded)
	if len(text) > 120 {
		return text[:117] + "..."
	}
	return strings.TrimSpace(text)
}
