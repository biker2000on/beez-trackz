# ASI Review — Beez Trackz

**Date:** 2026-08-04 (local)
**ASI standard:** 0.5
**Review agent:** Claude Code (Fable 5), five parallel review passes + direct verification of all High findings
**Mode:** Full
**Reviewed commit:** e9fd7574e1ab2c0ebad27258de73e8d65ca9e06d (clean worktree)
**Comparison base:** Not applicable
**Release recommendation:** Conditional

## Executive Summary

Beez Trackz is a self-hosted beekeeping management stack: Go API + worker
(chi/pgx/goose/asynq), Next.js PWA frontend, Postgres/Redis/MinIO, deployed
behind traefik on TrueNAS. The codebase is in notably good shape for its size:
the apiary-scoped authorization model is consistently enforced (including for
body-supplied IDs, where most APIs of this shape leak), the integer-cents money
migration is done correctly end to end, the equipment ledger's trigger-derived
totals with reconciliation guards are genuinely sound, and there is no SQL
injection, no path traversal, and no committed secret.

No Critical findings. The release risk concentrates in two clusters of
**High** findings:

1. **The offline mutation queue — the product's flagship field feature — can
   both lose data and duplicate data.** On the client, logging back in after a
   session expiry wipes every still-pending queued mutation, and a single
   mutation that 500s permanently wedges everything queued behind it with no UI
   escape hatch. On the server, the idempotency middleware's receipt-completion
   write runs on the request context with its error discarded — a client
   disconnect at exactly the wrong moment leaves the receipt in `processing`
   and a later replay re-executes the handler, booking the same sale twice.
2. **One inventory path escaped the shipped negative-stock invariant:**
   reversing a `jarring` movement performs no availability check and no lock,
   so jars that were already sold can be reversed into negative stock,
   double-counting honey. This contradicts the roadmap's "negative-stock
   validation shipped 2026-08-04" claim.

A fifth High: transcription uploads are effectively unbounded (the 64 MB
constant only controls memory spill, not request size), an OOM path on a NAS
deployment.

| Severity | Count |
|----------|------:|
| Critical | 0 |
| High | 5 |
| Medium | 16 |
| Low | 12 |

## Scope and Confidence

- Reviewed: `backend/` (all cmd + internal packages, all 9 goose migrations),
  `frontend/src` (app routes, features, lib, service worker), CI workflow,
  root/backend/frontend Dockerfiles, both compose files, `.env.example`,
  lockfiles (static inspection), docs (`README`, `docs/product-roadmap.md`,
  `docs/plans/*`, `docs/rewrite/*` for contracts).
- Excluded: the retired legacy Next.js app still tracked at the repo root
  (root `package.json`, `drizzle/`, root `Dockerfile`, `scripts/`,
  `docker-entrypoint.sh`) — reviewed only as repo-hygiene surface, not line by
  line; the roadmap already tracks its removal. `node_modules`, images, build
  artifacts.
- Not reviewed: runtime behavior against a live database (DB-backed
  integration tests were not run locally — no `TEST_DATABASE_URL`; CI runs
  them against Postgres 16); the production TrueNAS host itself (no remote
  commands were run); dependency vulnerability scan (`govulncheck` not
  installed, npm audit requires network).
- Assumptions: deployment model per `docker-compose.prod.yml` (traefik TLS,
  DB/Redis/MinIO on the compose network only); single-family instance with
  admin + a small number of OIDC collaborators; severity calibrated to that
  context with internet-exposed surfaces (login, public honey-story pages,
  MCP) weighted higher.
- Overall confidence: **High** for the findings themselves — every High was
  re-verified directly against the code after the review passes; agent-sourced
  Medium/Low findings carry quoted evidence and two were independently
  corroborated by separate passes. **Medium** for completeness of the frontend
  feature sweep (69 feature files reviewed for classes of defect, not
  exhaustively line by line).
- Applicable optional modules: Web and User Interface; Infrastructure,
  Container, and Cloud; Database and Data Pipeline; AI and Model-Integrated
  Systems. (API/SDK Compatibility: internal API only, treated inside core
  checks. Mobile/Desktop: not applicable — PWA covered under Web.)

## Verification Evidence

| Command or check | Result | Evidence / limitation |
|------------------|--------|-----------------------|
| `go build ./...` (backend) | Passed | exit 0 |
| `go vet ./...` (backend) | Passed | no findings |
| `go test ./...` (backend, no DB) | Passed | ai/db/httpapi packages ok; DB-backed tests skip without `TEST_DATABASE_URL` (`db_integration_test.go:16`); CI runs them against Postgres 16 |
| `npm run lint` (frontend) | Passed | 0 errors, 18 warnings (React Compiler memoization skips on react-hook-form usage) |
| `npm run build` (frontend) | Passed | production build completes; all routes compile |
| `go mod verify` | Passed | "all modules verified" |
| `govulncheck` | Not run | not installed; per review policy nothing was installed |
| `npm audit` | Not run | requires network; lockfiles inspected statically instead |
| DB integration suite | Not run locally | needs Postgres; covered in CI on every push (verified in `.github/workflows/deploy.yml`) |
| Docker/compose runtime checks | Not run | local docker context points at the production NAS; running anything was out of scope for a read-only review |

## Findings

### High

#### ASI-5-001: Offline replay can re-execute a completed mutation when the receipt-completion write fails

- **Check:** Reliability, concurrency, and state consistency
- **Confidence:** High (directly verified)
- **Location:** `backend/internal/httpapi/middleware_offline.go:294`
- **Evidence:** The completion bookkeeping runs on the request context with
  its error discarded: `_, _ = s.pool.Exec(r.Context(), UPDATE
  offline_mutation_receipts SET state='complete',...)`. If the client
  disconnects right after the handler commits (the flaky-signal market-day
  scenario this middleware exists for), `r.Context()` is canceled and the
  UPDATE silently fails, leaving the receipt in `processing`. After the
  5-minute window (`middleware_offline.go:241-253`) a replay claims the
  receipt and re-runs the handler. Aggravator: responses over the 2 MB capture
  limit (`middleware_offline.go:15,34-40`) are truncated to invalid JSON and
  the `jsonb` insert at line 294-298 fails the same silent way.
- **Impact:** Duplicate honey sales / inventory movements after offline sync —
  silent ledger corruption in the exact scenario the feature protects against.
- **Recommendation:** Run receipt bookkeeping (lines 258, 266, 283, 294) on
  `context.WithoutCancel(r.Context())` with a short timeout and log failures;
  skip storing the body when `capture.body.Len() >= offlineResponseLimit`.
