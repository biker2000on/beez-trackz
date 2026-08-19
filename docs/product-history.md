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

## Delivered 2026-08-19 — P2 structural, accessibility, responsive polish, ASI lows

Seven Opus workers in isolated worktrees, merged the same day. Gates: Go
suite against an isolated Postgres, tsc, eslint 0 errors.

- **Structural (drifted pairs → one artifact).** Offline route list is now
  generated from Go (`offline_routes.go` → `frontend/src/lib/offline-routes.generated.ts`)
  with a staleness test; CSRF Origin/Referer middleware on all mutating
  cookie-authenticated requests reusing the MCP origin check, plus a
  `chi.Walk` test asserting no mutating GET route (SEAM-021); migrations run
  under a signal-cancellable 15-minute context with the advisory lock always
  released (API-012); `AuthStatus.isAdmin` used instead of a second
  `/access/me` (SEAM-019); `HoneySale.tax/updatedAt/cancelledAt` + receipt
  tax line (SEAM-020); public story uses server-only `API_URL` and the
  leading-`YYYY-MM-DD` date rule (SEAM-022/023); 50/day/slug cap on anonymous
  customer signup (SEAM-024). DESIGN.md/README promises reconciled with code
  and pinned by `design-promises.spec.ts`: safe-area tokens are the single
  source, SectionNav `<Select>` vs scrollable in-page tabs documented, offline
  cached reads described accurately, conflict rows relabelled "Retry without
  overwriting" / "Discard my change".
- **Accessibility papercuts.** UX-018 table bulk-select keyboard-operable
  (`aria-selected`, Space/Enter, visible selected state); UX-019 urgency and
  queen-marking colour paired with text; UX-020 confirm on expense delete and
  type-to-confirm on API-token revoke; UX-021 dialog height respects safe-area
  insets; UX-022 sticky dialog footer for every form; UX-023 selection
  survives leaving bulk mode; UX-025: Split moved `x`→`t`, dev warning on
  shortcut collision, viewer-gated shortcuts in `?`, distinct nav labels,
  command palette listbox/option roles, skeleton action row, reduced-motion
  recording indicator, Android Back closes the dialog (history entry per
  dialog), and a full keyboard path for the apiary layout canvas (roving
  focus, arrow nudge in edit mode, Enter/Delete/Escape, live announcements).
- **Responsive field polish.** Touch targets ≥44 px via shared Button
  variants, scroll-snapping nav strips, wide tables wrapped or collapsed on
  small screens (see the `p2/responsive-polish` merge for the file table).
- **ASI lows.** All twelve re-verified in code (ASI-3-007/008/009/010/011,
  1-007/008/009/010, 5-008/009, 6-003) — already fixed 2026-08-11; two got
  pinning tests (base-URL allowlist, serial unlink on cancel). Plus
  `POST /bottling-runs/{id}/void` (one transaction, migration 00023) and the
  equipment ledger renamed "Equipment" in nav/titles.

Design notes as planned, preserved verbatim:

### Structural: make drifted list pairs one artifact

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

### Accessibility and correctness papercuts

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

### Responsive field polish

**Partially delivered 2026-08-04** — touch targets, empty states, and phone
layouts in apiaries, queens, and settings. Remaining gaps: sub-44 px targets,
horizontal navigation strips, and wide tables that do not fit small screens.
Substantially overlaps the "clunky" cluster above; do that first and re-scope
what is left.

### Remaining ASI low-severity findings

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

## Delivered 2026-08-18 — roadmap items 1–5 (Antigravity run), reviewed and patched 2026-08-19

Six feature branches merged 2026-08-18 (`2f82a82`…`f7fe99a`, follow-ups
through `28046bf`): colony/equipment sales and other hive products on one
`sales`/`sale_items` spine with an open `kind` (migrations 00015, 00020);
source-retained media — versioned transcripts, re-parse proposals,
lineage, pluggable photo originals with Immich (00017); Leaflet yard map,
elevation on the pin, per-stand/hive GPS, sun model (00018, 00021);
varroa program remaining (00016); treatment lockout, lot moisture,
Saturday yard queue (00019). Plus SSO-account password login.

