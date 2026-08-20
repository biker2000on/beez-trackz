package httpapi

import (
	"math"
	"strings"
	"testing"
)

// Scale ingest is CSV only, and the CSVs are whatever a Broodminder or
// HiveTracks export happens to look like that season. These tests pin the
// shapes the parser has to survive: metadata preamble lines above the header,
// kilograms, Celsius, blank and diagnostic rows, and several rows per day.

func TestParseScaleCSVBroodminderStyle(t *testing.T) {
	t.Parallel()

	// A Broodminder-style export: metadata lines above the header, hourly
	// rows, Fahrenheit, pounds named in the header.
	csv := strings.Join([]string{
		"Broodminder-W export",
		"Device,BM-W-1234",
		"",
		"Date,Weight (lbs),Temperature (F),Humidity (%)",
		"2026-06-10 06:00,102.5,58.0,62",
		"2026-06-10 12:00,104.5,78.0,48",
		"2026-06-10 18:00,103.0,71.0,55",
		"2026-06-11 06:00,109.0,60.0,60",
	}, "\n")

	result, err := parseScaleCSV(strings.NewReader(csv), "lb")
	if err != nil {
		t.Fatalf("parseScaleCSV: %v", err)
	}
	if result.RowsParsed != 4 {
		t.Errorf("RowsParsed = %d, want 4", result.RowsParsed)
	}
	if len(result.Days) != 2 {
		t.Fatalf("len(Days) = %d, want 2", len(result.Days))
	}

	first := result.Days[0]
	if first.Date != "2026-06-10" {
		t.Errorf("Days[0].Date = %q, want 2026-06-10", first.Date)
	}
	if first.Samples != 3 {
		t.Errorf("Days[0].Samples = %d, want 3", first.Samples)
	}
	// Three readings collapse to the day's mean, and the min/max survive so a
	// robbing spike is still visible in the daily curve.
	if math.Abs(first.WeightLb-103.333) > 0.001 {
		t.Errorf("Days[0].WeightLb = %v, want ~103.333", first.WeightLb)
	}
	if first.MinLb != 102.5 || first.MaxLb != 104.5 {
		t.Errorf("Days[0] min/max = %v/%v, want 102.5/104.5", first.MinLb, first.MaxLb)
	}
	if first.Temperature == nil || math.Abs(*first.Temperature-69) > 0.01 {
		t.Errorf("Days[0].Temperature = %v, want ~69", first.Temperature)
	}
	if first.Humidity == nil || math.Abs(*first.Humidity-55) > 0.01 {
		t.Errorf("Days[0].Humidity = %v, want ~55", first.Humidity)
	}

	// Days come back in calendar order so the series is a curve, not a scatter.
	if result.Days[1].Date != "2026-06-11" {
		t.Errorf("Days[1].Date = %q, want 2026-06-11", result.Days[1].Date)
	}
}

func TestParseScaleCSVConvertsMetricHeaders(t *testing.T) {
	t.Parallel()

	// The header names kilograms and Celsius, so the default unit is ignored
	// and the stored weight is canonical pounds like every other mass.
	csv := strings.Join([]string{
		"timestamp,Weight (kg),Temp (C)",
		"2026-06-10T06:00:00Z,45.0,10.0",
	}, "\n")

	result, err := parseScaleCSV(strings.NewReader(csv), "lb")
	if err != nil {
		t.Fatalf("parseScaleCSV: %v", err)
	}
	if result.WeightUnit != "kg" {
		t.Errorf("WeightUnit = %q, want kg", result.WeightUnit)
	}
	if len(result.Days) != 1 {
		t.Fatalf("len(Days) = %d, want 1", len(result.Days))
	}
	if want := 45.0 * poundsPerKilogram; math.Abs(result.Days[0].WeightLb-want) > 0.01 {
		t.Errorf("WeightLb = %v, want ~%v", result.Days[0].WeightLb, want)
	}
	if got := result.Days[0].Temperature; got == nil || math.Abs(*got-50) > 0.01 {
		t.Errorf("Temperature = %v, want 50F", got)
	}
}

func TestParseScaleCSVHonoursDefaultUnitWhenHeaderIsSilent(t *testing.T) {
	t.Parallel()

	csv := "Date,Weight\n2026-06-10,45.0\n"
	result, err := parseScaleCSV(strings.NewReader(csv), "kg")
	if err != nil {
		t.Fatalf("parseScaleCSV: %v", err)
	}
	if want := 45.0 * poundsPerKilogram; math.Abs(result.Days[0].WeightLb-want) > 0.01 {
		t.Errorf("WeightLb = %v, want ~%v", result.Days[0].WeightLb, want)
	}
}

