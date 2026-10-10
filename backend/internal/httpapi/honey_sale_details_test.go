package httpapi

import (
	"context"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
)

// PATCH /sales/{id}/details: who a sale was to, and its context, can be
// corrected after the fact without moving a jar or a cent.

func seedSaleCustomer(t *testing.T, server *Server, name, company string) uuid.UUID {
	t.Helper()
	var id uuid.UUID
	if err := server.pool.QueryRow(context.Background(), `
		INSERT INTO customers (name, company_name) VALUES ($1, NULLIF($2, '')) RETURNING id`,
		name, company).Scan(&id); err != nil {
		t.Fatalf("seed customer: %v", err)
	}
	return id
}

func patchSaleDetails(
	t *testing.T, server *Server, saleID string, body map[string]any,
) (int, map[string]any) {
	t.Helper()
	response, decoded := call(t, server.honeyUpdateSaleDetails, adminRequest(
		http.MethodPatch, "/api/v1/sales/"+saleID+"/details", body, "id", saleID))
	return response.Code, decoded
}

type saleDetailsRow struct {
	CustomerID   *uuid.UUID
	CustomerName *string
	Location     *string
	Notes        *string
}

func readSaleDetails(t *testing.T, server *Server, saleID string) saleDetailsRow {
	t.Helper()
	var row saleDetailsRow
	if err := server.pool.QueryRow(context.Background(), `
		SELECT customer_id, customer_name, location, notes FROM sales WHERE id=$1`, saleID).
		Scan(&row.CustomerID, &row.CustomerName, &row.Location, &row.Notes); err != nil {
		t.Fatalf("read sale details: %v", err)
	}
	return row
}

// saleMoneyAndLines is everything a details edit must leave alone.
type saleMoneyAndLines struct {
	Status     string
	Total      int64
	Paid       int64
	Discount   int64
	Applied    bool
	Lines      string
	Operations int
}

func readSaleMoneyAndLines(t *testing.T, server *Server, saleID string) saleMoneyAndLines {
	t.Helper()
	var snap saleMoneyAndLines
	if err := server.pool.QueryRow(context.Background(), `
		SELECT s.order_status, s.total_amount_cents, s.amount_paid_cents, s.discount_amount_cents,
		       s.physical_applied_at IS NOT NULL,
		       COALESCE((SELECT string_agg(si.kind || ':' || si.quantity || '@' || si.unit_price_cents, ',' ORDER BY si.id)
		                 FROM sale_items si WHERE si.sale_id = s.id), ''),
		       (SELECT COUNT(*)::int FROM inventory_operations o WHERE o.source_id = s.id)
		FROM sales s WHERE s.id = $1`, saleID).
		Scan(&snap.Status, &snap.Total, &snap.Paid, &snap.Discount, &snap.Applied,
			&snap.Lines, &snap.Operations); err != nil {
		t.Fatalf("read sale money and lines: %v", err)
	}
	return snap
}

func recordPaidJarSale(t *testing.T, server *Server, customerID *uuid.UUID, quantity int) string {
	t.Helper()
	jarSizeID := seedJarSize(t, server, "Pint", 16, 1200)
	seedHarvest(t, server, 100)
	lotID := jarStock(t, server, jarSizeID, 10)
	body := map[string]any{
		"date":        time.Now().Format("2006-01-02"),
		"orderStatus": "paid",
		"location":    "Farm stand",
		"lines": []map[string]any{
			{"jarSizeId": jarSizeID.String(), "harvestLotId": lotID.String(), "quantity": quantity, "unitPrice": 12},
		},
	}
	if customerID != nil {
		body["customerId"] = customerID.String()
	}
	response, saleBody := call(t, server.honeyRecordSale, adminRequest(
		http.MethodPost, "/api/v1/sales", body))
	if response.Code != http.StatusCreated {
		t.Fatalf("record sale = %d %v", response.Code, saleBody)
	}
	saleID, _ := saleBody["id"].(string)
	if saleID == "" {
		t.Fatalf("no sale id in %v", saleBody)
	}
	return saleID
}

