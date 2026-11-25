package httpapi

import (
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
)

func civil(t *testing.T, value string) time.Time {
	t.Helper()
	day, err := parseCivilDate(value)
	if err != nil {
		t.Fatalf("parse %q: %v", value, err)
	}
	return day
}

func TestParseActivityRange(t *testing.T) {
	now := time.Date(2026, time.November, 25, 15, 0, 0, 0, time.Local)
	cases := []struct {
		name, from, to string
		wantFrom       string
		wantTo         string
		wantErr        string
	}{
		{"defaults", "", "", "2025-11-25", "2026-11-25", ""},
		{"to only", "", "2026-09-13", "2025-09-13", "2026-09-13", ""},
		{"from only", "2026-09-01", "", "2026-09-01", "2026-11-25", ""},
		{"single day", "2026-09-13", "2026-09-13", "2026-09-13", "2026-09-13", ""},
		{"exactly three years", "2023-11-25", "2026-11-25", "2023-11-25", "2026-11-25", ""},
		{"over three years", "2023-11-24", "2026-11-25", "", "", "cannot exceed 3 years"},
		{"reversed", "2026-09-14", "2026-09-13", "", "", "from must be on or before to"},
		{"bad from", "Sep 13", "", "", "", "from must be a date"},
		{"bad to", "", "2026-13-01", "", "", "to must be a date"},
		{"timestamp refused", "2026-09-13T00:00:00Z", "", "", "", "from must be a date"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			rg, err := parseActivityRange(tc.from, tc.to, now)
			if tc.wantErr != "" {
				if err == nil || !strings.Contains(err.Error(), tc.wantErr) {
					t.Fatalf("err = %v, want %q", err, tc.wantErr)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if formatCivil(rg.From) != tc.wantFrom || formatCivil(rg.To) != tc.wantTo {
				t.Fatalf("range = %s..%s, want %s..%s",
					formatCivil(rg.From), formatCivil(rg.To), tc.wantFrom, tc.wantTo)
			}
		})
	}
}

func TestActivityRangeContainsIsInclusive(t *testing.T) {
	rg := activityRange{From: civil(t, "2026-09-01"), To: civil(t, "2026-09-30")}
	for value, want := range map[string]bool{
		"2026-08-31": false, "2026-09-01": true, "2026-09-15": true,
		"2026-09-30": true, "2026-10-01": false,
	} {
		if got := rg.contains(civil(t, value)); got != want {
			t.Errorf("contains(%s) = %v", value, got)
		}
	}
	lower, upper := rg.sqlBounds()
	if !lower.Before(rg.From) || !upper.After(rg.To.AddDate(0, 0, 1)) {
		t.Fatalf("sql bounds %v..%v must widen %v..%v", lower, upper, rg.From, rg.To)
	}
}

func TestParseActivityTypes(t *testing.T) {
	types, err := parseActivityTypes("")
	if err != nil || types != nil {
		t.Fatalf("empty filter = %v %v, want nil (all)", types, err)
	}
	types, err = parseActivityTypes(" Inspection, queen ,mite_count,,")
	if err != nil {
		t.Fatal(err)
	}
	if !types["inspection"] || !types["queen_event"] || !types["mite_count"] || len(types) != 3 {
		t.Fatalf("types = %v", types)
	}
	types, err = parseActivityTypes("queen_event")
	if err != nil || !types["queen_event"] {
		t.Fatalf("raw queen_event alias = %v %v", types, err)
	}
	if _, err := parseActivityTypes("inspection,weather"); err == nil ||
		!strings.Contains(err.Error(), `unknown type "weather"`) {
		t.Fatalf("err = %v", err)
	}
	for _, name := range activityTypeNames {
		if _, ok := activityTypeAliases[name]; !ok {
			t.Errorf("contract type %q has no mapping", name)
		}
	}
	if !typeAllowed(nil, "status") || typeAllowed(map[string]bool{"feeding": true}, "status") {
		t.Fatal("typeAllowed")
	}
}

func TestEventDay(t *testing.T) {
	// A date-only value stored as UTC midnight is that UTC date.
	if got := formatCivil(eventDay(time.Date(2026, 9, 13, 0, 0, 0, 0, time.UTC))); got != "2026-09-13" {
		t.Fatalf("utc midnight = %s", got)
	}
	// A time of day is read in server local time.
	local := time.Date(2026, 9, 13, 13, 41, 0, 0, time.Local)
	if got := formatCivil(eventDay(local)); got != "2026-09-13" {
		t.Fatalf("local afternoon = %s", got)
	}
	// parseDate output (local midnight) maps back to its own day.
	at, _ := parseDate("2026-09-13")
	if got := formatCivil(eventDay(at)); got != "2026-09-13" {
		t.Fatalf("parseDate day = %s", got)
	}
}

func TestBuildActivityDaysOrdering(t *testing.T) {
	installedEarly := time.Date(2024, 4, 1, 0, 0, 0, 0, time.UTC)
	installedLate := time.Date(2026, 4, 27, 0, 0, 0, 0, time.UTC)
	b4 := uuid.New()
	a1Old := uuid.New()
	a1New := uuid.New()
	hives := map[uuid.UUID]activityHiveInfo{
		b4:    {header: activityHiveJSON{HiveID: b4, PositionLabel: "B4", Status: "active"}},
		a1Old: {header: activityHiveJSON{HiveID: a1Old, PositionLabel: "A1", Status: "sold", IsArchived: true}, installed: &installedEarly},
		a1New: {header: activityHiveJSON{HiveID: a1New, PositionLabel: "a1", Status: "active"}, installed: &installedLate},
	}
	at := func(day string, hour int) time.Time {
		d := civil(t, day)
		return time.Date(d.Year(), d.Month(), d.Day(), hour, 0, 0, 0, time.Local)
	}
	row := func(hive uuid.UUID, kind string, when time.Time) timelineRow {
		return timelineRow{HiveID: hive, hiveTimelineEntry: hiveTimelineEntry{
			ID: uuid.New(), Type: kind, Date: when, Title: kind,
			Photos: []hiveTimelinePhoto{}, Meta: []byte(`{}`),
		}}
	}
	rows := []timelineRow{
		row(b4, "inspection", at("2026-09-13", 10)),
		row(a1New, "feeding", at("2026-09-13", 9)),
		row(a1New, "inspection", at("2026-09-13", 11)),
		row(a1Old, "harvest", at("2026-09-13", 8)),
		row(b4, "mite_count", at("2026-09-12", 10)),
		row(b4, "inspection", at("2026-08-31", 10)),         // outside the range
		row(uuid.New(), "inspection", at("2026-09-13", 10)), // unknown hive
	}
	observations := []activityObservationJSON{
		{ID: uuid.New(), ObservedAt: at("2026-09-14", 7), Notes: "goldenrod"},
		{ID: uuid.New(), ObservedAt: at("2026-09-13", 9), Notes: "early"},
		{ID: uuid.New(), ObservedAt: at("2026-09-13", 14), Notes: "late"},
	}
	rg := activityRange{From: civil(t, "2026-09-01"), To: civil(t, "2026-09-30")}
	days := buildActivityDays(hives, rows, observations, rg)

	var dates []string
	for _, day := range days {
		dates = append(dates, day.Date)
	}
	if strings.Join(dates, ",") != "2026-09-14,2026-09-13,2026-09-12" {
		t.Fatalf("days = %v", dates)
	}
	if len(days[0].Hives) != 0 || len(days[0].ApiaryObservations) != 1 {
		t.Fatalf("observation-only day = %+v", days[0])
	}
	day := days[1]
	if day.ApiaryObservations[0].Notes != "late" || day.ApiaryObservations[1].Notes != "early" {
		t.Fatalf("observations not newest first: %+v", day.ApiaryObservations)
	}
	var order []uuid.UUID
	for _, hive := range day.Hives {
		order = append(order, hive.HiveID)
	}
	if len(order) != 3 || order[0] != a1Old || order[1] != a1New || order[2] != b4 {
		t.Fatalf("hive order = %v, want old A1, new A1, B4", order)
	}
	events := day.Hives[1].Events
	if len(events) != 2 || events[0].Type != "inspection" || events[1].Type != "feeding" {
		t.Fatalf("events not newest first: %+v", events)
	}
	if day.Hives[0].Status != "sold" || !day.Hives[0].IsArchived {
		t.Fatalf("retired hive header lost: %+v", day.Hives[0])
	}
	if len(days[2].Hives) != 1 || days[2].ApiaryObservations == nil {
		t.Fatalf("2026-09-12 = %+v", days[2])
	}
}

func TestHiveStatusHelpers(t *testing.T) {
	now := time.Date(2026, 11, 25, 12, 0, 0, 0, time.Local)
	if date, err := hiveStatusDate(nil, now); err != nil || date != nil {
		t.Fatalf("nil date = %v %v", date, err)
	}
	blank := " "
	if date, err := hiveStatusDate(&blank, now); err != nil || date != nil {
		t.Fatalf("blank date = %v %v", date, err)
	}
	past := "2026-03-02"
	if date, err := hiveStatusDate(&past, now); err != nil || date == nil ||
		formatCivil(eventDay(*date)) != "2026-03-02" {
		t.Fatalf("past date = %v %v", date, err)
	}
	future := "2026-12-01"
	if _, err := hiveStatusDate(&future, now); err == nil {
		t.Fatal("future dead-out must be refused")
	}
	bad := "March"
	if _, err := hiveStatusDate(&bad, now); err == nil {
		t.Fatal("bad date must be refused")
	}
	for _, status := range []string{"active", "dead", "sold", "combined"} {
		query, usesDate, ok := hiveStatusUpdateSQL(status)
		if !ok || query == "" {
			t.Fatalf("%s: no update", status)
		}
		if usesDate != (status == "dead") {
			t.Fatalf("%s: usesDate = %v", status, usesDate)
		}
		for _, column := range []string{"notes", "position_label", "slot_row", "stand_id"} {
			if strings.Contains(query, column) {
				t.Fatalf("%s update touches %s", status, column)
			}
		}
	}
	if _, _, ok := hiveStatusUpdateSQL("archived"); ok {
		t.Fatal("unknown status accepted")
	}
}

func TestTimelineUnionSQLStatusBranch(t *testing.T) {
	if strings.Contains(timelineUnionSQL(false), "'Dead-out'") {
		t.Fatal("unfiltered timeline must not include status events")
	}
	withStatus := timelineUnionSQL(true)
	if !strings.Contains(withStatus, "'Dead-out'") || !strings.Contains(withStatus, "'Sold'") {
		t.Fatal("status branch missing")
	}
	if !strings.Contains(withStatus, "'eventType', q.event_type") {
		t.Fatal("queen events must carry eventType in meta")
	}
}
