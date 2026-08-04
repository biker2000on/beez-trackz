# Integration notes — GnuCash-web-ready inventory & honey (backend P1)

Backend-only change set. **No frontend file was touched.** The API was kept
source-compatible on purpose: every route, method, and success-response shape
the frontend already calls still works. What changed is what those calls *mean*
underneath, plus some additive response fields.

This is the list of things the integrator must do in `frontend/**`.

---

## 1. Money stays in dollars on the wire — no frontend change needed

Every monetary column moved from `double precision` dollars to `BIGINT` cents
(migration `00004_money_integer_cents.sql`), and Go handles money as integer
cents throughout. **The JSON contract did not change**: amounts are still
serialized as dollars with exactly two decimals (`12.34`), and request bodies
are still read as dollars.

- **Action: none required.** Existing `unitPrice: 12.5`, `amount: 249.99`,
  `discountAmount`, `amountPaid`, `minimumOrderAmount` payloads keep working.
- Worth knowing: amounts are now rounded **half away from zero at two
  decimals** on the way in. Sending `12.345` stores `$12.35`, not `$12.34`. If
  any input lets a user type more than two decimals, consider rounding in the UI
  so the displayed value matches what is stored.
- `POST/PATCH /honey/sales` accept an optional `tax` field (dollars). It is
  stored in the new nullable `honey_sales.tax_cents` for future accounting
  mapping. Nothing consumes it yet; `null` means "no tax recorded", which is
  deliberately different from a tax of zero.

## 2. Delete buttons no longer delete — relabel them

Three "delete" endpoints kept their URL, method, and `{"success": true}`
response but changed semantics. **The labels in the UI are now wrong.**

| Endpoint | Was | Now | UI action |
|---|---|---|---|
| `DELETE /honey/sales/{id}` | destroyed the sale and its items | sets `order_status='cancelled'`, records actor/time/reason; jars return to inventory | Relabel "Delete sale" → **"Cancel sale"**. Confirm copy should say the record is kept. |
| `DELETE /honey/movements/{id}` | destroyed the ledger row | writes a **reversing entry** (negated quantity/pounds) linked to the original | Relabel "Delete" → **"Reverse"** / "Undo". Both rows now appear in the timeline. |
| `DELETE /harvest-entries/{id}` | destroyed the entry | soft-delete with actor/time/reason; excluded from all listings and totals | Relabel "Delete" → **"Remove"** is fine; behaviour looks the same to the user. |
| `DELETE /expenses/{id}` | destroyed the expense | soft-delete with actor/time/reason; excluded from all listings and totals | Same as above. |

All four accept an **optional** JSON body `{"reason": "..."}` on the DELETE.
Adding a reason prompt is recommended but not required — the calls work with no
body.

New/extra response fields on these:
- `DELETE /honey/movements/{id}` → `reversed: true`, `reversalMovementId`,
  `reversedMovementId`. Reversing an already-reversed movement returns **409**;
  surface that as "this entry has already been reversed".
- `DELETE /honey/sales/{id}` → `cancelled: true`, `orderStatus: "cancelled"`,
  `id`, `amountPaid`, `balanceDue`. Cancelling an already-cancelled sale is
  idempotent (200, not an error).
- `DELETE /expenses/{id}` and `DELETE /harvest-entries/{id}` → `softDeleted: true`.

## 3. `PATCH /honey/sales/{id}` now accepts `orderStatus: "cancelled"`

Previously rejected with 400, which is why deleting was the only way to void a
sale. Cancelling through PATCH behaves exactly like the DELETE path (actor,
timestamp, `cancellationReason`, stock released).

- Add `cancelled` to whatever status selector the sale editor renders.
- Optional request fields: `cancellationReason`, `tax`.
- A cancelled sale can no longer be moved back to another status; it is
  terminal. The UI should not offer a status change on a cancelled sale.

## 4. `/honey/overview` — new revenue fields

`totalRevenue` is **unchanged in meaning and value** (invoiced: every
non-cancelled order, paid or not), so nothing breaks. Three fields were added:

| Field | Meaning |
|---|---|
| `invoicedRevenue` | Same number as `totalRevenue`. Use this name going forward. |
| `collectedRevenue` | Money actually received (`SUM(amount_paid)`). |
| `unpaidRevenue` | `invoicedRevenue - collectedRevenue`. |

**Action:** the honey overview stat strip currently labels `totalRevenue` as
"Revenue", which disagrees with market-day reconciliation's paid/due split.
Label the two explicitly — e.g. "Collected $X · Invoiced $Y" — and prefer
`collectedRevenue` where the user is asking "how much money did I take?".
`/analytics/profitability` gained the same three fields alongside its existing
`revenue`.

## 5. `/honey/inventory` rows gained `isActive`

Deactivated jar sizes that still hold stock are now **included** in inventory,
low-stock, production-plan, and valuation results, with `isActive: false`.
Previously they silently vanished (an untracked write-off).

**Action:** if the inventory table renders every row identically, add a muted
"inactive" badge so a discontinued size holding 12 jars is visibly discontinued.
Active sizes with zero stock behave exactly as before.

