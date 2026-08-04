# Adversarial Review — UX/Tab Structure & Inventory/Honey (gnucash-web readiness)

Reviewed 2026-08-03 against the live Go + Next stack (`backend/`, `frontend/`).
Scope: navigation/tab overload, whether Equipment Inventory and Honey Inventory
are "proper" inventories, and readiness for the P1 gnucash-web integration
(`docs/product-roadmap.md:99-112`).

---

## Part 1 — UX/UI: the tab problem, quantified

### The numbers

| Metric | Value |
|---|---|
| Top-level nav items (desktop) | 9 (7 for non-admin) |
| Total tab triggers app-wide | 28 across 5 `<Tabs>` instances |
| Max tabs on one strip | 9 (`/hives/[id]`) |
| Max tab targets on one route | **11** (`/harvest`: 7 tabs + 4 nested Business tabs) |
| Tab strips with URL state | **0** — every strip is `defaultValue`-only |
| Max depth to a leaf view | 4 (nav → tab → nested tab → dialog) |
| Orphan routes | 1 (`/transcribe` — fully built, zero inbound links) |

### Finding 1.1 — `/harvest` is three applications wearing one tab strip

The Honey hub mixes three fundamentally different work modes as sibling tabs:

- **Browsing/records**: Activity, Jars, Harvests, Sales, Lots & QR
- **A transactional POS**: Market day (cart, checkout, end-of-day reconciliation)
- **Back-office reporting**: Business, which is itself 4 nested tabs
  (Profitability, Expenses, Bottle next, Customers & wholesale)

A point-of-sale flow inside a tab is a modal task inside a browsing container:
mid-sale, one stray tab click discards the cart context. The Business tab is
four report pages hiding behind a second-level tab strip with no URLs.
Reaching the customer list is sidebar → Honey → Business → Customers &
wholesale → dialog — four levels, none linkable.

On top of the 11 tab targets, the hub header carries 6 quick-action dialog
buttons (`j s u l v a`) and 4 stat cards — ~15 interactive targets before any
content.

**Recommendation.** Split `/harvest` per the roadmap's own P1 item
(roadmap:69-78), which this review confirms and sharpens:

- `/harvest` → overview page: stat strip, next-action prompts (bulk awaiting
  bottling, low stock, unpaid orders), recent activity. Keep the quick-action
  dialogs here.
- Keep at most 2–3 peer tabs for records (e.g. Activity | Jars). Promote to
  sub-routes: `/harvest/harvests`, `/harvest/lots`, `/harvest/sales`.
- `/harvest/market-day` as a dedicated full-screen route (it's phone-first
  POS; it deserves its own chrome and exit confirmation).
- Business reports merge into `/reports` (see 1.3) or become
  `/harvest/business/*` sub-routes. Nested tabs are eliminated entirely.

### Finding 1.2 — `/hives/[id]`: 9 tabs, 4 of which are filtered copies of tab 1

The Timeline tab already merges inspections, feedings, treatments, mite
counts, queen events, harvests, splits, and moves. Tabs Inspections,
Feedings, Splits, and History are *filtered subsets of Timeline*. That's four
tabs of navigation cost for data the first tab already shows, and it pushes
distinct content (Varroa, Equipment, Photos, Queen) into an
overflow-scrolling strip on mobile.

**Recommendation.** Timeline (default, with type filter chips replacing the
four subset tabs) | Health (Varroa + inspections summary) | Equipment |
Queen | Photos. 9 → 5, nothing lost — filter chips on the timeline replace
the subset tabs. The 8-button action row above the tabs should collapse to
2–3 primary actions + an overflow menu.

### Finding 1.3 — Financial numbers live in three places, on two nav items

Revenue/profit appears in the `/harvest` stat strip, in `/harvest` →
Business → Profitability, and in `/reports` → Apiary economics. Honey yield
appears in `/reports` and twice inside `/harvest`. Worse, the numbers
*disagree by design* (see Part 2: overview revenue includes unpaid
draft/pending orders; market-day reconciliation splits paid vs. due).

**Recommendation.** One home for reporting: `/reports` absorbs
Profitability, Expenses, Bottle next, and Season economics. `/harvest` keeps
only operational stats (on-hand, unpaid orders). One revenue definition,
labeled (collected vs. invoiced).

### Finding 1.4 — No tab state in URLs anywhere

Every `Tabs` uses `defaultValue`. Consequences: no deep links, back button
skips tab context, and returning from `/harvest/sessions/[id]` or a receipt
always dumps the user on the Activity tab regardless of where they came
from. If any tabs survive the restructure, they must read/write a search
param. (Converting workflows to sub-routes solves this for free.)

### Finding 1.5 — Mobile silently amputates the app

The bottom nav shows 5 of 9 items with no "More" overflow, and the dropped
set differs by role (admins lose Queens and Inventory; non-admins lose
Recommendations and Reports). Those pages are unreachable on mobile except
via command palette or typed URLs — for a field-first product, Inventory
being unreachable on the phone contradicts the roadmap's own field-first
goals.

**Recommendation.** 5th slot becomes "More" (sheet with the remaining
items), or reduce top-level nav so it fits (see 1.8).

