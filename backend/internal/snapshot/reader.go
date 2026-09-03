package snapshot

import (
	"bufio"
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"

	"github.com/biker2000on/beez-trackz/backend/internal/db"
)

// Artifact is a completely verified snapshot. OpenArtifact does not return a
// partially trusted artifact: every manifest hash, JSONL envelope digest and
// verification.json digest entry has been checked first.
type Artifact struct {
	Directory    string
	Manifest     Manifest
	Verification Verification
	Media        MediaManifest
	Records      map[string][]RecordEnvelope
	// DroppedDomains names required format-v1 domains that the Phase B
	// baseline intentionally omits. An undeclared missing domain is still a
	// reader error.
	DroppedDomains []string
}

// OpenArtifact reads and independently verifies a format-v1 snapshot.
func OpenArtifact(directory string) (*Artifact, error) {
	root, err := filepath.Abs(directory)
	if err != nil {
		return nil, fmt.Errorf("snapshot reader: resolve input: %w", err)
	}
	manifestBytes, err := os.ReadFile(filepath.Join(root, "manifest.json"))
	if err != nil {
		return nil, fmt.Errorf("snapshot reader: read manifest.json: %w", err)
	}
	var manifest Manifest
	if err := decodeOne(manifestBytes, &manifest); err != nil {
		return nil, fmt.Errorf("snapshot reader: decode manifest.json: %w", err)
	}
	if manifest.FormatVersion != FormatVersion {
		return nil, fmt.Errorf("snapshot reader: unsupported formatVersion %d (supported: %d)", manifest.FormatVersion, FormatVersion)
	}
	if manifest.Canonical.JSON != CanonicalizationVersion || manifest.Canonical.DigestAlgorithm != DigestAlgorithmVersion {
		return nil, fmt.Errorf("snapshot reader: unsupported canonicalization declarations %q/%q", manifest.Canonical.JSON, manifest.Canonical.DigestAlgorithm)
	}
	if manifest.Canonical.Encoding != "UTF-8 without BOM" || manifest.Canonical.LineEnding != "LF" {
		return nil, fmt.Errorf("snapshot reader: unsupported encoding or line ending declaration")
	}

	artifact := &Artifact{Directory: root, Manifest: manifest, Records: make(map[string][]RecordEnvelope)}
	seenFiles := make(map[string]bool)
	seenDomains := make(map[string]bool)
	for _, file := range manifest.Files {
		if file.Domain == "" || seenDomains[file.Domain] {
			return nil, fmt.Errorf("snapshot reader: duplicate or empty domain %q in manifest", file.Domain)
		}
		seenDomains[file.Domain] = true
		content, err := verifiedFile(root, file, seenFiles)
		if err != nil {
			return nil, err
		}
		records, err := decodeJSONL(file, content)
		if err != nil {
			return nil, err
		}
		artifact.Records[file.Domain] = records
	}
	for _, domain := range RegisteredDomains() {
		if !seenDomains[domain.Name] {
			if db.BaselineDrops(domain.Name) {
				artifact.DroppedDomains = append(artifact.DroppedDomains, domain.Name)
				continue
			}
			return nil, fmt.Errorf("snapshot reader: required domain %q is absent", domain.Name)
		}
	}

	verificationBytes, err := verifiedFile(root, manifest.Verification, seenFiles)
	if err != nil {
		return nil, err
	}
	if err := decodeOne(verificationBytes, &artifact.Verification); err != nil {
		return nil, fmt.Errorf("snapshot reader: decode verification.json: %w", err)
	}
	if err := validateVerification(artifact); err != nil {
		return nil, err
	}
	mediaBytes, err := verifiedFile(root, manifest.MediaManifest, seenFiles)
	if err != nil {
		return nil, err
	}
	if err := decodeOne(mediaBytes, &artifact.Media); err != nil {
		return nil, fmt.Errorf("snapshot reader: decode media manifest: %w", err)
	}
	if artifact.Media.Version != manifest.MediaManifestVersion || artifact.Media.Version != MediaManifestVersion {
		return nil, fmt.Errorf("snapshot reader: unsupported media manifest version %d", artifact.Media.Version)
	}
	return artifact, nil
}

func verifiedFile(root string, file FileManifest, seen map[string]bool) ([]byte, error) {
	if file.Path == "" {
		return nil, fmt.Errorf("snapshot reader: manifest contains an empty file path")
	}
	clean := filepath.Clean(filepath.FromSlash(file.Path))
	if filepath.IsAbs(clean) || clean == ".." || strings.HasPrefix(clean, ".."+string(filepath.Separator)) {
		return nil, fmt.Errorf("snapshot reader: unsafe artifact path %q", file.Path)
	}
	if seen[file.Path] {
		return nil, fmt.Errorf("snapshot reader: duplicate artifact path %q", file.Path)
	}
	seen[file.Path] = true
	content, err := os.ReadFile(filepath.Join(root, clean))
	if err != nil {
		return nil, fmt.Errorf("snapshot reader: read %s: %w", file.Path, err)
	}
	if int64(len(content)) != file.Bytes {
		return nil, fmt.Errorf("snapshot reader: %s byte count mismatch: manifest=%d actual=%d", file.Path, file.Bytes, len(content))
	}
	actual := SHA256Hex(content)
	if actual != file.SHA256 {
		return nil, fmt.Errorf("snapshot reader: %s SHA-256 mismatch: manifest=%s actual=%s", file.Path, file.SHA256, actual)
	}
	return content, nil
}

