# UI coherence: shape brief (2026-10-19)

Source: `/impeccable critique` of the whole UI at `4104836` (23/40), snapshot
`.impeccable/critique/2026-10-19T13-59-48Z__frontend-src.md`. Owner's
complaint: "disjointed and confusing". Owner's decisions: structure first,
merge Production + Stock, fix everything the critique found.

## 1. Job and audience

One beekeeper-operator (admin) plus occasional viewers/editors. Arrives on a
phone in the yard (gloves, sunlight, one hand) or at a desk after market day.
Mode: Operate. Success: every area, record and tab reads the same way, every
concept has one name, and the first screen says what to do today.

## 2. Outcome and proof

- One page grammar: two templates, built from the route index.
- One name per concept, enforced by code (nav label drives h1, `<title>`,
  tabs, breadcrumbs, palette).
- Five areas, five-slot phone bar, as DESIGN.md promises.
- Today shows one card per hive with one primary action.
- Equipment exists once.
- Proof: re-run critique; P0s gone, score ≥ 30/40, overlay reports no 10px
  functional text and no sub-4.5:1 badge.

## 3. Information architecture (five areas)

URLs do not change; only the navigation tree, labels and templates do.
Retired destinations keep a redirect.

| Area (nav label, g-key) | Root route | Children (nav label → route) |
|---|---|---|
| Today (t) | `/today` | Visit queue → `/yard/queue` (same items, grouped by apiary). `/today/recommendations` redirects to `/today?view=all`. |
| Apiaries (y) | `/yard` | Apiary list → `/yard/apiaries`; Hives → `/yard/hives`; Queens → `/yard/queens`; Equipment → `/equipment`; Voice inspection → `/yard/transcribe` (requiresEdit). |
| Stock (s — free; no earlier `g s` chord) | `/stock` | On hand → `/stock` (exact; bulk / packaging / finished goods as tabs on one page, replacing the three separate pages, which redirect); Active batches → `/production`; Harvests → `/production/harvests`; Bottling → `/production/jars`; Lots & labels → `/production/lots`; Hive products → `/production/products`; Movements → `/stock/movements`. Serial lookup and Varietals are palette entries, not nav. Owner chose the word Stock over Honey/Production on 2026-10-19. |
| Sales (c) | `/sales` | Orders → `/sales` (exact); Market day; Consignment; Customers; Expenses (Categorize is an in-page link). |
| Insights (i) | `/insights` | Outcomes; Finance; Sales & planning; Compliance packet; Folio reconciliation. Sub-reports (survival, yield, economics, profitability, bottle next) are in-page sections or links, not nav rows. |

Setup is not an area. It is a sidebar footer link and an entry in the phone
More sheet: Setup → `/admin/setup` (operation setup) with Access &
integrations (`/admin`), Equipment types (`/equipment/types`), Varietals
(`/production/varietals`) as its tabs/children. `g a` still reaches it.

Equipment: one page at `/equipment` under Apiaries with the ledger columns
(On hand / Deployed / Available, plus Needed / Damaged / Retired) and row
actions (count, deploy, record loss). `/stock/equipment` redirects there.
Types & BOMs live only in Setup. *Wave 3 (2026-10-19):* every column is
`GET /equipment/stock`, which the server sums from `inventory_balances`
(on hand, deployed, damaged, retired) and `inventory_available` at the home
location (available); the summary cards, the "Below target" card and the
Owned / Available columns on `/equipment/types` are gone, so the quantities
are drawn in exactly one table. The stock workspace no longer has an
equipment kind.

Phone bar (five slots): admin = Today · Apiaries · Stock · Sales · More;
viewer/editor = Today · Apiaries · Insights · More. More lists every area,
Setup and the account link. Labels ≥ 11px.

## 4. Glossary (one word per concept)

