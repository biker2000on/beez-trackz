# UI workflow review — 2026-09-04

Reviewed against production (`atlas.gentlebeeapiary.com`, image `d81d276`,
real data: 1 apiary, 16 hives, 8 harvest sessions, 0 lots, 348 pints on
hand) on a 1500px desktop and a 390px phone, plus the code behind each
screen. The question was the operator's: *the UI still feels disjointed;
make the workflow make sense for entering data.*

The short version: the seven-area map is right, and the ledgers, the hive
page and the market-day till are good. What is disjointed is everything
between them — the app shows a lot of *state* and very little *sequence*.
Each screen was designed as a read model with commands beside it, so the
operator has to know which screen holds the next step. The fixes below are
mostly about making the next step obvious and pre-filling what the app
already knows.

## 1. Findings, worst first

### F1. Today is a wall, not a plan (blocker on the phone)

`/today` renders one card per recommendation per hive. With 16 hives and
four generic rules (`Sample for mites`, `Check the feeder`, `Review
treatment`, `Seasonal prep` — `backend/internal/app/work/facts.go:116`) the
desktop page is 90 cards, and the phone page is a 26,000px scroll. Every
card carries its own Dismiss/Snooze, so "clearing" Today is 180 taps.
Nothing distinguishes a real observation (hive B1 not inspected in 122
days) from a rule that fires identically for every hive.

### F2. Data entry does not chain

The core production sequence is *pull supers → extraction session → harvest
lot → bottling run → jars sellable*, and the yard sequence is *inspection →
feeding/treatment → follow-up*. Neither is presented as a sequence:

- Two Jul 19 extraction sessions sit under "Extraction in progress" on the
  workbench while the Harvests list marks them **Finalized**. Neither
  screen offers "make a lot from this session".
- The overview says **1044.1 lb bulk on hand / awaiting bottling**; the
  workbench says **No bulk honey on hand** (bulk is per lot since the
  ledger cutover and prod has no lots). The operator sees two truths.
- Pints: **348 on hand, 348 reserved, 0 available**, so Market day shows
  "0 left" and the Sales workbench says "Nothing is available at the home
  location" with no explanation of what holds the reservation or how to
  release it.
- The lot dialog asked for season, region, elevation, bloom and story by
  hand although the apiary, the harvest sessions and the bloom log already
  hold them (being fixed in the prefill work landing with this review).

### F3. Duplicate surfaces and names

- Sidebar path **Production › Production › Lots & QR › Serial lookup** —
  the second "Production" is a section named after its parent. The
  Overview / Production toggle at the top of every production page repeats
  the sidebar again.
- Sales has a landing list and a Workbench, both headed **Sales**; Production
  has an Overview with "next actions" and a Workbench with numbered steps.
  Two competing "what next" pages per area.
- "Record sale" appears on the Production overview's quick-action strip
  (a Sales command) while "New harvest lot" does not.
- Admin lists the same person twice (local owner + OIDC identity) under
  "Apiary collaborators".

### F4. Landing pages hide the primary action

- `/yard`: no "Record inspection"; the recent-inspections list is not
  clickable; the incident log has the only button on the page.
- `/yard/hives` defaults to a card grid (the operator's stated preference
  is ledgers), with two empty promotional panels (Swarm & split readiness,
  Catch boxes) above the list. Cards show name/apiary/install date — none
  of the things you decide by (last inspection, queen status, stores, mite
  count).
- `/production/lots`, `/sales` workbench, `/equipment` are fine; `/insights`
  and `/today/recommendations` were not deep-reviewed.

### F5. Command chips read as filters

Workbench commands (`Start extraction day`, `Record sale`, `Transfer
stock`, `Add harvest entry`) are pale grey chips that look like filter
pills; the only strongly styled buttons on those pages are secondary
(Refresh, See bottling plan). The market-day till gets it right.

### F6. Small things that add up

- Hive notes render machine text (`[Obsidian identity:…; key=…]`).
- Every jar size shows a **Below par** badge because par is 6 and nothing
  is available; the badge stops meaning anything.
- The equipment area is fully seeded (17 types) but at zero stock, with no
  "count what you own" first-run prompt.
- Reserved quantities are never explained anywhere in the UI.

## 2. Recommendations

### R1. Turn Today into a plan (highest value, mostly backend)

