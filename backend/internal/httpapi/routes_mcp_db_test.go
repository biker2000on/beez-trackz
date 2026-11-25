package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
)

// DB-backed tests for Contracts 1-4. They skip without TEST_DATABASE_URL.

// cleanupHiveRecords removes the event rows the fixture's own cleanup does
// not know about. t.Cleanup is LIFO, so this runs before the hives go.
func cleanupHiveRecords(t *testing.T, fixture *hiveScopeFixture, extraHives ...uuid.UUID) {
	t.Helper()
	hives := append([]uuid.UUID{fixture.hiveA, fixture.hiveB}, extraHives...)
	apiaries := []uuid.UUID{fixture.apiaryA, fixture.apiaryB}
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		pool := fixture.server.pool
		for _, table := range []string{"feedings", "mite_counts", "treatment_events", "queen_events", "honey_harvests", "hive_location_history"} {
			_, _ = pool.Exec(ctx, `DELETE FROM `+table+` WHERE hive_id = ANY($1)`, hives)
		}
		_, _ = pool.Exec(ctx, `DELETE FROM inspections WHERE hive_id = ANY($1)`, hives)
		_, _ = pool.Exec(ctx, `DELETE FROM apiary_inspections WHERE apiary_id = ANY($1)`, apiaries)
		_, _ = pool.Exec(ctx, `DELETE FROM bloom_observations WHERE apiary_id = ANY($1)`, apiaries)
		if len(extraHives) > 0 {
			_, _ = pool.Exec(ctx, `DELETE FROM hives WHERE id = ANY($1)`, extraHives)
		}
	})
}

func (f *hiveScopeFixture) addHive(t *testing.T, apiary uuid.UUID, label, status string, archived bool) uuid.UUID {
	t.Helper()
	var id uuid.UUID
	if err := f.server.pool.QueryRow(f.ctx, `
		INSERT INTO hives (apiary_id, position_label, status, is_archived)
		VALUES ($1,$2,$3,$4) RETURNING id`, apiary, label, status, archived).Scan(&id); err != nil {
		t.Fatalf("insert hive %s: %v", label, err)
	}
	return id
}

// mcp calls a tool as the fixture's editor and decodes the structured result.
func (f *hiveScopeFixture) mcp(t *testing.T, name string, args map[string]any) (map[string]any, string) {
	t.Helper()
	params, err := json.Marshal(map[string]any{"name": name, "arguments": args})
	if err != nil {
		t.Fatalf("encode params: %v", err)
	}
	request := httptest.NewRequest(http.MethodPost, "/api/v1/mcp", nil)
	request = request.WithContext(context.WithValue(f.ctx, principalKey, f.editor))
	result, err := f.server.mcpCallTool(request, params)
	if err != nil {
		return nil, err.Error()
	}
	if result.IsError {
		text, _ := result.Content[0]["text"].(string)
		return nil, text
	}
	raw, _ := json.Marshal(result.StructuredContent)
	out := map[string]any{}
	if len(raw) > 0 && raw[0] == '{' {
		if err := json.Unmarshal(raw, &out); err != nil {
			t.Fatalf("decode result: %v", err)
		}
	} else {
		out["items"] = json.RawMessage(raw)
	}
	return out, ""
}

// mcpOK is mcp for calls that must succeed.
func (f *hiveScopeFixture) mcpOK(t *testing.T, name string, args map[string]any) map[string]any {
	t.Helper()
	out, errText := f.mcp(t, name, args)
	if errText != "" {
		t.Fatalf("%s: tool error: %s", name, errText)
	}
	return out
}

func (f *hiveScopeFixture) count(t *testing.T, query string, args ...any) int {
	t.Helper()
	var n int
	if err := f.server.pool.QueryRow(f.ctx, query, args...).Scan(&n); err != nil {
		t.Fatalf("count: %v", err)
	}
	return n
}

