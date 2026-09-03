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
- Requested 2026-08-31 — rearchitect inventory after comparing the current
  schema with gnucash-web's inventory spine: one quantity authority, while
  retaining Beez's bee, honey, batch, and traceability records.
- Requested 2026-08-31 — pre-launch workflow/application architecture reset.
  The app is not live, so replace routes directly instead of maintaining
  compatibility redirects, and permit a clean schema/migration baseline. Before
  discarding the imported data, define a portable versioned export/import format,
  export and validate the current dataset, and use that artifact to restore the
  useful data after the reset.
- Requested 2026-09-03 — rename the product to **Apiary Atlas** and make every
  deployment white-labelable. Apiary Atlas is the upstream/default identity;
  this operator's deployment is **GentleBee Atlas**, and another operator may
  supply a different display name and visual identity without forking source.
  Branding is runtime configuration, while compatibility-sensitive machine
  identifiers stay stable unless separately migrated.
- Requested 2026-09-03 — a first-class apiary/hive **Observation** for the
  things a beekeeper notices without performing another workflow: for example,
  “a swarm took off yesterday.” Fold it into the current workflow/application
  reset, not a later notes feature. Observations join the unified activity and
  insight evidence streams; only an explicit follow-up or derived recommendation
  turns one into work.
- Reviewed 2026-09-01 — three-vendor Polyagent review of the three sections
  below at `241f7ea` (`polyagent-review-2026-09-01.md`; worker reports under
  run `20260901-roadmap-review-bz01`). Verdict: diagnosis and ordering
  confirmed against the codebase; three blocker-level amendments and several
  scope corrections are folded into the sections below. Operator decision the
  same day: **no QR labels have ever been printed**, so no authenticated
  internal URL (including `/hives/{id}`) needs to be frozen for printed
  labels — internal routes may be renamed freely. The public Honey Story
  `/honey/[slug]` contract is still preserved because stories are live on
  gentlebeeapiary.com.

## Order of work

The 2026-08-12 review P0/P1 fix list shipped 2026-08-17 (see
[`product-history.md`](./product-history.md)). SEAM-001 and SEAM-004 are no
longer blockers. Remaining product work, in this order:

1–5 (colony/equipment sales + other hive products, source-retained
media + Immich, yard map + sun, varroa program, lockout/moisture/yard
queue) **shipped 2026-08-18** — see [`product-history.md`](./product-history.md)
"Delivered 2026-08-18". Their remaining gaps are listed under
"Shipped 2026-08-18 — remaining gaps" below. Next:

6. ~~**Inventory at more than one location**~~ — **shipped 2026-08-20**
   (Polyagent run `20260820-roadmap-6-8-w1`; migration 00024). Remaining
   gaps under "Shipped 2026-08-20 — remaining gaps" below.
7. ~~**Live GnuCash sync**~~ — **shipped 2026-08-26** (Polyagent waves
   `20260825-gaps-w1-bz01` / `20260825-sync-w2-bz02`; migrations
   00038–00045). Both sides: gnucash-web (folio) gained a
   `/api/integrations/beez/*` integration API (external links, idempotent
   writes, bounded-overlap change feed), and Beez gained the sync engine
   (Settings > GnuCash sync: token, account mappings per line kind and
   expense category, pull-first Sync now, conflict/reconciliation list).
   Beez stays authoritative for physical quantities. Next: preserve the
   current data in a portable snapshot before rebuilding inventory and the
   application workflows.
