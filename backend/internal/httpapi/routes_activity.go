package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"sort"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
)

// Apiary activity (Contract 1) and the hive timeline filters (Contract 2)
// share one date-range grammar and one event union, so the yard history and
// the hive record can be drawn by the same renderer.

func (s *Server) mountActivity(r chi.Router) {
	r.With(s.requireApiaryParamRole(false)).
		Get("/apiaries/{id}/activity", s.handleApiaryActivity)
}

const (
	activityDefaultRangeDays = 365
	activityMaxRangeYears    = 3
	civilDateLayout          = "2006-01-02"
)

// activityTypeNames are the ?types= values Contract 1 allows, in display
// order. They double as the MCP enum.
var activityTypeNames = []string{
	"inspection", "feeding", "treatment", "mite_count", "queen", "split",
	"harvest", "move", "status", "apiary_observation",
}

// activityTypeAliases maps an accepted ?types= value to the event_type the
// timeline union emits. Queen events keep the hive timeline's historical
// "queen_event" type string; "queen" is the filter spelling, and the raw type
// is accepted too so a client can echo an event's type back as a filter.
var activityTypeAliases = map[string]string{
	"inspection":         "inspection",
	"feeding":            "feeding",
	"treatment":          "treatment",
	"mite_count":         "mite_count",
	"queen":              "queen_event",
	"queen_event":        "queen_event",
	"split":              "split",
	"harvest":            "harvest",
	"move":               "move",
	"status":             "status",
	"apiary_observation": "apiary_observation",
}

// activityRange is an inclusive range of civil days. Both ends are midnight
// UTC labels for a calendar date, not instants.
type activityRange struct {
	From time.Time
	To   time.Time
}

// parseCivilDate accepts exactly YYYY-MM-DD and returns that day as a
// midnight-UTC label.
func parseCivilDate(raw string) (time.Time, error) {
	return time.Parse(civilDateLayout, strings.TrimSpace(raw))
}

// civilToday is the server's calendar day as a midnight-UTC label.
func civilToday(now time.Time) time.Time {
	y, m, d := now.In(time.Local).Date()
	return time.Date(y, m, d, 0, 0, 0, 0, time.UTC)
}

// eventDay maps a stored timestamptz to the calendar day it belongs to, as a
// midnight-UTC label. calendarDate already treats a UTC-midnight value as a
// date-only record; everything else is read in server local time, which is
// how parseDate stores a date-only request value.
func eventDay(t time.Time) time.Time {
	day := calendarDate(t.In(time.Local))
	y, m, d := day.Date()
	return time.Date(y, m, d, 0, 0, 0, 0, time.UTC)
}

func formatCivil(t time.Time) string { return t.Format(civilDateLayout) }

func formatCivilPtr(t *time.Time) *string {
	if t == nil {
		return nil
	}
	value := formatCivil(eventDay(*t))
	return &value
}

// parseActivityRange applies Contract 1: to defaults to today, from to 365
// days before to, both inclusive, at most three years apart.
func parseActivityRange(rawFrom, rawTo string, now time.Time) (activityRange, error) {
	var rg activityRange
	if strings.TrimSpace(rawTo) == "" {
		rg.To = civilToday(now)
	} else {
		to, err := parseCivilDate(rawTo)
		if err != nil {
			return rg, errors.New("to must be a date (YYYY-MM-DD)")
		}
		rg.To = to
	}
	if strings.TrimSpace(rawFrom) == "" {
		rg.From = rg.To.AddDate(0, 0, -activityDefaultRangeDays)
	} else {
		from, err := parseCivilDate(rawFrom)
		if err != nil {
			return rg, errors.New("from must be a date (YYYY-MM-DD)")
		}
		rg.From = from
	}
	if rg.From.After(rg.To) {
		return rg, errors.New("from must be on or before to")
	}
	if rg.From.AddDate(activityMaxRangeYears, 0, 0).Before(rg.To) {
		return rg, fmt.Errorf("date range cannot exceed %d years", activityMaxRangeYears)
	}
	return rg, nil
}

// parseActivityTypes parses a comma-separated ?types= filter into the set of
// emitted event types. nil means "all types".
func parseActivityTypes(raw string) (map[string]bool, error) {
	if strings.TrimSpace(raw) == "" {
		return nil, nil
	}
	out := map[string]bool{}
	for _, part := range strings.Split(raw, ",") {
		name := strings.ToLower(strings.TrimSpace(part))
		if name == "" {
			continue
		}
		mapped, ok := activityTypeAliases[name]
		if !ok {
			return nil, fmt.Errorf("unknown type %q (allowed: %s)",
				name, strings.Join(activityTypeNames, ", "))
		}
		out[mapped] = true
	}
	if len(out) == 0 {
		return nil, nil
	}
	return out, nil
}

