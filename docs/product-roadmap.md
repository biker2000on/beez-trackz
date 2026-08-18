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

## Order of work

The 2026-08-12 review P0/P1 fix list shipped 2026-08-17 (see
[`product-history.md`](./product-history.md)). SEAM-001 and SEAM-004 are no
longer blockers. Remaining product work, in this order:

1. **Colony and equipment sales**, designed so **other hive products**
   (creamed honey, hot honey, mead, propolis/tincture) are more line
   kinds on the same sale, not a third commerce system. The spring 2026
   hive+equipment sale still cannot be recorded. Market-day errors and
   offline queue now exist, so new line kinds will not fail silently.
2. **Source-retained media** — keep original audio/photos and reprocess when
   algorithms improve. Photo originals are pluggable: Immich link and
   direct upload, same as cairn.
3. **Yard map and sun model** — Leaflet under the canvas, multiple tile
   layers, zoom out for context; store elevation with the pin; register
   stands to the ground; model sunrise/sunset over those positions.
4. **Varroa program** (remaining gaps — the sticky-board rate chart is fixed).
5. **High-leverage ops on existing spines** — treatment/harvest lockout,
   lot moisture, Saturday yard work queue. These refuse bad honey and
   tell you what to do this weekend; they do not need new maps or hardware.
6. **Live GnuCash sync**, then **Zebra labels**.
7. **The rest of the 2026-08-18 wave** — field objects (catch boxes,
   intake, comb age, swarm readiness), place/flow (elevation-banded
   flora, forage radius, scale hives, frost), health (photo time-series,
   strength, incidents, deadout autopsy), queen breeding, floral claim,
   pollination, ntfy, labor, compliance packet.
8. **Extractor controller** — long-term; hardware plus an ingest
   contract onto harvest sessions. Design the session payload when
   extraction IDs stabilize; do not wait to start the controller.
9. P2 structural/a11y items and leftover ASI lows.

## Shipped 2026-08-17 — review P0/P1 fixes

Moved to history: SEAM-001…018, UX-001…017, API-001…011, and the varroa
sticky-board chart bug. Do not re-open those IDs without a new failing test.

## P1 — Yard map, georeferenced canvas, and sun

**Planned (requested 2026-08-18; Leaflet/layers same day; elevation
same day).** Set an apiary's location by pointing at a map, then lay the
yard canvas on real imagery so each stand sits on the ground it occupies.
Store **elevation** with that pin — sourwood and other flora track
elevation bands as much as lat/lng. Once the hives have coordinates and
headings, model sunrise and sunset over them — which colonies get first
light, which sit in a tree's shadow at 4pm in February.

**The map is Leaflet. The canvas sits on top of it.** Today's satellite
path cannot zoom out for context: `SATELLITE_ZOOM` is hardcoded to 19 and
`buildTileMosaic` fetches a 3×3 Esri patch (`radius: 1`) into Konva world
pixels. Pinching the stage only enlarges those nine tiles; there is no
lower zoom, no neighboring countryside, no streets for orientation. Do not
grow that mosaic. Replace it with a real map that already does tiles,
zoom, and layers, and keep Konva for stands/hives/sun only.

Pieces that stay:

- `apiaries.latitude` / `longitude` for weather and bloom. There is no
  elevation column. The form is two decimal fields plus "use my device
  location", which writes lat/lng only and ignores
  `GeolocationCoordinates.altitude`. There is no map.
- Hive facing (compass + 0–359°) and the north arrow. That is the heading
  the sun model needs.
- The README privacy note: whoever serves tiles sees the coordinates.
  Leaflet does not change that; each layer's host does. Keep the note, and
  name the active layer.

What to build:

1. **Leaflet under the yard, and as the location picker.** Same library
   both places. The apiary form (and a "set location" action on the yard)
   is a Leaflet pin: click or drag; typed lat/lng stay the values the pin
   writes; device location is a one-tap seed. No location means no map
   under the canvas and no sun — do not invent a coordinate.
