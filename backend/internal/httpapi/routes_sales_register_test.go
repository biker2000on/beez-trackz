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

func registerDay(day int) time.Time {
	return time.Date(2026, 10, day, 0, 0, 0, 0, time.UTC)
}

// The merge is pure: date order, revenue from sales only, reversed
// give-aways shown but uncounted, own use labelled and totalled apart.
func TestBuildSalesRegisterMergesAndTotals(t *testing.T) {
	saleNew := honeySaleRow{ID: uuid.New(), Date: registerDay(9), TotalAmount: 2400,
		OrderStatus: "paid", CreatedAt: registerDay(9).Add(time.Hour)}
	saleCancelled := honeySaleRow{ID: uuid.New(), Date: registerDay(5), TotalAmount: 9900,
		OrderStatus: "cancelled", CreatedAt: registerDay(5)}
	gift := registerGiveAway{ID: uuid.New(), Date: registerDay(9), Purpose: "gift",
		TotalJars: 2, RetailValue: 2400}
	ownUse := registerGiveAway{ID: uuid.New(), Date: registerDay(7), Purpose: "own_use",
		TotalJars: 1, RetailValue: 1200}
	reversed := registerGiveAway{ID: uuid.New(), Date: registerDay(8), Purpose: "gift",
		TotalJars: 5, RetailValue: 6000, Reversed: true}
	giveAways := []registerGiveAway{gift, reversed, ownUse}
	created := []time.Time{registerDay(9).Add(2 * time.Hour), registerDay(8), registerDay(7)}

	register := buildSalesRegister([]honeySaleRow{saleNew, saleCancelled}, giveAways, created, "all")

	wantOrder := []struct {
		id  uuid.UUID
		typ string
	}{
		{gift.ID, "give_away"}, // same day as saleNew, recorded later
		{saleNew.ID, "sale"},
		{reversed.ID, "give_away"},
		{ownUse.ID, "own_use"},
		{saleCancelled.ID, "sale"},
	}
	if len(register.Entries) != len(wantOrder) {
		t.Fatalf("entries = %d, want %d", len(register.Entries), len(wantOrder))
	}
	for i, want := range wantOrder {
		got := register.Entries[i]
		if got.ID != want.id || got.Type != want.typ {
			t.Errorf("row %d = %s %s, want %s %s", i, got.Type, got.ID, want.typ, want.id)
		}
	}
	if register.Entries[2].GiveAway == nil || !register.Entries[2].GiveAway.Reversed {
		t.Error("reversed give-away lost its reversed flag")
	}

	totals := register.Totals
	if totals.Revenue != 2400 {
		t.Errorf("revenue = %d cents, want 2400 (paid sale only; no give-aways, no cancelled)", totals.Revenue)
	}
	if totals.SalesCount != 1 {
		t.Errorf("sales count = %d, want 1", totals.SalesCount)
	}
	if totals.GivenAwayJars != 2 || totals.OwnUseJars != 1 {
		t.Errorf("jars given/own = %d/%d, want 2/1 (reversed excluded)", totals.GivenAwayJars, totals.OwnUseJars)
	}
	if totals.RetailValueGiven != 3600 {
		t.Errorf("retail value given = %d, want 3600", totals.RetailValueGiven)
	}

	onlySales := buildSalesRegister([]honeySaleRow{saleNew}, giveAways, created, "sales")
	if len(onlySales.Entries) != 1 || onlySales.Entries[0].Type != "sale" {
		t.Errorf("kind=sales entries = %+v", onlySales.Entries)
	}
	if onlySales.Totals.GivenAwayJars != 2 {
		t.Error("totals must cover the whole register whatever kind shows")
	}
	onlyGiven := buildSalesRegister([]honeySaleRow{saleNew}, giveAways, created, "giveaways")
	if len(onlyGiven.Entries) != 3 {
		t.Errorf("kind=giveaways entries = %d, want 3", len(onlyGiven.Entries))
	}
	for _, entry := range onlyGiven.Entries {
		if entry.Type == "sale" {
			t.Error("kind=giveaways returned a sale")
		}
	}
}

func TestApplyRegisterLinePricesAtDefault(t *testing.T) {
	row := registerGiveAway{}
	price := int64(1250)
	applyRegisterLine(&row, registerGiveAwayLine{Label: "Pint", Quantity: 3}, &price)
	applyRegisterLine(&row, registerGiveAwayLine{Label: "Comb", Quantity: 2}, nil)
	if row.TotalJars != 5 || row.RetailValue != 3750 || row.UnpricedJars != 2 {
		t.Fatalf("row = %+v", row)
	}
	if row.Lines[0].RetailValue == nil || *row.Lines[0].RetailValue != 3750 || row.Lines[1].RetailValue != nil {
		t.Errorf("lines = %+v", row.Lines)
	}
}

func TestSalesRegisterRejectsUnknownKind(t *testing.T) {
	response := httptest.NewRecorder()
	(&Server{}).salesRegisterHandler(response,
		httptest.NewRequest(http.MethodGet, "/api/v1/sales/register?kind=bogus", nil))
	if response.Code != http.StatusBadRequest {
		t.Fatalf("kind=bogus = %d, want 400", response.Code)
	}
}

func TestGiveAwayRejectsUnknownPurpose(t *testing.T) {
	response := httptest.NewRecorder()
	(&Server{}).honeyRecordGiveAway(response, adminRequest(http.MethodPost,
		"/api/v1/honey/give-away", map[string]any{"purpose": "barter"}))
	if response.Code != http.StatusBadRequest {
		t.Fatalf("purpose=barter = %d, want 400", response.Code)
	}
}

// --- DB-backed ---