### Finding 1.6 — Orphans and duplicates

- `/transcribe` (batch voice transcription, ~180 lines + review flow) has no
  nav entry and zero inbound links. Either link it (obvious home: a button on
  `/apiaries/[id]` or the dashboard) or delete it.
- Two independent Deploy-equipment UIs (inventory page + hive Equipment tab)
  and four independent hand-rolled "bulk select mode" toggles on four pages —
  consolidation candidates.
- Nav labels don't match routes: "Queens" → `/genealogy`, "Honey" →
  `/harvest`. Rename routes (or labels) — this leaks into shortcuts, docs,
  and support conversations.
- Keyboard shortcut `s` means Split (hive detail), Record sale (honey), and
  Settings (after `g`) — fine individually, but the collision set is growing
  with every page.

### Finding 1.7 — Settings is one page with 5 accordions; roadmap wants Equipment out

Settings is fine structurally (single page, collapsible cards), but
Jar sizes is operational configuration living next to AI keys. When the
Honey overview gains a "manage sizes" affordance, jar sizes should move with
it. (Equipment already escaped Settings — good.)

### Finding 1.8 — Suggested end-state navigation

- **Yards** (apiaries, canvas, flora, forecast)
- **Hives**
- **Honey** (overview → harvests / lots / sales / market-day sub-routes)
- **Inventory** (equipment)
- **Reports** (survival, yield, economics, profitability, expenses)
- **More/Settings** (queens/genealogy could live under Hives or stay top-level)

That's 6–7 top-level items — fits the mobile bottom nav without amputation.

---

## Part 2 — Inventory & honey: not yet a "proper inventory"

The one genuinely right thing: **jar counts are a derived, append-only
ledger** (`honey_movements` + sale items), and the sale path locks rows and
enforces availability correctly (`routes_honey.go:748-803`). That core is
worth keeping. Everything around it undermines it.

### Finding 2.1 — The "append-only" ledger has a hard-delete API

`DELETE /honey/movements/{id}` and `DELETE /honey/sales/{id}` hard-delete
ledger rows (`routes_honey.go:495-511`, `1021-1037`). No tombstone, no
reversing entry, no record of who/when. The schema comment says append-only;
the API contradicts it. Meanwhile the *proper* void mechanism —
`order_status='cancelled'` — is unreachable after creation: `PATCH` rejects
it (`routes_honey.go:949-952`) even though creation accepts it. So the only
way to void a sale is to destroy the evidence.

**Fix.** Reversing entries (or soft-delete with actor + reason) for
movements; allow transition to `cancelled` on sales; remove hard deletes
from the API. This is the single biggest blocker for accounting sync.

### Finding 2.2 — No actor, no history, anywhere

No inventory or commerce table records `created_by`. `honey_sales` has no
`updated_at` at all, yet `PATCH` mutates `amount_paid`, `order_status`,
`payment_method` in place — a payment can go from $60 to $0 with zero trace.
Harvest-session true-up overwrites the authoritative extracted weight with
no prior value kept (negative values accepted). `app_users` exists
(migration 00003) — the columns just were never added.

### Finding 2.3 — Same quantity stored twice, eight ways to drift

The audit found 8 pairs of duplicated state that nothing reconciles. The
worst:

1. **`bottling_runs.quantity` ⟷ mirrored `honey_movements` row**, linked
   only by a text `reason` string ("bottling run LOT-CODE"), no FK. Delete
   the movement and the lot still shows the jars. A run without a
   `jarSizeId` creates *no* movement — jars exist on the lot page and
   nowhere in inventory.
2. **Two different `bulkOnHandLbs` formulas live in production**:
   `/honey/overview` sums stored `amount_lbs`
   (`routes_honey.go:1162`); `/honey/production-plan` recomputes from
   `quantity × honey_oz/16` (`routes_commerce.go:1398-1400`). They disagree
   whenever `honey_oz` was null at jarring time or has since been edited —
   editing a jar size retroactively rewrites history on one endpoint only.
3. **`equipment_stock.total_owned` ⟷ Σ adjustments** — kept in sync only by
   application code; no constraint, no reconciliation view.
4. `harvest_lots.honey_weight_lbs` is free-typed, never validated against
   linked harvests; `honey_sales.total_amount` is never re-derivable checked
   against its items.

**Fix.** One formula for bulk-on-hand (a shared query/view). FK from the
jarring movement to its bottling run. Either derive `total_owned` from the
adjustment ledger or add a reconciliation check.

### Finding 2.4 — Negative stock is the norm, not the exception

Only `POST /honey/sales` validates availability. Give-aways, jarring, bulk
use/loss, bottling runs, equipment deployment, and equipment adjustments all
accept quantities that drive stock negative — the UI even styles negative
on-hand in red as an expected state. Jarring 500 lbs with 3 lbs of bulk on
hand succeeds silently.

**Fix.** Extend the sale path's lock-and-validate pattern (it's already
written) to give-away, jarring (vs. bulk), bottling (vs. lot weight and
bulk), and deployment (vs. available). Keep `jar_adjustment` unbounded —
that's its job.

