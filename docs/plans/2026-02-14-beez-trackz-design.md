# Beez Trackz — Design Document

**Date:** 2026-02-14
**Status:** Approved

## Overview

Self-hosted, AI-first hive management app for a sideliner beekeeper (10-50 hives). Tracks apiaries, hives, inspections, queens, equipment, feeding, honey harvest, and sales. AI-powered audio/video transcription, smart note parsing, and recommendation engine.

## Tech Stack

- **Framework:** Next.js 15 (App Router, Server Components, Server Actions)
- **Language:** TypeScript
- **ORM:** Drizzle ORM
- **Database:** PostgreSQL 16
- **Job Queue:** Redis
- **Styling:** Tailwind CSS + shadcn/ui
- **Canvas:** React-Konva (apiary layout)
- **Genealogy:** react-flow (queen family tree)
- **Deployment:** Docker Compose (app + postgres + redis) on home NAS
- **PWA:** @serwist/next for service worker, IndexedDB for offline storage

## Architecture

### Deployment

Single Docker Compose stack with three containers:

- `app` — Next.js 15 application
- `db` — PostgreSQL 16
- `redis` — Redis for background job queue (transcription, AI processing)

### Authentication

Simple password gate (bcrypt-hashed, stored in DB) with long-lived session cookie. Single-user, self-hosted — no OAuth complexity.

### AI Provider Layer

Abstracted provider interface supporting multiple backends:

- **ClaudeProvider** — Anthropic API via Max subscription
- **GeminiProvider** — Google AI Studio via Pro subscription
- **OllamaProvider** — Local models, optional fallback

User-configurable: pick which provider handles which task, set fallback chain order, toggle recommendation types on/off.

## Data Model

### Apiary

- name, location (lat/lng), notes
- canvas_layout (JSON — hive positions, north arrow angle, zoom level, satellite overlay settings)
- satellite_image_url (optional overlay)

### Hive

- belongs to Apiary
- position_label (A3, D4, etc.)
- status (active, dead, sold, combined)
- installed_date
- Location history tracked via HiveLocationHistory table (apiary_id, position_label, date_from, date_to)

### Queen

- belongs to Hive (current)
- origin (purchased, swarm, raised, walked)
- origin_hive_id (nullable — FK to parent hive if raised/split)
- parent_queen_id (nullable — self-referential FK for genealogy tree)
- marked_color (auto-calculated from introduction year using international color code)
- introduced_date
- status (active, superseded, dead, missing)
- notes

**Queen color code:**

| Year ending | Color  |
|-------------|--------|
| 1 or 6      | White  |
| 2 or 7      | Yellow |
| 3 or 8      | Red    |
| 4 or 9      | Green  |
| 5 or 0      | Blue   |

### Inspection

- belongs to Hive
- date, inspector_name
- queen_seen (boolean), queen_health (rating/notes)
- brood_pattern (rating/notes)
- stores_honey, stores_pollen (ratings)
- temperament (rating)
- pests[] (JSON — small hive beetle count, varroa count, wax moth, etc.)
- treatments[] (JSON — product, application_method, date_applied, date_to_remove)
- notes (free text, populated by AI transcription)
- source_media[] (links to original audio/video files)

### Equipment

- type (deep, medium, shallow, queen_excluder, double_screen, inner_cover, bottom_board, etc.)
- frame_capacity (nullable — 8, 10 for boxes)
- frames_installed (nullable — actual count currently in this box)
- frame_type (nullable — wax_foundation, plastic, foundationless, drawn_comb)
- belongs_to (hive_id, nullable — null means in storage)
- storage_location (text, when not on a hive)
- added_to_hive_date
- removed_from_hive_date

**Frame inventory** is an aggregate query, not a separate table:

- total_capacity: SUM of frame_capacity across all boxes
- total_installed: SUM of frames_installed across all boxes
- shortage: capacity - installed
- Breakdown by frame_type and box_type

### Feeding

- belongs to Hive
- date_fed
- type (sugar_syrup_1to1, sugar_syrup_2to1, dry_sugar, pollen_patty, fondant, etc.)
- quantity (numeric)
- quantity_unit (lbs, oz, quarts, gallons)
- feeder_type (entrance, top, frame, baggie, open)
- date_empty (nullable — filled in when checked and empty)
- notes

### HoneyHarvest

- belongs to Hive
- date
- super_weight_before, super_weight_after
- calculated_honey_weight (derived)
- notes

### HoneyInventory

- jar_size (8oz, 1lb, 2lb, quart, etc.)
- quantity_on_hand
- from_harvest_id (nullable, for traceability)

### HoneySale

- date, customer_name
- items[] (JSON — jar_size, quantity, price_per_unit)
- total_amount
- notes

### Photo

- belongs_to_type (hive, apiary, inspection)
- belongs_to_id
- original_path (full-res stored on disk)
- thumbnail_path (~200px wide)
- medium_path (~1200px wide)
- taken_date
- caption (optional, AI-suggested)
- tags[] (optional, AI-suggested)

Storage path: `/data/photos/{apiary}/{hive}/{year}/`