func TestApiaryActivityGroupsDaysAndKeepsRetiredHives(t *testing.T) {
	fixture := newHiveScopeFixture(t)
	retired := fixture.addHive(t, fixture.apiaryA, "A2", "dead", true)
	cleanupHiveRecords(t, fixture, retired)
	pool := fixture.server.pool
	exec := func(query string, args ...any) {
		t.Helper()
		if _, err := pool.Exec(fixture.ctx, query, args...); err != nil {
			t.Fatalf("seed: %v", err)
		}
	}
	exec(`UPDATE hives SET deadout_date='2026-09-13T00:00:00Z' WHERE id=$1`, retired)
	exec(`INSERT INTO inspections (hive_id, date, notes) VALUES ($1,'2026-09-13T00:00:00Z','strong')`, fixture.hiveA)
	exec(`INSERT INTO inspections (hive_id, date, notes) VALUES ($1,'2026-09-13T00:00:00Z','queenless')`, retired)
	exec(`INSERT INTO feedings (hive_id, date_fed, type, quantity, quantity_unit)
		VALUES ($1,'2026-09-12T00:00:00Z','sugar_syrup_1to1',2,'quarts')`, fixture.hiveA)
	exec(`INSERT INTO queen_events (hive_id, event_date, event_type) VALUES ($1,'2026-09-12T00:00:00Z','superseded')`, fixture.hiveA)
	exec(`INSERT INTO apiary_inspections (apiary_id, observed_at, notes) VALUES ($1,'2026-09-13T13:41:00Z','goldenrod opening')`, fixture.apiaryA)
	exec(`INSERT INTO inspections (hive_id, date, notes) VALUES ($1,'2026-07-01T00:00:00Z','out of range')`, fixture.hiveA)

	params := map[string]string{"id": fixture.apiaryA.String()}
	response := fixture.call(t, fixture.server.handleApiaryActivity, http.MethodGet,
		"/apiaries/x/activity?from=2026-09-01&to=2026-09-30", nil, params)
	if response.Code != http.StatusOK {
		t.Fatalf("activity = %d %s", response.Code, response.Body.String())
	}
	var body activityResponse
	if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if body.From != "2026-09-01" || body.To != "2026-09-30" || len(body.Days) != 2 {
		t.Fatalf("activity = %+v", body)
	}
	sep13 := body.Days[0]
	if sep13.Date != "2026-09-13" || len(sep13.ApiaryObservations) != 1 || len(sep13.Hives) != 2 {
		t.Fatalf("2026-09-13 = %+v", sep13)
	}
	if sep13.Hives[0].PositionLabel != "A1" || sep13.Hives[1].HiveID != retired {
		t.Fatalf("hive order = %+v", sep13.Hives)
	}
	retiredDay := sep13.Hives[1]
	if retiredDay.Status != "dead" || !retiredDay.IsArchived ||
		retiredDay.DeadoutDate == nil || *retiredDay.DeadoutDate != "2026-09-13" {
		t.Fatalf("retired hive header = %+v", retiredDay)
	}
	types := map[string]json.RawMessage{}
	for _, event := range retiredDay.Events {
		types[event.Type] = event.Meta
	}
	if _, ok := types["inspection"]; !ok {
		t.Fatalf("retired hive events = %+v", retiredDay.Events)
	}
	if meta := string(types["status"]); !strings.Contains(meta, `"status": "dead"`) && !strings.Contains(meta, `"status":"dead"`) {
		t.Fatalf("status meta = %s", meta)
	}
	sep12 := body.Days[1]
	if sep12.Date != "2026-09-12" || len(sep12.Hives) != 1 || len(sep12.Hives[0].Events) != 2 {
		t.Fatalf("2026-09-12 = %+v", sep12)
	}

	filtered := fixture.call(t, fixture.server.handleApiaryActivity, http.MethodGet,
		"/apiaries/x/activity?from=2026-09-01&to=2026-09-30&types=queen", nil, params)
	var queenOnly activityResponse
	_ = json.Unmarshal(filtered.Body.Bytes(), &queenOnly)
	if len(queenOnly.Days) != 1 || queenOnly.Days[0].Hives[0].Events[0].Type != "queen_event" ||
		!strings.Contains(string(queenOnly.Days[0].Hives[0].Events[0].Meta), "superseded") {
		t.Fatalf("types=queen = %s", filtered.Body.String())
	}

	tooLong := fixture.call(t, fixture.server.handleApiaryActivity, http.MethodGet,
		"/apiaries/x/activity?from=2020-01-01&to=2026-09-30", nil, params)
	if tooLong.Code != http.StatusBadRequest {
		t.Fatalf("over 3 years = %d", tooLong.Code)
	}

	// The MCP read applies the same viewer rule: apiary B is not shared.
	if _, errText := fixture.mcp(t, "get_apiary_activity", map[string]any{"apiaryId": fixture.apiaryB.String()}); errText == "" {
		t.Fatal("activity for an unshared apiary must be refused")
	}
}

