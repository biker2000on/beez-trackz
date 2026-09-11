# Apiary Atlas: one operation, five useful workspaces

The frontend can be substantially more cohesive. The strongest redesign would organize the application around a beekeeper's work, carry context between that work, and give stock one consistent meaning everywhere. Changing the menu alone will not achieve this.

This proposal accompanies the [interactive UI concept](../ui-concept/atlas-cohesive-ui.html). The concept is a workflow simulator, not a production implementation: it does not provide actual microphone capture or replace the existing apiary canvas map.

## Review basis

The latest `main` was pulled before review: `dfa08ba`, also the version deployed on TrueNAS. This review combines current frontend source, the consolidated schema, and read-only production data. An authenticated browser session was unavailable, so this is a code-and-data review, not live visual or usability QA. Historical review reports have not been treated as evidence of current bugs.

The live operation contains one Lenoir apiary, 35 historical hives with 16 active, 126 inspections, eight extraction sessions, eight harvest lots, 16 bottling runs, and 96 sales, all paid. There are 17 equipment types, six jar item types, no active product catalog entries or product batches, and a Carolina Pedal Works consignment location. These facts argue for a compact, practical interface: field work and ordinary honey production should dominate; complex product manufacturing and debt collection should appear when relevant.

The equipment types have no movement records, and no packaging inventory items were found. That establishes missing inventory records, not verified absence of physical equipment or empty jars. The UI should say **Not counted yet** and offer an initial count, rather than confidently showing zero or announcing a physical shortage. Existing signed inventory balances also require location, reservation, and restriction context before they can be labeled available.

Eight historical extraction sessions must not become eight unfinished jobs. The present workbench query lists sessions without an open/closed filter, and the baseline has no session status. A redesigned active-work queue needs an explicit, defensible completion rule; history alone is not a backlog.

## Why it still feels disjointed

1. **Several screens compete to be the same home.** Production has a KPI dashboard, a link-card overview, and an actionable workbench, all titled Production. Sales has both a receipt register and a workbench. Users must learn which interpretation of the area contains their next task. See [Production dashboard](../../frontend/src/features/honey/honey-overview.tsx), [overview](../../frontend/src/features/honey/production-overview.tsx), and [workbench](../../frontend/src/features/workbench/production-workbench.tsx).
2. **Today is narrower than its promise.** Its copy says everything in front of you, but its implementation is the field slice. Bottling needs, equipment shortages, and commercial work have separate homes. See [Today](../../frontend/src/features/work/today-view.tsx).
3. **Navigation mixes dimensions.** Jars, Hive products, Varietals, Lots & QR, and Workbench mix physical stock, catalog, classification, tracing, and interface type. The nested Production → Production structure reinforces this ambiguity. See [navigation](../../frontend/src/components/shell/nav-items.ts).
4. **Stock has several interface identities.** Equipment presents aggregate cards, a table, and deployments; Production presents finished stock; Sales presents sellable stock at home; consignment presents stock elsewhere. These are useful views of related facts, but the user must reconcile them mentally. See [equipment](../../frontend/src/features/equipment/stock-view.tsx) and [sales workbench](../../frontend/src/features/workbench/sales-workbench.tsx).
5. **The workbench is not yet a continuous journey.** Stacked lists of extraction sessions, lots, bottling candidates, and jars do not show one batch progressing. A lot link can take the user to the complete lot register instead of that lot's detail. Numbering the sections does not carry the selected source forward.
6. **Forms expose the breadth of the application too early.** Record sale combines stock shelf, channel, payment, order status, jar rows, colony/equipment fields, product fields, customer, and lot. The capabilities are valuable; presenting them together makes an ordinary sale feel administrative. See [sale dialog](../../frontend/src/features/honey/record-sale-dialog.tsx).
7. **A visit is split among record types.** Inspection, feeding, equipment changes, and photos belong to one practical visit, but the hive screen distributes them among dialogs and routes. See [hive detail](../../frontend/src/features/hives/detail-page.tsx).

Existing strengths deserve preservation: contextual actions, explanations before blocked commands, explicit offline state, hive timelines, and previews of the consequences of selling a colony. The redesign should extend these patterns across the product.

## What the schema makes possible

The inventory foundation now joins item, location, lot, condition, and optional hive container. Signed movements belong to operations; reversals preserve history; draft reservations distinguish physical holdings from availability. Bottling connects bulk honey and packaging consumption to finished jars, with ancestry retained. See the [baseline schema](../../backend/internal/db/migrations/00001_baseline.sql) and [inventory service](../../backend/internal/app/inventory/service.go).

