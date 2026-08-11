package httpapi

import (
	"testing"
	"time"
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
