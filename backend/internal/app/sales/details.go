package sales

import (
	"context"
	"errors"

	"github.com/biker2000on/beez-trackz/backend/internal/app"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// UpdateSaleDetailsInput edits who a sale was to and the context written on
// it, after the fact. Each *Set flag says the field was present in the
// request; a present field with a nil value clears it. Absent fields keep
// their stored value.
//
// It is deliberately narrow: amounts, lines, inventory and status are never
// touched, so editing the details of a paid, fulfilled sale cannot move a jar
// or a cent.
type UpdateSaleDetailsInput struct {
	SaleID          uuid.UUID
	CustomerSet     bool
	CustomerID      *uuid.UUID
	CustomerNameSet bool
	CustomerName    *string
	LocationSet     bool
	Location        *string
	NotesSet        bool
	Notes           *string
}

type UpdateSaleDetailsResult struct {
	Success      bool       `json:"success"`
	ID           uuid.UUID  `json:"id"`
	CustomerID   *uuid.UUID `json:"customerId"`
	CustomerName *string    `json:"customerName"`
	Location     *string    `json:"location"`
	Notes        *string    `json:"notes"`
	// FolioPending is true when the edit changed the description of a sale
	// already pushed to the active Folio book, so the next sync updates it.
	FolioPending bool `json:"folioPending"`
}

// UpdateSaleDetails changes a sale's customer, receipt name, location and
// notes.
//
// Customer rules:
//   - customerId names a saved customer (it must exist). The stored
//     customer_name becomes the given customerName, or, when none is given,
//     a snapshot of the customer's sale name (SaleCustomerName: the company
//     when it has one, else the customer's name — the same rule RecordSale
//     uses). The snapshot
//     is what the Folio push describes the sale with; screens show the live
//     customer through the join either way.
//   - customerId null clears the saved customer; customer_name becomes the
//     given walk-in name, or null.
//   - customerName alone changes only the receipt name.
//
// A consignment settlement sale belongs to the store it settled: its customer
// is the store's linked customer and its location is the store. Those are
// refused here (change the store instead); its notes can still be edited.
//
// A cancelled sale is refused outright: it is struck from the record.
//
// Folio: the pushed description is built from customer_name, falling back to
// location. When either changes on a sale whose external_sync row is synced
// to the ACTIVE book (or not pinned to a book yet), the row goes back to
// pending, so the next sync PUTs the corrected description as an update of
// the same transaction. A row pinned to a retired book is left alone — that
// book is never written again (see routes_folio_books.go).
func UpdateSaleDetails(ctx context.Context, uow *app.UnitOfWork, in UpdateSaleDetailsInput) (UpdateSaleDetailsResult, error) {
	const op = "update sale details"
	out := UpdateSaleDetailsResult{ID: in.SaleID}
	if in.SaleID == uuid.Nil {
		return out, app.Invalid(op, "sale is required")
	}
	if !in.CustomerSet && !in.CustomerNameSet && !in.LocationSet && !in.NotesSet {
		return out, app.Invalid(op, "nothing to change: send customerId, customerName, location, or notes")
	}

	var (
		status, channel         string
		stockLocation, customer *uuid.UUID
		name, location, notes   *string
		settled                 bool
	)
	if err := uow.QueryRow(ctx, `
		SELECT order_status, channel, stock_location_id, customer_id, customer_name, location, notes,
		       EXISTS(SELECT 1 FROM consignment_settlements cs WHERE cs.sale_id = s.id)
		FROM sales s WHERE id = $1 FOR UPDATE`, in.SaleID).
		Scan(&status, &channel, &stockLocation, &customer, &name, &location, &notes, &settled); errors.Is(err, pgx.ErrNoRows) {
		return out, app.NotFound(op, "sale not found")
	} else if err != nil {
		return out, dbError(op, err)
	}
	if status == "cancelled" {
		return out, app.Conflict(op, "this sale is cancelled; a cancelled sale cannot be edited")
	}

	newCustomer, newName, newLocation, newNotes := customer, name, location, notes
	if in.CustomerSet {
		newCustomer = in.CustomerID
		newName = nil
		if in.CustomerID != nil {
			display, err := loadSaleCustomerName(ctx, uow, *in.CustomerID)
			if errors.Is(err, errCustomerNotFound) {
				return out, app.Invalid(op, "customer not found")
			} else if err != nil {
				return out, dbError(op, err)
			}
			newName = display
		}
	}
	if in.CustomerNameSet {
		if given := trim(in.CustomerName); given != nil || !in.CustomerSet || newCustomer == nil {
			// A blank name next to a saved customer keeps the snapshot.
			newName = given
		}
	}
	if in.LocationSet {
		newLocation = trim(in.Location)
	}
	if in.NotesSet {
		newNotes = trim(in.Notes)
	}

	customerChanged := !sameUUID(customer, newCustomer) || !sameString(name, newName)
	locationChanged := !sameString(location, newLocation)
	if (settled || (channel == "consignment" && stockLocation != nil)) && (customerChanged || locationChanged) {
		return out, app.Conflict(op, "this sale is a consignment settlement: its customer and location follow the store it was settled with; only its notes can be edited here")
	}

	if _, err := uow.Exec(ctx, `
		UPDATE sales SET customer_id = $2, customer_name = $3, location = $4, notes = $5
		WHERE id = $1`, in.SaleID, newCustomer, newName, newLocation, newNotes); err != nil {
		return out, dbError(op, err)
	}

	// Only what the Folio body is built from re-queues the push: notes never
	// reach Folio, and re-queuing an unchanged body would be a no-op anyway.
	if !sameString(name, newName) || locationChanged {
		tag, err := uow.Exec(ctx, `
			UPDATE external_sync es SET sync_state = 'pending'
			WHERE es.system = 'gnucash_web' AND es.entity_type = 'sale' AND es.entity_id = $1
			  AND es.sync_state = 'synced'
			  AND (es.book_id IS NULL OR EXISTS (
				SELECT 1 FROM gnucash_books b WHERE b.id = es.book_id AND b.retired_at IS NULL))`,
			in.SaleID)
		if err != nil {
			return out, dbError(op, err)
		}
		out.FolioPending = tag.RowsAffected() > 0
	}

	changed := []string{}
	if !sameUUID(customer, newCustomer) {
		changed = append(changed, "customerId")
	}
	if !sameString(name, newName) {
		changed = append(changed, "customerName")
	}
	if locationChanged {
		changed = append(changed, "location")
	}
	if !sameString(notes, newNotes) {
		changed = append(changed, "notes")
	}
	if err := uow.Emit(ctx, app.Event{AggregateType: "sale", AggregateID: in.SaleID, Type: "sale.details_updated", Payload: map[string]any{
		"changed":      changed,
		"customerId":   newCustomer,
		"customerName": newName,
		"location":     newLocation,
	}}); err != nil {
		return out, err
	}

	out.Success = true
	out.CustomerID, out.CustomerName, out.Location, out.Notes = newCustomer, newName, newLocation, newNotes
	return out, nil
}

func sameUUID(a, b *uuid.UUID) bool {
	if a == nil || b == nil {
		return a == nil && b == nil
	}
	return *a == *b
}

func sameString(a, b *string) bool {
	if a == nil || b == nil {
		return a == nil && b == nil
	}
	return *a == *b
}
