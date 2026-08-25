package httpapi

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"net/http"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	qrcode "github.com/skip2/go-qrcode"
)

func (s *Server) mountFieldIntelligence(r chi.Router) {
	r.With(s.requireApiaryParamRole(false)).
		Get("/apiaries/{id}/weather", s.apiaryWeather)
	r.With(s.requireApiaryParamRole(false)).
		Get("/apiaries/{id}/bloom-predictions", s.apiaryBloomPredictions)
	r.With(s.requireHiveParamRole(false)).
		Get("/hives/{id}/tag", s.hiveTag)
	r.With(s.requireHiveParamRole(false)).
		Get("/hives/{id}/tag/qr", s.hiveTagQR)
	r.Get("/analytics/queen-performance", s.queenPerformance)
}

type weatherForecast struct {
	Latitude    float64 `json:"latitude"`
	Longitude   float64 `json:"longitude"`
	Timezone    string  `json:"timezone"`
	UnitsSystem string  `json:"unitsSystem"`
	Current     struct {
		UnitsSystem string  `json:"unitsSystem"`
		Time        string  `json:"time"`
		Temperature float64 `json:"temperature_2m"`
		Apparent    float64 `json:"apparent_temperature"`
		Humidity    float64 `json:"relative_humidity_2m"`
		WeatherCode int     `json:"weather_code"`
		WindSpeed   float64 `json:"wind_speed_10m"`
		IsDay       int     `json:"is_day"`
	} `json:"current"`
	Daily struct {
		Time              []string  `json:"time"`
		WeatherCode       []int     `json:"weather_code"`
		TemperatureMax    []float64 `json:"temperature_2m_max"`
		TemperatureMin    []float64 `json:"temperature_2m_min"`
		PrecipitationSum  []float64 `json:"precipitation_sum"`
		PrecipProbability []float64 `json:"precipitation_probability_max"`
		WindSpeedMax      []float64 `json:"wind_speed_10m_max"`
	} `json:"daily"`
}

type weatherAlert struct {
	Date     string `json:"date"`
	Severity string `json:"severity"`
	Message  string `json:"message"`
}

type apiaryWeatherResponse struct {
	ApiaryID uuid.UUID       `json:"apiaryId"`
	Source   string          `json:"source"`
	Fetched  time.Time       `json:"fetchedAt"`
	Forecast weatherForecast `json:"forecast"`
	// Daily arrays start frostLookbackDays in the past. ForecastStart is the
	// index of today so callers can render the outlook without the history.
	ForecastStart int            `json:"forecastStartIndex"`
	Alerts        []weatherAlert `json:"alerts"`
	Frost         frostSummary   `json:"frost"`
	Feeding       feedingStatus  `json:"feedingStatus"`
}

// frostLookbackDays is the "last week" in "this stand frosted N nights last
// week" — the past window requested from the existing weather snapshot.
const frostLookbackDays = 7

// Freezing, and the hard freeze that ends a bloom rather than nipping it.
// Weather is canonical Celsius / km/h / mm from the provider onward.
const (
	metricWeatherUnits   = "metric"
	frostThresholdC      = 0.0
	hardFreezeThresholdC = -2.2222222222
	strongWindKmh        = 25 * 1.609344
)

// frostSummary is the night-lows read of the pin: what already happened in the
// past week, and the next frost in the outlook. Available is false when the
// snapshot carries no past days (a cache row written before past_days, or a
// provider that returned only the outlook) — a silent zero would read as
// "no frost" when it means "not known".
type frostSummary struct {
	Available        bool     `json:"available"`
	ThresholdC       float64  `json:"thresholdC"`
	WindowStart      string   `json:"windowStart"`
	WindowEnd        string   `json:"windowEnd"`
	NightsLastWeek   int      `json:"nightsLastWeek"`
	HardFreezeNights int      `json:"hardFreezeNights"`
	LowestC          *float64 `json:"lowestC"`
	Dates            []string `json:"dates"`
	UpcomingNights   int      `json:"upcomingNights"`
	NextFrostDate    *string  `json:"nextFrostDate"`
	Summary          string   `json:"summary"`
}

