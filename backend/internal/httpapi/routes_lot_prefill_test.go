package httpapi

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"testing"

	"github.com/google/uuid"

	"github.com/biker2000on/beez-trackz/backend/internal/app/production"
)

// DB-backed tests for the lot dialog helpers: GET /lots/prefill, POST
// /lots/story-draft (with a fake provider), pulledOn on the lot commands, and
// the claim species that derives from the varietal. Skip without
// TEST_DATABASE_URL.

// lotPrefillFixture is the season the prefill reads: a yard with an
// elevation, two blooms (one inside the 45-day lookback, one long over), a
// prior summer lot that named the region and a varietal, and three harvests
// of which one is already in that prior lot.
type lotPrefillFixture struct {
	apiaryID, varietalID, priorLotID uuid.UUID
	hiveIDs                          []uuid.UUID
	harvestIDs                       []uuid.UUID
	sessionID                        uuid.UUID
}

func seedLotPrefillFixture(t *testing.T, server *Server) lotPrefillFixture {
	t.Helper()
	ctx := context.Background()
	var f lotPrefillFixture
	if err := server.pool.QueryRow(ctx, `
		INSERT INTO apiaries (name, elevation_m, elevation_source)
		VALUES ('Ridge yard', 640.1, 'override') RETURNING id`).Scan(&f.apiaryID); err != nil {
		t.Fatalf("seed apiary: %v", err)
	}
	t.Cleanup(func() { purgeApiary(t, server, f.apiaryID) })
	for _, label := range []string{"H1", "H2"} {
		var hiveID uuid.UUID
		if err := server.pool.QueryRow(ctx,
			`INSERT INTO hives (apiary_id, position_label) VALUES ($1,$2) RETURNING id`,
			f.apiaryID, label).Scan(&hiveID); err != nil {
			t.Fatalf("seed hive: %v", err)
		}
		f.hiveIDs = append(f.hiveIDs, hiveID)
	}
	varietalName := "Basswood " + uuid.NewString()[:8]
	if err := server.pool.QueryRow(ctx,
		`INSERT INTO honey_varietals (name) VALUES ($1) RETURNING id`, varietalName).Scan(&f.varietalID); err != nil {
		t.Fatalf("seed varietal: %v", err)
	}
	t.Cleanup(func() {
		_, _ = server.pool.Exec(ctx, `DELETE FROM honey_varietals WHERE id=$1`, f.varietalID)
	})
	// Basswood: first seen Jun 25, no last seen -> window to Jul 16, inside
	// the [May 30, Jul 14] lookback. Dandelion: Apr 10 - Apr 30, long over.
	if _, err := server.pool.Exec(ctx, `
		INSERT INTO bloom_observations (apiary_id, species, date_first_seen, date_last_seen, year, abundance, notes)
		VALUES ($1, 'Basswood', '2026-06-25', NULL, 2026, 4, 'heavy along the creek'),
		       ($1, 'Dandelion', '2026-04-10', '2026-04-30', 2026, 2, NULL)`, f.apiaryID); err != nil {
		t.Fatalf("seed blooms: %v", err)
	}
	if err := server.pool.QueryRow(ctx, `
		INSERT INTO harvest_lots (lot_code, public_slug, extraction_date, honey_weight_lbs, season,
			apiary_region, claim_apiary_id, varietal_id)
		VALUES ('2025-RIDGE-01', 'ridge-2025', '2025-07-20', 30, 'Summer 2025',
			'Western New York', $1, $2) RETURNING id`, f.apiaryID, f.varietalID).Scan(&f.priorLotID); err != nil {
		t.Fatalf("seed prior lot: %v", err)
	}
	if err := server.pool.QueryRow(ctx,
		`INSERT INTO harvest_sessions (apiary_id, date, notes) VALUES ($1, '2026-07-14 14:00+00', 'pulled two supers each') RETURNING id`,
		f.apiaryID).Scan(&f.sessionID); err != nil {
		t.Fatalf("seed session: %v", err)
	}
	for _, seed := range []struct {
		hive   uuid.UUID
		date   string
		pounds float64
	}{
		{f.hiveIDs[0], "2026-07-14 15:00+00", 42.5}, // on the pull day
		{f.hiveIDs[1], "2026-07-13 15:00+00", 18},   // the day before, already in the prior lot
		{f.hiveIDs[0], "2026-07-02 15:00+00", 9},    // in the 14-day lookback, too far to suggest
	} {
		var harvestID uuid.UUID
		if err := server.pool.QueryRow(ctx, `
			INSERT INTO honey_harvests (session_id, hive_id, date, super_weight_before, super_weight_after, calculated_honey_weight)
			VALUES ($1, $2, $3, $4, 0, $4) RETURNING id`, f.sessionID, seed.hive, seed.date, seed.pounds).Scan(&harvestID); err != nil {
			t.Fatalf("seed harvest: %v", err)
		}
		f.harvestIDs = append(f.harvestIDs, harvestID)
	}
	if _, err := server.pool.Exec(ctx,
		`INSERT INTO harvest_lot_harvests (lot_id, harvest_id) VALUES ($1, $2)`, f.priorLotID, f.harvestIDs[1]); err != nil {
		t.Fatalf("link harvest: %v", err)
	}
	// A harvest of another yard on the pull day must not appear.
	var otherApiary, otherHive, otherSession uuid.UUID
	if err := server.pool.QueryRow(ctx, `INSERT INTO apiaries (name) VALUES ('Other yard') RETURNING id`).Scan(&otherApiary); err != nil {
		t.Fatalf("seed other apiary: %v", err)
	}
	t.Cleanup(func() { purgeApiary(t, server, otherApiary) })
	if err := server.pool.QueryRow(ctx, `INSERT INTO hives (apiary_id, position_label) VALUES ($1,'X1') RETURNING id`, otherApiary).Scan(&otherHive); err != nil {
		t.Fatalf("seed other hive: %v", err)
	}
	if err := server.pool.QueryRow(ctx, `INSERT INTO harvest_sessions (apiary_id, date) VALUES ($1, '2026-07-14 14:00+00') RETURNING id`, otherApiary).Scan(&otherSession); err != nil {
		t.Fatalf("seed other session: %v", err)
	}
	if _, err := server.pool.Exec(ctx, `
		INSERT INTO honey_harvests (session_id, hive_id, date, super_weight_before, super_weight_after, calculated_honey_weight)
		VALUES ($1, $2, '2026-07-14 15:00+00', 5, 0, 5)`, otherSession, otherHive); err != nil {
		t.Fatalf("seed other harvest: %v", err)
	}
	return f
}

