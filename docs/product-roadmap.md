# Beez Trackz — Product Roadmap

What is next, and in what order. Delivered work moved to
[`product-history.md`](./product-history.md) on 2026-08-13 so this document shows
only open items; check there before assuming something is unbuilt.

Sources for the open items below:

- `docs/plans/2026-08-12-adversarial-ui-backend-review.md` — three independent
  read-only reviewers (navigation/layout, Go backend internals, frontend↔backend
  seam) against `b234d82`, scoped by the standing complaint that navigation and
  layout still feel clunky. IDs prefixed `UX-`, `API-`, `SEAM-`.
- `asi-review.md` (commit e9fd757) — full-stack review, mostly delivered. IDs
  prefixed `ASI-`.
- `docs/plans/2026-08-03-ux-and-inventory-adversarial-review.md` — delivered.
- Requested 2026-08-17 — source-retained media, modeled on cairn. Originals
  stay the restoration boundary; transcripts and photos can be reprocessed.
  Refined 2026-08-18: photo originals are pluggable like cairn — Immich
  library link and direct upload, resolved per photo.
- Requested 2026-08-18 — map picker for apiary location, canvas registered
  onto satellite imagery so stands sit on the real ground, and sunrise/sunset
  modeled over those positions. Refined the same day: Leaflet as the map
  substrate (zoom out for context), multiple tile layers, canvas on top;
  store elevation with the pin for sourwood and other flora bands.
- Requested 2026-08-18 — field, flow, health, queen, honey-product, and
  operations features (swarm/split readiness, treatment lockout, comb age,
  catch boxes, colony intake, elevation-banded flora, forage radius, scale
  hives, frost, photo time-series, strength score, incident log, deadout
  autopsy, mating-yard map, grafting cycle, lot moisture, floral-source
  claim, pollination contracts, ntfy, Saturday yard queue, labor minutes,
  compliance packet). Plus a long-term extractor controller that posts
  cycle/time/speed telemetry into harvest sessions. Same day: Immich
  search for flower and beehive photos near the apiary pin, auto-built
  into a yard timeline.
- Requested 2026-08-18 — other hive products: creamed honey, hot honey,
  mead, propolis harvest and tincture (and later propolis for sale).
  Extends the sale-table restructure; do not design `kind` as only
  jar/colony/equipment.
- Requested 2026-08-19 — units: display metric or US across the app from
  one preference; store canonical, convert at the edge.
- Requested 2026-08-19 — inventory at more than one location. Finished
  goods consigned to the local bike shop, which pays as sales happen, not
  up front. Stock locations, transfers, consignment sales, settlement.

## Order of work

The 2026-08-12 review P0/P1 fix list shipped 2026-08-17 (see
[`product-history.md`](./product-history.md)). SEAM-001 and SEAM-004 are no
longer blockers. Remaining product work, in this order:

1–5 (colony/equipment sales + other hive products, source-retained
media + Immich, yard map + sun, varroa program, lockout/moisture/yard
queue) **shipped 2026-08-18** — see [`product-history.md`](./product-history.md)
"Delivered 2026-08-18". Their remaining gaps are listed under
"Shipped 2026-08-18 — remaining gaps" below. Next:

6. **Inventory at more than one location** — consignment stock at the
   bike shop, pay-as-sold; transfers and settlement on the existing
   ledger. Needed before GnuCash mappings are finalized.
7. **Live GnuCash sync**, then **Zebra labels**.
8. **The rest of the 2026-08-18 wave** — field objects (catch boxes,
   intake, comb age, swarm readiness), place/flow (elevation-banded
   flora, forage radius, scale hives, frost), health (photo time-series,
   strength, incidents, deadout autopsy), queen breeding, floral claim,
   pollination, ntfy, labor, compliance packet. Plus **units** (metric or
   US display across the app, one per-user preference).
9. **Extractor controller** — long-term; hardware plus an ingest
   contract onto harvest sessions. Design the session payload when
   extraction IDs stabilize; do not wait to start the controller.
10. P2 structural/a11y items and leftover ASI lows.

## Shipped 2026-08-17 — review P0/P1 fixes

