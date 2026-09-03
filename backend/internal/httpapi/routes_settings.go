package httpapi

import (
	"context"
	"errors"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"

	"github.com/biker2000on/beez-trackz/backend/internal/app"
	appadmin "github.com/biker2000on/beez-trackz/backend/internal/app/admin"
	"github.com/biker2000on/beez-trackz/backend/internal/notify"
)

// mountSettings retains the integration-specific settings endpoints. Personal
// preferences and operation policy are mounted by mountMe and mountAdmin.
func (s *Server) mountSettings(r chi.Router) {
	admin := r.With(s.requireAdmin)
	admin.Get("/settings", s.handleSettingsGet)
	admin.Put("/settings/ntfy", s.handleSettingsUpdateNtfy)
	admin.Get("/settings/storage", s.handleSettingsStorage)
}

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

type policyJSON struct {
	DisplayName           *string       `json:"displayName"`
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

func writeSettingsApplicationError(w http.ResponseWriter, err error) {
	switch app.KindOf(err) {
	case app.KindInvalid:
		writeError(w, http.StatusBadRequest, err.Error())
	case app.KindNotFound:
		writeError(w, http.StatusNotFound, err.Error())
	case app.KindForbidden:
		writeError(w, http.StatusForbidden, err.Error())
	case app.KindConflict:
		writeError(w, http.StatusConflict, err.Error())
	default:
		writeError(w, http.StatusInternalServerError, "database error")
	}
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

// GET /settings and GET /admin/policy expose only operation-wide policy. API
// keys remain in the separately masked AI response and the ntfy token remains
// write-only.
func (s *Server) handleSettingsGet(w http.ResponseWriter, r *http.Request) {
	var (
		displayName, ntfyURL, ntfyTopic, ntfyAccessToken *string
		laborTracking, ntfyEnabled                       bool
		ntfyKinds                                        []string
		thresholdPer100, thresholdPerDay                 *float64
		checkInterval                                    *int
		moistureThreshold                                *float64
	)
	err := s.pool.QueryRow(r.Context(), `
		SELECT display_name, labor_tracking_enabled,
			ntfy_server_url, ntfy_topic, ntfy_access_token,
			ntfy_enabled, ntfy_event_kinds,
			mite_threshold_per_100, mite_threshold_per_day, mite_check_interval_days,
			moisture_threshold_pct
		FROM user_settings LIMIT 1`).
		Scan(&displayName, &laborTracking,
			&ntfyURL, &ntfyTopic, &ntfyAccessToken, &ntfyEnabled, &ntfyKinds,
			&thresholdPer100, &thresholdPerDay, &checkInterval, &moistureThreshold)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	if ntfyKinds == nil {
		ntfyKinds = []string{}
	}
	writeJSON(w, http.StatusOK, policyJSON{
		DisplayName:           displayName,
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
	command := appadmin.UpdatePolicyCommand{
		SetNtfy: true, NtfyServerURL: nullIfEmpty(ntfy.ServerURL),
		NtfyTopic: nullIfEmpty(ntfy.Topic), NtfyEnabled: ntfy.Enabled,
		NtfyEventKinds: ntfy.EventKinds, SetNtfyAccessToken: patchToken,
		NtfyAccessToken: nullIfEmpty(token),
	}
	if err := s.runInUnitOfWork(r, func(ctx context.Context, uow *app.UnitOfWork) error {
		return appadmin.UpdatePolicy(ctx, uow, command)
	}); err != nil {
		writeSettingsApplicationError(w, err)
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
