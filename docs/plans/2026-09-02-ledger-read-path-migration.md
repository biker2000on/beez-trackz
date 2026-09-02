# Ledger read-path migration — T4 audit (spec §8.1, review OV6)

**Status:** read-only audit of commit `bd05aa2895efff191b23bdd1ae38b072da598e0f`.
**Binding spec:** `docs/plans/2026-09-01-inventory-ledger-design.md` (review amendments in §2.1 override earlier text; landing is two-phase per §9; tests per §12).
**Method:** Read + Grep only. Every site below is cited. No guessed readers.

This document is the wave-2 checklist for switching every live reader of the tables and views the ledger replaces, and for the three companion audits the assignment required: (a) `external_sync` vs migration 00041, (b) stock-motivated row locks review A4 deletes, (c) writers the Phase A freeze trigger will refuse.

Wave-2 task ownership (from spec §9 Phase A + §6/§8/§10):

| Task | Owns |
|---|---|
| **T3 producers** | Every handler that today `INSERT`/`UPDATE`/`DELETE`s a freeze-set table, plus every stock-motivated lock those handlers take. HTTP becomes transport; `app/{production,sales,equipment,field}` call builders then `inventory.Record` / `CheckAvailable`. |
| **T4 projections** | Every live **read** of a dropped table or view. Same change as T3 in Phase A step 2: switch to `inventory_balances` / `inventory_available` / `inventory_reservations` / checkpoint reconciliation / a retained domain table. |
| **T5 backfill** | Idempotent in-place translation (§7) against live legacy tables, residual splits, freeze trigger, and §7.2 parity against the **legacy** aggregate family in `snapshot/legacy.go`. |

Phase A freeze set (spec §9 step 3 — eight tables): `honey_movements`, `stock_movements`, `product_adjustments`, `equipment_stock`, `equipment_stock_adjustments`, `equipment_deployments`, `equipment_deployment_returns`, `equipment_state_changes`. `stock_locations` and `equipment_type_components` are also dropped at Phase B (decision 10) but are **not** in the freeze-eight; their writers still have to move before Phase B.

---

## Replacement projections (spec §3.7, OV1, TD1)

| Projection | Meaning | Use when the legacy number was |
|---|---|---|
| `inventory_balances` | checkpoint + SUM of movements after `as_of_operation_id`, per `(item, location, lot, condition, container_hive_id)` | on-hand **physical** quantity (bulk honey, equipment owned/deployed/condition, consigned jars/products, lot ceilings as receipts) |
| `inventory_available` | `on_hand − reserved` | jar / product / propolis formulas that today subtract **draft and pending** sale lines (`legacy.go:48-50`, OV1) |
| `inventory_reservations` | query over `sale_items` on sales that are neither applied nor cancelled | draft/pending demand; not a table |
| checkpoint reconciliation | `inventory_balance_checkpoints` vs raw SUM | `equipment_stock_reconciliation` |
| domain table that stays | `harvest_lots`, `honey_varietals`, `jar_sizes`, `product_catalog`, `product_batches`, `propolis_harvests`, `sales`/`sale_items`, `equipment_types`, `hives`, `inventory_locations` (from `stock_locations`), `inventory_boms` (from `equipment_type_components`) | catalog/identity/audit facts, not quantity |

Draft/pending sales are **reservations**. After T4, any surface that currently reports `onHand` from a formula that subtracts non-cancelled sales (including drafts) must read `inventory_available`, not `inventory_balances`. Spec §7.2.

---

## (a) `external_sync` entity-type list vs migration 00041

**Finding:** at this commit the Go allowlist **equals** the 00041 CHECK. OV6's "code list wider than 00041" is not true here; the dissolved set is taken from the code list, not from the spec's "nine".

`backend/internal/httpapi/external_sync.go:14-55` (`syncEntityTypes` must equal the DB CHECK):

```
sale, sale_item, expense, customer,
harvest_lot, jar_size, honey_movement, bottling_run,
stock_location, stock_movement, consignment_settlement,
hive, equipment_stock, equipment_stock_adjustment,
product_catalog, product_batch, product_adjustment
```

`backend/internal/db/migrations/00041_external_sync_entity_types.sql:18-24` CHECK is the same 17 values.

### Exact dissolved set the re-key must handle

Intersection of the code allowlist with tables decision 10 drops:

| `entity_type` (code + 00041) | Dropped table | Re-key target |
|---|---|---|
| `honey_movement` | `honey_movements` | `inventory_operation` via `legacy_ref_*` |
| `stock_movement` | `stock_movements` | `inventory_operation` via `legacy_ref_*` |
| `equipment_stock` | `equipment_stock` | `inventory_operation` for quantity history; catalog attrs (`unit_cost_cents`, `needed_quantity`, `storage_location`, `first_deployed_year`) move to `equipment_types` (OV2), not to an operation |
| `equipment_stock_adjustment` | `equipment_stock_adjustments` | `inventory_operation` via `legacy_ref_*` |
| `product_adjustment` | `product_adjustments` | `inventory_operation` via `legacy_ref_*` |
| `stock_location` | `stock_locations` | **`inventory_location`**, not `inventory_operation`. Consignees and `home` become `inventory_locations` rows (spec §3.3, Q4). |

That is **six** allowlist values, not nine. The other eleven stay: `sale`, `sale_item`, `expense`, `customer`, `harvest_lot`, `jar_size`, `bottling_run`, `consignment_settlement`, `hive`, `product_catalog`, `product_batch`.

**Not in the allowlist at all** (no `external_sync` rows to re-key unless a later writer adds them): `equipment_deployments`, `equipment_deployment_returns`, `equipment_state_changes`, `equipment_type_components`. Their UUIDs still survive on `inventory_operations.legacy_ref_*` for provenance (decision 10).

GnuCash load path today (`routes_gnucash_sync.go:1098-1106`) joins `equipment_stock` only to resolve a sale-line label (`et.name`). After OV2 that join is `sale_items.item_id → inventory_items → equipment_types`. `internal/gnucashsync` itself has **no** SQL against the dropped tables (`grep` over the package is empty); it consumes DTOs built in httpapi.

`snapshot/exporter.go:455-456` repeats the same 17-type map for semantic FK checks on `external_sync.entity_id`. T5's GnuCash re-key test (`external_sync_rekey_test.go` in spec §12) must cover the **six** dissolved allowlist values above, not a guessed nine.

---

## (b) Stock-motivated row locks review A4 deletes

A4: the inventory service is the **only** quantity locker (`pg_advisory_xact_lock` per tuple, sorted). Producers may lock **domain** rows (`sales`, `bottling_runs`, `harvest_lots`, …) only *before* `Record` / `CheckAvailable`. `honeyLockJarSizes`-style stock locks are deleted. `honeyBulkLockKey` is **subsumed** into `app/inventory/doc.go` order, not deleted (OV7 outside-voice finding 10).

### Delete (stock-motivated)

