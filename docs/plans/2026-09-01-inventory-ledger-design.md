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
| 1 | Do hives become inventory locations? | **No.** A hive is a unique mobile identity; "A4" is a stand *position* at an apiary that different hives occupy over time. | Locations are places: sites, storage areas, apiaries, consignees. The hive is a **container** dimension on movements. A hive relocation emits transfer movements for its contents. |
| 2 | Does a draft sale create an operation? | **No.** Physical operations happen at bottling (bulk → jars) and at sale apply / shipment to consignment. | Draft/pending demand is a *reservation projection* over sale lines, not a movement. Stock validation reads on-hand minus reservations. |
| 3 | Per-unit serial tracking in the ledger? | **No.** Serialized jars are fungible within their lot; serials are labels. | No `inventory_units` table. `jar_serials` stays a domain record (lot, bottling run, serial, optional sale link). The roadmap's units table is withdrawn. |
| 4 | Unit representation | `numeric(14,4)` for mass, integer for counts; tolerance 0.0001 in the nonnegative invariant. Two decimals would do today; four is future-proof. | Float noise eliminated at the storage layer; the P0 aggregate-rounding lesson does not recur. |
| 5 | Condition vocabulary | Generated from the union of `frame_condition` and `equipment_state_changes` states; the importer coerces legacy values. | One `inventory_conditions` registry seeded by the importer translation. |
| 6 | Derived lot weight vs immutable movements | A lot's ceiling **is** a receipt movement into the lot. Re-linking a harvest is a reversal plus a new receipt. | `harvest_lots.honey_weight_lbs` / `honey_weight_source` become a projection; the 00039 recompute logic becomes an operation producer. |
| 7 | Where lockout and moisture refusals live | **Domain commands**, before they produce an operation. | The inventory service has no beekeeping knowledge; it enforces ledger invariants only. |
| 8 | Residual-to-opening-balance splits | Lead's call (§7.4): unassigned bulk → `opening_balance` receipt into lot `legacy-unassigned` at `home`; home jar/product residuals → per-item `opening_balance` at `home`, lot `legacy-unassigned` where the jar cannot be traced to a lot. | Declared as `legacy-residual-split-v1` in `verification.json`; the gate compares against it. |
| 9 | Migration chain | **Squash** 00001–00049 into one initial schema. | Goose restarts at `00001_baseline.sql`. The snapshot format version stays 1; a `formatVersion` 1→1 identity transform with the residual splits is the importer's translation. |
| 10 | Legacy quantity tables | **All dropped** after translation: `honey_movements`, `stock_movements`, `product_adjustments`, `equipment_stock`, `equipment_stock_adjustments`, `equipment_deployments`, `equipment_deployment_returns`, `equipment_state_changes`. | They are inventory surfaces and are represented as operations. Their UUIDs survive as `inventory_operations.legacy_ref` for provenance and GnuCash re-key. |

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
  -- site, storage_area, apiary, consignee, in_transit
inventory_operation_kinds  (kind text PK, description text, sided text)
  -- sided: 'one' | 'paired' | 'transform' (see §4)
inventory_conditions       (condition text PK, description text, sellable boolean)
  -- serviceable, damaged, retired, plus the generated frame conditions (§7.3)
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
  consignment_terms jsonb,               -- carried over from stock_locations
  is_active boolean NOT NULL DEFAULT true
)
```

Seeded: `home` (site, `is_home`), one `apiary` location per `apiaries` row
(parent `home` is not implied — apiaries are peers of `home`), one
`consignee` per current consignment `stock_locations` row. Stand positions
("A4") are **not** locations; they remain `hive_location_history` facts on the
hive.

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
  reverses_operation_id uuid REFERENCES inventory_operations,
  reversed_by_operation_id uuid REFERENCES inventory_operations,
  legacy_ref_type text, legacy_ref_id uuid,             -- dropped-table provenance (decision 10)
  details jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES app_users,
  provenance text NOT NULL DEFAULT 'recorded'           -- 'recorded' | 'legacy-import' | 'legacy-unattributed'
)

inventory_movements (
  id uuid PK,
  operation_id uuid NOT NULL REFERENCES inventory_operations,
  line_no smallint NOT NULL,
  item_id uuid NOT NULL REFERENCES inventory_items,
  location_id uuid NOT NULL REFERENCES inventory_locations,
  lot_id uuid REFERENCES inventory_lots,
  condition text REFERENCES inventory_conditions,
  container_type text, container_id uuid,               -- 'hive' → hives.id (decision 1)
  quantity numeric(14,4) NOT NULL CHECK (quantity <> 0),
  UNIQUE (operation_id, line_no)
)
```