type feedingStatus struct {
	ActiveFeeders  int        `json:"activeFeeders"`
	LastFeedingAt  *time.Time `json:"lastFeedingAt"`
	NeedsAttention bool       `json:"needsAttention"`
}

// weatherLocation resolves the apiary's own timezone so "today" is the
// stand's today, not the server's. Falls back to the server zone when the
// host has no tzdata for the name.
func weatherLocation(forecast weatherForecast) *time.Location {
	if forecast.Timezone == "" {
		return time.Local
	}
	location, err := time.LoadLocation(forecast.Timezone)
	if err != nil {
		return time.Local
	}
	return location
}

// forecastStartIndex is the first daily index that is today or later. Every
// index before it is the past week the frost read is built from.
func forecastStartIndex(forecast weatherForecast) int {
	today := time.Now().In(weatherLocation(forecast)).Format("2006-01-02")
	for index, date := range forecast.Daily.Time {
		if date >= today {
			return index
		}
	}
	return len(forecast.Daily.Time)
}

// dailyMin reads the daily minimum at an index, or false when the provider
// returned a shorter array than the date list.
func dailyMin(forecast weatherForecast, index int) (float64, bool) {
	if index < 0 || index >= len(forecast.Daily.TemperatureMin) {
		return 0, false
	}
	return forecast.Daily.TemperatureMin[index], true
}

// frostRead answers "this stand frosted N nights last week" from the snapshot
// already cached for the pin. No new provider.
func frostRead(forecast weatherForecast) frostSummary {
	start := forecastStartIndex(forecast)
	frostThreshold := frostThresholdC
	hardFreezeThreshold := hardFreezeThresholdC
	if forecast.UnitsSystem != metricWeatherUnits {
		// Compatibility for in-process callers built around the legacy shape.
		frostThreshold = 32
		hardFreezeThreshold = 28
	}
	value := frostSummary{ThresholdC: frostThreshold, Dates: []string{}}
	if start > 0 {
		value.Available = true
		value.WindowStart = forecast.Daily.Time[0]
		value.WindowEnd = forecast.Daily.Time[start-1]
	}
	for index := 0; index < start; index++ {
		low, ok := dailyMin(forecast, index)
		if !ok {
			continue
		}
		if value.LowestC == nil || low < *value.LowestC {
			lowest := low
			value.LowestC = &lowest
		}
		if low <= frostThreshold {
			value.NightsLastWeek++
			value.Dates = append(value.Dates, forecast.Daily.Time[index])
		}
		if low <= hardFreezeThreshold {
			value.HardFreezeNights++
		}
	}
	for index := start; index < len(forecast.Daily.Time); index++ {
		low, ok := dailyMin(forecast, index)
		if !ok || low > frostThreshold {
			continue
		}
		value.UpcomingNights++
		if value.NextFrostDate == nil {
			date := forecast.Daily.Time[index]
			value.NextFrostDate = &date
		}
	}
	value.Summary = frostSentence(value)
	return value
}

func frostSentence(value frostSummary) string {
	if !value.Available {
		return "Night lows for the past week are not in this snapshot yet."
	}
	switch {
	case value.NightsLastWeek == 0:
		return "No frost at this stand in the past week."
	case value.NightsLastWeek == 1:
		return "This stand frosted 1 night last week."
	default:
		return fmt.Sprintf("This stand frosted %d nights last week.",
			value.NightsLastWeek)
	}
}

