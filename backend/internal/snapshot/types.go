package snapshot

import (
	"encoding/json"
	"time"
)

const (
	FormatVersion         = 1
	VerificationVersion   = 1
	MediaManifestVersion  = 1
	ExporterVersion       = "snapshot-export-v1"
	LegacyAggregateFamily = "legacy-v1-migrations-00001-00048"
	NewAggregateFamily    = "new-ledger-v1-reserved"
)

type RecordEnvelope struct {
	Domain                  string          `json:"domain"`
	ID                      json.RawMessage `json:"id"`
	CanonicalizationVersion string          `json:"canonicalizationVersion"`
	DigestAlgorithm         string          `json:"digestAlgorithm"`
	Digest                  string          `json:"digest"`
	Data                    json.RawMessage `json:"data"`
}

type FileManifest struct {
	Domain    string `json:"domain,omitempty"`
	Path      string `json:"path"`
	Records   int64  `json:"records"`
	Bytes     int64  `json:"bytes"`
	SHA256    string `json:"sha256"`
	MediaKind string `json:"mediaKind,omitempty"`
}

type CanonicalDeclarations struct {
	JSON                string            `json:"json"`
	Encoding            string            `json:"encoding"`
	LineEnding          string            `json:"lineEnding"`
	Timestamps          string            `json:"timestamps"`
	BusinessTimezone    string            `json:"businessTimezone"`
	Units               map[string]string `json:"units"`
	Money               string            `json:"money"`
	DigestAlgorithm     string            `json:"digestAlgorithm"`
	RecordEnvelope      string            `json:"recordEnvelope"`
	ExternalIdempotency string            `json:"externalIdempotency"`
	TreatmentReconcile  string            `json:"treatmentReconciliation"`
}

type OmittedDomain struct {
	Domain string `json:"domain"`
	Reason string `json:"reason"`
}

type ExcludedConfiguration struct {
	Domain string   `json:"domain"`
	Keys   []string `json:"keys"`
	Reason string   `json:"reason"`
}

type Manifest struct {
	FormatVersion         int                     `json:"formatVersion"`
	ExportedAt            time.Time               `json:"exportedAt"`
	AppCommit             string                  `json:"appCommit"`
	SchemaMigration       int64                   `json:"schemaMigration"`
	ExporterVersion       string                  `json:"exporterVersion"`
	Files                 []FileManifest          `json:"files"`
	Canonical             CanonicalDeclarations   `json:"canonical"`
	OmittedDomains        []OmittedDomain         `json:"omittedDomains"`
	ExcludedConfiguration []ExcludedConfiguration `json:"excludedConfiguration"`
	MediaManifestVersion  int                     `json:"mediaManifestVersion"`
	MediaManifest         FileManifest            `json:"mediaManifest"`
	Verification          FileManifest            `json:"verification"`
}

type RecordDigest struct {
	Domain                  string          `json:"domain"`
	ID                      json.RawMessage `json:"id"`
	CanonicalizationVersion string          `json:"canonicalizationVersion"`
	DigestAlgorithm         string          `json:"digestAlgorithm"`
	Digest                  string          `json:"digest"`
}

type ReferenceCheck struct {
	Name           string   `json:"name"`
	FromDomain     string   `json:"fromDomain"`
	FromFields     []string `json:"fromFields"`
	ToDomain       string   `json:"toDomain"`
	ToFields       []string `json:"toFields"`
	Required       bool     `json:"required"`
	PopulatedCount int64    `json:"populatedCount"`
	ResolvedCount  int64    `json:"resolvedCount"`
	DanglingCount  int64    `json:"danglingCount"`
}

type AggregateDefinition struct {
	Name           string          `json:"name"`
	Version        string          `json:"version"`
	Description    string          `json:"description"`
	Statuses       []string        `json:"statuses"`
	Dimensions     []string        `json:"dimensions"`
	Unit           string          `json:"unit"`
	Currency       string          `json:"currency,omitempty"`
	Rounding       string          `json:"rounding"`
	SignConvention string          `json:"signConvention"`
	QueryVersion   string          `json:"queryVersion"`
	Value          json.RawMessage `json:"value"`
}

type AggregateFamily struct {
	Label       string                `json:"label"`
	Version     string                `json:"version"`
	Definitions []AggregateDefinition `json:"definitions"`
	Mapping     []AggregateMapping    `json:"mapping"`
}

type AggregateMapping struct {
	LegacyName    string `json:"legacyName"`
	NewLedgerName string `json:"newLedgerName"`
	Transform     string `json:"transform"`
	TransformVer  string `json:"transformVersion"`
}

type MediaVerification struct {
	RecordDomain string `json:"recordDomain"`
	RecordID     string `json:"recordId"`
	OwnerDomain  string `json:"ownerDomain"`
	OwnerID      string `json:"ownerId"`
	Reference    string `json:"reference"`
	HashState    string `json:"hashState"`
	SHA256       string `json:"sha256,omitempty"`
	Bytes        int64  `json:"bytes,omitempty"`
}

type Verification struct {
	Version                 int                        `json:"version"`
	FormatVersion           int                        `json:"formatVersion"`
	GeneratedAt             time.Time                  `json:"generatedAt"`
	CanonicalizationVersion string                     `json:"canonicalizationVersion"`
	DigestAlgorithm         string                     `json:"digestAlgorithm"`
	RecordCounts            map[string]int64           `json:"recordCounts"`
	RecordDigests           []RecordDigest             `json:"recordDigests"`
	ReferenceChecks         []ReferenceCheck           `json:"referenceChecks"`
	AggregateFamilies       map[string]AggregateFamily `json:"aggregateFamilies"`
	Media                   []MediaVerification        `json:"media"`
}

type MediaObject struct {
	RecordDomain      string   `json:"recordDomain"`
	RecordID          string   `json:"recordId"`
	OwnerDomain       string   `json:"ownerDomain"`
	OwnerID           string   `json:"ownerId"`
	MediaType         string   `json:"mediaType"`
	OriginalFilename  string   `json:"originalFilename"`
	Role              string   `json:"role"`
	StorageBackend    string   `json:"storageBackend"`
	Disposition       string   `json:"disposition"`
	Reference         string   `json:"reference"`
	Required          bool     `json:"required"`
	HashState         string   `json:"hashState"`
	Bytes             int64    `json:"bytes,omitempty"`
	SHA256            string   `json:"sha256,omitempty"`
	DerivedRenditions []string `json:"derivedRenditions,omitempty"`
	OmissionReason    string   `json:"omissionReason,omitempty"`
}

type MediaManifest struct {
	Version int           `json:"version"`
	Objects []MediaObject `json:"objects"`
}