func TestParseScaleCSVSkipsUnusableRowsWithoutFailingTheFile(t *testing.T) {
	t.Parallel()

	// A device export routinely carries blank cells, diagnostic text, and an
	// out-of-range calibration row. None of those may cost the operator the
	// rest of an otherwise good file.
	csv := strings.Join([]string{
		"Date,Weight (lbs)",
		"2026-06-10,101.0",
		"2026-06-10,",
		",95.0",
		"not-a-date,99.0",
		"2026-06-11,battery low",
		"2026-06-11,99999",
		"2026-06-11,-4",
		"2026-06-12,110.0",
	}, "\n")

	result, err := parseScaleCSV(strings.NewReader(csv), "lb")
	if err != nil {
		t.Fatalf("parseScaleCSV: %v", err)
	}
	if result.RowsParsed != 2 {
		t.Errorf("RowsParsed = %d, want 2", result.RowsParsed)
	}
	if result.RowsSkipped != 6 {
		t.Errorf("RowsSkipped = %d, want 6", result.RowsSkipped)
	}
	if len(result.Days) != 2 {
		t.Fatalf("len(Days) = %d, want 2 (10th and 12th)", len(result.Days))
	}
	if result.Days[0].Date != "2026-06-10" || result.Days[1].Date != "2026-06-12" {
		t.Errorf("Days = %q/%q, want 2026-06-10/2026-06-12",
			result.Days[0].Date, result.Days[1].Date)
	}
}

func TestParseScaleCSVRejectsFileWithNoWeightColumn(t *testing.T) {
	t.Parallel()

	csv := "Date,Temperature\n2026-06-10,58\n"
	if _, err := parseScaleCSV(strings.NewReader(csv), "lb"); err == nil {
		t.Fatal("parseScaleCSV accepted a CSV with no weight column")
	}
}

func TestScaleParseDateAcceptsExportLayouts(t *testing.T) {
	t.Parallel()

	cases := map[string]string{
		"2026-06-10":              "2026-06-10",
		"2026-06-10 14:30":        "2026-06-10",
		"2026-06-10T14:30:00Z":    "2026-06-10",
		"06/10/2026":              "2026-06-10",
		"6/10/2026 14:30":         "2026-06-10",
		"\"2026-06-10 14:30:00\"": "2026-06-10",
		"10.06.2026":              "2026-06-10",
	}
	for raw, want := range cases {
		got, ok := scaleParseDate(raw)
		if !ok || got != want {
			t.Errorf("scaleParseDate(%q) = %q,%v; want %q,true", raw, got, ok, want)
		}
	}
	for _, raw := range []string{"", "   ", "yesterday", "0"} {
		if got, ok := scaleParseDate(raw); ok {
			t.Errorf("scaleParseDate(%q) = %q,true; want not ok", raw, got)
		}
	}
}

func TestScaleValidVendor(t *testing.T) {
	t.Parallel()

	for _, vendor := range []string{"broodminder", "hivetracks", "other"} {
		if !scaleValidVendor(vendor) {
			t.Errorf("scaleValidVendor(%q) = false, want true", vendor)
		}
	}
	for _, vendor := range []string{"", "Broodminder", "mqtt", "arnia"} {
		if scaleValidVendor(vendor) {
			t.Errorf("scaleValidVendor(%q) = true, want false", vendor)
		}
	}
}

func TestScaleWeightSummaryReadsTheDayOverDayChange(t *testing.T) {
	t.Parallel()

	gain, loss, flat := 3.2, -2.4, 0.1
	cases := []struct {
		name   string
		change *float64
		want   string
	}{
		{"no previous day", nil, "No previous day"},
		{"flow", &gain, "Gained 3.2 lb"},
		{"robbing", &loss, "Lost 2.4 lb"},
		{"quiet", &flat, "Flat"},
	}
	for _, test := range cases {
		test := test
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			if got := scaleWeightSummary(test.change); !strings.Contains(got, test.want) {
				t.Errorf("scaleWeightSummary(%v) = %q, want it to contain %q",
					test.change, got, test.want)
			}
		})
	}
}
