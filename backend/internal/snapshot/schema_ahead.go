package snapshot

import (
	"bytes"
	"encoding/json"
	"fmt"
	"sort"
)

const (
	InventoryLocationsConsigneeAttrsTransform = "inventory-locations-consignee-attrs-v1"
	UserPreferencesTransform                  = "user-preferences-v1"
	HarvestLotVarietalNameTransform           = "harvest-lot-varietal-name-v1"
	HarvestLotPulledOnTransform               = "harvest-lot-pulled-on-v1"
)

// PostArtifactMigration is the format-v1 declaration for a schema migration
// that can be newer than an artifact. BaselineMigration records the equivalent
// post-reset migration; zero means the change was folded into baseline 00001.
// Empty entries are intentional: they prove that a migration was reviewed and
// did not change exported record shapes.
type PostArtifactMigration struct {
	LegacyMigration   int64
	BaselineMigration int64
	Name              string
	AddedColumns      map[string][]string
	RemovedColumns    map[string][]string
	NewDomains        []NewDomainMigration
	// RemovedReferenceChecks affect verification metadata only. Dropping a
	// foreign key never transforms record data.
	RemovedReferenceChecks []string
	// AddedReferenceChecks likewise: a foreign key the migration creates
	// shows up in the re-export of an older artifact as a new check.
	AddedReferenceChecks []string
}

// NewDomainMigration declares either an empty newly-created domain or a
// deterministic cross-domain derivation. GeneratedColumns are supplied by the
// target database and are checked for presence, but not against a source value.
type NewDomainMigration struct {
	Domain           string
	KeyField         string
	ForEachDomain    string
	ForEachKeyField  string
	ValuesFromDomain string
	CopiedColumns    []string
	GeneratedColumns []string
	ExpectedEmpty    bool
}

// PostArtifactMigrations is the single ordered declaration of portable
// record-shape effects after the last pre-ledger format-v1 migration.
var PostArtifactMigrations = []PostArtifactMigration{
	{
		LegacyMigration: 50, Name: PreLedgerTransform,
		AddedColumns: map[string][]string{
			"equipment_types": {"first_deployed_year", "item_id", "needed_quantity", "storage_location", "unit_cost_cents"},
			"harvest_lots":    {"inventory_lot_id"},
			"jar_sizes":       {"item_id"},
			"product_batches": {"inventory_lot_id"},
			"product_catalog": {"item_id"},
			"sale_items":      {"inventory_lot_id", "item_id"},
		},
		NewDomains: emptyNewDomains(
			"inventory_item_kinds", "inventory_location_kinds", "inventory_operation_kinds",
			"inventory_conditions", "inventory_operation_reasons", "inventory_items",
			"inventory_locations", "inventory_lots", "inventory_operations",
			"inventory_movements", "inventory_boms", "inventory_bom_lines",
			"inventory_balance_checkpoints",
		),
	},
	{LegacyMigration: 51, Name: "schema-generation-v1"},
	{LegacyMigration: 52, Name: "sale-items-item-target-v1"},
	{LegacyMigration: 53, Name: "reservations-in-item-units-v1"},
	{LegacyMigration: 54, Name: "inventory-bom-cycle-guard-v1"},
	{LegacyMigration: 55, BaselineMigration: 2, Name: "domain-events-outbox-v1"},
	{
		LegacyMigration: 56, BaselineMigration: 3,
		Name: InventoryLocationsConsigneeAttrsTransform,
		AddedColumns: map[string][]string{
			"inventory_locations": {"address", "customer_id", "deleted_at", "notes", "slug"},
		},
		RemovedReferenceChecks: []string{
			"consignment_settlements_location_id_fkey",
			"external_sync_location_id_fkey",
			"sales_stock_location_id_fkey",
		},
		AddedReferenceChecks: []string{"inventory_locations_customer_id_fkey"},
	},
	{
		LegacyMigration: 57, BaselineMigration: 4,
		Name: UserPreferencesTransform,
		RemovedColumns: map[string][]string{
			"user_settings": {"date_format", "default_apiary_id", "temperature_unit", "theme", "units", "weight_unit"},
		},
		// default_apiary_id moved with its FOREIGN KEY; the reference check
		// disappears from the re-export of an older artifact.
		RemovedReferenceChecks: []string{"user_settings_default_apiary_id_fkey"},
		AddedReferenceChecks:   []string{"user_preferences_user_id_fkey", "user_preferences_default_apiary_id_fkey"},
		NewDomains: []NewDomainMigration{{
			Domain: "user_preferences", KeyField: "user_id",
			ForEachDomain: "app_users", ForEachKeyField: "id",
			ValuesFromDomain: "user_settings",
			CopiedColumns: []string{
				"theme", "default_apiary_id", "date_format", "weight_unit", "units", "temperature_unit",
			},
			GeneratedColumns: []string{"created_at", "updated_at"},
		}},
	},
	{
		LegacyMigration: 58, BaselineMigration: 5,
		Name: HarvestLotVarietalNameTransform,
		// The free-text name is gone; the varietal (varietal_id, already a
		// portable column) is the lot's only name. The migration's backfill
		// runs on the target database before an older artifact is restored,
		// so a restored lot carries only its varietal_id: a pre-00058 lot
		// whose honey_variety text named no varietal restores unnamed.
		RemovedColumns: map[string][]string{
			"harvest_lots": {"honey_variety"},
		},
	},
	{
		LegacyMigration: 59, BaselineMigration: 6,
		Name: HarvestLotPulledOnTransform,
		// The day the frames were pulled, nullable. An older artifact's lot
		// restores with pulled_on NULL; nothing is derived for it.
		AddedColumns: map[string][]string{
			"harvest_lots": {"pulled_on"},
		},
	},
}

