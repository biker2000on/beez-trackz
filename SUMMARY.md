# PR 3 — Varroa program remaining

Branch: `feat/1f80f067-pr-3-varroa-program`

Sticky-board vs rate chart is unchanged: washes/rolls still plot as mites per
100; board/visual stay off that axis unless they have a per-day rate.

## Shipped

1. **Board exposure duration.** `mite_counts.days_on_board` plus generated
   `mites_per_day` for `sticky_board` / `visual`. Washes/rolls stay
   `mites_per_100`. Sticky boards default to 1 day when duration is omitted.
2. **Action levels.** Seasonal wash thresholds (spring/fall 2.0, summer/winter
   3.0) and a 9 mites/day board line. Optional overrides on `user_settings`
   (`mite_threshold_per_100`, `mite_threshold_per_day`,
   `mite_check_interval_days`). `treat_now` reads the latest comparable count
   and fires high/urgent. Health panel shows the latest **number** plus a
   threshold line — 0.3 vs 9.0 is not color-only.
3. **Sampling reminder.** `mite_check_due` mirrors `inspection_due`: never
   sampled, then overdue by interval (14 days in season, 28 off-season, or the
   settings override).
4. **Counts can be corrected.** `PATCH /mite-counts/{id}` and existing DELETE.
   Inspection GET includes `miteCounts`; PUT replaces them. Standalone upsert
   uses a partial unique index on `(hive_id, date, method) WHERE inspection_id
   IS NULL` (NULL no longer silently inserts duplicates).
5. **Fleet analytics.** `GET /analytics/varroa` without `hiveId` returns every
   visible hive, last count, and `overThreshold`.
6. **Efficacy pairing.** Before is last comparable count in the 21 days up to
   `date_applied`. After is first comparable count after
   `COALESCE(date_removed, date_applied)`, within 42 days, and before the next
   treatment. Board rates pair as mites/day. Mixed units do not invent a %.
   Tests cover the windows, `date_removed`, next-treatment bound, and board
   rates.
7. **Hive overview card** shows the last mite number (e.g. `9.0 / 100`), not
   only a “Varroa trends” link.
8. **MCP** `record_mite_count` (same path as `record_inspection` /
   `record_feeding`).

## Schema

Migration **00016** only: `00016_varroa_program.sql`.

## Tests

- `backend/internal/httpapi/routes_operations_varroa_test.go` — upsert, PATCH,
  DELETE, inspection GET/PUT, fleet analytics, efficacy SQL.
- `backend/internal/recs/varroa_test.go` — seasonal thresholds / comparable
  rate.
- `backend/internal/recs/rules_varroa_test.go` — treat-now and mite-check-due.

Integration tests need `TEST_DATABASE_URL`.
