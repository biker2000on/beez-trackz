package httpapi

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"github.com/google/uuid"
	"golang.org/x/crypto/bcrypt"
)

func TestSetupAlreadyCompleteReturnsConflictWithoutHashing(t *testing.T) {
	server := honeyTestServer(t)
	ctx := context.Background()
	hash, err := bcrypt.GenerateFromPassword([]byte("already-set"), bcrypt.MinCost)
	if err != nil {
		t.Fatalf("hash: %v", err)
	}
	if _, err := server.pool.Exec(ctx, `DELETE FROM user_settings`); err != nil {
		t.Fatalf("clear settings: %v", err)
	}
	if _, err := server.pool.Exec(ctx, `
		INSERT INTO user_settings (password_hash, display_name)
		VALUES ($1, 'Existing')`, string(hash)); err != nil {
		t.Fatalf("seed settings: %v", err)
	}

	request := httptest.NewRequest(http.MethodPost, "/api/v1/auth/setup",
		strings.NewReader(`{"displayName":"Eve","password":"newpassword","confirmPassword":"newpassword"}`))
	request.RemoteAddr = "198.51.100.30:1"
	response := httptest.NewRecorder()
	server.handleSetup(response, request)
	if response.Code != http.StatusConflict {
		t.Fatalf("setup after complete = %d %s, want 409", response.Code, response.Body.String())
	}
}

func TestSetupRateLimitedPerIP(t *testing.T) {
	ip := "setup-rl-" + uuid.NewString()
	for i := 0; i < 5; i++ {
		if allowed, _ := setupThrottle.take(ip); !allowed {
			t.Fatalf("prefill take %d was rejected", i+1)
		}
	}

	request := httptest.NewRequest(http.MethodPost, "/api/v1/auth/setup",
		strings.NewReader(`{"displayName":"Eve","password":"newpassword","confirmPassword":"newpassword"}`))
	request.RemoteAddr = ip
	response := httptest.NewRecorder()
	(&Server{}).handleSetup(response, request)
	if response.Code != http.StatusTooManyRequests {
		t.Fatalf("sixth setup = %d %s, want 429", response.Code, response.Body.String())
	}
}

func TestUserSettingsSingletonRejectsSecondRow(t *testing.T) {
	server := honeyTestServer(t)
	ctx := context.Background()
	if _, err := server.pool.Exec(ctx, `DELETE FROM user_settings`); err != nil {
		t.Fatalf("clear settings: %v", err)
	}
	if _, err := server.pool.Exec(ctx,
		`INSERT INTO user_settings (display_name) VALUES ('first')`); err != nil {
		t.Fatalf("insert first row: %v", err)
	}
	_, err := server.pool.Exec(ctx,
		`INSERT INTO user_settings (display_name) VALUES ('second')`)
	if err == nil {
		t.Fatal("second user_settings row was allowed")
	}
}

func TestConcurrentSetupCreatesSingleRow(t *testing.T) {
	server := honeyTestServer(t)
	ctx := context.Background()
	if _, err := server.pool.Exec(ctx, `DELETE FROM user_settings`); err != nil {
		t.Fatalf("clear settings: %v", err)
	}

	const n = 2
	codes := make([]int, n)
	var wg sync.WaitGroup
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			body := fmt.Sprintf(
				`{"displayName":"Owner %d","password":"password%d","confirmPassword":"password%d"}`,
				i, i, i)
			request := httptest.NewRequest(http.MethodPost, "/api/v1/auth/setup",
				strings.NewReader(body))
			request.RemoteAddr = fmt.Sprintf("198.51.100.%d:1", 40+i)
			response := httptest.NewRecorder()
			server.handleSetup(response, request)
			codes[i] = response.Code
		}(i)
	}
	wg.Wait()

	var rows int
	if err := server.pool.QueryRow(ctx, `SELECT COUNT(*) FROM user_settings`).Scan(&rows); err != nil {
		t.Fatalf("count settings: %v", err)
	}
	if rows != 1 {
		t.Fatalf("user_settings rows = %d, want 1", rows)
	}

	ok, conflict := 0, 0
	for _, code := range codes {
		switch code {
		case http.StatusOK:
			ok++
		case http.StatusConflict:
			conflict++
		default:
			t.Errorf("unexpected setup status %d", code)
		}
	}
	if ok != 1 || conflict != 1 {
		t.Fatalf("setup statuses = %v, want one 200 and one 409", codes)
	}
}