// maxBaselineMigration is the newest post-reset baseline migration declared
// above; baseline artifact versions up to it map onto legacy ceilings.
func maxBaselineMigration() int64 {
	ceiling := int64(0)
	for _, migration := range PostArtifactMigrations {
		if migration.BaselineMigration > ceiling {
			ceiling = migration.BaselineMigration
		}
	}
	return ceiling
}

func emptyNewDomains(names ...string) []NewDomainMigration {
	out := make([]NewDomainMigration, len(names))
	for index, name := range names {
		out[index] = NewDomainMigration{Domain: name, ExpectedEmpty: true}
	}
	return out
}

// EffectiveLegacyMigration maps a post-reset baseline artifact onto the
// equivalent legacy-chain ceiling. The presence of a ledger domain
// distinguishes baseline versions (1 through the newest declared baseline
// migration) from genuinely old legacy versions.
func EffectiveLegacyMigration(schemaMigration int64, hasLedgerDomain bool) int64 {
	if schemaMigration >= LedgerSchemaMigration || schemaMigration > maxBaselineMigration() || !hasLedgerDomain {
		return schemaMigration
	}
	ceiling := int64(0)
	for _, migration := range PostArtifactMigrations {
		if migration.BaselineMigration == 0 {
			if schemaMigration >= 1 && migration.LegacyMigration <= 54 {
				ceiling = migration.LegacyMigration
			}
			continue
		}
		if schemaMigration >= migration.BaselineMigration {
			ceiling = migration.LegacyMigration
		}
	}
	return ceiling
}

func DeclaredNewDomainAfter(schemaMigration int64, hasLedgerDomain bool, domain string) (PostArtifactMigration, NewDomainMigration, bool) {
	effective := EffectiveLegacyMigration(schemaMigration, hasLedgerDomain)
	for _, migration := range PostArtifactMigrations {
		if effective >= migration.LegacyMigration {
			continue
		}
		for _, added := range migration.NewDomains {
			if added.Domain == domain {
				return migration, added, true
			}
		}
	}
	return PostArtifactMigration{}, NewDomainMigration{}, false
}

type AppliedPostArtifactMigration struct {
	Migration int64
	Name      string
	Domains   []string
}