func TestHiveTimelineFiltersAndUnchangedDefault(t *testing.T) {
	fixture := newHiveScopeFixture(t)
	cleanupHiveRecords(t, fixture)
	pool := fixture.server.pool
	for _, query := range []string{
		`INSERT INTO inspections (hive_id, date) VALUES ($1,'2026-08-01T00:00:00Z')`,
		`INSERT INTO feedings (hive_id, date_fed, type, quantity, quantity_unit) VALUES ($1,'2026-08-05T00:00:00Z','fondant',1,'lbs')`,
		`INSERT INTO mite_counts (hive_id, date, method, mites_count, sample_size) VALUES ($1,'2026-09-01T00:00:00Z','alcohol_wash',6,300)`,
		`UPDATE hives SET deadout_date='2026-09-10T00:00:00Z' WHERE id=$1`,
	} {
		if _, err := pool.Exec(fixture.ctx, query, fixture.hiveA); err != nil {
			t.Fatalf("seed: %v", err)
		}
	}
	params := map[string]string{"id": fixture.hiveA.String()}
	timeline := func(query string) []hiveTimelineEntry {
		t.Helper()
		response := fixture.call(t, fixture.server.hiveTimeline, http.MethodGet,
			"/hives/x/timeline"+query, nil, params)
		if response.Code != http.StatusOK {
			t.Fatalf("timeline%s = %d %s", query, response.Code, response.Body.String())
		}
		var out []hiveTimelineEntry
		if err := json.Unmarshal(response.Body.Bytes(), &out); err != nil {
			t.Fatal(err)
		}
		return out
	}
	all := timeline("")
	if len(all) != 3 {
		t.Fatalf("unfiltered timeline has %d entries, want 3 (no status rows): %+v", len(all), all)
	}
	if got := timeline("?from=2026-08-02&to=2026-08-31"); len(got) != 1 || got[0].Type != "feeding" {
		t.Fatalf("date filter = %+v", got)
	}
	if got := timeline("?types=inspection,mite_count"); len(got) != 2 {
		t.Fatalf("type filter = %+v", got)
	}
	if got := timeline("?types=status"); len(got) != 1 || got[0].Type != "status" {
		t.Fatalf("status filter = %+v", got)
	}
	bad := fixture.call(t, fixture.server.hiveTimeline, http.MethodGet,
		"/hives/x/timeline?types=weather", nil, params)
	if bad.Code != http.StatusBadRequest {
		t.Fatalf("bad type = %d", bad.Code)
	}
}

