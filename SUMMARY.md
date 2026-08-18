# PR 6 — Other hive products

Branch: `feat/1f80f067-pr-6-hive-products`

## Files changed

### Schema
- `backend/internal/db/migrations/00020_hive_products.sql` — `product_catalog`, `propolis_harvests`, `product_batches`, `product_batch_expenses`; `sale_items.product_id`; kind CHECK extended with creamed_honey / hot_honey / mead / propolis / tincture; `honey_movements.product_batch_id`; expense category `grocery`.

### Backend
- `backend/internal/httpapi/routes_products.go` — catalog CRUD, propolis harvests (hive or yard, grams/ounces), conversion batches. Honey-consuming batches write `bulk_use` movements. Tincture consumes propolis only.
- `backend/internal/httpapi/routes_honey.go` — mixed lines accept catalog SKUs; availability lock; list labels join the catalog; batch-linked movements cannot be reversed alone.
- `backend/internal/httpapi/routes.go`, `routes_commerce.go`, `middleware_offline.go` — mount + grocery + offline prefixes.
- Tests: `routes_honey_test.go`, `honey_integration_test.go`, `hive_products_migration_test.go`, `db_integration_test.go`, `middleware_offline_test.go`.

### Frontend
- `/harvest/products` — catalog, propolis harvests, batches.
- Market day and record-sale grow catalog SKU buttons/lines on the same checkout.
- Nav, production overview, receipt, offline SW prefixes, grocery expense category.

## Decisions
- Same sale spine. New kinds use `product_id`; jar / colony / equipment targets stay exclusive.
- Finished SKUs live in `product_catalog` (name, kind, unit, default_price_cents, optional size_label). No second `jar_sizes`.
- Propolis harvests never touch `honey_harvests` or `honey_movements`.
- Creamed / hot / mead batches consume bulk honey lbs (`bulk_use` + lot on the batch). Tincture consumes a named propolis harvest.
- Catalog stock is `SUM(quantity_out) − sold`. Raw propolis SKUs are sellable off remaining harvest without a packaging batch.
- Market day lists in-stock catalog items next to jars. One customer, one payment, one receipt.

## Leftover risks
- Integration/migration tests need `TEST_DATABASE_URL` (skipped in this worktree). Unit tests pass.
- Frontend was not typechecked here (`node_modules` absent).
- GnuCash per-kind account mappings remain out of scope.
- Batches are append-only; reversing a batch-linked honey movement is rejected.
