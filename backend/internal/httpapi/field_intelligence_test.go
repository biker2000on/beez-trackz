package httpapi

import (
	"math"
	"strings"
	"testing"
)

func TestDistanceMiles(t *testing.T) {
	distance := distanceMiles(40.7128, -74.0060, 40.7306, -73.9352)
	if math.Abs(distance-4.0) > 0.75 {
		t.Fatalf("distanceMiles() = %.2f, want roughly 4 miles", distance)
	}
}

func TestForecastWarmthShift(t *testing.T) {
	var forecast weatherForecast
	forecast.Daily.TemperatureMax = []float64{76, 78, 80, 75, 77, 79, 81}
	if got := forecastWarmthShift(forecast); got != -4 {
		t.Fatalf("forecastWarmthShift() = %d, want -4", got)
	}
	forecast.Daily.TemperatureMax = []float64{40, 42, 44}
	if got := forecastWarmthShift(forecast); got != 4 {
		t.Fatalf("forecastWarmthShift() = %d, want 4", got)
	}
}

func TestWeatherAlertsIncludeFeederWarning(t *testing.T) {
	var forecast weatherForecast
	forecast.Daily.Time = []string{"2026-11-01"}
	forecast.Daily.TemperatureMin = []float64{29}
	forecast.Daily.WindSpeedMax = []float64{10}
	alerts := weatherAlerts(forecast, feedingStatus{})
	if len(alerts) != 1 {
		t.Fatalf("weatherAlerts() returned %d alerts, want 1", len(alerts))
	}
	if !strings.Contains(alerts[0].Message, "No active feeder") {
		t.Fatalf("weather alert did not include feeder warning: %q", alerts[0].Message)
	}
}

func TestBroodPatternScore(t *testing.T) {
	tests := map[string]float64{
		"solid and even": 100,
		"good pattern":   80,
		"average":        60,
		"spotty":         30,
		"not recorded":   50,
	}
	for value, want := range tests {
		if got := broodPatternScore(value); got != want {
			t.Errorf("broodPatternScore(%q) = %.0f, want %.0f", value, got, want)
		}
	}
}

func TestAPITokenHash(t *testing.T) {
	const token = "bt_example"
	if got := apiTokenHash(token); got == token || len(got) != 64 {
		t.Fatalf("apiTokenHash() produced an invalid digest: %q", got)
	}
	if apiTokenHash(token) != apiTokenHash(token) {
		t.Fatal("apiTokenHash() is not deterministic")
	}
}

func TestMCPToolCatalog(t *testing.T) {
	required := map[string]bool{
		"list_apiaries":         false,
		"get_apiary_weather":    false,
		"get_bloom_predictions": false,
		"record_inspection":     false,
		"record_feeding":        false,
		"record_mite_count":     false,
	}
	for _, tool := range mcpTools() {
		name, _ := tool["name"].(string)
		if _, ok := required[name]; ok {
			required[name] = true
		}
	}
	for name, found := range required {
		if !found {
			t.Errorf("MCP tool %q is missing", name)
		}
	}
}
