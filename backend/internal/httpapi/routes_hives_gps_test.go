package httpapi

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
)

// Validation runs before any database access, so a bare Server is enough.
func hiveGpsRequest(t *testing.T, body string) *httptest.ResponseRecorder {
	t.Helper()
	s := &Server{}
	req := httptest.NewRequest(http.MethodPatch,
		"/hives/5f0c1a8e-1111-2222-3333-444455556666/gps", strings.NewReader(body))
	rctx := chi.NewRouteContext()
	rctx.URLParams.Add("id", "5f0c1a8e-1111-2222-3333-444455556666")
	req = req.WithContext(context.WithValue(req.Context(), chi.RouteCtxKey, rctx))
	rec := httptest.NewRecorder()
	s.handleHiveGps(rec, req)
	return rec
}

func TestHiveGpsValidation(t *testing.T) {
	t.Parallel()
	cases := []struct {
		name string
		body string
		want int
	}{
		// An empty PATCH body must not clear coordinates.
		{"empty object", `{}`, http.StatusBadRequest},
		{"latitude only", `{"latitude": 35.5}`, http.StatusBadRequest},
		{"longitude only", `{"longitude": -82.5}`, http.StatusBadRequest},
		{"one null", `{"latitude": 35.5, "longitude": null}`, http.StatusBadRequest},
		{"lat out of range", `{"latitude": 95, "longitude": 0}`, http.StatusBadRequest},
		{"lng out of range", `{"latitude": 0, "longitude": 199}`, http.StatusBadRequest},
		{"not json", `nope`, http.StatusBadRequest},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			if got := hiveGpsRequest(t, tc.body).Code; got != tc.want {
				t.Errorf("status = %d, want %d", got, tc.want)
			}
		})
	}
}