Moved to history: SEAM-001…018, UX-001…017, API-001…011, and the varroa
sticky-board chart bug. Do not re-open those IDs without a new failing test.

## P1 — Inventory at more than one location (consignment at the bike shop)

**Requested 2026-08-19.** Finished goods are about to live in more than
one place. Jars (and later creamed/hot honey, propolis, mead) go to the
local bike shop, which sells them on the operator's behalf. The shop
does not buy the stock up front; it pays as sales happen. Today the
ledger has one implicit location — everything bottled is "on hand" —
and the only way to record the shop is a `consignment` channel on a
sale, which is the *sale*, not the stock sitting on their shelf.

What is wrong without this:

- Handing 24 jars to the shop is not a sale (no money changed hands)
  and not shrink. Recording it as a sale invents revenue and a
  receivable that does not exist yet; not recording it means the
  jars still count as on hand for market day and the stock-validation
  guard lets you oversell them.
- When the shop says "we sold 9 this month, here is $X," there is no
  object that says 15 are still on their shelf, 9 moved to sold, and
  the 9 became a receivable that the payment settles.
- Returns (unsold jars coming back, a broken one) have no path back to
  home stock that preserves lot ancestry.

Shape — extend the existing spine, do not add a second ledger:

1. **Stock locations.** A small table: `home` (default, seeded for
   all existing stock) plus named locations, each optionally linked
   to a `customers` row (the shop is already a customer). Every
   finished-goods quantity is per location. Bulk honey and equipment
   stay single-location for now; finished SKUs (jar sizes and
   `product_catalog` items) are what travel.
2. **Transfer movement.** A new movement kind that moves quantity
   between locations without touching revenue, COGS, or pounds
   bottled. Carries the lot/batch so Honey Story and "where did this
   honey go" still answer. Reverse transfer is the return path.
3. **Consignment terms on the location.** `consignment` flag, commission
   or wholesale price basis (flat % or the existing wholesale price
   list), and settlement cadence. Stock at a consignment location is
   still the operator's inventory (it is not sold); it is simply
   not available to sell at home.
4. **Consignment sale = existing sale, location-scoped.** When the
   shop reports sales, record a sale with `channel = consignment`,
   the shop as customer, the location as stock source. Lines decrement
   the shop's location, not home. Revenue is recognized at that
   report; money is a receivable until the shop pays. Reuse the
   collected-vs-invoiced fields that already exist rather than a
   new payment table. One sale per shop report is fine; per-item
   granularity comes from the shop's statement.
5. **Settlement.** A statement per location per period: opening
   stock, transferred in, sold (per SKU, price basis, commission),
   returned, closing stock, amount owed, amount paid. Reconciles the
   shop's count against ours; the difference is shrink at that
   location, recorded as an adjustment there, not at home.
6. **Surfaces.** Honey/Sales inventory shows on-hand by location and
   a total; market day sells only from `home` (or a chosen location);
   a "Bike shop" page lists stock on shelf, unsettled sales, and a
   "record their report" action that takes counts-or-sold and
   payment together.
7. **GnuCash mapping.** Consigned stock stays on the inventory
   account until the report; the report posts revenue + COGS + AR;
   payment clears AR. Design the location dimension into the
   entity mappings with the GnuCash item below so consignment does
   not become a third mapping later.

Rules: never recognize revenue on a transfer; never let home
stock-validation count consigned jars; every transfer, sale, return,
and shrink at a location is an idempotent, reversible movement on the
existing ledger. Equipment consignment (selling used boxes through the
shop) is out of scope until it actually happens — but the location
table should not be jar-only in name.

## Shipped 2026-08-18 — remaining gaps

Reviewed 2026-08-19 (six independent read-only reviewers over
52ac317..28046bf, then fixes landed the same day — see history). What
the review left open, by feature:

- **Sales / products.** No undo/cancel for a product batch (a wrong
  40 lb mead batch permanently consumes bulk honey). Colony revenue is not paired against `bees_queens`; equipment lines
  have no cost basis / COGS. `external_sync` entity types and per-kind
  account mappings for colony/equipment/product lines were not
  designed (do with GnuCash). Hot-honey batch expenses are stored but
  not reported. (Propolis `net_grams` and deferred physical effects for
  draft/pending sales landed 2026-08-19, migration 00022.)
