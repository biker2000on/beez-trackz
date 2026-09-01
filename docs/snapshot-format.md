# Beez Trackz portable snapshot format

## Status and compatibility

This document defines `formatVersion: 1`. The snapshot format is versioned independently of Postgres migrations. An importer must select an explicit format-version decoder and transforms; it must not infer a source table layout from `appCommit` or `schemaMigration`.

Version 1 is a directory artifact. It may be transported in an encrypted archive, provided extraction reproduces the exact file bytes and paths. The artifact contains customer, financial, transcript, sync, and media metadata and must be encrypted at rest and in transit, limited to restore operators, retained only under the backup policy, and securely disposed when superseded. Encryption credentials are never stored beside the checksums.

## Layout

```text
snapshot/
  manifest.json
  verification.json
  media-manifest.json
  domains/
    apiaries.jsonl
    ...one UTF-8 JSON Lines file for every registered domain...
```

Files use UTF-8 without a BOM and LF line endings. JSONL files end every record, including the last, with LF. Empty domains are represented by an empty file, not an omitted file. `manifest.json` is written last. Its own hash is intentionally not recursive; all other canonical artifact files are linked from it by SHA-256.

## `manifest.json`

The manifest has these required fields:

- `formatVersion`: integer `1`.
- `exportedAt`: RFC 3339 UTC export timestamp.
- `appCommit`: Beez Trackz application commit.
- `schemaMigration`: highest applied Goose migration version (currently expected to be 48).
- `exporterVersion`: version of the exporter implementation.
- `files`: one entry per domain file, each with `domain`, relative `path`, `records`, exact `bytes`, and lowercase hexadecimal `sha256`. The hash covers the complete JSONL bytes, including LF.
- `canonical`: the canonical JSON/digest version, UTF-8 and line-ending declarations, UTC and named-business-timezone rules, canonical units, money representation, record-envelope rule, external-sync idempotency derivation, and the migration-00034 treatment reconciliation rule.
- `omittedDomains`: explicit `{domain, reason}` declarations. Version 1 declares API tokens, OIDC identities, notification dispatch attempts, session state, nonexistent payments, nonexistent durable sync tombstones, and nonexistent stored external-write idempotency keys.
- `excludedConfiguration`: domain/key lists and operator-facing reasons for configuration that must be supplied again.
- `mediaManifestVersion` and `mediaManifest`: the version plus path/bytes/SHA-256 of `media-manifest.json`.
- `verification`: the path/bytes/SHA-256 of `verification.json`.

Canonical units are pounds for honey mass, grams for propolis mass, meters for elevation, degrees Celsius for canonical temperature, and integers for discrete counts. Money is stored as integer minor units (cents) with one artifact-level ISO 4217 currency declaration. A domain field that declares its own canonical unit remains authoritative. Locale-formatted numbers and ambiguous formatted quantities are forbidden.

All `timestamptz` values are normalized to RFC 3339 UTC with `Z`. Date-only business fields remain `YYYY-MM-DD`; their interpretation uses `canonical.businessTimezone`, which is a named IANA timezone (not a numeric offset). Time-of-day values without an offset are forbidden in portable records.

## Domain registry

Domain names are portable concepts. The format-v1 exporter reads the similarly named live table, but an importer restores through domain services and does not replay table SQL. Preserved soft deletions, voids, reversals, audit actors, timestamps, UUIDs, and composite IDs are semantic data.

Version 1 exports every domain below:

- Identity/configuration: `app_users` (without login subject or password hash), `user_settings` (safe display/unit/threshold/AI task and non-secret endpoint configuration), `apiary_memberships`, and `offline_mutation_receipts` (owned retry/idempotency audit history).
- Apiary and colony: `apiaries` (including canonicalized `canvas_layout`), `hives`, `hive_location_history`, `hive_splits`, `queens`, and `queen_events`.
- Inspection and health: `inspections` (including strength-score fields and canonicalized `pests`, `treatments`, `source_media`, and `weather_snapshot`), `feedings`, `feeding_status_backfills`, `mite_counts`, `treatment_events`, and `treatment_products`.
- Harvest and honey provenance: `harvest_sessions`, `harvest_session_true_ups`, `honey_harvests`, `harvest_lots` (including canonicalized `testing_data`), `harvest_lot_harvests`, `harvest_lot_photos`, `honey_varietals`, and `honey_movements`.
- Bottling and product production: `jar_sizes`, `bottling_runs`, `jar_serials`, `product_catalog`, `propolis_harvests`, `product_batches`, `product_batch_expenses`, and `product_adjustments`.
- Commerce and location stock: `customers`, `wholesale_price_lists`, `wholesale_price_list_items`, `sales` (including invoiced/paid/collected status columns), `sale_items`, `stock_locations`, `stock_movements`, and `consignment_settlements` (including amount owed/paid and commission columns). There is deliberately no payments domain.
- Equipment and packaging: `equipment_types`, `equipment_type_components`, `equipment_stock`, `equipment_stock_adjustments`, `equipment_deployments`, `equipment_deployment_returns`, and `equipment_state_changes`. Packaging added by 00048 is catalogued as equipment category `packaging` and therefore travels through the same records.
- Field objects: `catch_boxes`, `colony_intakes`, `field_incidents`, and `deadout_autopsies`. Standard strength scores are fields on `inspections`, not a phantom table.
- Place/flow: `bloom_observations`, `yard_scales`, `scale_readings`, `apiary_weather_cache` (canonicalized `forecast`), `immich_timeline_scans`, and `immich_timeline_candidates`.
- Media and derived text: `photos` (canonicalized `tags`), `media_files`, and `transcript_versions`.
- Work intelligence: `yard_labor_sessions` and `ai_recommendations`.
- Safe accounting replay state: `external_sync` (including canonicalized account/category/tax mappings, conflict projection, per-record `last_synced_at` success timestamp, `content_hash`, `remote_transaction_guid`, and `remote_enter_date`) and `gnucash_sync_settings` (base URL, expected book identity/currency, cursor, sync-enabled state, canonicalized account mapping, and singleton `last_attempt_at`; the misleading source column `last_synced_at` is renamed because it is written on attempts, including failed pulls; never the API token).

