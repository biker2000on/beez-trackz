package main

import (
	"bufio"
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/biker2000on/beez-trackz/backend/internal/snapshot"
)

// supportedFormatVersion is the only snapshot format this gate understands.
// An unknown version is a hard refusal, never a guess at the table layout
// from the source commit (design section 3, adversarial case A8).
const supportedFormatVersion = snapshot.FormatVersion

// artifactRecord is one JSONL line, already parsed and re-digested.
type artifactRecord struct {
	Domain string
	// IDKey is the canonical JSON encoding of the envelope id, so composite
	// keys and scalar keys index the same way.
	IDKey  string
	Digest string
	Data   json.RawMessage
	Fields map[string]any
	Line   int
	Offset int64
}

// artifact is a loaded snapshot directory plus everything the gate
// recomputed itself. Nothing here is taken on the exporter's word: every
// hash, count, and per-record digest is recomputed from the bytes on disk
// (design step 2 — "do not trust the exporter's in-process hashes").
type artifact struct {
	Dir          string
	Manifest     snapshot.Manifest
	Verification snapshot.Verification
	Media        snapshot.MediaManifest
	Records      map[string][]artifactRecord
	ByID         map[string]map[string]artifactRecord
	// WrapChecksum is the artifact-wide checksum kept beside (never inside)
	// the artifact, and never beside any encryption credential.
	WrapChecksum string
}

const stepChecksum = "step2-checksum"

// loadArtifact performs the independent checksum and structural pass. It
// returns whatever it managed to load together with every finding; a caller
// that got a nil artifact cannot continue.
func loadArtifact(dir string) (*artifact, []finding) {
	var findings []finding
	manifestBytes, err := os.ReadFile(filepath.Join(dir, "manifest.json"))
	if err != nil {
		return nil, []finding{fail(stepChecksum, "artifact-unreadable", "manifest.json: %v", err)}
	}
	loaded := &artifact{Dir: dir, Records: map[string][]artifactRecord{},
		ByID: map[string]map[string]artifactRecord{}}
	if err := json.Unmarshal(manifestBytes, &loaded.Manifest); err != nil {
		return nil, []finding{fail(stepChecksum, "artifact-unreadable", "manifest.json: %v", err)}
	}

	// Format support is checked before anything else is interpreted: a
	// version this build does not know may lay out every other file
	// differently, so parsing on and reporting the consequences would be
	// guessing.
	if loaded.Manifest.FormatVersion != supportedFormatVersion {
		return nil, []finding{fail(stepChecksum, "unsupported-format-version",
			"manifest formatVersion %d is not supported (this gate reads %d only)",
			loaded.Manifest.FormatVersion, supportedFormatVersion)}
	}

	verificationBytes, verificationFindings := readLinkedFile(dir, loaded.Manifest.Verification, "verification")
	findings = append(findings, verificationFindings...)
	if verificationBytes != nil {
		if err := json.Unmarshal(verificationBytes, &loaded.Verification); err != nil {
			findings = append(findings, fail(stepChecksum, "artifact-unreadable",
				"verification.json: %v", err))
		}
	}
	mediaBytes, mediaFindings := readLinkedFile(dir, loaded.Manifest.MediaManifest, "media manifest")
	findings = append(findings, mediaFindings...)
	if mediaBytes != nil {
		if err := json.Unmarshal(mediaBytes, &loaded.Media); err != nil {
			findings = append(findings, fail(stepChecksum, "artifact-unreadable",
				"media-manifest.json: %v", err))
		}
	}
	if loaded.Verification.FormatVersion != 0 &&
		loaded.Verification.FormatVersion != loaded.Manifest.FormatVersion {
		findings = append(findings, fail(stepChecksum, "unsupported-format-version",
			"verification.json declares formatVersion %d, manifest says %d",
			loaded.Verification.FormatVersion, loaded.Manifest.FormatVersion))
	}

	for _, file := range loaded.Manifest.Files {
		records, fileFindings := loadDomainFile(dir, file)
		findings = append(findings, fileFindings...)
		if file.Domain == "" {
			continue
		}
		loaded.Records[file.Domain] = records
		index := make(map[string]artifactRecord, len(records))
		for _, record := range records {
			if _, duplicate := index[record.IDKey]; duplicate {
				findings = append(findings, fail(stepChecksum, "duplicate-record-id",
					"%s line %d: preserved id %s appears more than once",
					file.Path, record.Line, record.IDKey))
				continue
			}
			index[record.IDKey] = record
		}
		loaded.ByID[file.Domain] = index
	}

	findings = append(findings, verifyVerificationDigests(loaded)...)
	findings = append(findings, verifyReferences(loaded)...)
	findings = append(findings, verifyMedia(loaded)...)

	checksum, err := wrappingChecksum(loaded)
	if err != nil {
		findings = append(findings, fail(stepChecksum, "artifact-unreadable",
			"wrapping checksum: %v", err))
	}
	loaded.WrapChecksum = checksum
	return loaded, findings
}

