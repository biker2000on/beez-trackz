package httpapi

import (
	"net/http"
	"testing"
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
		{"record sale", http.MethodPost, "/api/v1/honey/sales", true},
		{"update sale", http.MethodPatch, "/api/v1/honey/sales/a", true},
		{"cancel sale", http.MethodDelete, "/api/v1/honey/sales/a", true},
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
		// Read-only honey routes are still out of scope.
		{"honey overview", http.MethodGet, "/api/v1/honey/overview", false},
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
