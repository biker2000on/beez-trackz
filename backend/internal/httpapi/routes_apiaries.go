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
	r.With(s.requireAdmin).Post("/apiaries", s.handleApiaryCreate)
	r.With(s.requireApiaryParamRole(false)).Get("/apiaries/{id}", s.handleApiaryGet)
	r.With(s.requireApiaryParamRole(true)).Put("/apiaries/{id}", s.handleApiaryUpdate)
	r.With(s.requireAdmin).Delete("/apiaries/{id}", s.handleApiaryDelete)
}

const (
	elevationSourceGeolocation = "geolocation"
	elevationSourceTerrain     = "terrain"
	elevationSourceOverride    = "override"
)

// apiaryJSON is the detail response shape for a single apiary.
type apiaryJSON struct {
	ID                string          `json:"id"`
	Name              string          `json:"name"`
	Latitude          *float64        `json:"latitude"`
	Longitude         *float64        `json:"longitude"`
	ElevationM        *float64        `json:"elevationM"`
	ElevationSource   *string         `json:"elevationSource"`
	Notes             *string         `json:"notes"`
	CanvasLayout      json.RawMessage `json:"canvasLayout"`
	SatelliteImageKey *string         `json:"satelliteImageKey"`
	CreatedAt         time.Time       `json:"createdAt"`
	UpdatedAt         time.Time       `json:"updatedAt"`
}

// apiaryListJSON is the list response shape (legacy getApiaries fields).
type apiaryListJSON struct {
	ID              string    `json:"id"`
	Name            string    `json:"name"`
	Latitude        *float64  `json:"latitude"`
	Longitude       *float64  `json:"longitude"`
	ElevationM      *float64  `json:"elevationM"`
	ElevationSource *string   `json:"elevationSource"`
	Notes           *string   `json:"notes"`
	CreatedAt       time.Time `json:"createdAt"`
	HiveCount       int64     `json:"hiveCount"`
}

// apiaryPayload is the create/update request body.
type apiaryPayload struct {
	Name            string   `json:"name"`
	Latitude        *float64 `json:"latitude"`
	Longitude       *float64 `json:"longitude"`
	ElevationM      *float64 `json:"elevationM"`
	ElevationSource *string  `json:"elevationSource"`
	Notes           *string  `json:"notes"`
}

// apiaryRoundCoord rounds a nullable coordinate to 8 decimals (~1 mm).
func apiaryRoundCoord(v *float64) *float64 {
	if v == nil {
		return nil
	}
	r := math.Round(*v*1e8) / 1e8
	return &r
}

// apiaryNormalizeElevation validates a ground-elevation pair. Null elevation
// is allowed (never invent 0). Sea-level 0 is kept when the operator or a
// lookup actually supplied it. Source is required whenever a value is set.
func apiaryNormalizeElevation(m *float64, source *string) (*float64, *string, error) {
	if m == nil || math.IsNaN(*m) || math.IsInf(*m, 0) {
		return nil, nil, nil
	}
	rounded := math.Round(*m*10) / 10
	if rounded < -500 || rounded > 9000 {
		return nil, nil, errors.New("elevation must be between -500 and 9000 meters")
	}
	src := elevationSourceOverride
	if source != nil {
		switch strings.TrimSpace(*source) {
		case elevationSourceGeolocation, elevationSourceTerrain, elevationSourceOverride:
			src = strings.TrimSpace(*source)
		case "":
			// omitted source on a typed value is an operator override
		default:
			return nil, nil, errors.New("elevation source must be geolocation, terrain, or override")
		}
	}
	return &rounded, &src, nil
}

func (s *Server) apiaryFetch(ctx context.Context, id any) (*apiaryJSON, error) {
	var a apiaryJSON
	var layout []byte
	err := s.pool.QueryRow(ctx, `
		SELECT id, name, latitude, longitude, elevation_m, elevation_source,
		       notes, canvas_layout, satellite_image_key, created_at, updated_at
		FROM apiaries WHERE id = $1`, id).
		Scan(&a.ID, &a.Name, &a.Latitude, &a.Longitude, &a.ElevationM, &a.ElevationSource,
			&a.Notes, &layout, &a.SatelliteImageKey, &a.CreatedAt, &a.UpdatedAt)
	if err != nil {
		return nil, err
	}
	a.CanvasLayout = layout
	return &a, nil
}

// GET /apiaries — ordered by name, with count of live hives.
func (s *Server) handleApiaryList(w http.ResponseWriter, r *http.Request) {
	user := principalFrom(r)
	rows, err := s.pool.Query(r.Context(), `
		SELECT a.id, a.name, a.latitude, a.longitude, a.elevation_m, a.elevation_source,
		       a.notes, a.created_at, count(h.id)
		FROM apiaries a
		LEFT JOIN hives h ON h.apiary_id = a.id
			AND h.is_archived = false AND h.deadout_date IS NULL
		WHERE $1::boolean OR EXISTS (
			SELECT 1 FROM apiary_memberships membership
			WHERE membership.apiary_id=a.id AND membership.user_id=$2
		)
		GROUP BY a.id
		ORDER BY a.name`, user.IsAdmin, user.ID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	defer rows.Close()

	items := []apiaryListJSON{}
	for rows.Next() {
		var a apiaryListJSON
		if err := rows.Scan(&a.ID, &a.Name, &a.Latitude, &a.Longitude,
			&a.ElevationM, &a.ElevationSource, &a.Notes,
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
	elev, elevSrc, err := apiaryNormalizeElevation(req.ElevationM, req.ElevationSource)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	var id string
	err = s.pool.QueryRow(r.Context(), `
		INSERT INTO apiaries (name, latitude, longitude, elevation_m, elevation_source, notes)
		VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
		name, apiaryRoundCoord(req.Latitude), apiaryRoundCoord(req.Longitude),
		elev, elevSrc, hiveTextOrNil(req.Notes)).Scan(&id)
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
	elev, elevSrc, elevErr := apiaryNormalizeElevation(req.ElevationM, req.ElevationSource)
	if elevErr != nil {
		writeError(w, http.StatusBadRequest, elevErr.Error())
		return
	}
	tag, err := s.pool.Exec(r.Context(), `
		UPDATE apiaries SET name = $1, latitude = $2, longitude = $3,
		                    elevation_m = $4, elevation_source = $5, notes = $6
		WHERE id = $7`,
		name, apiaryRoundCoord(req.Latitude), apiaryRoundCoord(req.Longitude),
		elev, elevSrc, hiveTextOrNil(req.Notes), id)
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