func typeAllowed(types map[string]bool, name string) bool {
	return types == nil || types[name]
}

func (rg activityRange) contains(day time.Time) bool {
	return !day.Before(rg.From) && !day.After(rg.To)
}

// sqlBounds widens the civil range by two days on each side. Stored values
// are instants and the day they belong to depends on eventDay's rules, so
// SQL only pre-filters and Go applies the exact day test.
func (rg activityRange) sqlBounds() (time.Time, time.Time) {
	return rg.From.AddDate(0, 0, -2), rg.To.AddDate(0, 0, 3)
}

// --- the shared event union ---------------------------------------------

type timelineQuery struct {
	HiveIDs []uuid.UUID
	Lower   *time.Time
	Upper   *time.Time
	// Types holds emitted event types; nil means every type.
	Types map[string]bool
	// IncludeStatus adds dated status changes (dead-out, colony sale). The
	// unfiltered hive timeline leaves them out so its response is unchanged.
	IncludeStatus bool
	// Limit caps the rows; 0 means no cap.
	Limit int
}

type timelineRow struct {
	HiveID uuid.UUID
	hiveTimelineEntry
}

// timelineTypeGuard keeps a branch of the union from running at all when the
// type filter excludes it.
func timelineTypeGuard(eventType string) string {
	return "($4::text[] IS NULL OR '" + eventType + "' = ANY($4::text[]))"
}

