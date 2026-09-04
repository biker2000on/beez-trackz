package httpapi

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/biker2000on/beez-trackz/backend/internal/config"
	"github.com/biker2000on/beez-trackz/backend/internal/notify"
)

func TestLaborElapsedMinutes(t *testing.T) {
	t.Parallel()
	start := time.Date(2026, 8, 20, 8, 0, 0, 0, time.UTC)
	now := start.Add(47 * time.Minute)
	if got := laborElapsedMinutes(start, nil, now); got != 47 {
		t.Errorf("open session = %d, want 47", got)
	}
	stopped := start.Add(90*time.Second + 20*time.Second)
	if got := laborElapsedMinutes(start, &stopped, now); got != 2 {
		t.Errorf("110s rounds to %d, want 2", got)
	}
	before := start.Add(-time.Minute)
	if got := laborElapsedMinutes(start, &before, now); got != 0 {
		t.Errorf("negative duration = %d, want 0", got)
	}
}

func TestNormalizeUnits(t *testing.T) {
	t.Parallel()
	metric := "Metric"
	got, msg := normalizeUnits(&metric)
	if msg != "" || got == nil || *got != "metric" {
		t.Fatalf("metric: %v %q", got, msg)
	}
	us := "us"
	got, msg = normalizeUnits(&us)
	if msg != "" || got == nil || *got != "us" {
		t.Fatalf("us: %v %q", got, msg)
	}
	bad := "imperial"
	if _, msg := normalizeUnits(&bad); msg == "" {
		t.Fatal("expected error for imperial")
	}
	empty := "  "
	got, msg = normalizeUnits(&empty)
	if msg != "" || got != nil {
		t.Fatalf("empty should clear: %v %q", got, msg)
	}
	got, msg = normalizeUnits(nil)
	if msg != "" || got != nil {
		t.Fatalf("nil keeps unset: %v %q", got, msg)
	}
}

func TestNormalizeTemperatureUnit(t *testing.T) {
	t.Parallel()
	c := "C"
	got, msg := normalizeTemperatureUnit(&c)
	if msg != "" || got == nil || *got != "c" {
		t.Fatalf("c: %v %q", got, msg)
	}
	empty := ""
	got, msg = normalizeTemperatureUnit(&empty)
	if msg != "" || got != nil {
		t.Fatalf("empty clears override: %v %q", got, msg)
	}
	bad := "k"
	if _, msg := normalizeTemperatureUnit(&bad); msg == "" {
		t.Fatal("expected error for kelvin")
	}
}

func TestNormalizeNtfyPrefs(t *testing.T) {
	t.Parallel()
	server := "https://ntfy.sh/"
	topic := "beez-yard"
	enabled := true
	got, msg := normalizeNtfyPrefs(&server, &topic, &enabled, []string{
		notify.KindMiteCheckDue, notify.KindFlowStarted,
	})
	if msg != "" {
		t.Fatalf("valid: %s", msg)
	}
	if got.ServerURL != "https://ntfy.sh" || got.Topic != "beez-yard" || !got.Enabled {
		t.Fatalf("normalized = %#v", got)
	}
	if len(got.EventKinds) != 2 {
		t.Fatalf("kinds = %#v", got.EventKinds)
	}
	badURL := "file:///tmp"
	if _, msg := normalizeNtfyPrefs(&badURL, &topic, &enabled, nil); msg == "" {
		t.Fatal("expected invalid URL")
	}
	badTopic := "has space"
	if _, msg := normalizeNtfyPrefs(&server, &badTopic, &enabled, nil); msg == "" {
		t.Fatal("expected invalid topic")
	}
}

func TestNtfyPriority(t *testing.T) {
	t.Parallel()
	if ntfyPriority("urgent") != 5 || ntfyPriority("high") != 4 || ntfyPriority("normal") != 3 {
		t.Fatal("priority mapping")
	}
}

func TestOpsRoutesRequireAuthentication(t *testing.T) {
	cfg := &config.Config{SessionSecret: "test", AppURL: "http://localhost:3000"}
	handler := NewRouter(cfg, nil, nil, nil)
	paths := []struct {
		method, path string
	}{
		{http.MethodGet, "/api/v1/ops/units"},
		{http.MethodGet, "/api/v1/ops/labor/current"},
		{http.MethodGet, "/api/v1/ops/labor"},
		{http.MethodPost, "/api/v1/ops/labor/start"},
		{http.MethodPost, "/api/v1/ops/labor/stop"},
		{http.MethodGet, "/api/v1/ops/compliance-packet"},
		{http.MethodGet, "/api/v1/ops/compliance-packet/print"},
		{http.MethodPost, "/api/v1/ops/ntfy/dispatch"},
		{http.MethodPost, "/api/v1/ops/ntfy/test"},
		{http.MethodPut, "/api/v1/settings/ntfy"},
	}
	for _, path := range paths {
		request := httptest.NewRequest(path.method, path.path, nil)
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, request)
		if response.Code != http.StatusUnauthorized {
			t.Errorf("%s %s status = %d, want 401", path.method, path.path, response.Code)
		}
	}
}

func TestCompliancePrintTemplateRenders(t *testing.T) {
	t.Parallel()
	var out strings.Builder
	packet := compliancePacket{
		Title:      "GentleBee Atlas compliance packet",
		ExportedAt: time.Date(2026, 8, 21, 0, 0, 0, 0, time.UTC),
	}
	if err := compliancePrintTemplate.Execute(&out, packet); err != nil {
		t.Fatalf("render empty packet: %v", err)
	}
	html := out.String()
	if !strings.Contains(html, "<title>GentleBee Atlas compliance packet</title>") {
		t.Fatal("print view missing title")
	}
}

func TestOpsNotificationAndComplianceNamesUseBrand(t *testing.T) {
	t.Parallel()
	message := ntfyTestMessage("Orchard Ledger")
	if message.Title != "Orchard Ledger" || message.Body != "Test notification from Orchard Ledger." {
		t.Fatalf("test notification = %#v", message)
	}
	if got := brandFilenameStem("GentleBee Atlas"); got != "gentlebee-atlas" {
		t.Fatalf("filename stem = %q", got)
	}
}

func TestCompliancePacketIsNotPublic(t *testing.T) {
	cfg := &config.Config{SessionSecret: "test", AppURL: "http://localhost:3000"}
	handler := NewRouter(cfg, nil, nil, nil)
	request := httptest.NewRequest(http.MethodGet, "/api/v1/public/ops/compliance-packet", nil)
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code == http.StatusOK {
		t.Fatal("compliance packet must not be a public route")
	}
}
