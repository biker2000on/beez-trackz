package recs

import (
	"testing"
	"time"
)

func TestSeasonalWashThreshold(t *testing.T) {
	tests := []struct {
		month time.Month
		want  float64
	}{
		{time.April, 2.0},
		{time.July, 3.0},
		{time.September, 2.0},
		{time.January, 3.0},
	}
	for _, tt := range tests {
		got := SeasonalWashThreshold(time.Date(2026, tt.month, 15, 0, 0, 0, 0, time.UTC))
		if got != tt.want {
			t.Errorf("month %s = %.1f, want %.1f", tt.month, got, tt.want)
		}
	}
}

func TestOverThreshold(t *testing.T) {
	settings := VarroaSettings{ThresholdPer100: 2.0, ThresholdPerDay: 9.0}
	per100 := 2.0
	below := 1.9
	perDay := 9.0
	if !OverThreshold("alcohol_wash", &per100, nil, settings) {
		t.Fatal("wash at threshold should treat")
	}
	if OverThreshold("alcohol_wash", &below, nil, settings) {
		t.Fatal("wash below threshold should not treat")
	}
	if !OverThreshold("sticky_board", nil, &perDay, settings) {
		t.Fatal("board at threshold should treat")
	}
	if OverThreshold("sticky_board", nil, nil, settings) {
		t.Fatal("board without days-on-board cannot treat")
	}
	if OverThreshold("visual", &per100, nil, settings) {
		t.Fatal("visual must use mites-per-day, not per-100")
	}
}

func TestComparableRate(t *testing.T) {
	per100 := 3.5
	perDay := 12.0
	rate, kind, ok := ComparableRate("sugar_roll", &per100, nil)
	if !ok || kind != "per_100" || rate != 3.5 {
		t.Fatalf("wash rate = %v %s ok=%v", rate, kind, ok)
	}
	rate, kind, ok = ComparableRate("sticky_board", nil, &perDay)
	if !ok || kind != "per_day" || rate != 12.0 {
		t.Fatalf("board rate = %v %s ok=%v", rate, kind, ok)
	}
	if _, _, ok := ComparableRate("sticky_board", nil, nil); ok {
		t.Fatal("board without per-day should not be comparable")
	}
}
