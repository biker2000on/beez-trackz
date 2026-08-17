package httpapi

import (
	"net"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"
)

// In-memory per-IP throttles. Deliberately process-local: the deployment is a
// single API container behind traefik, and the goal is stopping online
// password guessing and bot floods on the public endpoints, not distributed
// rate limiting.

var (
	// loginThrottle guards the password login against online guessing
	// (ASI-3-003).
	loginThrottle = newFailureThrottle()
	// publicPostThrottle bounds unauthenticated /public/* writes per IP
	// (ASI-3-001).
	publicPostThrottle = newIPThrottle(5, time.Minute)
	// setupThrottle bounds unauthenticated /auth/setup per IP (API-003).
	setupThrottle = newIPThrottle(5, time.Minute)
)

func stripHostPort(remoteAddr string) string {
	host, _, err := net.SplitHostPort(remoteAddr)
	if err != nil {
		return remoteAddr
	}
	return host
}

func ipInNets(ip net.IP, nets []*net.IPNet) bool {
	if ip == nil {
		return false
	}
	for _, network := range nets {
		if network != nil && network.Contains(ip) {
			return true
		}
	}
	return false
}

// resolveClientIP returns the connecting peer unless that peer is in the
// trusted-proxy allowlist, in which case X-Forwarded-For is walked from the
// right (skipping trusted hops) and X-Real-IP is the fallback.
func resolveClientIP(remoteAddr, xff, xRealIP string, trusted []*net.IPNet) string {
	host := stripHostPort(remoteAddr)
	peer := net.ParseIP(host)
	if peer == nil || !ipInNets(peer, trusted) {
		return host
	}
	if xff != "" {
		parts := strings.Split(xff, ",")
		for i := len(parts) - 1; i >= 0; i-- {
			candidate := net.ParseIP(strings.TrimSpace(parts[i]))
			if candidate == nil {
				continue
			}
			if !ipInNets(candidate, trusted) || i == 0 {
				return candidate.String()
			}
		}
	}
	if realIP := net.ParseIP(strings.TrimSpace(xRealIP)); realIP != nil {
		return realIP.String()
	}
	return host
}

// trustedRealIP rewrites RemoteAddr from forwarding headers only when the
// connecting peer is a trusted proxy. Replaces chi middleware.RealIP, which
// honored X-Forwarded-For from any client (API-007).
func (s *Server) trustedRealIP(next http.Handler) http.Handler {
	var nets []*net.IPNet
	if s.cfg != nil {
		nets = s.cfg.TrustedProxies
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if ip := resolveClientIP(r.RemoteAddr, r.Header.Get("X-Forwarded-For"),
			r.Header.Get("X-Real-IP"), nets); ip != "" {
			r.RemoteAddr = ip
		}
		next.ServeHTTP(w, r)
	})
}

// clientIP returns the request's client address without the port. The router
// applies trustedRealIP first, so behind a trusted proxy this is the
// forwarded client address rather than the proxy's.
func clientIP(r *http.Request) string {
	return stripHostPort(r.RemoteAddr)
}

// ipThrottle allows limit requests per window per key (fixed window).
type ipThrottle struct {
	mu      sync.Mutex
	window  time.Duration
	limit   int
	buckets map[string]*throttleBucket
}

type throttleBucket struct {
	count       int
	windowStart time.Time
}

func newIPThrottle(limit int, window time.Duration) *ipThrottle {
	return &ipThrottle{
		limit:   limit,
		window:  window,
		buckets: make(map[string]*throttleBucket),
	}
}

// take records one attempt and reports whether it is allowed, plus how long
// to wait when it is not.
func (t *ipThrottle) take(key string) (bool, time.Duration) {
	now := time.Now()
	t.mu.Lock()
	defer t.mu.Unlock()
	// Opportunistic cleanup keeps the map from accumulating dead clients.
	if len(t.buckets) > 4096 {
		for k, bucket := range t.buckets {
			if now.Sub(bucket.windowStart) > t.window {
				delete(t.buckets, k)
			}
		}
	}
	bucket := t.buckets[key]
	if bucket == nil || now.Sub(bucket.windowStart) > t.window {
		t.buckets[key] = &throttleBucket{count: 1, windowStart: now}
		return true, 0
	}
	bucket.count++
	if bucket.count > t.limit {
		return false, t.window - now.Sub(bucket.windowStart)
	}
	return true, 0
}

// throttleMiddleware 429s requests beyond the per-IP budget.
func throttleMiddleware(t *ipThrottle) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			allowed, wait := t.take(clientIP(r))
			if !allowed {
				w.Header().Set("Retry-After",
					strconv.Itoa(int(wait.Seconds())+1))
				writeError(w, http.StatusTooManyRequests,
					"too many requests; try again later")
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}

// failureThrottle blocks a key with exponential delay after repeated
// failures. Used by password login: five free attempts, then 1s, 2s, 4s, …
// capped at 15 minutes. A success or 15 minutes of quiet resets the count.
type failureThrottle struct {
	mu       sync.Mutex
	failures map[string]*failureRecord
}

type failureRecord struct {
	count        int
	blockedUntil time.Time
	lastFailure  time.Time
}

const (
	failureFreeAttempts = 5
	failureResetAfter   = 15 * time.Minute
	failureMaxDelay     = 15 * time.Minute
)

func newFailureThrottle() *failureThrottle {
	return &failureThrottle{failures: make(map[string]*failureRecord)}
}

// blocked reports whether the key must wait before another attempt.
func (t *failureThrottle) blocked(key string) (bool, time.Duration) {
	now := time.Now()
	t.mu.Lock()
	defer t.mu.Unlock()
	record := t.failures[key]
	if record == nil {
		return false, 0
	}
	if now.Sub(record.lastFailure) > failureResetAfter {
		delete(t.failures, key)
		return false, 0
	}
	if now.Before(record.blockedUntil) {
		return true, time.Until(record.blockedUntil)
	}
	return false, 0
}

// fail records a failed attempt for the key.
func (t *failureThrottle) fail(key string) {
	now := time.Now()
	t.mu.Lock()
	defer t.mu.Unlock()
	if len(t.failures) > 4096 {
		for k, record := range t.failures {
			if now.Sub(record.lastFailure) > failureResetAfter {
				delete(t.failures, k)
			}
		}
	}
	record := t.failures[key]
	if record == nil || now.Sub(record.lastFailure) > failureResetAfter {
		record = &failureRecord{}
		t.failures[key] = record
	}
	record.count++
	record.lastFailure = now
	if record.count > failureFreeAttempts {
		delay := time.Second << (record.count - failureFreeAttempts - 1)
		if delay > failureMaxDelay || delay <= 0 {
			delay = failureMaxDelay
		}
		record.blockedUntil = now.Add(delay)
	}
}

// success clears the key's failure history.
func (t *failureThrottle) success(key string) {
	t.mu.Lock()
	defer t.mu.Unlock()
	delete(t.failures, key)
}