- **Regression verification:** Integration test — handler commits, cancel the
  request context before the completion UPDATE, replay the same mutation ID;
  assert the stored response is returned and exactly one row was created.
- **Status:** Fixed 2026-08-11 (receipt bookkeeping on `context.WithoutCancel`
  with logging; truncated bodies skipped; tests added) · **Owner:** Claude

#### ASI-5-002: Logging back in destroys the pending offline mutation queue

- **Check:** Reliability, concurrency, and state consistency
- **Confidence:** High (directly verified)
- **Location:** `frontend/src/app/sw.js/route.ts:315-330` (with `clearPrivateOfflineState` at 104-107, `clearQueue` at 93-102)
- **Evidence:** Replay correctly halts on 401/403 leaving items `pending`
  (line 169). But a successful `POST /api/v1/auth/login` or OIDC callback
  triggers `clearPrivateOfflineState()`, which runs `clearQueue()` — deleting
  **every** queued mutation including pending ones never replayed.
- **Impact:** Beekeeper works offline all day, session cookie expires, comes
  back online, replay halts on 401, signs back in — and login wipes every
  unsynced inspection/feeding/harvest entry. In a single-user app, "same user
  re-authenticating" is the common case, not the edge case.
- **Recommendation:** On login success clear only `DATA_CACHE`; keep the queue
  (or clear it only when the authenticated principal actually changed), then
  trigger `replayQueue()`.
- **Regression verification:** Queue a mutation offline, delete the session
  cookie, reconnect, log in; the queued item must replay and appear
  server-side.
- **Status:** Fixed 2026-08-11 (login/OIDC success clears only the data cache
  and triggers replay; logout still clears both) · **Owner:** Claude

#### ASI-5-003: One poisoned pending mutation wedges the entire offline queue with no escape hatch

- **Check:** Reliability, concurrency, and state consistency
- **Confidence:** High (directly verified)
- **Location:** `frontend/src/app/sw.js/route.ts:178-181`; `frontend/src/components/pwa-register.tsx:154`
- **Evidence:** In `replayQueue()`, 4xx responses become reviewable
  `failed`/`conflict` items, but any 5xx or network error hits a bare `break`
  with the item left `pending` — and the review dialog renders only
  `queue.items.filter((item) => item.state !== "pending")`, so a
  permanently-500ing pending item can never be seen or discarded. "Retry"
  re-runs `replayQueue()` and breaks at the same item.
- **Impact:** A single server bug on one payload permanently blocks sync of
  everything queued after it; the only user recovery is clearing site data,
  which loses everything.
- **Recommendation:** Track a per-item retry count; after N consecutive 5xx
  failures mark the item `failed` (reviewable/discardable) instead of breaking
  forever. Alternatively list pending items in the review dialog with a
  Discard action.
- **Regression verification:** Queue two mutations, make the server 500 on the
  first; the first must eventually surface in review and the second must
  replay after the first is discarded.
- **Status:** Fixed 2026-08-11 (per-item retry count; 5 consecutive 5xx
  failures promote to `failed`; network errors uncounted; explicit user retry
  resets the budget) · **Owner:** Claude

#### ASI-1-001: Reversing a jarring movement bypasses the shipped negative-stock validation

- **Check:** Correctness and AI-slop indicators
- **Confidence:** High (directly verified)
- **Location:** `backend/internal/httpapi/routes_honey.go:576-676` (`honeyReverseMovement`)
- **Evidence:** `DELETE /honey/movements/{id}` locks only the movement row
  (`FOR UPDATE`, line 609), negates quantity/lbs (643-652), and inserts the
  reversal — with no `honeyLockJarSizes` call and no availability check.
  Repro: jar 10 × Pint, sell 10, reverse the jarring movement → jar on-hand =
  −10, no error. The roadmap marks negative-stock validation **Shipped
  2026-08-04** and the integration notes exempt only `jar_adjustment`; the
  reversal path is not on the exemption list. Reversal also decrements
  `JarredLbs`, inflating `bulkOnHandLbs` back while the jars remain in the
  sold aggregate — the same honey counted twice.
- **Impact:** Ledger corruption reachable from a normal admin action; negative
  on-hand quantities poison every downstream total (overview, production plan,
  valuation, low-stock).
- **Recommendation:** In `honeyReverseMovement`, when the original is
  `jarring` (or a positive `jar_adjustment`), call `honeyLockJarSizes` +
  the standard availability check for the quantity being removed before
  inserting; return the standard 400 shortfall message.
- **Regression verification:** Integration test — jar N, sell N, reverse the
  jarring movement must 400; reversing an unsold jarring must still succeed.
- **Status:** Fixed 2026-08-11 (jarring / positive jar_adjustment reversals
  lock jar sizes and clear the availability check; test added) · **Owner:** Claude

#### ASI-4-001: Transcription upload size is effectively unbounded

- **Check:** Filesystem, network, and customer-environment safety
- **Confidence:** High (directly verified)
- **Location:** `backend/internal/httpapi/routes_transcriptions.go:144,177`
- **Evidence:** `r.ParseMultipartForm(transcriptionMaxUploadBytes)` only
  controls memory-vs-tempfile spill — it does not cap request size — and
  there is no `http.MaxBytesReader` and no `header.Size` check (contrast the
  photos route, which does both at `routes_photos.go:89,110`). The file is
  then `io.ReadAll`'d into RAM, read fully again in the worker
  (`internal/jobs/transcribe.go:54`), with Gemini adding a +33% base64 copy.
- **Impact:** A single multi-GB upload (a stuck recorder, or hostile) fills
  memory/disk and can OOM the API or worker on the NAS.
- **Recommendation:** `r.Body = http.MaxBytesReader(w, r.Body,
  transcriptionMaxUploadBytes+(1<<20))` before parsing, and reject
  `header.Size > transcriptionMaxUploadBytes`.
- **Regression verification:** POST a body just over 64 MB; expect 400 with
  bounded memory.
- **Status:** Fixed 2026-08-11 (`MaxBytesReader` + `header.Size` check,
  mirroring the photos route) · **Owner:** Claude

### Medium

#### ASI-3-001: Public honey-story subscribe endpoint can overwrite existing customer CRM records, with no rate limit

- **Check:** Security, supply chain, privacy, and data integrity
- **Confidence:** High (corroborated independently by two review passes)
- **Location:** `backend/internal/httpapi/routes_commerce.go:658-705` (mounted unauthenticated via `router.go:39`)
- **Evidence:** `ON CONFLICT (lower(email)) ... DO UPDATE SET
  name=EXCLUDED.name, email_opt_in=true,
  referred_by=COALESCE(EXCLUDED.referred_by, customers.referred_by)` — and the
  router has no rate-limit middleware anywhere.