func decodeJSONL(file FileManifest, content []byte) ([]RecordEnvelope, error) {
	if len(content) > 0 && content[len(content)-1] != '\n' {
		return nil, fmt.Errorf("snapshot reader: %s is truncated or lacks its final LF", file.Path)
	}
	reader := bufio.NewReader(bytes.NewReader(content))
	records := make([]RecordEnvelope, 0, file.Records)
	ids := make(map[string]string)
	for line := int64(1); ; line++ {
		raw, err := reader.ReadBytes('\n')
		if len(raw) == 0 && err == io.EOF {
			break
		}
		if err != nil && err != io.EOF {
			return nil, fmt.Errorf("snapshot reader: %s line %d: %w", file.Path, line, err)
		}
		raw = bytes.TrimSuffix(raw, []byte{'\n'})
		if len(raw) == 0 {
			return nil, fmt.Errorf("snapshot reader: %s line %d is empty", file.Path, line)
		}
		var envelope RecordEnvelope
		if err := decodeOne(raw, &envelope); err != nil {
			return nil, fmt.Errorf("snapshot reader: %s line %d is invalid JSONL: %w", file.Path, line, err)
		}
		if envelope.Domain != file.Domain {
			return nil, fmt.Errorf("snapshot reader: %s line %d declares domain %q, expected %q", file.Path, line, envelope.Domain, file.Domain)
		}
		if envelope.CanonicalizationVersion != CanonicalizationVersion || envelope.DigestAlgorithm != DigestAlgorithmVersion {
			return nil, fmt.Errorf("snapshot reader: %s line %d has unsupported digest declarations", file.Path, line)
		}
		canonicalID, err := CanonicalJSON(envelope.ID)
		if err != nil || string(canonicalID) == "null" {
			return nil, fmt.Errorf("snapshot reader: %s line %d has invalid preserved id", file.Path, line)
		}
		actualDigest, err := DigestCanonicalJSON(envelope.Data)
		if err != nil {
			return nil, fmt.Errorf("snapshot reader: %s line %d data: %w", file.Path, line, err)
		}
		if actualDigest != envelope.Digest {
			return nil, fmt.Errorf("snapshot reader: %s line %d record digest mismatch for id %s", file.Path, line, canonicalID)
		}
		key := string(canonicalID)
		if previous, exists := ids[key]; exists {
			kind := "duplicate"
			if previous != envelope.Digest {
				kind = "conflicting duplicate"
			}
			return nil, fmt.Errorf("snapshot reader: %s line %d has %s preserved id %s", file.Path, line, kind, key)
		}
		ids[key] = envelope.Digest
		records = append(records, envelope)
	}
	if int64(len(records)) != file.Records {
		return nil, fmt.Errorf("snapshot reader: %s record count mismatch: manifest=%d actual=%d", file.Path, file.Records, len(records))
	}
	return records, nil
}

func validateVerification(artifact *Artifact) error {
	v := artifact.Verification
	if v.Version != VerificationVersion || v.FormatVersion != FormatVersion || v.CanonicalizationVersion != CanonicalizationVersion || v.DigestAlgorithm != DigestAlgorithmVersion {
		return fmt.Errorf("snapshot reader: verification.json has unsupported version declarations")
	}
	expected := make(map[string]string)
	for domain, records := range artifact.Records {
		if v.RecordCounts[domain] != int64(len(records)) {
			return fmt.Errorf("snapshot reader: verification count mismatch for domain %s", domain)
		}
		for _, record := range records {
			id, _ := CanonicalJSON(record.ID)
			expected[domain+"\x00"+string(id)] = record.Digest
		}
	}
	seen := make(map[string]bool)
	for _, digest := range v.RecordDigests {
		id, err := CanonicalJSON(digest.ID)
		if err != nil {
			return fmt.Errorf("snapshot reader: invalid verification digest id for %s", digest.Domain)
		}
		key := digest.Domain + "\x00" + string(id)
		if seen[key] {
			return fmt.Errorf("snapshot reader: duplicate verification digest for %s id %s", digest.Domain, id)
		}
		seen[key] = true
		if digest.CanonicalizationVersion != CanonicalizationVersion || digest.DigestAlgorithm != DigestAlgorithmVersion || expected[key] != digest.Digest {
			return fmt.Errorf("snapshot reader: verification digest mismatch for %s id %s", digest.Domain, id)
		}
	}
	if len(seen) != len(expected) {
		return fmt.Errorf("snapshot reader: verification digest set is incomplete: expected=%d actual=%d", len(expected), len(seen))
	}
	for _, check := range v.ReferenceChecks {
		if check.DanglingCount != 0 || check.ResolvedCount != check.PopulatedCount {
			return fmt.Errorf("snapshot reader: verification reference %s has %d dangling records", check.Name, check.DanglingCount)
		}
	}
	return nil
}

func decodeOne(raw []byte, target any) error {
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	if err := decoder.Decode(target); err != nil {
		return err
	}
	var trailing any
	if err := decoder.Decode(&trailing); err != io.EOF {
		return fmt.Errorf("multiple JSON values")
	}
	return nil
}
