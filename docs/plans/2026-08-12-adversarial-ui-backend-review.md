# Adversarial Review — Navigation/Layout, Backend Robustness, and Full-Stack Seams

Reviewed 2026-08-12 against the live Go + Next stack (`backend/`, `frontend/`) at
commit `b234d82`. Three independent read-only reviewers, one per layer; no source
files were modified during the review.

Scope was set by the standing complaint that **"the navigation and layout still
seems clunky"**, widened to backend robustness and the frontend/backend seam.

**Evidence caveat:** `npx tsc --noEmit` and `npm run lint` could not run —
`frontend/node_modules` has no local `typescript` or `eslint` installed. Every
frontend finding below is from source reading with file:line evidence, not from a
type-checked build. Installing frontend dev dependencies so the gates can run is
itself a backlog item (UX-024).

ID prefixes: `UX-` navigation/layout/interaction/a11y, `SEAM-` frontend↔backend
seam, `API-` Go backend internals.

---

## The pattern behind the findings

Three reviewers working on different layers converged on one root cause: **the
documented contract and the implementation have drifted, and nothing tests the
seam.**

- `DESIGN.md:27,34` promises safe-area handling. A repo-wide grep for
  `env(safe-area` returns two hits: the helper definition and its single consumer.
- `DESIGN.md:33` promises horizontally scrollable mobile tabs. `section-nav.tsx:6-8`
  deliberately replaced them with a `<Select>`; the doc was not updated.
- `README.md:55` and `DESIGN.md:16` promise cached field reads offline. Offline
  navigation lands on `/offline` for every route.
- `README.md:57` promises newer server edits become reviewable conflicts "instead of
  being overwritten". `sw.js/route.ts:461` restamps `queuedAt` on retry, which
  guarantees the overwrite.
- `middleware_offline.go:72-87` hardens the honey/commerce endpoints for offline
  replay, with a comment calling market day "the most offline-prone surface in the
  product — a farmers' market with no signal". The service worker's queue list
  contains none of those paths.

The recurring fix is to make each pair of lists **one artifact** — a shared manifest,
a generated list, or a test asserting they agree — rather than repairing each drift
in isolation.

---

## P0 — Silent data loss and silent data mutation

### SEAM-001 (Critical) — Market-day POS swallows every sale failure
`frontend/src/features/commerce/market-day-tab.tsx:43,81-102,170` ·
`frontend/src/features/honey/hooks.ts:219-228`

`useRecordSale` sets `silentError: true`, which is correct for
`record-sale-dialog.tsx` — that component renders `mutation.error` inline at
`:187-210`. Market day inherits the same hook, passes only `onSuccess`, and never
reads `sale.error` or `sale.isError`; the file's only error branch is
`inventory.isError` at `:61`.

A sale that fails on insufficient stock (`"Not enough Pint: need 4, have 2"`), 403,
500, or a dropped connection produces nothing on screen. The button re-enables, the
cart still shows the jars, and the beekeeper hands over honey believing it was
recorded — or taps again and books it twice.

**Fix:** pass `silentError` as a prop, or render `sale.error` above the Complete-sale
button exactly as the dialog does.

### SEAM-002 (Critical) — A 401/403 during replay wedges the entire offline queue
`frontend/src/app/sw.js/route.ts:190` ·
`frontend/src/components/pwa-register.tsx:93-94,114-119,128-141,153-154`

`replayQueue` does `if (response.status === 401 || response.status === 403) break;`.
The item stays `state: "pending"`, so it is never promoted to `failed` and never
enters the review dialog (which filters `item.state !== "pending"`). `issues` stays
0, so the banner renders the `Syncing ${queue.pending} queued changes…` branch with a
Retry button that re-runs `replayQueue` and 401s again.

A session that expired overnight turns a day of queued inspections into a permanent
silent spinner with no "sign in" prompt. One editor-only 403 jams every queued write
behind it.

**Fix:** on 401 mark the queue `needs-auth` and broadcast a state the banner renders
as "Sign in to sync N changes" linking to `/login`; on 403 mark that single item
`failed` with the server message and `continue` past it.

### SEAM-003 (Critical) — Logging out silently destroys unsent field work
`frontend/src/app/sw.js/route.ts:120-123,342-355` ·
`frontend/src/components/shell/logout-button.tsx:15-24`

The logout branch calls `clearPrivateOfflineState()` —
`Promise.all([caches.delete(DATA_CACHE), clearQueue()])` — wiping the IndexedDB
mutation store. `LogoutButton` fires on a single click with no confirmation and no
awareness that a queue exists.

The login branch at `:366-375` deliberately *preserves* the queue for exactly this
reason, and the comment says so. Logout discards it anyway.

**Fix:** have `LogoutButton` request queue status first and block on a confirm dialog
when `pending > 0`; or stop clearing the queue on logout and scope queue entries by
user id.

### UX-001 (Critical) — `g d`, `g s`, `g r` silently mutate records while navigating
`frontend/src/features/dashboard/dashboard-view.tsx:136-174` ·
`frontend/src/components/shortcuts/provider.tsx:236-253`

`DashboardView` installs a second `window` keydown listener binding bare `d`
(dismiss), `s` (snooze 7 days), `r` (refill feeder), and `o`/`Enter`. The shortcuts
provider makes `g` arm a 1500 ms goto prefix. Neither listener knows about the other;
`preventDefault()` does not stop a sibling listener on the same target, and React
flushes child effects before parent effects, so the dashboard's handler registers and
fires first. On `/dashboard`:

- `g d` (documented: go to Dashboard) **dismisses the top Needs-attention
  recommendation**, then navigates.
- `g s` (go to Settings) **snoozes the top item for 7 days**, then navigates away so
  the toast is seen out of context.
- `g r` (go to Recommendations) **refills a feeder** that was never refilled.

`focusedIndex` initialises to `0` at `:73` with no prior user interaction, so a bare
`d`/`s`/`r` resolves a row the user never focused. None of these writes confirm and
none offer undo. The only discoverability hint is `:197`, which is `md:block` —
invisible on mobile, where a paired Bluetooth keyboard still fires the keys. Because
they bypass `useShortcut`, they never appear in the `?` help dialog either.