- **Impact:** Anyone who knows or guesses a customer email can rename that
  customer (feeds receipts and sale displays), force marketing opt-in (a
  compliance problem), and stamp a referral; bots can insert unlimited junk
  customer rows.
- **Recommendation:** On conflict update nothing except `email_opt_in` (or
  `DO NOTHING` into a separate `story_subscribers` table); add a per-IP
  throttle on `/public/*` POSTs (in-app or traefik).
- **Regression verification:** POST subscribe with an existing customer's
  email and a new name; stored `name`/`referred_by` must be unchanged.
- **Status:** Open · **Owner:** Unassigned

#### ASI-3-002: Stored XSS via photo uploads served with client-controlled Content-Type

- **Check:** Security, supply chain, privacy, and data integrity
- **Confidence:** High (directly verified)
- **Location:** `backend/internal/httpapi/routes_photos.go:144-147` (upload), `:358-381` (serve)
- **Evidence:** Upload trusts the client's `Content-Type` header when set to
  anything but empty/octet-stream; `servePhotoKey` replays it verbatim. No
  image-type whitelist; grep finds no `X-Content-Type-Options`,
  `Content-Security-Policy`, or `X-Frame-Options` anywhere in the backend.
  Public lot photos serve through the same path (`routes_commerce.go:636-656`).
- **Impact:** An editor-role collaborator uploads `evil.jpg` with
  `Content-Type: text/html`; when the admin views it, script executes on the
  app origin and can call any admin API with credentials — an editor→admin
  privilege escalation. Attached to a public lot, it serves arbitrary HTML
  from the public origin.
- **Recommendation:** Whitelist upload content types to the
  `photoContentTypes` map values; on serve, derive `Content-Type` solely from
  the key extension and set `X-Content-Type-Options: nosniff` (ideally
  `Content-Security-Policy: sandbox` on the file route).
- **Regression verification:** Upload a text/html payload named `evil.jpg` —
  rejected; a pre-existing object must serve as `image/jpeg` + `nosniff`.
- **Status:** Open · **Owner:** Unassigned

#### ASI-3-003: No brute-force protection on the password login endpoint

- **Check:** Security, supply chain, privacy, and data integrity
- **Confidence:** High
- **Location:** `backend/internal/httpapi/routes_auth.go:167-203`; `router.go:26-48`
- **Evidence:** One instance-wide password compared with bcrypt, no attempt
  counting/delay/lockout, and no rate-limit middleware in the router. Minimum
  password length is 8.
- **Impact:** Internet-exposed login guarding an admin session, subject to
  unlimited low-and-slow online guessing for the lifetime of the deployment.
- **Recommendation:** Small in-memory failure throttle (exponential delay
  after 5 failures), or a traefik rate-limit rule on `/api/v1/auth/login`
  documented in the prod compose.
- **Regression verification:** 20 rapid wrong-password POSTs get delayed/429'd.
- **Status:** Open · **Owner:** Unassigned

#### ASI-3-004: Session tokens are non-revocable for 30 days and the JWT is echoed in the login response body

- **Check:** Security, supply chain, privacy, and data integrity
- **Confidence:** High
- **Location:** `backend/internal/auth/session.go:14,60-72`; `backend/internal/httpapi/routes_auth.go:202,206-209`
- **Evidence:** `SessionDuration = 30 days`; `ParseToken` checks only HMAC +
  expiry (no store, no jti/version); logout only clears the cookie; login
  returns the raw JWT in the JSON body, and Bearer auth accepts it.
- **Impact:** A leaked session JWT is valid 30 days with no revocation short
  of rotating `SESSION_SECRET` (logs everyone out). The body-returned token
  invites localStorage storage, undoing HttpOnly and compounding ASI-3-002.
  (Deactivating a user does cut access — `middleware.go:75-98` gates on
  `is_active`; the gap is per-token revocation and the shared password
  subject.)
- **Recommendation:** Stop returning `token` from login (the cookie is already
  set); `/access/tokens` is the existing revocable mechanism for API use.
  Optionally shorten `SessionDuration`.
- **Regression verification:** Login response contains no `token`; cookie auth
  still works.
- **Status:** Open · **Owner:** Unassigned

#### ASI-3-005: `SESSION_SECRET` doubles as the MinIO root password in production

- **Check:** Security, supply chain, privacy, and data integrity
- **Confidence:** High
- **Location:** `docker-compose.prod.yml:22,131`
- **Evidence:** `MINIO_SECRET_KEY: ${SESSION_SECRET:?...}` and
  `MINIO_ROOT_PASSWORD: ${SESSION_SECRET:?...}` (the adjacent comment admits
  the cutover shortcut). Sessions are HMAC-signed with the same secret.
- **Impact:** Any MinIO credential leak is simultaneously a session-forging
  key — an attacker can mint admin JWTs; rotating one forces rotating both.
- **Recommendation:** Introduce a distinct `MINIO_SECRET_KEY` variable in the
  stack `.env`, reference it in both MinIO places, then rotate
  `SESSION_SECRET`.
- **Regression verification:** `grep SESSION_SECRET docker-compose.prod.yml`
  shows only the api service's `SESSION_SECRET` key.
- **Status:** Open · **Owner:** Unassigned

#### ASI-3-006: 34 MB compiled binary committed to the repo (`backend/server.exe~`)

- **Check:** Security, supply chain, privacy, and data integrity
- **Confidence:** High (directly verified: blob 34,305,536 bytes in `git ls-files`)
- **Location:** `backend/server.exe~` (tracked); `.gitignore` last line; `backend/Dockerfile:5`
- **Evidence:** `.gitignore` has `*.exe` but the `~` suffix defeats it. There
  is no `backend/.dockerignore`, and `backend/Dockerfile` does `COPY . .`, so
  the binary rides into every CI build context and build-stage layer cache.
- **Impact:** 34 MB of unreviewable, stale binary in every clone and CI
  checkout — a supply-chain review blind spot and repo bloat.
- **Recommendation:** `git rm --cached backend/server.exe~`; add `*.exe~` to
  `.gitignore`; add `backend/.dockerignore` covering `*.exe*`.
- **Regression verification:** `git ls-files | grep -i exe` returns nothing.
- **Status:** Open · **Owner:** Unassigned

#### ASI-1-002: Reversing a bottling-run movement strands the run, lot accounting, and serials

- **Check:** Correctness and AI-slop indicators
- **Confidence:** High
- **Location:** `backend/internal/httpapi/routes_honey.go:655-662`; `routes_commerce.go:477-491`
- **Evidence:** The reversal copies `bottling_run_id` onto the negated row but
  the `bottling_runs` row survives: `alreadyBottledLbs` still counts the
  reversed run (permanently consuming lot capacity), the run's `jar_serials`
  stay live and lookup-able for jars the ledger says were never bottled, and
  there is no endpoint to void a run.
