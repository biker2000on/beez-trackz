# Beez Trackz UI system

Beez Trackz manages inventory and apiary inspections: quick to scan in sunlight,
usable with one hand, and dense only where comparison helps a decision.

## Product principles

- Put the next likely action beside the information that motivates it.
- Keep common writes within one page and one confirmation.
- Use progressive disclosure for detail; do not hide primary actions in menus.
- Make every collection manageable in bulk. Selection mode uses `b`, select
  all/clear all uses `x`, and the same actions remain visible on touch devices.
- Make the complete application operable from a keyboard. `Ctrl/⌘ K` opens the
  command palette, `g` plus a navigation key changes sections, `?` shows
  shortcuts, and page actions register mnemonic single-key commands.
- Cache authenticated field reads and queue supported JSON writes in the PWA.
  Always show offline/sync state; replay with stable mutation IDs and surface
  conflicts for explicit retry or discard.

## Visual language

- Warm paper backgrounds, honey-gold action color, and dark forest neutrals.
- Rounded cards organize related information; borders and spacing carry more
  hierarchy than shadows.
- Icons clarify actions but never replace text for a primary workflow.
- Status colors are semantic and always paired with text.
- Controls are at least 44px on coarse-pointer devices and respect safe areas.
  Safe-area insets live in one place: `globals.css` defines `--safe-top`,
  `--safe-right`, `--safe-bottom`, `--safe-left` and the `.pt-safe`/`.pr-safe`/
  `.pb-safe`/`.pl-safe` utilities, plus `--bottom-nav-h` for the mobile bar.
  Components use those tokens; nothing else calls `env(safe-area-inset-*)`.
- Motion is brief, functional, and disabled when reduced motion is preferred.

## Navigation and naming

- Today, Apiaries, Stock, Sales, and Insights are the five areas, and
  `components/shell/nav-items.ts` is the one route index they come from: the
  sidebar, the phone bar, the page header (h1, `<title>`, phone disclosure)
  and Ctrl-K all read it, so a destination has one name everywhere.
- Setup is not an area. It is the sidebar footer link beside the account
  link and a row in the phone More sheet (`SETUP_ITEM`), with Operation
  setup, Access & integrations, Equipment types and Varietals as its pages.
  `g a` still reaches it.
- The sidebar expands only the active area; no area lists more than seven
  pages. On a record the rail draws that record as one row under its list
  (the apiary's name under Apiary list, the hive's label under Hives); a
  record's tabs and actions belong to the record header and Ctrl-K, never to
  the rail. When a Setup page is open, Setup's four pages expand under the
  footer link the way an area's children do, and the Setup pages carry no
  cross-link cards to each other. Before the profile answers it draws the same five rows as
  placeholders, so the tree does not jump when it lands.
- The phone bar has five slots: four areas plus More (admin: Today ·
  Apiaries · Stock · Sales · More; viewer/editor: Today · Apiaries ·
  Insights · More). More lists every area, Setup and the account link. Bar
  labels are at least 11px.
- Glossary, one word per concept: Apiaries (never Yard as a label, never
  roster); Hive (not colony, except in reports); Stock and Movements (not
  Production, Honey, Inventory, Activity); Bottling (not Jars); In progress (the
  `/production` page; not Active batches, Production); Lots & labels (not
  Lots & QR); Equipment (not gear, equipment stock, counts &
  equipment actions); Setup, Operation setup, Access & integrations (not
  Admin); Insights (not Reports); Map (not Layout); Record visit (apiary
  voice), Voice inspection (hive voice), Log inspection (typed form); Visit
  queue (not Yard queue); Market day (not POS; "register" is only the Orders
  page's inline name); freshness reads "Updated 9:47 AM · Refresh" (never
  "Live — read", "Server stock"). No eyebrows or kickers above a heading.
- Glossary, continued (Wave 2 clarify): Record harvest (the one entry point
  on Harvests; it starts a harvest session for an extraction day or saves a
  single-hive harvest — never "New session" / "New harvest" side by side);
  Settlements (what a consignment shop reports; not "Reports" inside Sales);
  "consignment, the shop reports its sales" (not "settles by report"); Stock
  value (not Inventory value); Open Stock (not Back to Honey); Open hive and
  Log inspection on the Map canvas (not View Hive / New Inspection); Source
  (the disclosure that import provenance folds into); Access & integrations
  in prose too (never "Admin and Integrations"); "bill of materials" is
  spelled out once before "BOM" on any page that uses it.