// readLinkedFile reads a file the manifest links by hash and proves the
// bytes match what the manifest claims.
func readLinkedFile(dir string, link snapshot.FileManifest, label string) ([]byte, []finding) {
	if link.Path == "" {
		return nil, []finding{fail(stepChecksum, "artifact-unreadable",
			"manifest does not link a %s file", label)}
	}
	content, err := os.ReadFile(filepath.Join(dir, filepath.FromSlash(link.Path)))
	if err != nil {
		return nil, []finding{fail(stepChecksum, "artifact-unreadable", "%s: %v", link.Path, err)}
	}
	var findings []finding
	if got := snapshot.SHA256Hex(content); got != link.SHA256 {
		findings = append(findings, fail(stepChecksum, "manifest-hash-mismatch",
			"%s: sha256 %s does not match the manifest link %s", link.Path, got, link.SHA256))
	}
	if int64(len(content)) != link.Bytes {
		findings = append(findings, fail(stepChecksum, "manifest-bytes-mismatch",
			"%s: %d bytes on disk, manifest says %d", link.Path, len(content), link.Bytes))
	}
	if len(findings) > 0 {
		return nil, findings
	}
	return content, nil
}

// loadDomainFile hashes, counts, and re-digests one JSONL file.
func loadDomainFile(dir string, file snapshot.FileManifest) ([]artifactRecord, []finding) {
	path := filepath.Join(dir, filepath.FromSlash(file.Path))
	content, err := os.ReadFile(path)
	if err != nil {
		return nil, []finding{fail(stepChecksum, "artifact-unreadable", "%s: %v", file.Path, err)}
	}
	var findings []finding
	if got := snapshot.SHA256Hex(content); got != file.SHA256 {
		// A byte flipped after hashing lands here, and nothing downstream
		// runs: the restore never starts against an artifact whose bytes are
		// not the bytes that were signed (A1).
		findings = append(findings, fail(stepChecksum, "manifest-hash-mismatch",
			"%s: sha256 %s does not match the manifest %s", file.Path, got, file.SHA256))
	}
	if int64(len(content)) != file.Bytes {
		findings = append(findings, fail(stepChecksum, "manifest-bytes-mismatch",
			"%s: %d bytes on disk, manifest says %d", file.Path, len(content), file.Bytes))
	}
	if len(content) > 0 && content[len(content)-1] != '\n' {
		// Format spec: every record, including the last, ends with LF. A file
		// truncated mid-object usually lands here as well as on the parse
		// error below, and naming both is more useful than naming either.
		findings = append(findings, fail(stepChecksum, "jsonl-parse-error",
			"%s: file does not end with LF (byte offset %d); the last record is truncated",
			file.Path, len(content)))
	}

	records := make([]artifactRecord, 0, file.Records)
	reader := bufio.NewReaderSize(bytes.NewReader(content), 1<<20)
	var offset int64
	for line := 1; ; line++ {
		raw, err := reader.ReadBytes('\n')
		if len(raw) == 0 && err == io.EOF {
			break
		}
		start := offset
		offset += int64(len(raw))
		trimmed := bytes.TrimRight(raw, "\n")
		if len(bytes.TrimSpace(trimmed)) == 0 {
			if err == io.EOF {
				break
			}
			continue
		}
		record, recordFindings := decodeEnvelope(file, trimmed, line, start)
		findings = append(findings, recordFindings...)
		if record != nil {
			records = append(records, *record)
		}
		if err == io.EOF {
			break
		}
		if err != nil {
			findings = append(findings, fail(stepChecksum, "jsonl-parse-error",
				"%s line %d (byte offset %d): %v", file.Path, line, start, err))
			break
		}
	}
	if int64(len(records)) != file.Records {
		findings = append(findings, fail(stepChecksum, "manifest-record-count-mismatch",
			"%s: %d records readable, manifest says %d", file.Path, len(records), file.Records))
	}
	return records, findings
}