// purgeApiary removes a fixture yard and everything hanging off it, in FK
// order; resetHoneyTables leaves apiaries, hives, inspections and blooms
// alone, so the fixtures clean up after themselves.
func purgeApiary(t *testing.T, server *Server, apiaryID uuid.UUID) {
	t.Helper()
	ctx := context.Background()
	for _, statement := range []string{
		`DELETE FROM harvest_lot_harvests WHERE harvest_id IN (SELECT h.id FROM honey_harvests h JOIN hives ON hives.id=h.hive_id WHERE hives.apiary_id=$1)`,
		`DELETE FROM honey_harvests WHERE hive_id IN (SELECT id FROM hives WHERE apiary_id=$1)`,
		`DELETE FROM harvest_sessions WHERE apiary_id=$1`,
		`DELETE FROM inspections WHERE hive_id IN (SELECT id FROM hives WHERE apiary_id=$1)`,
		`DELETE FROM bloom_observations WHERE apiary_id=$1`,
		`DELETE FROM hives WHERE apiary_id=$1`,
		`DELETE FROM apiaries WHERE id=$1`,
	} {
		if _, err := server.pool.Exec(ctx, statement, apiaryID); err != nil {
			t.Logf("purge apiary %s: %v", apiaryID, err)
			return
		}
	}
}

