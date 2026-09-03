package httpapi

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/biker2000on/beez-trackz/backend/internal/config"
)

func TestMeAndAdminSettingsRoutesRequireAuthentication(t *testing.T) {
	handler := NewRouter(&config.Config{
		SessionSecret: "settings-test", AppURL: "http://localhost:3000",
	}, nil, nil, nil)
	for _, testCase := range []struct {
		method string
		path   string
	}{
		{http.MethodGet, "/api/v1/me/preferences"},
		{http.MethodPut, "/api/v1/me/preferences"},
		{http.MethodGet, "/api/v1/admin/policy"},
		{http.MethodPut, "/api/v1/admin/policy"},
	} {
		request := httptest.NewRequest(testCase.method, testCase.path, nil)
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, request)
		if response.Code != http.StatusUnauthorized {
			t.Errorf("%s %s status = %d, want 401", testCase.method, testCase.path, response.Code)
		}
	}
}
