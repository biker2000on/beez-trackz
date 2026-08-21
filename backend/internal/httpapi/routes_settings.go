package httpapi

import (
	"errors"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/biker2000on/beez-trackz/backend/internal/notify"
)

// mountSettings wires the preference settings endpoints. (AI provider settings
// live in routes_ai_settings.go.)
func (s *Server) mountSettings(r chi.Router) {
	admin := r.With(s.requireAdmin)
	admin.Get("/settings", s.handleSettingsGet)
	admin.Put("/settings/preferences", s.handleSettingsUpdatePreferences)
	admin.Put("/settings/ntfy", s.handleSettingsUpdateNtfy)
	admin.Get("/settings/storage", s.handleSettingsStorage)
}

const (
	prefsDefaultTheme      = "system"
	prefsDefaultDateFormat = "MM/DD/YYYY"
	prefsDefaultWeightUnit = "oz"
)

type ntfyPrefsJSON struct {
	ServerURL string `json:"serverUrl"`
	Topic     string `json:"topic"`
	// The token is write-only: it is never serialized back to any client.
	// hasAccessToken tells the settings UI whether one is stored.
	AccessToken    string   `json:"-"`
	HasAccessToken bool     `json:"hasAccessToken"`
	Enabled        bool     `json:"enabled"`
	EventKinds     []string `json:"eventKinds"`
}

type prefsJSON struct {
	DisplayName           *string       `json:"displayName"`
	Theme                 string        `json:"theme"`
	DefaultApiaryID       *uuid.UUID    `json:"defaultApiaryId"`
	DateFormat            string        `json:"dateFormat"`
	WeightUnit            string        `json:"weightUnit"`
	Units                 *string       `json:"units"`
	TemperatureUnit       *string       `json:"temperatureUnit"`
	LaborTrackingEnabled  bool          `json:"laborTrackingEnabled"`
	MiteThresholdPer100   *float64      `json:"miteThresholdPer100"`
	MiteThresholdPerDay   *float64      `json:"miteThresholdPerDay"`
	MiteCheckIntervalDays *int          `json:"miteCheckIntervalDays"`
	MoistureThresholdPct  *float64      `json:"moistureThresholdPct"`
	Ntfy                  ntfyPrefsJSON `json:"ntfy"`
}

func prefsOr(v *string, def string) string {
	if v == nil || *v == "" {
		return def
	}
	return *v
}

func normalizeUnits(raw *string) (*string, string) {
	if raw == nil {
		return nil, ""
	}
	v := strings.ToLower(strings.TrimSpace(*raw))
	if v == "" {
		return nil, ""
	}
	if v != "metric" && v != "us" {
		return nil, "units must be metric or us"
	}
	return &v, ""
}

func normalizeTemperatureUnit(raw *string) (*string, string) {
	if raw == nil {
		return nil, ""
	}
	v := strings.ToLower(strings.TrimSpace(*raw))
	if v == "" {
		// Empty string clears the override so temperature follows units.
		return nil, ""
	}
	if v != "c" && v != "f" {
		return nil, "temperatureUnit must be c or f"
	}
	return &v, ""
}

func normalizeNtfyPrefs(serverURL, topic *string, enabled *bool, kinds []string) (ntfyPrefsJSON, string) {
	out := ntfyPrefsJSON{EventKinds: []string{}}
	if serverURL != nil {
		out.ServerURL = strings.TrimRight(strings.TrimSpace(*serverURL), "/")
	}
	if topic != nil {
		out.Topic = strings.TrimSpace(*topic)
	}
	if enabled != nil {
		out.Enabled = *enabled
	}
	normalized, err := notify.NormalizeKinds(kinds)
	if err != nil {
		return out, err.Error()
	}
	out.EventKinds = normalized
	if out.ServerURL != "" && !notify.ValidServerURL(out.ServerURL) {
		return out, "ntfy serverUrl must be an http or https URL"
	}
	if out.Topic != "" && !notify.ValidTopic(out.Topic) {
		return out, "ntfy topic must be 1–64 letters, digits, underscore, or hyphen"
	}
	return out, ""
}

