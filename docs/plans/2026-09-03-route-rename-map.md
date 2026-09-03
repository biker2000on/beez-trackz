# Route rename map — roadmap P1 item 10

**Status: executed 2026-09-03 by wave 5**, in one change, with the deviations
recorded in §7 of `docs/plans/2026-09-03-workflow-reset-design.md`. It is the
machine-checkable half of that document. Old paths were **deleted**, never
redirected (roadmap: "Do not add compatibility redirects or preserve the
current redirect chain"); `frontend/tests/e2e/retired-routes.spec.ts` is the
standing proof — it asserts every retired path answers 404 with
`maxRedirects: 0`, that the evacuated `/honey/*` pages are now public story
slugs rather than app pages, and that `/honey/[slug]` still resolves.

The §4 searches are clean as of that change: the only hits left are that
negative spec, this document and its siblings under `docs/`, the four live API
paths §3 protects, and `polyagent-review-*.md`. Sixty rows below; all sixty
are done. The table is kept in the past tense of the tree it produced, so it
stays readable as the record of what moved where.

**Frozen — never rename, never delete:**

| Path | Why | Enforced by |
|---|---|---|
| `/honey/[slug]` | the only external URL contract; printed on jar QR codes | `writeHoneyStoryQR` (`backend/internal/httpapi/routes_commerce.go:1238-1239`), `frontend/src/app/honey/[slug]/page.tsx`, `frontend/src/features/commerce/lots-tab.tsx:136`, palette `frontend/src/components/shortcuts/provider.tsx:375` |
| `/login`, `/setup`, `/offline` | auth and offline shell | SW `SHELL` (`frontend/src/app/sw.js/route.ts:26-27`) |

`/hives/{id}` is **not** frozen: no QR label has ever been printed (operator
decision 2026-09-01), so the hive-tag generator
(`backend/internal/httpapi/routes_field_intelligence.go:625`) is rewritten with
everything else. See §0 D1 of the design document.

---

## 1. Rename table

`Type` is `move` (the page exists and its path changes), `delete-shim` (the
page is only a `redirect()` and disappears), or `delete` (the page is replaced
by a new surface). "Non-route consumers" lists every place other than the page
file itself that must change in the same commit.

| # | Old path | New path | Type | Non-route consumers to update in the same commit | Status |
|---|---|---|---|---|---|
| 1 | `/` | `/today` | move | `frontend/src/app/page.tsx:4` | Complete (wave 5a) |
| 2 | `/dashboard` | `/today` | move | `sw.js/route.ts:28`; `install-prompt.tsx:35`; `nav-items.ts:45,381`; `manifest.ts:9` (`start_url`); `components/shell/sidebar.tsx:83`; `app/error.tsx:44`; `app/offline/page.tsx:24`; `features/apiaries/overview-tab.tsx:126`; `app/(auth)/login/page.tsx:63,87`; `features/transcription/batch-review.tsx:130`; `features/dashboard/dashboard-view.tsx` (deleted); **`backend/internal/httpapi/routes_auth.go:573`** (OIDC success redirect); e2e `design-promises.spec.ts:120`, `offline.spec.ts:54` | Complete (wave 5a) |
| 3 | `/operations/yard-queue` | `/yard/queue` | move | `sw.js/route.ts:29`; `install-prompt.tsx:36`; `nav-items.ts:53,386`; `features/dashboard/dashboard-view.tsx:37`; `features/operations/yard-queue.tsx:135`; `features/operations/hooks.ts:189` (**API path — do not rename**, see §3); e2e `design-promises.spec.ts:121`, `offline.spec.ts:55` | Complete (wave 5a) |
| 4 | `/recommendations` | `/today/recommendations` | move | `install-prompt.tsx:42`; `nav-items.ts:223,389`; `features/dashboard/dashboard-view.tsx:39`; `features/dashboard/needs-attention-widget.tsx:55`; `features/dashboard/todays-actions-widget.tsx:51`; `backend/internal/httpapi/yard_queue.go:166` (deleted with the file in wave 7; its replacement in `app/work` must emit the new path) | Complete (wave 5a) |
| 5 | `/apiaries` | `/yard/apiaries` | move | `install-prompt.tsx:37`; `nav-items.ts:61,382`; `manifest.ts:22` | Complete (wave 5a) |
| 6 | `/apiaries/[id]` | `/yard/apiaries/[id]` | move | `nav-items.ts:246-247` (`contextualNavRoutes`); `provider.tsx:313-320`; e2e `navigation.spec.ts:161,166,226` | Complete (wave 5a) |
| 7 | `/apiaries/[id]/flora` | `/yard/apiaries/[id]/flora` | move | `nav-items.ts:248` | Complete (wave 5a) |
| 8 | `/apiaries/[id]/photos` | `/yard/apiaries/[id]/photos` | move | `nav-items.ts:249`; e2e `navigation.spec.ts:167` | Complete (wave 5a) |
| 9 | `/apiaries/[id]/labels` | `/yard/apiaries/[id]/labels` | move | `nav-items.ts:250` | Complete (wave 5a) |
| 10 | `/apiaries/[id]/bulk` | `/yard/apiaries/[id]/bulk` | move | `nav-items.ts:251` | Complete (wave 5a) |
| 11 | `/apiaries/[id]/timeline` | `/yard/apiaries/[id]/timeline` | move | in-app links only | Complete (wave 5a) |
| 12 | `/hives` | `/yard/hives` | move | `install-prompt.tsx:38`; `nav-items.ts:77,383`; `manifest.ts:29`; `sw.js/route.ts` `SHELL` (**added**, §2); e2e `a11y-bulk-select.spec.ts:72,98,116`, `navigation.spec.ts:263` | Complete (wave 5a) |
| 13 | `/hives/[id]` | `/yard/hives/[id]` | move | `nav-items.ts:264-274`; `provider.tsx:334-341`; `features/dashboard/dashboard-view.tsx:174`; **`backend/internal/httpapi/yard_queue.go:104,169,212,265`**; **`backend/internal/httpapi/routes_field_intelligence.go:625`** (`hiveTagQR` target); e2e `navigation.spec.ts:169,174,226-228` | Complete (wave 5a) |
| 14 | `/hives/[id]/equipment` | `/yard/hives/[id]/equipment` | move | `nav-items.ts:272` | Complete (wave 5a) |
| 15 | `/hives/[id]/queen` | `/yard/hives/[id]/queen` | move | `nav-items.ts:273`; e2e `navigation.spec.ts:174-175` | Complete (wave 5a) |
| 16 | `/hives/[id]/photos` | `/yard/hives/[id]/photos` | move | `nav-items.ts:274` | Complete (wave 5a) |
| 17 | `/hives/[id]/transcribe` | `/yard/transcribe?hive=[id]` | delete | `nav-items.ts:276-280` (merged into one entry, S10) | Complete (wave 5b) |
| 18 | `/transcribe` | `/yard/transcribe` | move | `nav-items.ts:68,254`; `features/apiaries/detail-page.tsx:153` | Complete (wave 5a) |
| 19 | `/queens` | `/yard/queens` | move | `nav-items.ts:215,390`; `install-prompt.tsx` (**added**, currently missing) | Complete (wave 5a) |
| 20 | `/genealogy` | — | delete-shim | `install-prompt.tsx:39` (stale entry, removed) | Complete (wave 5b) |
| 21 | `/honey` | `/production` | move | `sw.js/route.ts:30`; `install-prompt.tsx:40`; `nav-items.ts:85,384`; `manifest.ts:36`; `features/honey/section-nav.tsx:27,60`; e2e `honey-gaps.spec.ts:116`, `navigation.spec.ts:181`, `design-promises.spec.ts:124` | Complete (wave 5a) |
| 22 | `/honey/activity` | `/production/activity` | move | `nav-items.ts:92`; `section-nav.tsx:29`; e2e `navigation.spec.ts:188,243` | Complete (wave 5a) |
| 23 | `/honey/production` | `/production/overview` | move | `nav-items.ts:97`; `section-nav.tsx:32` | Complete (wave 5a) |
| 24 | `/honey/harvests` | `/production/harvests` | move | `nav-items.ts:100,108`; `section-nav.tsx:35` | Complete (wave 5a) |
| 25 | `/honey/jars` | `/production/jars` | move | `nav-items.ts:101,109` | Complete (wave 5a) |
| 26 | `/honey/lots` | `/production/lots` | move | `nav-items.ts:102,122`; `features/commerce/serial-lookup.tsx:144` | Complete (wave 5a) |
| 27 | `/honey/serials` | `/production/serials` | move | `nav-items.ts:103,127`; `features/commerce/lots-tab.tsx:77`; `features/commerce/sale-serials.tsx:84` | Complete (wave 5a) |
| 28 | `/honey/sessions/[id]` | `/production/sessions/[id]` | move | `nav-items.ts:103` (`matches`); `provider.tsx:363` | Complete (wave 5a) |
| 29 | `/honey/products` | `/production/products` | move | `nav-items.ts:104,112` | Complete (wave 5a) |
| 30 | `/honey/varietals` | `/production/varietals` | move | `nav-items.ts:105,117`; add to the new section-nav `matches` (today missing, §1.5 of the design doc) | Complete (wave 5a) |
| 31 | `/honey/market-day` | — | delete-shim | `sw.js/route.ts:31`; `section-nav.tsx:47`; e2e `design-promises.spec.ts:123`, `honey-gaps.spec.ts:126`, `offline.spec.ts:58` | Complete (wave 5b) |
| 32 | `/honey/sales` | — | delete-shim | none in-app (the **API** alias is separate, §3) | Complete (wave 5b) |
| 33 | `/honey/sales/[id]` | — | delete-shim | none in-app | Complete (wave 5b) |
| 34 | `/harvest` | — | delete-shim | none | Complete (wave 5b) |
| 35 | `/harvest/activity` | — | delete-shim | none | Complete (wave 5b) |
| 36 | `/harvest/harvests` | — | delete-shim | none | Complete (wave 5b) |
| 37 | `/harvest/jars` | — | delete-shim | none | Complete (wave 5b) |
| 38 | `/harvest/lots` | — | delete-shim | none | Complete (wave 5b) |
| 39 | `/harvest/market-day` | — | delete-shim | none | Complete (wave 5b) |
| 40 | `/harvest/production` | — | delete-shim | none | Complete (wave 5b) |
| 41 | `/harvest/products` | — | delete-shim | none | Complete (wave 5b) |
| 42 | `/harvest/sales` | — | delete-shim | none | Complete (wave 5b) |
| 43 | `/harvest/sales/[id]` | — | delete-shim | none | Complete (wave 5b) |
| 44 | `/harvest/serials` | — | delete-shim | none | Complete (wave 5b) |
| 45 | `/harvest/sessions/[id]` | — | delete-shim | none | Complete (wave 5b) |
| 46 | `/inventory` | `/equipment` | move | `install-prompt.tsx:41`; `nav-items.ts:156,387`; `features/dashboard/frame-shortage-widget.tsx:23`; nav keyword `nav-items.ts:161` drops the word "inventory" | Complete (wave 5a) |
| 47 | `/inventory/types` | `/equipment/types` | move | `nav-items.ts:164` | Complete (wave 5a) |
| 48 | `/reports` | `/insights` | move | `install-prompt.tsx:43`; `nav-items.ts:172,388`; `features/dashboard/dashboard-view.tsx:38`; `features/operations/reports-nav.tsx:19`; `features/operations/report-directory.tsx`; `features/operations/reports-overview.tsx`; e2e `navigation.spec.ts:198` | Complete (wave 5a) |
| 49 | `/reports/outcomes` | `/insights/outcomes` | move | `nav-items.ts:178`; `reports-nav.tsx:32` | Complete (wave 5a) |
| 50 | `/reports/survival` | `/insights/survival` | move | `nav-items.ts:181`; `reports-nav.tsx:21,34` | Complete (wave 5a) |
| 51 | `/reports/yield` | `/insights/yield` | move | `nav-items.ts:182`; `reports-nav.tsx:22,35` | Complete (wave 5a) |
| 52 | `/reports/finance` | `/insights/finance` | move | `nav-items.ts:187`; `reports-nav.tsx:37`; e2e `navigation.spec.ts:205,229` | Complete (wave 5a) |
| 53 | `/reports/economics` | `/insights/economics` | move | `nav-items.ts:195`; `reports-nav.tsx:23,41` | Complete (wave 5a) |
| 54 | `/reports/profitability` | `/insights/profitability` | move | `nav-items.ts:196`; `reports-nav.tsx:24,42` | Complete (wave 5a) |
| 55 | `/reports/expenses` | `/sales/expenses` | move | `nav-items.ts:197`; `reports-nav.tsx:25,43` — **area change**, S11 | Complete (wave 5a) |
| 56 | `/reports/sales-planning` | `/insights/sales-planning` | move | `nav-items.ts:202`; `reports-nav.tsx:47` | Complete (wave 5a) |
| 57 | `/reports/bottling` | `/insights/bottling` | move | `nav-items.ts:206`; `reports-nav.tsx:26,49` | Complete (wave 5a) |
| 58 | `/reports/customers` | `/sales/customers` | move | `nav-items.ts:207`; `reports-nav.tsx:27,49` — **area change**, S12 | Complete (wave 5a) |
| 59 | `/settings` | `/me` + `/admin/setup` + `/admin` | delete | `nav-items.ts:231,391`; `features/settings/settings-view.tsx` split (wave 6); the compliance packet moves to `/insights/compliance` and the GnuCash reconciliation report to `/insights/reconciliation` | Complete (wave 5b) |
| 60 | `/sales`, `/sales/[id]`, `/sales/market-day`, `/sales/consignment`, `/sales/consignment/[id]` | unchanged | — | `sw.js/route.ts:32-33` keeps both `SHELL` entries; `provider.tsx:352` unchanged | Verified unchanged (wave 5a) |

Sixty rows. Fifteen of them are `delete-shim` — the twelve `/harvest/*`
pages plus `/honey/market-day`, `/honey/sales` and `/honey/sales/[id]` — and
fourteen of those fifteen have **zero** in-app link consumers. The single
exception is `/honey/market-day`, which is precached in the SW `SHELL` and
pinned by three e2e specs, so it cannot be deleted outside the coordinated
wave-5 commit.

---

## 2. Non-route surfaces, before and after

| Surface | file:line | Before | After |
|---|---|---|---|
| `manifest.start_url` | `frontend/src/app/manifest.ts:9` | `/dashboard` | `/today` |
| manifest shortcut 1 | `manifest.ts:22` | `/apiaries` | `/yard/apiaries` |
| manifest shortcut 2 | `manifest.ts:29` | `/hives` | `/yard/hives` |
| manifest shortcut 3 | `manifest.ts:36` | `/honey` | `/production` |
| SW `SHELL` | `frontend/src/app/sw.js/route.ts:25-37` | `/offline`, `/login`, `/dashboard`, `/operations/yard-queue`, `/honey`, `/honey/market-day`, `/sales`, `/sales/market-day` | `/offline`, `/login`, `/today`, `/yard/queue`, `/yard/hives`, `/production`, `/sales`, `/sales/market-day` |
| `CALM_ROUTES` | `frontend/src/components/install-prompt.tsx:34-44` | nine hand-written paths including the dead `/genealogy`, missing `/queens` and `/sales` | derived from the `NAV_ITEMS` roots plus `/today/recommendations` |
| `MOBILE_PRIORITY` | `frontend/src/components/shell/nav-items.ts:380-392` | eleven module paths | `/today`, `/yard`, `/production`, `/sales`, `/equipment`, `/insights`, `/admin` |
| palette sale href | `frontend/src/components/shortcuts/provider.tsx:352` | `/sales/${sale.id}` | unchanged |
| palette session href | `provider.tsx:363` | `/honey/sessions/${session.id}` | `/production/sessions/${session.id}` |
| palette story href | `provider.tsx:375` | `/honey/${lot.publicSlug}` | **unchanged — frozen** |
| hive tag QR target | `backend/internal/httpapi/routes_field_intelligence.go:625` | `AppURL + "/hives/" + id` | `AppURL + "/yard/hives/" + id` |
| honey story QR target | `backend/internal/httpapi/routes_commerce.go:1239` | `StoryBaseURL() + "/honey/" + slug` | **unchanged — frozen** |
| reserved slug guard | `routes_commerce.go:77-85`, called at `:667` and `:798` | ten reserved slugs (and, incorrectly, not `varietals`) | **deleted**, with `routes_commerce_test.go:82-83` |
| README precache prose | `README.md:61-62` | "dashboard, yard queue, harvest, sales, and both market-day screens" | "today, yard queue, hives, production, sales, and market day" |

---

## 3. API paths that must NOT be renamed

The UI rename must not touch the HTTP surface. These strings look like retired
UI paths but are API resources; a careless global replace breaks the app and
every queued offline mutation.

| API path | Where it is used | Note |
|---|---|---|
| `/operations/yard-queue` | `features/operations/hooks.ts:189`; registered at `backend/internal/httpapi/routes_operations.go:39` | the endpoint is deleted in wave 7 with `yard_queue.go`, and replaced by `/work/yard` — but it is not *renamed* by wave 5 |
| `/recommendations`, `/recommendations/state`, `/recommendations/run`, `/recommendations/count` | `features/recommendations/api.ts:34,61,73`; `features/dashboard/hooks.ts:67`; `routes_recommendations.go:17-26` | the domain endpoints stay; only the **page** moves |
| `/settings`, `/settings/preferences`, `/settings/ai*`, `/settings/gnucash*`, `/settings/ntfy`, `/settings/storage` | `features/settings/api.ts`; `routes_settings.go` | unchanged in wave 5; wave 6 may split the handlers, not the prefix |
| `/apiaries`, `/hives`, `/queens`, `/inspections`, `/feedings`, `/harvests`, `/harvest-lots`, `/harvest-sessions`, `/products`, `/expenses`, `/customers`, `/jar-sizes`, `/equipment/*`, `/sales`, `/honey/*` | throughout `frontend/src/features/**/api.ts` and `hooks.ts`; `backend/internal/httpapi/offline_routes.go:33-79` | the offline manifest is API prefixes only, so **wave 5 changes nothing in it** |
| `/api/v1/honey/sales` | `routes_honey.go:45-52` (registered alongside `/sales`); `offline_routes.go:55` | kept through wave 5 so mutations queued before the deploy still replay; retired in wave 7 after one `RECEIPT_TTL_MS` window (`sw.js/route.ts:38`, 30 days) |

---

## 4. The verification search

After wave 5, these searches must return **only** negative tests and historical
documentation. Run from the repository root, with `rg` 14.x. Two mechanical
notes, both verified while writing this map:

- `rg` uses the Rust regex engine, so lookbehind is unavailable. The patterns
  anchor on the delimiter that precedes a UI path in source instead.
- On Git Bash / MSYS2 (this repository's Windows shell) a pattern that *starts*
  with `/` is silently rewritten into a Windows path before `rg` sees it, and
  the search then matches nothing. Every pattern below therefore begins with a
  group, never with a bare `/`. Use `-e` so the pattern is unambiguous.

### 4.1 Retired path prefixes that are unambiguous (no API name collision)

```
rg -n --hidden -g '!node_modules' -g '!.git' -e \
  '(?:/)(dashboard|genealogy|harvest/(activity|harvests|jars|lots|market-day|production|products|sales|serials|sessions)|honey/(activity|harvests|jars|lots|market-day|products|sessions)|inventory/types|operations/yard-queue)(["'"'"'`?)/ ,\]]|$)'
