package sales

import (
	"testing"
	"time"

	"github.com/biker2000on/beez-trackz/backend/internal/app"
)

func colonyDay(value string) time.Time {
	parsed, err := time.Parse(time.DateOnly, value)
	if err != nil {
		panic(err)
	}
	return parsed
}

func colonyDayPtr(value string) *time.Time {
	parsed := colonyDay(value)
	return &parsed
}

// TestColonySaleDateRefusesASuccessorColony replays the A1/C2 case: the
// colonies sold to Craig on 2026-04-25 were followed at the same labels by a
// swarm (2026-04-27) and a split (2026-05-18). A sale dated 2026-04-25 must
// not be able to mark either successor sold.
func TestColonySaleDateRefusesASuccessorColony(t *testing.T) {
	cases := []struct {
		name      string
		label     string
		installed *time.Time
		saleDate  time.Time
		want      string
	}{
		{
			name: "A1 swarm caught after the sale", label: "A1",
			installed: colonyDayPtr("2026-04-27"), saleDate: colonyDay("2026-04-25"),
			want: "A1 was installed 2026-04-27, after the 2026-04-25 sale date; pick the colony that was in A1 on that date.",
		},
		{
			name: "C2 split made after the sale", label: "C2",
			installed: colonyDayPtr("2026-05-18"), saleDate: colonyDay("2026-04-25"),
			want: "C2 was installed 2026-05-18, after the 2026-04-25 sale date; pick the colony that was in C2 on that date.",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			err := colonySaleDateRefusal(tc.label, tc.installed, tc.saleDate)
			if !app.IsKind(err, app.KindInvalid) {
				t.Fatalf("kind = %q, want %q: %v", app.KindOf(err), app.KindInvalid, err)
			}
			typed, ok := err.(*app.Error)
			if !ok {
				t.Fatalf("error %T is not *app.Error", err)
			}
			if typed.Message != tc.want {
				t.Errorf("message = %q\nwant      %q", typed.Message, tc.want)
			}
		})
	}
}

func TestColonySaleDateAllowsTheColonyThatWasThere(t *testing.T) {
	cases := []struct {
		name      string
		installed *time.Time
		saleDate  time.Time
	}{
		// The old A1: top half of the 2026-03-22 A4 split, sold 2026-04-25.
		{"installed before the sale", colonyDayPtr("2026-03-22"), colonyDay("2026-04-25")},
		{"installed on the sale date", colonyDayPtr("2026-04-25"), colonyDay("2026-04-25")},
		{"no installed date recorded", nil, colonyDay("2026-04-25")},
		{"zero installed date", &time.Time{}, colonyDay("2026-04-25")},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if err := colonySaleDateRefusal("A1", tc.installed, tc.saleDate); err != nil {
				t.Fatalf("refused: %v", err)
			}
		})
	}
}

// TestColonySaleDateComparesCalendarDays: date-only fields are stored at
// midnight UTC, but a sale stamped later in the day, or read back in another
// zone, is still the same day and must not flip the answer.
func TestColonySaleDateComparesCalendarDays(t *testing.T) {
	eastern := time.FixedZone("EDT", -4*60*60)
	installed := time.Date(2026, 4, 25, 0, 0, 0, 0, time.UTC)
	// 2026-04-25 21:00 EDT is 2026-04-26 01:00 UTC: a later day, so allowed.
	if err := colonySaleDateRefusal("A1", &installed, time.Date(2026, 4, 25, 21, 0, 0, 0, eastern)); err != nil {
		t.Fatalf("same-or-later UTC day refused: %v", err)
	}
	// Midnight UTC read back in EDT is still 2026-04-25 by UTC day.
	sale := time.Date(2026, 4, 25, 0, 0, 0, 0, time.UTC).In(eastern)
	if err := colonySaleDateRefusal("A1", &installed, sale); err != nil {
		t.Fatalf("same UTC day in another zone refused: %v", err)
	}
	later := time.Date(2026, 4, 26, 0, 0, 0, 0, time.UTC)
	if err := colonySaleDateRefusal("A1", &later, sale); err == nil {
		t.Fatal("hive installed the next UTC day was allowed")
	}
}