// decodeEnvelope parses one record envelope and recomputes its semantic
// digest from the canonical bytes of its data (A1/tampered-digest case).
func decodeEnvelope(file snapshot.FileManifest, line []byte, number int, offset int64) (*artifactRecord, []finding) {
	var envelope snapshot.RecordEnvelope
	decoder := json.NewDecoder(bytes.NewReader(line))
	decoder.UseNumber()
	if err := decoder.Decode(&envelope); err != nil {
		return nil, []finding{fail(stepChecksum, "jsonl-parse-error",
			"%s line %d (byte offset %d): %v", file.Path, number, offset, err)}
	}
	var findings []finding
	if envelope.Domain != file.Domain {
		findings = append(findings, fail(stepChecksum, "record-domain-mismatch",
			"%s line %d: envelope domain %q does not match the file domain %q",
			file.Path, number, envelope.Domain, file.Domain))
	}
	if envelope.CanonicalizationVersion != snapshot.CanonicalizationVersion ||
		envelope.DigestAlgorithm != snapshot.DigestAlgorithmVersion {
		findings = append(findings, fail(stepChecksum, "digest-algorithm-drift",
			"%s line %d: canonicalization %q/%q is not %q/%q",
			file.Path, number, envelope.CanonicalizationVersion, envelope.DigestAlgorithm,
			snapshot.CanonicalizationVersion, snapshot.DigestAlgorithmVersion))
	}
	digest, err := snapshot.DigestCanonicalJSON(envelope.Data)
	if err != nil {
		return nil, append(findings, fail(stepChecksum, "jsonl-parse-error",
			"%s line %d (byte offset %d): canonicalize data: %v", file.Path, number, offset, err))
	}
	if digest != envelope.Digest {
		findings = append(findings, fail(stepChecksum, "record-digest-mismatch",
			"%s line %d: id %s carries digest %s but its data digests to %s",
			file.Path, number, string(envelope.ID), envelope.Digest, digest))
	}
	idKey, err := snapshot.CanonicalJSON(envelope.ID)
	if err != nil {
		return nil, append(findings, fail(stepChecksum, "jsonl-parse-error",
			"%s line %d: canonicalize id: %v", file.Path, number, err))
	}
	fields := map[string]any{}
	fieldDecoder := json.NewDecoder(bytes.NewReader(envelope.Data))
	fieldDecoder.UseNumber()
	if err := fieldDecoder.Decode(&fields); err != nil {
		return nil, append(findings, fail(stepChecksum, "jsonl-parse-error",
			"%s line %d: data is not a JSON object: %v", file.Path, number, err))
	}
	return &artifactRecord{Domain: file.Domain, IDKey: string(idKey), Digest: digest,
		Data: envelope.Data, Fields: fields, Line: number, Offset: offset}, findings
}

// verifyVerificationDigests proves verification.json agrees with the JSONL
// files it claims to describe, in both directions.
func verifyVerificationDigests(loaded *artifact) []finding {
	var findings []finding
	if loaded.Verification.RecordCounts == nil {
		return append(findings, fail(stepChecksum, "verification-incomplete",
			"verification.json carries no record counts"))
	}
	for domain, records := range loaded.Records {
		declared, present := loaded.Verification.RecordCounts[domain]
		if !present {
			findings = append(findings, fail(stepChecksum, "verification-count-mismatch",
				"verification.json has no record count for domain %s", domain))
			continue
		}
		if declared != int64(len(records)) {
			findings = append(findings, fail(stepChecksum, "verification-count-mismatch",
				"domain %s: %d records on disk, verification says %d", domain, len(records), declared))
		}
	}
	for domain := range loaded.Verification.RecordCounts {
		if _, present := loaded.Records[domain]; !present {
			findings = append(findings, fail(stepChecksum, "verification-count-mismatch",
				"verification.json names domain %s, which the manifest does not include", domain))
		}
	}
	seen := make(map[string]map[string]bool, len(loaded.ByID))
	for _, digest := range loaded.Verification.RecordDigests {
		idKey, err := snapshot.CanonicalJSON(digest.ID)
		if err != nil {
			findings = append(findings, fail(stepChecksum, "verification-incomplete",
				"verification digest for %s carries an unreadable id: %v", digest.Domain, err))
			continue
		}
		record, present := loaded.ByID[digest.Domain][string(idKey)]
		if !present {
			findings = append(findings, fail(stepChecksum, "verification-digest-missing",
				"verification names %s %s, which is not in the domain file", digest.Domain, idKey))
			continue
		}
		if record.Digest != digest.Digest {
			findings = append(findings, fail(stepChecksum, "record-digest-mismatch",
				"%s %s: verification digest %s, recomputed %s",
				digest.Domain, idKey, digest.Digest, record.Digest))
		}
		if seen[digest.Domain] == nil {
			seen[digest.Domain] = map[string]bool{}
		}
		seen[digest.Domain][string(idKey)] = true
	}
	for domain, index := range loaded.ByID {
		for idKey := range index {
			if !seen[domain][idKey] {
				findings = append(findings, fail(stepChecksum, "verification-digest-missing",
					"%s %s is in the domain file but has no verification digest", domain, idKey))
			}
		}
	}
	return findings
}