// weatherAlerts warns about the outlook only: start is the first daily index
// that is today or later, so the past week the frost read uses never turns
// into a cold-snap alert for a night that already passed.
func weatherAlerts(forecast weatherForecast, feeding feedingStatus) []weatherAlert {
	start := forecastStartIndex(forecast)
	alerts := []weatherAlert{}
	coldThreshold := frostThresholdC
	windThreshold := strongWindKmh
	temperatureUnit := "°C"
	windUnit := "km/h"
	if forecast.UnitsSystem != metricWeatherUnits {
		coldThreshold = 32
		windThreshold = 25
		temperatureUnit = "°F"
		windUnit = "mph"
	}
	for index, date := range forecast.Daily.Time {
		if index < start {
			continue
		}
		if index < len(forecast.Daily.TemperatureMin) &&
			forecast.Daily.TemperatureMin[index] <= coldThreshold {
			message := fmt.Sprintf("Cold snap: %.0f%s low; check feed and wind protection.",
				forecast.Daily.TemperatureMin[index], temperatureUnit)
			if feeding.ActiveFeeders == 0 {
				message += " No active feeder is recorded for this apiary."
			}
			alerts = append(alerts, weatherAlert{
				Date: date, Severity: "high",
				Message: message,
			})
		}
		if index < len(forecast.Daily.WindSpeedMax) &&
			forecast.Daily.WindSpeedMax[index] >= windThreshold {
			alerts = append(alerts, weatherAlert{
				Date: date, Severity: "normal",
				Message: fmt.Sprintf("Strong wind: %.0f %s; secure covers and loose equipment.",
					forecast.Daily.WindSpeedMax[index], windUnit),
			})
		}
	}
	return alerts
}

func (s *Server) apiaryFeedingStatus(
	r *http.Request,
	apiaryID uuid.UUID,
) feedingStatus {
	var value feedingStatus
	_ = s.pool.QueryRow(r.Context(), `
		SELECT count(*) FILTER (WHERE feeding.status = 'open')::integer,
			max(feeding.date_fed)
		FROM feedings feeding
		JOIN hives hive ON hive.id=feeding.hive_id
		WHERE hive.apiary_id=$1`, apiaryID).
		Scan(&value.ActiveFeeders, &value.LastFeedingAt)
	value.NeedsAttention = value.ActiveFeeders == 0
	return value
}

