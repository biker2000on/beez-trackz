package snapshot

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestOpenArtifactRejectsCorruptHash(t *testing.T) {
	root, _ := readerFixture(t, nil)
	path := filepath.Join(root, "domains", "customers.jsonl")
	content, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	content[len(content)/2] ^= 1
	if err := os.WriteFile(path, content, 0o600); err != nil {
		t.Fatal(err)
	}
	_, err = OpenArtifact(root)
	if err == nil || !strings.Contains(err.Error(), "SHA-256 mismatch") {
		t.Fatalf("got %v", err)
	}
}

func TestOpenArtifactRejectsTruncatedJSONL(t *testing.T) {
	root, manifest := readerFixture(t, nil)
	path := filepath.Join(root, "domains", "customers.jsonl")
	content, _ := os.ReadFile(path)
	content = bytes.TrimSuffix(content, []byte{'\n'})
	updateFixtureFile(t, root, manifest, "customers", content)
	_, err := OpenArtifact(root)
	if err == nil || !strings.Contains(err.Error(), "truncated") {
		t.Fatalf("got %v", err)
	}
}

func TestOpenArtifactRejectsRecordDigestMismatch(t *testing.T) {
	root, manifest := readerFixture(t, func(records []RecordEnvelope) []RecordEnvelope {
		records[0].Digest = strings.Repeat("0", 64)
		return records
	})
	path := filepath.Join(root, "domains", "customers.jsonl")
	content, _ := os.ReadFile(path)
	updateFixtureFile(t, root, manifest, "customers", content)
	_, err := OpenArtifact(root)
	if err == nil || !strings.Contains(err.Error(), "record digest mismatch") {
		t.Fatalf("got %v", err)
	}
}

func TestOpenArtifactRejectsUnsupportedFormatVersion(t *testing.T) {
	root, manifest := readerFixture(t, nil)
	manifest.FormatVersion = FormatVersion + 1
	writeJSON(t, filepath.Join(root, "manifest.json"), manifest)
	_, err := OpenArtifact(root)
	if err == nil || !strings.Contains(err.Error(), "unsupported formatVersion") {
		t.Fatalf("got %v", err)
	}
}

func TestOpenArtifactRejectsDuplicateAndConflictingPreservedIDs(t *testing.T) {
	for _, test := range []struct {
		name     string
		conflict bool
		want     string
	}{
		{"duplicate", false, "duplicate preserved id"},
		{"conflicting", true, "conflicting duplicate preserved id"},
	} {
		t.Run(test.name, func(t *testing.T) {
			root, manifest := readerFixture(t, func(records []RecordEnvelope) []RecordEnvelope {
				duplicate := records[0]
				if test.conflict {
					duplicate.Data = json.RawMessage(`{"created_at":"2024-01-01T00:00:00Z","email":null,"email_opt_in":false,"id":"11111111-1111-1111-1111-111111111111","name":"Different","notes":null,"updated_at":"2024-01-01T00:00:00Z"}`)
					duplicate.Digest = SHA256Hex(duplicate.Data)
				}
				return append(records, duplicate)
			})
			path := filepath.Join(root, "domains", "customers.jsonl")
			content, _ := os.ReadFile(path)
			updateFixtureFile(t, root, manifest, "customers", content)
			_, err := OpenArtifact(root)
			if err == nil || !strings.Contains(err.Error(), test.want) {
				t.Fatalf("got %v", err)
			}
		})
	}
}