func TestLotPrefillDerivesSeasonFromTheYardAndDates(t *testing.T) {
	server := honeyTestServer(t)
	f := seedLotPrefillFixture(t, server)

	response, body := call(t, server.lotPrefill, adminRequest(http.MethodGet,
		"/api/v1/lots/prefill?apiaryId="+f.apiaryID.String()+"&pulledOn=2026-07-14&extractedOn=2026-07-18", nil))
	if response.Code != http.StatusOK {
		t.Fatalf("prefill = %d %v", response.Code, body)
	}
	if body["season"] != "Summer 2026" {
		t.Errorf("season = %v", body["season"])
	}
	if body["claimYear"] != float64(2026) {
		t.Errorf("claimYear = %v", body["claimYear"])
	}
	if body["apiaryRegion"] != "Western New York" {
		t.Errorf("apiaryRegion = %v", body["apiaryRegion"])
	}
	if body["elevationM"] != 640.1 {
		t.Errorf("elevationM = %v", body["elevationM"])
	}
	if body["bloomNotes"] != "Basswood (Heavy) — first seen Jun 25 — heavy along the creek" {
		t.Errorf("bloomNotes = %q", body["bloomNotes"])
	}
	if body["suggestedVarietalId"] != f.varietalID.String() {
		t.Errorf("suggestedVarietalId = %v, want %s", body["suggestedVarietalId"], f.varietalID)
	}
	harvests, _ := body["harvests"].([]any)
	if len(harvests) != 3 {
		t.Fatalf("harvests = %v, want the yard's three", harvests)
	}
	byID := map[string]map[string]any{}
	var order []string
	for _, raw := range harvests {
		item := raw.(map[string]any)
		byID[item["id"].(string)] = item
		order = append(order, item["id"].(string))
	}
	if order[0] != f.harvestIDs[0].String() || order[2] != f.harvestIDs[2].String() {
		t.Errorf("harvests are not newest first: %v", order)
	}
	pullDay := byID[f.harvestIDs[0].String()]
	if pullDay["suggested"] != true || pullDay["inLotId"] != nil || pullDay["hiveName"] != "H1" ||
		pullDay["calculatedHoneyWeight"] != 42.5 || pullDay["sessionId"] != f.sessionID.String() {
		t.Errorf("pull-day harvest = %v", pullDay)
	}
	inLot := byID[f.harvestIDs[1].String()]
	if inLot["suggested"] != false || inLot["inLotId"] != f.priorLotID.String() {
		t.Errorf("already-used harvest = %v", inLot)
	}
	early := byID[f.harvestIDs[2].String()]
	if early["suggested"] != false || early["inLotId"] != nil {
		t.Errorf("12-days-early harvest = %v", early)
	}
}

func TestLotPrefillFallsBackWhenTheSeasonIsNew(t *testing.T) {
	server := honeyTestServer(t)
	f := seedLotPrefillFixture(t, server)

	// A fall pull: no earlier "Fall" lot, so the most recent lot's varietal;
	// the summer bloom is more than 45 days gone; extractedOn defaults to
	// pulledOn; the July harvests fall outside the window.
	response, body := call(t, server.lotPrefill, adminRequest(http.MethodGet,
		"/api/v1/lots/prefill?apiaryId="+f.apiaryID.String()+"&pulledOn=2026-09-20", nil))
	if response.Code != http.StatusOK {
		t.Fatalf("prefill = %d %v", response.Code, body)
	}
	if body["season"] != "Fall 2026" || body["bloomNotes"] != nil {
		t.Errorf("season/bloom = %v / %v", body["season"], body["bloomNotes"])
	}
	if body["suggestedVarietalId"] != f.varietalID.String() {
		t.Errorf("suggestedVarietalId = %v", body["suggestedVarietalId"])
	}
	if harvests, _ := body["harvests"].([]any); len(harvests) != 0 {
		t.Errorf("harvests = %v, want none", harvests)
	}

	// A yard nobody has claimed yet: null region and varietal, elevation
	// from the pin.
	var bareApiary uuid.UUID
	if err := server.pool.QueryRow(context.Background(),
		`INSERT INTO apiaries (name) VALUES ('Bare yard') RETURNING id`).Scan(&bareApiary); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { purgeApiary(t, server, bareApiary) })
	response, body = call(t, server.lotPrefill, adminRequest(http.MethodGet,
		"/api/v1/lots/prefill?apiaryId="+bareApiary.String()+"&pulledOn=2026-01-05", nil))
	if response.Code != http.StatusOK {
		t.Fatalf("prefill = %d %v", response.Code, body)
	}
	if body["season"] != "Winter 2026" || body["apiaryRegion"] != nil || body["elevationM"] != nil || body["suggestedVarietalId"] != nil {
		t.Errorf("bare yard prefill = %v", body)
	}
}

