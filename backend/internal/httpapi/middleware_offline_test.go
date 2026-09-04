package httpapi

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/google/uuid"
)

func TestOfflineMutationSupported(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name   string
		method string
		path   string
		want   bool
	}{
		{"inspection", http.MethodPost, "/api/v1/inspections", true},
		{"apiary update", http.MethodPut, "/api/v1/apiaries/a", true},
		{"apiary canvas", http.MethodPut, "/api/v1/apiaries/a/canvas-layout", true},
		{"hive update", http.MethodPut, "/api/v1/hives/a", true},
		{"hive delete", http.MethodDelete, "/api/v1/hives/a", false},
		{"canvas create", http.MethodPost, "/api/v1/canvas/hives", false},
		{"harvest entry", http.MethodPost, "/api/v1/harvest-sessions/a/entries", true},
		{"harvest session create", http.MethodPost, "/api/v1/harvest-sessions", false},
		{"access token", http.MethodPost, "/api/v1/access/tokens", false},
		{"settings", http.MethodPut, "/api/v1/settings/preferences", false},
		{"MCP", http.MethodPost, "/api/v1/mcp", false},
		// Honey/commerce writes: market day is the most offline-prone surface
		// in the product and every one of these used to be excluded.
		{"record sale (retired alias)", http.MethodPost, "/api/v1/honey/sales", false},
		{"update sale (retired alias)", http.MethodPatch, "/api/v1/honey/sales/a", false},
		{"cancel sale (retired alias)", http.MethodDelete, "/api/v1/honey/sales/a", false},
		{"record sale canonical", http.MethodPost, "/api/v1/sales", true},
		{"update sale canonical", http.MethodPatch, "/api/v1/sales/a", true},
		{"cancel sale canonical", http.MethodDelete, "/api/v1/sales/a", true},
		{"jarring", http.MethodPost, "/api/v1/honey/jarring", true},
		{"give away", http.MethodPost, "/api/v1/honey/give-away", true},
		{"jar adjustment", http.MethodPost, "/api/v1/honey/jar-adjustments", true},
		{"reverse movement", http.MethodDelete, "/api/v1/honey/movements/a", true},
		{"harvest", http.MethodPost, "/api/v1/harvests", true},
		{"expense", http.MethodPost, "/api/v1/expenses", true},
		{"expense delete", http.MethodDelete, "/api/v1/expenses/a", true},
		{"jar size", http.MethodPut, "/api/v1/jar-sizes/a", true},
		{"customer", http.MethodPost, "/api/v1/customers", true},
		{"harvest lot", http.MethodPost, "/api/v1/harvest-lots", true},
		{"bottling run", http.MethodPost, "/api/v1/harvest-lots/a/bottling-runs", true},
		{"product catalog", http.MethodPost, "/api/v1/products", true},
		{"propolis harvest", http.MethodPost, "/api/v1/propolis-harvests", true},
		{"product batch", http.MethodPost, "/api/v1/product-batches", true},
		// Read-only honey routes are still out of scope.
		{"honey overview", http.MethodGet, "/api/v1/honey/overview", false},
		// Equipment ledger writes belong in the PWA queue; catalog/seed/GET
		// do not.
		{"equipment receive", http.MethodPost, "/api/v1/equipment/stock/a/receive", true},
		{"equipment adjust", http.MethodPost, "/api/v1/equipment/stock/a/adjust", true},
		{"equipment damage", http.MethodPost, "/api/v1/equipment/stock/a/damage", true},
		{"equipment repair", http.MethodPost, "/api/v1/equipment/stock/a/repair", true},
		{"equipment retire", http.MethodPost, "/api/v1/equipment/stock/a/retire", true},
		{"equipment physical count", http.MethodPost, "/api/v1/equipment/physical-count", true},
		{"equipment deploy", http.MethodPost, "/api/v1/equipment/deployments", true},
		{"equipment return", http.MethodPost, "/api/v1/equipment/deployments/a/return", true},
		{"equipment remove", http.MethodPost, "/api/v1/equipment/deployments/a/remove", true},
		{"equipment list", http.MethodGet, "/api/v1/equipment/stock", false},
		{"equipment seed", http.MethodPost, "/api/v1/equipment/seed-defaults", false},
		{"equipment type create", http.MethodPost, "/api/v1/equipment/types", false},
		{"equipment stock create", http.MethodPost, "/api/v1/equipment/stock", false},
		{"equipment stock patch", http.MethodPatch, "/api/v1/equipment/stock/a", false},
	}

	for _, test := range tests {
		test := test
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			if got := offlineMutationSupported(test.method, test.path); got != test.want {
				t.Fatalf("offlineMutationSupported(%q, %q) = %v, want %v",
					test.method, test.path, got, test.want)
			}
		})
	}
}

func TestMigratedOfflineCommandsUseTransactionalReceipts(t *testing.T) {
	t.Parallel()
	tests := []struct {
		method string
		path   string
		want   bool
	}{
		{http.MethodPost, "/api/v1/honey/jarring", true},
		{http.MethodPost, "/api/v1/honey/sales", false},
		{http.MethodPost, "/api/v1/sales", true},
		{http.MethodPatch, "/api/v1/honey/sales/abc", false},
		{http.MethodPatch, "/api/v1/sales/abc", true},
		{http.MethodPost, "/api/v1/harvest-sessions/abc/entries", true},
		{http.MethodPost, "/api/v1/harvest-lots", true},
		{http.MethodPost, "/api/v1/feedings/abc/refill", true},
		{http.MethodDelete, "/api/v1/sales/abc", false},
		{http.MethodPost, "/api/v1/expenses", false},
	}
	for _, test := range tests {
		if got := migratedOfflineCommand(test.method, test.path); got != test.want {
			t.Errorf("migratedOfflineCommand(%q, %q) = %v, want %v",
				test.method, test.path, got, test.want)
		}
	}
}

