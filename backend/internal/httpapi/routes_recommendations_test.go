package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

type recFixture struct {
	server   *Server
	user     *principal
	apiaryID uuid.UUID
	hiveID   uuid.UUID
	ctx      context.Context
	recCount int
}

// newRecFixture creates an isolated admin user, apiary, hive, and no
// recommendations; tests insert the shapes they need.
func newRecFixture(t *testing.T) *recFixture {
	t.Helper()
	databaseURL := os.Getenv("TEST_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("TEST_DATABASE_URL is not configured")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	t.Cleanup(cancel)

	pool, err := feedingTestDatabase(ctx, databaseURL)
	if err != nil {
		t.Fatalf("connect test database: %v", err)
	}

	suffix := uuid.NewString()
	fixture := &recFixture{server: &Server{pool: pool}, ctx: ctx}

	var userID uuid.UUID
	if err := pool.QueryRow(ctx, `
		INSERT INTO app_users (auth_subject, display_name, is_admin, is_active)
		VALUES ($1,'Rec test',true,true) RETURNING id`,
		"rec-test:"+suffix).Scan(&userID); err != nil {
		t.Fatalf("insert test user: %v", err)
	}
	fixture.user = &principal{ID: userID, DisplayName: "Rec test", IsAdmin: true}

	if err := pool.QueryRow(ctx,
		`INSERT INTO apiaries (name) VALUES ($1) RETURNING id`,
		"Rec test "+suffix).Scan(&fixture.apiaryID); err != nil {
		t.Fatalf("insert test apiary: %v", err)
	}
	if err := pool.QueryRow(ctx, `
		INSERT INTO hives (apiary_id, position_label) VALUES ($1,'R1') RETURNING id`,
		fixture.apiaryID).Scan(&fixture.hiveID); err != nil {
		t.Fatalf("insert test hive: %v", err)
	}

	t.Cleanup(func() {
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cleanupCancel()
		_, _ = pool.Exec(cleanupCtx,
			`DELETE FROM ai_recommendations WHERE hive_id=$1`, fixture.hiveID)
		_, _ = pool.Exec(cleanupCtx, `DELETE FROM hives WHERE id=$1`, fixture.hiveID)
		_, _ = pool.Exec(cleanupCtx, `DELETE FROM apiaries WHERE id=$1`, fixture.apiaryID)
		_, _ = pool.Exec(cleanupCtx, `DELETE FROM app_users WHERE id=$1`, userID)
	})
	return fixture
}

func (f *recFixture) pool() *pgxpool.Pool { return f.server.pool }

// recTypes rotates seed rows across the enum: undismissed duplicates of the
// same (type, hive) are now rejected by ai_recommendations_active_unique.
var recTypes = []string{
	"inspection_due", "treatment_reminder", "equipment_needed",
	"seasonal_prep", "feeder_check",
}

func (f *recFixture) insertRec(t *testing.T, priority string) uuid.UUID {
	t.Helper()
	var id uuid.UUID
	recType := recTypes[f.recCount%len(recTypes)]
	f.recCount++
	if err := f.pool().QueryRow(f.ctx, `
		INSERT INTO ai_recommendations (hive_id, type, message, priority)
		VALUES ($1,$2,'Test recommendation',$3) RETURNING id`,
		f.hiveID, recType, priority).Scan(&id); err != nil {
		t.Fatalf("insert recommendation: %v", err)
	}
	return id
}

func (f *recFixture) call(
	t *testing.T,
	handler http.HandlerFunc,
	method, target string,
	body any,
	params map[string]string,
) *httptest.ResponseRecorder {
	t.Helper()
	var request *http.Request
	if body != nil {
		encoded, err := json.Marshal(body)
		if err != nil {
			t.Fatalf("encode body: %v", err)
		}
		request = httptest.NewRequest(method, target, bytes.NewReader(encoded))
		request.Header.Set("Content-Type", "application/json")
	} else {
		request = httptest.NewRequest(method, target, nil)
	}
	routeCtx := chi.NewRouteContext()
	for key, value := range params {
		routeCtx.URLParams.Add(key, value)
	}
	ctx := context.WithValue(f.ctx, chi.RouteCtxKey, routeCtx)
	ctx = context.WithValue(ctx, principalKey, f.user)
	response := httptest.NewRecorder()
	handler(response, request.WithContext(ctx))
	return response
}

func (f *recFixture) listIDs(t *testing.T, view string) []string {
	t.Helper()
	response := f.call(t, f.server.handleRecommendationsList,
		http.MethodGet, "/recommendations?view="+view, nil, nil)
	if response.Code != http.StatusOK {
		t.Fatalf("list %s: status %d: %s", view, response.Code, response.Body.String())
	}
	var list []recommendationJSON
	if err := json.Unmarshal(response.Body.Bytes(), &list); err != nil {
		t.Fatalf("decode list: %v", err)
	}
	ids := make([]string, 0, len(list))
	for _, item := range list {
		ids = append(ids, item.ID.String())
	}
	return ids
}

func contains(list []string, id uuid.UUID) bool {
	for _, item := range list {
		if item == id.String() {
			return true
		}
	}
	return false
}

func TestRecommendationSnoozeHidesFromPendingUntilItLapses(t *testing.T) {
	fixture := newRecFixture(t)
	id := fixture.insertRec(t, "high")

	response := fixture.call(t, fixture.server.handleRecommendationSnooze,
		http.MethodPost, "/recommendations/"+id.String()+"/snooze",
		map[string]any{"days": 7}, map[string]string{"id": id.String()})
	if response.Code != http.StatusOK {
		t.Fatalf("snooze: status %d: %s", response.Code, response.Body.String())
	}

	if contains(fixture.listIDs(t, "pending"), id) {
		t.Fatal("snoozed recommendation still listed as pending")
	}
	if !contains(fixture.listIDs(t, "all"), id) {
		t.Fatal("snoozed recommendation missing from the all view")
	}
	if contains(fixture.listIDs(t, "dismissed"), id) {
		t.Fatal("snoozed recommendation listed as dismissed")
	}

	// A snoozed rec must stay undismissed so the engine's dedup keeps
	// suppressing duplicates while it sleeps.
	var dismissed bool
	var snoozedUntil *time.Time
	if err := fixture.pool().QueryRow(fixture.ctx, `
		SELECT dismissed, snoozed_until FROM ai_recommendations WHERE id=$1`,
		id).Scan(&dismissed, &snoozedUntil); err != nil {
		t.Fatalf("read rec: %v", err)
	}
	if dismissed || snoozedUntil == nil || !snoozedUntil.After(time.Now()) {
		t.Fatalf("want undismissed with a future snooze, got dismissed=%v snoozedUntil=%v",
			dismissed, snoozedUntil)
	}

	// An expired snooze resurfaces in pending without any write.
	if _, err := fixture.pool().Exec(fixture.ctx, `
		UPDATE ai_recommendations SET snoozed_until = now() - interval '1 hour'
		WHERE id=$1`, id); err != nil {
		t.Fatalf("expire snooze: %v", err)
	}
	if !contains(fixture.listIDs(t, "pending"), id) {
		t.Fatal("recommendation with a lapsed snooze did not resurface in pending")
	}
}

func TestRecommendationDismissRestoreRoundTrip(t *testing.T) {
	fixture := newRecFixture(t)
	id := fixture.insertRec(t, "urgent")

	response := fixture.call(t, fixture.server.handleRecommendationDismiss,
		http.MethodPost, "/recommendations/"+id.String()+"/dismiss",
		nil, map[string]string{"id": id.String()})
	if response.Code != http.StatusOK {
		t.Fatalf("dismiss: status %d: %s", response.Code, response.Body.String())
	}

	var dismissedAt *time.Time
	var dismissedBy *uuid.UUID
	if err := fixture.pool().QueryRow(fixture.ctx, `
		SELECT dismissed_at, dismissed_by FROM ai_recommendations WHERE id=$1`,
		id).Scan(&dismissedAt, &dismissedBy); err != nil {
		t.Fatalf("read rec: %v", err)
	}
	if dismissedAt == nil || dismissedBy == nil || *dismissedBy != fixture.user.ID {
		t.Fatalf("dismissal audit missing: at=%v by=%v", dismissedAt, dismissedBy)
	}
	if contains(fixture.listIDs(t, "pending"), id) {
		t.Fatal("dismissed recommendation still pending")
	}
	if !contains(fixture.listIDs(t, "dismissed"), id) {
		t.Fatal("dismissed recommendation missing from the dismissed view")
	}

	response = fixture.call(t, fixture.server.handleRecommendationRestore,
		http.MethodPost, "/recommendations/"+id.String()+"/restore",
		nil, map[string]string{"id": id.String()})
	if response.Code != http.StatusOK {
		t.Fatalf("restore: status %d: %s", response.Code, response.Body.String())
	}
	if !contains(fixture.listIDs(t, "pending"), id) {
		t.Fatal("restored recommendation not pending again")
	}
	var stillDismissedAt *time.Time
	if err := fixture.pool().QueryRow(fixture.ctx, `
		SELECT dismissed_at FROM ai_recommendations WHERE id=$1`,
		id).Scan(&stillDismissedAt); err != nil {
		t.Fatalf("read rec: %v", err)
	}
	if stillDismissedAt != nil {
		t.Fatal("restore left the dismissal audit fields populated")
	}
}

func TestRecommendationBulkStateUpdatesInOneCall(t *testing.T) {
	fixture := newRecFixture(t)
	first := fixture.insertRec(t, "normal")
	second := fixture.insertRec(t, "low")

	response := fixture.call(t, fixture.server.handleRecommendationsState,
		http.MethodPost, "/recommendations/state",
		map[string]any{
			"ids":   []string{first.String(), second.String()},
			"state": "dismissed",
		}, nil)
	if response.Code != http.StatusOK {
		t.Fatalf("bulk state: status %d: %s", response.Code, response.Body.String())
	}
	var result struct {
		Updated int64 `json:"updated"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &result); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if result.Updated != 2 {
		t.Fatalf("updated = %d, want 2", result.Updated)
	}
	pending := fixture.listIDs(t, "pending")
	if contains(pending, first) || contains(pending, second) {
		t.Fatal("bulk-dismissed recommendations still pending")
	}

	response = fixture.call(t, fixture.server.handleRecommendationsState,
		http.MethodPost, "/recommendations/state",
		map[string]any{"ids": []string{first.String()}, "state": "nonsense"}, nil)
	if response.Code != http.StatusBadRequest {
		t.Fatalf("invalid state: status %d, want 400", response.Code)
	}
}
