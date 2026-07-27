# UI Feature Spec (rewrite from scratch — ideas only, zero legacy code reuse)

New frontend: Next.js client in `frontend/`, all data via the Go API (`/api/v1`,
proxied same-origin). TanStack Query for data, react-hook-form + zod for forms, Tailwind +
shadcn-style components, next-themes. PWA install + manifest retained.

## Shell & navigation
- Desktop: left sidebar (logo, nav, theme toggle, logout). Mobile: bottom nav bar with
  safe-area padding. Nav: Dashboard, Apiaries, Hives, Queens (/genealogy), Recommendations,
  Honey (/harvest), Inventory, Settings.
- Warm honey/amber palette (primary amber, forest-green accent, cream bg), dark mode.
- Keyboard shortcuts: `?` help dialog, `g`+key nav sequences, per-page keys (n=new, b=bulk,
  honey j/s/u/l/v/a). Ignore while typing/dialog open.
- PWA: manifest (standalone, start /dashboard, amber theme, maskable icons),
  install prompt and iOS instructions. Cache field reads; queue supported JSON
  writes in IndexedDB; replay on reconnect and offer retry/discard for
  conflicts.

## Auth pages
- `/setup`: first-run display name + password (≥8, confirm). `/login`: password + optional
  "Sign in with SSO" (shown when API says OIDC enabled), friendly OIDC error messages from
  ?error= codes. Root `/` redirects to /dashboard.

## Dashboard
Widget grid (fixed layout, each independently loading with skeleton):
hive overview (counts by status, apiary count), recommendations top-3 with priority badges,
recent 5 inspections (hive, Q badge if queen seen, date), feeding status (active feeders,
flag >7 days), frame shortage (spare frames, drawn/fresh breakdown), honey inventory
(bulk lbs, jars on hand, revenue, per-size pills).

## Apiaries
- List: card grid (name, lat/lng, hive count) + new-apiary dialog.
- Detail tabs: Layout (canvas), Hives (cards + new hive + bulk create), Bulk Actions
  (bulk inspection + bulk feeding forms), Flora (bloom form + active blooms + history),
  Photos (upload + gallery), and Forecast (weather alerts + local bloom
  windows). Header includes MUNBYN QR/NFC hive-tag printing.
- Form: name, lat/lng with "Use current location" geolocation button, notes.

## Canvas (retain full functionality, rewrite clean)
- Konva (dynamic import, ssr:false). Two-tier persistence: stand geometry + north arrow +
  viewport in apiary canvasLayout blob (explicit Save + 1s debounced autosave, dirty flag);
  hive↔slot occupancy relational, written through immediately via API calls.
- Stands: rows×cols grids (1–8), auto-label A,B,C…, drag, rotate (snap 45° with Ctrl/Shift),
  resize, rename (≤4 chars), delete (hives become unassigned, warn).
- Hives in slots: status color, label, entrance-facing arrow; two hives per slot via placement
  (top/bottom or left/right nuc). Double-click → hive page.
- North arrow: drag + rotate + preset menu. Satellite overlay: Esri tiles when lat/lng set,
  opacity slider, anchored at mount.
- Toolbar: edit/view toggle, add stand (rows/cols popover), add hive, zoom in/out/fit,
  save state (dirty/saving/saved), satellite toggle+opacity.
- Interactions: pan bg drag, wheel/pinch zoom anchored on cursor, drag hives between slots
  with live highlight; drop on occupied slot → stack choice dialog (top/bottom vs left/right).
  Mode indicator pill. Unassigned hive tray (amber chips → move-to-slot).
- Context menus: stand (rename/resize/rotate/delete), empty slot (add new hive / assign
  existing), occupied slot (split/add nuc/remove), hive (set facing, move, remove, edit,
  flip 180°, new inspection, quick inspection, feed, photo, split).
- Dialogs: stand settings, delete stand, facing (8 compass presets + 0-359 slider),
  move-to-slot, stack choice, hive edit (label/placement/status/notes — seed placement from
  actual value, legacy bug reset it), plus embedded inspection/feeding/split/photo forms.
- Geometry: CELL_SIZE 60px, zoom 0.2–3 step 0.1, grid 40px, rotation-aware slot hit tests.

## Hives
- List: card/table toggle (persisted), filters (apiary, status, show-archived URL param),
  bulk-select mode (b) with action bar (set status, archive/unarchive).
