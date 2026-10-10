package httpapi

import (
	"net/http"
	"testing"

	"github.com/google/uuid"
)

// Per-store consignment prices and the movement history's per-lot lines.
// These need TEST_DATABASE_URL and skip without it.

// seedWholesaleShop creates a wholesale-basis consignee with no price list:
// it is priced purely by its own per-SKU prices.
func seedWholesaleShop(t *testing.T, server *Server, name string) uuid.UUID {
	t.Helper()
	response, body := call(t, server.stockLocationCreate, adminRequest(
		http.MethodPost, "/api/v1/stock-locations", map[string]any{
			"name":              name,
			"isConsignment":     true,
			"priceBasis":        "wholesale_list",
			"settlementCadence": "monthly",
		}))
	if response.Code != http.StatusCreated {
		t.Fatalf("create wholesale location = %d %v", response.Code, body)
	}
	id, err := uuid.Parse(body["id"].(string))
	if err != nil {
		t.Fatalf("parse location id: %v", err)
	}
	return id
}

func putPrices(t *testing.T, server *Server, locationID uuid.UUID, prices []map[string]any) (int, map[string]any) {
	t.Helper()
	response, body := call(t, server.stockLocationPricesReplace, adminRequest(
		http.MethodPut, "/api/v1/stock-locations/"+locationID.String()+"/prices",
		map[string]any{"prices": prices}, "id", locationID.String()))
	return response.Code, body
}

func locationDetail(t *testing.T, server *Server, locationID uuid.UUID) map[string]any {
	t.Helper()
	response, body := call(t, server.stockLocationDetail, adminRequest(
		http.MethodGet, "/api/v1/stock-locations/"+locationID.String(), nil,
		"id", locationID.String()))
	if response.Code != http.StatusOK {
		t.Fatalf("detail = %d %v", response.Code, body)
	}
	return body
}