func (s *Server) loadApiaryWeather(
	r *http.Request,
	apiaryID uuid.UUID,
) (*apiaryWeatherResponse, error) {
	var latitude, longitude float64
	err := s.pool.QueryRow(r.Context(), `
		SELECT latitude,longitude FROM apiaries
		WHERE id=$1 AND latitude IS NOT NULL AND longitude IS NOT NULL`,
		apiaryID).Scan(&latitude, &longitude)
	if err != nil {
		return nil, err
	}
	feeding := s.apiaryFeedingStatus(r, apiaryID)

	var cached []byte
	var fetched time.Time
	err = s.pool.QueryRow(r.Context(), `
		SELECT forecast,fetched_at FROM apiary_weather_cache
		WHERE apiary_id=$1 AND latitude=$2 AND longitude=$3 AND expires_at>now()`,
		apiaryID, latitude, longitude).Scan(&cached, &fetched)
	if err == nil {
		var forecast weatherForecast
		if json.Unmarshal(cached, &forecast) == nil &&
			forecast.UnitsSystem == metricWeatherUnits {
			return &apiaryWeatherResponse{
				ApiaryID: apiaryID, Source: "Open-Meteo", Fetched: fetched,
				Forecast: forecast, ForecastStart: forecastStartIndex(forecast),
				Alerts: weatherAlerts(forecast, feeding), Frost: frostRead(forecast),
				Feeding: feeding,
			}, nil
		}
	} else if !errors.Is(err, pgx.ErrNoRows) {
		return nil, err
	}

	query := url.Values{}
	query.Set("latitude", strconv.FormatFloat(latitude, 'f', 6, 64))
	query.Set("longitude", strconv.FormatFloat(longitude, 'f', 6, 64))
	query.Set("current",
		"temperature_2m,relative_humidity_2m,apparent_temperature,is_day,weather_code,wind_speed_10m")
	query.Set("daily",
		"weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum,precipitation_probability_max,wind_speed_10m_max")
	query.Set("temperature_unit", "celsius")
	query.Set("wind_speed_unit", "kmh")
	query.Set("precipitation_unit", "mm")
	query.Set("forecast_days", "10")
	// Frost and night lows at the pin come from the same snapshot, not a new
	// provider: the forecast endpoint returns the past week's daily minimum
	// alongside the outlook when past_days is set.
	query.Set("past_days", strconv.Itoa(frostLookbackDays))
	query.Set("timezone", "auto")

	request, err := http.NewRequestWithContext(r.Context(), http.MethodGet,
		"https://api.open-meteo.com/v1/forecast?"+query.Encode(), nil)
	if err != nil {
		return nil, err
	}
	client := &http.Client{Timeout: 12 * time.Second}
	response, err := client.Do(request)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("weather provider returned %d", response.StatusCode)
	}
	var forecast weatherForecast
	decoder := json.NewDecoder(io.LimitReader(response.Body, 2<<20))
	if err := decoder.Decode(&forecast); err != nil {
		return nil, err
	}
	forecast.UnitsSystem = metricWeatherUnits
	forecast.Current.UnitsSystem = metricWeatherUnits
	raw, err := json.Marshal(forecast)
	if err != nil {
		return nil, err
	}
	fetched = time.Now().UTC()
	if _, err := s.pool.Exec(r.Context(), `
		INSERT INTO apiary_weather_cache
			(apiary_id,latitude,longitude,forecast,fetched_at,expires_at)
		VALUES ($1,$2,$3,$4,$5,$6)
		ON CONFLICT (apiary_id) DO UPDATE SET
			latitude=EXCLUDED.latitude,longitude=EXCLUDED.longitude,
			forecast=EXCLUDED.forecast,fetched_at=EXCLUDED.fetched_at,
			expires_at=EXCLUDED.expires_at`,
		apiaryID, latitude, longitude, raw, fetched, fetched.Add(30*time.Minute)); err != nil {
		return nil, err
	}
	return &apiaryWeatherResponse{
		ApiaryID: apiaryID, Source: "Open-Meteo", Fetched: fetched,
		Forecast: forecast, ForecastStart: forecastStartIndex(forecast),
		Alerts: weatherAlerts(forecast, feeding), Frost: frostRead(forecast),
		Feeding: feeding,
	}, nil
}

func (s *Server) apiaryWeather(w http.ResponseWriter, r *http.Request) {
	id, err := uuidParam(r, "id")
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	value, err := s.loadApiaryWeather(r, id)
	if errors.Is(err, pgx.ErrNoRows) {
		writeError(w, http.StatusUnprocessableEntity,
			"apiary latitude and longitude are required for weather")
		return
	}
	if err != nil {
		writeError(w, http.StatusBadGateway, "weather is temporarily unavailable")
		return
	}
	writeJSON(w, http.StatusOK, value)
}

type bloomHistoryPoint struct {
	ApiaryID uuid.UUID
	Species  string
	Day      int
	Distance float64
}

type bloomPrediction struct {
	Species       string  `json:"species"`
	PredictedDate string  `json:"predictedDate"`
	WindowStart   string  `json:"windowStart"`
	WindowEnd     string  `json:"windowEnd"`
	Confidence    string  `json:"confidence"`
	Observations  int     `json:"observations"`
	RadiusMiles   float64 `json:"radiusMiles"`
	WeatherShift  int     `json:"weatherShiftDays"`
	Method        string  `json:"method"`
}

func radians(value float64) float64 { return value * math.Pi / 180 }