**Fix:** delete the ad-hoc listener; register `d`/`s`/`r`/`o`/arrows through
`useShortcut` so they route through the single provider handler, which already
suppresses page keys while the `g` prefix is armed. Require explicit focus before row
keys resolve, and add an undo action to the success toast.

### API-001 (Critical) — Concurrent first-run setup lets two callers claim the instance
`backend/internal/httpapi/routes_auth.go:90,120` ·
`backend/internal/db/migrations/00001_init.sql:318`

Two attackers POST `/auth/setup` concurrently: both observe no `user_settings` row,
both insert a password hash. The schema has neither a singleton constraint nor a
transaction/lock, and login uses `SELECT ... LIMIT 1`, so either attacker's password
may become the effective owner credential.

**Fix:** make setup a single serializable transaction protected by an advisory lock or
a singleton constraint; check completion before bcrypt; add a concurrent-setup test.

### API-002 (Critical) — Offline idempotency is not atomic with the protected mutation
`backend/internal/httpapi/middleware_offline.go:251,324,345`

A write can commit in its handler, then the process can die before the separate
receipt-completion update. After five minutes the replay claims the still-`processing`
receipt and executes the mutation again. A flaky client duplicates inspections,
feedings, sales, and jarring despite using the same mutation ID — the exact outcome
the middleware exists to prevent.

This is adjacent to ASI-5-001, which fixed the *cancelled-context* half of the
problem (`context.WithoutCancel` for receipt bookkeeping). The remaining gap is the
crash window between the domain commit and the receipt write.

**Fix:** persist the domain mutation and its completed receipt in one transaction, or
use an outbox / domain-level idempotency key with a unique constraint. Add
crash-window recovery coverage.

---

## P0 — The bottom of the screen is unusable in the field

### UX-002 (Critical) — The offline/sync banner completely covers the mobile bottom nav
`frontend/src/components/pwa-register.tsx:105` (`fixed inset-x-3 bottom-3 z-[100]`) ·
`frontend/src/components/install-prompt.tsx:312` (`bottom-3 z-[90] … md:bottom-4`) ·
`frontend/src/components/shell/bottom-nav.tsx:73` (`fixed inset-x-0 bottom-0 z-40`)

Both banners sit 12 px off the bottom at z-90/z-100; the bottom nav occupies roughly
0–85 px at z-40. On any phone the banner paints directly on top of Home / Yards /
Hives / Honey / More. The `md:bottom-4` on the install prompt only moves it on
desktop, where there is no bottom nav to collide with.

`pwa-register.tsx:94` renders whenever `!online || queue.pending || issues` — the
banner is on screen for the entire time the beekeeper is out of cell range, which is
the scenario this PWA exists for. It has no dismiss control.

**Fix:** define `--bottom-nav-h: calc(3.25rem + env(safe-area-inset-bottom))` in
`globals.css` and give both banners `bottom-[calc(var(--bottom-nav-h)+0.75rem)]
md:bottom-4`. Better, fold sync state into the existing top `OfflineBanner` and delete
the floating card, which also resolves UX-014.

### UX-003 (High) — Five sticky bulk toolbars are hardcoded to `bottom-20`
`frontend/src/features/hives/list-page.tsx:304` ·
`frontend/src/features/apiaries/list-page.tsx:208` ·
`frontend/src/features/photos/photo-gallery.tsx:159` ·
`frontend/src/features/queens/genealogy-view.tsx:331` ·
`frontend/src/features/recommendations/recommendations-view.tsx:528`

All five use `sticky bottom-20 z-20 … md:bottom-4`. `bottom-20` is 80 px. The nav's
real height is `py-2` + 20 px icon + 2 px gap + ~13 px label ≈ **51 px plus
`env(safe-area-inset-bottom)`**. `viewportFit: "cover"` is active
(`app/layout.tsx:45`), so that inset is 34 px on every Face-ID iPhone and 24–48 px on
Android gesture bars — nav top edge at 85 px against a toolbar bottom edge at 80 px,
and the nav's `z-40` beats the toolbar's `z-20`.

The clipped region contains the "Exit bulk select" ✕ and the Archive/Delete buttons.
Bulk mode is how a season's deadouts get archived.

**Fix:** `bottom-[calc(var(--bottom-nav-h)+0.5rem)] md:bottom-4` in all five places.

### UX-004 (High) — Market day ignores safe areas entirely
`frontend/src/features/commerce/market-day-page.tsx:57,58,70-73,76`

`fixed inset-0 z-50` beats both the sidebar and the bottom nav (`z-40`), so all
navigation is hidden — deliberate, per the comment at `:4-9`, since "the only way out
is the Exit control". But there is no `pt-[env(safe-area-inset-top)]`, so with
`viewport-fit=cover` in standalone PWA mode the header, cart badge, and **Exit**
button render under the iPhone status bar/notch. There is no bottom inset either, so
the checkout controls sit under the home indicator, where an upward swipe dismisses
the app.

**Fix:** `pt-[env(safe-area-inset-top)]` on the sticky header and
`pb-[calc(6rem+env(safe-area-inset-bottom))]` on the body.

### UX-005 (Medium) — `env(safe-area-inset-*)` is claimed broadly but implemented once
`DESIGN.md:27,34` vs. `frontend/src/app/globals.css:211-213` and its single consumer
`bottom-nav.tsx:73`.

Failing surfaces: the five bulk toolbars (UX-003), the install prompt and sync banner
(UX-002), the "More" bottom sheet (`bottom-nav.tsx:118,125`; `ui/sheet.tsx:51,68`),
market day top and bottom (UX-004), the base dialog `max-h-[calc(100dvh-2rem)]`
(`ui/dialog.tsx:63` — a 16 px margin against a 34 px inset, putting `DialogFooter` and
its submit button out of reach), and landscape left/right insets, which are absent
everywhere.

**Fix:** define `--safe-b` and `--bottom-nav-h` once in `globals.css` and derive every
offset from them; add `pl-/pr-[env(safe-area-inset-*)]` to the app shell.

---

## P1 — The "clunky" cluster

### UX-006 (High) — 768 px tablet cliff: content gets 37% narrower as the viewport widens
`frontend/src/app/(app)/layout.tsx:62-64` (`md:pl-60`, `md:px-8`) ·
`frontend/src/components/shell/sidebar.tsx:64` (`w-60 … md:flex`)