| File:line | Lock | Why it is stock-motivated |
|---|---|---|
| `honey_ledger.go:110-111` | `SELECT id FROM jar_sizes WHERE id = ANY($1) ORDER BY id FOR UPDATE` inside `honeyLockJarSizes` | Availability serialization for jars. Replaced by `CheckAvailable` tuple locks. |
| `honey_ledger.go:359-360` | `SELECT id FROM product_catalog WHERE id = ANY($1) ORDER BY id FOR UPDATE` inside `stockLockProducts` | Same for catalog SKUs on transfers. |
| `routes_products.go:185` | `SELECT id FROM product_catalog … FOR UPDATE` inside `productLockCatalogInfo` | Same for home sales / shrink / batch void. Then reads `productInventoryQuery` (line 201) under that lock. |
| `routes_equipment.go:207-216` | `FROM equipment_stock es … FOR UPDATE OF es` inside `equipLockStock` | Quantity lock on the stock row; also reads deployed SUM from `equipment_deployments` (lines 210-212). |
| `routes_equipment.go:1000-1004` | `FROM equipment_deployments WHERE id = $1 AND date_removed IS NULL FOR UPDATE` | Serializes return vs concurrent return of the same deployment. |
| `routes_sales.go:105-110` | `FROM equipment_deployments WHERE hive_id=$1 AND date_removed IS NULL … FOR UPDATE` | Colony-sale consume of deployed gear. |
| `routes_honey.go:757-759` | `FROM honey_movements WHERE id = $1 FOR UPDATE` | Reverse path holds the movement row then checks jar availability via `honeyLockJarSizes` (806). |
| `routes_commerce.go:1336-1344` | `FROM honey_movements m WHERE m.bottling_run_id=$1 … FOR UPDATE OF m` | Void bottling: lock run movements, then `honeyLockJarSizes` (1390). |
| `routes_products.go:1534-1541` | `FROM honey_movements m WHERE m.product_batch_id=$1 … FOR UPDATE OF m` | Void batch: lock batch movements. |
| `routes_stock_locations.go:1218-1219` | `FROM stock_movements WHERE id=$1 FOR UPDATE` | Reverse transfer. |
| `routes_stock_locations.go:1242-1245` | `SELECT id FROM stock_movements WHERE transfer_id=$1 … ORDER BY id FOR UPDATE` | Reverse both halves. |
| `routes_stock_locations.go:2276-2278` | `SELECT id FROM stock_movements WHERE settlement_id=$1 … ORDER BY id FOR UPDATE` | Void settlement movements. |
| `routes_products.go:1374-1375` | `FROM product_adjustments WHERE id=$1 AND deleted_at IS NULL FOR UPDATE` | Undo adjustment; then `productLockCatalogInfo` (1394) for home availability. |
| `routes_equipment_bom.go:168-169` | `SELECT id FROM equipment_stock WHERE type_id = $1 FOR UPDATE` | Type-delete: lock stock before checking ledger history. |

### Callers of the helpers (all go with the helpers)

`honeyLockJarSizes`: `routes_honey.go:604` (give-away), `:806` (reverse jarring/adjust), `:1498` (sale apply at home); `routes_commerce.go:1390` (void bottling); `routes_jar_sizes.go:246` (deactivate size); `routes_stock_locations.go:1060` (transfer/return), `:1889` (settlement).

`stockLockProducts`: `routes_stock_locations.go:1069`, `:1896`.

`productLockCatalogInfo`: `routes_honey.go:1525` (sale apply products); `routes_products.go:1290` (create adjustment), `:1394` (delete adjustment), `:1505` (void batch).

`equipLockStock`: `routes_equipment.go:834` (deploy), `:990` (return); `routes_equipment_ledger.go:158` (receive), `:205` (adjust), `:307` (condition move), `:554` (physical count); `routes_equipment_bom.go:473` (assembly); `routes_honey_varietals.go:305` (packaging consume); `routes_sales.go:234` (sell from stock), `:407` (restore sold).

### Keep (domain locks, taken **before** `Record` / `CheckAvailable`)

These are **not** A4 deletions. They remain, documented in `app/inventory/doc.go` ahead of tuple locks:

| File:line | Lock | Domain fact |
|---|---|---|
| `honey_ledger.go:174` | `pg_advisory_xact_lock(honeyBulkLockKey)` | Subsumed, not deleted. |
| `honey_ledger.go:203` | `harvest_lots … FOR UPDATE` (`honeyLockLot`) | Lot identity / ceiling row. On-hand then read from `honey_lot_balances` (208) — **that read** moves to T4; the lot row lock stays. |
| `routes_commerce.go:292, 401, 971, 1149` | harvests / harvest_lots | Harvest↔lot link. |
| `routes_commerce.go:1305` | `bottling_runs … FOR UPDATE` | Void run. |
| `routes_honey.go:1837, 1971` | `sales … FOR UPDATE` | Sale apply/cancel. |
| `routes_products.go:991, 1489` | `product_catalog` / `product_batches FOR UPDATE` | Batch create/void (catalog kind/name; batch row). The catalog lock in `productLockCatalogInfo` **is** stock-motivated and is deleted; a remaining catalog lock that is only "what kind is this SKU" may stay as a domain lock. |
| `routes_sales.go:73` | `hives … FOR UPDATE` | Colony sale marks hive sold. |
| `routes_stock_locations.go:2192` | `consignment_settlements … FOR UPDATE` | Void settlement. |
| `routes_serials.go:228, 247` | sales / jar_serials | Serial linking. |
| `routes_harvest_sessions.go:588, 689` | harvest_sessions / honey_harvests | True-up. |
| `routes_feedings.go:343` | feedings | Not inventory. |

---

## (c) Writers the Phase A freeze will refuse (T3 must move)

Production `INSERT`/`UPDATE`/`DELETE` sites on the freeze-eight. Tests and migrations are listed only as a note; they are not handlers.

### `honey_movements`

| File:line | Op | Handler / helper |
|---|---|---|
| `routes_honey.go:417` | INSERT `kind='jarring'` | `honeyRecordJarring` |
| `routes_honey.go:447` | INSERT `kind='loss'` | same, jarring loss |
| `routes_honey.go:542` | INSERT `bulk_use`/`loss` | `honeyRecordBulkMovement` |
| `routes_honey.go:621` | INSERT `give_away` | `honeyRecordGiveAway` |
| `routes_honey.go:700` | INSERT `jar_adjustment` | `honeyAdjustJarCounts` |
| `routes_honey.go:841` | INSERT reversal | `honeyReverseMovement` |
| `routes_commerce.go:1233` | INSERT `jarring` | `bottlingRunCreate` |
| `routes_commerce.go:1425` | INSERT reversal | `bottlingRunVoid` |
| `routes_products.go:1094` | INSERT `bulk_use` | `productBatchCreate` |
| `routes_products.go:1587` | INSERT reversal | `productBatchVoid` |
| `routes_jar_sizes.go:280` | INSERT `jar_adjustment` write-off | jar-size deactivate |
| `routes_stock_locations.go:2109` | INSERT `jar_adjustment` | settlement shrink (global half) |
| `routes_stock_locations.go:2223` | INSERT reversal | `stockSettlementVoid` |

No handler `UPDATE`/`DELETE`s `honey_movements` (append-only). Test-only `DELETE`: `routes_serials_test.go:76`.

### `stock_movements`

| File:line | Op | Handler / helper |
|---|---|---|
| `routes_stock_locations.go:1152` | INSERT | `stockInsertMovement` (transfer/return, both halves) |
| `routes_stock_locations.go:1294` | INSERT negation | `stockReverseMovements` |
| `routes_stock_locations.go:2095` | INSERT `kind='adjustment'` | settlement shrink (location half) |

### `product_adjustments`

| File:line | Op | Handler / helper |
|---|---|---|
| `routes_products.go:1185` | INSERT | `productInsertAdjustment` (`productAdjustmentCreate`, settlement product shrink at 2119) |
| `routes_products.go:1416` | UPDATE `deleted_at` | `productAdjustmentDelete` |
| `routes_stock_locations.go:2237` | UPDATE `deleted_at` | `stockSettlementVoid` |

### `equipment_stock`

| File:line | Op | Handler / helper |
|---|---|---|
| `routes_equipment.go:580` | INSERT empty row + later adjustment | `equipCreateStock` |
| `routes_equipment.go:708` | UPDATE descriptive cols (`storage_location`, `notes`, `frame_condition`, `needed_quantity`, `unit_cost_cents`, `first_deployed_year`) | `equipUpdateStock` — OV2: these columns move to `equipment_types`; this PATCH becomes a type update, not a freeze-table write |
| `routes_equipment_ledger.go:182` | UPDATE `unit_cost_cents` | `equipReceiveStock` |
| `routes_equipment_bom.go:439` | INSERT empty row `ON CONFLICT DO NOTHING` | `equipApplyAssembly` |
| `routes_equipment_bom.go:577` | UPDATE `unit_cost_cents` | assembly rolled-up cost |
| `routes_equipment_bom.go:188` | DELETE | `equipDeleteType` when stock has no history |
| `routes_honey_varietals.go:272` | INSERT empty row `ON CONFLICT DO NOTHING` | `honeyConsumePackaging` |