func distanceMiles(lat1, lon1, lat2, lon2 float64) float64 {
	dlat := radians(lat2 - lat1)
	dlon := radians(lon2 - lon1)
	a := math.Sin(dlat/2)*math.Sin(dlat/2) +
		math.Cos(radians(lat1))*math.Cos(radians(lat2))*
			math.Sin(dlon/2)*math.Sin(dlon/2)
	return 3958.8 * 2 * math.Atan2(math.Sqrt(a), math.Sqrt(1-a))
}

// forecastWarmthShift nudges a bloom prediction by the coming week's warmth.
// The daily arrays now open on the past week, so the average starts at today.
func forecastWarmthShift(forecast weatherForecast) int {
	start := forecastStartIndex(forecast)
	if start > len(forecast.Daily.TemperatureMax) {
		start = len(forecast.Daily.TemperatureMax)
	}
	window := forecast.Daily.TemperatureMax[start:]
	if len(window) > 7 {
		window = window[:7]
	}
	if len(window) == 0 {
		return 0
	}
	sum := 0.0
	for _, value := range window {
		sum += value
	}
	average := sum / float64(len(window))
	warmest := 23.8888888889
	warm := 18.3333333333
	coldest := 7.2222222222
	cold := 12.7777777778
	if forecast.UnitsSystem != metricWeatherUnits {
		warmest, warm, coldest, cold = 75, 65, 45, 55
	}
	switch {
	case average >= warmest:
		return -4
	case average >= warm:
		return -2
	case average <= coldest:
		return 4
	case average <= cold:
		return 2
	default:
		return 0
	}
}

func (s *Server) apiaryBloomPredictions(w http.ResponseWriter, r *http.Request) {
	id, err := uuidParam(r, "id")
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	var latitude, longitude float64
	if err := s.pool.QueryRow(r.Context(), `
		SELECT latitude,longitude FROM apiaries
		WHERE id=$1 AND latitude IS NOT NULL AND longitude IS NOT NULL`,
		id).Scan(&latitude, &longitude); errors.Is(err, pgx.ErrNoRows) {
		writeError(w, http.StatusUnprocessableEntity,
			"apiary latitude and longitude are required for bloom predictions")
		return
	} else if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}

	user := principalFrom(r)
	rows, err := s.pool.Query(r.Context(), `
		SELECT observation.apiary_id,observation.species,
			EXTRACT(DOY FROM observation.date_first_seen)::integer,
			apiary.latitude,apiary.longitude
		FROM bloom_observations observation
		JOIN apiaries apiary ON apiary.id=observation.apiary_id
		WHERE apiary.latitude IS NOT NULL AND apiary.longitude IS NOT NULL
			AND ($1::boolean OR EXISTS (
				SELECT 1 FROM apiary_memberships membership
				WHERE membership.apiary_id=apiary.id AND membership.user_id=$2
			))`, user.IsAdmin, user.ID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	defer rows.Close()
	bySpecies := map[string][]bloomHistoryPoint{}
	for rows.Next() {
		var point bloomHistoryPoint
		var pointLat, pointLon float64
		if err := rows.Scan(&point.ApiaryID, &point.Species, &point.Day,
			&pointLat, &pointLon); err != nil {
			writeError(w, http.StatusInternalServerError, "database error")
			return
		}
		point.Distance = distanceMiles(latitude, longitude, pointLat, pointLon)
		if point.Distance <= 50 {
			bySpecies[point.Species] = append(bySpecies[point.Species], point)
		}
	}

	weather, _ := s.loadApiaryWeather(r, id)
	weatherShift := 0
	if weather != nil {
		weatherShift = forecastWarmthShift(weather.Forecast)
	}
	now := time.Now()
	predictions := []bloomPrediction{}
	for species, points := range bySpecies {
		weightedDay, weights := 0.0, 0.0
		localCount := 0
		maxDistance := 0.0
		for _, point := range points {
			weight := 1 / (1 + point.Distance/10)
			if point.ApiaryID == id {
				weight *= 3
				localCount++
			}
			weightedDay += float64(point.Day) * weight
			weights += weight
			if point.Distance > maxDistance {
				maxDistance = point.Distance
			}
		}
		day := int(math.Round(weightedDay/weights)) + weatherShift
		year := now.Year()
		predicted := time.Date(year, 1, 1, 12, 0, 0, 0, time.Local).
			AddDate(0, 0, day-1)
		if predicted.Before(now.AddDate(0, 0, -30)) {
			predicted = predicted.AddDate(1, 0, 0)
		}
		window := 14
		confidence := "low"
		switch {
		case localCount >= 3 || len(points) >= 6:
			confidence, window = "high", 7
		case localCount >= 1 || len(points) >= 3:
			confidence, window = "medium", 10
		}
		predictions = append(predictions, bloomPrediction{
			Species: species, PredictedDate: predicted.Format("2006-01-02"),
			WindowStart: predicted.AddDate(0, 0, -window).Format("2006-01-02"),
			WindowEnd:   predicted.AddDate(0, 0, window).Format("2006-01-02"),
			Confidence:  confidence, Observations: len(points),
			RadiusMiles: math.Round(maxDistance*10) / 10, WeatherShift: weatherShift,
			Method: "distance-weighted observations within 50 miles, adjusted by the local 7-day temperature forecast",
		})
	}
	sort.Slice(predictions, func(i, j int) bool {
		return predictions[i].PredictedDate < predictions[j].PredictedDate
	})
	writeJSON(w, http.StatusOK, map[string]any{
		"apiaryId": id, "latitude": latitude, "longitude": longitude,
		"predictions": predictions,
	})
}

