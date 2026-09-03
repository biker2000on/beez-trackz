# Workflow and application architecture reset — roadmap P1 item 10

**Status:** binding design for item 10. Produced by the wave-1 design-and-
inventory pass (Polyagent run `20260903-item10-wave1-bz01`), pinned to
`abdd2a7`. No application code changed in this wave; this document plus
`docs/plans/2026-09-03-route-rename-map.md` are its whole output, and the
implementation waves in §7 are the contract they execute against.

**Binding inputs.** `docs/product-roadmap.md` §"P1 — Workflow and application
architecture reset"; `polyagent-review-2026-09-01.md` (the ~15 straddling
flows); `docs/plans/2026-09-01-inventory-ledger-design.md` (the ledger is
live — hives are containers at the virtual `deployed` location, quantities
come only from `inventory_available`/`inventory_balances`, commands go through
`backend/internal/app/inventory`); `backend/internal/app/doc.go` (the numbered
application-layer conventions already in force).

**Method.** Every claim below was checked against the tree at `abdd2a7` and
cites `file:line`. Where the roadmap's 2026-09-01 corrections and the code
disagree, the code wins and the disagreement is called out in §0.

---

## 0. Where the roadmap and the code disagree

| # | Roadmap / review says | Code at `abdd2a7` says | Resolution |
|---|---|---|---|
| D1 | "Freeze `/hives/{id}` and public `/honey/{slug}` as eternal URLs, or the no-redirect rule bricks every printed hive QR label" (`polyagent-review-2026-09-01.md`, workflow/application-reset bullet 1) | The generator is live — `target := AppURL + "/hives/" + id` (`backend/internal/httpapi/routes_field_intelligence.go:625`) — and the print surface is `frontend/src/features/apiaries/hive-labels-page.tsx:230`; but the operator states no label has ever been printed | The **roadmap's later operator decision wins**: `/hives/{id}` is not frozen. It is renamed with everything else and `hiveTagQR` is updated in the same change. Only `/honey/{slug}` is an external contract. |
| D2 | "Preferences are admin-gated today, so 'My Preferences' as a per-user surface is an access change, not a rename" | `PreferencesSection` is inside the `isAdmin` block (`frontend/src/features/settings/settings-view.tsx:52-59`) — correct so far — **but** `user_settings` has no `user_id` column and is read `LIMIT 1` (`backend/internal/db/migrations/00001_baseline.sql:2003-2031`; `backend/internal/httpapi/routes_settings.go:141,281,334`) | It is **not** merely an access change. Per-user preferences need a new per-user table (§6.4). The roadmap understates this. |
| D3 | "the offline mutation manifest … only changes if application commands change endpoint URLs" | True for UI renames, **but** `/honey/sales` is a live *API* alias registered alongside `/sales` precisely so queued offline mutations keep working (`backend/internal/httpapi/routes_honey.go:45-52`), and both are in the manifest (`backend/internal/httpapi/offline_routes.go:55-56`) | Retiring the `/honey/*` **API** alias is a separate, later decision from retiring the `/honey/*` **UI** routes. §1.4 keeps the API alias through the route rewrite and retires it in wave 7, after one offline-receipt TTL window. |
| D4 | "harvest-session *create* is deliberately excluded" from offline queueing, via `POSTExclusions` | The exclusion is achieved by the rule's trailing slash (`offline_routes.go:42`, `{Prefix: "/api/v1/harvest-sessions/"}`), so `POST /api/v1/harvest-sessions` never matches a rule at all; the `POSTExclusions` entry at `offline_routes.go:83` is dead code | Intent right, mechanism wrong. Wave 4 makes the exclusion explicit (rule without trailing slash + a live exclusion) so a future prefix edit cannot silently open it. |
| D5 | "there is no breadcrumb component (the command palette synthesizes crumbs from `NAV_ITEMS`)" | Correct: `flattenNavRoutes` builds `breadcrumbs` (`frontend/src/components/shell/nav-items.ts:363-378`) and the palette joins them with `›` (`frontend/src/components/shortcuts/provider.tsx:288-297`) | No roadmap change. The palette *is* the breadcrumb surface and is rewritten by rewriting `NAV_ITEMS`. |
| D6 | "the nav item 'Equipment' lives at `/inventory`" | Correct (`frontend/src/components/shell/nav-items.ts:151-168`) | Resolved in §2.3: the UI area is `/equipment`; "inventory" survives only as backend/DB ledger vocabulary. |
| D7 | Not stated anywhere | `commerceSlugReserved` (`backend/internal/httpapi/routes_commerce.go:77-85`) omits `varietals`, yet `frontend/src/app/(app)/honey/varietals/page.tsx` exists — a lot slugged `varietals` is silently shadowed by the authenticated route and its public Honey Story is unreachable | A live latent bug that the `/honey/*` evacuation in §2.3 fixes by construction. Flagged so it is not reintroduced if the evacuation is descoped. |
| D8 | "Dashboard … mixes the work list with status/history/reporting widgets" | Correct, and larger than stated: `DashboardView` also owns an action-center keyboard controller (`frontend/src/features/dashboard/dashboard-view.tsx:139-198`, armed-row guard at `:53-60`) that must survive the move to Today | The keyboard contract is part of Today's acceptance criteria (§7 wave 2). |
| D9 | Roadmap: mobile is "four role-dependent pins plus More" | Confirmed exactly: `MOBILE_PRIORITY` (`nav-items.ts:380-392`) → `primaryMobileItems` filters by role and `.slice(0, 4)` (`nav-items.ts:394-402`); admin gets Home/Yards/Hives/Honey, a viewer gets Home/Yards/Hives/Queue | No change. §2.2 keeps the mechanism and only changes the list. |

---

## 1. Route and entry-point inventory

### 1.1 Frontend routes

Every `page.tsx` under `frontend/src/app`. "Role gating today" is what the code
actually does: the frontend only *hides* nav entries — there is no route guard,
no `middleware.ts`, and no per-page gate except `AdminReportGate`
(`frontend/src/features/operations/reports-nav.tsx:53-63`). Enforcement is
server-side (`requireAdmin`, `backend/internal/httpapi/middleware.go:236-245`;
`apiaryRole` `:247`; `requireHiveParamRole` `:373`).

| Current path | Kind | Consumers beyond `NAV_ITEMS` | Role gating today | Proposed canonical path |
|---|---|---|---|---|
| `/` | redirect to `/dashboard` (`src/app/page.tsx:4`) | — | anon | redirect to `/today` |
| `/login` | page | SW `SHELL` (`sw.js/route.ts:27`); `offline.spec.ts:52` | anon | `/login` (unchanged) |
| `/setup` | page | `login/page.tsx` | anon | `/setup` (unchanged) |
| `/offline` | page | SW `SHELL` (`sw.js/route.ts:26`) | anon | `/offline` (unchanged) |
| `/dashboard` | page | `SHELL:28`; `CALM_ROUTES` (`install-prompt.tsx:35`); `MOBILE_PRIORITY` (`nav-items.ts:381`); manifest `start_url` (`manifest.ts:9`); `sidebar.tsx:83`; `error.tsx:44`; `offline/page.tsx:24`; `apiaries/overview-tab.tsx:126`; `login/page.tsx:63,87`; `transcription/batch-review.tsx:130`; **`backend/internal/httpapi/routes_auth.go:573`** (the OIDC success redirect, `AppURL + "/dashboard"`); e2e `design-promises:120`, `offline:54` | all | **`/today`** |
| `/operations/yard-queue` | page | `SHELL:29`; `CALM_ROUTES:36`; `MOBILE_PRIORITY:386`; `dashboard-view.tsx:37`; `operations/yard-queue.tsx:135`; e2e `design-promises:121`, `offline:55` | all | **`/yard/queue`** |
| `/apiaries` | list | `CALM_ROUTES:37`; `MOBILE_PRIORITY:382`; manifest shortcut (`manifest.ts:22`) | all | `/yard/apiaries` |
| `/apiaries/[id]` (plus `?tab=layout`) | detail | `contextualNavRoutes` (`nav-items.ts:246-247`); palette (`provider.tsx:313-320`); e2e `navigation:161-167,226` | membership | `/yard/apiaries/[id]` |
| `/apiaries/[id]/flora` | page | contextual nav `:248` | membership | `/yard/apiaries/[id]/flora` |
| `/apiaries/[id]/photos` | page | contextual nav `:249`; `?tab=photos` target (e2e `navigation:167`) | membership | `/yard/apiaries/[id]/photos` |
| `/apiaries/[id]/labels` | print tags | contextual nav `:250`; renders `/api/v1/hives/{id}/tag/qr` (`hive-labels-page.tsx:230`) | membership | `/yard/apiaries/[id]/labels` |
| `/apiaries/[id]/bulk` | bulk record | contextual nav `:251` (`requiresEdit`) | editor | `/yard/apiaries/[id]/bulk` |
| `/apiaries/[id]/timeline` | page | in-app link | membership | `/yard/apiaries/[id]/timeline` |
| `/hives` | list | `CALM_ROUTES:38`; `MOBILE_PRIORITY:383`; manifest shortcut (`manifest.ts:29`); e2e `a11y-bulk-select:72,98,116`, `navigation:263` | all | `/yard/hives` |
| `/hives/[id]` (plus `?tab=timeline|health`) | detail | contextual nav `:264-274`; palette `:334-341`; **`yard_queue.go:104,169,212,265`** builds hrefs for four item kinds; `dashboard-view.tsx:174` (`router.push`); `hiveTagQR` target (`routes_field_intelligence.go:625`); e2e `navigation:169-175,226-228` | membership | `/yard/hives/[id]` |
| `/hives/[id]/equipment` | page | contextual nav `:272` | membership | `/yard/hives/[id]/equipment` |
| `/hives/[id]/queen` | page | contextual nav `:273`; e2e `navigation:174` | membership | `/yard/hives/[id]/queen` |
| `/hives/[id]/photos` | page | contextual nav `:274` | membership | `/yard/hives/[id]/photos` |
| `/hives/[id]/transcribe` | voice inspection | contextual nav `:276-280` (`requiresEdit`) | editor | `/yard/transcribe?hive=[id]` (S10) |
| `/queens` | page | `NAV_ITEMS:215`; `MOBILE_PRIORITY:390` | all | `/yard/queens` |
| `/genealogy` | **redirect to `/queens`** (`genealogy/page.tsx:8`) | `CALM_ROUTES:39` — stale, see §1.5 | all | **deleted** |
| `/transcribe` | voice walkthrough | `NAV_ITEMS:68`; contextual nav `:254`; `apiaries/detail-page.tsx:153` | editor | `/yard/transcribe` |
| `/recommendations` | inbox | `CALM_ROUTES:42`; `MOBILE_PRIORITY:389`; `dashboard-view.tsx:39`; `needs-attention-widget.tsx:55`; `todays-actions-widget.tsx:51`; **`yard_queue.go:166`** (hive-less rec href) | all | **`/today/recommendations`** |
| `/honey` | overview | `SHELL:30`; `CALM_ROUTES:40`; `MOBILE_PRIORITY:384`; `section-nav.tsx:27`; e2e `honey-gaps:116`, `navigation:181`, `design-promises:124` | admin nav (`nav-items.ts:88`) plus `requireAdmin` (`routes_honey.go:28`) | **`/production`** |
| `/honey/activity` | ledger timeline | `NAV_ITEMS:92`; `section-nav.tsx:29`; e2e `navigation:188,243` | admin | `/production/activity` |
| `/honey/production` | production overview | `NAV_ITEMS:97`; `section-nav.tsx:32` | admin | `/production/overview` |
| `/honey/harvests` | page | `NAV_ITEMS:108`; `section-nav.tsx:35` | admin | `/production/harvests` |
| `/honey/sessions/[id]` | harvest session | `NAV_ITEMS:103` (`matches`); palette `:363` | admin | `/production/sessions/[id]` |
| `/honey/lots` | lots and QR | `NAV_ITEMS:122`; links to public `/honey/{slug}` (`commerce/lots-tab.tsx:136`); `commerce/serial-lookup.tsx:144` | admin | `/production/lots` |
| `/honey/serials` | serial lookup | `NAV_ITEMS:127`; `commerce/lots-tab.tsx:77`; `commerce/sale-serials.tsx:84` | admin | `/production/serials` |
| `/honey/jars` | jar stock | `NAV_ITEMS:109` | admin | `/production/jars` |
| `/honey/products` | hive-product catalog | `NAV_ITEMS:112` | admin | `/production/products` |
| `/honey/varietals` | varietal rollup | `NAV_ITEMS:117`; **absent** from `commerceSlugReserved` (D7) and from `HONEY_SECTIONS` matches (§1.5) | admin | `/production/varietals` |
| `/honey/market-day` | **redirect to `/sales/market-day`** | `SHELL:31`; `section-nav.tsx:47`; e2e `design-promises:123`, `honey-gaps:126`, `offline:58` | admin | **deleted** |
| `/honey/sales` | **redirect to `/sales`** | none in-app | admin | **deleted** |
| `/honey/sales/[id]` | **redirect to `/sales/[id]`** | none in-app | admin | **deleted** |
| `/harvest` plus `/harvest/{activity,harvests,jars,lots,market-day,production,products,sales,serials}` plus `/harvest/sales/[id]` plus `/harvest/sessions/[id]` | 12 redirect shims to `/honey/*` | **zero in-app consumers** (verified: only their own files match) | admin | **deleted** |
| `/sales` | orders | `SHELL:32`; `MOBILE_PRIORITY:385`; `sales-section-nav.tsx:13` | admin | `/sales` (unchanged) |
| `/sales/[id]` | receipt | palette `:352` | admin | `/sales/[id]` |
| `/sales/market-day` | POS | `SHELL:33`; `section-nav.tsx:47,64`; `sales-section-nav.tsx:19,33`; e2e `design-promises:125` | admin | `/sales/market-day` |
| `/sales/consignment` | list | `NAV_ITEMS:150`; `sales-section-nav.tsx:14` | admin | `/sales/consignment` |
| `/sales/consignment/[id]` | location detail | in-app link | admin | `/sales/consignment/[id]` |
| `/inventory` | equipment stock | `CALM_ROUTES:41`; `MOBILE_PRIORITY:387`; `dashboard/frame-shortage-widget.tsx:23` | admin (`nav-items.ts:159`) | **`/equipment`** |
| `/inventory/types` | types and BOMs | `NAV_ITEMS:164` | admin | `/equipment/types` |
| `/reports` | directory | `CALM_ROUTES:43`; `MOBILE_PRIORITY:388`; `dashboard-view.tsx:38`; `reports-nav.tsx:19`; e2e `navigation:198` | all | **`/insights`** |
| `/reports/outcomes` | group landing | `reports-nav.tsx:32` | all | `/insights/outcomes` |
| `/reports/survival`, `/reports/yield` | reports | `reports-nav.tsx:21-22,34-35` | all | `/insights/survival`, `/insights/yield` |
| `/reports/finance` | group landing | `reports-nav.tsx:37`; e2e `navigation:205,229` | admin | `/insights/finance` |
| `/reports/economics`, `/reports/profitability` | reports | `reports-nav.tsx:23-24,41-42` | admin | `/insights/economics`, `/insights/profitability` |
| `/reports/expenses` | **CRUD editor** (add and delete expenses, `commerce/business-reports.tsx:379-410`) | `reports-nav.tsx:25,43` | admin | **`/sales/expenses`** (S11) |
| `/reports/sales-planning` | group landing | `reports-nav.tsx:47` | admin | `/insights/sales-planning` |
| `/reports/bottling` | report | `reports-nav.tsx:26,49` | admin | `/insights/bottling` |
| `/reports/customers` | **CRUD editor** (customers plus wholesale price lists, `commerce/business-reports.tsx:646-672`) | `reports-nav.tsx:27,49` | admin | **`/sales/customers`** (S12) |
| `/settings` | accordion catch-all, 12 sections | `NAV_ITEMS:231`; `MOBILE_PRIORITY:391` | mixed, see §6 | split into `/me`, `/admin/setup`, `/admin` |
| `/honey/[slug]` | **public Honey Story**, outside the `(app)` group | QR target `writeHoneyStoryQR` (`routes_commerce.go:1238-1239`); `commerce/lots-tab.tsx:136`; palette `:375` | anonymous | **`/honey/[slug]` — frozen, unchanged** |