func TestOfflineCaptureWriterDoesNotWriteThrough(t *testing.T) {
	t.Parallel()
	rec := httptest.NewRecorder()
	capture := &offlineCaptureWriter{ResponseWriter: rec}
	capture.Header().Set("Content-Type", "application/json")
	capture.WriteHeader(http.StatusCreated)
	if _, err := capture.Write([]byte(`{"ok":true}`)); err != nil {
		t.Fatalf("write: %v", err)
	}
	if rec.Body.Len() != 0 {
		t.Fatalf("capture wrote through before flush: %q", rec.Body.String())
	}
	if rec.Code != http.StatusOK {
		t.Fatalf("WriteHeader wrote through, recorder code = %d", rec.Code)
	}
	flushOfflineResponse(rec, capture)
	if rec.Code != http.StatusCreated {
		t.Fatalf("flushed status = %d, want %d", rec.Code, http.StatusCreated)
	}
	if rec.Body.String() != `{"ok":true}` {
		t.Fatalf("flushed body = %q", rec.Body.String())
	}
}

func TestOffline5xxDeletesReceiptAndFlushesStatus(t *testing.T) {
	server := honeyTestServer(t)
	mutationID := uuid.New()
	handler := server.offlineMutations(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		writeError(w, http.StatusInternalServerError, "boom")
	}))
	request := adminRequest(http.MethodPost, "/api/v1/expenses", map[string]any{})
	request.Header.Set("X-Offline-Mutation-ID", mutationID.String())
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d %s, want 500", response.Code, response.Body.String())
	}
	var n int
	if err := server.pool.QueryRow(context.Background(),
		`SELECT COUNT(*) FROM offline_mutation_receipts WHERE mutation_id=$1`,
		mutationID).Scan(&n); err != nil {
		t.Fatalf("count receipts: %v", err)
	}
	if n != 0 {
		t.Fatalf("5xx left %d receipt(s)", n)
	}
}

func TestOfflineSuccessFlushesAfterReceiptCompletes(t *testing.T) {
	server := honeyTestServer(t)
	mutationID := uuid.New()
	handler := server.offlineMutations(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusCreated, map[string]any{"ok": true})
	}))
	request := adminRequest(http.MethodPost, "/api/v1/expenses", map[string]any{})
	request.Header.Set("X-Offline-Mutation-ID", mutationID.String())
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusCreated {
		t.Fatalf("status = %d %s", response.Code, response.Body.String())
	}
	var state string
	if err := server.pool.QueryRow(context.Background(),
		`SELECT state FROM offline_mutation_receipts WHERE mutation_id=$1`,
		mutationID).Scan(&state); err != nil {
		t.Fatalf("read receipt: %v", err)
	}
	if state != "complete" {
		t.Fatalf("receipt state = %q after 201, want complete", state)
	}
}

// A queued POST /equipment/stock/{id}/adjust must apply once. The second
// request with the same X-Offline-Mutation-ID is served from the receipt
// and must not append another ledger row.
func TestOfflineIdempotencyCoversEquipmentAdjust(t *testing.T) {
	server := honeyTestServer(t)
	ctx := context.Background()
	var typeID uuid.UUID
	if err := server.pool.QueryRow(ctx, `
		INSERT INTO equipment_types (name, category) VALUES ($1,'box') RETURNING id`,
		"Offline adjust "+uuid.NewString()).Scan(&typeID); err != nil {
		t.Fatalf("seed type: %v", err)
	}
	// The opening ten are booked through the ledger, which is where the
	// balance the adjust handler reads and writes actually lives.
	stockID := equipSeedStockForTest(t, server, typeID, 10)

	mutationID := uuid.New().String()
	handler := server.offlineMutations(http.HandlerFunc(server.equipAdjustStock))
	send := func() *httptest.ResponseRecorder {
		request := adminRequest(
			http.MethodPost,
			"/api/v1/equipment/stock/"+stockID.String()+"/adjust",
			map[string]any{"quantity": 2, "reason": "purchased"},
			"id", stockID.String(),
		)
		request.Header.Set("X-Offline-Mutation-ID", mutationID)
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, request)
		return response
	}

	first := send()
	if first.Code != http.StatusOK {
		t.Fatalf("first submission = %d %s", first.Code, first.Body.String())
	}
	second := send()
	if second.Code != http.StatusOK {
		t.Fatalf("replay = %d %s", second.Code, second.Body.String())
	}
	if second.Header().Get("X-Offline-Replayed") != "true" {
		t.Error("replayed equipment adjust was not served from the receipt")
	}

	// Two operations against this type: the opening receipt and one adjust.
	// A replay that slipped past the receipt would show a third.
	var n int
	if err := server.pool.QueryRow(ctx, `
		SELECT COUNT(*) FROM inventory_operations
		WHERE source_type='equipment_type' AND source_id=$1`, typeID).Scan(&n); err != nil {
		t.Fatalf("count equipment operations: %v", err)
	}
	if n != 2 {
		t.Errorf("replaying the mutation wrote %d ledger operations, want 2 (opening + one adjust)", n)
	}
	if owned := equipOnHandForTest(t, server, typeID); owned != 12 {
		t.Errorf("on hand = %d, want 12 (applied once)", owned)
	}
}
