# Polyagent Review — Roadmap architecture-reset additions (2026-09-01)

- **Run:** `20260901-roadmap-review-bz01`, mode `review`, pinned to `241f7ea`
  ("docs: roadmap pre-launch architecture reset", diff `272db64..241f7ea` =
  +390 lines in `docs/product-roadmap.md`).
- **Workers:** Claude Opus (schema/inventory-ledger lens), Codex gpt-5.6-sol
  (backend app-layer/importer/GnuCash lens), Grok 4.6 (UI flow/routes lens).
  All three completed with `REVIEW_FINDINGS`; all three worktrees verified
  clean (no source edits). Durable reports under
  `%USERPROFILE%\.polyagent\projects\beez-trackz-fd2f75e7\runs\20260901-roadmap-review-bz01\workers\*\report.md`.
- **Lead verification:** the lead independently confirmed the eleven-destination
  nav claim (`frontend/src/components/shell/nav-items.ts`), the
  multi-ledger schema claim (migrations 00001/00006/00020/00024/00030/00047/00048),
  the `external_sync` entity-type allowlist (00041), the `content_hash`
  divergence semantics (00045), the cursor-clearing settings PUT
  (`routes_gnucash_sync.go:191-219`), and the unenforced `SyncEnabled`
  (`routes_gnucash_sync.go:488-535`).

## Verdict

**Consensus across all three vendors: the diagnosis is correct and the
ordering (P0 snapshot gate → inventory ledger → workflow reset → Zebra) is
directionally sound — but the plan is not executable as written.** Every
factual premise the roadmap states about the codebase checked out (eleven
module-first destinations, three competing work inboxes, Settings as a mixed
catch-all, large cross-domain HTTP handlers, multiple competing quantity
authorities, pre-launch status making a clean reset legitimate). The blockers
are in the plan's own acceptance criteria: three of them cannot pass against
the code at `241f7ea`.

## Blockers (fix the roadmap before executing)

### B1. P0 ↔ workflow-reset circular dependency (Claude §4/§6, Codex §1)

P0 requires importing "through domain-aware APIs or services, not direct table
replay" while preserving UUIDs, `created_at`/`created_by`, soft-delete /
void / reversal history, and passing record-level digest equality. No handler
accepts a client-supplied ID or audit timestamp (every create is
`gen_random_uuid()` + `RETURNING id`), `backend/internal/app/` does not exist,
and the only importer (`cmd/migrate-legacy`) is self-described "idempotent-ish"
table copying. The application layer P0 depends on is sequenced *after* P0
under item 10. **Fix:** pull a minimal application/restore foundation into P0
— unit-of-work, transaction-bound repositories, a privileged system-restore
actor, and restore-only repositories that accept preserved IDs/timestamps —
and say so explicitly in the roadmap.

### B2. The GnuCash replay boundary cannot pass its own gate (Claude C1–C3, Codex §2–§4)

Five independent problems, each verified:

1. **Mapping identity dissolves.** Nine of the seventeen
   `external_sync.entity_type` values (00041) — `jar_size`, `honey_movement`,
   `bottling_run`, `stock_location`, `stock_movement`, `equipment_stock`,
   `equipment_stock_adjustment`, `product_batch`, `product_adjustment` — are
   rows the seven-table core dissolves. Restoring those mappings is a re-key
   migration, not a restore, and the gate as written cannot verify it.
2. **`content_hash` flips everything to `diverged`.** 00045: the hash is of
   the last-sent transaction body; the ledger rewrite changes how bodies are
   composed, so the first post-restore rescan marks every row diverged. A
   content-hash rebaseline step is required and absent.
3. **No no-write dry run exists on either side.** The folio client has only
   GET status/accounts/changes plus write-capable transaction ops; there is no
   read-by-external-ID, no batch verify, no dry-run flag anywhere in
   `gnucashsync` or `routes_gnucash_sync.go`. Proving "restored mappings
   resolve to existing remote records" needs a **folio (gnucash-web) API
   addition** — a cross-repo dependency the roadmap does not name.
4. **Re-entering the excluded token destroys the restored cursor.**
   `handleGnuCashSettingsPut` treats any token change as a book-identity
   change and clears `BookGUID`/`ChangesCursor`
   (`routes_gnucash_sync.go:216-219`, pinned by test). The documented restore
   flow (restore → configure credentials → reconcile) self-destructs. A
   guarded restore command that installs cursor/state after an
   identity-match check is required.
5. **"Restore with sync disabled" is not enforced.** `handleGnuCashSyncNow`
   never checks `SyncEnabled` and pushes regardless; the frontend gates the
   button on request-pending only. Also: "deletion tombstones" and "stored
   idempotency keys" do not exist as durable Beez records (tombstones are
   transient feed entries collapsed into `conflict_state`; keys are derived
   `externalID+contentHash` at send time), and singleton `last_synced_at` is
   last-*attempt*, set even when pull fails.