- **Impact:** Lot page, serial lookup, and inventory permanently disagree
  after one reversal; future runs on the lot fail "already bottled".
- **Recommendation:** Refuse to reverse movements with `bottling_run_id IS NOT
  NULL` (409 pointing at a future "void run" action), or void the run + its
  unsold serials in the same transaction.
- **Regression verification:** Lot 10 lbs → bottle 10 → reverse → a new 10-lb
  run must be consistent with whichever policy is chosen.
- **Status:** Fixed 2026-08-11 (refuse policy: 409 on run-linked movements; a
  void-run endpoint remains future work; test added) · **Owner:** Claude

#### ASI-5-004: Harvest true-up and entry soft-delete reduce bulk stock without the bulk lock or a floor

- **Check:** Reliability, concurrency, and state consistency
- **Confidence:** Medium (lock bypass is objective; how much of the reduction path is intended correction is a product call)
- **Location:** `backend/internal/httpapi/routes_harvest_sessions.go:373-438` (`hsTrueUp`), `:444-468` (`hsDeleteEntry`); `honey_ledger.go:47`
- **Evidence:** Both shrink `TotalHarvestedLbs` without acquiring
  `honeyBulkLockKey` and without checking already-jarred pounds. The advisory
  lock protocol only works if every bulk-affecting writer participates — a
  true-up committing between a concurrent jarring's check and commit
  invalidates that validation. Also `NULLIF(hs.total_extracted_weight, 0)`
  means truing-up to exactly 0 silently reverts to the per-entry sum.
- **Impact:** `bulkOnHandLbs` can go negative after honey was already
  jarred/bottled; concurrent validation races.
- **Recommendation:** Take `pg_advisory_xact_lock(honeyBulkLockKey)` in both
  handlers; if the reduction would push bulk below zero, require an explicit
  override/reason or reject.
- **Regression verification:** Harvest 100 lbs, jar 90, true-up to 50 →
  expect 400 or flagged override, not silent −40 bulk.
- **Status:** Fixed 2026-08-11 (both handlers take the bulk advisory lock and
  floor at already-jarred pounds; zero true-ups rejected explicitly because
  the formula treats 0 as unset; tests added) · **Owner:** Claude

#### ASI-5-005: Handlers collapse transient DB errors into 4xx, which the idempotency layer then makes permanent

- **Check:** Reliability, concurrency, and state consistency
- **Confidence:** High
- **Location:** `backend/internal/httpapi/routes_honey.go:1044-1049`; `routes_commerce.go:303-305,375-377,452-456,510-512,700-702,909-911,933-935,1001-1003`; `middleware_offline.go:282-298`
- **Evidence:** Several mutation handlers map *any* non-FK error to
  409/400 (e.g. sale insert: any non-FK failure → `409 "order number already
  exists"`). The offline middleware persists any status < 500 as the final
  receipt, so a transient failure (deadlock, serialization, connection drop)
  on a queued market-day sale is recorded as a permanent 4xx; every replay
  returns the stored failure and the sale is silently lost.
- **Impact:** Offline-queued sales silently dropped on transient DB errors.
- **Recommendation:** Distinguish by `pgconn.PgError` code — 23505 → 409,
  23503 → 400, everything else → 500 (the middleware already deletes the
  receipt on 500, allowing retry).
- **Regression verification:** Inject a non-constraint error into each
  handler: assert 500, and that a replayed mutation after a 500 re-executes.
- **Status:** Fixed 2026-08-11 (shared `writeDBError` maps 23505→409,
  23503→400, everything else→500; applied across the cited honey/commerce
  handlers; unit test added) · **Owner:** Claude

#### ASI-5-006: Whisper model self-install: unpinned multi-GB download under a 5-minute timeout, brittle detection, 4xx treated as success, unserialized concurrent installs