func TestUserPasswordLoginUsesSSOSubject(t *testing.T) {
	server := honeyTestServer(t)
	ctx := context.Background()
	suffix := uuid.NewString()
	email := "sso-" + suffix + "@example.com"
	subject := "oidc:https://idp.example/" + suffix
	hash, err := bcrypt.GenerateFromPassword([]byte("correct-horse"), bcrypt.MinCost)
	if err != nil {
		t.Fatalf("hash: %v", err)
	}
	var userID uuid.UUID
	if err := server.pool.QueryRow(ctx, `
		INSERT INTO app_users (auth_subject, display_name, email, is_admin, password_hash)
		VALUES ($1, 'SSO Owner', $2, true, $3)
		RETURNING id`, subject, email, string(hash)).Scan(&userID); err != nil {
		t.Fatalf("insert user: %v", err)
	}
	t.Cleanup(func() {
		_, _ = server.pool.Exec(context.Background(), `DELETE FROM app_users WHERE id=$1`, userID)
	})

	request := httptest.NewRequest(http.MethodPost, "/api/v1/auth/login",
		strings.NewReader(`{"email":"`+email+`","password":"correct-horse"}`))
	request.RemoteAddr = "198.51.100.90:1"
	response := httptest.NewRecorder()
	server.handleLogin(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("login = %d %s", response.Code, response.Body.String())
	}
	var cookie *http.Cookie
	for _, item := range response.Result().Cookies() {
		if item.Name == "session" {
			cookie = item
		}
	}
	if cookie == nil {
		t.Fatal("login did not set session cookie")
	}
	request = httptest.NewRequest(http.MethodGet, "/api/v1/auth/status", nil)
	request.AddCookie(cookie)
	response = httptest.NewRecorder()
	server.handleAuthStatus(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("status = %d %s", response.Code, response.Body.String())
	}
	if !strings.Contains(response.Body.String(), `"authenticated":true`) {
		t.Fatalf("password login did not authenticate as the SSO user: %s", response.Body.String())
	}
	if !strings.Contains(response.Body.String(), `"passwordLogin":true`) {
		t.Fatalf("status did not advertise password login: %s", response.Body.String())
	}

	wrong := httptest.NewRequest(http.MethodPost, "/api/v1/auth/login",
		strings.NewReader(`{"email":"`+email+`","password":"wrong-password"}`))
	wrong.RemoteAddr = "198.51.100.91:1"
	denied := httptest.NewRecorder()
	server.handleLogin(denied, wrong)
	if denied.Code != http.StatusUnauthorized {
		t.Fatalf("wrong password = %d, want 401", denied.Code)
	}
}

func TestUsernamePasswordLogin(t *testing.T) {
	server := honeyTestServer(t)
	ctx := context.Background()
	suffix := uuid.NewString()
	subject := "oidc:https://idp.example/user-" + suffix
	hash, err := bcrypt.GenerateFromPassword([]byte("correct-horse"), bcrypt.MinCost)
	if err != nil {
		t.Fatalf("hash: %v", err)
	}
	var userID uuid.UUID
	if err := server.pool.QueryRow(ctx, `
		INSERT INTO app_users (auth_subject, display_name, username, is_admin, password_hash)
		VALUES ($1, 'No Email', $2, true, $3)
		RETURNING id`, subject, "keeper-"+suffix[:8], string(hash)).Scan(&userID); err != nil {
		t.Fatalf("insert user: %v", err)
	}
	t.Cleanup(func() {
		_, _ = server.pool.Exec(context.Background(), `DELETE FROM app_users WHERE id=$1`, userID)
	})

	request := httptest.NewRequest(http.MethodPost, "/api/v1/auth/login",
		strings.NewReader(`{"email":"keeper-`+suffix[:8]+`","password":"correct-horse"}`))
	request.RemoteAddr = "198.51.100.93:1"
	response := httptest.NewRecorder()
	server.handleLogin(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("username login = %d %s", response.Code, response.Body.String())
	}
}

