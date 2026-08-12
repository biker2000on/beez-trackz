# Beez Trackz — Product Roadmap

Feature ideas for the Go/Next.js stack, grouped by theme. Roughly ordered by
value-for-effort within each section. (Drafted 2026-07-23, after the stack
rewrite cutover.)

Status labels below reflect the roadmap delivery completed on 2026-07-26.

## High value for how the apiary actually runs

### Voice-first everything
**Shipped 2026-07-26.**

The transcription pipeline only creates inspections today. Extend the parser
so one walkthrough recording can also extract:
- feedings ("gave A3 two quarts of 1:1")
- treatments ("put Apivar strips in B2")
- queen events ("saw a new queen in A4, superseded")

### Overwintering & survival analytics
**Shipped 2026-07-26.**

Deadout dates, location history, and queen lineage already exist. A
winter-survival report by apiary, stand position, and queen line turns the
records into decisions (which yard, which genetics).

### Varroa tracking done properly
**Shipped 2026-07-26.**

Structured mite-count fields (alcohol wash / sticky board counts) instead of
free-text pest counts, with per-hive trend charts and treatment-efficacy
overlays (counts before vs. after each treatment).

## Workflow clarity and field-first UI

**Progress updated from HEAD `e9fd757` (statuses on each item below); based on the 2026-08-02
production UI audit and the 2026-08-03 adversarial UX/inventory review
(`docs/plans/2026-08-03-ux-and-inventory-adversarial-review.md`), which
quantified the tab problem: 28 tab triggers across 5 tab strips, 11 tab
targets on `/harvest` alone (7 tabs + 4 nested Business tabs), 9 tabs on
hive detail, zero tab state in URLs, and a mobile bottom nav that drops 4 of
9 destinations with no overflow menu.**

### P0 — Feeding lifecycle and one-row hive status
**Complete 2026-08-11.** Explicit open/closed/unverified feeder states with
refill/close endpoints, an audited reversible backfill (originals preserved in
`feeding_status_backfills`), and a per-visible-active-hive
`GET /feedings/status` row driving the dashboard widget, including explicit
zero-history rows for hives that have never been fed.

Closed 2026-08-11: a feeding recorded without a feeder is a feed event —
created closed (`not_installed`) so it can never overstate active feeders,
with the dialog making the choice explicit ("No feeder — fed directly"); the
dashboard row shows the latest feed (date, type, quantity, feeder) and
separates open from unverified counts; and on mixed hives the action always
targets the record it names (verify → oldest unverified, refill/close →
oldest open).

At audit time, 81 feeding records had no empty date across 22 hives (two to
six records per hive), and every one was older than 90 days. First verify
whether an empty date actually means an active feeder, then perform an
audit-safe, reversible backfill or state correction rather than silently
changing history. Preserve feeding events in the hive timeline, but show one
dashboard status row per hive: feeder count, latest feed date/type, and an
actionable stale or attention state. Sort urgent rows first; use a fixed-height
scrolling list on desktop/tablet and prioritized rows plus **View all feeding
status** on mobile. Refills and closures must make the active-feeder rule
explicit so duplicate status rows cannot return.

### P1 — Dashboard hierarchy for work in front of the beekeeper
**Complete 2026-08-04.** Needs attention and Today's field actions lead;
every row names its action and evidence.

Make the dashboard lead with **Needs attention** and **Today’s field actions**,
then hive/apiary status, feeding summaries, recent activity, and reporting.
Every recommendation should name the action and its evidence (for example,
a feeding record with no empty date older than 90 days, once active-feeder
semantics are verified), rather than giving generic advice equal weight with
setup or analytics.

### P1 — Replace embedded workflow tabs with clear overviews
**Complete 2026-08-11** (except the deliberately deferred `/harvest` →
`/honey` route rename, which collides with the public `/honey/[slug]` story
pages). Honey overview + sub-routes with a full-screen `/harvest/market-day`;
Business reports merged into `/reports`; hive detail 9 tabs → 5 with timeline
filter chips; tab state in URLs; bottom nav pins 4 role-aware items plus a
More sheet; `/genealogy` renamed `/queens` (redirect kept); `/transcribe`
linked from apiary detail.

Closed 2026-08-11, with adversarial follow-up completed the same day: Apiary
opens on an Overview and has only one peer view, Layout; Flora, Photos, and
Bulk record are dedicated routes. Hive opens on a true summary Overview and
has three peer views (Overview | Timeline | Health); Equipment, Queen, and
Photos are dedicated drill-down routes. Honey has three invariant workflow
groups (Overview | Production | Sales), while detail routes such as Activity,
Harvests, Lots, and Serial lookup resolve to a group without expanding the
strip. Reports uses three groups (Outcomes | Finance | Sales & planning) on
detail pages and no redundant strip above its card-based home. Both menus
collapse to a select on phones. Home remains pinned in the mobile bar, with
all other destinations reachable through More. Responsive browser regression
tests cover 390 px and 1024 px layouts, group invariance, tab counts, and URL
state. The two deploy-equipment UIs are one dialog, and the four hand-rolled
bulk-select toggles share `useBulkSelect`.

Apiary, Hive, and Honey need default overview pages with promoted field
actions. Keep tabs only for two or three peer views; move larger workflows to
dedicated routes reached through concise section menus and breadcrumbs. Apiary
overviews should summarize yard status, layout, hives, flora, and activity;
hive overviews should summarize health, latest inspection, feeding, equipment,
queen, and timeline; Honey should summarize bulk stock, packaged stock, recent
harvests, and sales. Use **Honey** consistently as the module name and
**Harvests** as its subsection.

Specific defects from the 2026-08-03 review to close as part of this work:

- `/harvest` mixes three work modes as sibling tabs: record browsing
  (Activity/Jars/Harvests/Sales/Lots), a full point-of-sale (Market day —
  a cart inside a tab, where one stray click abandons a sale), and
  back-office reporting (Business, itself four nested tabs). Split: Honey
  overview page with quick actions; sub-routes for harvests, lots, and
  sales; a dedicated full-screen `/harvest/market-day`; Business reports
  merged into Reports. Eliminate nested tabs entirely.
- `/hives/[id]` had 9 tabs, and four (Inspections, Feedings, Splits,
  History) are filtered subsets of the Timeline tab. Replace them with
  filter chips on the timeline; final strip: Overview | Timeline | Health,
  with Equipment, Queen, and Photos reached from overview cards. Collapse the
  8-button action row to 2–3 primary actions plus overflow.
- Any surviving tab strip must persist its active tab in the URL
  (deep-linkable, back-button-safe); returning from a session or receipt
  detail must not reset to the default tab.
- Mobile bottom nav drops Recommendations/Reports (and, for admins, Queens/
  Inventory) with no overflow — Inventory is unreachable in the field. Add
  a "More" sheet or shrink top-level nav to 6–7 items so it fits.