// A wholesale store owes the operator its own wholesale price per jar, not
// capped by and not requiring a shelf price; the shelf price only sets the
// store's margin. Settlement and the shelf preview agree.
func TestWholesaleStoreSettlesAtItsOwnPrice(t *testing.T) {
	server := honeyTestServer(t)
	jarSizeID := seedJarSize(t, server, "Pint", 16, 1200)
	seedHarvest(t, server, 100)
	jarStock(t, server, jarSizeID, 24)
	shopID := seedWholesaleShop(t, server, "Corner store")
	transfer(t, server, shopID, jarSizeID, 24)

	// Without a store price or a price list the jar cannot be settled.
	response, body := call(t, server.stockSettlementCreate, adminRequest(
		http.MethodPost, "/api/v1/stock-locations/"+shopID.String()+"/settlements",
		map[string]any{
			"periodStart": "2026-08-01", "periodEnd": "2026-08-31",
			"lines": []map[string]any{{"jarSizeId": jarSizeID.String(), "quantitySold": 1}},
		}, "id", shopID.String()))
	if response.Code != http.StatusBadRequest {
		t.Fatalf("unpriced wholesale settlement = %d %v, want 400", response.Code, body)
	}

	if code, body := putPrices(t, server, shopID, []map[string]any{
		{"jarSizeId": jarSizeID.String(), "wholesalePrice": 8.00, "shelfPrice": 14.00},
	}); code != http.StatusOK || body["success"] != true {
		t.Fatalf("put prices = %d %v", code, body)
	}

	detail := locationDetail(t, server, shopID)
	shelf := detail["shelf"].([]any)
	if len(shelf) != 1 {
		t.Fatalf("shelf = %v", shelf)
	}
	row := shelf[0].(map[string]any)
	if row["unitPrice"] != 14.00 || row["owedPrice"] != 8.00 {
		t.Errorf("shelf row prices = %v / owed %v, want 14.00 / 8.00", row["unitPrice"], row["owedPrice"])
	}
	var priced map[string]any
	for _, entry := range detail["prices"].([]any) {
		entry := entry.(map[string]any)
		if entry["jarSizeId"] == jarSizeID.String() {
			priced = entry
		}
	}
	if priced == nil || priced["wholesalePrice"] != 8.00 || priced["shelfPrice"] != 14.00 ||
		priced["listPrice"] != 12.00 || priced["priceListPrice"] != nil {
		t.Errorf("price sheet entry = %v", priced)
	}

	// No unitPrice on the line: the store's shelf price ($14) is the default,
	// the operator is owed $8 a jar, and the store keeps $6.
	response, body = call(t, server.stockSettlementCreate, adminRequest(
		http.MethodPost, "/api/v1/stock-locations/"+shopID.String()+"/settlements",
		map[string]any{
			"periodStart": "2026-08-01", "periodEnd": "2026-08-31",
			"lines": []map[string]any{{"jarSizeId": jarSizeID.String(), "quantitySold": 3}},
		}, "id", shopID.String()))
	if response.Code != http.StatusCreated {
		t.Fatalf("settlement = %d %v", response.Code, body)
	}
	if body["amountOwed"] != 24.00 || body["commission"] != 18.00 {
		t.Errorf("owed/commission = %v/%v, want 24.00/18.00", body["amountOwed"], body["commission"])
	}

	// A shelf price below the wholesale price does not cap what is owed.
	response, body = call(t, server.stockSettlementCreate, adminRequest(
		http.MethodPost, "/api/v1/stock-locations/"+shopID.String()+"/settlements",
		map[string]any{
			"periodStart": "2026-09-01", "periodEnd": "2026-09-30",
			"lines": []map[string]any{{
				"jarSizeId": jarSizeID.String(), "quantitySold": 2, "unitPrice": 5.00,
			}},
		}, "id", shopID.String()))
	if response.Code != http.StatusCreated {
		t.Fatalf("discounted settlement = %d %v", response.Code, body)
	}
	if body["amountOwed"] != 16.00 || body["commission"] != 0.00 {
		t.Errorf("discounted owed/commission = %v/%v, want 16.00/0.00", body["amountOwed"], body["commission"])
	}

	// Replacing the sheet with a priceless entry clears it.
	if code, body := putPrices(t, server, shopID, []map[string]any{
		{"jarSizeId": jarSizeID.String(), "wholesalePrice": nil, "shelfPrice": nil},
	}); code != http.StatusOK {
		t.Fatalf("clear prices = %d %v", code, body)
	}
	row = locationDetail(t, server, shopID)["shelf"].([]any)[0].(map[string]any)
	if row["unitPrice"] != 12.00 || row["owedPrice"] != nil {
		t.Errorf("cleared shelf row = %v / owed %v, want 12.00 / null", row["unitPrice"], row["owedPrice"])
	}
}

// A transfer of two varietals is one history row whose lines name each lot.
func TestMovementHistoryListsEachLot(t *testing.T) {
	server := honeyTestServer(t)
	f := seedVarietalFixture(t, server)

	movements := locationDetail(t, server, f.shopID)["movements"].([]any)
	if len(movements) != 1 {
		t.Fatalf("movements = %v, want the one transfer", movements)
	}
	row := movements[0].(map[string]any)
	if row["quantity"] != float64(f.sourwoodShipped+f.wildShipped) || row["label"] != "Pint" {
		t.Errorf("row = %v %v, want Pint %d", row["label"], row["quantity"], f.sourwoodShipped+f.wildShipped)
	}
	if row["lotCode"] != nil || row["varietalName"] != nil {
		t.Errorf("mixed-lot row names lot %v / varietal %v, want both null", row["lotCode"], row["varietalName"])
	}
	lines := row["lines"].([]any)
	if len(lines) != 2 {
		t.Fatalf("lines = %v, want one per lot", lines)
	}
	first, second := lines[0].(map[string]any), lines[1].(map[string]any)
	if first["varietalName"] != f.sourwoodName || first["quantity"] != float64(f.sourwoodShipped) ||
		first["lotCode"] != f.sourwoodCode || first["kind"] != saleKindJar {
		t.Errorf("first line = %v, want %s x%d", first, f.sourwoodName, f.sourwoodShipped)
	}
	if second["varietalName"] != f.wildName || second["quantity"] != float64(f.wildShipped) {
		t.Errorf("second line = %v, want %s x%d", second, f.wildName, f.wildShipped)
	}
}