- **Lockout / moisture / yard queue.** Migration 00022 seeds Apivar 14,
  CheckMite+ 14, ApiLife Var 30 days; verify the rest against labels in
  Settings > Treatment withdrawals. Sale lockout only bites when the sale names a lot; jar lines are not
  traced to lots and bottling from a locked lot is not refused.
  Moisture is a hard reject above threshold with no override tier.
  Transcript re-parse can change a treatment's product without
  re-resolving withdrawal days. Inspection PATCH of `treatments` jsonb
  does not touch `treatment_events`. Yard queue has no endpoint test.
- **Varroa.** Inspection form edits only the first mite count; a
  multi-method inspection cannot be fully edited. Trend chart still
  evenly spaced; board/visual not charted. No soft delete/audit on
  `mite_counts`. Efficacy "after" count does not match method.
  Standalone same-day counts now upsert (unique index) — a second
  sticky board on the same day silently overwrites the first.
- **Media / Immich.** The re-parse "diff" UI shows only accept
  checkboxes, not current vs proposed values. No photo reprocess UI;
  no UI to pick which transcript version to parse. Worker Force
  re-transcribe can race a retry of the original task (two versions).
  Transcription delete is check-then-delete outside a tx (FK makes it
  a 500, not data loss). Dev `docker-compose.yml` lacks the Immich vars.
- **Yard map / sun.** `CanvasRegistration` offset/rotation/scale is
  vestigial (identity once any stand has GPS) — remove it and the
  `satelliteImageKey` column. No UI surfaces hive lat/lng. Sun uses
  the device timezone, not the apiary's. Tiles are cross-origin so the
  map is blank offline, and the stand layer is hidden until geo loads.
  Browser `coords.altitude` is ellipsoidal, stored as if MSL. Esri
  legacy tile endpoint ToS is grey.
- **Auth.** `loadDotEnv` runs in the production server (harmless with
  cwd `/`, but scope it to `cmd/set-password`).

## P1 — Live GnuCash sync and reconciliation

**Foundations delivered 2026-08-04** (integer cents, audit fields, reversals and
soft deletes, a unified bulk formula, stock validation, collected-vs-invoiced
revenue fields, honey/commerce idempotency, and the `external_sync` mapping
table). What remains:

Complete per-record `external_id`/sync-state mappings — entity, external
account/category/tax mapping, last-synced, conflict state — and add the live
GnuCash sync and reconciliation workflow. Honey and commerce mutations are
idempotent; remaining idempotency work is limited to equipment mutations, and
equipment entity mappings are still missing. Keep categories, channels, and tax
data mappable for external accounting, with COGS and inventory values traceable
to the linked physical ledger.

Design for bidirectional syncing with **gnucash-web** across the product
ecosystem. Records need stable external IDs and idempotent sync behavior;
explicit account, category, and tax mappings; and traceability from inventory
movement through COGS, revenue, payment, refund, and adjustment. Surface
reconciliation status and conflicts, retain a complete audit trail, and never
silently overwrite quantity or value when either system changes it. The eventual
sync must preserve the physical honey/equipment ledger and its financial entries
as linked, reviewable records rather than treating either side as disposable.
Beez Trackz remains authoritative for physical honey and equipment quantities;
gnucash-web remains authoritative for posted accounting entries. Sync must not
infer or overwrite physical stock solely from accounting data.

**Coupled to colony and equipment sales** (above). Those sales introduce line
kinds that do not map to honey's revenue-with-COGS shape, and selling equipment is
itself an equipment mutation — so the entity mappings and mutation idempotency
should be built once to cover both rather than twice.

## P1 — Zebra label printing and physical traceability

**Planned; distinct from the delivered generic browser-print support.** Hive
labels already print through the browser using MUNBYN 2x1-inch and 3x2-inch
profiles with an authenticated internal QR. Honey lots already support public
Honey Story QRs, lot metadata, bottling runs, and optional per-jar serials, but
have no label-print action.