// timelineUnionSQL is THE event union behind GET /hives/{id}/timeline and
// GET /apiaries/{id}/activity. $1 hive ids, $2/$3 optional instant bounds,
// $4 optional emitted-type filter, $5 optional limit (NULL = all).
func timelineUnionSQL(includeStatus bool) string {
	status := ""
	if includeStatus {
		status = `
			UNION ALL
			SELECT h.id, h.id, 'status', h.deadout_date, 'Dead-out', NULL::text,
				'[]'::jsonb, jsonb_build_object('status', 'dead')
			FROM hives h
			WHERE h.id = ANY($1::uuid[]) AND h.deadout_date IS NOT NULL
			  AND ` + timelineTypeGuard("status") + `
			UNION ALL
			SELECT h.id, sale.id, 'status', sale.date, 'Sold', NULL::text,
				'[]'::jsonb, jsonb_build_object('status', 'sold', 'saleId', sale.id)
			FROM hives h
			JOIN sales sale ON sale.id = h.sale_id
			WHERE h.id = ANY($1::uuid[]) AND h.status = 'sold'
			  AND ` + timelineTypeGuard("status")
	}
	return `
		SELECT hive_id, event_id, event_type, event_date, title, details, photos, meta
		FROM (
			SELECT i.hive_id AS hive_id, i.id AS event_id, 'inspection'::text AS event_type,
				i.date AS event_date, 'Inspection'::text AS title,
				COALESCE(i.notes, i.brood_pattern, i.queen_health) AS details,
				COALESCE((
					SELECT jsonb_agg(jsonb_build_object(
						'id', p.id,
						'url', COALESCE(
							CASE WHEN p.medium_key IS NOT NULL AND p.medium_key <> ''
								THEN '/api/v1/photos/file/' || p.medium_key END,
							CASE WHEN p.thumbnail_key IS NOT NULL AND p.thumbnail_key <> ''
								THEN '/api/v1/photos/file/' || p.thumbnail_key END,
							'/api/v1/photos/' || p.id::text || '/original'
						),
						'caption', p.caption
					) ORDER BY p.created_at)
					FROM photos p WHERE p.owner_type = 'inspection' AND p.owner_id = i.id
				), '[]'::jsonb) AS photos,
				jsonb_build_object(
					'queenSeen', i.queen_seen, 'storesHoney', i.stores_honey,
					'storesPollen', i.stores_pollen, 'temperament', i.temperament
				) AS meta
			FROM inspections i
			WHERE i.hive_id = ANY($1::uuid[]) AND ` + timelineTypeGuard("inspection") + `
			UNION ALL
			SELECT f.hive_id, f.id, 'feeding', f.date_fed, 'Feeding',
				concat_ws(' · ', CASE f.type::text
						WHEN 'sugar_syrup_1to1' THEN '1:1 syrup'
						WHEN 'sugar_syrup_2to1' THEN '2:1 syrup'
						ELSE replace(f.type::text, '_', ' ')
					END,
					f.quantity::text || ' ' || f.quantity_unit::text, f.notes),
				'[]'::jsonb, jsonb_build_object('dateEmpty', f.date_empty)
			FROM feedings f
			WHERE f.hive_id = ANY($1::uuid[]) AND ` + timelineTypeGuard("feeding") + `
			UNION ALL
			SELECT t.hive_id, t.id, 'treatment', t.date_applied, 'Treatment: ' || t.product,
				concat_ws(' · ', t.method, t.notes), '[]'::jsonb,
				jsonb_build_object(
					'dateRemoved', t.date_removed,
					'withdrawalDays', t.withdrawal_days,
					'lockoutUntil', CASE WHEN t.date_removed IS NULL THEN NULL
						ELSE (t.date_removed::date + t.withdrawal_days)::date END
				)
			FROM treatment_events t
			WHERE t.hive_id = ANY($1::uuid[]) AND t.deleted_at IS NULL
			  AND ` + timelineTypeGuard("treatment") + `
			UNION ALL
			SELECT m.hive_id, m.id, 'mite_count', m.date, 'Varroa count',
				m.mites_count::text || ' mites via ' || replace(m.method, '_', ' '),
				'[]'::jsonb,
				jsonb_build_object('method', m.method, 'mitesCount', m.mites_count,
					'sampleSize', m.sample_size, 'daysOnBoard', m.days_on_board,
					'mitesPer100', m.mites_per_100, 'mitesPerDay', m.mites_per_day)
			FROM mite_counts m
			WHERE m.hive_id = ANY($1::uuid[]) AND m.deleted_at IS NULL
			  AND ` + timelineTypeGuard("mite_count") + `
			UNION ALL
			SELECT q.hive_id, q.id, 'queen_event', q.event_date,
				'Queen ' || replace(q.event_type, '_', ' '), q.notes,
				'[]'::jsonb,
				jsonb_build_object('eventType', q.event_type, 'queenId', q.queen_id)
			FROM queen_events q
			WHERE q.hive_id = ANY($1::uuid[]) AND ` + timelineTypeGuard("queen_event") + `
			UNION ALL
			SELECT hs.hive_id, hs.id, 'harvest', hs.date, 'Honey harvest',
				round(hs.calculated_honey_weight::numeric, 2)::text || ' lb', '[]'::jsonb,
				jsonb_build_object('weightLbs', hs.calculated_honey_weight)
			FROM honey_harvests hs
			WHERE hs.hive_id = ANY($1::uuid[]) AND hs.deleted_at IS NULL
			  AND ` + timelineTypeGuard("harvest") + `
			UNION ALL
			SELECT th.id, sp.id, 'split', sp.split_date,
				CASE WHEN sp.parent_hive_id = th.id THEN 'Split created'
					ELSE 'Created from split' END,
				concat_ws(' · ', replace(sp.split_type::text, '-', ' '), sp.notes),
				'[]'::jsonb,
				jsonb_build_object('parentHiveId', sp.parent_hive_id, 'childHiveId', sp.child_hive_id)
			FROM hive_splits sp
			JOIN unnest($1::uuid[]) AS th(id)
				ON th.id = sp.parent_hive_id OR th.id = sp.child_hive_id
			WHERE ` + timelineTypeGuard("split") + `
			UNION ALL
			SELECT lh.hive_id, lh.id, 'move', lh.date_from, 'Moved to ' || a.name,
				lh.position_label, '[]'::jsonb,
				jsonb_build_object('apiaryId', lh.apiary_id, 'dateTo', lh.date_to)
			FROM hive_location_history lh
			JOIN apiaries a ON a.id = lh.apiary_id
			WHERE lh.hive_id = ANY($1::uuid[]) AND ` + timelineTypeGuard("move") +
		status + `
		) timeline
		WHERE ($2::timestamptz IS NULL OR event_date >= $2::timestamptz)
		  AND ($3::timestamptz IS NULL OR event_date < $3::timestamptz)
		ORDER BY event_date DESC, event_id
		LIMIT $5`
}

