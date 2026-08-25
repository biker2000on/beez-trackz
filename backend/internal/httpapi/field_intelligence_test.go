package httpapi

import (
	"context"
	"encoding/json"
	"io"
	"math"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/google/uuid"
)

type weatherRoundTripFunc func(*http.Request) (*http.Response, error)

func (f weatherRoundTripFunc) RoundTrip(request *http.Request) (*http.Response, error) {
	return f(request)
}

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

func TestLoadApiaryWeatherRefetchesNonMetricCache(t *testing.T) {
	pool := equipPool(t)
	ctx := context.Background()
	var apiaryID uuid.UUID
	if err := pool.QueryRow(ctx, `
		INSERT INTO apiaries (name, latitude, longitude)
		VALUES ($1, 35.5, -82.5) RETURNING id`,
		"weather cache "+uuid.NewString()).Scan(&apiaryID); err != nil {
		t.Fatalf("insert apiary: %v", err)
	}
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(), `DELETE FROM apiaries WHERE id = $1`, apiaryID)
	})
	if _, err := pool.Exec(ctx, `
		INSERT INTO apiary_weather_cache
			(apiary_id, latitude, longitude, forecast, fetched_at, expires_at)
		VALUES ($1, 35.5, -82.5, $2::jsonb, now(), now() + interval '30 minutes')`,
		apiaryID, `{"unitsSystem":"us","current":{"temperature_2m":70}}`); err != nil {
		t.Fatalf("insert stale cache: %v", err)
	}

	requests := 0
	client := &http.Client{Transport: weatherRoundTripFunc(func(request *http.Request) (*http.Response, error) {
		requests++
		if request.URL.Query().Get("temperature_unit") != "celsius" ||
			request.URL.Query().Get("wind_speed_unit") != "kmh" {
			t.Errorf("provider units query = %q", request.URL.RawQuery)
		}
		body := `{
			"latitude":35.5,"longitude":-82.5,"timezone":"UTC",
			"current":{"time":"2026-08-25T12:00","temperature_2m":12,
				"apparent_temperature":11,"relative_humidity_2m":60,
				"weather_code":1,"wind_speed_10m":8,"is_day":1},
			"daily":{"time":[],"weather_code":[],"temperature_2m_max":[],
				"temperature_2m_min":[],"precipitation_sum":[],
				"precipitation_probability_max":[],"wind_speed_10m_max":[]}}`
		return &http.Response{
			StatusCode: http.StatusOK,
			Header:     make(http.Header),
			Body:       io.NopCloser(strings.NewReader(body)),
			Request:    request,
		}, nil
	})}
	server := &Server{pool: pool, weatherHTTPClient: client}
	result, err := server.loadApiaryWeather(
		httptest.NewRequest(http.MethodGet, "/weather", nil), apiaryID)
	if err != nil {
		t.Fatalf("load weather: %v", err)
	}
	if requests != 1 {
		t.Fatalf("provider requests = %d, want 1 refetch", requests)
	}
	if result.Forecast.UnitsSystem != metricWeatherUnits ||
		result.Forecast.Current.UnitsSystem != metricWeatherUnits {
		t.Fatalf("refetched units = %q/%q, want metric",
			result.Forecast.UnitsSystem, result.Forecast.Current.UnitsSystem)
	}
	if result.Forecast.Current.Temperature != 12 {
		t.Fatalf("temperature = %v, want refetched value 12", result.Forecast.Current.Temperature)
	}

	var cachedRaw []byte
	if err := pool.QueryRow(ctx, `
		SELECT forecast FROM apiary_weather_cache WHERE apiary_id = $1`, apiaryID).
		Scan(&cachedRaw); err != nil {
		t.Fatalf("read refreshed cache: %v", err)
	}
	var cached weatherForecast
	if err := json.Unmarshal(cachedRaw, &cached); err != nil {
		t.Fatalf("decode refreshed cache: %v", err)
	}
	if cached.UnitsSystem != metricWeatherUnits {
		t.Fatalf("cached units = %q, want metric", cached.UnitsSystem)
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