func readerFixture(t *testing.T, mutate func([]RecordEnvelope) []RecordEnvelope) (string, *Manifest) {
	t.Helper()
	root := t.TempDir()
	if err := os.Mkdir(filepath.Join(root, "domains"), 0o700); err != nil {
		t.Fatal(err)
	}
	data := json.RawMessage(`{"created_at":"2024-01-01T00:00:00Z","email":null,"email_opt_in":false,"id":"11111111-1111-1111-1111-111111111111","name":"Fixture","notes":null,"updated_at":"2024-01-01T00:00:00Z"}`)
	id := json.RawMessage(`"11111111-1111-1111-1111-111111111111"`)
	records := []RecordEnvelope{{Domain: "customers", ID: id, CanonicalizationVersion: CanonicalizationVersion, DigestAlgorithm: DigestAlgorithmVersion, Digest: SHA256Hex(data), Data: data}}
	if mutate != nil {
		records = mutate(records)
	}
	files := make([]FileManifest, 0, len(Domains))
	digests := []RecordDigest{}
	counts := map[string]int64{}
	for _, domain := range RegisteredDomains() {
		var content []byte
		if domain.Name == "customers" {
			for _, record := range records {
				line, err := MarshalCanonical(record)
				if err != nil {
					t.Fatal(err)
				}
				content = append(content, append(line, '\n')...)
				digests = append(digests, RecordDigest{Domain: domain.Name, ID: record.ID, CanonicalizationVersion: CanonicalizationVersion, DigestAlgorithm: DigestAlgorithmVersion, Digest: record.Digest})
			}
		}
		relative := filepath.ToSlash(filepath.Join("domains", domain.Name+".jsonl"))
		if err := os.WriteFile(filepath.Join(root, filepath.FromSlash(relative)), content, 0o600); err != nil {
			t.Fatal(err)
		}
		files = append(files, FileManifest{Domain: domain.Name, Path: relative, Records: int64(len(recordsFor(domain.Name, records))), Bytes: int64(len(content)), SHA256: SHA256Hex(content)})
		counts[domain.Name] = int64(len(recordsFor(domain.Name, records)))
	}
	verification := Verification{Version: VerificationVersion, FormatVersion: FormatVersion, GeneratedAt: time.Now().UTC(), CanonicalizationVersion: CanonicalizationVersion, DigestAlgorithm: DigestAlgorithmVersion, RecordCounts: counts, RecordDigests: digests, AggregateFamilies: map[string]AggregateFamily{}}
	verificationContent := canonicalDocument(t, verification)
	if err := os.WriteFile(filepath.Join(root, "verification.json"), verificationContent, 0o600); err != nil {
		t.Fatal(err)
	}
	media := MediaManifest{Version: MediaManifestVersion, Objects: []MediaObject{}}
	mediaContent := canonicalDocument(t, media)
	if err := os.WriteFile(filepath.Join(root, "media-manifest.json"), mediaContent, 0o600); err != nil {
		t.Fatal(err)
	}
	manifest := &Manifest{FormatVersion: FormatVersion, ExportedAt: time.Now().UTC(), AppCommit: "test", SchemaMigration: 48, ExporterVersion: ExporterVersion, Files: files,
		Canonical:            CanonicalDeclarations{JSON: CanonicalizationVersion, Encoding: "UTF-8 without BOM", LineEnding: "LF", BusinessTimezone: "UTC", DigestAlgorithm: DigestAlgorithmVersion},
		MediaManifestVersion: MediaManifestVersion,
		MediaManifest:        FileManifest{Path: "media-manifest.json", Records: 1, Bytes: int64(len(mediaContent)), SHA256: SHA256Hex(mediaContent)},
		Verification:         FileManifest{Path: "verification.json", Records: 1, Bytes: int64(len(verificationContent)), SHA256: SHA256Hex(verificationContent)},
	}
	writeJSON(t, filepath.Join(root, "manifest.json"), manifest)
	return root, manifest
}

func recordsFor(domain string, records []RecordEnvelope) []RecordEnvelope {
	if domain == "customers" {
		return records
	}
	return nil
}

func updateFixtureFile(t *testing.T, root string, manifest *Manifest, domain string, content []byte) {
	t.Helper()
	for i := range manifest.Files {
		if manifest.Files[i].Domain == domain {
			if err := os.WriteFile(filepath.Join(root, filepath.FromSlash(manifest.Files[i].Path)), content, 0o600); err != nil {
				t.Fatal(err)
			}
			manifest.Files[i].Bytes = int64(len(content))
			manifest.Files[i].SHA256 = SHA256Hex(content)
		}
	}
	writeJSON(t, filepath.Join(root, "manifest.json"), manifest)
}

func canonicalDocument(t *testing.T, value any) []byte {
	t.Helper()
	content, err := MarshalCanonical(value)
	if err != nil {
		t.Fatal(err)
	}
	return append(content, '\n')
}

func writeJSON(t *testing.T, path string, value any) {
	t.Helper()
	content := canonicalDocument(t, value)
	if err := os.WriteFile(path, content, 0o600); err != nil {
		t.Fatal(err)
	}
}