func (s *Server) queryTimeline(ctx context.Context, q timelineQuery) ([]timelineRow, error) {
	if len(q.HiveIDs) == 0 {
		return []timelineRow{}, nil
	}
	var types any
	if q.Types != nil {
		list := make([]string, 0, len(q.Types))
		for name := range q.Types {
			list = append(list, name)
		}
		sort.Strings(list)
		types = list
	}
	var limit any
	if q.Limit > 0 {
		limit = q.Limit
	}
	rows, err := s.pool.Query(ctx, timelineUnionSQL(q.IncludeStatus),
		q.HiveIDs, q.Lower, q.Upper, types, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]timelineRow, 0)
	for rows.Next() {
		var item timelineRow
		var photosJSON []byte
		if err := rows.Scan(&item.HiveID, &item.ID, &item.Type, &item.Date, &item.Title,
			&item.Details, &photosJSON, &item.Meta); err != nil {
			return nil, err
		}
		item.Photos = []hiveTimelinePhoto{}
		_ = json.Unmarshal(photosJSON, &item.Photos)
		out = append(out, item)
	}
	return out, rows.Err()
}

// --- GET /apiaries/{id}/activity ----------------------------------------

type activityObservationJSON struct {
	ID         uuid.UUID `json:"id"`
	ObservedAt time.Time `json:"observedAt"`
	Notes      string    `json:"notes"`
}

type activityHiveJSON struct {
	HiveID        uuid.UUID           `json:"hiveId"`
	PositionLabel string              `json:"positionLabel"`
	Status        string              `json:"status"`
	IsArchived    bool                `json:"isArchived"`
	InstalledDate *string             `json:"installedDate"`
	DeadoutDate   *string             `json:"deadoutDate"`
	StandID       *string             `json:"standId"`
	SlotRow       *int                `json:"slotRow"`
	SlotCol       *int                `json:"slotCol"`
	Events        []hiveTimelineEntry `json:"events"`
}

type activityDayJSON struct {
	Date               string                    `json:"date"`
	ApiaryObservations []activityObservationJSON `json:"apiaryObservations"`
	Hives              []activityHiveJSON        `json:"hives"`
}

type activityResponse struct {
	ApiaryID uuid.UUID         `json:"apiaryId"`
	From     string            `json:"from"`
	To       string            `json:"to"`
	Days     []activityDayJSON `json:"days"`
}

// activityHiveInfo is the per-hive header repeated on each day the hive has
// events. installed is kept as an instant for sorting.
type activityHiveInfo struct {
	header    activityHiveJSON
	installed *time.Time
}

// buildActivityDays groups timeline rows and apiary observations into
// Contract 1's day list: newest day first, hives by position label then
// installed date, empty days omitted. Pure, so the ordering is unit-tested.
func buildActivityDays(
	hives map[uuid.UUID]activityHiveInfo,
	rows []timelineRow,
	observations []activityObservationJSON,
	rg activityRange,
) []activityDayJSON {
	type dayBucket struct {
		observations []activityObservationJSON
		hives        map[uuid.UUID]*activityHiveJSON
	}
	buckets := map[time.Time]*dayBucket{}
	bucket := func(day time.Time) *dayBucket {
		b := buckets[day]
		if b == nil {
			b = &dayBucket{hives: map[uuid.UUID]*activityHiveJSON{}}
			buckets[day] = b
		}
		return b
	}
	for _, row := range rows {
		info, ok := hives[row.HiveID]
		if !ok {
			continue
		}
		day := eventDay(row.Date)
		if !rg.contains(day) {
			continue
		}
		b := bucket(day)
		hive := b.hives[row.HiveID]
		if hive == nil {
			header := info.header
			header.Events = []hiveTimelineEntry{}
			hive = &header
			b.hives[row.HiveID] = hive
		}
		hive.Events = append(hive.Events, row.hiveTimelineEntry)
	}
	for _, observation := range observations {
		day := eventDay(observation.ObservedAt)
		if !rg.contains(day) {
			continue
		}
		b := bucket(day)
		b.observations = append(b.observations, observation)
	}

	days := make([]time.Time, 0, len(buckets))
	for day := range buckets {
		days = append(days, day)
	}
	sort.Slice(days, func(i, j int) bool { return days[i].After(days[j]) })

	out := make([]activityDayJSON, 0, len(days))
	for _, day := range days {
		b := buckets[day]
		item := activityDayJSON{
			Date:               formatCivil(day),
			ApiaryObservations: b.observations,
			Hives:              make([]activityHiveJSON, 0, len(b.hives)),
		}
		if item.ApiaryObservations == nil {
			item.ApiaryObservations = []activityObservationJSON{}
		}
		sort.Slice(item.ApiaryObservations, func(i, j int) bool {
			return item.ApiaryObservations[i].ObservedAt.After(item.ApiaryObservations[j].ObservedAt)
		})
		ids := make([]uuid.UUID, 0, len(b.hives))
		for id := range b.hives {
			ids = append(ids, id)
		}
		sort.Slice(ids, func(i, j int) bool {
			return activityHiveLess(hives[ids[i]], hives[ids[j]])
		})
		for _, id := range ids {
			hive := b.hives[id]
			sort.SliceStable(hive.Events, func(i, j int) bool {
				return hive.Events[i].Date.After(hive.Events[j].Date)
			})
			item.Hives = append(item.Hives, *hive)
		}
		out = append(out, item)
	}
	return out
}