// GET /settings — the single user_settings row; defaults when missing
// (pre-setup instances should still render a settings page).
func (s *Server) handleSettingsGet(w http.ResponseWriter, r *http.Request) {
	var (
		displayName, theme, dateFormat, weightUnit *string
		units, temperatureUnit                     *string
		defaultApiaryID                            *uuid.UUID
		laborTracking                              bool
		ntfyURL, ntfyTopic, ntfyAccessToken        *string
		ntfyEnabled                                bool
		ntfyKinds                                  []string
		thresholdPer100, thresholdPerDay           *float64
		checkInterval                              *int
		moistureThreshold                          *float64
	)
	err := s.pool.QueryRow(r.Context(), `
		SELECT display_name, theme, default_apiary_id, date_format, weight_unit,
			units, temperature_unit, labor_tracking_enabled,
			ntfy_server_url, ntfy_topic, ntfy_access_token,
			ntfy_enabled, ntfy_event_kinds,
			mite_threshold_per_100, mite_threshold_per_day, mite_check_interval_days,
			moisture_threshold_pct
		FROM user_settings LIMIT 1`).
		Scan(&displayName, &theme, &defaultApiaryID, &dateFormat, &weightUnit,
			&units, &temperatureUnit, &laborTracking,
			&ntfyURL, &ntfyTopic, &ntfyAccessToken, &ntfyEnabled, &ntfyKinds,
			&thresholdPer100, &thresholdPerDay, &checkInterval, &moistureThreshold)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	if ntfyKinds == nil {
		ntfyKinds = []string{}
	}
	writeJSON(w, http.StatusOK, prefsJSON{
		DisplayName:           displayName,
		Theme:                 prefsOr(theme, prefsDefaultTheme),
		DefaultApiaryID:       defaultApiaryID,
		DateFormat:            prefsOr(dateFormat, prefsDefaultDateFormat),
		WeightUnit:            prefsOr(weightUnit, prefsDefaultWeightUnit),
		Units:                 units,
		TemperatureUnit:       temperatureUnit,
		LaborTrackingEnabled:  laborTracking,
		MiteThresholdPer100:   thresholdPer100,
		MiteThresholdPerDay:   thresholdPerDay,
		MiteCheckIntervalDays: checkInterval,
		MoistureThresholdPct:  moistureThreshold,
		Ntfy: ntfyPrefsJSON{
			ServerURL:      prefsOr(ntfyURL, ""),
			Topic:          prefsOr(ntfyTopic, ""),
			HasAccessToken: prefsOr(ntfyAccessToken, "") != "",
			Enabled:        ntfyEnabled,
			EventKinds:     ntfyKinds,
		},
	})
}

