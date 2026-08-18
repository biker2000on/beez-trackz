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
	admin := r.With(s.requireAdmin)
	admin.Get("/settings", s.handleSettingsGet)
	admin.Put("/settings/preferences", s.handleSettingsUpdatePreferences)
}

const (
	prefsDefaultTheme      = "system"
	prefsDefaultDateFormat = "MM/DD/YYYY"
	prefsDefaultWeightUnit = "oz"
)

type prefsJSON struct {
	DisplayName           *string    `json:"displayName"`
	Theme                 string     `json:"theme"`
	DefaultApiaryID       *uuid.UUID `json:"defaultApiaryId"`
	DateFormat            string     `json:"dateFormat"`
	WeightUnit            string     `json:"weightUnit"`
	MiteThresholdPer100   *float64   `json:"miteThresholdPer100"`
	MiteThresholdPerDay   *float64   `json:"miteThresholdPerDay"`
	MiteCheckIntervalDays *int       `json:"miteCheckIntervalDays"`
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
		thresholdPer100, thresholdPerDay           *float64
		checkInterval                              *int
	)
	err := s.pool.QueryRow(r.Context(), `
		SELECT display_name, theme, default_apiary_id, date_format, weight_unit,
			mite_threshold_per_100, mite_threshold_per_day, mite_check_interval_days
		FROM user_settings LIMIT 1`).
		Scan(&displayName, &theme, &defaultApiaryID, &dateFormat, &weightUnit,
			&thresholdPer100, &thresholdPerDay, &checkInterval)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	writeJSON(w, http.StatusOK, prefsJSON{
		DisplayName:           displayName,
		Theme:                 prefsOr(theme, prefsDefaultTheme),
		DefaultApiaryID:       defaultApiaryID,
		DateFormat:            prefsOr(dateFormat, prefsDefaultDateFormat),
		WeightUnit:            prefsOr(weightUnit, prefsDefaultWeightUnit),
		MiteThresholdPer100:   thresholdPer100,
		MiteThresholdPerDay:   thresholdPerDay,
		MiteCheckIntervalDays: checkInterval,
	})
}

// PUT /settings/preferences {theme, defaultApiaryId?, dateFormat, weightUnit}
func (s *Server) handleSettingsUpdatePreferences(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Theme                 string   `json:"theme"`
		DefaultApiaryID       *string  `json:"defaultApiaryId"`
		DateFormat            string   `json:"dateFormat"`
		WeightUnit            string   `json:"weightUnit"`
		MiteThresholdPer100   *float64 `json:"miteThresholdPer100"`
		MiteThresholdPerDay   *float64 `json:"miteThresholdPerDay"`
		MiteCheckIntervalDays *int     `json:"miteCheckIntervalDays"`
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
	if req.MiteThresholdPer100 != nil && *req.MiteThresholdPer100 <= 0 {
		writeError(w, http.StatusBadRequest, "miteThresholdPer100 must be positive")
		return
	}
	if req.MiteThresholdPerDay != nil && *req.MiteThresholdPerDay <= 0 {
		writeError(w, http.StatusBadRequest, "miteThresholdPerDay must be positive")
		return
	}
	if req.MiteCheckIntervalDays != nil && *req.MiteCheckIntervalDays <= 0 {
		writeError(w, http.StatusBadRequest, "miteCheckIntervalDays must be positive")
		return
	}

	theme := prefsOr(&req.Theme, prefsDefaultTheme)
	dateFormat := prefsOr(&req.DateFormat, prefsDefaultDateFormat)
	weightUnit := prefsOr(&req.WeightUnit, prefsDefaultWeightUnit)

	tag, err := s.pool.Exec(r.Context(), `
		UPDATE user_settings
		SET theme = $1, default_apiary_id = $2, date_format = $3, weight_unit = $4,
			mite_threshold_per_100 = $5, mite_threshold_per_day = $6,
			mite_check_interval_days = $7
		WHERE id = (SELECT id FROM user_settings LIMIT 1)`,
		theme, defaultApiaryID, dateFormat, weightUnit,
		req.MiteThresholdPer100, req.MiteThresholdPerDay, req.MiteCheckIntervalDays)
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
