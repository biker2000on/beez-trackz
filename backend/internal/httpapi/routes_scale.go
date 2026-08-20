package httpapi

import (
	"encoding/csv"
	"errors"
	"fmt"
	"io"
	"math"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// Scale hives. Daily weight is the flow and death detector; one scale per
// yard is enough, so the hive link is optional. Ingest is CSV only
// (Broodminder / HiveTracks exports) — deliberately no MQTT.
func (s *Server) mountScale(r chi.Router) {
	r.With(s.requireApiaryParamRole(false)).
		Get("/apiaries/{id}/scales", s.scaleList)
	r.With(s.requireApiaryParamRole(true)).
		Post("/apiaries/{id}/scales", s.scaleCreate)
	r.With(s.requireApiaryParamRole(false)).
		Get("/apiaries/{id}/scale-series", s.scaleSeries)
	r.Post("/scales/{id}/readings", s.scaleReadingsUpload)
	r.Delete("/scales/{id}", s.scaleDelete)
}

const (
	scaleMaxUploadBytes = 8 << 20 // a decade of hourly rows is well under this
	scaleMaxWeightLb    = 2000.0
	scaleSeriesDefault  = 180 // days of history when the caller names no window
	poundsPerKilogram   = 2.2046226218487757
)

func scaleValidVendor(v string) bool {
	switch v {
	case "broodminder", "hivetracks", "other":
		return true
	}
	return false
}

type scaleJSON struct {
	ID           uuid.UUID  `json:"id"`
	ApiaryID     uuid.UUID  `json:"apiaryId"`
	HiveID       *uuid.UUID `json:"hiveId"`
	HiveLabel    *string    `json:"hiveLabel"`
	Name         string     `json:"name"`
	Vendor       string     `json:"vendor"`
	DeviceID     *string    `json:"deviceId"`
	Notes        *string    `json:"notes"`
	ReadingCount int        `json:"readingCount"`
	FirstReading *string    `json:"firstReading"`
	LastReading  *string    `json:"lastReading"`
	LastWeightLb *float64   `json:"lastWeightLb"`
	CreatedAt    time.Time  `json:"createdAt"`
}

// GET /apiaries/{id}/scales
func (s *Server) scaleList(w http.ResponseWriter, r *http.Request) {
	apiaryID, err := uuidParam(r, "id")
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	rows, err := s.pool.Query(r.Context(), `
		SELECT scale.id, scale.apiary_id, scale.hive_id, hive.position_label,
			scale.name, scale.vendor, scale.device_id, scale.notes,
			count(reading.id)::integer, min(reading.reading_date),
			max(reading.reading_date), scale.created_at
		FROM yard_scales scale
		LEFT JOIN hives hive ON hive.id = scale.hive_id
		LEFT JOIN scale_readings reading ON reading.scale_id = scale.id
		WHERE scale.apiary_id = $1
		GROUP BY scale.id, hive.position_label
		ORDER BY scale.name`, apiaryID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	defer rows.Close()
	items := []scaleJSON{}
	for rows.Next() {
		var item scaleJSON
		var first, last *time.Time
		if err := rows.Scan(&item.ID, &item.ApiaryID, &item.HiveID, &item.HiveLabel,
			&item.Name, &item.Vendor, &item.DeviceID, &item.Notes,
			&item.ReadingCount, &first, &last, &item.CreatedAt); err != nil {
			writeError(w, http.StatusInternalServerError, "database error")
			return
		}
		item.FirstReading = bloomDatePtr(first)
		item.LastReading = bloomDatePtr(last)
		items = append(items, item)
	}
	if rows.Err() != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	// The latest weight is a per-scale lookup rather than a window function so
	// the aggregate above stays one plan; a yard has one or two scales.
	for index := range items {
		if items[index].ReadingCount == 0 {
			continue
		}
		var weight float64
		if err := s.pool.QueryRow(r.Context(), `
			SELECT weight_lb FROM scale_readings
			WHERE scale_id = $1 ORDER BY reading_date DESC LIMIT 1`,
			items[index].ID).Scan(&weight); err != nil {
			continue
		}
		items[index].LastWeightLb = &weight
	}
	writeJSON(w, http.StatusOK, items)
}

// POST /apiaries/{id}/scales {name, vendor?, deviceId?, hiveId?, notes?}
func (s *Server) scaleCreate(w http.ResponseWriter, r *http.Request) {
	apiaryID, err := uuidParam(r, "id")
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	var req struct {
		Name     string  `json:"name"`
		Vendor   string  `json:"vendor"`
		DeviceID *string `json:"deviceId"`
		HiveID   *string `json:"hiveId"`
		Notes    *string `json:"notes"`
	}
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	name := strings.TrimSpace(req.Name)
	if name == "" {
		writeError(w, http.StatusBadRequest, "Scale name is required")
		return
	}
	vendor := strings.TrimSpace(strings.ToLower(req.Vendor))
	if vendor == "" {
		vendor = "other"
	}
	if !scaleValidVendor(vendor) {
		writeError(w, http.StatusBadRequest,
			"vendor must be broodminder, hivetracks, or other")
		return
	}
	// A scale belongs to the yard. Naming a hive is a convenience, not a
	// requirement, and the hive has to live in this yard.
	var hiveID *uuid.UUID
	if req.HiveID != nil && strings.TrimSpace(*req.HiveID) != "" {
		parsed, parseErr := uuid.Parse(strings.TrimSpace(*req.HiveID))
		if parseErr != nil {
			writeError(w, http.StatusBadRequest, "invalid hiveId")
			return
		}
		var hiveApiary uuid.UUID
		if err := s.pool.QueryRow(r.Context(),
			`SELECT apiary_id FROM hives WHERE id = $1`, parsed).Scan(&hiveApiary); err != nil {
			writeError(w, http.StatusBadRequest, "Hive not found")
			return
		}
		if hiveApiary != apiaryID {
			writeError(w, http.StatusBadRequest, "Hive is in a different apiary")
			return
		}
		hiveID = &parsed
	}
	user := principalFrom(r)
	var id uuid.UUID
	err = s.pool.QueryRow(r.Context(), `
		INSERT INTO yard_scales (apiary_id, hive_id, name, vendor, device_id, notes, created_by)
		VALUES ($1, $2, $3, $4, $5, $6, $7)
		RETURNING id`,
		apiaryID, hiveID, name, vendor, inspectionTrimPtr(req.DeviceID),
		inspectionTrimPtr(req.Notes), user.ID).Scan(&id)
	if err != nil {
		if pgErrCode(err) == "23505" {
			writeError(w, http.StatusConflict,
				"A scale with that name already exists in this apiary")
			return
		}
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"id": id, "success": true})
}

// scaleApiary resolves the yard a scale belongs to for authorization.
func (s *Server) scaleApiary(r *http.Request, scaleID uuid.UUID) (uuid.UUID, error) {
	var apiaryID uuid.UUID
	err := s.pool.QueryRow(r.Context(),
		`SELECT apiary_id FROM yard_scales WHERE id = $1`, scaleID).Scan(&apiaryID)
	return apiaryID, err
}

// DELETE /scales/{id} — readings go with it (they are the device's, not the
// yard's, history).
func (s *Server) scaleDelete(w http.ResponseWriter, r *http.Request) {
	id, err := uuidParam(r, "id")
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	apiaryID, err := s.scaleApiary(r, id)
	if errors.Is(err, pgx.ErrNoRows) {
		writeError(w, http.StatusNotFound, "scale not found")
		return
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	if !s.requireApiaryRole(w, r, apiaryID, true) {
		return
	}
	if _, err := s.pool.Exec(r.Context(),
		`DELETE FROM yard_scales WHERE id = $1`, id); err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"success": true})
}