Triggers in 00006 also `UPDATE equipment_stock` totals; those go away with the table.

### `equipment_stock_adjustments`

| File:line | Op | Handler / helper |
|---|---|---|
| `routes_equipment.go:249` | INSERT | `equipInsertAdjustment` (receive, adjust, physical count, assembly, packaging consume) |
| `routes_sales.go:264` | INSERT `reason='sold'` | `saleInsertSoldAdjustment` |
| `routes_sales.go:414` | INSERT `reason='other'` cancel restore | `saleRevertPhysical` |
| `routes_sales.go:423` | DELETE sold rows | `saleUnapplyPhysical` |

### `equipment_deployments`

| File:line | Op | Handler / helper |
|---|---|---|
| `routes_equipment.go:850` | INSERT | `equipDeployTx` |
| `routes_equipment.go:1042` | UPDATE `quantity_returned`, `date_removed` | `equipReturnTx` |
| `routes_sales.go:456` | UPDATE restore outstanding | `saleRevertPhysical` |

### `equipment_deployment_returns`

| File:line | Op | Handler / helper |
|---|---|---|
| `routes_equipment.go:1028` | INSERT | `equipReturnTx` |
| `routes_sales.go:463` | DELETE | `saleRevertPhysical` |

### `equipment_state_changes`

| File:line | Op | Handler / helper |
|---|---|---|
| `routes_equipment.go:279` | INSERT | `equipInsertStateChange` (damage/repair/retire, return-damaged, dispose-from-condition) |

### Not freeze-eight, still dropped at Phase B (move before squash)

| Table | File:line | Op |
|---|---|---|
| `stock_locations` | `honey_ledger.go:252` | INSERT home seed |
| `stock_locations` | `routes_stock_locations.go:345` | INSERT create |
| `stock_locations` | `routes_stock_locations.go:395` | UPDATE |
| `stock_locations` | `routes_stock_locations.go:440` | UPDATE soft-delete |
| `stock_locations` | `app/restore_portable.go:424` | DELETE `slug='home'` seed yield |
| `equipment_type_components` | `routes_equipment_bom.go:306` | DELETE replace-all |
| `equipment_type_components` | `routes_equipment_bom.go:312` | INSERT |

### Restore writer (must not hit freeze)

`app/restore_portable.go:331-335` forces `equipment_stock` inserts to zero owned/damaged/retired then relies on adjustment replay (`doc.go:110`). After freeze, restore of quantity history is T5 translation into operations, not table copy.

---

## T3 producers — checklist

Move each command off the freeze tables. Each row is one §6 producer (or the lock/write it currently owns). Check off when the handler is transport-only and the command calls a builder + `Record`/`CheckAvailable`.

- [ ] Harvest allocated / re-linked — today lot ceiling is `harvest_lots.honey_weight_lbs` (stays as domain, becomes projection per decision 6). No `honey_movements` write on harvest; T3 still owns the `receive` that **replaces** that ceiling.
- [ ] `honeyRecordJarring` (`routes_honey.go:242`) — `transform` + packaging `shrink` (`honeyConsumePackaging` at 435 / `routes_honey_varietals.go:239`).
- [ ] `honeyRecordBulkMovement` (`routes_honey.go:468`) — `shrink`.
- [ ] `honeyRecordGiveAway` (`routes_honey.go:558`) — `shrink` reason `give_away`; drop `honeyLockJarSizes`.
- [ ] `honeyAdjustJarCounts` (`routes_honey.go:641`) — `count_adjust`.
- [ ] `honeyReverseMovement` (`routes_honey.go:724`) — `Reverse`; drop `FOR UPDATE` on `honey_movements`.
- [ ] `bottlingRunCreate` (`routes_commerce.go:1233`) / `bottlingRunVoid` (`:1284`) — `transform` / `reversal`; drop movement `FOR UPDATE OF m` and `honeyLockJarSizes`.
- [ ] `productBatchCreate` / `productBatchVoid` (`routes_products.go:1094`, `:1464`) — `transform` / `reversal`.
- [ ] Jar-size deactivate write-off (`routes_jar_sizes.go:280`).
- [ ] Sale apply (`routes_honey.go:1377` + `saleApplyPhysical` `routes_sales.go:24`) — `sale_consume`; `CheckAvailable` under tuple locks; colony gear from `inventory_balances` at `deployed` (A5); equipment `item_id` not `equipment_stock_id` (OV2).
- [ ] Sale cancel / unapply (`saleRevertPhysical` `routes_sales.go:372`) — `reversal`; stop INSERT/DELETE on adjustments and UPDATE/DELETE on deployments/returns.
- [ ] Consignment transfer/return (`stockWriteMovements` `routes_stock_locations.go:1036`) — `transfer`; drop `honeyLockJarSizes` / `stockLockProducts`.
- [ ] `stockMovementReverse` (`:1197`) — `reversal`.
- [ ] Settlement (`stockApplySettlement` `:1860`) — `sale_consume` + `return` + `shrink`; stop writing `stock_movements` + `honey_movements` + `product_adjustments`.
- [ ] Settlement void (`:2170`) — reverse those operations.
- [ ] Product adjustment create/delete (`routes_products.go:1249`, `:1356`) — `count_adjust` / `reversal`.
- [ ] `equipCreateStock` / receive / adjust / physical count (`routes_equipment.go:514`, `routes_equipment_ledger.go:151`, `:287`, `:601`) — `receive` / `count_adjust` / `shrink`.
- [ ] Damage / repair / retire (`routes_equipment_ledger.go:377+`) — `condition_change`.
- [ ] Deploy / return (`equipDeployTx` `:833`, `equipReturnTx` `:975`) — `deploy` / `return` into virtual `deployed` + `container_hive_id` (A1). Hive relocation must **not** write the ledger (A1).
- [ ] Assembly / disassembly (`equipApplyAssembly` `routes_equipment_bom.go:398`) — `transform` per BOM.
- [ ] Packaging consume (`honeyConsumePackaging`) — part of bottling `transform`.
- [ ] Descriptive equipment PATCH (`equipUpdateStock` `:624`) — write `equipment_types`, not `equipment_stock` (OV2).
- [ ] Delete A4 stock locks listed in (b).
- [ ] Re-key `sale_items.equipment_stock_id` → `item_id` (OV2) on write paths (`routes_honey.go:1729` INSERT list).

Frontend writers that send the old identities (must change with T3, not T4):

| Consumer | Field today |
|---|---|
| `frontend/src/features/honey/hooks.ts:311` | mutation body `equipmentStockId` |
| `frontend/src/features/honey/record-sale-dialog.tsx:274,289` | posts `equipmentStockId` |
| `frontend/src/features/honey/types.ts:83` | `SaleLineItem.equipmentStockId` |
| `frontend/src/features/honey/hooks.ts:447-454` `HiveSaleOffer.deployments[].stockId` | colony-sale gear identity |
| `frontend/src/features/hives/hooks.ts:99` | `HiveDeployment.stockId` |

---

## T4 projections — checklist (every live reader)

Format per reader: **site**, **SQL/Go**, **number**, **replacement**, **JSON**, **frontend**, **owner**. Owner is T4 unless noted.

Shared helpers are listed once; HTTP handlers that call them are listed as dependents so none is left to be discovered.

### Shared derivation helpers (the one formula per number)

#### H1. `honeyBulkOnHand` — global bulk honey

