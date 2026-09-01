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
`docs/product-roadmap.md`.

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
| `gnucash_sync_settings.restore_state` and mark-reconciled | **Landing in this wave** | `backend/internal/db/migrations/00049_gnucash_restore_state.sql` and `backend/internal/httpapi/routes_gnucash_sync.go` |

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
  [-minio-use-ssl]
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

### What the driver does (design section 2)

The operator runs one command:

```text
TZ=UTC go run ./cmd/roundtrip-gate \
  -database <admin-url> \
  -workdir /safe/path/gate-run \
  [-keep] [-skip-media]
```

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
   disabled through post-restore reconciliation.
7. Only then is it acceptable, as a **later P1 act**, to replace the
   development database and squash migrations. Wave 2 does not squash
   anything.

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
| You planned to enable GnuCash sync before pull-first reconciliation | Roadmap C9. |
| `formatVersion` is not `1` and this build has no transform for it | Importer must not guess schema from `appCommit`. |
| You do not have the wrapping checksum and the artifact on storage independent of the database being replaced | A successful import into a database you then drop is not a backup. |

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

Entity re-key of the nine dissolving `external_sync.entity_type` values and
content-hash rebaseline against unchanged `remote_transaction_guid` /
`remote_enter_date` apply when restoring into the **P1** schema, not during
this same-schema rehearsal.

---

## 6. Troubleshooting

Importer and gate failures are per-file / per-record. A silent partial restore
is a bug. Kinds come from `backend/internal/app/errors.go`. Report outcomes
come from `backend/internal/app/restore.go`. Gate comparison classes come from
design section 3. GnuCash messages come from
`backend/internal/httpapi/routes_gnucash_sync.go`.

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
| Gate skipped: `TEST_DATABASE_URL is not configured` | design 5.3 | The gate is not passed. |
| Honey tests / `TRUNCATE` wrecked a restore in progress | restored into the shared test DB | Never restore into `TEST_DATABASE_URL`'s database. Use a disposable name. |

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
- Export flags: `backend/cmd/export-snapshot/main.go`
- Restore semantics: `backend/internal/app/doc.go`, `backend/internal/app/restore.go`
- Excluded configuration: `backend/internal/snapshot/registry.go`
- GnuCash refusals and guarded restore: `backend/internal/httpapi/routes_gnucash_sync.go`
- Importer CLI (this wave): `backend/cmd/import-snapshot/`
- Gate CLI (this wave): `backend/cmd/roundtrip-gate/`
- Restore-state column (this wave): `backend/internal/db/migrations/00049_gnucash_restore_state.sql`