- Wave 7 (2026-10-19) rules: Today, `?view=all` and the Visit queue roll
  up only hives the roster (`GET /hives?includeArchived=true`) says are
  active and unarchived — a sold, dead or combined hive is read-only
  everywhere else, so its items are dropped in `features/work/rollup.ts`
  (`isRetired`), never drawn; a nuc placement ("B2 (N1)") is a hive of its
  own and appears under its own label only while it is active. A harvest
  session reads Taking entries → Trued up → Closed, and only `closedAt`
  makes it Closed: the Close session primary (`closeSessionCommand`) sits
  on every trued-up row of In progress and in the session record's header.
  The Insights season is one `?season=` param with one default (the current
  year) shared by the hub, its sub-hubs and every report; `?year=` is read
  as a legacy alias. Winter survival rows name stands ("Stand B") and queen
  lines ("A4 · emergency cell queen, 2026"), with "Stand unrecorded" and
  "Queen line unknown" for what does not resolve
  (`features/operations/survival-labels.ts`). An order line reads
  "C2 · Lenoir Apiary (hive) @ $225.00" (`orderLineText`): the kind in
  parentheses with spaces, no "1 ×" on a hive. "Apiary" replaces "yard" in
  every label and control; "hive" replaces "colony" everywhere but the
  `colony` sale-line kind in the API.
- Copy rules the glossary implies: a subtitle says what you do on the page
  in one sentence, never what the data model is. A button names its outcome
  ("Start session", "Delete inspection", "Delete photo"), never the gesture
  ("Submit", "OK", "Delete"). An empty state says which kind it is — first
  use, no results, or filtered — and offers the next action. An error says
  what failed and how to recover. Import provenance (`[Obsidian import: …]`,
  "Created by the curated Obsidian history import.") never appears in body
  text: `splitProvenance` (`lib/provenance.ts`) strips it and `NoteText` /
  `SourceNote` (`components/record/source-note.tsx`) show it behind a quiet
  "Source" disclosure. Hold, origin and restriction boilerplate renders
  nothing when there is nothing to do, and a plain sentence with an action
  when there is.

## Page templates

- AreaPage (every non-record route): `PageHeader` reads the route index. The
  h1 is the nav label, the optional subtitle is one sentence about the task,
  the actions slot holds one primary and at most two secondary controls, and
  the optional status line carries freshness or offline state. There is no
  in-page section strip on desktop — the sidebar shows siblings — and on
  phones the header carries one disclosure labelled "Area · Page" listing
  them. Server pages export `metadata` from `pageMetadata(href)`; client
  titles come from `usePageTitle`; both produce "Page · Area · Brand".