2. **Elevation with the pin.** Add `apiaries.elevation_m` (meters above
   sea level, nullable). This is ground height, not solar altitude.
   Fill it when the pin is set, in this order:
   - browser geolocation `coords.altitude` when present (often missing
     or ± tens of meters on a phone — keep it, label the source)
   - a terrain lookup from the pin (Open-Meteo elevation or a DEM tile;
     same "who sees the coordinate" rule as imagery)
   - operator override, always, because a ridge yard and the valley
     road 200 m away are not the same flow
   Show elevation on the apiary and use it anywhere bloom/flora is
   sliced — sourwood is the example that motivated this; do not build a
   sourwood-only model. A later "which yards are in the sourwood band"
   view reads this column. Null elevation is allowed; do not invent 0.
3. **Multiple tile layers, switchable.** Not a single Esri overlay.
   Leaflet `L.tileLayer` / layer control. First set:
   - Esri World Imagery (what the canvas already uses)
   - a street/labels layer for context when zoomed out (OSM or Esri
     Streets — pick one, document who sees the coords)
   - the existing imagery kept as the default when registering stands
   Adding a layer later is a URL + attribution + toggle, not a new
   renderer. Opacity still applies to the imagery the stands sit on.
4. **Zoom out for context.** Leaflet owns pan/zoom, including zoom
   levels well below 19 so the operator can see the road, the tree line,
   the neighboring lot. Zooming in still reaches yard scale. The Konva
   stage is a georeferenced overlay (or a Leaflet layer that hosts the
   stage) so stands stay nailed to lat/lng as the map zooms — they do
   not become a 3×3 bitmap that you magnify.
5. **Register the canvas to the map.** Today's overlay is anchored at
   mount to the stand bounding-box center. Moving a stand does not move
   the photo, which is correct, but there is no way to slide, rotate, or
   scale the *layout relative to the ground* so stand A sits on the
   actual pallet. Register/calibrate mode: map locked, operator nudges
   the stand layer (or one ground-control point + north) until the
   drawing matches. Persist offset/rotation/scale in `canvas_layout`.
   Delete `satellite-layer.tsx` / the zoom-19 mosaic once Leaflet is
   underneath; do not leave two tile engines.
6. **Hives have ground positions, not just slots.** After registration,
   each occupied slot has a lat/lng (`facingDegrees` already exists).
   Derive from the registered canvas; do not store a second layout.
7. **Sunrise / sunset over the yard.** Date-scrubbable solar azimuth and
   *solar* altitude on the overlay: sun path, sunrise/sunset bearings,
   simple hive-body shadows (obstacles only if the operator draws them).
   NOAA / SPA-class math, local, from lat/lng/date. Answers "does A3
   see sun before 10am in January", not a full insolation sim. Ground
   elevation is a separate column; do not overload the word.

What this is not:

- Not a second mapping product and not a Google/Mapbox SDK. Leaflet
  plus tile URLs. Konva stays for the yard drawing.
- Not automatic photogrammetry. The operator aligns the drawing; the
  computer does not guess which blob is a hive.
- Not a weather-sun hybrid. Forecast/bloom already use the apiary pin.
  The sun model uses hive positions once they exist; until then, fall
  back to the pin and say so.

Follow-ons that wait on the pin and `elevation_m` are in **Place and
flow** (elevation-banded flora, forage radius, frost). Mating-yard
pins wait on this map too.

Do not wait on colony sales or GnuCash. Independent of the commerce
spine. A yard with no lat/lng still cannot show a map or sun, which is
why the picker is first.

## P1 — Source-retained media (cairn model)

**Planned (requested 2026-08-17).** Voice and photos are how field notes enter
this system. Treat them the way cairn treats FIT/JSON archives: the original
bytes are the source of truth, derived rows are a projection, and a better
algorithm later must be able to rebuild the projection without the walkthrough
having to be recorded again.

Cairn's rule, quoted because it is the whole item: *raw files are the source of
truth; everything in Postgres can be reprocessed from the object store.*
Immutable source objects are the restoration boundary. Beez Trackz already
stores the bytes (`photos.original_key`, `media_files.audio_key`) and already
stores the transcript text next to the audio, then writes inspections with a
`source_media` blob (`mediaFileId`, `hiveReference`, `rawText`). That is the
right shape of the first two layers. What is missing is treating those layers
as a pipeline that can be rerun, rather than a one-shot ingest that happens
to leave files on disk.

The pipeline is three layers. None of them is disposable:

