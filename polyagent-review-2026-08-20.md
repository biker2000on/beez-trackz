# Polyagent review — 2026-08-20 roadmap waves (migrations 00024–00029)

Cross-model, three-lens read-only review of `8d14354..0c6f38d` (consignment
inventory, field/health objects, units + ops, place/flow, Immich timeline,
claims), pinned at `0c6f38d`. Reviewers: Claude opus (ledger/money +
migrations), Codex gpt-5.6-sol (auth + operational safety), and a lead-run
contracts lens (frontend↔backend; the Grok worker completed its analysis twice
but never wrote its report artifact, so the lead re-ran that lens locally).
All worker worktrees verified clean — no reviewer modified source.

Durable worker reports:
`~\.polyagent\projects\beez-trackz-fd2f75e7\runs\20260820-review-waves\workers\*\report.md`.

## Fixed before deploy (in commit(s) following this report)

| Sev | Lens | Finding | Fix |
| --- | --- | --- | --- |
| HIGH | ledger | Settlement lines not aggregated per SKU — duplicate lines each validated against the full opening shelf: oversell, over-recognised revenue, corrupted shrink | Duplicate SKU lines in one report now 400 |
| HIGH | ledger | `honey_weight_entered` bare numbers re-parsed under the *reader's* unit preference silently rewrote `honey_weight_lbs` (the bottling ceiling) | Entered text persisted with an explicit suffix; only suffixed text seeds the edit field, else canonical `N lb` |
| HIGH | auth/ops | Immich originals buffered with unbounded `io.ReadAll` before the pixel check — a multi-GB RAW in the library OOM-kills the worker on auto-adopt | 256 MB bound on original/preview reads (`imgReadBounded`) |
| MED-HIGH | ledger | A live settlement's sale could be cancelled from the sales list, stranding the statement, returns, and shrink | Cancel (PATCH and DELETE) now 409s → "void the settlement instead" |
| MED | ledger | `wholesale_list` basis credited full retail on catalog products (price list has no product dimension) — operator owed the shop's whole margin | Product lines at wholesale-basis locations refused |
| MED | ledger | `PATCH /stock-locations/{id}` defaulted omitted fields — `{"name": …}` silently converted a commission location to retail | Partial bodies refused loudly; TS type made strict |
| MED | auth | Catch-box occupancy accepted a hive UUID from a yard the caller has no role in | Hive must belong to the box's own yard |
| LOW | auth | Scale CSV "8 MB" uploads actually capped at 1 MB by the router-wide body limit | `/scales/{id}/readings` added to the upload exemption |
| MED | contracts | Home sales/jarring/give-aways/adjustments never invalidated `["stock-locations"]` — market-day tiles showed pre-sale counts | All honey mutations invalidate it |
| MED | contracts | Colony intake didn't invalidate queens/expenses; deadout autopsy didn't refresh the analytics reports; the labor toggle didn't wake the labor widget | Invalidations added |
| MED | contracts | `parseFeedingQuantity` metric branch was dead code — bare metric input parsed as pounds | Bare metric input now kg → canonical lbs |

## Deferred — tracked follow-ups

**Settlement money model (ledger findings 4 + 5).** `amount_paid_cents` /
`amount_owed_cents` are double-booked between the settlement and its sale, a
later payment can only be recorded on the sale (the statement then renders
stale), and `amountOwed` means different things on the preview vs the created
settlement. The reviewer's recommendation — derive both from the linked sale —
retires all of it in one rework; patching any single symptom now would churn
the same code twice. Do together with the GnuCash mapping work.

**00024 down-migration index rebuild (ledger 9).** Latent until GnuCash sync
writes `external_sync.location_id`; the down would then fail (cleanly, in a
transaction). Fix on the GnuCash roadmap item. The down's unconditional
`DELETE FROM external_sync` also belongs in the runbook.

**ntfy SSRF hardening (auth).** URL validation allows loopback/RFC1918
targets. Deliberately deferred: this is a single-operator self-hosted app
whose real ntfy server lives at a private LAN address, and the endpoints are
admin-only. Revisit if the app ever becomes multi-tenant.

**Immich scan wedge (auth).** A scan whose very first status UPDATE fails on
every attempt stays `queued` and blocks the yard's next scan while the API
reports `alreadyActive`. Needs terminal bookkeeping before the first
transition; small design change on the jobs side.

**Timeline candidate metadata scope (auth).** Yard viewers can see
GPS-less candidate metadata from the whole Immich library, and ambiguous
candidates leak the other yard's UUID in `nearbyApiaryIds`. Acceptable for a
single-household install; restrict the review tray to editors if collaborators
ever get viewer-only access.

**Propolis grams pool on location sales (ledger 8).** The made-to-order
grams guard is home-path only. Narrow (needs raw-propolis SKUs consigned);
fold into the product-adjustment-ledger work.

**Smaller items.** Scale CSV re-upload replaces a day instead of merging
(flatten-the-spike risk); ntfy receipt written before publish can suppress one
reminder on a crash, and `ntfy_dispatches` is never pruned; statement
`Returned` inverts for shop→shop returns; `colony_intakes.cost_cents`
duplicates the expense with no back-link; stock-location delete races a
concurrent transfer (stranded stock, manual fix); `Temp C` CSV headers parse
as °F; market-day catalog product tiles cap by global on-hand, not the
selected shelf; lot selector silently ignored on non-home sales; catch-box
occupancy endpoint has no UI caller (boxes can never be re-emptied from the
UI); catch-box/incident mutations are online-only — decide whether they should
queue offline like inspections do.

## Verified clean (high-signal subset)

- Home-as-residual algebra holds through transfer, location sale, and void;
  revenue is never recognised on a transfer; reversals preserve every
  dimension; idempotency and lock ordering are correct across the new paths.
- Commission splits are exact integer cents and always re-add to the shelf
  price; overpayment guarded at both layers.
- All migrations are transactional with symmetric downs (00024's index rebuild
  excepted, above); backfills are idempotent; generated columns match their Go
  mirrors.
- Every new endpoint is inside the authenticated group with role checks
  consistent with neighbors; compliance packet and ntfy are admin-only; labor
  visibility is self/admin/shared-yard; the public Honey Story leaks no IDs,
  coordinates, or customer data and pins the operator's units.
- Frontend/backend field names match across all new payloads (queens included);
  units parse sites all pass `UnitsSystem` strings; Honey Story formats with a
  fixed locale from the payload; the offline manifest is test-enforced and
  matches the deliberate online-only set.