- **Site:** `backend/internal/httpapi/honey_ledger.go:44-65`
- **SQL:** `SUM(amount_lbs) FROM honey_movements WHERE kind IN ('jarring','bulk_use','loss')` plus harvest-session true-up from `harvest_sessions` / `honey_harvests` (those stay).
- **Number:** `totalHarvestedLbs`, `jarredLbs`, `bulkUsedLbs`, `lossLbs`, `bulkOnHandLbs = harvested − jarred − used − loss`.
- **Replacement:** `inventory_balances` for item `honey_bulk` at `home` (all lots including `legacy-unassigned`). Harvested pounds remain a domain sum (sessions + sessionless harvests) until decision 6's lot receipts fully replace the ceiling; after backfill, bulk on-hand **is** the honey_bulk balance. Compare legacy `global_bulk_honey` to `inventory_balances` (spec §7.2).
- **JSON:** field names on `/honey/overview` and `/honey/production-plan` can stay (`bulkOnHandLbs`, …). Values must match `inventory_balances` (not `inventory_available` — bulk honey is not reserved by draft jar sales).
- **Frontend:** `frontend/src/features/honey/types.ts:26-35` `HoneyOverview`; `frontend/src/features/honey/hooks.ts:35-39`; `frontend/src/features/dashboard/hooks.ts:53-62`; `frontend/src/features/commerce/api.ts:191-211` `ProductionPlan.bulkOnHandLbs`.
- **Dependents:** `honeyOverviewHandler` `routes_honey.go:2137`; `productionPlan` `routes_commerce.go:2491`; `honeyLotBalances` unassigned residual `routes_honey_varietals.go:68`.

#### H2. `honeyJarInventoryWithQuerier` — global jar formula

- **Site:** `routes_honey.go:2078-2123`
- **SQL:**
  ```
  FROM jar_sizes js
  LEFT JOIN (SELECT jar_size_id,
             SUM(quantity) FILTER (WHERE kind='jarring') jarred,
             SUM(quantity) FILTER (WHERE kind='give_away') given_away,
             SUM(quantity) FILTER (WHERE kind='jar_adjustment') adjusted
             FROM honey_movements GROUP BY jar_size_id) m
  LEFT JOIN (sale_items jar lines on non-cancelled sales) si
  ```
  Go then sets `OnHand = Jarred + Adjusted − Sold − GivenAway` (`:2120`). **Sold includes drafts and pending** (`order_status <> 'cancelled'`).
- **Number:** per jar size: `jarred`, `givenAway`, `adjusted`, `sold`, `onHand` (global, all locations).
- **Replacement:** `inventory_available` for each jar-size **item** summed across locations for the global figure; `inventory_balances` at `home` vs consignees for location split. Breakdown columns (`jarred`/`sold`/`givenAway`/`adjusted`) become operation-kind filters on `History`, not the balance view.
- **JSON:** `HoneyInventoryRow` (`frontend/src/features/honey/types.ts:12-24`) keeps `onHand`. `jarred`/`sold`/`givenAway`/`adjusted` **change** if T4 stops recomputing those sums from `honey_movements` — either keep them as history aggregates over operations, or drop them and change the jars tab.
- **Frontend:** `honey/hooks.ts:42-46` `useJarInventory`; `honey/types.ts`; `dashboard/hooks.ts:41-51`; `commerce/api.ts:149-155` `Profitability.breakEvenByJarSize[].onHand`; `commerce/api.ts:200-203` `ProductionPlan.recommendations[].onHand`; `commerce/api.ts:400` `useLowStock`.
- **Dependents:** `honeyInventoryHandler` `:2127`; `honeyOverviewHandler` `:2167`; `honeyLockJarSizes` `:128` (then subtracts away); `stockGlobalUnits` `routes_stock_locations.go:197`; `stockLocationShelf` home path `:565`; `stockInventoryHandler` `:665`; `productionPlan` `routes_commerce.go:2424`; profitability `:2001`; `lowStockAlerts` `:2515`.

#### H3. `stockAwayQuantities` — away-from-home finished goods

- **Site:** `honey_ledger.go:274-308`
- **SQL:**
  ```
  SELECT location_id, jar_size_id, product_id, SUM(qty)
  FROM (
    SELECT m.location_id, m.jar_size_id, m.product_id, m.quantity FROM stock_movements m
    UNION ALL
    SELECT s.stock_location_id, si.jar_size_id, si.product_id, -si.quantity
    FROM sale_items si JOIN sales s … WHERE order_status<>'cancelled' AND stock_location_id IS NOT NULL
  ) WHERE location_id NOT IN (SELECT id FROM stock_locations WHERE is_home)
  ```
- **Number:** net count per `(location, jar_size|product)` excluding home. Sales here also include drafts (same OV1 issue at a consignee).
- **Replacement:** `inventory_available` (and `inventory_balances` for physical) at each `inventory_locations` row with `kind=consignee` (or non-home). Home is no longer a residual of a second ledger; it is the `is_home` location's own balance.
- **JSON:** `StockShelfRow.onHand`, `StockInventoryRow.byLocation`, `StockLocation.onHandUnits` can stay as names. Identity stays `jarSizeId`/`productId` until items fully replace those FKs on the wire.
- **Frontend:** `frontend/src/features/commerce/stock-locations-api.ts:26-74` (`onHandUnits`, `onHand`, `total`, `byLocation`); statement lines `:127-162`.
- **Dependents:** `stockAwayJarTotals` `:312`; `stockAwayProductTotals` `:330`; `stockLoadLocations` `:161`; `stockLocationShelf` `:588`; `stockInventoryHandler` `:675`; `lowStockAlerts` `:2520`; `honeyLockJarSizes` `:132` (home = global − away).

#### H4. `honeyLockLot` on-hand read

- **Site:** `honey_ledger.go:207-208`
- **SQL:** `SELECT on_hand_lbs FROM honey_lot_balances WHERE lot_id=$1`
- **Number:** one lot's bulk remaining (lot ceiling − attributed jarring/bulk_use/loss).
- **Replacement:** `inventory_balances` for `honey_bulk` at that lot's `inventory_lot_id` (location `home`). The `harvest_lots FOR UPDATE` at `:203` stays (domain).
- **JSON:** none directly; gates 400 messages (`honeyLotShortfall`).
- **Frontend:** none (error string only).
- **Owner:** T4 for the read; T3 for the surrounding producer.

#### H5. `productInventoryQuery` — catalog SKU on-hand

- **Site:** `routes_products.go:104-147`
- **SQL:** live `product_batches.quantity_out` + `SUM(delta) FROM product_adjustments WHERE deleted_at IS NULL` − non-cancelled `sale_items` (again includes drafts).
- **Number:** per SKU `made`, `sold`, `adjusted`, `onHand = made + adjusted − sold`, `inStock`.
- **Replacement:** `inventory_available` for the catalog **item** (OV1). `made` stays a domain sum over non-voided `product_batches` (retained table). `adjusted` becomes `count_adjust`/`shrink` history.
- **JSON:** `CatalogProduct` `frontend/src/features/honey/types.ts:94-112` (`made`/`sold`/`adjusted`/`onHand`/`inStock`). `onHand` should become available-at-all-locations or be split; market-day uses `inStock` (`products-page.tsx`, `record-sale-dialog.tsx:935,963`).
- **Frontend:** `honey/hooks.ts:108-115` `useProductCatalog`; `honey/types.ts:114-117` `propolisOnHandGrams` (propolis grams are **not** from a dropped table — `propolis_harvests` + batches + sales stay; T4 only if a propolis **item** balance replaces the formula).
- **Dependents:** `productList` `:300`; `productLockCatalogInfo` `:201`; `stockGlobalUnits` `:205`; `stockLocationShelf` `:576`; `stockInventoryHandler` `:670`.

#### H6. `stockHomeLocationID` / `stock_locations` identity

- **Site:** `honey_ledger.go:242-256`; list SQL `routes_stock_locations.go:118-124`
- **SQL:** `SELECT id FROM stock_locations WHERE is_home`; full row select from `stock_locations`.
- **Number:** location identity, consignment terms (Q4), `onHandUnits` decoration from H2+H3+H5.
- **Replacement:** `inventory_locations` (`is_home`, `kind=consignee`, typed consignment columns). Phase A can keep serving `stock_locations` until freeze; T4 live reads should already join `inventory_locations` once producers write there.
- **JSON:** `StockLocation` in `stock-locations-api.ts:26-49` can stay if ids are preserved through Phase A.
- **Frontend:** `stock-locations-api.ts` entire module.