- RecordPage (`/yard/apiaries/[id]/*`, `/yard/hives/[id]/*`, lots, bottling
  runs, harvest sessions, product batches, orders, consignment locations,
  stock items): one `RecordHeader` (`components/record/record-header.tsx`)
  owns the way back to the list, the record name with its status badge, one
  context line, the action bar (one primary, at most two secondary, the rest
  behind More; on a phone the primary is full width and 44px tall), the tab
  strip and `<title>` ("Name · List · Brand"; an index entry may carry a
  `collectionLabel` for that segment, so an apiary reads "Lenoir Apiary ·
  Apiaries · Brand" while its way-back link still says Apiary list). For
  hives and apiaries the
  route `layout.tsx` renders it once, so every tab shares it and sub-pages
  render only their body. The tabs come from `contextualNavRoutes`, never
  from a hand-written list; entries flagged `action` (Record visit, Voice
  inspection) are drawn as actions, not tabs. The strip never wraps: at
  phone width it scrolls sideways inside its own box with the active tab in
  view.
- Retired routes keep a redirect; URLs never change under a rename.

## Layout and responsive behavior

- Desktop uses a persistent sidebar and compact comparison tables.
- Use safe-area padding and sticky actions on phones.
- Apiary, hive, lot, bottling run, product batch, and stock records have full
  URLs. Section navigation uses named links, including in the mobile More
  sheet. Do not nest record tabs or hide navigation in select inputs.
- Map/list views and same-data filters may change presentation in place.
  Preserve the actual apiary canvas, keyboard controls, and layout editing.
- Tables that must preserve column comparison scroll horizontally rather than
  crushing content.
- DataGrid (`components/ui/data-grid.tsx`): column defs must not depend on
  per-keystroke state (drafts, selection, pending flags). TanStack mounts a
  function `cell` as a component, so rebuilding the columns on every change
  remounts the cell and drops focus from any input in it. Keep the columns
  memo static and pass the mutable state via `useTable({ meta })`; cells read
  it with `gridMeta<MyMeta>(table)`.
- Empty, loading, error, and offline states always include a useful next step.

## Core workflows

- Today: one card per hive, not one card per item. The server's flat work
  list (`/work/today`) is rolled up in `features/work/rollup.ts`: items with
  the same hive share a card, the card takes the highest priority among them
  and that priority names its bucket (urgent → Urgent, high → This week,
  normal/low → Later). The card reads one summary line ("Inspect this hive ·
  324 d · Check the feeder · 724 d") and offers one primary action (Log
  inspection when the top item asks for one, otherwise Open hive); Dismiss,
  Snooze and the other per-item commands sit behind the card's disclosure.
  A generated item whose evidence is older than a season (180 days, read
  from the item's own "N days") is hidden behind "Show stale (n)".
  Recommendations carry the sparkle icon with an accessible name, never a
  "REC" pill, and keyboard letters are listed in the `?` dialog, not inline.
  `/today?view=all` is the same roll-up with dismissed, snoozed and stale
  items shown; the Visit queue is the same roll-up grouped by apiary and
  limited to what can be done at a hive.
- Equipment: one page, `/equipment`, fed only by `GET /equipment/stock`,
  which the server sums from the inventory ledger (on hand, deployed,
  damaged and retired from `inventory_balances`; available from
  `inventory_available` at the home location). The table draws those
  columns once; the header restates its totals and nothing else repeats
  them. Row actions are Deploy to hive, Record damage, Retire, Adjust and
  Physical count; what is on hives and the loss report are sections below.
  `/equipment/types` (Setup) lists definitions, bills of materials and unit
  cost only — no quantity columns.
- In progress (`/production`, "Active batches" until Wave 5): each total appears once. "Extraction in
  progress" lists only sessions still taking entries; a trued-up session
  waits under "Trued up, not yet closed". Bulk honey by lot
  carries the bottling command (there is no second "available for bottling"
  list of the same lots), and Finished stock is one total plus a link to
  Stock › On hand, naming only the sizes below their target ("9 oz (4 of
  target 24 jars)" — never "par").
- Finished stock has one count (Wave 6): `useFinishedStock`
  (`features/commerce/finished-stock.ts`) reads the ledger's per-location
  split (`GET /stock-locations/inventory`, the read Market day sells from)
  and the Setup jar-size targets (`GET /jar-sizes`), and Today, In progress,
  Market day and Consignment all draw from it: jars at home, jars at shops,
  and the active sizes below target. No page sums "available" for itself;
  the workbench's every-location `jarStock` and a location's every-kind
  `onHandUnits` are not drawn as "available". A page that counts a
  different fact says which ("· 52 at shops").
- An extraction session has one status (Wave 6): `sessionStatus` in
  `features/honey/session-status.tsx` derives Taking entries → Trued up ·
  close to finish → Closed from `closedAt`, `totalExtractedWeight` and the
  workbench's `trueUpDifferenceLbs`, and `SessionStatusBadge` renders it on
  Today, In progress, Harvests and the session record. "Finalized" and
  "extraction remains open" are not words the UI uses.
- A sold, dead, combined or archived hive is read-only (Wave 6): its record
  header says so in one line ("Dead Apr 24, 2026 · records are read-only",
  with Open order when a sale is linked), the field actions (Voice
  inspection, Log inspection, Feed, Split) leave the bar, and the primary is
  Reactivate (status back to active, unarchived) with Edit behind More. The
  tabs stay readable.
- Apiary: layout canvas, flora, local forecast/bloom intelligence, bulk
  records, photos, and printable hive tags share one detail workflow.
- Visits: voice is primary for both apiary observations and hive inspections.
  Review each hive in place; confirm observations and accepted equipment
  changes atomically, then continue to the next hive. Manual entry uses the
  same domain commands. Missing queen observations remain unknown.
- Recordings and editable drafts persist on the device, partitioned by account.
  Freeze upload identity after an attempt; retry with the same identity. Queued
  writes are pending until a server receipt confirms them. Preserve original
  audio, transcript versions, and observation times during correction/recovery.
- Stock: quick ledger actions use memorable keys and all multi-line movements
  are committed once. On hand shows bulk honey, packaging and finished goods
  as tabs of one page; Equipment exists once, under Apiaries.
- Stock on hand: show on hand, reserved, and available for the exact item, unit,
  location, lot, condition, and hive tuple. Holds and unknown counts remain
  explicit. The ledger is the only quantity authority.
- Payment and fulfillment are independent facts. Extraction completion is an
  explicit domain action; remaining stock does not imply an active session.
