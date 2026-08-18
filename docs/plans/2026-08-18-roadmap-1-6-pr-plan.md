# Roadmap 1–6 execution plan

PLAN_ID: 1f80f067  
Base: `e7d1e4f` (`main`)

Wave 1 is four independent PRs. Wave 2 depends on wave 1.

Migration numbers are pre-assigned so worktrees do not collide:

| PR | Migration |
|----|-----------|
| PR 1 sales | 00015 |
| PR 3 varroa | 00016 |
| PR 4 media | 00017 |
| PR 5 yard map | 00018 |
| PR 2 lockout/queue | 00019 |
| PR 6 hive products | 00020 |

## PR Plan

### PR 1: Colony and equipment sales

**Description:** Restructure `honey_sales`/`honey_sale_items` to `sales`/`sale_items` with open `kind` discriminator (`jar` | `colony` | `equipment` plus CHECK that exactly one target is set). Migrate existing rows as `kind=jar`. One mixed sale can include colonies (sets hive `sold`, links sale, closes feeders with `sold_with_hive`) and equipment (new `sold` disposition from stock / hive deployments). Cancel restores hive, feeders, and equipment. Past-dated entry allowed. Sales nav becomes top-level; Honey keeps overview/production. Update all Go/TS call sites. Leave `kind` open for later products. Do not implement GnuCash live sync.

**Files/components affected:** `backend/internal/db/migrations/00015_sales_kinds.sql`, `backend/internal/httpapi/routes_honey.go`, `backend/internal/httpapi/routes_commerce.go`, `backend/internal/httpapi/honey_integration_test.go`, `frontend/src/features/honey/*`, `frontend/src/features/commerce/*`, `frontend/src/components/shell/nav-items.ts`

**Dependencies:** None

### PR 3: Varroa program remaining

**Description:** Add sticky-board exposure days; mites-per-day for boards. Thresholds + treat-now recommendation rule. Sampling-due reminder. PATCH/DELETE mite counts and inspection edit that updates `mite_counts`. Apiary-wide varroa analytics (which hives over threshold). Bound efficacy windows; include board counts via per-day rate. Hive overview shows last mite number. MCP `record_mite_count`. Tests for analytics pairing.

**Files/components affected:** `backend/internal/db/migrations/00016_varroa_program.sql`, `backend/internal/httpapi/routes_operations.go`, `backend/internal/recs/rules.go`, `backend/internal/httpapi/routes_mcp.go`, `frontend/src/features/operations/varroa-panel.tsx`, `frontend/src/features/inspections/*`, `frontend/src/features/hives/detail-page.tsx`

**Dependencies:** None

### PR 4: Source-retained media and Immich

**Description:** Version transcripts (provider/model/prompt/produced-at); never overwrite a complete transcript. Re-transcribe and re-parse actions in review UI; re-parse proposes diffs, does not silently rewrite confirmed rows. Lineage from feedings/treatments/mite counts to media. Refuse delete of source while domain rows point at it. Photo backend: `storage_backend` + `original_ref`; MinIO always; Immich optional via `IMMICH_BASE_URL`/`IMMICH_API_KEY`; per-photo resolution; renditions stay MinIO; upload falls back to MinIO; link-from-library adopt not copy. Settings health probe. Audio stays MinIO-only.

**Files/components affected:** `backend/internal/db/migrations/00017_source_retained_media.sql`, `backend/internal/jobs/transcribe.go`, `backend/internal/httpapi/routes_photos.go`, `backend/internal/httpapi/routes_transcriptions.go`, `frontend/src/features/photos/*`, `frontend/src/features/transcription/*`, `frontend/src/features/settings/*`

**Dependencies:** None

### PR 5: Yard map, elevation, and sun

**Description:** Leaflet under the canvas and as the apiary location picker. `apiaries.elevation_m` nullable, filled from geolocation altitude, terrain lookup, or operator override. Tile layers: Esri World Imagery (default), street/labels. Leaflet owns pan/zoom below 19. Register/calibrate stand layer (offset/rotation/scale in `canvas_layout`). Derive hive lat/lng from registered canvas. Date-scrubbable sunrise/sunset bearings and simple hive-body shadows. Delete zoom-19 mosaic once Leaflet is underneath. No invented coordinates.

**Files/components affected:** `backend/internal/db/migrations/00018_yard_map_elevation.sql`, `backend/internal/httpapi/routes_apiaries.go`, `backend/internal/httpapi/routes_canvas.go`, `frontend/src/features/canvas/*`, `frontend/src/features/apiaries/*`

**Dependencies:** None

### PR 2: Treatment lockout, lot moisture, Saturday yard queue

**Description:** Treatment products have withdrawal windows. Harvest sessions and market/sales refuse lots whose source hives are inside withdrawal. Record moisture on harvest session and lot; warn/reject wet lots at harvest not market. Saturday yard queue page: phone-first, offline-capable, built from open recs + harvest readiness + feeding status + lockout + mite due + split readiness if present.

**Files/components affected:** `backend/internal/db/migrations/00019_lockout_moisture_queue.sql`, `backend/internal/httpapi/routes_harvest_sessions.go`, `backend/internal/httpapi/routes_honey.go`, `frontend/src/features/honey/*`, `frontend/src/features/operations/*`, `frontend/src/components/shell/nav-items.ts`

**Dependencies:** PR 3

### PR 6: Other hive products on the open sale kind

**Description:** Product catalog (name, kind, unit, default price). Propolis harvest (grams, hive/yard) that does not touch honey pounds. Creamed/hot-honey/mead batches as conversions with input movements. Sale lines of those kinds on the PR 1 `sale_items` table. Market day product buttons. Do not invent a second sales system.

**Files/components affected:** `backend/internal/db/migrations/00020_hive_products.sql`, `backend/internal/httpapi/routes_commerce.go`, `frontend/src/features/commerce/*`, `frontend/src/features/honey/*`

**Dependencies:** PR 1
