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
- Privacy note: the apiary canvas's optional satellite layer loads imagery
  from `arcgisonline.com`, which necessarily sends the map tile coordinates
  (and therefore the approximate apiary location) to that third party. Skip
  the satellite layer if that is a concern.

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
`beez-trackz-web` **only when you run "Build and publish images" from the
Actions tab** (`workflow_dispatch`). Push and PR no longer trigger it —
automatic builds were burning minutes on docs-only commits.
`docker-compose.prod.yml` runs the full stack behind traefik (dockhand stack
on TrueNAS). Before publishing either image, CI runs the Go suite against
PostgreSQL 16 (including all goose migrations), lints the frontend, and
produces a Next.js production build.

**CI only publishes images — deployment is a manual SSH step.** The stack is
a Dockhand *internal* stack, so no webhook redeploys it. The API runs goose
migrations at startup, which means every deploy that carries new migrations
mutates the production database: **always back up first**.

From a machine with SSH access to the NAS (stack dir
`/mnt/docker/volumes/dockhand/stacks/Truenas/beez-trackz`):

```bash
# 1. Back up the database (backups land in ~/backups — the stack dir is root-owned).
ssh justin@192.168.4.132 'mkdir -p ~/backups && docker exec beez-trackz-db-1 pg_dump -U beeztrackz beeztrackz | gzip > ~/backups/beez-trackz-$(date +%Y%m%d-%H%M%S).sql.gz'

# 2. Pin the build: set BEEZ_IMAGE_TAG=<git sha from the CI run> in the stack
#    .env (edit via the dockhand container; the stack dir is root-owned).
#    Never deploy by floating on :latest.

# 3. Pull and roll out.
ssh justin@192.168.4.132 'cd /mnt/docker/volumes/dockhand/stacks/Truenas/beez-trackz && docker compose -f docker-compose.prod.yml --env-file .env pull && docker compose -f docker-compose.prod.yml --env-file .env up -d'

# 4. Verify migrations and health.
ssh justin@192.168.4.132 'docker logs beez-trackz-api-1 2>&1 | grep goose; docker ps --format "{{.Names}}\t{{.Status}}"'
```

**Rollback:** set `BEEZ_IMAGE_TAG` back to the previous sha and `pull && up`
again. If the bad deploy ran a destructive migration, restore the pre-deploy
dump first (`gunzip -c backup.sql.gz | docker exec -i beez-trackz-db-1 psql -U
beeztrackz beeztrackz` against a stopped api/worker) — an old binary on a new
schema is not a supported state.

Required stack `.env` variables are listed at the top of
`docker-compose.prod.yml`; `MINIO_SECRET_KEY` must be distinct from
`SESSION_SECRET`.