// activityHiveLess orders hives by position label (case-insensitive), then
// installed date (unknown last), then id so the order is stable.
func activityHiveLess(a, b activityHiveInfo) bool {
	la, lb := strings.ToLower(a.header.PositionLabel), strings.ToLower(b.header.PositionLabel)
	if la != lb {
		return la < lb
	}
	switch {
	case a.installed != nil && b.installed != nil && !a.installed.Equal(*b.installed):
		return a.installed.Before(*b.installed)
	case a.installed != nil && b.installed == nil:
		return true
	case a.installed == nil && b.installed != nil:
		return false
	}
	return a.header.HiveID.String() < b.header.HiveID.String()
}

func (s *Server) handleApiaryActivity(w http.ResponseWriter, r *http.Request) {
	apiaryID, err := uuidParam(r, "id")
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	query := r.URL.Query()
	rg, err := parseActivityRange(query.Get("from"), query.Get("to"), time.Now())
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	types, err := parseActivityTypes(query.Get("types"))
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	lower, upper := rg.sqlBounds()

	// Every hive whose record lives in this apiary, retired ones included:
	// this is history.
	hiveRows, err := s.pool.Query(r.Context(), `
		SELECT id, position_label, status::text, is_archived, installed_date,
			deadout_date, stand_id, slot_row, slot_col
		FROM hives WHERE apiary_id = $1`, apiaryID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	hives := map[uuid.UUID]activityHiveInfo{}
	hiveIDs := make([]uuid.UUID, 0)
	for hiveRows.Next() {
		var info activityHiveInfo
		var deadout *time.Time
		if err := hiveRows.Scan(&info.header.HiveID, &info.header.PositionLabel,
			&info.header.Status, &info.header.IsArchived, &info.installed, &deadout,
			&info.header.StandID, &info.header.SlotRow, &info.header.SlotCol); err != nil {
			hiveRows.Close()
			writeError(w, http.StatusInternalServerError, "database error")
			return
		}
		info.header.InstalledDate = formatCivilPtr(info.installed)
		info.header.DeadoutDate = formatCivilPtr(deadout)
		hives[info.header.HiveID] = info
		hiveIDs = append(hiveIDs, info.header.HiveID)
	}
	hiveRows.Close()
	if hiveRows.Err() != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}

	hiveTypes := types
	wantsHiveEvents := types == nil
	if types != nil {
		hiveTypes = map[string]bool{}
		for name := range types {
			if name != "apiary_observation" {
				hiveTypes[name] = true
				wantsHiveEvents = true
			}
		}
	}
	rows := []timelineRow{}
	if wantsHiveEvents {
		rows, err = s.queryTimeline(r.Context(), timelineQuery{
			HiveIDs: hiveIDs, Lower: &lower, Upper: &upper, Types: hiveTypes,
			IncludeStatus: typeAllowed(types, "status"),
		})
		if err != nil {
			writeError(w, http.StatusInternalServerError, "database error")
			return
		}
	}

	observations := []activityObservationJSON{}
	if typeAllowed(types, "apiary_observation") {
		obsRows, err := s.pool.Query(r.Context(), `
			SELECT id, observed_at, notes FROM apiary_inspections
			WHERE apiary_id = $1 AND observed_at >= $2 AND observed_at < $3
			ORDER BY observed_at DESC, id`, apiaryID, lower, upper)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "database error")
			return
		}
		for obsRows.Next() {
			var item activityObservationJSON
			if err := obsRows.Scan(&item.ID, &item.ObservedAt, &item.Notes); err != nil {
				obsRows.Close()
				writeError(w, http.StatusInternalServerError, "database error")
				return
			}
			observations = append(observations, item)
		}
		obsRows.Close()
		if obsRows.Err() != nil {
			writeError(w, http.StatusInternalServerError, "database error")
			return
		}
	}

	writeJSON(w, http.StatusOK, activityResponse{
		ApiaryID: apiaryID,
		From:     formatCivil(rg.From),
		To:       formatCivil(rg.To),
		Days:     buildActivityDays(hives, rows, observations, rg),
	})
}