1. **Aggregate rule-driven items per apiary**, not per hive. One card:
   "Mite sampling due — 16 hives at Lenoir" with a single action that opens
   the yard queue filtered to those hives. Observation-driven items (a
   specific overdue hive, a treatment off-date, an empty feeder that was
   actually seen) stay per hive.
2. **Cap Today at what fits a screen**: top three per group, "and 13 more"
   expands. The full list is the Yard queue.
3. **Rules need evidence before they fire.** "Sample for mites" for a hive
   with no mite history ever is a setup nudge, not a task; show it once as
   "Start a mite-sampling routine" and stop repeating it. Same for
   `Check the feeder` on feeders placed 700+ days ago: that is a
   never-closed feeding record, so the right item is "Close 16 stale
   feeding records" once.
4. Dismiss/Snooze move to the group; per-hive dismiss stays in the queue.

### R2. Chain the production sequence

1. On a **finalized session**, show "Create harvest lot from this session"
   (pre-selects its harvests, yard, pull date = session date); on the
   workbench "Extraction in progress" only shows sessions that are actually
   open, and finalized-but-unlotted sessions become step 2 "Sessions
   waiting on a lot".
2. **Unassigned bulk gets a row** everywhere bulk is shown ("1044 lb not yet
   in a lot — assign") so the two numbers agree and the fix is one click.
3. **Reservations get a sentence**: "348 reserved by consignment draw for
   Carolina Pedal Works" with a link to the thing holding them. Availability
   without the reason is a dead end.
4. After a bottling run, land on the jars view with "Sell on Market day"
   and "Transfer to consignee" as the two next actions.

### R3. One "what next" page per area, named for the area

- Production: keep the **Overview** (KPIs + next actions), fold the
  workbench's numbered steps into it, and drop the top toggle. The sidebar
  becomes Production › Overview / Harvests / Lots & QR / Jars / Hive
  products / Varietals / Activity. "Serial lookup" moves into Lots & QR as a
  search box, not a page.
- Sales: the list page becomes **Sales › Ledger**; the workbench is the
  area landing. Same shape as production.
- Quick-action strips list only that area's commands; cross-area commands
  are links ("Record a sale →").

### R4. Landing pages lead with the action

- `/yard`: primary "Record inspection" (opens the hive picker), secondary
  "Feed", "Treat"; the recent-inspections list is a ledger (clickable rows).
- `/yard/hives`: ledger by default, columns *Hive · Apiary · Last inspected ·
  Queen · Stores · Mites (last) · Open items*, row-click opens the hive; the
  swarm/catch-box panels collapse to a single line until they have content.
- Every landing page's primary button is filled (the `default` variant);
  commands on workbenches use `outline`, not the muted chip style.

### R5. Auto-fill everything derivable (in flight)

The lot dialog rework landing with this review (yard + pull date +
extraction date → season, region, elevation, year, bloom, varietal
suggestion, source harvests; AI-drafted story from the season's logs; the
floral claim's species = the varietal) is the pattern to repeat:

- Inspection form: default the inspector to the signed-in user, the date to
  today, weather from the apiary cache, and the previous inspection's
  frame counts as placeholders.
- Feeding: default the feed type and amount to the last feeding at that
  hive; treatment: default the product to the last one and compute the
  withdrawal window from Operation setup.
- Bottling run: default the jar size to the lowest-stock size, the lot to
  the oldest open lot.

### R6. Cleanups

Strip machine identity blocks from hive notes into a hidden field; make
"Below par" conditional on par being set explicitly; dedupe collaborator
identities into one person with two sign-in methods; add a first-run card
on Equipment ("Count what you own") that opens the physical count.

## 3. Suggested order

| # | Work | Why first |
|---|------|-----------|
| 1 | R1 Today aggregation + evidence gating | The phone view is unusable today; it is the field entry point |
| 2 | R5 lot dialog prefill + AI story (in flight) | Direct operator ask; establishes the auto-fill pattern |
| 3 | R2.1–R2.3 session→lot link, unassigned bulk row, reservation explanations | Removes the contradictions between overview, workbench and till |
| 4 | R3 area naming + single landing per area | Cheap, removes the "which page" confusion |
| 5 | R4 yard landing + hives ledger | Makes the yard as entry-friendly as production |
| 6 | R5 inspection/feeding/treatment defaults, R6 cleanups | Steady polish |

Items 1, 3 and 4 are each a one-day polyagent wave; 5 and 6 are smaller.
