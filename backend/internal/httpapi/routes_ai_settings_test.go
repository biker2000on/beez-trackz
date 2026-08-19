package httpapi

import "testing"

// ASI-3-007: admin-supplied Ollama/Whisper base URLs are fetched server-side,
// so anything that is not an absolute http/https URL is an SSRF-shaped input.
func TestAIValidBaseURL(t *testing.T) {
	valid := []string{
		"http://ollama:11434",
		"https://whisper.example.com",
		"http://192.168.1.10:8080/v1",
	}
	for _, raw := range valid {
		if !aiValidBaseURL(raw) {
			t.Errorf("aiValidBaseURL(%q) = false, want true", raw)
		}
	}
	invalid := []string{
		"",
		"ollama:11434",
		"/internal/path",
		"file:///etc/passwd",
		"gopher://169.254.169.254/",
		"http://",
	}
	for _, raw := range invalid {
		if aiValidBaseURL(raw) {
			t.Errorf("aiValidBaseURL(%q) = true, want false", raw)
		}
	}
}