---

### Honey HTTP readers

#### R1. `GET /honey/lot-balances`

- **Site:** `routes_honey_varietals.go:38-42` view; `:74-79` unassigned draws
- **SQL:** `SELECT … lot_lbs, jarred_lbs, bulk_used_lbs, loss_lbs, on_hand_lbs FROM honey_lot_balances`; `SUM(amount_lbs) FROM honey_movements WHERE lot_id IS NULL AND kind IN ('jarring','bulk_use','loss')`
- **Number:** per-lot bulk remaining; unassigned residual `harvested − Σ lot ceilings − unattributed draws`; plus H1 totals.
- **Replacement:** `inventory_balances` for `honey_bulk` grouped by `lot_id`, joined to `harvest_lots` for varietal; unassigned = lot `legacy-unassigned` at `home`.
- **JSON:** `HoneyLotBalances` `honey/types.ts:282-307`. Field names can stay. Unassigned is a real lot after T5, not a computed residual.
- **Frontend:** `honey/hooks.ts:144-149`; `honey/varietals-view.tsx`; `honey/movement-dialogs.tsx:77` (lot `onHandLbs` for jarring picker).

#### R2. `GET /honey/varietals`

- **Site:** `routes_honey_varietals.go:110-114`
- **SQL:** `FROM honey_varietals v JOIN honey_varietal_balances b ON b.varietal_id = v.id`
- **Number:** per varietal `lotCount`, `lotLbs`, `jarredLbs`, `bulkUsedLbs`, `lossLbs`, `onHandLbs`.
- **Replacement:** same balances grouped by `harvest_lots.varietal_id`. `honey_varietals` stays.
- **JSON:** `HoneyVarietal` `honey/types.ts:310-320` — can stay.
- **Frontend:** `honey/hooks.ts:152-157`; `honey/varietals-view.tsx`.

#### R3. `GET /honey/inventory` / `GET /honey/overview`

- **Site:** `routes_honey.go:2126-2188` (uses H1 + H2)
- **Number:** overview bulk + global jar rows + revenue (revenue is `sales`, stays).
- **Replacement:** H1 + H2.
- **JSON:** `HoneyOverview` — `inventory[].onHand` is today's **global** figure including drafts subtracted. After T4 it should be `inventory_available` (OV1) if the UI keeps "what can I sell". Jars tab also subtracts away via stock inventory (see R10).
- **Frontend:** `honey/hooks.ts:35-46`; `honey/honey-overview.tsx`; `honey/jars-tab.tsx`; `dashboard/honey-summary-widget.tsx`; `dashboard/hooks.ts:53-62`.

#### R4. `GET /honey/timeline`

- **Site:** `routes_honey.go:2231-2237`
- **SQL:** `SELECT m.id, m.date, m.kind, m.amount_lbs, m.quantity, … FROM honey_movements m LEFT JOIN jar_sizes … ORDER BY m.date DESC LIMIT $1`
- **Number:** movement history rows (not a balance).
- **Replacement:** `Service.History` / operations with `legacy_ref` during Phase A. Timeline **identity** becomes `inventory_operations.id`. `reversesMovementId` → `reverses_operation_id` (Q3: "is reversed" is `EXISTS`).
- **JSON:** **changes.** `TimelineEntry` `honey/types.ts:45-58` (`reversesMovementId`, movement `id`).
- **Frontend:** `honey/hooks.ts:49-54`; `honey/activity-tab.tsx`.

#### R5. `GET /honey/low-stock`

- **Site:** `routes_commerce.go:2514-2520` (H2 + H3)
- **Number:** home on-hand vs `jar_sizes.low_stock_threshold`. Home = global jar on-hand − away.
- **Replacement:** `inventory_available` at `home` per jar item.
- **JSON:** `{ jarSizeId, label, onHand, threshold }[]` — `commerce/api.ts:400`. `onHand` meaning stays "home available" if T4 preserves the handler contract.
- **Frontend:** `commerce/api.ts:396-403`; `honey/honey-overview.tsx:274-311`.

#### R6. `GET /honey/production-plan`

- **Site:** `routes_commerce.go:2424, 2491` (H2 + H1)
- **Number:** per-size `onHand` (global jar formula), `bulkOnHandLbs`.
- **Replacement:** jar `inventory_available` (plan is about what can be sold/bottled); bulk `inventory_balances`.
- **JSON:** `ProductionPlan` `commerce/api.ts:191-211` — can stay.
- **Frontend:** `commerce/api.ts:380`.

#### R7. Profitability inventory value

- **Site:** `routes_commerce.go:2001-2024`
- **Number:** `inventoryValue` = Σ `defaultPrice * onHand`; `breakEvenByJarSize[].onHand` from H2 (global, drafts subtracted).
- **Replacement:** `inventory_available` (same formula family as finished_jar_inventory).
- **JSON:** `Profitability` `commerce/api.ts:138-155` — can stay.
- **Frontend:** `commerce/api.ts` profitability query; `commerce/business-reports.tsx`.

---

### Products HTTP readers

#### R8. `GET /products`

- **Site:** `routes_products.go:300` → H5
- **JSON:** `ProductCatalogResponse` `honey/types.ts:114-117`.
- **Frontend:** `honey/hooks.ts:108-115`; `honey/products-page.tsx`; `honey/record-sale-dialog.tsx:935,963`.

#### R9. `GET /product-adjustments`

- **Site:** `routes_products.go:1207-1216`
- **SQL:** `FROM product_adjustments a JOIN product_catalog … LEFT JOIN stock_locations l … WHERE a.deleted_at IS NULL`
- **Number:** signed `delta` history, not a balance.
- **Replacement:** `History` filtered to `count_adjust`/`shrink` for catalog items. `stock_locations` join → `inventory_locations`.
- **JSON:** **changes** if `id` is re-keyed to `inventory_operations.id`. `ProductAdjustment` `honey/types.ts:162-174` (`locationId`, `settlementId`).
- **Frontend:** `honey/hooks.ts:132-136`.

---

### Stock-location HTTP readers

#### R10. `GET /stock-locations` / `GET /stock-locations/inventory` / `GET /stock-locations/{id}`

- **Sites:** `routes_stock_locations.go:245` list; `:652` inventory; `:762` detail (shelf `:778`, movements `:825`)
- **SQL:** location catalog from `stock_locations`; quantities from H2+H3+H5; history `stockMovementHistory` `:864-878`:
  ```
  FROM stock_movements m
  LEFT JOIN jar_sizes / product_catalog / stock_locations / harvest_lots
  WHERE m.location_id=$1
  ```
- **Number:** `onHandUnits`, per-SKU shelf `onHand`, movement signed `quantity`.
- **Replacement:** balances at `inventory_locations`; history from operations (`transfer`/`sale_consume`/`shrink`/`return`).
- **JSON:** shelf/inventory field names can stay. `StockMovement.id` / `reversedByMovementId` **change** to operation ids. `stock-locations-api.ts:75-90`.
- **Frontend:** `stock-locations-api.ts:213-235`; `honey/jars-tab.tsx:44-53` splits jar grid by `StockInventory.byLocation`.

#### R11. Settlement statement

- **Site:** `routes_stock_locations.go:1441-1477`
- **SQL:** opening = `SUM(stock_movements WHERE location_id=$1 AND date < $2)` ∪ negated location-scoped sales; period movements grouped by kind from `stock_movements`.
- **Number:** `opening`, `transferredIn/Out`, `sold`, `returned`, `shrink`, `closing` per SKU.
- **Replacement:** as-of `inventory_balances` (or checkpoint + delta) at that location at period start/end; period ops filtered by kind. Sold in-period is `sale_consume` at the consignee, not "non-cancelled sale lines" if drafts must stop affecting the shelf (OV1).
- **JSON:** `StockStatement` `stock-locations-api.ts:127-162` — names can stay.
- **Frontend:** `stock-locations-api.ts:237-250`.