**First milestone (requested 2026-08-04): serialized jar-label batches.** Print a
sequence of jar labels on the Zebra where the print action mints the serials — one
freshly generated serial per label, tied to the bottling run (runs already
serialized print their existing serials instead of minting twice). Requirements,
inheriting this section's service rules: the API owns the ZPL and the job (printer
host/port configured in Settings with a test/calibration print; port 9100 kept
LAN-only); each job records per-label state, and a connection lost after bytes may
have been sent marks the affected labels **unknown** — never auto-resent, cleared
only by operator inspection and an explicit per-label reprint with a reason, which
lands in the serial's audit history. Labels carry the public curated Honey Story
QR plus the human-readable serial (optionally barcoded); nothing internal or
authenticated goes on a customer-facing jar. Entry point: a "Print serial labels"
action on the bottling run.

Validate the exact Zebra ZD420 **ZD42H42-C01E00EZ** before one-click work. It is a
4-inch-class, 203-dpi ZD420c-HC healthcare ribbon-cartridge desktop printer
supporting thermal transfer and direct thermal; this SKU provides USB, USB
Host/USB-A, Bluetooth, and Ethernet. Zebra family specifications list ZPL II, a
4.09-inch maximum print width, and media up to 4.65 inches; other family
connectivity options should not be assumed for this SKU. The model was replaced by
the ZD421c-HC.

Build the label layer for any self-hosted installation, not around fixed Beez
branding. Each installation owns a reusable asset library for admin-uploaded
logos, artwork, backgrounds, and approved fonts in common raster/vector formats.
Validate type and size, and sanitize or rasterize SVG before use. Keep branding
and versioned templates separate from hive/lot data so each operator can design
labels and historical reprints retain their original look.

1. **Native ZD420 hive labels.** Exact-size template, preview, copies, and
   alignment/calibration so authenticated hive QRs scan reliably.
2. **Bottling-run honey labels.** Batch lot and jar labels, including circular
   stock, with the public curated Honey Story QR; preview, lot, copies, and
   printed QR must agree.
3. **Serialized jar traceability.** Preserve each jar identity through print,
   explicit reprint, reason, and audit history.
4. **Harvest/extraction container labels.** Once process IDs are stable, keep
   containers tied to the correct authenticated internal record.
5. **Market, wholesale-order, and tote labels.** Once order states are stable,
   reduce fulfillment mix-ups with authenticated internal identifiers.
6. **Apiary and stand identifiers.** Once naming is final, durable internal
   wayfinding that works with the existing scan flow.
7. **Equipment and bin labels.** After stable asset IDs exist, with label history
   tied to IDs rather than free-form names.

Shared prerequisites are validated media/hardware, centralized templates and
DPI/media settings, and a shared print service before any one-click ZPL phase.
Templates support configurable physical diameter/shape, 203-dpi-safe layout,
print/export, and a constrained editor for assets, apiary name, text, colors,
borders, lot fields, and QR placement. A live round preview flags QR quiet-zone or
size failures and edge clipping; calibration and paper/test print come before
label stock. Starter presets may later be derived from user-provided MUNBYN Editor
samples, without making that editor a runtime dependency.

The service owns ZPL and tracks jobs, history, and copies; clients never submit
arbitrary ZPL. Only job creation and deduplication are idempotent. Raw TCP/9100
delivery is not: if a connection is lost after bytes may have been sent, mark
every label type unknown, never auto-resend, and require the operator to inspect
output and explicitly reprint. Keep port 9100 LAN-only. If Ethernet is unusable,
use an operator workstation or dedicated local USB print bridge without assuming
TrueNAS container USB passthrough. Browser/system-driver printing remains the
durable fallback. Only curated Honey Story content is public; hive, order,
container, apiary/stand, and equipment identifiers remain authenticated and
internal.

## P1 — Field work that still has no object

**Added 2026-08-18.** Inspections, feedings, treatments, and hive status
exist. These are the Saturday-morning objects that are still notes.

- **Swarm and split readiness.** Derive a per-hive call from what is
  already recorded: crowded brood, queen cups / cells, stores, a flow
  on, days since last split, temperament. One list: will swarm / ready
  to split / neither. Not a new inspection form. Voice already extracts
  queen events; this is a rule on top, same shape as `checkInspectionDue`.
