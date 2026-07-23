package ai

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Task identifies which per-task provider configuration to use.
type Task string

const (
	TaskTranscription   Task = "transcription"
	TaskRecommendations Task = "recommendations"
	TaskImageAnalysis   Task = "imageAnalysis"
	TaskImport          Task = "import"
)

// ValidProviders are the accepted provider names.
var ValidProviders = []string{"claude", "gemini", "ollama"}

// IsValidProvider reports whether name is a known provider.
func IsValidProvider(name string) bool {
	for _, p := range ValidProviders {
		if p == name {
			return true
		}
	}
	return false
}

// TaskConfig selects a provider (and optional model override) for one task.
type TaskConfig struct {
	Provider string `json:"provider"`
	Model    string `json:"model,omitempty"`
}

// APIKeys holds provider credentials (ollamaUrl is a base URL, not a secret).
type APIKeys struct {
	Anthropic string `json:"anthropic,omitempty"`
	Google    string `json:"google,omitempty"`
	OllamaURL string `json:"ollamaUrl,omitempty"`
}

// AIProviderConfig mirrors the user_settings.ai_provider_config jsonb shape:
// { transcription: {provider, model?}, recommendations: {...}, imageAnalysis:
// {...}, import: {...}, apiKeys: {anthropic?, google?, ollamaUrl?} }.
type AIProviderConfig struct {
	Transcription   TaskConfig `json:"transcription"`
	Recommendations TaskConfig `json:"recommendations"`
	ImageAnalysis   TaskConfig `json:"imageAnalysis"`
	Import          TaskConfig `json:"import"`
	APIKeys         APIKeys    `json:"apiKeys"`
}

// defaultProviders matches the legacy getDefaultConfig() task defaults.
func defaultProviders() AIProviderConfig {
	return AIProviderConfig{
		Transcription:   TaskConfig{Provider: "gemini"},
		Recommendations: TaskConfig{Provider: "claude"},
		ImageAnalysis:   TaskConfig{Provider: "claude"},
		Import:          TaskConfig{Provider: "claude"},
	}
}

// ParseConfig parses a stored jsonb blob, filling task defaults for missing or
// malformed sections. API keys are returned exactly as stored (no env
// fallback) so callers can persist merged configs without baking env values in.
func ParseConfig(raw []byte) *AIProviderConfig {
	cfg := defaultProviders()
	if len(raw) == 0 {
		return &cfg
	}
	var partial struct {
		Transcription   *TaskConfig `json:"transcription"`
		Recommendations *TaskConfig `json:"recommendations"`
		ImageAnalysis   *TaskConfig `json:"imageAnalysis"`
		Import          *TaskConfig `json:"import"`
		APIKeys         *APIKeys    `json:"apiKeys"`
	}
	if err := json.Unmarshal(raw, &partial); err != nil {
		return &cfg
	}
	if partial.Transcription != nil && partial.Transcription.Provider != "" {
		cfg.Transcription = *partial.Transcription
	}
	if partial.Recommendations != nil && partial.Recommendations.Provider != "" {
		cfg.Recommendations = *partial.Recommendations
	}
	if partial.ImageAnalysis != nil && partial.ImageAnalysis.Provider != "" {
		cfg.ImageAnalysis = *partial.ImageAnalysis
	}
	if partial.Import != nil && partial.Import.Provider != "" {
		cfg.Import = *partial.Import
	}
	if partial.APIKeys != nil {
		cfg.APIKeys = *partial.APIKeys
	}
	return &cfg
}

// LoadStoredConfig reads user_settings.ai_provider_config as stored (task
// defaults applied, no env fallback for keys). A missing row or null column
// yields the defaults.
func LoadStoredConfig(ctx context.Context, pool *pgxpool.Pool) (*AIProviderConfig, error) {
	var raw []byte
	err := pool.QueryRow(ctx,
		`SELECT ai_provider_config FROM user_settings LIMIT 1`).Scan(&raw)
	if errors.Is(err, pgx.ErrNoRows) {
		return ParseConfig(nil), nil
	}
	if err != nil {
		return nil, fmt.Errorf("load ai config: %w", err)
	}
	return ParseConfig(raw), nil
}

// LoadConfig reads the stored config and applies environment fallbacks for
// credentials (ANTHROPIC_API_KEY, GOOGLE_AI_API_KEY, OLLAMA_URL).
func LoadConfig(ctx context.Context, pool *pgxpool.Pool) (*AIProviderConfig, error) {
	cfg, err := LoadStoredConfig(ctx, pool)
	if err != nil {
		return nil, err
	}
	if cfg.APIKeys.Anthropic == "" {
		cfg.APIKeys.Anthropic = os.Getenv("ANTHROPIC_API_KEY")
	}
	if cfg.APIKeys.Google == "" {
		cfg.APIKeys.Google = os.Getenv("GOOGLE_AI_API_KEY")
	}
	if cfg.APIKeys.OllamaURL == "" {
		cfg.APIKeys.OllamaURL = os.Getenv("OLLAMA_URL")
	}
	return cfg, nil
}

// taskConfig returns the (possibly defaulted) TaskConfig for a task.
func (c *AIProviderConfig) taskConfig(task Task) (TaskConfig, error) {
	var tc TaskConfig
	switch task {
	case TaskTranscription:
		tc = c.Transcription
	case TaskRecommendations:
		tc = c.Recommendations
	case TaskImageAnalysis:
		tc = c.ImageAnalysis
	case TaskImport:
		tc = c.Import
	default:
		return TaskConfig{}, fmt.Errorf("no configuration found for task: %s", task)
	}
	if tc.Provider == "" {
		defaults := defaultProviders()
		dtc, _ := defaults.taskConfig(task)
		tc.Provider = dtc.Provider
	}
	return tc, nil
}

// NewProvider constructs a provider by name using the config's credentials
// (with env fallbacks, matching the legacy createProvider()).
func NewProvider(name string, cfg *AIProviderConfig, model string) (Provider, error) {
	switch name {
	case "claude":
		apiKey := cfg.APIKeys.Anthropic
		if apiKey == "" {
			apiKey = os.Getenv("ANTHROPIC_API_KEY")
		}
		if apiKey == "" {
			return nil, errors.New("Anthropic API key not configured. Set it in AI settings or ANTHROPIC_API_KEY environment variable.")
		}
		return NewClaude(apiKey, model), nil
	case "gemini":
		apiKey := cfg.APIKeys.Google
		if apiKey == "" {
			apiKey = os.Getenv("GOOGLE_AI_API_KEY")
		}
		if apiKey == "" {
			return nil, errors.New("Google AI API key not configured. Set it in AI settings or GOOGLE_AI_API_KEY environment variable.")
		}
		return NewGemini(apiKey, model), nil
	case "ollama":
		baseURL := cfg.APIKeys.OllamaURL
		if baseURL == "" {
			baseURL = os.Getenv("OLLAMA_URL")
		}
		if baseURL == "" {
			baseURL = DefaultOllamaURL
		}
		return NewOllama(baseURL, model), nil
	default:
		return nil, fmt.Errorf("unknown AI provider: %s", name)
	}
}

// ProviderForTask resolves the configured provider for a task, applying task
// defaults (transcription→gemini, recommendations/imageAnalysis/import→claude).
func ProviderForTask(cfg *AIProviderConfig, task Task) (Provider, error) {
	tc, err := cfg.taskConfig(task)
	if err != nil {
		return nil, err
	}
	return NewProvider(tc.Provider, cfg, tc.Model)
}
