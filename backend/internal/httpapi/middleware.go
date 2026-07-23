package httpapi

import (
	"context"
	"net/http"

	"github.com/biker2000on/beez-trackz/backend/internal/auth"
)

type ctxKey int

const sessionKey ctxKey = 0

// requireSession validates the session cookie (or Bearer token) and stores the
// session claims on the request context. Unauthenticated requests get 401 JSON —
// the frontend is a pure API client, so there are no redirects here.
func (s *Server) requireSession(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		sess, err := auth.SessionFromRequest(r, s.cfg.SessionSecret)
		if err != nil {
			writeError(w, http.StatusUnauthorized, "unauthorized")
			return
		}
		next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), sessionKey, sess)))
	})
}

func sessionFrom(r *http.Request) *auth.Session {
	sess, _ := r.Context().Value(sessionKey).(*auth.Session)
	return sess
}
