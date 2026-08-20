package httpapi

import (
	"errors"
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

// mountBloom wires the bloom-observation endpoints.
func (s *Server) mountBloom(r chi.Router) {
	r.Post("/bloom-observations", s.handleBloomCreate)
	r.Get("/bloom-observations/species", s.handleBloomSpecies)
	r.With(s.requireEntityParamRole("bloom", true)).
		Post("/bloom-observations/{id}/end", s.handleBloomEnd)
	r.With(s.requireEntityParamRole("bloom", true)).
		Delete("/bloom-observations/{id}", s.handleBloomDelete)
	r.With(s.requireApiaryParamRole(false)).
		Get("/apiaries/{id}/blooms", s.handleBloomsForApiary)
	// Place and flow: species x elevation band x last year's window.
	r.Get("/bloom-observations/elevation-bands", s.handleBloomBands)
	r.With(s.requireApiaryParamRole(false)).
		Get("/apiaries/{id}/flow-calendar", s.handleFlowCalendar)
}

// --- elevation bands -------------------------------------------------------

// elevationBandDef is one rung of the band ladder. Bands are a filter on
// bloom, not a species model: every observation stores the metres it was seen
// at and the band is a generated column over those metres (migration 00027),
// so these bounds and the database CASE must stay in step.
type elevationBandDef struct {
	ID    string   `json:"id"`
	Label string   `json:"label"`
	MinM  *float64 `json:"minM"`
	MaxM  *float64 `json:"maxM"`
}

func bandBound(v float64) *float64 { return &v }

var elevationBandDefs = []elevationBandDef{
	{ID: "valley", Label: "Valley", MinM: nil, MaxM: bandBound(300)},
	{ID: "foothill", Label: "Foothill", MinM: bandBound(300), MaxM: bandBound(700)},
	{ID: "midslope", Label: "Midslope", MinM: bandBound(700), MaxM: bandBound(1100)},
	{ID: "ridge", Label: "Ridge", MinM: bandBound(1100), MaxM: bandBound(1600)},
	{ID: "summit", Label: "Summit", MinM: bandBound(1600), MaxM: nil},
}

// bloomBandFor mirrors the generated column so Go can label a yard's pin
// without a round trip. Nil metres stay nil — never invent a band.
func bloomBandFor(meters *float64) *string {
	if meters == nil || math.IsNaN(*meters) || math.IsInf(*meters, 0) {
		return nil
	}
	for _, band := range elevationBandDefs {
		if band.MaxM == nil || *meters < *band.MaxM {
			id := band.ID
			return &id
		}
	}
	return nil
}

func bloomBandValid(id string) bool {
	for _, band := range elevationBandDefs {
		if band.ID == id {
			return true
		}
	}
	return false
}

func bloomBandLabel(id *string) string {
	if id == nil {
		return "No elevation recorded"
	}
	for _, band := range elevationBandDefs {
		if band.ID == *id {
			return band.Label
		}
	}
	return *id
}

// GET /bloom-observations/elevation-bands — the band ladder for filters.
func (s *Server) handleBloomBands(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, elevationBandDefs)
}

// bloomDate formats a Postgres `date` column as YYYY-MM-DD (legacy shape).
func bloomDate(t time.Time) string {
	return t.Format("2006-01-02")
}

func bloomDatePtr(t *time.Time) *string {
	if t == nil {
		return nil
	}
	s := bloomDate(*t)
	return &s
}

type bloomJSON struct {
	ID            uuid.UUID `json:"id"`
	ApiaryID      uuid.UUID `json:"apiaryId"`
	Species       string    `json:"species"`
	DateFirstSeen string    `json:"dateFirstSeen"`
	DateLastSeen  *string   `json:"dateLastSeen"`
	Year          int       `json:"year"`
	Abundance     *int      `json:"abundance"`
	Notes         *string   `json:"notes"`
	ElevationM    *float64  `json:"elevationM"`
	ElevationBand *string   `json:"elevationBand"`
	BandLabel     string    `json:"elevationBandLabel"`
	CreatedAt     time.Time `json:"createdAt"`
}

const bloomSelectCols = `id, apiary_id, species, date_first_seen, date_last_seen,
	year, abundance, notes, elevation_m, elevation_band, created_at`

