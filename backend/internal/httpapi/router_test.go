package httpapi

import (
	"testing"

	"github.com/biker2000on/beez-trackz/backend/internal/config"
)

// TestRouterConstructs catches chi route registration panics — duplicate
// routes or conflicting URL param names (e.g. /hives/{id} vs /hives/{hiveId})
// registered by different domain files.
func TestRouterConstructs(t *testing.T) {
	cfg := &config.Config{SessionSecret: "test", AppURL: "http://localhost:3000"}
	defer func() {
		if r := recover(); r != nil {
			t.Fatalf("router construction panicked: %v", r)
		}
	}()
	if h := NewRouter(cfg, nil, nil, nil); h == nil {
		t.Fatal("nil handler")
	}
}