Eleven top-level `NAV_ITEMS` destinations (`nav-items.ts:41-232`), of which
Honey (`:88`), Sales (`:142`) and Equipment (`:159`) are `adminOnly` — a viewer
sees eight. The roadmap's count is exact.

### 1.2 Mobile pins, More, and the command palette

`MOBILE_PRIORITY` (`nav-items.ts:380-392`) is an ordered list of eleven hrefs;
`primaryMobileItems` role-filters and takes the first four (`:394-402`);
`overflowMobileItems` puts the rest behind More (`:404-410`). Today:

- admin: Home, Yards, Hives, Honey (plus More)
- viewer or editor: Home, Yards, Hives, Queue (plus More)

The command palette (`frontend/src/components/shortcuts/provider.tsx`) is
generated: route commands from `flattenNavRoutes(NAV_ITEMS)` labelled
`breadcrumbs.join(" > ")` (`:288-297`), per-apiary and per-hive contextual
commands (`:305-345`), and three record kinds with hardcoded hrefs —
`/sales/${sale.id}` (`:352`), `/honey/sessions/${session.id}` (`:363`), and
`/honey/${lot.publicSlug}` (`:375`, the public story). Rewriting `NAV_ITEMS`
rewrites every route command and every synthesized crumb; `:352` and `:363` are
the only manual edits and `:375` must **not** change.

### 1.3 PWA manifest, service worker, install prompt

| Surface | file:line | Current | Proposed |
|---|---|---|---|
| `start_url` | `frontend/src/app/manifest.ts:9` | `/dashboard` | `/today` |
| shortcut "Apiaries" | `manifest.ts:22` | `/apiaries` | `/yard/apiaries` |
| shortcut "Hives" | `manifest.ts:29` | `/hives` | `/yard/hives` |
| shortcut "Honey harvest" | `manifest.ts:36` | `/honey` | `/production` |
| SW `SHELL` precache | `frontend/src/app/sw.js/route.ts:25-37` | `/offline`, `/login`, `/dashboard`, `/operations/yard-queue`, `/honey`, `/honey/market-day`, `/sales`, `/sales/market-day` plus 3 icons | `/offline`, `/login`, `/today`, `/yard/queue`, `/yard/hives`, `/production`, `/sales`, `/sales/market-day` plus 3 icons |
| `CALM_ROUTES` | `frontend/src/components/install-prompt.tsx:34-44`, checked at `:229` | `/dashboard`, `/operations/yard-queue`, `/apiaries`, `/hives`, **`/genealogy`** (dead), `/honey`, `/inventory`, `/recommendations`, `/reports`; missing `/queens` and `/sales` | derived from the `NAV_ITEMS` roots plus `/today/recommendations`, so it cannot go stale again |

`SHELL` is pinned by two specs: `design-promises.spec.ts:114-128` slices the
literal `const SHELL = [` block and requires eight route strings, and
`offline.spec.ts:52-59` requires five by `toContain`. Both fail CI if `SHELL`
changes without them. `honey-gaps.spec.ts:126` navigates to
`/honey/market-day`, today a redirect landing on `/sales/market-day`.

The SW queues by `X-Offline-Mutation-ID` (`sw.js/route.ts:62-64`) and stamps
`X-Beez-Cache: stale` on cache-served API responses (`sw.js/route.ts:400`) —
and **nothing reads it**: the only other match in the tree is the assertion at
`offline.spec.ts:68`, and `frontend/src/lib/api.ts` reads only `content-type`
off the response (`api.ts:108`). Freshness UI therefore starts from zero
(§4.5).

### 1.4 Offline mutations (`backend/internal/httpapi/offline_routes.go`)

The manifest is API prefixes, not UI paths, and is generated into
`frontend/src/lib/offline-routes.generated.ts` by
`TestOfflineRouteManifestMatchesFrontend`. Complete inventory:

| Rule (`offline_routes.go`) | Methods | Owner area after the reset | Notes |
|---|---|---|---|
| `/api/v1/inspections` `:33` | POST PUT PATCH DELETE | Yard | |
| `/api/v1/feedings` `:34` | all | Yard | covers `/{id}/refill`, `/close`, `/empty` (`routes_feedings.go:22-29`) — the Today and Yard inline commands |
| `/api/v1/bloom-observations` `:35` | all | Yard | |
| `/api/v1/mite-counts` `:36` | all | Yard | |
| `/api/v1/treatment-events` `:37` | all | Yard | lockout inputs |
| `/api/v1/queen-events` `:38`, `/api/v1/queens` `:39` | all | Yard | |
| `/api/v1/photos/` `:40` | all | Yard | |
| `/api/v1/canvas/` `:41` | all except `POST /canvas/hives` (`:82`) | Yard | |
| `/api/v1/harvest-sessions/` `:42` | all | Production | trailing slash excludes create — D4 |
| `/api/v1/harvest-entries/` `:43` | all | Production | |
| `/api/v1/recommendations/` `:44` | all except `POST /recommendations/run` (`:84`) | Today | `/recommendations/state` **is** queueable |
| `/api/v1/harvests` `:49` | all | Production | |
| `/api/v1/honey/jarring` `:50`, `/honey/bulk-movements` `:51`, `/honey/give-away` `:52`, `/honey/jar-adjustments` `:53`, `/honey/movements/` `:54` | all | Production | |
| `/api/v1/honey/sales` `:55` **and** `/api/v1/sales` `:56` | all | Sales | duplicate registration (`routes_honey.go:45-52`); see D3 |
| `/api/v1/jar-sizes` `:57` | all | Operation Setup | |
| `/api/v1/expenses` `:58`, `/api/v1/customers` `:59` | all | Sales | S11, S12 |
| `/api/v1/harvest-lots` `:60` | all | Production | |
| `/api/v1/wholesale-price-lists` `:61` | all | Sales | |
| `/api/v1/products` `:62`, `/api/v1/product-batches` `:64` | all | Production | |
| `/api/v1/propolis-harvests` `:63` | all | Production | |
| `/api/v1/hives/bulk` `:65` (exact) | all | Yard | |
| `/api/v1/hives/` `:66` | all except DELETE | Yard | |
| `/api/v1/apiaries/` `:67` | PUT | Yard | |
| `/api/v1/splits/` `:68` | DELETE | Yard | |
| `/api/v1/ops/labor/start` `:69`, `/stop` `:70` | POST | Yard | S4 |
| `/api/v1/equipment/stock/` `:77` | POST | Equipment | receive, adjust, damage, repair, retire |
| `/api/v1/equipment/physical-count` `:78` | POST | Equipment | |
| `/api/v1/equipment/deployments` `:79` | POST | Equipment | hive-side deploy, S7 |

**Gaps that block the roadmap's own offline acceptance criterion**, verified
against `offlineRouteManifest.supports` (`offline_routes.go:112-133`):

1. `POST /api/v1/harvest-sessions` (start an extraction session) is not
   queueable (D4). A field-day "start extraction" work item cannot declare
   `offline: queueable` until this is revisited.
2. `POST /api/v1/equipment/deployments/{id}/return` is covered by the
   `/equipment/deployments` prefix, but `POST /api/v1/equipment/stock` (create
   a stock row) is deliberately not — deploying gear that does not yet exist
   cannot be completed offline.
3. Queueability is a **global API-prefix allowlist**: it cannot express "this
   command, for this actor, on this record". The WorkItem contract's
   per-command `offline` disposition (§4.4) is therefore computed *from* this
   manifest rather than independently, and the manifest must gain the entries
   above before the corresponding work items may advertise offline commands.

### 1.5 Already dead or already wrong entry points

- The twelve `/harvest/*` shims have zero in-app consumers. Free deletion.
- `/genealogy` has one consumer and it is the stale `CALM_ROUTES` entry
  (`install-prompt.tsx:39`), which can never match: the route is a server
  redirect that never renders at that pathname.
- `CALM_ROUTES` omits `/queens` and `/sales`, so the install prompt never
  offers itself on two calm pages.
- `HONEY_SECTIONS` (`features/honey/section-nav.tsx:25-42`) omits
  `/honey/varietals` from Production's `matches`, so the section menu
  de-highlights there, while `NAV_ITEMS` (`nav-items.ts:117`) does include it.
  Two nav trees, one already drifted.

---

## 2. Target information architecture

### 2.1 The seven desktop areas