// referencePredicate recovers the discriminator the exporter folded into a
// semantic check's name. The ReferenceCheck struct carries no predicate
// field, but the polymorphic checks are only meaningful with one: without it
// every hive-owned photo would read as a dangling apiary reference.
func referencePredicate(check snapshot.ReferenceCheck) (string, string, bool) {
	ownerPrefix := check.FromDomain + "_owner_"
	if strings.HasPrefix(check.Name, ownerPrefix) {
		return "owner_type", strings.TrimPrefix(check.Name, ownerPrefix), true
	}
	const entityPrefix = "external_sync_entity_"
	if check.FromDomain == "external_sync" && strings.HasPrefix(check.Name, entityPrefix) {
		return "entity_type", strings.TrimPrefix(check.Name, entityPrefix), true
	}
	return "", "", false
}

// verifyReferences resolves every declared relationship against the records
// actually present in the artifact, and cross-checks the counts the exporter
// declared. It does not take verification.json's word for danglingCount: an
// artifact that lies about its own graph is exactly the case this pass is
// for (design section 3.2, adversarial case A3).
func verifyReferences(loaded *artifact) []finding {
	var findings []finding
	for _, check := range loaded.Verification.ReferenceChecks {
		if len(check.FromFields) == 0 || len(check.FromFields) != len(check.ToFields) {
			findings = append(findings, fail(stepChecksum, "verification-incomplete",
				"reference %s declares %d source fields and %d target fields",
				check.Name, len(check.FromFields), len(check.ToFields)))
			continue
		}
		from, hasFrom := loaded.Records[check.FromDomain]
		if !hasFrom {
			findings = append(findings, fail(stepChecksum, "verification-incomplete",
				"reference %s names source domain %s, which is not in the artifact",
				check.Name, check.FromDomain))
			continue
		}
		target, hasTarget := loaded.Records[check.ToDomain]
		if !hasTarget {
			findings = append(findings, fail(stepChecksum, "verification-incomplete",
				"reference %s names target domain %s, which is not in the artifact",
				check.Name, check.ToDomain))
			continue
		}
		index := make(map[string]bool, len(target))
		for _, record := range target {
			key, ok := tupleKey(record.Fields, check.ToFields)
			if ok {
				index[key] = true
			}
		}
		predicateField, predicateValue, hasPredicate := referencePredicate(check)
		var populated, resolved int64
		for _, record := range from {
			if hasPredicate {
				value, _ := record.Fields[predicateField].(string)
				if value != predicateValue {
					continue
				}
			}
			key, ok := tupleKey(record.Fields, check.FromFields)
			if !ok {
				continue
			}
			populated++
			if index[key] {
				resolved++
				continue
			}
			findings = append(findings, fail(stepChecksum, "dangling-reference",
				"%s: %s %s field(s) %s = %s does not resolve to %s %s",
				check.Name, check.FromDomain, record.IDKey,
				strings.Join(check.FromFields, ","), key,
				check.ToDomain, strings.Join(check.ToFields, ",")))
		}
		if populated != check.PopulatedCount || resolved != check.ResolvedCount ||
			check.DanglingCount != check.PopulatedCount-check.ResolvedCount {
			findings = append(findings, fail(stepChecksum, "reference-count-mismatch",
				"%s: recomputed %d populated / %d resolved, verification declares %d / %d (dangling %d)",
				check.Name, populated, resolved,
				check.PopulatedCount, check.ResolvedCount, check.DanglingCount))
		}
	}
	return findings
}

