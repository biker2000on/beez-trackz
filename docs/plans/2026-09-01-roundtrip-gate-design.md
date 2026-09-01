# P0 round-trip gate design

Date: 2026-09-01
Pinned commit for this worktree: `51dccb6df44021cba91108d6ae6f737b241e4dd3`
Schema ceiling: goose migration **00048** (`00048_packaging_inventory.sql`)

This is the Wave 1 design of the P0 round-trip gate. It does not implement the
importer or the driver that executes the runbook. Those are Wave 2.

Sources, all binding:

- `docs/product-roadmap.md` section **P0 — Portable snapshot and verified
  restore**, including every `Amended 2026-09-01` block, **Round-trip gate**,
  **Reset policy after the gate**, and **Acceptance criteria**.
- `polyagent-review-2026-09-01.md` blockers B1–B3 and the portable-snapshot
  gaps (jsonb canonicalization, originals vs renditions, no-FK pointers,
  import-time triggers, importer idempotency as a fourth contract).
- Live goose migrations under `backend/internal/db/migrations/` (00001–00048)
  and the Go formulas that currently compute inventory, money, and production
  totals. `docs/rewrite/db-schema.md` is stale (still names
  `satellite_image_key`, `honey_sales`, float dollars) and is not a source.

## 0. What this gate is, and what it is not

The gate is a **legacy-schema rehearsal**: export the current database,
restore it into a disposable empty database that has been migrated through
the same 00001–00048 chain, re-export, and prove record-level semantic
equality plus the named aggregates. Matching totals never substitute for
per-record digest equality.

It is **not** the later P1 clean-baseline restore. That later restore uses
the same artifact and the same driver, but compares against the
**new-ledger** family in `verification.json` and treats declared
residual-to-opening-balance splits as explained differences. Both families
are emitted at export time so the artifact survives the reset.

It is **not** a `pg_dump` / `cmd/migrate-legacy` copy.
`cmd/migrate-legacy` is a table copier that refuses a target with apiaries
and is explicitly out of the importer contract. Restoration after this gate
uses the canonical importer only.

GnuCash entity re-key and content-hash rebaseline (roadmap P0 amendment) are
**not** part of this same-schema rehearsal. Nine of seventeen
`external_sync.entity_type` values (00041) still name live rows. They only
dissolve when P1 replaces those tables. This gate proves the mappings and
cursor round-trip as records, with sync disabled. The re-key, rebaseline,
folio verify-by-external-ID dry run, and guarded credential install are
acceptance items that fire on the later new-schema restore; their contracts
are specified here so Wave 2 and the folio work do not invent a second gate.

---

## 1. Tooling map

Each runbook step names **what already exists**, **what Wave 1 of this
Polyagent run must land**, and **what Wave 2 must build**. Paths for Wave 1
siblings follow the assignment; if the format-spec worker picks a different
`cmd/` name, the driver calls that binary, not a second exporter.

| Piece | Status at `51dccb6` | Wave | Role in the gate |
|---|---|---|---|
| Goose migrations 00001–00048 via `db.Connect` | exists | — | Bring a throwaway database to the current schema. Workers use `ConnectWithoutMigrations`. |
| `TEST_DATABASE_URL` skip + `freshDatabase` (`backend/internal/db/money_migration_test.go`) | exists | — | Create/drop a sibling Postgres database. Never reuse the working `beeztrackz` volume. |
| `SET TIME ZONE 'UTC'` | exists in `cmd/migrate-legacy` only | Wave 1/2 must copy the pattern | Every export, import, and comparison session sets UTC. Process env is `TZ=UTC`. |
| Ledger formulas (`honey_ledger.go`, `productInventoryQuery`, `propolisOnHandGrams`, `honey_lot_balances` / `honey_varietal_balances` views, `equipment_stock_status`) | exists | Wave 1 emitter reuses them | Legacy aggregate family in `verification.json`. |
| `cmd/migrate-legacy` | exists | **must not run the gate** | Table copier; not domain-aware; copies `password_hash`. |
| Snapshot format spec + `backend/internal/snapshot` | absent | Wave 1 (sibling) | Canonical JSONL records, manifest, hashes, digest algorithm. |
| Export CLI | absent | Wave 1 (sibling), expected under `backend/cmd/` consuming `internal/snapshot` | Fresh snapshot + re-export after restore. |
| `verification.json` emitter | absent | Wave 1 (sibling), same package as export | Per-record digests, reference checks, both aggregate families, media hashes, calculation definitions. |
| `backend/internal/app/` restore foundation (UoW, restore repos, system-restore actor) | absent | Wave 1 (sibling) | Importer (Wave 2) sits on this; the gate does not call HTTP handlers. |
| GnuCash guarded restore command + server `SyncEnabled` refusal | absent; PUT currently clears `book_guid`/`changes_cursor` on token change (`routes_gnucash_sync.go`); `handleGnuCashSyncNow` and `handleGnuCashRowPush` never read `sync_enabled` (00044) | Wave 1 (sibling) | Post-restore credential install and write-endpoint gate. |
| Importer (dry-run + restore + report) | absent | **Wave 2** | Domain-aware restore into the empty database. |
| Round-trip driver | absent | **Wave 2** | Ordered runbook below, as a Go test and/or `backend/cmd/` tool. |
| Folio verify-by-external-ID (or no-write batch plan) | absent, cross-repo | parallel with P0 | Required for the GnuCash no-create/no-overwrite sign-off, not for the same-schema record gate. |

House rules the driver inherits:

- Go tests run with `TZ=UTC`.
- Database-touching tests skip when `TEST_DATABASE_URL` is unset and must not
  assume a live database.
- Frontend typecheck/lint is irrelevant to this gate (`npx tsc --noEmit`,
  `npx eslint` stay unused here).
- CI today runs `go test -p 1 ./...` against Postgres 16 because parallel
  packages deadlock on `TRUNCATE` once 00015 FKs reach hives
  (`.github/workflows/deploy.yml`). The gate uses a **private database
  name**, so it must not `TRUNCATE` the shared `TEST_DATABASE_URL` database.

---

## 2. End-to-end gate procedure (ordered runbook)

Run as one Wave 2 driver with a single report written **outside** both the
source database and the disposable target. Abort on the first failing step.
Do not start a destructive reset from this rehearsal; the reset policy
(section 7) requires a fresh snapshot if source data moved after this run.

### Step 0 — Preconditions

1. Process environment: `TZ=UTC`.
2. `TEST_DATABASE_URL` is set to an admin-capable Postgres 16 URL (same role
   that can `CREATE DATABASE`, matching `freshDatabase`). If unset, the
   driver skips with `TEST_DATABASE_URL is not configured` and the gate is
   **not passed**.
3. The **source** database URL is a separate setting (`SNAPSHOT_SOURCE_URL`
   or equivalent). Defaulting it to `DATABASE_URL` is allowed for an
   operator rehearsal; the automated gate **must not** use the compose
   working database `beeztrackz` on volume `postgres_data` as the restore
   target. See section 5.
4. Wave 1 export CLI, snapshot package, and verification emitter are on
   `PATH` / importable. Wave 2 importer is on `PATH` / importable.
5. MinIO (and Immich, if any `photos.storage_backend = 'immich'` row exists,
   00017) are reachable **read-only** for original-byte hashing. The gate
   does not write objects during dry-run or comparison.
6. GnuCash sync on the source may be enabled; the **target** is created with
   `gnucash_sync_settings.sync_enabled = false` (00044 default) and the
   importer must leave it false. Wave 1's server gate must refuse
   `POST /settings/gnucash/sync` and `POST /settings/gnucash/rows/{id}/push`
   while it is false.

### Step 1 — Fresh snapshot from the current database

**Who runs it:** Wave 1 export CLI against the source URL.

**What it writes** (canonical artifact, directory or archive; format owned
by the Wave 1 spec):

- `manifest.json` — `formatVersion`, export timestamp (UTC), application
  commit, source schema commit / `MAX(goose_db_version.version_id)` (today
  48), exporter version, included domain files with record counts / byte
  sizes / content hashes, unit and encoding declarations, timezone rules,
  omitted optional domains, media-manifest version, embedded-vs-external
  flag per original.
- One JSONL file per domain record type (section 2.1).
- Media originals either embedded or referenced (`photos.original_key` /
  `original_ref` / `storage_backend`, `media_files.audio_key`, Immich
  `immich_timeline_candidates.immich_asset_id`).