- **Treatment vs harvest lockout.** Every treatment product has a
  withdrawal. Harvest sessions and market day must refuse a lot whose
  source hives are still inside that window. Date-on, date-off, and
  "this honey cannot be extracted / sold until" on the lot and the
  hive. Legal and money, not a reminder card. Couples to the varroa
  `date_removed` gap and to harvest-session create.
- **Comb age / box rotation.** Equipment already moves through the
  ledger. Frames and boxes do not age. Record year-in-service (or
  first-deployed) on the stock row; surface "this deep is five years
  old, pull it." AFB-risk comb and sagging boxes are the reason.
- **Catch boxes and lost swarms.** A swarm leaving is a queen/hive
  event today. There is no bait-hive object: yard, stand or fence
  line, date set, empty-as-of, occupied. Seasonal, easy to forget,
  cheap to model. Occupied becomes colony intake (below).
- **Package / nuc / split intake.** A new colony arrives with source,
  date, starting stores, and cost. Today that is hive-create plus
  notes. First-class intake writes the hive, the `bees_queens`
  expense, and the queen-line / winter-survival cohort in one
  transaction. Splits you already record; packages and bought nucs
  you do not.

## P1 — Place and flow

**Added 2026-08-18.** Sits on the yard-map item (Leaflet, elevation,
registered canvas). Do not start these before the pin and
`elevation_m` exist.

- **Elevation-banded flora.** Bloom observations exist; they are not
  tied to height. Sourwood (and other flora) tracks elevation bands.
  Per-yard flow calendar: species × elevation band × last year's
  first/last seen. "Will this yard make sourwood this year" is the
  question. No sourwood-only model — the band is a filter on bloom.
  The Immich yard timeline below is evidence for that calendar, not
  a replacement for structured bloom rows.
- **Forage radius on the map.** A 2–3 km circle around the apiary
  pin, on Leaflet, so tree line / crop / water from the tile layer
  is visible. Explains two yards 400 m of elevation apart. Not a
  land-cover classifier. This circle is also the search radius for
  the Immich timeline.
- **Yard flora / hive timeline from Immich.** Use Immich's own
  search — do not re-implement CLIP. Smart search for flower /
  bloom / blossom / hive / beehive / bees, intersected with
  metadata search near the apiary pin (EXIF GPS inside the forage
  radius, or Immich's `near` / map-bounds filter if the version
  we run exposes it). Order by `DateTimeOriginal`. The result is
  a year-scrubbable timeline on the apiary: first dandelion, first
  sourwood, hive-front shots through the season.
  Adopt matches as `original_external` photo rows on the apiary
  (same link-not-copy rule). **Surface ambiguity, do not guess:**
  a photo 1.5 km from two yards, or a houseplant "flower" indoors,
  is offered for review, not silently attached. No EXIF GPS → not
  in the location set; it can still appear in a smart-search-only
  tray the operator attaches by hand.
  A scan is a job (`POST /apiaries/{id}/photos/scan`),
  restart-safe, same as cairn's ride-window Immich scan. No
  unbounded walk of the whole library. Re-running the scan is
  how a better Immich model or a moved pin updates the timeline.
  Immich down → the timeline still renders already-adopted
  thumbs; the scan fails loudly.
- **Scale hives.** Daily weight is the best flow and death detector.
  One scale per yard is enough. Ingest Broodminder / HiveTracks-style
  CSV or MQTT. Overlay on inspections and bloom. Do not require a
  scale on every hive.
- **Frost and night lows at the pin.** Weather is already
  location-aware. Surface "this stand frosted three nights last
  week" next to elevation. Matters for sourwood and for winter.
  No new provider if the existing snapshot already has min temp.

## P1 — Colony health beyond mite counts

**Added 2026-08-18.** Varroa stays its own item. This is everything
else a deadout or a weak nuc should have taught us.