func bloomScan(row pgx.Row) (bloomJSON, error) {
	var v bloomJSON
	var firstSeen time.Time
	var lastSeen *time.Time
	err := row.Scan(&v.ID, &v.ApiaryID, &v.Species, &firstSeen, &lastSeen,
		&v.Year, &v.Abundance, &v.Notes, &v.ElevationM, &v.ElevationBand,
		&v.CreatedAt)
	if err != nil {
		return v, err
	}
	v.DateFirstSeen = bloomDate(firstSeen)
	v.DateLastSeen = bloomDatePtr(lastSeen)
	v.BandLabel = bloomBandLabel(v.ElevationBand)
	return v, nil
}

// POST /bloom-observations
func (s *Server) handleBloomCreate(w http.ResponseWriter, r *http.Request) {
	var req struct {
		ApiaryID      string   `json:"apiaryId"`
		Species       string   `json:"species"`
		DateFirstSeen string   `json:"dateFirstSeen"`
		Abundance     *int     `json:"abundance"`
		Notes         *string  `json:"notes"`
		ElevationM    *float64 `json:"elevationM"`
	}
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	species := strings.TrimSpace(req.Species)
	if req.ApiaryID == "" || species == "" || strings.TrimSpace(req.DateFirstSeen) == "" {
		writeError(w, http.StatusBadRequest, "Apiary, species, and date are required")
		return
	}
	apiaryID, err := uuid.Parse(req.ApiaryID)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid apiaryId")
		return
	}
	if !s.requireApiaryRole(w, r, apiaryID, true) {
		return
	}
	firstSeen, err := parseDate(req.DateFirstSeen)
	if err != nil {
		writeError(w, http.StatusBadRequest, "Invalid date")
		return
	}
	// Elevation-banded flora: the observation records the height it was seen
	// at. An operator value wins; otherwise the yard's pin supplies it. A yard
	// with no pin elevation records no band rather than an invented one.
	elevation := req.ElevationM
	if elevation != nil &&
		(math.IsNaN(*elevation) || math.IsInf(*elevation, 0) ||
			*elevation < -500 || *elevation > 9000) {
		writeError(w, http.StatusBadRequest,
			"elevation must be between -500 and 9000 meters")
		return
	}
	if elevation == nil {
		var pinElevation *float64
		if err := s.pool.QueryRow(r.Context(),
			`SELECT elevation_m FROM apiaries WHERE id = $1`, apiaryID).
			Scan(&pinElevation); err != nil && !errors.Is(err, pgx.ErrNoRows) {
			writeError(w, http.StatusInternalServerError, "database error")
			return
		}
		elevation = pinElevation
	}
	var id uuid.UUID
	err = s.pool.QueryRow(r.Context(), `
		INSERT INTO bloom_observations
			(apiary_id, species, date_first_seen, year, abundance, notes, elevation_m)
		VALUES ($1, $2, $3, $4, $5, $6, $7)
		RETURNING id`,
		apiaryID, species, firstSeen, firstSeen.Year(), clampRating(req.Abundance),
		inspectionTrimPtr(req.Notes), elevation).Scan(&id)
	if err != nil {
		if inspectionIsFKViolation(err) {
			writeError(w, http.StatusBadRequest, "Apiary not found")
			return
		}
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	created, err := bloomScan(s.pool.QueryRow(r.Context(),
		`SELECT `+bloomSelectCols+` FROM bloom_observations WHERE id = $1`, id))
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	writeJSON(w, http.StatusCreated, created)
}

// GET /apiaries/{id}/blooms?filter=active|history&band=<elevation band>
func (s *Server) handleBloomsForApiary(w http.ResponseWriter, r *http.Request) {
	apiaryID, err := uuidParam(r, "id")
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	// The band is a filter on bloom. "none" asks for the rows recorded before
	// a pin elevation existed; an empty band means every row.
	var band *string
	switch raw := strings.TrimSpace(r.URL.Query().Get("band")); raw {
	case "":
	case "none":
		empty := ""
		band = &empty
	default:
		if !bloomBandValid(raw) {
			writeError(w, http.StatusBadRequest, "unknown elevation band")
			return
		}
		band = &raw
	}
	bandClause := ``
	if band != nil {
		if *band == "" {
			bandClause = ` AND elevation_band IS NULL`
		} else {
			bandClause = ` AND elevation_band = $2`
		}
	}
	var query string
	switch filter := r.URL.Query().Get("filter"); filter {
	case "", "active":
		query = `SELECT ` + bloomSelectCols + ` FROM bloom_observations
			WHERE apiary_id = $1 AND date_last_seen IS NULL` + bandClause + `
			ORDER BY date_first_seen DESC`
	case "history":
		query = `SELECT ` + bloomSelectCols + ` FROM bloom_observations
			WHERE apiary_id = $1` + bandClause + `
			ORDER BY year DESC, date_first_seen DESC`
	default:
		writeError(w, http.StatusBadRequest, "filter must be active or history")
		return
	}
	args := []any{apiaryID}
	if band != nil && *band != "" {
		args = append(args, *band)
	}
	rows, err := s.pool.Query(r.Context(), query, args...)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	defer rows.Close()
	list := []bloomJSON{}
	for rows.Next() {
		v, err := bloomScan(rows)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "database error")
			return
		}
		list = append(list, v)
	}
	if rows.Err() != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	writeJSON(w, http.StatusOK, list)
}

