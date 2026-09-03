# Beez Trackz restore runbook

Operator procedure for the P0 portable snapshot: take an artifact, prove it
round-trips, restore through the canonical importer, then reconfigure secrets
and GnuCash. This is not a `pg_dump` restore and it is not
`backend/cmd/migrate-legacy` (that copier is out of the importer contract and
copies `password_hash`). Restoration goes through domain services under
`backend/internal/app/` as the privileged system-restore actor. No HTTP create
endpoint will accept preserved IDs or audit timestamps.

The format contract is `docs/snapshot-format.md` (`formatVersion: 1`). The
ordered gate, comparison matrix, adversarial cases A1–A22, and disposable
database plan in `docs/plans/2026-09-01-roundtrip-gate-design.md` are binding.
The reset policy is the roadmap paragraph **Reset policy after the gate** in
`docs/product-roadmap.md`. Phase A of the inventory ledger (additive backfill
and freeze) is section 6; its binding spec is
`docs/plans/2026-09-01-inventory-ledger-design.md` §9, and the exact writer /
reader / freeze-set checklist is
`docs/plans/2026-09-02-ledger-read-path-migration.md`. Phase B (squash to
`00001_baseline.sql`, drop the frozen tables, recreate every database, restore)
is section 7; its binding spec is the same §9, steps 6-9.

Run every Go command with `TZ=UTC`. Do not restore into the compose working
database `beeztrackz` on volume `postgres_data`.

## What exists now vs what is landing in this wave

| Piece | Status | Authority |
|---|---|---|
| Format, exporter, `verification.json`, media manifest | Wave 1, in this tree | `docs/snapshot-format.md`, `backend/internal/snapshot/`, `backend/cmd/export-snapshot/` |
| Restore driver, typed errors, system-restore actor | Wave 1, in this tree | `backend/internal/app/doc.go`, `backend/internal/app/restore.go` |
| GnuCash guarded restore HTTP + `SyncEnabled` write refusal | Wave 1, in this tree | `backend/internal/httpapi/routes_gnucash_sync.go` |
| `import-snapshot` CLI | **Landing in this wave** | Shared CLI contract below; implementation `backend/cmd/import-snapshot/` |
| `roundtrip-gate` CLI | **Landing in this wave** | Assignment flags below; implementation `backend/cmd/roundtrip-gate/`; procedure `docs/plans/2026-09-01-roundtrip-gate-design.md` sections 2 and 5 |
| `gnucash_sync_settings.restore_state` and mark-reconciled | **Landing in this wave** | `backend/internal/db/legacy-00001-00052/00049_gnucash_restore_state.sql` and `backend/internal/httpapi/routes_gnucash_sync.go` |
| Ledger tables, views, seeded locations (incl. virtual `deployed`), nullable item/lot links, `equipment_types` catalog attributes | Wave 1, in this tree (2026-09-02) | `backend/internal/db/legacy-00001-00052/00050_inventory_ledger.sql` |
| `schema_generation` stamp + generation guard | Wave 1, in this tree (2026-09-02) | `backend/internal/db/legacy-00001-00052/00051_schema_generation.sql`, `backend/internal/db/generation.go`, `db.ConnectWithOptions` |
| `app/inventory` (`Record` / `Reverse` / `CheckAvailable`, builders, queries, checkpoints) | Wave 1, in this tree (2026-09-02) | `backend/internal/app/inventory/` (`doc.go`, `build/build.go`, `service.go`, `types.go`) |
| Phase B baseline `00001_baseline.sql`, the `BEEZ_SCHEMA_BASELINE` profile switch, and the dropped-by-baseline declaration | In this tree (2026-09-03), **not yet applied to any database** | `backend/internal/db/migrations/00001_baseline.sql`, `backend/internal/db/schema_profile.go`, `backend/internal/db/baseline_domains.go`; procedure section 7 |
| `import-snapshot -backfill-ledger` (Phase A in-place translation, residual splits, freeze) | **Landing in this wave** | `backend/cmd/import-snapshot/main.go` for the authoritative flags; spec §9 Phase A; tests named in spec §12 |

Where a flag, report field, or refusal is not yet in this tree, this runbook
names the file to re-read after that binary lands. It does not invent flags.

### `import-snapshot` (landing in this wave)

```text
import-snapshot -input <snapshot-dir> -database <postgres-url> \
  [-dry-run] [-conflict-policy fail|skip|overwrite] [-report <path>]
```

- Exit 0 only on full success. A dry run that validates is success.
- Nonzero on any validation, reference, digest, or restore failure.
- Always writes a JSON restore report to `-report`. Default is
  `./restore-report.json` (current working directory). Writing
  `<input>/restore-report.json` is forbidden: never write inside the snapshot
  artifact. Prefer an absolute path beside the wrapping checksum, outside the
  artifact.
- Applies goose migrations to the target if it is behind.
- Refuses a non-empty database unless `-conflict-policy` is `skip` or
  `overwrite`. Default policy is `fail`. Exact emptiness check: read
  `backend/cmd/import-snapshot/` after it lands.
- Dry run makes no writes: `SET TRANSACTION READ ONLY` and/or a transaction
  that is always rolled back, plus repositories that skip writes when
  `UnitOfWork.DryRun` is set (`backend/internal/app/uow.go`,
  `backend/internal/app/restore.go`). Do not use `pg_stat_*` tuple counters as
  proof (gate design section 4.1).

The report lists created / unchanged / updated / skipped / conflicted / failed
per record, plus missing media and excluded configuration
(`backend/internal/app/restore.go` `Report`).

`-backfill-ledger` is a **separate** Phase A mode of this same binary, landing
in this wave. It is not part of the P0 restore contract above. Do not invent
companion flags for it. After it lands, re-read
`backend/cmd/import-snapshot/main.go` for the authoritative flag set, then
follow section 6.

### `roundtrip-gate` (landing in this wave)

```text
roundtrip-gate -database <admin-url> -workdir <dir> [-keep] [-skip-media]
```

- `-database` is an admin URL used only to `CREATE DATABASE` / `DROP DATABASE`.
  The driver never restores into that URL. Disposable name follows the
  `beez_roundtrip_gate` pattern in gate design section 5.
- `-workdir` receives the source artifact, the re-export, the wrapping
  checksum, the gate report JSON, and the human summary. Keep this directory
  outside both the source database and the disposable target.
- `-keep` leaves the disposable database in place instead of dropping it.
- `-skip-media` is a Wave 2 driver flag. Read `backend/cmd/roundtrip-gate/`
  for what it skips. A destructive reset still requires every required original
  to resolve or to be classified in the artifact (`docs/snapshot-format.md`
  media section).
- How the driver selects the **source** database (the design allows
  `SNAPSHOT_SOURCE_URL`, or defaulting to `DATABASE_URL` for a manual
  rehearsal) is part of the Wave 2 binary. Read `backend/cmd/roundtrip-gate/`
  rather than guessing a `-source` flag.
- The driver exports through `backend/internal/snapshot` and invokes the
  importer strictly as the `import-snapshot` CLI above.

---

## 1. Taking a snapshot safely

### Preconditions

1. Process environment: `TZ=UTC`.
2. Source is the live operator/dev database you intend to preserve. The
   exporter opens it with `db.ConnectWithoutMigrations` and a repeatable-read,
   read-only transaction, then `SET LOCAL TIME ZONE 'UTC'`
   (`backend/internal/snapshot/exporter.go`). It will not migrate the source.
3. Decide the `-hash-minio` tradeoff before you start (below).
4. Choose an output path that does not already exist. The exporter creates the
   directory itself (`os.Mkdir`, mode `0700`) and fails if the path is present.
5. Have operator-controlled storage ready that is **not** the Postgres data
   volume and **not** the database you may later replace.
6. Know which **schema generation** the source is. Every entry point checks it
   (section 1.1). If the source predates the `schema_generation` stamp, the
   export needs `--legacy-source`; if it does not, do not pass the flag.

### 1.1 The schema generation guard, and `--legacy-source`

Goose answers "which migrations ran", not "is this the schema this binary was
built for". Those two questions come apart at the ledger reset: a database
still sitting at the head of the *old* chain looks healthy to `goose up`
against the *new* one, so the process would happily serve a schema that
predates the ledger (design review A6).

Migration `00051_schema_generation.sql` closes that hole. It creates a one-row
`schema_generation` table stamped with this binary's generation (`ledger-v1`).
`backend/internal/db/generation.go` classifies any database:

| What the database looks like | Generation | Result |
|---|---|---|
| `schema_generation` holds exactly `ledger-v1`, goose head equals the embedded head | `ledger-v1` | accepted everywhere |
| no `schema_generation` table at all | `legacy` | refused everywhere except `--legacy-source` |
| row deleted, rewritten, or duplicated | mismatch | refused everywhere |
| right stamp, foreign goose head (another build migrated it) | mismatch | refused everywhere |

The expected goose head is **derived from the embedded migrations at start-up**,
never written down, so adding a migration cannot leave the guard behind.

`server`, `worker`, `set-password`, `import-snapshot` (dry run and real), and
the round-trip gate's **disposable target** all take the strict path. The
refusal is one line naming actual beside expected, for example:

```text
schema generation guard: missing-generation-table (actual legacy, expected ledger-v1); this database predates the schema_generation stamp; recreate it from the current migrations, or read it with export-snapshot --legacy-source
```

**The one exception is read-only.** `export-snapshot --legacy-source` and
`roundtrip-gate -legacy-source` (the **source** connection only) accept
generation `legacy`, and only on a pool opened with
`SET default_transaction_read_only = on`. The guard re-reads that setting
before granting the exception, and any write on such a connection fails with
SQLSTATE `25006`. `import-snapshot` and `worker` never accept it, with or
without a flag: they are writers.

Migrating a pre-stamp database *forward* through the ordinary chain is still
normal — `db.Connect` applies 00051 and stamps it. The guard refuses a foreign
generation; it does not refuse the chain.

> **Recreate all databases once.** When this guard lands, every developer, CI,
> and test database created before it must be dropped and recreated from the
> current migrations (`DROP DATABASE x; CREATE DATABASE x;`, then let `server`
> or `import-snapshot` migrate it). A database merely migrated forward is
> fine; one restored or copied from another chain is not, and will be refused
> at start-up rather than silently served. The same applies again at the Phase
> B squash, when the generation changes.

### Export CLI

From `backend/`:

```text
TZ=UTC go run ./cmd/export-snapshot \
  -database-url <postgres-url> \
  -output <new-directory> \
  [-app-commit <git-sha>] \
  [-exporter-version snapshot-export-v1] \
  [-business-timezone <IANA-name>] \
  [-currency USD] \
  [-hash-minio] \
  [-minio-endpoint localhost:9000] \
  [-minio-bucket beeztrackz-media] \
  [-minio-access-key ...] \
  [-minio-secret-key ...] \
  [-minio-use-ssl] \
  [-legacy-source]
```

