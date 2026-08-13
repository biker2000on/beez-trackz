# Beez Trackz — Delivered Work

Completed roadmap items, kept out of `product-roadmap.md` so that document shows
only what is next. Split out 2026-08-13. Entries preserve the delivery notes
written at the time, including the design decisions behind them, because several
are the rationale for why the current schema and UI look the way they do.

Nothing here is a commitment to future behavior. If an entry conflicts with the
code, the code is right and the entry is stale.

**Caveat on "shipped" labels.** The 2026-08-12 adversarial review found that
three items marked fixed on 2026-08-11 were fixed only on the arm that was
reported — the sibling path was never covered. Treat a completion note here as
"the reported case was fixed and tested", not "the class of bug is gone". The
specific carve-outs are noted inline below.

## Delivered 2026-07-26 — first roadmap wave

### Voice-first everything

The transcription parser extracts feedings ("gave A3 two quarts of 1:1"),
treatments ("put Apivar strips in B2"), and queen events ("saw a new queen in
A4, superseded") from one walkthrough recording, not just inspections.

### Overwintering & survival analytics

A winter-survival report by apiary, stand position, and queen line, built on the
existing deadout dates, location history, and queen lineage.

### Varroa tracking

Structured mite-count fields (alcohol wash / sticky board counts) replacing
free-text pest counts, with per-hive trend charts and treatment-efficacy
overlays comparing counts before and after each treatment.

See the roadmap's **Varroa program** item for what this wave did *not* cover.

### Profitability and cost tracking

Expenses for bees and queens, feed, treatments, jars/lids/labels, equipment,
mileage, market fees, and optional estimated labor. Reports revenue, gross
margin, cost per harvested pound, cost per jar, inventory value, and break-even
pricing by season, harvest lot, jar size, sales channel, and apiary.

### Sales channels, orders, and market-day mode

Record Sale gained channels (farm stand, farmers market, wholesale, pickup,
online, gift, consignment), customer and order history, receipts/invoices,
unpaid balances, wholesale price lists and minimums, low-stock alerts, and
end-of-day reconciliation. A phone-first market-day screen uses large product
buttons, captures payment method and discounts, and decrements inventory
immediately.

### Production and repeat-customer planning

Bulk inventory plus historical sales velocity recommends what to bottle next
(jar mix, packaging required, projected revenue, bulk reserved for wholesale).
QR Story pages support opted-in seasonal release alerts, reorder reminders, and
referral codes. Deliberately scoped to honey customers rather than a generic CRM.

### Hive timeline view

A single chronological feed per hive merging inspections, feedings, treatments,
splits, harvests, queen changes, and moves.

### Honey yield by hive / apiary / year

A yield leaderboard and year-over-year comparison over the per-hive harvest
records.

### Season and apiary economics

Yield combined with cost and sales-channel data: pounds per hive, revenue and
margin per apiary, winter survival, queen/split outcomes, and treatment/feed
cost per colony — distinguishing a favorable honey year from a genuinely
improving operation.

### Queen performance scoring

Lineage connected to outcomes: brood pattern ratings, temperament, survival, and
honey yield rolled up per queen and per mother line, on the genealogy tree.

### True offline mode

The legacy offline queue was dead code and was dropped in the rewrite. Replaced
with mutations queued in IndexedDB and replayed on reconnect with conflict
detection. Substantially revised on 2026-08-11 (see below) and still carrying
open structural gaps — see the roadmap's offline/PWA section.

### NFC / QR tags on hives

Scanning a tag at the hive jumps to its page or starts a recording. The same
authenticated hive URL is encoded in QR and Web NFC. Printable 2x1-inch and
3x2-inch profiles work with MUNBYN label-printer drivers.

### Weather integration

Conditions auto-attach to inspections using exact apiary coordinates, with
cached provider results and feeder-aware field alerts warning about upcoming
cold snaps when feeders are light.

### Bloom calendar intelligence

Bloom observations correlate with harvest timing across years to predict flow
starts. Predictions are location-specific: distance-weighted observations within
50 miles favor the current apiary and shift their windows using its local
forecast.

### MCP server for the Go API

Re-added after the rewrite, letting an AI assistant answer questions like "which
hives haven't been inspected since the flow started?" from any MCP client.

### Multi-user support

`user_settings` was single-row by design. Administrators now pre-authorize
verified OIDC emails and grant viewer/editor access separately for each apiary;
API tokens and MCP calls use the same authorization rules.

## Delivered 2026-08-04

### Harvest lots, jar runs, and customer-facing QR honey stories

Harvest-lot records (for example `2026-SUMMER-01`) link source apiaries/hives,
extraction date and weight, notes, testing data, and bottling/jar runs, with a
QR code generated per lot by default and optional per-jar serials.

The QR opens a public, read-only Honey Story page carrying curated honey
variety/season, bottling date, lot number, approximate apiary region, bloom
observations, beekeeper story, and selected photos — with exact coordinates and
raw inspection data kept private, plus a reorder link and optional customer
email signup.

Serial traceability completed the same day: `/harvest/serials` looks any serial
up (serial → bottling run → lot → sale), and sales carry linked serials via
`jar_serials.sale_id` with audit fields, managed from the sale receipt. Bottling
runs are FK-linked to the jar ledger and validated against lot weight and bulk on
hand. Lot weight remains free-typed against linked harvests.

### Equipment ledger

Equipment became a real ledger: a unique stock row per type (duplicates merged),
trigger-derived totals with drift rejected, damaged/retired states with a loss
report, partial guarded returns carrying reason and condition, needed quantity
and unit cost in integer cents, and a physical-count flow replacing bulk-adjust.

This closed a specific list of defects: returns that could not be partial and
silently overwrote the first return date; damaged/retired existing only as
adjustment reasons that decremented `total_owned`; `bulk-adjust` recording
reason `'other'` with note "bulk edit" while silently skipping unresolvable
rows; `equipment_stock.type_id` not being unique; `total_owned` kept in sync
only by application code with nothing reconciling it; and stock validation
existing only on the sale path.

### GnuCash-readiness foundations

Integer cents, audit fields, reversals and soft deletes, a unified bulk formula,
stock validation, collected-vs-invoiced revenue fields, honey/commerce
idempotency, and the `external_sync` mapping table. Live sync and reconciliation
remain open — see the roadmap.

### Dashboard hierarchy

The dashboard leads with **Needs attention** and **Today's field actions**, then
hive/apiary status, feeding summaries, recent activity, and reporting. Every row
names its action and its evidence rather than giving generic advice equal weight
with setup or analytics.

### PWA prompt behavior

The install prompt waits for a completed task or repeat visit, retreats from
dialogs, recordings, and detail routes, persists dismissal for 120 days, and
Settings keeps a permanent Install entry — so it never overlays active apiary,
hive, or field-recording work.

### Dangling features wired up

Lots and customers became editable in place from their existing views (`PATCH`
endpoints finally got UI); the low-stock threshold surfaces on the Honey
overview's next actions; wholesale price lists apply from the sale dialog's
wholesale channel, prefilling line prices and enforcing the minimum server-side.

### Responsive field polish (partial)

Touch targets, empty states, and phone layouts in apiaries, queens, and
settings. Remaining gaps stayed on the roadmap and were substantially expanded
by the 2026-08-12 review.

## Delivered 2026-08-11

### Feeding lifecycle and one-row hive status

Explicit open/closed/unverified feeder states with refill and close endpoints,
an audited reversible backfill (originals preserved in
`feeding_status_backfills`), and a per-visible-active-hive `GET /feedings/status`
row driving the dashboard widget, including explicit zero-history rows for hives
that have never been fed.

A feeding recorded without a feeder is a feed event — created closed
(`not_installed`) so it can never overstate active feeders, with the dialog
making the choice explicit ("No feeder — fed directly"). The dashboard row shows
the latest feed (date, type, quantity, feeder) and separates open from
unverified counts. On mixed hives the action always targets the record it names
(verify → oldest unverified, refill/close → oldest open).

Context at audit time: 81 feeding records had no empty date across 22 hives (two
to six records per hive), every one older than 90 days. The work first verified
whether an empty date actually meant an active feeder, then performed an
audit-safe reversible backfill rather than silently changing history.

### Navigation restructure — tabs replaced with overviews

Closed the tab problem quantified by the 2026-08-03 adversarial review: 28 tab
triggers across 5 tab strips, 11 tab targets on `/harvest` alone, 9 tabs on hive
detail, zero tab state in URLs, and a mobile bottom nav dropping 4 of 9
destinations with no overflow.

Apiary opens on an Overview with one peer view, Layout; Flora, Photos, and Bulk
record are dedicated routes. Hive opens on a true summary Overview with three
peer views (Overview | Timeline | Health); Equipment, Queen, and Photos are
dedicated drill-down routes, and the timeline's filter chips replaced the four
tabs that were filtered subsets of it. Honey has three invariant workflow groups
(Overview | Production | Sales), with Activity, Harvests, Lots, and Serial
lookup resolving to a group without expanding the strip. Reports uses three
groups (Outcomes | Finance | Sales & planning) on detail pages and no redundant
strip above its card-based home. Market day became a full-screen
`/harvest/market-day` rather than a cart inside a tab. Business reports merged
into `/reports`, resolving the three disagreeing financial surfaces into one
reporting home with a labeled revenue definition. `/genealogy` was renamed
`/queens` with a redirect; `/transcribe` gained inbound links from apiary
detail; the two deploy-equipment UIs became one dialog; and the four hand-rolled
bulk-select toggles now share `useBulkSelect`.

Both menus collapse to a select on phones. Home stays pinned in the mobile bar
with other destinations reachable through More. Responsive browser regression
tests cover 390 px and 1024 px layouts, group invariance, tab counts, and URL
state.

Deliberately deferred: the `/harvest` → `/honey` route rename, which collides
with the public `/honey/[slug]` story pages. Still open on the roadmap.

The 2026-08-12 review found this work left the mobile bottom nav overlapped by
undismissable overlays and introduced a 768 px layout cliff — see the roadmap's
navigation section.

### Harvest sessions with an explicit lifecycle

The session page records a whole walkthrough as line items saved in one
transaction. Each line, and the standalone harvest dialog, takes either a
super-weight pair or a directly measured harvested weight (`direct_weight`,
migration 00011), and every surface labels the pair "Super weight before/after
(lbs)". Sessions run In progress → Finalized by true-up: finalized sessions
refuse new entries, the true-up captures a reason and renders its history,
session entries are no longer double-listed under Individual harvests, and entry
deletion is presented as the audited archive it is.

### Retire the legacy stack from the repo (ASI-8-001)

Root `src/` was deleted 2026-08-04; the remaining legacy root files
(`drizzle/`, `drizzle.config.ts`, `package.json`/lockfile, `Dockerfile`,
`docker-entrypoint.sh`, `next.config.ts`, `tailwind.config.ts`,
`components.json`, `vitest.config.ts`, `scripts/`, `.prompts/`, root `public/`,
and legacy configs) are gone. The root `docker-compose.yml` (dev infra for the
new stack) and `DESIGN.md` remain by design.

## ASI review backlog — delivered 2026-08-11

The full-stack ASI review (`asi-review.md`, commit e9fd757) found no Critical
issues and confirmed the shipped ledger invariants hold, with the exceptions
below. All were fixed 2026-08-11.

**Three of these were fixed only on the reported arm.** The 2026-08-12 review
found the sibling path still open in each case. They are listed with the item.

### Offline sync trustworthiness

- **ASI-5-002** Logging back in after session expiry wiped every still-pending
  queued mutation. Fixed: only the data cache clears; the queue is preserved and
  replayed after login. **Sibling still open —** the logout path destroys the
  same queue (SEAM-003).
- **ASI-5-003** One mutation that 500s wedged the whole queue forever. Fixed
  with a retry cap that promotes to `failed`. **Sibling still open —** 401/403
  and 409 responses still wedge it (SEAM-002).
- **ASI-5-001** The receipt-completion write ran on the request context with its
  error discarded, so a disconnect could leave the receipt `processing` and let a
  replay re-execute the handler. Fixed with `context.WithoutCancel` for receipt
  bookkeeping, and truncated (>2 MB) bodies are no longer stored. **Sibling still
  open —** that covers client cancellation, not process death between the domain
  commit and the receipt write (API-002).
- **ASI-5-005** Handlers collapsed transient DB errors into 4xx, which the
  idempotency layer stored as the permanent answer. Fixed by mapping
  non-constraint pg errors to 500 so replays retry.

Regression tests in `honey_integration_test.go` (receipt completion after client
disconnect, truncated-body skip) and `db_errors_test.go` (error mapping).

### Negative-stock gap and unbounded uploads

- **ASI-1-001** Reversing a `jarring` movement bypassed negative-stock
  validation. Fixed: jarring reversals now clear the availability check.
- **ASI-1-002** Reversing a bottling-run movement stranded the run, its serials,
  and lot capacity. Fixed by refusing reversal with a 409; a void-run action
  remains future work and is on the roadmap.
- **ASI-5-004** True-up and entry-delete shrank bulk without the bulk lock or a
  floor against already-jarred pounds. Fixed: both hold the lock with a
  jarred-pounds floor.
- **ASI-4-001** Transcription uploads were effectively unbounded, an OOM path on
  the NAS. Fixed and bounded.

### Security

- **ASI-3-001** Public honey-story subscribe could overwrite existing customer
  records and had no rate limit. Fixed: subscribe no longer rewrites customers,
  and `/public/*` POSTs are rate limited.
- **ASI-3-002** Stored XSS via client-controlled photo Content-Type, an
  editor→admin escalation. Fixed: uploads are whitelisted and served `nosniff`
  with extension-derived types.
- **ASI-3-003** No brute-force protection on login. Fixed with an exponential
  per-IP failure throttle. **See API-007 on the roadmap** — the throttle trusts
  user-controlled forwarding headers, so it is bypassable as shipped.
- **ASI-3-004** Session JWTs were echoed in the login response body. Fixed: the
  token is no longer returned.
- **ASI-3-005** `SESSION_SECRET` doubled as the MinIO root password in prod
  compose. Fixed: prod compose requires a distinct `MINIO_SECRET_KEY` (add to the
  NAS `.env`, then rotate `SESSION_SECRET`).
- **ASI-3-006** A 34 MB `backend/server.exe~` binary was committed. Untracked,
  with `.gitignore`/`.dockerignore` coverage.

### Worker and AI robustness

- **ASI-5-006** Whisper self-install was an unpinned ~1.6 GB download under a
  5-minute timeout that treated 404 as success with unserialized concurrent
  installs. Fixed: a 30-minute dedicated client, failure on non-409 4xx, and
  serialization.
- **ASI-6-001** Image jobs decoded without a dimension guard. Fixed via
  `DecodeConfig` with `SkipRetry` over 50 MP.
- **ASI-6-002** AI provider responses were `io.ReadAll` with no size cap. Fixed:
  all AI reads capped at 10 MB.
- **ASI-5-007** Every worker replica ran its own scheduler and the recs dedup
  check raced. Fixed with a partial unique index plus `asynq.Unique` on both
  scheduler and manual runs.
- **ASI-4-002** `offline_mutation_receipts` grew forever. Fixed with a daily job
  pruning receipts older than 30 days. **See SEAM-011 on the roadmap** — that
  retention is shorter than the queue's TTL.
- **ASI-2-001** `jobs`, `recs`, `auth`, `config`, `storage` had zero tests. Test
  suites seeded in `jobs`, `auth`, and `config`.

### Deployment

- **ASI-7-001** Prod floated on `:latest` with `pull_policy: always` and CI
  published `latest` from any push to `main` or a recreated `rewrite/go-stack`.
  Fixed: publish jobs gate on main only, actions are SHA-pinned.
- **ASI-7-002** Migrate-on-boot with no backup step or rollback procedure. Fixed:
  README documents the backup → pin → pull/up → verify deploy path with rollback.
- **ASI-7-003** CI's `notify-dockhand` job curled a dead webhook and
  double-swallowed failure, so green CI implied a deploy that never happened.
  Replaced with a "manual deploy required" summary carrying the sha to pin.
- **ASI-7-004** Runtime containers ran as root, `minio:latest` and
  `speaches:latest-cpu` were unpinned, and api/web/worker/whisper had no
  healthchecks. Fixed: images digest-pinned, healthchecks added (`/healthz` now
  pings the DB), runtime containers run non-root, whisper is memory-bounded.

### Field-facing correctness

- **ASI-1-003** `parseCents` turned `"24,50"` into $2,450. Fixed.
- **ASI-1-004** Transcription status polling stopped permanently if the first
  poll failed. Fixed. **See SEAM-015 on the roadmap** — polling still never
  surfaces a sustained failure.
- **ASI-1-005** Sale lines with quantity but no price silently recorded $0.
  Fixed: a price is now required.
- **ASI-1-006** The public honey-story page rendered date-only values via
  `new Date()`, showing the previous day west of UTC. Fixed: the formatter pins
  `timeZone: "UTC"`, verified at `frontend/src/app/honey/[slug]/page.tsx:49`.
- **ASI-8-002** No global 401 handling. Fixed: a 401 on any non-auth endpoint
  redirects to `/login`. **See SEAM-014 on the roadmap** — multipart uploads
  bypass this.

### Low-severity backlog

Fixed 2026-08-11, details per finding in `asi-review.md`. Deliberately left, and
still deliberately left: migrate-legacy per-table transactions (a one-shot
operator tool) and the already-applied 00005 backfill's UTC quirk (a benign NULL
link). The Lows that remain open are listed on the roadmap.
