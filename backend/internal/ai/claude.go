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
)

const (
	// DefaultClaudeModel matches the legacy provider default.
	DefaultClaudeModel = "claude-sonnet-4-20250514"

	anthropicMessagesURL = "https://api.anthropic.com/v1/messages"
	anthropicVersion     = "2023-06-01"
	claudeMaxTokens      = 4096
)

// Claude talks to the Anthropic Messages API over plain HTTP.
type Claude struct {
	apiKey string
	model  string
}

func NewClaude(apiKey, model string) *Claude {
	if model == "" {
		model = DefaultClaudeModel
	}
	return &Claude{apiKey: apiKey, model: model}
}

type claudeMessage struct {
	Role    string `json:"role"`
	Content any    `json:"content"`
}

func (c *Claude) send(ctx context.Context, messages []claudeMessage, maxTokens int) (string, error) {
	body, err := json.Marshal(map[string]any{
		"model":      c.model,
		"max_tokens": maxTokens,
		"messages":   messages,
	})
	if err != nil {
		return "", err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, anthropicMessagesURL, bytes.NewReader(body))
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("x-api-key", c.apiKey)
	req.Header.Set("anthropic-version", anthropicVersion)

	resp, err := aiHTTPClient.Do(req)
	if err != nil {
		return "", fmt.Errorf("claude request: %w", err)
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(io.LimitReader(resp.Body, aiMaxResponseBytes))
	if err != nil {
		return "", fmt.Errorf("claude response: %w", err)
	}

	var out struct {
		Content []struct {
			Type string `json:"type"`
			Text string `json:"text"`
		} `json:"content"`
		Error *struct {
			Message string `json:"message"`
		} `json:"error"`
	}
	if err := json.Unmarshal(data, &out); err != nil {
		if resp.StatusCode >= 300 {
			return "", fmt.Errorf("Claude API error: %s", resp.Status)
		}
		return "", fmt.Errorf("claude response parse: %w", err)
	}
	if resp.StatusCode >= 300 {
		if out.Error != nil && out.Error.Message != "" {
			return "", fmt.Errorf("Claude API error: %s", out.Error.Message)
		}
		return "", fmt.Errorf("Claude API error: %s", resp.Status)
	}
	for _, block := range out.Content {
		if block.Type == "text" {
			return block.Text, nil
		}
	}
	return "", errors.New("No text response from Claude")
}

// Chat mirrors the legacy behavior: optional context is fed as a leading user
// turn followed by an acknowledging assistant turn.
func (c *Claude) Chat(ctx context.Context, prompt, contextText string) (string, error) {
	var messages []claudeMessage
	if contextText != "" {
		messages = append(messages,
			claudeMessage{Role: "user", Content: contextText},
			claudeMessage{Role: "assistant", Content: "Understood. I have the context."},
		)
	}
	messages = append(messages, claudeMessage{Role: "user", Content: prompt})
	return c.send(ctx, messages, claudeMaxTokens)
}

// Transcribe is unsupported by Claude.
func (c *Claude) Transcribe(_ context.Context, _ []byte, _ string) (string, error) {
	return "", errors.New("Audio transcription is not supported by Claude. Use Gemini or a dedicated transcription service.")
}

// AnalyzeImage sends a base64 jpeg image block followed by the prompt.
func (c *Claude) AnalyzeImage(ctx context.Context, image []byte, prompt string) (string, error) {
	content := []map[string]any{
		{
			"type": "image",
			"source": map[string]any{
				"type":       "base64",
				"media_type": "image/jpeg",
				"data":       base64.StdEncoding.EncodeToString(image),
			},
		},
		{"type": "text", "text": prompt},
	}
	return c.send(ctx, []claudeMessage{{Role: "user", Content: content}}, claudeMaxTokens)
}