- Financial numbers appear on three surfaces (`/harvest` stats, Business →
  Profitability, Reports → economics) that disagree because overview
  revenue includes unpaid draft/pending orders. One reporting home, one
  labeled revenue definition (collected vs. invoiced).
- Orphans and duplicates: `/transcribe` (batch voice transcription) is fully
  built with zero inbound links — link it or delete it; two independent
  deploy-equipment UIs and four hand-rolled bulk-select toggles should
  consolidate; nav labels should match routes ("Queens" → `/genealogy`,
  "Honey" → `/harvest`).

### P1 — Separate operational inventories and clarify honey flow
**Equipment workflow complete 2026-08-04; honey flow partially shipped.**
Equipment is a real ledger: unique stock row per
type (duplicates merged), trigger-derived totals with drift rejected,
damaged/retired states with a loss report, partial guarded returns with
reason/condition, needed quantity + unit cost (cents), and a physical-count
flow replacing bulk-adjust. Only minor naming clarity remains. Honey movement
paths validate stock (sale-path lock pattern); bottling runs require a jar
size and are FK-linked.

Name and model **Equipment Inventory** separately from **Honey Inventory**.
If equipment is a routine field operation, move it out of Settings. The
equipment workflow needs an initial-count flow and a clear view of owned,
deployed, available, needed, damaged, and retired equipment, backed by ledger
actions to receive, deploy, return, adjust, and retire rather than opaque
quantity edits.

The 2026-08-03 review documented the pre-delivery equipment model against this bar:

- Returns cannot be partial, record no reason or condition, and a second
  return call silently overwrites the first return date (no
  `date_removed IS NULL` guard).
- Damaged/retired exist only as adjustment reasons that decrement
  `total_owned` — there is no damaged or retired state and no loss
  reporting. "Needed" and unit cost do not exist at all.
- `bulk-adjust` is exactly the opaque quantity edit this item bans: it
  records reason `'other'` with note "bulk edit" and silently skips rows
  that fail to resolve. Replace it with a physical-count flow.
- `equipment_stock.type_id` is not unique, so one equipment type can split
  across multiple stock rows, making per-row availability meaningless.
- `total_owned` is a mutable column kept in sync with the adjustments
  ledger only by application code; nothing reconciles them. Either derive
  the total from the ledger or add a reconciliation check.
- Only the sale path validates stock; deployments and adjustments can drive
  counts negative server-side.

Make the Honey workflow show its allowed path and the next useful action:
**harvest session → bulk inventory/lot → optional bottling → movement or
sale**. Each stage should show its status and available quantity, while still
allowing the deliberate shortcuts that real operations need.

Harvest entry captures the date and apiary once per session. **Closed
2026-08-11:** the session page records the whole walkthrough as line items
saved in one transaction; each line (and the standalone harvest dialog) takes
either a super-weight pair or a directly measured harvested weight
(`direct_weight` column, migration 00011); every surface labels the pair
"Super weight before/after (lbs)"; and sessions have an explicit lifecycle —
In progress → Finalized by true-up, with finalized sessions refusing new
entries, the true-up capturing a reason, its history rendered, session
entries no longer double-listed under Individual harvests, and entry
deletion presented as the audited archive it is.

### P1 — GnuCash-web-ready inventory and honey integration
**Foundations shipped 2026-08-04; live GnuCash sync and external/accounting
reconciliation remain planned.** Completed foundations include integer cents,
audit fields, reversals/soft deletes, a unified bulk formula, stock
validation, collected-vs-invoiced revenue fields, and honey/commerce
idempotency. The `external_sync` mapping-table foundation is in place;
equipment entity mappings and equipment mutation idempotency remain missing.

Design inventory and honey workflows and data contracts for future
bidirectional syncing with **gnucash-web** across the product ecosystem.
Records need stable external IDs and idempotent sync behavior; explicit
account, category, and tax mappings; and traceability from inventory movement
through COGS, revenue, payment, refund, and adjustment. Surface reconciliation
status and conflicts, retain a complete audit trail, and never silently
overwrite quantity or value when either system changes it. The eventual sync
must preserve the physical honey/equipment ledger and its financial entries as
linked, reviewable records rather than treating either side as disposable.
Beez Trackz remains authoritative for physical honey and equipment quantities;
gnucash-web remains authoritative for posted accounting entries. Sync must not
infer or overwrite physical stock solely from accounting data.

The 2026-08-03 review found the pre-delivery system failed these criteria.
The remaining GnuCash work is live GnuCash sync and external/accounting
reconciliation, plus equipment entity mappings and equipment mutation
idempotency. Historical blockers, in recommended order of attack:

1. **RESOLVED — Money precision and audit fields.** Money uses integer cents
   and commerce/inventory records have the required audit fields.
2. **RESOLVED — Reversals and soft deletes.** Ledger corrections use
   reversing entries, reachable cancellation, or soft delete rather than
   destructive deletion.
3. **RESOLVED — Unified bulk formula and linked bottling ledger.**
4. **RESOLVED — Negative-stock validation.**
5. **RESOLVED — Equipment ledger upgrades** (see the operational-inventories
   item above).
6. **Remaining — live GnuCash sync and external/accounting reconciliation.**
   Complete per-record `external_id`/sync-state mappings (entity, external
   account/category/tax mapping, last-synced, conflict state) and add the
   live GnuCash sync and reconciliation workflow. Honey and commerce
   mutations are idempotent; remaining idempotency work is limited to
   equipment mutations.
   Keep categories, channels, and tax data mappable for external accounting,
   with COGS and inventory values traceable to the linked physical ledger.
