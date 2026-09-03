package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/google/uuid"
)

func settingsRequest(method, target string, body any, userID uuid.UUID, admin bool) *http.Request {
	var encoded []byte
	if body != nil {
		encoded, _ = json.Marshal(body)
	}
	request := httptest.NewRequest(method, target, bytes.NewReader(encoded))
	ctx := context.WithValue(request.Context(), principalKey, &principal{
		ID: userID, DisplayName: "Settings test user", IsAdmin: admin,
		Memberships: map[uuid.UUID]string{},
	})
	return request.WithContext(ctx)
}

func TestPreferencesArePerUserAndHidePolicySecrets(t *testing.T) {
	server := honeyTestServer(t)
	ctx := context.Background()
	if _, err := server.pool.Exec(ctx, `INSERT INTO user_settings DEFAULT VALUES ON CONFLICT DO NOTHING`); err != nil {
		t.Fatalf("ensure operation policy: %v", err)
	}
	suffix := uuid.NewString()
	users := []uuid.UUID{uuid.New(), uuid.New()}
	for i, id := range users {
		if _, err := server.pool.Exec(ctx, `
			INSERT INTO app_users (id, auth_subject, display_name, is_admin, is_active)
			VALUES ($1,$2,$3,false,true)`, id, "preferences:"+suffix+string(rune('a'+i)), "Preferences user"); err != nil {
			t.Fatalf("insert user %d: %v", i, err)
		}
	}
	t.Cleanup(func() {
		_, _ = server.pool.Exec(context.Background(), `DELETE FROM app_users WHERE id=ANY($1)`, users)
		_, _ = server.pool.Exec(context.Background(), `
			UPDATE user_settings SET ai_provider_config=NULL, ntfy_access_token=NULL`)
	})
	if _, err := server.pool.Exec(ctx, `
		UPDATE user_settings
		SET ai_provider_config='{"apiKey":"policy-api-secret"}'::jsonb,
			ntfy_access_token='policy-ntfy-secret'`); err != nil {
		t.Fatalf("seed policy secrets: %v", err)
	}

	put := func(userID uuid.UUID, theme string) {
		t.Helper()
		response := httptest.NewRecorder()
		server.handleMePreferencesPut(response, settingsRequest(
			http.MethodPut, "/api/v1/me/preferences", map[string]any{
				"theme": theme, "defaultApiaryId": nil,
				"dateFormat": "YYYY-MM-DD", "weightUnit": "kg",
				"units": "metric", "temperatureUnit": "c",
			}, userID, false))
		if response.Code != http.StatusOK {
			t.Fatalf("PUT preferences status = %d: %s", response.Code, response.Body.String())
		}
	}
	put(users[0], "dark")
	put(users[1], "light")

	for i, wantTheme := range []string{"dark", "light"} {
		response := httptest.NewRecorder()
		server.handleMePreferencesGet(response, settingsRequest(
			http.MethodGet, "/api/v1/me/preferences", nil, users[i], false))
		if response.Code != http.StatusOK {
			t.Fatalf("GET preferences %d status = %d: %s", i, response.Code, response.Body.String())
		}
		var got preferencesJSON
		if err := json.Unmarshal(response.Body.Bytes(), &got); err != nil {
			t.Fatalf("decode preferences %d: %v", i, err)
		}
		if got.Theme != wantTheme {
			t.Errorf("user %d theme = %q, want %q", i, got.Theme, wantTheme)
		}
		body := response.Body.String()
		for _, forbidden := range []string{
			"policy-api-secret", "policy-ntfy-secret", "ai_provider_config",
			"ntfy_access_token", "laborTrackingEnabled", "miteThresholdPer100",
		} {
			if strings.Contains(body, forbidden) {
				t.Errorf("non-admin preferences leaked %q: %s", forbidden, body)
			}
		}
	}

	var firstTheme, secondTheme string
	if err := server.pool.QueryRow(ctx, `
		SELECT first.theme, second.theme
		FROM user_preferences first, user_preferences second
		WHERE first.user_id=$1 AND second.user_id=$2`, users[0], users[1]).
		Scan(&firstTheme, &secondTheme); err != nil {
		t.Fatalf("read stored themes: %v", err)
	}
	if firstTheme != "dark" || secondTheme != "light" {
		t.Fatalf("stored themes = %q/%q, want dark/light", firstTheme, secondTheme)
	}

	forbidden := httptest.NewRecorder()
	server.requireAdmin(http.HandlerFunc(server.handleSettingsGet)).ServeHTTP(forbidden,
		settingsRequest(http.MethodGet, "/api/v1/admin/policy", nil, users[0], false))
	if forbidden.Code != http.StatusForbidden {
		t.Fatalf("non-admin policy GET status = %d, want 403", forbidden.Code)
	}
}

