package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/google/uuid"
)

// Consignment tests. The pure ones run everywhere; the ledger ones need
// TEST_DATABASE_URL and skip without it, like the rest of the honey suite.

// --- pure arithmetic -------------------------------------------------------

func TestStockOwedSplitStaysExactCents(t *testing.T) {
	t.Parallel()
	bps := 3000
	commissionShop := stockLocationRow{PriceBasis: "commission", CommissionBps: &bps}
	owed, commission := stockOwedSplit(commissionShop, 1200, nil)
	if owed != 840 || commission != 360 {
		t.Errorf("30%% of $12.00 split as owed=%d commission=%d, want 840/360", owed, commission)
	}
	// The two halves must always add back up to the shelf price, including
	// where the split does not land on a whole cent.
	for _, retail := range []money{1, 7, 99, 1233, 4999} {
		owed, commission := stockOwedSplit(commissionShop, retail, nil)
		if owed+commission != retail {
			t.Errorf("split of %d lost a cent: %d + %d", retail, owed, commission)
		}
	}

	retailShop := stockLocationRow{PriceBasis: "retail"}
	if owed, commission := stockOwedSplit(retailShop, 1200, nil); owed != 1200 || commission != 0 {
		t.Errorf("retail basis = %d/%d, want 1200/0", owed, commission)
	}

	wholesaleShop := stockLocationRow{PriceBasis: "wholesale_list"}
	list := money(700)
	if owed, commission := stockOwedSplit(wholesaleShop, 1200, &list); owed != 700 || commission != 500 {
		t.Errorf("wholesale basis = %d/%d, want 700/500", owed, commission)
	}
	// A list price above the shelf price must not owe the operator more than
	// the shop actually collected.
	above := money(1500)
	if owed, commission := stockOwedSplit(wholesaleShop, 1200, &above); owed != 1200 || commission != 0 {
		t.Errorf("list above shelf = %d/%d, want 1200/0", owed, commission)
	}
}

func TestStockLocationPayloadValidation(t *testing.T) {
	t.Parallel()
	if err := (&stockLocationPayload{}).normalize(); err == nil {
		t.Error("a nameless location was accepted")
	}
	commission := &stockLocationPayload{Name: "Bike shop", PriceBasis: "commission"}
	if err := commission.normalize(); err == nil {
		t.Error("the commission basis was accepted without a percentage")
	}
	wholesale := &stockLocationPayload{Name: "Bike shop", PriceBasis: "wholesale_list"}
	if err := wholesale.normalize(); err == nil {
		t.Error("the wholesale basis was accepted without a price list")
	}
	plain := &stockLocationPayload{Name: "  Bike shop  "}
	if err := plain.normalize(); err != nil {
		t.Fatalf("a plain location was rejected: %v", err)
	}
	if plain.Name != "Bike shop" || plain.PriceBasis != "retail" ||
		plain.SettlementCadence != "monthly" {
		t.Errorf("defaults not applied: %+v", plain)
	}
	if got := stockSlug("Joe's Bike Shop!"); got != "joe-s-bike-shop" {
		t.Errorf("stockSlug = %q", got)
	}

	over := 101.0
	if _, err := stockCommissionBps(&over); err == nil {
		t.Error("a commission above 100% was accepted")
	}
	thirty := 30.0
	bps, err := stockCommissionBps(&thirty)
	if err != nil || bps == nil || *bps != 3000 {
		t.Errorf("30%% = %v (%v), want 3000", bps, err)
	}
}

func TestStockPeriodBoundsAreHalfOpen(t *testing.T) {
	t.Parallel()
	start, end, err := stockPeriodBounds("2026-08-01", "2026-08-31")
	if err != nil {
		t.Fatalf("bounds: %v", err)
	}
	// A sale timestamped late on the 31st still belongs to August.
	late := time.Date(2026, 8, 31, 23, 59, 0, 0, time.Local)
	if late.Before(start) || !late.Before(end) {
		t.Errorf("%v fell outside [%v, %v)", late, start, end)
	}
	if _, _, err := stockPeriodBounds("2026-08-31", "2026-08-01"); err == nil {
		t.Error("a backwards period was accepted")
	}
}

// --- ledger ----------------------------------------------------------------