func TestHiveStatusPatchTouchesOnlyStatusColumns(t *testing.T) {
	fixture := newHiveScopeFixture(t)
	pool := fixture.server.pool
	if _, err := pool.Exec(fixture.ctx, `
		UPDATE hives SET notes='queen marked blue', stand_id='A', slot_row=1, slot_col=2
		WHERE id=$1`, fixture.hiveA); err != nil {
		t.Fatal(err)
	}
	params := map[string]string{"id": fixture.hiveA.String()}
	patch := func(body map[string]any) (int, map[string]any) {
		t.Helper()
		response := fixture.call(t, fixture.server.handleHiveStatus, http.MethodPatch,
			"/hives/x/status", body, params)
		out := map[string]any{}
		_ = json.Unmarshal(response.Body.Bytes(), &out)
		return response.Code, out
	}
	read := func() (status string, archived bool, deadout *string, notes, label string, slotCol int) {
		t.Helper()
		if err := pool.QueryRow(fixture.ctx, `
			SELECT status::text, is_archived, to_char(deadout_date AT TIME ZONE 'UTC','YYYY-MM-DD'),
				notes, position_label, slot_col FROM hives WHERE id=$1`, fixture.hiveA).
			Scan(&status, &archived, &deadout, &notes, &label, &slotCol); err != nil {
			t.Fatal(err)
		}
		return
	}

	code, body := patch(map[string]any{"status": "dead", "date": "2026-09-13T00:00:00Z"})
	if code != http.StatusOK || body["status"] != "dead" || body["isArchived"] != true {
		t.Fatalf("dead = %d %v", code, body)
	}
	status, archived, deadout, notes, label, slotCol := read()
	if status != "dead" || !archived || deadout == nil || *deadout != "2026-09-13" ||
		notes != "queen marked blue" || label != "A1" || slotCol != 2 {
		t.Fatalf("after dead: %s %v %v %q %q %d", status, archived, deadout, notes, label, slotCol)
	}
	// Re-sending dead without a date keeps the recorded dead-out date.
	if code, _ := patch(map[string]any{"status": "dead"}); code != http.StatusOK {
		t.Fatalf("dead again = %d", code)
	}
	if _, _, deadout, _, _, _ = read(); deadout == nil || *deadout != "2026-09-13" {
		t.Fatalf("dead-out date moved: %v", deadout)
	}
	if code, _ := patch(map[string]any{"status": "active"}); code != http.StatusOK {
		t.Fatalf("active = %d", code)
	}
	if status, archived, deadout, notes, _, _ = read(); status != "active" || archived || deadout != nil || notes != "queen marked blue" {
		t.Fatalf("after active: %s %v %v %q", status, archived, deadout, notes)
	}
	if code, _ := patch(map[string]any{"status": "sold", "date": "2026-04-25"}); code != http.StatusOK {
		t.Fatalf("sold = %d", code)
	}
	if status, archived, _, _, _, _ = read(); status != "sold" || !archived {
		t.Fatalf("after sold: %s %v", status, archived)
	}
	if code, _ := patch(map[string]any{"status": "lost"}); code != http.StatusBadRequest {
		t.Fatalf("bad status = %d", code)
	}
	future := time.Now().AddDate(0, 0, 5).Format(civilDateLayout)
	if code, _ := patch(map[string]any{"status": "dead", "date": future}); code != http.StatusBadRequest {
		t.Fatalf("future date = %d", code)
	}
	if code, _ := patch(map[string]any{"status": "dead", "notes": "x"}); code != http.StatusBadRequest {
		t.Fatalf("unknown field = %d", code)
	}
}

func TestHiveDeadoutAcceptsOptionalDate(t *testing.T) {
	fixture := newHiveScopeFixture(t)
	params := map[string]string{"id": fixture.hiveA.String()}
	dated := fixture.call(t, fixture.server.handleHiveDeadout, http.MethodPost,
		"/hives/x/deadout", map[string]any{"date": "2026-03-02T00:00:00Z"}, params)
	if dated.Code != http.StatusOK {
		t.Fatalf("dated deadout = %d %s", dated.Code, dated.Body.String())
	}
	var day string
	var archived bool
	if err := fixture.server.pool.QueryRow(fixture.ctx, `
		SELECT to_char(deadout_date AT TIME ZONE 'UTC','YYYY-MM-DD'), is_archived
		FROM hives WHERE id=$1`, fixture.hiveA).Scan(&day, &archived); err != nil {
		t.Fatal(err)
	}
	if day != "2026-03-02" || !archived {
		t.Fatalf("deadout = %s archived=%v", day, archived)
	}
	// No body keeps the old behaviour: stamped now.
	undated := fixture.call(t, fixture.server.handleHiveDeadout, http.MethodPost,
		"/hives/x/deadout", nil, params)
	if undated.Code != http.StatusOK {
		t.Fatalf("undated deadout = %d %s", undated.Code, undated.Body.String())
	}
	var recent bool
	if err := fixture.server.pool.QueryRow(fixture.ctx, `
		SELECT deadout_date > now() - interval '1 minute' FROM hives WHERE id=$1`,
		fixture.hiveA).Scan(&recent); err != nil || !recent {
		t.Fatalf("undated deadout not stamped now: %v %v", recent, err)
	}
}

