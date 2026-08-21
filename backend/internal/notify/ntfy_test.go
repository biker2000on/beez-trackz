package notify

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestValidKind(t *testing.T) {
	t.Parallel()
	for _, kind := range KnownKinds {
		if !ValidKind(kind) {
			t.Errorf("ValidKind(%q) = false, want true", kind)
		}
	}
	if ValidKind("email") || ValidKind("") || ValidKind("MITE_CHECK_DUE") {
		t.Fatal("ValidKind accepted an unknown kind")
	}
}

func TestNormalizeKinds(t *testing.T) {
	t.Parallel()
	got, err := NormalizeKinds([]string{
		" mite_check_due ", "feeder_empty", "mite_check_due", "",
	})
	if err != nil {
		t.Fatalf("NormalizeKinds: %v", err)
	}
	if len(got) != 2 || got[0] != KindMiteCheckDue || got[1] != KindFeederEmpty {
		t.Fatalf("NormalizeKinds = %#v", got)
	}
	if _, err := NormalizeKinds([]string{"mite_check_due", "sms"}); err == nil {
		t.Fatal("NormalizeKinds accepted unknown kind")
	}
	empty, err := NormalizeKinds(nil)
	if err != nil || len(empty) != 0 {
		t.Fatalf("empty kinds: %#v %v", empty, err)
	}
}

func TestValidServerURL(t *testing.T) {
	t.Parallel()
	valid := []string{
		"https://ntfy.sh",
		"http://ntfy.home.arpa:8080",
		"https://push.example.com/ntfy",
	}
	for _, raw := range valid {
		if !ValidServerURL(raw) {
			t.Errorf("ValidServerURL(%q) = false, want true", raw)
		}
	}
	invalid := []string{
		"",
		"ntfy.sh",
		"/topic",
		"file:///etc/passwd",
		"gopher://169.254.169.254/",
		"https://",
	}
	for _, raw := range invalid {
		if ValidServerURL(raw) {
			t.Errorf("ValidServerURL(%q) = true, want false", raw)
		}
	}
}

func TestValidTopic(t *testing.T) {
	t.Parallel()
	if !ValidTopic("beez-yard") || !ValidTopic("Yard_1") {
		t.Fatal("expected valid topics")
	}
	for _, topic := range []string{"", "has space", "a/b", "x y", string(make([]byte, 65))} {
		if ValidTopic(topic) {
			t.Errorf("ValidTopic(%q) = true, want false", topic)
		}
	}
}

func TestPublishUnconfiguredIsNoop(t *testing.T) {
	t.Parallel()
	client := New(nil)
	if err := client.Publish(context.Background(), Config{}, Message{Title: "x"}); err != nil {
		t.Fatalf("unconfigured: %v", err)
	}
	if err := (*Client)(nil).Publish(context.Background(), Config{
		ServerURL: "https://ntfy.sh", Topic: "yard",
	}, Message{Title: "x"}); err != nil {
		t.Fatalf("nil client: %v", err)
	}
}

func TestPublishPostsToTopic(t *testing.T) {
	t.Parallel()
	var (
		gotPath     string
		gotTitle    string
		gotPriority string
		gotTags     string
		gotBody     string
		gotAuth     string
	)
	// TLS: a token over plain HTTP is refused outright.
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		gotTitle = r.Header.Get("Title")
		gotPriority = r.Header.Get("Priority")
		gotTags = r.Header.Get("Tags")
		gotAuth = r.Header.Get("Authorization")
		body, _ := io.ReadAll(r.Body)
		gotBody = string(body)
		w.WriteHeader(http.StatusOK)
	}))
	defer server.Close()

	client := New(server.Client())
	err := client.Publish(context.Background(), Config{
		ServerURL: server.URL, Topic: "beez-yard", AccessToken: "secret-token",
	}, Message{
		Title:    "Sample for mites",
		Body:     "Hive A1 is due",
		Priority: 4,
		Tags:     "bee,warning",
		Kind:     KindMiteCheckDue,
	})
	if err != nil {
		t.Fatalf("Publish: %v", err)
	}
	if gotPath != "/beez-yard" {
		t.Errorf("path = %q, want /beez-yard", gotPath)
	}
	if gotTitle != "Sample for mites" || gotBody != "Hive A1 is due" {
		t.Errorf("title/body = %q %q", gotTitle, gotBody)
	}
	if gotPriority != "4" || gotTags != "bee,warning" {
		t.Errorf("priority/tags = %q %q", gotPriority, gotTags)
	}
	if gotAuth != "Bearer secret-token" {
		t.Errorf("authorization = %q, want bearer token", gotAuth)
	}
}

func TestPublishRefusesTokenOverPlainHTTP(t *testing.T) {
	t.Parallel()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Error("request must not be sent")
	}))
	defer server.Close()
	err := New(server.Client()).Publish(context.Background(), Config{
		ServerURL: server.URL, Topic: "yard", AccessToken: "secret",
	}, Message{Body: "hello"})
	if err == nil || !strings.Contains(err.Error(), "plain HTTP") {
		t.Fatalf("err = %v, want plain-HTTP refusal", err)
	}
}

func TestPublishOmitsAuthorizationWithoutToken(t *testing.T) {
	t.Parallel()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if got := r.Header.Get("Authorization"); got != "" {
			t.Errorf("authorization = %q, want empty", got)
		}
		w.WriteHeader(http.StatusOK)
	}))
	defer server.Close()

	err := New(server.Client()).Publish(context.Background(), Config{
		ServerURL: server.URL, Topic: "yard",
	}, Message{Body: "hello"})
	if err != nil {
		t.Fatalf("Publish: %v", err)
	}
}

func TestPublishHTTPError(t *testing.T) {
	t.Parallel()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusBadGateway)
	}))
	defer server.Close()
	client := New(server.Client())
	err := client.Publish(context.Background(), Config{
		ServerURL: server.URL, Topic: "yard",
	}, Message{Title: "x", Body: "y"})
	if err == nil {
		t.Fatal("expected HTTP error")
	}
}

func TestConfigConfigured(t *testing.T) {
	t.Parallel()
	if (Config{}).Configured() {
		t.Fatal("empty config should not be configured")
	}
	if !(Config{ServerURL: "https://ntfy.sh", Topic: "yard"}).Configured() {
		t.Fatal("full config should be configured")
	}
}
