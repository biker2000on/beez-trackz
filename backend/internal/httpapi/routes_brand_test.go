package httpapi

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/biker2000on/beez-trackz/backend/internal/brand"
	"github.com/biker2000on/beez-trackz/backend/internal/config"
)

func TestBrandRouteIsPublicAndCacheable(t *testing.T) {
	deployment := brand.Default()
	deployment.DisplayName = "Orchard Ledger"
	deployment.ShortName = "Orchard"
	handler := NewRouter(&config.Config{
		SessionSecret: "test", AppURL: "http://localhost:3000", Brand: deployment,
	}, nil, nil, nil)
	request := httptest.NewRequest(http.MethodGet, "/api/v1/brand", nil)
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)

	if response.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200: %s", response.Code, response.Body.String())
	}
	if cache := response.Header().Get("Cache-Control"); cache == "" || cache == "no-store" {
		t.Fatalf("brand response is not cacheable: %q", cache)
	}
	var got brand.PublicBrand
	if err := json.Unmarshal(response.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	if got.DisplayName != "Orchard Ledger" || got.ShortName != "Orchard" {
		t.Fatalf("brand response = %#v", got)
	}
}