### Finding 2.5 — Jar-size deactivation is an invisible write-off

`honeyJarInventoryWithQuerier` filters `WHERE js.is_active`
(`routes_honey.go:1105`). Deactivating a size with jars on hand silently
removes them from on-hand, dashboard totals, inventory value, and low-stock
alerts — while their sales still count as revenue. An untracked inventory
write-off via a settings toggle.

### Finding 2.6 — Serialized traceability is write-only

`jar_serials` are generated and counted but no endpoint looks one up, and
serials link to nothing downstream (no `sale_id`). The roadmap marks
"Harvest lots, jar runs…" as **Shipped**, but jar→extraction-run
traceability does not exist at the data level. The roadmap overclaims here;
either finish it (serial lookup endpoint + link serials to sales) or drop
serial generation until then.

### Finding 2.7 — Equipment inventory vs. the roadmap's own bar

Roadmap (lines 82-87) asks for owned/deployed/available/needed/damaged/
retired with ledger actions. Current state:

- **Return** can't do partial quantities, records no reason/condition, and
  calling it twice silently overwrites the first return date (no
  `AND date_removed IS NULL` guard, `routes_equipment.go:598-599`).
- **Damaged/retired** exist only as adjustment reasons that decrement
  `total_owned` — no state, no loss reporting.
- **Needed** doesn't exist. **Cost** doesn't exist (can't record what a box
  cost — also blocks any equipment asset value for accounting).
- **Bulk-adjust is exactly the "opaque quantity edit"** the roadmap bans:
  reason `'other'`, note "bulk edit", and unresolvable rows silently skipped
  (`routes_equipment.go:504-507`).
- `equipment_stock.type_id` isn't unique — the same type can be split across
  multiple stock rows, making per-row "available" meaningless.

### Finding 2.8 — Money is floating point everywhere

Every monetary column is `double precision`; every Go handler uses `float64`
and compares with `==`/`>`. `amountPaid > totalAmount` can reject a valid
payment on a 1e-13 artifact, and balances will never net to exactly zero
against gnucash's fixed-point amounts.

**Fix (pre-sync hard requirement).** Integer cents (or `numeric`) for all
money columns and handlers. One migration, painful later, cheap now.

### Finding 2.9 — Revenue recognition & period integrity

- Overview `totalRevenue` includes draft/pending (unpaid) orders; market-day
  reconciliation splits paid vs. due — the two surfaces will not agree.
- Inventory value is computed at **retail price**, not cost. COGS is a
  year-blended average recomputed at read time; deleting one expense
  retroactively changes every break-even and lot margin for the year.
- Date-only inputs parse in server-local time into `timestamptz`, analytics
  bucket with `EXTRACT(YEAR …)` in DB-session timezone — a Dec 31 sale can
  change fiscal years depending on deployment config.
- Nothing locks a reconciled market day; closed numbers stay editable.

### Finding 2.10 — gnucash-web readiness scorecard (vs. roadmap:99-112)

| Requirement | Status |
|---|---|
| Stable external IDs | UUIDs ✔, but no `external_id`/sync columns |
| Idempotent sync | Idempotency middleware exists but **excludes every honey/commerce/equipment route** |
| Account/category/tax mappings | Categories are DDL CHECK strings; **tax fields don't exist** |
| COGS→revenue traceability | Cost attached to nothing; blended read-time average |
| Never silently overwrite qty/value | Violated by hard deletes, traceless PATCH, true-up, deactivation write-off |
| Complete audit trail | No actor, no history, no reversing entries |
| Money precision | All float64 |

### Recommended order of attack

1. **Money to integer cents** + `updated_at`/`created_by` on all commerce
   and inventory tables (schema-only, do it before more data accumulates).
2. **Kill hard deletes**: reversing entries for movements, reachable
   `cancelled` for sales, soft-delete + reason elsewhere.
3. **One bulk-on-hand formula**; FK bottling runs ↔ movements; fix jar-size
   deactivation to block (or explicitly write off) remaining stock.
4. **Negative-stock validation** reusing the sale path's pattern.
5. **Equipment**: unique `type_id`, partial/guarded returns, damaged/retired
   states, physical-count flow to replace bulk-adjust, optional unit cost.
6. Then, and only then, the sync layer: `external_sync` mapping table
   (entity, external_id, account mapping, last_synced, conflict state),
   extend idempotency middleware to commerce routes.

### Housekeeping

- The repo still contains the entire legacy Next.js stack at root `src/`
  (plus root `drizzle/`, Dockerfile, etc.). It confuses tooling, agents, and
  reviews (this one included). Archive or delete it.
- `docs/product-roadmap.md` marks several features Shipped whose data-level
  substance is missing (serial traceability §2.6; "sales channels" are a
  CHECK column, orders have no lifecycle beyond a status field). Worth
  re-labeling to Partially shipped so the roadmap stays trustworthy.
- Dangling ends: `PATCH /harvest-lots` and `PATCH /customers` have no UI;
  `useLowStock` hook + `low_stock_threshold` column have no surface;
  wholesale price lists can be created but not applied from the sale dialog.
