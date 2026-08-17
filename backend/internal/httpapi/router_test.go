package httpapi

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/biker2000on/beez-trackz/backend/internal/config"
)

// TestRouterConstructs catches chi route registration panics — duplicate
// routes or conflicting URL param names (e.g. /hives/{id} vs /hives/{hiveId})
// registered by different domain files.
func TestRouterConstructs(t *testing.T) {
	cfg := &config.Config{SessionSecret: "test", AppURL: "http://localhost:3000"}
	defer func() {
		if r := recover(); r != nil {
			t.Fatalf("router construction panicked: %v", r)
		}
	}()
	if h := NewRouter(cfg, nil, nil, nil); h == nil {
		t.Fatal("nil handler")
	}
}

func TestHoneyStoryRoutesArePublic(t *testing.T) {
	cfg := &config.Config{SessionSecret: "test", AppURL: "http://localhost:3000"}
	handler := NewRouter(cfg, nil, nil, nil)

	request := httptest.NewRequest(http.MethodGet, "/api/v1/public/honey-stories/test-lot", nil)
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)

	// A nil test pool causes a recovered 500 after routing. The important
	// contract is that the public route is reached without a session.
	if response.Code == http.StatusUnauthorized {
		t.Fatal("Honey Story route unexpectedly requires authentication")
	}
}

func TestOperationsRoutesRequireAuthentication(t *testing.T) {
	cfg := &config.Config{SessionSecret: "test", AppURL: "http://localhost:3000"}
	handler := NewRouter(cfg, nil, nil, nil)

	request := httptest.NewRequest(http.MethodGet, "/api/v1/analytics/yield?year=2026", nil)
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)

	if response.Code != http.StatusUnauthorized {
		t.Fatalf("operations response status = %d, want %d", response.Code, http.StatusUnauthorized)
	}
}

func TestAPIJSONBodyLimit(t *testing.T) {
	cfg := &config.Config{SessionSecret: "test", AppURL: "http://localhost:3000"}
	handler := NewRouter(cfg, nil, nil, nil)

	body := `{"password":"` + strings.Repeat("a", apiJSONBodyLimit+1) + `"}`
	request := httptest.NewRequest(http.MethodPost, "/api/v1/auth/login", strings.NewReader(body))
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusBadRequest {
		t.Fatalf("oversize JSON = %d %s, want 400", response.Code, response.Body.String())
	}
}

func TestAPIUploadPathsAreExemptFromJSONBodyLimit(t *testing.T) {
	t.Parallel()
	photo := httptest.NewRequest(http.MethodPost, "/api/v1/photos", nil)
	if !apiUploadExempt(photo) {
		t.Error("POST /api/v1/photos should be exempt")
	}
	transcription := httptest.NewRequest(http.MethodPost, "/api/v1/transcriptions/", nil)
	if !apiUploadExempt(transcription) {
		t.Error("POST /api/v1/transcriptions/ should be exempt")
	}
	login := httptest.NewRequest(http.MethodPost, "/api/v1/auth/login", nil)
	if apiUploadExempt(login) {
		t.Error("POST /api/v1/auth/login should not be exempt")
	}
}
