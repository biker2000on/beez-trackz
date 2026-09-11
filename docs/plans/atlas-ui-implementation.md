# Atlas UI implementation

Implemented on `codex/atlas-ui-rewrite`, based on main `6d65d44` and the September 11 UI review. The branch was rechecked against origin/main after implementation. The initial release was deployed to the TrueNAS test stack as `atlas-ui-20260911-163643`.

## User workflows

- Today, Apiaries, Production, Sales and Stock are directly reachable on desktop and mobile. Pages exposes named secondary destinations. Apiary and hive history, lots, bottling runs, product batches and stock items have full URLs.
- Apiary observations, multi-hive recordings and individual hive inspections share a visit workspace. Voice is primary, with manual entry using the same atomic observation/equipment commands. The actual apiary layout canvas remains available, including read-only navigation and keyboard access.
- Stop prepares review automatically. Each hive can be corrected and confirmed independently; Confirm & next retains apiary context and updates the hive URL. Unknown queen observations remain unknown. Equipment actions require explicit selection and acceptance.
- Completed audio is committed locally before upload. Active audio has periodic recovery checkpoints. Drafts, upload identities, pending requests and receipts survive reload, are partitioned by account, and cannot be restored under a different apiary. Interrupted recordings require review before upload. Queued confirmations are distinguished from server receipts.
- Upload retries preserve the original envelope. Server receipts reconcile saved items after response loss or another tab's confirmation. Original audio, replacement lineage, transcript versions and observation times remain preserved.
- Stock presents exact item/unit/location/lot/condition/hive quantities, on hand versus reserved versus available, unknown counts, holds and source history. Harvest-lot and inventory-lot identities remain distinct.
- Payment and fulfillment are separate commands. Reservations protect deployable equipment. Extraction closure is explicit and prevents further entries.

Inventory operations and movements remain the quantity authority. The additive schema contains domain apiary observations, capture provenance/receipts and extraction closure; it introduces no competing inventory balance store. Baseline migrations are mirrored into the retained legacy profile.

## Verification

- Production frontend build and TypeScript checks passed.
- Frontend lint passed without errors; existing React Compiler compatibility warnings remain.
- 25 focused browser tests passed across visits/recovery, navigation, design promises and lot workflows. Viewports include 320, 375, 390 and 768 pixels. New coverage includes audio stop/upload identity and durability, nullable queen observations, reload, queued receipts, partial confirmations, wrong-apiary restore rejection, response-loss retries and server-receipt reconciliation.
- Firefox and mobile WebKit smoke checks passed for manual inspection, persisted draft reload, horizontal fit, confirmation and the next-hive URL. No application console errors were reported.
- `go test ./...` passed. Real disposable PostgreSQL suites passed for HTTP API, inventory, sales and production, with additional baseline/legacy regressions for concurrent confirmations, replacement races, scope rejection, equipment rollback, tuple stock/history, reservations, payment/fulfillment and explicit session closure.
- Browser microphone tests use a simulated MediaRecorder and mocked API responses; physical device microphone behavior and a live transcription provider were not exercised.

API details: [visit capture and confirmation](atlas-voice-api-contract.md) and [stock, production and sales](atlas-stock-api-contract.md).

## Adversarial review fixes

- Manual visit retries delegate canonical receipt validation to the transaction runner, recovering receipts from the initial release while rejecting changed payloads and mismatched mutation IDs.
- Recording replacements preserve the original observation time, timezone, account, and inspection scope.
- Sales quick actions report backend failures and distinguish offline queue acknowledgments from successful saves.
- Verification: PostgreSQL voice/manual/offline tests passed with middleware replay coverage; three browser regressions passed for replacement context, stock-short fulfillment feedback, and queued payment feedback. Both production images built; lint reported no errors and 16 existing compatibility warnings.
