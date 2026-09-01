package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/biker2000on/beez-trackz/backend/internal/snapshot"
)

// The adversarial suite of design section 4. Every case here is file-only, so
// none of them skip: a corrupt artifact must be refused whether or not a
// Postgres is reachable, and the whole point of the checksum pass is that it
// runs before anything is connected to.

// fixtureRecord is one record in a hand-built artifact. DigestOverride writes
// a digest the data does not hash to, which is how the tampered-digest case
// produces an artifact that is internally consistent everywhere else.
type fixtureRecord struct {
	Data           map[string]any
	DigestOverride string
}

// fixtureModel is a complete, self-consistent snapshot artifact. It is built
// by hand rather than exported so the adversarial cases can mutate one thing
// at a time and re-seal everything else.
type fixtureModel struct {
	FormatVersion int
	Domains       map[string][]fixtureRecord
	References    []snapshot.ReferenceCheck
	Media         []snapshot.MediaObject
}

// baselineFixture is a miniature but structurally complete artifact: two
// linked domains, one media owner, one satisfied reference check.
func baselineFixture() *fixtureModel {
	apiaryID := "11111111-1111-4111-8111-111111111111"
	hiveID := "22222222-2222-4222-8222-222222222222"
	photoID := "33333333-3333-4333-8333-333333333333"
	return &fixtureModel{
		FormatVersion: snapshot.FormatVersion,
		Domains: map[string][]fixtureRecord{
			"apiaries": {{Data: map[string]any{
				"id": apiaryID, "name": "Home yard",
				"canvas_layout": map[string]any{"zoom": 1, "scale": 2},
				"created_at":    "2026-01-01T00:00:00Z",
			}}},
			"hives": {{Data: map[string]any{
				"id": hiveID, "apiary_id": apiaryID, "position_label": "A1",
				"created_at": "2026-01-01T00:00:00Z",
			}}},
			"photos": {{Data: map[string]any{
				"id": photoID, "owner_type": "hive", "owner_id": hiveID,
				"original_key": "photos/one.jpg", "original_ref": "photos/one.jpg",
				"thumbnail_key": "photos/one.thumb.jpg", "storage_backend": "minio",
				"original_external": false, "created_at": "2026-01-01T00:00:00Z",
			}}},
		},
		References: []snapshot.ReferenceCheck{
			{Name: "hives_apiary_id_fkey", FromDomain: "hives", FromFields: []string{"apiary_id"},
				ToDomain: "apiaries", ToFields: []string{"id"}, Required: true,
				PopulatedCount: 1, ResolvedCount: 1, DanglingCount: 0},
			{Name: "photos_owner_hive", FromDomain: "photos", FromFields: []string{"owner_id"},
				ToDomain: "hives", ToFields: []string{"id"}, Required: true,
				PopulatedCount: 1, ResolvedCount: 1, DanglingCount: 0},
			{Name: "photos_owner_apiary", FromDomain: "photos", FromFields: []string{"owner_id"},
				ToDomain: "apiaries", ToFields: []string{"id"}, Required: true,
				PopulatedCount: 0, ResolvedCount: 0, DanglingCount: 0},
		},
		Media: []snapshot.MediaObject{{
			RecordDomain: "photos", RecordID: photoID, OwnerDomain: "hive", OwnerID: hiveID,
			MediaType: "image", OriginalFilename: "one.jpg", Role: "original",
			StorageBackend: "minio", Disposition: "external-reference",
			Reference: "photos/one.jpg", Required: true, HashState: "unhashed",
			DerivedRenditions: []string{"photos/one.thumb.jpg"},
		}},
	}
}