1. **Source.** The original recording (MinIO) and the original photo
   (whichever backend holds it — see below). Never overwritten, never
   regenerated, never deleted as a side effect of transcribing, parsing,
   confirming, or generating thumbnails. Delete of a source is an explicit
   operator action, and it must refuse while derived domain rows still
   point at it — or soft-delete and keep the object until those rows are
   gone.
2. **Derived artifact.** The transcript text (and, later, image-analysis
   output and any new photo variants). Versioned: provider, model, prompt
   revision, and produced-at, so a re-run is a new version, not an in-place
   overwrite. API-011 already notes that a good transcript can be clobbered
   by an asynq retry; that is the opposite of this rule.
3. **Domain rows.** Inspections, feedings, treatments, queen events, mite
   counts — whatever the parser (or a future photo classifier) projects. Each
   row keeps a durable pointer back to the source *and* the artifact version
   that produced it. Reprocessing produces a reviewable diff against the
   current rows; it does not silently rewrite a season of confirmed records.

What "reprocess" means, concretely:

- **Re-transcribe** the same `audio_key` with a new STT model or provider.
  The previous transcript stays; the new one is another version. The
  operator picks which version to parse.
- **Re-parse** a stored transcript (any version) through a new extraction
  prompt or schema. This is the path that gets cheaper and better as the
  parser learns feedings, treatments, mite counts, and queen events more
  reliably. Confirm already writes `source_media`; a re-parse must be able
  to find every row that came from this recording and propose updates
  instead of inserting a second walkthrough.
- **Re-process photos** from the original, whichever backend holds it:
  new thumbnail/medium sizes, better EXIF orientation, and — when image
  analysis is actually wired to a job, which today it is not, despite
  being a configured AI task — disease/stores/queen-cell suggestions
  that can be regenerated the same way a transcript can.

**Photo originals are pluggable, the way cairn just shipped them.**
Today every photo is a MinIO `original_key`. That stays a first-class
path. The other path is the Immich library already running on the same
NAS: link a library asset onto a hive, apiary, or inspection without
copying bytes, or upload new bytes that land in Immich by default when
it is configured.

Copy cairn's constraints, not a new design:

- A `photostore.Backend` (or the same package, if sharing is cheap).
  Two implementations: `minio` (always present, existing bucket) and
  `immich` (optional: `IMMICH_BASE_URL` + `IMMICH_API_KEY`).
  `PHOTO_STORAGE_BACKEND` unset means "decide" — Immich if configured,
  MinIO otherwise. Explicit always wins. Direct upload is not a
  legacy path.
- **Resolved per photo, not globally.** Each `photos` row records
  which backend holds the original (`storage_backend` + opaque
  `original_ref`: MinIO key or Immich asset UUID). Existing rows
  are `minio` forever. Flipping the default must not orphan them.
- Renditions (thumb/medium) stay Beez-owned in MinIO. An Immich
  outage leaves galleries and honey-story thumbs working; only
  "download the original" fails, and only for Immich-held rows.
- **Upload falls back to MinIO** if the default backend is down.
  The row records MinIO. Do not refuse the shot and do not invent
  a durable staging queue.
- **Link is adopt, not copy.** Picking an Immich asset creates a
  photo row with `original_external=true`. Deleting that row
  removes the association and Beez renditions; it never deletes
  the library original. Assets Beez uploaded into Immich delete
  normally.
- Startup never contacts Immich. Malformed config (bad URL, key
  without URL, etc.) fails loud. Unreachable Immich is not a
  boot failure.
- Audio recordings stay MinIO-only. They are not a photo library
  object and must not appear in Immich.

UI: the existing upload control stays. Next to it, "Link from
library" when Immich is configured — a picker over Immich images,
then attach to the current hive/apiary/inspection. Settings
reports default backend, fallback, a health probe, and how many
photos each backend holds. Photo time-series (same hive, same
angle, across months) is in **Colony health**. **Yard flora/hive
timeline** (Immich search by place + "flower"/"beehive") is in
**Place and flow**. Both adopt through this store; neither is a
second gallery.

Public honey-story bytes go through the same serve path as
authenticated ones: resolve the row's backend, then apply
`is_public`. Do not hand an Immich URL to the browser.