Treatments have three authoritative stores: `treatment_events`, `inspections.treatments`, and `treatment_products`. All three are exported. `canonical.treatmentReconciliation` names `migration-00034-v1`: when inspection treatment JSON is edited, linked treatment events are reconciled by `inspection_id`. Import and verification must preserve the three stores and this provenance rule; one store must not be synthesized by dropping another.

## JSONL record envelope

Each line is one canonical JSON object:

```json
{
  "canonicalizationVersion": "beez-canonical-json-v1",
  "data": {"...": "all normalized non-secret semantic fields"},
  "digest": "lowercase SHA-256 hex",
  "digestAlgorithm": "sha256-beez-canonical-json-v1",
  "domain": "apiaries",
  "id": "preserved UUID, boolean singleton ID, or canonical object for a composite key"
}
```

`id` is the single primary stable key value when the domain has one. Composite keys use an object keyed by component field name. Record order is ascending primary-key order. Array order remains semantic and is preserved.

The per-record digest is:

```text
hex_lower(SHA-256(canonical_json(envelope.data)))
```

It does not cover envelope metadata. This allows a verifier to index by `(domain,id)`, recompute the semantic digest, and detect missing, additional, or changed records independently of file order. The algorithm/version string is mandatory in both each envelope and `verification.json`.

## Canonical JSON version 1

`beez-canonical-json-v1` applies to every record, manifest/report structure, aggregate value, and nested JSON/jsonb value. In particular it applies to the jsonb fields named in the registry, all external/GnuCash mapping objects, and the safe remainder of `user_settings.ai_provider_config`.

Rules:

1. Object keys are sorted lexicographically by their UTF-8 key bytes. Arrays retain input order. No insignificant whitespace is emitted.
2. Strings use JSON escaping for control characters, quote, and backslash. UTF-8 text is emitted without HTML escaping. Unicode is not normalized; stored Unicode scalar sequences are semantic.
3. `null`, `true`, and `false` use their lowercase JSON spellings.
4. Numbers are exact finite base-10 JSON numbers. Exponents are expanded to fixed decimal notation, insignificant integer leading zeros and fractional trailing zeros are removed, an empty integer part becomes `0`, and every negative-zero representation becomes `0`. No exponent, plus sign, `NaN`, or infinity is allowed. Thus `1`, `1.0`, `1.000e0`, and `0.10e1` canonicalize to `1`; `1.2300e-2` canonicalizes to `0.0123`. This fixed-number rule is required because Postgres `jsonb` normalizes numeric literals and does not preserve input key order.
5. Database `timestamptz` fields are converted to UTC before canonicalization. Date-only values are not converted.

The digest algorithm identifier `sha256-beez-canonical-json-v1` means SHA-256 over exactly those canonical UTF-8 bytes.

## Media manifest and hash gate

`media-manifest.json` has `version: 1` and an `objects` array. Each entry names the domain owner and stable owner ID, media type, original filename, role, storage backend, disposition (`external-reference` or `external-original-reference` in Wave 1), resolvable reference, required flag, hash state, optional bytes/SHA-256, derived rendition keys, and any omission reason.

The restoration boundary includes originals: photo `original_key`/`original_ref`, audio `audio_key`, and Immich `original_external` references. (Apiary satellite overlays were dropped by migration 00032 — Leaflet tiles replaced them — and are deliberately not part of the boundary.) Thumbnail and medium keys are listed only under `derivedRenditions`; they are regenerable and excluded from every content-hash gate. With MinIO hashing disabled, MinIO originals explicitly say `unhashed`. With it enabled they say `verified` with bytes/hash, or `missing-or-unreadable` with a reason. Immich originals say `external-unverified` until a resolver proves them. A required original that is missing or unresolved fails the destructive-reset gate unless that individual owner/reference omission is classified, accepted by an operator, and recorded in a later gate report.

