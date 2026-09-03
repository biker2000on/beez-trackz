# Inventory ledger design — roadmap P1 item 9

**Status:** design spec, decisions ratified by the operator 2026-09-01. This
document is the contract for the clean-baseline schema and the importer
translation. It supersedes the "Generalized core" sketch in
`docs/product-roadmap.md` where the two differ (differences are called out
in §2).

**Prerequisite met:** the P0 portable snapshot round-trip gate passed against
a copy of production on 2026-09-01 (`docs/restore-runbook.md`,
`docs/plans/2026-09-01-roundtrip-gate-design.md`). A fresh snapshot and a
passing gate run immediately before the actual reset remain mandatory.

---

## 1. Goal and non-goals

**Goal.** One signed, immutable movement ledger is the sole authority for
on-hand quantity of every stockable thing — bulk honey, jars, catalog
products, raw propolis, equipment, packaging — by item × location × lot ×
condition, with the hive as an explicit container dimension for deployed
gear. Every stock-changing command in the application produces operations on
this ledger; nothing else writes a quantity. Balances are projections.

**Non-goals.**

- Not a rewrite of bee, honey, sales, or provenance domain records. Hives,
  queens, inspections, harvest sessions, lots, bottling runs, jar serials,
  sales, customers, settlements, and GnuCash sync state stay first-class and
  keep their facts. They *reference* operations; they do not change
  quantities on their own.
- Not a live cutover. The app is pre-launch; the migration chain is squashed
  and the working database is rebuilt from the validated snapshot through the
  importer (decisions 9 and 10).
- Not a copy of gnucash-web's inventory: we borrow the movement-ledger spine,
  not its thinner domain model.

---

## 2. Decisions (ratified 2026-09-01)

| # | Question | Decision | Consequence |
|---|---|---|---|
| 1 | Do hives become inventory locations? | **No.** A hive is a unique mobile identity; "A4" is a stand *position* at an apiary that different hives occupy over time. | Locations are places: sites, storage areas, apiaries, consignees. The hive is a **container** dimension on movements. *Amended by review A1:* container-tracked gear sits at a virtual `deployed` location and its apiary is derived from `hive_location_history`; a hive relocation does not touch the ledger. |
| 2 | Does a draft sale create an operation? | **No.** Physical operations happen at bottling (bulk → jars) and at sale apply / shipment to consignment. | Draft/pending demand is a *reservation projection* over sale lines, not a movement. Stock validation reads on-hand minus reservations. |
| 3 | Per-unit serial tracking in the ledger? | **No.** Serialized jars are fungible within their lot; serials are labels. | No `inventory_units` table. `jar_serials` stays a domain record (lot, bottling run, serial, optional sale link). The roadmap's units table is withdrawn. |
| 4 | Unit representation | `numeric(14,4)` for mass, integer for counts; tolerance 0.0001 in the nonnegative invariant. Two decimals would do today; four is future-proof. | Float noise eliminated at the storage layer; the P0 aggregate-rounding lesson does not recur. |
| 5 | Condition vocabulary | Generated from the union of `frame_condition` and `equipment_state_changes` states; the importer coerces legacy values. | One `inventory_conditions` registry seeded by the importer translation. |
| 6 | Derived lot weight vs immutable movements | A lot's ceiling **is** a receipt movement into the lot. Re-linking a harvest is a reversal plus a new receipt. | `harvest_lots.honey_weight_lbs` / `honey_weight_source` become a projection; the 00039 recompute logic becomes an operation producer. |
| 7 | Where lockout and moisture refusals live | **Domain commands**, before they produce an operation. | The inventory service has no beekeeping knowledge; it enforces ledger invariants only. |
| 8 | Residual-to-opening-balance splits | Lead's call (§7.4): unassigned bulk → `opening_balance` receipt into lot `legacy-unassigned` at `home`; home jar/product residuals → per-item `opening_balance` at `home`, lot `legacy-unassigned` where the jar cannot be traced to a lot. | Declared as `legacy-residual-split-v1` in `verification.json`; the gate compares against it. |
| 9 | Migration chain | **Squash** 00001–00049 into one initial schema. | Goose restarts at `00001_baseline.sql`. The snapshot format version stays 1; a `formatVersion` 1→1 identity transform with the residual splits is the importer's translation. |
| 10 | Legacy quantity tables | **All dropped** after translation: `honey_movements`, `stock_movements`, `product_adjustments`, `equipment_stock`, `equipment_stock_adjustments`, `equipment_deployments`, `equipment_deployment_returns`, `equipment_state_changes`. | They are inventory surfaces and are represented as operations. Their UUIDs survive as `inventory_operations.legacy_ref` for provenance and GnuCash re-key. |

### 2.1 Engineering review amendments (2026-09-02, `/plan-eng-review`)

Thirteen findings, all resolved by the operator; each is folded into the
section it affects and summarized here so the decision trail is in one place.

