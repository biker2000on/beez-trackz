package httpapi

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
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

func TestHiveGpsExplicitNullClearsManualSource(t *testing.T) {
	pool := equipPool(t)
	ctx := context.Background()
	var apiaryID uuid.UUID
	if err := pool.QueryRow(ctx, `
		INSERT INTO apiaries (name) VALUES ($1) RETURNING id`,
		"gps clear "+uuid.NewString()).Scan(&apiaryID); err != nil {
		t.Fatalf("insert apiary: %v", err)
	}
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(), `DELETE FROM apiaries WHERE id = $1`, apiaryID)
	})

	var hiveID uuid.UUID
	if err := pool.QueryRow(ctx, `
		INSERT INTO hives (apiary_id, position_label, latitude, longitude, gps_source)
		VALUES ($1, 'A1', 35.5, -82.5, 'manual') RETURNING id`, apiaryID).Scan(&hiveID); err != nil {
		t.Fatalf("insert hive: %v", err)
	}

	req := httptest.NewRequest(http.MethodPatch, "/hives/"+hiveID.String()+"/gps",
		strings.NewReader(`{"latitude":null,"longitude":null}`))
	rctx := chi.NewRouteContext()
	rctx.URLParams.Add("id", hiveID.String())
	req = req.WithContext(context.WithValue(req.Context(), chi.RouteCtxKey, rctx))
	rec := httptest.NewRecorder()
	(&Server{pool: pool}).handleHiveGps(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200: %s", rec.Code, rec.Body.String())
	}

	var latitude, longitude *float64
	var source *string
	if err := pool.QueryRow(ctx, `
		SELECT latitude, longitude, gps_source FROM hives WHERE id = $1`, hiveID).
		Scan(&latitude, &longitude, &source); err != nil {
		t.Fatalf("read hive gps: %v", err)
	}
	if latitude != nil || longitude != nil || source != nil {
		t.Fatalf("cleared gps = %v,%v source %v; want all NULL", latitude, longitude, source)
	}
}