// seedShop creates a consignment location that keeps `commissionPercent` of
// every sale, linked to a customer the way the bike shop is.
func seedShop(t *testing.T, server *Server, name string, commissionPercent float64) uuid.UUID {
	t.Helper()
	var customerID uuid.UUID
	if err := server.pool.QueryRow(context.Background(),
		`INSERT INTO customers (name) VALUES ($1) RETURNING id`, name).Scan(&customerID); err != nil {
		t.Fatalf("seed customer: %v", err)
	}
	response, body := call(t, server.stockLocationCreate, adminRequest(
		http.MethodPost, "/api/v1/stock-locations", map[string]any{
			"name":              name,
			"isConsignment":     true,
			"customerId":        customerID.String(),
			"priceBasis":        "commission",
			"commissionPercent": commissionPercent,
			"settlementCadence": "monthly",
		}))
	if response.Code != http.StatusCreated {
		t.Fatalf("create location = %d %v", response.Code, body)
	}
	id, err := uuid.Parse(body["id"].(string))
	if err != nil {
		t.Fatalf("parse location id: %v", err)
	}
	return id
}

func transfer(
	t *testing.T,
	server *Server,
	locationID, jarSizeID uuid.UUID,
	quantity int,
) map[string]any {
	t.Helper()
	response, body := call(t, server.stockTransferCreate, adminRequest(
		http.MethodPost, "/api/v1/stock-locations/"+locationID.String()+"/transfers",
		map[string]any{
			"date": time.Now().Format("2006-01-02"),
			"lines": []map[string]any{
				{"jarSizeId": jarSizeID.String(), "quantity": quantity},
			},
		}, "id", locationID.String()))
	if response.Code != http.StatusCreated {
		t.Fatalf("transfer = %d %v", response.Code, body)
	}
	return body
}

// shelfCount reads what one location holds of one jar size.
func shelfCount(t *testing.T, server *Server, locationID, jarSizeID uuid.UUID) int {
	t.Helper()
	shelf, _, err := server.stockLocationShelf(context.Background(), server.pool, locationID)
	if err != nil {
		t.Fatalf("shelf: %v", err)
	}
	for _, row := range shelf {
		if row.JarSizeID != nil && *row.JarSizeID == jarSizeID {
			return row.OnHand
		}
	}
	return 0
}

func homeLocation(t *testing.T, server *Server) uuid.UUID {
	t.Helper()
	id, err := stockHomeLocationID(context.Background(), server.pool)
	if err != nil {
		t.Fatalf("home location: %v", err)
	}
	return id
}

func globalOnHand(t *testing.T, server *Server, jarSizeID uuid.UUID) int {
	t.Helper()
	inventory, err := server.honeyJarInventory(context.Background())
	if err != nil {
		t.Fatalf("inventory: %v", err)
	}
	for _, row := range inventory {
		if row.JarSizeID == jarSizeID {
			return row.OnHand
		}
	}
	return 0
}

// A transfer is not a sale. It must move stock and touch nothing else.
func TestTransferMovesStockWithoutRecognisingRevenue(t *testing.T) {
	server := honeyTestServer(t)
	jarSizeID := seedJarSize(t, server, "Pint", 16, 1200)
	seedHarvest(t, server, 100)
	jarStock(t, server, jarSizeID, 24)
	shopID := seedShop(t, server, "Bike shop", 30)

	transfer(t, server, shopID, jarSizeID, 24)

	ctx := context.Background()
	var sales, saleItems int
	if err := server.pool.QueryRow(ctx, `
		SELECT (SELECT COUNT(*) FROM sales), (SELECT COUNT(*) FROM sale_items)`).
		Scan(&sales, &saleItems); err != nil {
		t.Fatalf("count sales: %v", err)
	}
	if sales != 0 || saleItems != 0 {
		t.Errorf("a transfer invented %d sales and %d lines", sales, saleItems)
	}
	// Pounds bottled must be untouched too: a transfer is not a jarring.
	bulk, err := honeyBulkOnHand(ctx, server.pool)
	if err != nil {
		t.Fatalf("bulk: %v", err)
	}
	if bulk.JarredLbs != 24 {
		t.Errorf("jarred lbs = %v after a transfer, want 24", bulk.JarredLbs)
	}

	// The jars still exist; they are just somewhere else.
	if got := globalOnHand(t, server, jarSizeID); got != 24 {
		t.Errorf("global on hand = %d, want 24", got)
	}
	if got := shelfCount(t, server, shopID, jarSizeID); got != 24 {
		t.Errorf("shop shelf = %d, want 24", got)
	}
	if got := shelfCount(t, server, homeLocation(t, server), jarSizeID); got != 0 {
		t.Errorf("home shelf = %d, want 0", got)
	}
}

