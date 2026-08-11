// Package ai ports the legacy src/lib/ai TypeScript providers to Go.
// Providers are thin net/http clients for the Anthropic, Google Generative
// Language, and Ollama APIs — no vendor SDKs.
package ai

import (
	"context"
	"net/http"
	"time"
)

// Provider is the common surface every AI backend implements.
// Chat sends a prompt with optional leading context; Transcribe converts audio
// to text (only supported by Gemini); AnalyzeImage answers a prompt about an
// image (base64-inlined, jpeg assumed).
type Provider interface {
	Chat(ctx context.Context, prompt, context string) (string, error)
	Transcribe(ctx context.Context, audio []byte, mimeType string) (string, error)
	AnalyzeImage(ctx context.Context, image []byte, prompt string) (string, error)
}

// aiHTTPClient is shared by all providers. Transcription of long recordings can
// be slow, so the timeout is generous.
var aiHTTPClient = &http.Client{Timeout: 5 * time.Minute}

// aiMaxResponseBytes caps every provider response read. Ollama and Whisper
// base URLs are admin-configurable, so a misbehaving endpoint could otherwise
// stream indefinitely into worker memory for the life of the timeout.
const aiMaxResponseBytes = 10 << 20
