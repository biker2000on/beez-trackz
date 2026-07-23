package auth

import (
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

const SessionCookieName = "session"

// Session mirrors the JWT claims carried in the session cookie.
type Session struct {
	UserID   string
	Username string
}

type claims struct {
	Username string `json:"username"`
	jwt.RegisteredClaims
}

// IssueToken signs a session JWT (HS256) valid for the given duration.
func IssueToken(secret, userID, username string, ttl time.Duration) (string, error) {
	now := time.Now()
	c := claims{
		Username: username,
		RegisteredClaims: jwt.RegisteredClaims{
			Subject:   userID,
			IssuedAt:  jwt.NewNumericDate(now),
			ExpiresAt: jwt.NewNumericDate(now.Add(ttl)),
		},
	}
	return jwt.NewWithClaims(jwt.SigningMethodHS256, c).SignedString([]byte(secret))
}

// SessionFromRequest accepts either the session cookie or an
// Authorization: Bearer token holding the same JWT (used by the MCP surface).
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
	if err != nil || !parsed.Valid {
		return nil, errors.New("invalid session")
	}
	return &Session{UserID: c.Subject, Username: c.Username}, nil
}
