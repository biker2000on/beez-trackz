package httpapi

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
)

// TestHoneyStorySignupDailyCap (SEAM-024) covers the per-slug daily cap that
// sits alongside the 5/min/IP throttle: one public slug cannot be used to
// create unlimited customer rows, no matter how many addresses it is hit from.
func TestHoneyStorySignupDailyCap(t *testing.T) {
	if os.Getenv("TEST_DATABASE_URL") == "" {
		t.Skip("TEST_DATABASE_URL is not configured")
	}
	fixture := newFeedingFixture(t)
	ctx := fixture.ctx

	slug := "cap-test-" + uuid.NewString()
	if _, err := fixture.server.pool.Exec(ctx, `
		INSERT INTO harvest_lots (lot_code, public_slug, extraction_date,
			honey_weight_lbs, is_public)
		VALUES ($1,$2,now(),10,true)`, "CAP-"+slug[:8], slug); err != nil {
		t.Fatalf("insert harvest lot: %v", err)
	}

	original := honeyStorySignupThrottle
	honeyStorySignupThrottle = newIPThrottle(2, time.Hour)
	t.Cleanup(func() { honeyStorySignupThrottle = original })

	subscribe := func(email string) *httptest.ResponseRecorder {
		body := fmt.Sprintf(`{"name":"Visitor","email":%q}`, email)
		request := httptest.NewRequest(http.MethodPost,
			"/api/v1/public/honey-stories/"+slug+"/subscribe",
			strings.NewReader(body))
		request.Header.Set("Content-Type", "application/json")
		routeCtx := chi.NewRouteContext()
		routeCtx.URLParams.Add("slug", slug)
		request = request.WithContext(
			context.WithValue(ctx, chi.RouteCtxKey, routeCtx))
		response := httptest.NewRecorder()
		fixture.server.publicHoneyStorySubscribe(response, request)
		return response
	}

	for i := 0; i < 2; i++ {
		response := subscribe(fmt.Sprintf("cap%d-%s@example.com", i, slug))
		if response.Code != http.StatusCreated {
			t.Fatalf("signup %d = %d %s, want 201",
				i, response.Code, response.Body.String())
		}
	}
	response := subscribe("cap-over-" + slug + "@example.com")
	if response.Code != http.StatusTooManyRequests {
		t.Fatalf("signup past the cap = %d %s, want 429",
			response.Code, response.Body.String())
	}
	if response.Header().Get("Retry-After") == "" {
		t.Error("capped signup is missing Retry-After")
	}

	// A different lot has its own budget.
	otherSlug := "cap-other-" + uuid.NewString()
	if _, err := fixture.server.pool.Exec(ctx, `
		INSERT INTO harvest_lots (lot_code, public_slug, extraction_date,
			honey_weight_lbs, is_public)
		VALUES ($1,$2,now(),10,true)`, "CAP-"+otherSlug[:8], otherSlug); err != nil {
		t.Fatalf("insert second harvest lot: %v", err)
	}
	if allowed, _ := honeyStorySignupThrottle.take(otherSlug); !allowed {
		t.Error("a second Honey Story shares the first one's daily budget")
	}

	// Malformed payloads must not consume the budget.
	fresh := "cap-bad-" + uuid.NewString()
	honeyStorySignupThrottle = newIPThrottle(1, time.Hour)
	badRequest := httptest.NewRequest(http.MethodPost,
		"/api/v1/public/honey-stories/"+slug+"/subscribe",
		strings.NewReader(`{"email":"not-an-email"}`))
	routeCtx := chi.NewRouteContext()
	routeCtx.URLParams.Add("slug", slug)
	badRequest = badRequest.WithContext(
		context.WithValue(ctx, chi.RouteCtxKey, routeCtx))
	badResponse := httptest.NewRecorder()
	fixture.server.publicHoneyStorySubscribe(badResponse, badRequest)
	if badResponse.Code != http.StatusBadRequest {
		t.Fatalf("invalid email = %d, want 400", badResponse.Code)
	}
	if ok := subscribe(fresh + "@example.com"); ok.Code != http.StatusCreated {
		t.Fatalf("valid signup after a rejected one = %d %s, want 201",
			ok.Code, ok.Body.String())
	}
}