| Viewport | Sidebar | Padding | Content width |
|---|---|---|---|
| 767 px | none | 32 px | **735 px** |
| 768 px | 240 px | 64 px | **464 px** |

Card grids use `sm:grid-cols-2 lg:grid-cols-3` (`hives/list-page.tsx:231`,
`apiaries/list-page.tsx:140`, `dashboard-view.tsx:224`), so a hive card is 359 px at
767 px and **224 px at 768 px** — 38% smaller on a wider screen — and stays cramped
until `lg` at 1024 px. Every `whitespace-nowrap` table (`ui/table.tsx:71,84`) is
forced into horizontal scroll across the entire 768–1024 px band.

This is the band an iPad mini, a 10" Android tablet, or a split-window laptop lands
in. Rotating a tablet to landscape is the only way to make it usable, and rotating
back makes it worse than the phone layout. Most likely single contributor to the
layout complaint.

**Fix:** move the sidebar to `lg:` (`sidebar.tsx:64`, `layout.tsx:62`,
`bottom-nav.tsx:73`), or make it collapsible below `lg`; failing that add an
`md:grid-cols-1 lg:grid-cols-2 xl:grid-cols-3` step. Sweep for other `md:` shell
assumptions (`section-nav.tsx:80,97`) at the same time.

### UX-007 (High) — Single-key shortcuts fire while typing in Radix comboboxes and menus
`frontend/src/components/shortcuts/provider.tsx:55-64,66-73,217,225-226` ·
`frontend/src/components/ui/select.tsx:31,59` · `ui/dropdown-menu.tsx`

`isTypingTarget()` matches only `INPUT`, `TEXTAREA`, `SELECT`, and `contentEditable`.
Radix `SelectTrigger` renders a `<button role="combobox">`, and its open content is
`role="listbox"` in a portal — so neither the typing guard nor `isDialogOpen()` fires.
Radix implements single-character typeahead without calling `preventDefault()`, so the
`event.defaultPrevented` bail at `:217` does not help either.

| Page | Action | Unintended effect |
|---|---|---|
| `/hives` | Apiary filter, type "b" | Toggles bulk-select mode |
| `/hives` | Same filter, type "n" | Opens New hive behind the popup |
| `/hives/[id]` | Focused Select, type "e" | Opens Edit hive |
| `/hives/[id]` | …type "x" | Opens **Split hive** |
| `/harvest` | Focused Select, type "s" | Opens Record-a-sale |
| `/inventory` | Focused Select, type "c" | Toggles physical-count mode |

`dashboard-view.tsx:40-53` (`keyboardBusy`) is a verbatim copy of the same flawed
check, so the UX-001 mutations fire from inside a Select too.

**Fix:** widen the guard to
`target.closest('[role="combobox"],[role="listbox"],[role="menu"],[role="menuitem"],[data-slot="select-trigger"]')`
and treat any mounted `[data-radix-popper-content-wrapper]` as busy. Put the helper in
one module and have `dashboard-view.tsx` import it.

### UX-008 (High) — "All N inspections" lands on the wrong tab (two `router.replace` calls race)
`frontend/src/features/hives/detail-page.tsx:363-366` ·
`frontend/src/lib/url-state.ts:32-43`

`onSeeAll={() => { setTab("timeline"); setFilter("inspections"); }}` — both setters
come from `useSearchParamState`, and each rebuilds the query from the same render-time
`searchParams` snapshot and issues its own `router.replace`. The second replace wins
and drops `tab` entirely, so `tab` falls back to `"overview"` and the user is dumped
back on Overview. The nav's active indicator then faithfully reflects a URL the user
never requested.

**Fix:** add `setMany(patch: Record<string,string>)` to `url-state.ts` that builds one
`URLSearchParams` and issues a single `router.replace`.

### UX-009 (Medium) — Sidebar expansion pins on first click and never re-syncs to the route
`frontend/src/components/shell/sidebar.tsx:56-61,74,80,159` · mirrored at
`bottom-nav.tsx:135,210`

`const open = expanded[item.href] ?? active` — once a section is manually toggled,
`expanded[href]` is pinned for the session and the `?? active` fallback is dead.
Collapse "Honey", navigate to `/harvest/jars`, and Honey stays collapsed with no
indication of where inside it you are. Expand "Reports" and it stays expanded
everywhere. With Honey + Reports + contextual hive/apiary children open, the nav
renders 25+ rows into a 240 px column at `overflow-y-auto` with no `scrollIntoView`
for the active item, so the highlighted row is routinely off-screen.

Nothing is visibly broken; the map is just always slightly wrong. That is the quiet,
constant contributor to "clunky".

**Fix:** clear the manual override for a section when the route enters it (a
`useEffect` keyed on `pathname`), and `scrollIntoView({ block: "nearest" })` the active
link on route change.

### UX-010 (Medium) — Tapping "Yards" sometimes doesn't go to Yards
`frontend/src/features/apiaries/list-page.tsx:48-53`

With exactly one apiary the list `router.replace`s to the apiary detail — but only
once per session, gated on invisible `sessionStorage`. The same nav item does two
different things on first vs. second tap. Because it uses `replace`, Back from the
auto-opened apiary jumps to the Dashboard, skipping a list the user never saw.
Single-apiary is the most common hobbyist configuration, so this is the default
experience.

**Fix:** remove the redirect. If the list is redundant with one yard, render the apiary
detail *at* `/apiaries` instead of navigating away from it.

### UX-011 (Medium) — Mobile section nav contradicts DESIGN.md and reaches only interstitials
`frontend/src/components/shell/section-nav.tsx:3-9,80-96` ·
`frontend/src/features/operations/reports-nav.tsx:26-46` ·
`report-directory.tsx:47-70` · `reports-overview.tsx:33-54` · `nav-items.ts:141-175`

`DESIGN.md:33-34` promises horizontally scrollable tabs; the implementation uses a
`<Select>` and the comment admits the scroll strips were removed. Either the doc or
the code is stale.

Independently: from `/reports/survival` on a phone the Select's only options are the
three group directories, so there is no way to jump report-to-report — every switch
lands on an interstitial link list first. The same seven reports are presented three
different ways depending on the surface (flat on `/reports`, grouped in the sidebar,
groups-only in the mobile Select).