The UI can therefore explain one operation from several viewpoints without inventing different stock totals. A bottling receipt can link its source lot, packaging, and output. A colony sale can show which equipment goes with it. A consignment transfer can show a change of location before any sale occurs.

This does **not** mean every action already has a safe generic Undo button. Reversal controls must respect domain rules and later dependent work. Nor does it mean unified field observations already exist: inspection/visit unification and any combined-save orchestration are proposed product experiences that still need underlying work. A single atomic visit save is not an existing capability established by this review.

## Five navigation groups with clear ownership

These are **five groups, not five giant pages**. Distinct jobs retain distinct, visibly named pages. Do not hide pages behind tabs inside other pages or use nested tabs as primary navigation. Desktop navigation exposes destination links within each group; mobile provides a clearly labeled **Pages** menu/list with those same destinations. Each page has a stable URL and supports bookmarking, deep links, and browser Back/Forward.

| Home | Primary purpose | Main surface |
|---|---|---|
| Today | Decide what to do next across the operation | Prioritized work, grouped by practical context, with optional date and location filters |
| Apiaries | Understand colonies and conduct visits | Apiary roster, colony status, visit mode, and contextual history |
| Production | Turn harvests into finished goods | Active batches with stage, remaining material, requirements, and next action |
| Sales | Manage promises, fulfilment, and money | Orders with separate fulfilment and payment states; fast market mode |
| Stock | Know what exists, where it is, and what is usable | Named Equipment, Bulk honey, Packaging, and Finished goods pages with shared quantity semantics |

For example, Stock may expose `/stock/equipment`, `/stock/bulk`, `/stock/packaging`, and `/stock/finished`. Sales exposes Orders/register, Market day, Consignment, and Customers as named destinations. Production exposes Batches, Harvest history, and Lots where each serves a distinct job. These are illustrative route choices, not a mandatory route-renaming specification. Apiary Map/List switches and genuine status filters over the same data are appropriate view controls; they must not become a way to conceal different pages.

Insights and setup become secondary utilities. Catalogs, equipment types, bills of materials, and varietals remain available under setup or contextual management; they do not compete with daily work.

| Current destination | Proposed destination |
|---|---|
| Today, Recommendations, Yard queue | One Today work source, with a Field filter reused in visit planning |
| Yard dashboard, Apiaries, Hives, Queens | Apiaries group with named pages and full hive, equipment, and queen detail routes |
| Production dashboard, overview, workbench | One Production home; completed batches in History |
| Harvests, sessions, bottling, products | Named Batches and Harvest history pages, with contextual workflows |
| Jars, varietal balances, equipment stock | Named Stock pages: Equipment, Bulk honey, Packaging, and Finished goods; shared filters and semantics |
| Lots & QR, serial lookup | Named Lots destination, full lot detail, and global lookup |
| Sales register, sales workbench | Orders/register destination combining useful active work and searchable history |
| Market day | Named Market day page with specialized fast-selling controls |
| Consignment, Customers | Named Consignment and Customers destinations; linked location detail and settlement work |
| Expenses and finance reports | Money/reporting utility, linked from relevant operations |

## One interaction language, specialized working modes

Every workspace uses the same page anatomy: title and scope, one primary action, relevant work/list, contextual detail. Hive, lot, item, and order records have full routes. Substantial history, hive equipment, and queen work also require full destinations with visible navigation links. A record drawer can supplement these pages with a quick summary or action and an Open full record link; it cannot replace their navigation. Summary, activity, and related information should use readable sections or named destinations as appropriate, not another hierarchy of hidden tabs. Deep links preserve context.

Actions inherit context. A bottling action from a lot starts with that lot selected. A stock transfer begins with the selected item and source. A shortage on an order opens production planning with the required item and quantity carried forward.

Each action shows only the fields it needs, then a plain-language consequence preview, then a receipt with related-record links. The signature actions are **Record visit**, **Run batch**, and **Make sale**. This is a shared interaction pattern, not a generic everything form. Visit mode remains optimized for field recording; market mode remains optimized for quick sales.

## Three concrete journeys

The following quantities and scenarios are **hypothetical illustrations**, not claims about current production data.

### Inspect, feed, and add a super