---

### Equipment HTTP readers

#### R12. `GET /equipment/stock`

- **Site:** `routes_equipment.go:466-471`
- **SQL:** `SELECT stock_id, type_id, … total_owned, deployed, available, damaged_quantity, retired_quantity, needed_quantity, unit_cost_cents, first_deployed_year FROM equipment_stock_status`
- **Number:** `totalOwned`, `deployed`, `available = owned − damaged − retired − deployed`, `damaged`, `retired`, plus catalog attrs on the stock row.
- **Replacement:** `inventory_balances` by item × condition (`serviceable`/`damaged`/`retired`) × location (`home` vs `deployed` + `container_hive_id`). OV2: `needed_quantity`, `unit_cost_cents`, `storage_location`, `first_deployed_year` read from `equipment_types`. OV5: `frame_condition` is **item identity**, not a column — drawn vs fresh are separate items.
- **JSON:** **changes.** `EquipmentStockRow` `frontend/src/features/equipment/types.ts:133-159` is keyed by `id` = `stock_id`. After drop the stable id is `item_id` (and maybe no one-row-per-type). `frameCondition` goes away as a field.
- **Frontend:** `equipment/hooks.ts:36-40`; `equipment/types.ts`; `inventory-view.tsx`; `stock-table.tsx`; `stock-dialogs.tsx`; `types-view.tsx`; `honey/record-sale-dialog.tsx:43,124,667,853` (equipment sale picker uses `available`).

#### R13. `GET /equipment/stock/{id}/adjustments` and `/state-changes`

- **Sites:** `routes_equipment.go:729-731`, `:774-777`
- **SQL:** `FROM equipment_stock_adjustments WHERE stock_id=$1`; `FROM equipment_state_changes WHERE stock_id=$1`
- **Number:** history, not balances.
- **Replacement:** `History` for that item (`receive`/`shrink`/`count_adjust`/`transform`; `condition_change`).
- **JSON:** **changes** (operation ids; `stockId` → `itemId`).
- **Frontend:** `equipment/hooks.ts:57-72`; `equipment/types.ts:161-183`.

#### R14. `GET /equipment/deployments/active`

- **Site:** `routes_equipment.go:1197-1204`
- **SQL:** `FROM equipment_deployments ed JOIN hives JOIN equipment_stock JOIN equipment_types WHERE date_removed IS NULL AND quantity > quantity_returned`
- **Number:** `outstanding = quantity − quantity_returned` per live deployment.
- **Replacement:** `inventory_balances` at virtual `deployed` grouped by `container_hive_id` (nonzero). There is no deployment row; outstanding **is** the balance.
- **JSON:** **changes.** `ActiveDeployment` `equipment/types.ts:185-196` (`id` was deployment id, `stockId`).
- **Frontend:** `equipment/hooks.ts:50-54`.

#### R15. `GET /hives/{id}/deployments`

- **Site:** `routes_equipment.go:1248-1254`
- **SQL:** `FROM equipment_deployments ed JOIN equipment_stock JOIN equipment_types WHERE hive_id=$1` (full history, including removed).
- **Number:** per-deployment outstanding and dates.
- **Replacement:** current outstanding from balances at `deployed`+hive; history from `deploy`/`return` operations.
- **JSON:** **changes.** `HiveDeployment` `frontend/src/features/hives/hooks.ts:97-109` (`stockId`, deployment `id`).
- **Frontend:** `hives/hooks.ts:205-209`; `hives/equipment-tab.tsx`.

#### R16. `GET /equipment/frame-summary`

- **Site:** `routes_equipment.go:1300-1341`
- **SQL:** `SELECT frame_condition, available FROM equipment_stock_status WHERE type_category='frame'`; `SUM(ed.quantity - ed.quantity_returned) FROM equipment_deployments … category='box'`.
- **Number:** standalone drawn/fresh/unspecified available frames; deployed box frame capacity.
- **Replacement:** `inventory_available` (or balances at storage) for frame **items** split by drawn/fresh (OV5); deployed boxes = balances at `deployed` for box items × `equipment_types.frames_per_box`.
- **JSON:** `FrameSummary` `equipment/types.ts:198-213` and duplicate `dashboard/hooks.ts:24-39` — structure can stay; `unspecified` should go to zero after the frame split.
- **Frontend:** `equipment/hooks.ts:43-47`; `dashboard/hooks.ts:71-75`; `dashboard/frame-shortage-widget.tsx`.

#### R17. `GET /equipment/reconciliation`

- **Site:** `routes_equipment_ledger.go:805-809`
- **SQL:** `SELECT stock_id, type_name, total_owned, ledger_total_owned, damaged_quantity, ledger_damaged, retired_quantity, ledger_retired, reconciled FROM equipment_stock_reconciliation`
- **Number:** trigger-guarded columns vs SUM of adjustments/state changes; `reconciled` boolean.
- **Replacement:** checkpoint-vs-raw-sum projection (§3.7, TD1). No `stock_id`.
- **JSON:** **changes** (columns named for the old dual-ledger). No frontend caller of `/equipment/reconciliation` (route is mounted at `routes_equipment.go:75` only).
- **Frontend:** none.

#### R18. `GET /equipment/loss-report`

- **Site:** `routes_equipment_ledger.go:709-715`, `:758-761`
- **SQL:** `FROM equipment_loss_events` (view in `00006_equipment_ledger.sql:402-437` over `equipment_state_changes` ∪ negative `equipment_stock_adjustments`).
- **Number:** damaged/retired/written-off counts and `value_cents` (uses `equipment_stock.unit_cost_cents`).
- **Replacement:** operations of kinds `condition_change` (to damaged/retired) and `shrink` (write-off); unit cost from `equipment_types` (OV2).
- **JSON:** `LossReport` `equipment/types.ts:242-272` — names can stay.
- **Frontend:** `equipment/hooks.ts:75-80`; `equipment/loss-report.tsx`. Spec did not list this view as dropped; it **dies with its base tables** and must move in T4.

#### R19. `GET /equipment/components`

- **Site:** `routes_equipment_bom.go:221-226`
- **SQL:** `FROM equipment_type_components c JOIN equipment_types pt/ct`
- **Number:** BOM line `quantity` (expectation, not on-hand). Assembly then reads component **availability** via `equipLockStock` (T3).
- **Replacement:** `inventory_boms` / `inventory_bom_lines` (spec §3.6). Component availability = `inventory_available` for the component item.
- **JSON:** `EquipmentComponentLine` `equipment/types.ts:124-131` — `id` changes if BOM ids are new; `quantity` stays.
- **Frontend:** `equipment/hooks.ts` components query; `equipment/types-view.tsx`.

#### R20. `GET /hives/{id}/sale-offer`

- **Site:** `routes_sales.go:649-656`
- **SQL:** `SELECT ed.id, ed.stock_id, et.name, …, ed.quantity - ed.quantity_returned, es.unit_cost_cents FROM equipment_deployments ed JOIN equipment_stock es JOIN equipment_types et WHERE hive_id=$1 AND date_removed IS NULL`
- **Number:** outstanding deployed gear + unit cost for the colony-sale dialog (A5).
- **Replacement:** `inventory_balances` at `deployed` + `container_hive_id`; unit cost from `equipment_types` (OV2).
- **JSON:** **changes.** `HiveSaleOffer.deployments[].stockId` `honey/hooks.ts:447-454`.
- **Frontend:** `honey/hooks.ts:457-462`; `honey/record-sale-dialog.tsx:48,132,656,1033`.

#### R21. `equipLockStock` derived counts (writer-path read)