- `verification.json`, linked by hash from the manifest.
- A classified omission list (empty unless the operator pre-accepted a
  missing original).
- A secrets-exclusion report: which columns/keys were stripped and what
  the operator must reconfigure.

**Must not write:** `app_users.password_hash` (00013), legacy
`user_settings.password_hash` if any row still has it (00001; 00013 moved
the live hash), `user_settings.ntfy_access_token` (00031),
`api_tokens.token_hash` (00003; exclude the table), `oidc_identities`
subject/issuer binding as a restore secret (00001/00003; exclude the
table — identities are re-linked after restore),
`gnucash_sync_settings.api_token` (00044),
`user_settings.ai_provider_config.apiKeys.*` (`anthropic`, `google`,
`ollamaUrl`, `whisperUrl` in `backend/internal/ai/config.go`). Session
JWTs are not stored in Postgres (`backend/internal/auth/session.go`).
`offline_mutation_receipts` (00003/00010) is session/offline state and is
**omitted** (declared in the manifest as an intentional omission).

**Pass:** CLI exit 0, manifest hashes match the files just written, every
required domain file is present, `verification.json` hash matches the
manifest link, goose version in the manifest equals 48 (or whatever
`MAX(version_id)` the source actually has).

**Fail:** any missing required domain, hash mismatch, secret found by the
scan in section 4, goose version drift vs the exporter's expected ceiling.

### Step 2 — Checksum the artifact (independent of the exporter)

**Who runs it:** Wave 2 driver, using the same hash algorithm the Wave 1
manifest declares (content hashes of each file, plus a wrapping checksum
of the artifact). Do not trust the exporter's in-process hashes as the
only check.

Keep the wrapping checksum **separate from any encryption credentials**.
If the operator encrypts the artifact at rest (age/gpg — not a new crypto
subsystem), checksum the ciphertext **and** keep a plaintext checksum
inside the encrypted payload; decryption credentials never live next to
the checksum file.

**Pass:** recomputed file hashes equal `manifest.json`; wrapping checksum
is stored beside the artifact, outside the source database.

**Fail:** any byte mismatch. Re-export; do not "fix" the manifest.

### Step 3 — Importer dry run (no writes)

**Who runs it:** Wave 2 importer `dry-run` against the artifact. It uses
the Wave 1 restore foundation for validation helpers but must not open a
read-write transaction on any database that holds operator data. Preferred:
validate in-process (manifest, hashes, `formatVersion`, units, required
fields, IDs, references, media originals, `verification.json` internal
consistency) **without connecting to the source**. A connection to the
**target** is allowed only if the session is `SET TRANSACTION READ ONLY`
and is rolled back.

**Validates:**

- Supported `formatVersion` (unknown version is a hard fail; no guessing a
  table layout from the source commit — roadmap).
- Manifest ↔ file hashes, record counts, `verification.json` link.
- Canonical units (lbs, grams, integer cents, ISO 8601 UTC timestamps,
  named local timezone only where a jsonb snapshot already stored one).
- Preserved IDs unique per domain file.
- Every required reference (section 3.2) resolves inside the artifact.
- Trigger-order constraints are *checkable* here even though no rows are
  written: bottling runs before their movements (00047
  `honey_movement_lot_matches_run`); equipment stock would insert at zero
  (00006 `equipment_stock_reconcile_guard`); settlement
  `amount_paid_cents <= amount_owed_cents` (00024); BOM cycle guard
  (00046) would accept the catalog as exported.
- Media: every required original is embedded or the external ref resolves
  (HEAD/stat MinIO key or Immich asset). Accepted omissions must already
  be classified in the manifest **and** `verification.json`.

**No-write proof:** section 4 (dry-run-makes-no-writes). The driver records
the proof in the gate report.

**Pass:** dry-run report has zero errors; no-write proof holds.

**Fail:** any validation error. Dry-run must not repair data.

### Step 4 — Restore into a disposable empty database

**Who runs it:** Wave 2 importer `restore`, Wave 1 restore services, system
-restore actor (not an `app_users` row and not HTTP auth).

**Target construction (section 5):**

1. `DROP DATABASE IF EXISTS <gate_db>; CREATE DATABASE <gate_db>;` using
   the `freshDatabase` URL rewrite.
2. `db.Connect` so goose applies 00001–00048. This seeds
   `stock_locations` home (`slug = 'home'`, 00024) and
   `treatment_products` catalog rows (00019/00022/00034). The importer
   must treat those seeds as **idempotent identity by natural key**
   (`stock_locations.slug`, `treatment_products.name_key`), not as
   conflicting preserved IDs, unless the snapshot's preserved UUID differs
   — in which case the restore report records a **seed-identity remap**
   (explained, not a gate failure) and all FKs in the artifact that
   pointed at the snapshot UUID are rewritten to the seed UUID before
   insert. Prefer: the exporter records the home location and treatment
   products with their live UUIDs; the importer deletes or replaces the
   seed row inside the restore transaction so preserved IDs win. The
   second option is simpler and is **required** unless the format spec
   forbids deleting seeds. This design requires **preserved IDs win**:
   inside the restore transaction, delete the 00024 home seed and the
   00019/00022/00034 treatment-product seeds, then insert snapshot rows.
   Re-seed home only if the snapshot omitted it (it must not).
3. `SET TIME ZONE 'UTC'` on every connection.
4. Confirm `SELECT COUNT(*) FROM apiaries` is 0 (and similarly for
   `hives`, `sales`, `honey_movements`) before the first insert. Goose
   seeds do not create apiaries.

**Restore rules the driver asserts via the importer report:**

- Privileged writes of preserved UUIDs, `created_at`/`created_by`,
  `deleted_at`/`voided_at`/`cancelled_at`/`physical_applied_at`. No
  `gen_random_uuid()` on imported rows.
- Dependency order is **not** one topological sort over files (review
  gap). Required intra-file / post-pass order:
  - Catalogs first: `app_users` (without password hashes), `apiaries`,
    `jar_sizes`, `product_catalog`, `equipment_types`,
    `equipment_type_components` (00046 cycle guard), `treatment_products`,
    `honey_varietals` (00047), `customers`, `wholesale_price_lists`.
  - Then apiary-scoped masters: `hives`, `queens` (two-pass for
    `parent_queen_id`, same as `cmd/migrate-legacy`), `stock_locations`.
  - Then events/history.
  - `bottling_runs` before `honey_movements` that set `bottling_run_id`
    (00047 trigger).
  - `equipment_stock` inserted at **zero** totals, then
    `equipment_stock_adjustments` / `equipment_state_changes` replayed so
    00006 triggers compute `total_owned` / damaged / retired
    (roadmap importer contract).
  - Original `honey_movements` / `stock_movements` before rows whose
    `reverses_movement_id` points at them (00005, 00024 FKs). These
    columns **do** have FKs; they are not no-FK pointers. The true no-FK
    pointer is `media_files.current_transcript_version_id` (00017) — set
    in a post-pass after `transcript_versions` exist.
  - `harvest_lot_photos.photo_id` is `ON DELETE RESTRICT` (00017); photos
    before lot-photo links.
  - `jar_serials.sale_id` is `ON DELETE RESTRICT` (00010); sales before
    serials that name them, or insert serials unsold then post-pass the
    link.
  - Consignment settlements before the movements that name
    `settlement_id` (00024).
- Soft-deleted / voided / cancelled / reversed history is restored as
  history (`honey_harvests.deleted_at` 00005, `expenses.deleted_at` 00005,
  `sales.cancelled_at` 00005, `bottling_runs.voided_at` 00023,
  `product_batches.voided_at` 00030, `product_adjustments.deleted_at`
  00030, `propolis_harvests.deleted_at` 00020, `mite_counts.deleted_at`
  00036, `treatment_events.deleted_at` 00037, field-object `deleted_at`
  00025, `yard_labor_sessions.deleted_at` 00026,
  `consignment_settlements.voided_at` 00024,
  `stock_locations.deleted_at` 00024).
- GnuCash: restore `gnucash_sync_settings` **without** `api_token`, with
  `sync_enabled = false`, preserving `book_guid`, `book_name`,
  `root_currency`, `changes_cursor`, `account_mapping`, and
  `last_synced_at` under the name **last-attempt** (00044; written even
  when pull fails). Restore `external_sync` rows including
  `content_hash`, `remote_transaction_guid`, `remote_enter_date` (00045),
  `conflict_state`, `location_id` (00024 identity key). Do not invent
  tombstone rows or stored idempotency keys — they are not durable Beez
  records (review B2).
