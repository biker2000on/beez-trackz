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
)

type hiveScopeFixture struct {
	server  *Server
	editor  *principal
	apiaryA uuid.UUID
	apiaryB uuid.UUID
	hiveA   uuid.UUID
	hiveB   uuid.UUID
	ctx     context.Context
}

func newHiveScopeFixture(t *testing.T) *hiveScopeFixture {
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
	fixture := &hiveScopeFixture{server: &Server{pool: pool}, ctx: ctx}

	var userID uuid.UUID
	if err := pool.QueryRow(ctx, `
		INSERT INTO app_users (auth_subject, display_name, is_admin, is_active)
		VALUES ($1,'Scope editor',false,true) RETURNING id`,
		"scope-editor:"+suffix).Scan(&userID); err != nil {
		t.Fatalf("insert editor: %v", err)
	}
	fixture.editor = &principal{ID: userID, DisplayName: "Scope editor", IsAdmin: false}

	if err := pool.QueryRow(ctx,
		`INSERT INTO apiaries (name) VALUES ($1) RETURNING id`,
		"Yard A "+suffix).Scan(&fixture.apiaryA); err != nil {
		t.Fatalf("insert apiary A: %v", err)
	}
	if err := pool.QueryRow(ctx,
		`INSERT INTO apiaries (name) VALUES ($1) RETURNING id`,
		"Yard B "+suffix).Scan(&fixture.apiaryB); err != nil {
		t.Fatalf("insert apiary B: %v", err)
	}
	if _, err := pool.Exec(ctx, `
		INSERT INTO apiary_memberships (user_id, apiary_id, role)
		VALUES ($1,$2,'editor')`, userID, fixture.apiaryA); err != nil {
		t.Fatalf("grant editor on A: %v", err)
	}
	if err := pool.QueryRow(ctx, `
		INSERT INTO hives (apiary_id, position_label) VALUES ($1,'A1') RETURNING id`,
		fixture.apiaryA).Scan(&fixture.hiveA); err != nil {
		t.Fatalf("insert hive A: %v", err)
	}
	if err := pool.QueryRow(ctx, `
		INSERT INTO hives (apiary_id, position_label) VALUES ($1,'B1') RETURNING id`,
		fixture.apiaryB).Scan(&fixture.hiveB); err != nil {
		t.Fatalf("insert hive B: %v", err)
	}

	t.Cleanup(func() {
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cleanupCancel()
		_, _ = pool.Exec(cleanupCtx, `
			UPDATE queens SET parent_queen_id = NULL
			WHERE hive_id IN ($1,$2) OR origin_hive_id IN ($1,$2)`,
			fixture.hiveA, fixture.hiveB)
		_, _ = pool.Exec(cleanupCtx, `DELETE FROM queens WHERE hive_id IN ($1,$2) OR origin_hive_id IN ($1,$2)`,
			fixture.hiveA, fixture.hiveB)
		_, _ = pool.Exec(cleanupCtx, `DELETE FROM inspections WHERE hive_id IN ($1,$2)`,
			fixture.hiveA, fixture.hiveB)
		_, _ = pool.Exec(cleanupCtx, `DELETE FROM hives WHERE id IN ($1,$2)`,
			fixture.hiveA, fixture.hiveB)
		_, _ = pool.Exec(cleanupCtx, `DELETE FROM apiary_memberships WHERE user_id=$1`, userID)
		_, _ = pool.Exec(cleanupCtx, `DELETE FROM apiaries WHERE id IN ($1,$2)`,
			fixture.apiaryA, fixture.apiaryB)
		_, _ = pool.Exec(cleanupCtx, `DELETE FROM app_users WHERE id=$1`, userID)
	})
	return fixture
}

func (f *hiveScopeFixture) call(
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
	ctx = context.WithValue(ctx, principalKey, f.editor)
	response := httptest.NewRecorder()
	handler(response, request.WithContext(ctx))
	return response
}

func TestHiveInspectionsRespectsLimit(t *testing.T) {
	fixture := newHiveScopeFixture(t)
	for i, day := range []string{"2026-08-01", "2026-08-02", "2026-08-03"} {
		if _, err := fixture.server.pool.Exec(fixture.ctx, `
			INSERT INTO inspections (hive_id, date, notes)
			VALUES ($1,$2,$3)`,
			fixture.hiveA, day, "note "+string(rune('a'+i))); err != nil {
			t.Fatalf("insert inspection %s: %v", day, err)
		}
	}

	response := fixture.call(t, fixture.server.handleInspectionsForHive,
		http.MethodGet, "/hives/"+fixture.hiveA.String()+"/inspections?limit=2",
		nil, map[string]string{"id": fixture.hiveA.String()})
	if response.Code != http.StatusOK {
		t.Fatalf("list: status %d: %s", response.Code, response.Body.String())
	}
	var list []inspectionJSON
	if err := json.Unmarshal(response.Body.Bytes(), &list); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(list) != 2 {
		t.Fatalf("got %d inspections, want 2", len(list))
	}
}

