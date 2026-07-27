# Database Schema Inventory (rewrite source of truth)

Implemented in `backend/internal/db/migrations/`. Conventions in the new schema:
uuid PKs (`gen_random_uuid()`), `timestamptz`, `updated_at` maintained by trigger, indexes on
every FK, media columns hold MinIO object keys (`photos.original_key/thumbnail_key/medium_key`,
`media_files.audio_key`). Legacy columns `honey_sales.items`, `user_settings.jar_sizes`,
`inspection_preferences`, `dashboard_preferences` were dropped.

## Global conventions (legacy → new)

- Legacy PKs: `uuid DEFAULT gen_random_uuid()`; timestamps were `timestamp` (no tz) — now timestamptz.
- No global soft-delete. `hives` has lifecycle: `is_archived` + `status` enum + `deadout_date`.
- Honey ledger tables are append-only; inventory is always derived by summing.
- All FKs NO ACTION except `honey_sale_items.sale_id` → honey_sales ON DELETE CASCADE.

## Tables

### apiaries
id, name (text NOT NULL), latitude/longitude (double), notes, canvas_layout (jsonb),
satellite_image_key (text), created_at, updated_at.

`canvas_layout` shape: `{ stands?: Array<{id, label, x, y, rotation, rows, cols}>,
northArrow?: {x, y, rotation}, zoom?, offsetX?, offsetY? }` — geometry only; hive slot
occupancy lives in relational hive columns.

### hives
id, apiary_id → apiaries NOT NULL, position_label (text NOT NULL), stand_id (text, references
stand id inside apiary canvas_layout JSON — not a DB FK), slot_row int, slot_col int,
placement hive_placement DEFAULT 'full', facing_degrees int DEFAULT 0,
status hive_status NOT NULL DEFAULT 'active', installed_date, is_archived bool NOT NULL
DEFAULT false, deadout_date, notes, created_at, updated_at.

### hive_location_history (append-only)
id, hive_id → hives, apiary_id → apiaries, position_label NOT NULL, date_from NOT NULL,
date_to (null = current), created_at.

### hive_splits (append-only)
id, parent_hive_id → hives, child_hive_id → hives, split_date NOT NULL,
split_type split_type NOT NULL, frames_moved int, notes, created_at.

### queens
id, hive_id → hives (null), origin queen_origin NOT NULL, origin_hive_id → hives (null),
parent_queen_id → queens (self-FK, new), introduced_date, status queen_status DEFAULT 'active',
notes, created_at, updated_at.

### inspections
id, hive_id → hives NOT NULL, date NOT NULL, inspector_name, queen_seen bool, queen_health,
brood_pattern, stores_honey int, stores_pollen int, temperament int (1-5 ratings),
pests jsonb, treatments jsonb, notes, source_media jsonb, weather_snapshot
jsonb, created_at, updated_at.

JSON shapes: pests `Array<{type: string, count?: string}>`; treatments
`Array<{product: string, method?: string}>`; source_media
`{mediaFileId, hiveReference, rawText}` (set when created from a transcription).
`weather_snapshot` stores provider, fetch time, timezone, and the exact current
conditions captured when the inspection was created.

### feedings (append-only)
id, hive_id → hives NOT NULL, date_fed NOT NULL, type feed_type NOT NULL,
quantity double NOT NULL, quantity_unit quantity_unit NOT NULL, feeder_type (null),
date_empty (null = feeder still on), notes, created_at.

### harvest_sessions
id, apiary_id → apiaries NOT NULL, date NOT NULL, total_extracted_weight double, notes, created_at.

### honey_harvests
id, session_id → harvest_sessions (null), hive_id → hives NOT NULL, date NOT NULL,
super_weight_before double NOT NULL, super_weight_after double NOT NULL,
calculated_honey_weight double NOT NULL, notes, created_at.

### honey_sales
id, date NOT NULL, customer_id → customers, harvest_lot_id → harvest_lots,
customer_name, location, channel, payment_method, total_amount double NOT NULL,
discount_amount, amount_paid, order_status, order_number (unique when present),
due_date, wholesale_price_list_id → wholesale_price_lists, notes, created_at.

### jar_sizes
id, label text NOT NULL UNIQUE, honey_oz double, default_price double,
sort_order int NOT NULL DEFAULT 0, is_active bool NOT NULL DEFAULT true,
low_stock_threshold int NOT NULL DEFAULT 6, created_at.

### honey_movements (append-only ledger)
id, date NOT NULL, kind honey_movement_kind NOT NULL, amount_lbs double,
jar_size_id → jar_sizes, quantity int (negative allowed for adjustments), reason, notes, created_at.
Semantics: `jarring` bulk→jars (amount_lbs derived from size honey_oz × qty / 16);
`bulk_use`/`loss` consume bulk via amount_lbs; `give_away`/`jar_adjustment` move jars via
jar_size_id + quantity.

### honey_sale_items
id, sale_id → honey_sales ON DELETE CASCADE NOT NULL, jar_size_id → jar_sizes NOT NULL,
quantity int NOT NULL, unit_price double NOT NULL. (No timestamps.)

### mite_counts (append-only)
id, hive_id → hives, inspection_id → inspections (optional), date, method,
mites_count, sample_size, generated mites_per_100, notes, created_at. One count
per inspection/method.

