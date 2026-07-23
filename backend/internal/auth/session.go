package auth

import (
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

const (
	SessionCookieName = "session"
	SessionDuration   = 30 * 24 * time.Hour
)

// Session mirrors the legacy JWT claims: {authenticated: true, sub, name}.
// sub is "password" for password logins or the OIDC subject.
type Session struct {
	Sub  string `json:"sub"`
	Name string `json:"name"`
}

type claims struct {
	Authenticated bool   `json:"authenticated"`
	Name          string `json:"name,omitempty"`
	jwt.RegisteredClaims
}

func IssueToken(secret, sub, name string) (string, error) {
	now := time.Now()
	c := claims{
		Authenticated: true,
		Name:          name,
		RegisteredClaims: jwt.RegisteredClaims{
			Subject:   sub,
			IssuedAt:  jwt.NewNumericDate(now),
			ExpiresAt: jwt.NewNumericDate(now.Add(SessionDuration)),
		},
	}
	return jwt.NewWithClaims(jwt.SigningMethodHS256, c).SignedString([]byte(secret))
}

// SessionFromRequest accepts either the session cookie or an
// Authorization: Bearer token holding the same JWT (used by MCP clients).
func SessionFromRequest(r *http.Request, secret string) (*Session, error) {
	token := ""
	if c, err := r.Cookie(SessionCookieName); err == nil {
		token = c.Value
	}
	if h := r.Header.Get("Authorization"); token == "" && strings.HasPrefix(h, "Bearer ") {
		token = strings.TrimPrefix(h, "Bearer ")
	}
	if token == "" {
		return nil, errors.New("no session")
	}
	return ParseToken(secret, token)
}

func ParseToken(secret, token string) (*Session, error) {
	var c claims
	parsed, err := jwt.ParseWithClaims(token, &c, func(t *jwt.Token) (any, error) {
		if _, ok := t.Method.(*jwt.SigningMethodHMAC); !ok {
			return nil, errors.New("unexpected signing method")
		}
		return []byte(secret), nil
	})
	if err != nil || !parsed.Valid || !c.Authenticated {
		return nil, errors.New("invalid session")
	}
	return &Session{Sub: c.Subject, Name: c.Name}, nil
}

// NewSessionCookie builds the session cookie with legacy-compatible attributes.
func NewSessionCookie(token string, secure bool) *http.Cookie {
	return &http.Cookie{
		Name:     SessionCookieName,
		Value:    token,
		Path:     "/",
		MaxAge:   int(SessionDuration.Seconds()),
		HttpOnly: true,
		Secure:   secure,
		SameSite: http.SameSiteLaxMode,
	}
}

// ClearSessionCookie expires the session cookie.
func ClearSessionCookie(secure bool) *http.Cookie {
	return &http.Cookie{
		Name:     SessionCookieName,
		Value:    "",
		Path:     "/",
		MaxAge:   -1,
		HttpOnly: true,
		Secure:   secure,
		SameSite: http.SameSiteLaxMode,
	}
}
