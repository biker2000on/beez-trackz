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
	// Live GnuCash (folio) sync: connection settings, account mapping,
	// "sync now", and the reconciliation queue.
	s.mountGnuCashSync(r)
	s.mountHoney(r)
	s.mountHarvestSessions(r)
	s.mountJarSizes(r)
	s.mountEquipment(r)
	s.mountPhotos(r)
	s.mountTranscriptions(r)
	s.mountOperations(r)
	// Field objects: catch boxes, colony intake, incidents, deadout
	// autopsies, and the derived swarm/split readiness list.
	s.mountFieldObjects(r)
	s.mountCommerce(r)
	s.mountProducts(r)
	// Stock locations: finished goods consigned to the bike shop, the
	// transfers that put them there, and the settlement that pays for them.
	s.mountStockLocations(r)
	s.mountFieldIntelligence(r)
	// The WorkItem projection: one server-side answer to "what is there to
	// do?" for Today and the yard queue (routes_work.go).
	s.mountWork(r)
	s.mountWorkbenches(r)
	s.mountMCP(r)

	// Place and flow: yard scales (CSV ingest, daily weights, and the
	// series the bloom/inspection overlay chart draws).
	s.mountScale(r)

	// Units + weekly operations (ntfy, labor minutes, compliance packet).
	// Separate from mountOperations (treatments / varroa / yard queue).
	s.mountOps(r)
}
