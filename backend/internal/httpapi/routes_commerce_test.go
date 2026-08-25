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
	jarSizeID := seedJarSize(t, server, "Profitability 1 lb", 16, 1200)
	var productID uuid.UUID
	if err := server.pool.QueryRow(ctx, `
		INSERT INTO product_catalog (name, kind, unit, default_price_cents)
		VALUES ('Test mead', 'mead', 'bottle', 2500) RETURNING id`).Scan(&productID); err != nil {
		t.Fatalf("seed product: %v", err)
	}
	insertSale := func(status string, applied bool) uuid.UUID {
		t.Helper()
		var id uuid.UUID
		if err := server.pool.QueryRow(ctx, `
			INSERT INTO sales
				(date, total_amount_cents, order_status, physical_applied_at)
			VALUES ('2026-06-01', 0, $1,
				CASE WHEN $2 THEN '2026-06-01'::timestamptz ELSE NULL END)
			RETURNING id`, status, applied).Scan(&id); err != nil {
			t.Fatalf("seed %s sale: %v", status, err)
		}
		return id
	}
	insertJarLine := func(saleID uuid.UUID, quantity int, basis *int64) {
		t.Helper()
		if _, err := server.pool.Exec(ctx, `
			INSERT INTO sale_items
				(sale_id, kind, jar_size_id, quantity, unit_price_cents, cost_basis_cents)
			VALUES ($1, 'jar', $2, $3, 1200, $4)`,
			saleID, jarSizeID, quantity, basis); err != nil {
			t.Fatalf("seed jar line: %v", err)
		}
	}

	knownBasis := int64(700)
	insertJarLine(insertSale("paid", true), 2, &knownBasis)
	staleBasis := int64(900)
	insertJarLine(insertSale("pending", false), 1, &staleBasis)
	cancelledBasis := int64(500)
	insertJarLine(insertSale("cancelled", true), 1, &cancelledBasis)

	meadSaleID := insertSale("paid", true)
	if _, err := server.pool.Exec(ctx, `
		INSERT INTO sale_items
			(sale_id, kind, product_id, quantity, unit_price_cents, cost_basis_cents)
		VALUES ($1, 'mead', $2, 1, 2500, NULL)`, meadSaleID, productID); err != nil {
		t.Fatalf("seed mead line: %v", err)
	}

	response, body := call(t, server.profitabilityAnalytics,
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
	jar := byKind["jar"]
	if jar["revenue"] != 36.0 || jar["cost"] != 7.0 || jar["margin"] != 29.0 {
		t.Fatalf("jar profitability = %#v, want revenue 36, cost 7, margin 29", jar)
	}
	mead := byKind["mead"]
	if mead["revenue"] != 25.0 || mead["cost"] != nil || mead["margin"] != nil {
		t.Fatalf("mead profitability = %#v, want revenue 25 and unknown cost/margin", mead)
	}
}
