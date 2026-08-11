package ai

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"strings"
	"sync"
	"time"
)

const (
	// DefaultWhisperURL matches the compose service; DefaultWhisperModel is the
	// CTranslate2 conversion of Whisper large-v3-turbo (near large-v3 accuracy,
	// CPU-friendly).
	DefaultWhisperURL   = "http://localhost:8000"
	DefaultWhisperModel = "deepdml/faster-whisper-large-v3-turbo-ct2"
)

// whisperVocabPrompt biases decoding toward apiary vocabulary. Whisper treats
// the prompt as preceding transcript context, so hive labels ("A3", "B2") and
// treatment names come out as written instead of near-homophones.
const whisperVocabPrompt = "Beekeeping inspection notes for hives A1, A2, A3, " +
	"A4, B1, B2, B3, B4, C1, C2, C3, C4, D1, D2, D3, D4. Varroa mites, " +
	"alcohol wash, sticky board, oxalic acid vaporization, Apivar strips, " +
	"formic acid, brood pattern, queenright, queenless, supersedure, swarm " +
	"cells, nuc, deadout, deep box, medium super, frames of bees, 1:1 sugar " +
	"syrup, 2:1 syrup, pollen patty, fondant, entrance feeder, top feeder, " +
	"honey flow, nectar dearth."

// Whisper talks to a local OpenAI-compatible speech-to-text server
// (speaches / faster-whisper-server). Transcription only.
type Whisper struct {
	baseURL string
	model   string
}

func NewWhisper(baseURL, model string) *Whisper {
	if baseURL == "" {
		baseURL = DefaultWhisperURL
	}
	if model == "" {
		model = DefaultWhisperModel
	}
	return &Whisper{baseURL: strings.TrimRight(baseURL, "/"), model: model}
}

// Chat is unsupported by Whisper.
func (w *Whisper) Chat(_ context.Context, _, _ string) (string, error) {
	return "", errors.New("Whisper is a transcription-only provider. Use Claude, Gemini, or Ollama for text tasks.")
}

// AnalyzeImage is unsupported by Whisper.
func (w *Whisper) AnalyzeImage(_ context.Context, _ []byte, _ string) (string, error) {
	return "", errors.New("Whisper is a transcription-only provider. Use Claude, Gemini, or Ollama for image analysis.")
}

// whisperFilename gives the upload a filename whose extension matches the
// recording's mime type — the server sniffs the container format from it.
func whisperFilename(mimeType string) string {
	base := mimeType
	if i := strings.Index(base, ";"); i >= 0 {
		base = base[:i]
	}
	switch strings.TrimSpace(base) {
	case "audio/wav", "audio/x-wav", "audio/wave":
		return "audio.wav"
	case "audio/mpeg", "audio/mp3":
		return "audio.mp3"
	case "audio/mp4", "audio/x-m4a", "audio/m4a":
		return "audio.m4a"
	case "audio/ogg", "application/ogg":
		return "audio.ogg"
	case "audio/flac", "audio/x-flac":
		return "audio.flac"
	default:
		// The recorder produces webm/opus; also the safe fallback.
		return "audio.webm"
	}
}

// whisperInstallClient gives model installs their own generous timeout: the
// download is ~1.6 GB from HuggingFace, and cutting it off at the shared
// client's 5 minutes made every transcription attempt re-trigger a partial
// download through asynq's retries on a slow link.
var whisperInstallClient = &http.Client{Timeout: 30 * time.Minute}

// whisperInstallMu serializes installs across worker goroutines so concurrent
// transcriptions trigger one download, not one per worker slot.
var whisperInstallMu sync.Mutex

// installModel asks the server to download the model (speaches requires an
// explicit POST /v1/models/{id} before a model can serve). Blocks until the
// download finishes; the model cache volume makes this a once-per-install cost.
func (w *Whisper) installModel(ctx context.Context) error {
	whisperInstallMu.Lock()
	defer whisperInstallMu.Unlock()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost,
		w.baseURL+"/v1/models/"+w.model, nil)
	if err != nil {
		return err
	}
	resp, err := whisperInstallClient.Do(req)
	if err != nil {
		return fmt.Errorf("whisper model install: %w", err)
	}
	defer resp.Body.Close()
	// 2xx = installed now; 409 = already installed. Anything else — a 404
	// from a typo'd model name especially — is a real failure. Treating it
	// as success produced a confusing retry loop instead of an error.
	if resp.StatusCode >= 400 && resp.StatusCode != http.StatusConflict {
		detail, _ := io.ReadAll(io.LimitReader(resp.Body, 300))
		return fmt.Errorf("whisper model install failed: %d %s",
			resp.StatusCode, strings.TrimSpace(string(detail)))
	}
	return nil
}

// Transcribe posts the audio to POST {baseURL}/v1/audio/transcriptions
// (multipart: file, model, prompt, response_format=json). A "model not
// installed" response triggers one install-and-retry so a fresh model cache
// heals itself.
func (w *Whisper) Transcribe(ctx context.Context, audio []byte, mimeType string) (string, error) {
	text, err := w.transcribeOnce(ctx, audio, mimeType)
	if err != nil && strings.Contains(err.Error(), "not installed") {
		if installErr := w.installModel(ctx); installErr != nil {
			return "", installErr
		}
		return w.transcribeOnce(ctx, audio, mimeType)
	}
	return text, err
}

func (w *Whisper) transcribeOnce(ctx context.Context, audio []byte, mimeType string) (string, error) {
	var body bytes.Buffer
	form := multipart.NewWriter(&body)
	part, err := form.CreateFormFile("file", whisperFilename(mimeType))
	if err != nil {
		return "", err
	}
	if _, err := part.Write(audio); err != nil {
		return "", err
	}
	for field, value := range map[string]string{
		"model":           w.model,
		"prompt":          whisperVocabPrompt,
		"response_format": "json",
	} {
		if err := form.WriteField(field, value); err != nil {
			return "", err
		}
	}
	if err := form.Close(); err != nil {
		return "", err
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost,
		w.baseURL+"/v1/audio/transcriptions", &body)
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", form.FormDataContentType())

	resp, err := aiHTTPClient.Do(req)
	if err != nil {
		return "", fmt.Errorf("whisper request: %w", err)
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(io.LimitReader(resp.Body, aiMaxResponseBytes))
	if err != nil {
		return "", fmt.Errorf("whisper response: %w", err)
	}
	if resp.StatusCode >= 300 {
		detail := strings.TrimSpace(string(data))
		if len(detail) > 300 {
			detail = detail[:300]
		}
		return "", fmt.Errorf("Whisper API error: %d %s", resp.StatusCode, detail)
	}
	var out struct {
		Text string `json:"text"`
	}
	if err := json.Unmarshal(data, &out); err != nil {
		return "", errors.New("Failed to parse Whisper response as JSON")
	}
	return strings.TrimSpace(out.Text), nil
}

// WhisperHealthy checks GET {baseURL}/v1/models, the cheapest call the
// OpenAI-compatible surface exposes.
func WhisperHealthy(ctx context.Context, baseURL string) error {
	if baseURL == "" {
		baseURL = DefaultWhisperURL
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet,
		strings.TrimRight(baseURL, "/")+"/v1/models", nil)
	if err != nil {
		return err
	}
	resp, err := aiHTTPClient.Do(req)
	if err != nil {
		return fmt.Errorf("whisper not reachable: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 300 {
		return fmt.Errorf("whisper server returned %d", resp.StatusCode)
	}
	return nil
}