// write emits the artifact with every hash, count, and digest consistent.
func (model *fixtureModel) write(t *testing.T, directory string) string {
	t.Helper()
	if err := os.MkdirAll(filepath.Join(directory, "domains"), 0o700); err != nil {
		t.Fatalf("create fixture: %v", err)
	}
	names := make([]string, 0, len(model.Domains))
	for name := range model.Domains {
		names = append(names, name)
	}
	sort.Strings(names)

	files := make([]snapshot.FileManifest, 0, len(names))
	verification := snapshot.Verification{
		Version: snapshot.VerificationVersion, FormatVersion: model.FormatVersion,
		GeneratedAt:             time.Date(2026, 9, 1, 0, 0, 0, 0, time.UTC),
		CanonicalizationVersion: snapshot.CanonicalizationVersion,
		DigestAlgorithm:         snapshot.DigestAlgorithmVersion,
		RecordCounts:            map[string]int64{},
		AggregateFamilies: map[string]snapshot.AggregateFamily{
			"legacy": {Label: "legacy definitions", Version: snapshot.LegacyAggregateFamily,
				Definitions: []snapshot.AggregateDefinition{{
					Name: "honey_bulk_on_hand_lbs", Version: "legacy-v1", Unit: "lb",
					Rounding: "none", SignConvention: "draws negative", QueryVersion: "honey_ledger-v1",
					Value: json.RawMessage(`0`)}}},
			"newLedger": {Label: "new-ledger definitions", Version: snapshot.NewAggregateFamily},
		},
	}
	for _, name := range names {
		var content []byte
		for _, record := range model.Domains[name] {
			data, err := snapshot.MarshalCanonical(record.Data)
			if err != nil {
				t.Fatalf("canonicalize %s: %v", name, err)
			}
			digest := snapshot.SHA256Hex(data)
			if record.DigestOverride != "" {
				digest = record.DigestOverride
			}
			id, err := snapshot.MarshalCanonical(record.Data["id"])
			if err != nil {
				t.Fatalf("canonicalize id: %v", err)
			}
			line, err := snapshot.MarshalCanonical(snapshot.RecordEnvelope{
				Domain: name, ID: id, CanonicalizationVersion: snapshot.CanonicalizationVersion,
				DigestAlgorithm: snapshot.DigestAlgorithmVersion, Digest: digest, Data: data,
			})
			if err != nil {
				t.Fatalf("encode envelope: %v", err)
			}
			content = append(append(content, line...), '\n')
			verification.RecordDigests = append(verification.RecordDigests, snapshot.RecordDigest{
				Domain: name, ID: id, CanonicalizationVersion: snapshot.CanonicalizationVersion,
				DigestAlgorithm: snapshot.DigestAlgorithmVersion, Digest: digest})
		}
		relative := "domains/" + name + ".jsonl"
		if err := os.WriteFile(filepath.Join(directory, filepath.FromSlash(relative)), content, 0o600); err != nil {
			t.Fatalf("write %s: %v", relative, err)
		}
		files = append(files, snapshot.FileManifest{Domain: name, Path: relative,
			Records: int64(len(model.Domains[name])), Bytes: int64(len(content)),
			SHA256: snapshot.SHA256Hex(content)})
		verification.RecordCounts[name] = int64(len(model.Domains[name]))
	}
	verification.ReferenceChecks = model.References
	for _, object := range model.Media {
		verification.Media = append(verification.Media, snapshot.MediaVerification{
			RecordDomain: object.RecordDomain, RecordID: object.RecordID,
			OwnerDomain: object.OwnerDomain, OwnerID: object.OwnerID,
			Reference: object.Reference, HashState: object.HashState,
			SHA256: object.SHA256, Bytes: object.Bytes})
	}

	mediaFile := writeFixtureDocument(t, directory, "media-manifest.json",
		snapshot.MediaManifest{Version: snapshot.MediaManifestVersion, Objects: model.Media})
	verificationFile := writeFixtureDocument(t, directory, "verification.json", verification)
	writeFixtureDocument(t, directory, "manifest.json", snapshot.Manifest{
		FormatVersion: model.FormatVersion,
		ExportedAt:    time.Date(2026, 9, 1, 0, 0, 0, 0, time.UTC),
		AppCommit:     "fixture", SchemaMigration: 49,
		ExporterVersion: snapshot.ExporterVersion, Files: files,
		Canonical: snapshot.CanonicalDeclarations{
			JSON: snapshot.CanonicalizationVersion, Encoding: "UTF-8 without BOM", LineEnding: "LF",
			Units: map[string]string{"honeyMass": "lb"}, DigestAlgorithm: snapshot.DigestAlgorithmVersion},
		MediaManifestVersion: snapshot.MediaManifestVersion,
		MediaManifest:        mediaFile, Verification: verificationFile,
	})
	return directory
}

func writeFixtureDocument(t *testing.T, directory, name string, value any) snapshot.FileManifest {
	t.Helper()
	content, err := snapshot.MarshalCanonical(value)
	if err != nil {
		t.Fatalf("encode %s: %v", name, err)
	}
	content = append(content, '\n')
	if err := os.WriteFile(filepath.Join(directory, name), content, 0o600); err != nil {
		t.Fatalf("write %s: %v", name, err)
	}
	return snapshot.FileManifest{Path: name, Records: 1, Bytes: int64(len(content)),
		SHA256: snapshot.SHA256Hex(content)}
}