// --- CSV ingest ------------------------------------------------------------

// scaleDayReading is one calendar day distilled from however many rows the
// export carried for it.
type scaleDayReading struct {
	Date        string   `json:"date"`
	WeightLb    float64  `json:"weightLb"`
	MinLb       float64  `json:"minLb"`
	MaxLb       float64  `json:"maxLb"`
	Temperature *float64 `json:"temperatureF"`
	Humidity    *float64 `json:"humidityPct"`
	Samples     int      `json:"samples"`
}

type scaleParseResult struct {
	Days        []scaleDayReading
	RowsParsed  int
	RowsSkipped int
	WeightUnit  string
}

// scaleColumnIndex finds the column whose header contains any of the needles.
func scaleColumnIndex(header []string, needles ...string) int {
	for index, name := range header {
		lower := strings.ToLower(strings.TrimSpace(name))
		for _, needle := range needles {
			if strings.Contains(lower, needle) {
				return index
			}
		}
	}
	return -1
}

// scaleUnitFromHeader reads the unit out of a column label such as
// "Weight (kg)" or "Weight lbs". Returns "" when the label does not say.
func scaleUnitFromHeader(label string) string {
	lower := strings.ToLower(label)
	switch {
	case strings.Contains(lower, "kg"), strings.Contains(lower, "kilogram"):
		return "kg"
	case strings.Contains(lower, "lb"), strings.Contains(lower, "pound"):
		return "lb"
	default:
		return ""
	}
}

