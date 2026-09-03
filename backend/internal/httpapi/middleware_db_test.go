package httpapi

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"
	"time"

	"github.com/biker2000on/beez-trackz/backend/internal/auth"
	"github.com/biker2000on/beez-trackz/backend/internal/config"
	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
)

// TestMiddlewareActorCarriesAccessSnapshot proves the authentication edge
// loads all memberships before any handler builds its app.Actor. Each request
// gets a fresh snapshot; nothing is cached on Server.
func TestMiddlewareActorCarriesAccessSnapshot(t *testing.T) {
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
	server := &Server{
		cfg:  &config.Config{SessionSecret: "middleware-test"},
		pool: pool,
	}

	suffix := uuid.NewString()
	var apiaryID uuid.UUID
	if err := pool.QueryRow(ctx,
		`INSERT INTO apiaries (name) VALUES ($1) RETURNING id`,
		"Middleware yard "+suffix).Scan(&apiaryID); err != nil {
		t.Fatalf("insert apiary: %v", err)
	}

	type testUser struct {
		subject string
		name    string
		admin   bool
		role    string
		id      uuid.UUID
	}
	users := []testUser{
		{subject: "middleware-member:" + suffix, name: "Member", role: "viewer"},
		{subject: "middleware-nonmember:" + suffix, name: "Non-member"},
		{subject: "middleware-admin:" + suffix, name: "Admin", admin: true},
	}
	for i := range users {
		if err := pool.QueryRow(ctx, `
			INSERT INTO app_users (auth_subject, display_name, is_admin, is_active)
			VALUES ($1,$2,$3,true) RETURNING id`,
			users[i].subject, users[i].name, users[i].admin).Scan(&users[i].id); err != nil {
			t.Fatalf("insert %s: %v", users[i].name, err)
		}
	}
	if _, err := pool.Exec(ctx, `
		INSERT INTO apiary_memberships (user_id, apiary_id, role)
		VALUES ($1,$2,$3)`, users[0].id, apiaryID, users[0].role); err != nil {
		t.Fatalf("insert membership: %v", err)
	}

	t.Cleanup(func() {
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cleanupCancel()
		ids := []uuid.UUID{users[0].id, users[1].id, users[2].id}
		_, _ = pool.Exec(cleanupCtx, `DELETE FROM apiary_memberships WHERE user_id=ANY($1)`, ids)
		_, _ = pool.Exec(cleanupCtx, `DELETE FROM app_users WHERE id=ANY($1)`, ids)
		_, _ = pool.Exec(cleanupCtx, `DELETE FROM apiaries WHERE id=$1`, apiaryID)
	})

	for _, tc := range users {
		t.Run(tc.name, func(t *testing.T) {
			var seen bool
			handler := server.requireSession(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				seen = true
				user := principalFrom(r)
				if user == nil {
					t.Fatal("handler received no principal")
				}
				if got := len(user.Memberships); got != btoi(tc.role != "") {
					t.Errorf("membership count = %d, want %d", got, btoi(tc.role != ""))
				}

				actor := appActor(r)
				if actor.MayAdminister() != tc.admin {
					t.Errorf("MayAdminister = %v, want %v", actor.MayAdminister(), tc.admin)
				}
				wantRole := tc.role
				if tc.admin {
					wantRole = "editor"
				}
				if got := actor.ApiaryRole(apiaryID); got != wantRole {
					t.Errorf("ApiaryRole = %q, want %q", got, wantRole)
				}
				w.WriteHeader(http.StatusNoContent)
			}))

			token, err := auth.IssueToken(server.cfg.SessionSecret, tc.subject, tc.name)
			if err != nil {
				t.Fatalf("issue session: %v", err)
			}
			request := httptest.NewRequest(http.MethodGet, "/protected", nil)
			request.AddCookie(auth.NewSessionCookie(token, false))
			response := httptest.NewRecorder()
			handler.ServeHTTP(response, request)
			if response.Code != http.StatusNoContent || !seen {
				t.Fatalf("status = %d, reached handler = %v: %s",
					response.Code, seen, response.Body.String())
			}
		})
	}
}

func btoi(value bool) int {
	if value {
		return 1
	}
	return 0
}

func TestRequireRecommendationRoleHiveLessIsAdminOnly(t *testing.T) {
	fixture := newRecFixture(t)

	var recommendationID uuid.UUID
	if err := fixture.pool().QueryRow(fixture.ctx, `
		INSERT INTO ai_recommendations (hive_id, type, message, priority, dismissed)
		VALUES (NULL,'seasonal_prep','All-yard task','normal',true)
		RETURNING id`).Scan(&recommendationID); err != nil {
		t.Fatalf("insert hive-less recommendation: %v", err)
	}
	t.Cleanup(func() {
		_, _ = fixture.pool().Exec(context.Background(),
			`DELETE FROM ai_recommendations WHERE id=$1`, recommendationID)
	})

	suffix := uuid.NewString()
	var editorID uuid.UUID
	if err := fixture.pool().QueryRow(fixture.ctx, `
		INSERT INTO app_users (auth_subject, display_name, is_admin, is_active)
		VALUES ($1,'Recommendation editor',false,true) RETURNING id`,
		"recommendation-editor:"+suffix).Scan(&editorID); err != nil {
		t.Fatalf("insert editor: %v", err)
	}
	if _, err := fixture.pool().Exec(fixture.ctx, `
		INSERT INTO apiary_memberships (user_id, apiary_id, role)
		VALUES ($1,$2,'editor')`, editorID, fixture.apiaryID); err != nil {
		t.Fatalf("grant editor: %v", err)
	}
	t.Cleanup(func() {
		_, _ = fixture.pool().Exec(context.Background(),
			`DELETE FROM apiary_memberships WHERE user_id=$1`, editorID)
		_, _ = fixture.pool().Exec(context.Background(),
			`DELETE FROM app_users WHERE id=$1`, editorID)
	})
	editor := &principal{
		ID: editorID, DisplayName: "Recommendation editor",
		Memberships: map[uuid.UUID]string{fixture.apiaryID: "editor"},
	}

	check := func(t *testing.T, user *principal, wantStatus int, wantNext bool) {
		t.Helper()
		reached := false
		handler := fixture.server.requireEntityParamRole("recommendation", true)(
			http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				reached = true
				w.WriteHeader(http.StatusNoContent)
			}))
		request := httptest.NewRequest(http.MethodPost,
			"/recommendations/"+recommendationID.String()+"/dismiss", nil)
		routeCtx := chi.NewRouteContext()
		routeCtx.URLParams.Add("id", recommendationID.String())
		ctx := context.WithValue(request.Context(), chi.RouteCtxKey, routeCtx)
		ctx = context.WithValue(ctx, principalKey, user)
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, request.WithContext(ctx))
		if response.Code != wantStatus || reached != wantNext {
			t.Fatalf("status = %d, reached next = %v, want %d/%v: %s",
				response.Code, reached, wantStatus, wantNext, response.Body.String())
		}
	}

	t.Run("admin allowed", func(t *testing.T) {
		check(t, fixture.user, http.StatusNoContent, true)
	})
	t.Run("editor forbidden rather than missing", func(t *testing.T) {
		check(t, editor, http.StatusForbidden, false)
	})
}