// The rule the roadmap called out by name: home's guard must not count
// consigned jars, or market day oversells the same jar twice.
func TestHomeStockValidationIgnoresConsignedJars(t *testing.T) {
	server := honeyTestServer(t)
	jarSizeID := seedJarSize(t, server, "Pint", 16, 1200)
	seedHarvest(t, server, 100)
	jarStock(t, server, jarSizeID, 24)
	shopID := seedShop(t, server, "Bike shop", 30)
	transfer(t, server, shopID, jarSizeID, 20)

	// Four are left at home. Five is one too many.
	response, body := call(t, server.honeyRecordSale, adminRequest(
		http.MethodPost, "/api/v1/honey/sales", map[string]any{
			"date":    time.Now().Format("2006-01-02"),
			"channel": "farmers_market",
			"lines": []map[string]any{
				{"jarSizeId": jarSizeID.String(), "quantity": 5, "unitPrice": 12.00},
			},
		}))
	if response.Code != http.StatusBadRequest {
		t.Fatalf("market day oversold consigned stock: %d %v", response.Code, body)
	}

	// Four is exactly right.
	response, body = call(t, server.honeyRecordSale, adminRequest(
		http.MethodPost, "/api/v1/honey/sales", map[string]any{
			"date":    time.Now().Format("2006-01-02"),
			"channel": "farmers_market",
			"lines": []map[string]any{
				{"jarSizeId": jarSizeID.String(), "quantity": 4, "unitPrice": 12.00},
			},
		}))
	if response.Code != http.StatusCreated {
		t.Fatalf("selling the four at home failed: %d %v", response.Code, body)
	}
	if got := shelfCount(t, server, shopID, jarSizeID); got != 20 {
		t.Errorf("a home sale moved the shop's shelf to %d, want 20", got)
	}
}

// A transfer cannot send jars that are not at the source.
func TestTransferRefusesMoreThanHomeHolds(t *testing.T) {
	server := honeyTestServer(t)
	jarSizeID := seedJarSize(t, server, "Pint", 16, 1200)
	seedHarvest(t, server, 100)
	jarStock(t, server, jarSizeID, 6)
	shopID := seedShop(t, server, "Bike shop", 30)

	response, body := call(t, server.stockTransferCreate, adminRequest(
		http.MethodPost, "/api/v1/stock-locations/"+shopID.String()+"/transfers",
		map[string]any{
			"date": time.Now().Format("2006-01-02"),
			"lines": []map[string]any{
				{"jarSizeId": jarSizeID.String(), "quantity": 7},
			},
		}, "id", shopID.String()))
	if response.Code != http.StatusBadRequest {
		t.Fatalf("over-transfer = %d %v", response.Code, body)
	}
	if got := shelfCount(t, server, shopID, jarSizeID); got != 0 {
		t.Errorf("a rejected transfer still moved %d jars", got)
	}
}