func (s *Server) hiveTagData(r *http.Request, id uuid.UUID) (map[string]any, error) {
	var apiaryID uuid.UUID
	var apiaryName, position string
	err := s.pool.QueryRow(r.Context(), `
		SELECT hive.apiary_id,apiary.name,hive.position_label
		FROM hives hive JOIN apiaries apiary ON apiary.id=hive.apiary_id
		WHERE hive.id=$1`, id).Scan(&apiaryID, &apiaryName, &position)
	if err != nil {
		return nil, err
	}
	target := strings.TrimRight(s.cfg.AppURL, "/") + "/hives/" + id.String()
	return map[string]any{
		"hiveId": id, "apiaryId": apiaryID, "apiaryName": apiaryName,
		"positionLabel": position, "url": target,
		"nfc": map[string]any{"recordType": "url", "data": target},
		"printProfiles": []map[string]any{
			{"id": "munbyn-2x1", "widthInches": 2, "heightInches": 1},
			{"id": "munbyn-3x2", "widthInches": 3, "heightInches": 2},
		},
	}, nil
}

func (s *Server) hiveTag(w http.ResponseWriter, r *http.Request) {
	id, err := uuidParam(r, "id")
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	value, err := s.hiveTagData(r, id)
	if errors.Is(err, pgx.ErrNoRows) {
		writeError(w, http.StatusNotFound, "hive not found")
		return
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	writeJSON(w, http.StatusOK, value)
}

func (s *Server) hiveTagQR(w http.ResponseWriter, r *http.Request) {
	id, err := uuidParam(r, "id")
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	size := 256
	if raw := r.URL.Query().Get("size"); raw != "" {
		if parsed, parseErr := strconv.Atoi(raw); parseErr == nil && parsed >= 128 && parsed <= 1024 {
			size = parsed
		}
	}
	target := strings.TrimRight(s.cfg.AppURL, "/") + "/hives/" + id.String()
	png, err := qrcode.Encode(target, qrcode.Medium, size)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "could not generate QR code")
		return
	}
	w.Header().Set("Content-Type", "image/png")
	w.Header().Set("Cache-Control", "private, max-age=3600")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(png)
}

