# PR 1 — Colony and equipment sales

Branch: `feat/1f80f067-pr-1-colony-equipment-sales`

## Files changed

### Schema
- `backend/internal/db/migrations/00015_sales_kinds.sql` — rename `honey_sales`/`honey_sale_items` → `sales`/`sale_items`; add `kind` + nullable targets; hive/feeder/equipment `sale_id`; `sold` adjustment reason; `sold_with_hive` return/close reason.

### Backend
- `backend/internal/httpapi/routes_sales.go` — physical side effects (sell hive, close feeders, sell/return equipment, cancel restore) and `GET /hives/{id}/sale-offer`.
- `backend/internal/httpapi/routes_honey.go` — mixed line normalize/record/cancel; `/sales` + `/honey/sales` aliases; jar aggregates only count `kind=jar`.
- `backend/internal/httpapi/routes_commerce.go`, `routes_serials.go`, `routes_equipment.go`, `routes_feedings.go`, `routes_hives.go`, `middleware_offline.go` — table names, `/sales` aliases, `sold`/`sold_with_hive`, hive `saleId`.
- `backend/cmd/migrate-legacy/main.go` — dest table rename via `destTable`.
- Tests: `routes_honey_test.go`, `honey_integration_test.go`, `sales_kinds_migration_test.go`, `db_integration_test.go`, `money_migration_test.go`, `middleware_offline_test.go`.

### Frontend
- Top-level `/sales` (orders, receipt, market day). `/harvest/sales` and `/harvest/market-day` redirect.
- Nav: Sales is top-level; Honey keeps Overview/Production.
- Record-sale dialog: colonies with default-checked hive deployments, stock equipment, confirm copy for feeder/return side effects.
- Types/hooks/API paths, SW offline prefixes, e2e nav/offline updates.

## Decisions
- `kind` is `text` with `CHECK (kind IN ('jar','colony','equipment'))` and a comment that 00020 will extend it. Exactly one target per kind.
- Existing rows migrate as `kind=jar` (column default + UPDATE).
- Hive deployments consume matching equipment lines first (`sold_with_hive` + sold adjustment). Unchecked deployments return to storage (`hive_removed`). Remainder comes from available stock.
- Cancel restores only on the first transition to cancelled (idempotent replay does not double-restore).
- `/honey/sales` remains as an alias so queued offline mutations still replay.

## Leftover risks
- Integration/migration tests need `TEST_DATABASE_URL` (skipped in this worktree). Unit tests pass.
- Manual `sold` adjustments are allowed by the enum but are not the sale path; cancel only reverses sale-linked negative `sold` rows.
- GnuCash mappings, extra product kinds, and Zebra labels are out of scope.
- Frontend was not typechecked here (`node_modules` absent).