func TestSaleDetailsChangeTheCustomerOfAPaidSaleOnly(t *testing.T) {
	server := honeyTestServer(t)
	first := seedSaleCustomer(t, server, "Ann Buyer", "")
	second := seedSaleCustomer(t, server, "Jane Doe", "Carolina Pedal Works")
	saleID := recordPaidJarSale(t, server, &first, 4)

	before := readSaleMoneyAndLines(t, server, saleID)
	if before.Status != "paid" || !before.Applied || before.Operations == 0 {
		t.Fatalf("fixture sale is not a paid, applied sale: %+v", before)
	}
	inventory, _ := server.honeyJarInventory(context.Background())
	onHandBefore := inventory[0].OnHand

	code, body := patchSaleDetails(t, server, saleID, map[string]any{
		"customerId": second.String(),
		"notes":      "  Picked up for the shop's open house  ",
	})
	if code != http.StatusOK || body["success"] != true {
		t.Fatalf("edit details = %d %v", code, body)
	}

	row := readSaleDetails(t, server, saleID)
	if row.CustomerID == nil || *row.CustomerID != second {
		t.Errorf("customer_id = %v, want %v", row.CustomerID, second)
	}
	// The stored name is a snapshot of the sale name — the company when the
	// customer has one (SaleCustomerName):
	// that is what the Folio description is built from.
	if row.CustomerName == nil || *row.CustomerName != "Carolina Pedal Works" {
		t.Errorf("customer_name = %v, want the company snapshot", row.CustomerName)
	}
	if row.Notes == nil || *row.Notes != "Picked up for the shop's open house" {
		t.Errorf("notes = %v, want the trimmed note", row.Notes)
	}
	if row.Location == nil || *row.Location != "Farm stand" {
		t.Errorf("location = %v, want it untouched", row.Location)
	}

	after := readSaleMoneyAndLines(t, server, saleID)
	if after != before {
		t.Errorf("details edit moved money, lines, status or inventory:\n before %+v\n after  %+v", before, after)
	}
	inventory, _ = server.honeyJarInventory(context.Background())
	if inventory[0].OnHand != onHandBefore {
		t.Errorf("on hand = %d after a details edit, want %d", inventory[0].OnHand, onHandBefore)
	}

	// Customer stats follow the sale: it now counts for the second customer.
	var firstOrders, secondOrders int
	if err := server.pool.QueryRow(context.Background(), `
		SELECT COUNT(*) FILTER (WHERE customer_id=$1), COUNT(*) FILTER (WHERE customer_id=$2)
		FROM sales WHERE order_status <> 'cancelled'`, first, second).
		Scan(&firstOrders, &secondOrders); err != nil {
		t.Fatalf("count customer orders: %v", err)
	}
	if firstOrders != 0 || secondOrders != 1 {
		t.Errorf("orders first=%d second=%d, want 0 and 1", firstOrders, secondOrders)
	}

	// The read model the receipt and lists use shows the new customer.
	sales, err := server.honeyListSales(context.Background())
	if err != nil {
		t.Fatalf("list sales: %v", err)
	}
	if sales[0].CustomerID == nil || *sales[0].CustomerID != second ||
		sales[0].CustomerName == nil || *sales[0].CustomerName != "Carolina Pedal Works — Jane Doe" {
		t.Errorf("listed sale customer = %v / %v", sales[0].CustomerID, sales[0].CustomerName)
	}

	var events int
	if err := server.pool.QueryRow(context.Background(), `
		SELECT COUNT(*) FROM domain_events
		WHERE aggregate_type='sale' AND aggregate_id=$1 AND event_type='sale.details_updated'`,
		saleID).Scan(&events); err != nil {
		t.Fatalf("count domain events: %v", err)
	}
	if events != 1 {
		t.Errorf("sale.details_updated events = %d, want 1", events)
	}
}