func TestLotPrefillValidatesItsInputs(t *testing.T) {
	server := honeyTestServer(t)
	f := seedLotPrefillFixture(t, server)
	for name, target := range map[string]string{
		"missing apiary":        "/api/v1/lots/prefill?pulledOn=2026-07-14",
		"bad pulledOn":          "/api/v1/lots/prefill?apiaryId=" + f.apiaryID.String() + "&pulledOn=14/07/2026",
		"bad extractedOn":       "/api/v1/lots/prefill?apiaryId=" + f.apiaryID.String() + "&pulledOn=2026-07-14&extractedOn=soon",
		"extracted before pull": "/api/v1/lots/prefill?apiaryId=" + f.apiaryID.String() + "&pulledOn=2026-07-14&extractedOn=2026-07-01",
	} {
		response, body := call(t, server.lotPrefill, adminRequest(http.MethodGet, target, nil))
		if response.Code != http.StatusBadRequest {
			t.Errorf("%s = %d %v, want 400", name, response.Code, body)
		}
	}
	response, body := call(t, server.lotPrefill, adminRequest(http.MethodGet,
		"/api/v1/lots/prefill?apiaryId="+uuid.NewString()+"&pulledOn=2026-07-14", nil))
	if response.Code != http.StatusNotFound {
		t.Errorf("unknown apiary = %d %v, want 404", response.Code, body)
	}
}

func TestLotCreateCarriesPulledOnAndDerivesClaimSpeciesFromVarietal(t *testing.T) {
	server := honeyTestServer(t)
	f := seedLotPrefillFixture(t, server)
	var varietalName string
	if err := server.pool.QueryRow(context.Background(), `SELECT name FROM honey_varietals WHERE id=$1`, f.varietalID).Scan(&varietalName); err != nil {
		t.Fatal(err)
	}

	response, body := call(t, server.harvestLotCreate, adminRequest(http.MethodPost, "/api/v1/harvest-lots", map[string]any{
		"lotCode": "2026-RIDGE-01", "extractionDate": "2026-07-18", "pulledOn": "2026-07-14",
		"honeyWeightLbs": 40, "varietalId": f.varietalID.String(), "claimApiaryId": f.apiaryID.String(),
	}))
	if response.Code != http.StatusCreated {
		t.Fatalf("create = %d %v", response.Code, body)
	}
	lotID := body["id"].(string)
	_, lot := call(t, server.harvestLotGet, adminRequest(http.MethodGet, "/api/v1/harvest-lots/"+lotID, nil, "id", lotID))
	if lot["pulledOn"] != "2026-07-14" {
		t.Errorf("pulledOn = %v", lot["pulledOn"])
	}
	if lot["claimSpecies"] != varietalName {
		t.Errorf("claimSpecies = %v, want the varietal name %q", lot["claimSpecies"], varietalName)
	}
	if lot["claimElevationM"] != 640.1 {
		t.Errorf("claimElevationM = %v", lot["claimElevationM"])
	}

	// An explicit species (a blend) wins over the varietal, and pulledOn can
	// be cleared again.
	response, body = call(t, server.harvestLotUpdate, adminRequest(http.MethodPatch, "/api/v1/harvest-lots/"+lotID, map[string]any{
		"lotCode": "2026-RIDGE-01", "extractionDate": "2026-07-18", "pulledOn": nil,
		"honeyWeightLbs": 40, "varietalId": f.varietalID.String(), "claimSpecies": "  Basswood and clover blend ",
	}, "id", lotID))
	if response.Code != http.StatusOK {
		t.Fatalf("update = %d %v", response.Code, body)
	}
	_, lot = call(t, server.harvestLotGet, adminRequest(http.MethodGet, "/api/v1/harvest-lots/"+lotID, nil, "id", lotID))
	if lot["pulledOn"] != nil {
		t.Errorf("pulledOn after clearing = %v", lot["pulledOn"])
	}
	if lot["claimSpecies"] != "Basswood and clover blend" {
		t.Errorf("claimSpecies = %v, want the explicit blend", lot["claimSpecies"])
	}

	// No varietal and no species: nothing is invented.
	response, body = call(t, server.harvestLotUpdate, adminRequest(http.MethodPatch, "/api/v1/harvest-lots/"+lotID, map[string]any{
		"lotCode": "2026-RIDGE-01", "extractionDate": "2026-07-18", "honeyWeightLbs": 40, "claimSpecies": "   ",
	}, "id", lotID))
	if response.Code != http.StatusOK {
		t.Fatalf("update = %d %v", response.Code, body)
	}
	_, lot = call(t, server.harvestLotGet, adminRequest(http.MethodGet, "/api/v1/harvest-lots/"+lotID, nil, "id", lotID))
	if lot["claimSpecies"] != nil {
		t.Errorf("claimSpecies with no varietal = %v, want null", lot["claimSpecies"])
	}

	// A bad pulledOn and an unknown varietal are refused.
	response, body = call(t, server.harvestLotCreate, adminRequest(http.MethodPost, "/api/v1/harvest-lots", map[string]any{
		"lotCode": "2026-RIDGE-02", "extractionDate": "2026-07-18", "pulledOn": "July 14", "honeyWeightLbs": 1,
	}))
	if response.Code != http.StatusBadRequest {
		t.Errorf("bad pulledOn = %d %v, want 400", response.Code, body)
	}
	response, body = call(t, server.harvestLotCreate, adminRequest(http.MethodPost, "/api/v1/harvest-lots", map[string]any{
		"lotCode": "2026-RIDGE-03", "extractionDate": "2026-07-18", "honeyWeightLbs": 1, "varietalId": uuid.NewString(),
	}))
	if response.Code != http.StatusNotFound {
		t.Errorf("unknown varietal = %d %v, want 404", response.Code, body)
	}
}

