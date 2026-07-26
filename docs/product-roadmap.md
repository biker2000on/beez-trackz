# Beez Trackz — Product Roadmap

Feature ideas for the Go/Next.js stack, grouped by theme. Roughly ordered by
value-for-effort within each section. (Drafted 2026-07-23, after the stack
rewrite cutover.)

Status labels below reflect the roadmap delivery completed on 2026-07-26.

## High value for how the apiary actually runs

### Photo migration + inspection photos on the timeline
**Importer shipped 2026-07-26; production backfill awaits the missing source files.**

The media-only legacy importer now recovers photo metadata and filesystem-only
originals into MinIO, and inspection photos render inline in the hive history.
The expected TrueNAS source directory was empty during release verification,
so the production photo backfill can run only after those originals are
located or restored from another backup.

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

## From harvest to sale

### Harvest lots, jar runs, and customer-facing QR honey stories
**Shipped 2026-07-26.**

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
Connect lineage to outcomes: brood pattern ratings, temperament, survival,
and honey yield rolled up per queen and per mother line, displayed on the
genealogy tree.

## Field usability

### True offline mode
The legacy offline queue was dead code and was dropped in the rewrite. The
PWA + Go API is a clean foundation for a real one: queue mutations in
IndexedDB, replay on reconnect with conflict detection.

### NFC / QR tags on hives
Scan a tag at the hive to jump straight to its page or start a recording.
The canvas already knows physical positions.

### Weather integration
Apiaries have lat/lng. Auto-attach conditions to inspections; warn about
upcoming cold snaps when feeders are light.

## Longer arc

### Bloom calendar intelligence
Bloom observations are being recorded; correlate them with harvest timing
across years to predict flow starts.

### MCP server for the Go API
The legacy app exposed one. Re-adding it lets an AI assistant answer
questions like "which hives haven't been inspected since the flow started?"
from any MCP client.

### Multi-user support
`user_settings` is single-row by design. If anyone else ever helps with the
bees, per-user identities over shared data is the one structural change to
plan for.