8. ~~**P0 — Portable snapshot and verified restore.**~~ — **shipped 2026-09-01**
   (Polyagent runs `20260901-p0-wave1-bz01` / `20260901-p0-wave2-bz01` /
   `20260901-folio-verify-bz01`; migration 00049). Format spec
   (`docs/snapshot-format.md`), exporter/importer/roundtrip-gate CLIs,
   `backend/internal/app` restore foundation, GnuCash guarded restore with
   durable `restore_state`, folio verify-by-external-ID API, and the operator
   runbook (`docs/restore-runbook.md`). **The rehearsal ran against a copy of
   prod the same day and passed**: 1,024 records across 65 domains,
   record-digest equality, proven no-write dry run, idempotent second import
   (gate wrapping checksum `53e00e25…`). The rehearsal surfaced and fixed
   three real defects: unpopulated reference cycles stalling the import order
   (81 FK failures), raw double-precision aggregate sums breaking comparison,
   and the comparator failing importer-migrates-to-head. Current prod has no
   media, no transcripts, and no GnuCash sync state, so the media hash gate
   and sync replay boundary are vacuously satisfied for this dataset — a
   fresh snapshot + gate run remains mandatory immediately before the actual
   reset (see the runbook's reset procedure and STOP table). Deferred by
   design to the ledger rewrite: entity re-key + content-hash rebaseline, and
   the beez-side reconciliation sweep that consumes folio's verify endpoint.
   Original item follows for reference: define the canonical,
   versioned export/import contract; export the current imported data; validate
   and round-trip it into an empty database. No destructive schema reset starts
   until this recovery artifact passes the acceptance criteria below.
   *Amended 2026-09-01:* this item includes building the minimal application
   foundation (`backend/internal/app/` restore services, unit-of-work, system
   actor) the importer requires — see the importer contract — and the folio
   reconciliation API work runs in parallel with it. Neither existed at review
   time, and P0's acceptance criteria cannot pass without them.
9. **P1 — Inventory ledger rearchitecture.** Establish one canonical signed
   quantity ledger on a clean baseline, with domain provenance and importer-backed
   recovery. The detailed design is below. Do not add further inventory features
   or label flows until its invariants hold. *Amended 2026-09-01:* the open
   design decisions listed in that section (hives as locations, draft-sale
   operations, unit representation, condition vocabularies, derived lot
   weight, serial identity, guard relocation) must be answered in the spec
   before schema work starts. *Amended 2026-09-02:* those decisions are in
   the spec; Wave 1 landed migrations 00050/00051, `app/inventory`, and the
   generation guard. Sequencing is Phase A (additive ledger + freeze +
   parity) then Phase B (squash and drop) — see **Pre-launch replacement
   phases** below. *Amended 2026-09-03:* **Phase A is code complete** through
   wave 3d — every quantity writer and reader is on the ledger, the
   cross-domain backfill with §7.2 parity and §7.4 residual splits ships as
   `import-snapshot -backfill-ledger`, and the freeze arms only on parity
   success. **Phase B is built and rehearsed against the seeded fixture**:
   `00001_baseline.sql` is generated from the legacy chain, selected by
   `BEEZ_SCHEMA_BASELINE`, and the baseline round trip passes end to end;
   the equipment surface is proven against a baseline database (bill-of-
   materials editing and assembly excepted — spec §12.1 open item 8, a
   Phase B blocker). Spec §12.1 open items 1–7 are closed. **Next act is rehearsal on a copy of
   production** (checklist in spec §12.1, procedure in
   `docs/restore-runbook.md` section 6) — nothing is frozen or squashed on
   the real database yet.
10. **P1 — Workflow and application architecture reset.** Replace the
    module-first information architecture, add a use-case/application layer and
    stable workbench read models, introduce one apiary/hive observation and
    activity stream, and rewrite internal routes directly across the app. This is
    a pre-launch replacement, not a compatibility migration.
    *Amended 2026-09-01:* the WorkItem projection lands in two slices — field
    Today/Yard after the shared command/policy seam (may start during the
    ledger work), Production/Sales workbenches only after ledger-backed
    commands exist.
11. **P1 — Apiary Atlas brand and white-label migration.** Starts after the
    workflow/application route rewrite and before new physical label work.
    Replace the Beez Trackz product identity with Apiary Atlas as the default,
    introduce one runtime brand contract shared by the API and web app, and set
    the Gentle Bee deployment to GentleBee Atlas. Keep database names, container
    image coordinates, public URLs, API paths/tokens, offline storage keys, and other
    machine contracts stable unless an explicit compatibility migration says
    otherwise. Detailed sequence and acceptance criteria are below.
12. **P1 — Zebra label printing and physical traceability.** Starts after the
    inventory-ledger and workflow/application resets, so printed stock and
    serialized jars consume a single quantity authority through stable workflows.
    *Amended 2026-09-01, revised the same day:* serialized jars are fungible
    within their lot (decision 3 in the ledger spec), so the first milestone
    works from `jar_serials` + lot + the bottling run's operation; a consigned
    serialized jar is located by its lot's balance at the consignee, not by
    serial. Gated only on the ledger and workflow resets.
13. ~~**The rest of the 2026-08-18 wave**~~ — **shipped 2026-08-20** in two
    Polyagent waves (migrations 00025–00029): field objects, health
    objects, units preference + display sweep, ntfy, labor, compliance
    packet, place/flow (elevation-banded flora, forage radius, Immich
    yard timeline, scale-hive CSV ingest, frost), photo time-series,
    mating-yard field, floral claim. Deliberately still open per their
    sections: pollination contracts (skip until signed), grafting cycle
    (skip until recorded), MQTT scale ingest (CSV only for now).
14. **Extractor controller** — long-term; hardware plus an ingest
    contract onto harvest sessions. Design the session payload when
    extraction IDs stabilize; do not wait to start the controller.
15. ~~P2 structural/a11y items and leftover ASI lows~~ — shipped
    2026-08-19 (see history); the ASI lows were already closed 2026-08-11.

## Shipped 2026-08-17 — review P0/P1 fixes

Moved to history: SEAM-001…018, UX-001…017, API-001…011, and the varroa
sticky-board chart bug. Do not re-open those IDs without a new failing test.

## Inventory at more than one location (consignment) — shipped 2026-08-20

**Requested 2026-08-19; shipped 2026-08-20** (migration 00024). The spec
below is retained until this section moves to history; see "Shipped
2026-08-20 — remaining gaps" for what stayed open. Finished goods are about to live in more than
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

## Shipped 2026-08-20 — remaining gaps

Items 6 and most of item 8 shipped 2026-08-20 via a three-worker
Polyagent run (consignment / field+health / units+ops; migrations
00024–00026). What the worker reports left open:

- **Consignment.** Closed 2026-08-21 (migration 00030): product
  adjustment ledger (settlement shrink on catalog SKUs now writes both
  halves), `POST /sales` takes `stockLocationId` with
  `/stock-locations/{id}/sales` retired to a deprecated delegate (delete
  after one release), inventory matrix is a fixed number of queries.
  Transfers/settlements stay online-only by design.
- **Units.** Display sweep complete 2026-08-21 (forecast
  current-conditions strip converts through the preference). Closed
  2026-08-25: the Open-Meteo request is Celsius/kmh/mm canonical with a
  `unitsSystem` discriminator stamped into new snapshots; historical
  Fahrenheit snapshots render through a compatibility branch.
- **Ops.** Closed 2026-08-21: ntfy access token (migration 00031,
  bearer auth for reserved topics), dispatch runs hands-free after each
  recommendation pass (receipt-deduplicated), compliance packet has an
  authenticated print view (browser print-to-PDF), labor start/stop in
  the offline mutation manifest.
- **Field/health.** None blocking; voice parser now extracts
  frames-of-bees/brood/stores (`extract-v2`).

## Shipped 2026-08-18 — remaining gaps

Reviewed 2026-08-19 (six independent read-only reviewers over
52ac317..28046bf, then fixes landed the same day — see history). What
the review left open, by feature:

- **Sales / products.** Product batches void 2026-08-21 (reverses the
  honey/propolis consumption; refused once output is drawn down), and
  batch expenses now report cost-per-unit on the products page. Closed
  2026-08-25/26 (migrations 00040–00041): colony lines snapshot
  `cost_basis_cents` from `bees_queens` expenses and equipment lines from
  `unit_cost_cents` at physical apply; profitability by-kind reports
  cost/margin only when basis coverage is complete (coverage counts
  surfaced); `external_sync` entity types renamed/extended and per-kind
  account mappings landed with the GnuCash sync. (Propolis `net_grams`
  and deferred physical effects for draft/pending sales landed
  2026-08-19, migration 00022.)
- **Lockout / moisture / yard queue.** Migration 00022 seeds Apivar 14,
  CheckMite+ 14, ApiLife Var 30 days; verify the rest against labels in
  Settings > Treatment withdrawals. Sale lockout only bites when the sale names a lot; jar lines are not
  traced to lots and bottling from a locked lot is not refused.
  Closed 2026-08-21 (migration 00034): bottling from a locked lot is
  refused with the same rule as sales; moisture has an explicit override
  tier (flag + recorded reason, hard reject unchanged without it);
  inspection PATCH of `treatments` jsonb reconciles `treatment_events`
  with re-resolved withdrawal days; withdrawal seeds audited against
  labels with missing products added insert-only. (The re-parse
  re-resolve sentence was stale — fixed earlier in `5e7a706`. Yard-queue
  endpoint test added the same day.) Closed 2026-08-25 (migration
  00038): jar sale lines can carry a `bottling_run_id` (picker in the
  sale form), and a run-carrying line is refused against a locked lot at
  sale time even when the sale names no lot; future-dated bottling runs,
  harvests, and session entries are refused outright, closing the
  date-forging escape. An untraced jar line (no run selected) remains
  legal by design for offline/POS flows.
- **Varroa.** Closed 2026-08-21 (migration 00036): every mite count on
  an inspection is editable via dedicated `/mite-counts` endpoints;
  soft delete + audit on `mite_counts` (all aggregates filter deleted
  rows); a same-day duplicate returns 409 with the existing row and
  requires an explicit overwrite; trend chart is on a real time axis
  with wash/board/visual series; efficacy pairs same-method only.
- **Media / Immich.** Closed 2026-08-21 (migration 00035): re-parse
  acceptance shows current → proposed per field; transcript versions
  are listed with a Select action; photo detail has a Reprocess action;
  forced re-transcribe records intent and serializes deliveries so it
  cannot race an original-task retry. (Transcription delete made
  transactional and dev compose gained the Immich vars the same day.)
- **Yard map / sun.** Closed 2026-08-21: `CanvasRegistration` and
  `satelliteImageKey` dropped (migration 00032), hive lat/lng surfaced
  on the hive overview (capture/clear via `PATCH /hives/{id}/gps`), sun
  times formatted in the apiary timezone from the weather snapshot.
  Closed 2026-08-25 (migration 00043): tile failures surface a
  dismissible offline notice and stands render regardless; streets tiles
  moved to OpenStreetMap with attribution (README privacy disclosure
  updated), Esri imagery attributed; elevation capture prefers
  Open-Meteo terrain MSL over ellipsoidal device altitude; and
  `hives.gps_source` makes a manual GPS capture survive layout saves
  until explicitly cleared.
- **Auth.** Closed 2026-08-21: `.env` loading is scoped to
  `cmd/set-password`; the production server no longer reads one.

## P1 — Live GnuCash sync and reconciliation — shipped 2026-08-26

**Shipped 2026-08-26.** Everything below was delivered across both repos:
folio exposes `/api/integrations/beez/*` (book-scoped `gcw_` tokens,
`gnucash_web_external_links`, idempotent create/replace/delete keyed by
`sale:<id>`/`expense:<id>` external ids, and a change feed with a
bounded-overlap cursor, deletion tombstones, and quarantine sets for
NULL/far-future timestamps); Beez pushes applied sales (revenue split per
line kind, cash vs receivable from collected-vs-invoiced, tax, optional
COGS/inventory pair from `cost_basis_cents`) and expenses per category,
pulls the feed, and marks `remote_newer`/`diverged`/tombstone conflicts
for operator resolution — pull always runs before push so a bookkeeper's
edit is never overwritten unseen. Equipment mutations got idempotency
keys (00042) and offline-manifest registration. Beez remains
authoritative for physical quantities; folio for posted accounting. The
original spec follows for reference.

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

## P0 — Portable snapshot and verified restore

**Requested 2026-08-31; execute before either architecture reset.** This app is
not live and its current rows came from an import. It is acceptable to discard the
working database and replace the accumulated migration chain with a clean baseline
when that materially simplifies the architecture. A database dump is not an
adequate recovery boundary: first create an application-level snapshot that is
portable across schema designs, export the current data, and prove that it can be
restored.

**Canonical artifact.** Use a documented archive/directory format with a
`manifest.json` and one JSON Lines file per domain record type. The manifest owns
at least:

- `formatVersion`, export timestamp, Beez Trackz application commit, source schema
  commit or migration version, and exporter version;
- the included domain files, record counts, byte sizes, and cryptographic content
  hashes;
- canonical unit and encoding declarations, timezone/timestamp rules, and any
  explicitly omitted optional domains;
- a media manifest version and whether each original is embedded or externally
  referenced;
- a versioned `verification.json` file, linked by hash from the manifest, that
  contains the expected per-record canonical digests, record counts, reference
  checks, pre-reset inventory balances, financial and production totals, media
  hashes, and the exact calculation definitions used to produce every aggregate.

The format is versioned independently from database migrations. Future importers
may upgrade older snapshot versions through explicit transforms; they must never
guess a table layout from the source commit.

`verification.json` is part of the canonical artifact, not an informal report
generated after deletion. Each record entry identifies its domain type and
preserved stable ID, the canonicalization/digest algorithm version, and a digest
of all normalized semantic fields. Reference checks name both ends of every
required relationship. Aggregate definitions declare included statuses,
dimensions, units, currencies, rounding, sign conventions, and query/exporter
version so a matching number cannot hide a different calculation.

*Amended 2026-09-01.* The pre-reset inventory balances can only be computed by
the legacy formulas this reset exists to retire, so `verification.json` carries
two labelled families of aggregate definitions: **legacy definitions** (the
~15 current derivations, versioned exactly as implemented at export time) used
to verify the round trip against the old database, and **new-ledger
definitions** used after the inventory rearchitecture. A restored database is
verified against the family that matches its schema; the mapping between the
two (including the residual-to-opening-balance splits defined in the inventory
section) is itself part of the artifact. jsonb columns are the specific digest
hazard: Postgres does not preserve key order and normalizes numeric literals,
so the canonicalization spec must define sorted-key, fixed-number-format
serialization for every jsonb field (`inspections.pests/treatments/
source_media/weather_snapshot`, `apiaries.canvas_layout`, `photos.tags`,
`harvest_lots.testing_data`, `apiary_weather_cache.forecast`, the `external_sync`
and `gnucash_sync_settings` mapping columns, and
`user_settings.ai_provider_config` — the last mixes configuration with
credentials, so secret exclusion for it is per-key, not per-column). Note
"treatments" is three stores — `treatment_events`, `inspections.treatments`
jsonb, and `treatment_products` — and the export must carry all three plus the
00034 reconciliation rule, or withdrawal provenance is lost.

**Portable domain records.** Export stable application concepts, not raw tables.
Use deterministic JSONL records with preserved UUIDs/IDs and explicit references
for apiaries, hives, queens, inspections, treatments, harvests, lots, bottling and
product batches, serials, customers, sales, stock locations,
consignment, equipment, expenses, sync metadata that is safe to retain, and other
owned operational history. (*Corrected 2026-09-01:* there is no `payments`
table and 00024 deliberately declined one — money is
collected-vs-invoiced columns on `sales` and `consignment_settlements`;
export those columns, not a phantom domain.) The acceptance criteria require
every exported domain to be documented, so the enumeration is the work: the
list above additionally includes feedings and feeding-status backfills,
mite counts, queen events and hive splits, hive location history, the 00025
field objects (catch boxes, colony intakes, incidents, deadout autopsies,
strength scores), the 00027–00028 place/flow objects (bloom observations,
yard scales and readings, weather cache, Immich timeline candidates/scans),
media (`photos`, `media_files`, transcript versions), `honey_varietals`,
labor sessions, recommendations, wholesale price lists, apiary memberships,
and the catalogs every quantity record points at (`jar_sizes`,
`product_catalog`, `equipment_types` and their BOM components,
`treatment_products`). Normalize timestamps to ISO 8601 UTC while retaining a
named local timezone where the business meaning requires it. Use declared
canonical units for measured quantities and integer cents plus currency code for
money; do not export locale-formatted numbers or ambiguous free-text quantities.

**Media and security boundary.** Every photo, transcript source, document, logo,
and label asset is represented in the media manifest with its owner, media type,
original filename, byte size, and content hash. The manifest distinguishes
**originals** (the restoration boundary — `original_key`, `audio_key`, Immich
external references) from **derived renditions** (thumbnail/medium keys, which
are regenerable and excluded from the hash gate, or the gate fails on any
re-render). The artifact may embed original
bytes or carry a resolvable external reference (for example Immich), but the
manifest must make missing external content detectable before reset. A missing
required original fails the destructive-reset gate unless that specific omission
is classified, explicitly accepted, and recorded in the manifest and verification
report with its owner and reason. Exclude passwords and password hashes,
API/personal tokens, integration credentials, encryption keys, session state, and
other secrets. Mark excluded configuration so the restore report tells the
operator what must be configured again. The artifact still contains sensitive
customer, sales, transcript, and media data: encrypt it at rest and in transit,
restrict access to the operator/restore process, keep checksums separate from
decryption credentials, and define retention and secure disposal for superseded
copies.

**GnuCash replay boundary.** Preserve every non-secret value needed to recognize
already-synchronized work after restore: external record IDs, entity/account/
category/tax mappings, conflict and reconciliation state, last-attempt sync
metadata, and the bounded-overlap change-feed cursor or position. Credentials
themselves remain excluded. Restore with GnuCash sync disabled. Before
re-enabling it, run a pull-first reconciliation and no-write push dry run that
proves the restored mappings resolve to the existing remote records and would
produce no unexpected creates, duplicate postings, overwrites, or tombstone
resurrection. Any mismatch stays quarantined for operator resolution.

*Amended 2026-09-01 — the review found this boundary unimplementable as
written; the following are now part of this item:*

- **Export what actually exists.** Deletion tombstones are not durable Beez
  records — an incoming `Deleted` feed entry is collapsed into
  `conflict_state = remote_newer` (and skipped entirely for external IDs Beez
  does not own, while the cursor advances). External write idempotency keys
  are derived at send time from `externalID + contentHash`, not stored. The
  artifact preserves the conflict projection, the derivation algorithm and
  its version, `content_hash`, `remote_transaction_guid`, and
  `remote_enter_date` — and does not claim to export tombstones or stored
  keys. If durable tombstone/sync-run records are acceptance-critical, add
  them to the sync engine first. Singleton `last_synced_at` is last-*attempt*
  (it is written even when the pull fails); export it under that name and use
  per-row `external_sync.last_synced_at` for per-record success.
- **Entity re-key step.** Nine of the seventeen `external_sync.entity_type`
  values (00041) — `jar_size`, `honey_movement`, `bottling_run`,
  `stock_location`, `stock_movement`, `equipment_stock`,
  `equipment_stock_adjustment`, `product_batch`, `product_adjustment` — name
  rows the inventory rearchitecture dissolves. The restore into the new
  schema therefore includes an explicit, versioned mapping re-key transform
  (old entity type + UUID → new item/operation identity), verified by the
  same gate. Without it the mappings dangle and the reconciliation cannot
  pass.
- **Content-hash rebaseline step.** `content_hash` is the hash of the
  last-sent transaction body (00045); the ledger rewrite changes how bodies
  are composed, so the first post-restore rescan would mark every row
  `diverged`. After the re-key and before re-enabling sync, recompute and
  rebaseline `content_hash` from the new body composition against unchanged
  remote state, and only treat as diverged the rows whose *remote* content no
  longer matches `remote_transaction_guid`/`remote_enter_date`.
- **Folio API dependency (cross-repo, runs in parallel with P0).** The
  current folio client exposes only status/accounts/changes plus
  write-capable transaction operations; a pull from the restored cursor
  cannot prove that older unchanged external IDs still resolve remotely.
  gnucash-web needs a read/verify-by-external-ID endpoint (or a server-side
  no-write batch plan) for the dry run to mean what this section promises.
- **Guarded restore of book identity and cursor.** Today,
  `handleGnuCashSettingsPut` clears `BookGUID`/`ChangesCursor` on any token
  change (correct for normal operation, fatal for restore: entering the
  re-excluded token wipes the restored cursor), and `handleGnuCashSyncNow`
  never checks `SyncEnabled` — "sync disabled" is display-only. Add a
  restore-specific flow: keep the expected book GUID/currency separately,
  enter and test new credentials, require an exact identity match, then
  install the preserved cursor/mappings under an explicit restore command;
  and make `SyncEnabled = false` (or reconciliation-pending) a server-side
  refusal on every write-capable sync and force-push endpoint.

**Importer contract.** Import into an empty database through domain-aware APIs or
services, not direct table replay.

*Amended 2026-09-01 — resolving a circular dependency the review found:* no
current endpoint accepts a client-supplied ID, `created_at`, `created_by`,
`deleted_at`, or `voided_at` (every create is `gen_random_uuid()` +
`RETURNING id`), and soft-deleted/voided/reversed history cannot be recreated
through user commands with matching audit timestamps. The importer is
therefore the **first slice of the application layer, built inside P0**: a
restore service layer under `backend/internal/app/` with its own
unit-of-work, transaction-bound repositories, and a privileged system-restore
actor distinct from end-user authorization — not the later user-command API,
and not the `cmd/migrate-legacy` table copier. "Domain-aware" means it
enforces domain validation and reference resolution while being allowed to
write preserved IDs and audit fields directly. Ordering constraints the
contract must own explicitly: no-FK pointers
(`media_files.current_transcript_version_id`, both `reverses_movement_id`
self-references) are set in a post-pass or by intra-file original-before-
reversal ordering; trigger guards (`equipment_stock_reconcile_guard`,
`honey_movement_lot_matches_run`, settlement amount checks) mean equipment
stock is inserted at zero and adjustments replayed, bottling runs precede
their movements, and dependency ordering is finer-grained than one
topological sort over files. It must support:

- a no-write dry run that validates the manifest, hashes, supported
  `formatVersion`, `verification.json`, units, required fields, IDs, and all
  references;
- deterministic dependency ordering with useful per-file/per-record errors rather
  than a partial silent restore;
- idempotent re-execution: an identical record is a no-op, while a conflicting
  preserved ID is reported and requires an explicit resolution policy — this
  is a restore-specific semantic, defined here, not inherited from the
  existing (and mutually inconsistent) domain idempotency behaviors;
- a final restore report listing created, unchanged, skipped, conflicted, and
  failed records, plus missing media and configuration that was intentionally
  excluded.

**Round-trip gate.** Before any destructive reset, create and checksum a snapshot
from the current database, run the importer dry run, restore it into a disposable
empty database, then export that database again. Verification must compare record
counts by domain and every required reference, then compare **every normalized
domain record** by preserved stable ID and canonical semantic-field digest from
`verification.json`; matching aggregate totals do not substitute for record-level
equality. It must also compare inventory quantities by item/location/lot/
condition, financial totals by currency and status, honey and production totals,
and media content hashes or resolvable external references using the versioned
calculation definitions in that file. Only normalization differences explicitly
defined by the applicable `formatVersion` transform may pass; every absent,
additional, or digest-mismatched record and every unexplained aggregate difference
fails the gate. Aggregate comparison uses the definition family matching the
target schema (legacy formulas against the legacy schema, new-ledger
definitions plus the declared residual-split transforms against the clean
baseline); a residual-to-opening-balance difference that matches its declared
split is explained, everything else fails. Keep the validated artifact and
verification report outside the database being replaced.

**Reset policy after the gate.** Once the round trip passes, it is acceptable to
replace the development database, rewrite or squash the migration history into a
clean initial schema, and import the retained data into the new model. Restoration
must use the canonical importer, not one-off SQL written for this reset. Take a
fresh snapshot immediately before the actual reset if the source data changed
after the rehearsal, and repeat the verification gate for that artifact. Keep
external sync disabled through restore and its post-restore reconciliation.

**Acceptance criteria.** The format and every exported domain are documented;
`verification.json` carries versioned per-record digests, reference checks,
baseline aggregates, hashes, and their calculation definitions; the artifact
contains no secrets and is encrypted/access-controlled as sensitive data; all
embedded content hashes verify and all required external media originals resolve,
with any accepted omission individually classified and recorded; dry run makes no
writes; two imports of the same artifact are safe; corrupt, dangling,
incompatible, and conflicting records produce actionable errors; the disposable
round trip proves semantic equality for every preserved-ID record as well as the
count, reference, inventory, financial, production, and media checks; restored
GnuCash mappings and cursors — after the entity re-key and content-hash
rebaseline defined above, through the guarded restore flow, against the folio
verification API — pass a no-create/no-overwrite reconciliation before
sync is enabled; and the validated artifact plus report can restore the useful
current data without any dependency on the old tables or migration chain.

## P1 — Inventory ledger rearchitecture

**Requested 2026-08-31; execute after the portable-snapshot gate.** The current
inventory model has useful domain detail but too many competing quantity
authorities. The 2026-09-01 review counted **~15 distinct derivations across 5
storage patterns**, not the six originally listed: global bulk honey (event
sum + true-up override), per-lot bulk (`honey_lot_balances` view), varietal
rollup, the *unassigned bulk residual* (defined only in 00047's header
comment), the mutable derived lot ceiling (00039), jar finished goods,
catalog SKUs (three sources, two soft-delete filters), propolis grams (a
parallel unit), per-location SKU sums, the *home-stock residual*, trigger-
guarded equipment totals, equipment condition columns, the availability view,
packaging riding the equipment ledger (00048), and equipment BOM assembly
(00046). The two residuals and the mutable lot ceiling are the genuinely
dangerous ones — the trigger-guarded equipment totals cannot drift and are
the least of it. That makes a physical count or a new inventory feature
depend on knowing which formula wins. The target is a single signed movement
ledger, not a removal of bee or honey provenance. Because the app is pre-launch,
prefer a clean schema baseline and importer-backed restoration when that is
simpler and more trustworthy than maintaining legacy tables through a live
cutover.

**Strict boundary.** `inventory_movements` is the sole authority for
on-hand quantity, by item × location × lot × condition. All stock-changing
events create immutable signed lines under an `inventory_operation`;
corrections reverse the operation rather than mutating a balance. Bee and
honey records continue to own their facts and link to inventory operations;
they do not independently change quantities.

**Generalized core (revised 2026-09-01 from the original seven-table
sketch).** The schema is designed once, around dimensions and registries, so
that every feature already on this roadmap — and the ones like it that will
follow — lands as *rows and producers*, not as another rearchitecture. The
core tables:

- `inventory_items` — one ledger identity per stockable thing. `item_kind`
  is a **reference-table value, not a CHECK-constraint allowlist** (00041
  already had to drop-and-rebuild exactly such a constraint once; do not
  repeat it). Each item declares its canonical unit, numeric policy
  (integer count vs fractional mass with a stated tolerance), and tracking
  policy flags (`lot_tracked`, `serial_tracked`, `condition_tracked`).
  Domain catalogs (`jar_sizes`, `product_catalog`, `equipment_types`,
  packaging, future creamed/hot/mead/tincture/wax SKUs) stay first-class
  and point at their item via a polymorphic `source_type`/`source_id`; the
  ledger never grows a domain-specific column for a new product family.
- `inventory_locations` — hierarchical (`parent_id`), with a
  reference-table `location_kind` (site, room/store area, consignee/party,
  hive, container, in-transit/virtual) and an optional polymorphic domain
  ref (customer for the bike shop, hive for deployments, future extractor
  or bucket containers). `home` is a seeded real location. A new kind of
  place — a second consignment shop, a rented honey house, a market tote —
  is an INSERT, never a migration.
- `inventory_lots` — a generic provenance container, not honey-specific:
  harvest lots first, but propolis harvests, mead batches, and wax belong
  here too. Stable ID, item-family scope, domain links for provenance, and
  an `attributes` jsonb for kind-specific facts (declared and canonicalized
  per the P0 digest rules). Lockout stays a computed domain walk, never a
  lot column.
- `inventory_operations` — the only write path. Reference-table
  `operation_kind` (receive, transfer, sale-consume, shrink, deploy,
  return, condition-change, transform, count-adjust, opening-balance, …);
  mandatory payload-bound idempotency key; polymorphic
  `source_type`/`source_id` provenance to the commanding domain record
  (sale, bottling run, feeding, deployment, settlement, future extractor
  run); reversal self-reference; a `details` jsonb for kind-specific facts.
  **A new stock behavior is a new operation kind plus a producer in the
  application layer — never a new ledger, table, or balance formula.**
- `inventory_movements` — immutable signed lines under an operation, one
  row per (item × location × lot? × condition? × quantity). The dimension
  tuple is the only part of the core whose change requires a schema
  migration, and adding a dimension is a design-review event, not a
  feature chore; everything else extends by rows.
- ~~`inventory_units` + `inventory_movement_units`~~ — **withdrawn
  2026-09-01 (decision 3):** serialized jars are fungible within their lot,
  so serials stay a label on the `jar_serials` domain record (lot + bottling
  run + optional sale link) and the ledger tracks quantity by lot. If
  asset-tagged equipment ever needs per-unit movement, a units table joins
  movements by `(operation, line)` as an additive change.
- `inventory_boms` and `inventory_bom_lines` — templates with input/output
  **roles** and expected yields; operations record actuals against them.
  One mechanism covers bottling, equipment assembly, packaging consumption,
  and transformation into any future product. This absorbs the three
  existing BOM-ish mechanisms — `equipment_type_components` (00046, cycle
  guard included), `equipment_types.variant_of_type_id`, and
  `jar_sizes.packaging_type_id` (00048) — rather than ignoring them.
- Small insert-only registries back the `*_kind` and condition vocabularies
  (`inventory_item_kinds`, `inventory_location_kinds`,
  `inventory_operation_kinds`, `inventory_conditions`), unifying today's two
  equipment condition vocabularies into one extensible set.

A balance is a query or materialized projection of movement sums, never a
second writable total; condition changes are paired negative and positive
lines.

**Extensibility rules — the test every future feature must pass without
touching this schema:**

1. New product family (creamed honey, mead, tincture, wax) → new item-kind
   row + catalog rows + BOM templates. No DDL.
2. New place (second consignment shop, rented storage, market tote,
   extractor container) → new location row, at most a new location-kind
   row. No DDL.
3. New stock behavior (catch-box bait stock, comb rotation retirement,
   future rental/loan of equipment) → new operation kind + application-layer
   producer. No DDL.
4. New serialized object (asset-tagged equipment, labeled bins) → unit rows
   on existing tables. No DDL.
5. New condition state → condition row. No DDL.
6. New report or workbench number → new projection over movements. No DDL,
   no stored total.
7. Kind-specific facts ride the declared jsonb payloads (canonicalized for
   P0 digests); the ledger gains no domain columns. Anything that cannot be
   expressed as items/locations/lots/conditions/operations/units is a
   *domain* record that links to operations — like pollination contracts
   (service revenue, no stock effect: explicitly outside the ledger) or
   extractor telemetry (a machine log attached to a session, not a
   movement).

If a proposed feature fails all seven rules, that is the signal a real new
dimension has arrived; amend the movement tuple deliberately, once, with the
same review rigor as this reset — not by bolting on a parallel ledger.

**Design decisions — answered 2026-09-01; the ratified spec is
[`plans/2026-09-01-inventory-ledger-design.md`](./plans/2026-09-01-inventory-ledger-design.md),
which supersedes the sketch above where they differ.** Headline answers:
hives are *not* locations (they are mobile identities; the hive is a
**container** dimension on movements and a hive relocation transfers its
contents); draft sales create no operation (physical movement happens at
bottling and at sale apply / consignment shipment); serialized jars are
fungible within their lot, so `inventory_units` is withdrawn; mass is
`numeric(14,4)` with 0.0001 tolerance; conditions are generated and coerced
on import; a lot's ceiling is a receipt movement; beekeeping refusals stay in
domain commands; the migration chain is squashed; every legacy quantity table
is dropped after translation. The original questions follow for the record:

- **Do hives become `inventory_locations`?** Three location vocabularies
  exist today (`stock_locations` for finished goods, free-text
  `equipment_stock.storage_location`, and deployments keyed to `hives`).
  "Deployments become movement producers" is only true if a deployment is a
  movement to a hive-location; that makes every hive a location and apiaries
  location groups. The generalized core's answer is **yes** — hive is a
  location kind with a polymorphic ref to the `hives` row, apiaries are
  parent locations — but the spec must still confirm the consequences
  (location rows tracking hive lifecycle, `hive_location_history` becoming
  location metadata) before schema work.
- **Does a draft sale create an operation?** Jar and product lines decrement
  on-hand at any non-cancelled status including draft; colony/equipment lines
  apply physically only at `physical_applied_at`. One rule must win, and it
  changes reported on-hand either way.
- **Unit representation.** Honey lbs and propolis grams are `double
  precision` with a tolerance rule (`honeyPoundTolerance`); jars, SKUs, and
  equipment are integers. The generalized core puts the canonical unit and
  numeric policy on `inventory_items`; the spec still owes the concrete
  choice — `numeric` scale per unit kind, the tolerance value, and how the
  negative-lot invariant applies it so float noise cannot trip it.
- **Condition vocabularies.** `frame_condition` sits on a UNIQUE-per-type
  stock row; `equipment_state_changes` covers serviceable/damaged/retired.
  The generalized core unifies both into the `inventory_conditions`
  registry; the spec owes the merged vocabulary and the mapping from both
  legacy columns before paired ±condition lines can be generated.
- **Derived lot weight vs immutable movements.** A `derived` lot (00039)
  recomputes its weight when harvest links change; under immutable movements
  a re-link must emit compensating operations and re-verify downstream
  draws. The 00039 lock order and refuse-delete-under-live-runs rules are
  the current safety net and must have equivalents.
- **Where do the lockout and moisture refusals live?** Lot lockout is a
  recomputed walk (harvests → hives → treatment events), not an attribute,
  and changes retroactively when inspection jsonb is edited. Routing all
  stock-changing commands through the inventory service moves the
  chokepoint; the guards move with it or bottling/sales stop being refused.

**Responsibility migration.** The current product-adjustment ledger,
equipment ledger and totals, honey/lot balance views, stock-location
calculation, sale stock effects, transfers, shrink, deployments, and
bottling/batch consumption/output become operation-specific producers of
the one movement ledger — as do (added 2026-09-01) the harvest/true-up
supply side (harvest sessions, `harvest_session_true_ups`, sessionless
harvests), propolis harvests and tincture draws, packaging consumption
(00048), equipment BOM assemble/disassemble (00046), the varietal rollup,
and the `give_away`/`jar_adjustment` movement kinds. Historical
`honey_movements` carry no actor (`created_by` does not exist on that
table), so imported honey history uses an explicit `legacy-unattributed`
provenance marker alongside the `legacy-unassigned` lots. Locations become explicit movement dimensions;
`home` is a real location, never "global minus elsewhere." Sales remain
commercial records and reference the physical operation that consumes
stock; they no longer serve as a competing balance formula.

**Keep these domain records.** Harvest sessions and allocations, hives,
treatments and withdrawal rules, varietals and floral claims, Honey Story,
bottling runs and jar serials, mead/hot-honey/propolis process facts,
customers and consignment statements, collected-vs-invoiced money fields and
commissions, and GnuCash sync/conflict state stay first-class — and so do
(added 2026-09-01, all load-bearing and previously unlisted): **feedings**
(the workflow section's own WorkItem example), inspections and their jsonb,
mite counts with their soft-delete/audit trail, the queen lifecycle
(`queen_events`, `hive_splits`, location history), the 00025 field objects,
the 00027–00028 place/flow objects, media and transcript versions,
`honey_varietals`, and expenses. They reference items, lots,
and operations as needed; the core ledger must not flatten them into generic
notes.

**Pre-launch replacement phases.**

*Amended 2026-09-02 (spec §9 / OV7):* additive ledger + freeze + parity
first; squash and drop second. Decisions 9 and 10 remain the destination.
No dual-write. No table is dropped in Phase A.

Wave 1 of this item **landed 2026-09-02** on the current goose chain:
migration `00050_inventory_ledger.sql` (ledger tables, views, seeded
locations including the virtual `deployed` location, nullable
`item_id`/`inventory_lot_id` links on `sale_items`/`jar_sizes`/
`product_catalog`/`equipment_types`/`harvest_lots`/`product_batches`,
`equipment_types` catalog attribute columns), migration
`00051_schema_generation.sql` plus the generation guard
(`db.ConnectWithOptions`; `--legacy-source` read-only exception), and
`backend/internal/app/inventory` (pure builders in `app/inventory/build`,
`Service.Record` / `Reverse` / `CheckAvailable`, read queries, checkpoint
refresh, lock order in `doc.go`). Legacy quantity tables still exist and
were still written by the then-current handlers.

1. Complete the portable-snapshot round-trip gate (P0, shipped 2026-09-01).
   Freeze the inventory portion of the export contract around domain facts
   and provenance rather than the old balance formulas; use explicit
   `legacy-unassigned` lots only where the source records genuinely cannot
   prove ancestry. A fresh snapshot + passing gate remains mandatory
   immediately before the Phase A backfill and again before the Phase B
   reset (`docs/restore-runbook.md`).
2. **Phase A — additive ledger, freeze, parity (this wave).** Finish routing
   every stock-changing command through one inventory application service
   (`app/production`, `app/sales`, `app/equipment`, `app/field` calling
   builders then `inventory.Record` / `CheckAvailable`; HTTP is transport)
   and switch every live reader of a freeze-set table or view to
   `inventory_balances` / `inventory_available` / `inventory_reservations`
   / checkpoint reconciliation (audit T3/T4). Then run the in-place
   backfill — `import-snapshot -backfill-ledger`, **landing in this wave**;
   authoritative flags in `backend/cmd/import-snapshot/main.go` — under
   the system-restore actor: spec §7 translation, residual splits, freeze
   trigger on the eight legacy quantity tables, §7.2 parity against the
   frozen legacy aggregate family. A failed parity never commits; legacy
   tables stay writable and the ledger stays empty. Investigate rather
   than conceal differences. Operate on the ledger alone; frozen tables
   remain for reference. Procedure: `docs/restore-runbook.md` section 6.
3. **Between the phases.** After a committed freeze, complete the physical
   count and consignment-settlement reconciliation as `count_adjust`
   operations on the new ledger (this retires `legacy-unassigned` lots).
   Export and round-trip verify a post-adjustment snapshot so those
   adjustments become the new rollback boundary; do not rely only on the
   pre-Phase-A artifact. GnuCash: re-key the six dissolved
   `external_sync` types, content-hash rebaseline, folio verify sweep,
   `markReconciled`, then enable sync. Still no squash and no dropped
   table.
4. **Phase B — squash and drop (later).** Only after the ledger has run
   alone for a real period and the physical count in step 3 has landed:
   write `00001_baseline.sql` as the full target schema minus the dropped
   set, move the old chain aside, stamp `schema_generation`
   `'ledger-v1-baseline'`, recreate every database, take the final
   snapshot, run the ordinary P0 gate (translation already happened in
   Phase A), reset, and restore through the canonical importer with
   GnuCash disabled. Run the full record-level and aggregate verification
   against `verification.json` before accepting the restored database.
   This wave does not do Phase B.

**Cutover invariants.** Every operation is idempotent and supports reversal.
A reversal operation references its original, and the original records that
link when one exists. Transfers net to zero for the same item and unit at
their source and destination; transformations carry their required input and
output lines. One-sided receive, sale, shrink, and adjustment operations are
allowed, but each has a source/reference. Sales consume only their source
location; no revenue is recognized on transfers; a lot cannot go negative
where traceability is required; and new sums reconcile to the old reported
balances until the approved physical-count adjustment.

*Qualified 2026-09-01 — these are designs to build, not properties the
current machinery provides:* idempotency keys become mandatory and
payload-bound (today equipment replays on key match without comparing
payloads, product/stock duplicates 409, and transfer subkeys depend on
request line order — three different semantics); reversal is aggregate-aware
(a bottling-run void reverses movements, removes unsold serials, and marks
the run atomically — a generic rule must specify descendant consumption,
sold/serialized outputs, and refusal-vs-compensation); the nonnegative-lot
rule is a cross-row aggregate needing a lock anchor and deterministic lock
order over item/location/lot/condition; and "reconcile to old balances"
applies per legacy formula except where a residual was split into declared
opening-balance operations — those reconcile to the declared split, and each
ambiguity is classified rather than forced into simultaneous equality.
GnuCash remains authoritative for posted accounting, while this ledger is
authoritative for physical quantity.

**Boundary on a clean reset.** Do not copy gnucash-web literally: borrow its
movement-ledger spine, not its thinner domain model. A pre-launch replacement of
the schema, routes, and working database is explicitly allowed; an unverified
destructive rewrite is not. The validated portable snapshot, importer rehearsal,
ledger reconciliation, and preserved domain provenance are the rollback and
recovery path. Do not carry shadow-write machinery, compatibility tables, or an
indefinite dual-read feature flag solely for a production cutover that does not
exist.

## P1 — Workflow and application architecture reset

**Requested 2026-08-31; execute after the inventory baseline, with the
application seam beginning during inventory work.** The UI problem is structural,
not a request for another styling pass. The present navigation exposes eleven
module-first top-level destinations (verified 2026-09-01: an admin sees all
eleven; Honey, Sales, and Equipment are admin-gated so a viewer sees eight,
and mobile is four role-dependent pins plus More — the reset must keep that
role filtering). Dashboard, Yard Queue, and Recommendations
compete as separate work centers; Honey and Sales leak overlapping
stock and production actions into one another (corrected 2026-09-01: the nav
item labelled Equipment at `/inventory` holds hive gear, not finished goods —
finished stock leaks between Honey and Sales, and packaging straddles
Settings jar sizes and equipment types); Settings is a catch-all page of
mixed concerns (one route, accordion sections — there is no
`/settings/[section]` tree to rewrite, so splitting it means new routes); and
large HTTP handlers orchestrate transactions that cross
domain boundaries. Users are being asked to understand the package and table
layout before they can complete a job.

**Prototype the information architecture around work.** Validate this first-pass
desktop taxonomy against representative field, honey-house, market, and admin
tasks:

- **Today** — attention, due work, recent changes, and resumable tasks;
- **Yard** — apiaries, hives, queens, inspections, treatments, and field work;
- **Production** — harvest, extraction, lots, bottling, transformations, finished
  stock, and production traceability;
- **Sales** — market day, orders, consignment, customers, settlement, and payment;
- **Equipment** — owned assets, stock, deployment, condition, and maintenance;
- **Insights** — reports, trends, compliance, and reconciliation;
- **Admin** — operation setup, integrations, access, and infrastructure.

The mobile primary navigation prototype is **Today / Yard / Production / Sales /
More**, with Equipment, Insights, and Admin under More. These labels are a
testable proposal, not permission to reproduce the existing pages under new menu
names. Run concrete journeys through the prototype and move each action to the
place where the operator begins that job. Mobile caveats (2026-09-01):
Production and Sales are admin surfaces — the bar must keep role filtering —
and Saturday field work starts at yards and hives, so the field-day prototype
should not demote Yard off the phone bar in favor of honey-house areas. The
review catalogued ~15 flows that straddle two proposed areas (harvest-ready
pull-honey, treatment lockout, record-sale, labor start/stop, compliance
packet, GnuCash reconciliation status, hive-side equipment deploy, feeding
surfaces, hive products, voice walkthroughs, and others — see
`polyagent-review-2026-09-01.md`); each needs an owner decision during the
prototype, not a menu label.

**One work system.** Introduce `WorkItem` as a query/read projection over source
domain facts, never a second task or inventory source of truth. A projected item
has a stable projection ID, source type and source ID, location/context, title and
evidence, priority/status, `asOf` and freshness metadata, permission-aware
available commands, and an offline/sync disposition. Completing “refill feeder,”
for example, invokes the source feeding command; it does not mutate a generic
work-item row and hope the source catches up.

Today is the default work view. Yard Queue is a location/grouping filter over the
same projection, not a separately owned queue. Recommendations is a reason/status
filter and review history over the same projection, not another inbox. Projection
responses must state what time their facts are true as of, distinguish stale
cached evidence from current server evidence, and declare which source commands
may be safely queued offline. Permission filtering applies to the commands and
the facts used to explain the work item.

**One observation and activity stream.** Add a first-class `Observation` source
fact for something witnessed in the field that is worth remembering but is not
necessarily a task, inspection, status change, or colony acquisition. The primary
entry point is **Add observation** on an apiary, with equivalent context-preserving
entry points on a hive and in Yard/Today quick actions. The minimum record is
`occurred_at`, `apiary_id`, a canonical kind, and non-empty body; `hive_id` is
optional because the source colony may be unknown. Optional attachments/source
media, voice capture, tags, and `follow_up_at` use the existing media, command,
and offline conventions rather than parallel storage.

Seed the entry UI with **General**, **Swarm departure**, **Swarm arrival**,
**Colony behavior**, **Weather**, **Forage**, **Pest/wildlife**, and **Other**.
The canonical type mechanism must be extensible without another closed database
CHECK for every useful observation. Keep `swarm_departure` distinct from a
`colony_intakes.source = swarm` row: the former says a swarm was seen leaving
(possibly from an unknown hive); the latter says a colony was acquired. A user
may link or correct the suspected hive later without rewriting the original
author, occurrence time, or audit history.

This becomes the apiary's operational activity spine. A cohesive activity read
model merges observations with the already-authoritative inspections, feedings,
treatments, queen events, splits, harvest events, bloom observations, field
objects, and adopted/source-retained media. Apiary Activity is chronological and
filterable; a hive-linked observation also appears on that hive's timeline.
Replace the current misleading “Yard timeline” boundary, which is an Immich
flora/hive-photo view, with an Activity surface in which that photo evidence is
one source rather than the whole timeline. Today may show a bounded recent-
activity/evidence slice, but it must not turn every note into an attention item.

Observations are evidence for insights and recommendations. The recommendation
pipeline may cite an observation by stable ID, kind, scope, and occurrence time;
for example, “Swarm observed at North Yard yesterday” can inform a later colony-
strength or queen-status recommendation. An observation enters the WorkItem
projection only when `follow_up_at` is set or a source-domain rule derives an
actionable recommendation. That item keeps the observation as its evidence and
executes the observation's explicit complete/reschedule command; deleting or
editing a note must not silently dismiss a separately derived recommendation.

**Existing-data migration.** Replace the narrow `field_incidents` silo rather
than building a second journal beside it. Backfill every live and soft-deleted
incident one-to-one into observations while preserving ID, apiary/hive scope,
incident date, exact incident kind (`robbing`, `yellowjackets`, `bears`, `skunks`,
or `flood`), notes, creator, timestamps, and deletion audit. Keep those specific
kinds available beneath the broader Pest/wildlife grouping. Do **not** convert
`apiaries.notes`: that mutable field remains current access/landowner/setup
information, not dated history. Do not convert swarm colony intakes. Retire the
global eight-row Incident Log only after its rows, permissions, delete behavior,
snapshot registration, and relevant tests are represented by Observation and
Activity contracts.

Observation create/edit/link/delete and follow-up commands are editor-only and
apiary-scoped; viewers see only observations for apiaries they may read. Creation
and safe edits must be idempotent and queueable offline through the generated
offline-route manifest—the current `/incidents` write is not. Activity responses
carry the same `asOf` and freshness contract as WorkItem/read models so cached
field evidence is visibly distinct from current server evidence.

*Scope honesty (2026-09-01):* this is a new backend projection plus the
deletion of three existing assemblers, not a filter flag. Today the Dashboard
work list is a client-side assembler (`useFieldWork`: recs + feeding status,
with inline refill/close/snooze/dismiss), Yard Queue is a server-side
assembler (`yard_queue.go`: lockouts + recs + feeding + harvest-ready, no
stable item IDs, `asOf` returned but never rendered, links only — no inline
commands), and Recommendations is a third inbox with its own triage
semantics; both work lists independently special-case `feeder_check`, and
that dedup moves into the projection once. The current frontend also cannot
consume the contract yet: nothing reads the service worker's
`X-Beez-Cache: stale` header, access is page-level
(`adminOnly`/`requiresEdit`) rather than per-command, and offline
queueability is a global API-prefix allowlist in which harvest-session
*create* is deliberately excluded — a field-day "start extraction" work item
cannot satisfy the offline-disposition criterion without revisiting
`offline_routes.go`. Dashboard additionally mixes the work list with
status/history/reporting widgets that must be relocated before Today is a
work view. Build the field Today/Yard slice first (it does not depend on the
new ledger); Production and Sales workbenches wait for ledger-backed
commands or their quantity and command fields would encode the legacy
authorities.

**Application/use-case boundary.** Add command and query services under an
application layer such as:

```text
backend/internal/app/
  inventory/
  work/
  field/
  production/
  sales/
```

Start this boundary with the P0 restore services and continue it through the
inventory-ledger rewrite so HTTP handlers translate
transport concerns while application commands own authorization, validation,
transactions, idempotency, lifecycle changes, and domain-event emission. Queries
own stable use-case projections. Domain packages retain domain rules and facts;
the application layer coordinates them. Do not move current long handlers into
equally long “service” methods without defining command inputs, transaction
boundaries, results, and failure semantics.

*Prerequisite conventions (2026-09-01), defined before any package
extraction:* a unit-of-work/transaction runner owned by the **outer use-case
command** — `sales.RecordSale` or `production.CompleteBatch` owns the atomic
transaction and the inventory service participates in the same `pgx.Tx`
(the "one inventory service for every stock-changing command" rule is about
authorship of movements, not about inventory owning the outer transaction;
an independently transactional inventory command would nest or split
atomicity); transaction-bound repositories; deterministic lock ordering;
typed errors independent of HTTP; explicit authorization inputs (actor,
memberships, admin/system-restore scope); and a decision on idempotency —
whether the offline mutation ID/request hash becomes command identity with
result and writes stored atomically (today the receipt middleware inserts
the receipt, lets the handler commit separately, and a crash between the two
opens a five-minute re-execution window), or receipts remain a transport
layer backed by mandatory payload-bound domain keys. Domain-event emission
needs a post-commit/outbox design; none exists today.

**Stable workbench contracts.** Prefer a small set of cohesive read models such
as `/work/today`, `/work/yard`, `/production/workbench`, and
`/sales/workbench`. Their contracts represent use cases and can compose several
domains; they are not exact component trees. Avoid endpoint-per-card or
endpoint-per-widget BFF sprawl, and avoid making the frontend reconstruct one
workflow from a pile of unrelated list calls. Mutations remain explicit source
commands rather than generic “update workbench” requests.

**Direct canonical route rewrite.** The app is not live, so update routes across
the codebase in one bounded change and delete obsolete internal aliases. Do not
add compatibility redirects or preserve the current redirect chain. No QR
label has ever been printed (operator decision 2026-09-01), so no
authenticated internal URL — `/hives/{id}` included — needs to survive the
rename; the only external contract is the live public Honey Story
`/honey/[slug]` namespace. Rewrite the
desktop and mobile navigation, in-app links, command palette/search
targets, QR/internal scan target generators, offline mutation route
manifest, service-worker/cache rules, documentation, and route/e2e tests together.
Corrections from the 2026-09-01 review: there is no breadcrumb component
(the command palette synthesizes crumbs from `NAV_ITEMS`; that plus any
hardcoded "Honey › …" copy is the real surface), and ntfy notifications
carry no click/deep-link URL today — do not invent rewrite work for either,
but if click URLs are added later they land on Today/Yard, not retired
paths. Concrete consumer inventory: the `/harvest/*` shims have **zero**
in-app link consumers (cheap delete); `/honey/market-day` has seven,
including the service-worker SHELL precache and three e2e specs
(`offline`, `design-promises`, `honey-gaps`) that fail CI if the alias is
deleted without coordinated updates; `install-prompt.tsx` CALM_ROUTES is
already stale (`/genealogy`, missing `/queens`/`/sales`); PWA manifest
shortcuts and `start_url` name current paths; the offline mutation manifest
is generated from `offline_routes.go` (API prefixes, not UI paths) and only
changes if application commands change endpoint URLs.
Remove the internal `/harvest` tree and Honey-owned Sales/Market Day aliases
(including `/honey/sales`-style destinations) after their canonical Production or
Sales routes exist, plus the `/genealogy` redirect. Preserve the intentional
public Honey Story contract, but do
not let that public `/honey/[slug]` namespace dictate the authenticated
information architecture — the collision-free option is to move all
authenticated honey routes off `/honey/*` entirely, retiring the
reserved-slug guard. Resolve the naming collision this creates: the nav item
"Equipment" lives at `/inventory`, the target IA has no Inventory area, and
the ledger work adds `inventory_*` tables and `internal/app/inventory` —
pick route names so "/inventory" and "inventory" do not mean different
things in the same codebase. A repository search for every retired internal path
must be empty except explicit negative tests or historical documentation.

**Split configuration by owner and frequency.** Replace the Settings catch-all
with:

- **My Preferences** — per-user units, appearance, notification, and interaction
  preferences;
- **Operation Setup** — operational catalogs and policies used by Yard,
  Production, Sales, and Equipment, linked contextually from those workspaces;
- **Admin & Integrations** — access, storage/media providers, AI, API tokens,
  GnuCash, ntfy, printer/network infrastructure, and system health.

Contextual “manage” links may enter the appropriate setup view, but operational
objects must not have two independently owned editors. Known offenders to
resolve during the split (2026-09-01): Preferences are admin-gated today, so
"My Preferences" as a per-user surface is an access change, not a rename;
labor is dual-homed (Settings section + Yard Queue widget); record-sale is a
Honey quick action, a Sales-layout action, and the Market Day POS; equipment
deploy runs from both the hive page and Equipment inventory; the compliance
packet is stored in Settings but Insights-shaped; and jar sizes / treatment
withdrawals have no contextual manage links at all yet.

**Execution sequence.**

1. Inventory all current routes, entry points, offline mutations, top journeys,
   and the application commands they should invoke. Prototype the target IA and
   WorkItem contract against one field day, one production run, one sale/
   consignment settlement, one equipment task, one general/swarm observation,
   and one admin setup flow.
2. The `internal/app` package and its unit-of-work/transaction conventions
   start earlier, as the P0 restore services (see the importer contract).
   During the inventory reset, extend that foundation into the
   `internal/app/inventory` command/
   query pattern. In the field slice, implement Observation commands, the
   incident migration, and the unified Activity read model; then implement the
   WorkItem projection and Today/Yard filters without copying source state into a
   writable generic queue. This work may start as soon as the shared
   command/policy seam exists; it does not wait for the ledger.
3. Add Production and Sales workbench projections and move cross-domain
   orchestration out of HTTP handlers into explicit application commands. Prove
   permissions, idempotency, rollback, and offline behavior at this seam.
4. Replace navigation and all internal routes in one coordinated rewrite, update
   every route consumer/cache/test, and delete aliases instead of redirecting
   them. Then split Settings and add contextual setup links.
5. Remove orphan pages, duplicate query assemblers, old handler orchestration,
   and retired route vocabulary only after end-to-end journeys pass against the
   canonical paths.

**Acceptance criteria.** Desktop exposes only the seven proposed work areas (or a
documented user-tested refinement) and mobile only the five primary entries;
Today, Yard Queue, and Recommendations are views over one permission-aware,
freshness-aware WorkItem projection; every work-item action executes its source
command; an editor can record “a swarm took off yesterday” against an apiary with
no known source hive while offline, later link a hive, and see the synced record
in Apiary Activity and that hive's timeline; the same observation can be cited as
recommendation evidence but appears as work only with a follow-up or derived
action; every legacy field incident survives the migration with its identity,
scope, kind, author, dates, and deletion audit intact; apiary setup notes and swarm
colony intakes retain their distinct meanings; production can be followed from
hive harvest through extraction, lot, bottling, finished stock, and sale/transfer
without crossing arbitrary modules;
the representative field, production, sale/settlement, equipment, and admin
journeys each have one clear starting point and canonical route; inventory and
other migrated cross-domain transactions are owned by tested application
commands rather than HTTP handlers; workbench pages use cohesive use-case read
models rather than per-widget endpoints; route, command-palette, notification,
offline/cache, scan, and e2e consumers contain no retired internal paths; no
compatibility redirects remain; configuration has one owning surface in My
Preferences, Operation Setup, or Admin & Integrations; and desktop/mobile online,
offline, stale-data, forbidden-command, error, undo/reversal, and interrupted-
workflow states are verified before the old pages are removed.

## P1 — Apiary Atlas brand and white-label migration

**Requested 2026-09-03; execute after the workflow/application reset and before
Zebra label templates.** The upstream product becomes **Apiary Atlas**. A fresh
deployment displays that name without configuration; this operator's production
deployment overrides it with **GentleBee Atlas**. White-labeling must be a
supported runtime capability, not a search-and-replace fork or a value baked into
one Docker image.

**Brand boundary.** Separate human-facing identity from machine identity before
renaming anything:

- **Product identity:** Apiary Atlas is the default name used by source docs,
  metadata, and any deployment with no override.
- **Deployment identity:** a small, validated runtime brand contract supplies at
  least display name, short name, description/tagline, wordmark/mark assets, and
  theme colors. Missing optional values fall back independently to the Apiary
  Atlas defaults. Gentle Bee production sets the display and short names to
  `GentleBee Atlas`; another installation can supply its own values without a
  rebuild.
- **Stable machine identity:** do not cosmetically rename PostgreSQL database or
  role names, MinIO buckets, container/image coordinates, Go module paths,
  migration/profile names, API token prefixes, HTTP routes, external-sync entity
  IDs, idempotency keys, cookie names, service-worker/cache/IndexedDB keys, or
  compatibility headers. Existing names such as `beez-trackz`, `beeztrackz`,
  `bt_`, `X-Beez-Cache`, and `/api/integrations/beez` may remain internal. Change
  one only with an inventoried reader/writer migration and rollback plan; a brand
  migration alone is not that authority.
- **External public contracts:** preserve `/honey/[slug]`, existing Honey Story
  and hive-tag URLs, and the configured origins. Branding may change their visible
  copy and artwork, never their resolvability or embedded record identity.

**Execution sequence.**

1. Inventory every visible product-name, logo, icon, color, description, document
   title, install prompt, generated filename, and outbound message in the frontend,
   backend, PWA, public Honey Story, MCP metadata, compliance export, notifications,
   deployment files, tests, and current documentation. Classify each hit as
   product default, deployment brand, historical prose, or stable machine
   identifier; do not run a blind repository-wide replacement.
2. Define one typed brand schema and defaults. The server-side runtime
   configuration is authoritative and exposes only public presentation values to
   the browser. Both server-rendered and client-rendered UI consume the same
   resolved object so titles and visible copy cannot disagree or hydrate with a
   different name. Validate lengths, colors, and asset paths at startup; brand
   configuration must never admit arbitrary HTML, script, or remote executable
   content.
3. Make the PWA brand-aware at request time: document metadata, web manifest,
   Apple/install titles, shortcuts, icons, theme colors, offline/error pages, and
   install prompts all use the resolved deployment brand. Keep cache and IndexedDB
   identifiers stable so upgrading does not strand queued field work. Version the
   shell cache when branded assets change, and document that installed launchers
   may require refresh or reinstall before an OS redraws their name/icon.
4. Replace user-facing hardcoding with shared brand primitives: application logo
   and wordmark, authentication/setup screens, sidebar/mobile shell, toasts and
   recovery pages, Settings install copy, public Honey Story attribution, and
   customer-facing error/not-found states. Custom assets must have accessible
   text/fallbacks and preserve contrast in light/dark themes; the Apiary Atlas
   mark remains the fallback when a deployment supplies only a name.
5. Carry the same contract through backend-produced surfaces: notification title
   and body, compliance packet title and download filename, MCP display title, and
   any printable/exported human-facing heading. Keep protocol identifiers stable
   (for example, MCP's machine `name` and GnuCash integration paths/external IDs)
   while changing only their display labels. Snapshot/import metadata must record
   the product and deployment brand as non-authoritative provenance, never use a
   brand string as a restore key.
6. Add deployment plumbing without image forks. Pass the public brand variables to
   both API and web containers at runtime; document the Apiary Atlas defaults in
   `.env.example`; set Gentle Bee production to GentleBee Atlas in its deployment
   environment; and provide a minimal second-brand fixture used only by automated
   tests. Secrets and infrastructure coordinates are not part of the public brand
   object.
7. Test a two-brand matrix against the same build: unconfigured **Apiary Atlas**
   and overridden **GentleBee Atlas**. Cover server metadata, hydrated UI, manifest
   and install copy, public Honey Story, offline fallback, notification/compliance
   output, MCP initialize metadata, custom/fallback assets, and reset-to-default
   behavior. Add a repository scan gate that rejects new user-facing `Beez Trackz`
   strings while explicitly allowlisting historical prose and stable machine
   identifiers.
8. Roll out as one bounded presentation migration after the route reset has
   settled. Take the normal pre-deploy backup, deploy GentleBee Atlas, verify old
   public and authenticated links, queued offline writes, login/OIDC, Honey Story
   QR targets, MCP clients, GnuCash sync, and PWA upgrade behavior, then retain the
   previous image/config pair as the rollback. No database migration or data
   rewrite is expected for branding alone.

**Acceptance criteria.** One unchanged application image serves Apiary Atlas by
default and GentleBee Atlas when configured at runtime; a third test brand works
without a source edit or rebuild. Every visible app-owned name and mark comes from
the resolved brand contract, including SSR metadata, PWA/install surfaces, public
stories, backend-generated documents/messages, and MCP's human-facing title.
There is no hydration mismatch, unsafe custom markup, contrast/accessibility
regression, loss of offline queue/cache data, or broken old QR/public URL. Stable
machine identifiers and external-sync contracts remain byte-for-byte compatible,
and the repository scan distinguishes those intentional legacy identifiers from
accidental user-facing Beez Trackz copy.

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
   tied to IDs rather than free-form names. Per-unit identity is deferred
   (ledger spec decision 3); when this item starts, add an additive units
   table joined to movements rather than a separate asset-tag scheme.

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

## Field work that still has no object — shipped 2026-08-20

**Added 2026-08-18; shipped 2026-08-20** (migration 00025: catch boxes,
colony intake, incidents, deadout autopsy, strength scores, comb age,
swarm/split readiness rule, lockout was already delivered 2026-08-18). Inspections, feedings, treatments, and hive status
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

## Place and flow — shipped 2026-08-20 (wave 2)

**Added 2026-08-18; shipped 2026-08-20** (migration 00027 flora bands /
forage radius / scales / frost, 00028 Immich timeline). MQTT scale
ingest deferred — CSV only.

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

## Colony health beyond mite counts — shipped 2026-08-20

**Added 2026-08-18; shipped 2026-08-20** (strength score, incident log,
deadout autopsy in wave 1; photo time-series with operator-labelled
comparison angles in wave 2, migration 00028). Image analysis on the
strip was deliberately left out — the `imageAnalysis` task has no
trustworthy reprocessable pipeline yet. Varroa stays its own item. This is everything
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
  still active. The narrow delivered log is superseded during the P1 workflow
  reset by the first-class Observation/Activity stream; existing incident rows
  migrate into it rather than being discarded or kept as a second silo.
- **Deadout autopsy.** Marking deadout today is mostly a status.
  Require (or strongly prompt): stores left, cluster position, last
  fall mite load, queen status, moisture / mold. Winter-survival
  reports should segment on these rows. A deadout without an
  autopsy is a status change you cannot learn from.

## Queen breeding — mating yard shipped 2026-08-20

**Added 2026-08-18.** Mating-yard field + drone-source note shipped
2026-08-20 (migration 00029). Grafting cycle stays skipped per the
bullet below. Queen performance scoring exists. Mating place
and raising cycle do not.

- **Mating-yard / drone-source map.** Where she mated, which yards
  were flooding drones. One extra field plus the Leaflet pin turns
  queen scores into a place story. Couples to the yard-map item.
- **Grafting / cell-builder cycle.** Graft date, emerge, introduce,
  accept. Links to the queen row you already have. Skip if you
  never graft; build when the first graft is recorded as a note
  for the third time.

## Honey as a declared product — floral claim shipped 2026-08-20

**Added 2026-08-18.** Floral-source claim shipped 2026-08-20 (migration
00029: lot claim fields, lot form, Honey Story render, `floralClaim` in
lot JSON for future label templates). Pollination contracts stay
skipped until one is signed. Lots, bottling, Honey Story, and market day
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

## Operations around the week — shipped 2026-08-20

**Added 2026-08-18; shipped 2026-08-20** (ntfy, labor minutes,
compliance packet — gaps noted above). Recommendations exist and live in the app.
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

## Units: metric or US across the app — shipped 2026-08-20 (display sweep open)

**Requested 2026-08-19; core shipped 2026-08-20** (migration 00026,
`lib/units.ts`, Settings > Preferences). The per-surface display sweep is
listed under "Shipped 2026-08-20 — remaining gaps". Every quantity is entered and shown in whatever
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

## Shipped 2026-08-19 — P2 structural, a11y, responsive, ASI lows

Moved to history. Remaining follow-ups: the new e2e specs
(`design-promises`, `a11y-bulk-select`, `solar`, updated `navigation`) first
run in CI — worktrees could not start Playwright; `API_URL` is now the
server-side contract and `NEXT_PUBLIC_API_URL` is deprecated for one
release; `/harvest` → `/honey` rename and lot-weight derivation stay in
"Smaller deferred items".

## Smaller deferred items

- ~~**`/harvest` → `/honey` route rename**~~ — **shipped 2026-08-25.**
  Authenticated tree moved to `(app)/honey` with redirect shims at every
  old `/harvest` path (`?serial=` forwarded); public `/honey/[slug]`
  stories unaffected; reserved-slug guard on lot create *and* update
  keeps app subroutes from shadowing a story.
- ~~**Lot weight is free-typed**~~ — **shipped 2026-08-25** (migration
  00039): `honey_weight_source` manual|derived; derived lots sum linked
  non-deleted harvests, recompute when links change, and are protected by
  a global harvest→lot→bulk lock order; deleting a harvest under a lot
  with live bottling runs is refused to preserve withdrawal provenance.
  Lot **moisture** is the sibling number and lives in the honey-product
  item, not here.

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