type recordingDrafter struct {
	prompt, context string
	reply           string
}

func (d *recordingDrafter) Chat(_ context.Context, prompt, contextText string) (string, error) {
	d.prompt, d.context = prompt, contextText
	return d.reply, nil
}

func TestLotStoryDraftGathersTheSeasonForAFakeProvider(t *testing.T) {
	server := honeyTestServer(t)
	f := seedLotPrefillFixture(t, server)
	ctx := context.Background()
	if _, err := server.pool.Exec(ctx, `
		INSERT INTO inspections (hive_id, date, queen_seen, brood_pattern, stores_honey, flow_on, notes)
		VALUES ($1, '2026-05-02 10:00+00', true, 'solid', 3, false, 'building up fast'),
		       ($2, '2026-06-28 10:00+00', NULL, NULL, 5, true, 'basswood flow on, supers filling'),
		       ($1, '2026-08-01 10:00+00', true, 'spotty', 2, false, 'after the pull: dearth'),
		       ($1, '2025-06-01 10:00+00', true, NULL, 4, true, 'last year')`,
		f.hiveIDs[0], f.hiveIDs[1]); err != nil {
		t.Fatalf("seed inspections: %v", err)
	}
	drafter := &recordingDrafter{reply: "I pulled the frames on July 14 and extracted on July 18.\n\nThe basswood was heavy along the creek."}
	server.storyDrafter = func(context.Context) (production.StoryDrafter, string, error) {
		return drafter, "fake", nil
	}

	response, body := call(t, server.lotStoryDraft, adminRequest(http.MethodPost, "/api/v1/lots/story-draft", map[string]any{
		"apiaryId": f.apiaryID.String(), "pulledOn": "2026-07-14", "extractedOn": "2026-07-18",
		"varietalId": f.varietalID.String(), "harvestIds": []string{f.harvestIDs[0].String()},
	}))
	if response.Code != http.StatusOK {
		t.Fatalf("story draft = %d %v", response.Code, body)
	}
	if body["story"] != drafter.reply || body["provider"] != "fake" {
		t.Errorf("story/provider = %v / %v", body["story"], body["provider"])
	}
	sources, _ := body["sources"].(map[string]any)
	if sources["inspections"] != float64(2) || sources["harvests"] != float64(1) ||
		sources["bloomObservations"] != float64(2) || sources["weatherDays"] != float64(0) {
		t.Errorf("sources = %v", sources)
	}
	for _, want := range []string{
		"Yard: Ridge yard", "Honey name (varietal): Basswood", "Yard elevation: 640 m",
		"Frames pulled: July 14, 2026", "Honey extracted: July 18, 2026",
		"- Basswood (Heavy) — first seen Jun 25 — heavy along the creek",
		"- Dandelion (Light) — first seen Apr 10, last seen Apr 30",
		"- Jul 14: hive H1, 42.5 lb — session: pulled two supers each",
		"- May 2, hive H1: queen seen, brood solid, honey stores 3/5, no flow — building up fast",
		"- Jun 28, hive H2: honey stores 5/5, flow on — basswood flow on, supers filling",
	} {
		if !strings.Contains(drafter.context, want) {
			t.Errorf("context lacks %q:\n%s", want, drafter.context)
		}
	}
	for _, reject := range []string{"after the pull", "last year", "Jul 13: hive H2", "Jul 2: hive H1"} {
		if strings.Contains(drafter.context, reject) {
			t.Errorf("context includes %q, which is outside the window or not selected:\n%s", reject, drafter.context)
		}
	}
	if drafter.prompt != production.StoryPrompt() {
		t.Errorf("prompt = %q", drafter.prompt)
	}
	var stories int
	if err := server.pool.QueryRow(ctx, `SELECT count(*) FROM harvest_lots WHERE beekeeper_story IS NOT NULL`).Scan(&stories); err != nil {
		t.Fatal(err)
	}
	if stories != 0 {
		t.Errorf("a draft was persisted: %d lots carry a story", stories)
	}

	// Without harvestIds the lot window's live harvests are all included.
	drafter.context = ""
	response, body = call(t, server.lotStoryDraft, adminRequest(http.MethodPost, "/api/v1/lots/story-draft", map[string]any{
		"apiaryId": f.apiaryID.String(), "pulledOn": "2026-07-14", "extractedOn": "2026-07-18",
	}))
	if response.Code != http.StatusOK {
		t.Fatalf("story draft = %d %v", response.Code, body)
	}
	if sources, _ := body["sources"].(map[string]any); sources["harvests"] != float64(3) {
		t.Errorf("window harvests = %v, want 3", sources["harvests"])
	}
	if strings.Contains(drafter.context, "Honey name") {
		t.Errorf("context names a varietal that was not given:\n%s", drafter.context)
	}
}