## 6. Deactivating a jar size can now fail with 409

`PUT /jar-sizes/{id}` with `isActive: false` returns **409 Conflict** when jars
are still on hand, with a message naming the count.

To proceed anyway, resend with `writeOffRemaining: true` (and optionally
`writeOffReason: "..."`), which records a visible `jar_adjustment` ledger entry
zeroing the stock and returns `jarsWrittenOff: <n>`.

**Action:** the settings/jar-sizes toggle needs a confirm dialog on the 409:
"N jars are still on hand. Write them off?" → resend with
`writeOffRemaining: true`. Without this the toggle will appear broken.

## 7. Bottling runs now require a jar size

`POST /harvest-lots/{id}/bottling-runs` returns **400** when `jarSizeId` is
missing. A run without one used to create no inventory movement at all, so the
jars showed on the lot page and nowhere in inventory.

Two more 400s are possible:
- the run would bottle more pounds than the lot yielded, and
- the run would bottle more pounds than the bulk honey on hand.

**Action:** make `jarSizeId` a required field in the bottling-run form and
surface the error message verbatim (it names the lot, the lot weight, the
pounds already bottled, and the pounds requested).

## 8. Negative stock is now rejected

These endpoints validate availability and return **400** with a human-readable
message instead of silently going negative:

- `POST /honey/jarring` — against bulk honey on hand (including its loss line).
- `POST /honey/give-away` — against jars on hand.
- `POST /honey/bulk-movements` (`bulk_use` and `loss`) — against bulk on hand.
- `POST /harvest-lots/{id}/bottling-runs` — see above.
- `POST /honey/sales` — unchanged; it always validated.

`POST /honey/jar-adjustments` is **deliberately still unbounded** — correcting a
miscount downward is what it is for.

**Action:** any UI that styles a negative on-hand value in red as an expected
state can stop doing so for these flows. Show the returned error message; it is
written for the user ("Not enough Half Pint: need 6, have 5", "Not enough bulk
honey: need 500.00 lbs, have 3.00 lbs").

## 9. `/honey/timeline` entries gained three flags

- `isReversal: bool` and `reversesMovementId: uuid|null` on movement entries.
  Reversal descriptions are prefixed `"Reversed: "`.
- `cancelled: bool` on sale entries, description prefixed `"Cancelled: "`.

**Action:** style reversed/cancelled entries as struck-through or muted so the
pair reads as a correction rather than two unrelated events.

## 10. Harvest-session true-up keeps its history

`POST /harvest-sessions/{id}/true-up`:
- accepts an optional `reason`,
- **rejects negative weights** with 400,
- returns `previousWeightLbs` alongside `success`.

`GET /harvest-sessions/{id}` gained `trueUpHistory: [{ id, previousWeightLbs,
newWeightLbs, reason, recordedAt, recordedBy }]`, newest first.

**Action:** optional but valuable — show the correction history on the session
detail page so an edited extraction weight is auditable.

## 11. Sale objects gained fields

`GET /honey/sales`, `GET /honey/timeline`, and `GET /honey/sales/{id}/receipt`
now include on each sale: `tax` (dollars or null), `updatedAt`, `cancelledAt`.
Additive only — existing fields are unchanged.

## 12. Offline mutation queue now covers honey and commerce

The idempotency middleware previously excluded every honey/commerce route, so a
replayed offline queue could book the same sale twice. These paths are now
covered and honour `X-Offline-Mutation-ID` / `X-Offline-Queued-At`:

`/honey/sales` (POST/PATCH/DELETE), `/honey/jarring`, `/honey/bulk-movements`,
`/honey/give-away`, `/honey/jar-adjustments`, `/honey/movements/{id}`,
`/harvests`, `/expenses`, `/customers`, `/jar-sizes`, `/harvest-lots`
(incl. bottling runs), `/wholesale-price-lists`.

**Action:** whatever the PWA queue uses to attach `X-Offline-Mutation-ID` should
now include these routes — especially the market-day checkout, which is the most
offline-prone surface in the product. Replays return the original response with
`X-Offline-Replayed: true`. Stale offline edits to `/honey/sales/{id}`,
`/expenses/{id}`, `/customers/{id}`, `/harvest-lots/{id}`, and `/jar-sizes/{id}`
can now return **409** with `X-Offline-Conflict: newer-server-version`; the
existing conflict handling for hives/inspections applies unchanged.

---

## Not changed (deliberately)

- **Equipment** — owned by a separate work stream. `routes_equipment.go` and the
  `equipment_*` tables still use float money and still lack the stock validation
  described above.
- **Cancelling a sale writes no reversing movement.** Every inventory and
  revenue aggregate already filters `order_status <> 'cancelled'`, so the jars
  return to stock the moment the sale is cancelled. Emitting reversing movements
  as well would double-count them back into inventory.
- **`external_sync`** (migration 00005) is a table plus indexes only. No sync
  logic, no endpoint, nothing for the frontend to call yet.
