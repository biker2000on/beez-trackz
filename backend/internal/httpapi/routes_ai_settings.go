package httpapi

import (
	"encoding/json"
	"fmt"
	"net/http"

	"github.com/go-chi/chi/v5"

	"github.com/biker2000on/beez-trackz/backend/internal/ai"
)

func (s *Server) mountAISettings(r chi.Router) {
	admin := r.With(s.requireAdmin)
	admin.Get("/settings/ai", s.handleAISettingsGet)
	admin.Put("/settings/ai", s.handleAISettingsPut)
	admin.Post("/settings/ai/test", s.handleAISettingsTest)
	admin.Get("/settings/ai/ollama-models", s.handleAIOllamaModels)
}

// aiTaskJSON renders a TaskConfig with camelCase fields (model omitted if empty).
func aiTaskJSON(tc ai.TaskConfig) map[string]any {
	out := map[string]any{"provider": tc.Provider}
	if tc.Model != "" {
		out["model"] = tc.Model
	}
	return out
}

// GET /settings/ai — effective config with API keys masked to booleans.
// hasAnthropicKey/hasGoogleKey reflect stored config or env fallback; the raw
// keys are never returned. ollamaUrl is a plain base URL, not a secret.
func (s *Server) handleAISettingsGet(w http.ResponseWriter, r *http.Request) {
	cfg, err := ai.LoadConfig(r.Context(), s.pool)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"transcription":   aiTaskJSON(cfg.Transcription),
		"recommendations": aiTaskJSON(cfg.Recommendations),
		"imageAnalysis":   aiTaskJSON(cfg.ImageAnalysis),
		"import":          aiTaskJSON(cfg.Import),
		"apiKeys": map[string]any{
			"hasAnthropicKey": cfg.APIKeys.Anthropic != "",
			"hasGoogleKey":    cfg.APIKeys.Google != "",
			"ollamaUrl":       cfg.APIKeys.OllamaURL,
		},
	})
}

// PUT /settings/ai — accepts the full config including keys. Empty key fields
// mean "keep the existing stored key".
func (s *Server) handleAISettingsPut(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Transcription   *ai.TaskConfig `json:"transcription"`
		Recommendations *ai.TaskConfig `json:"recommendations"`
		ImageAnalysis   *ai.TaskConfig `json:"imageAnalysis"`
		Import          *ai.TaskConfig `json:"import"`
		APIKeys         *ai.APIKeys    `json:"apiKeys"`
	}
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	for name, tc := range map[string]*ai.TaskConfig{
		"transcription": req.Transcription, "recommendations": req.Recommendations,
		"imageAnalysis": req.ImageAnalysis, "import": req.Import,
	} {
		if tc != nil && tc.Provider != "" && !ai.IsValidProvider(tc.Provider) {
			writeError(w, http.StatusBadRequest, fmt.Sprintf("Invalid %s provider", name))
			return
		}
	}

	ctx := r.Context()
	var settingsID string
	if err := s.pool.QueryRow(ctx, `SELECT id FROM user_settings LIMIT 1`).Scan(&settingsID); err != nil {
		writeError(w, http.StatusBadRequest, "No user account found. Complete setup first.")
		return
	}

	// Merge over the stored config (no env fallback — env keys must not be
	// persisted into the database).
	cfg, err := ai.LoadStoredConfig(ctx, s.pool)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	if req.Transcription != nil && req.Transcription.Provider != "" {
		cfg.Transcription = *req.Transcription
	}
	if req.Recommendations != nil && req.Recommendations.Provider != "" {
		cfg.Recommendations = *req.Recommendations
	}
	if req.ImageAnalysis != nil && req.ImageAnalysis.Provider != "" {
		cfg.ImageAnalysis = *req.ImageAnalysis
	}
	if req.Import != nil && req.Import.Provider != "" {
		cfg.Import = *req.Import
	}
	if req.APIKeys != nil {
		if req.APIKeys.Anthropic != "" {
			cfg.APIKeys.Anthropic = req.APIKeys.Anthropic
		}
		if req.APIKeys.Google != "" {
			cfg.APIKeys.Google = req.APIKeys.Google
		}
		if req.APIKeys.OllamaURL != "" {
			cfg.APIKeys.OllamaURL = req.APIKeys.OllamaURL
		}
	}

	raw, err := json.Marshal(cfg)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "encoding error")
		return
	}
	if _, err := s.pool.Exec(ctx,
		`UPDATE user_settings SET ai_provider_config = $1 WHERE id = $2`, raw, settingsID); err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"success": true})
}

