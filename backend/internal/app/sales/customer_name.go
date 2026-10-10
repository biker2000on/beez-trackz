package sales

import (
	"context"
	"errors"
	"strings"

	"github.com/biker2000on/beez-trackz/backend/internal/app"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// SaleCustomerName is the name a sale stores for a saved customer: the
// customer's company name when it has one, else the customer's own name, both
// trimmed. It is a snapshot taken when the sale is recorded or its customer is
// changed; the Folio push describes the sale with it (falling back to the
// location only when a sale names no customer at all). Screens keep showing the
// live customer record through the join.
//
// Migration 00014 (legacy 00067) backfills existing sales with the same rule
// in SQL (blank company and name count as missing).
func SaleCustomerName(companyName *string, name string) *string {
	if company := trim(companyName); company != nil {
		return company
	}
	return trim(&name)
}

// errCustomerNotFound is returned by loadSaleCustomerName for an unknown id.
var errCustomerNotFound = errors.New("customer not found")

// loadSaleCustomerName reads a saved customer and returns SaleCustomerName.
func loadSaleCustomerName(ctx context.Context, uow *app.UnitOfWork, customerID uuid.UUID) (*string, error) {
	var (
		company *string
		name    string
	)
	if err := uow.QueryRow(ctx, `SELECT company_name, name FROM customers WHERE id = $1`, customerID).
		Scan(&company, &name); errors.Is(err, pgx.ErrNoRows) {
		return nil, errCustomerNotFound
	} else if err != nil {
		return nil, err
	}
	return SaleCustomerName(company, name), nil
}

// consignmentSaleCustomerName is the name a consignment settlement sale stores:
// the store's name, unless the store is linked to a saved customer with a
// company name, in which case that company (the business the store is). A
// linked customer without a company keeps the store name — the contact person
// is not who the store's sales were to.
func consignmentSaleCustomerName(storeName string, linkedCompany *string) *string {
	if company := trim(linkedCompany); company != nil {
		return company
	}
	store := strings.TrimSpace(storeName)
	return &store
}