### B3. The cutover invariant "new sums reconcile to the old reported balances" is unachievable as stated (Claude §1/§5-C4, Codex §8)

Two of the current authorities — unassigned bulk honey (defined only in
00047's header comment as a residual) and home stock (00024's "global minus
elsewhere") — have no rows. Converting them to a movement ledger means
*inventing* opening-balance operations; the phase-3 comparison will then show
differences that are correct, and the roadmap gives no acceptance rule for
them. Relatedly, P1 says freeze the export around "domain facts rather than
the old balance formulas" while P0 requires `verification.json` to carry
pre-reset balances "with the exact calculation definitions" — which only the
15 legacy formulas can produce. **Fix:** declare the legacy aggregates as
versioned *legacy definitions* distinct from domain-fact records, and state
the acceptance rule for residual-to-opening-balance splits.

## Major gaps (agree with the plan, but it understates the work)

### Inventory ledger (Claude lens)

- **The real authority count is ~15 across 5 storage patterns, not the six
  the roadmap lists.** Missing from "Responsibility migration": propolis
  grams (a whole parallel unit), the harvest/true-up supply side, packaging
  consumption (00048, three days old), equipment BOM assemble/disassemble
  (00046), varietal rollup (00047), and `give_away`/`jar_adjustment` kinds.
- **Undecided design questions that change the schema:** do hives become
  `inventory_locations` (three location vocabularies exist today:
  `stock_locations`, free-text `equipment_stock.storage_location`, and
  deployments-to-hives)? Does a draft sale create an operation (jar/product
  lines decrement at draft; colony/equipment at `physical_applied_at`)?
  Fractional lbs/grams vs integer counts in one `quantity` column (the
  `honeyPoundTolerance` rule must survive)? Two equipment condition
  vocabularies (`frame_condition` on a UNIQUE-per-type stock row vs
  `equipment_state_changes`)?
- **`jar_serials` have no location and no movement link** — a consigned
  serialized jar is not locatable, and the seven-table core has no per-unit
  identity table. This undermines Zebra item 11's premise even though it is
  sequenced after the reset. Add per-unit identity to the core or explicitly
  scope serials as lot-level attachments.
- **Derived lot weight (00039) conflicts with immutable movements:** re-linking
  a harvest recomputes `honey_weight_lbs`; under the new model that must emit
  compensating movements and re-verify downstream draws. Unmentioned.
- **BOMs are not new:** `equipment_type_components` (with cycle guard),
  `variant_of_type_id`, and `jar_sizes.packaging_type_id` are three existing
  BOM-ish mechanisms the migration list ignores.
- **Lockout/moisture guards must move with the chokepoint:** lot lockout is a
  recomputed walk (`lockout.go:277-346`), not an attribute; routing all
  stock-changing commands through one inventory service relocates where the
  bottling/sale refusals live.
- **Keep-list omissions:** `feedings` (the workflow section's own WorkItem
  example!), `inspections` + jsonb, `mite_counts`, queens lifecycle
  (`queen_events`, `hive_splits`), field objects (00025), place/flow
  (00027–28), media/transcripts, `honey_varietals`, `expenses`. Also
  "payments and commissions" names a `payments` table that does not exist —
  00024 explicitly declined one.

### Portable snapshot (Claude + Codex lenses)

- **jsonb canonicalization** is the specific digest hazard (key order,
  numeric normalization) across ~14 jsonb columns;
  `user_settings.ai_provider_config` mixes config with credentials so secret
  exclusion must be per-key, not per-column.
- **Media:** distinguish originals (restoration boundary) from regenerable
  thumbnail/medium renditions, or the hash gate fails on any re-render.
- **No-FK pointers** (`current_transcript_version_id`, both
  `reverses_movement_id` columns) need explicit post-pass/intra-file ordering.
- **Import-time triggers** (`equipment_stock_reconcile_guard`,
  `honey_movement_lot_matches_run`, settlement checks) make dependency
  ordering finer than one topological sort.
- **Idempotency is currently three inconsistent contracts** (equipment:
  replay-without-payload-comparison; product/stock: 409; transfers:
  line-order-dependent subkeys) plus a non-atomic offline receipt middleware —
  the importer's identical-no-op semantics are a fourth and must be specified,
  not assumed.

### Workflow/application reset (Grok + Codex lenses)

- **Freeze `/hives/{id}` and public `/honey/{slug}` as eternal URLs**, or the
  "no compatibility redirects" rule bricks every printed hive QR label and
  the Honey Story contract. This must be an explicit invariant.
- **The rewrite is smaller than the prose in places and larger in others:**
  `/harvest/*` has zero in-app link consumers (delete is cheap);
  `/honey/market-day` has seven concrete consumers including the SW SHELL
  precache and three e2e specs that will fail CI if deleted without
  coordination; there is no breadcrumb component and ntfy has no deep-link
  URL — "rewrite breadcrumbs/notifications" describes surfaces that do not
  exist; `install-prompt.tsx` CALM_ROUTES is already stale (`/genealogy`).
- **Dashboard / Yard Queue / Recommendations really are three separate
  assemblers** (client-side `useFieldWork`, server-side `yardQueue`, the recs
  inbox) with duplicated `feeder_check` exclusion and different command
  surfaces. Unifying them is a new backend projection plus deleting all
  three, not a filter flag. Yard Queue items have no stable IDs and its
  `asOf` is never rendered.
- **The WorkItem contract is not consumable by the current frontend:** no
  freshness UI (`X-Beez-Cache: stale` is never read by `api.ts`), no
  per-command permissions (access is page-level `adminOnly`/`requiresEdit`),
  and offline disposition is a global API-prefix allowlist in which
  harvest-session *create* is excluded — a field-day "start extraction" work
  item cannot meet the offline acceptance criterion without changing
  `offline_routes.go`.
- **IA mapping details:** "Honey, Sales, and Inventory leak overlapping
  stock" misnames the third leak — `/inventory` is equipment; finished goods
  leak between Honey and Sales, and packaging straddles Settings jar sizes
  and equipment types. Preferences are admin-gated today, so "My Preferences"
  is not a rename. Fifteen flows straddle two proposed areas (harvest-ready,
  lockout, record-sale, labor, compliance, GnuCash reconciliation, etc.) and
  each needs an owner decision, not a menu label. Mobile: the proposed
  five-entry bar must keep `adminOnly` filtering and should not demote
  Apiaries/Hives — where Saturday work starts — off the phone bar.
- **Transaction ownership needs a design before extraction** (Codex §5):
  "every stock-changing command routes through one inventory service" and
  "application commands own transactions" collide — a `sales.RecordSale`
  command must own the outer transaction with inventory as a participant in
  the same `pgx.Tx`. Define unit-of-work, typed errors, authorization inputs,
  and outbox/domain-event semantics first or `internal/app` becomes the same
  long methods with a new package name.
- **Naming collision:** the nav item "Equipment" lives at `/inventory`, the
  target IA has no Inventory area, and the ledger adds seven `inventory_*`
  tables plus `internal/app/inventory`. Pick a resolution in the roadmap.

## Amended ordering (consensus of all three reports)

1. **P0a** — export contract + full domain enumeration (write the export
   against the live schema; no DB changes).
2. **P0b** — minimal application/restore foundation *inside P0*: unit-of-work,
   restore repositories accepting preserved IDs/timestamps, system actor.
3. **Folio work in parallel** — read/verify-by-external-ID or a server-side
   no-write plan endpoint; Beez guarded credential/book/cursor restore
   command; server-enforced `SyncEnabled`/reconciliation-pending gates;
   durable sync-run + tombstone records if they stay acceptance-critical;
   entity re-key + content-hash rebaseline step in the plan.
4. **Round-trip gate** with legacy-vs-new aggregate definitions split and an
   acceptance rule for residual opening balances. No reset before it passes.
5. **Inventory ledger** on the clean baseline, with the design questions above
   (hives-as-locations, draft sales, units, condition, serials, derived lot
   weight, lockout chokepoint) answered in the spec first.
6. **WorkItem in two slices** — field Today/Yard after the shared
   policy/command seam (can start early); Production/Sales workbenches only
   after ledger-backed commands. Then the route rewrite, with `/hives/{id}`
   and `/honey/{slug}` frozen, and SW SHELL + the three pinned e2e specs
   updated in the same change.
7. **Zebra last** — unchanged, but only after serials gain
   location/movement identity.

## Do-not-relitigate confirmations

- Eleven top-level destinations: exact (`nav-items.ts`).
- "Large HTTP handlers orchestrate cross-domain transactions": 440 `*Server`
  methods, 58 production `pool.Begin` call sites in `internal/httpapi`;
  `routes_commerce.go` 95 KB, `routes_honey.go`/`routes_stock_locations.go`
  76 KB each.
- Pre-launch stance is legitimate: no production install dependency found;
  the `/harvest` shims and `/genealogy` redirect are already dead weight.
- Secrets exclusion list in P0 is complete for this schema (password hash,
  ntfy token, `api_tokens`, OIDC, GnuCash token, AI provider credential keys).
