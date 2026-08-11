package auth

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

// ASI-2-001 seed: the session token layer had zero tests.

func TestTokenRoundTrip(t *testing.T) {
	t.Parallel()
	token, err := IssueToken("secret", "password", "Beekeeper")
	if err != nil {
		t.Fatalf("issue: %v", err)
	}
	session, err := ParseToken("secret", token)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if session.Sub != "password" || session.Name != "Beekeeper" {
		t.Errorf("session = %+v", session)
	}
}

func TestParseTokenRejectsWrongSecretAndGarbage(t *testing.T) {
	t.Parallel()
	token, err := IssueToken("secret", "password", "")
	if err != nil {
		t.Fatalf("issue: %v", err)
	}
	if _, err := ParseToken("other-secret", token); err == nil {
		t.Error("a token signed with a different secret was accepted")
	}
	if _, err := ParseToken("secret", "not-a-jwt"); err == nil {
		t.Error("garbage was accepted as a session token")
	}
	if _, err := ParseToken("secret", ""); err == nil {
		t.Error("an empty token was accepted")
	}
}

func TestSessionFromRequestReadsCookieAndBearer(t *testing.T) {
	t.Parallel()
	token, err := IssueToken("secret", "password", "")
	if err != nil {
		t.Fatalf("issue: %v", err)
	}

	withCookie := httptest.NewRequest(http.MethodGet, "/", nil)
	withCookie.AddCookie(NewSessionCookie(token, false))
	if _, err := SessionFromRequest(withCookie, "secret"); err != nil {
		t.Errorf("cookie session rejected: %v", err)
	}

	withBearer := httptest.NewRequest(http.MethodGet, "/", nil)
	withBearer.Header.Set("Authorization", "Bearer "+token)
	if _, err := SessionFromRequest(withBearer, "secret"); err != nil {
		t.Errorf("bearer session rejected: %v", err)
	}

	if _, err := SessionFromRequest(
		httptest.NewRequest(http.MethodGet, "/", nil), "secret"); err == nil {
		t.Error("a request with no credentials produced a session")
	}
}

func TestSessionCookieAttributes(t *testing.T) {
	t.Parallel()
	cookie := NewSessionCookie("value", true)
	if !cookie.HttpOnly || !cookie.Secure || cookie.SameSite != http.SameSiteLaxMode {
		t.Errorf("cookie attributes = %+v", cookie)
	}
	if ClearSessionCookie(true).MaxAge != -1 {
		t.Error("clear cookie does not expire the session")
	}
}
