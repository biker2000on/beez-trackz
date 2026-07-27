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