7. **Coupled — colony and equipment sales** (see "Colony and equipment
   sales" under *From harvest to sale*). Those sales introduce line kinds
   that do not map to honey's revenue-with-COGS shape: colony proceeds have
   no per-unit cost basis, and equipment resale is an asset disposal with a
   gain or loss against stored unit cost. One mixed sale must post as one
   split transaction. Because selling equipment is itself an equipment
   mutation, the entity mappings and mutation idempotency listed above
   should be built once to cover both rather than twice.

### P1 — PWA prompt behavior
**Shipped 2026-08-04.** The prompt waits for a completed task or repeat
visit, retreats from dialogs/recordings/detail routes, persists dismissal
for 120 days, and Settings keeps a permanent Install entry.

Do not overlay active apiary, hive, or field-recording work with the install
prompt. Ask only after a completed task or a repeat visit, persist dismissal,
and make installation easy to find later without interrupting operations.

### P2 — Responsive field polish
**Partially shipped 2026-08-04** — touch targets, empty states, and phone
layouts in apiaries, queens, and settings. Remaining gaps include sub-44px
targets, horizontal navigation strips, and wide tables that do not fit small
screens.

Finish responsive layouts, field-appropriate touch targets, and useful empty
states so routine work stays clear on a phone as well as desktop and tablet.

## From harvest to sale

### Harvest lots, jar runs, and customer-facing QR honey stories
**Shipped; serial traceability completed 2026-08-04.** Lots, bottling runs,
and public Honey Story pages work; bottling runs are FK-linked to the jar
ledger and validated against lot weight and bulk on hand (2026-08-04, with
the gnucash-web blockers); and serials are now real: `/harvest/serials`
looks any serial up (serial → bottling run → lot → sale), and sales carry
linked serials via `jar_serials.sale_id` with audit fields, managed from
the sale receipt. Lot weight remains free-typed against linked harvests.

The existing harvest sessions, per-hive harvest records, honey ledger, and
sales inventory are a strong base, but they do not connect a physical jar to
its extraction run. Add a harvest-lot record (for example, `2026-SUMMER-01`)
linked to source apiaries/hives, extraction date and weight, notes, testing
data, and bottling/jar runs. Generate a QR code for each lot by default, with
an optional per-jar serial number.

The QR should open a public, read-only Honey Story page with the curated
honey variety/season, bottling date, lot number, approximate apiary region,
bloom observations, beekeeper story, and selected photos. Keep exact apiary
coordinates and raw inspection data private. Include a reorder link and an
optional customer email signup, not a public view of operational records.

### Zebra label printing and physical traceability program
**Planned; distinct from the shipped generic browser-print support.**

Hive labels already print through the browser using MUNBYN 2x1-inch and
3x2-inch profiles, with an authenticated internal QR. Honey lots already
support public Honey Story QRs, lot metadata, bottling runs, and optional
per-jar serials, but have no label-print action yet.

**First milestone (requested 2026-08-04): serialized jar-label batches.**
Print a sequence of jar labels on the Zebra where the print action mints the
serials — one freshly generated serial per label, tied to the bottling run
(runs already serialized print their existing serials instead of minting
twice). Requirements, inheriting this section's service rules: the API owns
the ZPL and the job (printer host/port configured in Settings with a
test/calibration print; port 9100 kept LAN-only); each job records per-label
state, and a connection lost after bytes may have been sent marks the
affected labels **unknown** — never auto-resent, cleared only by operator
inspection and an explicit per-label reprint with a reason, which lands in
the serial's audit history (traceability shipped 2026-08-04:
`jar_serials` + `/harvest/serials`). Labels carry the public curated Honey
Story QR plus the human-readable serial (optionally barcoded); nothing
internal or authenticated goes on a customer-facing jar. Entry point: a
"Print serial labels" action on the bottling run.

Validate the exact Zebra ZD420 **ZD42H42-C01E00EZ** before one-click work. It
is a 4-inch-class, 203-dpi ZD420c-HC healthcare ribbon-cartridge desktop
printer supporting thermal transfer and direct thermal; this SKU provides
USB, USB Host/USB-A, Bluetooth, and Ethernet. Zebra family specifications list
ZPL II, a 4.09-inch maximum print width, and media up to 4.65 inches; other
family connectivity options should not be assumed for this SKU. The model was
replaced by the ZD421c-HC.

Build the label layer for any self-hosted installation, not around fixed Beez
branding. Each installation owns a reusable asset library for admin-uploaded
logos, artwork, backgrounds, and approved fonts in common raster/vector
formats. Validate type and size, and sanitize or rasterize SVG before use.
Keep branding and versioned templates separate from hive/lot data so each
operator can design labels and historical reprints retain their original look.

1. **Native ZD420 hive labels.** Add an exact-size template, preview, copies,
   and alignment/calibration so authenticated hive QRs scan reliably.
2. **Bottling-run honey labels.** Batch lot and jar labels, including circular
   stock, with the public, curated Honey Story QR; preview, lot, copies, and
   printed QR must agree.
3. **Serialized jar traceability.** Preserve each jar identity through print,
   explicit reprint, reason, and audit history.
4. **Harvest/extraction container labels.** Once process IDs are stable, keep
   containers tied to the correct authenticated internal record.
5. **Market, wholesale-order, and tote labels.** Once order states are stable,
   reduce fulfillment mix-ups with authenticated internal identifiers.
6. **Apiary and stand identifiers.** Once naming is final, add durable internal
   wayfinding that works with the existing scan flow.
7. **Equipment and bin labels.** Begin after stable asset IDs exist, with label
   history tied to IDs rather than free-form names.

Shared prerequisites are validated media/hardware, centralized templates and
DPI/media settings, and a shared print service before any one-click ZPL phase.
Templates support configurable physical diameter/shape, 203-dpi-safe layout,
print/export, and a constrained editor for assets, apiary name, text, colors,
borders, lot fields, and QR placement. A live round preview flags QR quiet-zone
or size failures and edge clipping; calibration and paper/test print come
before label stock. Starter presets may later be derived from user-provided
MUNBYN Editor samples, without making that editor a runtime dependency.

The service owns ZPL and tracks jobs, history, and copies; clients never submit
arbitrary ZPL. Only job creation and deduplication are idempotent. Raw TCP/9100
delivery is not: if a connection is lost after bytes may have been sent, mark
every label type unknown, never auto-resend, and require the operator to
inspect output and explicitly reprint. Keep port 9100 LAN-only. If Ethernet is
unusable, use an operator workstation or dedicated local USB print bridge
without assuming TrueNAS container USB passthrough. Browser/system-driver
printing remains the durable fallback. Only curated Honey Story content is
public; hive, order, container, apiary/stand, and equipment identifiers remain
authenticated and internal.

### Profitability and cost tracking
**Shipped 2026-07-26.**

Record expenses for bees and queens, feed, treatments, jars/lids/labels,
equipment, mileage, market fees, and optionally estimated labor. Report
revenue, gross margin, cost per harvested pound, cost per jar, inventory
value, and break-even pricing by season, harvest lot, jar size, sales channel,
and apiary. This turns the existing revenue total into a usable answer to
"which honey is actually making money?"

### Sales channels, orders, and market-day mode
**Shipped 2026-07-26.**

Extend Record Sale with channels such as farm stand, farmers market,
wholesale, pickup, online, gift, and consignment. Keep customer and order
history; support receipts/invoices, unpaid balances, wholesale price lists and
minimums, low-stock alerts, and end-of-day reconciliation. A phone-first
market-day screen should use large product buttons, capture payment method and
discounts, and decrement inventory immediately.

### P1 — Colony and equipment sales
**Planned (requested 2026-08-12).** Two hives with bees were sold in spring
2026, along with the boxes and frames that went with them. None of that
transaction can be recorded today.

The sale model is structurally honey-only: `honey_sale_items.jar_size_id` is
`NOT NULL`, so a sale line can only ever be a jar size. `hives.status`
already has a `sold` value, but marking a hive sold records no buyer, no
price, and no link to a transaction — the colony simply stops counting as
active. Equipment leaves storage only through `discarded`/`gifted`/`other`
adjustments, which carry no proceeds and no `sold` disposition, even though
stock rows already store a unit cost that would serve as cost basis. And
because every revenue figure reads `honey_sales`, a colony sale is invisible
in profitability, apiary economics, and break-even — while the expense side
already has a `bees_queens` category. The operation can record buying bees
but not selling them, so margins are understated by exactly the amount sold.