func TestSaleDetailsClearTheCustomerAndUseAWalkInName(t *testing.T) {
	server := honeyTestServer(t)
	customer := seedSaleCustomer(t, server, "Ann Buyer", "")
	saleID := recordPaidJarSale(t, server, &customer, 2)

	// Clearing the saved customer clears the receipt name with it.
	code, body := patchSaleDetails(t, server, saleID, map[string]any{"customerId": nil})
	if code != http.StatusOK {
		t.Fatalf("clear customer = %d %v", code, body)
	}
	row := readSaleDetails(t, server, saleID)
	if row.CustomerID != nil || row.CustomerName != nil {
		t.Errorf("after clearing: customer_id=%v customer_name=%v, want both null", row.CustomerID, row.CustomerName)
	}

	// A walk-in with no saved customer: free text only.
	code, body = patchSaleDetails(t, server, saleID, map[string]any{
		"customerId":   nil,
		"customerName": "Regular in the red truck",
		"location":     "Saturday market",
	})
	if code != http.StatusOK {
		t.Fatalf("walk-in name = %d %v", code, body)
	}
	row = readSaleDetails(t, server, saleID)
	if row.CustomerID != nil || row.CustomerName == nil || *row.CustomerName != "Regular in the red truck" {
		t.Errorf("walk-in: customer_id=%v customer_name=%v", row.CustomerID, row.CustomerName)
	}
	if row.Location == nil || *row.Location != "Saturday market" {
		t.Errorf("location = %v, want Saturday market", row.Location)
	}

	// Notes alone, then cleared with an explicit null; the name stays.
	if code, body = patchSaleDetails(t, server, saleID, map[string]any{"notes": "Owes a jar back"}); code != http.StatusOK {
		t.Fatalf("notes = %d %v", code, body)
	}
	if row = readSaleDetails(t, server, saleID); row.Notes == nil || *row.Notes != "Owes a jar back" {
		t.Errorf("notes = %v", row.Notes)
	}
	if code, body = patchSaleDetails(t, server, saleID, map[string]any{"notes": nil}); code != http.StatusOK {
		t.Fatalf("clear notes = %d %v", code, body)
	}
	row = readSaleDetails(t, server, saleID)
	if row.Notes != nil {
		t.Errorf("notes = %v, want cleared", row.Notes)
	}
	if row.CustomerName == nil || *row.CustomerName != "Regular in the red truck" {
		t.Errorf("a notes-only edit changed the customer name to %v", row.CustomerName)
	}
}

func TestSaleDetailsRejectBadInput(t *testing.T) {
	server := honeyTestServer(t)
	saleID := recordPaidJarSale(t, server, nil, 1)
	before := readSaleDetails(t, server, saleID)

	cases := []struct {
		name string
		body map[string]any
		want int
	}{
		{"unknown customer", map[string]any{"customerId": uuid.NewString()}, http.StatusBadRequest},
		{"malformed customer id", map[string]any{"customerId": "not-a-uuid"}, http.StatusBadRequest},
		{"unknown field", map[string]any{"totalAmount": 1}, http.StatusBadRequest},
		{"nothing to change", map[string]any{}, http.StatusBadRequest},
		{"non-string notes", map[string]any{"notes": 7}, http.StatusBadRequest},
	}
	for _, test := range cases {
		code, body := patchSaleDetails(t, server, saleID, test.body)
		if code != test.want {
			t.Errorf("%s = %d %v, want %d", test.name, code, body, test.want)
		}
	}
	if after := readSaleDetails(t, server, saleID); after.CustomerID != before.CustomerID ||
		(after.CustomerName == nil) != (before.CustomerName == nil) {
		t.Errorf("a refused edit wrote anyway: %+v -> %+v", before, after)
	}

	code, body := patchSaleDetails(t, server, uuid.NewString(), map[string]any{"notes": "x"})
	if code != http.StatusNotFound {
		t.Errorf("unknown sale = %d %v, want 404", code, body)
	}
}

func TestSaleDetailsRefuseACancelledSale(t *testing.T) {
	server := honeyTestServer(t)
	saleID := recordPaidJarSale(t, server, nil, 1)
	response, body := call(t, server.honeyCancelSale, adminRequest(
		http.MethodDelete, "/api/v1/sales/"+saleID, nil, "id", saleID))
	if response.Code != http.StatusOK {
		t.Fatalf("cancel = %d %v", response.Code, body)
	}

	code, body := patchSaleDetails(t, server, saleID, map[string]any{"notes": "too late"})
	if code != http.StatusConflict {
		t.Fatalf("edit a cancelled sale = %d %v, want 409", code, body)
	}
	if msg, _ := body["error"].(string); !strings.Contains(msg, "cancelled") {
		t.Errorf("refusal %q does not say the sale is cancelled", msg)
	}
	if row := readSaleDetails(t, server, saleID); row.Notes != nil {
		t.Errorf("notes = %v on a cancelled sale", row.Notes)
	}
}