| # | Finding | Resolution |
|---|---|---|
| A1 | Deployed gear's apiary was stored twice (movement `location_id` + `hive_location_history`); hive position is written from four handler sites, so the copy would drift. | Container-tracked movements use a virtual `deployed` location; the apiary is derived by joining `hive_location_history`. **A hive relocation never touches the ledger.** Decision 1's "relocation emits transfers" consequence is withdrawn. |
| A2 | The reservation projection was named but never defined. | Reservations are a **query** over `sale_items` on sales that are neither applied nor cancelled — no table. Stock validation reads `available = on_hand − reserved` under the service's tuple locks. |
| A3 | FIFO lot allocation for untraced jar lines invents provenance. | Keep FIFO by lot receipt date, but record `lot_allocation.method = 'fifo-inferred'` on the operation and expose an inferred-allocation report filter; Honey Story never treats an inferred lot as fact. |
| A4 | Two lock disciplines (advisory tuple locks + existing `FOR UPDATE` row locks) would coexist without a global order. | The inventory service is the **only** quantity locker (`pg_advisory_xact_lock` per tuple, sorted); producers take domain row locks only *before* `Record`; `honeyLockJarSizes`-style stock locks are removed; order documented in `doc.go`; a two-goroutine deadlock regression test is required. |
| A5 | Colony sales carry deployed gear; the spec consumed it from storage. | A colony sale line lists the deployed gear it includes; `sale_consume` lines carry `container = hive`; the sales command marks the hive sold in the same unit of work. |
| A6 | After the squash, goose silently reports "no migrations to run" against a database still at version 49. | Baseline stamps a `schema_generation` row; `db.Connect`, the importer, and `roundtrip-gate` refuse a database whose generation or goose max version does not match the binary. All dev/test databases are recreated as a documented step. |
| Q1 | Producers (§6) and the importer translation (§7) implemented every operation shape twice. | **Pure operation builders** in `app/inventory/build` are the single definition of each shape, called by live commands and by the translator; the translator adds only residual splits and provenance marking. |
| Q2 | Three integrity rules were prose only. | Composite FK `(lot_id, item_id) → inventory_lots(id, item_id)`; a `BEFORE INSERT` trigger rejecting a quantity that does not match the item's scale; `reason` becomes a `NOT NULL` column backed by an `inventory_operation_reasons` registry. |
| Q3 | `reversed_by_operation_id` made the "immutable" table mutable and allowed double reversal. | Dropped. `UNIQUE INDEX ... (reverses_operation_id) WHERE reverses_operation_id IS NOT NULL`; "is reversed" is an `EXISTS`. |
| Q4 | Consignment terms moved into jsonb, losing the 00024 CHECKs. | The typed columns (`is_consignment`, `price_basis`, `commission_bps`, `settlement_cadence`) and their CHECKs carry onto `inventory_locations` for `kind = consignee`. |
| T1 | No test plan. | §12 added: every path in §5–§9 has a named test; the translate-mode gate is the reset's acceptance test. |
| P1 | Balance view is a full SUM per availability check while holding the tuple lock; no index on the dimension tuple. | Composite index on the tuple now; plain view stays; §3.7 reserves an additive `inventory_balance_checkpoints` materialization with a measured trigger. |
| P2 | Row-by-row lookups in translation steps 5 and 7. | Step 7's as-of lookup disappears with A1; the translator preloads lookup maps once per stage. |
| TD1 | Balance checkpoint materialization was reserved as a future TODO. | **Operator chose to build it now** (overrides P1's deferral): `inventory_balance_checkpoints` ships with the ledger, with the reconciliation test against the raw sum. |

Outside voice (independent Claude subagent, fresh context, read-only against
the code) then found seven further gaps the review had missed. All accepted;
folded into the sections they touch:

| # | Finding | Resolution |
|---|---|---|
| OV1 | Legacy jar/product/propolis formulas subtract **draft** lines (`legacy.go:48-50`); translation step 9 consumed pending sales that apply then consumed again; the reservation view named `sale_items` columns that do not exist; no locked entry point existed for a draft. | Translation consumes only sales with `physical_applied_at`; drafts and pending sales are reservations; §7.2 compares the legacy jar/product/propolis values to `inventory_available`, not `inventory_balances`; `Service.CheckAvailable(uow, tuples)` takes the tuple locks for drafts; `sale_items` gains `item_id` and `inventory_lot_id` by declared transform. |
| OV2 | `equipment_stock` carries catalog facts (`unit_cost_cents`, `needed_quantity`, `storage_location`, `first_deployed_year`) read by COGS and GnuCash bodies, and `sale_items.equipment_stock_id` FKs to it. | Those attributes move to `equipment_types`; `equipment_stock` is dropped; `sale_items.equipment_stock_id` re-keys to `sale_items.item_id`; COGS and sync bodies read the type. |
| OV3 | The generation guard refused the legacy-source export the translate gate needs, while `worker` (`ConnectWithoutMigrations`) stayed unguarded. | Every entry point checks the generation; `export-snapshot` and the gate's *source* connection accept `--legacy-source`, which permits generation `legacy` only on a `default_transaction_read_only = on` connection; import and worker never accept it. |
| OV4 | Polymorphic `container_type/container_id` had no FK; `routes_hives.go:613` hard-deletes hives and would orphan deployed gear. | `container_hive_id uuid REFERENCES hives(id)`; deleting a hive is refused while any tuple with that container has a nonzero balance. A second container kind is an additive nullable column later. |
| OV5 | `frame_condition` (`drawn`/`fresh`, 00001:29) is what a frame *is*, orthogonal to serviceable/damaged/retired; merging them (decision 5) made drawn-but-damaged unrepresentable. | Drawn and fresh frames are **separate items** with a `transform` (fresh → drawn); `condition` is only the state axis; the importer splits legacy rows by `frame_condition`. Decision 5 amended. |
| OV6 | Readers outside inventory depend on dropped tables/views: `internal/recs/rules.go:230-237` (deployments), `routes_honey_varietals.go:42,77,114` (dropped views), `routes_equipment_ledger.go:809`, `external_sync.go:29-30` (entity list beyond 00041). | §8.1 names every reader and its replacement projection; the `external_sync` entity count is re-audited from code, not from 00041. |
| OV7 | §9 steps 1–4 were one atomic big-bang: squash, drop, translate, and rewrite every producer before any reset. | **Phased** (§9): Phase A lands the ledger additively on the current chain with an idempotent backfill, freezes the legacy tables read-only, switches every read to the new projections, and checks parity at the freeze point — no dual-write; Phase B squashes and drops after the ledger has run alone, with the P0 gate proving the squash. Decisions 9 and 10 stay the destination. Also noted from the outside voice: `doc.go` subsumes the existing non-stock lock order (`honeyBulkLockKey`, `userSettingsLockKey`, harvest→lot→bulk) rather than replacing it, and `legacy-unassigned` jar stock dominates inferred allocations until the physical count retires it — stated, accepted. |

---

## 3. Core schema

All tables are new in the squashed baseline. Every table has `id uuid`,
`created_at`, `created_by` (nullable, `app_users`), and where mutable
`updated_at`. Reference registries are insert-only rows, never CHECK
allowlists (the 00041 lesson).

### 3.1 Registries

```sql
inventory_item_kinds       (kind text PK, description text, unit_family text)
  -- honey_bulk, jar, catalog_product, propolis_raw, equipment, packaging, (future: wax, mead_bulk, ...)
inventory_location_kinds   (kind text PK, description text)
  -- site, storage_area, apiary, consignee, in_transit, deployed (virtual, one row; see §3.3)
inventory_operation_reasons (reason text PK, description text, applies_to_kinds text[])
  -- give_away, loss, feeding, settlement_shrink, count, packaging_consumed_untraced, ...
inventory_operation_kinds  (kind text PK, description text, sided text)
  -- sided: 'one' | 'paired' | 'transform' (see §4)
inventory_conditions       (condition text PK, description text, sellable boolean)
  -- serviceable, damaged, retired ONLY (state axis). Drawn vs fresh frames are
  -- different ITEMS, not conditions (review OV5; see §7.3).
```

### 3.2 Items

```sql
inventory_items (
  id uuid PK,
  kind text NOT NULL REFERENCES inventory_item_kinds,
  name text NOT NULL,
  canonical_unit text NOT NULL,          -- 'lb' | 'g' | 'count'
  quantity_scale smallint NOT NULL,      -- 4 for mass, 0 for counts
  lot_tracked boolean NOT NULL,
  condition_tracked boolean NOT NULL,
  container_tracked boolean NOT NULL,    -- true for equipment/packaging that deploys into hives
  source_type text, source_id uuid,      -- polymorphic link to the domain catalog row
  is_active boolean NOT NULL DEFAULT true,
  UNIQUE (source_type, source_id)
)
```

Domain catalogs stay authoritative for their own attributes and point at the
item: `jar_sizes.item_id`, `product_catalog.item_id`,
`equipment_types.item_id`. Two singleton items are seeded: `honey_bulk`
(lb, lot-tracked) and `propolis_raw` (g, lot-tracked). A new product family is
a new item-kind row plus catalog rows — no DDL.

### 3.3 Locations

```sql
inventory_locations (
  id uuid PK,
  kind text NOT NULL REFERENCES inventory_location_kinds,
  name text NOT NULL,
  parent_id uuid REFERENCES inventory_locations,
  is_home boolean NOT NULL DEFAULT false,
  source_type text, source_id uuid,      -- 'apiary' → apiaries.id, 'customer' → customers.id
  -- consignment terms: typed columns and CHECKs carried verbatim from 00024
  -- stock_locations (review Q4), meaningful only for kind = 'consignee'
  is_consignment boolean NOT NULL DEFAULT false,
  price_basis text NOT NULL DEFAULT 'retail' CHECK (price_basis IN ('retail','commission','wholesale_list')),
  commission_bps integer CHECK (commission_bps IS NULL OR (commission_bps BETWEEN 0 AND 10000)),
  settlement_cadence text NOT NULL DEFAULT 'monthly' CHECK (settlement_cadence IN ('weekly','monthly','quarterly','on_demand')),
  is_active boolean NOT NULL DEFAULT true
)
```

Seeded: `home` (site, `is_home`), one `apiary` location per `apiaries` row
(parent `home` is not implied — apiaries are peers of `home`), one
`consignee` per current consignment `stock_locations` row, and exactly one
**virtual `deployed` location** (review A1). Container-tracked gear that is
on a hive lives at `deployed` with `container = hive`; its physical apiary is
derived at query time by joining `hive_location_history` on the hive and
date. Stand positions ("A4") are **not** locations; they remain
`hive_location_history` facts on the hive, and a hive relocation is a hive
fact only — it never writes to the ledger.

### 3.4 Lots

```sql
inventory_lots (
  id uuid PK,
  item_id uuid NOT NULL REFERENCES inventory_items,
  code text NOT NULL,
  source_type text, source_id uuid,      -- 'harvest_lot' → harvest_lots.id, 'propolis_harvest', 'product_batch'
  attributes jsonb NOT NULL DEFAULT '{}', -- canonicalized per docs/snapshot-format.md
  is_legacy_unassigned boolean NOT NULL DEFAULT false,
  UNIQUE (item_id, code)
)
```

`harvest_lots` keeps every provenance and Honey Story field and gains
`inventory_lot_id`. Lockout is never a lot column (decision 7). One
`legacy-unassigned` lot per lot-tracked item is seeded by the importer.

### 3.5 Operations and movements

```sql
inventory_operations (
  id uuid PK,
  kind text NOT NULL REFERENCES inventory_operation_kinds,
  occurred_at timestamptz NOT NULL,
  idempotency_key text NOT NULL UNIQUE,  -- payload-bound (§5.1)
  source_type text NOT NULL, source_id uuid NOT NULL,   -- the commanding domain record
  reason text NOT NULL REFERENCES inventory_operation_reasons,  -- review Q2; 'none' for kinds without one
  reverses_operation_id uuid REFERENCES inventory_operations,
  legacy_ref_type text, legacy_ref_id uuid,             -- dropped-table provenance (decision 10)
  details jsonb NOT NULL DEFAULT '{}',                  -- free-form facts only; lot_allocation.method lives here
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES app_users,
  provenance text NOT NULL DEFAULT 'recorded'           -- 'recorded' | 'legacy-import' | 'legacy-unattributed'
)
CREATE UNIQUE INDEX inventory_operations_single_reversal
  ON inventory_operations (reverses_operation_id) WHERE reverses_operation_id IS NOT NULL;

inventory_movements (
  id uuid PK,
  operation_id uuid NOT NULL REFERENCES inventory_operations,
  line_no smallint NOT NULL,
  item_id uuid NOT NULL REFERENCES inventory_items,
  location_id uuid NOT NULL REFERENCES inventory_locations,
  lot_id uuid,
  condition text REFERENCES inventory_conditions,
  container_hive_id uuid REFERENCES hives (id),         -- decision 1 + review OV4: a real FK; a second
                                                        -- container kind is an additive nullable column later
  quantity numeric(14,4) NOT NULL CHECK (quantity <> 0),
  UNIQUE (operation_id, line_no),
  FOREIGN KEY (lot_id, item_id) REFERENCES inventory_lots (id, item_id)   -- review Q2: a lot can only hold its own item
)
CREATE INDEX inventory_movements_tuple_idx
  ON inventory_movements (item_id, location_id, lot_id, condition, container_hive_id);  -- review P1
-- Deleting a hive is refused while any (item, lot, condition) with
-- container_hive_id = that hive has a nonzero balance (review OV4). The FK
-- is ON DELETE SET NULL (wave 1 implementation): once the guard passes, the
-- hive may be deleted and its historical movement rows keep everything
-- except the container pointer. Today's equipment_deployments FK blocks
-- deleting any hive that ever held gear; this is deliberately more
-- permissive, and the guard is what protects live balances.
-- BEFORE INSERT trigger inventory_movement_scale_guard: refuses a quantity whose
-- fractional digits exceed inventory_items.quantity_scale (review Q2).
```

`inventory_operations` and `inventory_movements` rows are never updated or
deleted (review Q3: there is no back-pointer to maintain). A correction is a
new operation with `reverses_operation_id` set; the partial unique index
makes a second reversal of the same original impossible, and "is this
operation reversed" is `EXISTS (SELECT 1 ... WHERE reverses_operation_id = $1)`.

The **dimension tuple** is `(item, location, lot, condition, container)`.
Adding a dimension is a design-review event; everything else extends by
rows.

### 3.6 BOM templates

```sql
inventory_boms      (id uuid PK, name text, output_item_id uuid, is_active boolean)
inventory_bom_lines (id uuid PK, bom_id uuid, role text, item_id uuid, quantity numeric(14,4),
                     -- role: 'input' | 'output' | 'byproduct' | 'waste'
                     UNIQUE (bom_id, role, item_id))
```

Absorbs `equipment_type_components` (assembly BOMs), `jar_sizes.packaging_type_id`
(one-line packaging BOM per jar size), and `equipment_types.variant_of_type_id`
(recorded as an `attributes` link on the item, not a BOM). Transform
operations record *actuals*; the BOM is the expectation used for validation
and yield reporting.

### 3.7 Projections (never writable)

```sql
CREATE VIEW inventory_balances AS
  SELECT item_id, location_id, lot_id, condition, container_type, container_id,
         SUM(quantity) AS on_hand
  FROM inventory_movements GROUP BY 1,2,3,4,5,6;

CREATE VIEW inventory_reservations AS   -- decision 2, review A2/OV1: derived, never stored
  SELECT si.item_id,
         CASE WHEN si.hive_id IS NOT NULL THEN deployed.id          -- colony-sale gear is reserved where it sits
              ELSE COALESCE(s.stock_location_id, home.id) END AS location_id,
         si.inventory_lot_id AS lot_id,
         si.hive_id AS container_hive_id,
         SUM(si.quantity)::numeric(14,4) AS reserved
  FROM sale_items si
  JOIN sales s ON s.id = si.sale_id
  CROSS JOIN (SELECT id FROM inventory_locations WHERE is_home) home
  CROSS JOIN (SELECT id FROM inventory_locations WHERE kind = 'deployed') deployed
  WHERE s.physical_applied_at IS NULL AND s.order_status <> 'cancelled'
    AND si.item_id IS NOT NULL                                     -- colony lines themselves carry no item
  GROUP BY 1,2,3,4;

CREATE VIEW inventory_available AS      -- on_hand - reserved, per (item, location, lot, container)
```

`sale_items` gains `item_id` (jar, product, propolis, and equipment lines
alike — review OV2) and `inventory_lot_id`, populated by a declared
translation from `jar_size_id` / `product_id` / `equipment_stock_id` /
`bottling_run_id`. A reservation is a draft **or pending** sale line, nothing
else: it begins when the line is saved, changes when the line is edited, and
ends when the sale is applied (the line becomes a `sale_consume`) or
cancelled. Stock validation calls `Service.CheckAvailable(uow, tuples)`
(review OV1), which takes the same sorted tuple locks as `Record` and reads
`inventory_available`, so two drafts racing for the last jars serialize
exactly as sales do today — the guarantee `honeyLockJarSizes` gave, now owned
by the service.

**Balances are materialized from day one** (operator decision TD1,
overriding the P1 deferral): `inventory_balance_checkpoints
(item_id, location_id, lot_id, condition, container_hive_id,
as_of_operation_id, on_hand numeric(14,4), refreshed_at)` is written by a
periodic checkpoint job, and `inventory_balances` is defined as the
checkpoint row plus the SUM of movements recorded after `as_of_operation_id`,
over `inventory_movements_tuple_idx`. The checkpoint is a cache of the
movements, never an authority: a reconciliation test compares every
checkpoint against the raw SUM, and the job refuses to write a checkpoint
that disagrees with the raw sum it was computed from. Availability checks
therefore cost O(movements since last checkpoint).

---

## 4. Operation kinds and their shapes

| kind | sided | lines | produced by (domain command) |
|---|---|---|---|
| `receive` | one | +qty into location/lot | harvest allocation to a lot (§6.1), propolis harvest, equipment purchase, colony/package intake (equipment only), opening balance (import) |
| `opening_balance` | one | +qty | importer residual splits only (§7.4); refused from the API |
| `transfer` | paired | −qty at from, +qty at to; nets to zero per item/lot/condition/container | consignment shipment and return, hive relocation (contents), storage moves |
| `deploy` / `return` | paired | −qty at storage (container null), +qty at apiary (container = hive) and the reverse | hive equipment deploy/return; intake |
| `transform` | transform | inputs negative, outputs positive per BOM roles; may cross items | bottling (bulk lot → jars, packaging consumed), product batches (honey/propolis → catalog product), equipment assembly/disassembly, tincture |
| `sale_consume` | one | −qty at the sale's source location | sale apply (`physical_applied_at`), consignment sale report |
| `sale_return` | one | +qty | refund/return to stock |
| `shrink` | one | −qty | loss, give-away, settlement shrink at a consignee |
| `count_adjust` | one | ±qty | physical count approval (post-reset only) |
| `condition_change` | paired | −qty condition A, +qty condition B, same location/lot/container | damage, retire, repair |
| `reversal` | mirrors original | exact negation of every line | any command's undo path |

`give_away` and `jar_adjustment` are `shrink` / `count_adjust` with
`reason = 'give_away'` / `'count'` from the `inventory_operation_reasons`
registry (review Q2) — a real column, so reports group on it. New stock
behavior = a new `inventory_operation_kinds` row (and reasons) plus a
producer; never a new table.

---

## 5. Invariants and where they are enforced

### 5.1 Idempotency — inventory service

`idempotency_key` is mandatory and **payload-bound**: the producer supplies
`<source_type>:<source_id>:<command>:<attempt-or-version>` and the service
stores `sha256(canonical(lines))` in `details._payload_hash`. A replay with
the same key and hash returns the existing operation (no-op); the same key
with a different hash is a `conflict`. This replaces the three inconsistent
legacy behaviors (equipment replayed without comparing payloads; product and
stock movements 409'd; transfer subkeys depended on line order).

### 5.2 Nonnegative balances — inventory service

For every affected `(item, location, lot, condition, container)` tuple, the
service takes `pg_advisory_xact_lock(hashtext(tuple))` in ascending hash
order, reads the projected balance (and, for sales, `inventory_available`)
inside the transaction, and refuses any line that would take a
**lot-tracked** item below `−0.0001` or a count item below 0. Non-lot-tracked
mass (none today) follows the same rule. Consignee locations are included:
consigned jars cannot be over-sold at home because they are not at home.

**Lock discipline (review A4) — the inventory service is the only quantity
locker.** Producers may lock their own domain rows (`sales FOR UPDATE`,
`bottling_runs FOR UPDATE`) but always *before* calling `Record` or
`CheckAvailable`, never after, and never for stock purposes:
`honeyLockJarSizes` and every other stock-motivated row lock is deleted.
`Record` acquires tuple locks in sorted order and releases them at commit.
The non-stock advisory locks that remain (`honeyBulkLockKey`,
`userSettingsLockKey`, the harvest → lot → bulk order in
`routes_commerce.go:236-261`) are **subsumed into** the documented order in
`app/inventory/doc.go` — they come before tuple locks — not replaced by it
(outside voice, finding 10). A two-goroutine deadlock regression test (§12)
runs two conflicting producers concurrently against the test database.

### 5.3 Reversal — inventory service

A reversal negates every line of exactly one operation, references it, and
is refused if the original is already reversed — enforced by the partial
unique index in §3.5, not only by application code. Aggregate-aware undo (a
bottling run void must reverse its transform *and* unlink serials *and* mark
the run) is a **domain command** that issues the reversal and then updates its
own records in the same unit of work — the ledger does not know about runs.

### 5.4 Transfers and transforms — inventory service

Transfers net to zero per `(item, lot, condition, container)` across the
pair. Transforms must carry at least one input and one output line; input
and output items may differ; mass conservation is **not** enforced by the
ledger (bottling loses weight to skimming, tincture changes unit family) —
yield variance is reported against the BOM, not refused.

### 5.5 Beekeeping rules — domain commands (decision 7)

Treatment lockout (harvest → hive → treatment-event walk), moisture
override, withdrawal windows, future-dated harvest refusal, and the
"refuse to delete a harvest under a lot with live bottling runs" rule all
stay in the honey/production/sales commands, evaluated **before** the
command asks the inventory service for an operation. The ledger has no
column and no hook for them.

### 5.6 Transaction ownership — application layer

The outer use-case command (`sales.ApplySale`, `production.RecordBottling`,
`equipment.Deploy`, `field.RelocateHive`) owns the `app.UnitOfWork`. The
inventory service is a participant: `inventory.Record(ctx, uow, op)` writes
inside the caller's transaction. This is the convention established by the
P0 restore foundation (`backend/internal/app/doc.go`); `internal/app/inventory`
is its first non-restore package.

---

## 6. Producers: domain command → operation

### 6.1 Honey

| Command | Operation |
|---|---|
| Harvest allocated to a lot (`harvest_lot_harvests` insert) | `receive` `honey_bulk` +lbs into lot at `home` (lot's storage location); the lot ceiling **is** this receipt (decision 6) |
| Harvest re-linked / unlinked | `reversal` of that receipt + new `receive` |
| Harvest with no lot | `receive` into `legacy-unassigned` lot (post-reset: refused — every harvest must name a lot, matching the 2026-08-31 lotId rule) |
| Bottling run | `transform`: −bulk lbs from lot, +jars (jar-size item) into the same `inventory_lot`, −packaging per jar-size BOM |
| Bottling run void | domain command: `reversal` of the transform, unlink unsold serials, mark run voided |
| Bulk use (feeding, product batch input) | `transform` (batch) or `shrink` with reason (feeding) |
| Loss / give-away | `shrink` with reason |

### 6.2 Products and propolis

| Command | Operation |
|---|---|
| Propolis harvest | `receive` `propolis_raw` +g into a propolis lot |
| Product batch (creamed/hot honey, tincture, mead) | `transform`: inputs (honey lot lbs, propolis g, packaging), output +quantity_out of the catalog item into a batch lot |
| Product batch void | `reversal` (refused if outputs already drawn — same rule as today) |
| Product adjustment | `count_adjust` with reason |

### 6.3 Sales and consignment

| Command | Operation |
|---|---|
| Sale created / edited while draft or pending | **none** (decision 2); the line is a reservation, validated through `CheckAvailable` under tuple locks (review OV1) |
| Sale applied (`physical_applied_at`) | `sale_consume` per line at the sale's `stock_location` (home or consignee); jar lines with a `bottling_run_id` consume from that run's lot; an untraced jar line consumes from the location's oldest-receipt lot for that jar size **and records `details.lot_allocation = {method: 'fifo-inferred', lot_id}`** (review A3) — an inferred allocation is queryable and is never presented as recorded provenance |
| Sale cancelled after apply | `reversal` |
| Consignment transfer / return | `transfer` home ↔ consignee, lot-preserving |
| Settlement shrink | `shrink` at the consignee |
| Equipment sale line (loose gear) | `sale_consume` from the storage location it sits in |
| Colony sale line | the line lists the deployed gear that leaves with the colony; `sale_consume` lines carry `container = hive` at the `deployed` location (review A5); the hive itself is not stock — the sales command marks it sold in the same unit of work, and the hive's balances reach zero exactly when the colony leaves |

### 6.4 Equipment and packaging

| Command | Operation |
|---|---|
| Purchase / intake | `receive` +count at storage, condition `serviceable` |
| Deploy to hive | `deploy`: −count at storage (container null) → +count at the virtual `deployed` location, `container = hive` (review A1) |
| Return from hive | `return` (the mirror) |
| Hive relocation (`hive_location_history` insert with a new apiary) | **no operation** (review A1) — the hive's position is a hive fact; "equipment at Yard B as of date X" joins `hive_location_history` |
| Damage / retire / repair | `condition_change` |
| Assembly / disassembly | `transform` per the equipment BOM |
| Packaging consumed by bottling | part of the bottling `transform` |

### 6.5 Field

| Command | Operation |
|---|---|
| Colony intake (package/nuc) | equipment lines only (`receive` + `deploy`); the colony is a hive record |
| Deadout / hive merge | domain command; deployed gear stays `container = hive` until returned, so "what is in the dead hive" still answers |

---

## 7. Importer translation (snapshot → operations)

The P0 importer already restores every domain record verbatim. This work
adds a **translation stage** for the dropped quantity tables (decision 10),
run under the system-restore actor in causal order, emitting operations with
`provenance = 'legacy-import'` (or `'legacy-unattributed'` where the source
row had no actor — every `honey_movements` row) and `legacy_ref_*` set to
the dropped row's identity.

**The translator does not define operation shapes** (review Q1). Every
shape — `BottlingTransform`, `Deploy`, `Return`, `SaleConsume`,
`ConsignmentTransfer`, `ConditionChange`, `Assembly`, `Receive`, `Shrink`,
`CountAdjust`, `Reversal` — is a pure builder in `app/inventory/build` that
takes explicit inputs (ids, quantities, timestamps, actor) and returns an
`Operation` value. Live commands call the builders after their beekeeping
guards; the translator calls the same builders from legacy rows and adds
only three things of its own: the residual splits (§7.4), the provenance and
`legacy_ref` markers, and the condition coercion (§7.3). Lookups the
translator needs (bottling runs by date and jar size, conditions, items by
catalog id) are **preloaded once per stage into maps** (review P2), never
queried per row.

### 7.1 Ordering

1. Seed registries, `home`, apiary and consignee locations, items from
   catalogs, conditions (§7.3), `legacy-unassigned` lots.
2. Harvest receipts: for each `harvest_lot_harvests` link with a live
   harvest, `receive` into the lot dated at the harvest; sessionless and
   unlinked harvests → `legacy-unassigned`.
3. `honey_movements` by `created_at`: jarring → `transform` (lot from
   `lot_id`, else `legacy-unassigned`); bulk_use/loss → `shrink`;
   give_away → `shrink` (reason `give_away`); jar_adjustment →
   `count_adjust`; rows with `reverses_movement_id` → `reversal` of the
   operation translated from the referenced row.
4. `propolis_harvests` → `receive`; `product_batches` (non-voided) →
   `transform`; voided batches → transform + `reversal` at `voided_at`;
   `product_adjustments` (live) → `count_adjust`.
5. `equipment_stock_adjustments` by date → `receive` / `shrink` /
   `count_adjust` by sign and reason (`assembled`/`disassembled` →
   `transform`; `consumed` → part of the corresponding bottling transform
   when the bottling run is identifiable by date+jar size, else `shrink`
   with reason `packaging_consumed_untraced`).
6. `equipment_state_changes` → `condition_change`.
7. `equipment_deployments` / `_returns` → `deploy` / `return` into the
   virtual `deployed` location with `container = hive` (review A1; no as-of
   apiary lookup is needed).
8. `stock_movements` → `transfer` / `shrink` at consignees; consignment
   sales already applied → `sale_consume` at the consignee.
9. `sales` with `physical_applied_at` set → `sale_consume` (review OV1).
   Draft **and pending** sales → nothing; they are reservations. Note the
   legacy jar/product/propolis formulas subtract *every* non-cancelled line
   including drafts (`legacy.go:48-50`), so §7.2 compares those three legacy
   values to `inventory_available`, not to `inventory_balances`; a pending
   sale is consumed exactly once, when its status transition applies it.
10. Residual splits (§7.4). `legacy-unassigned` jar stock (jarring rows with
    no `bottling_run_id`) is large relative to traced stock and every later
    untraced sale FIFO-infers from it; inferred provenance therefore
    dominates until the physical count retires the lot — accepted and
    stated (outside voice, finding 12).

### 7.2 Verification

After translation, the new projections are compared with the snapshot's
**legacy** aggregate family through the declared `legacy-residual-split-v1`
transform. Because the legacy `finished_jar_inventory`,
`catalog_product_inventory`, and `raw_propolis_inventory` formulas subtract
draft and pending lines, they are compared to **`inventory_available`**;
`away_finished_goods`, `equipment_stock_status`, `equipment_condition_totals`
(after the drawn/fresh item split of §7.3), `lot_bulk_honey`, and
`global_bulk_honey` are compared to `inventory_balances`. Counts must match
exactly, mass within 0.0001. Any other difference is investigated, not
concealed, and the gate fails.

### 7.3 Condition coercion and the frame split (decision 5, amended by OV5)

`condition` is the state axis only: the translation maps
`equipment_state_changes` states to `serviceable` / `damaged` / `retired`.
`equipment_stock.frame_condition` (`drawn` | `fresh`) is *what the frame is*,
so a legacy stock row carrying a frame condition is split into two items
(`<frame type>, drawn` and `<frame type>, fresh`) with their balances
translated separately; a fresh frame becoming drawn is a `transform`
post-reset. The mapping is recorded in the restore report.

### 7.4 Residual splits (decision 8)

- **Unassigned bulk honey** (`total harvested − Σ lot ceilings − Σ lot-less
  draws`): one `opening_balance` receipt of that many lbs into
  `honey_bulk` lot `legacy-unassigned` at `home`, dated at the earliest
  harvest. If the residual is negative, the gate fails — that is a real data
  problem to investigate before reset.
- **Home jar residual** per jar size (`global jars − Σ away`): after steps
  3, 8, and 9 the projection at `home` should already equal it. Any
  remaining difference becomes one `opening_balance` per jar size at `home`,
  lot `legacy-unassigned`, with `details.reason = 'home-residual-split'`.
  Same for **home product residual** per catalog product.
- Each split is listed in the restore report and in the new-ledger
  `verification.json` family with its amount, so the post-adjustment
  snapshot (roadmap phase 5) can retire the `legacy-unassigned` lots through
  explicit `count_adjust` operations once the physical count is done.

---

## 8. Dropped tables, retained records, and the GnuCash re-key

**Dropped** (decision 10): `honey_movements`, `stock_movements`,
`product_adjustments`, `equipment_stock`, `equipment_stock_adjustments`,
`equipment_deployments`, `equipment_deployment_returns`,
`equipment_state_changes`, `stock_locations` (→ `inventory_locations`),
`equipment_type_components` (→ BOMs), and the views `honey_lot_balances`,
`honey_varietal_balances`, `equipment_stock_status`,
`equipment_stock_reconciliation`, and `equipment_loss_events` (a view over
`equipment_state_changes` ∪ `equipment_stock_adjustments` that
`/equipment/loss-report` reads — found by the wave-1 audit; T4 moves it).

**Retained, with declared transforms** (review OV2/OV1 — "verbatim" was
wrong for four tables; every change below is a named `formatVersion` 1
transform the gate applies before comparing digests):
`harvest_lots (+inventory_lot_id)`, `bottling_runs (+operation_id)`,
`jar_serials` (unchanged — decision 3), `product_batches (+operation_id, +inventory_lot_id)`,
`propolis_harvests (+operation_id)`, `sales (+applied_operation_id;
stock_location_id re-keyed to inventory_locations)`,
`sale_items (+item_id, +inventory_lot_id; equipment_stock_id dropped —
re-keyed to item_id)`, `consignment_settlements (+shrink_operation_id)`,
`jar_sizes (+item_id)`, `product_catalog (+item_id)`,
`equipment_types (+item_id, +unit_cost_cents, +needed_quantity,
+storage_location, +first_deployed_year — moved from equipment_stock; COGS
snapshots and GnuCash sale bodies read these from the type)`, and every bee,
field, place, media, work, and sync table verbatim.

### 8.1 Readers outside inventory that must move (review OV6)

Each of these reads a dropped table or view today and gets a named
replacement projection in the same change — none is left to be discovered:

| Reader | Reads today | Replacement |
|---|---|---|
| `internal/recs/rules.go:230-237` (frame-shortage / equipment recommendations) | `equipment_deployments` | `inventory_balances` at `deployed` by `container_hive_id` |
| `routes_honey_varietals.go:42,77,114` | `honey_lot_balances`, `honey_varietal_balances`, `honey_movements` | `inventory_balances` for `honey_bulk` grouped by lot → varietal via `harvest_lots` |
| `routes_equipment_ledger.go:809` (reconciliation report) | `equipment_stock_reconciliation` | a checkpoint-vs-raw-sum reconciliation projection (§3.7) |
| honey overview, jar inventory, product inventory, away stock | `honey_movements`, `stock_movements`, `product_adjustments` sums | `inventory_available` / `inventory_balances` |
| `external_sync.go:29-30` entity-type list | code list wider than 00041 | re-audited from code; the dissolved set is whatever the code list says, not "nine" |
| compliance packet, Honey Story lot facts | lot weight / balances | `inventory_lots` + balances; Honey Story never surfaces an inferred allocation as fact (review A3) |

**GnuCash re-key (roadmap B2, deferred to here by design).** The
`external_sync.entity_type` allowlist drops the **six** dissolved types —
`honey_movement`, `stock_movement`, `equipment_stock`,
`equipment_stock_adjustment`, `product_adjustment` (→ `inventory_operation`)
and `stock_location` (→ `inventory_location`) — per the wave-1 audit
(`docs/plans/2026-09-02-ledger-read-path-migration.md`; the Go list matches
00041, so OV6's "wider than 00041" did not hold at `bd05aa2`); `entity_id`
for a dissolved row is re-keyed
through `inventory_operations.legacy_ref_*` by the translation, and
`content_hash` is rebaselined from the new body composition before the
pull-first reconciliation (`docs/restore-runbook.md` §5). Production
currently has **zero** `external_sync` rows, so for the first reset this is
an allowlist change with nothing to re-key — but the transform is written
and tested regardless, because the next reset will not be so lucky.

---

## 9. Phased landing, then squash (decisions 9 and 10, re-sequenced by OV7)

The outside voice's objection was correct: dropping the legacy tables in
the same change that introduces the ledger makes steps "squash + translate +
rewrite every producer" one atomic cutover that cannot ship partially.
Decisions 9 and 10 remain the **destination**; the path is two phases. No
dual-write at any point — the roadmap's ban on shadow-write machinery holds.

**Phase A — additive ledger on the current chain.**

1. Migration `00050_inventory_ledger.sql`: §3 tables, registries, views,
   the checkpoint table, `sale_items.item_id/inventory_lot_id`, the
   `equipment_types` attribute columns, and `schema_generation` (stamped
   `'ledger-v1'` here, not at the squash).
2. `app/inventory` (builders, service with `Record` / `Reverse` /
   `CheckAvailable`), and the producers in `app/production`, `app/sales`,
   `app/equipment`, `app/field` with the HTTP handlers reduced to transport
   (scope confirmed in review D3). Every read path in §8.1 switches to the
   new projections in the same change.
3. **Backfill = the §7 translation, run in place** as an idempotent job
   under the system-restore actor against the live legacy tables (same
   builders, same residual splits, same `legacy_ref`s). It runs inside one
   transaction that ends by **freezing the legacy tables**: a `BEFORE
   INSERT OR UPDATE OR DELETE` trigger raising on each of the eight tables,
   so the parity check in step 4 compares a fixed legacy state.
4. Parity at the freeze point: §7.2 against the legacy aggregate family
   computed from the frozen tables. The job refuses to commit the freeze if
   parity fails, so a failed backfill leaves the legacy tables live and
   writable — the ledger is simply empty and the producers are not yet
   switched on (feature-gated behind the presence of a committed freeze).
5. Operate on the ledger alone. Legacy tables and views remain, frozen and
   read-only, for reference and for the gate in Phase B.

**Phase B — squash and drop, once the ledger has run alone for a real
period and the physical count (§9 step 7 below) has landed.**

6. Write `backend/internal/db/migrations/00001_baseline.sql` as the full
   target schema minus the dropped set; move the old chain to
   `legacy-00001-00050/` for reference. `schema_generation` becomes
   `'ledger-v1-baseline'`.
7. **Generation guard on every entry point (review A6 + OV3).** `server`,
   `worker`, `export-snapshot`, `import-snapshot`, `roundtrip-gate`, and
   `set-password` refuse a database whose `schema_generation` row or
   `goose_db_version` max does not match the binary. The one exception is
   explicit and read-only: `export-snapshot --legacy-source` and the gate's
   *source* connection accept the previous generation on a connection
   opened with `SET default_transaction_read_only = on`; `import-snapshot`
   and `worker` never accept it. Every dev, CI, and test database is
   dropped and recreated once, as a runbook step.
8. Exporter: a `ledger-v1` database exports the `inventory_*` domains and
   fills the `newLedger` aggregate family (the `legacy` family only when
   the frozen tables exist); `roundtrip-gate -translate` becomes plain
   `roundtrip-gate` against the new schema — the squash is proven by the
   ordinary P0 gate (export → baseline import → re-export → digest
   equality), since translation already happened in Phase A.
9. Take the final snapshot, run the gate, reset to the baseline, restore
   with GnuCash disabled, verify, reconfigure per the runbook.

**Operator steps that sit between the phases** (extend
`docs/restore-runbook.md`):

- Physical count and consignment reconciliation as `count_adjust`
  operations; export a post-adjustment snapshot; retire the
  `legacy-unassigned` lots.
- GnuCash: entity re-key and content-hash rebaseline (§8), the
  reconciliation sweep against folio's verify endpoint, `markReconciled`,
  enable sync.

---

## 10. Application layer: `internal/app/inventory`

```go
package inventory

type Service struct{ ... }

// Record writes one operation inside the caller's unit of work, enforcing
// §5.1–§5.4. It never opens its own transaction.
func (s *Service) Record(ctx context.Context, uow *app.UnitOfWork, op Operation) (Recorded, error)

// Reverse records the exact negation of an existing operation.
func (s *Service) Reverse(ctx context.Context, uow *app.UnitOfWork, originalID uuid.UUID, key string, reason string) (Recorded, error)

// CheckAvailable takes the sorted tuple locks and verifies on_hand - reserved
// covers the requested quantities, without recording anything. It is the
// entry point for draft/pending sale validation (review OV1) and holds the
// locks until the caller's transaction ends.
func (s *Service) CheckAvailable(ctx context.Context, uow *app.UnitOfWork, needs []TupleQuantity) error

// Queries (read models): Balances(filter), Available(filter), History(tuple), LotLedger(lotID).
```

`Operation` is a value: kind, reason, occurred_at, idempotency key, source
ref, lines. It is constructed only through the pure builders in
`app/inventory/build` (review Q1), which are the single definition of every
operation shape and are shared with the importer translator. Producers live
in `app/production`, `app/sales`, `app/equipment`, `app/field`, each owning
its outer command and its beekeeping rules (decision 7), calling a builder
and then `Record`. HTTP handlers become transport only, as the roadmap's workflow
section requires; the first handlers to move are the ones that today own
cross-domain transactions (`routes_honey.go` sale apply, `routes_products.go`
batch create, `routes_stock_locations.go` transfers/settlements,
`routes_equipment.go` deploy).

---

## 11. Extensibility check (the roadmap's seven rules)

| Future feature | Lands as | DDL? |
|---|---|---|
| Creamed honey, mead, wax | item-kind row + catalog rows + BOM | no |
| Second consignment shop, market tote | location rows | no |
| Catch-box bait stock, equipment loan | operation-kind row + producer | no |
| Asset-tagged equipment | **deferred by decision 3**; if ever needed, a `units` table joins movements by `(operation, line)` — additive | additive only |
| New condition | condition row (or import coercion) | no |
| Any new report | projection | no |
| Pollination contracts, extractor telemetry | domain records referencing operations or sessions | outside the ledger |

Only a new **dimension** (§3.5) changes the movement tuple, and that is a
design-review event.

---

## 12. Test plan (review T1 — every path named before implementation)

Go, `TZ=UTC`; database-backed tests skip without `TEST_DATABASE_URL` and
run with `-p 1`, matching the existing suite. Builder and service tests
live beside their packages; producer tests beside their commands; the
translation and gate tests extend the P0 suites.

| Area | Test (file) | Asserts |
|---|---|---|
| Baseline | `internal/db/schema_generation_test.go` | fresh DB gets `ledger-v1`; a DB stamped `legacy` or with a foreign goose max is refused by `db.Connect`, `import-snapshot`, and `roundtrip-gate` with a named error |
| Builders | `app/inventory/build/*_test.go` (table tests, no DB) | each builder's lines for canonical inputs: receive, transfer nets to zero, deploy/return mirror, bottling transform (bulk −, jars +, packaging −), batch transform, sale_consume with/without container, shrink with reason, count_adjust sign, condition_change pairing, reversal exact negation; zero-quantity and scale violations rejected before the DB |
| Service | `app/inventory/service_db_test.go` | idempotency: same key+hash no-op, same key different hash → conflict; nonnegative at −0.0001 boundary for mass and 0 for counts; transfer pairing violation refused; transform without input or output refused; composite lot/item FK, scale trigger, and reason registry each produce a typed error; reversal once, second refused by the index |
| Locks | `app/inventory/deadlock_db_test.go` | two goroutines run conflicting producers (sale at home vs consignment transfer of the same jar size/lot) 200× with no `40P01`; one waits, both commit |
| Reservations | `app/sales/reservation_db_test.go` | two drafts for the last N jars: second refused under lock; apply converts the reservation to consumption; cancel releases it; consignee-located sale reserves at the consignee |
| Producers | `app/{production,sales,equipment,field}/*_db_test.go` | one test per §6 row: bottling, bottling void (once), batch, batch void refused after draw-down, sale apply/cancel/unapply, consignment transfer/return/shrink, deploy/return, condition change, assembly/disassembly, colony sale with gear (hive balances reach zero, hive marked sold), FIFO-inferred allocation flagged and reported; lockout and moisture refusals still fire *before* any operation is recorded |
| Translation | `cmd/import-snapshot/translate_test.go` on a seeded legacy fixture | ordering 1–10; every legacy row yields exactly one operation with `legacy_ref`; unattributed honey rows carry `legacy-unattributed`; condition coercion mapping recorded; residual splits produce declared opening balances; **a negative unassigned residual fails the gate**; §7.2 reconciliation against the legacy aggregate family passes exactly for counts and within 0.0001 for mass |
| Exporter | `internal/snapshot/exporter_newschema_test.go` | a new-schema DB exports `inventory_*` domains and fills the `newLedger` family; the `legacy` family is absent |
| Gate | `cmd/roundtrip-gate/translate_gate_test.go` [→E2E] | legacy fixture → translate-restore → re-export → zero unexplained differences; second translate-import is a no-op by fingerprint |
| GnuCash | `internal/httpapi/external_sync_rekey_test.go` | synthetic `external_sync` rows for the six dissolved types (§8) re-key — five to `inventory_operation` via `legacy_ref`, `stock_location` to `inventory_location`; `content_hash` rebaseline leaves unchanged remote bodies `synced`; a changed remote body stays `diverged` |
| Checkpoints | `app/inventory/checkpoint_db_test.go` | every checkpoint equals the raw SUM; a job run against a moved tuple refuses to write a disagreeing checkpoint; availability reads through checkpoint + delta equal the raw view |
| CheckAvailable | `app/inventory/service_db_test.go` | takes tuple locks (observable via `pg_locks`), passes when available covers the need, fails with a typed error naming the tuple otherwise; two concurrent callers for the last N serialize |
| Generation guard | `internal/db/schema_generation_test.go` (+ per-cmd) | `server`, `worker`, `import-snapshot` refuse the previous generation; `export-snapshot --legacy-source` accepts it only on a read-only connection and any write attempt fails with 25006 |
| Frame split | `cmd/import-snapshot/translate_test.go` | a legacy stock row with `frame_condition = drawn` becomes the drawn item's balance; damaged drawn frames reconcile in `equipment_condition_totals` |
| Hive delete guard | `internal/httpapi/routes_hives_test.go` | deleting a hive with a nonzero deployed balance is refused with the named container; succeeds after `return` |
| Replacement projections | one parity test per §8.1 row | each new projection returns the same numbers as the frozen legacy read on the seeded fixture |
| Freeze | `cmd/import-snapshot/backfill_db_test.go` | after a successful backfill every legacy table refuses INSERT/UPDATE/DELETE; a failed parity leaves them writable and the ledger empty |
| Rehearsal | operator step, runbook | Phase A backfill on a fresh prod copy; later, Phase B `roundtrip-gate` against the new schema; reports retained |

## 12.1 Implementation log and open items (updated as waves land)

- **Wave 1 (2026-09-02):** migration 00050 (core), 00051 (generation
  stamp), `app/inventory`, generation guard with `--legacy-source`, read-path
  audit.
- **Wave 2 (2026-09-02):** `app/equipment`, `app/field`, equipment readers and
  recs on the ledger, `app/backfill` (equipment history, freeze, six-type
  re-key — refuses to freeze while other legacy rows exist), Phase A docs.
- **Wave 3a (2026-09-03):** `app/production`, `app/sales`, every honey /
  product / stock-location / sales writer and reader on the ledger, migration
  00052 (`sale_items` targets `item_id`), BOM assembly on the ledger,
  equipment opening residual, seeded-row yield for the P0 importer. No
  production writer of the eight legacy tables remains.

**Open items carried into wave 3b/3c** (found by the wave-3a workers):

1. `routes_harvest_sessions.go:735` — the harvest-entry soft-delete guard is
   vacuous now that lot pounds are receipts (decision 6); the true-up guard at
   `:622` compares a declared weight delta against ledger bulk. Re-base both
   on the lot ceilings.
2. GnuCash sale bodies still join `equipment_stock` through
   `sale_items.equipment_stock_id`; new equipment lines carry only
   `item_id`. The composer must read `equipment_types` via `item_id` before
   Phase B drops the column.
3. `equipment_stock_status` (view) still sums the frozen legacy tables; it is
   dropped in Phase B and must have no remaining readers by then.
4. `app/sales.CheckAvailability` subtracts the asking sale's own stored
   reservation; any caller that re-validates a stored sale in place needs a
   "less this sale" variant.
5. Raw-propolis sale lines carry no `item_id` (their stock is harvested
   grams); `propolisOnHandGrams` subtracts unapplied lines itself — the one
   reservation the view does not express.
6. Untraced jar/product reservations pin one FIFO-inferred lot while apply
   may consume across several; the report labels it honestly, the
   reservation is approximate (candidate finding, accepted).
7. Frontend `features/equipment` still names legacy identities (46
   occurrences) — wave 3b.

## 13. Roadmap corrections implied by this spec

- The roadmap's generalized-core bullet listing `inventory_units` +
  `inventory_movement_units` is withdrawn (decision 3); Zebra item 3
  (serialized jar traceability) works from `jar_serials` + lot + the
  bottling run's operation, and Zebra item 7 (equipment/bin labels) waits on
  an optional future units table rather than a core one.
- "Do hives become locations?" is answered **no**; the container dimension
  replaces it.
- Item 11 (Zebra) is gated on the ledger and workflow resets, not on serial
  identity in the ledger.
- Decision 5 is amended (OV5): condition is the state axis only; drawn vs
  fresh are items.
- Decisions 9 and 10 are re-sequenced (OV7): additive ledger and freeze
  first, squash and drop second. The roadmap's phase list for item 9 should
  read Phase A / Phase B as in §9.

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 0 | — | — |
| Codex Review | `/codex review` | Independent 2nd opinion | 0 | — | Codex timed out (5 min); Claude subagent outside voice ran instead |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 1 | CLEAR (PLAN) | 13 issues (6 arch, 4 quality, 1 test, 2 perf) + 7 outside-voice findings, all resolved; 0 critical gaps |
| Design Review | `/plan-design-review` | UI/UX gaps | 0 | — | — |
| DX Review | `/plan-devex-review` | Developer experience gaps | 0 | — | — |

- **CROSS-MODEL:** the outside voice (Claude subagent, fresh context) found 7 gaps the four-section review missed — draft-sale double-count against the legacy formulas, `equipment_stock` catalog attributes, the generation-guard hole, the container FK, the frame-condition category error, external read paths, and big-bang sequencing — all accepted; its one-thing simplification (additive ledger before squash) was adopted as sequencing with decisions 9/10 kept as the destination.
- **VERDICT:** ENG CLEARED — ready to implement. Scope confirmed at full (ledger + app/* extraction) by the operator in D3.

NO UNRESOLVED DECISIONS
