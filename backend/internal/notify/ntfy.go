// Package notify is the optional ntfy publisher for yard-queue events.
// Unconfigured (empty server or topic) is a no-op, not an error.
package notify

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
	"unicode"
)

// Event kinds match the Saturday yard queue / operations list.
const (
	KindMiteCheckDue     = "mite_check_due"
	KindFeederEmpty      = "feeder_empty"
	KindTreatmentOffDate = "treatment_off_date"
	KindFlowStarted      = "flow_started"
)

// KnownKinds is the closed set stored on user_settings.ntfy_event_kinds.
var KnownKinds = []string{
	KindMiteCheckDue,
	KindTreatmentOffDate,
	KindFeederEmpty,
	KindFlowStarted,
}

const maxResponseBytes = 1 << 20

// Message is one ntfy publish.
type Message struct {
	Title    string
	Body     string
	Priority int    // 1–5; 0 means ntfy default (3)
	Tags     string // comma-separated ntfy tags
	Kind     string
}

// Config is the operator-supplied webhook. Empty ServerURL or Topic means
// the publisher is unconfigured and Publish returns nil without I/O.
type Config struct {
	ServerURL string
	Topic     string
	// AccessToken authenticates reserved/protected topics. It is never logged.
	AccessToken string
}

// Client posts to an ntfy server. httpClient may be nil (a default is used).
type Client struct {
	httpClient *http.Client
}

// New constructs a client. It does not contact the server.
func New(httpClient *http.Client) *Client {
	if httpClient == nil {
		httpClient = &http.Client{Timeout: 8 * time.Second}
	}
	return &Client{httpClient: httpClient}
}

// ValidKind reports whether kind is one of the yard-queue ntfy events.
func ValidKind(kind string) bool {
	switch kind {
	case KindMiteCheckDue, KindFeederEmpty, KindTreatmentOffDate, KindFlowStarted:
		return true
	}
	return false
}

// NormalizeKinds deduplicates and validates event kinds. Empty input is valid
// (means "none enabled"). Unknown values are an error.
func NormalizeKinds(kinds []string) ([]string, error) {
	if len(kinds) == 0 {
		return []string{}, nil
	}
	seen := map[string]bool{}
	out := make([]string, 0, len(kinds))
	for _, raw := range kinds {
		kind := strings.TrimSpace(raw)
		if kind == "" {
			continue
		}
		if !ValidKind(kind) {
			return nil, fmt.Errorf("unknown ntfy event kind %q", kind)
		}
		if seen[kind] {
			continue
		}
		seen[kind] = true
		out = append(out, kind)
	}
	return out, nil
}

// ValidServerURL accepts only absolute http/https URLs with a host. The
// topic is a separate field; a path on the server URL is allowed (ntfy
// subfolder installs) but the topic is never taken from the URL.
func ValidServerURL(raw string) bool {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return false
	}
	parsed, err := url.Parse(raw)
	return err == nil && (parsed.Scheme == "http" || parsed.Scheme == "https") &&
		parsed.Host != ""
}

// ValidTopic is a conservative ntfy topic: 1–64 chars, letters, digits,
// underscore, hyphen. ntfy itself is looser; we refuse spaces and slashes so
// a topic cannot smuggle a second path segment.
func ValidTopic(topic string) bool {
	topic = strings.TrimSpace(topic)
	if topic == "" || len(topic) > 64 {
		return false
	}
	for _, r := range topic {
		if unicode.IsLetter(r) || unicode.IsDigit(r) || r == '_' || r == '-' {
			continue
		}
		return false
	}
	return true
}

// Configured reports whether a publish would attempt I/O.
func (c Config) Configured() bool {
	return strings.TrimSpace(c.ServerURL) != "" && strings.TrimSpace(c.Topic) != ""
}

// Publish posts msg to ntfy. Unconfigured config is a silent success.
// Callers should treat a returned error as fail-soft (log, keep going).
func (c *Client) Publish(ctx context.Context, cfg Config, msg Message) error {
	if c == nil {
		return nil
	}
	server := strings.TrimRight(strings.TrimSpace(cfg.ServerURL), "/")
	topic := strings.TrimSpace(cfg.Topic)
	if server == "" || topic == "" {
		return nil
	}
	if !ValidServerURL(server) {
		return fmt.Errorf("invalid ntfy server URL")
	}
	if !ValidTopic(topic) {
		return fmt.Errorf("invalid ntfy topic")
	}

	endpoint := server + "/" + url.PathEscape(topic)
	body := strings.TrimSpace(msg.Body)
	if body == "" {
		body = strings.TrimSpace(msg.Title)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, strings.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "text/plain; charset=utf-8")
	if token := strings.TrimSpace(cfg.AccessToken); token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	if title := strings.TrimSpace(msg.Title); title != "" {
		req.Header.Set("Title", title)
	}
	if msg.Priority >= 1 && msg.Priority <= 5 {
		req.Header.Set("Priority", fmt.Sprintf("%d", msg.Priority))
	}
	if tags := strings.TrimSpace(msg.Tags); tags != "" {
		req.Header.Set("Tags", tags)
	}

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, maxResponseBytes))
	if resp.StatusCode >= 300 {
		return fmt.Errorf("ntfy: HTTP %d", resp.StatusCode)
	}
	return nil
}