```

Four deliberate omissions, each because the string is also a live **API** path
and would otherwise be a permanent false positive (all four verified against
`abdd2a7`):

- `/harvest` on its own — `/harvest-lots`, `/harvest-sessions` and
  `/harvest-entries` are live endpoints (`offline_routes.go:42-43,60`).
- `/honey/production` — `GET /honey/production-plan`
  (`routes_commerce.go:47`).
- `/honey/varietals` — `GET`/`POST`/`PATCH /honey/varietals`
  (`routes_honey.go:34-36`; `routes_honey_varietals.go:138,197,227`).
- `/honey/serials` — `GET /honey/serials/{serialNumber}`
  (`routes_serials.go:23,79`).

All four retired **pages** are covered by 4.2, which anchors on link context
and therefore cannot match an API call. Note also the explicit terminator
class: a bare `\b` would match `/honey/production-plan` after "production",
which is why it is not used.

### 4.2 Retired paths that collide with live API names — anchored on link context

```
rg -n --hidden -g '!node_modules' -g '!.git' -e \
  '(href=\{?["`'"'"']|router\.(push|replace)\(["`'"'"']|redirect\(["`'"'"']|page\.goto\(["`'"'"'])/(dashboard|apiaries|hives|queens|genealogy|transcribe|harvest|honey|inventory|reports|recommendations|settings|operations)([/"`'"'"'?]|$)'
