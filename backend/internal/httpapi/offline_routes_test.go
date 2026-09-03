package httpapi

import (
	"encoding/json"
	"flag"
	"net/http"
	"os"
	"path/filepath"
	"testing"
)

var updateOfflineRoutes = flag.Bool("update-offline-routes", false,
	"rewrite the generated frontend offline route manifest")

// generatedManifestPath is the TypeScript half of the offline route
// contract. It is generated, never hand-edited.
var generatedManifestPath = filepath.Join(
	"..", "..", "..", "frontend", "src", "lib", "offline-routes.generated.ts")

func offlineRoutesTypeScript(t *testing.T) string {
	t.Helper()
	encoded, err := json.MarshalIndent(offlineRoutes, "", "  ")
	if err != nil {
		t.Fatalf("encode manifest: %v", err)
	}
	return `// Code generated from backend/internal/httpapi/offline_routes.go.
// DO NOT EDIT — regenerate with:
//   cd backend && go test ./internal/httpapi \
//     -run TestOfflineRouteManifestMatchesFrontend -update-offline-routes
//
// The service worker (src/app/sw.js/route.ts) and the API's offline receipt
// middleware must queue exactly the same routes; generating this file is what
// keeps the two halves from drifting.

export interface OfflineRouteRule {
  prefix: string;
  exact?: boolean;
  methods?: string[];
  exceptMethods?: string[];
}

export interface OfflineRouteManifest {
  rules: OfflineRouteRule[];
  postExclusions: string[];
}

export const OFFLINE_ROUTE_MANIFEST: OfflineRouteManifest = ` +
		string(encoded) + ";\n"
}

// TestOfflineRouteManifestMatchesFrontend fails when the checked-in
// TypeScript manifest no longer matches the Go source of truth.
func TestOfflineRouteManifestMatchesFrontend(t *testing.T) {
	want := offlineRoutesTypeScript(t)
	if *updateOfflineRoutes {
		if err := os.WriteFile(generatedManifestPath, []byte(want), 0o644); err != nil {
			t.Fatalf("write manifest: %v", err)
		}
		return
	}
	got, err := os.ReadFile(generatedManifestPath)
	if err != nil {
		t.Fatalf("read generated manifest: %v", err)
	}
	if string(got) != want {
		t.Fatalf("frontend offline route manifest is stale; regenerate with\n"+
			"  go test ./internal/httpapi -run %s -update-offline-routes",
			t.Name())
	}
}

func TestOfflineRouteManifestRules(t *testing.T) {
	t.Parallel()
	cases := []struct {
		method, path string
		want         bool
	}{
		{http.MethodPost, "/api/v1/inspections", true},
		{http.MethodPost, "/api/v1/honey/sales", true},
		{http.MethodPost, "/api/v1/canvas/hives", false},
		{http.MethodPut, "/api/v1/canvas/hives", true},
		{http.MethodPost, "/api/v1/harvest-sessions", false},
		{http.MethodPut, "/api/v1/harvest-sessions", true},
		{http.MethodPost, "/api/v1/harvest-sessions/abc/entries", true},
		{http.MethodPost, "/api/v1/hives/bulk", true},
		{http.MethodDelete, "/api/v1/hives/bulk", true},
		{http.MethodDelete, "/api/v1/hives/abc", false},
		{http.MethodPut, "/api/v1/hives/abc", true},
		{http.MethodPut, "/api/v1/apiaries/abc", true},
		{http.MethodPost, "/api/v1/apiaries", false},
		{http.MethodDelete, "/api/v1/splits/abc", true},
		{http.MethodPost, "/api/v1/splits", false},
		{http.MethodPost, "/api/v1/auth/login", false},
		{http.MethodPost, "/api/v1/equipment/stock/abc/receive", true},
		{http.MethodPost, "/api/v1/equipment/stock/abc/adjust", true},
		{http.MethodPost, "/api/v1/equipment/stock/abc/damage", true},
		{http.MethodPost, "/api/v1/equipment/stock/abc/repair", true},
		{http.MethodPost, "/api/v1/equipment/stock/abc/retire", true},
		{http.MethodPost, "/api/v1/equipment/physical-count", true},
		{http.MethodPost, "/api/v1/equipment/deployments", true},
		{http.MethodPost, "/api/v1/equipment/deployments/abc/return", true},
		{http.MethodPost, "/api/v1/equipment/deployments/abc/remove", true},
		{http.MethodGet, "/api/v1/equipment/stock", false},
		{http.MethodGet, "/api/v1/equipment/deployments/active", false},
		{http.MethodPost, "/api/v1/equipment/seed-defaults", false},
		{http.MethodPost, "/api/v1/equipment/types", false},
		{http.MethodPost, "/api/v1/equipment/stock", false},
		{http.MethodPatch, "/api/v1/equipment/stock/abc", false},
	}
	for _, tc := range cases {
		if got := offlineMutationSupported(tc.method, tc.path); got != tc.want {
			t.Errorf("offlineMutationSupported(%s %s) = %v, want %v",
				tc.method, tc.path, got, tc.want)
		}
	}
}