func TestSetPasswordOnSSOUserThenLogin(t *testing.T) {
	server := honeyTestServer(t)
	ctx := context.Background()
	suffix := uuid.NewString()
	email := "setpw-" + suffix + "@example.com"
	subject := "oidc:https://idp.example/" + suffix
	var userID uuid.UUID
	if err := server.pool.QueryRow(ctx, `
		INSERT INTO app_users (auth_subject, display_name, email, is_admin)
		VALUES ($1, 'SSO Owner', $2, true)
		RETURNING id`, subject, email).Scan(&userID); err != nil {
		t.Fatalf("insert user: %v", err)
	}
	t.Cleanup(func() {
		_, _ = server.pool.Exec(context.Background(), `DELETE FROM app_users WHERE id=$1`, userID)
	})

	request := httptest.NewRequest(http.MethodPost, "/api/v1/access/me/password",
		strings.NewReader(`{"password":"new-password","confirmPassword":"new-password"}`))
	request = request.WithContext(context.WithValue(request.Context(), principalKey, &principal{
		ID: userID, DisplayName: "SSO Owner", Email: &email, IsAdmin: true, AuthSubject: subject,
	}))
	response := httptest.NewRecorder()
	server.accessSetPassword(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("set password = %d %s", response.Code, response.Body.String())
	}

	login := httptest.NewRequest(http.MethodPost, "/api/v1/auth/login",
		strings.NewReader(`{"email":"`+email+`","password":"new-password"}`))
	login.RemoteAddr = "198.51.100.92:1"
	loggedIn := httptest.NewRecorder()
	server.handleLogin(loggedIn, login)
	if loggedIn.Code != http.StatusOK {
		t.Fatalf("login after set password = %d %s", loggedIn.Code, loggedIn.Body.String())
	}

	again := httptest.NewRequest(http.MethodPost, "/api/v1/access/me/password",
		strings.NewReader(`{"password":"other-password","confirmPassword":"other-password"}`))
	again = again.WithContext(context.WithValue(again.Context(), principalKey, &principal{
		ID: userID, DisplayName: "SSO Owner", Email: &email, IsAdmin: true, AuthSubject: subject,
	}))
	blocked := httptest.NewRecorder()
	server.accessSetPassword(blocked, again)
	if blocked.Code != http.StatusBadRequest {
		t.Fatalf("change without current = %d, want 400", blocked.Code)
	}
}

func TestSetPasswordRefusesAPITokenPrincipal(t *testing.T) {
	server := honeyTestServer(t)
	ctx := context.Background()
	suffix := uuid.NewString()
	email := "apitok-" + suffix + "@example.com"
	subject := "oidc:https://idp.example/" + suffix
	var userID uuid.UUID
	if err := server.pool.QueryRow(ctx, `
		INSERT INTO app_users (auth_subject, display_name, email, is_admin)
		VALUES ($1, 'Token Owner', $2, false)
		RETURNING id`, subject, email).Scan(&userID); err != nil {
		t.Fatalf("insert user: %v", err)
	}
	t.Cleanup(func() {
		_, _ = server.pool.Exec(context.Background(), `DELETE FROM app_users WHERE id=$1`, userID)
	})
	const body = `{"password":"new-password","confirmPassword":"new-password"}`

	viaToken := httptest.NewRequest(http.MethodPost, "/api/v1/access/me/password", strings.NewReader(body))
	viaToken = viaToken.WithContext(context.WithValue(viaToken.Context(), principalKey, &principal{
		ID: userID, DisplayName: "Token Owner", Email: &email, AuthSubject: subject, FromAPIToken: true,
	}))
	denied := httptest.NewRecorder()
	server.accessSetPassword(denied, viaToken)
	if denied.Code != http.StatusForbidden {
		t.Fatalf("API-token set password = %d, want 403: %s", denied.Code, denied.Body.String())
	}
	var hash *string
	if err := server.pool.QueryRow(ctx, `SELECT password_hash FROM app_users WHERE id=$1`, userID).Scan(&hash); err != nil {
		t.Fatalf("read hash: %v", err)
	}
	if hash != nil {
		t.Fatal("API-token request still set a password")
	}

	viaSession := httptest.NewRequest(http.MethodPost, "/api/v1/access/me/password", strings.NewReader(body))
	viaSession = viaSession.WithContext(context.WithValue(viaSession.Context(), principalKey, &principal{
		ID: userID, DisplayName: "Token Owner", Email: &email, AuthSubject: subject,
	}))
	allowed := httptest.NewRecorder()
	server.accessSetPassword(allowed, viaSession)
	if allowed.Code != http.StatusOK {
		t.Fatalf("session set password = %d, want 200: %s", allowed.Code, allowed.Body.String())
	}
}