**Fix:** put the seven leaf reports in the mobile Select grouped with `SelectLabel`;
delete the three interstitial routes or give them real content. Correct `DESIGN.md` if
the Select is intended.

### UX-012 (Medium) — 9-chip timeline filter strip has zero offscreen affordance
`frontend/src/features/hives/detail-page.tsx:110-124,319-323`

`-mx-4 flex gap-1.5 overflow-x-auto px-4 md:mx-0 md:flex-wrap`. At 390 px roughly five
of nine chips fit; **"Splits" and "Moves" are entirely offscreen** with no fade, no
gradient, no arrow, no scroll-snap, and no count. Desktop wraps, so this is mobile-only
— the target platform.

Noted as working: both the tab strip and the filter *do* sync to `?tab=`/`?view=` and
are deep-linkable and refresh-safe.

**Fix:** add a right-edge mask that clears at scroll end, or wrap to two rows on mobile.

### UX-013 (Medium) — 5 of 9 destinations sit behind "More", whose nested links are 36 px
`frontend/src/components/shell/nav-items.ts:344-363` · `bottom-nav.tsx:219-226` ·
`globals.css:217-236`

The bar holds `MOBILE_PRIORITY.slice(0, 4)` plus More, so Inventory, Reports, Queens,
Recommendations, and Settings are ≥2 taps and nested items 3–4. Inside the sheet,
nested routes render as `<a>` with `py-2 pr-2 text-sm` ≈ 36 px, and the coarse-pointer
44 px rule covers `button`, `[role=button]`, `[role=tab]`, `[role=menuitem]`, and
`a[data-slot="button"]` — **not plain anchors**. Direct `DESIGN.md:27` violation on the
deepest targets. The sheet also has no bottom safe-area padding.

Noted as working: the More cell shows an active highlight when any overflow item is
current, so the overflow itself is discoverable.

**Fix:** add `nav a[href]` to the coarse-pointer rule (or `min-h-11` on the row) and
`pb-[env(safe-area-inset-bottom)]` to the sheet.

---

## P1 — Offline/PWA is structurally incomplete

### SEAM-004 (High) — Backend hardened honey/commerce for replay; the SW never queues it
`backend/internal/httpapi/middleware_offline.go:72-87` vs.
`frontend/src/app/sw.js/route.ts:232-245`

The Go `offlineMutationSupported` list includes `/api/v1/harvests`, `/honey/jarring`,
`/honey/bulk-movements`, `/honey/give-away`, `/honey/jar-adjustments`,
`/honey/movements/`, `/honey/sales`, `/jar-sizes`, `/expenses`, `/customers`,
`/harvest-lots`, and `/wholesale-price-lists`. The SW's `supportedFieldPaths` contains
none of them. Offline at a market, `POST /honey/sales` falls through to the default
network path, the fetch rejects, and per SEAM-001 the user sees nothing at all.

**Fix:** make the two lists one artifact — generate the SW list from the Go list, or
share a JSON manifest with a test asserting they agree.

### SEAM-005 (High) — The conflict "Retry" button force-overwrites the newer server edit
`frontend/src/app/sw.js/route.ts:454-467` (esp. `:461`) ·
`backend/internal/httpapi/middleware_offline.go:158-170,304-322`

Conflict detection is `updatedAt.After(*queuedAt)`. `RETRY_OFFLINE_MUTATION` restamps
`item.queuedAt` to now, which is by construction after the server's `updated_at`, so
`offlineMutationConflicts` returns `false` and the retry runs clean — and the backend
has already deleted the receipt on the conflict path. The dialog says "Retry after
checking the current server record" but shows only `METHOD /path` and an error string:
no diff, no server version.

**Fix:** keep the original `queuedAt` on retry (add a separate `retriedAt` for
ordering) and require an explicit "overwrite server version" affordance sending a
distinct force header.

### SEAM-006 (High) — Offline writes return 202 `{queued:true}` treated as the created entity
`frontend/src/app/sw.js/route.ts:395-412` · `frontend/src/lib/api.ts:85-93` ·
`frontend/src/features/inspections/inspection-form-dialog.tsx:240-241` ·
`frontend/src/features/inspections/hooks.ts:107-123`

The SW synthesizes `202 {queued, offline, mutationId}`. `api.request` sees `res.ok`
(202 is ok) and returns that object cast to `T`. Nothing in `frontend/src` reads
`queued` or `mutationId`. So `mutateAsync` resolves, `toast.success("Inspection
recorded")` fires, the dialog closes, and the invalidation refetches from cache —
without the new inspection. Any caller dereferencing a returned `id` gets `undefined`.

**Fix:** have the SW return a shape the app detects, and add an `onSuccess` branch that
optimistically inserts the pending record into the query cache with a "queued" badge.

### SEAM-007 (High) — Offline navigation always lands on `/offline`; no cached reads
`frontend/src/app/sw.js/route.ts:22-27,417-421` ·
`frontend/src/app/offline/page.tsx:17-20` ·
`frontend/src/components/shell/offline-banner.tsx:29-31`

`SHELL` precaches only `/offline` and icons — no app routes, no RSC payloads. Next App
Router client navigations request `/<route>?_rsc=…`, which is not `mode: "navigate"`
and not `/_next/static/`, so the fetch handler falls through with no `respondWith`,
fails offline, and Next hard-navigates to `/offline`.

The banner says "cached field data is available" while `/offline` says "Reconnect
before viewing data", and `/offline`'s "Try again" links to `/dashboard`, which fails
the same way. `README.md:55` and `DESIGN.md:16` are both unmet.

**Fix:** precache the app shell routes and serve navigations network-first with cache
fallback; cache RSC payloads for the hive/apiary routes.

### SEAM-008 (High) — Every body-less POST is excluded from the queue by the content-type gate
`frontend/src/lib/api.ts:71` · `frontend/src/app/sw.js/route.ts:219-229` ·
`backend/internal/httpapi/middleware_offline.go:96-100`

