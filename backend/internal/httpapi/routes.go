package httpapi

import (
	"net/http"

	"github.com/go-chi/chi/v5"
)

// mountAuth wires the unauthenticated auth endpoints (login, OIDC, setup).
// Implemented in the auth port.
func (s *Server) mountAuth(r chi.Router) {
	r.Post("/auth/login", func(w http.ResponseWriter, r *http.Request) {
		writeError(w, http.StatusNotImplemented, "not implemented")
	})
}

// mountDomains wires all authenticated domain routes.
// Filled in domain-by-domain as the port progresses.
func (s *Server) mountDomains(r chi.Router) {
	r.Get("/me", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, sessionFrom(r))
	})
}
