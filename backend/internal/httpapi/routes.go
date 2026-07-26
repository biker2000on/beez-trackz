package httpapi

import (
	"net/http"

	"github.com/go-chi/chi/v5"
)

// mountDomains wires all authenticated domain routes. Each domain lives in its
// own routes_<domain>.go file.
func (s *Server) mountDomains(r chi.Router) {
	r.Get("/me", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, sessionFrom(r))
	})
	s.mountApiaries(r)
	s.mountHives(r)
	s.mountCanvas(r)
	s.mountQueens(r)
	s.mountSplits(r)
	s.mountInspections(r)
	s.mountFeedings(r)
	s.mountBloom(r)
	s.mountRecommendations(r)
	s.mountSettings(r)
	s.mountAISettings(r)
	s.mountHoney(r)
	s.mountHarvestSessions(r)
	s.mountJarSizes(r)
	s.mountEquipment(r)
	s.mountPhotos(r)
	s.mountTranscriptions(r)
	s.mountOperations(r)
	s.mountCommerce(r)
}
