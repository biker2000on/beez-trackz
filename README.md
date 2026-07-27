# Beez Trackz

A self-hosted beekeeping management application.

The current product includes voice-first inspection entry, apiary-scoped
viewer/editor collaboration, offline field recording, structured Varroa and
treatment tracking, hive timelines, location-aware weather and bloom
predictions, queen performance scoring, printable/NFC hive tags, and a
harvest-to-sale workflow with lot QR stories, bottling runs, expenses,
customers, orders, wholesale pricing, and a phone-first market screen.

## Architecture (Go rewrite)

- **backend/** — Go API (`cmd/server`) and background worker (`cmd/worker`).
  chi + pgx + goose migrations (run automatically on boot), asynq job queue
  over Redis, MinIO for photo/audio storage. All endpoints under `/api/v1`.
- **frontend/** — Next.js client (App Router and installable PWA). All data flows through
  the Go API; `/api/*` is proxied to the backend so cookies stay same-origin.
- **PostgreSQL** — primary datastore. **Redis** — worker queue. **MinIO** —
  media object storage.
- **docs/rewrite/** — the ported behavior specs (schema, backend rules, UI).

## Development

Start infrastructure (Postgres, Redis, MinIO):

```bash
docker compose up -d
```

Run the API and worker (from `backend/`):

```bash
go run ./cmd/server
go run ./cmd/worker
```

Run the web app (from `frontend/`):

```bash
npm run dev
```

Copy `.env.example` values into your environment (`SESSION_SECRET` and
`DATABASE_URL` are required for the API).

## Collaboration, offline use, and MCP

- The password owner and existing OIDC identities migrate as administrators.
  Administrators add collaborators by verified OIDC email in **Settings >
  Users, access, and API**, assigning `viewer` or `editor` per apiary.
- Viewers can read their assigned apiaries. Editors can also change apiary,
  hive, inspection, feeding, bloom, photo, and operational records. Global
  AI, inventory, commerce, and instance settings remain administrator-only.
- The production PWA caches field-data reads and queues supported JSON writes
  in IndexedDB. Reconnect replays them with idempotency keys; newer server
  edits become reviewable conflicts instead of being overwritten.
- Personal API tokens are created in Settings and used as
  `Authorization: Bearer bt_...`. The MCP Streamable HTTP endpoint is
  `https://your-app.example/api/v1/mcp` and exposes only tools allowed by the
  token owner's apiary roles.
- Hive tag sheets are available from an apiary's **Print tags** action. The
  print profiles target common MUNBYN 2x1 and 3x2 inch label stock; Web NFC
  writing requires compatible Android Chrome hardware.

## Migrating data from the legacy app

The legacy Next.js app stored data in the same table shapes; migrate with:

```bash
LEGACY_DATABASE_URL=postgres://... LEGACY_DATA_DIR=/path/to/old/data go run ./cmd/migrate-legacy
```

This copies every table into the new schema and uploads `data/photos` /
`data/audio` files into MinIO.

To repair photos after cutover without touching existing operational rows,
mount the old data directory and run:

```bash
LEGACY_MEDIA_ONLY=true LEGACY_DATA_DIR=/path/to/old/data \
DATABASE_URL=postgres://... MINIO_ENDPOINT=... MINIO_ACCESS_KEY=... \
MINIO_SECRET_KEY=... migrate-legacy
```

`LEGACY_DATABASE_URL` is optional in media-only mode. When supplied, photo
metadata is copied first; otherwise the importer discovers originals using
`data/photos/{hive|apiary|inspection}/{owner-uuid}/...`. Re-running the media
repair is safe: existing photo IDs and object keys are skipped.

## Deploy

GitHub Actions builds `ghcr.io/biker2000on/beez-trackz-api` and
`beez-trackz-web`; `docker-compose.prod.yml` runs the full stack behind
traefik (dockhand stack on TrueNAS). Before publishing either image, CI runs
the Go suite against PostgreSQL 16 (including all goose migrations), lints the
frontend, and produces a Next.js production build.