// "We sold 9 this month, here is $X" — one request carrying counts sold, jars
// coming back, their shelf count, and the payment.
func TestSettlementRecognisesRevenueReturnsAndShrink(t *testing.T) {
	server := honeyTestServer(t)
	jarSizeID := seedJarSize(t, server, "Pint", 16, 1200)
	seedHarvest(t, server, 100)
	jarStock(t, server, jarSizeID, 24)
	shopID := seedShop(t, server, "Bike shop", 30)
	transfer(t, server, shopID, jarSizeID, 24)

	// 24 out, 9 sold, 2 handed back: 13 should be left. They count 12, so one
	// went missing on their shelf.
	response, body := call(t, server.stockSettlementCreate, adminRequest(
		http.MethodPost, "/api/v1/stock-locations/"+shopID.String()+"/settlements",
		map[string]any{
			"periodStart":   "2026-08-01",
			"periodEnd":     "2026-08-31",
			"reportedAt":    "2026-09-02",
			"paymentMethod": "check",
			"amountPaid":    50.00,
			"lines": []map[string]any{{
				"jarSizeId":        jarSizeID.String(),
				"quantitySold":     9,
				"quantityReturned": 2,
				"unitPrice":        12.00,
				"countOnShelf":     12,
			}},
		}, "id", shopID.String()))
	if response.Code != http.StatusCreated {
		t.Fatalf("settlement = %d %v", response.Code, body)
	}

	// 30% of $12.00 leaves the operator $8.40 a jar, nine jars, $75.60 owed.
	if body["amountOwed"] != 75.60 {
		t.Errorf("amountOwed = %v, want 75.60", body["amountOwed"])
	}
	if body["commission"] != 32.40 {
		t.Errorf("commission = %v, want 32.40", body["commission"])
	}
	if body["balanceDue"] != 25.60 {
		t.Errorf("balanceDue = %v, want 25.60", body["balanceDue"])
	}
	if body["shrinkUnits"] != float64(1) || body["returnedUnits"] != float64(2) {
		t.Errorf("units = %v shrink, %v returned; want 1 and 2", body["shrinkUnits"], body["returnedUnits"])
	}

	ctx := context.Background()
	var channel, orderStatus string
	var locationID uuid.UUID
	var total, paid money
	if err := server.pool.QueryRow(ctx, `
		SELECT channel, order_status, stock_location_id, total_amount_cents, amount_paid_cents
		FROM sales WHERE order_status <> 'cancelled'`).
		Scan(&channel, &orderStatus, &locationID, &total, &paid); err != nil {
		t.Fatalf("read settlement sale: %v", err)
	}
	if channel != "consignment" || locationID != shopID {
		t.Errorf("sale = %s at %v, want consignment at the shop", channel, locationID)
	}
	// Partly paid: the rest is a receivable on the sale itself, no new table.
	if orderStatus != "pending" || total != 7560 || paid != 5000 {
		t.Errorf("sale = %s %d/%d, want pending 7560/5000", orderStatus, total, paid)
	}

	// 24 - 9 sold - 2 back - 1 missing = 12 on their shelf, and the two that
	// came back are at home.
	if got := shelfCount(t, server, shopID, jarSizeID); got != 12 {
		t.Errorf("shop shelf = %d, want 12", got)
	}
	if got := shelfCount(t, server, homeLocation(t, server), jarSizeID); got != 2 {
		t.Errorf("home shelf = %d, want 2", got)
	}
	// The missing jar left the world, so the global count drops too. Without
	// the global half home would silently inherit it.
	if got := globalOnHand(t, server, jarSizeID); got != 14 {
		t.Errorf("global on hand = %d, want 14 (24 - 9 sold - 1 shrink)", got)
	}
	var shrinkReason string
	if err := server.pool.QueryRow(ctx, `
		SELECT reason FROM honey_movements
		WHERE kind='jar_adjustment' AND settlement_id IS NOT NULL`).Scan(&shrinkReason); err != nil {
		t.Fatalf("shrink was not attributed to the location: %v", err)
	}
	if shrinkReason != "shrink at Bike shop" {
		t.Errorf("shrink reason = %q, want it to name the location", shrinkReason)
	}
}

// The same period cannot be settled twice.
func TestSettlementPeriodIsUniquePerLocation(t *testing.T) {
	server := honeyTestServer(t)
	jarSizeID := seedJarSize(t, server, "Pint", 16, 1200)
	seedHarvest(t, server, 100)
	jarStock(t, server, jarSizeID, 24)
	shopID := seedShop(t, server, "Bike shop", 30)
	transfer(t, server, shopID, jarSizeID, 24)

	report := map[string]any{
		"periodStart":   "2026-08-01",
		"periodEnd":     "2026-08-31",
		"reportedAt":    "2026-09-02",
		"paymentMethod": "check",
		"amountPaid":    0,
		"lines": []map[string]any{{
			"jarSizeId": jarSizeID.String(), "quantitySold": 2, "unitPrice": 12.00,
		}},
	}
	response, body := call(t, server.stockSettlementCreate, adminRequest(
		http.MethodPost, "/api/v1/stock-locations/"+shopID.String()+"/settlements",
		report, "id", shopID.String()))
	if response.Code != http.StatusCreated {
		t.Fatalf("first settlement = %d %v", response.Code, body)
	}
	response, body = call(t, server.stockSettlementCreate, adminRequest(
		http.MethodPost, "/api/v1/stock-locations/"+shopID.String()+"/settlements",
		report, "id", shopID.String()))
	if response.Code != http.StatusConflict {
		t.Fatalf("re-settling the same period = %d %v, want 409", response.Code, body)
	}
}

