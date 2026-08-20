package jobs

import (
	"math"
	"testing"
	"time"

	"github.com/google/uuid"
)

func TestTimelineReviewDecisionSurfacesAmbiguity(t *testing.T) {
	lat, lon := 35.0, -82.0
	flora := immichTimelineAsset{Latitude: &lat, Longitude: &lon, Terms: map[string]struct{}{"flower": {}}}
	if reason, auto := timelineReviewDecision(flora, []uuid.UUID{uuid.New()}); auto || reason != "flora_or_bees_needs_review" {
		t.Fatalf("flora decision = %q auto=%v", reason, auto)
	}
	hive := immichTimelineAsset{Latitude: &lat, Longitude: &lon, Terms: map[string]struct{}{"beehive": {}}}
	if reason, auto := timelineReviewDecision(hive, []uuid.UUID{uuid.New()}); !auto || reason != "unique_location_hive_match" {
		t.Fatalf("hive decision = %q auto=%v", reason, auto)
	}
	if reason, auto := timelineReviewDecision(hive, []uuid.UUID{uuid.New(), uuid.New()}); auto || reason != "multiple_apiaries" {
		t.Fatalf("multi-yard decision = %q auto=%v", reason, auto)
	}
	missing := immichTimelineAsset{Terms: map[string]struct{}{"hive": {}}}
	if reason, auto := timelineReviewDecision(missing, nil); auto || reason != "missing_gps" {
		t.Fatalf("missing-GPS decision = %q auto=%v", reason, auto)
	}
}

func TestHaversineMeters(t *testing.T) {
	got := haversineMeters(35, -82, 35.01, -82)
	if math.Abs(got-1112) > 10 {
		t.Fatalf("distance = %.1fm, want about 1112m", got)
	}
}

func TestParseImmichTakenDatePrefersDateTimeOriginal(t *testing.T) {
	original := "2026-04-10T09:30:00-04:00"
	created := "2026-08-20T12:00:00Z"
	got := parseImmichTakenDate(&original, &created)
	if got == nil || !got.Equal(time.Date(2026, 4, 10, 13, 30, 0, 0, time.UTC)) {
		t.Fatalf("taken date = %v", got)
	}
	if fallback := parseImmichTakenDate(&created); fallback == nil {
		t.Fatal("RFC3339 DateTimeOriginal should parse")
	}
	if missing := parseImmichTakenDate(nil); missing != nil {
		t.Fatalf("missing DateTimeOriginal became %v", missing)
	}
}