// PUT /settings/preferences — omitted units/temperature/labor/ntfy fields keep
// the stored value so the theme toggle does not wipe them.
func (s *Server) handleSettingsUpdatePreferences(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Theme                 string   `json:"theme"`
		DefaultApiaryID       *string  `json:"defaultApiaryId"`
		DateFormat            string   `json:"dateFormat"`
		WeightUnit            string   `json:"weightUnit"`
		Units                 *string  `json:"units"`
		TemperatureUnit       *string  `json:"temperatureUnit"`
		LaborTrackingEnabled  *bool    `json:"laborTrackingEnabled"`
		MiteThresholdPer100   *float64 `json:"miteThresholdPer100"`
		MiteThresholdPerDay   *float64 `json:"miteThresholdPerDay"`
		MiteCheckIntervalDays *int     `json:"miteCheckIntervalDays"`
		MoistureThresholdPct  *float64 `json:"moistureThresholdPct"`
		Ntfy                  *struct {
			ServerURL   *string  `json:"serverUrl"`
			Topic       *string  `json:"topic"`
			AccessToken *string  `json:"accessToken"`
			Enabled     *bool    `json:"enabled"`
			EventKinds  []string `json:"eventKinds"`
		} `json:"ntfy"`
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
	if req.MoistureThresholdPct != nil && (*req.MoistureThresholdPct <= 0 || *req.MoistureThresholdPct > 100) {
		writeError(w, http.StatusBadRequest, "moistureThresholdPct must be between 0 and 100")
		return
	}

	units, msg := normalizeUnits(req.Units)
	if msg != "" {
		writeError(w, http.StatusBadRequest, msg)
		return
	}
	temperatureUnit, msg := normalizeTemperatureUnit(req.TemperatureUnit)
	if msg != "" {
		writeError(w, http.StatusBadRequest, msg)
		return
	}
	clearTemperature := req.TemperatureUnit != nil && strings.TrimSpace(*req.TemperatureUnit) == ""

	var ntfy ntfyPrefsJSON
	patchNtfy := req.Ntfy != nil
	patchNtfyToken := false
	if patchNtfy {
		var kinds []string
		if req.Ntfy.EventKinds != nil {
			kinds = req.Ntfy.EventKinds
		}
		var errMsg string
		ntfy, errMsg = normalizeNtfyPrefs(req.Ntfy.ServerURL, req.Ntfy.Topic, req.Ntfy.Enabled, kinds)
		if errMsg != "" {
			writeError(w, http.StatusBadRequest, errMsg)
			return
		}
		if req.Ntfy.AccessToken != nil {
			patchNtfyToken = true
			ntfy.AccessToken = strings.TrimSpace(*req.Ntfy.AccessToken)
		}
	}

	theme := prefsOr(&req.Theme, prefsDefaultTheme)
	dateFormat := prefsOr(&req.DateFormat, prefsDefaultDateFormat)
	weightUnit := prefsOr(&req.WeightUnit, prefsDefaultWeightUnit)

	tag, err := s.pool.Exec(r.Context(), `
		UPDATE user_settings
		SET theme = $1, default_apiary_id = $2, date_format = $3, weight_unit = $4,
			mite_threshold_per_100 = $5, mite_threshold_per_day = $6,
			mite_check_interval_days = $7, moisture_threshold_pct = $8,
			units = COALESCE($9, units),
			temperature_unit = CASE
				WHEN $10::boolean THEN NULL
				ELSE COALESCE($11, temperature_unit)
			END,
			labor_tracking_enabled = COALESCE($12, labor_tracking_enabled),
			ntfy_server_url = CASE WHEN $13::boolean THEN $14 ELSE ntfy_server_url END,
			ntfy_topic = CASE WHEN $13::boolean THEN $15 ELSE ntfy_topic END,
			ntfy_access_token = CASE WHEN $16::boolean THEN $17 ELSE ntfy_access_token END,
			ntfy_enabled = CASE WHEN $13::boolean THEN $18 ELSE ntfy_enabled END,
			ntfy_event_kinds = CASE WHEN $13::boolean THEN $19 ELSE ntfy_event_kinds END
		WHERE id = (SELECT id FROM user_settings LIMIT 1)`,
		theme, defaultApiaryID, dateFormat, weightUnit,
		req.MiteThresholdPer100, req.MiteThresholdPerDay, req.MiteCheckIntervalDays,
		req.MoistureThresholdPct,
		units, clearTemperature, temperatureUnit, req.LaborTrackingEnabled,
		patchNtfy, ntfy.ServerURL, ntfy.Topic,
		patchNtfyToken, nullIfEmpty(ntfy.AccessToken), ntfy.Enabled, ntfy.EventKinds)
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

// PUT /settings/ntfy — ntfy webhook. Empty server/topic is stored and is a
// fail-soft no-op at publish time.
func (s *Server) handleSettingsUpdateNtfy(w http.ResponseWriter, r *http.Request) {
	var req struct {
		ServerURL string `json:"serverUrl"`
		Topic     string `json:"topic"`
		// Pointer, so an omitted token preserves the stored one; an explicit
		// empty string clears it. The token is never echoed back.
		AccessToken *string  `json:"accessToken"`
		Enabled     bool     `json:"enabled"`
		EventKinds  []string `json:"eventKinds"`
	}
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	ntfy, msg := normalizeNtfyPrefs(&req.ServerURL, &req.Topic, &req.Enabled, req.EventKinds)
	if msg != "" {
		writeError(w, http.StatusBadRequest, msg)
		return
	}
	patchToken := req.AccessToken != nil
	token := ""
	if patchToken {
		token = strings.TrimSpace(*req.AccessToken)
	}
	tag, err := s.pool.Exec(r.Context(), `
		UPDATE user_settings
		SET ntfy_server_url = $1, ntfy_topic = $2,
			ntfy_access_token = CASE WHEN $3::boolean THEN $4 ELSE ntfy_access_token END,
			ntfy_enabled = $5, ntfy_event_kinds = $6
		WHERE id = (SELECT id FROM user_settings LIMIT 1)`,
		nullIfEmpty(ntfy.ServerURL), nullIfEmpty(ntfy.Topic),
		patchToken, nullIfEmpty(token), ntfy.Enabled, ntfy.EventKinds)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	if tag.RowsAffected() == 0 {
		writeError(w, http.StatusNotFound, "No settings found")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"success": true})
}

// GET /settings/storage — default backend, fallback, Immich health, counts.
func (s *Server) handleSettingsStorage(w http.ResponseWriter, r *http.Request) {
	defaultBackend := "minio"
	configured := false
	if s.cfg != nil {
		defaultBackend = s.cfg.ResolvedPhotoBackend()
		configured = s.cfg.ImmichConfigured()
	} else if s.photos != nil {
		defaultBackend = s.photos.Preferred()
		configured = s.photos.ImmichConfigured()
	}

	counts := map[string]int{"minio": 0, "immich": 0}
	rows, err := s.pool.Query(r.Context(), `
		SELECT storage_backend::text, count(*) FROM photos GROUP BY storage_backend`)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	for rows.Next() {
		var backend string
		var n int
		if err := rows.Scan(&backend, &n); err != nil {
			rows.Close()
			writeError(w, http.StatusInternalServerError, "database error")
			return
		}
		counts[backend] = n
	}
	rows.Close()

	var healthy any
	var healthErr any
	if configured && s.photos != nil && s.photos.Immich() != nil {
		if err := s.photos.Immich().Health(r.Context()); err != nil {
			healthy = false
			healthErr = err.Error()
		} else {
			healthy = true
		}
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"defaultBackend":   defaultBackend,
		"fallbackBackend":  "minio",
		"immichConfigured": configured,
		"immichHealthy":    healthy,
		"immichError":      healthErr,
		"counts":           counts,
	})
}
