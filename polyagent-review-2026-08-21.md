# Polyagent cross-model review — 2026-08-21

Run `20260821-gaps-review-c7d2`, pinned to `f618759` (the four gap-closure
commits `26acc00..f618759`). Reviewers: Claude Opus (ledger/idempotency),
Codex gpt-5.6-sol (security/ops). The Grok worker exited cleanly twice
without writing a report and was substituted by a local read-only Claude
subagent covering the same migration/behavioral lens. Full worker reports:
`%USERPROFILE%\.polyagent\projects\beez-trackz-fd2f75e7\runs\20260821-gaps-review-c7d2\workers\`.

**Every confirmed finding below was fixed the same day** in commits
`4c1804b` (ledger + security lenses) and `92acae0` (migration lens).
Line references are to the pinned commit; the fix column says what landed.

## HIGH — fixed

| # | Lens | Finding | Fix |
|---|------|---------|-----|
| 1 | ledger | Home sale of a catalog SKU validated against **global** on-hand, so units consigned to the bike shop could be sold twice (home sale passes on global 8, shop later reports the same 8 sold). | `honeyRecordSale` subtracts `stockAwayProductTotals` before the availability check (`routes_honey.go`). |
| 2 | ledger | `DELETE /product-adjustments/{id}` on a **positive** ("stock found") adjustment was an unchecked withdrawal — no transaction, no lock, no home-availability bar; could drive home stock negative after a transfer. | Delete is one transaction with `FOR UPDATE`, catalog lock, and a `delta > home` → 409 guard (`routes_products.go`). |
| 3 | security | Offline labor start/stop replayed with the **reconnect** time, not the tap time — a stop queued at 17:00 and replayed at 20:00 booked three hours not worked. | Handlers honor `X-Offline-Queued-At` (bounded −7d..+5m), stop clamps to `>= started_at`, and the UI shows "saved offline" instead of a red error (`routes_ops.go`, `labor-control.tsx`). |
| 4 | migration | `canvasSyncYardGps` nulled GPS for **every** hive in the apiary, then re-wrote only placed ones — merely opening the yard map (mount-time hydration marks the layout dirty; 1 s autosave) wiped every manually captured hive GPS. | Sync nulls only placed hives (`stand_id`/`slot_row`/`slot_col` NOT NULL); autosave gated on `canEdit`; overview-tab copy states the real rule (`routes_canvas.go`, `canvas-inner.tsx`, `overview-tab.tsx`). |
| 5 | migration | An invalid IANA zone from Open-Meteo crashed the whole yard-map render — `dateFromScrubber`'s `Intl.DateTimeFormat` had no try/catch and ran even with the sun overlay off. | Guarded with device-zone fallback (`canvas-inner.tsx`). |

## MEDIUM — fixed

| # | Lens | Finding | Fix |
|---|------|---------|-----|
| 6 | ledger | Propolis SKUs: a positive adjustment made `onHand` positive, which flipped sales off the grams path — propolis could sell that was never harvested; shrink was simultaneously impossible. | Grams path is unconditional for propolis kinds; manual adjustments on propolis SKUs are refused (400 pointing at propolis harvests) (`routes_products.go`). |
| 7 | ledger | `POST /product-adjustments` had no idempotency key despite the table's unique index — a double-tap shrank twice. | Endpoint accepts `idempotencyKey`; the Adjust dialog mints one per session (`routes_products.go`, `products-page.tsx`). |
| 8 | ledger | Migration 00030's Down left the ledger *wrong* (voided batches resurrected while their honey reversals survive). | Down now `RAISE EXCEPTION`s when voided batches exist (00030, not yet deployed so edited in place). |
| 9 | security | The stored ntfy bearer token was echoed to the admin browser in settings GET/PUT JSON. | Token is write-only: `hasAccessToken` flag, omit-preserves / empty-clears semantics, UI keeps only a local draft (`routes_settings.go`, `ntfy-section.tsx`). |
| 10 | security | Token could travel over plain HTTP or follow an HTTPS→HTTP redirect. | Publish refuses a token over non-HTTPS and rejects redirects off https/off-host when a token rides along; tests added (`notify/ntfy.go`). |
| 11 | migration | Transcription **confirm** path still raced delete → mid-insert FK 500 (the delete side was fixed, the confirm side was not). | Confirm holds `media_files FOR KEY SHARE` for its whole transaction; a concurrent delete is now a clean 404. Delete's 409 message keyed on the constraint name (`routes_transcriptions.go`, `routes_transcriptions_versions.go`). |
| 12 | migration | `PATCH /hives/{id}/gps` with an empty body silently cleared coordinates. | Both keys required (`null` to clear); validation table test added (`routes_hives.go`, `routes_hives_gps_test.go`). |
| 13 | migration | `config.Load` no longer reads `.env` but the README still documented `go run ./cmd/server` bare. | README documents `set -a; source .env.local; set +a`. |

## LOW — fixed

- Voided batches no longer report ingredient/honey cost (ledger #6-adjacent).
- Manual adjustment `locationId` restricted to home; consignment shrink is the
  settlement's job (ledger).
- Covering partial index `(product_id) WHERE deleted_at IS NULL` for the
  per-SKU `SUM(delta)` aggregate (00030).
- Adjust/void mutations invalidate the stock-location queries (frontend).
- ntfy receipt-delete failure now logged loudly (a silent failure suppresses
  all retries); post-recs hook panic-isolated; dispatch title/body scrubbed
  after 30 days (migration 00033) while dedup keys are kept; compliance
  packet responses `Cache-Control: no-store, private`.
- 00032 Down carries an explicit "not restorable, by design" comment.

## Accepted / deferred (not fixed, on purpose)

- **Ntfy outbox state machine** (codex #4): insert-receipt-then-publish still
  has a crash window between insert and publish (stranded receipt = lost
  alert). The failure-path delete is now loud, dedup and the six-hour cadence
  bound the blast radius; a full pending/leased/sent outbox is deferred.
- **Batch honey cost is a lifetime average** recomputed at read time, not a
  stamped per-lot COGS. Documented behavior; a stable per-lot cost basis is
  GnuCash-work (roadmap P1).
- **Admin-role 403 tests** for print/dispatch exist only as 401 coverage; the
  role boundary test is a nice-to-have.
- **Solar DST edge cases** (offset taken at the observation instant, ±60 min
  on two days a year on a decorative overlay) and the missing timezone label
  in the sun panel.
- **Expand/contract note**: 00032 drops a column at startup-migration time;
  fine for the single-replica prod stack, but the ship-code-first-drop-later
  pattern is worth following if replicas ever appear.
- **Dead helpers** `productLockCatalog`/`productCheckAvailability` retain
  test-only callers.

## Verified clean (do not re-litigate)

Settlement void vs manual undo cannot double-restore; batch void is
serialized under `FOR UPDATE` and cannot double-reverse against
`honeyReverseMovement`; tincture void releases propolis without a
compensating row; `productDivideCents` is exact half-away-from-zero integer
cents; the deprecated sales delegate reads the body once and preserves the
consignment 409; compliance print view is `html/template`-escaped with a
valid CSP and no XSS path found; forecast F→C and mph→km/h conversions are
exact; goose annotations and numbering for 00030–00033 are correct and apply
cleanly in sequence from 00029; `CanvasRegistration`/`satelliteImageKey`
removal is complete with no dangling reference; hive-GPS route auth matches
its siblings; transcription delete/confirm lock ordering cannot deadlock.