func TestSetPasswordRejectsUsernameWithAt(t *testing.T) {
	server := honeyTestServer(t)
	userID := uuid.New()
	request := httptest.NewRequest(http.MethodPost, "/api/v1/access/me/password",
		strings.NewReader(`{"username":"victim@example.com","password":"new-password","confirmPassword":"new-password"}`))
	request = request.WithContext(context.WithValue(request.Context(), principalKey, &principal{
		ID: userID, DisplayName: "Nameless", AuthSubject: "oidc:x",
	}))
	response := httptest.NewRecorder()
	server.accessSetPassword(response, request)
	if response.Code != http.StatusBadRequest {
		t.Fatalf("username with @ = %d, want 400: %s", response.Code, response.Body.String())
	}
}

func TestPasswordLoginPrefersEmailOverShadowingUsername(t *testing.T) {
	server := honeyTestServer(t)
	ctx := context.Background()
	suffix := uuid.NewString()
	email := "victim-" + suffix + "@example.com"
	victimHash, _ := bcrypt.GenerateFromPassword([]byte("victim-pass"), bcrypt.MinCost)
	attackerHash, _ := bcrypt.GenerateFromPassword([]byte("attacker-pass"), bcrypt.MinCost)
	var victimID, attackerID uuid.UUID
	if err := server.pool.QueryRow(ctx, `
		INSERT INTO app_users (auth_subject, display_name, email, is_admin, password_hash)
		VALUES ($1, 'Victim', $2, false, $3) RETURNING id`,
		"oidc:victim-"+suffix, email, string(victimHash)).Scan(&victimID); err != nil {
		t.Fatalf("insert victim: %v", err)
	}
	// Inserted directly: the API now refuses '@' in usernames, but legacy rows may exist.
	if err := server.pool.QueryRow(ctx, `
		INSERT INTO app_users (auth_subject, display_name, username, is_admin, password_hash)
		VALUES ($1, 'Attacker', $2, false, $3) RETURNING id`,
		"oidc:attacker-"+suffix, email, string(attackerHash)).Scan(&attackerID); err != nil {
		t.Fatalf("insert attacker: %v", err)
	}
	t.Cleanup(func() {
		_, _ = server.pool.Exec(context.Background(), `DELETE FROM app_users WHERE id = ANY($1)`, []uuid.UUID{victimID, attackerID})
	})

	login := httptest.NewRequest(http.MethodPost, "/api/v1/auth/login",
		strings.NewReader(`{"email":"`+email+`","password":"attacker-pass"}`))
	login.RemoteAddr = "198.51.100.93:1"
	response := httptest.NewRecorder()
	server.handleLogin(response, login)
	if response.Code != http.StatusUnauthorized {
		t.Fatalf("shadowing username login = %d, want 401: %s", response.Code, response.Body.String())
	}

	login = httptest.NewRequest(http.MethodPost, "/api/v1/auth/login",
		strings.NewReader(`{"email":"`+email+`","password":"victim-pass"}`))
	login.RemoteAddr = "198.51.100.94:1"
	response = httptest.NewRecorder()
	server.handleLogin(response, login)
	if response.Code != http.StatusOK {
		t.Fatalf("email owner login = %d, want 200: %s", response.Code, response.Body.String())
	}
}
