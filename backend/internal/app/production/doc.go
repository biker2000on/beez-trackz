// Package production owns the honey and product commands that change stock:
// harvest allocation, bottling, bulk draws, product batches, propolis
// harvests, and count adjustments. Each command owns the outer
// app.UnitOfWork, runs its beekeeping guards first (decision 7 of
// docs/plans/2026-09-01-inventory-ledger-design.md), then builds an operation
// with app/inventory/build and hands it to inventory.Service.
//
// Lock order is the one documented in app/inventory/doc.go: domain rows
// first, then the non-stock advisory locks, then the service's tuple locks.
// No command in this package takes a stock-motivated row lock; the inventory
// service is the only quantity locker (review A4).
package production