// Voiding a mis-entered report puts everything back without deleting a row.
func TestSettlementVoidReversesEveryEffect(t *testing.T) {
	server := honeyTestServer(t)
	jarSizeID := seedJarSize(t, server, "Pint", 16, 1200)
	seedHarvest(t, server, 100)
	jarStock(t, server, jarSizeID, 24)
	shopID := seedShop(t, server, "Bike shop", 30)
	transfer(t, server, shopID, jarSizeID, 24)

	_, body := call(t, server.stockSettlementCreate, adminRequest(
		http.MethodPost, "/api/v1/stock-locations/"+shopID.String()+"/settlements",
		map[string]any{
			"periodStart":   "2026-08-01",
			"periodEnd":     "2026-08-31",
			"reportedAt":    "2026-09-02",
			"paymentMethod": "check",
			"amountPaid":    75.60,
			"lines": []map[string]any{{
				"jarSizeId":        jarSizeID.String(),
				"quantitySold":     9,
				"quantityReturned": 2,
				"unitPrice":        12.00,
				"countOnShelf":     12,
			}},
		}, "id", shopID.String()))
	settlementID, err := uuid.Parse(body["id"].(string))
	if err != nil {
		t.Fatalf("parse settlement id: %v", err)
	}

	response, voidBody := call(t, server.stockSettlementVoid, adminRequest(
		http.MethodPost, "/api/v1/consignment-settlements/"+settlementID.String()+"/void",
		map[string]any{"reason": "they miscounted"}, "id", settlementID.String()))
	if response.Code != http.StatusOK {
		t.Fatalf("void = %d %v", response.Code, voidBody)
	}

	if got := shelfCount(t, server, shopID, jarSizeID); got != 24 {
		t.Errorf("shop shelf after void = %d, want 24", got)
	}
	if got := shelfCount(t, server, homeLocation(t, server), jarSizeID); got != 0 {
		t.Errorf("home shelf after void = %d, want 0", got)
	}
	if got := globalOnHand(t, server, jarSizeID); got != 24 {
		t.Errorf("global on hand after void = %d, want 24", got)
	}

	ctx := context.Background()
	var cancelled int
	var movementRows int
	if err := server.pool.QueryRow(ctx, `
		SELECT (SELECT COUNT(*) FROM sales WHERE order_status='cancelled'),
		       (SELECT COUNT(*) FROM stock_movements WHERE settlement_id IS NOT NULL)`).
		Scan(&cancelled, &movementRows); err != nil {
		t.Fatalf("inspect void: %v", err)
	}
	if cancelled != 1 {
		t.Errorf("cancelled sales = %d, want 1", cancelled)
	}
	// Reversal, not deletion: the return pair, the shrink, and their
	// negations all survive.
	if movementRows == 0 {
		t.Error("the void destroyed the settlement's movements instead of reversing them")
	}

	// Voiding twice is a conflict, not a second unwind.
	response, _ = call(t, server.stockSettlementVoid, adminRequest(
		http.MethodPost, "/api/v1/consignment-settlements/"+settlementID.String()+"/void",
		nil, "id", settlementID.String()))
	if response.Code != http.StatusConflict {
		t.Errorf("second void = %d, want 409", response.Code)
	}
}

// Reversing a transfer unwinds both halves and refuses a second time.
func TestTransferReversalIsWholeAndIdempotent(t *testing.T) {
	server := honeyTestServer(t)
	jarSizeID := seedJarSize(t, server, "Pint", 16, 1200)
	seedHarvest(t, server, 100)
	jarStock(t, server, jarSizeID, 10)
	shopID := seedShop(t, server, "Bike shop", 30)
	transfer(t, server, shopID, jarSizeID, 10)

	var movementID uuid.UUID
	if err := server.pool.QueryRow(context.Background(), `
		SELECT id FROM stock_movements WHERE location_id=$1 AND quantity > 0`,
		shopID).Scan(&movementID); err != nil {
		t.Fatalf("read movement: %v", err)
	}

	response, body := call(t, server.stockMovementReverse, adminRequest(
		http.MethodDelete, "/api/v1/stock-movements/"+movementID.String(),
		map[string]any{"reason": "wrong shop"}, "id", movementID.String()))
	if response.Code != http.StatusOK {
		t.Fatalf("reverse = %d %v", response.Code, body)
	}
	if body["reversed"] != float64(2) {
		t.Errorf("reversed %v rows, want both halves", body["reversed"])
	}
	if got := shelfCount(t, server, shopID, jarSizeID); got != 0 {
		t.Errorf("shop shelf after reversal = %d, want 0", got)
	}
	if got := shelfCount(t, server, homeLocation(t, server), jarSizeID); got != 10 {
		t.Errorf("home shelf after reversal = %d, want 10", got)
	}

	response, _ = call(t, server.stockMovementReverse, adminRequest(
		http.MethodDelete, "/api/v1/stock-movements/"+movementID.String(),
		nil, "id", movementID.String()))
	if response.Code != http.StatusConflict {
		t.Errorf("second reversal = %d, want 409", response.Code)
	}
}