func fetchSalesRegister(t *testing.T, server *Server, kind string) salesRegister {
	t.Helper()
	response := httptest.NewRecorder()
	server.salesRegisterHandler(response, adminRequest(http.MethodGet,
		"/api/v1/sales/register?kind="+kind, nil))
	if response.Code != http.StatusOK {
		t.Fatalf("register %s = %d %s", kind, response.Code, response.Body.String())
	}
	var register salesRegister
	if err := json.Unmarshal(response.Body.Bytes(), &register); err != nil {
		t.Fatalf("decode register: %v", err)
	}
	return register
}

func TestSalesRegisterMergesGiveAwaysAndOwnUse(t *testing.T) {
	server := honeyTestServer(t)
	jarSizeID := seedJarSize(t, server, "Pint", 16, 1200)
	seedHarvest(t, server, 100)
	lotID := seedFixtureLot(t, server, 12)
	jarStockFromLot(t, server, lotID, jarSizeID, 12)

	giveAway := func(date, purpose, reason string, quantity int) {
		t.Helper()
		body := map[string]any{
			"date":   date,
			"reason": reason,
			"lines": []map[string]any{{
				"jarSizeId": jarSizeID.String(), "harvestLotId": lotID.String(), "quantity": quantity,
			}},
		}
		if purpose != "" {
			body["purpose"] = purpose
		}
		response, result := call(t, server.honeyRecordGiveAway, adminRequest(
			http.MethodPost, "/api/v1/honey/give-away", body))
		if response.Code != http.StatusOK {
			t.Fatalf("give-away = %d %v", response.Code, result)
		}
	}
	giveAway("2026-10-01", "", "Neighbors", 2)
	giveAway("2026-10-03", "own_use", "Kitchen", 1)
	giveAway("2026-10-04", "gift", "Mail carrier", 3)

	response, body := call(t, server.honeyRecordSale, adminRequest(
		http.MethodPost, "/api/v1/sales", map[string]any{
			"date":         "2026-10-02",
			"location":     "Farmers Market",
			"harvestLotId": lotID.String(),
			"lines": []map[string]any{
				{"jarSizeId": jarSizeID.String(), "quantity": 2, "unitPrice": 12},
			},
		}))
	if response.Code != http.StatusOK && response.Code != http.StatusCreated {
		t.Fatalf("sale = %d %v", response.Code, body)
	}

	// Reverse the mail-carrier gift: it stays in the register, flagged.
	var mailCarrier uuid.UUID
	if err := server.pool.QueryRow(context.Background(), `
		SELECT id FROM inventory_operations
		WHERE reason='give_away' AND details->>'recipient'='Mail carrier'`).Scan(&mailCarrier); err != nil {
		t.Fatalf("find gift: %v", err)
	}
	response, body = call(t, server.honeyReverseMovement, adminRequest(
		http.MethodDelete, "/api/v1/honey/movements/"+mailCarrier.String(), nil,
		"id", mailCarrier.String()))
	if response.Code != http.StatusOK {
		t.Fatalf("reverse = %d %v", response.Code, body)
	}

	register := fetchSalesRegister(t, server, "all")
	wantTypes := []string{"give_away", "own_use", "sale", "give_away"}
	if len(register.Entries) != len(wantTypes) {
		t.Fatalf("entries = %d, want %d: %+v", len(register.Entries), len(wantTypes), register.Entries)
	}
	for i, want := range wantTypes {
		if register.Entries[i].Type != want {
			t.Errorf("row %d type = %s, want %s", i, register.Entries[i].Type, want)
		}
		if i > 0 && register.Entries[i].Date.After(register.Entries[i-1].Date) {
			t.Errorf("row %d is newer than row %d", i, i-1)
		}
	}

	reversed := register.Entries[0].GiveAway
	if reversed == nil || !reversed.Reversed || reversed.ID != mailCarrier {
		t.Fatalf("newest row should be the reversed gift: %+v", reversed)
	}
	ownUse := register.Entries[1].GiveAway
	if ownUse == nil || ownUse.Purpose != "own_use" || ownUse.Recipient == nil || *ownUse.Recipient != "Kitchen" {
		t.Fatalf("own use row = %+v", ownUse)
	}
	neighbors := register.Entries[3].GiveAway
	if neighbors == nil || neighbors.Purpose != "gift" || neighbors.TotalJars != 2 ||
		neighbors.RetailValue != 2400 || len(neighbors.Lines) != 1 {
		t.Fatalf("neighbors row = %+v", neighbors)
	}
	line := neighbors.Lines[0]
	if line.Label != "Pint" || line.HarvestLotID == nil || *line.HarvestLotID != lotID ||
		line.Quantity != 2 || line.UnitRetailPrice == nil || *line.UnitRetailPrice != 1200 {
		t.Errorf("neighbors line = %+v", line)
	}

	totals := register.Totals
	if totals.Revenue != 2400 || totals.SalesCount != 1 {
		t.Errorf("revenue = %d over %d sales; want 2400 over 1 (give-aways are not revenue)",
			totals.Revenue, totals.SalesCount)
	}
	if totals.GivenAwayJars != 2 || totals.OwnUseJars != 1 || totals.RetailValueGiven != 3600 {
		t.Errorf("zero-revenue totals = %+v; the reversed gift must not count", totals)
	}

	if only := fetchSalesRegister(t, server, "giveaways"); len(only.Entries) != 3 {
		t.Errorf("kind=giveaways = %d rows, want 3", len(only.Entries))
	}
	if only := fetchSalesRegister(t, server, "sales"); len(only.Entries) != 1 || only.Entries[0].Sale == nil {
		t.Errorf("kind=sales = %+v", only.Entries)
	}
}