| Use | Never |
|---|---|
| Apiaries (area), apiary, yard only in prose | Yard (as a label), roster |
| Hive | colony (except in reports where it is the domain term) |
| Stock (area, and the on-hand page), Movements | Production, Honey, Inventory, Activity (as labels) |
| Bottling (page), jar (unit) | Jars (page) |
| Lots & labels | Lots & QR |
| Equipment | Gear, equipment stock, counts & equipment actions |
| Setup (area), Operation setup, Access & integrations | Admin, Admin and integrations |
| Insights | Reports |
| Map (apiary tab) | Layout |
| Record visit (apiary voice), Voice inspection (hive voice), Log inspection (typed form) | Record inspection, New inspection, Inspection visit, Voice recording, Multi-hive walkthrough |
| Visit queue | Yard queue, Saturday work |
| Market day | POS, register (register is the Orders page's inline name) |
| Updated 9:47 AM | Live — read 9:47 AM, Server stock |

No eyebrows/kickers ("SALES / ORDERS & REGISTER", "STOCK / INVENTORY").
No "REC" pill; recommendations carry the sparkle icon only.

## 5. Two templates

**AreaPage** (every non-record route): `PageHeader` reads the route index:
h1 = nav label, optional one-sentence task subtitle (what you do here, not
what the data model is), actions slot (1 primary + ≤2 secondary, rest in a
menu), optional status line (freshness "Updated 9:47 AM · Refresh", offline).
Body below. No in-page section strip on desktop (the sidebar shows siblings).
On phones the header carries one disclosure labelled with the area and the
current page ("Stock · Bottling ▾") listing siblings; the bottom bar's fifth
slot is "More", so the two never share a name.

**RecordPage** (`/yard/apiaries/[id]/*`, `/yard/hives/[id]/*`,
`/production/lots/[id]/*`, `/production/sessions/[id]`, `/sales/[id]`,
`/sales/consignment/[id]`, `/stock/items/[id]`): a route `layout.tsx` owns
the record header (name, status badge, context line), the action bar, the tab
strip (from `contextualNavRoutes`) and `<title>` ("D1 · Hives · GentleBee
Atlas"). Sub-pages render only their body. Hive Equipment and Queen, apiary
Flora/Photos/Labels/Bulk/Timeline become tab bodies under the same header.

`<title>` everywhere: "Page · Area · Brand" for area pages, "Name · Area ·
Brand" for records. One `usePageTitle`/metadata helper; no hand-written
titles.

## 6. Content decisions (distill)

- Today: one card per hive, rolled up ("B4 · 324 days since inspection ·
  feeder 724 d · no mite count"), one primary action (Open hive / Log
  inspection), secondary Dismiss/Snooze in a menu; generated items whose
  evidence is older than one season (180 days) are hidden by default behind
  "Show stale (n)". Groups: Urgent, This week, Later. Keyboard hints stay in
  the `?` dialog, not inline.
  *Wave 3 (2026-10-19), as built (`features/work/rollup.ts`):* cards are
  keyed by `context.hiveId` in the server's order; the bucket is the
  server's priority renamed (urgent → Urgent, high → This week,
  normal/low → Later) using the highest priority on the card. The summary
  line is each item's title plus the age it states ("Inspect this hive ·
  86 d"). The primary is Log inspection (opens the inspection form in
  place) when the top item's title says inspect, else Open hive. Per-item
  commands (Dismiss, Snooze, Refill …) are behind the card's "n items"
  disclosure; arrow-focusing an item opens its card. Stale is read from the
  largest "N days" in the item's own text because the projection's
  `observedAt` is the date the rule ran, not the observation (a 724-day
  feeder is dated 2026-08-11); `observedAt` is only the fallback when the
  item states no age, and an item with neither is never stale. On the QA
  copy this hides 48 of 94 items and leaves 16 of 30 hives. Command letters
  are registered with the shortcuts provider so the `?` dialog lists them.
- Visit queue: same roll-up grouped by apiary, filtered to field-actionable
  items (*as built:* an item on a hive that is not a lockout notice; the
  hive-less catch-all section is dropped when empty).
- Active batches (`/production`): show each total once; "Finished stock" is a
  link to Stock on-hand, not a repeat of the numbers. *As built:* the
  "Available for bottling" panel (the same lots at the same balance) is
  merged into Bulk honey by lot, which carries its commands; Finished stock
  is one row — total jars available, sizes below target as "9 oz (4 of
  target 24 jars)", link to `/stock?tab=finished` — and sizes with nothing
  on hand are not listed; "Extraction in progress" holds only sessions not
  yet trued up, and trued-up (finalized) sessions wait in their own
  "Trued up, not yet closed" panel.
- Equipment: one page (see §3); `/equipment/types` only in Setup.
- Provenance strings (`[Obsidian import: …]`, "Created by the curated
  Obsidian history import.") fold into a "Source" disclosure/tooltip; hold
  boilerplate renders nothing when there is nothing to do.
- Sidebar: only the active area expanded; others collapsed; ≤ 7 children per
  area.

## 7. Harden list

- Market day: items → sticky footer with Cash / Card / Venmo segmented row →
  Complete; price editable only after tapping the amount; short size names
  ("1 lb", "Qt"); low-stock banner only for sizes with a lot; confirm sheet
  shows items, total, payment before completing.
- Phone bar labels ≥ 11px; "URGENT"/"REC"/varietal pills ≥ 12px or removed.
- `--destructive-foreground` vs `--destructive` ≥ 4.5:1 in both themes.
- Titles on every page; no bare "GentleBee Atlas".
- Market-day type scale: h1 ≥ 20px, h2 ≥ 16px.

## 8. Untouched / anti-goals

- No URL renames; redirects stay for every retired route (e2e
  `retired-routes.spec.ts` and `navigation.spec.ts` are updated, not
  deleted).
- Palette, fonts, tokens, the apiary canvas, the DataGrid, the voice
  pipeline, the ledger model and all API contracts stay as they are.
- Keyboard layer (Ctrl-K, `g` keys, mnemonics) stays and keeps deriving
  from `NAV_ITEMS`.
- Not a redesign: refinement inside the incumbent visual world.

## 9. Constraints

- Next.js app router; keep server `metadata` where pages are server
  components, otherwise set titles from the client helper.
- `tsc --noEmit`, eslint and the Playwright e2e suite (`CI=1`, mocked API)
  must pass after each wave; DESIGN.md is updated to match (five groups,
  Setup in the account menu, glossary).
- Verify in the browser at desktop and 375px with real data
  (localhost:3001 against the QA copy) once per wave, batched.