// ApplyPostArtifactMigrations prepares verified artifact records for a newer
// target. It never fabricates values for added nullable columns: omission lets
// the target apply NULL. Derivations run before removed source keys are cut.
func ApplyPostArtifactMigrations(artifact *Artifact) ([]AppliedPostArtifactMigration, error) {
	hasLedger := artifactHasLedgerDomain(artifact.Records)
	effective := EffectiveLegacyMigration(artifact.Manifest.SchemaMigration, hasLedger)
	var applied []AppliedPostArtifactMigration
	for _, migration := range PostArtifactMigrations {
		if effective >= migration.LegacyMigration {
			continue
		}
		changed := map[string]bool{}
		for domain, columns := range migration.AddedColumns {
			for _, record := range artifact.Records[domain] {
				fields, err := decodeRecordData(record.Data)
				if err != nil {
					return nil, fmt.Errorf("apply %s to %s: %w", migration.Name, domain, err)
				}
				for _, column := range columns {
					if _, present := fields[column]; !present {
						changed[domain] = true
					}
				}
			}
		}
		for _, declaration := range migration.NewDomains {
			before, present := artifact.Records[declaration.Domain]
			derived, err := deriveNewDomainRecords(artifact, declaration)
			if err != nil {
				return nil, fmt.Errorf("apply %s: %w", migration.Name, err)
			}
			if !present || len(derived) != len(before) {
				artifact.Records[declaration.Domain] = derived
				changed[declaration.Domain] = true
			}
		}
		for _, removed := range migration.RemovedReferenceChecks {
			for _, check := range artifact.Verification.ReferenceChecks {
				if check.Name == removed {
					changed[check.FromDomain] = true
				}
			}
		}
		for domain, columns := range migration.RemovedColumns {
			records := artifact.Records[domain]
			for index := range records {
				fields, err := decodeRecordData(records[index].Data)
				if err != nil {
					return nil, fmt.Errorf("apply %s to %s: %w", migration.Name, domain, err)
				}
				rewritten := false
				for _, column := range columns {
					if _, present := fields[column]; present {
						delete(fields, column)
						rewritten = true
					}
				}
				if rewritten {
					if err := rewriteEnvelopeData(&records[index], fields); err != nil {
						return nil, fmt.Errorf("apply %s to %s: %w", migration.Name, domain, err)
					}
					changed[domain] = true
				}
			}
			artifact.Records[domain] = records
		}
		if len(changed) > 0 {
			domains := make([]string, 0, len(changed))
			for domain := range changed {
				domains = append(domains, domain)
			}
			sort.Strings(domains)
			applied = append(applied, AppliedPostArtifactMigration{
				Migration: migration.LegacyMigration, Name: migration.Name, Domains: domains,
			})
		}
	}
	return applied, nil
}

func deriveNewDomainRecords(artifact *Artifact, declaration NewDomainMigration) ([]RecordEnvelope, error) {
	if declaration.ExpectedEmpty {
		if records, present := artifact.Records[declaration.Domain]; present {
			return records, nil
		}
		return []RecordEnvelope{}, nil
	}
	sources := artifact.Records[declaration.ValuesFromDomain]
	if len(sources) == 0 {
		return []RecordEnvelope{}, nil
	}
	if len(sources) != 1 {
		return nil, fmt.Errorf("%s derivation requires exactly one %s record, got %d", declaration.Domain, declaration.ValuesFromDomain, len(sources))
	}
	values, err := decodeRecordData(sources[0].Data)
	if err != nil {
		return nil, err
	}
	existing := map[string]bool{}
	for _, record := range artifact.Records[declaration.Domain] {
		id, err := CanonicalJSON(record.ID)
		if err != nil {
			return nil, err
		}
		existing[string(id)] = true
	}
	out := append([]RecordEnvelope(nil), artifact.Records[declaration.Domain]...)
	for _, owner := range artifact.Records[declaration.ForEachDomain] {
		ownerFields, err := decodeRecordData(owner.Data)
		if err != nil {
			return nil, err
		}
		key, present := ownerFields[declaration.ForEachKeyField]
		if !present {
			return nil, fmt.Errorf("%s record lacks %s", declaration.ForEachDomain, declaration.ForEachKeyField)
		}
		id, err := MarshalCanonical(key)
		if err != nil {
			return nil, err
		}
		if existing[string(id)] {
			continue
		}
		data := map[string]any{declaration.KeyField: key}
		for _, column := range declaration.CopiedColumns {
			data[column] = values[column]
		}
		envelope := RecordEnvelope{
			Domain: declaration.Domain, ID: id,
			CanonicalizationVersion: CanonicalizationVersion,
			DigestAlgorithm:         DigestAlgorithmVersion,
		}
		if err := rewriteEnvelopeData(&envelope, data); err != nil {
			return nil, err
		}
		out = append(out, envelope)
	}
	return out, nil
}

func decodeRecordData(raw json.RawMessage) (map[string]any, error) {
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	var fields map[string]any
	if err := decoder.Decode(&fields); err != nil {
		return nil, err
	}
	if fields == nil {
		return nil, fmt.Errorf("record data is not an object")
	}
	return fields, nil
}

func rewriteEnvelopeData(envelope *RecordEnvelope, fields map[string]any) error {
	data, err := MarshalCanonical(fields)
	if err != nil {
		return err
	}
	envelope.Data = data
	envelope.Digest = SHA256Hex(data)
	return nil
}

func artifactHasLedgerDomain(records map[string][]RecordEnvelope) bool {
	for _, domain := range LedgerDomains {
		if _, present := records[domain.Name]; present {
			return true
		}
	}
	return false
}