- **Site:** `routes_equipment.go:207-218`
- **SQL:** `total_owned`, `damaged_quantity`, `retired_quantity` from `equipment_stock` plus `SUM(d.quantity - d.quantity_returned) FROM equipment_deployments`.
- **Number:** `Available()` at `:197-199` = owned − damaged − retired − deployed.
- **Replacement:** `CheckAvailable` / `Balances` under tuple locks (T3+T4 together). Deleted as a lock in (b).

#### R22. Idempotency lookup against freeze tables

- **Site:** `routes_equipment.go:306-317` `SELECT id FROM {equipment_stock_adjustments|equipment_state_changes|equipment_deployments|equipment_deployment_returns} WHERE idempotency_key=$1`
- **Replacement:** `inventory_operations.idempotency_key` (spec §5.1). T3.

#### R23. Type-delete history probe

- **Site:** `routes_equipment_bom.go:157-179`
- **SQL:** `SELECT pt.name FROM equipment_type_components …`; `EXISTS (equipment_stock_adjustments|equipment_state_changes|equipment_deployments)` after locking `equipment_stock`.
- **Replacement:** BOM membership on `inventory_bom_lines`; nonzero balances or any operations for the item refuse delete (OV4 is the hive analog). T3/T4.

---

### Recs / jobs

#### R24. Frame-shortage rule

- **Site:** `backend/internal/recs/rules.go:230-237`
- **SQL:**
  ```
  SELECT d.hive_id, h.position_label, d.quantity - d.quantity_returned, t.category, t.frames_per_box
  FROM equipment_deployments d
  JOIN equipment_stock s ON s.id = d.stock_id
  JOIN equipment_types t ON t.id = s.type_id
  JOIN hives h ON h.id = d.hive_id
  WHERE d.date_removed IS NULL AND d.quantity > d.quantity_returned
    AND h.status = 'active' AND h.is_archived = false
  ```
- **Number:** per-hive deployed box capacity vs deployed frames (then shortage message).
- **Replacement:** `inventory_balances` at `deployed` by `container_hive_id`, join `inventory_items`/`equipment_types` for category and `frames_per_box` (spec §8.1 first row).
- **JSON:** recommendation `message` string only — `frontend/src/features/recommendations/api.ts:17-28` has no quantity fields. Shape stays; copy may change.
- **Frontend:** `recommendations/api.ts`; `dashboard/hooks.ts:13-22` (duplicate type).
- **Jobs:** `backend/internal/jobs/recommend.go:16` calls `recs.Run` — no SQL of its own. T4 owns the rule query.

`internal/gnucashsync`: no table reads (see (a)).

---

### Sales list join (label + COGS identity)

#### R25. `honeyListSales` line items

- **Site:** `routes_honey.go:949-963`
- **SQL:** `SELECT si.…, si.equipment_stock_id, … LEFT JOIN equipment_stock es ON es.id = si.equipment_stock_id LEFT JOIN equipment_types et ON et.id = es.type_id`
- **Number:** none (label + `equipmentStockId` identity). Cost basis is already on `sale_items`.
- **Replacement:** `sale_items.item_id` (OV2).
- **JSON:** **changes.** `SaleLineItem.equipmentStockId` `honey/types.ts:83`.
- **Frontend:** `honey/types.ts`; `honey/sales-tab.tsx:99`; `commerce/receipt-view.tsx:70`.

#### R26. GnuCash sale body

- **Site:** `routes_gnucash_sync.go:1098-1106`
- **SQL:** same `LEFT JOIN equipment_stock es` for line label.
- **Replacement:** `item_id` → type name. Body composition change is the content-hash rebaseline (spec §8) — T5 transform + T4 read.
- **JSON:** GnuCash payload, not the SPA. `frontend/src/features/settings/api.ts` has no inventory numbers.

#### R27. COGS snapshot read at apply

- **Site:** `routes_sales.go:258-259`
- **SQL:** `SELECT unit_cost_cents FROM equipment_stock WHERE id=$1`
- **Number:** cents snapshotted onto the adjustment and `sale_items.cost_basis_cents`.
- **Replacement:** `equipment_types.unit_cost_cents` (OV2). T3 write path; T4 if any report still reads stock.

---

### Compliance packet and Honey Story (spec §8.1 last row)

#### R28. Compliance lots

- **Site:** `routes_ops.go:900-904`
- **SQL:** `SELECT id, lot_code, extraction_date, honey_weight_lbs, … FROM harvest_lots`
- **Number:** `honey_weight_lbs` (lot ceiling). **Does not** read `honey_lot_balances` or `honey_movements`.
- **Replacement:** domain table stays; decision 6 makes the ceiling a projection of the lot's `receive`. Packet should expose that projection (and never an inferred FIFO lot as fact — A3).
- **JSON:** `complianceLot.HoneyWeightLbs` can stay.
- **Frontend:** `settings` compliance section consumes the packet JSON/print; no `api.ts` quantity fields.

#### R29. Honey Story public lot

- **Site:** `routes_commerce.go:1544-1552` (`harvestedPounds: item.HoneyWeightLbs` from `harvest_lots`)
- **Number:** lot weight, not a movement sum. Bottling run `quantity` on the story is from `bottling_runs` (stays).
- **Replacement:** same as R28. A3: do not add inferred allocations to this payload.
- **JSON:** public story already omits inventory. No SPA `api.ts` shape change required for quantity.

---

### Snapshot live reads (Phase A still exports frozen tables)

`snapshot/registry.go:34-44` lists dropped tables as format-v1 domains. `snapshot/exporter.go:455-456` maps `external_sync` entity types onto those tables. These remain valid **until Phase B drop**. They are not T4 HTTP switches; T5's translate-mode exporter grows the `newLedger` family (spec §9 step 8). Listed so T4 does not "fix" the exporter out from under T5.

---

## T5 backfill — checklist

T5 **keeps** reading the freeze tables (that is the source). It must not be rewritten onto projections until after freeze+parity.

### Legacy aggregate family (`snapshot/legacy.go`) — parity oracle

Each spec is one `QueryRow` in `computeLegacyAggregates` (`legacy.go:65-71`). §7.2 says which new projection it is compared to.

| Name | Site | Reads | Compare to (spec §7.2) |
|---|---|---|---|
| `global_bulk_honey` | `legacy.go:31-33, 43` | `honey_movements` jarring/bulk_use/loss + harvests | `inventory_balances` (mass, 0.0001) |
| `lot_bulk_honey` | `:44` | `SELECT * FROM honey_lot_balances` | `inventory_balances` per lot |
| `varietal_bulk_honey` | `:45` | `honey_varietal_balances` | `inventory_balances` grouped by varietal |
| `unassigned_bulk_honey_residual` | `:46` | `honey_movements` `lot_id IS NULL` | `legacy-unassigned` opening_balance + balances |
| `finished_jar_inventory` | `:48` | `honey_movements` + non-cancelled jar sales | **`inventory_available`** (OV1) |
| `catalog_product_inventory` | `:49` | `product_adjustments` + batches + sales | **`inventory_available`** |
| `away_finished_goods` | `:51` | `stock_movements` + `stock_locations.is_home` + sales | `inventory_balances` at consignees |
| `home_jar_residual` | `:52` | `honey_movements` + `stock_movements` + `stock_locations` | `inventory_balances` at `home` (jars) |
| `home_product_residual` | `:53` | `product_adjustments` + `stock_movements` | `inventory_balances` at `home` (products) |
| `equipment_stock_status` | `:54` | view `equipment_stock_status` | `inventory_balances` (after OV5 frame split: `equipment_condition_totals`) |
| `equipment_ledger_reconciliation` | `:55` | `equipment_stock_reconciliation` | checkpoint-vs-raw-sum (must be true at freeze) |
| `equipment_condition_totals` | `:56` | `equipment_stock` damaged/retired columns | `inventory_balances` by condition |
| `packaging_equipment_inventory` | `:57` | `equipment_stock_status WHERE type_category='packaging'` | packaging item balances |
| `equipment_bom_components` | `:58` | `equipment_type_components` ⋈ `equipment_stock_status.available` | BOM + component `inventory_available` |