type queenPerformanceRow struct {
	ID              uuid.UUID  `json:"id"`
	HiveID          *uuid.UUID `json:"hiveId"`
	HiveName        *string    `json:"hiveName"`
	ApiaryID        *uuid.UUID `json:"apiaryId"`
	ApiaryName      *string    `json:"apiaryName"`
	ParentQueenID   *uuid.UUID `json:"parentQueenId"`
	IntroducedDate  *time.Time `json:"introducedDate"`
	Status          string     `json:"status"`
	InspectionCount int        `json:"inspectionCount"`
	BroodScore      float64    `json:"broodScore"`
	Temperament     float64    `json:"temperamentScore"`
	YieldPounds     float64    `json:"yieldPounds"`
	SurvivalScore   float64    `json:"survivalScore"`
	OverallScore    float64    `json:"overallScore"`
}

func broodPatternScore(value string) float64 {
	lower := strings.ToLower(value)
	switch {
	case strings.Contains(lower, "solid"), strings.Contains(lower, "excellent"):
		return 100
	case strings.Contains(lower, "good"), strings.Contains(lower, "even"):
		return 80
	case strings.Contains(lower, "fair"), strings.Contains(lower, "average"):
		return 60
	case strings.Contains(lower, "spotty"), strings.Contains(lower, "poor"):
		return 30
	default:
		return 50
	}
}