- Detail: header (label, status badge, edit modal), quick actions (new inspection dialog,
  record inspection → transcribe, quick inspection, photo, feed, split, archive/deadout/
  unarchive). Tabs: Timeline (default, with inline inspection photos), Inspections,
  Varroa trends/treatment efficacy, Equipment (stack + deploy modal), Photos, Feedings, Queen
  (current queen card with year-color dot + history + add dialog), Splits (linked), History
  (location timeline).
- Forms: hive form (apiary select, stand/row/col, placement, auto position label, status,
  installed date, notes); inspection form sectioned (basics/queen/brood+stores 1-5 selects/
  pests dynamic list/treatments dynamic list/notes), controlled state throughout.

## Genealogy
- React Flow tree from parentQueenId, custom layout, queen nodes with international
  queen-marking year color dot, status badge, apiary—hive. Theme-synced. Add queen form
  (hive, parent queen, origin, dates, status).
- Performance table ranks queens and mother lines from brood, temperament,
  yield, and survival outcomes.

## Honey (/harvest)
- Stat strip: bulk on hand, jars on hand, revenue, used+losses.
- Quick action dialogs with shortcuts: Jar Honey (j: date, per-size jar lines, optional loss),
  Record Sale (s: date, location autocomplete, lines with price prefill + on-hand, customer,
  live total), Bulk Use (u), Loss (l), Give Away (v), Adjust Jars (a: ±delta with on-hand).
- Tabs: Activity (iconized color-tinted ledger timeline, per-row delete, bulk delete),
  Jars (inventory table), Harvests (sessions + individual), harvest Lots & QR,
  Sales/orders, phone-first Market Day, and Business (profitability, expenses,
  production plan, customers, wholesale pricing).
- Sessions: new (apiary/date/notes); detail with calculated vs actual extraction cards +
  difference, per-hive entries (before/after weights, live calc badge), true-up form.

## Inventory (/inventory)
- Seeds default equipment types on first visit. Stat strip (owned/in field/in storage/
  spare frames). Table grouped by category with bulk-edit-counts mode (b, inline inputs +
  reason + save N changes), deploy-to-hive dialog (capped at available), edit location,
  active deployments with "return to storage", add stock/type dialogs.

## Recommendations & Flora
- Recommendations page: priority-tiered list, dismiss, run-check button.
- Flora on apiary detail: bloom form (species autocomplete, first-seen, abundance 1-5, notes),
  active blooms (end bloom / still blooming), history.

## Transcription flow
- Per-hive `/hives/[id]/transcribe` (single) + `/transcribe` (batch). Audio recorder:
  MediaRecorder, permission errors, live timer, 30min cap, record/stop/playback/re-record/
  upload. Upload → job status polling every ~3s (queued/transcribing/failed+retry).
- Review: single = two panes (raw transcript + re-parse button | editable inspection card);
  batch = per-detected-inspection cards with include checkbox + match-to-hive select +
  compact fields, validate all included matched, Confirm All.
- Server parses once and returns structured data with the status (fix legacy double-parse).
- Review cards include structured feedings, treatments, queen events, and Varroa
  counts; confirmation writes all included records atomically.

## Reports
- Survival by apiary, stand, and queen line; honey yield by hive/apiary/year
  with year-over-year comparison; and apiary economics combining revenue,
  expenses, pounds per hive, winter survival, queen/split outcomes, and
  feed/treatment cost per colony.

## Settings (single consolidated page, no duplicate standalone routes)
- Preferences: theme, default apiary, date format, weight unit.
- AI config: keys (Anthropic/Google/Ollama URL) with test-connection buttons, Ollama model
  discovery, per-task provider+model selects.
- Administrators add OIDC collaborators and assign viewer/editor per apiary.
  Every user can create/revoke personal API tokens and see the MCP endpoint.
- Jar sizes editor. Import records (upload → AI parse → review with include checkboxes +
  editable rows + summary → confirm). Install app.

## Photos
- Upload (drag-drop/browse, preview, caption), gallery (thumbnails), detail view (medium),
  attached to hives/apiaries/inspections.

## Fix list (legacy bugs, do not reproduce)
- Dead offline write queue; broken apiary batch-record button POSTing to nonexistent route;
  canvas hive-edit placement reset; manual-DOM queen-seen toggle; theme stored in two places;
  duplicate settings routes; genealogy tree not refreshing on data change.