// The statement is the reconciliation surface: opening, in, sold, returned,
// shrink, closing, owed, paid.
func TestSettlementStatementReconcilesThePeriod(t *testing.T) {
	server := honeyTestServer(t)
	jarSizeID := seedJarSize(t, server, "Pint", 16, 1200)
	seedHarvest(t, server, 100)
	jarStock(t, server, jarSizeID, 24)
	shopID := seedShop(t, server, "Bike shop", 30)
	transfer(t, server, shopID, jarSizeID, 24)
	call(t, server.stockSettlementCreate, adminRequest(
		http.MethodPost, "/api/v1/stock-locations/"+shopID.String()+"/settlements",
		map[string]any{
			"periodStart": time.Now().AddDate(0, 0, -7).Format("2006-01-02"),
			"periodEnd":   time.Now().Format("2006-01-02"),
			"amountPaid":  75.60,
			"lines": []map[string]any{{
				"jarSizeId":        jarSizeID.String(),
				"quantitySold":     9,
				"quantityReturned": 2,
				"unitPrice":        12.00,
				"countOnShelf":     12,
			}},
		}, "id", shopID.String()))

	from := time.Now().AddDate(0, 0, -7).Format("2006-01-02")
	to := time.Now().Format("2006-01-02")
	response := httptest.NewRecorder()
	server.stockSettlementPreview(response, adminRequest(
		http.MethodGet,
		"/api/v1/stock-locations/"+shopID.String()+"/settlement?from="+from+"&to="+to,
		nil, "id", shopID.String()))
	if response.Code != http.StatusOK {
		t.Fatalf("statement = %d %s", response.Code, response.Body.String())
	}
	var decoded struct {
		Statement stockStatement `json:"statement"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &decoded); err != nil {
		t.Fatalf("decode statement: %v", err)
	}
	got := decoded.Statement
	if got.TransferredInUnits != 24 || got.SoldUnits != 9 ||
		got.ReturnedUnits != 2 || got.ShrinkUnits != 1 || got.ClosingUnits != 12 {
		t.Errorf("statement units = in %d, sold %d, returned %d, shrink %d, closing %d;"+
			" want 24/9/2/1/12", got.TransferredInUnits, got.SoldUnits,
			got.ReturnedUnits, got.ShrinkUnits, got.ClosingUnits)
	}
	if got.AmountInvoiced != 7560 || got.AmountCollected != 7560 || got.AmountOwed != 0 {
		t.Errorf("statement money = %d invoiced, %d collected, %d owed; want 7560/7560/0",
			got.AmountInvoiced, got.AmountCollected, got.AmountOwed)
	}
}

// A location cannot be deleted while its shelf still holds stock.
func TestDeletingALocationRequiresAnEmptyShelf(t *testing.T) {
	server := honeyTestServer(t)
	jarSizeID := seedJarSize(t, server, "Pint", 16, 1200)
	seedHarvest(t, server, 100)
	jarStock(t, server, jarSizeID, 8)
	shopID := seedShop(t, server, "Bike shop", 30)
	transfer(t, server, shopID, jarSizeID, 8)

	response, body := call(t, server.stockLocationDelete, adminRequest(
		http.MethodDelete, "/api/v1/stock-locations/"+shopID.String(), nil,
		"id", shopID.String()))
	if response.Code != http.StatusConflict {
		t.Fatalf("delete with stock = %d %v, want 409", response.Code, body)
	}

	// Home is not deletable at all.
	homeID := homeLocation(t, server)
	response, _ = call(t, server.stockLocationDelete, adminRequest(
		http.MethodDelete, "/api/v1/stock-locations/"+homeID.String(), nil,
		"id", homeID.String()))
	if response.Code == http.StatusOK {
		t.Error("home was deleted")
	}
}