func (s *Server) queenPerformance(w http.ResponseWriter, r *http.Request) {
	user := principalFrom(r)
	var requestedApiary *uuid.UUID
	if raw := r.URL.Query().Get("apiaryId"); raw != "" {
		parsed, err := uuid.Parse(raw)
		if err != nil {
			writeError(w, http.StatusBadRequest, "invalid apiaryId")
			return
		}
		if !s.requireApiaryRole(w, r, parsed, false) {
			return
		}
		requestedApiary = &parsed
	}
	rows, err := s.pool.Query(r.Context(), `
		SELECT queen.id,queen.hive_id,hive.position_label,hive.apiary_id,apiary.name,
			queen.parent_queen_id,queen.introduced_date,queen.status::text,
			hive.status::text,hive.deadout_date
		FROM queens queen
		LEFT JOIN hives hive ON hive.id=queen.hive_id
		LEFT JOIN apiaries apiary ON apiary.id=hive.apiary_id
		WHERE ($1::uuid IS NULL OR hive.apiary_id=$1)
			AND ($2::boolean OR EXISTS (
				SELECT 1 FROM apiary_memberships membership
				WHERE membership.apiary_id=hive.apiary_id AND membership.user_id=$3
			))
		ORDER BY apiary.name,hive.position_label,queen.introduced_date`,
		requestedApiary, user.IsAdmin, user.ID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	defer rows.Close()
	items := []queenPerformanceRow{}
	for rows.Next() {
		var item queenPerformanceRow
		var hiveStatus *string
		var deadout *time.Time
		if err := rows.Scan(&item.ID, &item.HiveID, &item.HiveName, &item.ApiaryID,
			&item.ApiaryName, &item.ParentQueenID, &item.IntroducedDate,
			&item.Status, &hiveStatus, &deadout); err != nil {
			writeError(w, http.StatusInternalServerError, "database error")
			return
		}
		if item.HiveID == nil {
			items = append(items, item)
			continue
		}
		var nextIntroduced *time.Time
		_ = s.pool.QueryRow(r.Context(), `
			SELECT min(introduced_date) FROM queens
			WHERE hive_id=$1 AND id<>$2 AND introduced_date>$3`,
			item.HiveID, item.ID, item.IntroducedDate).Scan(&nextIntroduced)
		inspectionRows, queryErr := s.pool.Query(r.Context(), `
			SELECT COALESCE(brood_pattern,''),temperament
			FROM inspections
			WHERE hive_id=$1 AND ($2::timestamptz IS NULL OR date >= $2)
				AND ($3::timestamptz IS NULL OR date < $3)`,
			item.HiveID, item.IntroducedDate, nextIntroduced)
		if queryErr != nil {
			writeError(w, http.StatusInternalServerError, "database error")
			return
		}
		broodTotal, broodCount := 0.0, 0
		tempTotal, tempCount := 0.0, 0
		for inspectionRows.Next() {
			var brood string
			var temperament *int
			if scanErr := inspectionRows.Scan(&brood, &temperament); scanErr != nil {
				inspectionRows.Close()
				writeError(w, http.StatusInternalServerError, "database error")
				return
			}
			item.InspectionCount++
			if brood != "" {
				broodTotal += broodPatternScore(brood)
				broodCount++
			}
			if temperament != nil {
				tempTotal += float64(*temperament) * 20
				tempCount++
			}
		}
		inspectionRows.Close()
		item.BroodScore = 50
		if broodCount > 0 {
			item.BroodScore = broodTotal / float64(broodCount)
		}
		item.Temperament = 50
		if tempCount > 0 {
			item.Temperament = tempTotal / float64(tempCount)
		}
		if err := s.pool.QueryRow(r.Context(), `
			SELECT COALESCE(sum(calculated_honey_weight),0)
			FROM honey_harvests
			WHERE hive_id=$1 AND deleted_at IS NULL AND ($2::timestamptz IS NULL OR date >= $2)
				AND ($3::timestamptz IS NULL OR date < $3)`,
			item.HiveID, item.IntroducedDate, nextIntroduced).Scan(&item.YieldPounds); err != nil {
			writeError(w, http.StatusInternalServerError, "database error")
			return
		}
		item.SurvivalScore = 100
		if hiveStatus != nil && *hiveStatus == "dead" && deadout != nil &&
			(nextIntroduced == nil || deadout.Before(*nextIntroduced)) {
			item.SurvivalScore = 0
		}
		yieldScore := math.Min(100, item.YieldPounds/60*100)
		item.OverallScore = math.Round((item.BroodScore*0.30+item.Temperament*0.25+
			yieldScore*0.30+item.SurvivalScore*0.15)*10) / 10
		item.BroodScore = math.Round(item.BroodScore*10) / 10
		item.Temperament = math.Round(item.Temperament*10) / 10
		item.YieldPounds = math.Round(item.YieldPounds*10) / 10
		items = append(items, item)
	}

	type lineage struct {
		QueenID      uuid.UUID `json:"queenId"`
		QueenCount   int       `json:"queenCount"`
		AverageScore float64   `json:"averageScore"`
	}
	lineageMap := map[uuid.UUID][]float64{}
	for _, item := range items {
		root := item.ID
		parent := item.ParentQueenID
		visited := map[uuid.UUID]bool{item.ID: true}
		for parent != nil && !visited[*parent] {
			visited[*parent] = true
			root = *parent
			var next *uuid.UUID
			if err := s.pool.QueryRow(r.Context(),
				`SELECT parent_queen_id FROM queens WHERE id=$1`, root).Scan(&next); err != nil {
				break
			}
			parent = next
		}
		lineageMap[root] = append(lineageMap[root], item.OverallScore)
	}
	lineages := []lineage{}
	for root, scores := range lineageMap {
		total := 0.0
		for _, score := range scores {
			total += score
		}
		lineages = append(lineages, lineage{
			QueenID: root, QueenCount: len(scores),
			AverageScore: math.Round(total/float64(len(scores))*10) / 10,
		})
	}
	sort.Slice(lineages, func(i, j int) bool {
		return lineages[i].AverageScore > lineages[j].AverageScore
	})
	writeJSON(w, http.StatusOK, map[string]any{
		"queens": items, "lineages": lineages,
		"weights": map[string]any{
			"brood": 0.30, "temperament": 0.25, "yield": 0.30, "survival": 0.15,
		},
	})
}