Flags as implemented in `backend/cmd/export-snapshot/main.go`:

| Flag | Default | Notes |
|---|---|---|
| `-database-url` | `DATABASE_URL` | Required. This is **not** the importer's `-database` flag. |
| `-output` | `snapshot-` + UTC `20060102T150405Z` | Must be a new directory. |
| `-app-commit` | `APP_COMMIT`, else Go `vcs.revision`, else `unknown` | Recorded in `manifest.json`. |
| `-exporter-version` | `snapshot-export-v1` | `snapshot.ExporterVersion`. |
| `-business-timezone` | `BUSINESS_TIMEZONE` or `UTC` | Named IANA zone for date-only business fields. Invalid names fail the export. |
| `-currency` | `CURRENCY_CODE` or `USD` | Uppercased; must be a three-letter ISO 4217 code. |
| `-hash-minio` | `false` | See tradeoff below. Requires access and secret keys. |
| `-minio-endpoint` | `MINIO_ENDPOINT` or `localhost:9000` | Used only with `-hash-minio`. |
| `-minio-bucket` | `MINIO_BUCKET` or `beeztrackz-media` | Used only with `-hash-minio`. |
| `-minio-access-key` | `MINIO_ACCESS_KEY` | Required with `-hash-minio`. |
| `-minio-secret-key` | `MINIO_SECRET_KEY` | Required with `-hash-minio`. |
| `-minio-use-ssl` | `MINIO_USE_SSL` | TLS to MinIO. |
| `-legacy-source` | `false` | Read a source of the **previous** schema generation. Opens the pool `default_transaction_read_only = on`; the guard verifies that before accepting, and writes fail `25006`. Use it only when a strict run refused with `missing-generation-table`. |

Pass: the process prints `snapshot written to … (formatVersion=1, domains=…, migration=…)` and exits 0. `manifest.json` is written last. Domain files are mode `0600`.

Fail: missing URL, MinIO hashing requested without keys, invalid timezone or
currency, inability to create the output directory, or any export error. Do
not "fix" a partial directory; delete it and export again.

### `-hash-minio` tradeoff

The restoration boundary is originals: photo `original_key` / `original_ref`,
audio `audio_key`, and Immich `original_external` references. Thumbnails and
medium keys are listed only as `derivedRenditions` and are excluded from the
hash gate.

| Mode | What the artifact records | When to use it |
|---|---|---|
| `-hash-minio` off (default) | MinIO originals: `hashState: unhashed`. Immich originals: `external-unverified`. | Fast local export while you still have the bucket. The destructive-reset gate still has to resolve required originals later. |
| `-hash-minio` on | MinIO originals: `verified` with bytes and SHA-256, or `missing-or-unreadable` with a reason. Immich stays `external-unverified` until a resolver proves them. | Any artifact you might reset from. Missing objects show up at export time so you can classify them before the gate. |

A required original that is missing or unresolved **fails the destructive-reset
gate** unless that exact owner and reference is classified, accepted, and
recorded in the artifact (and later in the gate report). Classifying after
deletion is too late.

Apiary satellite overlays are not in the boundary (dropped by migration
00032).

### What the artifact contains, and what it does not

Layout (`docs/snapshot-format.md`):

```text
<output>/
  manifest.json
  verification.json
  media-manifest.json
  domains/
    <one UTF-8 JSONL file per registered domain>
```

`manifest.excludedConfiguration` is the reconfiguration checklist. At export
it is (`backend/internal/snapshot/registry.go`):

- `app_users`: `auth_subject`, `password_hash` — login identities and password
  hashes must be reconfigured.
- `user_settings`: `password_hash`, `ntfy_access_token`,
  `ai_provider_config.apiKeys.anthropic`, `ai_provider_config.apiKeys.google`
  — passwords, notification tokens, and AI provider credentials are excluded
  per key. Safe keys `ollamaUrl` and `whisperUrl` remain.
- `gnucash_sync_settings`: `api_token` — re-enter through guarded restore.

Omitted domains (declared, not silent): `api_tokens`, `oidc_identities`,
`ntfy_dispatches`, `sessions`, `payments` (no such table), deletion
tombstones, and stored external-write idempotency keys.

The artifact still holds customer, financial, transcript, sync, and media
metadata. Treat it as sensitive data.

### Where to store it, and encryption at rest

1. Copy the directory (or an archive of it) to operator-controlled storage
   **outside** the database being replaced and **outside** compose volume
   `postgres_data`.
2. Encrypt at rest and in transit. Version 1 may travel as an encrypted
   archive (age or gpg — not a Beez crypto subsystem) provided extraction
   reproduces the exact file bytes and paths.
3. Keep wrapping checksums **separate from decryption credentials**.
   Credentials are never stored beside the checksums
   (`docs/snapshot-format.md` security section; gate design step 2).
4. If you encrypt: checksum the ciphertext **and** keep a plaintext checksum
   of the directory files inside the encrypted payload.
5. Restrict access to restore operators. Retain only under the backup policy.
   Securely dispose superseded copies; do not overwrite a validated artifact
   with a newer one in the same path.
6. Do not put restore reports, gate reports, or wrapping checksums inside the
   snapshot directory.

---

## 2. Verifying an artifact standalone

Do this on the stored copy, not by trusting the exporter's in-process hashes
as the only check. Abort on the first failure; do not repair `manifest.json`.

### 2.1 Independent file checksums (available now)

`manifest.json` links every other canonical file by SHA-256: each
`domains/*.jsonl`, `media-manifest.json`, and `verification.json`. Recompute
SHA-256 over the complete file bytes (JSONL hashes include the trailing LF on
every line, including the last). Compare to `files[].sha256`,
`mediaManifest.sha256`, and `verification.sha256`.

Pass: every hash matches, `formatVersion` is `1`, every registered domain file
is present (empty domains are empty files, not omitted files), and
`schemaMigration` equals the source's applied goose ceiling (Wave 1 expected
48; after Wave 2's `00049_gnucash_restore_state.sql` a new export will record
that ceiling).

Fail: any byte mismatch. Re-export. Do not edit the manifest to match the
files.

### 2.2 Secrets-absence scan (available now)

Grep the artifact (JSONL, manifest, verification, embedded filenames) for:

- bcrypt hashes (`$2a$` / `$2b$`)
- folio tokens (`gcw_`)
- ntfy bearer strings
- `apiKeys.anthropic` / `apiKeys.google`
- `token_hash` hex
- JWT-shaped session cookies

Any hit fails the export (gate A11). `app_users` rows may exist without
`password_hash`. `gnucash_sync_settings.api_token` must be absent.
`user_settings.ai_provider_config` must lack those credential keys.

### 2.3 Importer dry run (landing in this wave)

```text
TZ=UTC go run ./cmd/import-snapshot \
  -input <snapshot-dir> \
  -database <target-url> \
  -dry-run \
  -report /safe/path/restore-report.json
```

This is the standalone validation the gate uses (design step 3). It must
validate format support, canonical bytes, file hashes, record digests, units,
IDs, references, secret omissions, media state, and dependency/post-pass
requirements **without writing**.

Preferred: validate without connecting to the source. A connection to a
target is allowed only as a read-only / always-rolled-back session.

Pass: exit 0, report has zero `failed` and zero `conflicted`, and the no-write
proof holds.

Fail: any validation error. Dry run must not repair data. Read the report's
per-record `kind` and `error` (application kinds: `invalid`, `not_found`,
`conflict`, `forbidden`, `precondition`, `unsupported`, internal).

There is no separate `verify-snapshot` command in this tree. Do not invent
one; dry-run **is** the verifier.

---

## 3. Full round-trip rehearsal (`roundtrip-gate`)

This rehearsal proves the artifact against a disposable empty database. It
does **not** replace the working database. Abort on the first failing step.

### Preconditions

1. `TZ=UTC`.
2. Admin-capable Postgres URL in `-database` (same role that can `CREATE
   DATABASE`, matching `freshDatabase` in
   `backend/internal/db/money_migration_test.go`). If the automated test
   driver has no `TEST_DATABASE_URL`, it skips and the gate is **not passed**.
3. Wave 1 export code and Wave 2 `import-snapshot` are buildable from the
   same tree. The driver builds or `go run`s `./cmd/import-snapshot`.
4. MinIO (and Immich, if any `photos.storage_backend = 'immich'` row exists)
   reachable **read-only** for original-byte hashing, unless you have accepted
   classified omissions and understand `-skip-media`.
5. GnuCash sync on the source may be enabled. The disposable target is created
   with `sync_enabled = false` and the importer must leave it false.
6. Know the source's schema generation (section 1.1). A source from before the
   `schema_generation` stamp needs `-legacy-source`; the disposable target is
   always strict, because the gate creates and migrates it itself.

### What the driver does (design section 2)

The operator runs one command:

```text
TZ=UTC go run ./cmd/roundtrip-gate \
  -database <admin-url> \
  -workdir /safe/path/gate-run \
  [-keep] [-skip-media] [-legacy-source]
```

`-legacy-source` relaxes the generation guard for the **source** connection
only, and only onto a read-only connection (section 1.1). It does not relax
the calendar: the source pool is still pinned to UTC. The disposable target is
never affected. When the source is behind the target, the gate records
`schema-migration-ahead` as an *explained* difference, not a failure —
record-digest equality is what proves the newer schema changed nothing.

Ordered steps, aborting on the first failure:

0. Preconditions above. Disposable database name `beez_roundtrip_gate` (or
   the name the binary actually uses — confirm in
   `backend/cmd/roundtrip-gate/`). Goose migrates that database through the
   current chain. Confirm it is empty of operator data (`apiaries`, `hives`,
   `sales`, `honey_movements` counts are 0 after goose; catalog seeds are not
   operator data).
1. Fresh snapshot from the source into `-workdir` (same exporter as
   section 1).
2. Independent checksum of the artifact (section 2.1).
3. `import-snapshot -dry-run` against the artifact (section 2.3). No-write
   proof recorded in the gate report (content fingerprints, not `pg_stat`).
4. Restore into the disposable empty database via `import-snapshot` (no
   `-dry-run`), conflict policy `fail`. Preserved IDs win over goose seeds
   (home `stock_locations`, `treatment_products`). GnuCash token stays absent;
   `sync_enabled` stays false.
5. Second identical import into the same target: every record `unchanged`,
   zero `created`, zero `conflicted` (idempotent no-op contract).
6. Re-export the disposable database into a second directory under
   `-workdir` (never overwrite the source artifact).
7. Compare source vs restored artifacts using the matrix in gate design
   section 3. Family for this same-schema rehearsal: **legacy**. Matching
   totals never substitute for per-record digest equality.
