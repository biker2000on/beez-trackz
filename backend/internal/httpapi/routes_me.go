package httpapi

import (
	"context"
	"errors"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/biker2000on/beez-trackz/backend/internal/app"
	appme "github.com/biker2000on/beez-trackz/backend/internal/app/me"
)

const (
	prefsDefaultTheme      = "system"
	prefsDefaultDateFormat = "MM/DD/YYYY"
	prefsDefaultWeightUnit = "oz"
)

type preferencesJSON struct {
	Theme           string     `json:"theme"`
	DefaultApiaryID *uuid.UUID `json:"defaultApiaryId"`
	DateFormat      string     `json:"dateFormat"`
	WeightUnit      string     `json:"weightUnit"`
	Units           *string    `json:"units"`
	TemperatureUnit *string    `json:"temperatureUnit"`
}

func (s *Server) mountMe(r chi.Router) {
	r.Get("/me/preferences", s.handleMePreferencesGet)
	r.Put("/me/preferences", s.handleMePreferencesPut)
}

func (s *Server) handleMePreferencesGet(w http.ResponseWriter, r *http.Request) {
	user := principalFrom(r)
	if user == nil || user.ID == uuid.Nil {
		writeError(w, http.StatusForbidden, "authenticated user required")
		return
	}
	var theme, dateFormat, weightUnit, units, temperatureUnit *string
	var defaultApiaryID *uuid.UUID
	err := s.pool.QueryRow(r.Context(), `
		SELECT theme, default_apiary_id, date_format, weight_unit, units,
			temperature_unit
		FROM user_preferences
		WHERE user_id=$1`, user.ID).
		Scan(&theme, &defaultApiaryID, &dateFormat, &weightUnit, &units, &temperatureUnit)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	writeJSON(w, http.StatusOK, preferencesJSON{
		Theme:           prefsOr(theme, prefsDefaultTheme),
		DefaultApiaryID: defaultApiaryID,
		DateFormat:      prefsOr(dateFormat, prefsDefaultDateFormat),
		WeightUnit:      prefsOr(weightUnit, prefsDefaultWeightUnit),
		Units:           units,
		TemperatureUnit: temperatureUnit,
	})
}

func (s *Server) handleMePreferencesPut(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Theme           string  `json:"theme"`
		DefaultApiaryID *string `json:"defaultApiaryId"`
		DateFormat      string  `json:"dateFormat"`
		WeightUnit      string  `json:"weightUnit"`
		Units           *string `json:"units"`
		TemperatureUnit *string `json:"temperatureUnit"`
	}
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	var defaultApiaryID *uuid.UUID
	if req.DefaultApiaryID != nil && strings.TrimSpace(*req.DefaultApiaryID) != "" {
		id, err := uuid.Parse(strings.TrimSpace(*req.DefaultApiaryID))
		if err != nil {
			writeError(w, http.StatusBadRequest, "invalid defaultApiaryId")
			return
		}
		defaultApiaryID = &id
	}
	units, message := normalizeUnits(req.Units)
	if message != "" {
		writeError(w, http.StatusBadRequest, message)
		return
	}
	temperatureUnit, message := normalizeTemperatureUnit(req.TemperatureUnit)
	if message != "" {
		writeError(w, http.StatusBadRequest, message)
		return
	}
	command := appme.UpdatePreferencesCommand{
		Theme: req.Theme, DefaultApiaryID: defaultApiaryID,
		DateFormat: req.DateFormat, WeightUnit: req.WeightUnit,
		Units: units, TemperatureUnit: temperatureUnit,
	}
	if err := s.runInUnitOfWork(r, func(ctx context.Context, uow *app.UnitOfWork) error {
		return appme.UpdatePreferences(ctx, uow, command)
	}); err != nil {
		writeSettingsApplicationError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"success": true})
}