func TestTranscriptionCandidatesAreActiveHivesOnly(t *testing.T) {
	fixture := newHiveScopeFixture(t)
	sold := fixture.addHive(t, fixture.apiaryA, "A1", "sold", false)
	dead := fixture.addHive(t, fixture.apiaryA, "A3", "dead", true)
	cleanupHiveRecords(t, fixture, sold, dead)
	candidates, err := fixture.server.transcriptionCandidateHives(fixture.ctx, "apiary", fixture.apiaryA)
	if err != nil {
		t.Fatal(err)
	}
	if len(candidates) != 1 || candidates[0].ID != fixture.hiveA.String() {
		t.Fatalf("candidates = %+v, want only the active A1", candidates)
	}
}

func TestMCPListHivesStatusAndLabel(t *testing.T) {
	fixture := newHiveScopeFixture(t)
	sold := fixture.addHive(t, fixture.apiaryA, "a1", "sold", true)
	cleanupHiveRecords(t, fixture, sold)
	hives := func(args map[string]any) []hiveJSON {
		t.Helper()
		out := fixture.mcpOK(t, "list_hives", args)
		var items []hiveJSON
		if err := json.Unmarshal(out["items"].(json.RawMessage), &items); err != nil {
			t.Fatal(err)
		}
		return items
	}
	apiary := fixture.apiaryA.String()
	if got := hives(map[string]any{"apiaryId": apiary, "positionLabel": " A1 "}); len(got) != 1 || got[0].ID != fixture.hiveA.String() {
		t.Fatalf("label default status = %+v", got)
	}
	if got := hives(map[string]any{"apiaryId": apiary, "status": "all"}); len(got) != 2 {
		t.Fatalf("status all = %+v", got)
	}
	if got := hives(map[string]any{"apiaryId": apiary, "status": "sold"}); len(got) != 1 || got[0].ID != sold.String() {
		t.Fatalf("status sold = %+v", got)
	}
	// Unscoped list never shows apiary B, which the editor cannot see.
	for _, hive := range hives(map[string]any{"status": "all"}) {
		if hive.ID == fixture.hiveB.String() {
			t.Fatal("hive from an unshared apiary listed")
		}
	}
}