func TestSaleDetailsKeepAConsignmentSettlementsCustomer(t *testing.T) {
	server := honeyTestServer(t)
	ctx := context.Background()
	store := seedSaleCustomer(t, server, "Bike Shop", "")
	other := seedSaleCustomer(t, server, "Someone Else", "")
	saleID := uuid.New()
	locationID := uuid.New()
	if _, err := server.pool.Exec(ctx, `
		INSERT INTO sales (id, date, customer_id, customer_name, location, channel, payment_method,
			total_amount_cents, amount_paid_cents, order_status, order_number, stock_location_id, physical_applied_at)
		VALUES ($1, now(), $2, 'Bike Shop', 'Bike Shop', 'consignment', 'check', 2400, 2400, 'paid', 'BT-CONSIGN', $3, now())`,
		saleID, store, locationID); err != nil {
		t.Fatalf("seed consignment sale: %v", err)
	}
	if _, err := server.pool.Exec(ctx, `
		INSERT INTO consignment_settlements (location_id, period_start, period_end, reported_at,
			sale_id, amount_owed_cents, amount_paid_cents)
		VALUES ($1, current_date - 30, current_date, now(), $2, 2400, 2400)`,
		locationID, saleID); err != nil {
		t.Fatalf("seed settlement: %v", err)
	}

	for _, body := range []map[string]any{
		{"customerId": other.String()},
		{"customerId": nil},
		{"customerName": "Walk-in"},
		{"location": "Somewhere else"},
	} {
		code, response := patchSaleDetails(t, server, saleID.String(), body)
		if code != http.StatusConflict {
			t.Errorf("consignment edit %v = %d %v, want 409", body, code, response)
		}
		if msg, _ := response["error"].(string); !strings.Contains(msg, "consignment") {
			t.Errorf("refusal %q does not name the consignment rule", msg)
		}
	}
	row := readSaleDetails(t, server, saleID.String())
	if row.CustomerID == nil || *row.CustomerID != store {
		t.Errorf("customer_id = %v, want the store's customer kept", row.CustomerID)
	}

	// Notes are still the operator's to write.
	code, response := patchSaleDetails(t, server, saleID.String(), map[string]any{"notes": "Shelf by the register"})
	if code != http.StatusOK {
		t.Fatalf("consignment notes = %d %v", code, response)
	}
	if row = readSaleDetails(t, server, saleID.String()); row.Notes == nil || *row.Notes != "Shelf by the register" {
		t.Errorf("notes = %v", row.Notes)
	}
}

func TestSaleDetailsRequeueAPushedSaleForFolio(t *testing.T) {
	fake := newFolioFake(t)
	server := gnucashTestServer(t, fake, fullMapping())
	jarSizeID := seedJarSize(t, server, "Pint", 16, 1200)
	saleID := seedAppliedSale(t, server, jarSizeID, 2, 1200)
	runSync(t, server)
	row := syncRowFor(t, server, SyncEntitySale, saleID)
	if row.SyncState != "synced" {
		t.Fatalf("fixture sale did not sync: %+v", row)
	}

	// Notes never reach Folio, so a notes-only edit leaves the row alone.
	code, body := patchSaleDetails(t, server, saleID.String(), map[string]any{"notes": "context only"})
	if code != http.StatusOK || body["folioPending"] != false {
		t.Fatalf("notes edit = %d %v", code, body)
	}
	if got := syncRowFor(t, server, SyncEntitySale, saleID).SyncState; got != "synced" {
		t.Errorf("sync state after a notes edit = %q, want synced", got)
	}

	// A new customer name changes the pushed description: pending, then an
	// UPDATE of the same transaction on the next sync.
	code, body = patchSaleDetails(t, server, saleID.String(), map[string]any{
		"customerId": nil, "customerName": "Hilltop Grocery",
	})
	if code != http.StatusOK || body["folioPending"] != true {
		t.Fatalf("customer edit = %d %v", code, body)
	}
	if got := syncRowFor(t, server, SyncEntitySale, saleID).SyncState; got != "pending" {
		t.Fatalf("sync state after a customer edit = %q, want pending", got)
	}
	report := runSync(t, server)
	posts, puts, _ := fake.counts()
	if posts != 1 || puts != 1 || report["updated"] != float64(1) {
		t.Fatalf("after the edit: %d posts, %d puts, report %v; want the one transaction updated", posts, puts, report)
	}
	row = syncRowFor(t, server, SyncEntitySale, saleID)
	if row.SyncState != "synced" {
		t.Errorf("row after re-push %+v", row)
	}
	if description := fake.bodyFor(t, row.ExternalID).Description; !strings.Contains(description, "Hilltop Grocery") {
		t.Errorf("pushed description %q does not carry the edited customer", description)
	}

	// A sale whose book has been retired stays in that book: the edit changes
	// Atlas only and never queues a push.
	if _, err := server.pool.Exec(context.Background(),
		`UPDATE gnucash_books SET retired_at = now() WHERE retired_at IS NULL`); err != nil {
		t.Fatalf("retire book: %v", err)
	}
	code, body = patchSaleDetails(t, server, saleID.String(), map[string]any{"customerName": "Someone Newer"})
	if code != http.StatusOK || body["folioPending"] != false {
		t.Fatalf("edit in a retired book = %d %v", code, body)
	}
	if got := syncRowFor(t, server, SyncEntitySale, saleID).SyncState; got != "synced" {
		t.Errorf("sync state of a retired-book sale = %q, want synced (never re-pushed)", got)
	}
}