What this is not:

- Not a second index. Postgres still owns the photo row, owner,
  caption, tags, taken_date, and public flag. The backend only
  holds original bytes.
- Not a second media product. Same split as cairn: pluggable
  original store, Beez-owned renditions, Postgres as the index
  and the derived state.
- Not automatic overwrite of confirmed inspections. A better parser is
  offered as a review, the way transcription review already sits in front
  of confirm. The source plus the current rows are enough to show the
  diff; the operator accepts, rejects, or edits.
- Not a retention policy that "cleans up" originals after confirm. Confirm
  is a projection, not a handoff. The recording and its transcript remain
  after the inspection exists, which is already true today — lock that in
  as a rule, with a test, so a later cleanup job cannot "helpfully" delete
  the restoration boundary the way receipt cleanup already deletes
  `offline_mutation_receipts` after 30 days.

Prerequisites that already exist and must be kept: `original_key` /
`audio_key` as NOT NULL (relax `original_key` only when introducing
`original_ref` + backend), `transcription_text` on the same row as the
audio, `source_media` on inspections. Work this item must add: artifact
versioning so a retry or a better model cannot overwrite a good
transcript (closes the data-loss half of API-011), a re-transcribe and
re-parse action in the existing review UI, a re-process-image job that
reads the original rather than a derivative, lineage from every
parser-created feeding/treatment/mite-count back to the media file (today
only the inspection carries `source_media`), the per-photo backend
columns and Immich link/upload paths above, and an explicit "source is
not garbage" invariant so deletes and cleanup cannot take the original
out from under a live row.

Do not wait on colony sales, GnuCash, or labels. This is independent of
the review-finding order of work and can land any time after the P0 silent-
loss items, or in parallel with them where the files do not overlap.

## P1 — Varroa program

**Added 2026-08-13.** The 2026-07-26 "Varroa tracking done properly" delivery is
roughly half of what the name implies. Structured storage exists
(`mite_counts`, migration 00002, with a generated `mites_per_100` column), three
entry points work (inspection form, standalone dialog on the hive Health tab,
and voice transcription), and `GET /analytics/varroa` returns counts plus
treatment pairings. What follows is what that delivery did not cover, audited
2026-08-13. The first item is a live correctness bug, not a gap.

- **Sticky-board vs rate chart — shipped 2026-08-17.** Washes/rolls plot as
  mites per 100; board/visual counts are a separate list and are no longer
  drawn on the rate axis.
- **Board exposure duration is not recorded**, which is why boards cannot be
  normalized. A sticky-board count is only meaningful as a mites-per-day drop
  rate; without days-on-board the raw number means nothing. This is the schema
  change the item above depends on.
- **No threshold or action level anywhere.** The recommendations engine has five
  rules and none reads `mite_counts`. There is no economic-threshold constant, no
  seasonal variation, no "treat now" alert, and the panel does not visually
  distinguish 0.3 from 9.0. This is the largest gap: the app records the number
  that decides the colony's survival and never acts on it.
- **No sampling reminder.** Nothing computes days since last mite count, so
  there is no `mite_check_due` rule and no sampling-coverage view. Compare
  `checkInspectionDue`, which does exactly this for inspections.
- **Counts cannot be corrected.** There is no update endpoint and no edit or
  delete control in the UI. Reading an inspection does not return its mite data
  and updating one never touches `mite_counts`, so the inspection form guards on
  `!isEdit` — a typo'd count recorded during an inspection is unfixable. The
  `ON CONFLICT (inspection_id, method)` upsert also never fires for standalone
  counts, because NULL never conflicts in a Postgres unique index.
- **No apiary-wide view.** `GET /analytics/varroa` requires a single `hiveId`, so
  "which of my hives are over threshold" cannot be answered without N requests.
- **Efficacy pairing is unbounded in time and untested.** `before` is the last
  count at any time before the treatment (possibly six months prior), `after` is
  the first count at any time after (possibly the next day, or a year later, or
  after a subsequent treatment). There is no window bound, no minimum interval, no
  check that the "after" count precedes the next treatment, and no use of
  `date_removed` — so sequential or overlapping treatments double-count. Rows
  with NULL `mites_per_100` are excluded entirely, so a board-only beekeeper sees
  "Needs before/after counts" forever. This SQL is the subtlest logic in the
  feature and has no test.
