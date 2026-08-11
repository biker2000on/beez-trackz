package ai

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
)

const (
	// DefaultOllamaURL and DefaultOllamaModel match the legacy provider defaults.
	DefaultOllamaURL   = "http://localhost:11434"
	DefaultOllamaModel = "llama3.2"
)

// Ollama talks to a local (or remote) Ollama server.
type Ollama struct {
	baseURL string
	model   string
}

func NewOllama(baseURL, model string) *Ollama {
	if baseURL == "" {
		baseURL = DefaultOllamaURL
	}
	if model == "" {
		model = DefaultOllamaModel
	}
	return &Ollama{baseURL: strings.TrimRight(baseURL, "/"), model: model}
}

type ollamaMessage struct {
	Role    string   `json:"role"`
	Content string   `json:"content"`
	Images  []string `json:"images,omitempty"`
}

func (o *Ollama) chat(ctx context.Context, messages []ollamaMessage) (string, error) {
	body, err := json.Marshal(map[string]any{
		"model":    o.model,
		"messages": messages,
		"stream":   false,
	})
	if err != nil {
		return "", err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, o.baseURL+"/api/chat", bytes.NewReader(body))
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", "application/json")

	resp, err := aiHTTPClient.Do(req)
	if err != nil {
		return "", fmt.Errorf("ollama request: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 300 {
		return "", fmt.Errorf("Ollama API error: %d %s", resp.StatusCode, resp.Status)
	}
	data, err := io.ReadAll(io.LimitReader(resp.Body, aiMaxResponseBytes))
	if err != nil {
		return "", fmt.Errorf("ollama response: %w", err)
	}
	var out struct {
		Message struct {
			Content string `json:"content"`
		} `json:"message"`
	}
	if err := json.Unmarshal(data, &out); err != nil {
		return "", errors.New("Failed to parse Ollama response as JSON")
	}
	if out.Message.Content == "" {
		return "", errors.New("No text response from Ollama")
	}
	return out.Message.Content, nil
}

// Chat sends optional context as a system message followed by the user prompt.
func (o *Ollama) Chat(ctx context.Context, prompt, contextText string) (string, error) {
	var messages []ollamaMessage
	if contextText != "" {
		messages = append(messages, ollamaMessage{Role: "system", Content: contextText})
	}
	messages = append(messages, ollamaMessage{Role: "user", Content: prompt})
	return o.chat(ctx, messages)
}

// Transcribe is unsupported by Ollama.
func (o *Ollama) Transcribe(_ context.Context, _ []byte, _ string) (string, error) {
	return "", errors.New("Audio transcription is not supported by Ollama. Use Gemini or a dedicated transcription service.")
}

// AnalyzeImage attaches the image via the images[] field.
func (o *Ollama) AnalyzeImage(ctx context.Context, image []byte, prompt string) (string, error) {
	return o.chat(ctx, []ollamaMessage{{
		Role:    "user",
		Content: prompt,
		Images:  []string{base64.StdEncoding.EncodeToString(image)},
	}})
}

// ListOllamaModels fetches installed model names from GET {baseUrl}/api/tags.
func ListOllamaModels(ctx context.Context, baseURL string) ([]string, error) {
	if baseURL == "" {
		baseURL = DefaultOllamaURL
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet,
		strings.TrimRight(baseURL, "/")+"/api/tags", nil)
	if err != nil {
		return nil, err
	}
	resp, err := aiHTTPClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 300 {
		return nil, fmt.Errorf("Ollama not reachable at %s", baseURL)
	}
	var out struct {
		Models []struct {
			Name string `json:"name"`
		} `json:"models"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return nil, err
	}
	names := make([]string, 0, len(out.Models))
	for _, m := range out.Models {
		names = append(names, m.Name)
	}
	return names, nil
}