Record one sale that mixes what was actually sold: colonies (specific
hives), equipment (from stock rows), and honey, as a single transaction with
one customer, one payment, and one receipt. This extends the existing
commerce spine — customers, channels, payment method, order status,
receipts, unpaid balances, wholesale price lists, offline idempotency — and
must not fork a parallel sales system.

Requirements:

- **Restructure the sale tables properly rather than bolting on.** This is a
  single self-hosted instance with no external install base, so the
  migration is free to be breaking: rename `honey_sales` → `sales` and
  `honey_sale_items` → `sale_items`, and give the line a real `kind`
  discriminator (`jar` / `colony` / `equipment`) with nullable per-kind
  targets and a CHECK that exactly one is set. No compatibility shim, no
  view pretending the old names still exist — update the call sites.
  Breaking the *schema* is not the same as discarding the *ledger*: the
  instance holds real sales, harvests, and serial links, so the migration
  still carries every existing row across as a `jar` line and keeps the
  unified revenue formulas reading one source.
- **The physical side moves with the money, in one transaction.** Selling a
  colony sets the hive to `sold` and links the sale, so the hive timeline
  and location history say where it went. Selling equipment decrements
  stock through the ledger with a new `sold` disposition carrying the sale
  link — never an opaque quantity edit.
- **Equipment already on a sold hive is the common case.** Boxes and frames
  usually leave with the bees. Offer the hive's active deployments as
  default sale lines rather than making the operator return them to storage
  first and re-find them in inventory.
- **Guardrails matching the rest of the ledger.** A hive that is already
  sold, dead, or combined cannot be sold again; equipment lines cannot
  exceed available stock; and cancelling a sale restores the colony and the
  equipment, the way cancelling a honey sale already restores jars and
  unlinks serials.
- **Past-dated entry.** These sales have already happened. Recording one
  must not require pretending it happened today, and back-dating must land
  in the correct season for reporting.
- **Reporting that answers "did the bees pay for themselves?"** Split
  revenue by what was sold (honey / colonies / equipment), keep the
  collected-vs-invoiced distinction, pair colony revenue against the
  `bees_queens` expense category, and use stored unit cost as the cost
  basis for equipment lines.

**This must be designed against the gnucash-web sync from the start**, not
retrofitted — the three line kinds are not the same kind of accounting event,
so a single revenue mapping cannot serve them:

- **Honey** is inventory sold at retail or wholesale: revenue with COGS
  traceable to the physical ledger, which the existing design already covers.
- **Colonies** have no per-unit cost basis in this system. A hive was bought
  (a `bees_queens` expense), raised, or split off another colony; nothing
  capitalizes it. Colony proceeds are revenue against period expenses, and
  the mapping must say so rather than inventing a COGS figure the physical
  ledger cannot support.
- **Equipment** is an asset disposal, not merchandise. Boxes and frames sold
  used may have been expensed or capitalized on purchase, so the posting is
  potentially a gain or loss on disposal against the stored unit cost — a
  different account from sales revenue, and the one most likely to be
  mapped wrong if line kinds share a single account.

Consequences for the sync contract:

- One mixed sale is **one split transaction** on the accounting side, with a
  posting per line kind — not one lump sum, and not three unrelated
  transactions that no longer reconcile to the receipt.
- `external_sync` needs entity types and per-kind account/category/tax
  mappings for colony and equipment sale lines. This overlaps the already-
  planned equipment entity mappings and equipment mutation idempotency in
  the GnuCash item below; selling equipment *is* an equipment mutation, so
  the two should land together rather than twice.
- Cancelling a sale posts a reversing entry, never a delete — matching the
  existing rule that neither side silently overwrites the other.
- Back-dated entry meets a closed accounting period. Recording this spring's
  sale must either post to the correct period or surface the conflict for
  review; it must not silently re-date the transaction to today to make the
  posting succeed.
- The authority split holds: Beez Trackz stays authoritative for the
  colony's status and the equipment count, gnucash-web for the posted
  entries. A posting must never be the thing that marks a hive sold.

Naming follows the restructure rather than being an open question: with the
tables renamed to `sales`/`sale_items`, Sales stops being a Honey subsection
and moves up to a top-level destination, since a colony sale has nothing to
do with honey. That costs a nav slot — Honey drops to Overview and
Production — and the mobile bar already resolves overflow through More, so
the existing `SectionNav` groups absorb it.

**Selling a colony closes out the hive's open state automatically**
(decided 2026-08-12), because the alternative leaves a sold hive holding an
open feeder forever and the feeding status row reporting against a colony
that is gone. Automatic must not mean silent, so:

- **Feeders close with a reason that names the sale.** None of the existing
  close reasons fit — `removed` claims the beekeeper took the feeder off,
  `verified_closed` claims a field check happened. Add a `sold_with_hive`
  reason so the audit trail says what actually ended the feeding rather
  than borrowing a reason that is untrue.
- **Deployments split on whether they were sold.** Equipment named as a
  sale line left with the bees: it leaves the ledger as `sold` and must not
  be returned to storage. Everything else on that hive is equipment the
  operator kept, and returns to available stock. Getting this backwards
  either invents inventory that was sold or loses boxes that are sitting in
  the barn.
- **The sale dialog states the side effects before committing**, in the
  same confirmation that already lists the lines — "closes 1 open feeder,
  returns 3 deep boxes to storage" — so the operator can name a deployment
  as sold instead if the default guessed wrong.
- **Cancelling the sale reverses the close-out too**, reopening the feeders
  it closed and re-deploying what it returned. This is why the closures
  carry the sale link rather than a bare reason: without it, a cancel can
  restore the colony but not the state that came with it.

### Production and repeat-customer planning
**Shipped 2026-07-26.**

Use bulk inventory plus historical sales velocity to recommend what to bottle
next (jar mix, packaging required, projected revenue, and bulk reserved for
wholesale). QR Story pages can also support opted-in seasonal release alerts,
reorder reminders, and referral codes. Keep this narrowly focused on honey
customers rather than turning the app into a generic CRM.

## Data already in the database, one query away

### Hive timeline view
**Shipped 2026-07-26.**

A single chronological feed per hive merging inspections, feedings,
treatments, splits, harvests, queen changes, and moves.

### Honey yield by hive / apiary / year
**Shipped 2026-07-26.**

Harvests are recorded per hive; add a yield leaderboard and year-over-year
comparison.

### Season and apiary economics
**Shipped 2026-07-26.**

Combine the yield report with the new cost and sales-channel data: pounds per
hive, revenue and margin per apiary, winter survival, queen/split outcomes,
and treatment/feed cost per colony. This distinguishes a favorable honey year
from a genuinely improving operation.

