package httpapi

import (
	"net/http"
	"strconv"
	"time"

	"github.com/biker2000on/beez-trackz/backend/internal/app/production"
	"github.com/biker2000on/beez-trackz/backend/internal/app/sales"
	"github.com/go-chi/chi/v5"
)

func (s *Server) mountWorkbenches(r chi.Router) {
	r.Get("/production/workbench", s.productionWorkbench)
	r.Get("/sales/workbench", s.salesWorkbench)
}

func workbenchYear(r *http.Request) (int, error) {
	year := time.Now().UTC().Year()
	raw := r.URL.Query().Get("year")
	if raw == "" {
		return year, nil
	}
	return strconv.Atoi(raw)
}

func (s *Server) productionWorkbench(w http.ResponseWriter, r *http.Request) {
	year, err := workbenchYear(r)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid year")
		return
	}
	scoped, err := s.withMemberships(r)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	view, err := production.Workbench(scoped.Context(), s.pool, appActor(scoped), year, time.Now().UTC(), offlineRoutes.supports)
	if err != nil {
		writeCommandError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, view)
}
func (s *Server) salesWorkbench(w http.ResponseWriter, r *http.Request) {
	year, err := workbenchYear(r)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid year")
		return
	}
	view, err := sales.Workbench(r.Context(), s.pool, appActor(r), year, time.Now().UTC(), offlineRoutes.supports)
	if err != nil {
		writeCommandError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, view)
}