var scaleDateLayouts = []string{
	time.RFC3339,
	"2006-01-02T15:04:05",
	"2006-01-02 15:04:05",
	"2006-01-02 15:04",
	"2006-01-02",
	"01/02/2006 15:04:05",
	"01/02/2006 15:04",
	"01/02/2006",
	"1/2/2006 15:04",
	"1/2/2006",
	"02.01.2006",
}

// scaleParseDate keeps only the calendar day: a scale row is a weight at a
// place on a date, and the export's clock time is not worth a timezone guess.
func scaleParseDate(raw string) (string, bool) {
	text := strings.TrimSpace(strings.Trim(raw, `"'`))
	if text == "" {
		return "", false
	}
	for _, layout := range scaleDateLayouts {
		if parsed, err := time.ParseInLocation(layout, text, time.Local); err == nil {
			return parsed.Format("2006-01-02"), true
		}
	}
	return "", false
}

func scaleParseFloat(raw string) (float64, bool) {
	text := strings.TrimSpace(strings.Trim(raw, `"'`))
	if text == "" {
		return 0, false
	}
	// Broodminder exports occasionally carry a unit suffix in the cell.
	text = strings.TrimSuffix(text, "%")
	for _, suffix := range []string{"lbs", "lb", "kg", "°F", "°C", "F", "C"} {
		text = strings.TrimSpace(strings.TrimSuffix(strings.TrimSpace(text), suffix))
	}
	value, err := strconv.ParseFloat(text, 64)
	if err != nil || math.IsNaN(value) || math.IsInf(value, 0) {
		return 0, false
	}
	return value, true
}

type scaleDayAccumulator struct {
	sum     float64
	min     float64
	max     float64
	tempSum float64
	tempN   int
	humSum  float64
	humN    int
	samples int
}

// parseScaleCSV reads a Broodminder / HiveTracks-style export into daily
// weights. The header names the columns; the weight unit comes from the
// header when it says, and from defaultUnit otherwise. Rows that do not parse
// are counted and skipped rather than failing an otherwise good file — a
// device export routinely carries blank or diagnostic rows.
func parseScaleCSV(reader io.Reader, defaultUnit string) (scaleParseResult, error) {
	result := scaleParseResult{Days: []scaleDayReading{}, WeightUnit: "lb"}
	parser := csv.NewReader(reader)
	parser.FieldsPerRecord = -1
	parser.TrimLeadingSpace = true
	parser.LazyQuotes = true

	var dateCol, weightCol, tempCol, humidityCol int
	var tempCelsius bool
	toPounds := 1.0
	header := false
	accumulators := map[string]*scaleDayAccumulator{}
	order := []string{}

	for {
		record, err := parser.Read()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			// A malformed line is a skipped row, not a rejected upload.
			result.RowsSkipped++
			continue
		}
		if !header {
			dateCol = scaleColumnIndex(record, "date", "timestamp", "time")
			weightCol = scaleColumnIndex(record, "weight", "mass")
			if dateCol < 0 || weightCol < 0 {
				// Not the header yet (device exports prepend metadata lines).
				continue
			}
			header = true
			tempCol = scaleColumnIndex(record, "temp")
			humidityCol = scaleColumnIndex(record, "humid")
			unit := scaleUnitFromHeader(record[weightCol])
			if unit == "" {
				unit = defaultUnit
			}
			if unit == "kg" {
				toPounds = poundsPerKilogram
				result.WeightUnit = "kg"
			}
			if tempCol >= 0 {
				label := strings.ToLower(record[tempCol])
				tempCelsius = strings.Contains(label, "c)") ||
					strings.Contains(label, "celsius") ||
					strings.Contains(label, "°c")
			}
			continue
		}
		if dateCol >= len(record) || weightCol >= len(record) {
			result.RowsSkipped++
			continue
		}
		date, ok := scaleParseDate(record[dateCol])
		if !ok {
			result.RowsSkipped++
			continue
		}
		raw, ok := scaleParseFloat(record[weightCol])
		if !ok {
			result.RowsSkipped++
			continue
		}
		weight := raw * toPounds
		if weight < 0 || weight > scaleMaxWeightLb {
			result.RowsSkipped++
			continue
		}
		result.RowsParsed++
		day := accumulators[date]
		if day == nil {
			day = &scaleDayAccumulator{min: weight, max: weight}
			accumulators[date] = day
			order = append(order, date)
		}
		day.sum += weight
		day.samples++
		if weight < day.min {
			day.min = weight
		}
		if weight > day.max {
			day.max = weight
		}
		if tempCol >= 0 && tempCol < len(record) {
			if value, ok := scaleParseFloat(record[tempCol]); ok {
				if tempCelsius {
					value = value*9/5 + 32
				}
				day.tempSum += value
				day.tempN++
			}
		}
		if humidityCol >= 0 && humidityCol < len(record) {
			if value, ok := scaleParseFloat(record[humidityCol]); ok &&
				value >= 0 && value <= 100 {
				day.humSum += value
				day.humN++
			}
		}
	}
	if !header {
		return result, errors.New("no date and weight columns found in the CSV header")
	}
	sort.Strings(order)
	for _, date := range order {
		day := accumulators[date]
		reading := scaleDayReading{
			Date:     date,
			WeightLb: round3(day.sum / float64(day.samples)),
			MinLb:    round3(day.min),
			MaxLb:    round3(day.max),
			Samples:  day.samples,
		}
		if day.tempN > 0 {
			value := round2(day.tempSum / float64(day.tempN))
			reading.Temperature = &value
		}
		if day.humN > 0 {
			value := round2(day.humSum / float64(day.humN))
			reading.Humidity = &value
		}
		result.Days = append(result.Days, reading)
	}
	return result, nil
}