## Security exclusions

Version 1 never exports `password_hash`, `user_settings.ntfy_access_token`, rows from `api_tokens`, rows from `oidc_identities`, `gnucash_sync_settings.api_token`, or the credential keys `user_settings.ai_provider_config.apiKeys.anthropic` and `.google`. The safe AI keys `ollamaUrl` and `whisperUrl` remain. `app_users.auth_subject` is also excluded because login/OIDC identities must be re-established. Session state, runtime encryption keys, and environment credentials are never read by the exporter.

Secret filtering is column-specific or key-path-specific and occurs before canonical record digesting. `manifest.excludedConfiguration` is the restore operator's reconfiguration checklist.

## `verification.json`

The version-1 verification file contains:

- `version`, `formatVersion`, `generatedAt`, `canonicalizationVersion`, and `digestAlgorithm`;
- `recordCounts` by every registered domain;
- `recordDigests`, each with domain, preserved ID, algorithm versions, and semantic digest;
- `referenceChecks`, naming both domains/field sets, whether the relationship is required, and populated/resolved/dangling counts. These cover declared FKs plus non-FK transcript pointers and polymorphic media owners and `external_sync.entity_id` projections;
- `media`, carrying original reference hash/resolution states;
- `aggregateFamilies`, with the two required, distinctly labelled families below.

Every aggregate definition contains `name`, independent `version`, description/formula, included statuses, dimensions, unit, optional currency, rounding rule, sign convention, query/exporter version, and canonical value. Equal numbers under unequal definition versions are not considered equal.

### Legacy definitions

The `legacy` family is labelled `legacy definitions`, version `legacy-v1-migrations-00001-00048`, and is computed from the current code/schema. Its definitions are:

- global bulk honey (session true-up fallback and live harvest filters; jarring/bulk-use/loss movement signs);
- per-lot balances from `honey_lot_balances` and per-varietal balances from `honey_varietal_balances`;
- the unmaterialized unassigned-bulk residual from the 00047 formula;
- the mutable lot bottling ceiling and its manual/derived source input;
- finished jar inventory using jarring + adjustment - non-cancelled sold - give-away;
- catalog SKU inventory using non-voided batches + live adjustments - non-cancelled sold;
- raw propolis grams using exactly `28.349523125` grams/ounce, live harvests, live tincture consumption, and propolis sale net weights;
- away-location finished-goods sums, plus separate home jar and home product residuals;
- `equipment_stock_status`, trigger-backed equipment reconciliation, mutable condition columns, packaging-as-equipment, and BOM/component availability;
- sales and expense financial totals by currency/status/category, and live production batch totals.

These values verify a restore into the legacy schema. They are not promoted to permanent inventory truths.

### New-ledger definitions and mapping

The `newLedger` family is labelled `new-ledger definitions`, version `new-ledger-v1-reserved`. Wave 1 declares the target definition—signed immutable movement sums by item × location × lot × condition—and leaves its value `null` because the new schema does not yet exist. Wave 2/new-ledger export fills it without changing format version 1 semantics.

Its mapping explicitly declares `legacy-residual-split-v1`: the unassigned bulk residual becomes a classified opening balance in an unassigned virtual lot/location, and the home jar/product residuals become per-item opening balances at home. A matching declared split is an explained cross-family difference; any other difference fails verification.

## Round-trip gate design

Before a destructive reset:

1. Export a snapshot under a repeatable-read, read-only transaction and verify every manifest/file/media hash available at export time.
2. Run the Wave-2 importer dry run. It must validate format support, canonical bytes, file hashes, record digests, units, IDs, references, secret omissions, media state, and dependency/post-pass requirements without writing.
3. Restore into a disposable empty database through the privileged application restore layer, then repeat the identical import to prove identical records are no-ops and conflicting preserved IDs are explicit errors.
4. Export the disposable database again. Compare the complete `(domain,id,digest)` sets, record counts, all required reference checks, media hashes/resolvable references, financial and production totals, and the aggregate family appropriate to the target schema. Aggregate equality never substitutes for record equality.
5. For a legacy target, compare legacy definitions. For a new-ledger target, compare new-ledger definitions after applying only the declared residual-opening transforms. Missing, additional, dangling, digest-mismatched, unexplained aggregate, missing-required-media, or incompatible records fail.
6. Keep GnuCash sync disabled. After guarded credential/book identity restoration, entity re-keying, and content-hash rebaseline, require pull-first reconciliation and a no-write push plan before enabling sync.
7. Retain the validated artifact and gate report outside the database being replaced. If source data changes, take a fresh snapshot and repeat the gate.

The importer and executable round-trip driver are Wave 2 and are intentionally outside this implementation.
