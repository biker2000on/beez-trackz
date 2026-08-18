# PR 4 — Source-retained media (cairn model) + Immich originals

Branch: `feat/1f80f067-pr-4-source-retained-media`  
Migration: `00017_source_retained_media.sql` only.

## What shipped

### Transcript versions
- New `transcript_versions` table: provider, model, prompt revision, produced_at, text.
- Existing complete transcripts are backfilled as `legacy` versions.
- `media_files.current_transcript_version_id` is a pointer only (no circular FK).
- The transcribe job inserts a new version on success. A late asynq retry of a complete transcript is still a no-op and does not add a version.
- `POST /transcriptions/{id}/retranscribe` enqueues a forced pass that adds a version and never overwrites the previous version row. Failure restores `complete` and keeps the old text.
- `POST /transcriptions/{id}/select-version` lets the operator pick which stored text is current.

### Re-parse with a reviewable diff
- Parse (and GET-when-complete) returns `diff` against inspections / feedings / treatments / mite counts that already came from this recording.
- `POST /transcriptions/{id}/confirm` refuses (409) if domain rows already point at the recording.
- `POST /transcriptions/{id}/apply-reparse` applies only accepted proposals. Unmentioned confirmed rows stay put.

### Lineage
- `source_media_file_id` + `source_transcript_version_id` on inspections, feedings, treatment_events, and mite_counts.
- Confirm writes both. Inspections still also get the existing `source_media` jsonb blob.
- Existing inspections are backfilled from `source_media.mediaFileId` when the media row still exists.

### Delete invariant
- `DELETE /transcriptions/{id}` returns 409 while inspections/feedings/treatments/mite counts point at the recording.
- Photo delete returns 409 while `harvest_lot_photos` points at it. That FK is now `ON DELETE RESTRICT`.
- Linked Immich originals (`original_external=true`) drop the Beez row and MinIO renditions only.

### Photo originals
- `photos.storage_backend` + `original_ref` + `original_external`. Existing rows are `minio` with `original_ref = original_key`.
- `original_key` is nullable (Immich originals have no MinIO original).
- Package `internal/photostore`: MinIO always, small Immich client (upload / original / delete / ping / one page of search). Fake-backend tests, no live Immich at startup.
- `PHOTO_STORAGE_BACKEND` unset → Immich if configured, else MinIO. Explicit always wins.
- Bad config (unknown backend, key without URL, URL without key, malformed URL) fails loud in `config.Load`. Unreachable Immich is not a boot failure.
- Upload tries the preferred backend and falls back to MinIO.
- `POST /photos/link` adopts a library asset (`original_external=true`).
- Renditions stay MinIO. Image processing reads the original from the row's backend.
- `GET /photos/{id}/original` and public honey-story bytes resolve backend server-side. No Immich URL is handed to the browser.
- Audio stays MinIO-only.

### Settings / UI
- `GET /settings/storage` (admin): default backend, fallback, Immich health probe, counts per backend.
- `GET /photos/storage` (any signed-in user): enough for the uploader to show “Link from library”.
- Review UI: version picker, re-transcribe, re-parse diff apply.
- Settings → Photo storage card.

## Tests
- Config: Immich validation and default-backend decision.
- Photostore: Immich fake HTTP client; upload fallback to MinIO.
- Transcribe: complete transcript skip still holds; retry does not add a version; re-transcribe task is forced.
- HTTP (skip without `TEST_DATABASE_URL`): delete refuses while domain rows point; confirm writes lineage and 409s a second walkthrough; apply-reparse empty is a no-op; linked Immich delete removes the association only; public honey-story photo URL is the Beez public path.

`go test ./...` compiles and unit tests pass. Integration tests need `TEST_DATABASE_URL`.

## Not in this PR
- Yard flora Immich scan
- Photo time-series gallery
- Walking the whole Immich library (picker is one page)
