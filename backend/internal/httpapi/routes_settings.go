package httpapi

import (
	"errors"
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// mountSettings wires the preference settings endpoints. (AI provider settings
// live in routes_ai_settings.go.)
func (s *Server) mountSettings(r chi.Router) {
	r.Get("/settings", s.handleSettingsGet)
	r.Put("/settings/preferences", s.handleSettingsUpdatePreferences)
}

const (
	prefsDefaultTheme      = "system"
	prefsDefaultDateFormat = "MM/DD/YYYY"
	prefsDefaultWeightUnit = "oz"
)

type prefsJSON struct {
	DisplayName     *string    `json:"displayName"`
	Theme           string     `json:"theme"`
	DefaultApiaryID *uuid.UUID `json:"defaultApiaryId"`
	DateFormat      string     `json:"dateFormat"`
	WeightUnit      string     `json:"weightUnit"`
}

func prefsOr(v *string, def string) string {
	if v == nil || *v == "" {
		return def
	}
	return *v
}

// GET /settings — the single user_settings row; defaults when missing
// (pre-setup instances should still render a settings page).
func (s *Server) handleSettingsGet(w http.ResponseWriter, r *http.Request) {
	var (
		displayName, theme, dateFormat, weightUnit *string
		defaultApiaryID                            *uuid.UUID
	)
	err := s.pool.QueryRow(r.Context(), `
		SELECT display_name, theme, default_apiary_id, date_format, weight_unit
		FROM user_settings LIMIT 1`).
		Scan(&displayName, &theme, &defaultApiaryID, &dateFormat, &weightUnit)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	writeJSON(w, http.StatusOK, prefsJSON{
		DisplayName:     displayName,
		Theme:           prefsOr(theme, prefsDefaultTheme),
		DefaultApiaryID: defaultApiaryID,
		DateFormat:      prefsOr(dateFormat, prefsDefaultDateFormat),
		WeightUnit:      prefsOr(weightUnit, prefsDefaultWeightUnit),
	})
}

// PUT /settings/preferences {theme, defaultApiaryId?, dateFormat, weightUnit}
func (s *Server) handleSettingsUpdatePreferences(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Theme           string  `json:"theme"`
		DefaultApiaryID *string `json:"defaultApiaryId"`
		DateFormat      string  `json:"dateFormat"`
		WeightUnit      string  `json:"weightUnit"`
	}
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	var defaultApiaryID *uuid.UUID
	if req.DefaultApiaryID != nil && *req.DefaultApiaryID != "" {
		id, err := uuid.Parse(*req.DefaultApiaryID)
		if err != nil {
			writeError(w, http.StatusBadRequest, "invalid defaultApiaryId")
			return
		}
		defaultApiaryID = &id
	}
	theme := prefsOr(&req.Theme, prefsDefaultTheme)
	dateFormat := prefsOr(&req.DateFormat, prefsDefaultDateFormat)
	weightUnit := prefsOr(&req.WeightUnit, prefsDefaultWeightUnit)

	tag, err := s.pool.Exec(r.Context(), `
		UPDATE user_settings
		SET theme = $1, default_apiary_id = $2, date_format = $3, weight_unit = $4
		WHERE id = (SELECT id FROM user_settings LIMIT 1)`,
		theme, defaultApiaryID, dateFormat, weightUnit)
	if err != nil {
		if inspectionIsFKViolation(err) {
			writeError(w, http.StatusBadRequest, "Apiary not found")
			return
		}
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	if tag.RowsAffected() == 0 {
		writeError(w, http.StatusNotFound, "No settings found")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"success": true})
}