`api.post(path)` with no body omits `Content-Type`, and `queueableMutation` requires
`DELETE` or `application/json`. So these never queue despite explicit backend replay
support: `useMarkFeedingEmpty` (`feedings/hooks.ts:178-184`),
`useArchiveHive`/`useUnarchiveHive`/`useDeadoutHive` (`hives/hooks.ts:212-237`),
`useEndBloom` (`apiaries/hooks.ts:242-249`), `useRemoveDeployment`
(`hives/hooks.ts:277-289`).

"Mark feeder empty", "mark deadout", and "end bloom" — the archetypal one-handed field
actions — are exactly the ones that fail offline, while "record feeding" queues fine.

**Fix:** always send `Content-Type: application/json` and `{}` from `api.post`, or key
`queueableMutation` on the path list alone.

### SEAM-009 (High) — Stale cache served as fresh whenever the network exceeds 5 s
`frontend/src/app/sw.js/route.ts:284-309` ·
`frontend/src/components/shell/offline-banner.tsx:16-22`

`networkFirstAPI` races the network against a 5 s timer and returns `cache.match()` on
timeout with no header, no marker, nothing the app can read. `OfflineBanner` renders
only when `!navigator.onLine`, which is `true` on a rural cell link that is connected
but taking 20 s. The beekeeper is shown yesterday's hive status, feeder ages, and jar
counts as current, and makes field decisions on them. `DESIGN.md:17` says "Always show
offline/sync state."

**Fix:** mark cache-fallback responses with a header the client surfaces as "showing
cached data from <time>", and drive the indicator off that rather than
`navigator.onLine`.

### SEAM-010 (Medium) — The offline queue is unbounded and re-broadcasts itself on every write
`frontend/src/app/sw.js/route.ts:43-71,73-85,125-147`

`queueRequest` has no size or age cap and stores each full request body as text.
`broadcastQueueStatus()` runs on every enqueue, after every replay pass, and after
every discard, performing a full `getAll()` and posting the entire item array to every
window client. Combined with SEAM-002, the queue can only grow.

**Fix:** cap the queue and surface "queue full — reconnect to sync"; broadcast counts
and have the review dialog request items on demand.

### SEAM-011 (Low) — Receipt retention (30 days) is shorter than the queue's TTL (none)
`backend/internal/jobs/cleanup.go:15-25` · `frontend/src/app/sw.js/route.ts:43-71`

An item stuck `pending` past the 30-day receipt reap finds no idempotency record and
re-executes, producing a duplicate inspection or sale. The two halves of the
idempotency contract have mismatched lifetimes and nothing enforces the assumption.

**Fix:** give queue items a client-side expiry that promotes them to `failed` before the
server retention window closes.

---

## P1 — Errors have nowhere to surface

### SEAM-012 (High) — Honey hub renders permanent skeletons beside fabricated zeros
`frontend/src/features/honey/honey-overview.tsx:38-101,297-325` ·
`backend/internal/httpapi/routes_honey.go:23-24,43-44`

The file contains zero `isError` branches. On failure `isPending` goes false and `data`
is `undefined`, so `StatCard` hits `loading || value == null` and renders `<Skeleton>`
forever, while "Unpaid orders" computes from `sales.data ?? []` and confidently prints
`0` and `$0.00`. Every honey endpoint is `requireAdmin`, so a non-admin editor who
bookmarks `/harvest` sees two tiles shimmering indefinitely beside a confident zero.

**Fix:** add `isError` handling, plus a shared 403 → "Administrator access required"
renderer, since this pattern recurs.

### SEAM-013 (Medium) — No error boundary anywhere; the public QR page shows Next's crash screen
`frontend/src/app/honey/[slug]/page.tsx:55-63`

`getStory` throws on any non-404 non-ok response inside an async Server Component, and
a search of `frontend/src/app` for `error.tsx`, `global-error.tsx`, and `not-found.tsx`
returns nothing. A customer scanning a jar QR while the API restarts — which happens on
every deploy, since goose migrations run at boot — gets "Application error: a
server-side exception has occurred" on the product's public traceability surface.

**Fix:** add `app/honey/[slug]/error.tsx` with branded copy and a retry, plus a root
`app/error.tsx`.

### UX-014 (Medium) — Two competing offline indicators saying different things
`frontend/src/components/shell/offline-banner.tsx:24-33` ·
`frontend/src/components/pwa-register.tsx:99-127`

A top warning strip explains cached reads; a bottom floating card carries the queue
count and the Review action. Both render simultaneously when offline, neither
references the other, and the bottom one is the one occluding the nav (UX-002).

**Fix:** one offline surface — merge the queue count and Review action into the top
banner and delete the floating card. Resolves UX-002 at the same time.

### UX-015 (High) — Escape or a stray outside tap discards a half-finished inspection
`frontend/src/features/inspections/inspection-form-dialog.tsx:260` ·
`frontend/src/components/ui/dialog.tsx:48-83` · `ui/shortcut-form.tsx:41-51`

No `onInteractOutside`, no `onEscapeKeyDown`, and the base component passes no guards,
so Radix's defaults apply: overlay click and Escape both close. The inspection form is
the app's longest — date, inspector, queen seen, queen health, brood pattern, three
ratings, a pest array, a treatment array, mite method/count/sample/notes, free-text
notes. Ten minutes of observations, one mistimed thumb on an overlay that is a large
target next to the dialog on a phone.

The app already knows the correct pattern: `market-day-page.tsx:42-49,80-100` guards
the cart with both `beforeunload` and an `AlertDialog`. Same exposure on
`hive-form-dialog`, `split-dialog`, `apiary-form-dialog`, `queen-form-dialog`, and
`record-sale-dialog`.

**Fix:** track `formState.isDirty` and guard both handlers with the same confirm.

### UX-016 (Medium) — Empty and error states without a next step
`DESIGN.md:37` violations.

Empty, no CTA: `hives/detail-page.tsx:501,542,708,757`, `hives/list-page.tsx:228`,
`honey/honey-overview.tsx:128,170`, `dashboard/recent-inspections-widget.tsx:22`,
`access/access-section.tsx:281`, `equipment/stock-dialogs.tsx:1054`.

Error, no retry and no escape: `hives/subpage.tsx:43`, `apiaries/subpage.tsx:28`,
`hives/detail-page.tsx:483,536`. The first two are the whole page — a single grey
sentence with no way forward and no way back, on the flaky connection where a retry
button matters most.

