# Atlas review fixes: shared contracts (2026-11-25)

Source: the 2026-11-25 inspection review: an impeccable critique (snapshot in
`.impeccable/critique/`) plus an API/MCP gap list from syncing a season of
Obsidian journal entries into Atlas through MCP. Four workstreams run in
parallel, each in its own git worktree, branched from `atlas/base`. This
document is the contract between them. **If you need to change a contract,
stop and report it. Don't improvise a different shape.**

## Ground rules (all workstreams)

- **Edit only the files you own** (see the ownership table). If you need a
  change in a file you don't own, describe it in your final report instead.
- **No deploys, no pushes, no writes to production.** Read-only calls to
  `https://atlas.gentlebeeapiary.com` are allowed where a workstream says so.
- **No schema migrations** unless unavoidable. If one is, it goes in BOTH
  migration chains (see `backend/internal/db`) and must be called out in the
  report.
- **Commits:** small, conventional (`feat(mcp): …`, `fix(visit): …`), on your
  branch only. Each commit message ends with
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- **Backend checks:** `cd backend && go build ./... && go vet ./... && TZ=UTC
  go test ./internal/...`. DB-backed tests skip without `TEST_DATABASE_URL`;
  that's expected for now. Still write DB-backed tests for new behaviour,
  following the existing `*_test.go` patterns. The coordinator runs them
  later. **Never start Docker containers** (in WSL, `docker` points at the
  production NAS).
- **Frontend checks:** from `frontend/`, run
  `node node_modules/typescript/bin/tsc --noEmit` and
  `node node_modules/eslint/bin/eslint.js <changed files>`. Use `node`
  directly, not npx (the shims are WSL symlinks). `frontend/node_modules` in
  each worktree is a junction to the main checkout's. Don't run `npm install`
  or `npm ci`.
- **This is not the Next.js you know.** Read `frontend/AGENTS.md` and the
  relevant guide in `node_modules/next/dist/docs/` before writing Next-specific
  code.
- **Design system:** follow `DESIGN.md` (glossary, RecordHeader/PageHeader
  templates, 44px coarse-pointer targets, offline queue rules, keyboard model).
  On any UI change, follow the craft floor:
  `C:\Users\biker\.claude\skills\impeccable\reference\craft-floor.md`.
- **Hive labels:** use `frontend/src/lib/hive-label.ts` (`isActiveHive`,
  `activeHives`, `hiveDisplayLabel`) wherever a hive is picked, matched or
  listed. New records go only to the active hive with a given label.

## File ownership

