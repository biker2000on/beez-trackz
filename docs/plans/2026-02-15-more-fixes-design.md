# More Fixes & Improvements Design

**Date:** 2026-02-15
**Status:** Approved
**Scope:** 13 issues covering canvas fixes, hive management, CRUD gaps, equipment rework, and UI improvements

---

## 1. Canvas Regression Fix + Drag-and-Drop + Stacking (#1)

### Problem
Hive icons no longer render inside stand slots (stands render correctly). Need drag-and-drop between slots and max-2-high stacking.

### Regression Fix
- Debug `stand-group.tsx` — the slot rendering loop that maps `slot.hives` to `HiveIcon` components is broken (likely from rotation refactor in commit `3fe3c94`)
- Restore hive rendering within slots

### Drag-and-Drop
- `HiveIcon` components are `draggable` in edit mode
- During drag: semi-transparent clone follows cursor, original stays dimmed in place
- **Hover highlight:** Target slot gets highlighted border (blue glow/dashed outline) as hive is dragged over it
- Slot with 1 hive: highlight turns green (stacking will occur)
- Slot with 2 hives (full): highlight turns red (rejection)
- On drop: hive moves to highlighted slot, layout persists to DB
- Drop outside any slot: snap back to original position
- Updates hive's `standId`, `slotRow`, `slotCol`, `placement` in DB

### Stacking
- Max 2 hives per slot
- Visual: two overlapping rectangles offset vertically, bottom hive partially visible behind top
- Count badge "x2" on stacked slots

---

## 2. Hive Location Restructure (#8, #9)

### Schema Change
Replace `positionLabel` (free text) with structured location fields on `hives`:

```
standId     text, reference to stand in canvas layout
slotRow     integer
slotCol     integer
placement   enum: 'full' | 'top' | 'bottom' | 'left' | 'right'
```

### Display Label
Auto-generated: `"{Stand Label}{Row}{Col}"` (e.g., "A1", "B3"). Non-full placement appends suffix: "A1 (top)".