func TestPolicyUpdateRefusedForEditor(t *testing.T) {
	server := honeyTestServer(t)
	ctx := context.Background()
	if _, err := server.pool.Exec(ctx, `INSERT INTO user_settings DEFAULT VALUES ON CONFLICT DO NOTHING`); err != nil {
		t.Fatalf("ensure operation policy: %v", err)
	}
	userID := uuid.New()
	if _, err := server.pool.Exec(ctx, `
		INSERT INTO app_users (id, auth_subject, display_name, is_admin, is_active)
		VALUES ($1,$2,'Policy editor',false,true)`, userID, "policy-editor:"+uuid.NewString()); err != nil {
		t.Fatalf("insert editor: %v", err)
	}
	t.Cleanup(func() {
		_, _ = server.pool.Exec(context.Background(), `DELETE FROM app_users WHERE id=$1`, userID)
	})

	var before bool
	if err := server.pool.QueryRow(ctx,
		`SELECT labor_tracking_enabled FROM user_settings LIMIT 1`).Scan(&before); err != nil {
		t.Fatalf("read policy: %v", err)
	}
	response := httptest.NewRecorder()
	server.handleAdminPolicyPut(response, settingsRequest(
		http.MethodPut, "/api/v1/admin/policy",
		map[string]any{"laborTrackingEnabled": !before}, userID, false))
	if response.Code != http.StatusForbidden {
		t.Fatalf("editor policy PUT status = %d, want 403: %s", response.Code, response.Body.String())
	}
	var after bool
	if err := server.pool.QueryRow(ctx,
		`SELECT labor_tracking_enabled FROM user_settings LIMIT 1`).Scan(&after); err != nil {
		t.Fatalf("read policy after refusal: %v", err)
	}
	if after != before {
		t.Fatalf("editor changed labor policy from %v to %v", before, after)
	}
}

func TestAdminPolicyUpdateKeepsSecretsWriteOnly(t *testing.T) {
	server := honeyTestServer(t)
	ctx := context.Background()
	if _, err := server.pool.Exec(ctx, `INSERT INTO user_settings DEFAULT VALUES ON CONFLICT DO NOTHING`); err != nil {
		t.Fatalf("ensure operation policy: %v", err)
	}
	t.Cleanup(func() {
		_, _ = server.pool.Exec(context.Background(), `
			UPDATE user_settings
			SET labor_tracking_enabled=false, mite_threshold_per_100=NULL,
				ntfy_server_url=NULL, ntfy_topic=NULL, ntfy_access_token=NULL,
				ntfy_enabled=false, ntfy_event_kinds='{}'`)
	})

	response := httptest.NewRecorder()
	server.handleAdminPolicyPut(response, settingsRequest(
		http.MethodPut, "/api/v1/admin/policy", map[string]any{
			"laborTrackingEnabled": true,
			"miteThresholdPer100":  3.5,
			"ntfy": map[string]any{
				"serverUrl": "https://ntfy.sh/", "topic": "settings-test",
				"accessToken": "admin-write-only-token", "enabled": true,
				"eventKinds": []string{},
			},
		}, testUserID, true))
	if response.Code != http.StatusOK {
		t.Fatalf("admin policy PUT status = %d: %s", response.Code, response.Body.String())
	}
	var labor, ntfyEnabled bool
	var threshold float64
	var token string
	if err := server.pool.QueryRow(ctx, `
		SELECT labor_tracking_enabled, mite_threshold_per_100,
			ntfy_enabled, ntfy_access_token
		FROM user_settings LIMIT 1`).Scan(&labor, &threshold, &ntfyEnabled, &token); err != nil {
		t.Fatalf("read updated policy: %v", err)
	}
	if !labor || threshold != 3.5 || !ntfyEnabled || token != "admin-write-only-token" {
		t.Fatalf("stored policy = labor %v, threshold %v, ntfy %v, token %q",
			labor, threshold, ntfyEnabled, token)
	}

	read := httptest.NewRecorder()
	server.handleSettingsGet(read, settingsRequest(
		http.MethodGet, "/api/v1/admin/policy", nil, testUserID, true))
	if read.Code != http.StatusOK {
		t.Fatalf("admin policy GET status = %d: %s", read.Code, read.Body.String())
	}
	if strings.Contains(read.Body.String(), "admin-write-only-token") ||
		!strings.Contains(read.Body.String(), `"hasAccessToken":true`) {
		t.Fatalf("policy response did not mask ntfy token: %s", read.Body.String())
	}
}

func TestPreferencesMigrationSeparatesUserAndOperationColumns(t *testing.T) {
	server := honeyTestServer(t)
	ctx := context.Background()
	for _, column := range []string{
		"theme", "default_apiary_id", "date_format", "weight_unit", "units",
		"temperature_unit",
	} {
		var inPreferences, inSettings bool
		if err := server.pool.QueryRow(ctx, `
			SELECT
				EXISTS (SELECT 1 FROM information_schema.columns
					WHERE table_schema='public' AND table_name='user_preferences' AND column_name=$1),
				EXISTS (SELECT 1 FROM information_schema.columns
					WHERE table_schema='public' AND table_name='user_settings' AND column_name=$1)`, column).
			Scan(&inPreferences, &inSettings); err != nil {
			t.Fatalf("inspect %s: %v", column, err)
		}
		if !inPreferences || inSettings {
			t.Errorf("%s: user_preferences=%v user_settings=%v, want true/false",
				column, inPreferences, inSettings)
		}
	}
	for _, column := range []string{
		"ai_provider_config", "ntfy_access_token", "labor_tracking_enabled",
		"mite_threshold_per_100", "moisture_threshold_pct",
	} {
		var inSettings bool
		if err := server.pool.QueryRow(ctx, `
			SELECT EXISTS (SELECT 1 FROM information_schema.columns
				WHERE table_schema='public' AND table_name='user_settings' AND column_name=$1)`, column).
			Scan(&inSettings); err != nil {
			t.Fatalf("inspect %s: %v", column, err)
		}
		if !inSettings {
			t.Errorf("operation policy column %s moved out of user_settings", column)
		}
	}
}