- Final restore report: created / unchanged / skipped / conflicted /
  failed, missing media, excluded configuration.

**Pass:** report has zero failed and zero conflicted rows; created +
unchanged equals the snapshot record counts per domain; `sync_enabled` is
false; secrets columns are null.

**Fail:** any conflicted preserved ID, any failed row, any trigger
exception, any seed UUID collision that was not remapped by the
preserved-IDs-win rule above.

### Step 5 — Re-export the disposable database

**Who runs it:** the **same** Wave 1 export CLI against the target URL,
same `formatVersion`, same digest algorithm version.

**Pass:** CLI exit 0; new `manifest.json` + `verification.json` written
into a second directory (`artifact.restored/`), never overwriting the
source artifact.

**Fail:** exporter error. Do not compare a partial re-export.

### Step 6 — Compare source artifact vs restored artifact

**Who runs it:** Wave 2 comparator (part of the driver), reading both
`verification.json` files and both domain JSONL files. It does **not**
re-query the source database. The disposable target may be queried only
to double-check that the re-export matches what is actually in it (a
sanity probe, not the equality oracle).

Comparison uses the matrix in section 3. For this same-schema rehearsal
the aggregate family is **legacy**. `formatVersion` transforms do not
apply (export and re-export share the current version). Residual-split
explanations do not apply (schema has not changed).
`legacy-unattributed` / `legacy-unassigned` markers may appear in the
**artifact** as exported facts; they must round-trip as the same markers,
not as invented ancestry.

**Pass:** every cell in section 3 is either equal or an **explained**
difference. Gate report written beside the artifact.

**Fail:** any absent, additional, or digest-mismatched record; any
unexplained aggregate delta; any unresolved media original.

### Step 7 — Adversarial suite against the same binaries

**Who runs it:** Wave 2 tests, each skipping without `TEST_DATABASE_URL`
when they need Postgres. Fixtures may be file-only. Checklist: section 4.

**Pass:** every case in section 4 has a named test and the expected
actionable error. Dry-run no-write proof is one of those tests.

### Step 8 — GnuCash post-restore (same-schema subset)

This rehearsal **cannot** complete the full roadmap GnuCash sentence
(folio verify API + re-key + rebaseline) because those depend on P1 and
on gnucash-web. The same-schema subset that **this** gate must still
prove:

1. Restored `external_sync` rows equal source digests (including
   `content_hash`, `remote_transaction_guid`, `remote_enter_date`,
   `conflict_state`, `location_id`).
2. Restored `gnucash_sync_settings` has no token, `sync_enabled = false`,
   preserved cursor and book GUID.
3. Wave 1 server gate: `POST /settings/gnucash/sync` and
   `POST /settings/gnucash/rows/{id}/push` return a refusal while
   `sync_enabled = false` (and while reconciliation-pending, once that
   flag exists).
4. Wave 1 guarded restore command: presenting a new token does **not**
   clear `book_guid`/`changes_cursor` unless the tested book identity
   mismatches. Exact identity match then installs the preserved cursor.
   Ordinary `PUT /settings/gnucash` remains destructive on token change
   (current tests pin that).

The remaining GnuCash bullets (folio no-write plan, entity re-key,
content-hash rebaseline) are **sign-off items deferred** to the P1
new-schema restore and the folio parallel work. They stay on the
acceptance list in section 6 as not-yet-runnable, not as waived.

### Step 9 — Keep the artifact; do not touch the working database

Copy `artifact/`, wrapping checksum, gate report, and
`artifact.restored/` to operator-controlled storage. Drop the disposable
database (`freshDatabase` cleanup). Do not `TRUNCATE`, migrate, or
reconfigure the compose `beeztrackz` database as part of this rehearsal.

### 2.1 Domain JSONL files the gate requires

Every exported domain must appear in the format spec. The gate fails if
the exporter omits one of these tables, or if the re-export adds a
domain the source artifact lacked. Views are **not** domains; they are
legacy aggregate definitions.

| Domain file (stable concept) | Table | Born in |
|---|---|---|
| `apiaries` | `apiaries` | 00001; elevation 00018; forage radius 00027; `satellite_image_key` dropped 00032 |
| `hives` | `hives` | 00001; sale_id 00015; GPS 00021; `gps_source` 00043 |
| `hive_location_history` | `hive_location_history` | 00001 |
| `hive_splits` | `hive_splits` | 00001 |
| `queens` | `queens` | 00001; mating yard 00029 |
| `queen_events` | `queen_events` | 00002 |
| `inspections` | `inspections` | 00001; weather 00003; source media FKs 00017; frames/strength fields 00025 |
| `feedings` | `feedings` | 00001; lifecycle 00007; sale_id 00015; source media 00017 |
| `feeding_status_backfills` | `feeding_status_backfills` | 00007 |
| `mite_counts` | `mite_counts` | 00002; mites_per_day 00016; audit 00036 |
| `treatment_products` | `treatment_products` | 00019; seeds 00022/00034 |
| `treatment_events` | `treatment_events` | 00002; withdrawal_days 00019; source media 00017; soft delete 00037 |
| `harvest_sessions` | `harvest_sessions` | 00001 |
| `harvest_session_true_ups` | `harvest_session_true_ups` | 00005 |
| `honey_harvests` | `honey_harvests` | 00001; deleted_at 00005; `direct_weight` 00011 |
| `harvest_lots` | `harvest_lots` | 00002; moisture 00019/00034; `honey_weight_entered` 00026; `honey_weight_source` 00039; varietal 00047; floral claim 00029 |
| `harvest_lot_harvests` | `harvest_lot_harvests` | 00002 |
| `harvest_lot_photos` | `harvest_lot_photos` | 00002; RESTRICT 00017 |
| `honey_varietals` | `honey_varietals` | 00047 |
| `honey_movements` | `honey_movements` | 00001; reverse/run 00005; batch 00020; settlement 00024; lot_id 00047 |
| `jar_sizes` | `jar_sizes` | 00001; cents 00004; packaging_type_id 00048 |
| `bottling_runs` | `bottling_runs` | 00002; void 00023 |
| `jar_serials` | `jar_serials` | 00002; sale link 00009; RESTRICT 00010 |
| `customers` | `customers` | 00002 |
| `sales` | `sales` (renamed 00015) | 00001 as `honey_sales`; cents 00004; cancel 00005; kinds 00015; `physical_applied_at` 00022; `stock_location_id` 00024 |
| `sale_items` | `sale_items` | 00001 as `honey_sale_items`; kinds 00015/00020; `bottling_run_id` 00038; `cost_basis_cents` 00040 |
| `stock_locations` | `stock_locations` | 00024 |
| `stock_movements` | `stock_movements` | 00024 |
| `consignment_settlements` | `consignment_settlements` | 00024 |
| `product_catalog` | `product_catalog` | 00020; `net_grams` 00022 |
| `product_batches` | `product_batches` | 00020; void 00030 |
| `product_batch_expenses` | `product_batch_expenses` | 00020 |
| `product_adjustments` | `product_adjustments` | 00030 |
| `propolis_harvests` | `propolis_harvests` | 00020 |
| `expenses` | `expenses` | 00002; cents 00004; deleted_at 00005 |
| `wholesale_price_lists` | `wholesale_price_lists` | 00002 |
| `wholesale_price_list_items` | `wholesale_price_list_items` | 00002 |
| `equipment_types` | `equipment_types` | 00001; variant_of 00046 |
| `equipment_type_components` | `equipment_type_components` | 00046 |
| `equipment_stock` | `equipment_stock` | 00001; ledger columns 00006; first_deployed_year 00025 |
| `equipment_stock_adjustments` | `equipment_stock_adjustments` | 00001; ledger 00006; sale_id 00015; snapshot cost 00040; idempotency 00042 |
| `equipment_deployments` | `equipment_deployments` | 00001; returns 00006; idempotency 00042 |
| `equipment_deployment_returns` | `equipment_deployment_returns` | 00006; sale_id 00015; idempotency 00042 |
| `equipment_state_changes` | `equipment_state_changes` | 00006; idempotency 00042 |
| `photos` | `photos` | 00001; backend/ref 00017; comparison_angle 00028 |
| `media_files` | `media_files` | 00001; current version 00017; retranscription 00035 |
| `transcript_versions` | `transcript_versions` | 00017 |
| `catch_boxes` | `catch_boxes` | 00025 |
| `colony_intakes` | `colony_intakes` | 00025 |
| `field_incidents` | `field_incidents` | 00025 |
| `deadout_autopsies` | `deadout_autopsies` | 00025 |
| `bloom_observations` | `bloom_observations` | 00001; elevation band 00027 |
| `yard_scales` | `yard_scales` | 00027 |
| `scale_readings` | `scale_readings` | 00027 |
| `apiary_weather_cache` | `apiary_weather_cache` | 00003 |
| `immich_timeline_scans` | `immich_timeline_scans` | 00028 |
| `immich_timeline_candidates` | `immich_timeline_candidates` | 00028 |
| `yard_labor_sessions` | `yard_labor_sessions` | 00026 |
| `ai_recommendations` | `ai_recommendations` | 00001; triage 00008; unique 00010 |
| `ntfy_dispatches` | `ntfy_dispatches` | 00026; scrub 00033 (title/body nullable) |
| `apiary_memberships` | `apiary_memberships` | 00003 |
| `app_users` | `app_users` | 00003; password_hash 00013 **excluded**; username 00014 |
| `user_settings` | `user_settings` | 00001; singleton 00012; mite thresholds 00016; moisture 00019; units/ntfy 00026; ntfy token 00031 **excluded** |
| `external_sync` | `external_sync` | 00005; location 00024; entity types 00041; push state 00045 |
| `gnucash_sync_settings` | `gnucash_sync_settings` | 00044; token **excluded** |