func TestMCPRecordInspectionDeduplicates(t *testing.T) {
	fixture := newHiveScopeFixture(t)
	cleanupHiveRecords(t, fixture)
	hive := fixture.hiveA.String()
	// An inspection already exists on Sep 13 at 13:41 (recorded by voice).
	if _, err := fixture.server.pool.Exec(fixture.ctx, `
		INSERT INTO inspections (hive_id, date, notes) VALUES ($1,$2,'voice')`,
		fixture.hiveA, time.Date(2026, 9, 13, 13, 41, 0, 0, time.Local)); err != nil {
		t.Fatal(err)
	}
	dup := fixture.mcpOK(t, "record_inspection", map[string]any{
		"hiveId": hive, "date": "2026-09-13", "notes": "journal copy",
	})
	if dup["duplicate"] != true || dup["existingId"] == nil {
		t.Fatalf("expected a duplicate, got %v", dup)
	}
	record, _ := dup["record"].(map[string]any)
	if record["notes"] != "voice" {
		t.Fatalf("duplicate record = %v", record)
	}
	if n := fixture.count(t, `SELECT count(*) FROM inspections WHERE hive_id=$1`, fixture.hiveA); n != 1 {
		t.Fatalf("inspections = %d, want 1", n)
	}

	created := fixture.mcpOK(t, "record_inspection", map[string]any{
		"hiveId": hive, "date": "2026-09-14", "framesOfBees": 8, "queenCellsCount": 2,
		"treatments": []any{map[string]any{"product": "Oxalic acid", "method": "vapor"}},
		"miteCounts": []any{map[string]any{"method": "alcohol_wash", "mitesCount": 3, "sampleSize": 300}},
	})
	if created["duplicate"] != nil || created["id"] == nil || created["queenSeen"] != nil {
		t.Fatalf("create = %v", created)
	}
	// The inspection's oxalic treatment is one-shot: it must not lock the hive.
	var open int
	open = fixture.count(t, `SELECT count(*) FROM treatment_events
		WHERE hive_id=$1 AND date_removed IS NULL AND deleted_at IS NULL`, fixture.hiveA)
	if open != 0 {
		t.Fatalf("open treatments = %d, want 0", open)
	}

	again := fixture.mcpOK(t, "record_inspection", map[string]any{
		"hiveId": hive, "date": "2026-09-13", "allowDuplicate": true,
	})
	if again["duplicate"] != nil || again["id"] == nil {
		t.Fatalf("allowDuplicate = %v", again)
	}
	if n := fixture.count(t, `SELECT count(*) FROM inspections WHERE hive_id=$1`, fixture.hiveA); n != 3 {
		t.Fatalf("inspections = %d, want 3", n)
	}

	if _, errText := fixture.mcp(t, "record_inspection", map[string]any{
		"hiveId": fixture.hiveB.String(), "date": "2026-09-13",
	}); errText == "" {
		t.Fatal("writing to an unshared hive must be refused")
	}
}

func TestMCPWriteToolsDeduplicateByNaturalKey(t *testing.T) {
	fixture := newHiveScopeFixture(t)
	cleanupHiveRecords(t, fixture)
	hive := fixture.hiveA.String()
	apiary := fixture.apiaryA.String()
	cases := []struct {
		tool  string
		args  map[string]any
		other map[string]any // same day, different key: must be written
	}{
		{"record_feeding",
			map[string]any{"hiveId": hive, "dateFed": "2026-09-13", "type": "fondant", "quantity": 1, "quantityUnit": "lbs"},
			map[string]any{"hiveId": hive, "dateFed": "2026-09-13", "type": "pollen_patty", "quantity": 1, "quantityUnit": "lbs"}},
		{"record_mite_count",
			map[string]any{"hiveId": hive, "date": "2026-09-13", "method": "alcohol_wash", "mitesCount": 4, "sampleSize": 300},
			map[string]any{"hiveId": hive, "date": "2026-09-13", "method": "sticky_board", "mitesCount": 20, "daysOnBoard": 3}},
		{"record_treatment",
			map[string]any{"hiveId": hive, "dateApplied": "2026-09-13", "product": "Apivar"},
			map[string]any{"hiveId": hive, "dateApplied": "2026-09-13", "product": "Formic Pro"}},
		{"record_queen_event",
			map[string]any{"hiveId": hive, "eventDate": "2026-09-13", "eventType": "observed"},
			map[string]any{"hiveId": hive, "eventDate": "2026-09-13", "eventType": "superseded"}},
		{"record_apiary_observation",
			map[string]any{"apiaryId": apiary, "observedAt": "2026-09-13T13:41:00Z", "notes": "goldenrod"},
			map[string]any{"apiaryId": apiary, "observedAt": "2026-09-13T13:41:00Z", "notes": "asters"}},
		{"record_bloom_observation",
			map[string]any{"apiaryId": apiary, "species": "Goldenrod", "dateFirstSeen": "2026-09-13"},
			map[string]any{"apiaryId": apiary, "species": "Aster", "dateFirstSeen": "2026-09-13"}},
	}
	for _, tc := range cases {
		t.Run(tc.tool, func(t *testing.T) {
			first := fixture.mcpOK(t, tc.tool, tc.args)
			if first["duplicate"] != nil {
				t.Fatalf("first write reported duplicate: %v", first)
			}
			second := fixture.mcpOK(t, tc.tool, tc.args)
			if second["duplicate"] != true || second["existingId"] != first["id"] {
				t.Fatalf("second write = %v, want duplicate of %v", second, first["id"])
			}
			other := fixture.mcpOK(t, tc.tool, tc.other)
			if other["duplicate"] != nil {
				t.Fatalf("different key reported duplicate: %v", other)
			}
		})
	}
	// Product matching is case-insensitive.
	caseDup := fixture.mcpOK(t, "record_treatment", map[string]any{
		"hiveId": hive, "dateApplied": "2026-09-13", "product": " apivar ",
	})
	if caseDup["duplicate"] != true {
		t.Fatalf("case-insensitive product = %v", caseDup)
	}
}

