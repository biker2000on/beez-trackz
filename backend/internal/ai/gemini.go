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

// DefaultGeminiModel matches the legacy provider default.
const DefaultGeminiModel = "gemini-2.0-flash"

const geminiBaseURL = "https://generativelanguage.googleapis.com/v1beta/models"

// Gemini talks to the Google Generative Language REST API.
type Gemini struct {
	apiKey string
	model  string
}

func NewGemini(apiKey, model string) *Gemini {
	if model == "" {
		model = DefaultGeminiModel
	}
	return &Gemini{apiKey: apiKey, model: model}
}

type geminiPart struct {
	Text       string            `json:"text,omitempty"`
	InlineData *geminiInlineData `json:"inlineData,omitempty"`
}

type geminiInlineData struct {
	MimeType string `json:"mimeType"`
	Data     string `json:"data"`
}

func (g *Gemini) generate(ctx context.Context, parts []geminiPart) (string, error) {
	body, err := json.Marshal(map[string]any{
		"contents": []map[string]any{{"parts": parts}},
	})
	if err != nil {
		return "", err
	}
	url := fmt.Sprintf("%s/%s:generateContent", geminiBaseURL, g.model)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(body))
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("x-goog-api-key", g.apiKey)

	resp, err := aiHTTPClient.Do(req)
	if err != nil {
		return "", fmt.Errorf("gemini request: %w", err)
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(io.LimitReader(resp.Body, aiMaxResponseBytes))
	if err != nil {
		return "", fmt.Errorf("gemini response: %w", err)
	}

	var out struct {
		Candidates []struct {
			Content struct {
				Parts []struct {
					Text string `json:"text"`
				} `json:"parts"`
			} `json:"content"`
		} `json:"candidates"`
		Error *struct {
			Message string `json:"message"`
		} `json:"error"`
	}
	if err := json.Unmarshal(data, &out); err != nil {
		if resp.StatusCode >= 300 {
			return "", fmt.Errorf("Gemini API error: %s", resp.Status)
		}
		return "", fmt.Errorf("gemini response parse: %w", err)
	}
	if resp.StatusCode >= 300 {
		if out.Error != nil && out.Error.Message != "" {
			return "", fmt.Errorf("Gemini API error: %s", out.Error.Message)
		}
		return "", fmt.Errorf("Gemini API error: %s", resp.Status)
	}

	var sb strings.Builder
	for _, cand := range out.Candidates {
		for _, part := range cand.Content.Parts {
			sb.WriteString(part.Text)
		}
		break // first candidate only, matching the SDK's response.text()
	}
	return sb.String(), nil
}

// Chat prepends optional context ("Context:\n...") to the prompt, matching legacy.
func (g *Gemini) Chat(ctx context.Context, prompt, contextText string) (string, error) {
	fullPrompt := prompt
	if contextText != "" {
		fullPrompt = fmt.Sprintf("Context:\n%s\n\n%s", contextText, prompt)
	}
	text, err := g.generate(ctx, []geminiPart{{Text: fullPrompt}})
	if err != nil {
		return "", err
	}
	if text == "" {
		return "", errors.New("No text response from Gemini")
	}
	return text, nil
}

// Transcribe posts the audio inline as base64 with a transcription instruction.
func (g *Gemini) Transcribe(ctx context.Context, audio []byte, mimeType string) (string, error) {
	if mimeType == "" {
		mimeType = "audio/webm"
	}
	text, err := g.generate(ctx, []geminiPart{
		{Text: "Transcribe the following audio accurately. Return only the transcription text, no additional commentary."},
		{InlineData: &geminiInlineData{
			MimeType: mimeType,
			Data:     base64.StdEncoding.EncodeToString(audio),
		}},
	})
	if err != nil {
		return "", err
	}
	if text == "" {
		return "", errors.New("No transcription response from Gemini")
	}
	return text, nil
}

// AnalyzeImage sends the prompt plus an inline base64 jpeg.
func (g *Gemini) AnalyzeImage(ctx context.Context, image []byte, prompt string) (string, error) {
	text, err := g.generate(ctx, []geminiPart{
		{Text: prompt},
		{InlineData: &geminiInlineData{
			MimeType: "image/jpeg",
			Data:     base64.StdEncoding.EncodeToString(image),
		}},
	})
	if err != nil {
		return "", err
	}
	if text == "" {
		return "", errors.New("No text response from Gemini image analysis")
	}
	return text, nil
}
