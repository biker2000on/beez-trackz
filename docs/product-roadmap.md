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
