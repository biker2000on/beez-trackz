package httpapi

import (
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// mountBloom wires the bloom-observation endpoints.
func (s *Server) mountBloom(r chi.Router) {
	r.Post("/bloom-observations", s.handleBloomCreate)
	r.Get("/bloom-observations/species", s.handleBloomSpecies)
	r.With(s.requireEntityParamRole("bloom", true)).
		Post("/bloom-observations/{id}/end", s.handleBloomEnd)
	r.With(s.requireEntityParamRole("bloom", true)).
		Delete("/bloom-observations/{id}", s.handleBloomDelete)
	r.With(s.requireApiaryParamRole(false)).
		Get("/apiaries/{id}/blooms", s.handleBloomsForApiary)
}

// bloomDate formats a Postgres `date` column as YYYY-MM-DD (legacy shape).
func bloomDate(t time.Time) string {
	return t.Format("2006-01-02")
}

func bloomDatePtr(t *time.Time) *string {
	if t == nil {
		return nil
	}
	s := bloomDate(*t)
	return &s
}

type bloomJSON struct {
	ID            uuid.UUID `json:"id"`
	ApiaryID      uuid.UUID `json:"apiaryId"`
	Species       string    `json:"species"`
	DateFirstSeen string    `json:"dateFirstSeen"`
	DateLastSeen  *string   `json:"dateLastSeen"`
	Year          int       `json:"year"`
	Abundance     *int      `json:"abundance"`
	Notes         *string   `json:"notes"`
	CreatedAt     time.Time `json:"createdAt"`
}

const bloomSelectCols = `id, apiary_id, species, date_first_seen, date_last_seen,
	year, abundance, notes, created_at`

func bloomScan(row pgx.Row) (bloomJSON, error) {
	var v bloomJSON
	var firstSeen time.Time
	var lastSeen *time.Time
	err := row.Scan(&v.ID, &v.ApiaryID, &v.Species, &firstSeen, &lastSeen,
		&v.Year, &v.Abundance, &v.Notes, &v.CreatedAt)
	if err != nil {
		return v, err
	}
	v.DateFirstSeen = bloomDate(firstSeen)
	v.DateLastSeen = bloomDatePtr(lastSeen)
	return v, nil
}

// POST /bloom-observations
func (s *Server) handleBloomCreate(w http.ResponseWriter, r *http.Request) {
	var req struct {
		ApiaryID      string  `json:"apiaryId"`
		Species       string  `json:"species"`
		DateFirstSeen string  `json:"dateFirstSeen"`
		Abundance     *int    `json:"abundance"`
		Notes         *string `json:"notes"`
	}
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	species := strings.TrimSpace(req.Species)
	if req.ApiaryID == "" || species == "" || strings.TrimSpace(req.DateFirstSeen) == "" {
		writeError(w, http.StatusBadRequest, "Apiary, species, and date are required")
		return
	}
	apiaryID, err := uuid.Parse(req.ApiaryID)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid apiaryId")
		return
	}
	if !s.requireApiaryRole(w, r, apiaryID, true) {
		return
	}
	firstSeen, err := parseDate(req.DateFirstSeen)
	if err != nil {
		writeError(w, http.StatusBadRequest, "Invalid date")
		return
	}
	var id uuid.UUID
	err = s.pool.QueryRow(r.Context(), `
		INSERT INTO bloom_observations (apiary_id, species, date_first_seen, year, abundance, notes)
		VALUES ($1, $2, $3, $4, $5, $6)
		RETURNING id`,
		apiaryID, species, firstSeen, firstSeen.Year(), clampRating(req.Abundance),
		inspectionTrimPtr(req.Notes)).Scan(&id)
	if err != nil {
		if inspectionIsFKViolation(err) {
			writeError(w, http.StatusBadRequest, "Apiary not found")
			return
		}
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	created, err := bloomScan(s.pool.QueryRow(r.Context(),
		`SELECT `+bloomSelectCols+` FROM bloom_observations WHERE id = $1`, id))
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	writeJSON(w, http.StatusCreated, created)
}

// GET /apiaries/{id}/blooms?filter=active|history
func (s *Server) handleBloomsForApiary(w http.ResponseWriter, r *http.Request) {
	apiaryID, err := uuidParam(r, "id")
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	var query string
	switch filter := r.URL.Query().Get("filter"); filter {
	case "", "active":
		query = `SELECT ` + bloomSelectCols + ` FROM bloom_observations
			WHERE apiary_id = $1 AND date_last_seen IS NULL
			ORDER BY date_first_seen DESC`
	case "history":
		query = `SELECT ` + bloomSelectCols + ` FROM bloom_observations
			WHERE apiary_id = $1
			ORDER BY year DESC, date_first_seen DESC`
	default:
		writeError(w, http.StatusBadRequest, "filter must be active or history")
		return
	}
	rows, err := s.pool.Query(r.Context(), query, apiaryID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	defer rows.Close()
	list := []bloomJSON{}
	for rows.Next() {
		v, err := bloomScan(rows)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "database error")
			return
		}
		list = append(list, v)
	}
	if rows.Err() != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	writeJSON(w, http.StatusOK, list)
}

// POST /bloom-observations/{id}/end — date_last_seen = today (date-only).
func (s *Server) handleBloomEnd(w http.ResponseWriter, r *http.Request) {
	id, err := uuidParam(r, "id")
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	tag, err := s.pool.Exec(r.Context(),
		`UPDATE bloom_observations SET date_last_seen = CURRENT_DATE WHERE id = $1`, id)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	if tag.RowsAffected() == 0 {
		writeError(w, http.StatusNotFound, "Bloom observation not found")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"success": true})
}

// DELETE /bloom-observations/{id}
func (s *Server) handleBloomDelete(w http.ResponseWriter, r *http.Request) {
	id, err := uuidParam(r, "id")
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	tag, err := s.pool.Exec(r.Context(), `DELETE FROM bloom_observations WHERE id = $1`, id)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	if tag.RowsAffected() == 0 {
		writeError(w, http.StatusNotFound, "Bloom observation not found")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"success": true})
}

// GET /bloom-observations/species — distinct species, most recently seen first
// (autocomplete source).
func (s *Server) handleBloomSpecies(w http.ResponseWriter, r *http.Request) {
	rows, err := s.pool.Query(r.Context(), `
		SELECT observation.species FROM bloom_observations observation
		JOIN apiaries apiary ON apiary.id=observation.apiary_id
		WHERE ($1::boolean OR EXISTS (
			SELECT 1 FROM apiary_memberships membership
			WHERE membership.user_id=$2 AND membership.apiary_id=apiary.id
		))
		GROUP BY observation.species
		ORDER BY max(observation.date_first_seen) DESC`,
		principalFrom(r).IsAdmin, principalFrom(r).ID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	defer rows.Close()
	list := []string{}
	for rows.Next() {
		var sp string
		if err := rows.Scan(&sp); err != nil {
			writeError(w, http.StatusInternalServerError, "database error")
			return
		}
		list = append(list, sp)
	}
	if rows.Err() != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	writeJSON(w, http.StatusOK, list)
}