func TestQueenCreateRejectsCrossApiaryOriginHive(t *testing.T) {
	fixture := newHiveScopeFixture(t)
	hiveA, hiveB := fixture.hiveA.String(), fixture.hiveB.String()
	response := fixture.call(t, fixture.server.handleQueenCreate,
		http.MethodPost, "/queens",
		map[string]any{"hiveId": hiveA, "origin": "purchased", "originHiveId": hiveB},
		nil)
	if response.Code != http.StatusForbidden {
		t.Fatalf("cross-apiary originHiveId = %d, want %d: %s",
			response.Code, http.StatusForbidden, response.Body.String())
	}
}

func TestQueenCreateRejectsCrossApiaryParentQueen(t *testing.T) {
	fixture := newHiveScopeFixture(t)
	var parentID uuid.UUID
	if err := fixture.server.pool.QueryRow(fixture.ctx, `
		INSERT INTO queens (hive_id, origin, status) VALUES ($1,'purchased','active')
		RETURNING id`, fixture.hiveB).Scan(&parentID); err != nil {
		t.Fatalf("insert parent queen: %v", err)
	}

	response := fixture.call(t, fixture.server.handleQueenCreate,
		http.MethodPost, "/queens",
		map[string]any{
			"hiveId": fixture.hiveA.String(), "origin": "raised",
			"parentQueenId": parentID.String(),
		}, nil)
	if response.Code != http.StatusForbidden {
		t.Fatalf("cross-apiary parentQueenId = %d, want %d: %s",
			response.Code, http.StatusForbidden, response.Body.String())
	}
}

func TestQueenCreateAcceptsSameApiaryLineage(t *testing.T) {
	fixture := newHiveScopeFixture(t)
	var parentID uuid.UUID
	if err := fixture.server.pool.QueryRow(fixture.ctx, `
		INSERT INTO queens (hive_id, origin, status) VALUES ($1,'purchased','active')
		RETURNING id`, fixture.hiveA).Scan(&parentID); err != nil {
		t.Fatalf("insert parent queen: %v", err)
	}

	response := fixture.call(t, fixture.server.handleQueenCreate,
		http.MethodPost, "/queens",
		map[string]any{
			"hiveId":        fixture.hiveA.String(),
			"origin":        "raised",
			"originHiveId":  fixture.hiveA.String(),
			"parentQueenId": parentID.String(),
		}, nil)
	if response.Code != http.StatusCreated {
		t.Fatalf("same-apiary lineage = %d, want %d: %s",
			response.Code, http.StatusCreated, response.Body.String())
	}
}

func TestQueenUpdateRejectsCrossApiaryParentQueen(t *testing.T) {
	fixture := newHiveScopeFixture(t)
	var queenID, foreignParent uuid.UUID
	if err := fixture.server.pool.QueryRow(fixture.ctx, `
		INSERT INTO queens (hive_id, origin, status) VALUES ($1,'purchased','active')
		RETURNING id`, fixture.hiveA).Scan(&queenID); err != nil {
		t.Fatalf("insert queen: %v", err)
	}
	if err := fixture.server.pool.QueryRow(fixture.ctx, `
		INSERT INTO queens (hive_id, origin, status) VALUES ($1,'purchased','active')
		RETURNING id`, fixture.hiveB).Scan(&foreignParent); err != nil {
		t.Fatalf("insert foreign parent: %v", err)
	}

	response := fixture.call(t, fixture.server.handleQueenUpdate,
		http.MethodPut, "/queens/"+queenID.String(),
		map[string]any{
			"hiveId":        fixture.hiveA.String(),
			"origin":        "raised",
			"parentQueenId": foreignParent.String(),
		}, map[string]string{"id": queenID.String()})
	if response.Code != http.StatusForbidden {
		t.Fatalf("update cross-apiary parent = %d, want %d: %s",
			response.Code, http.StatusForbidden, response.Body.String())
	}
}

func TestQueenCreateRejectsMissingParentQueen(t *testing.T) {
	fixture := newHiveScopeFixture(t)
	response := fixture.call(t, fixture.server.handleQueenCreate,
		http.MethodPost, "/queens",
		map[string]any{
			"hiveId":        fixture.hiveA.String(),
			"origin":        "raised",
			"parentQueenId": uuid.New().String(),
		}, nil)
	if response.Code != http.StatusBadRequest {
		t.Fatalf("missing parentQueenId = %d, want %d: %s",
			response.Code, http.StatusBadRequest, response.Body.String())
	}
}
