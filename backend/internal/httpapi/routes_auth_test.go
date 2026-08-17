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