The good pattern already exists at `apiaries/detail-page.tsx:62-79`,
`hives/list-page.tsx:215-225`, `app/(app)/layout.tsx:40-51`, and
`apiaries/list-page.tsx:126-138`.

### UX-017 (Medium) — Validation errors inconsistently placed; some fields have none
`frontend/src/features/inspections/inspection-form-dialog.tsx:44,445-449,451-465`

Pest *type* renders an error under the input; pest *count* sets `aria-invalid` but
renders no message despite the schema producing one — the field goes red with no
explanation. The resolver runs in react-hook-form's default `onSubmit` mode, so nothing
validates until the user has scrolled to the bottom, and there is no scroll-to-error.
The user taps Save, nothing visibly happens, and taps again.

**Fix:** render the count error like the type error; `mode: "onTouched"`; scroll and
focus the first `[aria-invalid="true"]` on invalid submit.

### SEAM-014 (Medium) — Multipart uploads bypass the 401 → `/login` redirect
`frontend/src/features/photos/hooks.ts:40-68` ·
`frontend/src/features/transcription/api.ts:138-168` · `frontend/src/lib/api.ts:45-57,86`

Both multipart helpers use raw `fetch` and construct `ApiError` by hand without calling
`handleUnauthorized`, which is module-private. On an expired session a photo upload
shows `Upload failed (401)` while the page's other queries quietly redirect to `/login`
underneath, and the captured photo or recording is discarded rather than preserved
across re-login.

**Fix:** export `handleUnauthorized` (or add a shared `requestRaw`) and route both
through it.

### SEAM-015 (Medium) — Transcription polls every 3 s forever and never surfaces failure
`frontend/src/features/transcription/use-transcription-flow.ts:13,55-70,94-113`

`refetchInterval` returns `POLL_INTERVAL_MS` whenever `data === undefined` — deliberate,
per the comment, to fix an earlier bug where one failed fetch stopped polling forever.
But `data` is also `undefined` when the status GET fails permanently: worker down, Redis
down, AI provider unconfigured, 403, media deleted. `processing` stays `true` forever
and `statusQuery.isError` is not in the returned interface at all.

Voice-first inspection entry — the headline feature per `README.md:5` — spins
indefinitely after a successful upload, hitting the API every 3 s on cell data, with the
recording unrecoverable from that screen.

**Fix:** bound consecutive failures or elapsed time before stopping; add `statusError` to
the interface and render it in `status-card.tsx` with a retry using the retained blob.

---

## P1 — Backend robustness

### API-003 (High) — Unauthenticated `/auth/setup` is a cheap bcrypt DoS after setup
`backend/internal/httpapi/routes_auth.go:90,114,120` · `router.go:48`

The server performs bcrypt cost 12 *before* determining setup is already complete, on a
public route with no rate limit. A few concurrent requests exhaust API CPU and starve
authenticated traffic.

**Fix:** check setup state before hashing; rate-limit the endpoint.

### API-004 (High) — No global request-body limit or server read timeout
`backend/internal/httpapi/json.go:18` · `router.go:25` · `backend/cmd/server/main.go:52`

Most JSON handlers decode arbitrary-size bodies; only photo and transcription uploads
impose limits. `http.Server` sets only `ReadHeaderTimeout` — no `ReadTimeout`,
`IdleTimeout`, `WriteTimeout`, or `MaxHeaderBytes`. An authenticated user can send
enormous JSON slowly to ordinary mutation endpoints, holding connections and driving
memory.

**Fix:** router-wide body cap, route-specific lower caps, full timeout set, and reject
trailing JSON values.

### API-005 (High) — Admin bottling request is unbounded in CPU, memory, DB writes, and response size
`backend/internal/httpapi/routes_commerce.go:439,452,557`

An arbitrarily large positive `quantity` with `serialize:true` loops once per jar,
inserts each serial, accumulates every serial into the response, and holds the
transaction open. No maximum, no batching.

**Fix:** per-request/batch limits, set-wise or asynchronous serial generation, paged or
exported results.

### API-006 (High) — Honey timeline accepts an unbounded `limit`
`backend/internal/httpapi/routes_honey.go:1466,1469,1476,1544`

`?limit=999999999` queries that many ledger rows, then separately loads all sales before
merging and sorting in process memory.

**Fix:** strict maximum plus database-side cursor pagination for both sources.

### API-007 (High) — IP throttles trust user-controlled forwarding headers
`backend/internal/httpapi/router.go:30` · `ratelimit.go:25,83`

Chi `RealIP` rewrites `RemoteAddr` from forwarding headers with no trusted-proxy
allowlist. If the backend port is reachable other than through traefik, an attacker
rotates `X-Forwarded-For` to bypass login and public-subscription throttles; the
unbounded in-memory maps also admit thousands of spoofed keys.

**Fix:** enforce network-only proxy access or derive client IP only from trusted proxy
CIDRs; use a bounded shared limiter.

### API-008 (Medium) — API-token verification permits DB amplification, no constant-time path
`backend/internal/httpapi/middleware.go:42,55,69`

Every guessed `bt_` token performs a DB lookup, and each valid token additionally
performs a write updating `last_used_at`, with no endpoint limiter and no debouncing.

**Fix:** rate-limit auth attempts, debounce `last_used_at`, and consider HMAC-keyed token
hashes rather than a fast unsalted SHA-256 lookup.

### API-009 (Medium) — Cross-apiary queen lineage references accepted without ownership checks
`backend/internal/httpapi/routes_queens.go:127,190,197` ·
`backend/internal/db/migrations/00001_init.sql:92`

An editor of apiary A may create or update a queen in A while supplying an
`originHiveId` or `parentQueenId` from apiary B — only `hiveId` is authorized; the other
foreign keys are merely UUID-parsed. Forges cross-tenant pedigree links and skews lineage
analytics.

**Fix:** resolve and authorize every referenced hive/queen; add DB-level tenancy
constraints.

### API-010 (Medium) — Money parser can overflow signed cents before validation
`backend/internal/httpapi/money.go:68,96,109` (and the exponent float fallback at `:73`)