There is **no** `payments` table (00024 declined one). There is **no**
`strength_scores` table: 00025 added inspection frame counts
(`frames_of_bees` / `frames_of_brood` / `frames_of_stores`), which ride
the `inspections` domain. There is **no** `queens.testing_data`;
`testing_data jsonb` is on `harvest_lots` (00002). The roadmap amendment
that named `queens.testing_data` is treated as that column.

**Declared omissions (not gate failures when listed in the manifest):**

- `api_tokens` (00003) — secrets.
- `oidc_identities` (00001/00003) — re-bind after restore.
- `offline_mutation_receipts` (00003/00010) — session/offline state.
- `goose_db_version` — schema, not a domain.
- Generated columns (not independent records): `mite_counts.mites_per_100`
  (00002), `mite_counts.mites_per_day` (00016),
  `propolis_harvests.amount_grams` / `product_batches.propolis_amount_grams`
  (00026), `bloom_observations.elevation_band` (00027),
  `treatment_products.name_key` (00019). Digests skip them; restore
  lets Postgres recompute.

**Not domains (legacy aggregate oracles, cited by `verification.json`
definitions, not JSONL files):** `honey_lot_balances` and
`honey_varietal_balances` (00047), `equipment_stock_status` /
`equipment_stock_reconciliation` / `equipment_loss_events` (00006, rewritten
00025).

---

## 3. Comparison matrix

Oracle: `verification.json` from the **source** snapshot. Actuals: the
re-export's `verification.json` plus, for media, live resolution of
external refs. Family for this rehearsal: **legacy**. Family for the later
clean-baseline restore: **new-ledger**, plus declared residual splits.

Every row below: **equal** means the restored side matches the source
definition on that key. **Explained** means the difference is listed in
the gate report with a coded reason and does **not** fail the gate.
Anything else fails.

### 3.1 Record-level digest equality by preserved ID, per domain

| Check | How | Explained difference | Gate failure |
|---|---|---|---|
| Count by domain | `manifest` recordCounts vs both verification files | none for same-schema | missing file; count mismatch; extra domain |
| Presence by preserved ID | every `(domain, id)` in source appears in restored; no extras | seed rows that the importer deleted (00024 home, 00019 products) must **not** reappear under a new UUID | absent ID; extra ID; duplicate ID in either file |
| Canonical semantic digest | digest of normalized fields, algorithm version stamped per record | `formatVersion` transform (not used in this rehearsal); generated columns omitted by spec | digest mismatch; algorithm version drift; field dropped/added outside the transform |
| jsonb fields | sorted-key, fixed-number-format canonicalization (section 4 jsonb traps) | none — canonicalization must make Postgres round-trip equal | key-order-only "fix" that was not canonicalized at export; numeric `1` vs `1.0` mismatch after restore |
| Audit timestamps | `created_at` / `updated_at` / `deleted_at` / `voided_at` / `cancelled_at` / `physical_applied_at` exported as ISO 8601 UTC | `updated_at` may move if a restore trigger fires (`set_updated_at` on 00001+). **Not explained.** Restore repos must set `updated_at` from the snapshot and the Wave 1 UoW must disable or bypass `set_updated_at` during restore (session `session_replication_role = replica` **or** a restore-only insert that includes `updated_at` and a trigger exception). Prefer including `updated_at` in the INSERT and using `session_replication_role = replica` for the restore transaction so triggers do not rewrite audit fields. | any `created_at`/`deleted_at`/`voided_at` drift; any `updated_at` drift if triggers were not bypassed |
| Actor IDs | `created_by` / `deleted_by` / `voided_by` preserved | `legacy-unattributed` marker on `honey_movements` (table has **no** `created_by`, 00001) — export the marker, restore as null actor plus the marker in verification | silent attribution to the system-restore actor |
| Soft-deleted rows | included, with `deleted_at` | none | dropped tombstones (especially 00036 mite_counts, 00037 treatment_events — live unique indexes ignore them; dropping them changes history) |