`raw_propolis_inventory` (`:50`) does **not** read a dropped table (harvests + tincture batches + propolis sales). Still compared to `inventory_available` for the propolis item (OV1).

### Translation inputs (T5 reads, T3 stops writing)

Spec §7.1 order, all cited as table scans T5 must implement (not present as a translator yet):

1. Registries / items / locations from catalogs + `stock_locations` + `apiaries`.
2. Harvest receipts from `harvest_lot_harvests` (stays).
3. `honey_movements` by `created_at`.
4. `product_adjustments` (live) + batches/propolis (stay).
5. `equipment_stock_adjustments` by date.
6. `equipment_state_changes`.
7. `equipment_deployments` / `equipment_deployment_returns`.
8. `stock_movements`.
9. Applied `sales` only (`physical_applied_at`).
10. Residual splits vs the family above.

### Freeze + restore

- [ ] `BEFORE INSERT OR UPDATE OR DELETE` on the eight tables after successful parity.
- [ ] `restore_portable.go` equipment_stock zero-insert + adjustment replay replaced by operation translation.
- [ ] GnuCash re-key for the **six** dissolved allowlist types in (a); test file named in spec §12.
- [ ] Exporter: while frozen tables exist, still fill the `legacy` family; `newLedger` family is additive.

---

## Frontend API expectations (`frontend/src/features/**/api.ts`)

Only some features use a file named `api.ts`. Quantity-carrying response shapes:

| File | Shape / field | Backend reader | JSON change? |
|---|---|---|---|
| `commerce/api.ts:147,154` | `Profitability.inventoryValue`, `breakEvenByJarSize[].onHand` | R7 / H2 | No, if T4 keeps names; `onHand` becomes available |
| `commerce/api.ts:196-203` | `ProductionPlan.bulkOnHandLbs`, `recommendations[].onHand` | R6 | No |
| `commerce/api.ts:400` | `useLowStock` `{ jarSizeId, label, onHand, threshold }` | R5 | No |
| `commerce/stock-locations-api.ts:46,57,66-68,82,132-138` | `onHandUnits`, shelf `onHand`, matrix `total`/`byLocation`, movement `quantity`, statement qty columns | R10, R11, H3 | Movement ids **yes**; qty field names no |
| `recommendations/api.ts:17-28` | no numeric inventory fields | R24 | No |

Sibling files that are the real contracts (no `api.ts` in the feature):

| File | Shape | Change? |
|---|---|---|
| `honey/types.ts:12-35, 77-90, 94-117, 162-174, 282-320` | inventory, overview, sale lines, products, adjustments, lot/varietal balances | `equipmentStockId` **yes**; timeline reverse id **yes**; lot/varietal names no |
| `honey/hooks.ts:439-454` | `HiveSaleOffer.deployments[].stockId` | **yes** |
| `equipment/types.ts:124-272` | stock row, deployments, frame summary, loss, BOM | stock/deployment ids **yes**; `frameCondition` **yes** (OV5); loss names no |
| `hives/hooks.ts:97-109` | `HiveDeployment.stockId` | **yes** |
| `dashboard/hooks.ts:24-62` | `FrameSummary`, `HoneyOverview` | same as R16/R3 |

`settings/api.ts` GnuCash mapping has `inventory?: string` (account name, not on-hand). No T4 quantity work.

---

## Coverage matrix (named tables/views × production readers)

| Object | Production readers (file:line) | Wave-2 |
|---|---|---|
| `honey_movements` | H1 `:56-58`; H2 `:2095`; H4 via view; R1 `:77`; R4 `:2234`; T3 writers (c); T5 `legacy.go:31-33,46,48,52` | T3 write, T4 read, T5 parity |
| `honey_lot_balances` | R1 `:42`; H4 `:208`; T5 `:44` | T4, T5 |
| `honey_varietal_balances` | R2 `:114`; T5 `:45` | T4, T5 |
| `stock_movements` | H3 `:282`; R10 `:871`; R11 `:1444,1476`; T3 writers; T5 `:51-53` | T3, T4, T5 |
| `stock_locations` | H3 `:244,291`; R10 `:122`; R9 `:1214`; T5 `:51`; restore `:424` | T4 (→ `inventory_locations`), Phase B drop |
| `product_adjustments` | H5 `:125`; R9 `:1212`; T3 writers; T5 `:49,53` | T3, T4, T5 |
| `equipment_stock` | R12 via view; R21 `:213`; R25 `:962`; R26 `:1104`; R27 `:259`; R20 `:653`; recs `:234`; T3 writers; T5 `:56` | T3, T4, T5 |
| `equipment_stock_status` | R12 `:471`; R16 `:1302`; T5 `:54,57,58` | T4, T5 |
| `equipment_stock_reconciliation` | R17 `:809`; T5 `:55` | T4, T5 |
| `equipment_stock_adjustments` | R13 `:731`; R18 via `equipment_loss_events`; R22; R23 `:177`; T3 writers | T3, T4 |
| `equipment_state_changes` | R13 `:777`; R18; R22; R23 `:178`; T3 writers | T3, T4 |
| `equipment_deployments` | R14 `:1200`; R15 `:1251`; R16 `:1335`; R20 `:652`; R21 `:212`; R24 `:233`; R23 `:179`; T3 writers | T3, T4 |
| `equipment_deployment_returns` | `equipLoadReturnResult` `routes_equipment.go:1100`; T3 writers | T3, T4 (history) |
| `equipment_type_components` | R19 `:223`; R23 `:157`; assembly `:407`; T5 `:58` | T4 (→ BOMs), Phase B drop |
| `equipment_loss_events` (derived view, not in spec drop list) | R18 `:715,761` | T4 |

`internal/jobs` and `internal/gnucashsync`: no direct SQL against these objects.

Test-only SELECTs (not live readers; rewrite with T3/T4 tests): `honey_integration_test.go`, `routes_equipment_db_test.go`, `routes_products_test.go`, `routes_stock_locations_test.go`, `db/equipment_migration_test.go`, etc.

---

## JSON-shape change summary (frontend must-change list)

Must change in the same Phase A switch (dropped identities leak into JSON):

1. `equipmentStockId` → `itemId` on sale lines — `honey/types.ts`, `honey/hooks.ts`, `record-sale-dialog.tsx`, `sales-tab.tsx`, `commerce/receipt-view.tsx`.
2. Equipment stock/deployment primary keys — `equipment/types.ts` `EquipmentStockRow.id`, `ActiveDeployment`, `hives/hooks.ts` `HiveDeployment.stockId`, `HiveSaleOffer.deployments`.
3. `frameCondition` on stock rows — OV5 item split; `equipment/types.ts:142`.
4. Timeline / stock-movement / product-adjustment row ids and `reversesMovementId` — operation ids.
5. `/equipment/reconciliation` column names — checkpoint projection (no SPA consumer today).

Can keep field names if T4 preserves the DTO and only swaps the SQL:

- `HoneyOverview`, `HoneyInventoryRow.onHand`, `HoneyLotBalance`, `HoneyVarietal`, `ProductionPlan`, `Profitability` jar `onHand`, low-stock, stock shelf/matrix/statement quantities, `FrameSummary` counts, `LossReport` counts, recommendation messages.

OV1 semantic change (not a rename): any `onHand` that today subtracts draft/pending sales becomes `inventory_available`. Call that out in QA; the key name can stay.

---

## Explicit non-readers (so they are not "discovered" later)

- Compliance packet and Honey Story do **not** read `honey_lot_balances` / `honey_movements`; they read `harvest_lots.honey_weight_lbs`. Still in T4 because decision 6 makes that column a projection.
- Propolis on-hand grams do **not** read a dropped table.
- `honeyBulkLockKey` is not deleted (A4/OV7).
- Hive relocation must not become a ledger writer (A1) — no T3 producer for it.
- `internal/gnucashsync` has no SQL; only `routes_gnucash_sync.go:1104`.
- `internal/jobs` has no SQL; only `recs.Run`.
)