Reviewed 2026-08-19 by six independent read-only reviewers. Confirmed
defects fixed the same day, with tests: sale created as `cancelled`
permanently sold the hive (now 400); no way to end a treatment so
lockout never cleared (PATCH `/treatment-events/{id}` + "Mark removed"
on the hive lockout card, `treatmentEventId` on lockout JSON); product
batches ignored lockout; propolis availability never decremented;
yard-queue "pull honey" used the latest inspection *with* stores≥4
(now latest inspection, 60-day bound, no harvest since); `treat_now`
rec never cleared after treatment; inspection edits dropped mite-count
transcript provenance; mite-count PATCH always 400 (client sent
`hiveId`); cross-apiary mite upsert via `inspectionId`; apply-reparse
creates skipped the hive role check and omitted `withdrawal_days`;
single-mode re-parse creates could not apply; Immich duplicate uploads
could later be force-deleted from the user's library; the Immich
library was browsable by viewers; Immich health probe had no timeout;
HEIC Immich originals got no renditions; sun model was ~13 days off
(Julian Day lacked the Gregorian correction, tz sign flipped); hive GPS
went stale on slot moves and the apiary pin was overwritten by the
stand centroid on every autosave; no lat/lng range validation; terrain
elevation not refreshed when the pin moved; an API token could set a
password on the account; usernames could shadow another user's email.
Remaining gaps are listed in the roadmap under "Shipped 2026-08-18 —
remaining gaps".

Design notes as planned, preserved verbatim:

### Yard map, georeferenced canvas, and sun — design notes as planned

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


### Source-retained media (cairn model) — design notes as planned

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


### Varroa program — design notes as planned

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


### Colony and equipment sales — design notes as planned

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


### Other hive products (creamed, hot honey, mead, propolis) — design notes as planned

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


## Delivered 2026-08-17 — review P0/P1 product fixes

The 2026-08-12 adversarial review backlog (UX / API / SEAM) plus the varroa
sticky-board chart bug. Go tests: `httpapi`, `config`, `auth`, `jobs` against
an isolated Postgres. Frontend eslint clean on the touched files.

- **Market day** reports sale failures inline and by toast (SEAM-001). Safe-area
  padding on the full-screen POS (UX-004). Offline 202 `{queued:true}` is no
  longer treated as a created sale (SEAM-006).
- **Service worker:** 401/403/409 no longer wedge the queue (SEAM-002); logout
  keeps the mutation queue (SEAM-003); honey/commerce paths queue (SEAM-004);
  retry keeps original `queuedAt` (SEAM-005); shell precache + navigate fallback
  (SEAM-007); body-less POSTs queue (SEAM-008); stale cache is marked
  (SEAM-009); queue capped at 200 (SEAM-010); 30-day items are not replayed
  (SEAM-011); DATA_CACHE LRU + caught `put` (SEAM-018). Banner prompts sign-in
  when `needsAuth`.
- **Layout:** `--bottom-nav-h` lifts banners and bulk toolbars (UX-002/003/005);
  sidebar at `lg:` (UX-006); expansion re-syncs on route change (UX-009); single
  apiary no longer hijacks Yards (UX-010); reports mobile select is
  report-to-report (UX-011); More nested targets 44 px (UX-013); one offline
  banner for connectivity, bottom banner only for queue work (UX-014); finance
  reports gated (SEAM-016).
- **Keyboard/forms:** dashboard `d/s/r` unarmed until arrow focus; `g` chords
  preventDefault (UX-001); combobox/menu typing ignored (UX-007); tab+filter
  in one replace (UX-008); chip-strip fade (UX-012); dirty inspection confirm
  (UX-015); first invalid field scrolls into view (UX-017).
- **Errors:** honey overview no longer skeletons/`$0.00` on failure (SEAM-012);
  App Router + public story error boundaries (SEAM-013); multipart 401 → login
  (SEAM-014); transcription poll surfaces failure (SEAM-015).
- **Backend:** singleton `user_settings` + advisory lock (API-001); setup
  checks complete before bcrypt and is rate-limited (API-003); offline receipts
  complete before the client sees the body (API-002); server timeouts + 1 MiB
  JSON cap (API-004); trusted-proxy RealIP (API-007); token `last_used_at`
  throttled (API-008); serialized bottling cap 500 (API-005); timeline/inspection
  limits clamped (API-006, SEAM-017); queen lineage authorized (API-009); money
  overflow rejected (API-010); transcribe TaskID + no overwrite of a complete
  transcript (API-011).
- **Varroa:** wash/roll rate chart is separate from board/visual mite counts.

Migration **00012** (`user_settings_singleton`) runs on API boot.

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
