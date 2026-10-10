package httpapi

import (
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"
)

// mountMeta serves small facts about the operator's data that many screens
// share, such as which season years have anything recorded.
func (s *Server) mountMeta(r chi.Router) {
	r.Get("/meta/years", s.metaYears)
}

// metaYearsResponse is the span of season years the operator has data for:
// Min is the earliest year anything was recorded, Max the later of the newest
// recorded year and Current. Year pickers list Min..Max (plus a year ahead
// where planning makes sense).
type metaYearsResponse struct {
	Min     int `json:"min"`
	Max     int `json:"max"`
	Current int `json:"current"`
}

// metaYearsSQL finds the earliest and latest year across the records that
// carry a season: sales, expenses, other income, harvests and harvest lots,
// inspections, mite counts and bloom observations. Soft-deleted rows are
// skipped where the table has a deleted_at.
const metaYearsSQL = `
	WITH years AS (
		SELECT EXTRACT(YEAR FROM date)::int AS y FROM sales
		UNION ALL SELECT EXTRACT(YEAR FROM expense_date)::int FROM expenses WHERE deleted_at IS NULL
		UNION ALL SELECT EXTRACT(YEAR FROM income_date)::int FROM other_income WHERE deleted_at IS NULL
		UNION ALL SELECT EXTRACT(YEAR FROM date)::int FROM honey_harvests WHERE deleted_at IS NULL
		UNION ALL SELECT EXTRACT(YEAR FROM date)::int FROM harvest_sessions
		UNION ALL SELECT EXTRACT(YEAR FROM extraction_date)::int FROM harvest_lots
		UNION ALL SELECT EXTRACT(YEAR FROM date)::int FROM inspections
		UNION ALL SELECT EXTRACT(YEAR FROM date)::int FROM mite_counts WHERE deleted_at IS NULL
		UNION ALL SELECT year FROM bloom_observations
	)
	SELECT MIN(y), MAX(y) FROM years WHERE y BETWEEN 1900 AND 2200`

func (s *Server) metaYears(w http.ResponseWriter, r *http.Request) {
	var earliest, latest *int
	if err := s.pool.QueryRow(r.Context(), metaYearsSQL).Scan(&earliest, &latest); err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	writeJSON(w, http.StatusOK, yearSpan(earliest, latest, time.Now().Year()))
}

// yearSpan turns the data's earliest/latest years (nil when there is no data)
// into the span a year picker lists. It always includes the current year.
func yearSpan(earliest, latest *int, current int) metaYearsResponse {
	span := metaYearsResponse{Min: current, Max: current, Current: current}
	if earliest != nil && *earliest < span.Min {
		span.Min = *earliest
	}
	if latest != nil && *latest > span.Max {
		span.Max = *latest
	}
	return span
}