// tupleKey builds the join key for one record, reporting false when any
// component is absent or null — a partially null foreign key is not a
// reference, it is the absence of one.
func tupleKey(fields map[string]any, names []string) (string, bool) {
	parts := make([]string, len(names))
	for index, name := range names {
		value, present := fields[name]
		if !present || value == nil {
			return "", false
		}
		encoded, err := json.Marshal(value)
		if err != nil {
			return "", false
		}
		parts[index] = string(encoded)
	}
	return strings.Join(parts, "\x1f"), true
}

// verifyMedia proves the media manifest covers every original the record
// files still point at, and that verification.json repeats the same states.
// Derived renditions are deliberately not gated: they are regenerable
// (format spec, design section 3.6).
func verifyMedia(loaded *artifact) []finding {
	var findings []finding
	if loaded.Manifest.MediaManifestVersion != snapshot.MediaManifestVersion {
		findings = append(findings, fail(stepChecksum, "unsupported-format-version",
			"media manifest version %d is not supported (this gate reads %d)",
			loaded.Manifest.MediaManifestVersion, snapshot.MediaManifestVersion))
	}
	byOwner := make(map[string]snapshot.MediaObject, len(loaded.Media.Objects))
	for _, object := range loaded.Media.Objects {
		byOwner[object.RecordDomain+"\x1f"+object.RecordID] = object
	}
	// Every photo original and every audio original is inside the
	// restoration boundary and must be described.
	required := []struct{ domain, field string }{
		{"photos", "original_ref"},
		{"media_files", "audio_key"},
	}
	for _, want := range required {
		for _, record := range loaded.Records[want.domain] {
			reference, _ := record.Fields[want.field].(string)
			if strings.TrimSpace(reference) == "" {
				continue
			}
			id, _ := record.Fields["id"].(string)
			object, present := byOwner[want.domain+"\x1f"+id]
			if !present {
				findings = append(findings, fail(stepChecksum, "missing-required-media",
					"%s %s references original %q with no entry in media-manifest.json",
					want.domain, id, reference))
				continue
			}
			if object.Reference != reference {
				findings = append(findings, fail(stepChecksum, "missing-required-media",
					"%s %s references original %q but the media manifest names %q",
					want.domain, id, reference, object.Reference))
			}
			if object.Required && object.HashState == "missing-or-unreadable" &&
				strings.TrimSpace(object.OmissionReason) == "" {
				findings = append(findings, fail(stepChecksum, "missing-required-media",
					"%s %s original %q is unreadable and carries no classified omission reason",
					want.domain, id, reference))
			}
		}
	}
	verified := make(map[string]snapshot.MediaVerification, len(loaded.Verification.Media))
	for _, item := range loaded.Verification.Media {
		verified[item.RecordDomain+"\x1f"+item.RecordID] = item
	}
	for key, object := range byOwner {
		item, present := verified[key]
		if !present {
			findings = append(findings, fail(stepChecksum, "media-verification-missing",
				"media manifest lists %s %s, which verification.json does not",
				object.RecordDomain, object.RecordID))
			continue
		}
		if item.HashState != object.HashState || item.SHA256 != object.SHA256 ||
			item.Reference != object.Reference {
			findings = append(findings, fail(stepChecksum, "media-verification-mismatch",
				"%s %s: media manifest says %s/%s/%s, verification says %s/%s/%s",
				object.RecordDomain, object.RecordID, object.Reference, object.HashState, object.SHA256,
				item.Reference, item.HashState, item.SHA256))
		}
	}
	return findings
}

// wrappingChecksum is the artifact-wide checksum of design step 2. It covers
// every file in the artifact by path and content hash, so adding, removing,
// or editing any file changes it. It is written beside the artifact — never
// inside it, and never beside decryption credentials.
func wrappingChecksum(loaded *artifact) (string, error) {
	var paths []string
	err := filepath.WalkDir(loaded.Dir, func(path string, entry os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if entry.IsDir() {
			return nil
		}
		relative, err := filepath.Rel(loaded.Dir, path)
		if err != nil {
			return err
		}
		paths = append(paths, filepath.ToSlash(relative))
		return nil
	})
	if err != nil {
		return "", err
	}
	sort.Strings(paths)
	var buffer bytes.Buffer
	for _, relative := range paths {
		content, err := os.ReadFile(filepath.Join(loaded.Dir, filepath.FromSlash(relative)))
		if err != nil {
			return "", err
		}
		fmt.Fprintf(&buffer, "%s %s\n", snapshot.SHA256Hex(content), relative)
	}
	return snapshot.SHA256Hex(buffer.Bytes()), nil
}