`inventory_movements` rows are never updated or deleted. Corrections are a
new operation with `reverses_operation_id` set; the original gets
`reversed_by_operation_id` (the only column on an operation that changes
after insert).

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

CREATE VIEW inventory_reservations AS   -- decision 2
  SELECT item_id, location_id, lot_id, SUM(quantity) AS reserved
  FROM sale_line_reservations ... WHERE sale not applied and not cancelled;

CREATE VIEW inventory_available AS      -- on_hand - reserved
```

Materialize `inventory_balances` only when measured query cost demands it,
and only as a refresh-on-commit projection with a reconciliation test against
the raw sum.

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
`details.reason`, not their own kinds. New stock behavior = a new
`inventory_operation_kinds` row plus a producer; never a new table.

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
service locks the tuple's advisory lock in a deterministic order (sorted
tuple hash), reads the projected balance inside the transaction, and refuses
any line that would take a **lot-tracked** item below `−0.0001` or a count
item below 0. Non-lot-tracked mass (none today) follows the same rule.
Consignee locations are included: consigned jars cannot be over-sold at home
because they are not at home.

### 5.3 Reversal — inventory service

A reversal negates every line of exactly one operation, references it, and
is refused if the original is already reversed. Aggregate-aware undo (a
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
| Sale created / edited while draft or pending | **none** (decision 2); reservation projection only |
| Sale applied (`physical_applied_at`) | `sale_consume` per line at the sale's `stock_location` (home or consignee); jar lines with a `bottling_run_id` consume from that run's lot, otherwise from the location's FIFO lot for the jar size (recorded in `details.lot_allocation`) |
| Sale cancelled after apply | `reversal` |
| Consignment transfer / return | `transfer` home ↔ consignee, lot-preserving |
| Settlement shrink | `shrink` at the consignee |
| Colony / equipment sale lines | equipment: `sale_consume` from storage; colony: no inventory line (a hive is not stock) |

### 6.4 Equipment and packaging

| Command | Operation |
|---|---|
| Purchase / intake | `receive` +count at storage, condition `serviceable` |
| Deploy to hive | `deploy`: −count at storage (container null) → +count at the hive's apiary location, `container = hive` |
| Return from hive | `return` (the mirror) |
| Hive relocation (`hive_location_history` insert with a new apiary) | `transfer` of every `(item, lot, condition)` with `container = hive` from old apiary to new apiary — one operation, source = the hive-move command |
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
7. `equipment_deployments` / `_returns` → `deploy` / `return`, location =
   the hive's apiary **as of the deployment date** (from
   `hive_location_history`), `container = hive`.
8. `stock_movements` → `transfer` / `shrink` at consignees; consignment
   sales already applied → `sale_consume` at the consignee.
9. `sales` with `physical_applied_at` (or, for jar/product lines, any
   non-cancelled non-draft status, matching today's formula) →
   `sale_consume`; draft sales → nothing.
10. Residual splits (§7.4).

### 7.2 Verification

After translation, `inventory_balances` is compared with the snapshot's
**legacy** aggregate family through the declared `legacy-residual-split-v1`
transform: every `finished_jar_inventory`, `catalog_product_inventory`,
`raw_propolis_inventory`, `away_finished_goods`, `equipment_stock_status`,
`lot_bulk_honey`, and `global_bulk_honey` value must equal the corresponding
projection exactly (counts) or within 0.0001 (mass). Any other difference is
investigated, not concealed, and the gate fails.

### 7.3 Condition coercion (decision 5)

The translation collects the distinct values of `equipment_stock.frame_condition`
and the states in `equipment_state_changes`, emits one `inventory_conditions`
row per distinct value (normalized to lower snake case), and records the
mapping in the restore report. Post-reset, adding a condition is a row.

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
`equipment_stock_reconciliation`.

**Retained** (they gain `inventory_*` foreign keys where noted):
`harvest_lots (+inventory_lot_id)`, `bottling_runs (+operation_id)`,
`jar_serials` (unchanged — decision 3), `product_batches (+operation_id, +inventory_lot_id)`,
`propolis_harvests (+operation_id)`, `sales (+applied_operation_id)`,
`consignment_settlements (+shrink_operation_id)`, `jar_sizes (+item_id)`,
`product_catalog (+item_id)`, `equipment_types (+item_id)`, and every bee,
field, place, media, work, and sync table verbatim.

**GnuCash re-key (roadmap B2, deferred to here by design).** The
`external_sync.entity_type` allowlist drops the nine dissolved types and
gains `inventory_operation`; `entity_id` for a dissolved row is re-keyed
through `inventory_operations.legacy_ref_*` by the translation, and
`content_hash` is rebaselined from the new body composition before the
pull-first reconciliation (`docs/restore-runbook.md` §5). Production
currently has **zero** `external_sync` rows, so for the first reset this is
an allowlist change with nothing to re-key — but the transform is written
and tested regardless, because the next reset will not be so lucky.

---

## 9. Squash and reset plan (decision 9)

1. Write `backend/internal/db/migrations/00001_baseline.sql` as the full
   target schema (domain tables verbatim from the current chain, minus the
   dropped set, plus §3). Move the old chain to
   `backend/internal/db/migrations/legacy-00001-00049/` for reference
   (not applied by goose). Update `db.Connect` expectations and every test
   that names a migration number.
2. Extend the importer with the translation stage (§7) behind the existing
   `formatVersion 1` decoder — the artifact format does not change.
3. Extend the exporter so a **new-schema** database exports the same domain
   files plus `inventory_*` domains, and fills the `newLedger` aggregate
   family; the `legacy` family is computed only when the source has the old
   tables.
4. Extend `roundtrip-gate` with a `-translate` mode: export legacy source →
   restore-with-translation into a disposable new-schema database → verify
   §7.2 → re-export → compare new-ledger family and every retained domain
   digest.
5. Rehearse against a fresh copy of production until step 4 passes with zero
   unexplained differences.
6. Take the final pre-reset snapshot, re-run the gate, reset the working
   database to the baseline, restore through the importer with GnuCash
   disabled, verify, then reconfigure per the runbook.
7. Physical count and consignment reconciliation as `count_adjust`
   operations; export the post-adjustment snapshot; retire the
   `legacy-unassigned` lots; run the GnuCash reconciliation sweep against
   folio's verify endpoint; `markReconciled`; enable sync.

Steps 1–4 are code; 5–7 are operator runbook steps and extend
`docs/restore-runbook.md`.

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

// Queries (read models): Balances(filter), Available(filter), History(tuple), LotLedger(lotID).
```

`Operation` is a value: kind, occurred_at, idempotency key, source ref,
lines. Producers live in `app/production`, `app/sales`, `app/equipment`,
`app/field`, each owning its outer command and its beekeeping rules
(decision 7). HTTP handlers become transport only, as the roadmap's workflow
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

## 12. Roadmap corrections implied by this spec

- The roadmap's generalized-core bullet listing `inventory_units` +
  `inventory_movement_units` is withdrawn (decision 3); Zebra item 3
  (serialized jar traceability) works from `jar_serials` + lot + the
  bottling run's operation, and Zebra item 7 (equipment/bin labels) waits on
  an optional future units table rather than a core one.
- "Do hives become locations?" is answered **no**; the container dimension
  replaces it.
- Item 11 (Zebra) is gated on the ledger and workflow resets, not on serial
  identity in the ledger.