- **The overlay is not an overlay** and the trend chart is not a chart. Efficacy
  renders as cards below a hand-rolled div-height bar row with no time axis (bars
  are evenly spaced regardless of date gaps), no method distinction, no threshold
  line, and no range control. A season of weekly sampling renders as unreadable
  slivers.
- **Mite load appears in no report.** Overwintering survival analytics segment by
  apiary, stand, and queen line but not by mite load — the single most predictive
  variable for winter loss. Queen performance ignores it too, despite hygienic
  behavior being a queen-line trait, and there is no treatment-cost-versus-
  reduction analysis.
- **Method coverage is incomplete.** No CO₂ injector and no drone-brood
  uncapping; `visual` is a catch-all with no defined semantics. No `sampled_from`
  (brood frame vs honey super), no sampler identity, and no recovery-efficiency
  qualifier distinguishing sugar roll from alcohol wash.
- **Smaller gaps.** The MCP surface exposes `record_inspection` and
  `record_feeding` but no `record_mite_count` and no varroa analytics tool;
  `mite_counts` has no `updated_at`, soft delete, or audit trail; the varroa
  endpoints have no test coverage; and the hive overview advertises "Varroa
  trends" as a link while surfacing no mite number itself.

## P1 — Colony and equipment sales

**Planned (requested 2026-08-12).** Two hives with bees were sold in spring 2026,
along with the boxes and frames that went with them. None of that transaction can
be recorded today.

**Prerequisites, shipped 2026-08-17:** SEAM-001 (market day reports sale
errors) and SEAM-004 (market day can queue offline). This item is unblocked.

**The nav decision below needs revisiting.** It concluded that moving Sales to
top-level is affordable because "the mobile bar already resolves overflow through
More" — UX-013 and UX-002 were the cited problems and both shipped 2026-08-17
(`--bottom-nav-h`, 44 px More targets). Re-decide against the current nav, not
the pre-fix one.

The sale model is structurally honey-only: `honey_sale_items.jar_size_id` is
`NOT NULL`, so a sale line can only ever be a jar size. `hives.status` already
has a `sold` value, but marking a hive sold records no buyer, no price, and no
link to a transaction — the colony simply stops counting as active. Equipment
leaves storage only through `discarded`/`gifted`/`other` adjustments, which carry
no proceeds and no `sold` disposition, even though stock rows already store a unit
cost that would serve as cost basis. And because every revenue figure reads
`honey_sales`, a colony sale is invisible in profitability, apiary economics, and
break-even — while the expense side already has a `bees_queens` category. The
operation can record buying bees but not selling them, so margins are understated
by exactly the amount sold.

Record one sale that mixes what was actually sold: colonies (specific hives),
equipment (from stock rows), and honey, as a single transaction with one
customer, one payment, and one receipt. This extends the existing commerce spine —
customers, channels, payment method, order status, receipts, unpaid balances,
wholesale price lists, offline idempotency — and must not fork a parallel sales
system.

Requirements:

- **Restructure the sale tables properly rather than bolting on.** This is a
  single self-hosted instance with no external install base, so the migration is
  free to be breaking: rename `honey_sales` → `sales` and `honey_sale_items` →
  `sale_items`, and give the line a real `kind` discriminator. The first
  cut is `jar` / `colony` / `equipment`; **do not treat that list as
  closed** — creamed honey, hot honey, mead, and propolis (see **Other
  hive products** below) land as further kinds or as catalog products
  on this same line, not as another sales table. Nullable per-kind
  targets and a CHECK that exactly one target is set.
  No compatibility shim, no view pretending the old names still exist — update the
  call sites. Breaking the *schema* is not the same as discarding the *ledger*:
  the instance holds real sales, harvests, and serial links, so the migration
  still carries every existing row across as a `jar` line and keeps the unified
  revenue formulas reading one source.
- **The physical side moves with the money, in one transaction.** Selling a
  colony sets the hive to `sold` and links the sale, so the hive timeline and
  location history say where it went. Selling equipment decrements stock through
  the ledger with a new `sold` disposition carrying the sale link — never an
  opaque quantity edit.
