package ai

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestWhisperTranscribeSendsMultipartAndParsesText(t *testing.T) {
	var gotModel, gotPrompt, gotFilename string
	var gotBytes int
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/audio/transcriptions" {
			t.Errorf("path = %q", r.URL.Path)
		}
		if err := r.ParseMultipartForm(32 << 20); err != nil {
			t.Fatalf("parse multipart: %v", err)
		}
		gotModel = r.FormValue("model")
		gotPrompt = r.FormValue("prompt")
		file, header, err := r.FormFile("file")
		if err != nil {
			t.Fatalf("form file: %v", err)
		}
		defer file.Close()
		gotFilename = header.Filename
		buf := make([]byte, 16)
		n, _ := file.Read(buf)
		gotBytes = n
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"text": " Checked hive A3, six frames of bees. "}`))
	}))
	defer server.Close()

	provider := NewWhisper(server.URL, "")
	text, err := provider.Transcribe(context.Background(), []byte("fake-audio"), "audio/webm;codecs=opus")
	if err != nil {
		t.Fatalf("transcribe: %v", err)
	}
	if text != "Checked hive A3, six frames of bees." {
		t.Fatalf("text = %q", text)
	}
	if gotModel != DefaultWhisperModel {
		t.Fatalf("model = %q, want default", gotModel)
	}
	if !strings.Contains(gotPrompt, "Varroa") || !strings.Contains(gotPrompt, "A3") {
		t.Fatalf("vocab prompt missing beekeeping terms: %q", gotPrompt)
	}
	if gotFilename != "audio.webm" {
		t.Fatalf("filename = %q", gotFilename)
	}
	if gotBytes == 0 {
		t.Fatal("no audio bytes reached the server")
	}
}

func TestWhisperFilenameByMime(t *testing.T) {
	for mime, want := range map[string]string{
		"audio/wav":              "audio.wav",
		"audio/mpeg":             "audio.mp3",
		"audio/mp4":              "audio.m4a",
		"audio/ogg":              "audio.ogg",
		"audio/webm;codecs=opus": "audio.webm",
		"":                       "audio.webm",
	} {
		if got := whisperFilename(mime); got != want {
			t.Errorf("whisperFilename(%q) = %q, want %q", mime, got, want)
		}
	}
}

func TestWhisperTranscribeSurfacesServerErrors(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		http.Error(w, `{"detail":"model not found"}`, http.StatusNotFound)
	}))
	defer server.Close()

	_, err := NewWhisper(server.URL, "nope").Transcribe(context.Background(), []byte("x"), "audio/webm")
	if err == nil || !strings.Contains(err.Error(), "404") {
		t.Fatalf("want 404 error, got %v", err)
	}
}

func TestWhisperChatAndImageUnsupported(t *testing.T) {
	provider := NewWhisper("", "")
	if _, err := provider.Chat(context.Background(), "hi", ""); err == nil {
		t.Fatal("Chat should be unsupported")
	}
	if _, err := provider.AnalyzeImage(context.Background(), nil, "hi"); err == nil {
		t.Fatal("AnalyzeImage should be unsupported")
	}
}