| Workstream | Branch | Owns |
| ---------- | ------ | ---- |
| **MCP** (backend API + MCP tools) | `atlas/mcp-tools` | `backend/internal/httpapi/**` (all routes, MCP, tests), `backend/internal/auth/**` if needed |
| **Ledger** (whole-yard visit + inspection forms) | `atlas/visit-ledger` | `frontend/src/features/transcription/**`, `frontend/src/features/inspections/**`, `frontend/src/features/apiaries/bulk-actions-tab.tsx`, `frontend/src/app/(app)/yard/apiaries/[id]/visit/**`, `frontend/src/app/(app)/yard/apiaries/[id]/bulk/**` |
| **Timeline** (yard history by date, hive record, labels, IA) | `atlas/yard-timeline` | `frontend/src/features/photos/**`, `frontend/src/features/operations/hive-timeline.tsx`, `frontend/src/features/hives/**`, `frontend/src/features/yard/**`, `frontend/src/features/apiaries/**` except `bulk-actions-tab.tsx`, `frontend/src/app/(app)/yard/apiaries/[id]/{timeline,inspections,photos,overview}/**`, `frontend/src/app/(app)/yard/hives/[id]/**`, `frontend/src/components/shell/nav-items.ts`, `DESIGN.md` |
| **Import** (Obsidian import status bug) | `atlas/import-fix` | `backend/cmd/migrate-legacy/**` (and other importer code outside `internal/httpapi` if that's where the bug lives) |

`frontend/src/lib/hive-label.ts` is frozen on `atlas/base`. If a helper is
missing, add a local one in your own files and say so in the report.

## Contract 1: apiary activity (MCP builds it; Timeline consumes it)

`GET /api/v1/apiaries/{id}/activity?from=YYYY-MM-DD&to=YYYY-MM-DD&types=a,b`

- Viewer access to the apiary (same rule as the other apiary reads).
- `from`/`to` are inclusive. If `to` is missing, use today. If `from` is
  missing, use `to` minus 365 days. Reject ranges over 3 years with 400.
- `types` filters events. Allowed values: `inspection`, `feeding`,
  `treatment`, `mite_count`, `queen`, `split`, `harvest`, `move`, `status`,
  `apiary_observation`. An empty filter means all of them.
- **Status events:** a dead-out (`deadout_date`) appears as type `status`
  with `meta: {"status": "dead"}`. Other status changes are included only if
  the backend has a dated source for them. Don't invent dates.
- Include events of retired hives (dead, sold, combined) in the range: this is
  history.

Response `200`:

```json
{
  "apiaryId": "uuid",
  "from": "2025-11-25",
  "to": "2026-11-25",
  "days": [
    {
      "date": "2026-09-13",
      "apiaryObservations": [
        { "id": "uuid", "observedAt": "2026-09-13T13:41:00Z", "notes": "…" }
      ],
      "hives": [
        {
          "hiveId": "uuid",
          "positionLabel": "B4",
          "status": "active",
          "isArchived": false,
          "installedDate": "2025-04-13",
          "deadoutDate": null,
          "standId": "uuid|null",
          "slotRow": 0,
          "slotCol": 3,
          "events": [
            {
              "id": "uuid",
              "type": "inspection",
              "title": "Inspection",
              "details": "…",
              "meta": {},
              "photos": []
            }
          ]
        }
      ]
    }
  ]
}
```

- `days` are newest first. `hives` within a day are sorted by
  `positionLabel`, then `installedDate`. Days without events are omitted.
- `events[*]` uses exactly the shape and meta keys the hive timeline already
  returns (`hiveTimeline` in `routes_operations.go`), so one renderer can show
  both.
- `photos` may be an empty array. Don't add photo lookups that slow this
  endpoint down.

## Contract 2: hive timeline filters (MCP builds; Timeline may use)

`GET /api/v1/hives/{id}/timeline` gains optional `from`, `to` and `types`
query params with the same semantics as Contract 1. With no params, the
response is unchanged.

## Contract 3: hive status changes (MCP builds)

- `POST /api/v1/hives/{id}/deadout` accepts an optional JSON body
  `{"date":"YYYY-MM-DD"}`. With no body or no date it stamps today, as it
  does now.
- New: `PATCH /api/v1/hives/{id}/status`, body
  `{"status":"active|dead|sold|combined","date":"YYYY-MM-DD?"}`. It changes
  only status-related columns, never notes, label or slot.
  - `dead`: sets `deadout_date` (to `date`, or today) and archives.
  - `sold` / `combined`: archives (and records `date` if the schema has a
    column for it; otherwise ignore `date`).
  - `active`: unarchives and clears `deadout_date`.
  - Response: the hive JSON (same shape as `GET /hives/{id}`).
- Voice matching (`transcriptionCandidateHives`, `routes_transcriptions.go`)
  must use `status = 'active' AND is_archived = false`.

## Contract 4: MCP tool set (MCP builds; the beekeeping skill consumes)

Server: `routes_mcp.go`. Keep the existing tool names and behaviour
backward-compatible. Add or extend the following.

Reads:
- `list_hives` gains `status` (`active` | `dead` | `sold` | `combined` | `all`;
  default `active`) and `positionLabel` (exact, case-insensitive). With a
  label and the default status, it returns zero or one hive.
- `get_hive_timeline` gains `from`, `to` and `types` (Contract 2).
- `get_apiary_activity` (`apiaryId`, `from?`, `to?`, `types?`) uses
  Contract 1.
- `list_apiary_observations` (`apiaryId`, `from?`, `to?`).
- `get_varroa_summary` (`apiaryId?`, `season?`) wraps the existing varroa
  analytics.
- `get_treatment_locks` (`apiaryId?`): per active hive, whether a treatment
  lock or withdrawal window is open, and until when. Reuse `lockout.go`.

Writes (all need editor access; all **deduplicate**):
- **Dedupe rule:** before inserting, look for an existing record with the same
  natural key. If found, return
  `{"duplicate": true, "existingId": "...", "record": {...}}` and don't
  write, unless the caller passes `allowDuplicate: true`. Natural keys:
  - inspection: hive + date
  - feeding: hive + date + type
  - mite count: hive + date + method
  - treatment: hive + date + product (case-insensitive)
  - queen event: hive + date + type
  - apiary observation: apiary + observedAt + notes
- `record_inspection`: expose every field `inspectionCreateReq` accepts
  (frames, stores, queen cells and cups, `queenHealth`, `crowdedBrood`,
  `flowOn`, `pests`, `treatments`, `miteCounts`, `inspectorName`). Keep
  `queenSeen` tri-state: omitted means unknown.
- `update_inspection` (`inspectionId` + any inspection fields; a partial
  update) and `delete_inspection` (`inspectionId`; must state the hive and
  date it deleted).
- `record_treatment` (`hiveId`, `dateApplied`, `product`, `method?`,
  `dateRemoved?`, `notes?`): if `dateRemoved` is omitted and the product
  resolves to a catalog product whose notes mark it one-shot (Oxalic acid
  today; match by name or alias), default `dateRemoved` to `dateApplied` so
  the hive isn't left locked.
- `record_queen_event`, `record_apiary_observation`,
  `record_bloom_observation`: wrap the existing REST handlers.
- `set_hive_status` (`hiveId`, `status`, `date?`) uses Contract 3.
- `record_visit` (`apiaryId`, `date`, `observation?`, `entries[]`): each
  entry has `hiveId` **or** `positionLabel` (resolved to the active hive;
  unresolvable labels are errors for that entry), plus optional `inspection`
  (record_inspection fields), `feeding`, `miteCount` and `treatment`. Each
  entry is processed independently with the dedupe rule. The response lists,
  per entry, what was created, what was a duplicate and what failed, plus
  totals. Use a transaction per entry, so one bad entry doesn't roll back the
  others.
- Tool descriptions must say what the tool does, its dedupe behaviour and the
  units, in one or two sentences. Input schemas use `additionalProperties:
  false` and accurate enums.

## Frontend specs

**Ledger (P0: whole-yard visit)**
- After capture, the visit review is a **ledger**: one compact row per hive
  showing the label, a one-line summary of what was heard and a match chip
  (matched / needs a hive / skipped), each row expandable to the existing
  editable fields.
- A sticky primary action "Confirm N matched", with a separate count for rows
  that need a hive. Show progress while confirming ("7 of 14 saved"). At the
  end, show a visit summary ("14 saved · 1 skipped · Open Sep 13 on the
  timeline"), linking to `/yard/apiaries/{id}/timeline?date=YYYY-MM-DD`.
- Use existing confirm endpoints, called sequentially, keeping offline
  queueing intact. No backend changes.
- Show a progress state while transcribing, not just "Preparing your
  inspection review…".
- The hive picker shows the A1–D4 grid by default, not collapsed. Pickers
  offer active hives only and are labelled with `hiveDisplayLabel`.
- "What to record" no longer mixes modes and ~18 hives in one native select.
- **Fields:** one shared fields component for the typed form and the voice
  review. A Quick set (note, queen seen yes/no/unknown, temperament, mite
  count) plus a "More detail" disclosure. The typed form's queen must be
  tri-state; never default to "not seen". Temperament labels say which end is
  calm. Every input has a real `<label>`.
- **Bulk record** gains Treatment (product, method, dates; a series of dates
  creates one record per date) and Mite count (method, count, sample size).
- **Accessibility:** the recording timer must not be a per-second live region
  (announce start and stop only). 44px targets on coarse pointers. Keyboard:
  Enter confirms the focused row, `j`/`k` move between rows, and `Mod+Enter`
  confirms all matched. Register them through the existing keyboard model
  (`lib/keyboard.ts`).
- Delete `batch-review.tsx` and `single-review.tsx` if they're still unused.
  Plain-language copy: no "server receipts" or "structured mite counts".
- InspectionCard: findings before the weather strip; Edit and Delete at 44px
  on coarse pointers.

**Timeline (P1: yard history by date, labels, retired hives)**
- The apiary **Timeline** tab becomes visit days from Contract 1: newest day
  first. Each day shows apiary observations, then one row per hive with
  compact chips for each event (inspection one-liner, feeding, treatment,
  mite count `n/300`, status). A list/grid toggle shows the day on the A1–D4
  grid. Support a `?date=` deep link (scroll to and highlight that day) plus
  type filters. Move the photo evidence that lived on Timeline under the
  Photos tab, and keep a redirect if any route changes.
- **Hive record:**
  - Inspection cards on a retired hive show no Edit or Delete.
  - Reactivate asks for confirmation and offers "Start a new hive at {label}"
    as the alternative.
  - Timeline filter chips are 44px on coarse pointers, at most 4 visible plus
    "More".
  - The timeline error state has Retry.
  - Queen events read as words ("Queen marked", "Supersedure"), not raw
    lowercase enum values.
- Anywhere in these areas where a hive is listed or picked, use
  `hiveDisplayLabel`.
- **IA:** one whole-yard entry point for each job. Keep "Record visit" and
  "Bulk record", and fold "Voice walkthrough" into Record visit (keep its URL
  as a redirect). Voice inspection on a hive should not throw the user out of
  the hive record if that can be fixed in `nav-items.ts` alone. Update the
  `DESIGN.md` glossary to match.
- Data comes from `GET /apiaries/{id}/activity`. Until the MCP branch merges,
  that endpoint 404s locally. Build against the contract, handle loading,
  empty and error states, and keep types in one file so the coordinator can
  adjust them if the backend differs.

## Import workstream

The Obsidian import gave successor colonies the status of the colony
previously at that label: the current A1 and C2 records were marked `sold`
because their predecessors were sold to Craig on 2026-04-25. C2's 2026-07-19
harvest is also missing. Find the cause in the importer, fix it, add a test,
and produce a **read-only** report of other hive records in production that
the same bug likely affected (status, harvests). Read production only through
`selected/skills/beekeeping/scripts/atlas_api.py` in
`C:\Users\biker\projects\agent-skills`: `GET` only, with the token from that
repo's `.env`, never printed. Don't write to production; propose data fixes in
the report instead.