```

Verified against the tree at `abdd2a7`: this pattern currently returns the
`navigation`, `honey-gaps`, `design-promises` and `a11y-bulk-select` specs plus
every in-app link listed in §1, which is exactly the set wave 5 must empty.

Every hit must be one of: an entry in `frontend/tests/e2e/retired-routes.spec.ts`,
a line in `docs/plans/*`, `docs/product-history.md`, `docs/product-roadmap.md`
or `docs/rewrite/*` (all historical), or a line in `polyagent-review-*.md`. Any
other hit is a miss in wave 5.

Backend hits are in scope too. Run 4.1 and 4.2 against `backend/` as well as
`frontend/`: at `abdd2a7` that surfaces three, and wave 5 or wave 7 must clear
each — `backend/internal/httpapi/routes_auth.go:573` (the OIDC success
redirect), `backend/internal/httpapi/routes_operations.go:39` (the
`/operations/yard-queue` **API** registration, deleted in wave 7), and
`backend/internal/httpapi/yard_queue_test.go:78,112` (deleted with the file).

### 4.3 The non-route surfaces, checked literally

```
rg -n 'const SHELL = \[' -A 12 frontend/src/app/sw.js/route.ts
rg -n 'start_url|url: "/' frontend/src/app/manifest.ts
rg -n 'CALM_ROUTES' -A 12 frontend/src/components/install-prompt.tsx
rg -n 'MOBILE_PRIORITY' -A 14 frontend/src/components/shell/nav-items.ts
rg -n '"/hives/"' backend/internal/httpapi/
rg -n 'commerceSlugReserved' backend/internal/
```

Expected after wave 5: the first four print only canonical paths; the fifth
prints nothing (the hive-tag target is `"/yard/hives/"` and `yard_queue.go` is
gone or rewritten); the sixth prints nothing.

### 4.4 The `inventory` vocabulary rule (§2.3 of the design document)

```
rg -n --files frontend/src/app | rg 'inventory'
rg -n -i 'inventory' frontend/src/components frontend/src/features --glob '!**/*.test.*'
```

The first must print nothing: no route segment named `inventory` may exist. The
second may print only strings that describe the ledger itself, never hive gear.

### 4.5 The negative spec

`frontend/tests/e2e/retired-routes.spec.ts` is created in wave 5 and is the one
file allowed to name retired paths in `frontend/`:

```ts
// The route reset deleted these paths outright — no redirects (roadmap P1
// item 10). If any of them resolves again, an alias has crept back in.
const RETIRED = [
  "/dashboard", "/operations/yard-queue", "/recommendations", "/apiaries",
  "/hives", "/queens", "/genealogy", "/transcribe",
  "/harvest", "/harvest/activity", "/harvest/harvests", "/harvest/jars",
  "/harvest/lots", "/harvest/market-day", "/harvest/production",
  "/harvest/products", "/harvest/sales", "/harvest/serials",
  "/honey/activity", "/honey/harvests", "/honey/jars", "/honey/lots",
  "/honey/market-day", "/honey/production", "/honey/products",
  "/honey/sales", "/honey/serials", "/honey/varietals",
  "/inventory", "/inventory/types",
  "/reports", "/reports/outcomes", "/reports/survival", "/reports/yield",
  "/reports/finance", "/reports/economics", "/reports/profitability",
  "/reports/expenses", "/reports/sales-planning", "/reports/bottling",
  "/reports/customers",
  "/settings",
];

for (const path of RETIRED) {
  test(`${path} is gone`, async ({ page }) => {
    const response = await page.goto(path);
    expect(response?.status(), `${path} still resolves`).toBe(404);
  });
}

test("the public honey story is still reachable", async ({ page }) => {
  const response = await page.goto("/honey/summer-clover-2026");
  expect(response?.status()).not.toBe(404);
});
```

The list is exactly the "Old path" column of §1 minus the frozen rows, and the
final test is the guard that the evacuation of `/honey/*` did not take the
public namespace with it.