- **Photo time-series.** Same hive, same angle, April vs June vs
  August. Immich + `taken_date` + owner makes the strip cheap —
  build it on the source-retained / Immich work, not before.
  Disease/stores/queen-cell analysis (the unused `imageAnalysis`
  task) runs on the original and can be reprocessed. A gallery
  sorted by upload time is not this. Distinct from the **yard
  flora/hive timeline** (Place and flow), which is Immich search
  near the pin, not "this hive's front, year over year."
- **Standard strength score.** Frames of bees / brood / stores as
  numbers you can chart, not only 1–5 stores on the inspection.
  Winters and splits become comparable across years. Voice parser
  should fill these when the walkthrough says "eight frames of bees."
- **Incident log.** Robbing, yellowjackets, bears, skunks, flood.
  Date, hive or yard, notes. Timeline and "don't put a weak nuc
  here." Not a status enum on the hive — a hive can be robbed and
  still active.
- **Deadout autopsy.** Marking deadout today is mostly a status.
  Require (or strongly prompt): stores left, cluster position, last
  fall mite load, queen status, moisture / mold. Winter-survival
  reports should segment on these rows. A deadout without an
  autopsy is a status change you cannot learn from.

## P1 — Queen breeding

**Added 2026-08-18.** Queen performance scoring exists. Mating place
and raising cycle do not.

- **Mating-yard / drone-source map.** Where she mated, which yards
  were flooding drones. One extra field plus the Leaflet pin turns
  queen scores into a place story. Couples to the yard-map item.
- **Grafting / cell-builder cycle.** Graft date, emerge, introduce,
  accept. Links to the queen row you already have. Skip if you
  never graft; build when the first graft is recorded as a note
  for the third time.

## P1 — Honey as a declared product

**Added 2026-08-18.** Lots, bottling, Honey Story, and market day
exist. The claim on the jar and the number that decides if it
bottles do not.

- **Floral source as a claim.** "Sourwood 2026, Yard B, 2100 ft."
  Lot, label, and Honey Story share one declared source. Elevation
  + bloom window is how you defend it. Not a free-text note on the
  lot that the story page ignores.
- **Pollination contracts.** Drop, pickup, colony count, payment.
  Distinct from honey sales. Maps to GnuCash as service revenue,
  not COGS — design against the GnuCash item, do not fork a
  third sales system. Skip until a contract is actually signed.

## P1 — Operations around the week

**Added 2026-08-18.** Recommendations exist and live in the app.
Field work wants a list and a push.

- **ntfy / phone push.** Mite check due, feeder empty, treatment
  off-date, "flow started at Yard B." Same events as the yard
  queue. Optional webhook; no email-only path.
- **Labor minutes.** Optional start/stop on the yard visit. Turns
  cost-per-pound from feed+jars into feed+jars+Saturday. Off by
  default; do not guilt a hobbyist.
- **State inspection / compliance packet.** One export: hive list,
  treatments, lots, sales, withdrawal windows. The day the
  inspector or the market manager asks. Authenticated, not public.

## P1 — Units: metric or US across the app

**Requested 2026-08-19.** Every quantity is entered and shown in whatever
unit its table happened to be written in: honey in `lbs`, feedings in
`lbs/oz/quarts/gallons`, propolis in `grams/ounces`, moisture in `%`,
elevation in `m` (the pin) but flora bands described in feet, weather in
whatever Open-Meteo returned, lot weight free-typed. A single display
preference should make the whole app read metric or US.

- **Store canonical, display converted.** Keep one storage unit per
  quantity kind (mass → grams or kg internally is fine; honey already
  has integer-cents discipline — do the same for mass: store in one
  unit, never two columns). Do not migrate existing columns to new
  units; add the conversion layer first and migrate only where a
  column is currently ambiguous (`propolis_unit`, free-text lot weight).
- **One preference, per user.** `Settings > Preferences`: `units:
  metric | us` (and optionally temperature separately). Default from
  the browser locale. API responses stay canonical; the frontend
  formats. Voice/AI extraction must normalize "two kilos of syrup" into
  the canonical unit with the spoken unit preserved in the transcript.
- **Inputs accept either.** Forms show the preferred unit, accept a
  typed unit suffix ("2 kg", "4.4 lb"), and submit canonical.
  Thresholds (moisture, mite action levels) are unit-free or
  converted at display, never stored twice.
