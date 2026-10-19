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
  pages. Before the profile answers it draws the same five rows as
  placeholders, so the tree does not jump when it lands.
- The phone bar has five slots: four areas plus More (admin: Today ·
  Apiaries · Stock · Sales · More; viewer/editor: Today · Apiaries ·
  Insights · More). More lists every area, Setup and the account link. Bar
  labels are at least 11px.
- Glossary, one word per concept: Apiaries (never Yard as a label, never
  roster); Hive (not colony, except in reports); Stock and Movements (not
  Production, Honey, Inventory, Activity); Bottling (not Jars); Lots &
  labels (not Lots & QR); Equipment (not gear, equipment stock, counts &
  equipment actions); Setup, Operation setup, Access & integrations (not
  Admin); Insights (not Reports); Map (not Layout); Record visit (apiary
  voice), Voice inspection (hive voice), Log inspection (typed form); Visit
  queue (not Yard queue); Market day (not POS; "register" is only the Orders
  page's inline name); freshness reads "Updated 9:47 AM · Refresh" (never
  "Live — read", "Server stock"). No eyebrows or kickers above a heading.

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
  strip and `<title>` ("Name · List · Brand"). For hives and apiaries the
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
- Empty, loading, error, and offline states always include a useful next step.

## Core workflows

- Dashboard: prioritize actionable colony, feeding, harvest, and inventory
  signals; avoid decorative charts.
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