func TestMCPRecordTreatmentOneShotDefault(t *testing.T) {
	fixture := newHiveScopeFixture(t)
	cleanupHiveRecords(t, fixture)
	hive := fixture.hiveA.String()
	oxalic := fixture.mcpOK(t, "record_treatment", map[string]any{
		"hiveId": hive, "dateApplied": "2026-10-01", "product": "OA", "method": "vapor",
	})
	if oxalic["dateRemoved"] == nil || oxalic["dateRemovedDefaulted"] != true {
		t.Fatalf("oxalic alias = %v", oxalic)
	}
	apivar := fixture.mcpOK(t, "record_treatment", map[string]any{
		"hiveId": hive, "dateApplied": "2026-10-01", "product": "Apivar",
	})
	if apivar["dateRemoved"] != nil || apivar["dateRemovedDefaulted"] != false {
		t.Fatalf("apivar = %v", apivar)
	}
	locks := fixture.mcpOK(t, "get_treatment_locks", map[string]any{"apiaryId": fixture.apiaryA.String()})
	rows, _ := locks["hives"].([]any)
	if len(rows) != 1 {
		t.Fatalf("locks = %v", locks)
	}
	row := rows[0].(map[string]any)
	if row["locked"] != true || row["treatmentOn"] != true || row["product"] != "Apivar" {
		t.Fatalf("lock row = %v", row)
	}
}

