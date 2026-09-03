// Package inventory owns the signed movement ledger and all quantity locks.
// It participates in an existing app.UnitOfWork and never starts or commits a
// transaction itself.
//
// # Global lock order
//
// Domain commands acquire every non-inventory lock before calling Record or
// CheckAvailable. The complete order is:
//
//  1. domain row locks, including honey harvest rows and then harvest lot rows;
//  2. existing non-stock advisory locks, including honeyBulkLockKey and
//     userSettingsLockKey (the honey order remains harvest -> lot -> bulk as
//     documented by honeyLockOrder in routes_commerce.go);
//  3. inventory tuple advisory locks, ordered by PostgreSQL hashtext(tuple),
//     with the tuple text as a deterministic collision tie-breaker.
//
// Once a tuple lock has been acquired, code must not go back to either prior
// class. This package subsumes those existing locks into one order; it does
// not replace them. Tuple locks are transaction-scoped and are therefore held
// until the outer unit of work commits or rolls back.
package inventory
