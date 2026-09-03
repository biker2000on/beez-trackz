package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"

	"github.com/biker2000on/beez-trackz/backend/internal/app"
	appadmin "github.com/biker2000on/beez-trackz/backend/internal/app/admin"
)

type policyUpdateRequest struct {
	LaborTrackingEnabled  bool     `json:"laborTrackingEnabled"`
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

func (s *Server) mountAdmin(r chi.Router) {
	admin := r.With(s.requireAdmin)
	admin.Get("/admin/policy", s.handleSettingsGet)
	admin.Put("/admin/policy", s.handleAdminPolicyPut)
}

func (s *Server) handleAdminPolicyPut(w http.ResponseWriter, r *http.Request) {
	var raw json.RawMessage
	if err := decodeJSON(r, &raw); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	var req policyUpdateRequest
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(raw, &req); err != nil || json.Unmarshal(raw, &fields) != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	_, setLabor := fields["laborTrackingEnabled"]
	_, setPer100 := fields["miteThresholdPer100"]
	_, setPerDay := fields["miteThresholdPerDay"]
	_, setInterval := fields["miteCheckIntervalDays"]
	_, setMoisture := fields["moistureThresholdPct"]
	command := appadmin.UpdatePolicyCommand{
		SetLaborTrackingEnabled: setLabor,
		LaborTrackingEnabled:    req.LaborTrackingEnabled,
		SetMiteThresholdPer100:  setPer100,
		MiteThresholdPer100:     req.MiteThresholdPer100,
		SetMiteThresholdPerDay:  setPerDay,
		MiteThresholdPerDay:     req.MiteThresholdPerDay,
		SetMiteCheckInterval:    setInterval,
		MiteCheckIntervalDays:   req.MiteCheckIntervalDays,
		SetMoistureThresholdPct: setMoisture,
		MoistureThresholdPct:    req.MoistureThresholdPct,
	}
	if req.Ntfy != nil {
		ntfy, message := normalizeNtfyPrefs(
			req.Ntfy.ServerURL, req.Ntfy.Topic, req.Ntfy.Enabled, req.Ntfy.EventKinds,
		)
		if message != "" {
			writeError(w, http.StatusBadRequest, message)
			return
		}
		command.SetNtfy = true
		command.NtfyServerURL = nullIfEmpty(ntfy.ServerURL)
		command.NtfyTopic = nullIfEmpty(ntfy.Topic)
		command.NtfyEnabled = ntfy.Enabled
		command.NtfyEventKinds = ntfy.EventKinds
		if req.Ntfy.AccessToken != nil {
			command.SetNtfyAccessToken = true
			command.NtfyAccessToken = nullIfEmpty(strings.TrimSpace(*req.Ntfy.AccessToken))
		}
	}
	if err := s.runInUnitOfWork(r, func(ctx context.Context, uow *app.UnitOfWork) error {
		return appadmin.UpdatePolicy(ctx, uow, command)
	}); err != nil {
		writeSettingsApplicationError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"success": true})
}
