package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
)

func callBottlingCreate(t *testing.T, server *Server, lotID uuid.UUID, body map[string]any) *httptest.ResponseRecorder {
	t.Helper()
	encoded, err := json.Marshal(body)
	if err != nil {
		t.Fatalf("encode: %v", err)
	}
	request := httptest.NewRequest(http.MethodPost,
		"/api/v1/harvest-lots/"+lotID.String()+"/bottling-runs", bytes.NewReader(encoded))
	request.Header.Set("Content-Type", "application/json")
	routeCtx := chi.NewRouteContext()
	routeCtx.URLParams.Add("id", lotID.String())
	request = request.WithContext(context.WithValue(request.Context(), chi.RouteCtxKey, routeCtx))
	response := httptest.NewRecorder()
	server.bottlingRunCreate(response, request)
	return response
}

func TestCommerceOptionalHTTPURL(t *testing.T) {
	valid := "https://example.com/honey?lot=summer"
	got, err := commerceOptionalHTTPURL(&valid)
	if err != nil {
		t.Fatalf("valid URL returned error: %v", err)
	}
	if got == nil || *got != valid {
		t.Fatalf("URL = %#v, want %q", got, valid)
	}

	for _, value := range []string{
		"javascript:alert(1)",
		"data:text/html,unsafe",
		"/relative/path",
		"not a url",
	} {
		t.Run(value, func(t *testing.T) {
			if _, err := commerceOptionalHTTPURL(&value); err == nil {
				t.Fatal("unsafe URL returned nil error")
			}
		})
	}
}

func TestHarvestLotCreateAndUpdateRejectReservedPublicSlug(t *testing.T) {
	payload := map[string]any{
		"lotCode":        "2026-RESERVED",
		"publicSlug":     "lots",
		"extractionDate": "2026-08-25",
		"honeyWeightLbs": 10,
	}
	tests := []struct {
		name    string
		handler http.HandlerFunc
		method  string
		params  []string
	}{
		{name: "create", handler: (&Server{}).harvestLotCreate, method: http.MethodPost},
		{
			name: "update", handler: (&Server{}).harvestLotUpdate, method: http.MethodPatch,
			params: []string{"id", uuid.NewString()},
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			response, body := call(t, tc.handler,
				adminRequest(tc.method, "/harvest-lots", payload, tc.params...))
			if response.Code != http.StatusBadRequest {
				t.Fatalf("status = %d, want 400: %s", response.Code, response.Body.String())
			}
			if body["error"] != "publicSlug is reserved by the Honey app" {
				t.Fatalf("error = %v, want reserved-slug error", body["error"])
			}
		})
	}
}

// Commerce request bodies stay in dollars on the wire and become integer cents
// the moment they are decoded, so no handler ever performs float money math.
func TestCommerceMoneyFieldsDecodeDollarsIntoCents(t *testing.T) {
	var payload struct {
		Amount             money  `json:"amount"`
		MinimumOrderAmount money  `json:"minimumOrderAmount"`
		Tax                *money `json:"tax"`
	}
	body := []byte(`{"amount":249.99,"minimumOrderAmount":150,"tax":null}`)
	if err := json.Unmarshal(body, &payload); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if payload.Amount != 24999 {
		t.Errorf("amount = %d cents, want 24999", int64(payload.Amount))
	}
	if payload.MinimumOrderAmount != 15000 {
		t.Errorf("minimumOrderAmount = %d cents, want 15000", int64(payload.MinimumOrderAmount))
	}
	if payload.Tax != nil {
		t.Errorf("null tax decoded as %v, want nil (no tax recorded is not tax of zero)", payload.Tax)
	}

	// And they marshal back to the same dollars the frontend already renders.
	encoded, err := json.Marshal(map[string]any{"amount": payload.Amount})
	if err != nil {
		t.Fatalf("encode: %v", err)
	}
	if string(encoded) != `{"amount":249.99}` {
		t.Errorf("re-encoded as %s, want {\"amount\":249.99}", encoded)
	}
}

func TestBottlingRunRejectsNonPositiveQuantity(t *testing.T) {
	server := &Server{}
	lotID := uuid.New()
	for _, quantity := range []int{0, -3} {
		response := callBottlingCreate(t, server, lotID, map[string]any{
			"bottledDate": "2026-08-01",
			"jarSizeId":   uuid.New().String(),
			"quantity":    quantity,
			"serialize":   true,
		})
		if response.Code != http.StatusBadRequest {
			t.Fatalf("quantity %d = %d, want %d: %s",
				quantity, response.Code, http.StatusBadRequest, response.Body.String())
		}
	}
}

