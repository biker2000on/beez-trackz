package httpapi

import (
	"net/http"

	"github.com/go-chi/chi/v5"
)

// mountDomains wires all authenticated domain routes. Each domain lives in its
// own routes_<domain>.go file.
func (s *Server) mountDomains(r chi.Router) {
	r.Get("/me", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, principalFrom(r))
	})
	s.mountAccess(r)
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
	s.mountProducts(r)
	// Stock locations: finished goods consigned to the bike shop, the
	// transfers that put them there, and the settlement that pays for them.
	s.mountStockLocations(r)
	s.mountFieldIntelligence(r)
	s.mountMCP(r)

	// Units + weekly operations (ntfy, labor minutes, compliance packet).
	// Separate from mountOperations (treatments / varroa / yard queue).
	s.mountOps(r)
}