8. Adversarial suite is the test package, not this operator command.
9. GnuCash same-schema subset: mappings and cursor round-trip, token absent,
   `sync_enabled = false`, write endpoints refuse. Entity re-key, content-hash
   rebaseline, and folio verify-by-external-ID are **not** this rehearsal
   (deferred to P1 + folio).
10. Copy artifact, wrapping checksum, gate report, and re-export to operator
    storage. Drop the disposable database unless `-keep`. Do not `TRUNCATE`,
    migrate, or reconfigure compose `beeztrackz` as part of this rehearsal.

Pass: driver exit 0. Every comparison cell is equal or **explained**. Report
written in `-workdir`.

Fail: nonzero exit listing every failure. The working database is untouched.

### Reading the gate report

The driver writes a JSON report plus a human summary in `-workdir`. Exact
filenames: read `backend/cmd/roundtrip-gate/` after it lands. The report is
the equality oracle; do not re-query the source database to "confirm."

| Class | What it means | Operator action |
|---|---|---|
| File / manifest hash mismatch | Artifact bytes do not match `manifest.json` (A1). | Re-export. Do not edit the manifest. |
| Unsupported `formatVersion` | Decoder will not guess a table layout from `appCommit` (A8). | This build cannot import that artifact. |
| Parse / truncated JSONL | Domain file is not well-formed JSONL (A2). | Re-export. |
| Duplicate preserved ID | Two lines with the same `id` in one domain (A4). | Re-export after fixing source data; do not coin-flip. |
| Dangling reference | Required relationship missing inside the artifact (A3, section 3.2). | Fix source data, re-export. Dry run must fail before restore starts. |
| Digest mismatch | Same `(domain, id)` survived but canonical semantic fields differ. | Fail. Totals matching does not excuse this. |
| Absent / extra ID | Record missing or added under a new UUID (including a goose seed that was not replaced). | Fail unless the design's seed-identity remap applied and was recorded. |
| `updated_at` / audit drift | Restore trigger rewrote audit fields. | Fail. Restore must preserve `created_at` / `deleted_at` / `voided_at` and insert-time `updated_at`. |
| Unexplained aggregate delta | Legacy inventory, money, or production total differs beyond the definition's tolerance. | Fail. Explained differences are only those coded in the report (none on same-schema except the design's listed markers such as `legacy-unassigned` **kept as the same marker**). |
| Missing required media | Original 404 or hash mismatch, and that owner is not in the accepted-omission list (A6). | Classify and accept before a reset, or restore the object into MinIO/Immich and re-export. |
| Accepted omission | One classified missing original; the gate skips **that** original only (A7). | Confirm the report lists it. A second missing original still fails. |
| Rendition inequality | Thumbnail/medium digest differs. | Explained as regenerable. Do not fail the gate for a re-encoded thumbnail. |
| Conflicted preserved ID | Target already has that ID with different content (A5). | Gate uses policy `fail`. Do not skip or overwrite during rehearsal. |
| Idempotency failure | Second import created or conflicted rows (A9). | Importer bug; do not reset. |
| Dry-run wrote | Fingerprints changed or a write escaped the transaction (A10). | Importer bug; do not reset. |
| Secrets present | A11 scan hit. | Re-export after fixing the exporter; do not reset. |
| GnuCash token present / `sync_enabled` true on target | Restore violated the replay boundary. | Fail. |

`legacy-unattributed` and `legacy-unassigned` markers in the **source**
artifact must round-trip as the same markers. Inventing lots or actors to
"clean up" history fails the gate.

---

## 4. Actual reset procedure

The rehearsal above is not the reset. After C8 (disposable round trip) passes,
the roadmap **Reset policy after the gate** still applies, and C10 (restore
onto a clean baseline that no longer depends on migrations 00001–00048) is
**P1**, not this wave.

### Ordered reset

1. **Freeze writes** on the source if anything else can still mutate it.
2. If source data changed after the rehearsal, take a **fresh** snapshot
   (section 1, with `-hash-minio` for a reset artifact) into a **new**
   directory. Keep the previous validated artifact. Repeat sections 2 and 3
   for the new artifact. Do not overwrite the rehearsal copy.

   If the source predates the generation this binary was built for — the
   normal shape of a pre-reset export — add `--legacy-source`:

   ```text
   TZ=UTC go run ./cmd/export-snapshot \
     -database-url <legacy-source-url> \
     -legacy-source \
     -hash-minio \
     -output <new-directory>
   ```

   and run the rehearsal against it the same way:

   ```text
   TZ=UTC go run ./cmd/roundtrip-gate \
     -database <admin-url> -source <legacy-source-url> \
     -legacy-source -workdir /safe/path/gate-run
   ```

   Both connections are read only; neither command can modify the source.
   Never look for `-legacy-source` on `import-snapshot` — it has no such flag,
   by design.
3. Confirm the gate report for **this** artifact is pass.
4. Restore with the canonical importer only, into the intended empty database,
   GnuCash sync disabled:
   ```text
   TZ=UTC go run ./cmd/import-snapshot \
     -input <validated-snapshot-dir> \
     -database <empty-target-url> \
     -conflict-policy fail \
     -report /safe/path/restore-report.json
   ```
5. Confirm the restore report: zero `failed`, zero `conflicted`; created +
   unchanged equals snapshot record counts per domain; `sync_enabled` is
   false; secret columns are null. Keep this report **outside** the database
   being replaced, next to the artifact and the gate report.
6. Reconfigure excluded configuration (section 5). Leave GnuCash sync
   disabled through post-restore reconciliation. Also **drop and recreate
   every other database on the current chain** — developer, CI, and test
   databases — so none is left at a generation the binaries refuse
   (section 1.1).
7. Only then is it acceptable, as a **later P1 act**, to replace the
   development database and squash migrations. That squash is **Phase B**
   of the ledger rewrite, after the ledger has run alone. This wave does
   not squash anything and does not drop a table. The additive Phase A
   backfill and freeze is section 6.

### STOP — do not reset

Stop immediately, keep the working database, and keep the artifact, when any
of the following is true:

| STOP | Why |
|---|---|
| Gate driver exited nonzero, skipped, or was not run | C8 has not passed. |
| Source rows changed after the passing rehearsal and you have not taken a fresh snapshot and re-run the gate | The passing report describes a different database. |
| Dry run was not clean, or you cannot show the no-write proof | Restore has not been validated. |
| Restore report contains `failed` or `conflicted` | Partial restore is not a restore. |
| Required media original is missing and not classified in the artifact | Reset would drop irreplaceable originals. |
| Secrets scan hit | Artifact is not the published format. |
| You were about to run `cmd/migrate-legacy` or one-off SQL | Out of contract; copies secrets; not domain-aware. |
| Target is compose `beeztrackz` / volume `postgres_data` and you have not intended a replace **after** a passing gate | Rehearsal must never use that database as a restore target. |
| Target GnuCash `sync_enabled` is true | Restore must leave sync disabled. |
| You were about to pass `--legacy-source` to something that writes, or to work around a generation refusal by hand-editing `schema_generation` or `goose_db_version` | The guard is the only thing between a wrong-generation binary and the data. Recreate the database instead. |
| You planned to enable GnuCash sync before pull-first reconciliation | Roadmap C9. |
| `formatVersion` is not `1` and this build has no transform for it | Importer must not guess schema from `appCommit`. |
| You do not have the wrapping checksum and the artifact on storage independent of the database being replaced | A successful import into a database you then drop is not a backup. |
| You were about to squash migrations, drop `honey_movements` (or any freeze-set table), or treat Phase A backfill as the Phase B reset | No table is dropped in Phase A. Squash is Phase B, after a committed freeze, a physical count, and a post-adjustment snapshot (section 6). |
| You do not have a pre-Phase-A snapshot on storage independent of the database you will backfill | A committed freeze rolls back only by restoring that snapshot (section 6). Do not start the backfill. |

---

## 5. Post-restore reconfiguration

Use `manifest.excludedConfiguration` as the checklist. The restore report
repeats it under `excludedConfig`. Until those items are supplied again, login,
notifications, API access, AI calls, and GnuCash writes will not work.

All HTTP paths below are under `/api/v1` and require an admin session except
the auth routes. The API enforces same-origin on POST/PUT/DELETE
(`backend/internal/httpapi/router.go`).

### 5.1 Login: passwords and OIDC relink

Restored `app_users` rows have **no** `password_hash` and **no**
`auth_subject`. Restored `user_settings.password_hash` is also absent, so
`GET /api/v1/auth/status` reports `setupComplete: false` and password login
off even though users exist.

**OIDC (preferred, and currently the only bootstrap that works without
forging rows):**

1. `GET /api/v1/auth/oidc/login` then the IdP callback
   (`backend/internal/httpapi/routes_auth.go`).
2. The callback matches an existing active user by `auth_subject` **or** by
   verified email. After restore the subject is empty, so the match is the
   restored `app_users.email` plus `email_verified` from the IdP.
3. On match it writes `auth_subject` and upserts `oidc_identities`.
4. If any `app_users` row exists and nothing matches, the callback redirects
   `not_authorized` and **does not** create a second user.

After SSO, set a password with `POST /api/v1/access/me/password` (session
only; API tokens cannot change the password). `POST /api/v1/auth/setup` on an
instance that already has a `user_settings` row also requires an admin SSO
session; an anonymous setup is refused (`Sign in with SSO first to add a
password`).

**Password-only instance (OIDC not configured):** `POST /api/v1/auth/login`
has no hash to check after a restore. The recovery path is
`backend/cmd/set-password --email you@example.com` (or `--username`), run
locally with `DATABASE_URL` pointed at the restored database: it now accepts
an account that has **neither** an SSO subject **nor** a password hash — the
post-restore state — and prints a recovery note when it does
(`cmd/set-password/eligibility.go`). An account that still holds a password
hash but no SSO subject remains refused, so the recovery path cannot be used
to overwrite a live credential. Do not use one-off SQL as the restore path.

### 5.2 API tokens

`api_tokens` is omitted. Old tokens do not exist. After you can sign in,
create new ones with `POST /api/v1/access/tokens` (`name` required) and revoke
with `DELETE /api/v1/access/tokens/{id}`.

### 5.3 ntfy token

Server URL, topic, and enable flags are not secrets and should have restored.
The access token did not. Re-enter it with `PUT /api/v1/settings/ntfy` or
`PUT /api/v1/settings/preferences` (`ntfy.accessToken`). Same masked-secret
contract as other tokens: omit the field to keep the stored value; send `""`
to clear. After restore the stored value is empty, so you must send the token.

### 5.4 AI credentials

Task provider selections and `ollamaUrl` / `whisperUrl` restore.
`apiKeys.anthropic` and `apiKeys.google` do not. Re-enter with
`PUT /api/v1/settings/ai`. Empty key fields mean "keep stored"; after restore
there is nothing to keep, so send the keys. `GET /api/v1/settings/ai` only
returns `hasAnthropicKey` / `hasGoogleKey` booleans.