### MediaFile

- original_url (file storage path)
- transcription_text
- transcription_status (pending, processing, complete, failed)
- linked_to (polymorphic: hive_id, inspection_id, etc.)

### AIRecommendation

- hive_id
- type (inspection_due, treatment_reminder, equipment_needed, seasonal_prep)
- message, priority
- dismissed (boolean)
- config reference (user's inspection frequency preferences, etc.)

## AI Features

### Audio/Video Transcription

Two modes:

- **Per-hive:** Record note for a single hive, attached directly to inspection
- **Batch note:** One recording covering multiple hives — AI segments by hive reference, presents split view for review before saving individual inspection records

### Smart Note Parsing

AI reads transcription and maps natural language to structured fields (queen_seen, brood, pests, treatments, etc.). Always presented for user review before saving.

### Photo Analysis

AI vision analyzes uploaded photos and suggests tags and captions. Suggestions are editable/dismissable.

### Recommendations

Scheduled job checks hive state against user config:

- Inspection overdue reminders
- Treatment schedule reminders
- Equipment/frame shortage warnings
- Seasonal preparation suggestions
- Feeder check reminders

All recommendations are dismissable suggestions, never auto-applied.

### Hive History Summary

AI reads all inspections, harvests, treatments for a hive and generates a narrative summary on demand.

### Old Record Import

Upload audio, video, or markdown files. AI transcribes/parses into structured data, presents for review before inserting.

## Apiary Canvas Layout

- 2D drag-and-drop canvas per apiary (React-Konva)
- Place/move hive icons at positions matching real layout
- Label with position code (A3, D4)
- Draggable north arrow for orientation
- Color-coded hive status (active=green, weak=yellow, dead=red, queenless=orange)
- Tap hive icon to navigate to detail page
- Optional satellite overlay via OpenStreetMap/Mapbox free tier
- Opacity slider to blend canvas and satellite view
- Canvas state stored as JSON on Apiary record

## Queen Genealogy Tree

- Interactive family tree via react-flow (zoom, pan, drag)
- Each node: queen name/ID, hive assignment, color dot, status, date introduced
- Lines connect parent → daughter queens
- Entry points: from hive detail page, from dedicated genealogy page
- Root nodes for queens with unknown origin (purchased, caught swarms)
- Filterable by status (active queens highlighted)

## Pages & Navigation

Bottom nav on mobile, sidebar on desktop:

| Nav Item  | Page              | Purpose                                                    |
|-----------|-------------------|------------------------------------------------------------|
| Home      | Dashboard         | Overview, pending inspections, recommendations, activity   |
| Apiaries  | Apiary list/detail| Canvas layout + hive list per apiary                       |
| Hives     | Hive list/detail  | All hives, filterable/searchable                           |
| Harvest   | Honey tracking    | Harvest log, jarring, inventory, sales                     |
| Settings  | Config            | AI providers, preferences, equipment inventory, profile    |

### Hive Detail Page

- Header: position label, apiary, status, queen color dot
- Quick actions: new inspection, record note, take photo, feed
- Tabs: Inspections | Equipment | Photos | Queen | History
- Equipment tab: visual top-to-bottom stack with frame counts per box

### Dashboard Widgets

- Hives needing inspection
- Active AI recommendations
- Recent inspections
- Frame shortage summary
- Feeding status (active feeders)
- Honey inventory snapshot

## PWA & Offline

### Service Worker

- App shell cached on install
- API responses cached with stale-while-revalidate
- Static assets (thumbnails, icons) cached aggressively

### Offline Capabilities

| Feature                    | Offline | Notes                              |
|----------------------------|---------|------------------------------------|
| View recent hives/inspections | Yes  | Cached from last sync              |
| Create new inspection      | Yes     | Queued in IndexedDB                |
| Record audio note          | Yes     | Saved locally, transcribed after sync |
| Take/attach photos         | Yes     | Stored locally, uploaded after sync |
| AI features                | No      | Requires server + provider         |
| Canvas layout              | Yes     | JSON cached locally                |
| View photo timeline        | Partial | Thumbnails if previously cached    |

### Sync

- Visual indicator: "N items pending sync" in app header
- Background sync pushes queued data when connectivity returns
- Conflict resolution: server wins for existing records, queued items create new records

## Honey & Sales

### Harvest Flow

1. Select hive(s) being harvested
2. Per super: enter weight before and after extraction
3. App calculates honey yield per super and total
4. Running totals per hive and per season

### Jarring

- Log jar size + quantity after extraction
- Track: total extracted vs total jarred (shows remainder)
- Jar sizes configurable

### Sales Log

- Date, customer name, items (size + qty + price), total
- Simple table, sortable/filterable
- Running totals: revenue per season, per jar size

### Inventory

- Per jar size: jarred - sold = on hand
- Dashboard card showing available stock

## Intentionally Excluded

- VR/3D hive stack visualization
- Enterprise inventory management
- Storefront / customer-facing pages
- Payment processing / invoicing
- Individual frame tracking (box-level only)
- Tax calculations
- Multi-user / role-based access