// codes lists the failure codes a findings slice carries.
func codes(items []finding) []string {
	out := make([]string, 0, len(items))
	for _, item := range items {
		if !item.Explained {
			out = append(out, item.Code)
		}
	}
	return out
}

func hasCode(items []finding, want string) bool {
	for _, code := range codes(items) {
		if code == want {
			return true
		}
	}
	return false
}

func detailFor(items []finding, code string) string {
	for _, item := range items {
		if item.Code == code {
			return item.Detail
		}
	}
	return ""
}

// A clean artifact passes the checksum pass with no findings at all. Every
// adversarial case below starts from this one and breaks exactly one thing,
// so a failure there is attributable.
func TestChecksumPassAcceptsACleanArtifact(t *testing.T) {
	directory := baselineFixture().write(t, t.TempDir())
	loaded, findings := loadArtifact(directory)
	if loaded == nil {
		t.Fatalf("clean artifact did not load: %v", findings)
	}
	if got := failures(findings); len(got) != 0 {
		t.Fatalf("clean artifact produced failures: %v", got)
	}
	if loaded.WrapChecksum == "" {
		t.Fatal("no wrapping checksum was computed")
	}
	// The wrapping checksum covers content, so an edit anywhere changes it.
	second := baselineFixture().write(t, t.TempDir())
	other, _ := loadArtifact(second)
	if other.WrapChecksum != loaded.WrapChecksum {
		t.Fatal("the wrapping checksum is not a function of the artifact bytes alone")
	}
}

// A1: a byte flipped after hashing. The manifest hash is the tripwire and
// nothing downstream runs.
func TestChecksumPassRejectsACorruptFile(t *testing.T) {
	directory := baselineFixture().write(t, t.TempDir())
	path := filepath.Join(directory, "domains", "hives.jsonl")
	content, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	flipped := strings.Replace(string(content), "\"A1\"", "\"A2\"", 1)
	if flipped == string(content) {
		t.Fatal("fixture changed shape; nothing was flipped")
	}
	if err := os.WriteFile(path, []byte(flipped), 0o600); err != nil {
		t.Fatal(err)
	}
	_, findings := loadArtifact(directory)
	if !hasCode(findings, "manifest-hash-mismatch") {
		t.Fatalf("a flipped byte was not caught: %v", codes(findings))
	}
}

// A2: a JSONL truncated mid-object. The error names the file and the byte
// offset, because "some JSON is bad" is not an actionable restore error.
func TestChecksumPassRejectsATruncatedJSONL(t *testing.T) {
	directory := baselineFixture().write(t, t.TempDir())
	path := filepath.Join(directory, "domains", "apiaries.jsonl")
	content, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	truncated := content[:len(content)-12]
	if err := os.WriteFile(path, truncated, 0o600); err != nil {
		t.Fatal(err)
	}
	// Re-seal the file hash so the parse error is what fails, not the hash.
	resealManifest(t, directory)
	_, findings := loadArtifact(directory)
	if !hasCode(findings, "jsonl-parse-error") {
		t.Fatalf("a truncated record was not caught: %v", codes(findings))
	}
	detail := detailFor(findings, "jsonl-parse-error")
	if !strings.Contains(detail, "apiaries.jsonl") || !strings.Contains(detail, "offset") {
		t.Fatalf("the parse error does not name the file and offset: %q", detail)
	}
}

// A3: a reference that does not resolve. The artifact is internally sealed
// and verification.json even claims the graph is whole; the gate resolves the
// references itself rather than believing it.
func TestChecksumPassRejectsADanglingReference(t *testing.T) {
	model := baselineFixture()
	model.Domains["hives"][0].Data["apiary_id"] = "99999999-9999-4999-8999-999999999999"
	directory := model.write(t, t.TempDir())
	_, findings := loadArtifact(directory)
	if !hasCode(findings, "dangling-reference") {
		t.Fatalf("a dangling reference was not caught: %v", codes(findings))
	}
	detail := detailFor(findings, "dangling-reference")
	if !strings.Contains(detail, "hives") || !strings.Contains(detail, "apiaries") {
		t.Fatalf("the reference error does not name both ends: %q", detail)
	}
	// And the lie in verification.json is reported in its own right.
	if !hasCode(findings, "reference-count-mismatch") {
		t.Fatalf("the declared reference counts were taken on faith: %v", codes(findings))
	}
}