- **Equipment already on a sold hive is the common case.** Boxes and frames
  usually leave with the bees. Offer the hive's active deployments as default sale
  lines rather than making the operator return them to storage first and re-find
  them in inventory.
- **Guardrails matching the rest of the ledger.** A hive that is already sold,
  dead, or combined cannot be sold again; equipment lines cannot exceed available
  stock; and cancelling a sale restores the colony and the equipment, the way
  cancelling a honey sale already restores jars and unlinks serials.
- **Past-dated entry.** These sales have already happened. Recording one must not
  require pretending it happened today, and back-dating must land in the correct
  season for reporting.
- **Reporting that answers "did the bees pay for themselves?"** Split revenue by
  what was sold (honey / colonies / equipment), keep the collected-vs-invoiced
  distinction, pair colony revenue against the `bees_queens` expense category, and
  use stored unit cost as the cost basis for equipment lines.

**This must be designed against the gnucash-web sync from the start**, not
retrofitted — the three line kinds are not the same kind of accounting event, so a
single revenue mapping cannot serve them:

- **Honey** is inventory sold at retail or wholesale: revenue with COGS traceable
  to the physical ledger, which the existing design already covers.
- **Colonies** have no per-unit cost basis in this system. A hive was bought (a
  `bees_queens` expense), raised, or split off another colony; nothing capitalizes
  it. Colony proceeds are revenue against period expenses, and the mapping must
  say so rather than inventing a COGS figure the physical ledger cannot support.
- **Equipment** is an asset disposal, not merchandise. Boxes and frames sold used
  may have been expensed or capitalized on purchase, so the posting is potentially
  a gain or loss on disposal against the stored unit cost — a different account
  from sales revenue, and the one most likely to be mapped wrong if line kinds
  share a single account.

Consequences for the sync contract:

- One mixed sale is **one split transaction** on the accounting side, with a
  posting per line kind — not one lump sum, and not three unrelated transactions
  that no longer reconcile to the receipt.
- `external_sync` needs entity types and per-kind account/category/tax mappings
  for colony and equipment sale lines. This overlaps the already-planned equipment
  entity mappings and equipment mutation idempotency in the GnuCash item below;
  selling equipment *is* an equipment mutation, so the two should land together
  rather than twice.
- Cancelling a sale posts a reversing entry, never a delete — matching the
  existing rule that neither side silently overwrites the other.
- Back-dated entry meets a closed accounting period. Recording this spring's sale
  must either post to the correct period or surface the conflict for review; it
  must not silently re-date the transaction to today to make the posting succeed.
- The authority split holds: Beez Trackz stays authoritative for the colony's
  status and the equipment count, gnucash-web for the posted entries. A posting
  must never be the thing that marks a hive sold.

Naming follows the restructure: with the tables renamed to `sales`/`sale_items`,
Sales stops being a Honey subsection and moves up to a top-level destination,
since a colony sale has nothing to do with honey. That costs a nav slot — Honey
drops to Overview and Production — and the existing `SectionNav` groups absorb it.
See the nav caveat at the top of this item before committing to the mobile side.

**Selling a colony closes out the hive's open state automatically** (decided
2026-08-12), because the alternative leaves a sold hive holding an open feeder
forever and the feeding status row reporting against a colony that is gone.
Automatic must not mean silent, so:

- **Feeders close with a reason that names the sale.** None of the existing close
  reasons fit — `removed` claims the beekeeper took the feeder off,
  `verified_closed` claims a field check happened. Add a `sold_with_hive` reason
  so the audit trail says what actually ended the feeding rather than borrowing a
  reason that is untrue.
- **Deployments split on whether they were sold.** Equipment named as a sale line
  left with the bees: it leaves the ledger as `sold` and must not be returned to
  storage. Everything else on that hive is equipment the operator kept, and
  returns to available stock. Getting this backwards either invents inventory that
  was sold or loses boxes that are sitting in the barn.
- **The sale dialog states the side effects before committing**, in the same
  confirmation that already lists the lines — "closes 1 open feeder, returns 3
  deep boxes to storage" — so the operator can name a deployment as sold instead
  if the default guessed wrong.