Area membership becomes **machine-checkable**: the first path segment of every
authenticated route names its owning area. That is what turns the roadmap's
acceptance criterion ("route, palette, cache and e2e consumers contain no
retired internal paths") into a grep rather than a review.

| Area | Root | Contains | Role |
|---|---|---|---|
| Today | `/today` | the WorkItem projection at its default filter; `/today/recommendations` (reason and status filter plus triage history) | all |
| Yard | `/yard` | `/yard/queue`, `/yard/apiaries[/...]`, `/yard/hives[/...]`, `/yard/queens`, `/yard/transcribe` | all, with per-apiary membership enforced server-side |
| Production | `/production` | `/production` (workbench), `/overview`, `/activity`, `/harvests`, `/sessions/[id]`, `/lots`, `/serials`, `/jars`, `/products`, `/varietals` | admin |
| Sales | `/sales` | `/sales` (workbench), `/sales/[id]`, `/market-day`, `/consignment[/...]`, `/customers`, `/expenses` | admin |
| Equipment | `/equipment` | `/equipment`, `/equipment/types` | admin |
| Insights | `/insights` | `/insights`, `/outcomes`, `/survival`, `/yield`, `/finance`, `/economics`, `/profitability`, `/sales-planning`, `/bottling`, `/compliance`, `/reconciliation` | all; finance and sales-planning children keep `adminOnly` |
| Admin | `/admin` | `/admin` (Admin and Integrations), `/admin/setup` (Operation Setup) | admin |

Plus one non-area, per-user surface: **`/me`** — My Preferences, reached from
the account menu, not from the area rail. It is not an eighth area; it is the
user's own settings, and it is available to every authenticated user (§6).

`visibleNavRoutes` (`nav-items.ts:286-302`) keeps working unchanged: Production,
Sales, Equipment and Admin carry `adminOnly: true`, and Insights' finance and
sales-planning children keep theirs. Yard's per-apiary filtering stays where it
already is — server-side in `apiaryRole` (`middleware.go:247`) and
`requireHiveParamRole` (`:373`).

### 2.2 Mobile

`MOBILE_PRIORITY` becomes `["/today", "/yard", "/production", "/sales",
"/equipment", "/insights", "/admin"]`, still role-filtered and sliced to four
with More fifth (`primaryMobileItems`, `nav-items.ts:394-402`). Resulting bars:

- admin: **Today / Yard / Production / Sales** plus More (Equipment, Insights, Admin)
- viewer or editor: **Today / Yard / Insights** plus More

This satisfies both mobile caveats: Production and Sales keep `adminOnly`, and
Yard — where Saturday work starts — is pinned second for every role and can
never be pushed off by an admin-only area.

### 2.3 The `/inventory` naming collision, and evacuating `/honey/*`

**Decision.**

1. The Equipment area is **`/equipment`**. The UI path `/inventory` is retired
   entirely; no route, nav label, or search keyword uses the word "inventory"
   for hive gear. The keyword string `"equipment gear stock inventory"`
   (`nav-items.ts:161`) drops its last word.
2. The word **inventory keeps exactly one meaning in this codebase: the
   quantity ledger**, and it lives only in the backend and the database —
   `inventory_items`, `inventory_locations`, `inventory_lots`,
   `inventory_operations`, `inventory_movements`, `inventory_balances`,
   `inventory_available`, and `backend/internal/app/inventory`. The rule is
   directional and testable: *no path under `frontend/src/app` may contain the
   segment `inventory`, and no user-facing string may use the word except when
   describing the ledger itself.* The API already agrees — the equipment UI
   calls `/api/v1/equipment/*` throughout
   (`frontend/src/features/equipment/hooks.ts:41-409`) — so only the UI route
   and the nav keyword change.
3. All **authenticated** honey routes move to `/production/*`. The public Honey
   Story namespace stays exactly where it is
   (`frontend/src/app/honey/[slug]/page.tsx`), and because nothing else lives
   under `/honey` any more, the reserved-slug guard `commerceSlugReserved`
   (`routes_commerce.go:77-85`, called at `:667` and `:798`, pinned by
   `routes_commerce_test.go:82-83`) is **deleted** — taking the latent
   `varietals` shadowing bug (D7) with it. This is the collision-free option
   the roadmap names, and the only one that makes the reserved list
   unnecessary rather than longer.

### 2.4 Owner decisions for the straddling flows

One owner each, with the evidence that forces the call. A work item owned by
one area may invoke another area's command — that is what the projection's
`commands[]` is for — but an operational object gets exactly one editor.

| # | Flow | Straddles | **Owner** | Rationale |
|---|---|---|---|---|
| S1 | Harvest-ready "Pull honey" (`yard_queue.go:218-268`) | Yard / Production | **Yard** item, **Production** command | The observation is a hive inspection (`stores_honey >= 4`, `yard_queue.go:229`), so the item belongs to the yard visit; its command starts a Production harvest session. |
| S2 | Treatment lockout (`lockout.go:277-346`, surfaced at `yard_queue.go:108-120`) | Yard / Production | **Yard** | The fact is a treatment event on a hive. Production and Sales consume it as a *refusal*, not as a work item, and that refusal moves with the chokepoint into the app-layer guards (`app/production/service.go:34` `runGuards`). |
| S3 | Record sale (`honey/quick-actions.tsx:41,129`, mounted from `honey-overview.tsx:81`, `section-nav.tsx:60` and `sales-section-nav.tsx:30`; POS at `commerce/market-day-tab.tsx:63`) | Production / Sales | **Sales** | Three entry points, one command. `HoneyQuickActions` loses `sale`; Production keeps jar, bulk, loss, give-away and adjust. Market Day stays the phone-first POS and `/sales` is the desktop entry. |
| S4 | Labor start and stop (`settings/labor-control.tsx`, mounted at `operations/yard-queue.tsx:62` **and** as a Settings accordion at `settings-view.tsx:101-107`) | Admin / Yard | **Yard** for the control, **Operation Setup** for the enable flag | `labor_tracking_enabled` sits on the singleton `user_settings` (`00001_baseline.sql:2020`) — an operation policy, not a per-user preference. The timer itself is yard work. |
| S5 | Compliance packet (`settings/compliance-section.tsx`; `GET /ops/compliance-packet`, `routes_ops.go:35-36`) | Admin / Insights | **Insights** at `/insights/compliance` | It is a generated report over hives, treatments, lots, sales and withdrawal windows. Nothing about it is configuration. |
| S6 | GnuCash reconciliation status (`settings/gnucash-section.tsx`; `routes_gnucash_sync.go`) | Admin / Insights | **split cleanly**: credentials, book and cursor to Admin and Integrations; the *reconciliation report* to `/insights/reconciliation` | Configuration and its output are different objects; only the configuration is dual-homed today, and it keeps one editor. |
| S7 | Hive-side equipment deploy (`hives/equipment-tab.tsx` and `equipment/inventory-view.tsx` both `POST /equipment/deployments`, `equipment/hooks.ts:166`) | Yard / Equipment | **Equipment** owns the command; **Yard** hosts a contextual invocation | One command (`app/equipment/service.go:156` `Deploy`) with two call sites is fine; two *editors* are not. The hive page keeps the deploy dialog and loses the stock-management table. |
| S8 | Feeding surfaces (`dashboard/feeding-status-widget.tsx`, `dashboard/feeding-actions.tsx`, hive timeline, `yard_queue.go:187-213`) | Today / Yard | **Today** projection with a Yard filter | Feeding rows are work items. The standalone dashboard widget is deleted; `/yard/hives/[id]?tab=timeline&view=feedings` remains the record view. |
| S9 | Hive products catalog (`/honey/products`, `features/honey/products-page.tsx`) | Production / Sales | **Production** | Creamed honey, hot honey, mead and propolis tincture are *made*; their batches are operations (`app/production/products.go:33` `RecordBatch`). Sales sells them from the same catalog read model. |
| S10 | Voice walkthrough and voice inspection (`/transcribe` apiary-scoped, `/hives/[id]/transcribe` hive-scoped) | Yard / Yard | **Yard**, one surface: `/yard/transcribe?apiary=...` or `?hive=...` | Two routes, one feature (`features/transcription/*`). Collapsing them removes the duplicate nav entries at `nav-items.ts:68` and `:276`. |
| S11 | Expenses editor (`commerce/business-reports.tsx:379-410`, routed at `/reports/expenses`) | Insights / — | **Sales** at `/sales/expenses` | It is a CRUD editor with add and delete, not a report, so it cannot live in a read-only area. Sales is the money-in and money-out area and the other GnuCash feed. *This widens the roadmap's Sales charter; see §8.1.* |
| S12 | Customers and wholesale price lists (`commerce/business-reports.tsx:646-672`, routed at `/reports/customers`) | Insights / Sales | **Sales** at `/sales/customers` | Also a CRUD editor (customer dialog, price-list dialog). Insights keeps reorder-due and wholesale-margin figures as read-only panels that link here. |
| S13 | Jar sizes and packaging (`settings/jar-sizes-section.tsx`, `jar_sizes.packaging_type_id`, equipment types) | Admin / Production / Equipment | **Operation Setup** owns the catalog; Production links contextually | One catalog, one editor. Packaging *stock* stays in Equipment; the *size definition* is setup. |
| S14 | Treatment withdrawals (`settings/treatment-products-section.tsx`; `PATCH /treatment-products/{id}`, `routes_operations.go:41`) | Admin / Yard | **Operation Setup**, with a contextual link from the lockout work item | A policy table feeding `lockout.go`; it has no contextual manage link today, which is why it is invisible where it matters. |
| S15 | Frame shortage and equipment recommendations (`dashboard/frame-shortage-widget.tsx:23` links `/inventory`; generated by `internal/recs/rules.go`) | Today / Equipment | **Today** item, **Equipment** command and detail | It is a recommendation, so it is a work item like any other; the widget is deleted and the row links to `/equipment`. |
| S16 | Lots, QR and serial lookup (`/honey/lots`, `/honey/serials`; `commerce/sale-serials.tsx:84` links from a receipt) | Production / Sales | **Production** | Traceability is a production fact. Sales receipts deep-link into it; they do not own it. |
| S17 | Print hive tags (`/apiaries/[id]/labels`; QR from `routes_field_intelligence.go:612-633`) | Yard / Equipment | **Yard** | The tag identifies a hive at a stand, not a piece of stock. |
| S18 | Consignment settlement (`stockApplySettlement`, `routes_stock_locations.go:1788`, 276 lines) | Sales / Insights | **Sales** | Settlement is a sale-side command (`app/sales/consignment.go:151` `RecordSettlementShrink`); Insights reports the resulting margin. |

---

## 3. Journey walkthroughs

Each journey has exactly one starting point. "Command" names the application
command the screen invokes after wave 3; the HTTP route it reaches today is
given where the command does not yet exist.

### 3.1 Field day (Saturday) — starting point **`/today`** on the phone

1. `/today` — `GET /api/v1/work/today`. Attention items first, then the visit
   checklist. Inline commands resolve rows in place:
   `POST /feedings/{id}/refill`, `POST /feedings/{id}/close`,
   `POST /recommendations/state` — all queueable
   (`offline_routes.go:34,44`).
2. Tap **Yard** to `/yard/queue` — `GET /api/v1/work/yard`, the *same*
   projection grouped by apiary. Precached in `SHELL`.
3. Tap a hive item to `/yard/hives/[id]` (timeline tab) and record work:
   `POST /inspections`, `POST /mite-counts`, `POST /treatment-events`,
   `POST /feedings` — all queueable (`offline_routes.go:33,36,37,34`).
4. A lockout item explains itself here from `lockout.go` evidence, with a
   contextual link to `/admin/setup#treatment-withdrawals` (S14).
5. A "Pull honey" item (S1) offers **Start extraction**,
   `POST /harvest-sessions` (`routes_harvest_sessions.go:101`). **Blocked
   offline today** (D4, §1.4 gap 1); until wave 4 changes the manifest the item
   declares `offline: "online_only"` and the button disables with that reason
   shown.
6. Voice: `/yard/transcribe?hive={id}` then confirm —
   `handleTranscriptionConfirm` (`routes_transcriptions.go:470`, 220 lines) to
   `app/field.ConfirmTranscription` (§5.4 row 6).

No screen in this journey lies outside Today and Yard.

### 3.2 Production run — starting point **`/production`**

1. `/production` — the production workbench: open sessions, bulk on hand by
   lot, lots awaiting bottling, jar stock below par.
   Read model `GET /api/v1/production/workbench` (§4.8).
2. **Start session** to `/production/sessions/[id]`:
   `POST /harvest-sessions` (`routes_harvest_sessions.go:101`).
3. Add per-hive entries: `POST /harvest-sessions/{id}/entries`
   (`hsAddEntry`, `routes_harvest_sessions.go:386`, 157 lines), which writes
   `harvest` operations through `inventory.Service.Record`
   (`app/inventory/service.go:33`).
4. True up the extracted total: `POST /harvest-sessions/{id}/true-up`
   (`routes_harvest_sessions.go:544`) to
   `production.Service.CheckHarvestResidual`
   (`app/production/harvest_sessions.go:115`).
5. **Create the lot** at `/production/lots`: `POST /harvest-lots`
   (`harvestLotCreate`, `routes_commerce.go:623`, 129 lines) to
   `production.EnsureHarvestLot` (`app/production/catalog.go:308`) and
   `SetLotCeiling` (`app/production/harvest.go:27`). The lockout guard (S2)
   refuses a locked-out harvest here, inside the command.
6. **Bottle**: `POST /honey/jarring` (`honeyRecordJarring`,
   `routes_honey.go:246`, 188 lines) or a bottling run (`bottlingRunCreate`,
   `routes_commerce.go:929`, 184 lines) to `production.Service.RecordBottling`
   (`app/production/bottling.go:47`), which draws bulk from the lot and
   packaging from Equipment inside one `app.UnitOfWork`
   (`app/production/bottling.go:156` `packagingDraws`).
7. Finished stock appears at `/production/jars`, read from
   `inventory_available` — the same numbers `/sales/market-day` sells from. No
   module boundary is crossed to follow hive to harvest to lot to bottling to
   finished stock.

### 3.3 Sale and consignment settlement — starting point **`/sales`**

1. `/sales` — the sales workbench: today's takings, drafts with their
   shortfalls, consignment locations with stock out, settlements due.
   Read model `GET /api/v1/sales/workbench` (§4.8).
2. Market day at `/sales/market-day` (precached; the offline-critical screen):
   `POST /sales` (`honeyRecordSale`, `routes_honey.go:1278`, **411 lines**, the
   longest handler in the tree) to `sales.Service.Apply`
   (`app/sales/apply.go:41`), which reserves, consumes and reverses through the
   inventory service.
3. Consignment shipment at `/sales/consignment/[id]`:
   `sales.Service.Transfer` (`app/sales/consignment.go:45`).
4. Settlement on the same screen: `stockApplySettlement`
   (`routes_stock_locations.go:1788`, 276 lines) to
   `sales.Service.RecordSettlementShrink` (`app/sales/consignment.go:151`).
5. Receipt at `/sales/[id]`; serials deep-link to
   `/production/serials?serial=...` (S16).
6. Money out and customers live in the same area: `/sales/expenses` (S11) and
   `/sales/customers` (S12).
7. Margin and reconciliation stay read-only in Insights:
   `/insights/profitability`, `/insights/reconciliation` (S6).

### 3.4 Equipment task — starting point **`/equipment`**

1. `/equipment` — stock by type, condition and location from
   `inventory_balances`; deployed gear appears at the virtual `deployed`
   location keyed by `container_hive_id`
   (`docs/plans/2026-09-01-inventory-ledger-design.md` §2.1 amendment A1).
2. Receive: `POST /equipment/stock/{id}/receive` (`equipment/hooks.ts:231`) to
   `equipment.Service.Receive` (`app/equipment/service.go:55`). Queueable
   (`offline_routes.go:77`).
3. Deploy to a hive: `POST /equipment/deployments` (`equipment/hooks.ts:166`)
   to `equipment.Service.Deploy` (`app/equipment/service.go:156`). Also
   invocable from `/yard/hives/[id]/equipment` (S7) — the same command.
4. Return: `POST /equipment/deployments/{id}/return` to
   `equipment.Service.Return` (`app/equipment/service.go:183`).
5. Damage, repair, retire and condition change:
   `equipment.Service.Adjust` (`:103`) and `ConditionChange` (`:133`).
6. Physical count: `POST /equipment/physical-count`, queueable
   (`offline_routes.go:78`).
7. Types and BOMs at `/equipment/types`: `equipment.SetComponents`
   (`app/equipment/bom.go:202`) with the 00054 cycle guard
   (`app/equipment/bom.go:164` `CheckBOMCycle`).

The frame-shortage work item (S15) enters this journey at step 1 from `/today`.

### 3.5 Admin setup — starting point **`/admin`**

1. `/admin` (Admin and Integrations): users and access
   (`features/access/access-section.tsx`), API tokens and MCP, AI providers,
   photo storage, ntfy, GnuCash credentials, system health.
2. `/admin/setup` (Operation Setup): jar sizes (S13), treatment withdrawals
   (S14), the labor-tracking enable flag (S4), plus contextual links to honey
   varietals and equipment types in their owning areas.
3. `/me` (My Preferences, every authenticated user): theme, date format, units,
   temperature unit, default apiary, password login, install app, *your* apiary
   access and *your* API tokens.
4. Worked example, enabling GnuCash sync: `/admin` then GnuCash, enter book URL
   and token (`routes_gnucash_sync.go`), run a reconcile, read the result at
   `/insights/reconciliation`. Configuration in one place, its output in
   another, neither duplicated.

---

## 4. The WorkItem contract

### 4.1 What replaces what

| Today | Fate |
|---|---|
| `useFieldWork` (`frontend/src/features/dashboard/hooks.ts:158-189`) — a client-side assembler over `/recommendations` and `/feedings/status` splitting into `attention` and `today` | **Deleted.** Today reads `GET /work/today`. |
| `yardQueue` (`backend/internal/httpapi/yard_queue.go:35-303`, 269 lines) — a server-side assembler over lockouts, recommendations, feeding status and harvest-ready, with no stable item ids and an `asOf` (`:300`) that is never rendered | **Deleted.** `GET /work/yard` is the same projection grouped by apiary. |
| The recommendations inbox (`frontend/src/features/recommendations/recommendations-view.tsx`; routes `routes_recommendations.go:16-27`) | The *inbox view* is deleted. `/today/recommendations` is a filter (`sourceType=recommendation`) plus triage history over the projection. The recommendation **domain** and its state endpoints stay — they are the source commands. |
| `FieldItem` (`hooks.ts:86-108`) | Superseded by `WorkItem` (§4.2), which is a superset. |
| Dashboard status, history and reporting widgets — `hive-overview-widget`, `frame-shortage-widget`, `honey-summary-widget`, `feeding-status-widget`, `recent-inspections-widget`, and the `REPORTS` link list (`dashboard-view.tsx:36-40`) | Relocated *before* Today ships: hive overview to `/yard`; frame shortage to a work item (S15) plus `/equipment`; honey summary to `/production`; feeding status to work items (S8); recent inspections to `/yard`; the report links to `/insights`. |
| The action-center keyboard controller (`dashboard-view.tsx:139-198`: arrows move, Enter opens the hive, `d`/`s`/`r` resolve; armed-row guard `:53-60`; reveal effect `:200-215`) | **Preserved verbatim** on Today, retargeted at `commands[]` instead of the two hardcoded kinds (D8). |

### 4.2 The projection

```jsonc
{
  "id": "wi:feeding:9f1c...",        // stable projection id, §4.3
  "sourceType": "feeding",           // feeding | recommendation | lockout | harvest_ready
  "sourceId": "9f1c...",             // the durable row the item is about
  "context": {
    "apiaryId": "...", "apiaryName": "North Ridge",
    "hiveId": "...",   "hiveName": "A3",
    "locationId": null               // set for Production and Sales items
  },
  "title": "Verify and close",       // the action, imperative
  "evidence": [                      // why; never advice without a fact
    { "text": "Feeder on A3 open 94 days with no refill",
      "sourceType": "feeding", "sourceId": "9f1c...",
      "observedAt": "2026-06-01T14:02:00Z" }
  ],
  "priority": "urgent",              // urgent | high | normal | low
  "status": "open",                  // open | snoozed | dismissed | done
  "dueAt": null,
  "supersedes": [],                  // §4.6
  "asOf": "2026-09-03T12:00:00Z",    // when this item's facts were read
  "freshness": { "origin": "server", "cachedAt": null, "stale": false },
  "commands": [
    {
      "id": "feeding.refill",
      "label": "Refill",
      "method": "POST",
      "path": "/api/v1/feedings/9f1c.../refill",
      "bodyTemplate": {},
      "permitted": true,
      "deniedReason": null,
      "offline": "queueable",        // queueable | online_only
      "offlineReason": null,
      "idempotencyKeyTemplate": "wi:feeding:9f1c...:refill:{clientMutationId}",
      "keyboard": "r"
    }
  ],
  "sortRank": 1                      // server-assigned, §4.7
}
```

### 4.3 Projection id derivation

`id = "wi:" + sourceType + ":" + sourceId [+ ":" + facet]`, where `sourceId` is
a durable primary key and `facet` disambiguates several items derived from one
row.

| sourceType | id | Why it is stable |
|---|---|---|
| `recommendation` | `wi:recommendation:{ai_recommendations.id}` | already a uuid (`routes_recommendations.go:30`) |
| `feeding` | `wi:feeding:{feedings.id}` — the row `listFeedingStatus` reports as `actionFeedingId` (`routes_feedings_status.go:245`) | today's client id is `feeding:{hiveId}` (`hooks.ts:118`), which silently changes meaning when the feeder is replaced |
| `lockout` | `wi:lockout:{hiveId}:{treatment_events.id}` | a lockout is a recomputed walk (`lockout.go:277-346`), not a row; the treatment event that causes it is the durable key |
| `harvest_ready` | `wi:harvest_ready:{hiveId}:{inspections.id}` | the item comes from exactly one inspection reading (`yard_queue.go:218-232` takes the latest per hive); keying on the inspection makes a re-read the same item and a new inspection a new item |

Stable ids are what make snooze and dismiss, keyboard focus retention across
refetches, and offline receipt correlation possible. The current yard queue has
none.

### 4.4 Permission-aware commands and offline disposition

- **Permissions.** Each command is evaluated against the actor's admin flag and
  apiary memberships (§5.3) and returned with `permitted` plus a
  `deniedReason`. This is a real change: access today is page-level
  (`adminOnly` / `requiresEdit` on nav entries, `nav-items.ts:19-20`) and a
  viewer simply never sees the nav item. A viewer *can* see a work item for an
  apiary they may read, and must be told per command that they may not act.
- **Offline.** `offline` is computed by evaluating the command's method and
  path against `offlineRoutes.supports` (`offline_routes.go:112-133`) — the
  same manifest the service worker is generated from — so the projection can
  never advertise a queueable command the SW would refuse. `online_only`
  carries a reason string, which is what makes §1.4 gap 1 visible in the UI
  instead of failing silently at the market stall.
- **Idempotency.** Every command carries an `idempotencyKeyTemplate` bound to
  the projection id, so a replayed offline mutation resolves to the same
  command identity (§5.1).

### 4.5 `asOf` and freshness

`asOf` is reported per item (the read that produced its facts) and per response
(`response.asOf`, the projection query's transaction time).
`freshness.origin` is `server` for a live response. For a cached response the
frontend must set `origin: "cache"`, `stale: true` and `cachedAt` from the
service worker's `X-Beez-Cache: stale` header (`sw.js/route.ts:400`) — which
requires `frontend/src/lib/api.ts` to start exposing response headers
(`api.ts:108` read only `content-type`). That plumbing is wave-2 scope and it
is the roadmap's "distinguish stale cached evidence from current server
evidence" criterion.

**Landed in wave 2.** `api.getWithMeta` returns an `ApiResponseMeta` carrying
the response `Headers`, the lowercased `X-Beez-Cache` and the parsed `Date`;
`features/work/api.ts` rewrites `freshness` to
`{origin: "cache", stale: true, cachedAt: <Date header>}` on the response and
on every item inside it when the header says `stale`, and `FreshnessMarker`
draws connection and freshness as two separate chips — a live connection can
still serve a cached body, and a cached body can be current.

### 4.6 The dedup rule for `feeder_check`

Both assemblers drop the type unconditionally today: `hooks.ts:163-165`
(`rec.type !== "feeder_check"`) and `yard_queue.go:132`
(`AND rec.type <> 'feeder_check'`). The consequence is that a `feeder_check`
recommendation for a hive with **no** feeding-status row is invisible on every
surface.

**Rule in the projection — one place, one behaviour:**

> A `feeder_check` recommendation is suppressed **iff** the same response
> contains a `feeding` item for the same `hiveId`. Otherwise it is emitted
> normally. When it is suppressed, the surviving feeding item lists it in
> `supersedes: ["wi:recommendation:..."]`.

This is a deliberate behaviour change from both assemblers and must be stated
in the wave-1 acceptance notes. The current rule looks correct only because the
feeding row usually exists; the failure mode — an orphan `feeder_check` never
shown — is silent.

### 4.7 Ordering

`sortRank` is `yardQueueRank` (`yard_queue.go:343-366`: lockout 0, urgent
recommendation or urgent feeding 1, high recommendation 2, feeding 3, normal
recommendation 4, harvest-ready 5) moved into the projection, with the existing
tie-break on hive name (`yard_queue.go:368-373`). Today's `attention` versus
`today` split (`hooks.ts:167-181`) is expressed as a grouping over the same
rank rather than as a second, independent rule in a React hook.

### 4.8 Read models

Four cohesive use-case endpoints, not endpoint-per-widget. All are `GET`, all
return `asOf` and `freshness`, all are permission-filtered server-side.

**`GET /api/v1/work/today?status=&priority=&sourceType=&apiaryId=`**

```jsonc
{
  "asOf": "2026-09-03T12:00:00Z",
  "freshness": { "origin": "server", "cachedAt": null, "stale": false },
  "counts": { "attention": 3, "today": 11, "snoozed": 2 },
  "groups": [
    { "key": "attention", "label": "Needs attention", "items": [ /* WorkItem */ ] },
    { "key": "today",     "label": "Today's field actions", "items": [ /* WorkItem */ ] }
  ]
}
```

`/today/recommendations` calls the same endpoint with
`sourceType=recommendation&status=open,snoozed,dismissed`.

**`GET /api/v1/work/yard?apiaryId=`**

```jsonc
{
  "asOf": "2026-09-03T12:00:00Z",
  "freshness": { "origin": "server", "cachedAt": null, "stale": false },
  "yards": [
    { "apiaryId": "...", "apiaryName": "North Ridge",
      "counts": { "urgent": 1, "high": 2, "normal": 4 },
      "items": [ /* WorkItem */ ] },
    { "apiaryId": null, "apiaryName": "All yards", "items": [ /* WorkItem */ ] }
  ]
}
```

Same item shape as `/work/today`; only the grouping differs. The
`apiaryId: null` catch-all preserves today's hive-less-recommendation
behaviour (`yard_queue.go:172-176`).

**`GET /api/v1/production/workbench?year=`**

```jsonc
{
  "asOf": "...",
  "freshness": { "origin": "server", "stale": false },
  "openSessions": [
    { "id": "...", "apiaryName": "...", "date": "...", "entryCount": 7,
      "calculatedTotalLbs": 118.5, "trueUpDifferenceLbs": null,
      "commands": [ /* WorkItemCommand */ ] }
  ],
  "bulkOnHand": [
    { "lotId": "...", "lotCode": "...", "varietal": "...",
      "availableLbs": "42.250", "lockedOut": false, "lockoutUntil": null }
  ],
  "lotsAwaitingBottling": [
    { "lotId": "...", "lotCode": "...", "availableLbs": "42.250" }
  ],
  "jarStock": [
    { "jarSizeId": "...", "label": "16 oz", "onHand": 34, "reserved": 6,
      "available": 28, "parLevel": 24 }
  ],
  "productBatches": [ { "id": "...", "productName": "Creamed", "onHand": 12 } ],
  "commands": [ /* start session, record bottling, adjust counts */ ]
}
```

Every quantity comes from `inventory_available` or `inventory_balances`
(`app/inventory/queries.go:12-20`), never from a legacy sum. `lockedOut`
carries S2 forward so the workbench explains a refusal before it happens.

**`GET /api/v1/sales/workbench?year=`**

```jsonc
{
  "asOf": "...",
  "freshness": { "origin": "server", "stale": false },
  "todayTakings": { "salesCount": 4, "revenueCents": 18500 },
  "drafts": [
    { "saleId": "...", "customerName": "...", "lineCount": 3,
      "shortfalls": [ { "itemLabel": "16 oz", "wanted": 12, "available": 8 } ] }
  ],
  "consignment": [
    { "locationId": "...", "name": "Bike shop", "unitsOut": 24,
      "settlementDueAt": "2026-09-30", "lastSettledAt": "2026-08-31" }
  ],
  "sellable": [
    { "itemId": "...", "label": "16 oz", "lotCode": "...", "availableAtHome": 28 }
  ],
  "commands": [ /* record sale, transfer, settle */ ]
}
```

`shortfalls` is `sales.Service.CheckAvailability`
(`app/sales/reservation.go:44`) surfaced as a read, so a draft explains its own
refusal. `availableAtHome` is home-location availability
(`honeyHomeJarAvailability`, `honey_ledger.go:138-150`) — the number Market Day
may actually sell, not the global total.

Mutations remain explicit source commands. There is no `PUT /workbench`.

---

## 5. Application-layer decisions the roadmap leaves open

### 5.1 Idempotency — recommended: command identity, one transaction

**Recommendation.** The offline mutation id plus the request hash becomes the
**command identity**, and the command's result is written to the receipt inside
the same `pgx.Tx` as the command's own writes. The receipt middleware is
demoted to transport: header parsing, the queued-at conflict check, and
returning a stored result on replay.

**Why.** `offlineMutations` (`middleware_offline.go:149-315`) today does:

1. `s.pool.Exec` inserts the receipt in state `processing` (`:210-213`);
2. `next.ServeHTTP(...)` — the handler opens and commits **its own**
   transaction;
3. `s.receiptExec` updates the receipt to `complete` (`:306-310`).

A crash between (2) and (3) leaves the receipt in `processing`. The replay path
then waits five minutes (`time.Since(updated) <= 5*time.Minute`,
`middleware_offline.go:248`) and afterwards **re-claims and re-executes** the
mutation (`:254-262`). For `POST /api/v1/sales` that is a duplicated sale.
Three further inconsistencies compound it: pre-hash receipts replay unchecked
(`:234-238`), a 5xx response deletes the receipt so the retry re-executes
(`:289-296`), and a body at the 2 MiB capture limit
(`offlineResponseLimit`, `:20`) is stored as no body at all (`:301-305`).

**Design.** The mechanism already exists one layer down and is proven:
`inventory.Service.Record` takes an `IdempotencyKey`, hashes the payload into
`details._payload_hash`, inserts `ON CONFLICT (idempotency_key) DO NOTHING`,
and on conflict compares the hash and returns the stored operation
(`app/inventory/service.go:43-52,71-97`; `compareReplay` `:348-354`).
Generalise it:

```go
// app: one transaction, one identity, one stored result.
func (r *Runner) RunIdempotent(
    ctx context.Context, actor Actor, id Identity,
    fn func(context.Context, *UnitOfWork) (any, error),
) (Result, error)
```

- `Identity{UserID, MutationID, RequestHash}` comes from the transport.
- Inside the transaction: `INSERT INTO offline_mutation_receipts
  (user_id, mutation_id, request_hash, state, response_status, response_body)
  VALUES (..., 'complete', ...) ON CONFLICT DO NOTHING`. On zero rows, load the
  existing row, compare `request_hash`, and return its stored result — the same
  shape as `compareReplay`.
- `response_body` stores the **command result**, marshalled inside the
  transaction. The HTTP handler serialises that same value, so the stored body
  is a pure function of the command result rather than a captured byte stream.
  That deletes the capture writer (`middleware_offline.go:22-52`), the 2 MiB
  truncation case, and the `Flush` no-op hack (`:44`).
- The `processing` state, the five-minute window, and the stale-claim update
  (`:245-262`, the stale-claim UPDATE at `:253-258`) are **deleted**: there is no window, because the receipt and the
  writes commit or roll back together.
- `X-Offline-Queued-At` conflict detection (`offlineMutationConflicts`, `middleware_offline.go:115-127`)
  stays in the middleware. It is a transport concern about a stale client edit
  and must run before the command.

**Cost, stated honestly.** A route's receipt can only become transactional once
an app-layer command serves it. Until then it keeps the two-step middleware;
the two coexist, selected by whether the handler opts in. The migration order
is §5.4, highest damage first: `POST /sales`, then bottling and jarring, then
equipment.

**Rejected alternative.** "Receipts remain transport, backed by mandatory
payload-bound domain keys" is strictly weaker here: every stock-changing
command *already* has a payload-bound domain key at the inventory layer
(`app/inventory/service.go:47`), and it still does not make the receipt and the
write atomic — the crash window at `middleware_offline.go:248` survives
untouched.

### 5.2 Post-commit domain events — recommended: a transactional outbox drained by `cmd/worker`

**Recommendation.** One table and one `UnitOfWork` method, drained by the
worker that already exists.

```sql
CREATE TABLE domain_events (
  id             uuid PRIMARY KEY,
  occurred_at    timestamptz NOT NULL DEFAULT now(),
  aggregate_type text NOT NULL,          -- 'sale', 'harvest_lot', 'hive', ...
  aggregate_id   uuid NOT NULL,
  event_type     text NOT NULL,          -- 'sale.applied', 'bottling.recorded', ...
  payload        jsonb NOT NULL,
  actor_id       uuid REFERENCES app_users(id),
  published_at   timestamptz,            -- NULL means undrained
  attempts       int NOT NULL DEFAULT 0,
  last_error     text
);
CREATE INDEX ON domain_events (occurred_at) WHERE published_at IS NULL;
```

`uow.Emit(Event)` appends inside the caller's transaction, so an event exists
if and only if its command committed. `cmd/worker` already runs asynq
(`backend/cmd/worker/main.go:52-63`) and already owns ntfy dispatch through
`NewBackgroundDispatcher` (`:51`); it gains a periodic drain that selects
undrained rows `FOR UPDATE SKIP LOCKED`, enqueues one asynq task per event, and
stamps `published_at`. Delivery is at-least-once; consumers key on `id`.

**Why an outbox rather than post-commit callbacks.** Nothing exists today — a
repository-wide search for `outbox` returns no Go or SQL match — and the
current alternative, dispatching ntfy inside the request, cannot be made
transactional. `backend/internal/app/doc.go` already states the rule that
anything escaping the transaction (object storage, outbound HTTP,
notifications) must be skipped when `DryRun` is set, precisely because a
rollback cannot undo it. An outbox is the only shape that keeps that rule true
for notifications. First consumers: ntfy dispatch (`routes_ops.go:376`
`collectNtfyCandidates`), recommendation regeneration
(`POST /recommendations/run`, `routes_recommendations.go:26`), and GnuCash push
(`external_sync`).

**Not in scope for item 10:** an event bus, projections rebuilt from events, or
event sourcing. `inventory_movements` remains the ledger; `domain_events` is a
delivery mechanism.

### 5.3 Authorization inputs — recommended: the actor carries them

`appActor` (`backend/internal/httpapi/honey_ledger.go:112-117`) builds
`app.UserActor(user.ID, user.DisplayName)` and **drops `IsAdmin` and every
apiary membership**; `app.Actor` (`backend/internal/app/actor.go:31-41`) has
exactly one privilege, `MayWritePreservedAudit` (`:88`). Authorization lives
entirely in chi middleware — `requireAdmin` (`middleware.go:236`), `apiaryRole`
(`:247`), `requireHiveParamRole` (`:373`), `requireEntityParamRole`. A command
therefore cannot answer "may this actor do this?", which is exactly what the
WorkItem contract's per-command `permitted` flag needs.

**Recommendation.** Extend `Actor` with the *inputs*, not the decisions:

```go
type Actor struct {
    kind         ActorKind
    userID       uuid.UUID
    label        string
    isAdmin      bool                    // end-user admin; never audit privilege
    memberships  map[uuid.UUID]string    // apiaryID -> "viewer" | "editor"
    fromAPIToken bool                    // credential changes still refuse it
}

func (a Actor) MayAdminister() bool
func (a Actor) MayViewApiary(id uuid.UUID) bool
func (a Actor) MayEditApiary(id uuid.UUID) bool
```

Rules that must hold: `MayWritePreservedAudit` stays independent of `isAdmin`
(`app/doc.go`, "Actors"); memberships are loaded once per request at the edge
and passed in, never queried from inside a command; the chi middleware remains
as a cheap pre-filter but stops being the only enforcement, so a command
reached through a new transport still refuses correctly with `app.Forbidden`.
`principal.FromAPIToken` (`middleware.go:31-33`) carries through unchanged so
credential-changing commands keep refusing token principals.

### 5.4 Long HTTP handlers to move into `app/*` commands

Measured at `abdd2a7` from the `func` line to its closing brace. Ordered by
length combined with cross-domain reach and offline exposure.

| # | Handler | file:line | Lines | Target command | Why now |
|---|---|---|---|---|---|
| 1 | `honeyRecordSale` | `routes_honey.go:1278` | **411** | `app/sales.RecordSale`, wrapping `Service.Apply` (`app/sales/apply.go:41`) | longest handler in the tree; queueable (`offline_routes.go:55-56`); carries the duplicate-sale exposure of §5.1 |
| 2 | `handleTranscriptionApplyReparse` | `routes_transcriptions_versions.go:632` | 280 | `app/field.ApplyReparse` | writes inspections and media lineage in one request |
| 3 | `stockApplySettlement` | `routes_stock_locations.go:1788` | 276 | `app/sales.ApplySettlement`, wrapping `RecordSettlementShrink` (`app/sales/consignment.go:151`) | crosses sales, consignment and inventory |
| 4 | `profitabilityAnalytics` | `routes_commerce.go:1729` | 275 | `app/insights.Profitability` (query) | read model for `/insights/profitability` |
| 5 | `yardQueue` | `yard_queue.go:35` | 269 | **deleted**, replaced by `app/work.Yard` | §4.1 |
| 6 | `handleTranscriptionConfirm` | `routes_transcriptions.go:470` | 220 | `app/field.ConfirmTranscription` | journey 3.1 step 6 |
| 7 | `handleCompliancePacket` | `routes_ops.go:834` | 205 | `app/insights.CompliancePacket` | moves with S5 to `/insights/compliance` |
| 8 | `handleFlowCalendar` | `routes_bloom.go:438` | 199 | `app/field.FlowCalendar` (query) | |
| 9 | `productBatchCreate` | `routes_products.go:911` | 196 | `app/production.RecordBatch` (exists, `app/production/products.go:33`) | the handler still owns the transaction |
| 10 | `handleInspectionUpdate` | `routes_inspections.go:622` | 196 | `app/field.UpdateInspection` | queueable; also drives `syncInspectionTreatmentEvents` (`routes_inspections.go:294`, 120 lines) |
| 11 | `honeyRecordJarring` | `routes_honey.go:246` | 188 | `app/production.RecordBottling` (exists, `app/production/bottling.go:47`) | queueable; journey 3.2 step 6 |
| 12 | `stockBuildStatement` | `routes_stock_locations.go:1319` | 184 | `app/sales.BuildStatement` (query) | |
| 13 | `bottlingRunCreate` | `routes_commerce.go:929` | 184 | `app/production.RecordBottlingRun` | |
| 14 | `harvestLotUpdate` | `routes_commerce.go:752` | 177 | `app/production.UpdateLot` | re-linking harvests recomputes derived lot weight, which must emit compensating movements |
| 15 | `jarUpdate` | `routes_jar_sizes.go:157` | 162 | `app/production.UpdateJarSize` | `honey_ledger.go:129-133` already records this handler as owed to the equipment wave |
| 16 | `queenPerformance` | `routes_field_intelligence.go:669` | 158 | `app/insights.QueenPerformance` (query) | |
| 17 | `hsAddEntry` | `routes_harvest_sessions.go:386` | 157 | `app/production.AddHarvestEntry` | queueable; journey 3.2 step 3 |
| 18 | `equipLossReport` | `routes_equipment_ledger.go:399` | 136 | `app/equipment.LossReport` (query) | |
| 19 | `harvestLotCreate` | `routes_commerce.go:623` | 129 | `app/production.CreateLot` | queueable |
| 20 | `handleCanvasAssignSlot` | `routes_canvas.go:462` | 128 | `app/field.AssignSlot` | queueable |
| 21 | `handleSettingsUpdatePreferences` | `routes_settings.go:178` | 124 | splits into `app/me.UpdatePreferences` and `app/admin.UpdatePolicy` | splits with §6.4 |
| 22 | `honeyUpdateSale` | `routes_honey.go:1697` | 123 | `app/sales.UpdateSale` | queueable |
| 23 | `handleFeedingRefill` | `routes_feedings.go:496` | 117 | `app/field.RefillFeeder` | the WorkItem example command; must be idempotent per §5.1 |
| 24 | `colonyIntakeCreate` | `routes_field_objects.go:309` | 114 | `app/field.RecordColonyIntake` (exists, `app/field/service.go:24`) | the handler still owns the transaction |
| 25 | `hiveTimeline` | `routes_operations.go:290` | 112 | `app/field.HiveTimeline` (query) | |

Scale context, re-checked here: `routes_commerce.go` 90 KB,
`routes_honey.go` 79 KB, `routes_stock_locations.go` 76 KB.

Deliberately **not** on the list: `handleOIDCCallback` (`routes_auth.go:433`,
142 lines) and `handlePhotoUpload` (`routes_photos.go:155`, 151 lines) are
transport and I/O by nature, not cross-domain transactions; moving them into
`app/*` would produce exactly the "equally long service methods with a new
package name" the roadmap warns against.

---

## 6. Settings split

`/settings` is one route rendering twelve accordion sections
(`frontend/src/features/settings/settings-view.tsx:32-160`), nine of them
inside a single `isAdmin` block (`:52-125`). There is no `/settings/[section]`
tree, so the split creates new routes rather than rewriting old ones.

### 6.1 My Preferences — `/me`, every authenticated user

| Section | file:line | Today | Move |
|---|---|---|---|
| Password login | `settings-view.tsx:45` | all users | `/me` |
| Preferences — theme, default apiary, date format, weight and units | `settings-view.tsx:54` | **admin only** | `/me` — **access change plus schema change**, §6.4 |
| Install app | `settings-view.tsx:139` | all users | `/me` |
| The non-admin half of "Users, access, and API": your apiary access, your API tokens, your MCP connection | `settings-view.tsx:127` | all users | `/me` |

### 6.2 Operation Setup — `/admin/setup`, admin

| Section | file:line | Contextual link added from |
|---|---|---|
| Jar sizes | `settings-view.tsx:69` | `/production/jars`, `/sales/market-day` (S13) |
| Treatment withdrawals | `settings-view.tsx:77` | the lockout work item, `/yard/hives/[id]` (S14) |
| Yard-visit labor **enable flag** | `settings-view.tsx:101` | `/yard/queue` (S4) |
| Honey varietals (owner stays `/production/varietals`) | — | link only |
| Equipment types and BOMs (owner stays `/equipment/types`) | — | link only |

### 6.3 Admin and Integrations — `/admin`, admin

AI configuration (`settings-view.tsx:61`), Photo storage (`:85`), Phone push
via ntfy (`:93`), GnuCash credentials and book (`:109`), and the admin half of
"Users, access, and API" — collaborators, roles, API tokens, MCP (`:127`) —
plus system health.

**Leaving Settings entirely:** the Compliance packet (`:117`) goes to
`/insights/compliance` (S5); the GnuCash *reconciliation report* goes to
`/insights/reconciliation` (S6); the labor start/stop control goes to
`/yard/queue` (S4).

### 6.4 The access change is also a schema change

Exposing `PreferencesSection` per user is an access change — that much the
roadmap says. But the data it edits is a **singleton**: `user_settings` has no
`user_id` column and no FK to `app_users`
(`backend/internal/db/migrations/00001_baseline.sql:2003-2031`), and every read
and write targets one row —
`SELECT ... FROM user_settings LIMIT 1` (`routes_settings.go:141`),
`UPDATE user_settings ... WHERE id = (SELECT id FROM user_settings LIMIT 1)`
(`routes_settings.go:281` and `:334`), and `GET /ops/units`
(`routes_ops.go:26-28`). That same row also holds `ai_provider_config`,
`ntfy_access_token`, the mite and moisture thresholds and
`labor_tracking_enabled` — operation-wide policy and secrets.

**Prerequisite for wave 6:** a `user_preferences` table keyed by
`app_users.id` holding **only** `theme`, `date_format`, `weight_unit`, `units`,
`temperature_unit` and `default_apiary_id`, with the current singleton values
backfilled as every existing user's defaults. Everything else stays on
`user_settings` and becomes explicitly operation policy, still read by
`GET /ops/units`. Without that table, "My Preferences" would let any user
rewrite the whole operation's display settings, and would sit one column away
from the ntfy access token.

### 6.5 Dual-homed offenders, resolved

| Offender | Two homes today | Single owner |
|---|---|---|
| Labor control | `settings-view.tsx:101` and `operations/yard-queue.tsx:62` | Yard owns the control; Operation Setup owns the enable flag (S4) |
| Record sale | `honey/quick-actions.tsx` mounted three times, plus the Market Day POS | Sales (S3) |
| Equipment deploy | `hives/equipment-tab.tsx` and `equipment/inventory-view.tsx` | Equipment owns the command, Yard invokes it (S7) |
| Compliance packet | a Settings section, Insights-shaped | Insights (S5) |
| Jar sizes | Settings, with no contextual link | Operation Setup plus links (S13) |
| Treatment withdrawals | Settings, with no contextual link | Operation Setup plus links (S14) |
| Customers and wholesale | a Reports route holding a CRUD editor | Sales (S12) |
| Expenses | a Reports route holding a CRUD editor | Sales (S11) |

---

## 7. Implementation waves

Dependency-ordered. Each wave is a candidate polyagent manifest: scope, owned
paths, tests, acceptance. Waves 1 to 3 touch no routes; wave 5 is the single
coordinated rewrite the roadmap requires. The field Today and Yard slice is
first and does not depend on any Production or Sales work.

### Wave 1 — WorkItem projection (backend), field slice only — **landed**

- **Scope.** A new `backend/internal/app/work` package: the `WorkItem` type,
  the four sources (recommendation, feeding, lockout, harvest_ready), id
  derivation (§4.3), the `feeder_check` rule (§4.6), `sortRank` ported from
  `yardQueueRank` (`yard_queue.go:343-366`), per-command permission evaluation
  against the extended actor (§5.3), and offline disposition computed from
  `offlineRoutes.supports`. Handlers `GET /work/today` and `GET /work/yard`.
  `app.Actor` gains `isAdmin` and `memberships`; `appActor`
  (`honey_ledger.go:112`) populates them. `yard_queue.go` stays untouched this
  wave so the two can be compared.
- **Owned paths.** `backend/internal/app/work/**`,
  `backend/internal/app/actor.go`,
  `backend/internal/httpapi/routes_work.go`,
  `backend/internal/httpapi/routes.go` (the mount line only),
  `backend/internal/httpapi/honey_ledger.go` (`appActor` only).
- **Tests.** Unit: id stability across two reads of the same source; the
  `feeder_check` rule in both directions (feeding present so suppressed,
  feeding absent so emitted — the behaviour change); permission filtering for
  admin, editor, viewer and non-member; every emitted command's `offline`
  value equals `offlineRoutes.supports(method, path)`. DB: parity against
  `yardQueue` on a seeded fixture — same items, same order, plus stable ids.
- **Acceptance.** `/work/yard` returns the same item set and order as
  `/operations/yard-queue` for the fixture; every item carries a stable id;
  `asOf` and `freshness` are present; no work item advertises a queueable
  command the SW manifest would refuse.
- **Landed** 2026-09-03 (polyagent run `20260903-item10-runA-bz01`). All four
  acceptance criteria hold. Green: `go build ./...`, `go vet ./...`,
  `gofmt -l` clean; the `internal/app/work` unit suite;
  `TestWorkCommandOfflineMatchesRouteManifest`; and the DB tests
  `TestWorkYardMatchesYardQueue`, `TestWorkYardIDsAreStableAcrossReads`,
  `TestWorkFeederCheckRuleAgainstTheDatabase`, `TestWorkTodayEndpoint`,
  `TestWorkYardRespectsMembership`.

  **Deviations from the scope above, all deliberate:**

  1. **`app/work` is pure; the facts are read at the edge.** The package
     takes an `Inputs` struct of already-read facts and returns the
     projection; `httpapi/routes_work.go` reads them. Doing the reads inside
     `app/work` would have meant duplicating the lockout walk
     (`lockout.go:216-267`, `pickLockout`, `lockoutMessage`) and the feeding
     status evaluation (`routes_feedings_status.go:115-190`), and two copies
     of the lockout rule is exactly the failure mode this item exists to
     remove. Every *rule* named in the scope — ids, `feeder_check`,
     `sortRank`, permission, offline, `asOf`/`freshness` — is in `app/work`
     and unit testable without a database. The cost is that `routes_work.go`
     restates two of the SQL reads `yard_queue.go` does (visible hives,
     harvest-ready); they converge when `yard_queue.go` is deleted.

  2. **`appActor` reads memberships from the request context.** §5.3 wants
     them loaded once at the edge, but the edge is `middleware.go`, which
     wave 1 does not own. `routes_work.go` loads them and stashes them under
     an unexported context key; every other handler gets an actor with
     `isAdmin` set (it is free from the principal) and no memberships, which
     can only under-report access. **Wave 3 must move the load into the auth
     middleware** and delete `workMembershipsKey` / `loadApiaryMemberships`
     from `routes_work.go`.

  3. **`Actor.WithAccess` is a no-op for non-user actors,** so a background
     job or the restore actor cannot acquire end-user admin through it, and
     `MayWritePreservedAudit` stays independent of `isAdmin`
     (`TestWorkAdminIsNotAuditPrivilege`). `fromAPIToken` from the §5.3
     sketch was **not** added: nothing in the field slice needs it and
     `principal.FromAPIToken` still gates credential changes at the edge. It
     belongs to wave 3 with the middleware move.

  4. **`feeder_check` recommendations now have a title** — "Check the
     feeder". `yardQueueRecTitle` has no case for the type because neither
     assembler ever emitted one; under the §4.6 rule they can be, so they
     need one. Part of the deliberate behaviour change; asserted by
     `TestWorkFeederCheckEmittedWithoutFeedingItem` and, end to end, by
     `TestWorkFeederCheckRuleAgainstTheDatabase`.

  5. **The DB parity fixture compares only its own hives.** Both endpoints
     read every yard the principal belongs to, and
     `ai_recommendations_active_unique` permits exactly one undismissed
     hive-less row per type per database — which `TestYardQueueEndpoint`
     already uses. The hive-less catch-all yard is covered by the unit test
     `TestWorkYardViewCatchAll` instead.

  6. **Two commands beyond the obvious triage set.** `harvest.start_session`
     (`POST /harvest-sessions`) is emitted on harvest-ready items precisely
     because it is an offline POST exclusion: it is the field slice's only
     `online_only` command, and without it the "no item advertises a
     queueable command the SW would refuse" check would only ever see
     queueable commands and prove nothing. `recommendation.restore` is
     emitted for dismissed rows so `/today/recommendations` has a
     triage-history action.

  7. **Today's groups carry every returned status.** `counts.snoozed` counts
     snoozed items among the items returned, and snoozed or dismissed items
     appear in the two rank groups rather than in a third group, so
     `/today/recommendations` (which asks for all three statuses) renders
     triage history from the same two groups. §4.8 shows only the two
     groups; this is how they behave when the status filter is widened.

- **Follow-up found while implementing (not fixed here — outside the owned
  paths).** `requireEntityParamRole("recommendation", …)` resolves the apiary
  through `JOIN hives` (`middleware.go:407-408`), so **dismiss, snooze and
  restore on a hive-less recommendation 404 for everyone, admins included**:
  the join yields no rows and `entityApiaryID` returns `pgx.ErrNoRows` before
  any role is checked. The projection reports those commands as `permitted`
  for an admin because that is the authorization answer; the transport is
  what is wrong. Fix belongs with wave 3's authorization move or the wave 5
  route rewrite.

### Wave 2 — Today and Yard Queue (frontend field slice) — **landed**

- **Depends on** wave 1.
- **Scope.** `/today` and `/yard/queue` consume `/work/*`. Delete
  `useFieldWork` (`dashboard/hooks.ts:158-189`) and the client-side split. Port
  the action-center keyboard controller (`dashboard-view.tsx:139-198`) onto
  `commands[]` (D8). Relocate the five dashboard status and history widgets per
  §4.1. Add freshness plumbing: expose response headers from
  `frontend/src/lib/api.ts` and read `X-Beez-Cache: stale` (§4.5). Render
  per-command `permitted` and `offline` states.
- **Owned paths.** `frontend/src/features/work/**`,
  `frontend/src/features/dashboard/**` (deletion and relocation),
  `frontend/src/lib/api.ts`, the two new route files.
- **Tests.** Component tests for the keyboard order and the armed-row guard; a
  stale-response test asserting the freshness marker; a forbidden-command test
  asserting a disabled control with a stated reason; e2e: Today renders offline
  from the SW cache and is marked stale.
- **Acceptance.** Today, `/yard/queue` and `/today/recommendations` are three
  filters over one response shape; every action executes its source command;
  the six roadmap states (online, offline, stale, forbidden, error,
  undo/interrupted) are each visibly distinct.
- **Landed** 2026-09-03 (polyagent run `20260903-item10-runB-bz01`). Green on
  the Windows checkout: `tsc --noEmit`, `npm run lint` (0 errors; the 17
  warnings are pre-existing React-Compiler notes in other features),
  `npm run build` (`/today`, `/today/recommendations`, `/yard`, `/yard/queue`
  all emit), and the full Playwright suite — 28 passed, 1 skipped on purpose
  (see deviation 2). `frontend/tests/e2e/work.spec.ts` is new: 11 assertions
  covering the keyboard order, the armed-row guard, source-command execution,
  stale versus live, forbidden, offline, queued, error and the recommendation
  filter.

  New code: `frontend/src/features/work/**` (`types.ts` mirroring §4.2,
  `api.ts`, `use-action-center.ts`, `use-work-commands.ts`, `use-online.ts`,
  `work-item-row.tsx`, `work-surface.tsx`, `freshness-marker.tsx`,
  `command-receipt-bar.tsx`, `today-view.tsx`, `yard-queue-view.tsx`).
  Deleted: `useFieldWork` and the `FieldItem` split, `needs-attention-widget`,
  `todays-actions-widget`, `field-item-row`, `feeding-status-widget`,
  `feeding-actions`.

  **Deviations from the scope above, all deliberate:**

  1. **No component tests — the behaviours are pinned in Playwright.** This
     repo has no component test runner (no jest/vitest, no
     `@testing-library/*`), and adding one is a toolchain decision this wave
     has no mandate for. Every behaviour the scope names as a component test
     is asserted in `work.spec.ts` against the real page with a mocked
     `/work/*` response, which pins the projection *contract* as well as the
     rendering.

  2. **"Today renders offline from the SW cache" cannot pass yet, and says
     so.** The service worker's `SHELL` precache
     (`frontend/src/app/sw.js/route.ts:25-36`) still lists `/dashboard` and
     `/operations/yard-queue`; `/today` and `/yard/queue` are not precached,
     so an offline navigation to `/today` falls through to `/offline`. `sw.js`
     is wave 5's file. `work.spec.ts` ends with a test that reads `/sw.js`,
     asserts `SHELL` contains the two canonical routes, and **skips itself
     while it does not** — so wave 5 inherits an assertion that arms the
     moment it edits `SHELL`, rather than a missing test. The *stale-marker*
     half of §4.5 is fully covered without it: the spec serves the response
     with `X-Beez-Cache: stale` and asserts the visible marker.

  3. **Widget relocation is as complete as the routes allow.** Hive overview
     and recent inspections moved to a new `/yard` landing page
     (`features/dashboard/yard-status-view.tsx`); feeding status became work
     items and its widget is deleted. Frame shortage and honey summary belong
     to `/equipment` and `/production`, which do not exist until wave 5 — they
     stay on `/dashboard` rather than being deleted out from under the
     operator, and the reporting links point at `/reports` and `/yard`
     because `/insights` does not exist yet either. The two relocated widgets
     still live under `features/dashboard/`; moving the folder is wave 5's
     single coordinated change.

  4. **`/today/recommendations` was built this wave, not deferred.** The
     acceptance criterion is that Today, the yard queue and the
     recommendations filter are *three filters over one response shape*; with
     only two surfaces it is not demonstrable. The page is `TodayView` with
     `sourceType=recommendation&status=open,snoozed,dismissed` and no code of
     its own. The old `/recommendations` inbox is untouched and still
     reachable — wave 7 deletes it.

  5. **`lib/api.ts` gained three things, not one.** `getWithMeta` returns the
     parsed body plus an `ApiResponseMeta` (status, `Headers`, the lowercased
     `X-Beez-Cache`, and the parsed `Date` used as `cachedAt`). `send`
     dispatches by method name so a command's own `method`/`path` executes
     verbatim. And `buildUrl` now accepts a path that already starts with
     `/api/v1/`, because that is the form the projection emits (§4.2) — the
     alternative was every call site stripping a prefix, which is one more
     place for client and server to disagree.

  6. **Undo is read back from the projection, never constructed.** After a
     reversible command (`recommendation.dismiss`, `recommendation.snooze`)
     the receipt bar looks for `recommendation.restore` on the same source row
     via a second, filtered read of `/work/today`
     (`sourceType=recommendation&status=snoozed,dismissed`). If the row is not
     there — offline, or someone else moved it — no undo is offered, because
     none can be honestly promised. Building `/recommendations/{id}/restore`
     in the client would have been a second source of truth for a path the
     server already publishes.

  7. **The row attribute is `data-work-id`, not `data-field-id`.** The guard
     and the reveal effect are otherwise ported verbatim from
     `dashboard-view.tsx:139-215`. The keys are no longer the hardcoded
     `d`/`s`/`r`: each command carries its own `keyboard`, and a keypress on a
     command with `permitted: false` produces the stated refusal instead of a
     request the server would reject.

  8. **Nav, manifest and service worker were not touched** (wave 5 owns them),
     so `/today`, `/today/recommendations`, `/yard` and `/yard/queue` are
     reachable by URL only. `NAV_ITEMS`' `adminOnly`/`requiresEdit` model is
     unchanged; per-command `permitted` is additive to it, exactly as §4.4
     describes.

  9. **`counts.snoozed` is rendered as "n of the items below are snoozed",**
     which is what wave 1 deviation 7 makes it: a count over the items
     actually returned. At the default filter it is zero.

- **Follow-ups found while implementing (not fixed here — outside the owned
  paths).**
  1. `/dashboard`, `/operations/yard-queue` and `/recommendations` now
     duplicate `/today`, `/yard/queue` and `/today/recommendations`. That is
     the intended overlap for waves 2-4 (nothing is deleted before wave 7),
     but `/operations/yard-queue` still reads the old `yardQueue` assembler,
     so the two surfaces can disagree until it goes.
  2. `features/dashboard/hooks.ts` keeps its own `useFrameSummary` and
     `useHoneyOverview`, which duplicate `features/equipment/hooks.ts:52` and
     `features/honey/hooks.ts:35` under different query keys. They survive
     only as long as the two unrelocated widgets do; wave 5 should drop them
     with the widgets rather than move the duplicates.
  3. `YardQueueLink` (`features/operations/yard-queue.tsx:132`) lost its only
     caller when the dashboard stopped hosting the work list. It is exported
     and unused; it goes with the rest of that file in wave 7.
  4. `frontend/tests/e2e/navigation.spec.ts:158` flakes on the *first* full
     suite run on a cold Next dev server (three new routes to compile inside
     a 15 s expect timeout) and passes on a warm one and in isolation. Not a
     product defect, but wave 5 adds more routes to the same server.

### Wave 3 — Application seam: idempotency, outbox, authorization — **landed 2026-09-03 (`71332e2`), with deviations**

Landed: `app.Runner.RunIdempotent` (mutation id + request hash as command
identity, receipt written in the command's own transaction, byte-identical
replay, 409 on payload mismatch, pre-hash receipts refused); the `processing`
state and five-minute re-claim are gone for the six migrated route families
(`middleware_offline.go` is transport for them and unchanged for the rest);
`domain_events` outbox as twin migrations `legacy-00001-00052/00055` +
`migrations/00002` with `uow.Emit`, `DrainEvents` (`FOR UPDATE SKIP LOCKED`,
at-least-once, idempotent per event id) and the `cmd/worker` drain;
`app/production.AddHarvestEntry` and `app/field.RefillFeeder` fully extracted;
sale create/update/cancel, jarring and lot-create run under the runner so
their writes, receipt and event commit or roll back together.
**Deviations, carried into wave 4:** `sales.RecordSale`, `sales.UpdateSale`
and `production.CreateLot` do not yet exist as named commands — the runner
owns their transaction but the orchestration is still in the HTTP files;
jarring still orchestrates around `RecordBottling`. The generic worker task
only logs the event envelope: the first consumers (ntfy, recommendation
regeneration, GnuCash push) are not rewired. §5.3's "memberships loaded at
the edge" was delivered by run B's `codex-auth-memberships` worker, not here.
Lead change: `internal/db` layout tests now derive the baseline head from the
embedded FS and require every post-reset baseline migration to have a
legacy-chain twin (`f5b0843`).

- **Depends on** wave 1 (the actor). Independent of waves 2 and 4.
- **Scope.** `Runner.RunIdempotent` and transactional receipts (§5.1); the
  `domain_events` table, `uow.Emit`, and the `cmd/worker` drain (§5.2); migrate
  rows 1, 11, 17, 19, 22 and 23 of §5.4 (the queueable ones) onto the new
  runner; demote `middleware_offline.go` to transport for those routes.
- **Owned paths.** `backend/internal/app/{uow.go,runner.go,events.go}`,
  `backend/internal/db/migrations/`, `backend/cmd/worker/`,
  `backend/internal/httpapi/middleware_offline.go`, the six migrated handlers.
- **Tests.** A crash-between-commit-and-receipt test proving no re-execution
  window remains — the `processing` state and the five-minute path at
  `middleware_offline.go:248` must be gone, not merely shorter; replay returns
  the identical stored result; a reused mutation id with a different payload
  still 409s; the outbox drain is at-least-once and idempotent per event id; a
  rolled-back command leaves no event.
- **Acceptance.** For the six migrated routes a receipt exists **iff** the
  command committed, and `POST /api/v1/sales` cannot double-book under replay.

### Wave 4 — Production and Sales workbenches — **frontend half landed 2026-09-03, with deviations**

**Backend half landed 2026-09-03 (`8398aa1`).** Named commands for sale
create/update/cancel and settlement (`app/sales`), lot create/update, jarring,
bottling runs, product batches and jar-size updates (`app/production`) — the
wave-3 leftovers included; `GET /api/v1/production/workbench` and
`GET /api/v1/sales/workbench`, each one application query over
`inventory_available` / `inventory_balances` with lockout and shortfall
explanations in the payload and row-level `commands[]` in the `app/work`
command shape; the dead `POSTExclusions` prefix fixed and
`offline-routes.generated.ts` regenerated (harvest-session create stays
`online_only`, its child entries queueable); first outbox consumers in
`cmd/worker` (ntfy for `sale.recorded` / `harvest_entry.added`,
recommendation regeneration for `feeding.refilled`) with durable
per-consumer claims by event id. No migration was needed. Lead note: the
worker's report carried a mistyped attempt id, so the harness marked the
attempt failed; the lead verified the worktree directly (build, vet, gofmt,
focused suites) before integrating.

**Frontend half landed.** `frontend/src/features/workbench/` and the two
canonical pages `/production/workbench` and `/sales/workbench`. Each renders
from exactly one §4.8 read model call — five panels on Production in the
§3.2 order (extraction in progress → bulk by lot → waiting on a bottling run
→ finished stock → product batches), four on Sales in the §3.3 order
(today's takings → drafts → consignment → sellable at home). Every mutation
is the source command the read model named, run through
`api.send(command.method, command.path, …)` with an `X-Offline-Mutation-ID`
substituted into the command's own `idempotencyKeyTemplate` (§5.1); there is
no `PUT /workbench`. Lockout and shortfall explanations are rendered *above*
the command they would refuse, and pinned in that DOM order by
`frontend/tests/e2e/workbench.spec.ts` (11 tests: one-call-per-workbench,
journey order, explanation-before-refusal for both a locked-out lot and a
short draft, forbidden command disabled with a visible reason, `start
extraction` online-only while offline, command-bound mutation id, the
`X-Beez-Cache: stale` marker, and an error state that is not an empty
workbench).

**Deviations and choices, for the lead to reconcile:**

1. **The backend half is not in this change.** The pages were coded to the
   §4.8 JSON verbatim while `routes_workbench.go` was written in parallel, so
   the spec drives the real pages against `page.route`-mocked responses. Until
   both land the pages 500-and-explain against a live server.
2. **Row-level `commands[]` are an accepted extension of §4.8.** The section
   shows `commands` on `openSessions[]` and at the response root only. The
   pages also render an optional `commands?: WorkCommand[]` on bulk lots,
   lots awaiting bottling, jar sizes, product batches, drafts, consignment
   locations and sellable items. Absent means "no command on this row", so a
   server that emits only the two documented positions is fully supported.
3. **`BulkLot.lockoutReason` is an accepted optional field.** §4.8 gives
   `lockedOut` and `lockoutUntil`; when the server can supply the lockout's
   own words the row states them. Without it the row still says it is locked
   out and until when.
4. **Decimal quantities are rendered rounded and kept exact.** `availableLbs`
   arrives as a string (`"42.250"`); it is displayed through
   `features/honey/format.formatLbs` and the verbatim server value is kept on
   `data-available-lbs`, so a rounded display never becomes the number an
   operator copies into a count.
5. **`useRunWorkbenchCommand` is a second copy of `useRunWorkCommand`.** The
   field-slice hook takes a `WorkItem` it does not use and invalidates the
   field caches; a bottling run has to invalidate honey, commerce,
   stock-locations and harvest-session caches instead. `features/work` is
   wave-2 code this wave does not own, so the two coexist. The same is true of
   the `X-Beez-Cache` → `freshness` rewrite, which is restated in
   `features/workbench/api.ts`. Both should collapse into one exported helper
   when `features/work` is next opened — wave 5.
6. **No keyboard action centre on the workbenches.** `WorkCommand.keyboard` is
   carried in the type and ignored by these pages: `/sales/*` already binds
   `j s u l v a` through `HoneyQuickActions`, and a second global key listener
   would fight it. Today and the yard queue keep theirs (D8).
7. **`/sales/workbench` inherits nine chrome fetches.** `sales/layout.tsx` →
   `SalesSectionNav` → `HoneyQuickActions` mounts its six record dialogs
   eagerly, prefetching their option lists on every `/sales/*` route. The
   workbench itself reads nothing but `GET /sales/workbench`; the chrome reads
   are listed by name in `workbench.spec.ts` so the assertion still fails if
   the *page* grows a fetch. `features/honey` and the section nav are not
   owned this wave — wave 5's nav rewrite is where this goes to zero.
8. **Deep links point at today's routes.** The workbenches link to
   `/honey/sessions/[id]`, `/honey/lots`, `/honey/jars`, `/sales/[id]`,
   `/sales/consignment/[id]` and `/sales/market-day`. Nothing is renamed,
   deleted or redirected here; wave 5 rewrites them in one change. The pages
   are reachable by URL only — `NAV_ITEMS`, `MOBILE_PRIORITY`, `manifest.ts`
   and `sw.js` are untouched.

- **Depends on** wave 3 (commands own their transactions) and the landed
  ledger.
- **Scope.** `GET /production/workbench` and `GET /sales/workbench` (§4.8),
  reading only `inventory_available` and `inventory_balances`; migrate rows 3,
  9, 13, 14 and 15 of §5.4; fix the offline manifest gaps (§1.4 gaps 1 and 2,
  and D4) so a "start extraction" work item can state its disposition
  truthfully.
- **Owned paths.** `backend/internal/app/{production,sales}/**`,
  `backend/internal/httpapi/routes_workbench.go`,
  `backend/internal/httpapi/offline_routes.go`,
  `frontend/src/lib/offline-routes.generated.ts` (regenerated),
  the two workbench frontends.
- **Tests.** `TestOfflineRouteManifestMatchesFrontend` passes after
  regeneration; no workbench field is sourced from a legacy quantity table;
  shortfall and lockout explanations appear before the refusal.
- **Acceptance.** Production is followable from hive harvest through
  extraction, lot, bottling, finished stock and sale without leaving Production
  and Sales; neither workbench is assembled from more than one call.

### Wave 5 — The route rewrite, in one change

- **Depends on** waves 2 and 4: canonical destinations must exist before
  aliases are deleted.
- **Scope.** Everything in `docs/plans/2026-09-03-route-rename-map.md`, in one
  commit: `NAV_ITEMS`, `MOBILE_PRIORITY` and `contextualNavRoutes`; every page
  move; `manifest.ts` `start_url` and its three shortcuts; the SW `SHELL`;
  `CALM_ROUTES` derived from `NAV_ITEMS`; the palette's two record hrefs
  (`provider.tsx:352,363` — **not** `:375`); the projection's item hrefs;
  `hiveTagQR` (`routes_field_intelligence.go:625`); deletion of the twelve
  `/harvest/*` shims, `/genealogy`, `/honey/market-day`, `/honey/sales` and
  `/honey/sales/[id]`; deletion of `commerceSlugReserved`
  (`routes_commerce.go:77-85`, call sites `:667` and `:798`) and its test
  (`routes_commerce_test.go:82-83`); the three pinned e2e specs updated in the
  same change; `README.md:59-64`, which names the precached field routes in
  prose.
- **Owned paths.** `frontend/src/app/**`, `frontend/src/components/shell/**`,
  `frontend/src/components/install-prompt.tsx`,
  `frontend/src/components/shortcuts/provider.tsx`,
  `frontend/src/app/{manifest.ts,sw.js/route.ts}`, `frontend/tests/e2e/**`,
  `backend/internal/httpapi/{routes_commerce.go,routes_field_intelligence.go}`,
  `README.md`.
- **Tests.** `design-promises.spec.ts:114-128` and `offline.spec.ts:52-59`
  updated to the new `SHELL`; `honey-gaps.spec.ts:126` retargeted;
  `navigation.spec.ts` gotos retargeted; a **new negative spec**
  `frontend/tests/e2e/retired-routes.spec.ts` asserting every retired path
  returns 404; the repo-search regexes in the rename map return only that spec
  and historical documentation.
- **Acceptance.** No compatibility redirect exists anywhere in the tree; the
  repo search is clean; `/honey/[slug]` and its QR still resolve.

### Wave 6 — Settings split

- **Depends on** wave 5 (the routes exist).
- **Scope.** The `user_preferences` migration and backfill (§6.4); `/me`,
  `/admin/setup` and `/admin`; contextual manage links from Production, Sales,
  Equipment and the lockout work item; move the compliance packet and the
  GnuCash reconciliation report to Insights; move the labor control to
  `/yard/queue` and its enable flag to Operation Setup; delete `/settings`.
- **Owned paths.** `backend/internal/db/migrations/`,
  `backend/internal/httpapi/routes_settings.go`,
  `frontend/src/features/settings/**`, `frontend/src/features/access/**`, the
  new route files.
- **Tests.** A non-admin can read and write **their own** preferences and
  cannot read `ai_provider_config` or `ntfy_access_token`; two users' theme
  changes do not overwrite each other; an inventory test over the section
  registry asserts every configuration object has exactly one editor.
- **Acceptance.** No configuration object has two editors; Preferences is
  per-user in data as well as in access.

### Wave 7 — Deletion sweep

- **Depends on** waves 5 and 6, plus one offline-receipt TTL window after wave
  5 (`RECEIPT_TTL_MS = 30 days`, `sw.js/route.ts:38`) before the
  `/api/v1/honey/sales` **API** alias may go (D3).
- **Scope.** Delete `yard_queue.go` and `yard_queue_test.go`, the
  recommendations inbox view, the orphaned dashboard widgets, the
  `/api/v1/honey/sales` registration (`routes_honey.go:45-52`) and its manifest
  entry (`offline_routes.go:55`), and every handler in §5.4 whose command now
  owns it.
- **Tests.** The full backend suite; the frontend e2e suite; the five journeys
  of §3 walked end to end against canonical paths only.
- **Acceptance.** The roadmap's acceptance criteria, verbatim.

---

## 8. Open questions for the operator

**Decided 2026-09-03 by the lead under the operator's standing "use your
judgement" instruction, before the implementation waves launched:**
(1) expenses and customers live under **Sales** — Insights stays read-only;
(2) **area-prefixed paths** (`/yard/hives/[id]`) — greppable ownership wins
over two path segments; (3) "start extraction" stays **`online_only`** — a
duplicated harvest session under replay is not an acceptable residual for a
weight-bearing record; revisit once `RunIdempotent` has run in production.

1. **S11, expenses under Sales.** This widens the roadmap's Sales charter
   ("market day, orders, consignment, customers, settlement, and payment") to
   include money out. The alternative is a Finance sub-area under Insights that
   is allowed to write, which contradicts "Insights = reports". The
   recommendation stands; the decision is the operator's.
2. **Path depth.** `/yard/hives/[id]/queen` is two segments deeper than
   `/hives/[id]/queen`. The gain is that area ownership is greppable and the
   acceptance criterion becomes mechanical. If short paths are preferred, the
   fallback is flat roots (`/hives`, `/apiaries`, `/queens`) with an `area:`
   field on each `NAV_ITEM` — the same IA, a weaker test.
3. **Offline "start extraction"** (§1.4 gap 1) requires
   `POST /api/v1/harvest-sessions` to become queueable, which means a session
   create must be idempotent under replay. Wave 3's `RunIdempotent` makes that
   possible; wave 4 must decide whether a duplicated session is an acceptable
   residual risk in exchange for a fully offline field day.