func round2(v float64) float64 { return math.Round(v*100) / 100 }
func round3(v float64) float64 { return math.Round(v*1000) / 1000 }

// POST /scales/{id}/readings — multipart CSV upload (field "file", optional
// "weightUnit" of lb or kg for exports whose header does not say). Re-running
// the same file is a no-op: a day upserts on (scale, date).
func (s *Server) scaleReadingsUpload(w http.ResponseWriter, r *http.Request) {
	id, err := uuidParam(r, "id")
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	apiaryID, err := s.scaleApiary(r, id)
	if errors.Is(err, pgx.ErrNoRows) {
		writeError(w, http.StatusNotFound, "scale not found")
		return
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	if !s.requireApiaryRole(w, r, apiaryID, true) {
		return
	}

	r.Body = http.MaxBytesReader(w, r.Body, scaleMaxUploadBytes+(1<<20))
	if err := r.ParseMultipartForm(scaleMaxUploadBytes); err != nil {
		var maxErr *http.MaxBytesError
		if errors.As(err, &maxErr) {
			writeError(w, http.StatusBadRequest, "CSV must be under 8MB")
			return
		}
		writeError(w, http.StatusBadRequest, "invalid multipart form")
		return
	}
	file, header, err := r.FormFile("file")
	if err != nil {
		writeError(w, http.StatusBadRequest, "CSV file is required")
		return
	}
	defer file.Close()
	if header.Size == 0 {
		writeError(w, http.StatusBadRequest, "CSV file is required")
		return
	}
	defaultUnit := strings.ToLower(strings.TrimSpace(r.FormValue("weightUnit")))
	switch defaultUnit {
	case "", "lb", "lbs", "pounds":
		defaultUnit = "lb"
	case "kg", "kilograms":
		defaultUnit = "kg"
	default:
		writeError(w, http.StatusBadRequest, "weightUnit must be lb or kg")
		return
	}

	parsed, err := parseScaleCSV(io.LimitReader(file, scaleMaxUploadBytes), defaultUnit)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	if len(parsed.Days) == 0 {
		writeError(w, http.StatusBadRequest,
			"No usable rows in this CSV — expected a date column and a weight column")
		return
	}

	sourceFile := strings.TrimSpace(header.Filename)
	if sourceFile == "" {
		sourceFile = "upload.csv"
	}
	tx, err := s.pool.Begin(r.Context())
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()
	for _, day := range parsed.Days {
		date, dateErr := parseDate(day.Date)
		if dateErr != nil {
			continue
		}
		if _, err := tx.Exec(r.Context(), `
			INSERT INTO scale_readings (scale_id, reading_date, weight_lb,
				weight_min_lb, weight_max_lb, temperature_f, humidity_pct,
				sample_count, source_file)
			VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
			ON CONFLICT (scale_id, reading_date) DO UPDATE SET
				weight_lb = EXCLUDED.weight_lb,
				weight_min_lb = EXCLUDED.weight_min_lb,
				weight_max_lb = EXCLUDED.weight_max_lb,
				temperature_f = EXCLUDED.temperature_f,
				humidity_pct = EXCLUDED.humidity_pct,
				sample_count = EXCLUDED.sample_count,
				source_file = EXCLUDED.source_file,
				imported_at = now()`,
			id, date, day.WeightLb, day.MinLb, day.MaxLb, day.Temperature,
			day.Humidity, day.Samples, sourceFile); err != nil {
			writeError(w, http.StatusInternalServerError, "database error")
			return
		}
	}
	if err := tx.Commit(r.Context()); err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"scaleId": id, "sourceFile": sourceFile, "weightUnit": parsed.WeightUnit,
		"rowsParsed": parsed.RowsParsed, "rowsSkipped": parsed.RowsSkipped,
		"daysStored": len(parsed.Days),
		"firstDate":  parsed.Days[0].Date,
		"lastDate":   parsed.Days[len(parsed.Days)-1].Date,
	})
}