### 5.5 GnuCash token and the guarded sequence

The snapshot restores `gnucash_sync_settings` **without** `api_token`, with
`sync_enabled = false`, preserving `book_guid`, `book_name`, `root_currency`,
`changes_cursor`, `account_mapping`, and last-attempt (`last_synced_at`
exported as `last_attempt_at`). It restores `external_sync` rows including
`content_hash`, `remote_transaction_guid`, `remote_enter_date`, and conflict
state. It does not invent tombstones or stored idempotency keys.

At this commit, `restorePending` is **derived**: sync disabled **and**
`book_guid` set **and** `changes_cursor` set
(`gnucashSettings.restorePending` in `routes_gnucash_sync.go`). After the
importer has installed a cursor, that heuristic is true. Wave 2 replaces it
with column `restore_state` (`none` / `installed` / `reconciled`) in
`00049_gnucash_restore_state.sql` — re-read that migration and
`routes_gnucash_sync.go` after they land.

The settings page at this commit does not drive restore; it only widens
`restorePending` / `lastSyncAttemptAt` / `discardRestore`. Wave 2 updates
`frontend/src/features/settings/gnucash-section.tsx` and
`frontend/src/features/settings/api.ts`. Until that UI lands, the guarded
command is `POST /api/v1/settings/gnucash/restore` from an admin session on
the app origin.

#### Sequence (configure → test → restore dry-run → restore → reconcile → mark reconciled → enable)

Do these steps in this order. Do not skip to enable.

**1. Configure** — `PUT /api/v1/settings/gnucash` with `baseUrl` and
`apiToken`.

The artifact never carried the token. Ordinary PUT treats a token or base-URL
change as "this is a different book" and clears `book_guid` / `changes_cursor`.
After an importer restore that already installed a cursor, `restorePending` is
true, so that PUT is **refused** unless you send `discardRestore: true`:

> A restored GnuCash cursor is installed and sync is still disabled. Changing
> the server or token now would discard it. Finish the restore reconciliation
> and enable sync, or send discardRestore to drop the restored state on
> purpose.

Sending `discardRestore` **does** drop book identity and cursor. That is
expected here: you are about to prove the new credentials open the **same**
book and reinstall the cursor through the guarded command, not through PUT.
Do not enable sync on this PUT.

Refuses: invalid base URL (must be absolute http(s) with no userinfo, query,
or fragment); restore-pending credential change without `discardRestore`.

**2. Test** — `POST /api/v1/settings/gnucash/test`.

Calls folio `GET status` and caches `bookGuid` / `bookName` / `rootCurrency`.
Allowed while sync is disabled. Does not use `writeClient`.

Refuses/returns: missing base URL or token (`GnuCash base URL is not
configured` / `GnuCash API token is not configured`); folio auth failure
(check that it is a folio personal access token bound to the right book);
404 (check the base URL).

Compare the returned `bookGuid` and `rootCurrency` to the snapshot **before**
restore. Wrong book: **STOP**. Do not install the cursor into someone else's
book.

**3. Restore dry-run** — `POST /api/v1/settings/gnucash/restore` with
`dryRun: true`.

Body fields implemented in `gnucashRestoreRequest`:

- `expectedBookGuid` (required) — from the artifact, not from the just-cached
  settings (comparing the stored value to itself proves nothing)
- `expectedRootCurrency` (required)
- `changesCursor` — preserved cursor
- `lastSyncAttemptAt` — singleton last-attempt, not per-row success
- `rows` — preserved `external_sync` projection
- `replaceExisting` — explicit conflict policy if rows already exist
- `dryRun`

The handler re-tests the live connection and requires an **exact** match on
both book GUID and root currency, then runs the same SQL inside
`Runner.DryRun` (always rolled back).

Refuses (and keeps nothing):

| Condition | Why |
|---|---|
| Missing `expectedBookGuid` / `expectedRootCurrency` | Restore has to know which book the artifact came from. |
| Unknown `entityType`, empty `entityId`, illegal `syncState` / `conflictState` | Artifact fails CHECKs in Go instead of as a SQLSTATE. |
| `externalId` does not match `sale:<uuid>` / `expense:<uuid>` for those types | Would push a Beez entity onto someone else's folio transaction. |
| Duplicate entity or external id in the payload | Unique identity. |
| Synced row without external id | Cannot be a successful sync. |
| No URL/token configured | Cannot test the book. |
| `sync_enabled` is true | `Disable GnuCash sync before restoring. The restored mappings have to pass a pull-first reconciliation before anything is pushed.` |
| Live book GUID/currency ≠ expected | `These credentials open book … but the snapshot was taken from book …` |
| Credentials changed between test and the locked install | Start over. |
| Existing `external_sync` rows and `replaceExisting` is false | Restore installs into empty sync state; send `replaceExisting` only on purpose. |

**4. Restore** — same POST without `dryRun` (or `dryRun: false`).

Installs cursor, book identity, and per-row sync state atomically, with
`sync_enabled` still false. Uses `SystemRestoreActor` only after the identity
proof. Response `restorePending: true`, `syncEnabled: false`,
`excludedConfig` naming the token, `nextSteps` telling you to reconcile
before enable.

At this commit the derived pending signal is now true. Wave 2 sets
`restore_state = 'installed'` here.

**5. Reconcile** (pull-first, no unexpected writes).

Roadmap: pull-first reconciliation and a no-write push plan proving restored
mappings resolve to existing remote records and would produce no unexpected
creates, duplicate postings, overwrites, or tombstone resurrection. Mismatches
stay quarantined.

What the server will and will not do **at this commit**:

- `POST /api/v1/settings/gnucash/sync` and
  `POST /api/v1/settings/gnucash/rows/{id}/push` go through `writeClient()`,
  which **refuses while `sync_enabled` is false**:
  `GnuCash sync is disabled. Enable it in settings before pushing to the book.`
  They also refuse with no cached `bookGuid`:
  `Test the connection before syncing so beez knows which book these credentials open`.
  Sync additionally refuses if the cash account is unmapped:
  `Map a cash account before syncing`.
- `GET /api/v1/settings/gnucash/rows` is local and safe: counts plus
  conflicted/failed rows.
- `GET /api/v1/settings/gnucash/accounts` is read-only against folio (needs
  URL+token, does not need sync enabled).
- Folio verify-by-external-ID (or a server-side no-write batch plan) is a
  **cross-repo** dependency and is not in this tree. Same-schema rehearsal
  cannot complete C9b. Do not treat a green gate report as GnuCash write
  clearance.

Wave 2 `restore_state` is the durable "installed, not yet signed off" signal.
Until a no-write reconcile path exists, **do not** enable sync to "make pull
work." Enabling opens every write-capable endpoint.

Inspect restored rows: conflict states `none` / `local_newer` /
`remote_newer` / `diverged`. Resolve quarantined rows only after you have a
verified no-write plan. `POST .../rows/{id}/ignore` stops syncing that entity
without writing folio and does **not** go through `writeClient`.

**6. Mark reconciled** (landing in this wave).

Wave 2: an admin acknowledgement — `POST /api/v1/settings/gnucash/restore`
with `{"markReconciled":true}`, or a dedicated handler in the same file —
sets `restore_state = 'reconciled'`. That is the **only** path that allows
settings PUT to set `syncEnabled: true` after a restore. Confirm the exact
request in `backend/internal/httpapi/routes_gnucash_sync.go` after it lands.

At this commit there is no `restore_state` column and PUT **can** set
`syncEnabled: true` while `restorePending` is still true. Do not do that.

**7. Enable** — `PUT /api/v1/settings/gnucash` with `syncEnabled: true`, only
after mark-reconciled.

`writeClient` then allows `POST /settings/gnucash/sync` (pull still runs
before push; a failed or incomplete pull pushes nothing) and
`POST /settings/gnucash/rows/{id}/push`.

Entity re-key of the **six** dissolved `external_sync.entity_type` values
(audit (a); spec §8) and content-hash rebaseline against unchanged
`remote_transaction_guid` / `remote_enter_date` apply in Phase A after
the freeze (section 6.6), not during this same-schema rehearsal.

---

## 6. Phase A — ledger backfill and freeze

This is the operator procedure for spec §9 Phase A: translate the live
legacy quantity tables into `inventory_operations` in place, check parity,
and freeze those tables read-only. It is **not** the P0 same-schema restore
(section 4) and it is **not** the Phase B squash. No table is dropped here.
There is no dual-write: once the freeze commits, the ledger is the only
quantity writer.

Binding documents: spec
`docs/plans/2026-09-01-inventory-ledger-design.md` (§7 translation, §7.2
parity, §7.4 residual splits, §8 GnuCash re-key, §9 Phase A, §12 tests)
and the wave-1 audit
`docs/plans/2026-09-02-ledger-read-path-migration.md` (freeze-eight, T3
writer set, T4 projections, T5 backfill, six-type `external_sync` re-key).

Wave 1 already landed on this chain (2026-09-02): migration
`00050_inventory_ledger.sql`, migration `00051_schema_generation.sql` plus
the generation guard, and `backend/internal/app/inventory`. This wave
lands the producers, the projection switch, and the backfill/freeze
command. Rehearse on a fresh copy of production first (spec §12
Rehearsal); keep that report.

### Preconditions

Do these in order. Abort rather than skip.

1. Process environment: `TZ=UTC`.
2. Every developer, CI, and test database has been dropped and recreated
   from the current migrations (section 1.1). A database merely copied
   from a pre-00051 chain will be refused at start-up.
3. The target is a `ledger-v1` database: `schema_generation` stamped,
   goose head includes 00050 and 00051, `app/inventory` present. Confirm
   with the binary that will run the backfill, not with an older one.
4. Take a **fresh** snapshot of the database you will backfill (section 1,
   with `-hash-minio` if this artifact might have to restore the
   pre-Phase-A state). Store it **outside** that database. This snapshot
   is the only rollback for a committed freeze.
5. That artifact has a **passing P0 gate** (sections 2 and 3). If source
   rows changed after the last passing rehearsal, re-export and re-run
   the gate. The passing report must describe *this* database.
6. GnuCash sync stays disabled for the backfill window (`sync_enabled =
   false`). Do not enable it to "make pull work" (section 5.5).
7. This wave's T3 producers and T4 readers are in the binary you will
   run. The freeze is what makes any leftover legacy writer fail
   loudly; arming it against a binary that still `INSERT`s
   `honey_movements` (etc.) is a STOP. The audit's writer set is listed
   under **Freeze** below.
8. Freeze writes on the source if anything else can still mutate
   quantity while the job runs. The backfill transaction is the
   serialization point; a concurrent legacy write races the freeze.

### 6.1 Rehearse on a copy, then run `-backfill-ledger`

