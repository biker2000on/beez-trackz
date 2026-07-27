# Backend Behavior Spec (from legacy app — Go rewrite source of truth)

Legacy: Next.js server actions + a few API routes. New: Go REST API under `/api/v1`.
`user_settings` remains the single instance-configuration row, while
`app_users` and `apiary_memberships` scope operational data per person.

## Auth

- bcrypt cost 12 for password hashing.
- Session: JWT HS256 signed with `SESSION_SECRET`; claims `{authenticated: true, sub, name, iat, exp}`;
  `sub` = `"password"` for password logins or the OIDC subject. TTL 30 days.
- Cookie `session`: httpOnly, secure (prod), sameSite lax, maxAge 30d, path /.
- Bearer JWTs and personal `bt_...` API tokens are accepted.
- Setup flow: if no user_settings row → setup required. Setup takes displayName + password
  (≥8 chars, confirmed). If a row exists WITH passwordHash → "Setup already completed".
  If row exists without password (OIDC-bootstrapped) → only an authenticated
  administrator can add the password.
- Login: password only. No row → setup required. Row without passwordHash → error (SSO-only).
- OIDC (openid-client → Go: coreos/go-oidc + oauth2): enabled iff OIDC_ISSUER/CLIENT_ID/CLIENT_SECRET
  set. PKCE S256 + state + nonce, txn stored in signed JWT cookie `beez_oidc_txn` (TTL 600s).
  Callback: bind `(issuer, subject)` to a pre-authorized active `app_users`
  record. A pending collaborator can be claimed by matching a verified OIDC
  email. Only the first identity on an empty instance bootstraps as an
  administrator; unknown later identities are denied.
- Administrators assign `viewer` or `editor` per apiary. Viewers are read-only;
  editors can mutate operational records in assigned apiaries. Global
  instance settings, AI configuration, inventory, and commerce are
  administrator-only.
- Login page probes GET oidc login endpoint: 404 when unconfigured (hides SSO button).

## API conventions (new)

- Base `/api/v1`, JSON, camelCase fields matching legacy TS shapes.
- Errors: `{"error": "message"}` with appropriate status (400 validation, 401, 404, 500).
- Auth middleware on everything except `/auth/*`, public Honey Story routes
  under `/public/honey-stories/*`, and `/healthz`.
- The Next frontend proxies `/api/*` to the Go server (same-origin cookies).
- The service worker adds `X-Offline-Mutation-ID` UUIDs only to supported PWA
  field mutations. Completed
  responses are stored per user and returned on retry. Replayed updates send
  `X-Offline-Queued-At`; a newer server row returns 409 plus
  `X-Offline-Conflict`.
- `/api/v1/mcp` implements MCP Streamable HTTP with immediate JSON responses
  (protocol `2025-11-25`). API-token authentication and all tool calls use the
  same apiary authorization checks as REST.

## Domain behavior (must-preserve rules)

### Apiaries
- create/update: name required (trimmed); lat/lng parsed float rounded to 6 decimals, empty → null.
- delete guard: refuse when apiary has hives ("Cannot delete apiary with active hives.").
- list: include hiveCount (non-archived, deadout_date null).

### Hives
- create: apiaryId required; auto-generate positionLabel from stand/slot when blank
  (`{standLabel}{row*cols+col+1}`, placement suffix ` (placement)` if not full; unassigned → "Unassigned");
  error if no label. Transaction: insert hive + initial hive_location_history
  (date_from = installedDate || now).
- move: transaction — close current location history (date_to=now where null), open new row,
  update hive apiary/positionLabel.
- delete: delete location history then hive.
- markDeadout: status=dead, isArchived=true, deadoutDate=now.
- bulkCreate: quantity ≥1; label `{startLabel}{i+1}` or `Hive {i+1}`; each with location history.
- bulkUpdate: {hiveIds[], status?, isArchived?}; status dead also sets deadoutDate.
- facingDegrees normalized `((round%360)+360)%360`.

### Canvas
- saveCanvasLayout: persist geometry only (stands, northArrow, zoom, offsetX/Y) — strip occupancy.
- assignHiveToSlot: THE single write path for placement: transaction closes current location
  history, opens new (label from slot), updates hive stand/slot columns. Returns positionLabel.
- createHiveFromCanvas, updateHiveFromCanvas (label/status/notes/placement — must seed placement
  from current value, legacy bug reset it to full), setHivePlacement, removeHiveFromSlot
  (clears stand/slot, placement→full), setHiveFacing.

### Queens
- create/update with "__none__"→null sentinel handling now done client-side; API takes nulls.
- Lineage/descendants: recursive CTEs on parent_queen_id (up and down).

### Inspections
- Ratings stores_honey/pollen/temperament ints 1–5 or null. queenSeen bool or null.
- ONE shared write path used by both CRUD API and offline sync endpoints.
- Recent inspections join hive+apiary, limit param (default 10).
- Inspection creation and transcription confirmation also persist structured
  mite counts, operational treatment events, feedings, and queen events in the
  same transaction.
- New inspections capture the current Open-Meteo conditions for the hive's
  apiary in `weather_snapshot`; provider failure never blocks field recording.