// --- series for the overlay chart ------------------------------------------

type scalePointJSON struct {
	Date        string   `json:"date"`
	WeightLb    float64  `json:"weightLb"`
	MinLb       *float64 `json:"minLb"`
	MaxLb       *float64 `json:"maxLb"`
	ChangeLb    *float64 `json:"changeLb"`
	Temperature *float64 `json:"temperatureF"`
}

type scaleSeriesJSON struct {
	ScaleID   uuid.UUID        `json:"scaleId"`
	Name      string           `json:"name"`
	Vendor    string           `json:"vendor"`
	HiveID    *uuid.UUID       `json:"hiveId"`
	HiveLabel *string          `json:"hiveLabel"`
	Points    []scalePointJSON `json:"points"`
	// The last day read the way the yard reads it: gained, lost, or flat.
	Summary string `json:"latestSummary"`
}

type scaleBloomMarker struct {
	Species   string  `json:"species"`
	Band      *string `json:"elevationBand"`
	FirstSeen string  `json:"firstSeen"`
	LastSeen  *string `json:"lastSeen"`
}

type scaleInspectionMarker struct {
	Date      string `json:"date"`
	HiveLabel string `json:"hiveLabel"`
}

// GET /apiaries/{id}/scale-series?from=YYYY-MM-DD&to=YYYY-MM-DD
//
// The daily weight curve plus the bloom windows and inspection dates that
// explain it — one fetch so the chart overlays without racing three queries.
func (s *Server) scaleSeries(w http.ResponseWriter, r *http.Request) {
	apiaryID, err := uuidParam(r, "id")
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	to := time.Now()
	if raw := strings.TrimSpace(r.URL.Query().Get("to")); raw != "" {
		parsed, parseErr := parseDate(raw)
		if parseErr != nil {
			writeError(w, http.StatusBadRequest, "invalid to date")
			return
		}
		to = parsed
	}
	from := to.AddDate(0, 0, -scaleSeriesDefault)
	if raw := strings.TrimSpace(r.URL.Query().Get("from")); raw != "" {
		parsed, parseErr := parseDate(raw)
		if parseErr != nil {
			writeError(w, http.StatusBadRequest, "invalid from date")
			return
		}
		from = parsed
	}
	if from.After(to) {
		writeError(w, http.StatusBadRequest, "from must be on or before to")
		return
	}

	rows, err := s.pool.Query(r.Context(), `
		SELECT scale.id, scale.name, scale.vendor, scale.hive_id, hive.position_label,
			reading.reading_date, reading.weight_lb, reading.weight_min_lb,
			reading.weight_max_lb, reading.temperature_f
		FROM yard_scales scale
		LEFT JOIN hives hive ON hive.id = scale.hive_id
		LEFT JOIN scale_readings reading ON reading.scale_id = scale.id
			AND reading.reading_date BETWEEN $2 AND $3
		WHERE scale.apiary_id = $1
		ORDER BY scale.name, reading.reading_date`, apiaryID, from, to)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	defer rows.Close()
	series := []scaleSeriesJSON{}
	index := map[uuid.UUID]int{}
	for rows.Next() {
		var scaleID uuid.UUID
		var name, vendor string
		var hiveID *uuid.UUID
		var hiveLabel *string
		var date *time.Time
		var weight, minLb, maxLb, temperature *float64
		if err := rows.Scan(&scaleID, &name, &vendor, &hiveID, &hiveLabel,
			&date, &weight, &minLb, &maxLb, &temperature); err != nil {
			writeError(w, http.StatusInternalServerError, "database error")
			return
		}
		position, ok := index[scaleID]
		if !ok {
			series = append(series, scaleSeriesJSON{
				ScaleID: scaleID, Name: name, Vendor: vendor, HiveID: hiveID,
				HiveLabel: hiveLabel, Points: []scalePointJSON{},
			})
			position = len(series) - 1
			index[scaleID] = position
		}
		if date == nil || weight == nil {
			continue
		}
		point := scalePointJSON{
			Date: bloomDate(*date), WeightLb: *weight, MinLb: minLb, MaxLb: maxLb,
			Temperature: temperature,
		}
		// Day-over-day change is what reads as a flow or a robbing event; it
		// is only meaningful against the previous stored day.
		if previous := series[position].Points; len(previous) > 0 {
			change := round3(point.WeightLb - previous[len(previous)-1].WeightLb)
			point.ChangeLb = &change
		}
		series[position].Points = append(series[position].Points, point)
	}
	if rows.Err() != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	for index := range series {
		points := series[index].Points
		if len(points) == 0 {
			series[index].Summary = "No readings in this window."
			continue
		}
		series[index].Summary = scaleWeightSummary(points[len(points)-1].ChangeLb)
	}

	blooms, err := s.scaleBloomMarkers(r, apiaryID, from, to)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	inspections, err := s.scaleInspectionMarkers(r, apiaryID, from, to)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"apiaryId": apiaryID,
		"from":     bloomDate(from), "to": bloomDate(to),
		"scales": series, "blooms": blooms, "inspections": inspections,
	})
}