The in-place job is `import-snapshot -backfill-ledger`. The flag is
**landing in this wave**. Do not invent companion flags (dry-run shape,
report path, database URL flag name, a separate freeze-only switch).
After the binary lands, the authoritative flag set is
`backend/cmd/import-snapshot/main.go`. Spec §12 names the tests that
pin the commit/rollback behaviour:
`backend/cmd/import-snapshot/backfill_db_test.go` (successful backfill
refuses INSERT/UPDATE/DELETE on every freeze-eight table; a failed
parity leaves those tables writable and the ledger empty) and
`backend/cmd/import-snapshot/translate_test.go` (causal order 1–10,
`legacy_ref` on every translated row, residual splits, **negative
unassigned residual fails**).

What the job is (spec §9 steps 3–4), regardless of flag spelling:

- The §7 translation, run in place as an idempotent job under the
  system-restore actor against the **live** legacy tables. Same builders
  (`backend/internal/app/inventory/build`) as live commands; the
  translator adds only residual splits, provenance / `legacy_ref`
  markers, and condition coercion.
- One transaction. It ends by installing a `BEFORE INSERT OR UPDATE OR
  DELETE` trigger on each of the eight freeze-set tables, then running
  §7.2 parity against the **frozen** legacy aggregate family
  (`backend/internal/snapshot/legacy.go`).
- Parity must pass inside that transaction or the job refuses to
  commit. Counts match exactly; mass within 0.0001. Jar / product /
  propolis legacy formulas compare to `inventory_available`; bulk,
  lots, away stock, and equipment compare to `inventory_balances`
  (spec §7.2).

Rehearse first against a disposable copy (same `CREATE DATABASE`
pattern as section 3). Do not rehearse against compose `beeztrackz`
or volume `postgres_data`. Only after that copy's report is pass, run
the same binary against the intended database.

```text
TZ=UTC go run ./cmd/import-snapshot \
  -backfill-ledger \
  …
```

Fill in `…` from `backend/cmd/import-snapshot/main.go` after the flag
lands. Existing P0 flags (`-input`, `-database`, `-dry-run`,
`-conflict-policy`, `-report`) mean what section 2.3 / the CLI block
above say; do not assume they all apply to backfill. Prefer an
absolute `-report` path beside the pre-Phase-A wrapping checksum,
**outside** the snapshot artifact.

Pass: exit 0, freeze triggers installed, parity cells equal or
**explained** by a declared `legacy-residual-split-v1` split, residual
splits listed in the restore report (spec §7.4). Keep that report next
to the pre-Phase-A snapshot.

### 6.2 What parity failure looks like

A failed backfill **does not commit**. Spec §9 step 4 and
`backfill_db_test.go`: the freeze trigger is not installed, the eight
legacy tables stay **writable**, and the ledger is empty (no leftover
`inventory_operations` / movements from the aborted transaction). Live
producers are not switched on — they are feature-gated behind a
committed freeze.

Treat any of the following as the same failure:

- Exit nonzero, or a report with `failed` / `conflicted`.
- An unexplained aggregate delta against the legacy family in
  `backend/internal/snapshot/legacy.go` (spec §7.2). Matching totals
  do not excuse a per-item / per-lot / per-location miss.
- A negative unassigned bulk residual (section 6.3) — that is a STOP,
  not a split to declare.
- A freeze-eight table that still accepts a write after a reported
  "success".

Do not "finish by hand": do not insert freeze triggers, do not delete
ledger rows, do not re-run a partial translation against a database
that already has some `inventory_*` rows from a committed attempt. Fix
the cause (source data, translator bug, binary that still writes
legacy tables), restore the copy if you rehearsed destructively, and
run the job again from a clean in-place state. The job is specified as
idempotent; confirm the actual no-op contract in
`backend/cmd/import-snapshot/` after it lands.

### 6.3 Residual-split report, and the negative-unassigned STOP

After translation steps 1–9, the job applies the declared splits (spec
§7.4, transform version `legacy-residual-split-v1`):

| Split | What it becomes | `details.reason` / lot |
|---|---|---|
| Unassigned bulk honey (`total harvested − Σ lot ceilings − Σ lot-less draws`) | one `opening_balance` receipt of that many lbs into item `honey_bulk` at `home` | lot `legacy-unassigned`, dated at the earliest harvest |
| Home jar residual per jar size (`global jars − Σ away`) | one `opening_balance` per jar-size item at `home` | lot `legacy-unassigned` where the jar cannot be traced; `details.reason = 'home-residual-split'` |
| Home product residual per catalog product | same shape per catalog item | same |
| Draw before its receipt | an `opening_balance` for the shortfall only, immediately before the draw | that item's `legacy-unassigned` lot at the draw location and date; `details.reason = 'draw-before-receipt'` |
| Remaining draw-before-receipt excess | one `legacy_reconcile` count adjustment, limited to the injected total for that item and location | dated at the last legacy event there; `details.reason = 'draw-before-receipt-reconcile'` |

Each split is listed in the restore report **and** in the new-ledger
`verification.json` family with its amount (spec §7.4). Exact JSON
keys land with the flag; read `backend/cmd/import-snapshot/main.go`
and the report type in that package. A matching declared split is an
explained difference; any other residual is a parity failure.

**STOP — negative unassigned residual.** If the unassigned bulk residual
is negative, the job must fail the gate (spec §7.4, §12 Translation).
That is a real data problem (more lot-less draws than unassigned
harvest). Investigate the source `honey_movements` / harvest / lot
graph, fix it, take a new snapshot, re-run the P0 gate, and only then
retry the backfill. Do not coerce the residual to zero. Do not invent
a lot to hide it.

`legacy-unassigned` jar stock is expected to be large relative to
traced stock until the physical count retires it (spec OV7 / §7.1
step 10). That is not a failure.

Read `ledgerBackfill.drawBeforeReceiptInjections` and
`ledgerBackfill.drawBeforeReceiptReconciles` together. The command summary
prints the same entries. Every row identifies `item`, `location`, `lot`,
signed `quantity`, and `source` (plus `operationId` in JSON). An injection is
positive and must be the exact shortage at that draw. A reconcile is negative
and removes only the end-state excess caused by those injections; the sum of
reconciles for an item/location must never exceed its injected total. Confirm
that its timestamp is the last legacy event for that item/location and that
the final parity cell equals the legacy figure.

A named harvest or batch lot is not eligible for an injection. If the report
or command error says a named lot was overdrawn, stop and investigate that
provenance; do not reinterpret it as `legacy-unassigned`. Likewise, a
negative residual larger than the listed injections is still a gate failure,
not permission to add a larger reconcile adjustment.

### 6.4 What the freeze means

On commit, a `BEFORE INSERT OR UPDATE OR DELETE` trigger raises on
each of the eight tables (spec §9 step 3). Any process still writing
those tables **fails loudly**. The exact SQLSTATE / message lands with
the trigger; do not guess it. After a successful backfill, prove the
refusal with a write against a freeze-set table (the
`backfill_db_test.go` assertion is the template).

The freeze-eight:

`honey_movements`, `stock_movements`, `product_adjustments`,
`equipment_stock`, `equipment_stock_adjustments`,
`equipment_deployments`, `equipment_deployment_returns`,
`equipment_state_changes`.

`stock_locations` and `equipment_type_components` are **not** in the
freeze-eight (they drop at Phase B). Their writers still have to move
before squash.

**These writers must already be migrated** (audit (c) / T3) before you
arm the freeze. File:line checklist:
`docs/plans/2026-09-02-ledger-read-path-migration.md` section (c).
Summary of the production writer set the trigger will refuse:

| Table | Production writers (handler / helper) |
|---|---|
| `honey_movements` | `honeyRecordJarring`, `honeyRecordBulkMovement`, `honeyRecordGiveAway`, `honeyAdjustJarCounts`, `honeyReverseMovement`; `bottlingRunCreate` / `bottlingRunVoid`; `productBatchCreate` / `productBatchVoid`; jar-size deactivate write-off; settlement shrink (global half) and `stockSettlementVoid` |
| `stock_movements` | `stockInsertMovement` (transfer/return), `stockReverseMovements`, settlement shrink (location half) |
| `product_adjustments` | `productInsertAdjustment` (incl. settlement product shrink), `productAdjustmentDelete`, `stockSettlementVoid` |
| `equipment_stock` | `equipCreateStock`, `equipUpdateStock` (OV2: this PATCH becomes an `equipment_types` update, not a freeze-table write), `equipReceiveStock`, `equipApplyAssembly` (empty-row insert + rolled-up cost), `equipDeleteType` (wave 3d: now refuses on `inventory_movements` and deletes the inventory item instead — no `equipment_stock` write), `honeyConsumePackaging` |
| `equipment_stock_adjustments` | `equipInsertAdjustment` (receive, adjust, physical count, assembly, packaging consume); `saleInsertSoldAdjustment`; `saleRevertPhysical`; `saleUnapplyPhysical` |
| `equipment_deployments` | `equipDeployTx`; `equipReturnTx`; `saleRevertPhysical` |
| `equipment_deployment_returns` | `equipReturnTx`; `saleRevertPhysical` |
| `equipment_state_changes` | `equipInsertStateChange` (damage / repair / retire, return-damaged, dispose-from-condition) |

Restore of quantity history after freeze is T5 translation into
operations, not table copy. Today's `app/restore_portable.go` still
inserts `equipment_stock` at zero and replays adjustments — that path
must not hit the freeze (audit "Restore writer").

Not freeze-eight, still must move before Phase B: `stock_locations`
create/update/soft-delete (`routes_stock_locations.go`, home seed in
`honey_ledger.go`) and `equipment_type_components` replace-all
(`routes_equipment_bom.go`).

As of wave 3d the `equipment_type_components` half of that is still open and
is a **Phase B blocker** (spec §12.1 open item 8): `GET /equipment/components`,
`PUT /equipment/types/{id}/components`, and `POST /equipment/assemblies` all
still name the table, so they fail on a baseline database.
`DELETE /equipment/types/{id}` no longer does.

After a committed freeze, operate on the ledger alone. Legacy tables
and views remain, frozen, for reference and for the Phase B gate.
Producers write through `app/inventory` (`Record` / `Reverse` /
`CheckAvailable`). Readers use `inventory_balances` /
`inventory_available` / `inventory_reservations` / checkpoint
reconciliation (audit T4).

### 6.4a The harvest guards tighten when the ledger holds the lot pounds

Not a procedure step — a behaviour change to expect the first time an
operator edits a harvest on a backfilled database, and the one thing in
Phase A that can refuse an edit that used to succeed.