// POST /bloom-observations/{id}/end — date_last_seen = today (date-only).
func (s *Server) handleBloomEnd(w http.ResponseWriter, r *http.Request) {
	id, err := uuidParam(r, "id")
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	tag, err := s.pool.Exec(r.Context(),
		`UPDATE bloom_observations SET date_last_seen = CURRENT_DATE WHERE id = $1`, id)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	if tag.RowsAffected() == 0 {
		writeError(w, http.StatusNotFound, "Bloom observation not found")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"success": true})
}

// DELETE /bloom-observations/{id}
func (s *Server) handleBloomDelete(w http.ResponseWriter, r *http.Request) {
	id, err := uuidParam(r, "id")
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	tag, err := s.pool.Exec(r.Context(), `DELETE FROM bloom_observations WHERE id = $1`, id)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	if tag.RowsAffected() == 0 {
		writeError(w, http.StatusNotFound, "Bloom observation not found")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"success": true})
}

// GET /bloom-observations/species — distinct species, most recently seen first
// (autocomplete source).
func (s *Server) handleBloomSpecies(w http.ResponseWriter, r *http.Request) {
	rows, err := s.pool.Query(r.Context(), `
		SELECT observation.species FROM bloom_observations observation
		JOIN apiaries apiary ON apiary.id=observation.apiary_id
		WHERE ($1::boolean OR EXISTS (
			SELECT 1 FROM apiary_memberships membership
			WHERE membership.user_id=$2 AND membership.apiary_id=apiary.id
		))
		GROUP BY observation.species
		ORDER BY max(observation.date_first_seen) DESC`,
		principalFrom(r).IsAdmin, principalFrom(r).ID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	defer rows.Close()
	list := []string{}
	for rows.Next() {
		var sp string
		if err := rows.Scan(&sp); err != nil {
			writeError(w, http.StatusInternalServerError, "database error")
			return
		}
		list = append(list, sp)
	}
	if rows.Err() != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	writeJSON(w, http.StatusOK, list)
}

// --- per-yard flow calendar ------------------------------------------------

// flowSeasonJSON is one species' window in one year, aggregated over every
// observation in scope (this yard, or every yard in the same elevation band).
type flowSeasonJSON struct {
	Year         int     `json:"year"`
	FirstSeen    string  `json:"firstSeen"`
	LastSeen     *string `json:"lastSeen"`
	Days         *int    `json:"days"`
	Abundance    *int    `json:"abundance"`
	Observations int     `json:"observations"`
	AtThisYard   int     `json:"atThisYard"`
	Yards        int     `json:"yards"`
	Ongoing      bool    `json:"ongoing"`
}

// flowCalendarRow answers "will this yard make sourwood this year" for one
// species at one band: last year's window, what has been seen this year, and
// where today sits against the two.
type flowCalendarRow struct {
	Species       string           `json:"species"`
	ElevationBand *string          `json:"elevationBand"`
	BandLabel     string           `json:"elevationBandLabel"`
	Reference     *flowSeasonJSON  `json:"reference"`
	Current       *flowSeasonJSON  `json:"current"`
	Seasons       []flowSeasonJSON `json:"seasons"`
	ExpectedFirst *string          `json:"expectedFirstSeen"`
	ExpectedLast  *string          `json:"expectedLastSeen"`
	Status        string           `json:"status"`
	DaysUntil     *int             `json:"daysUntil"`
	YearsObserved int              `json:"yearsObserved"`
	AtThisYard    int              `json:"atThisYard"`
}

type flowSeasonKey struct {
	species string
	band    string
	hasBand bool
	year    int
}

// flowDayOfYear compares two dates by position in the season without caring
// which year they were stamped with.
func flowDayOfYear(t time.Time) int {
	return int(t.Month())*32 + t.Day()
}

func flowDateInYear(month time.Month, day, year int) time.Time {
	return time.Date(year, month, day, 12, 0, 0, 0, time.Local)
}

// flowMeanDate averages a set of dates by day-of-year so "typically the second
// week of June" survives a yard with three years of records.
func flowMeanDate(dates []time.Time, year int) *time.Time {
	if len(dates) == 0 {
		return nil
	}
	total := 0
	for _, d := range dates {
		total += d.YearDay()
	}
	mean := int(math.Round(float64(total) / float64(len(dates))))
	value := time.Date(year, 1, 1, 12, 0, 0, 0, time.Local).AddDate(0, 0, mean-1)
	return &value
}

// GET /apiaries/{id}/flow-calendar?scope=band|yard&year=2026
//
// Species x elevation band x last year's first/last seen. The default scope is
// this yard's band across every apiary the caller can see, because one yard
// rarely has enough years of its own to answer the question; scope=yard
// narrows to this yard's rows only. A yard with no pin elevation has no band
// to widen to and falls back to yard scope.
func (s *Server) handleFlowCalendar(w http.ResponseWriter, r *http.Request) {
	apiaryID, err := uuidParam(r, "id")
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	var elevation *float64
	var radius int
	if err := s.pool.QueryRow(r.Context(),
		`SELECT elevation_m, forage_radius_m FROM apiaries WHERE id = $1`, apiaryID).
		Scan(&elevation, &radius); errors.Is(err, pgx.ErrNoRows) {
		writeError(w, http.StatusNotFound, "apiary not found")
		return
	} else if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	band := bloomBandFor(elevation)

	year := time.Now().Year()
	if raw := strings.TrimSpace(r.URL.Query().Get("year")); raw != "" {
		parsed, parseErr := strconv.Atoi(raw)
		if parseErr != nil || parsed < 1900 || parsed > 2200 {
			writeError(w, http.StatusBadRequest, "year must be between 1900 and 2200")
			return
		}
		year = parsed
	}
	scope := strings.TrimSpace(r.URL.Query().Get("scope"))
	switch scope {
	case "", "band":
		scope = "band"
	case "yard":
	default:
		writeError(w, http.StatusBadRequest, "scope must be band or yard")
		return
	}
	if scope == "band" && band == nil {
		scope = "yard"
	}
	yardOnly := scope == "yard"

	user := principalFrom(r)
	rows, err := s.pool.Query(r.Context(), `
		SELECT observation.species, observation.elevation_band, observation.year,
			min(observation.date_first_seen), max(observation.date_last_seen),
			max(observation.abundance), count(*)::integer,
			count(*) FILTER (WHERE observation.apiary_id = $1)::integer,
			count(DISTINCT observation.apiary_id)::integer,
			count(*) FILTER (WHERE observation.date_last_seen IS NULL)::integer
		FROM bloom_observations observation
		JOIN apiaries apiary ON apiary.id = observation.apiary_id
		WHERE ($2::boolean OR EXISTS (
				SELECT 1 FROM apiary_memberships membership
				WHERE membership.apiary_id = apiary.id AND membership.user_id = $3
			))
			AND (NOT $4::boolean OR observation.apiary_id = $1)
			AND ($4::boolean OR observation.elevation_band = $5)
			AND observation.year <= $6
		GROUP BY observation.species, observation.elevation_band, observation.year`,
		apiaryID, user.IsAdmin, user.ID, yardOnly, band, year)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	defer rows.Close()

	seasons := map[flowSeasonKey]flowSeasonJSON{}
	firstDates := map[flowSeasonKey][]time.Time{}
	lastDates := map[flowSeasonKey][]time.Time{}
	for rows.Next() {
		var species string
		var rowBand *string
		var rowYear int
		var first time.Time
		var last *time.Time
		var abundance *int
		var observations, atYard, yards, ongoing int
		if err := rows.Scan(&species, &rowBand, &rowYear, &first, &last, &abundance,
			&observations, &atYard, &yards, &ongoing); err != nil {
			writeError(w, http.StatusInternalServerError, "database error")
			return
		}
		key := flowSeasonKey{species: species, year: rowYear}
		if rowBand != nil {
			key.band, key.hasBand = *rowBand, true
		}
		season := flowSeasonJSON{
			Year: rowYear, FirstSeen: bloomDate(first), LastSeen: bloomDatePtr(last),
			Abundance: abundance, Observations: observations, AtThisYard: atYard,
			Yards: yards, Ongoing: ongoing > 0,
		}
		if last != nil && ongoing == 0 {
			days := int(last.Sub(first).Hours()/24) + 1
			season.Days = &days
		}
		seasons[key] = season
		firstDates[key] = append(firstDates[key], first)
		if last != nil {
			lastDates[key] = append(lastDates[key], *last)
		}
	}
	if rows.Err() != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}

	type rowKey struct {
		species string
		band    string
		hasBand bool
	}
	grouped := map[rowKey][]flowSeasonJSON{}
	groupFirst := map[rowKey][]time.Time{}
	groupLast := map[rowKey][]time.Time{}
	for key, season := range seasons {
		gk := rowKey{species: key.species, band: key.band, hasBand: key.hasBand}
		grouped[gk] = append(grouped[gk], season)
		groupFirst[gk] = append(groupFirst[gk], firstDates[key]...)
		groupLast[gk] = append(groupLast[gk], lastDates[key]...)
	}

	today := time.Now()
	items := []flowCalendarRow{}
	for gk, list := range grouped {
		sort.Slice(list, func(i, j int) bool { return list[i].Year > list[j].Year })
		item := flowCalendarRow{
			Species: gk.species, Seasons: list, YearsObserved: len(list),
		}
		if gk.hasBand {
			value := gk.band
			item.ElevationBand = &value
		}
		item.BandLabel = bloomBandLabel(item.ElevationBand)
		for index := range list {
			item.AtThisYard += list[index].AtThisYard
			switch {
			case list[index].Year == year:
				current := list[index]
				item.Current = &current
			case list[index].Year < year && item.Reference == nil:
				reference := list[index]
				item.Reference = &reference
			}
		}
		// Last year's window is the expectation the operator asked for; the
		// mean across every recorded year stands in when last year is missing.
		expectedFirst := flowMeanDate(groupFirst[gk], year)
		expectedLast := flowMeanDate(groupLast[gk], year)
		if item.Reference != nil {
			if parsed, parseErr := parseDate(item.Reference.FirstSeen); parseErr == nil {
				shifted := flowDateInYear(parsed.Month(), parsed.Day(), year)
				expectedFirst = &shifted
			}
			if item.Reference.LastSeen != nil {
				if parsed, parseErr := parseDate(*item.Reference.LastSeen); parseErr == nil {
					shifted := flowDateInYear(parsed.Month(), parsed.Day(), year)
					expectedLast = &shifted
				}
			}
		}
		if expectedFirst != nil {
			opening := bloomDate(*expectedFirst)
			item.ExpectedFirst = &opening
			if expectedLast == nil || expectedLast.Before(*expectedFirst) {
				closing := expectedFirst.AddDate(0, 0, 14)
				expectedLast = &closing
			}
			closing := bloomDate(*expectedLast)
			item.ExpectedLast = &closing
		}
		item.Status, item.DaysUntil = flowStatus(item, expectedFirst, expectedLast, today)
		items = append(items, item)
	}
	sort.Slice(items, func(i, j int) bool {
		left, right := items[i].ExpectedFirst, items[j].ExpectedFirst
		switch {
		case left == nil && right == nil:
			return items[i].Species < items[j].Species
		case left == nil:
			return false
		case right == nil:
			return true
		case *left != *right:
			return *left < *right
		default:
			return items[i].Species < items[j].Species
		}
	})

	writeJSON(w, http.StatusOK, map[string]any{
		"apiaryId": apiaryID, "year": year, "scope": scope,
		"elevationM": elevation, "elevationBand": band,
		"elevationBandLabel": bloomBandLabel(band),
		"forageRadiusM":      radius,
		"bands":              elevationBandDefs,
		"rows":               items,
	})
}

// flowStatus places today against the expected window: blooming now, still
// coming, or the yard missed it this year.
func flowStatus(
	item flowCalendarRow,
	expectedFirst, expectedLast *time.Time,
	today time.Time,
) (string, *int) {
	if item.Current != nil {
		if item.Current.Ongoing {
			return "blooming", nil
		}
		return "finished", nil
	}
	if expectedFirst == nil {
		return "no_history", nil
	}
	days := int(math.Round(expectedFirst.Sub(today).Hours() / 24))
	switch {
	case flowDayOfYear(today) < flowDayOfYear(expectedFirst.AddDate(0, 0, -7)):
		return "upcoming", &days
	case expectedLast == nil || flowDayOfYear(today) <= flowDayOfYear(*expectedLast):
		return "due", &days
	default:
		return "missed", nil
	}
}
