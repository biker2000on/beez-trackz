package httpapi

import (
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/biker2000on/beez-trackz/backend/internal/config"
)

// ASI-3-001: unauthenticated /public/* POSTs are bounded per IP.
func TestIPThrottleEnforcesWindowLimit(t *testing.T) {
	t.Parallel()
	throttle := newIPThrottle(3, time.Minute)

	for i := 0; i < 3; i++ {
		if allowed, _ := throttle.take("10.0.0.1"); !allowed {
			t.Fatalf("attempt %d was throttled inside the limit", i+1)
		}
	}
	allowed, wait := throttle.take("10.0.0.1")
	if allowed {
		t.Error("fourth attempt inside the window was allowed")
	}
	if wait <= 0 || wait > time.Minute {
		t.Errorf("wait = %v, want within (0, 1m]", wait)
	}
	// A different client is unaffected.
	if allowed, _ := throttle.take("10.0.0.2"); !allowed {
		t.Error("an unrelated client was throttled")
	}
}

// ASI-3-003: five free attempts, then exponential delay.
func TestFailureThrottleBlocksAfterFreeAttempts(t *testing.T) {
	t.Parallel()
	throttle := newFailureThrottle()
	const ip = "203.0.113.9"

	for i := 0; i < failureFreeAttempts; i++ {
		if isBlocked, _ := throttle.blocked(ip); isBlocked {
			t.Fatalf("blocked after only %d failures", i)
		}
		throttle.fail(ip)
	}
	throttle.fail(ip)
	isBlocked, wait := throttle.blocked(ip)
	if !isBlocked {
		t.Fatal("not blocked after exceeding the free attempts")
	}
	if wait <= 0 || wait > failureMaxDelay {
		t.Errorf("wait = %v, want within (0, %v]", wait, failureMaxDelay)
	}

	// Success clears the record entirely.
	throttle.success(ip)
	if isBlocked, _ := throttle.blocked(ip); isBlocked {
		t.Error("still blocked after a successful login")
	}
}

func TestFailureThrottleDelayIsCapped(t *testing.T) {
	t.Parallel()
	throttle := newFailureThrottle()
	const ip = "203.0.113.10"
	// Enough failures to overflow a naive shift well past the cap.
	for i := 0; i < 80; i++ {
		throttle.fail(ip)
	}
	_, wait := throttle.blocked(ip)
	if wait > failureMaxDelay {
		t.Errorf("wait = %v, want capped at %v", wait, failureMaxDelay)
	}
}

func TestSetupThrottleEnforcesWindowLimit(t *testing.T) {
	t.Parallel()
	throttle := newIPThrottle(5, time.Minute)
	const ip = "198.51.100.80"
	for i := 0; i < 5; i++ {
		if allowed, _ := throttle.take(ip); !allowed {
			t.Fatalf("attempt %d was throttled inside the limit", i+1)
		}
	}
	if allowed, _ := throttle.take(ip); allowed {
		t.Error("sixth setup attempt inside the window was allowed")
	}
}

func TestResolveClientIPIgnoresForwardedHeadersFromUntrustedPeer(t *testing.T) {
	t.Parallel()
	trusted := mustParseNets(t, "10.0.0.0/8,172.16.0.0/12,192.168.0.0/16")
	got := resolveClientIP("203.0.113.9:443", "1.2.3.4", "5.6.7.8", trusted)
	if got != "203.0.113.9" {
		t.Fatalf("resolveClientIP = %q, want the connecting peer", got)
	}
}

func TestResolveClientIPWalksXFFFromTrustedPeer(t *testing.T) {
	t.Parallel()
	trusted := mustParseNets(t, "10.0.0.0/8,172.16.0.0/12,192.168.0.0/16")
	got := resolveClientIP("172.18.0.5:443", "198.51.100.10, 172.18.0.5", "", trusted)
	if got != "198.51.100.10" {
		t.Fatalf("resolveClientIP = %q, want the original client", got)
	}
}

func TestResolveClientIPFallsBackToXRealIP(t *testing.T) {
	t.Parallel()
	trusted := mustParseNets(t, "172.16.0.0/12")
	got := resolveClientIP("172.18.0.5:443", "", "203.0.113.20", trusted)
	if got != "203.0.113.20" {
		t.Fatalf("resolveClientIP = %q, want X-Real-IP", got)
	}
}

func TestTrustedRealIPRewritesRemoteAddrFromTrustedProxy(t *testing.T) {
	t.Parallel()
	server := &Server{cfg: &config.Config{TrustedProxies: mustParseNets(t, "172.16.0.0/12")}}
	var seen string
	handler := server.trustedRealIP(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seen = clientIP(r)
	}))
	request := httptest.NewRequest(http.MethodGet, "/", nil)
	request.RemoteAddr = "172.18.0.2:443"
	request.Header.Set("X-Forwarded-For", "203.0.113.9")
	handler.ServeHTTP(httptest.NewRecorder(), request)
	if seen != "203.0.113.9" {
		t.Fatalf("clientIP after trustedRealIP = %q, want forwarded client", seen)
	}
}

func TestTrustedRealIPIgnoresSpoofedHeaders(t *testing.T) {
	t.Parallel()
	server := &Server{cfg: &config.Config{TrustedProxies: mustParseNets(t, "172.16.0.0/12")}}
	var seen string
	handler := server.trustedRealIP(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seen = clientIP(r)
	}))
	request := httptest.NewRequest(http.MethodGet, "/", nil)
	request.RemoteAddr = "203.0.113.50:443"
	request.Header.Set("X-Forwarded-For", "1.2.3.4")
	request.Header.Set("X-Real-IP", "5.6.7.8")
	handler.ServeHTTP(httptest.NewRecorder(), request)
	if seen != "203.0.113.50" {
		t.Fatalf("clientIP after spoofed headers = %q, want connecting peer", seen)
	}
}

func mustParseNets(t *testing.T, cidrs string) []*net.IPNet {
	t.Helper()
	var nets []*net.IPNet
	for _, part := range strings.Split(cidrs, ",") {
		_, network, err := net.ParseCIDR(strings.TrimSpace(part))
		if err != nil {
			t.Fatalf("parse %q: %v", part, err)
		}
		nets = append(nets, network)
	}
	return nets
}