A large syntactically valid dollar amount can fit in `int64` before multiplication but
overflow at `dollars * 100`, yielding a wrapped negative cent value that then passes
validators checking only the result.

**Fix:** checked arithmetic before multiplication/addition, explicit maximum amounts, and
remove the float fallback.

### API-011 (Medium) — Transcription jobs are not idempotent under at-least-once delivery
`backend/internal/jobs/transcribe.go:64,73,122` ·
`backend/internal/httpapi/routes_transcriptions.go:218`

A duplicate asynq delivery unconditionally moves a completed/processing media row back to
`processing` and calls the external provider again — duplicate AI cost, and a successful
transcript can be overwritten by a later result or failure.

**Fix:** atomically claim only `pending`/retryable rows with `UPDATE … WHERE status IN (…)
RETURNING`; treat an already-complete row as a no-op.

### SEAM-016 (Medium) — Admin-only pages have no route guard; Reports is not marked admin-only
`frontend/src/app/(app)/inventory/page.tsx:1-9` · `(app)/harvest/layout.tsx:1-19` ·
`(app)/reports/layout.tsx:1-19` · `components/shell/nav-items.ts:126-175,250-266` ·
`backend/internal/httpapi/routes_commerce.go:41-42`, `routes_honey.go:23-24`,
`routes_equipment.go:36-37`

`visibleNavRoutes` correctly filters `adminOnly` from the sidebar, bottom nav, and
command palette — but nothing guards the routes, so a bookmark or shared link renders
them regardless. Worse, the `Reports` entry carries no `adminOnly` flag while its Finance
children (`/reports/economics`, `/profitability`, `/expenses`) and Sales-&-planning
children (`/bottling`, `/customers`) all consume `requireAdmin` endpoints. The Outcomes
children are correctly non-admin and properly membership-scoped, so the tree is genuinely
mixed and the flag was simply not applied at child level.

A non-admin editor sees "Reports → Finance → Apiary economics" in the sidebar *and* the
Ctrl-K palette, clicks, and gets a bare "Could not load…" with no hint it is a permissions
boundary.

**Fix:** mark those subtrees `adminOnly`, and add a shared admin guard rendering
"Administrator access required".

### SEAM-017 (Medium) — `/hives/{id}/inspections` is unbounded and ships a weather snapshot per row
`backend/internal/httpapi/routes_inspections.go:180-203,486-514` ·
`frontend/src/features/inspections/hooks.ts:88-93` ·
`frontend/src/features/hives/detail-page.tsx:478,509,531`

No `LIMIT`, no offset, no query parameters; every row carries the full `weather_snapshot`
jsonb. `InspectionSummary` fetches the entire set to render `all.slice(0, 3)`. Opening
the Health tab on a five-year-old hive downloads hundreds of KB of weather JSON over cell
to display three cards — and the payload is then written into `DATA_CACHE`.

**Fix:** add `?limit=&before=`, request a small page for the summary, paginate the
timeline, and omit `weather` from list responses.

### SEAM-018 (Medium) — `DATA_CACHE` is unbounded and includes authenticated photo binaries
`frontend/src/app/sw.js/route.ts:275-295,316-335` ·
`backend/internal/httpapi/routes_photos.go:66-72,347-378`

`cacheableAPI` matches everything under `/api/v1/` except `/auth/`, `/access/`, and
`/settings/` — including `/api/v1/photos/file/*`, the authenticated MinIO stream, and
every 3-second transcription status poll. No size cap, no LRU, no eviction; cleared only
on login, logout, or a new `BUILD_ID`. `void cache.put(...)` discards `QuotaExceededError`
as an unhandled rejection, so quota exhaustion is silent and unobservable.

Access control on the photo bytes is correct and the cache is user-scoped in practice, so
this is a storage/reliability problem rather than a cross-user leak. Residual exposure:
authenticated field data and photo bytes persist indefinitely if the user closes the app
without logging out.

**Fix:** exclude `/photos/file/` or give it a budgeted LRU cache; await and log `cache.put`
failures; skip caching short-lived polling endpoints.

---

## P2 — Accessibility and correctness papercuts

### UX-018 (High) — Bulk-selecting hives in table view is impossible with a keyboard or screen reader
`frontend/src/features/hives/list-page.tsx:256-271`

Selection lives on a `<tr>` with `onClick` but no `tabIndex`, no `role="button"`, and no
`onKeyDown`; the `Checkbox` is controlled with no `onCheckedChange` and carries
`pointer-events-none`; `aria-selected` is never set. Keyboard and screen-reader users can
enter bulk mode but can never select anything. The card branch
(`apiaries/list-page.tsx:143-148`, `hives/hive-card.tsx:55-58`) got this right — only the
table branch was missed.

### UX-019 (Medium) — Color-only status, against `DESIGN.md:26`
`frontend/src/features/dashboard/field-item-row.tsx:88-94` — urgency is a 6 px
`aria-hidden` dot, red vs. amber, with no paired text anywhere on the row; `item.priority`
never appears as a label. Red-vs-amber at 6 px is not a distinction in direct sunlight and
is absent entirely for screen readers.
`frontend/src/features/queens/queen-node.tsx:26-45` — the marking-year colour's meaning
lives in a `title` attribute only, which does not surface on touch.

Everything else in the app pairs colour with text correctly, which is what makes these two
stand out.

### UX-020 (Medium) — Two destructive actions have no confirmation
`frontend/src/features/commerce/business-reports.tsx:130` (delete expense) and
`frontend/src/features/access/access-section.tsx:271-277` (revoke API token) fire
immediately from small icon-only buttons at the end of dense rows. Nine comparable actions
elsewhere all confirm. Token revocation also deserves a type-to-confirm step.

### UX-021 (Medium) — Base dialog max-height puts the submit button under the home indicator
`frontend/src/components/ui/dialog.tsx:62-63` — a `-translate-y-1/2` centred element with
`max-h-[calc(100dvh-2rem)]` has a symmetric 16 px margin, and `dvh` spans under the home
indicator with `viewport-fit=cover`. Affects `feeding-dialog`, `split-dialog`,
`hive-form-dialog`, `queen-tab`, and the six canvas dialogs.
`inspection-form-dialog.tsx:260` overrides to `max-h-[90dvh]`, so the longest form is
accidentally safe while the short ones are not.

