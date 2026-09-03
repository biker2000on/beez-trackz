// Package sales owns the sale lifecycle as it touches stock: the reservation
// a draft or pending line makes, the sale_consume an applied sale records, the
// reversal a cancel or unapply records, and the consignment transfers,
// returns, and settlement shrink that move finished goods between home and a
// consignee.
//
// Decision 2 of docs/plans/2026-09-01-inventory-ledger-design.md: a draft
// sale records no operation. Its lines are a reservation, which is a query
// over sale_items (review A2), and stock validation goes through
// inventory.Service.CheckAvailable so two drafts racing for the last jars
// serialize on the same tuple locks a sale does.
//
// The commands here own the outer app.UnitOfWork and take domain row locks
// (sales, hives) before calling the inventory service, never after — the
// order app/inventory/doc.go documents.
package sales