### treatment_events and queen_events (append-only)
Treatment events store hive/inspection, applied and removed dates, product,
method, and notes. Queen events store hive/queen, event date, constrained
event type, and notes. Both feed the unified hive timeline.

### harvest_lots, bottling_runs, and jar_serials
Harvest lots store unique lot code/public slug, extraction date and weight,
variety, season, approximate region, bloom/story/testing data, reorder URL,
and public flag. Join tables connect source `honey_harvests` and curated
`photos`. Bottling runs connect a lot to a jar size, date, quantity, honey
weight, and optional globally unique jar serials.

### expenses
Expense date, constrained category, description, amount, optional apiary,
hive, harvest lot, season, vendor, quantity/unit, notes, and created_at.

### customers and wholesale pricing
Customers store contact fields, explicit email opt-in, referral code, and
referral source; email uniqueness is case-insensitive. Wholesale price lists
store a minimum order and per-jar-size prices.

### equipment_types
id, name text NOT NULL UNIQUE, category equipment_category NOT NULL, frames_per_box int,
is_default bool NOT NULL DEFAULT false, created_at.

### equipment_stock
id, type_id → equipment_types NOT NULL, total_owned int NOT NULL DEFAULT 0,
frame_condition frame_condition (null), storage_location, notes, created_at, updated_at.

### equipment_stock_adjustments (append-only)
id, stock_id → equipment_stock NOT NULL, quantity int NOT NULL (signed delta),
reason stock_adjustment_reason NOT NULL, notes, date NOT NULL, created_at.

### equipment_deployments
id, stock_id → equipment_stock NOT NULL, hive_id → hives NOT NULL, quantity int NOT NULL
DEFAULT 1, date_deployed NOT NULL, date_removed (null = deployed), notes, created_at.

### bloom_observations
id, apiary_id → apiaries NOT NULL, species text NOT NULL, date_first_seen date NOT NULL,
date_last_seen date (null = active bloom), year int NOT NULL, abundance int, notes, created_at.

### photos (append-only)
id, owner_type media_owner_type NOT NULL, owner_id uuid NOT NULL (polymorphic: hive/apiary/
inspection, no FK), original_key text NOT NULL, thumbnail_key, medium_key, taken_date,
caption, tags jsonb (`string[]`), created_at, updated_at.

### media_files
id, audio_key text NOT NULL, transcription_text, transcription_status NOT NULL DEFAULT
'pending', transcription_error text (new), owner_type, owner_id (polymorphic), created_at, updated_at.

### ai_recommendations (append-only)
id, hive_id → hives (null = apiary-wide), type recommendation_type NOT NULL,
message text NOT NULL, priority text NOT NULL DEFAULT 'normal' (values urgent|high|normal|low),
dismissed bool NOT NULL DEFAULT false, created_at.

### app_users and apiary_memberships
`app_users` stores canonical auth subject, display name, email, administrator
flag, active flag, and timestamps. `apiary_memberships` has a composite
`(user_id, apiary_id)` key and `viewer|editor` role. Existing password/OIDC
owners migrate as administrators.

### api_tokens and offline_mutation_receipts
API tokens store only a SHA-256 token hash, owner, name, last-use/expiry, and
creation time. Offline receipts use `(user_id, mutation_id)` as the key and
retain a completed JSON response for idempotent PWA replay.

### apiary_weather_cache
One row per apiary with the exact coordinates, provider JSON, fetch time, and
expiry. Coordinate changes invalidate the cached match.

### user_settings (single-row instance settings)
id, password_hash (null when OIDC-bootstrapped), display_name, ai_provider_config jsonb,
theme text DEFAULT 'system', default_apiary_id → apiaries (null), date_format text DEFAULT
'MM/DD/YYYY', weight_unit text DEFAULT 'oz', created_at, updated_at.

`ai_provider_config` shape: `{ transcription: {provider, model?}, recommendations: {provider,
model?}, imageAnalysis: {provider, model?}, import?: {provider, model?}, apiKeys: {anthropic?,
google?, ollamaUrl?} }`, provider ∈ claude|gemini|ollama.

### oidc_identities
id, issuer NOT NULL, subject NOT NULL, display_name, email, user_id →
app_users, created_at, last_login_at, UNIQUE (issuer, subject).

## Enums

| enum | values |
|---|---|
| hive_status | active, dead, sold, combined |
| hive_placement | full, top, bottom, left, right |
| queen_origin | purchased, swarm, raised, walked, emergency_cell, unknown |
| queen_status | active, superseded, dead, missing |
| feed_type | sugar_syrup_1to1, sugar_syrup_2to1, dry_sugar, pollen_patty, fondant, other |
| feeder_type | entrance, top, frame, baggie, bucket, open, other |
| quantity_unit | lbs, oz, quarts, gallons |
| media_owner_type | hive, apiary, inspection |
| transcription_status | pending, processing, complete, failed |
| recommendation_type | inspection_due, treatment_reminder, equipment_needed, seasonal_prep, feeder_check |
| split_type | walk-away, vertical, nuc, cutdown, other |
| equipment_category | box, cover, bottom, accessory, frame, other |
| stock_adjustment_reason | purchased, built, discarded, broken, gifted, other |
| frame_condition | drawn, fresh |
| honey_movement_kind | jarring, bulk_use, loss, give_away, jar_adjustment |
| apiary_access_role | viewer, editor |
