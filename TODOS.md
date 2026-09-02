# TODOS

Deferred work with enough context to pick up cold. Added by `/plan-eng-review`
of `docs/plans/2026-09-01-inventory-ledger-design.md` on 2026-09-02.

## Per-unit inventory identity (asset-tagged equipment, labeled bins)

- **What:** an additive `inventory_units` table (unit id, item, lot, serial)
  joined to movements by `(operation_id, line_no)`, so individual pieces of
  equipment can be tracked through deploy/return/damage by tag.
- **Why:** Zebra items 3 and 7 (equipment and bin labels) want a stable
  per-unit identity. Ledger decision 3 deliberately kept jars fungible within
  their lot and withdrew the units table from the core; equipment is the case
  where per-unit tracking may actually pay.
- **Pros:** additive — no change to the movement tuple; label history ties
  to an id rather than a free-form name; damaged-frame history per frame.
- **Cons:** every deploy/return of a tagged item must name units; UI for
  scanning tags; more rows per operation.
- **Context:** `inventory_movements` is quantity-based; serials for jars live
  on `jar_serials` as labels only. Start by reading ledger spec §3.5 and
  decision 3, and the Zebra section of `docs/product-roadmap.md`.
- **Depends on / blocked by:** the ledger landing (Phase A); a real need for
  per-unit equipment history (none today).

## Market-day lot picker for jar lines

- **What:** when a jar sale line at a location could draw from more than one
  lot of that jar size, let the POS pick the lot instead of FIFO-inferring.
- **Why:** review finding A3 kept FIFO-inferred allocation for untraced jar
  lines (marked `lot_allocation.method = 'fifo-inferred'`) because the
  roadmap keeps untraced lines legal for offline/POS. A picker turns inferred
  provenance into recorded provenance where the operator can see the lots.
- **Pros:** exact lockout at sale time; Honey Story provenance recorded, not
  guessed; the inferred-allocation report shrinks toward zero.
- **Cons:** one more tap on market day; offline flow needs the lot list
  cached; not worth it while `legacy-unassigned` dominates.
- **Context:** `sale_items.inventory_lot_id` exists after Phase A; the
  inferred-allocation report (spec §6.3) shows how often the guess happens —
  build this when that report says it matters.
- **Depends on / blocked by:** Phase A; the physical count that retires the
  `legacy-unassigned` lots.