- **Check:** Reliability, concurrency, and state consistency
- **Confidence:** High
- **Location:** `backend/internal/ai/whisper.go:88-104,100-102,112,161-164`; `provider.go:24`; `internal/jobs/worker.go:27`
- **Evidence:** `installModel` triggers speaches to download ~1.6 GB from
  HuggingFace (no revision pin) using the shared client with a 5-minute
  timeout; "not installed" detection is a substring match against an error
  body truncated to 300 chars; `if resp.StatusCode >= 500` treats a 404/401
  (typo'd model name) as a successful install; worker concurrency 4 can fire
  concurrent installs.
- **Impact:** On a slow link every transcription attempt re-triggers a partial
  download through asynq's retries; a typo'd model name yields a confusing
  loop instead of an error.
- **Recommendation:** Dedicated long/no-timeout client (or async poll) for
  installs; treat `>=400 && != 409` as failure; serialize installs behind a
  singleflight/mutex.
- **Regression verification:** Stub server: 404 install response surfaces an
  error; two concurrent Transcribe calls produce one install POST.
- **Status:** Open · **Owner:** Unassigned

#### ASI-6-001: Image job has no dimension guard — decompression-bomb OOM with automatic retry

- **Check:** Performance and resource efficiency
- **Confidence:** High
- **Location:** `backend/internal/jobs/image.go:61,110`; `routes_photos.go:25`
- **Evidence:** The 10 MB file cap does not bound decoded size:
  `image.Decode` with no `DecodeConfig` bounds check — a small PNG declaring
  30000×30000 decodes to ~3.6 GB RGBA; asynq retries (MaxRetry 3) repeat the
  OOM kill at worker concurrency 4.
- **Impact:** Worker OOM loop from one crafted or corrupt image.
- **Recommendation:** `image.DecodeConfig` first; `asynq.SkipRetry` any image
  over ~50 MP.
- **Regression verification:** Enqueue a 100 MP PNG; job fails fast with
  SkipRetry, worker RSS stable.
- **Status:** Open · **Owner:** Unassigned

#### ASI-5-007: Every worker replica runs its own periodic scheduler, and the recommendations dedup check races

- **Check:** Reliability, concurrency, and state consistency
- **Confidence:** High
- **Location:** `backend/cmd/worker/main.go:57`; `backend/internal/recs/engine.go:43-62`; `routes_recommendations.go:242-243`
- **Evidence:** `asynq.NewScheduler` runs inside the worker binary (N replicas
  → N enqueues every 6 h, no dedup); recs dedup is a non-transactional
  `SELECT EXISTS` then `INSERT` with no unique constraint; the manual-run
  endpoint enqueues without `asynq.Unique`.
- **Impact:** Duplicate recommendation cards when workers scale or manual runs
  overlap. Currently latent with one worker replica.
- **Recommendation:** Partial unique index on
  `(type, COALESCE(hive_id, ...)) WHERE dismissed = false` +
  `ON CONFLICT DO NOTHING`; enqueue with `asynq.Unique(6h)`.
- **Regression verification:** Run `recs.Run` twice concurrently; row count
  equals single-run count.
- **Status:** Open · **Owner:** Unassigned

#### ASI-4-002: `offline_mutation_receipts` grows forever (bodies up to 2 MB each)

- **Check:** Filesystem, network, and customer-environment safety
- **Confidence:** High
- **Location:** `backend/internal/db/migrations/00003_collaboration_field_intelligence.sql:74-85`; `middleware_offline.go:294-298`
- **Evidence:** A `created_at` index exists, clearly intended for retention,
  but no code anywhere deletes old receipts; every offline mutation
  permanently stores its JSON response.
- **Impact:** Unbounded table/TOAST growth on the NAS; slows lookups and
  backups.
- **Recommendation:** Periodic worker job: `DELETE FROM
  offline_mutation_receipts WHERE created_at < now() - interval '30 days'`.
- **Regression verification:** Insert an old receipt, run cleanup, assert
  deletion; fresh replay still works.
- **Status:** Open · **Owner:** Unassigned

#### ASI-6-002: AI provider responses read with `io.ReadAll` and no size cap, against user-configurable endpoints

- **Check:** Performance and resource efficiency
- **Confidence:** High
- **Location:** `backend/internal/ai/claude.go:63`, `gemini.go:63`, `ollama.go:66`, `whisper.go:156`
- **Evidence:** All four `io.ReadAll(resp.Body)` uncapped; Ollama/Whisper base
  URLs are admin-settable, so a misbehaving endpoint that streams indefinitely
  holds worker memory for up to 5 minutes × concurrency 4.
- **Recommendation:** Wrap with `io.LimitReader(resp.Body, 10<<20)`.
- **Regression verification:** Stub streaming endless bytes; call returns a
  bounded error without memory growth.
- **Status:** Open · **Owner:** Unassigned

#### ASI-7-001: Production floats on `:latest` with `pull_policy: always`; any push to a matching branch silently becomes prod

- **Check:** Deployment, migration, and rollback readiness
- **Confidence:** High
- **Location:** `docker-compose.prod.yml:36-37,70-71`; `.github/workflows/deploy.yml:3-5,58,81`
- **Evidence:** `image: ...:${BEEZ_IMAGE_TAG:-latest}` + `pull_policy: always`
  + `restart: unless-stopped`; CI publishes `latest` on push to `main` **and**
  `rewrite/go-stack` (publish jobs gate only on "not a PR", not on branch).
  The branch is currently deleted, so this is latent — but recreating any
  branch with that name would clobber `latest`, and a mere container restart
  would then run that code and its migrations in prod.
- **Impact:** Unintended prod upgrade (including irreversible schema
  migration) triggered by a container restart after any `latest` push.
- **Recommendation:** Set `BEEZ_IMAGE_TAG=<sha>` in the stack `.env` (CI
  already tags SHAs) and/or restrict publish jobs to
  `if: github.ref == 'refs/heads/main'`; drop `rewrite/go-stack` from
  triggers; consider dropping `pull_policy: always`.
- **Regression verification:** `docker compose config` on the NAS shows a
  sha-pinned image; a test-branch push does not update `latest`.
- **Status:** Open · **Owner:** Unassigned

#### ASI-7-002: Migrate-on-boot with no backup step and no rollback path in the deploy flow

- **Check:** Deployment, migration, and rollback readiness
- **Confidence:** High
- **Location:** `backend/internal/db/db.go:18-28`; `docs/` (absence)
- **Evidence:** The API runs `goose.Up` on every boot (correctly serialized
  behind advisory lock `db.go:50-74`; worker correctly skips migrations). All
  migrations have Down sections but nothing wires `goose down`, and no backup
  or rollback procedure is documented anywhere in the repo — `grep
  rollback|backup|pg_dump` across `docs/` and `README.md` returns nothing.
  The real deploy path (SSH `pg_dump` → `compose pull && up`) exists only in
  session memory, not in the repo.
- **Impact:** Rolling back to an older image leaves the old binary running
  against the new schema; if a migration is destructive, the only recovery is
  a pg_dump that may not exist.
- **Recommendation:** Document (or script on the NAS) a pre-deploy `pg_dump`
  step and the SSH deploy procedure in README's Deploy section; consider a
  scheduled dump to also cover restart-triggered upgrades (ASI-7-001).
- **Regression verification:** A fresh backup file timestamp precedes each
  deploy's `goose: successfully migrated` log line.
- **Status:** Open · **Owner:** Unassigned

#### ASI-7-003: CI's deploy-notification job curls a dead webhook and double-swallows failure — green CI implies a deploy that never happened

- **Check:** Deployment, migration, and rollback readiness
- **Confidence:** High
- **Location:** `.github/workflows/deploy.yml:100-109`
- **Evidence:** `notify-dockhand` runs with `continue-on-error: true` **and**
  `|| echo ...`; per the project's own deployment notes the webhook does not
  redeploy the stack (deploys are manual SSH compose).
- **Impact:** Misleading deploy signal; nobody is told a manual deploy is
  still required.
- **Recommendation:** Delete the job or replace it with an explicit
  "manual deploy required" summary step.
- **Regression verification:** Workflow run for a main push has no webhook
  step; README documents the real deploy.
- **Status:** Open · **Owner:** Unassigned

#### ASI-1-003: `parseCents` turns European decimal-comma input into a 100× price

- **Check:** Correctness and AI-slop indicators
- **Confidence:** High
- **Location:** `frontend/src/features/equipment/format.ts:36-42`; `stock-dialogs.tsx:320-325`
- **Evidence:** `value.trim().replace(/[$,]/g, "")` turns `"24,50"` into
  `"2450"` → 245,000 cents. The input is free text with
  `inputMode="decimal"`, and comma-decimal-locale mobile keyboards offer only
  the comma key.
- **Impact:** Equipment costs silently recorded 100× too high, no validation
  error.
- **Recommendation:** Treat a comma followed by exactly 1–2 trailing digits as
  a decimal separator (or reject non-grouping commas) before stripping.
- **Regression verification:** Enter `24,50` in Receive Stock unit cost →
  $24.50 or a validation error, never $2,450.
- **Status:** Open · **Owner:** Unassigned

#### ASI-1-004: Transcription flow dead-ends on a failed status poll — spinner forever

- **Check:** Correctness and AI-slop indicators
- **Confidence:** High
- **Location:** `frontend/src/features/transcription/use-transcription-flow.ts:60-66,91-95`; `status-card.tsx:16-17,43-47`
- **Evidence:** `refetchInterval` returns `false` when `data` is `undefined` —
  if the *first* status GET fails (flaky field network, global `retry: 1`),
  polling stops permanently; the UI renders "Queued…" with no retry button.
- **Impact:** After a 30-minute field recording uploads successfully, one
  dropped poll leaves the UI spinning forever; only recourse is reload or
  re-record.
- **Recommendation:** Also return the poll interval when
  `query.state.data === undefined`, or surface `statusQuery.isError` with a
  Retry action.
- **Regression verification:** Block one status GET after upload, then
  unblock; polling resumes and the review panel appears.
- **Status:** Open · **Owner:** Unassigned

#### ASI-1-005: Sale lines with quantity but blank/invalid price silently record a $0 sale

- **Check:** Correctness and AI-slop indicators
- **Confidence:** High
- **Location:** `frontend/src/features/honey/record-sale-dialog.tsx:115-122`; `jar-lines-editor.tsx:30`
- **Evidence:** `unitPrice: parseNum(line.unitPrice ?? "") ?? 0` — no
  validation that a line with quantity > 0 has a price; jar sizes without a
  configured default start at `""`.
- **Impact:** Revenue silently understated; $0 lines only hinted at by the
  small total display.
- **Recommendation:** Validate `unitPrice` parses to ≥ 0 for every line with
  quantity > 0, or require explicit confirmation for $0 lines.
- **Regression verification:** Record a sale with no price typed → field
  error, not a $0 line.
- **Status:** Open · **Owner:** Unassigned

#### ASI-2-001: Worker, recommendations, auth, config, and storage packages have no tests at all

- **Check:** Verification and test quality
- **Confidence:** High (observed: `go test ./...` reports `[no test files]`)
- **Location:** `backend/internal/jobs`, `internal/recs`, `internal/auth`, `internal/config`, `internal/storage`, `cmd/*`
- **Evidence:** The tested surface (ai, db, httpapi) is meaningful — the
  httpapi suite includes DB-backed integration tests run in CI — but the
  entire job pipeline (image, transcribe, recommend, schedule), the session
  token layer, and storage have zero coverage. Several findings in this report
  (ASI-5-006, ASI-6-001, ASI-5-007) live exactly in those packages.
- **Impact:** Regressions in transcription/thumbnails/recommendations ship
  silently; the offline-replay double-execution scenario (ASI-5-001) has no
  failing test to prevent its return.
- **Recommendation:** Add tests alongside the fixes for the findings above —
  each finding's "regression verification" is the seed of the suite.
- **Regression verification:** `go test ./...` shows test files in
  jobs/recs/auth at minimum.
- **Status:** Open · **Owner:** Unassigned

### Low

#### ASI-3-007: SSRF via admin-configurable Ollama/Whisper base URLs

- **Check:** Security, supply chain, privacy, and data integrity
- **Confidence:** High
- **Location:** `backend/internal/httpapi/routes_ai_settings.go:200-244,119-124`; `internal/ai/ollama.go:109-124`
- **Evidence:** `baseUrl` from the query string / request body is fetched with
  no scheme/host validation; stored values are never validated on write. Both
  routes are admin-only, so no privilege boundary is crossed directly; the
  risk is as a CSRF/XSS amplifier probing internal Docker-network hosts, with
  reachability leaking via error text.
- **Recommendation:** Validate scheme http/https and allowlist expected
  private hosts on write and test.
- **Regression verification:** `?baseUrl=http://169.254.169.254/` as admin →
  400, no outbound probe.
- **Status:** Open · **Owner:** Unassigned

#### ASI-3-008: MinIO credentials default to `beeztrackz:beeztrackz` instead of being required

- **Check:** Security, supply chain, privacy, and data integrity
- **Confidence:** High
- **Location:** `backend/internal/config/config.go:44-45`
- **Evidence:** Unlike `SESSION_SECRET`/`DATABASE_URL` (required, `config.go:54-59`),
  MinIO creds silently fall back. Harmless while MinIO stays on the private
  compose network; an inconsistency in an otherwise fail-fast config.
- **Recommendation:** Require both variables, matching the `SESSION_SECRET`
  treatment.
- **Status:** Open · **Owner:** Unassigned

#### ASI-3-009: `secureCookies()` silently emits non-Secure cookies when `APP_URL` is misconfigured

- **Check:** Security, supply chain, privacy, and data integrity
- **Confidence:** High
- **Location:** `backend/internal/httpapi/routes_auth.go:34-36`; `backend/internal/config/config.go:49`
- **Evidence:** `Secure` derives from `strings.HasPrefix(AppURL, "https://")`
  and `APP_URL` defaults to `http://localhost:3000`; a TLS deployment that
  forgets the var issues the 30-day session cookie without `Secure`, silently.
- **Recommendation:** Startup warning (or refusal) when `APP_URL` is
  non-loopback and not https.
- **Status:** Open · **Owner:** Unassigned

#### ASI-3-010: GitHub Actions pinned by tag, not SHA

- **Check:** Security, supply chain, privacy, and data integrity
- **Confidence:** High
- **Location:** `.github/workflows/deploy.yml:32-90` (`actions/*@v4/v5`, `docker/*@v3/v6`)
- **Evidence:** All first-party orgs; workflow permissions are correctly
  minimal (`contents: read, packages: write`). Risk is amplified by
  ASI-7-001 (a poisoned image would be auto-pulled).
- **Recommendation:** Pin to commit SHAs or enable Dependabot for workflows.
- **Status:** Open · **Owner:** Unassigned

#### ASI-1-006: Public honey-story page formats date-only values with `new Date()` — can display the previous day

- **Check:** Correctness and AI-slop indicators
- **Confidence:** Medium
- **Location:** `frontend/src/app/honey/[slug]/page.tsx:78-85`
- **Evidence:** `"2026-07-01"` parses as UTC midnight and server-renders in
  the container's timezone; any TZ west of UTC shows June 30. The rest of the
  app avoids this (`features/hives/lib.ts` `parseApiDate`,
  `features/honey/format.ts` with `timeZone: "UTC"`) — this page is the one
  outlier.
- **Recommendation:** Reuse the UTC-pinned formatting used elsewhere.
- **Regression verification:** Container `TZ=America/New_York`, story with
  `harvestDate: "2026-07-01"` renders "July 1, 2026".
- **Status:** Open · **Owner:** Unassigned

#### ASI-1-007: Empty/whitespace hive references fuzzy-match the wrong hive in transcription review

- **Check:** Correctness and AI-slop indicators
- **Confidence:** Medium
- **Location:** `backend/internal/ai/parser.go:405-409`
- **Evidence:** A whitespace `hiveReference` trims to `""` and
  `strings.Contains(label, "")` is true for every label — the inspection
  pre-selects the first hive (same if any hive has an empty position label).
  User-reviewed suggestion only, but pre-selects wrong.
- **Recommendation:** `if ref == "" || label == "" { continue }`.
- **Regression verification:** Unit test with `hiveReference: " "` expects no
  match.
- **Status:** Open · **Owner:** Unassigned

#### ASI-1-008: Cancelled sales keep serials linked as "sold"

- **Check:** Correctness and AI-slop indicators
- **Confidence:** High
- **Location:** `backend/internal/httpapi/routes_honey.go:1205-1235`; `routes_serials.go:234-237`
- **Evidence:** Cancellation returns jars to inventory but never touches
  `jar_serials`; new links to cancelled sales are blocked, existing links
  persist with `sold_at` set — a jar physically back on the shelf still
  resolves as sold.
- **Recommendation:** Decide policy: unlink or annotate serials on
  cancellation.
- **Status:** Open · **Owner:** Unassigned

#### ASI-1-009: `jar_serials.sale_id ON DELETE SET NULL` contradicts its own CHECK constraint

- **Check:** Correctness and AI-slop indicators
- **Confidence:** High
- **Location:** `backend/internal/db/migrations/00009_jar_serial_traceability.sql:19-30`
- **Evidence:** `ON DELETE SET NULL` (comment: "the serial survives as
  unsold") + `CHECK ((sale_id IS NULL) = (sold_at IS NULL))` — a sale-row
  delete would null only `sale_id`, violating the CHECK and erroring. Latent
  (no endpoint deletes sales) and fails safe, but the documented behavior is
  unachievable.
- **Recommendation:** Trigger clearing `sold_at`/`linked_by`, or change to
  RESTRICT and fix the comment.
- **Status:** Open · **Owner:** Unassigned

#### ASI-1-010: Minor correctness cluster (backend)

- **Check:** Correctness and AI-slop indicators
- **Confidence:** High
- **Location:** see bullets
- **Evidence / impact:**
  - `routes_honey.go:252-280` — jarring reads `honey_oz` on the pool *before*
    `Begin`; a concurrent jar-size edit can produce `amount_lbs` from stale oz.
  - `routes_commerce.go:365-374` — lot update lets `honey_weight_lbs` drop
    below the already-bottled total; existing runs then exceed capacity and
    future runs 400. A floor at `alreadyBottledLbs` is cheap.
  - `routes_commerce.go:1556` — market-day reconciliation casts timestamptz in
    the DB session timezone while inputs parse server-local; near-midnight
    sales can land on the adjacent day.
  - `routes_harvest_sessions.go:316-338` — the session-query error is checked
    after the hive lookup; a non-NoRows DB error returns the misleading "hive
    must belong to the harvest session apiary".
  - `00005_ledger_integrity.sql:36` — run-link backfill matches dates in UTC
    while movement dates were parsed local; evening-entered legacy movements
    can miss their run link (benign: link stays NULL).
- **Recommendation:** Fix opportunistically alongside neighboring work.
- **Status:** Open · **Owner:** Unassigned

#### ASI-5-008: Offline receipts are keyed only by client-supplied UUID; latent nil-principal deref

- **Check:** Reliability, concurrency, and state consistency
- **Confidence:** Medium
- **Location:** `backend/internal/httpapi/middleware_offline.go:188-253,210-213`
- **Evidence:** Receipts are scoped to `(user_id, mutation_id)` — no
  cross-user exposure — but a replay never checks that method/path/body match
  the original, so a client bug or UUID collision returns request A's response
  to request B and B's write never happens. `principalFrom(r)` is dereferenced
  without a nil check; safe only while the middleware stays mounted after
  `requireSession`.
- **Recommendation:** Store a hash of `(method, path, body)` and 409 on
  mismatch; add a nil guard.
- **Status:** Open · **Owner:** Unassigned

#### ASI-5-009: Reliability cluster (worker/API edges)

- **Check:** Reliability, concurrency, and state consistency
- **Confidence:** High
- **Location:** see bullets
- **Evidence / impact:**
  - `routes_photos.go:171-175` — photo is durably created, then an enqueue
    failure (Redis down) returns 500; client re-uploads → duplicate photo, and
    the first never gets thumbnails (no repair sweep exists).
  - `internal/jobs/transcribe.go:27-48` — status flaps `failed`→`processing`
    across retries; if the final attempt's context is canceled the failure
    write itself fails and the row is stuck `processing` forever
    (`context.WithoutCancel` for the status write).
  - `cmd/migrate-legacy/main.go:152-171` — row-by-row copy with no
    transaction; a mid-copy failure leaves partial data the `existing > 0`
    guard then refuses to retry over. Operator-run tool; acceptable, worth a
    tx per table.
- **Recommendation:** Per bullet.
- **Status:** Open · **Owner:** Unassigned

#### ASI-6-003: Service-worker caches grow without bound and have no deploy-time versioning; 5-second soft timeout serves stale data silently

- **Check:** Performance and resource efficiency
- **Confidence:** High
- **Location:** `frontend/src/app/sw.js/route.ts:2-3,251-267,260,274-293,372-390`
- **Evidence:** Cache names hardcode `-v2`; runtime handlers cache every OK
  `/api/v1/*` GET (including photo bytes) and `/_next/static/` chunks with no
  eviction — stale entries accumulate across deploys until the literal name
  string is bumped. The network-first race rejects at 5 s and serves cache
  with no staleness signal, discarding the still-inflight fresh response —
  rural links routinely exceed 5 s. (Scoping itself is safe: same-origin only,
  auth/access/settings excluded, logout clears the data cache.)
- **Recommendation:** Interpolate a build id into the cache names (the SW is
  a template string — easy); consider caching the late response and/or a
  staleness indicator.
- **Status:** Open · **Owner:** Unassigned

#### ASI-3-011: `reorderUrl` rendered into `href` without scheme validation on the public page

- **Check:** Security, supply chain, privacy, and data integrity
- **Confidence:** High
- **Location:** `frontend/src/app/honey/[slug]/page.tsx:215-217,253-264`
- **Evidence:** Owner-entered value lands directly in `<a href>`; a
  `javascript:` value would execute for any public QR visitor. Requires a
  compromised owner/API, but `^https?://` validation is one line.
- **Status:** Open · **Owner:** Unassigned

#### ASI-7-004: Deployment hardening cluster

- **Check:** Deployment, migration, and rollback readiness
- **Confidence:** High
- **Location:** see bullets
- **Evidence / impact:**
  - `backend/Dockerfile:10-14`, `frontend/Dockerfile:13-20` — runtime
    containers run as root (the legacy root Dockerfile did this right; the
    rewrite regressed). Add `USER nobody` / the `node` user.
  - `docker-compose.prod.yml:120,126` — `speaches:latest-cpu` and
    `minio/minio:latest` unpinned with `restart: unless-stopped`; MinIO has
    shipped breaking releases. Pin versions.
  - `docker-compose.prod.yml` — `api`/`worker`/`web`/`whisper` have no
    healthchecks (the backend's `/healthz` at `router.go:32` is unused, and
    always returns `ok` without checking DB/Redis/MinIO — pair with a
    `pool.Ping` readiness probe); no resource limits anywhere, and whisper
    alone loads a ~1.6 GB model. Gate `web` on `service_healthy`.
- **Status:** Open · **Owner:** Unassigned

#### ASI-8-001: Legacy root stack still tracked (known; roadmap item exists)

- **Check:** Maintainability, observability, and structure
- **Confidence:** High
- **Location:** repo root: `package.json`, `package-lock.json`, `drizzle/`, `Dockerfile`, `docker-compose.yml`, `docker-entrypoint.sh`, `next.config.ts`, `scripts/`, `.prompts/`, etc.
- **Evidence:** Two Dockerfiles and two migration systems in one repo; the
  legacy root `Dockerfile` still runs an unpinned `npx --yes esbuild` at build
  time and its entrypoint runs the *drizzle* migrator — a future
  misconfiguration could run it against the new DB. Already tracked on the
  roadmap ("Retire the legacy stack"); listed here for completeness with the
  concrete risk.
- **Recommendation:** Complete the roadmap item in one deletion commit.
- **Status:** Open (pre-existing, tracked) · **Owner:** Unassigned

#### ASI-8-002: Frontend minor cluster

- **Check:** Maintainability, observability, and structure
- **Confidence:** High
- **Location:** see bullets
- **Evidence / impact:**
  - `frontend/src/lib/api.ts:45-79` + `app/(app)/layout.tsx:21-25` — no global
    401 handling and the auth-status query effectively never re-runs; after
    session expiry the user stays in the app with failing toasts and can fill
    forms that will be lost. (Feeds the ASI-5-002 scenario.) Redirect to
    /login on 401 for non-auth endpoints.
  - `use-audio-recorder.ts:171-179` — latent `reset()` race resurrects a
    discarded take if ever called mid-recording; currently unreachable from
    the UI. Detach `onstop` in `reset`.
  - `canvas/lib/tiles.ts:12` — satellite layer sends apiary tile coordinates
    to arcgisonline.com; deliberate feature, worth a privacy note in docs.
- **Status:** Open · **Owner:** Unassigned

## Check Results

| Check | Result | Notes |
|-------|--------|-------|
| 1. Correctness and AI-slop indicators | Findings | 1 High (jarring reversal), 4 Medium, 5 Low. Money/cents migration verified correct end to end; single-source on-hand formulas verified; the shipped ledger claims hold everywhere except the reversal path. |
| 2. Verification and test quality | Findings | 1 Medium: jobs/recs/auth/config/storage have zero tests. CI gates images on the full DB-backed suite + frontend lint/build with no bypass. |
| 3. Security, supply chain, privacy, and data integrity | Findings | 0 High. 6 Medium, 5 Low. No SQLi, no path traversal, no committed secrets, authz model consistently enforced, OIDC flow correct (state/nonce/PKCE), API tokens hashed, AI keys masked, logs clean. |
| 4. Filesystem, network, and customer-environment safety | Findings | 1 High (unbounded upload), 1 Medium (receipts growth). Photo upload path has proper size caps; MinIO orphan-compensation on upload failure present. |
| 5. Reliability, concurrency, and state consistency | Findings | 3 High (offline replay double-execute; login queue wipe; queue wedging), 4 Medium, 2 Low. Migration advisory-locking and graceful shutdown are correct; equipment ledger locking verified sound. |
| 6. Performance and resource efficiency | Findings | 2 Medium (image bomb, uncapped AI reads), 1 Low (SW cache growth). No N+1 or unbounded-result issues surfaced on reviewed hot paths. |
| 7. Deployment, migration, and rollback readiness | Findings | 3 Medium (`:latest` float, no backup/rollback procedure, dead webhook), 1 Low cluster (root containers, unpinned images, missing healthchecks). Migration mechanics (advisory lock, worker skip) verified sound; the missing piece is process, not code. |
| 8. Maintainability, observability, and structure | Findings | 2 Low (legacy root stack — already tracked; frontend minor cluster). Conventions are consistent; docs are unusually good (specs, integration notes, roadmap). |
| Module: Web and User Interface | Findings | Covered in checks 1/5/6 (offline queue, date shift, $0 sales, parseCents). Client-side controls verified not to substitute for server authz. |
| Module: Infrastructure, Container, and Cloud | Findings | Covered in checks 3/7. Prod network exposure is clean (no published ports; traefik-only). |
| Module: Database and Data Pipeline | Findings | Covered in checks 1/5 (migrations verified; 00004 sequencing transaction-safe; 00006 trigger design sound; 00009 CHECK contradiction). |
| Module: AI and Model-Integrated Systems | Findings | Covered in checks 4/5/6 (whisper self-install, uncapped reads, parser hive-match). Model output treated as reviewable suggestions, not autonomous writes — correct design. |

## Limitations and Follow-up

- **Not executed:** DB-backed integration tests locally (CI covers them),
  `govulncheck`, `npm audit`, any runtime/container verification (local docker
  context points at the production NAS — deliberately untouched). A dependency
  vulnerability scan should be run once `govulncheck` is installed:
  `go install golang.org/x/vuln/cmd/govulncheck@latest && govulncheck ./...`
  from `backend/`.
- **Depth:** the 69 frontend feature files were swept for defect classes
  (money, dates, state machines, auth, offline), not exhaustively line-by-line;
  the canvas/konva feature and report views got the lightest coverage.
- **Recommended order of attack:** (1) the offline-queue trio ASI-5-001/002/003
  plus ASI-5-005 — they share a test harness and together make offline
  market-day sync trustworthy; (2) ASI-1-001 jarring-reversal stock check;
  (3) ASI-4-001 upload bound; (4) the security mediums ASI-3-001…006; then the
  deployment process items ASI-7-001…003, which are configuration/docs rather
  than code.
- All open findings have been added to `docs/product-roadmap.md` under
  "ASI review backlog (2026-08-04)".
