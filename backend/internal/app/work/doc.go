// Package work is the WorkItem projection: the one server-side answer to
// "what is there to do?", replacing the two assemblers that answered it
// separately and differently (the client-side useFieldWork hook and the
// server-side yardQueue handler).
//
// It is defined by docs/plans/2026-09-03-workflow-reset-design.md §4. The
// package is deliberately pure: it takes already-read facts ([Inputs]) and
// returns a projection ([Build]). Reading those facts stays at the transport
// edge (backend/internal/httpapi/routes_work.go) so the lockout walk
// (lockout.go) and the feeding-status evaluation (routes_feedings_status.go)
// keep one implementation each instead of being duplicated here.
//
// What the projection owns:
//
//   - Stable ids (§4.3). Every item is keyed on a durable primary key, so
//     snooze, dismiss, keyboard focus across a refetch, and offline receipt
//     correlation all have something to hold. The yard queue had none.
//
//   - The feeder_check rule (§4.6), in one place with one behaviour. Both
//     old assemblers dropped feeder_check unconditionally; this one drops it
//     only when a feeding item for the same hive is actually present. See
//     [applyFeederCheckRule] — that is a deliberate behaviour change.
//
//   - Ordering (§4.7), ported from yardQueueRank. Today's "needs attention"
//     versus "today" split is a grouping over that one rank rather than a
//     second, independent rule in a React hook.
//
//   - Per-command authorization (§4.4, §5.3), evaluated against the extended
//     [app.Actor] rather than left to chi middleware. A viewer may see an
//     item for an apiary they can read and must be told, per command, that
//     they may not act.
//
//   - Offline disposition (§4.4), computed by asking the caller's
//     [OfflinePredicate] — in production the same offline route manifest the
//     service worker is generated from — so the projection can never
//     advertise a queueable command the service worker would refuse.
package work