// Recording a sale for a saved customer stores the customer's sale name —
// company first, else the contact's name — so the Folio push describes the
// sale by customer instead of falling back to its location. A typed receipt
// name with no saved customer is stored as typed. Screens still show the live
// customer record through the join.
func TestRecordSaleStoresTheSavedCustomersSaleName(t *testing.T) {
	server := honeyTestServer(t)
	company := seedSaleCustomer(t, server, "Jane Doe", "  Carolina Pedal Works ")
	person := seedSaleCustomer(t, server, " Ann Buyer ", "")
	jarSizeID := seedJarSize(t, server, "Pint", 16, 1200)
	seedHarvest(t, server, 100)
	lotID := jarStock(t, server, jarSizeID, 10)
	record := func(extra map[string]any) string {
		t.Helper()
		body := map[string]any{
			"date":        time.Now().Format("2006-01-02"),
			"orderStatus": "paid",
			"location":    "Farm stand",
			"lines": []map[string]any{
				{"jarSizeId": jarSizeID.String(), "harvestLotId": lotID.String(), "quantity": 1, "unitPrice": 12},
			},
		}
		for key, value := range extra {
			body[key] = value
		}
		response, saleBody := call(t, server.honeyRecordSale, adminRequest(
			http.MethodPost, "/api/v1/sales", body))
		if response.Code != http.StatusCreated {
			t.Fatalf("record sale = %d %v", response.Code, saleBody)
		}
		id, _ := saleBody["id"].(string)
		return id
	}

	row := readSaleDetails(t, server, record(map[string]any{"customerId": company.String()}))
	if row.CustomerName == nil || *row.CustomerName != "Carolina Pedal Works" {
		t.Errorf("with a company: customer_name = %v, want the trimmed company", row.CustomerName)
	}
	row = readSaleDetails(t, server, record(map[string]any{"customerId": person.String()}))
	if row.CustomerName == nil || *row.CustomerName != "Ann Buyer" {
		t.Errorf("without a company: customer_name = %v, want the trimmed name", row.CustomerName)
	}

	// A typed walk-in name with no saved customer stays exactly as typed.
	row = readSaleDetails(t, server, record(map[string]any{"customerName": "  Regular in the red truck "}))
	if row.CustomerID != nil || row.CustomerName == nil || *row.CustomerName != "Regular in the red truck" {
		t.Errorf("walk-in: customer_id=%v customer_name=%v, want the typed name", row.CustomerID, row.CustomerName)
	}

	// Screens keep showing the live customer record.
	sales, err := server.honeyListSales(context.Background())
	if err != nil {
		t.Fatalf("list sales: %v", err)
	}
	for _, sale := range sales {
		if sale.CustomerID != nil && *sale.CustomerID == company &&
			(sale.CustomerName == nil || *sale.CustomerName != "Carolina Pedal Works — Jane Doe") {
			t.Errorf("listed sale shows %v, want the live display name", sale.CustomerName)
		}
	}
}

// Editing a sale's customer uses the same rule: a contact without a company
// is stored by name.
func TestSaleDetailsStoreTheNameOfACustomerWithoutACompany(t *testing.T) {
	server := honeyTestServer(t)
	person := seedSaleCustomer(t, server, "Ann Buyer", "   ")
	saleID := recordPaidJarSale(t, server, nil, 1)

	code, body := patchSaleDetails(t, server, saleID, map[string]any{"customerId": person.String()})
	if code != http.StatusOK {
		t.Fatalf("edit details = %d %v", code, body)
	}
	row := readSaleDetails(t, server, saleID)
	if row.CustomerName == nil || *row.CustomerName != "Ann Buyer" {
		t.Errorf("customer_name = %v, want the customer's name", row.CustomerName)
	}
	if got, _ := body["customerName"].(string); got != "Ann Buyer" {
		t.Errorf("response customerName = %v, want the stored name", body["customerName"])
	}
}