### UX-022 (Medium) — Long forms have no sticky submit
`DialogContent` is itself the scroll container and `DialogFooter` is an ordinary flow
child, so recording an inspection — the app's most frequent write, done one-handed —
requires scrolling the full form to reach Save. `Ctrl/⌘+Enter` is desktop-only relief.

### UX-023 (Medium) — Bulk mode strips the ability to navigate, with no way to peek
`frontend/src/features/hives/list-page.tsx:272-282` · `apiaries/list-page.tsx:142-180` ·
`lib/use-bulk-select.ts:25-30`

In bulk mode the hive name is plain text rather than a link, and exiting bulk mode clears
the selection — so "archive the deadouts, but let me double-check that one" requires
redoing the whole selection.

**Fix:** keep the selection when exiting bulk mode (clear only on explicit Clear all), or
add a per-row open affordance that survives bulk mode.

### UX-024 (Medium) — Frontend lint/typecheck gates cannot run
`frontend/node_modules` has no local `typescript` or `eslint`, so no reviewer could execute
`npx tsc --noEmit` or `npm run lint`. Several findings here are the class a typecheck
catches (SEAM-019, SEAM-020). CI runs these; local development does not.

### UX-025 (Low) — Assorted
- `x` = "Split hive" (`hives/detail-page.tsx:162-163`) contradicts `DESIGN.md:12`, where
  `x` is globally select-all. Move Split to an unclaimed key.
- Shortcut registry silently overwrites on collision (`provider.tsx:181-196`) — warn in dev.
- The `?` dialog advertises shortcuts a viewer cannot use (`detail-page.tsx:153-163`).
- Radix dialogs push no history entry, so Android Back closes the whole route instead of
  the dialog — compounding UX-015.
- Two `<nav aria-label="Main navigation">` are always both in the DOM (CSS-only hiding).
- Command palette results lack `role="listbox"`/`option`/`aria-activedescendant`.
- Unsized `<img>` in the timeline and inspection card (CLS risk).
- Detail-page skeletons omit the action row, so content jumps when data lands.
- The apiary layout canvas has no keyboard path at all.
- `animate-ping` is the only recording indicator, and freezes under reduced motion.

### SEAM-019 (Low) — `AuthStatus` omits `isAdmin`, which the backend does send
`frontend/src/lib/api.ts:141-148` vs. `backend/internal/httpapi/routes_auth.go:78-80`. Role
gating instead makes a second round trip to `/access/me` for a fact the first response
already carried.

### SEAM-020 (Low) — `HoneySale` omits `tax`, `updatedAt`, and `cancelledAt`
`frontend/src/features/honey/types.ts:69-88` vs.
`backend/internal/httpapi/routes_honey.go:727-749`. `tax` is a money field the sales list
and receipt view can therefore never display.

### SEAM-021 (Low) — CSRF rests entirely on `SameSite=Lax`
`backend/internal/auth/session.go:81-83,94-96` vs. `routes_mcp.go:56-70`. No CSRF token and
no Origin/Referer validation on any state-changing REST route. This holds today because no
mutation is exposed as a GET — verified across `routes_*.go` — but `Lax` does send the
cookie on top-level GET navigations, so the invariant is undocumented and one convenience
endpoint away from being exploitable. `validMCPOrigin` already implements the right check
for one endpoint.

Positively noted: the session token is never echoed in a response body (with a comment
explaining why), no token or secret is in `localStorage`, and there is no
`dangerouslySetInnerHTML` anywhere in `frontend/src`.

**Fix:** apply an Origin/Referer middleware to all mutating requests, reusing
`validMCPOrigin`, and document the no-state-changing-GET invariant with a test.

### SEAM-022 (Low) — `NEXT_PUBLIC_API_URL` inlines the API host into the client bundle
`frontend/src/app/honey/[slug]/page.tsx:36-38` · `.env.example:27`. `apiOrigin()` runs only
in a Server Component, but the `NEXT_PUBLIC_` prefix bakes the value — typically an
internal hostname like `http://api:8080` — into JavaScript shipped to every public QR-page
visitor. Drop to `API_URL`.

### SEAM-023 (Low) — The public honey story formats dates by a different rule
`frontend/src/app/honey/[slug]/page.tsx:44-52` vs. `frontend/src/features/hives/lib.ts:69-82`.
The app's `parseApiDate` deliberately takes the leading `YYYY-MM-DD`; the public page pins
`timeZone: "UTC"` on the full RFC3339 string, so if the server's timezone is east of UTC,
`extractionDate` renders one calendar day early on the customer-facing page.

### SEAM-024 (Low) — Unauthenticated visitors can create customer records
`backend/internal/httpapi/routes_commerce.go:689-736` · `ratelimit.go:20-22`. The
`ON CONFLICT` clause is well-designed and the uniform 201 gives no enumeration oracle;
residual risk is CRM spam from distributed IPs at 5/min each.

Positively verified on the same surface: `publicHoneyStory` is a curated projection gated
on `is_public` with no hive ids, apiary ids, coordinates, inspection data, expenses, or
customer data crossing the boundary; `publicHoneyStoryPhoto` re-checks `lot.is_public`;
`safeReorderUrl` scheme-checks before `href`. The one thing that does cross is apiary
**names** via `sourceApiaries` (surfaced as `region`) — apparently intentional for a
provenance story, but worth a conscious decision since apiary names are often place names.

**Fix:** consider a per-slug daily cap alongside the per-IP throttle; confirm the apiary-name
exposure is intended.

### API-012 (Low) — Automatic migrations run with an uncancelable context at startup
`backend/internal/db/db.go:16,63,76`. A slow or blocked migration ignores shutdown and can
leave a deploy stuck holding its advisory lock.

---

## Review provenance

Three reviewers, cross-vendor, read-only:

| Lens | Harness | Output |
|---|---|---|
| Navigation, layout, interaction, a11y | Claude Code | UX-001 … UX-025 |
| Go API internals | Codex | API-001 … API-012 |
| Frontend↔backend seam, PWA, perf | Claude Code (separate session) | SEAM-001 … SEAM-024 |

A fourth reviewer (Google Antigravity) returned a report about an unrelated repository and
was discarded in full; nothing from it appears above.
