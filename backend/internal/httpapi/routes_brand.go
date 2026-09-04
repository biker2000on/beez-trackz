package httpapi

import (
	"net/http"

	"github.com/go-chi/chi/v5"

	"github.com/biker2000on/beez-trackz/backend/internal/brand"
)

func (s *Server) mountBrand(r chi.Router) {
	r.Get("/brand", s.handleBrandGet)
}

func (s *Server) handleBrandGet(w http.ResponseWriter, _ *http.Request) {
	w.Header().Set("Cache-Control", "public, max-age=300, stale-while-revalidate=86400")
	writeJSON(w, http.StatusOK, s.resolvedBrand().Public())
}

// resolvedBrand gives directly-constructed test servers the product default;
// production servers always receive a fully validated value from config.Load.
func (s *Server) resolvedBrand() brand.Brand {
	if s != nil && s.cfg != nil && s.cfg.Brand.DisplayName != "" {
		return s.cfg.Brand
	}
	return brand.Default()
}