func TestLotStoryDraftRefusesWithoutAProviderOrInputs(t *testing.T) {
	server := honeyTestServer(t)
	f := seedLotPrefillFixture(t, server)

	server.storyDrafter = func(context.Context) (production.StoryDrafter, string, error) {
		return nil, "", errNoStoryProvider
	}
	response, body := call(t, server.lotStoryDraft, adminRequest(http.MethodPost, "/api/v1/lots/story-draft", map[string]any{
		"apiaryId": f.apiaryID.String(), "pulledOn": "2026-07-14", "extractedOn": "2026-07-18",
	}))
	if response.Code != http.StatusServiceUnavailable || body["error"] != "no AI provider configured for recommendations" {
		t.Errorf("no provider = %d %v, want 503", response.Code, body)
	}

	// The default resolver with no stored settings and no key in the
	// environment is exactly that case.
	server.storyDrafter = nil
	t.Setenv("ANTHROPIC_API_KEY", "")
	if _, err := server.pool.Exec(context.Background(), `DELETE FROM user_settings`); err != nil {
		t.Fatal(err)
	}
	if _, _, err := server.storyDrafterFor(context.Background()); !errors.Is(err, errNoStoryProvider) {
		t.Errorf("default resolver error = %v, want errNoStoryProvider", err)
	}

	server.storyDrafter = func(context.Context) (production.StoryDrafter, string, error) {
		return &recordingDrafter{reply: "x"}, "fake", nil
	}
	for name, payload := range map[string]map[string]any{
		"no apiary":        {"pulledOn": "2026-07-14"},
		"bad pulledOn":     {"apiaryId": f.apiaryID.String(), "pulledOn": "yesterday"},
		"extract precedes": {"apiaryId": f.apiaryID.String(), "pulledOn": "2026-07-14", "extractedOn": "2026-07-10"},
	} {
		response, body := call(t, server.lotStoryDraft, adminRequest(http.MethodPost, "/api/v1/lots/story-draft", payload))
		if response.Code != http.StatusBadRequest {
			t.Errorf("%s = %d %v, want 400", name, response.Code, body)
		}
	}
	response, body = call(t, server.lotStoryDraft, adminRequest(http.MethodPost, "/api/v1/lots/story-draft", map[string]any{
		"apiaryId": uuid.NewString(), "pulledOn": "2026-07-14",
	}))
	if response.Code != http.StatusNotFound {
		t.Errorf("unknown apiary = %d %v, want 404", response.Code, body)
	}
}