jsonb columns that **must** be in the digest (actual schema, not the
roadmap's slightly wrong list):

- `inspections.pests`, `inspections.treatments`, `inspections.source_media`
  (00001)
- `inspections.weather_snapshot` (00003)
- `apiaries.canvas_layout` (00001; 00032 already stripped `registration`)
- `photos.tags` (00001)
- `harvest_lots.testing_data` (00002) — **not** `queens.testing_data`
- `apiary_weather_cache.forecast` (00003)
- `external_sync.account_mapping`, `category_mapping`, `tax_mapping` (00005)
- `gnucash_sync_settings.account_mapping` (00044)
- `user_settings.ai_provider_config` (00001) — secret exclusion is
  **per-key**: drop `apiKeys`, keep `transcription` /
  `recommendations` / `imageAnalysis` / `import`

Treatments are three stores: `treatment_events` (00002/00037),
`inspections.treatments` jsonb (00001), `treatment_products` (00019).
Export all three. The 00034 rule (PATCH of inspection jsonb reconciles
`treatment_events`, indexed by `treatment_events_inspection_id_idx`) is a
**reference + digest** check: every live `treatment_events` row with
`inspection_id` set must match a jsonb element, and every jsonb element
the exporter canonicalized must have a live event. Soft-deleted events
(00037) remain in the events file and must not be re-created as live.

### 3.2 Reference checks

Named in `verification.json` as `(from_domain, from_id, field, to_domain,
to_id)`. Both ends must exist in the restored artifact.

| Relationship | Migration / constraint | Explained | Failure |
|---|---|---|---|
| `hives.apiary_id` → apiaries | 00001 | none | dangling |
| `hives.sale_id` → sales | 00015 | none | dangling; TRUNCATE trap (honey tests null this first) |
| `queens.parent_queen_id` → queens | 00001 self-FK | none | missing parent because single-pass insert |
| `inspections.source_media_file_id` → media_files; `source_transcript_version_id` → transcript_versions | 00017 | none | jsonb `source_media.mediaFileId` disagrees with the FK |
| `media_files.current_transcript_version_id` → transcript_versions | 00017 **no FK** | none | pointer not set in post-pass; points at a version of a different file |
| `feedings.refill_of_id` → feedings | 00007 unique successor | none | two successors; cycle |
| `honey_movements.reverses_movement_id` → honey_movements | 00005 UNIQUE + FK | none | reversal before original; double reverse |
| `honey_movements.bottling_run_id` → bottling_runs and `lot_id` matches `bottling_runs.lot_id` | 00005, 00047 trigger | none | trigger would have fired; lot mismatch |
| `honey_movements.lot_id` → harvest_lots | 00047 | `legacy-unassigned`: `lot_id IS NULL` on historical draws — export as the unassigned bucket, do not invent a lot | importer filling a guessed lot |
| `honey_movements.product_batch_id` → product_batches | 00020 ON DELETE RESTRICT | none | dangling |
| `stock_movements.reverses_movement_id` / `transfer_id` pairs | 00024 | none | unpaired transfer; net ≠ 0 |
| `sale_items.bottling_run_id` → bottling_runs, jar kind only | 00038 | NULL on pre-00038 lines is a fact | attaching a run the source did not have |
| `jar_serials.sale_id` ↔ `sold_at` CHECK | 00009; RESTRICT 00010 | unsold NULL pair | CHECK violation; sale deleted out from under serials |
| `harvest_lot_photos.photo_id` | 00017 RESTRICT | none | missing original photo |
| `colony_intakes.expense_id` unique | 00025 | none | expense missing or shared |
| `equipment_type_components` parent/component | 00046 cycle guard | none | cycle |
| `external_sync (system, entity_type, entity_id, COALESCE(location_id, all-zero uuid))` unique | 00024/00041 | none | duplicate mapping identity |
| `external_sync.entity_id` resolves to the named entity_type | 00041 allowlist | on **P1 new-schema** restore only: versioned re-key transform (old type+UUID → new item/operation). Explained iff the transform is in the artifact and the new ID digests match | dangling mapping on same-schema restore; re-key skipped on new-schema restore |

A dangling reference in the **source** artifact fails Step 3 (dry run),
not Step 6. The source is not allowed to export an unsatisfiable graph
unless that edge is declared optional in the format spec.

### 3.3 Inventory quantities by item / location / lot / condition

Keys are the **legacy** dimensions, because that is the schema this
rehearsal restores into. `verification.json` stores each number with its
definition id, query/exporter version, unit, rounding, and sign.

| Aggregate | Definition (cite the code/SQL that is truth today) | Dimensions | Explained | Failure |
|---|---|---|---|---|
| Global bulk honey | `honeyBulkOnHand` in `honey_ledger.go`: session true-up or live harvest sum (00005 true-ups, 00011 direct_weight) + sessionless live harvests − jarring − bulk_use − loss. Soft-deleted harvests excluded. Pounds from stored `amount_lbs` (00005 backfill), not `quantity * honey_oz / 16`. Tolerance `honeyPoundTolerance = 0.0001` | none (one pool) | none on same-schema | any delta beyond tolerance |
| Unassigned bulk residual | 00047 header + `routes_honey_varietals.go`: `TotalHarvestedLbs - SUM(harvest_lots.honey_weight_lbs) - SUM(draws with lot_id IS NULL and kind in jarring, bulk_use, loss)` | the `legacy-unassigned` bucket | **P1 new-schema only:** splitting this residual into declared opening-balance operations whose sums equal this number. Same-schema must keep the residual as a number, not as invented lots | same-schema inventing lots; new-schema split that does not match the declared mapping |
| Per-lot bulk | view `honey_lot_balances` (00047): `honey_weight_lbs - jarred - bulk_use - loss` | lot_id | 00039 `derived` lots: weight is a fact at export time; same-schema must restore the stored `honey_weight_lbs` plus `honey_weight_source`. New-schema compensating movements are P1 | lot on-hand delta; derived flag lost |
| Varietal rollup | view `honey_varietal_balances` (00047) | varietal_id | none | rollup ≠ sum of lots |
| Jar finished goods (global) | `honeyJarInventoryWithQuerier`: `jarred + jar_adjustment − sold(non-cancelled, kind=jar) − give_away` (`routes_honey.go`). Inactive sizes listed only while on-hand ≠ 0 | jar_size_id | none | on-hand delta; deactivated size with stock dropped |
| Jar / SKU away-from-home | `stockAwayQuantities` (`honey_ledger.go` / 00024): `SUM(stock_movements at L) − sold on sales scoped to L`; home is **not** in this result | item (jar_size xor product) × location | none | shop shelf ≠ source |
| Jar / SKU at home (residual) | `globalOnHand - SUM(away)`. 00024: home is the residual, not a seeded pile | item × home | **P1 new-schema only:** opening-balance operations equal to this residual | same-schema writing home `stock_movements` that the source did not have |
| Catalog SKUs | `productInventoryQuery` (`routes_products.go` / 00030 comment): live batches `quantity_out` + `SUM(product_adjustments.delta)` where `deleted_at IS NULL` − sold | product_id | voided batches (00030) excluded from "made" | counting a voided batch |
| Propolis grams | `propolisOnHandGrams`: live harvests (ounces × 28.349523125, 00026) − live tincture batches − sold `kind=propolis` × `net_grams` (00022) | one pool (parallel unit) | none | grams delta beyond a stated milligram tolerance (define in verification as 0.001 g) |
| Equipment totals | 00006: `total_owned = SUM(adjustments)`; damaged/retired from `equipment_state_changes`; `available = total_owned - damaged - retired - deployed` (`equipment_stock_status`, 00025 rewrite) | type_id × condition (`frame_condition` on the UNIQUE-per-type stock row **and** state-change vocabulary). Two vocabularies remain until P1 | none on same-schema; P1 merge of vocabularies is a declared mapping | guard would fail (totals ≠ ledger); available delta |
| Packaging empties | 00048: packaging rides the equipment ledger (`equipment_category = 'packaging'`); `jar_sizes.packaging_type_id` is the link | equipment type | unlinked jar sizes consume nothing — a fact | losing the link |
| BOM assembly | 00046: assemble/disassemble are ordinary adjustments (`assembled` / `disassembled`) | parent type + components | none | missing component lines |
| Serials | `jar_serials` have **no location** (review). Gate checks count per `bottling_run_id` and sold vs unsold (`sale_id` NULL) | run_id × soldness | not locatable at a consignment shop — **not** a same-schema failure; do not invent locations | serial dropped; soldness flipped |

Sign conventions the definitions must stamp: honey movement quantities on
reversals are **negative** and net in the SUM (00005). Stock movement
transfers write −n / +n (00024). Product adjustment shrink is negative
delta (00030). Equipment sold adjustments are negative quantity (00015).

### 3.4 Financial totals by currency + status

There is **no** currency column on `sales` or `expenses`. Money is integer
cents (00004). Canonical currency in `verification.json` is a declared
encoding (export `USD` unless `gnucash_sync_settings.root_currency` is
set — 00044 — in which case stamp that code on the GnuCash-facing totals
and still declare Beez cents as the operator's book currency). Do not
export locale-formatted numbers.

| Aggregate | Definition | Dimensions | Explained | Failure |
|---|---|---|---|---|
| Sales totals | `SUM(total_amount_cents)`, `discount_amount_cents`, `amount_paid_cents`, `tax_cents` (NULL ≠ 0, 00004) | `order_status` (00002: draft/pending/paid/fulfilled/cancelled) × currency | cancelled sales (00005) stay in the artifact with `cancelled_at`; they are a **status bucket**, not dropped | mixing cancelled into paid totals; tax NULL becoming 0 |
| Collected vs invoiced | `amount_paid_cents` vs `total_amount_cents` on `sales`; `amount_paid_cents` vs `amount_owed_cents` on `consignment_settlements` (00024 CHECK paid ≤ owed) | status × currency | no `payments` table — these columns **are** the money domain | inventing a payments JSONL file |
| Line COGS | `sale_items.cost_basis_cents` (00040); equipment `unit_cost_cents_snapshot` | kind × status | NULL basis is "unknown", not zero | NULL → 0 |
| Expenses | `SUM(amount_cents)` where `deleted_at IS NULL` (00005) | category (00002 CHECK) × currency | soft-deleted expenses remain as records but drop out of the live total | live total includes deleted rows |
| Colony intake costs | `colony_intakes.cost_cents` linked 1:1 to expenses (00025) | none | none | broken 1:1 |
| Settlement commission | `commission_cents`, `commission_bps` (00024, integer bps) | location × period | voided settlements excluded from live owed | voided statement still in live total |

### 3.5 Honey / production totals

| Aggregate | Definition | Explained | Failure |
|---|---|---|---|
| Harvested lbs | same inner query as `honeyBulkOnHand` harvested half (true-up wins per session, 00005) | none | using super-weight pairs on `direct_weight` rows (00011) as if they were two measurements |
| Jarred / bulk_use / loss lbs | `SUM(amount_lbs)` by `honey_movements.kind` | unattributed (`lot_id` NULL) vs attributed split must match 00047 | moving history into lots |
| Bottled lbs / counts | `bottling_runs.honey_lbs` / `quantity` excluding `voided_at` (00023) | voided runs remain as records; live bottled total excludes them | voided run still in live bottled |
| Batch output | `product_batches.quantity_out` excluding voided (00030) | none | voided mead/tincture counted |
| Session true-up history | `harvest_session_true_ups` row-level digests | none | only the current session weight survived |

### 3.6 Media hashes vs resolvable external refs

| Check | Definition | Explained | Failure |
|---|---|---|---|
| Original bytes | hash of MinIO object at `photos.original_key` when `storage_backend = 'minio'` (00017 CHECK: `original_key IS NOT NULL` and `original_ref = original_key`) | classified accepted omission (owner + reason in manifest **and** verification) | missing required original; hash mismatch |
| Immich original | `storage_backend = 'immich'`: `original_key IS NULL`, `original_ref` is the Immich asset id, `original_external = true` (00017). Gate **resolves** (Immich GET asset) and hashes the remote original if reachable; if the operator classified the library as an external restoration boundary, a 200 + matching id is enough and the hash is recorded as "external, unresolved bytes" | accepted omission; Immich unreachable **after** a recorded successful resolve at export time is a **new** failure on the gate re-run, not explained | export-time missing Immich asset not classified |
| Audio original | `media_files.audio_key` (00001) hashed like photos | accepted omission | missing audio |
| Derived renditions | `thumbnail_key`, `medium_key` (00001) | **excluded from the hash gate** (roadmap). Re-render after restore is expected. Presence may be restored if embedded, but digest inequality on thumbnails is explained as `rendition-regenerable` | failing the gate because a thumbnail re-encoded |
| Immich timeline | `immich_timeline_candidates.immich_asset_id` (00028) must still resolve or be classified; `photo_id` if `review_state = 'adopted'` must point at a restored photo | rejected/pending candidates without a photo | adopted candidate with no photo |
| Lot photos | `harvest_lot_photos` (00017 RESTRICT) | none | story image missing |

---

## 4. Adversarial test checklist

Each item is a Wave 2 test. File-only cases must not require
`TEST_DATABASE_URL`. Database cases skip cleanly when it is unset.
Expected errors are per-file / per-record, never a silent partial restore.

| ID | Case | How to assert | Expected |
|---|---|---|---|
| A1 | Corrupt file | Flip a byte in a JSONL or in `verification.json` after hashing | dry-run fails on manifest hash; no restore starts |
| A2 | Truncated JSONL | Drop the last line mid-object / omit newline so `json.Decoder` errors | per-file parse error naming the domain file and byte offset |
| A3 | Dangling reference | Point `honey_movements.lot_id` at a missing lot; or `sale_items.hive_id` at a missing hive | dry-run reference error naming both ends |
| A4 | Duplicate preserved ID | Two JSONL lines with the same `id` in `hives.jsonl` | dry-run duplicate-ID error; restore does not insert either as a coin-flip |
| A5 | Conflicting preserved ID, different digest | Restore once, then restore a second artifact (or a mutated line) with the same id and a different digest | restore-specific conflict (roadmap: **not** equipment replay-without-payload, **not** product 409, **not** transfer line-order keys). Report `conflicted`; require an explicit policy. Default policy for the gate: **fail** |
| A6 | Missing required media original | MinIO 404 on `original_key`; or Immich 404 on `original_ref` | gate fail unless that exact owner+reason is in the accepted-omission list |
| A7 | Accepted-omission path | Manifest lists one missing original with owner, reason, classified `accepted`; verification repeats it | dry-run passes; restore report lists the omission; hash gate skips that one original and **fails** if a second original is also missing |
| A8 | Unsupported `formatVersion` | Set `formatVersion` to `0.0.0` or `999.0.0` | dry-run refuses; does not guess schema from source commit |
| A9 | Double-import idempotency | Restore the same artifact twice into the same empty-then-filled target | second run: all records `unchanged`; zero `created`; zero `conflicted`; totals unchanged. This is the restore-identical-noop contract, a fourth idempotency semantic |
| A10 | Dry-run makes no writes | See 4.1 | proof recorded; any write fails the test |
| A11 | Secrets-absence scan | After export, grep the artifact (JSONL + manifest + verification + embedded bytes filenames) for: bcrypt hashes (`$2a$`/`$2b$`), `gcw_` folio tokens, ntfy bearer strings, `apiKeys.anthropic` / `google`, `token_hash` hex, JWT-shaped session cookies | any hit fails Step 1. `app_users` rows may exist without `password_hash`. `gnucash_sync_settings.api_token` must be null/absent. `user_settings.ai_provider_config` must lack `apiKeys` or have empty values |
| A12 | jsonb key-order / number-format | Fixture: `canvas_layout` / `pests` / `treatments` / `forecast` / `account_mapping` with unsorted keys, `1.0` vs `1`, `1e2` vs `100`, `-0`, duplicate keys, `null` vs missing | export canonicalizes; restore + re-export digest-equals. A test that inserts jsonb via raw SQL with a different key order must still match. See 4.2 |
| A13 | Timezone edge cases | See 4.3 | timestamps equal as instants; `date` columns equal as calendar dates in UTC session |
| A14 | Trigger order | Restore a movement that names a bottling run before the run exists (importer bug) | 00047 `23514`; per-record error, transaction aborted, no partial file |
| A15 | Equipment insert at non-zero | Insert `equipment_stock.total_owned = 5` with no adjustments | 00006 `equipment_stock_reconcile_guard` `23514`. The importer must not take this path |
| A16 | Settlement paid > owed | | 00024 CHECK fails with a per-record error |
| A17 | BOM cycle | component of itself transitively | 00046 `23514` |
| A18 | Mite-count unique vs tombstone | Two live standalone counts same hive/date/method | 00036 unique violation. A live + a `deleted_at` row with the same key **must** restore |
| A19 | Treatments jsonb vs events | Inspection jsonb without matching live `treatment_events`, or vice versa | reference-check fail (00034 reconciliation rule) |
| A20 | SyncEnabled refusal | On the restored DB, with Wave 1 server: `sync_enabled = false`, call `handleGnuCashSyncNow` and `handleGnuCashRowPush` | HTTP refusal; no folio write; cursor unchanged |
| A21 | Guarded restore vs ordinary PUT | Ordinary PUT with a new token still clears cursor (existing test). Guarded restore command with matching book GUID keeps cursor | both behaviors pinned |
| A22 | `last_synced_at` last-attempt | Source row has `last_synced_at` set after a failed pull | restored value equals source; verification labels it last-attempt, not last-success (00044 vs per-row `external_sync.last_synced_at`) |

### 4.1 Dry-run-makes-no-writes proof

Do **not** use `pg_stat_user_tables.n_tup_ins` / `n_tup_upd` /
`n_tup_del` as the oracle. PostgreSQL increments those counters for
rows that later abort, so a dry-run that inserts-and-rolls-back looks
like a write.

Do **not** use `txid_current()` / `pg_current_xact_id()` alone: assigning
an xid is not a committed write, and a `READ ONLY` transaction that never
writes may still show xid movement depending on version.

**Required combined proof (Wave 2 test):**

1. **Code contract:** dry-run code path issues no `INSERT`/`UPDATE`/`DELETE`/
   `TRUNCATE`/`COPY` (enforced by a test double around the Wave 1 unit-of-work
   that panics on write). This is necessary but not sufficient.
2. **Session contract:** if dry-run touches Postgres at all, the connection
   sets `default_transaction_read_only = on` (or `SET TRANSACTION READ ONLY`
   before any statement). A write then raises `25006`. The test asserts that
   injecting a probe `INSERT` into that session fails with `25006`.
3. **Content contract (the gate-level proof):** before and after dry-run,
   compute a per-table content fingerprint of every user table in `public`
   except `goose_db_version`:

   ```sql
   SELECT c.relname,
          COUNT(*)::bigint AS n,
          COALESCE(
            md5(string_agg(sub.h, ',' ORDER BY sub.h)),
            'empty'
          ) AS fingerprint
   FROM pg_class c
   JOIN pg_namespace n ON n.oid = c.relnamespace
   LEFT JOIN LATERAL (
     SELECT md5(t::text) AS h FROM public.<table> t
   ) sub ON true
   WHERE n.nspname = 'public' AND c.relkind = 'r'
   GROUP BY 1;
   ```

   The driver generates that SQL from `information_schema.tables`. Before
   and after fingerprints must be identical, including counts. Run this
   against the **target** if dry-run connected, and against the **source**
   always (dry-run must not use the source at all; the fingerprint proves
   it).

4. Optional witness, never the oracle: `pg_stat_database.xact_commit` may
   rise (a read-only transaction still commits). Treat a rise in
   `tup_inserted`/`tup_updated`/`tup_deleted` as a **signal to
   investigate**, not as automatic failure, because stats include aborted
   work and background workers.

The gate report stores the before/after fingerprint maps.

### 4.2 jsonb / number-format traps

Postgres `jsonb` stores objects with sorted keys and normalizes numeric
literals. `jsonb ' {"b":1,"a":1.0} '` reads back as `{"a": 1, "b": 1}`.
If the exporter digests `json.RawMessage` from `pgx` without
canonicalizing, the re-export digest diverges even when the operator
changed nothing.

Canonicalization rules the Wave 1 spec must define and this gate asserts:

- Objects: keys sorted UTF-8, no insignificant whitespace.
- Arrays: order preserved (treatments/pests arrays are ordered facts).
- Numbers: shortest round-trip decimal (no trailing `.0`; no scientific
  notation; `-0` → `0`; reject NaN/Infinity — they cannot be jsonb).
- `null` vs missing key: missing is not `null`; both are distinct in the
  digest.
- Duplicate keys: illegal in the JSONL; dry-run fails.
- `photos.tags`, `canvas_layout`, `forecast`, mapping columns, and
  `ai_provider_config` (after `apiKeys` stripped) all go through the same
  encoder.

A Wave 2 fixture should `INSERT` a row with `'{ "z": 1.0, "a": 1 }'::jsonb`
and prove export digest equals a second insert of `'{ "a": 1, "z": 1 }'::jsonb`.

### 4.3 Timezone edge cases

| Trap | Why it exists | Gate rule |
|---|---|---|
| Naive timestamps in legacy data | `cmd/migrate-legacy` already `SET TIME ZONE 'UTC'` because legacy `now()` was UTC-container naive | export/import sessions set UTC; process `TZ=UTC` |
| `timestamptz` vs `date` | `inspections.date` is timestamptz (00001); `harvest_lots.extraction_date` and `bottling_runs.bottled_date` are `date` (00002); 00005 backfilled `bottled_date = (movement.date AT TIME ZONE 'UTC')::date` | timestamptz → ISO 8601 with `Z`; date → `YYYY-MM-DD` with no conversion. Digest the calendar date, not a midnight instant |
| DST / offset | weather_snapshot stores a named timezone (00003; `routes_inspections.go`) | the name is a semantic field; do not convert the snapshot's local clock into UTC and back |
| Year buckets | known ASI/review hazard: `EXTRACT(YEAR …)` uses session TZ | comparator never re-derives year from timestamptz in a non-UTC session |
| `updated_at` triggers | `set_updated_at()` (00001) would stamp restore time | bypass during restore (Step 4) |
| Scale readings | `scale_readings.reading_date date` + `imported_at timestamptz` (00027) | date stays a date even if imported_at is 23:00 UTC |

Fixtures: an inspection at `2025-12-31T23:30:00Z` and a lot
`extraction_date = 2026-01-01`; a harvest movement whose timestamptz falls
on a different UTC date than a local US/Eastern date. Digests must follow
the UTC/date rules above, not the operator's laptop TZ.

---

## 5. Disposable-database plan

### 5.1 Databases this repo already has

| Database | How it appears | Gate may use it as |
|---|---|---|
| `beeztrackz` on compose volume `postgres_data` (`docker-compose.yml`, user/password `beeztrackz`) | working development database, `DATABASE_URL` | **source only**, never as restore target, never truncated |
| URL in `TEST_DATABASE_URL` (CI: `postgres://beez@localhost:5432/beez_trackz_test?sslmode=disable`, Postgres 16) | shared by `go test -p 1`; honey tests `TRUNCATE` a subset (`honey_integration_test.go`); equipment tests roll back a transaction on the same DB | **admin URL** for `CREATE DATABASE`, not the gate's data plane. Do not `TRUNCATE` it |
| Sibling names created by `freshDatabase` (`beez_money_migration`, `beez_ledger_migration`, `beez_ext_sync_types`, …) | `DROP DATABASE IF EXISTS` / `CREATE DATABASE` / connect via `replaceDatabase` | **the pattern to copy** |

`freshDatabase` (cite `backend/internal/db/money_migration_test.go`):

1. Connect to `TEST_DATABASE_URL` as admin.
2. `DROP DATABASE IF EXISTS <name>; CREATE DATABASE <name>;`
3. Rewrite the URL path (keep the query string, e.g. `sslmode=disable`).
4. Return a pool plus a cleanup that drops the database.

The gate driver uses a **distinct** name, e.g. `beez_roundtrip_gate`, so it
cannot collide with in-process migration tests. It never runs against the
admin database's existing tables.

### 5.2 How the gate runs without touching the working database

```
SNAPSHOT_SOURCE_URL  →  existing operator/dev DB (read; export only)
TEST_DATABASE_URL    →  admin for CREATE/DROP
gate DB name         →  beez_roundtrip_gate (empty, goose 00001–00048, restore, re-export, DROP)
artifact paths       →  filesystem outside both databases
```

The working compose volume is not mounted into the gate. MinIO for the
gate should be a throwaway bucket **or** read-only access to the source
bucket for original hashes; restore of embedded originals writes into the
throwaway bucket, never into the operator's bucket, unless the operator
is running a manual rehearsal and has set an explicit
`GATE_MINIO_BUCKET`.

### 5.3 Skip behavior

Every Go test that opens Postgres starts with:

```go
if os.Getenv("TEST_DATABASE_URL") == "" {
    t.Skip("TEST_DATABASE_URL is not configured")
}
```

The Wave 2 driver test does the same. File-only adversarial cases (A1, A2,
A8, A11, A12 without SQL) do not skip.

### 5.4 Time zone

- Process: `TZ=UTC` (house rule; CI should set it on the Go test step when
  Wave 2 lands — today `.github/workflows/deploy.yml` does not, which is
  why this design requires the driver to set it itself via
  `t.Setenv("TZ", "UTC")` on Go 1.17+ or a documented `os.Setenv` at
  `TestMain`).
- Session: `SET TIME ZONE 'UTC'` on source export connections, target
  restore connections, and comparison probes, matching
  `cmd/migrate-legacy`.

### 5.5 Isolation from `go test -p 1` TRUNCATE

Do not restore into `TEST_DATABASE_URL`'s database. Honey tests truncate
sales/lots/movements and would destroy a gate in progress. The gate DB is
created, used, and dropped inside one test function, like
`TestMoneyMigrationConvertsExistingRows`.

### 5.6 What "empty" means

After goose: catalogs may contain **seeds** (home `stock_locations`,
`treatment_products`). Those are not operator data. Step 4 requires
preserved IDs to win (delete seeds, insert snapshot rows). After that,
`apiaries`, `hives`, `sales`, `honey_movements`, `photos` are empty until
the importer writes them. `user_settings` singleton (00012) may exist as
an empty row; the importer upserts the snapshot singleton by replacing
the row, never inserting a second (`user_settings_singleton` unique index
on `(true)`).

---

## 6. Acceptance sign-off (one-to-one with the roadmap paragraph)

Roadmap **Acceptance criteria** (P0), split into atomic checks. The gate
is passed only when every row is `pass`. Rows marked **Wave 2** cannot
pass until the importer/driver exist; rows marked **folio / P1** cannot
pass until those dependencies land. They remain on this list so they
cannot be quietly dropped.

| # | Roadmap clause | Sign-off check | When it can pass |
|---|---|---|---|
| C1 | The format and every exported domain are documented | Format spec (Wave 1 sibling) lists every table in §2.1; this document is the gate procedure | Wave 1 (docs) + Wave 1 spec |
| C2 | `verification.json` carries versioned per-record digests, reference checks, baseline aggregates, hashes, and their calculation definitions | Emitter output for a fixture contains: per-record `{domain, id, algoVersion, digest}`; reference tuples; legacy **and** new-ledger aggregate families with definition ids, units, rounding, sign, included statuses, exporter version; media hashes; residual-split mapping (may be empty until P1) | Wave 1 emitter |
| C3 | The artifact contains no secrets and is encrypted/access-controlled as sensitive data | A11 scan clean; operator runbook: encrypt at rest, restrict to restore process, checksums separate from credentials, retention/disposal of superseded copies. Encryption is an operator wrapping step, not a new subsystem | Wave 1 export + operator procedure |
| C4 | All embedded content hashes verify and all required external media originals resolve, with any accepted omission individually classified and recorded | §3.6; A6/A7 | Wave 1 export + Wave 2 gate |
| C5 | Dry run makes no writes | §4.1; A10 | Wave 2 importer |
| C6 | Two imports of the same artifact are safe | A9; second pass all `unchanged` | Wave 2 importer |
| C7 | Corrupt, dangling, incompatible, and conflicting records produce actionable errors | A1–A5, A8, A14–A19 | Wave 2 importer |
| C8 | The disposable round trip proves semantic equality for every preserved-ID record as well as the count, reference, inventory, financial, production, and media checks | Steps 1–6; matrix §3; family = legacy on this rehearsal | Wave 2 driver |
| C9 | Restored GnuCash mappings and cursors — after the entity re-key and content-hash rebaseline, through the guarded restore flow, against the folio verification API — pass a no-create/no-overwrite reconciliation before sync is enabled | **Split:** (C9a) same-schema: mappings/cursor round-trip, token absent, `sync_enabled = false`, Wave 1 server refusal, guarded restore does not wipe cursor (Step 8, A20/A21/A22). (C9b) new-schema: versioned re-key of the nine dissolving 00041 types (`jar_size`, `honey_movement`, `bottling_run`, `stock_location`, `stock_movement`, `equipment_stock`, `equipment_stock_adjustment`, `product_batch`, `product_adjustment`); content-hash rebaseline against unchanged `remote_transaction_guid`/`remote_enter_date`; folio verify-by-external-ID no-write plan | C9a: Wave 1 + Wave 2. C9b: P1 + folio parallel work |
| C10 | The validated artifact plus report can restore the useful current data without any dependency on the old tables or migration chain | True only after the **P1 clean-baseline** restore (new goose chain, same importer, new-ledger family, declared residual splits). This rehearsal proves the artifact is sufficient **relative to the current chain**; it does not by itself retire 00001–00048 | P1 reset, using this gate's driver |

### 6.1 Reset policy (after C8 passes, still before C10)

From the roadmap, operationalized:

1. If source data changed after the rehearsal, take a **fresh** snapshot
   and repeat Steps 1–6. The previous artifact is retained, not overwritten.
2. Restore with GnuCash sync disabled; leave it disabled through
   post-restore reconciliation (C9).
3. Restoration uses the canonical importer, never one-off SQL and never
   `cmd/migrate-legacy`.
4. Keep the validated artifact and the gate report **outside** the
   database being replaced.
5. Only then is it acceptable to replace the development database and
   squash migrations. That act is P1, not Wave 1/2.

---

## 7. Wave 1 vs Wave 2 vs later — what this document does not build

Wave 1 (this Polyagent wave) lands the **design** (this file) plus, in
sibling worktrees: the format spec, `backend/internal/snapshot`, the
export CLI, the `verification.json` emitter, `backend/internal/app`
restore foundation, the GnuCash guarded restore command, and the
server-enforced `SyncEnabled` gate.

Wave 2 builds the importer and the driver that executes sections 2–5, and
files the C1–C8 / C9a sign-offs.

P1 + folio complete C9b and C10. Residual-to-opening-balance splits and
`legacy-unassigned` lots become explained differences only on that
restore.

Until Wave 2 exists, no round-trip has been executed. This file is the
contract those binaries must satisfy.

---

## 8. Fixture notes for the Wave 2 driver (non-normative for Wave 1)

A minimal fixture that still stresses the matrix, once Wave 2 can seed a
throwaway DB:

- One apiary, two hives, a queen with `parent_queen_id`, an inspection
  whose `treatments` jsonb reconciles to two `treatment_events` (00034)
  plus a soft-deleted third event (00037).
- A harvest session with a true-up (00005), a `direct_weight` harvest
  (00011), a lot with `honey_weight_source = derived` (00039), a bottling
  run, a voided run (00023), serials sold and unsold (00009).
- Honey movements: attributed jarring, an unattributed historical
  `lot_id IS NULL` draw (00047 residual), a reversal pair (00005).
- Home + one consignment location, a transfer pair, a consignment sale
  (`stock_location_id` set, 00024), collected-vs-invoiced gap.
- A catalog SKU batch, a voided batch (00030), a product_adjustments
  shrink, propolis harvest in ounces (00026 generated grams).
- Equipment type + BOM line (00046), stock inserted via adjustments
  (00006), a damaged state change, packaging type linked to a jar size
  (00048).
- One MinIO photo original + thumbnail (thumbnail excluded from hash
  gate), one Immich-backed photo if the fixture can fake the resolver,
  one media_file + transcript version with `current_transcript_version_id`
  set in post-pass (00017).
- `external_sync` rows for `sale` and `expense` with `content_hash` /
  `remote_enter_date` (00045); `gnucash_sync_settings` with cursor and
  token present **on the source** so the exporter can prove the token
  was stripped.
- `user_settings.ai_provider_config` with both task providers and
  `apiKeys.anthropic` so the scan proves per-key exclusion.

The fixture is constructed with the Wave 1 restore actor or with SQL
inside the throwaway DB, **not** by calling public HTTP creates (those
cannot set preserved IDs — review B1).

---

## 9. Citations (migrations and code)

| Claim | Where |
|---|---|
| Schema ceiling 00048 | `00048_packaging_inventory.sql` |
| Home is a residual, not a pile of rows | `00024_stock_locations.sql` header; `honey_ledger.go` `stockAwayQuantities` |
| Unassigned bulk residual | `00047_honey_lot_balances.sql` header; `routes_honey_varietals.go` |
| Bulk-on-hand formula + pound tolerance | `honey_ledger.go` `honeyBulkOnHand`, `honeyPoundTolerance` |
| Jar on-hand formula | `routes_honey.go` `honeyJarInventoryWithQuerier` |
| SKU on-hand formula | `routes_products.go` `productInventoryQuery`; `00030` comment |
| Propolis grams | `routes_products.go` `propolisOnHandGrams`; `00022` `net_grams`; `00026` generated grams |
| Equipment totals + insert-at-zero guard | `00006_equipment_ledger.sql` `equipment_stock_reconcile_guard` |
| Lot/run trigger | `00047` `honey_movement_lot_matches_run` |
| No-FK transcript pointer | `00017_source_retained_media.sql` |
| Reversal FKs (they **are** FKs) | `00005` `honey_movements.reverses_movement_id`; `00024` `stock_movements.reverses_movement_id` |
| Photo originals vs renditions | `00001` keys; `00017` `photos_original_backend_ck` |
| jsonb columns | 00001, 00002 (`harvest_lots.testing_data`), 00003, 00005, 00044 |
| Secrets | 00001/00013 password hashes; 00003 `api_tokens`; 00031 ntfy token; 00044 GnuCash token; `ai/config.go` `apiKeys` |
| `SyncEnabled` unenforced; PUT clears cursor | `routes_gnucash_sync.go`; 00044 |
| `content_hash` semantics | `00045_external_sync_push_state.sql` |
| Entity-type allowlist including nine dissolving types | `00041_external_sync_entity_types.sql` |
| `last_synced_at` last-attempt | 00044 `gnucash_sync_settings.last_synced_at`; per-row success is `external_sync.last_synced_at` (00005) |
| No payments table | 00024; roadmap correction |
| Treatments three stores + 00034 index | 00001 jsonb; 00002/00037 events; 00019 products; 00034 `treatment_events_inspection_id_idx` |
| Soft-delete unique mite counts | 00036 |
| `freshDatabase` / `TEST_DATABASE_URL` skip | `money_migration_test.go`; `db_integration_test.go`; CI `deploy.yml` |
| UTC session | `cmd/migrate-legacy/main.go` |
| `go test -p 1` deadlock reason | `.github/workflows/deploy.yml` comment; 00015 hive/sale FKs |
| Importer is not HTTP and not `migrate-legacy` | roadmap P0 importer contract; review B1 |