- **Labels and public pages.** Honey Story and labels follow the
  *operator's* preference, not the viewer's; print both where law or
  the market requires (e.g. "1 lb (454 g)").
- Scope first pass: honey mass, feedings, propolis, elevation,
  temperature/weather, lot weight. Hive body dimensions and frames are
  already unit-free counts.

## P2 — Extractor controller (long-term, hardware)

**Added 2026-08-18.** A controller on the extractor — cycles, times,
speeds — that posts a run into Beez Trackz. Hardware is in-house
and will take a while. Software should be ready to receive the
payload when the first board can HTTP.

Harvest sessions already exist (apiary, date, calculated vs actual
extraction weight, per-hive harvest entries, true-up). The
controller does not replace the session; it **attaches a machine
log** to one.

Ingest contract, so the firmware and this app do not invent two
shapes:

- One extractor run → one session (or one child of a session if
  you spin the same yard twice in a day). Idempotent on a
  controller-issued `run_id`.
- Payload: started/ended, program name, per-cycle
  `{rpm, seconds, direction?}`, faults, optional load-cell
  weight if the machine has one. Store raw JSON as the source
  (cairn rule: the controller log is reprocessable) plus the
  columns the session UI actually charts.
- Auth: a personal API token (`bt_…`) from Settings, same as
  MCP. LAN-only is fine; do not put the extractor on the public
  internet.
- Offline: the honeyhouse may have worse wifi than the yard.
  The controller keeps the last N runs and retries. Same
  idempotency receipts the PWA uses, or a simpler
  `PUT /harvest-sessions/{id}/extractor-runs/{runId}`.

UI: on the session, a speed/time chart and "this honey saw 8
minutes at 250 rpm." That is the number that explains shattered
comb vs wet cappings next year. Do not block session create on
the controller being present — hand-entered weight stays valid.

Do not start firmware work in this repo. When the board can POST
JSON, this item is an ingest + chart, not a microcontroller
project. Zebra "harvest/extraction container labels" waits on
stable process IDs; those IDs are these runs.

## P2 — Structural: make drifted list pairs one artifact

**Added 2026-08-13**, promoted from the 2026-08-12 review's prose diagnosis.
This is the item that prevents the next round of these findings.

The recurring shape behind SEAM-004, SEAM-005, SEAM-007, UX-005, and UX-011 is a
documented contract and an implementation that drifted with nothing testing the
seam. `DESIGN.md:27,34` promises safe-area handling implemented in one component;
`DESIGN.md:33` promises scrollable mobile tabs that were deliberately replaced
with a `<Select>`; `README.md:55` promises cached offline reads while every
offline navigation lands on `/offline`; `README.md:57` promises reviewable
conflicts "instead of being overwritten" while the Retry button guarantees the
overwrite; and the backend's offline-supported route list has no counterpart test
on the client that duplicates it.

Fix the pattern rather than each instance: make each pair one artifact with a
test asserting they agree. Concretely — generate or share the offline route list
between `middleware_offline.go` and `sw.js/route.ts` and test the agreement (the
Go side already has `middleware_offline_test.go`; the client side has no test at
all), and either correct `DESIGN.md`/`README.md` or add checks that fail when the
promise stops being true.

Also worth pinning with a test: CSRF currently rests entirely on `SameSite=Lax`
with no Origin check outside MCP, which holds today only because no mutation is a
GET. That invariant should fail loudly if it ever stops being true.

## P2 — Accessibility and correctness papercuts

- **UX-018 (High)** Bulk-selecting hives in table view is impossible with a
  keyboard or screen reader — selection sits on a `<tr>` with no `tabIndex`, and
  the checkbox is controlled with no `onCheckedChange` plus `pointer-events-none`.
  The card branch is correct.
- **UX-019 (Medium)** Color-only status against `DESIGN.md:26` — a 6 px
  `aria-hidden` red-vs-amber urgency dot with no paired text, and queen marking
  year only in a `title`.
- **UX-020 (Medium)** Delete-expense and revoke-API-token fire with no
  confirmation, unlike the nine comparable actions that all confirm.
