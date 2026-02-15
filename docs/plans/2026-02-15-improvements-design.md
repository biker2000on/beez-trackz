# Beez Trackz Improvements — Design Document

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:writing-plans to create the implementation plan from this design.

**Goal:** Address 15 improvement items covering theme/visual identity, canvas stand management, bulk operations, harvest restructuring, honey inventory, AI provider support, flowering species tracking, and miscellaneous fixes.

**Architecture:** Extends the existing Next.js 15 + Drizzle ORM + PostgreSQL stack. No new major dependencies. All bulk operations share a reusable multi-hive selector component. Canvas enhancements build on existing react-konva infrastructure. Theme uses CSS custom properties via Tailwind.

**Tech Stack:** Next.js 15, Drizzle ORM, PostgreSQL, react-konva, next-themes, Tailwind CSS, BullMQ, Ollama

---

## Table of Contents

1. [Theme & Visual Identity](#1-theme--visual-identity)
2. [Canvas Stands & Hive Layout](#2-canvas-stands--hive-layout)
3. [Bulk Operations](#3-bulk-operations)
4. [Harvest Restructure](#4-harvest-restructure)
5. [Honey Inventory & Jar Sizes](#5-honey-inventory--jar-sizes)
6. [Apiary-Level Recordings](#6-apiary-level-recordings)
7. [AI Provider — Ollama Support](#7-ai-provider--ollama-support)
8. [Flowering Species Tracker](#8-flowering-species-tracker)
9. [Small Fixes](#9-small-fixes)

---

## 1. Theme & Visual Identity

**Items addressed:** #14 (dark mode + bee-themed colors)

### Color Palette

Natural earth tones inspired by the apiary:

| Token | Light Mode | Dark Mode | Usage |
|-------|-----------|-----------|-------|
| `bee-gold` | `#D4A017` | `#F5C542` | Primary accent, buttons, links |
| `bee-honey` | `#B8860B` | `#C4961A` | Secondary accent, active states |
| `bee-amber` | `#F5C542` | `#D4A017` | Highlights, badges |
| `bee-forest` | `#2D5016` | `#4A7C32` | Success states, healthy indicators |
| `bee-green` | `#4A7C32` | `#6BA352` | Secondary success |
| `bee-brown` | `#5C3A1E` | `#8B6914` | Borders, subtle backgrounds |
| `bee-cream` | `#FFF8E7` | `#1A1208` | Page background |
| `bee-warm-bg` | `#FDF6E3` | `#2D1F0E` | Card backgrounds |
| `bee-text` | `#3D2B1F` | `#F5E6D0` | Primary text |
| `bee-muted` | `#7A6B5A` | `#A89880` | Muted text |

### Implementation

- Install `next-themes` for dark mode toggle with system preference detection
- Extend Tailwind config with the `bee` color tokens above
- Override shadcn/ui CSS variables at `:root` and `.dark` scopes
- Dark mode toggle: icon button in sidebar header + settings page
- Store preference in `localStorage` (via next-themes) and optionally in `userSettings`
- Update all existing components to use new palette tokens (replace default gray/slate references)

### Component Updates

Every existing page and component switches from default Tailwind colors to `bee-*` tokens:
- Sidebar/nav: `bee-brown` background in dark, `bee-cream` in light
- Cards: `bee-warm-bg` backgrounds
- Buttons: `bee-gold` primary, `bee-forest` for success actions
- Status badges: `bee-forest` (healthy), `bee-amber` (warning), destructive stays red
- Charts/graphs: use `bee-gold`, `bee-forest`, `bee-honey`, `bee-brown` series

---

## 2. Canvas Stands & Hive Layout

**Items addressed:** #2 (canvas stands with draw/rotate, hive orientation, labeling)

### Stand Data Model

Stands live in the existing `apiaries.canvasLayout` JSONB column. No new DB tables needed.

```typescript
interface CanvasLayout {
  stands: Stand[];
  zoom: number;
  panX: number;
  panY: number;
}

interface Stand {
  id: string;          // uuid
  label: string;       // "A", "B", "C", etc.
  x: number;           // canvas position
  y: number;
  rotation: number;    // degrees, 0-360
  rows: number;        // grid dimensions, e.g. 2
  cols: number;        // e.g. 2 for a 2x2 pallet
  slots: Slot[];
}

interface Slot {
  row: number;
  col: number;
  hives: SlotHive[];   // empty array = vacant slot
}

interface SlotHive {
  hiveId: string;
  facingDegrees: number;  // 0 = north, 90 = east, etc.
  placement: "full" | "top" | "bottom" | "left" | "right" | "third-1" | "third-2" | "third-3";
  stackLabel?: string;    // e.g. "top", "bottom", "a", "b", "c" — for display
}
```

### Grid-Based Stands

Each stand has configurable `rows x cols` dimensions set at creation:

| Configuration | Use Case |
|--------------|----------|
| `1x4` | Rail stand (4 hives in a line) |
| `2x2` | Pallet (4 hives, 2x2 grid) |
| `1x2` | Small stand |
| `2x4` | Large pallet |
| Custom | Any combo the user selects |

Cell size is fixed (represents one physical hive footprint). Stand visual size is determined by `rows x cols`. User can change dimensions later (expanding adds empty slots, shrinking warns if occupied).

### Multi-Occupant Slots

A single slot can hold multiple independent hive units for these scenarios:

| Scenario | Placements | Visual Rendering |
|----------|-----------|-----------------|
| Normal single hive | `"full"` | Full cell, one direction arrow |
| Split (top/bottom) | `"top"` + `"bottom"` | Cell splits horizontally |
| 2x 5-frame nucs | `"left"` + `"right"` | Cell splits vertically |
| 3x 2-frame nucs | `"third-1"` + `"third-2"` + `"third-3"` | Cell splits into thirds |

Each sub-unit is a fully independent hive record in the DB with its own inspections, equipment, etc.

### Auto-Labeling

- Stands get sequential letters: A, B, C, D...
- Slots within a stand: A1, A2, A3... (left-to-right, top-to-bottom)
- Multi-occupant suffixes:
  - Splits: `A1-top`, `A1-bottom`
  - Nucs: `A1a`, `A1b`, `A1c`
  - User can override any label

### Canvas Interactions

| Action | How |
|--------|-----|
| Add stand | Toolbar button, pick grid dimensions, click to place |
| Move stand | Drag the stand group |
| Resize stand | Change rows/cols from context menu or properties panel |
| Rotate stand | Rotation handle above stand, or enter degrees |
| Set hive facing | Click hive in slot, drag direction arrow or enter degrees |
| Move hive between slots | Drag hive from one slot to another (same or different stand) |
| Split hive | Context menu on slot > "Split Hive" > creates new hive, both get placement labels |
| Add nucs | Context menu on slot > "Add Nuc" > pick 5-frame or 2-frame > adds hive to slot |
| Promote nuc | Context menu > "Move to own slot" > moves hive to an empty slot |
| Recombine | Context menu on multi-occupant slot > "Recombine" > merges into single hive |
| Delete stand | Context menu, confirms if hives are assigned |

---

## 3. Bulk Operations

**Items addressed:** #3 (bulk equipment), #4 (bulk hive entry), #9 (bulk input forms), #13 (apiary-level forms)

### Multi-Hive Selector Component

A reusable `<HiveMultiSelector>` component with two input modes (toggled by tab bar):

**Mode 1: Checkbox List**
- Hives grouped by stand (Stand A, Stand B, etc.)
- Checkboxes per hive with status indicator
- "Select all" / "Select none" per stand
- "Select all active hives" button

**Mode 2: Range Picker**
- Text input accepting ranges like `A1-C4`
- Parses stand letter + slot number ordering
- Resolves to the same selected hive IDs as checkbox mode
- Supports comma-separated: `A1-A4, B2, C1-C3`

**Props:**
```typescript
interface HiveMultiSelectorProps {
  apiaryId: string;
  value: string[];           // selected hive IDs
  onChange: (ids: string[]) => void;
}
```

### Bulk Equipment (Item 3)

Add `quantity` number input to the existing equipment form. When quantity > 1:
- Creates N equipment records in a single DB transaction
- Each record gets the same type, frame capacity, frame type, etc.
- All assigned to the same hive (or storage location)
- Default quantity = 1 (existing behavior preserved)

### Bulk Hive Entry (Item 4)

New "Add Hives" section on apiary page:
- Quantity field (e.g., 10)
- Default stand assignment (auto-fills next available slots)
- Optional: set common defaults (status, installed date)
- AI import path (existing) can also create hives from CSV/scanned data

### Bulk Action Forms (Items 9, 13)

Apiary page gets a "Bulk Actions" tab/section with:

| Form | Fields |
|------|--------|
| Bulk Inspection | `<HiveMultiSelector>` + inspection form fields (date, queen seen, stores, temperament, notes) |
| Bulk Feeding | `<HiveMultiSelector>` + feeding form fields (type, quantity, feeder type, date) |
| Bulk Equipment | `<HiveMultiSelector>` + equipment form fields (type, frame capacity, frame type, quantity) |

Each creates one record per selected hive in a single transaction. Example: "2 gal bucket feeder on hives A1-C4" → one feeding record per hive in range.

---

## 4. Harvest Restructure

**Items addressed:** #12 (session-based harvest with per-hive/super breakdown and true-up)

### New Data Model

**New table: `harvest_sessions`**

| Column | Type | Description |
|--------|------|-------------|
| `id` | uuid PK | |
| `apiary_id` | uuid FK → apiaries | Which apiary |
| `date` | timestamp | Harvest date |
| `total_extracted_weight` | double | Actual weight after filtering (true-up) |
| `notes` | text | |
| `created_at` | timestamp | |

**Modified table: `honey_harvests`** (becomes per-hive/per-super entries)

| Column | Type | Description |
|--------|------|-------------|
| `id` | uuid PK | |
| `session_id` | uuid FK → harvest_sessions | Parent session |
| `hive_id` | uuid FK → hives | Which hive |
| `equipment_id` | uuid FK → equipment (nullable) | Specific super if tracked |
| `super_weight_before` | double | Weight before extraction |
| `super_weight_after` | double | Weight after extraction |
| `calculated_honey_weight` | double | Computed: before - after |
| `notes` | text | |
| `created_at` | timestamp | |

### Harvest Flow

1. **Start session:** Create harvest session (pick date, apiary)
2. **Add entries:** For each hive and super pulled, enter before/after weights. System calculates honey weight per entry.
3. **Sum check:** System shows running total of calculated honey from all entries
4. **True-up:** Enter `totalExtractedWeight` (actual honey after filtering/settling). System shows reconciliation:
   - Sum of calculated weights: X lbs
   - Actual extracted: Y lbs
   - Difference (wax/losses): (X - Y) lbs
5. **Done:** Session is complete, honey is added to available inventory

### CSV Import

Upload scanned paper record sheet → AI parses into:
- Session date, apiary
- Per-row: hive name, super identifier, before weight, after weight
- Creates session with all entries in one transaction

---

## 5. Honey Inventory & Jar Sizes

**Items addressed:** #10 (pint jar size), #11 (jar inventory subtracts from stock)

### Configurable Jar Sizes

Jar sizes stored in `userSettings.jarSizes` JSON with honey weight per jar:

```typescript
interface JarSize {
  label: string;      // "Pint"
  honeyOz: number;    // 22
}
```

**Default jar sizes:**

| Label | Honey (oz) |
|-------|-----------|
| Half Pint | 12 |
| Pint | 22 |
| Quart | 44 |
| Half Gallon | 88 |
| Gallon | 176 |

User can add, edit, and remove jar sizes from the Settings page. These feed the dropdown on the inventory form.

### Honey Balance Calculation

```
Extracted (lbs)      = SUM(harvest_sessions.total_extracted_weight)
Jarred (lbs)         = SUM(honey_inventory.quantity * jar_size.honeyOz) / 16
Jarring losses (lbs) = SUM(honey_adjustments.amount_lbs) WHERE type = 'jarring_loss'
Other adjustments    = SUM(honey_adjustments.amount_lbs) WHERE type = 'other'
Available to jar     = Extracted - Jarred - Jarring losses - Other adjustments
```

### New table: `honey_adjustments`

| Column | Type | Description |
|--------|------|-------------|
| `id` | uuid PK | |
| `date` | timestamp | When adjustment was recorded |
| `type` | enum: `jarring_loss`, `other` | Category |
| `amount_lbs` | double | Pounds lost/adjusted (positive = loss) |
| `reason` | text | Explanation |
| `created_at` | timestamp | |

### Jarring Loss True-Up Flow

After a jarring session:
1. User enters how much honey was available before jarring
2. User jars honey (creates inventory entries)
3. User enters actual remaining honey weight
4. System calculates: expected remaining = (available before) - (sum of jars in oz / 16)
5. Difference recorded as a `honey_adjustments` entry with type `jarring_loss`

### Dashboard Display

Honey widget shows:
- **Extracted:** X lbs (from all harvest sessions)
- **Jarred:** Y lbs (Z jars total)
- **Losses:** W lbs
- **Available to Jar:** (X - Y - W) lbs

When creating inventory entries, warn if jarring more than available.

---

## 6. Apiary-Level Recordings

**Items addressed:** #1 (apiary recordings transcribed to all hives)

### Current State

Recording button exists on hive pages. The media infrastructure supports `ownerType: "apiary"`. BullMQ transcription jobs and AI parsing already work.

### Changes

1. **Add recording button to apiary page** — same `<RecordingButton>` component, with `ownerType="apiary"` and `ownerId={apiaryId}`
2. **Update transcription parser** — when processing an apiary-level recording:
   - AI attempts to identify per-hive observations (using position labels like "A1", "hive B3", etc.)
   - If specific hives mentioned: creates one inspection per mentioned hive with relevant notes
   - If no specific hives: creates one inspection for ALL active hives in the apiary with the full transcription as notes
3. **Review step** — after AI parsing, show user a review screen:
   - List of hives that will get inspections
   - Parsed notes per hive
   - User can edit, remove hives, or reassign notes before confirming
4. **Bulk create** — on confirm, create all inspections in a single transaction

---

## 7. AI Provider — Ollama Support

**Items addressed:** #5 (local AI without API key)

### Current State

AI provider abstraction exists with API key-based providers (Claude, OpenAI).

### Changes

Add Ollama as a third provider option:

| Setting | Value |
|---------|-------|
| Provider | `"ollama"` |
| Base URL | `http://localhost:11434` (default, user-configurable) |
| Model | Auto-discovered from Ollama API, user picks from list |
| API Key | Not needed |

### Implementation

- Add `OllamaProvider` class implementing the existing AI provider interface
- Ollama API: `POST /api/generate` for completions, `GET /api/tags` for model list
- Settings page: when "Ollama" selected, show URL field + model dropdown (populated from `/api/tags`)
- Map to existing AI tasks: transcription parsing, recommendations, import parsing
- Error handling: if Ollama unreachable, show clear error message (no silent fallback)

### Model Recommendations (shown in UI)

| Task | Recommended Models |
|------|-------------------|
| Transcription parsing | llama3.1, mistral |
| Recommendations | llama3.1, mistral |
| Import parsing | codellama, llama3.1 |

---

## 8. Flowering Species Tracker

**Items addressed:** #15 (track bloom timing year-over-year)

### New table: `bloom_observations`

| Column | Type | Description |
|--------|------|-------------|
| `id` | uuid PK | |
| `apiary_id` | uuid FK → apiaries | Which apiary |
| `species` | text | Plant species name |
| `date_first_seen` | date | When bloom started |
| `date_last_seen` | date (nullable) | When bloom ended (updated over time) |
| `year` | integer | Year for easy querying |
| `abundance` | integer (1-5) | How much is blooming |
| `notes` | text | |
| `created_at` | timestamp | |

### UI

**"Flora" tab on apiary page** with three sub-views:

**Active Blooms (default):**
- List of currently blooming species (where `date_last_seen` is null or recent)
- Quick "Add Bloom" button: species autocomplete (from previous entries) + abundance rating
- Quick "End Bloom" button: sets `date_last_seen` to today
- Quick "Still Blooming" to update last seen date

**History:**
- Table of all observations, filterable by year
- Edit/delete capability

**Year-over-Year Comparison Chart:**
- X-axis: months/weeks of the year
- Y-axis: species (one row per species)
- Horizontal bars showing bloom window per year, color-coded by year
- Filter: year range selector, species filter
- Helps answer: "When did clover start last year vs this year?"

### Quick Entry

Designed for field use — "I see clover starting today" should be one tap:
- Float action button on Flora tab
- Species autocomplete (most recent species at top)
- Date defaults to today
- Abundance defaults to 3 (medium)
- One tap to save

### Future Enhancement (not in scope)

Correlate bloom data with harvest weights to identify which blooms drive best yields.

---

## 9. Small Fixes

### 9a. Temperament Labels (Item 6)

Replace current aggression-ambiguous scale:

| Value | Current Label | New Label |
|-------|--------------|-----------|
| 1 | 1 - Very Low | 1 - Very Aggressive |
| 2 | 2 - Low | 2 - Aggressive |
| 3 | 3 - Average | 3 - Moderate |
| 4 | 4 - Good | 4 - Calm |
| 5 | 5 - Excellent | 5 - Very Calm |

Update in `inspection-form.tsx` only. DB stores integer, no migration needed.

### 9b. Remove Record Note Button (Item 7)

- Remove "Record Note" button/link from hive pages (currently 404s)
- Replace with "Quick Inspection" button that opens a streamlined inspection form
- Quick inspection: date (defaults today) + notes textarea only, all other fields collapsed/optional
- Creates a real inspection record, just with minimal required fields

### 9c. Bucket Feeder Type (Item 8)

Add `"bucket"` to the `feeder_type` PostgreSQL enum.

Requires Drizzle migration:
```sql
ALTER TYPE feeder_type ADD VALUE 'bucket';
```

Update `feederTypeEnum` in schema and feeder type options in UI.

### 9d. Jar Size Dropdown (Item 10)

Covered in Section 5. The freetext `jar_size` field on `honey_inventory` gets replaced with a reference to the configurable jar sizes in user settings. Migration: add `jar_size_label` text column (references the label from settings), keep `jar_size` for backward compat.

---

## Migration Summary

### New Tables

| Table | Section |
|-------|---------|
| `harvest_sessions` | 4 |
| `honey_adjustments` | 5 |
| `bloom_observations` | 8 |

### Modified Tables

| Table | Change | Section |
|-------|--------|---------|
| `honey_harvests` | Add `session_id` FK, `equipment_id` FK | 4 |
| `honey_inventory` | Add `jar_size_label` column | 5 |

### Enum Changes

| Enum | Change | Section |
|------|--------|---------|
| `feeder_type` | Add `bucket` value | 9c |

### No Schema Changes Needed

| Feature | Why |
|---------|-----|
| Canvas stands | Uses existing `canvas_layout` JSONB |
| Theme | CSS only |
| Bulk operations | Uses existing tables, just creates multiple records |
| Temperament labels | UI-only, DB stores integers |
| Ollama support | Config stored in existing `ai_provider_config` JSONB |
| Apiary recordings | Uses existing media/inspection tables |