func TestBottlingRunRejectsUnboundedSerializedQuantity(t *testing.T) {
	server := &Server{}
	lotID := uuid.New()
	response := callBottlingCreate(t, server, lotID, map[string]any{
		"bottledDate": "2026-08-01",
		"jarSizeId":   uuid.New().String(),
		"quantity":    maxSerializedBottlingQuantity + 1,
		"serialize":   true,
	})
	if response.Code != http.StatusBadRequest {
		t.Fatalf("serialized quantity %d = %d, want %d: %s",
			maxSerializedBottlingQuantity+1, response.Code, http.StatusBadRequest, response.Body.String())
	}
	if !bytes.Contains(response.Body.Bytes(), []byte("serialized quantity")) {
		t.Fatalf("error %q should mention the serialized-quantity cap", response.Body.String())
	}
}

func TestProfitabilityByKindIncludesAppliedCostAndMargin(t *testing.T) {
	server := honeyTestServer(t)
	ctx := context.Background()
	world := seedMixedSaleWorld(t, server)
	// The unit cost is a catalog fact on the type now, not a column on the
	// stock row COGS used to read (review OV2).
	if _, err := server.pool.Exec(ctx,
		`UPDATE equipment_types SET unit_cost_cents=450 WHERE id=$1`, world.typeID); err != nil {
		t.Fatalf("seed equipment unit cost: %v", err)
	}
	var uncostedHiveID uuid.UUID
	if err := server.pool.QueryRow(ctx, `
		INSERT INTO hives (apiary_id, position_label)
		VALUES ($1, 'A2') RETURNING id`, world.apiaryID).Scan(&uncostedHiveID); err != nil {
		t.Fatalf("seed uncosted hive: %v", err)
	}
	if _, err := server.pool.Exec(ctx, `
		INSERT INTO expenses (expense_date, category, description, amount_cents, hive_id)
		VALUES ('2026-05-01', 'bees_queens', 'Purchased colony', 700, $1)`,
		world.hiveID); err != nil {
		t.Fatalf("seed colony cost: %v", err)
	}

	response, body := call(t, server.honeyRecordSale, adminRequest(
		http.MethodPost, "/api/v1/sales", map[string]any{
			"date": "2026-06-01",
			"lines": []map[string]any{
				{"kind": "colony", "hiveId": world.hiveID.String(), "quantity": 1, "unitPrice": 10},
				{"kind": "colony", "hiveId": uncostedHiveID.String(), "quantity": 1, "unitPrice": 20},
				{"kind": "equipment", "equipmentStockId": world.stockID.String(), "quantity": 2, "unitPrice": 40},
			},
		}))
	if response.Code != http.StatusCreated {
		t.Fatalf("sale = %d: %v", response.Code, body)
	}

	response, body = call(t, server.profitabilityAnalytics,
		adminRequest(http.MethodGet, "/analytics/profitability?year=2026", nil))
	if response.Code != http.StatusOK {
		t.Fatalf("profitability = %d: %s", response.Code, response.Body.String())
	}
	rows, ok := body["byKind"].([]any)
	if !ok {
		t.Fatalf("byKind = %#v, want array", body["byKind"])
	}
	byKind := make(map[string]map[string]any, len(rows))
	for _, value := range rows {
		row, ok := value.(map[string]any)
		if !ok {
			t.Fatalf("byKind row = %#v, want object", value)
		}
		byKind[row["kind"].(string)] = row
	}
	equipment := byKind["equipment"]
	if equipment["revenue"] != 80.0 || equipment["cost"] != 9.0 || equipment["margin"] != 71.0 ||
		equipment["costedLines"] != 1.0 || equipment["totalLines"] != 1.0 {
		t.Fatalf("equipment profitability = %#v (all kinds %#v), want revenue 80, cost 9, margin 71, coverage 1/1", equipment, byKind)
	}
	colony := byKind["colony"]
	if colony["revenue"] != 30.0 || colony["cost"] != nil || colony["margin"] != nil ||
		colony["costedLines"] != 1.0 || colony["totalLines"] != 2.0 {
		t.Fatalf("colony profitability = %#v, want revenue 30, unknown cost/margin, coverage 1/2", colony)
	}
}