Lot pounds are ceiling receipts in the ledger now (spec decision 6), so
"pounds harvested" and "bulk on hand" are two different quantities. The
guard on both `hsTrueUp` (true up a session's weight) and `hsDeleteEntry`
(soft-delete one harvest entry) is the §7.4 residual:

    Σ harvested − Σ live lot ceilings ≥ 0

**A true-up or entry delete that would drive that residual negative is
refused.** Concretely: an operator cannot true a session *down* while its
lots still claim the full weight. The message names the lot. The fix is to
lower or unlink that lot first, then re-run the edit. Voiding the lot's
bottling runs is a separate, earlier step — a linked lot with non-voided
runs refuses the delete outright, and that refusal is what keeps the
provenance of jars already on the shelf reconstructable.

It deliberately does **not** refuse when the residual was already negative
before the edit. Legacy data carried in by the backfill can arrive in that
state (a manual lot weight typed over a smaller sum of harvests, for
instance). The edit did not create the inconsistency and refusing there
would trap the operator; the reset gate is what confronts it, by refusing
to carry a negative residual into Phase B.

Both handlers go through `production.CheckHarvestResidual` /
`production.RebaseDerivedLotCeilings`; that is the single place the rule
lives.

### 6.5 Rollback

Drop the ledger rows? **No.**

| Situation | Rollback |
|---|---|
| Parity failed, job exited nonzero | Nothing to roll back. The transaction did not commit. Legacy tables are still writable; the ledger is empty. Fix and retry. |
| You think a failed job "left rows behind" | Treat that as a translator/CLI bug. Do not `DELETE FROM inventory_operations`. Restore the pre-Phase-A snapshot into a disposable database and compare. |
| Freeze **committed** and you need to undo Phase A | Restore the **pre-Phase-A snapshot** through the canonical importer (section 4) onto a fresh replacement database, then run the canonical importer again with `-backfill-ledger`. That is the only rollback. Do not drop freeze triggers by hand. Do not `TRUNCATE` `inventory_*`. Do not squash. |

The pre-Phase-A snapshot plus its passing gate report are the recovery
boundary. Keep them on storage independent of the database you froze.

An artifact whose manifest has `schemaMigration < 50` legitimately has no
`inventory_*` domain files. The reader/importer declare those missing domains
as `pre-ledger-artifact-v1`; restore replays the legacy tables onto the fresh
head database and leaves every ledger domain empty. Re-run
`import-snapshot -database <replacement-url> -backfill-ledger` to translate
that restored legacy state, require parity, and arm the freeze. Never aim this
restore at the frozen database: the importer returns a typed precondition
naming `inventory_legacy_freeze` and this section. The end-to-end database test
`TestPreLedgerRollbackRestoreAndBackfillEndToEnd` proves this exact section 6.5
path (migration-48 export → head restore → backfill parity/freeze), while
`TestRoundTripGatePassesAgainstAPreLedgerSource` proves the corresponding
gate and named explanations.

### 6.6 Between the phases

These sit after a committed freeze and **before** Phase B squash (spec
§9 "Operator steps that sit between the phases"). Do not skip to
squash.

1. **Physical count and consignment reconciliation** as `count_adjust`
   operations on the ledger (inventory service, not a
   `product_adjustments` / `equipment_stock_adjustments` /
   `honey_movements` write — those now raise). Approved differences
   only. This is also how `legacy-unassigned` lots get retired.
2. **Post-adjustment snapshot.** Export (section 1) and round-trip
   verify (section 3) so those `count_adjust` operations become the
   new rollback boundary. Do not rely only on the pre-Phase-A
   artifact from here on.
3. **GnuCash re-key, rebaseline, reconcile, mark reconciled.** Sync
   stays disabled through this step.
   - Re-key the **six** dissolved `external_sync.entity_type` values
     (audit (a); spec §8 — not the original "nine"):
     `honey_movement`, `stock_movement`, `equipment_stock`,
     `equipment_stock_adjustment`, `product_adjustment` →
     `inventory_operation` via `legacy_ref_*`; `stock_location` →
     `inventory_location`. Production currently has zero
     `external_sync` rows, so the first pass may be an allowlist
     change with nothing to rewrite — still run and retain the
     report. Test named in spec §12:
     `backend/internal/httpapi/external_sync_rekey_test.go`. The
     allowlist itself is `backend/internal/httpapi/external_sync.go`.
   - Content-hash rebaseline from the new body composition against
     unchanged `remote_transaction_guid` / `remote_enter_date`
     (section 5.5; roadmap B2). Only a *remote* body that no longer
     matches stays `diverged`.
   - Pull-first reconciliation sweep against folio's verify-by-external-ID
     endpoint (section 5.5 step 5). No-write plan. Quarantine
     mismatches.
   - `markReconciled` (section 5.5 step 6). Confirm the exact request
     in `backend/internal/httpapi/routes_gnucash_sync.go`.
4. **Enable GnuCash sync** only after mark-reconciled (section 5.5
   step 7).

Phase B (squash to `00001_baseline.sql`, drop the frozen tables, stamp
`schema_generation = 'ledger-v1-baseline'`, recreate every database,
ordinary P0 gate against the new schema) is **section 7**. It starts only
after the ledger has run alone for a real period **and** the physical
count above has landed. That is a later act. This wave does not do it.

### STOP — do not freeze / do not squash

Stop immediately, keep the working database writable on the legacy
tables, and keep the pre-Phase-A artifact, when any of the following
is true:

| STOP | Why |
|---|---|
| No fresh snapshot + passing P0 gate for *this* database | The only rollback for a committed freeze would describe a different tree of rows. |
| A developer / CI / test database has not been recreated per section 1.1 | Generation guard will refuse it, or worse, a foreign chain gets served. |
| T3 writers in audit (c) still `INSERT`/`UPDATE`/`DELETE` a freeze-eight table | The freeze will fail those processes loudly. Migrate them first. |
| You were about to arm the freeze from a binary that does not contain this wave's producers and projections | Leftover handlers become the production quantity path, then break. |
| Parity failed, or the report is missing / unreadable | Freeze must not commit. Legacy tables stay writable (section 6.2). |
| Unassigned bulk residual is negative | Spec §7.4 data problem. Investigate; do not declare a split. |
| An unexplained residual (not a listed `legacy-residual-split-v1` row) | Concealment. Fail, fix, retry. |
| You were about to `DELETE` / `TRUNCATE` `inventory_*` rows to "undo" a backfill | A failed parity never commits. A committed freeze rolls back only by restoring the pre-Phase-A snapshot. |
| You were about to drop freeze triggers by hand, or `DROP TABLE honey_movements` (etc.) | Freeze is armed by the backfill job; tables drop in Phase B only. |
| You were about to squash migrations in this wave | Phase B, after count + post-adjustment snapshot. |
| Target is compose `beeztrackz` / volume `postgres_data` and this is still the rehearsal copy | Rehearse on a disposable database (section 3 pattern). |
| GnuCash `sync_enabled` is true | Disable, then backfill. Re-key / rebaseline / markReconciled happen *after* freeze (section 6.6). |
| Restore into a frozen database still copies `equipment_stock` then replays adjustments | Post-freeze restore is T5 translation. `app/restore_portable.go` must not hit the freeze. |
| `TEST_DATABASE_URL` is unset so `backfill_db_test.go` skipped and you treated that as a pass | The freeze contract is not proven. |

---

## 7. Phase B — squash to the baseline, reset, restore

Phase B is spec §9 steps 6–9: replace the 00001–00052 chain with one
`00001_baseline.sql`, drop the ten frozen legacy tables and the five
views over them, stamp a new generation, recreate every database, and
restore the final snapshot through the ordinary P0 gate. Translation
already happened in Phase A, so nothing is translated here — this is a
schema change proved by a plain round trip.

**Do not start Phase B until all of section 6.6 is done:** committed
freeze, physical count as `count_adjust` operations, post-adjustment
snapshot with a passing gate, GnuCash re-key / rebaseline /
mark-reconciled. Phase B is a later act.

### 7.1 What the baseline is, and how it is selected

`backend/internal/db/migrations/00001_baseline.sql` is the whole target
schema in one migration. The old chain now lives, unembedded, at
`backend/internal/db/legacy-00001-00052/` for reference; nothing runs it
except the in-package migration tests and the default profile.

Both chains ship in the binary and **the legacy chain is the default**.
The baseline is selected explicitly, by environment variable:

```text
BEEZ_SCHEMA_BASELINE=1     # 1 | true | yes | on (case-insensitive)
```

| `BEEZ_SCHEMA_BASELINE` | Chain applied | Generation expected | goose head |
|---|---|---|---|
| unset, empty, `0`, `false`, anything else | `legacy-00001-00052` | `ledger-v1` | 52 |
| `1` / `true` / `yes` / `on` | `migrations` (the baseline) | `ledger-v1-baseline` | 1 |

An unconfigured binary therefore behaves exactly as it did before the
squash landed in the tree. Set the variable on the process, not on a
single command: `server`, `worker`, `set-password`, `export-snapshot`,
`import-snapshot`, and `roundtrip-gate` each read it at connect time,
and a mixed pair (one process on each profile) refuses to share a
database — which is the guard doing its job, not a bug.

The baseline is **generated, never hand-written**. The procedure is in
the header comment of `00001_baseline.sql`: migrate a scratch database
through the legacy chain, copy it, drop the ten tables / five views /
seven dead functions / four dead enums, `pg_dump --schema-only`, strip
the psql preamble, and re-attach the seeds. `TestBaselineMatchesTheLegacyChain`
in `backend/internal/db` proves the result equals a chain-migrated
database, column for column and index for index, minus the declared
drops. Re-run it whenever the legacy chain moves before the reset lands:

```bash
cd backend
TZ=UTC TEST_DATABASE_URL=postgres://... go test ./internal/db -run Baseline -p 1 -count=1
```

### 7.2 What the baseline drops

Ten tables and five views, and nothing else (spec decision 10 and §8).
The list is declared once, in
`backend/internal/db/baseline_domains.go`, and every reader that has to
explain a difference reads it from there.

| Dropped tables (also snapshot domains) | Dropped views |
|---|---|
| `honey_movements`, `stock_movements`, `product_adjustments`, `equipment_stock`, `equipment_stock_adjustments`, `equipment_deployments`, `equipment_deployment_returns`, `equipment_state_changes`, `stock_locations`, `equipment_type_components` | `honey_lot_balances`, `honey_varietal_balances`, `equipment_stock_status`, `equipment_stock_reconciliation`, `equipment_loss_events` |

Retained tables keep **every column they had after 00052**, so a Phase A
snapshot restores without a column-level transform. Four foreign keys
that pointed into the dropped set went with it, leaving their columns as
unconstrained uuids: `consignment_settlements.location_id`,
`sales.stock_location_id`, `external_sync.location_id`, and
`sale_items.equipment_stock_id`. Re-keying those to
`inventory_locations` / `inventory_items` is application work (spec §8,
open items 2 and 3), not schema work, and must be finished before the
columns are retired in a later migration.

`external_sync.entity_type`'s CHECK is likewise still the seventeen values
00041 wrote, six of them dissolved (`honey_movement`, `stock_movement`,
`equipment_stock`, `equipment_stock_adjustment`, `product_adjustment`,
`stock_location`). Narrowing it to eleven is the same app-side re-key
(spec §8, section 6.6 step 3) and lands as a second migration on top of the
baseline — or by regenerating the baseline afterwards. Keeping it verbatim
here is deliberate: a Phase A artifact that still carries rows of those types
must restore, and the re-key rewrites them afterwards.

Seven trigger functions and four enum types lost their only tables and
are dropped with them: `equipment_component_cycle_guard`,
`equipment_ledger_sync`, `equipment_merge_duplicate_stock`,
`equipment_stock_ledger_totals`, `equipment_stock_reconcile_guard`,
`equipment_stock_sync`, `honey_movement_lot_matches_run`; enums
`equipment_state`, `frame_condition`, `honey_movement_kind`,
`stock_adjustment_reason`.

### 7.3 A Phase A snapshot restored into a baseline database

The final snapshot is taken from a Phase A database whose legacy tables
are present and frozen, so the artifact carries all ten dropped domains.
The baseline target has nowhere to put them. That is a **declared
`formatVersion` 1 transform**, not a loss:

- name: `domains-dropped-by-baseline`
- version: `ledger-v1-baseline-drop-v1`
- domains: the ten tables above, **listed by name** in the gate report

"Zero unexplained differences" is still the bar. A difference is
explained only if the report names the domain; a report that says "some
domains are missing" fails the gate. The ledger domains
(`inventory_*`) are the authority for those quantities and round-trip
normally, which is what makes the drop safe.

`TestPhaseBDroppedDomainsAreDeclaredByName` and
`TestPhaseBRoundTripIntoABaselineDatabase` in
`backend/cmd/roundtrip-gate/phase_b_test.go` rehearse exactly this on
disposable databases.

### 7.4 Recreate every database — the second generation change

> **Recreate all databases, again.** Section 1.1 already required this
> once, when the guard landed and the stamp became `ledger-v1`. The
> squash changes the generation a second time, to
> `ledger-v1-baseline`, and moves the goose head from 52 to 1. Every
> developer, CI, and test database must be dropped and recreated from
> the baseline — `DROP DATABASE x WITH (FORCE); CREATE DATABASE x;`,
> then let a `BEEZ_SCHEMA_BASELINE=1` process migrate it. **Migrating
> forward is not available this time.** There is no migration from 52
> to the baseline: goose would see version 1 as unapplied and try to
> create 72 tables that already exist. The generation guard turns that
> into a clean refusal instead of a DDL error, and the only cure is to
> recreate.

The production working database is recreated by the reset in 7.5, not
by hand.

### 7.5 Ordered Phase B procedure

Every step runs with `TZ=UTC`. Steps 1–4 do not touch the working
database.

1. **Final snapshot.** Export from the Phase A working database
   (section 1). The legacy tables are frozen, so the exporter omits the
   stale `legacy` aggregate family and fills `newLedger` — that is
   expected, and it is why the parity oracle for this reset is the
   ledger, not the legacy sums. Store the artifact and its wrapping
   checksum off the database host (section 1, "Where to store it").

2. **Gate the artifact against a baseline target.** The ordinary P0
   gate, with the baseline profile selected for the run:

   ```bash
   cd backend
   TZ=UTC BEEZ_SCHEMA_BASELINE=1 go run ./cmd/roundtrip-gate \
     -admin  postgres://.../postgres \
     -source postgres://.../beeztrackz \
     -workdir ./gate-phase-b
   ```

   The source is the Phase A database and is read only; the disposable
   target is created, migrated with the baseline, restored into,
   re-exported, and dropped. Read the report per section 3: it must
   pass, and its explained findings must be the ten dropped domains by
   name and nothing else. **Retain `gate-report.json`,
   `gate-summary.txt`, and `artifact.sha256`.**

3. **STOP and check.** Work the "do not squash" table in 7.6. Any row
   that is true stops the reset.

4. **Deploy the baseline binary nowhere yet.** Confirm the image or
   binary you are about to run carries `BEEZ_SCHEMA_BASELINE=1` in its
   environment and that no other process (worker, cron, a stray local
   `server`) is pointed at the working database on the old profile. A
   mixed pair does not corrupt anything — the guard refuses — but it
   does mean a silent outage while you are mid-reset.

5. **Recreate every database.** Working database last:
   - developer and CI databases (7.4);
   - the scratch databases the test suite creates are dropped and
     recreated by the tests themselves; nothing to do;
   - the working database: stop `server` and `worker`, then
     `DROP DATABASE beeztrackz WITH (FORCE); CREATE DATABASE beeztrackz;`
     from the `postgres` maintenance database.

     Take a `pg_dump` of the working database to independent storage
     first. It is not the restore path — the artifact from step 1 is —
     but it is the only thing that can answer "what did the old
     database actually hold" if the restore surprises you.

6. **Migrate and restore.** Bring up one process with
   `BEEZ_SCHEMA_BASELINE=1` to migrate the empty database (it will
   apply `00001_baseline.sql` and stamp `ledger-v1-baseline`), then
   restore the step-1 artifact through `import-snapshot` with GnuCash
   sync disabled, exactly as section 4 describes. The importer skips
   the ten dropped domains as a declared transform and says so in the
   restore report; any *other* skip is a failure.

7. **Verify.** Re-run the verification of section 4: record counts per
   domain, the `newLedger` aggregate family against the artifact's, and
   a spot check of on-hand quantities through `inventory_available`.
   Confirm `SELECT generation FROM schema_generation` reads
   `ledger-v1-baseline` and that `goose_db_version` holds exactly one
   applied row.

8. **Reconfigure.** Section 5, unchanged: passwords and OIDC relink,
   API tokens, ntfy token, AI credentials, then the GnuCash guarded
   sequence (5.5). Sync stays disabled until mark-reconciled.

9. **Retire the legacy chain.** Once the working database and every
   developer database are on the baseline and have stayed there for a
   release, delete `backend/internal/db/legacy-00001-00052/`, drop the
   profile switch, and make the baseline unconditional. Until then the
   switch is what lets one tree serve both.

### 7.6 STOP — do not squash

| STOP | Why |
|---|---|
| Section 6.6 is not finished (count, post-adjustment snapshot, GnuCash re-key + mark-reconciled) | Phase B is the last act, not a shortcut past the reconciliation. |
| The step-2 gate did not pass, or its explained findings are not exactly the ten dropped domains by name | An unexplained difference is data you are about to lose. |
| `TestBaselineMatchesTheLegacyChain` has not been run against this tree since the last migration landed | The baseline is generated; an unregenerated baseline is stale, and goose will not tell you. |
| You were about to "migrate" a Phase A database to the baseline instead of recreating it | There is no such migration (7.4). The guard refuses; do not work around it. |
| A developer, CI, or test database is still on `ledger-v1` | It will be refused at start-up, or a foreign schema gets served. Recreate it. |
| No `pg_dump` of the working database on independent storage | The artifact is the restore path, but you still want the raw answer to "what was there". |
| GnuCash `sync_enabled` is true | Restore with sync disabled; re-enable only after the guarded sequence (5.5). |
| The target is compose `beeztrackz` / volume `postgres_data` and this is still a rehearsal | Rehearse on a disposable database (section 3 pattern) with `BEEZ_SCHEMA_BASELINE=1`. |
| `sale_items.equipment_stock_id` / `sales.stock_location_id` still drive a live read path | Those FKs are gone in the baseline (7.2). Move the readers first. |
| `TEST_DATABASE_URL` is unset, so the Phase B tests skipped and you read that as a pass | Nothing was proven. |

---

## 8. Troubleshooting

Importer and gate failures are per-file / per-record. A silent partial restore
is a bug. Kinds come from `backend/internal/app/errors.go`. Report outcomes
come from `backend/internal/app/restore.go`. Gate comparison classes come from
design section 3. GnuCash messages come from
`backend/internal/httpapi/routes_gnucash_sync.go`. Phase A backfill / freeze
behaviour is spec §9 and, once the flag lands,
`backend/cmd/import-snapshot/main.go` plus
`backend/cmd/import-snapshot/backfill_db_test.go`.

| Symptom / class | Typical kind or case | Operator action |
|---|---|---|
| Exit nonzero, report unreadable / missing | CLI bug or `-report` path not writable | Fix the path (not inside the artifact). Re-run. Confirm default `./restore-report.json` after Wave 2 lands. |
| `unsupported` / unknown `formatVersion` | A8 | This build cannot import that artifact. Do not guess schema from `appCommit` or `schemaMigration`. |
| Manifest hash mismatch / A1 | corrupt file | Re-export. Never patch the manifest. |
| JSONL parse error / A2 | truncated line, missing LF | Re-export. Error should name the domain file and byte offset. |
| `not_found` dangling reference / A3 | required FK or no-FK pointer (`media_files.current_transcript_version_id`) | Fix source graph or accept that the artifact is unsatisfiable. Dry run must fail before restore. |
| Duplicate preserved ID / A4 | two lines, same `id` | Fix source; do not import either as a coin-flip. |
| `conflict` different digest, same ID / A5 | target not empty, or second artifact | Rehearsal: fail. Repair: explicit `-conflict-policy skip` (keep DB) or `overwrite` (artifact wins; `updated_at` becomes now — not a faithful restore). Prefer an empty database. |
| Non-empty database refused | `-conflict-policy fail` (default) | Restore into an empty DB, or pass `skip`/`overwrite` on purpose. Goose seeds (home location, treatment products) are not operator data; preserved IDs must win inside the restore transaction. |
| Missing required media / A6 | MinIO or Immich 404 | Restore the object or classify that owner+reason in the artifact before any reset. |
| Second missing original after one accepted omission / A7 | gate still fails | Classify every missing original individually. |
| Dry-run fingerprints changed / A10 | write escaped | Importer bug. Do not restore. Do not trust `pg_stat` counters. |
| Secrets in artifact / A11 | exporter leak | Do not restore. Re-export from a build that strips those keys. |
| jsonb digest churn / A12 | key order or `1` vs `1.0` | Canonicalization bug, not operator data change. Do not "fix" JSON by hand. |
| Timestamp / date mismatch / A13 | session TZ, `date` vs `timestamptz` | Re-run with `TZ=UTC`. Date-only fields stay `YYYY-MM-DD`; do not convert them. |
| Trigger `23514` / A14–A17 | bottling run after movement; equipment insert at non-zero; settlement paid > owed; BOM cycle | Importer ordering bug or bad artifact. Transaction must abort; no partial file. |
| Mite-count unique / A18 | two live rows same hive/date/method | Source data problem. A live row plus a `deleted_at` twin **must** restore. |
| Treatments jsonb vs events / A19 | 00034 reconciliation | Export must carry `treatment_events`, `inspections.treatments`, and `treatment_products`. Do not synthesize one store from another. |
| Aggregate delta, records equal | wrong family or unexplained residual | Same-schema uses **legacy**. Do not treat new-ledger `null` values as a pass. Do not invent lots for `legacy-unassigned`. |
| `precondition` "database not ready" | empty-DB / GnuCash credentials | Point at an empty migrated target, or configure/test GnuCash first. |
| `forbidden` preserved audit | HTTP user hit a restore write | Restore is not an HTTP create. Use `import-snapshot` / guarded GnuCash restore. |
| GnuCash PUT refused with `discardRestore` message | restore pending | Finish reconcile, or send `discardRestore` knowing it drops the cursor, then test + guarded restore. |
| GnuCash restore: book mismatch | token opens a different book | Point at the original book. Do not install the cursor. |
| GnuCash restore: rows already exist | not empty sync state | Send `replaceExisting` only if you mean to discard live mappings. |
| `POST /settings/gnucash/sync` or `.../rows/{id}/push` while disabled | A20 | Expected. Do not enable to bypass it. |
| Ordinary PUT with a new token cleared the cursor | A21, not restore-pending | Expected for live rotation. Guarded restore is the path that keeps the cursor after an identity match. |
| `last_synced_at` looks like last success | A22 | Singleton is last-**attempt**. Per-row success is `external_sync.last_synced_at`. |
| Cannot sign in after restore | excluded `password_hash` / `auth_subject` | OIDC relink by verified email (section 5.1). Password-only is a STOP. |
| Setup page offers first-run setup | `user_settings.password_hash` excluded | Do not run anonymous setup; it will 401. SSO first. |
| Old API token 401 | `api_tokens` omitted | Create a new token after login. |
| ntfy / AI / GnuCash calls fail with missing credentials | excluded keys | Re-enter per section 5. Safe AI URLs should already be present. |
| `cmd/migrate-legacy` "target already contains apiaries" | wrong tool | Stop. Use `import-snapshot`. |
| `schema generation guard: missing-generation-table (actual legacy, …)` | database predates migration 00051 | Reading it? Re-run with `--legacy-source` (exporter and gate source only). Using it? Recreate it from the current migrations. Never hand-create `schema_generation`. |
| `schema generation guard: generation-mismatch` | stamp deleted, rewritten, or duplicated | The database is not this chain's. Drop and recreate it; restore data through `import-snapshot`. |
| `schema generation guard: migration-version-mismatch` | goose head is not the embedded head | A different build migrated this database. Deploy the matching binary, or recreate. Do not delete `goose_db_version` rows. |
| `schema generation guard: legacy-source-not-read-only` | the read-only setting did not take | A role default or connection parameter re-armed writes. Fix that; the exception is only safe read only. |
| Write to a `--legacy-source` connection fails `25006` | `read_only_sql_transaction` | Working as designed. That connection exports; it never writes. |
| Gate skipped: `TEST_DATABASE_URL is not configured` | design 5.3 | The gate is not passed. |
| Honey tests / `TRUNCATE` wrecked a restore in progress | restored into the shared test DB | Never restore into `TEST_DATABASE_URL`'s database. Use a disposable name. |
| `-backfill-ledger` flag unknown / help text has no such flag | flag still landing | Re-read `backend/cmd/import-snapshot/main.go`. Do not invent a wrapper script or a second CLI. Do not pass `-backfill-ledger` to `roundtrip-gate` or `export-snapshot`. |
| Backfill exit nonzero; freeze-eight tables still writable; `inventory_operations` empty | spec §9 step 4; `backfill_db_test.go` | Working as designed. Parity did not commit. Read the restore report; fix source data or the translator; retry. Do not insert freeze triggers by hand. |
| Backfill exit nonzero **and** ledger rows present or some tables frozen | translator/CLI bug | STOP. Do not delete ledger rows. Restore the pre-Phase-A snapshot onto a replacement database (section 6.5). File the report. |
| Unexplained aggregate delta at freeze (counts off, or mass > 0.0001) | spec §7.2 vs `snapshot/legacy.go` | Fail. Jar/product/propolis compare to `inventory_available`; bulk/lots/away/equipment to `inventory_balances`. Do not treat a matching grand total as a pass. |
| Report lists a negative unassigned bulk residual, or the job failed naming that residual | spec §7.4 STOP | Investigate `honey_movements` with `lot_id IS NULL` vs harvest/lot ceilings. Fix source, re-export, re-run the P0 gate, retry. Do not coerce to zero. |
| Residual-split report missing a listed split, or a split amount that is not in `verification.json` | spec §7.4 | Fail. Each split has to appear in both the restore report and the new-ledger family. Re-read the report type in `backend/cmd/import-snapshot/` after it lands. |
| `INSERT`/`UPDATE`/`DELETE` on `honey_movements` (or another freeze-eight table) raises after a reported success | freeze trigger | Working as designed. That writer should already be a T3 producer (audit (c), section 6.4). If it is a process you still need, the producer is missing — STOP and roll back via the pre-Phase-A snapshot. |
| Same write still succeeds after a reported successful freeze | freeze did not install | Treat as a failed backfill. Do not operate as if Phase A committed. |
| `stock_locations` or `equipment_type_components` write raises during Phase A | those tables are not in the freeze-eight | Unexpected. The freeze covers only the eight tables in section 6.4. Investigate a bad trigger. Those writers still have to move before Phase B. |
| You dropped `inventory_operations` / movements to "undo" Phase A | not a rollback | Restore the pre-Phase-A snapshot (section 6.5). The ledger is not a scratch pad. |
| Physical count written as `product_adjustments` / `jar_adjustment` / equipment adjustment after freeze | freeze-eight writer | Use `count_adjust` through `app/inventory`. Legacy adjustment paths are the writer set in section 6.4. |
| Harvest true-up refused: "the lot allocation" / a lot named, after backfill | §7.4 residual guard (section 6.4a) | Working as designed. The session's lots still claim pounds the true-up would remove. Lower or unlink that lot, then re-run the true-up. Do not edit `harvest_lots.honey_weight_lbs` by hand. |
| Harvest entry delete refused although it "worked before Phase A" | §7.4 residual guard (section 6.4a) | Same rule, other handler. Lower or unlink the lot that claims those pounds. If the refusal names non-voided bottling runs instead, void those runs first — that is a deliberate audit-trail act, not a workaround. |
| A harvest whose lots already over-claim edits fine, and you expected a refusal | guard refuses a **breach**, not a pre-existing negative residual (section 6.4a) | Expected. The edit did not create the inconsistency. The reset gate refuses to carry a negative residual into Phase B; fix it there with a `count_adjust` / lot correction, not by blocking the edit. |
| GnuCash rows still typed `honey_movement` / `stock_movement` / `equipment_stock` / `equipment_stock_adjustment` / `product_adjustment` / `stock_location` after freeze | re-key not run | Section 6.6: six-type re-key, then content-hash rebaseline, then folio verify, then `markReconciled`. Do not enable sync. Allowlist: `backend/internal/httpapi/external_sync.go`. |
| First post-freeze rescan marks every GnuCash row `diverged` | content-hash not rebaselined | Rebaseline against unchanged `remote_transaction_guid` / `remote_enter_date` before treating remote drift as real (section 5.5 / 6.6). |
| `backfill_db_test.go` / `translate_test.go` skipped | `TEST_DATABASE_URL` unset | The freeze/parity contract is not proven. Not a pass. |

### Restore report outcomes (importer)

| Outcome | Meaning |
|---|---|
| `created` | Preserved ID was absent and was written (or would be, on dry run). |
| `unchanged` | Preserved ID present with identical semantic content. Second import of the same artifact must be all of these. |
| `updated` | Present with different content and `-conflict-policy overwrite`. Not faithful (`updated_at` stamped now). |
| `skipped` | Conflict left alone under `-conflict-policy skip`. |
| `conflicted` | Present with different content and policy `fail`. Always a `conflict` error. |
| `failed` | Validation, reference resolution, or write failed. |

A run is not OK unless `conflicted` and `failed` are both zero
(`Report.OK` in `backend/internal/app/restore.go`).

---

## References

- Format and security: `docs/snapshot-format.md`
- Gate procedure, matrix, A1–A22, disposable DB: `docs/plans/2026-09-01-roundtrip-gate-design.md`
- Reset policy and acceptance: `docs/product-roadmap.md` (P0)
- Phase A / Phase B sequence: `docs/product-roadmap.md` item 9, **Pre-launch replacement phases**
- Ledger spec (translation, parity, residual splits, freeze, tests): `docs/plans/2026-09-01-inventory-ledger-design.md` sections 7, 8, 9, 12
- Writer / reader / freeze-set / six-type re-key audit: `docs/plans/2026-09-02-ledger-read-path-migration.md`
- Export flags: `backend/cmd/export-snapshot/main.go`
- Restore semantics: `backend/internal/app/doc.go`, `backend/internal/app/restore.go`
- Inventory service (wave 1): `backend/internal/app/inventory/doc.go`, `build/build.go`, `service.go`, `types.go`
- Legacy aggregate family (parity oracle): `backend/internal/snapshot/legacy.go`
- Excluded configuration: `backend/internal/snapshot/registry.go`
- GnuCash refusals and guarded restore: `backend/internal/httpapi/routes_gnucash_sync.go`
- `external_sync` allowlist (re-key source): `backend/internal/httpapi/external_sync.go`
- Importer CLI (P0 restore and, this wave, `-backfill-ledger`): `backend/cmd/import-snapshot/main.go`
- Gate CLI (this wave): `backend/cmd/roundtrip-gate/`
- Restore-state column: `backend/internal/db/legacy-00001-00052/00049_gnucash_restore_state.sql`
- Ledger tables (wave 1): `backend/internal/db/legacy-00001-00052/00050_inventory_ledger.sql`
- Generation stamp: `backend/internal/db/legacy-00001-00052/00051_schema_generation.sql`
- Generation guard: `backend/internal/db/generation.go`, `backend/internal/db/db.go`
- Guard decisions A6 and OV3: `docs/plans/2026-09-01-inventory-ledger-design.md` sections 2.1 and 9 step 7
- Phase B baseline (section 7): `backend/internal/db/migrations/00001_baseline.sql` (its header comment is the regeneration procedure)
- Legacy chain, kept for reference only: `backend/internal/db/legacy-00001-00052/`
- Profile switch and the two chains: `backend/internal/db/schema_profile.go` (`BEEZ_SCHEMA_BASELINE`)
- Dropped-by-baseline declaration: `backend/internal/db/baseline_domains.go`
- Phase B tests: `backend/internal/db/schema_baseline_test.go`, `backend/cmd/roundtrip-gate/phase_b_test.go`