### Hive Form Changes
- Remove free-text "Position Label" input
- Add "Location" section:
  - **Stand** dropdown (populated from apiary's layout stands)
  - **Slot** dropdown (populated from stand's grid)
  - **Placement** checkboxes: top / bottom / left / right (none = full)
- When creating from canvas context menu, fields auto-populate from clicked slot

### Edit from Layout Modal (#9)
- Right-click hive on canvas > context menu > "Edit Hive" opens modal
- Modal shows: location (pre-filled, editable), status, placement checkboxes, notes
- Save updates both DB and canvas layout
- Uses shadcn `Dialog`, rendered as HTML over canvas (existing pattern)

### Migration
- Parse existing `positionLabel` like "A1" into stand "A", slot row 1, col 1
- Unparseable labels: default to first stand, first slot, full placement

---

## 3. Hive Splits (#2)

### New Table: `hiveSplits`

```
id              uuid, PK
parentHiveId    FK -> hives, NOT NULL
childHiveId     FK -> hives, NOT NULL
splitDate       timestamp, NOT NULL
splitType       enum: 'walk-away' | 'vertical' | 'nuc' | 'cutdown' | 'other'
framesMoved     integer, nullable
notes           text, nullable
createdAt       timestamp
```

### UI Integration
- **Hive detail page:** New "Splits" tab
  - "Splits From This Hive" — child hives created from this one
  - "Split Origin" — parent hive if this was created via split
- **"Split Hive" action:** Button on hive detail page
  - Pre-fills parent hive
  - Creates new child hive with location assignment
  - Records split in `hiveSplits`
  - Optionally creates queen record for child hive
- **Hive card:** Split icon/badge if hive has split history

---

## 4. Archive & Deadout (#4, #5)

### Schema Change
Add `isArchived` boolean column to `hives` (default `false`).

### Archive Behavior
- "Archive" sets `isArchived = true` — hive hidden from default views
- "Unarchive" sets `isArchived = false` — hive reappears
- All list queries filter `isArchived = false` by default
- "Show Archived" toggle on hives page reveals archived hives (visually dimmed)

### Deadout Behavior
- "Mark as Deadout" sets `status = 'dead'` AND `isArchived = true`
- Records deadout date (new `deadoutDate` field or in notes)
- On canvas: dead hives shown in gray when "Show Archived" is on

### Unarchive from Deadout
- Can unarchive deadout hives (e.g., reuse location)
- Sets `isArchived = false`, keeps `status = 'dead'` until manually changed

---

## 5. Equipment Rework (#13)

### New Tables (replace `equipment`)

**`equipmentTypes`**
```
id            uuid, PK
name          text, NOT NULL, UNIQUE (e.g., "Deep Box")
category      enum: 'box' | 'cover' | 'bottom' | 'accessory' | 'other'
isDefault     boolean, default false (true for pre-seeded)
createdAt     timestamp
```

Pre-seeded: Deep, Medium, Shallow, Queen Excluder, Inner Cover, Outer Cover, Bottom Board, Entrance Reducer, Feeder, Mouse Guard, Screened Bottom Board

**`equipmentStock`**
```
id              uuid, PK
typeId          FK -> equipmentTypes, NOT NULL
totalOwned      integer, NOT NULL, default 0 (denormalized cache)
storageLocation text, nullable
notes           text, nullable
createdAt       timestamp
updatedAt       timestamp
```

**`equipmentStockAdjustments`**
```
id            uuid, PK
stockId       FK -> equipmentStock, NOT NULL
quantity      integer, NOT NULL (positive=add, negative=remove)
reason        enum: 'purchased' | 'built' | 'discarded' | 'broken' | 'gifted' | 'other'
notes         text, nullable
date          timestamp, NOT NULL
createdAt     timestamp
```

**`equipmentDeployments`**
```
id              uuid, PK
stockId         FK -> equipmentStock, NOT NULL
hiveId          FK -> hives, NOT NULL
quantity        integer, NOT NULL, default 1
dateDeployed    timestamp, NOT NULL
dateRemoved     timestamp, nullable (null = currently deployed)
notes           text, nullable
createdAt       timestamp
```

### Computed Values
- `availableStock = totalOwned - SUM(active deployments quantity)`
- Active deployment: `dateRemoved IS NULL`

### Equipment Page (`/settings/equipment`)
- Cards per equipment type: total owned, deployed, available in storage
- "Adjust Stock" button: modal to increment/decrement with reason
- "Add Equipment Type" button: form to add custom types
- Expandable adjustment history timeline per type

### Hive Equipment Tab
- Currently deployed equipment + removal history
- "Add Equipment": dropdown of types with available stock > 0, quantity picker
- "Remove Equipment": sets `dateRemoved`, returns to available stock

### Migration
- Group existing `equipment` rows by type -> create stock entries
- Convert hive-assigned rows to deployment records
- Drop old `equipment` table

---

## 6. CRUD Gaps & Bug Fixes (#3, #6, #7, #10)

### Full CRUD Exposure (#3)
Add delete buttons with `AlertDialog` confirmation to:
- **Apiaries** — on edit page (warns about cascading hive deletion)
- **Feedings** — on list items in hive detail feedings tab
- **Bloom observations** — on flora observation list items
- **Queens** — on queen detail/edit (action exists, needs UI)

### Inspection Delete (#6)
- Verify delete is accessible from hive detail inspections tab
- Add delete button if missing

### Bulk Action Select-All Bug (#7)
- "All" button in `HiveMultiSelector` triggers form submission
- Fix: add `type="button"` to prevent default submit behavior

### Queen Form Empty String Bug (#10)
- Select components use `""` for "None" — invalid for `Select.Item`
- Fix: change to `"__none__"` sentinel (project pattern)
- Update queen action to check for `"__none__"` instead of `""`

---

## 7. Hive Table View (#11) & Preferences Page (#12)

### Hive Table View (#11)
- View toggle (card/table icons) on hives list page header
- Persist preference in localStorage (or user prefs table)
- **Table columns:** Location, Status (badge), Apiary, Installed Date, Last Inspection, Queen Status
- Client-side sortable columns
- Clickable rows navigate to hive detail
- Uses shadcn `Table` component
- Same filters (apiary, status) work in both views

### Preferences Page (#12)
- New route: `/settings/preferences`
- Add nav link in settings sidebar
- **Settings:**
  - Theme: light / dark / system (via next-themes)
  - Default apiary: dropdown
  - Date format: MM/DD/YYYY, DD/MM/YYYY, YYYY-MM-DD
  - Weight units: oz / lbs / grams / kg
  - Dashboard defaults: recent inspection count, default tab
- Stored in `userSettings` table (expand JSONB or add columns)
- Form uses `useActionState` pattern