func TestMCPRecordVisitPartialFailureAndRerun(t *testing.T) {
	fixture := newHiveScopeFixture(t)
	cleanupHiveRecords(t, fixture)
	args := map[string]any{
		"apiaryId":    fixture.apiaryA.String(),
		"date":        "2026-09-13",
		"observation": "goldenrod opening",
		"entries": []any{
			map[string]any{
				"positionLabel": "a1",
				"inspection":    map[string]any{"notes": "strong", "temperament": 2},
				"feeding":       map[string]any{"type": "sugar_syrup_2to1", "quantity": 1, "quantityUnit": "gallons"},
				"miteCount":     map[string]any{"method": "alcohol_wash", "mitesCount": 6, "sampleSize": 300},
				"treatment":     map[string]any{"product": "Oxalic acid", "method": "dribble"},
			},
			map[string]any{"positionLabel": "Z9", "inspection": map[string]any{"notes": "?"}},
			map[string]any{"hiveId": fixture.hiveB.String(), "inspection": map[string]any{}},
		},
	}
	out := fixture.mcpOK(t, "record_visit", args)
	entries := out["entries"].([]any)
	first := entries[0].(map[string]any)
	if first["status"] != "saved" || len(first["created"].([]any)) != 4 {
		t.Fatalf("entry 0 = %v", first)
	}
	for i := 1; i <= 2; i++ {
		entry := entries[i].(map[string]any)
		if entry["status"] != "failed" || len(entry["errors"].([]any)) == 0 {
			t.Fatalf("entry %d = %v", i, entry)
		}
	}
	totals := out["totals"].(map[string]any)
	if totals["createdRecords"] != float64(4) || totals["failedEntries"] != float64(2) || totals["savedEntries"] != float64(1) {
		t.Fatalf("totals = %v", totals)
	}
	if observation := out["observation"].(map[string]any); observation["status"] != "created" {
		t.Fatalf("observation = %v", observation)
	}
	if open := fixture.count(t, `SELECT count(*) FROM treatment_events
		WHERE hive_id=$1 AND date_removed IS NULL AND deleted_at IS NULL`, fixture.hiveA); open != 0 {
		t.Fatalf("one-shot treatment left the hive locked (%d open)", open)
	}

	// Re-running the same visit writes nothing.
	rerun := fixture.mcpOK(t, "record_visit", args)
	again := rerun["entries"].([]any)[0].(map[string]any)
	if again["status"] != "duplicate" || len(again["duplicates"].([]any)) != 4 || len(again["created"].([]any)) != 0 {
		t.Fatalf("rerun entry 0 = %v", again)
	}
	if observation := rerun["observation"].(map[string]any); observation["status"] != "duplicate" {
		t.Fatalf("rerun observation = %v", observation)
	}

	// With allowDuplicate the standalone mite count collides with the unique
	// index after the inspection and feeding were inserted; the whole entry
	// rolls back.
	before := fixture.count(t, `SELECT count(*) FROM inspections WHERE hive_id=$1`, fixture.hiveA)
	forced := fixture.mcpOK(t, "record_visit", map[string]any{
		"apiaryId": fixture.apiaryA.String(), "date": "2026-09-13", "allowDuplicate": true,
		"entries": []any{map[string]any{
			"positionLabel": "A1",
			"inspection":    map[string]any{"notes": "second look"},
			"miteCount":     map[string]any{"method": "alcohol_wash", "mitesCount": 6, "sampleSize": 300},
		}},
	})
	entry := forced["entries"].([]any)[0].(map[string]any)
	if entry["status"] != "failed" || len(entry["created"].([]any)) != 0 {
		t.Fatalf("forced entry = %v", entry)
	}
	if after := fixture.count(t, `SELECT count(*) FROM inspections WHERE hive_id=$1`, fixture.hiveA); after != before {
		t.Fatalf("failed entry left an inspection behind: %d -> %d", before, after)
	}
}

func TestMCPDeleteInspectionNamesHiveAndDate(t *testing.T) {
	fixture := newHiveScopeFixture(t)
	cleanupHiveRecords(t, fixture)
	created := fixture.mcpOK(t, "record_inspection", map[string]any{
		"hiveId": fixture.hiveA.String(), "date": "2026-09-13", "notes": "typo",
	})
	id := created["id"].(string)
	updated := fixture.mcpOK(t, "update_inspection", map[string]any{
		"inspectionId": id, "notes": "fixed", "queenSeen": true,
	})
	if updated["notes"] != "fixed" || updated["queenSeen"] != true {
		t.Fatalf("update = %v", updated)
	}
	deleted := fixture.mcpOK(t, "delete_inspection", map[string]any{"inspectionId": id})
	if deleted["deleted"] != true || deleted["positionLabel"] != "A1" || deleted["date"] != "2026-09-13" {
		t.Fatalf("delete = %v", deleted)
	}
	if _, errText := fixture.mcp(t, "delete_inspection", map[string]any{"inspectionId": id}); errText != "inspection not found" {
		t.Fatalf("second delete error = %q", errText)
	}
}

func TestMCPSetHiveStatus(t *testing.T) {
	fixture := newHiveScopeFixture(t)
	out := fixture.mcpOK(t, "set_hive_status", map[string]any{
		"hiveId": fixture.hiveA.String(), "status": "dead", "date": "2026-02-10",
	})
	if out["status"] != "dead" || out["isArchived"] != true || out["deadoutDate"] == nil {
		t.Fatalf("set_hive_status = %v", out)
	}
	if _, errText := fixture.mcp(t, "set_hive_status", map[string]any{
		"hiveId": fixture.hiveB.String(), "status": "dead",
	}); errText == "" {
		t.Fatal("status change on an unshared hive must be refused")
	}
}