// POST /settings/ai/test {provider, apiKey?, ollamaUrl?} — live connection
// test. Mirrors the legacy behavior: failures come back as {error} in a 200 so
// the settings UI can render them inline.
func (s *Server) handleAISettingsTest(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Provider  string `json:"provider"`
		APIKey    string `json:"apiKey"`
		OllamaURL string `json:"ollamaUrl"`
	}
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if req.Provider == "" {
		writeError(w, http.StatusBadRequest, "Provider is required")
		return
	}

	ctx := r.Context()
	// The settings form leaves key fields blank when a key is already stored
	// ("leave blank to keep it"), so an empty test request means "test the
	// configured key", not "no key".
	storedKey := func(pick func(*ai.AIProviderConfig) string) string {
		cfg, err := ai.LoadConfig(ctx, s.pool)
		if err != nil {
			return ""
		}
		return pick(cfg)
	}
	switch req.Provider {
	case "claude":
		key := req.APIKey
		if key == "" {
			key = storedKey(func(c *ai.AIProviderConfig) string { return c.APIKeys.Anthropic })
		}
		if key == "" {
			writeJSON(w, http.StatusOK, map[string]any{"error": "API key is required for Claude"})
			return
		}
		if _, err := ai.NewClaude(key, "").Chat(ctx, "Hi", ""); err != nil {
			writeJSON(w, http.StatusOK, map[string]any{"error": "Connection failed: " + err.Error()})
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"success": true, "message": "Claude connection successful"})
	case "gemini":
		key := req.APIKey
		if key == "" {
			key = storedKey(func(c *ai.AIProviderConfig) string { return c.APIKeys.Google })
		}
		if key == "" {
			writeJSON(w, http.StatusOK, map[string]any{"error": "API key is required for Gemini"})
			return
		}
		if _, err := ai.NewGemini(key, "").Chat(ctx, "Hi", ""); err != nil {
			writeJSON(w, http.StatusOK, map[string]any{"error": "Connection failed: " + err.Error()})
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"success": true, "message": "Gemini connection successful"})
	case "ollama":
		baseURL := req.OllamaURL
		if baseURL == "" {
			baseURL = req.APIKey // legacy passed the URL through the apiKey field
		}
		if baseURL == "" {
			baseURL = ai.DefaultOllamaURL
		}
		if _, err := ai.ListOllamaModels(ctx, baseURL); err != nil {
			writeJSON(w, http.StatusOK, map[string]any{"error": fmt.Sprintf("Ollama not reachable at %s", baseURL)})
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"success": true, "message": "Ollama connection successful"})
	default:
		writeJSON(w, http.StatusOK, map[string]any{"error": "Unknown provider: " + req.Provider})
	}
}

// GET /settings/ai/ollama-models?baseUrl= — installed Ollama models; falls back
// to the stored/env Ollama URL, and returns an empty list on errors (legacy).
func (s *Server) handleAIOllamaModels(w http.ResponseWriter, r *http.Request) {
	baseURL := r.URL.Query().Get("baseUrl")
	if baseURL == "" {
		if cfg, err := ai.LoadConfig(r.Context(), s.pool); err == nil {
			baseURL = cfg.APIKeys.OllamaURL
		}
	}
	models, err := ai.ListOllamaModels(r.Context(), baseURL)
	if err != nil || models == nil {
		models = []string{}
	}
	writeJSON(w, http.StatusOK, map[string]any{"models": models})
}
