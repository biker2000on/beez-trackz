# Beez Trackz

A self-hosted beekeeping management application.

## Architecture (Go rewrite)

- **backend/** — Go API (`cmd/server`) and background worker (`cmd/worker`).
  chi + pgx + goose migrations (run automatically on boot), asynq job queue
  over Redis, MinIO for photo/audio storage. All endpoints under `/api/v1`.
- **frontend/** — Next.js view-only layer (App Router). All data flows through
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

## Migrating data from the legacy app

The legacy Next.js app stored data in the same table shapes; migrate with:

```bash
LEGACY_DATABASE_URL=postgres://... LEGACY_DATA_DIR=/path/to/old/data go run ./cmd/migrate-legacy
```

This copies every table into the new schema and uploads `data/photos` /
`data/audio` files into MinIO.

## Deploy

GitHub Actions builds `ghcr.io/biker2000on/beez-trackz-api` and
`beez-trackz-web`; `docker-compose.prod.yml` runs the full stack behind
traefik (dockhand stack on TrueNAS).
