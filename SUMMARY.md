# PR 2 — Treatment lockout, lot moisture, Saturday yard queue

Branch: `feat/1f80f067-pr-2-lockout-queue`

Legal/money gates on honey, plus one phone-first Saturday work list. Not a
reminder card and not a fourth recommendations inbox.

## Shipped

1. **Treatment vs harvest lockout.** Treatment products carry withdrawal days
   (catalog + stamped `treatment_events.withdrawal_days`). A hive is locked
   while the treatment is still on (`date_removed` is null) and until
   `date_removed + days`. Standalone harvests, harvest-session entries, and
   sales of lots whose source harvests were extracted inside that window
   return 409 with `This honey cannot be extracted/sold until DATE` (or
   until the product is removed). The same payload is on hive GET/list and
   harvest-lot GET/list.
2. **Lot moisture.** Refractometer `%` on the harvest session (create +
   PATCH) and on the lot (`moisture_pct` at extraction, optional
   `bottling_moisture_pct` at bottling). Harvest session create/update and
   lot create/update reject readings over the threshold (default 18.6%,
   override on `user_settings.moisture_threshold_pct`). Sales do not
   re-check moisture.
3. **Saturday yard queue.** `GET /operations/yard-queue` and
   `/operations/yard-queue`: open recs (`treat_now`, `mite_check_due`,
   others except `feeder_check`), harvest-ready hives (stores ≥ 4 and not
   locked), feeders needing refill, and lockout end dates, grouped by yard.
   In nav (`g k`), dashboard, PWA shell cache.

## Schema

Migration **00019** only: `00019_lockout_moisture.sql`.

- `treatment_products` catalog (seeded common miticides)
- `treatment_events.withdrawal_days` (NOT NULL, stamped at record time)
- `harvest_sessions.moisture_pct`
- `harvest_lots.moisture_pct`, `harvest_lots.bottling_moisture_pct`
- `user_settings.moisture_threshold_pct`

## Tests

- `backend/internal/httpapi/lockout_test.go` — date math, still-on vs
  withdrawal window, moisture threshold compare (no database).
- `backend/internal/httpapi/routes_lockout_moisture_test.go` — harvest
  refuse while on / in window, session entry refuse, sale refuse of a
  tainted lot, session/lot moisture reject, settings override.

Integration tests need `TEST_DATABASE_URL`.