- **Cancelling the sale reverses the close-out too**, reopening the feeders it
  closed and re-deploying what it returned. This is why the closures carry the
  sale link rather than a bare reason: without it, a cancel can restore the colony
  but not the state that came with it.

## P1 — Other hive products (creamed, hot honey, mead, propolis)

**Planned (requested 2026-08-18).** Propolis has already been harvested
for tincture. Creamed honey, hot honey, and mead are planned this
year; propolis may later be sold as well. **None of that can be
recorded today.**

The ledger is honey-in-jars. `honey_sale_items.jar_size_id` is `NOT
NULL`. Harvest sessions, lots, and movements are pounds of honey.
There is no propolis harvest, no infusion/ferment batch, no SKU that
is not a jar size. Logging a tincture sale would mean pretending it
was a pint of honey.

This is the same commerce spine as **Colony and equipment sales**,
not a parallel shop. Design the `kind` / product catalog in that
restructure so these land without a second migration. What differs
is the *physical* side — each product is a different conversion of
hive material:

- **Creamed honey** is still honey: a process on a lot (seeded,
  controlled temp, time) that produces a different SKU. Inventory
  leaves bulk or liquid jars and enters creamed jars. Same floral
  claim, same lot ancestry, different texture. Moisture still
  applies.
- **Hot honey** is honey plus ingredients (peppers, vinegar). A
  batch consumes honey pounds from a lot *and* grocery inputs
  (`expenses`). The sale line is a finished SKU; COGS is honey +
  ingredients, not honey alone.
- **Mead** is honey consumed as a fermentable. A batch has honey
  lbs, water, yeast, start/end, vessel, and bottles out. Those
  bottles are not `jar_sizes`. Alcohol may need its own tax
  mapping on the GnuCash side — say so in the account map rather
  than posting mead as honey revenue. Withdrawal/lockout still
  applies to the honey that went in.
- **Propolis** is not honey. Record a harvest (hive or yard, date,
  grams or ounces scraped) that does not touch the honey
  ledger. Tincture is a batch: propolis + alcohol → bottles. Raw
  propolis for sale is a SKU off the harvest, no tincture step.
  Neither decrements honey pounds.

Shared rules:

- One sale, mixed lines: jars of honey, a bottle of hot honey, a
  tin of propolis, a nuc, a used box. One customer, one payment,
  one receipt. Market day grows product buttons; it does not grow
  a second checkout.
- Finished SKUs are a small catalog (name, kind, unit, default
  price, optional jar size or bottle size). Do not invent a new
  `jar_sizes` for mead.
- Every batch names its inputs and writes ledger movements so
  "where did this honey go" still answers. Creamed and hot honey
  remain traceable to a harvest lot and, if declared, a floral
  source. Mead too, even if the customer-facing label is just
  "mead."
- GnuCash: more line kinds, more accounts. Honey-with-COGS does
  not fit a tincture or a mead bottle. Design the mappings with
  colony/equipment, not after.

Do not block the spring colony sale on mead. Ship `jar` / `colony` /
`equipment` first if the catalog is not ready, but leave the
discriminator open so propolis does not require renaming `sales`
a second time.

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

- **Moisture / refractometer on the lot.** The number that decides
  if a lot bottles or sits. Record at extraction (harvest session)
  and optionally again at bottling. Reject or warn at harvest, not
  at the market. Sibling of the deferred "lot weight is free-typed"
  item — do both when the lot row is opened, not as two migrations.
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

- **Saturday yard queue.** One phone-first page, works offline
  (the queue spine shipped 2026-08-17): "Yard B — pull honey A3/A4,
  check mites C1, refill B2." Built from open recs + harvest
  readiness + feeding status + lockout + split readiness. Not a
  fourth recommendations inbox.
- **ntfy / phone push.** Mite check due, feeder empty, treatment
  off-date, "flow started at Yard B." Same events as the yard
  queue. Optional webhook; no email-only path.
- **Labor minutes.** Optional start/stop on the yard visit. Turns
  cost-per-pound from feed+jars into feed+jars+Saturday. Off by
  default; do not guilt a hobbyist.
- **State inspection / compliance packet.** One export: hive list,
  treatments, lots, sales, withdrawal windows. The day the
  inspector or the market manager asks. Authenticated, not public.

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