- **UX-021 (Medium)** Base dialog `max-h-[calc(100dvh-2rem)]` puts submit buttons
  under the home indicator; the longest form is accidentally safe because it
  overrides to `90dvh`.
- **UX-022 (Medium)** Long forms have no sticky submit, so the most frequent write
  in the app requires scrolling the full form one-handed.
- **UX-023 (Medium)** Exiting bulk mode clears the selection, so "archive the
  deadouts but let me check that one" means starting over.
- **Low cluster (UX-025 / SEAM-019…024 / API-012).** `x` collides with the
  documented global select-all; the shortcut registry overwrites silently; `?`
  advertises shortcuts viewers cannot use; Radix dialogs push no history entry so
  Android Back closes the route; duplicate `aria-label="Main navigation"`;
  command-palette results lack listbox roles; unsized `<img>` CLS risk; skeletons
  omit the action row; the apiary canvas has no keyboard path; `AuthStatus` omits
  `isAdmin` (costing a round trip per load); `HoneySale` omits
  `tax`/`updatedAt`/`cancelledAt`; `NEXT_PUBLIC_API_URL` inlines an internal
  hostname into the public bundle; anonymous visitors can create customer records
  (5/min/IP); migrations run uncancelable at startup. The CSRF item moved to the
  structural item above; the honey-story date item is probably stale (see the
  standing correction).

## P2 — Responsive field polish

**Partially delivered 2026-08-04** — touch targets, empty states, and phone
layouts in apiaries, queens, and settings. Remaining gaps: sub-44 px targets,
horizontal navigation strips, and wide tables that do not fit small screens.
Substantially overlaps the "clunky" cluster above; do that first and re-scope
what is left.

## Remaining ASI low-severity findings

Open Lows from `asi-review.md`: SSRF-shaped AI base-URL fetches (ASI-3-007),
MinIO default-credential fallback (ASI-3-008), silent non-Secure cookies on
misconfigured `APP_URL` (ASI-3-009), tag-pinned GitHub Actions (ASI-3-010),
transcription hive-match on empty references (ASI-1-007), cancelled sales keeping
serials "sold" (ASI-1-008), the `jar_serials` ON DELETE/CHECK contradiction
(ASI-1-009), a minor backend correctness cluster (ASI-1-010), offline receipts
unverified against method/path (ASI-5-008), a worker-edge reliability cluster
(ASI-5-009), service-worker cache growth and the 5-second stale-serve (ASI-6-003,
extended by SEAM-009 and SEAM-018), and `reorderUrl` scheme validation
(ASI-3-011).

Deliberately left closed: migrate-legacy per-table transactions (a one-shot
operator tool) and the already-applied 00005 backfill's UTC quirk (a benign NULL
link).

## Smaller deferred items

- **`/harvest` → `/honey` route rename**, deferred from the 2026-08-11 navigation
  work because it collides with the public `/honey/[slug]` story pages.
- **Void-bottling-run action.** ASI-1-002 was closed by refusing reversal of a
  run-linked movement with a 409; voiding the run in the same transaction remains
  unbuilt.
- **Equipment naming clarity.** The equipment ledger is otherwise complete; only
  naming **Equipment Inventory** distinctly from **Honey Inventory** remains.
- **Lot weight is free-typed** against linked harvests rather than derived.
  Lot **moisture** is the sibling number and lives in the honey-product
  item below, not here.

## Verified clean — do not re-litigate

From the 2026-08-12 review: `isNavRouteActive` is correct (the one case where the
indicator lies is UX-008's bad URL); tab and filter state *are* URL-backed and
refresh-safe; Radix focus trapping and restore are sound; reduced motion is
handled correctly; icon-only buttons have accessible names; the public honey story
is a curated projection that leaks no hive/apiary ids, coordinates, inspection,
expense, or customer data, and photo access re-checks `is_public`; no secret is in
`localStorage`; and there is no `dangerouslySetInnerHTML` anywhere.

Added 2026-08-13: the frontend typecheck passes clean and lint reports 0 errors
(16 React Compiler warnings about `react-hook-form`'s `watch()`), contrary to
UX-024.
