package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"math"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
)

func (s *Server) mountApiaries(r chi.Router) {
	r.Get("/apiaries", s.handleApiaryList)
	r.Post("/apiaries", s.handleApiaryCreate)
	r.Get("/apiaries/{id}", s.handleApiaryGet)
	r.Put("/apiaries/{id}", s.handleApiaryUpdate)
	r.Delete("/apiaries/{id}", s.handleApiaryDelete)
}

// apiaryJSON is the detail response shape for a single apiary.
type apiaryJSON struct {
	ID                string          `json:"id"`
	Name              string          `json:"name"`
	Latitude          *float64        `json:"latitude"`
	Longitude         *float64        `json:"longitude"`
	Notes             *string         `json:"notes"`
	CanvasLayout      json.RawMessage `json:"canvasLayout"`
	SatelliteImageKey *string         `json:"satelliteImageKey"`
	CreatedAt         time.Time       `json:"createdAt"`
	UpdatedAt         time.Time       `json:"updatedAt"`
}

// apiaryListJSON is the list response shape (legacy getApiaries fields).
type apiaryListJSON struct {
	ID        string    `json:"id"`
	Name      string    `json:"name"`
	Latitude  *float64  `json:"latitude"`
	Longitude *float64  `json:"longitude"`
	Notes     *string   `json:"notes"`
	CreatedAt time.Time `json:"createdAt"`
	HiveCount int64     `json:"hiveCount"`
}

// apiaryPayload is the create/update request body.
type apiaryPayload struct {
	Name      string   `json:"name"`
	Latitude  *float64 `json:"latitude"`
	Longitude *float64 `json:"longitude"`
	Notes     *string  `json:"notes"`
}

// apiaryRoundCoord rounds a nullable coordinate to 6 decimals (~0.1 m).
func apiaryRoundCoord(v *float64) *float64 {
	if v == nil {
		return nil
	}
	r := math.Round(*v*1e6) / 1e6
	return &r
}

func (s *Server) apiaryFetch(ctx context.Context, id any) (*apiaryJSON, error) {
	var a apiaryJSON
	var layout []byte
	err := s.pool.QueryRow(ctx, `
		SELECT id, name, latitude, longitude, notes, canvas_layout, satellite_image_key,
		       created_at, updated_at
		FROM apiaries WHERE id = $1`, id).
		Scan(&a.ID, &a.Name, &a.Latitude, &a.Longitude, &a.Notes, &layout,
			&a.SatelliteImageKey, &a.CreatedAt, &a.UpdatedAt)
	if err != nil {
		return nil, err
	}
	a.CanvasLayout = layout
	return &a, nil
}

// GET /apiaries — ordered by name, with count of live hives.
func (s *Server) handleApiaryList(w http.ResponseWriter, r *http.Request) {
	rows, err := s.pool.Query(r.Context(), `
		SELECT a.id, a.name, a.latitude, a.longitude, a.notes, a.created_at, count(h.id)
		FROM apiaries a
		LEFT JOIN hives h ON h.apiary_id = a.id
			AND h.is_archived = false AND h.deadout_date IS NULL
		GROUP BY a.id
		ORDER BY a.name`)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	defer rows.Close()

	items := []apiaryListJSON{}
	for rows.Next() {
		var a apiaryListJSON
		if err := rows.Scan(&a.ID, &a.Name, &a.Latitude, &a.Longitude, &a.Notes,
			&a.CreatedAt, &a.HiveCount); err != nil {
			writeError(w, http.StatusInternalServerError, "database error")
			return
		}
		items = append(items, a)
	}
	if rows.Err() != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	writeJSON(w, http.StatusOK, items)
}

// POST /apiaries {name, latitude?, longitude?, notes?}
func (s *Server) handleApiaryCreate(w http.ResponseWriter, r *http.Request) {
	var req apiaryPayload
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	name := strings.TrimSpace(req.Name)
	if name == "" {
		writeError(w, http.StatusBadRequest, "Apiary name is required")
		return
	}
	var id string
	err := s.pool.QueryRow(r.Context(), `
		INSERT INTO apiaries (name, latitude, longitude, notes)
		VALUES ($1, $2, $3, $4) RETURNING id`,
		name, apiaryRoundCoord(req.Latitude), apiaryRoundCoord(req.Longitude),
		hiveTextOrNil(req.Notes)).Scan(&id)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	apiary, err := s.apiaryFetch(r.Context(), id)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	writeJSON(w, http.StatusCreated, apiary)
}

// GET /apiaries/{id}
func (s *Server) handleApiaryGet(w http.ResponseWriter, r *http.Request) {
	id, err := uuidParam(r, "id")
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	apiary, err := s.apiaryFetch(r.Context(), id)
	if errors.Is(err, pgx.ErrNoRows) {
		writeError(w, http.StatusNotFound, "apiary not found")
		return
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	writeJSON(w, http.StatusOK, apiary)
}

// PUT /apiaries/{id} {name, latitude?, longitude?, notes?}
func (s *Server) handleApiaryUpdate(w http.ResponseWriter, r *http.Request) {
	id, err := uuidParam(r, "id")
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	var req apiaryPayload
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	name := strings.TrimSpace(req.Name)
	if name == "" {
		writeError(w, http.StatusBadRequest, "Apiary name is required")
		return
	}
	tag, err := s.pool.Exec(r.Context(), `
		UPDATE apiaries SET name = $1, latitude = $2, longitude = $3, notes = $4
		WHERE id = $5`,
		name, apiaryRoundCoord(req.Latitude), apiaryRoundCoord(req.Longitude),
		hiveTextOrNil(req.Notes), id)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	if tag.RowsAffected() == 0 {
		writeError(w, http.StatusNotFound, "apiary not found")
		return
	}
	apiary, err := s.apiaryFetch(r.Context(), id)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	writeJSON(w, http.StatusOK, apiary)
}

// DELETE /apiaries/{id} — refused while any hives reference the apiary.
func (s *Server) handleApiaryDelete(w http.ResponseWriter, r *http.Request) {
	id, err := uuidParam(r, "id")
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	var count int
	if err := s.pool.QueryRow(r.Context(),
		`SELECT count(*) FROM hives WHERE apiary_id = $1`, id).Scan(&count); err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	if count > 0 {
		writeError(w, http.StatusConflict, "Cannot delete apiary with active hives.")
		return
	}
	tag, err := s.pool.Exec(r.Context(), `DELETE FROM apiaries WHERE id = $1`, id)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	if tag.RowsAffected() == 0 {
		writeError(w, http.StatusNotFound, "apiary not found")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"success": true})
}