1. Open Lenoir in Apiaries and start a visit from its canvas map or synchronized list. See its 16 active colonies, relevant alerts, and recent observations.
2. Tap a colony and begin dictation. Its previous inspection and current equipment remain visible while speaking today's findings; no keyboard entry is required on the normal visit path.
3. Dictate feeding and super changes alongside observations, then review the proposed fields and actions. Choose available equipment from storage without leaving the colony; speaking an intended action never executes it automatically.
4. Review, correct by voice or controls, re-record if needed, and explicitly confirm submission. See what was saved and its sync status, then advance to the next colony.
5. Finish with a visit summary: colonies inspected, unresolved concerns, materials used, and follow-up work. Preserve individual timestamps and the distinction between observations and actual actions.

### Bottle a lot and prepare stock for sale

1. In Production, open a batch with 40 lb of available bulk honey and select Bottle.
2. Choose 24 one-pound jars. Show the source honey, empty-container requirement, and expected output together. Surface any packaging shortage with the appropriate existing policy rather than silently treating it as sufficient stock.
3. Preview: consume 24 lb honey and the corresponding containers; create 24 packaged units; leave 16 lb in the source lot, assuming no separately recorded loss.
4. Record the run. Its receipt links source ancestry, output lot, labels, and Stock.
5. Select Move stock if the jars are heading to a market or consignee. Location transfer is visibly distinct from sale.

### Sell without losing stock context

1. Enter Market mode for an immediate sale, or create an order in Sales for a future commitment.
2. Choose the selling location and products. Show available quantities there; disclose reservations where relevant. Ordinary honey sales do not require opening colony-sale controls.
3. For a hypothetical 12-jar order with only eight available, show the four-unit shortage and offer the appropriate next action: source stock elsewhere or plan production. Do not imply that a draft was fulfilled.
4. Record fulfilment and payment as separate facts. A paid order can still need delivery; an invoiced delivery can still need payment.
5. For Carolina Pedal Works, distinguish stock sent, stock still held there, recorded sales, and settlement. The shared location detail provides continuity between Stock and Sales.

## Stock language that should stay precise

| Term | Meaning in the interface |
|---|---|
| On hand | Physical quantity recorded at the selected location and scope |
| Reserved | Quantity committed by applicable drafts/orders |
| Available | On hand minus applicable reservations at the selected scope; treatment restrictions appear separately as hold/block indicators |
| In field | Equipment assigned to colonies; not a synonym for missing stock |
| Condition | Ready, damaged, retired, or other supported state; distinct from location |
| Consigned | Stock held at a consignee; not automatically sold or collected revenue |
| Lot | Traceable source/output identity; not a separate kind of inventory |
| Adjustment | A recorded correction with reason and history, not an unexplained overwritten total |

Avoid adding unlike units into a hero metric. Equipment totals should help locate shortages by type; honey needs weight; jars need size/product and quantity. A location filter must visibly scope the figures. Explain the reservations that make available differ from on hand. Show treatment holds and other action restrictions separately, without implying that the inventory availability calculation subtracts them.

Traceability must distinguish missing records from established origin. Where imported or historical stock lacks ancestry, display **Origin not recorded** and offer a correction path; do not invent a hive, harvest, or source lot to complete the visual chain.

## Non-negotiable acceptance requirements

These requirements are part of the initial redesign, not optional enhancements or a later mobile phase. They apply across **Today, Apiaries, Production, Sales, and Stock**.

**Visible page navigation is also a hard requirement:** all distinct destinations must be discoverable as desktop links and in the labeled mobile Pages list, retain their own URLs, and work with browser history. No nested-tab navigation or drawer-only substantial records.

### Phone-first across the entire application

- Verify every workspace and its forms at 320 px, 390 px, and 768 px viewport widths. Navigation, filters, details, receipts, and primary actions must remain usable without unintended page-wide horizontal scrolling. A map can pan inside its own viewport.
- Provide at least 44 × 44 px touch targets for interactive controls and at least 16 px text in mobile inputs. Preserve comfortable desktop density without shrinking mobile controls.
- Respect device safe areas. Drawers, dialogs, and bottom actions must fit the visible viewport, scroll independently where needed, and remain reachable when the software keyboard is open. Focused inputs and confirmation controls must not disappear behind it.
- Keep inventory keyboard entry, numeric input, physical counts, and existing useful keyboard workflows. Voice is a priority for field work, not a reason to make stock entry slower.

### Preserve the real apiary canvas map

The existing canvas map is a required operational surface. Retain hive placement, stands, orientation, zoom, and pan, plus the current view/edit lock, stand-grid and hive creation, zoom controls, fit, saved state, tile layer and imagery opacity, sun overlay, and location-setting controls. Map and list must share selection and refer to the same hive; switching views cannot discard visit context. Tapping a hive must make starting dictation immediate. An illustrative map in the concept is not acceptance evidence for preserving the actual canvas behavior.