### Feedings
- create requires hiveId, dateFed, type, quantity, quantityUnit. markEmpty sets dateEmpty=now.
- Active feedings = dateEmpty null, joined hive+apiary.

### Splits
- createSplit: transaction — create child hive (status active, installedDate=splitDate) +
  child location history + hive_splits row.
- getSplitsForHive: hive as parent or child, enriched with labels.

### Honey ledger (inventory is ALWAYS derived, never stored)
- createHarvest: calculatedHoneyWeight = before − after, error if negative.
- recordJarring{date, lines[{jarSizeId,quantity}], lossLbs?, lossReason?, notes?}: lines qty>0;
  error when no lines and no loss; amountLbs = honeyOz != null ? honeyOz*qty/16 : null;
  optional loss movement (reason default "jarring loss").
- recordBulkMovement{kind bulk_use|loss, amountLbs>0, reason?}.
- recordGiveAway{lines}; adjustJarCounts{lines[{jarSizeId,delta≠0}], reason default "manual correction"}.
- recordSale supports customer/lot, channel, payment, discounts, order state,
  due date, and wholesale pricing. It aggregates duplicate jar-size lines,
  rejects negative prices, locks affected jar sizes before checking inventory,
  and inserts the sale + items in one transaction. A selected wholesale list
  is authoritative for unit prices and minimum-order validation.
- updateSale advances draft/pending orders to paid or fulfilled and records
  payment without recreating line items. deleteSale cascades and returns jars
  to derived inventory.
- getJarInventory per active size: jarred=Σ jarring qty, givenAway, adjusted, sold(Σ sale items);
  onHand = jarred + adjusted − sold − givenAway.
- getHoneyOverview: totalHarvestedLbs = Σ session extracted if >0 else Σ per-hive harvests;
  jarredLbs/bulkUsedLbs/lossLbs from movements amountLbs by kind;
  bulkOnHand = harvested − jarred − bulkUsed − loss; plus totalRevenue, jarsSold, inventory.
- getHoneyTimeline(limit 50): movements + sales merged, human description, date desc.
- getSaleLocations: distinct non-null locations (autocomplete).
- Date-only strings (YYYY-MM-DD) parse in LOCAL time, not UTC.

### Harvest sessions
- addEntry: honeyWeight = before − after ≥ 0; uses session date.
- trueUp sets totalExtractedWeight. Detail: entries + calculatedTotal + difference.
- Session list with entryCount + calculatedTotal.

### Jar sizes
- getJarSizes seeds defaults if empty: Half Pint 12oz, Pint 22, Quart 44, Half Gallon 88,
  Gallon 176 (idempotent). create: unique label, sortOrder = max+1. update: label/honeyOz/price/isActive.

### Operations reports
- `GET /hives/{id}/timeline` merges inspections (with inline photos),
  feedings, treatments, mite counts, queen events, harvests, splits, and moves.
- Structured Varroa counts support alcohol wash, sugar roll, sticky board, and
  visual methods. `/analytics/varroa` pairs nearest pre/post-treatment counts
  and calculates efficacy when both normalized samples exist.
- `/analytics/survival`, `/analytics/yield`, and `/analytics/economics` report
  winter outcomes, hive/apiary/year yield, queen/split outcomes, and allocated
  cost and revenue metrics.

### Harvest-to-sale
- Harvest lots connect extraction weight, source hive harvests, selected
  photos, testing data, bottling runs, optional jar serials, and sales.
  Recording a bottling run also writes the corresponding jarring movement.
- Public Honey Story JSON, QR images, and curated lot photos are readable
  without a session. Exact coordinates, raw inspections, and operational IDs
  or bottling notes are not exposed. Reorder links accept only HTTP(S) URLs.
- Sales carry customer, harvest lot, channel, payment, discount, amount paid,
  status, order number, due date, and optional wholesale price list. Draft and
  pending orders reserve inventory; cancelled orders do not.
- Expenses can be assigned to an apiary, hive, season, or harvest lot.
  Profitability is reported overall and by channel, jar size, lot, season, and
  apiary. Production planning uses recent sales velocity and bulk inventory.

### Equipment v2
- stock list with deployed = Σ active deployment qty, available = totalOwned − deployed.
- adjustStock: transaction insert adjustment + totalOwned += quantity (delta ≠ 0).
- createStock: insert; if initialQuantity>0 record "purchased" adjustment "Initial stock".
- bulkAdjust{lines[{stockId,newTotal}]}: delta vs current, reason other, notes "bulk edit".
- deploy{stockId, hiveId, quantity≥1}; removeDeployment sets dateRemoved=now.
- getFrameSummary: standalone frames by condition minus active deployments + deployed-box
  frame capacity (framesPerBox × qty) → {standalone, boxFrameCapacity, boxBreakdown, grandTotal}.
- seedDefaultEquipmentTypes: idempotent 14 defaults (Deep/Medium/Shallow @10 frames, covers,
  bottoms, accessories, frames); backfills framesPerBox on existing box types.