### Queen performance scoring
**Shipped 2026-07-26.**

Connect lineage to outcomes: brood pattern ratings, temperament, survival,
and honey yield rolled up per queen and per mother line, displayed on the
genealogy tree.

## Field usability

### True offline mode
**Shipped 2026-07-26.**

The legacy offline queue was dead code and was dropped in the rewrite. The
PWA + Go API is a clean foundation for a real one: queue mutations in
IndexedDB, replay on reconnect with conflict detection.

### NFC / QR tags on hives
**Shipped 2026-07-26.**

Scan a tag at the hive to jump straight to its page or start a recording.
The same authenticated hive URL is encoded in QR and Web NFC. Printable
2x1-inch and 3x2-inch profiles work with MUNBYN label-printer drivers.

### Weather integration
**Shipped 2026-07-26.**

Apiaries have lat/lng. Auto-attach conditions to inspections; warn about
upcoming cold snaps when feeders are light. Forecasts use exact apiary
coordinates, cache provider results, and show feeder-aware field alerts.

## Housekeeping

### Retire the legacy stack from the repo
**Complete 2026-08-11.** Root `src/` was deleted 2026-08-04; the remaining
legacy root files (`drizzle/`, `drizzle.config.ts`, `package.json`/lockfile,
`Dockerfile`, `docker-entrypoint.sh`, `next.config.ts`, `tailwind.config.ts`,
`components.json`, `vitest.config.ts`, `scripts/`, `.prompts/`, root
`public/`, and legacy configs) are gone. The root `docker-compose.yml` (dev
infra for the new stack) and `DESIGN.md` remain by design.

The pre-rewrite Next.js app lived at the repo root and confused tooling,
agents, and reviews. The `src/` tree is gone; still present and candidates
for removal or relocation: root `drizzle/`, `drizzle.config.ts`,
`package.json`/`node_modules`, `Dockerfile`, `docker-compose.yml`,
`docker-entrypoint.sh`, `next.config.ts`, `tailwind.config.ts`,
`components.json`, `vitest.config.ts`, and `scripts/` (audit each for
live use first — the production compose file and CI reference only
`backend/` and `frontend/`).

### Dangling features to wire up or remove
**Closed 2026-08-04.** Lots and customers are editable in place from their
existing views (`PATCH` endpoints finally have UI); the low-stock threshold
surfaces on the Honey overview's next actions; wholesale price lists apply
from the sale dialog's wholesale channel, prefilling line prices and
enforcing the minimum server-side.

## ASI review backlog (2026-08-04)

The full-stack ASI review (`asi-review.md`, commit e9fd757) found no Critical
issues and confirmed the shipped ledger invariants hold — with the exceptions
below. Items are ordered by recommended attack order; IDs reference the
report, which carries evidence, exact locations, and regression checks.

### P0 — Make offline sync trustworthy (the queue can lose *and* duplicate data)
**Fixed 2026-08-11** — all four items below, with regression tests in
`honey_integration_test.go` (receipt completion after client disconnect,
truncated-body skip) and `db_errors_test.go` (error mapping).

These four share one test harness and should land together:

- **ASI-5-002 (High)** Logging back in after session expiry wipes every
  still-pending queued mutation (`sw.js` clears the queue on login success).
  Clear only the data cache; keep the queue and replay it after login.
- **ASI-5-003 (High)** One mutation that 500s wedges the whole queue forever —
  `replayQueue` breaks on 5xx leaving the item `pending`, and the review
  dialog hides pending items. Add a retry cap that promotes to `failed`.
- **ASI-5-001 (High)** Server-side, the receipt-completion write runs on the
  request context with its error discarded; a disconnect at the wrong moment
  leaves the receipt `processing` and a later replay re-executes the handler —
  the double-booked sale the middleware exists to prevent. Use
  `context.WithoutCancel` for receipt bookkeeping and stop storing truncated
  (>2 MB) bodies.
- **ASI-5-005 (Medium)** Handlers collapse transient DB errors into 4xx, which
  the idempotency layer stores as the permanent answer — a deadlock during a
  queued market-day sale silently loses the sale. Map non-constraint pg errors
  to 500 so replays retry.

### P0 — Close the negative-stock gap and bound uploads
**Fixed 2026-08-11** — jarring reversals now clear the availability check,
run-linked movements refuse reversal (409; a void-run action remains future
work), true-up/entry-delete hold the bulk lock with a jarred-pounds floor,
and transcription uploads are bounded. Regression tests alongside.

- **ASI-1-001 (High)** Reversing a `jarring` movement bypasses the shipped
  negative-stock validation (no lock, no availability check) — sold jars can
  be reversed into negative stock, double-counting honey. Related:
  **ASI-1-002 (Medium)** reversing a bottling-run movement strands the run,
  its serials, and lot capacity (refuse, or void the run in the same tx), and
  **ASI-5-004 (Medium)** true-up/entry-delete shrink bulk without the bulk
  lock or a floor against already-jarred pounds.