### Voice-first field entry

- Preserve the current recorder, audio-upload, transcription/review workflow, and multi-hive batch voice walkthrough. Improve their integration rather than replacing them with a text box or a decorative microphone.
- Provide dictation for relevant form entry throughout the redesign, especially inspection notes and field observations. Freeform speech should propose structured inspection fields while retaining the original account. Follow the application's current retention policy for original transcript and audio; do not silently discard them or invent a new retention policy.
- The normal inspection visit must be completable without typing: map/list selection → dictate → review → submit → next hive. Review must support voice correction or re-recording as well as accessible controls; keyboard editing remains available.
- Clearly mark uncertain or missing interpretations for review. Do not present low-confidence values as established observations. Users explicitly review and confirm before submission; AI interpretation never automatically applies treatments, moves equipment, records a sale, or performs another consequential action.
- Show distinct states for **Recording**, **Awaiting transcription**, **Review needed**, **Saved**, and **Synced**, plus actionable failure/retry states. A recording is not a saved inspection, and a pending local record is not a completed server sync.
- Preserve existing supported queue/retry behavior and implement recoverable offline capture as needed for the field workflow. The current recorder uploads audio and polls a service; this review has not established durable offline audio persistence today. Offline capture persistence and recovery must therefore be verified or implemented, not claimed as inherited capability. Do not promise offline AI transcription. When transcription requires connectivity, explain that it is pending and allow the user to resume safely after reconnection without losing captured work or duplicating submission.

### Required regression journeys

At 320 px, 390 px, and 768 px, verify **named page → full record → Back → Forward → refresh bookmarked URL** preserves the destination and record context. Verify every distinct destination appears in visible desktop navigation links and in the labeled mobile Pages list; no destination may depend on discovering a hidden tab or opening a drawer first.

1. At each target viewport, open the actual apiary map, pan/zoom, select a hive, switch to the list and back, and confirm placement and selection are preserved.
2. Complete **map → dictate inspection → review uncertain fields → correct/re-record → explicitly submit → next hive** without keyboard entry. Verify the selected hive, saved values, original account under current retention policy, and submission status.
3. Complete an existing multi-hive voice walkthrough and audio-upload review. Verify that observations remain attached to the intended hives and nothing applies before confirmation.
4. Interrupt connectivity during supported capture/submission paths; verify honest pending states, recoverable retry, and no duplicate records after reconnection. Transcription must not claim to have run offline unless that capability is actually implemented and verified.
5. Complete bottling and a sale on a phone, including consequence review and receipt; confirm safe-area and keyboard behavior. Complete an inventory count using normal keyboard/numeric entry.

## Visual rules

- Use compact operational rows for repeated records, with cards reserved for a small number of genuinely distinct summaries.
- Keep title, scope, primary action, filters, and selected-record detail in predictable positions.
- Use one dominant action per task. Reveal unusual actions in context instead of presenting six equal-weight buttons everywhere.
- Use neutral surfaces with restrained honey/amber branding. Reserve warning and danger colors for meaningful conditions; do not color every domain differently.
- Give quantities aligned columns and explicit units. Keep implementation terms such as ledger, projection, and source command out of routine screen copy.
- Preserve useful density on desktop. On mobile, show the task's next step and essential facts, with large field controls and explicit save/sync status.
- Empty states should reflect the actual operation. With no active product catalog, advanced product batches should not occupy a large empty primary panel.

## Priorities by user impact

1. **Establish one home per workspace and one all-domain Today, phone-first from the start.** Remove competing overview/workbench choices and make their useful capabilities part of the main experience. The map and voice acceptance requirements apply to this initial work and every following priority.
2. **Carry context across the three signature journeys.** Visit, bottle, and sell should feel continuous, with consequences and receipts linking their records.
3. **Unify Stock and availability language.** Make location, reservation, condition, and ancestry understandable wherever quantities appear.
4. **Replace broad dialogs with focused actions and consistent detail surfaces.** Preserve fast visit/POS modes while reducing routine administrative choices.
5. **Apply the visual system and bring secondary capabilities into context.** Reports, labels, catalogs, genealogy, and advanced production remain accessible without competing for attention.

Success should be judged by practical walkthroughs: can a beekeeper finish a visit from the real canvas map without typing, including reviewed equipment changes; bottle a selected lot without reselecting its source; explain a stock discrepancy; and fulfil an order on a phone without reconciling several screens? Those outcomes and the required regression journeys matter more than reducing route count or preserving the current frontend structure.