func (s *Server) scaleBloomMarkers(
	r *http.Request,
	apiaryID uuid.UUID,
	from, to time.Time,
) ([]scaleBloomMarker, error) {
	rows, err := s.pool.Query(r.Context(), `
		SELECT species, elevation_band, date_first_seen, date_last_seen
		FROM bloom_observations
		WHERE apiary_id = $1 AND date_first_seen <= $3
			AND (date_last_seen IS NULL OR date_last_seen >= $2)
		ORDER BY date_first_seen`, apiaryID, from, to)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := []scaleBloomMarker{}
	for rows.Next() {
		var item scaleBloomMarker
		var first time.Time
		var last *time.Time
		if err := rows.Scan(&item.Species, &item.Band, &first, &last); err != nil {
			return nil, err
		}
		item.FirstSeen = bloomDate(first)
		item.LastSeen = bloomDatePtr(last)
		items = append(items, item)
	}
	return items, rows.Err()
}

func (s *Server) scaleInspectionMarkers(
	r *http.Request,
	apiaryID uuid.UUID,
	from, to time.Time,
) ([]scaleInspectionMarker, error) {
	rows, err := s.pool.Query(r.Context(), `
		SELECT inspection.date, hive.position_label
		FROM inspections inspection
		JOIN hives hive ON hive.id = inspection.hive_id
		WHERE hive.apiary_id = $1 AND inspection.date >= $2
			AND inspection.date < ($3::date + 1)
		ORDER BY inspection.date`, apiaryID, from, to)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := []scaleInspectionMarker{}
	for rows.Next() {
		var date time.Time
		var label string
		if err := rows.Scan(&date, &label); err != nil {
			return nil, err
		}
		items = append(items, scaleInspectionMarker{
			Date: bloomDate(date), HiveLabel: label,
		})
	}
	return items, rows.Err()
}

// scaleWeightSummary renders a day-over-day change the way the yard reads it.
// Kept next to the ingest so the wording lives with the numbers it describes.
func scaleWeightSummary(change *float64) string {
	if change == nil {
		return "No previous day to compare."
	}
	switch {
	case *change > 0.5:
		return fmt.Sprintf("Gained %.1f lb since the previous day.", *change)
	case *change < -0.5:
		return fmt.Sprintf("Lost %.1f lb since the previous day.", -*change)
	default:
		return "Flat since the previous day."
	}
}