### Bloom observations
- create: apiaryId, species, dateFirstSeen required; year = dateFirstSeen.year; abundance 1-5 null ok.
- endBloom/updateLastSeen: dateLastSeen = today (date only).
- species autocomplete: distinct species by most recent.
- Apiary bloom predictions use observations within 50 miles, with
  distance/current-apiary weighting and a seven-day forecast temperature
  adjustment. Ten-day weather responses are cached for 30 minutes and include
  cold/wind alerts plus active-feeder status.

### Queen performance
- `/analytics/queen-performance` scores each visible queen from brood pattern
  (30%), temperament (25%), normalized honey yield (30%), and colony survival
  (15%), then aggregates scores by the oldest known mother line.

### Hive QR and NFC tags
- `/hives/{id}/tag` returns the authenticated hive URL, NFC URL record, and
  supported MUNBYN label profiles. `/hives/{id}/tag/qr` returns a private,
  authenticated PNG.

### Recommendations
- list active: undismissed ordered urgent<high<normal<low then createdAt desc; dismiss(id); count.
- runCheck: enqueue job (or run synchronously) — engine below.

### Settings
- preferences: theme, defaultApiaryId, dateFormat, weightUnit.
- ai-settings: per-task provider/model (transcription default gemini, recommendations claude,
  imageAnalysis claude, import claude) + apiKeys {anthropic, google, ollamaUrl}.
  testConnection(provider, key) hits provider live. Ollama model listing via GET {url}/api/tags.

### Photos
- upload multipart ≤10MB, ownerType hive|apiary|inspection + ownerId + caption + tags[].
  Store original in MinIO key `photos/{ownerType}/{ownerId}/{timestamp}_{sanitizedName}`
  (sanitize: non [a-zA-Z0-9._-] → _). Insert row, enqueue image job.
- Worker generates thumb (width 200) + medium (width 1200), never enlarging, EXIF auto-rotated,
  same format; stores as `{base}_thumb{ext}`/`{base}_medium{ext}` keys; updates row.
- Serve via GET /api/v1/photos/file/{key} (auth-gated, streams from MinIO; thumbnails
  Cache-Control immutable 1y, others 1h).
- delete: remove objects (ignore missing) + row.

### Transcription
- upload audio (webm) → media_files row (pending) + MinIO key `audio/{id}.webm` + enqueue job.
- Worker: status processing → download audio → provider transcribe → status complete with text;
  on error status failed + transcription_error (retry 3x).
- Parse endpoint: transcription text → AI parse into ParsedInspection[]
  {hiveReference?, queenSeen?, queenHealth?, broodPattern?, storesHoney? 1-5, storesPollen?,
  temperament?, pests?[{type,count?}], treatments?[{product,method?}], notes?}. Single mode = one
  object; batch = array per hive mentioned. Sanitize ```json fences; invalid JSON → empty result.
  Bound/round numerics 1-5. Fuzzy hive matching: case-insensitive exact/substring of positionLabel.
- confirm: single mode creates inspections with hiveId = media owner; batch takes per-item hiveId;
  sourceMedia = {mediaFileId, hiveReference, rawText}.

### AI providers (HTTP clients in Go)
- Claude: Anthropic Messages API, default model claude-sonnet-4-20250514, max_tokens 4096;
  chat + analyzeImage (base64 jpeg); no transcribe.
- Gemini: default gemini-2.0-flash; chat, transcribe (inline audio/webm base64), analyzeImage.
- Ollama: default http://localhost:11434 model llama3.2; POST /api/chat; analyzeImage via
  images[]; listModels GET /api/tags; no transcribe.
- Env fallbacks for keys: ANTHROPIC_API_KEY, GOOGLE_AI_API_KEY, OLLAMA_URL.

### Recommendations engine (worker, every 6h + on demand)
- Dedup: skip when same type + same hiveId already undismissed.
- inspection_due (14d): never inspected → high "never inspected"; overdue>14 urgent, >7 high, >0 normal.
- treatment_reminder: latest inspection with treatments; duration by method: oxalic+vaporize 7,
  oxalic 1, apivar/amitraz 42, apiguard/thymol 28, formic/mite away 14, hopguard 30,
  checkmite/coumaphos 42, default 14. daysSince ≥ duration → reminder; overdue>7 high else normal.
- equipment_needed: capacity = Σ(box qty × framesPerBox) vs installed frames; shortage>0 →
  message with pct; pct>50 high.
- feeder_check (7d): active feedings; ≥7d since fed → reminder; >14 high.
- seasonal_prep by month: Feb/Mar spring (normal), Apr/May swarm (high), Sep/Oct fall (high),
  Dec/Jan winter (low). One per active hive.

## Jobs (asynq)

- media:process_image {photoId} — concurrency 2, 3 attempts exponential backoff.
- ai:transcribe_audio {recordingId} — concurrency 1, 3 attempts.
- recs:generate {} — scheduled every 6h (asynq periodic) + on demand.

## Known legacy bugs fixed in rewrite
- /api/sync/photos didn't enqueue image processing → unify write paths.
- MCP create_hive skipped location history → all hive creation goes through one code path.
- ownerId "batch" placeholder for batch transcriptions → allow null owner or apiary owner.