- **ASI-4-001 (High)** Transcription uploads are effectively unbounded
  (`ParseMultipartForm` doesn't cap request size; no `MaxBytesReader`) — an
  OOM path on the NAS.

### P1 — Security mediums
**Fixed 2026-08-11** — subscribe no longer rewrites customers and /public/*
POSTs are rate limited; photo uploads are whitelisted and served nosniff with
extension-derived types; login has an exponential per-IP failure throttle and
no longer echoes the JWT; prod compose requires a distinct `MINIO_SECRET_KEY`
(add to the NAS `.env`, then rotate `SESSION_SECRET`); `backend/server.exe~`
untracked with `.gitignore`/`.dockerignore` coverage.

- **ASI-3-001** Public honey-story subscribe can overwrite existing customer
  records (`ON CONFLICT ... DO UPDATE SET name=...`) and has no rate limit.
- **ASI-3-002** Stored XSS via client-controlled photo Content-Type — an
  editor→admin escalation; whitelist upload types, serve with `nosniff`.
- **ASI-3-003** No brute-force protection on login (in-app throttle or a
  traefik rate-limit rule).
- **ASI-3-004** Session JWTs are non-revocable for 30 days and echoed in the
  login response body; stop returning the token, consider shorter sessions.
- **ASI-3-005** `SESSION_SECRET` doubles as the MinIO root password in prod
  compose — split the vars, then rotate.
- **ASI-3-006** `backend/server.exe~` (34 MB binary) is committed — `git rm
  --cached`, extend `.gitignore`, add `backend/.dockerignore`.

### P1 — Worker/AI robustness
**Fixed 2026-08-11** — whisper installs use a 30-minute dedicated client,
fail on non-409 4xx, and are serialized; image jobs guard dimensions via
`DecodeConfig` (SkipRetry over 50 MP); all AI reads are capped at 10 MB;
recs dedup is a partial unique index with `asynq.Unique` on both scheduler
and manual runs; a daily job prunes receipts older than 30 days; test suites
seeded in `jobs`, `auth`, and `config`.

- **ASI-5-006** Whisper self-install: unpinned ~1.6 GB download under a
  5-minute timeout, 404 treated as success, concurrent installs unserialized.
- **ASI-6-001** Image jobs decode without a dimension guard — decompression
  bomb OOMs the worker with retries; check `DecodeConfig`, `SkipRetry` >50 MP.
- **ASI-6-002** All AI provider responses are `io.ReadAll` with no size cap
  against admin-configurable endpoints; wrap in `io.LimitReader`.
- **ASI-5-007** Every worker replica runs its own scheduler and the recs dedup
  check races — duplicate recommendation cards once workers scale.
- **ASI-4-002** `offline_mutation_receipts` grows forever; add a 30-day
  cleanup job.
- **ASI-2-001** `jobs`, `recs`, `auth`, `config`, `storage` have zero tests —
  seed a suite from the regression checks in the report as fixes land.

### P1 — Deployment process (config/docs, not code)
**Fixed 2026-08-11** — CI publish jobs gate on main only and actions are
SHA-pinned; the dead webhook job is replaced by a "manual deploy required"
summary carrying the sha to pin; README documents the backup → pin →
pull/up → verify deploy path with rollback; minio/speaches are
digest-pinned; api/web/worker/whisper have healthchecks (`/healthz` now
pings the DB); runtime containers run non-root; whisper is memory-bounded.

- **ASI-7-001** Prod floats on `:latest` with `pull_policy: always`, and CI
  publishes `latest` from any push to `main` *or* a recreated
  `rewrite/go-stack` — a container restart can become an unintended upgrade
  plus migration. Pin `BEEZ_IMAGE_TAG` to a sha; gate publish jobs on main.
- **ASI-7-002** Migrate-on-boot with no backup step or rollback procedure
  anywhere in the repo — document/script the SSH `pg_dump` → `compose pull &&
  up` deploy path in README.
- **ASI-7-003** CI's `notify-dockhand` job curls the dead webhook and
  double-swallows failure — green CI implies a deploy that never happened.
  Delete or replace with a "manual deploy required" notice.
- **ASI-7-004** Cluster: runtime containers run as root; `minio:latest` /
  `speaches:latest-cpu` unpinned; no healthchecks on api/web/worker/whisper
  (`/healthz` exists but is unused and checks nothing).

### P2 — Field-facing correctness papercuts
**Fixed 2026-08-11** — comma-decimal prices parse correctly, transcription
polling survives a failed first poll, sale lines with quantity require a
price, the public story page formats dates in UTC, and a 401 on any
non-auth endpoint redirects to /login.

- **ASI-1-003** `parseCents` turns `"24,50"` into $2,450 — comma-decimal
  locales silently record 100× equipment costs.
- **ASI-1-004** Transcription status polling stops permanently if the first
  poll fails — spinner forever after a successful upload.
- **ASI-1-005** Sale lines with quantity but no price silently record $0.
- **ASI-1-006** Public honey-story page renders date-only values via
  `new Date()` — shows the previous day in western timezones; the one page
  not using the UTC-pinned formatters.
- **ASI-8-002** No global 401 handling — an expired session leaves the user
  filling forms that fail with generic toasts (feeds the ASI-5-002 data-loss
  scenario).

### P2 — Low-severity backlog
**Fixed 2026-08-11** (details per finding in `asi-review.md`). Deliberately
left: migrate-legacy per-table transactions (one-shot operator tool) and the
already-applied 00005 backfill's UTC quirk (benign NULL link).

Remaining Lows in the report: SSRF-shaped AI base-URL fetches (ASI-3-007),
MinIO default-credential fallback (ASI-3-008), silent non-Secure cookies on
misconfigured `APP_URL` (ASI-3-009), tag-pinned GitHub Actions (ASI-3-010),
transcription hive-match on empty references (ASI-1-007), cancelled sales
keeping serials "sold" (ASI-1-008), the `jar_serials` ON DELETE/CHECK
contradiction (ASI-1-009), a minor backend correctness cluster (ASI-1-010),
offline receipts unverified against method/path (ASI-5-008), a worker-edge
reliability cluster (ASI-5-009), service-worker cache growth and the 5-second
stale-serve (ASI-6-003), `reorderUrl` scheme validation (ASI-3-011), and the
frontend minor cluster (ASI-8-002). The legacy-stack cleanup (ASI-8-001) is
already tracked under Housekeeping above.

## Adversarial review backlog (2026-08-12)

Three independent read-only reviewers (navigation/layout, Go backend internals,
and the frontend↔backend seam) against HEAD `b234d82`, scoped by the standing
complaint that navigation and layout still feel clunky. Full evidence, file:line
citations, and recommended fixes are in
`docs/plans/2026-08-12-adversarial-ui-backend-review.md`; IDs below reference it.

Seven Critical findings, none of which overlap the ASI backlog above. Items are
ordered by recommended attack order.

**The pattern behind them:** the documented contract and the implementation have
drifted, and nothing tests the seam. `DESIGN.md:27,34` promises safe-area handling
that exists in exactly one component; `DESIGN.md:33` promises scrollable mobile
tabs that were deliberately replaced with a `<Select>`; `README.md:55` promises
cached offline reads while every offline navigation lands on `/offline`;
`README.md:57` promises conflicts are reviewable "instead of being overwritten"
while the Retry button guarantees the overwrite; and `middleware_offline.go:72-87`
hardens honey/commerce for offline replay — calling market day "the most
offline-prone surface in the product" — against a service-worker queue list that
contains none of those paths. The recurring fix is to make each pair of lists one
artifact with a test asserting they agree, rather than repairing each drift alone.

**Caveat:** `npx tsc --noEmit` and `npm run lint` could not run — `frontend/node_modules`
has no local `typescript` or `eslint`. All frontend findings are source-read with
file:line evidence, not from a type-checked build (UX-024).

### P0 — Silent data loss and silent data mutation

These four are the "the app lied to me" cluster: each one loses or changes a
record while telling the user nothing, or telling them the opposite.

- **SEAM-001 (Critical)** Market-day POS swallows every sale failure — `useRecordSale`
  is `silentError: true` (correct for the dialog, which renders the error inline)
  and market day never reads `sale.error`. A failed sale at a market shows nothing:
  the button re-enables, the cart stays full, and the beekeeper hands over honey
  believing it recorded — or taps again and double-books. Smallest fix on this list;
  the correct pattern is twenty lines away in `record-sale-dialog.tsx:187-210`.
- **SEAM-002 (Critical)** A 401/403 during replay wedges the entire offline queue —
  `replayQueue` breaks on 401/403 leaving the item `pending`, which the review dialog
  hides, so the banner spins "Syncing N queued changes…" forever with no sign-in
  prompt. An expired overnight session strands a day of inspections; one editor-only
  403 jams every write behind it. Directly parallel to the shipped ASI-5-003 (5xx
  wedge) — the auth arm was not covered.
- **SEAM-003 (Critical)** Logging out silently destroys the unsent queue —
  `clearPrivateOfflineState()` wipes IndexedDB on a single unguarded click. The login
  path deliberately preserves the queue for exactly this reason (ASI-5-002, shipped),
  and logout throws it away anyway.
- **UX-001 (Critical)** `g d`, `g s`, `g r` silently mutate records — the dashboard
  installs a second `window` keydown listener, so the documented navigation prefixes
  also **dismiss the top colony alert**, **snooze it seven days**, and **refill a
  feeder**. `focusedIndex` starts at 0 with no user interaction, there is no confirm
  and no undo, and because the keys bypass `useShortcut` they never appear in `?`.

### P0 — The bottom of the screen is unusable in the field

One shared root cause: nothing derives from the bottom nav's real height, which is
~51px **plus `env(safe-area-inset-bottom)`** (34px on Face-ID iPhones, with
`viewportFit: "cover"` active). A single `--bottom-nav-h` variable in `globals.css`
fixes all of these together.

- **UX-002 (Critical)** The offline/sync banner and install prompt (`bottom-3`,
  z-90/z-100) paint directly over the bottom nav (`bottom-0`, z-40). The banner
  renders whenever offline or holding queued writes — the entire time the beekeeper
  is out of cell range, the scenario the PWA exists for — and cannot be dismissed.
- **UX-003 (High)** Five sticky bulk toolbars hardcoded to `bottom-20` (80px) clip
  under an 85px nav that also outranks them in z-order. The clipped region holds
  "Exit bulk select" and Archive/Delete.
- **UX-004 (High)** Market day hides all navigation by design but has no
  `pt-[env(safe-area-inset-top)]`, so the **Exit** button — the only way out —
  renders under the notch, and checkout sits under the home indicator.
- **UX-005 (Medium)** Safe-area handling is claimed in `DESIGN.md:27,34` and
  implemented in exactly one component; the base dialog's `max-h-[calc(100dvh-2rem)]`
  also puts submit buttons out of reach, and landscape insets are absent everywhere.

### P1 — The "clunky" cluster

The direct answer to the standing complaint. Tap depth is fine; these are the causes.

- **UX-006 (High)** 768px tablet cliff — content drops from 735px to **464px** as the
  viewport grows by one pixel, so a hive card goes 359px → 224px (38% smaller on a
  wider screen) and stays cramped until 1024px, with every `whitespace-nowrap` table
  scrolling horizontally through the whole band. Most likely single contributor to
  the layout complaint. Move the sidebar from `md:` to `lg:`.
- **UX-007 (High)** Single-key shortcuts fire while typing in Radix comboboxes and
  menus — the guard only knows `<input>`/`<textarea>`, but `SelectTrigger` is a
  `<button role="combobox">` with typeahead that does not `preventDefault`. Filtering
  hives by typing "b" toggles bulk mode, "n" opens New hive behind the popup, "x"
  opens Split hive. `dashboard-view.tsx:40-53` duplicates the same flawed check.
- **UX-008 (High)** "All N inspections" lands on the wrong tab — `setTab` and
  `setFilter` each rebuild from the same stale snapshot and issue their own
  `router.replace`, so the second drops `tab` and the user is dumped on Overview.
- **UX-009 (Medium)** Sidebar expansion pins on first click and never re-syncs to the
  route (`expanded[href] ?? active` — the fallback dies after any manual toggle), and
  the active row is never scrolled into view. Nothing looks broken, which is exactly
  why it reads as clunky rather than buggy.
- **UX-010 (Medium)** Tapping "Yards" sometimes doesn't go to Yards — a once-per-session
  `sessionStorage`-gated `router.replace` to the apiary detail when there is exactly
  one apiary, which also makes Back skip to the Dashboard. Single-apiary is the most
  common hobbyist setup, so this is the default experience.
- **UX-011 (Medium)** Mobile section nav contradicts `DESIGN.md:33` and can only reach
  interstitials — the same seven reports are presented three different ways depending
  on the surface, and there is no report-to-report jump on a phone.
- **UX-012 (Medium)** The 9-chip timeline filter strip scrolls with zero offscreen
  affordance; "Splits" and "Moves" are invisible on a 390px phone.
- **UX-013 (Medium)** Five of nine destinations sit behind "More", whose nested links
  are 36px — a direct `DESIGN.md:27` violation on the deepest targets, since the
  coarse-pointer rule does not cover plain anchors.

### P1 — Offline/PWA is structurally incomplete

The ASI P0 work made the queue trustworthy once a write reaches it. These findings
are about writes that never reach it, and reads that never come back.

- **SEAM-004 (High)** The backend's `offlineMutationSupported` list and the service
  worker's `supportedFieldPaths` share **zero** entries on honey/commerce — the
  market-day protection was built server-side and left unreachable.
- **SEAM-005 (High)** The conflict Retry button restamps `queuedAt` to now, which is
  by construction after the server's `updated_at`, so the conflict check returns false
  and the retry clobbers the collaborator's edit — inverting `README.md:57` in one line.
- **SEAM-006 (High)** Offline writes return `202 {queued:true}`, which the API client
  hands back as the created entity: success toast fires, dialog closes, list refetches
  from cache without the record. The user is told it saved and cannot find it.
- **SEAM-007 (High)** Offline navigation always lands on `/offline` — `SHELL` precaches
  only `/offline` and icons, and RSC payload requests fall through unhandled. The
  banner and `/offline` tell the user opposite things.
- **SEAM-008 (High)** Every body-less POST is excluded from the queue by the
  content-type gate, so "mark feeder empty", "mark deadout", and "end bloom" — the
  archetypal one-handed field actions — are exactly the ones that fail offline.
- **SEAM-009 (High)** Stale cache is served as fresh past a 5s network timeout with no
  marker, while the indicator keys off `navigator.onLine` (true on a slow rural link).
  Extends the deliberately-deferred ASI-6-003.
- **SEAM-010 (Medium)** The queue is unbounded and re-broadcasts its entire contents to
  every client on every write.
- **SEAM-011 (Low)** Receipt retention (30 days, ASI-4-002) is shorter than the queue's
  TTL (none), so a long-stuck item can replay past its receipt and duplicate.

### P1 — Errors have nowhere to surface

- **SEAM-012 (High)** The Honey hub has zero `isError` branches: on any failure,
  including a 403, it renders skeletons forever beside a confident "0 unpaid orders,
  $0.00 invoiced".
- **UX-015 (High)** Escape or a stray outside tap discards a half-finished inspection —
  the app's longest form has no dirty guard, though market day already implements the
  correct pattern.
- **SEAM-013 (Medium)** No error boundary exists anywhere in the app, so a customer
  scanning a jar QR during a deploy gets Next.js's raw crash screen on the product's
  public traceability surface.
- **UX-014 (Medium)** Two competing offline indicators render simultaneously saying
  different things; merging them into the top banner also resolves UX-002.
- **UX-016 (Medium)** Ten empty states and four error states with no next step, against
  `DESIGN.md:37`; two of the error states are whole pages with no retry and no way back.
- **UX-017 (Medium)** Validation errors inconsistently placed, some fields red with no
  message, and no scroll-to-error on a twelve-section form.
- **SEAM-014 (Medium)** Multipart uploads bypass the 401 → `/login` redirect and discard
  the captured photo or recording.
- **SEAM-015 (Medium)** Transcription polls every 3s forever and never surfaces a polling
  failure — the headline voice-first feature spins indefinitely when the worker is down.

### P1 — Backend robustness

- **API-001 (Critical)** Concurrent `/auth/setup` lets two anonymous callers claim the
  instance — no lock, no singleton constraint, and login takes `LIMIT 1`.
- **API-002 (Critical)** Idempotency is still not atomic with the domain write. ASI-5-001
  fixed the cancelled-context half; the crash window between the domain commit and the
  receipt write remains, and a replay after it re-executes the mutation.
- **API-003 (High)** Unauthenticated `/auth/setup` runs bcrypt cost 12 *before* checking
  whether setup is complete, unrated-limited — a cheap CPU-exhaustion DoS.
- **API-004 (High)** No global request-body limit and no `ReadTimeout`/`IdleTimeout`/
  `WriteTimeout`/`MaxHeaderBytes`.
- **API-005 (High)** Admin bottling with an unbounded `quantity` and `serialize:true`
  loops per jar, accumulates every serial in the response, and holds the transaction open.
- **API-006 (High)** Honey timeline accepts `limit=999999999` and merges/sorts in memory.
- **API-007 (High)** Chi `RealIP` has no trusted-proxy allowlist, so `X-Forwarded-For`
  rotation bypasses the login and public-subscription throttles shipped for ASI-3-001/003.
- **API-008 (Medium)** Token verification amplifies DB load (a write per valid call) with
  no limiter and a fast unsalted SHA-256 lookup.
- **API-009 (Medium)** Cross-apiary queen lineage — an editor on apiary A can point
  `originHiveId`/`parentQueenId` at apiary B; only `hiveId` is authorized.
- **API-010 (Medium)** Money parser can overflow signed cents before validation.
- **API-011 (Medium)** Transcription jobs are not idempotent under asynq at-least-once
  delivery — duplicate AI cost, and a good transcript can be overwritten.
- **SEAM-016 (Medium)** Admin-only pages have no route guard, and the Reports tree is not
  marked `adminOnly` despite its Finance and Sales-&-planning children requiring admin.
- **SEAM-017 (Medium)** `/hives/{id}/inspections` is unbounded and ships a full weather
  snapshot per row — to render three cards.
- **SEAM-018 (Medium)** `DATA_CACHE` is unbounded and caches authenticated photo binaries;
  `cache.put` failures are discarded via `void`, so quota exhaustion is unobservable.
  Extends ASI-6-003.

### P2 — Accessibility and correctness papercuts

- **UX-018 (High)** Bulk-selecting hives in table view is impossible with a keyboard or
  screen reader — selection sits on a `<tr>` with no `tabIndex`, and the checkbox is
  controlled with no `onCheckedChange` plus `pointer-events-none`. The card branch is correct.
- **UX-019 (Medium)** Color-only status against `DESIGN.md:26` — a 6px `aria-hidden`
  red-vs-amber urgency dot with no paired text, and queen marking year only in a `title`.
- **UX-020 (Medium)** Delete-expense and revoke-API-token fire with no confirmation, unlike
  the nine comparable actions that all confirm.
- **UX-021 (Medium)** Base dialog `max-h-[calc(100dvh-2rem)]` puts submit buttons under the
  home indicator; the longest form is accidentally safe because it overrides to `90dvh`.
- **UX-022 (Medium)** Long forms have no sticky submit, so the most frequent write in the
  app requires scrolling the full form one-handed.
- **UX-023 (Medium)** Exiting bulk mode clears the selection, so "archive the deadouts but
  let me check that one" means starting over.
- **UX-024 (Medium)** `frontend/node_modules` has no local `typescript`/`eslint`, so the
  lint and typecheck gates cannot be run locally — several findings here (SEAM-019,
  SEAM-020) are the class a typecheck catches.
- **UX-025 / SEAM-019…024 / API-012 (Low)** `x` collides with the documented global
  select-all; shortcut registry overwrites silently; `?` advertises shortcuts viewers
  cannot use; Radix dialogs push no history entry so Android Back closes the route;
  duplicate `aria-label="Main navigation"`; command-palette results lack listbox roles;
  unsized `<img>` CLS risk; skeletons omit the action row; the apiary canvas has no
  keyboard path; `AuthStatus` omits `isAdmin` (costing a round trip per load); `HoneySale`
  omits `tax`/`updatedAt`/`cancelledAt`; CSRF rests entirely on `SameSite=Lax` with no
  Origin check outside MCP (holds today only because no mutation is a GET — worth a test
  pinning that invariant); `NEXT_PUBLIC_API_URL` inlines an internal hostname into the
  public bundle; the public honey story renders dates a day early east of UTC; anonymous
  visitors can create customer records (5/min/IP); migrations run uncancelable at startup.

Verified clean during this review and worth not re-litigating: `isNavRouteActive` is
correct (the one case where the indicator lies is UX-008's bad URL); tab and filter state
*are* URL-backed and refresh-safe; Radix focus trapping and restore are sound; reduced
motion is handled correctly; icon-only buttons have accessible names; the public honey
story is a curated projection that leaks no hive/apiary ids, coordinates, inspection,
expense, or customer data, and photo access re-checks `is_public`; no secret is in
`localStorage` and there is no `dangerouslySetInnerHTML` anywhere.

## Longer arc

### Bloom calendar intelligence
**Shipped 2026-07-26.**

Bloom observations are being recorded; correlate them with harvest timing
across years to predict flow starts. Predictions are location-specific:
distance-weighted observations within 50 miles favor the current apiary and
shift their windows using its local forecast.

### MCP server for the Go API
**Shipped 2026-07-26.**

The legacy app exposed one. Re-adding it lets an AI assistant answer
questions like "which hives haven't been inspected since the flow started?"
from any MCP client.

### Multi-user support
**Shipped 2026-07-26.**

`user_settings` is single-row by design. If anyone else ever helps with the
bees, per-user identities over shared data is the one structural change to
plan for. Administrators now pre-authorize verified OIDC emails and grant
viewer/editor access separately for each apiary; API tokens and MCP calls use
the same authorization rules.