// A4: two lines with the same preserved id. Neither is inserted as a
// coin flip; the artifact is refused.
func TestChecksumPassRejectsADuplicatePreservedID(t *testing.T) {
	model := baselineFixture()
	duplicate := model.Domains["hives"][0]
	duplicate.Data = map[string]any{}
	for key, value := range model.Domains["hives"][0].Data {
		duplicate.Data[key] = value
	}
	duplicate.Data["position_label"] = "A2"
	model.Domains["hives"] = append(model.Domains["hives"], duplicate)
	directory := model.write(t, t.TempDir())
	_, findings := loadArtifact(directory)
	if !hasCode(findings, "duplicate-record-id") {
		t.Fatalf("a duplicate preserved id was not caught: %v", codes(findings))
	}
}

// The tampered-digest case: the data was edited and the digest was edited to
// match the claim, so only recomputing from the canonical bytes catches it.
func TestChecksumPassRejectsATamperedDigest(t *testing.T) {
	model := baselineFixture()
	model.Domains["apiaries"][0].DigestOverride =
		"0000000000000000000000000000000000000000000000000000000000000000"
	directory := model.write(t, t.TempDir())
	_, findings := loadArtifact(directory)
	if !hasCode(findings, "record-digest-mismatch") {
		t.Fatalf("a tampered digest was not caught: %v", codes(findings))
	}
}

// A6/C4: a photo whose original is inside the restoration boundary but has no
// entry in the media manifest at all.
func TestChecksumPassRejectsAMissingRequiredMediaEntry(t *testing.T) {
	model := baselineFixture()
	model.Media = nil
	directory := model.write(t, t.TempDir())
	_, findings := loadArtifact(directory)
	if !hasCode(findings, "missing-required-media") {
		t.Fatalf("a missing required original was not caught: %v", codes(findings))
	}
	if !strings.Contains(detailFor(findings, "missing-required-media"), "photos/one.jpg") {
		t.Fatalf("the media error does not name the original: %q",
			detailFor(findings, "missing-required-media"))
	}
}

// A8: an unsupported formatVersion is refused outright. The gate does not
// parse on and guess a layout from the source commit.
func TestChecksumPassRejectsAnUnsupportedFormatVersion(t *testing.T) {
	for _, version := range []int{0, 999} {
		directory := baselineFixture().write(t, t.TempDir())
		patchManifest(t, directory, func(manifest map[string]any) {
			manifest["formatVersion"] = version
		})
		loaded, findings := loadArtifact(directory)
		if loaded != nil {
			t.Fatalf("formatVersion %d was parsed anyway", version)
		}
		if !hasCode(findings, "unsupported-format-version") {
			t.Fatalf("formatVersion %d was not refused: %v", version, codes(findings))
		}
		if len(findings) != 1 {
			t.Fatalf("formatVersion %d produced downstream findings from a guessed layout: %v",
				version, codes(findings))
		}
	}
}

// A restore report may never be written inside the artifact: it would change
// the bytes the wrapping checksum covers.
func TestImporterRefusesAReportInsideTheArtifact(t *testing.T) {
	directory := t.TempDir()
	item := &importer{binary: filepath.Join(directory, "import-snapshot")}
	if _, err := item.run(t.Context(), directory, "postgres://example/db",
		filepath.Join(directory, "restore-report.json")); err == nil {
		t.Fatal("the gate was willing to write a restore report into the snapshot artifact")
	}
}

// patchManifest rewrites manifest.json. The manifest's own hash is
// deliberately not recursive, so editing it alone leaves a consistent
// artifact — which is exactly what makes the formatVersion case a real test.
func patchManifest(t *testing.T, directory string, mutate func(map[string]any)) {
	t.Helper()
	path := filepath.Join(directory, "manifest.json")
	content, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	manifest := map[string]any{}
	if err := json.Unmarshal(content, &manifest); err != nil {
		t.Fatal(err)
	}
	mutate(manifest)
	encoded, err := json.Marshal(manifest)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, append(encoded, '\n'), 0o600); err != nil {
		t.Fatal(err)
	}
}

// resealManifest recomputes the file hashes and byte counts in the manifest
// without touching record counts, so a mutated file can be tested for what it
// is rather than for the hash mismatch it also causes.
func resealManifest(t *testing.T, directory string) {
	t.Helper()
	patchManifest(t, directory, func(manifest map[string]any) {
		files, _ := manifest["files"].([]any)
		for _, entry := range files {
			file, _ := entry.(map[string]any)
			path, _ := file["path"].(string)
			content, err := os.ReadFile(filepath.Join(directory, filepath.FromSlash(path)))
			if err != nil {
				t.Fatal(err)
			}
			file["sha256"] = snapshot.SHA256Hex(content)
			file["bytes"] = len(content)
		}
	})
}
