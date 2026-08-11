package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/biker2000on/beez-trackz/backend/internal/db"
)

// --- pure status rules (no database) --------------------------------------

func timePtr(t time.Time) *time.Time { return &t }

func TestFeedingStatusEvaluateStates(t *testing.T) {
	now := time.Date(2026, 8, 4, 12, 0, 0, 0, time.UTC)
	syrup := "sugar_syrup_1to1"

	tests := []struct {
		name        string
		row         feedingStatusRow
		wantState   string
		wantAction  string
		wantInText  string
		wantNoText  string
		wantAgeDays int
	}{
		{
			name: "unverified legacy record asks for verification",
			row: feedingStatusRow{
				HiveName:           "A3",
				UnverifiedFeeders:  1,
				OldestUnverifiedAt: timePtr(now.AddDate(0, 0, -94)),
				LatestFeedAt:       timePtr(now.AddDate(0, 0, -94)),
				LatestFeedType:     &syrup,
			},
			wantState:   feedingStateAttention,
			wantAction:  "Verify and close",
			wantInText:  "Feeder on A3 open 94 days",
			wantAgeDays: 94,
		},
		{
			name: "open feeder past the attention threshold",
			row: feedingStatusRow{
				HiveName:       "B1",
				OpenFeeders:    1,
				OldestOpenAt:   timePtr(now.AddDate(0, 0, -30)),
				LatestFeedAt:   timePtr(now.AddDate(0, 0, -30)),
				LatestFeedType: &syrup,
			},
			wantState:   feedingStateAttention,
			wantAction:  "Refill or close",
			wantInText:  "open 30 days with no refill",
			wantAgeDays: 30,
		},
		{
			name: "open feeder past the stale threshold",
			row: feedingStatusRow{
				HiveName:       "B2",
				OpenFeeders:    1,
				OldestOpenAt:   timePtr(now.AddDate(0, 0, -9)),
				LatestFeedAt:   timePtr(now.AddDate(0, 0, -9)),
				LatestFeedType: &syrup,
			},
			wantState:   feedingStateStale,
			wantAction:  "Check level",
			wantInText:  "filled 9 days ago (1:1 sugar syrup)",
			wantAgeDays: 9,
		},
		{
			name: "freshly filled feeder is ok and asks for nothing",
			row: feedingStatusRow{
				HiveName:       "B3",
				OpenFeeders:    1,
				OldestOpenAt:   timePtr(now.AddDate(0, 0, -2)),
				LatestFeedAt:   timePtr(now.AddDate(0, 0, -2)),
				LatestFeedType: &syrup,
			},
			wantState:   feedingStateOK,
			wantAction:  "",
			wantInText:  "filled 2 days ago",
			wantAgeDays: 2,
		},
		{
			name: "no feeder on the hive",
			row: feedingStatusRow{
				HiveName:       "C1",
				LatestFeedAt:   timePtr(now.AddDate(0, 0, -40)),
				LatestFeedType: &syrup,
			},
			wantState:  feedingStateOK,
			wantAction: "",
			wantInText: "No open feeder on C1",
			wantNoText: "verify",
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			row := test.row
			feedingStatusEvaluate(&row, now)
			if row.State != test.wantState {
				t.Fatalf("state = %q, want %q", row.State, test.wantState)
			}
			if test.wantAction == "Verify and close" &&
				row.ActionFeedingID != row.oldestUnverifiedID {
				t.Fatal("verify action does not target the oldest unverified record")
			}
			if row.Action != test.wantAction {
				t.Fatalf("action = %q, want %q", row.Action, test.wantAction)
			}
			if !bytes.Contains([]byte(row.Evidence), []byte(test.wantInText)) {
				t.Fatalf("evidence = %q, want it to contain %q", row.Evidence, test.wantInText)
			}
			if test.wantNoText != "" &&
				bytes.Contains([]byte(row.Evidence), []byte(test.wantNoText)) {
				t.Fatalf("evidence = %q, should not contain %q", row.Evidence, test.wantNoText)
			}
			if test.wantAgeDays > 0 {
				age := feedingStatusUrgency(row)
				if age != test.wantAgeDays {
					t.Fatalf("urgency age = %d, want %d", age, test.wantAgeDays)
				}
			}
		})
	}
}

// A hive with both an unverified legacy record and a current open feeder must
// point its "Verify and close" action at the unverified record — closing the
// live feeder as "verified" would have destroyed a valid record.
func TestFeedingStatusMixedStatesTargetTheUnverifiedRecord(t *testing.T) {
	now := time.Date(2026, 8, 4, 12, 0, 0, 0, time.UTC)
	syrup := "sugar_syrup_1to1"
	openID := uuid.New()
	unverifiedID := uuid.New()
	row := feedingStatusRow{
		HiveName:           "A3",
		OpenFeeders:        1,
		UnverifiedFeeders:  1,
		OldestOpenAt:       timePtr(now.AddDate(0, 0, -2)),
		OldestUnverifiedAt: timePtr(now.AddDate(0, 0, -120)),
		LatestFeedAt:       timePtr(now.AddDate(0, 0, -2)),
		LatestFeedType:     &syrup,
		oldestOpenID:       &openID,
		oldestUnverifiedID: &unverifiedID,
	}
	feedingStatusEvaluate(&row, now)
	if row.Action != "Verify and close" {
		t.Fatalf("action = %q, want Verify and close", row.Action)
	}
	if row.ActionFeedingID == nil || *row.ActionFeedingID != unverifiedID {
		t.Fatalf("action targets %v, want the unverified record %v",
			row.ActionFeedingID, unverifiedID)
	}
	if !strings.Contains(row.Evidence, "current feeder") {
		t.Errorf("evidence %q does not mention the remaining open feeder", row.Evidence)
	}
}

func TestFeedingStatusSortIsUrgentFirst(t *testing.T) {
	now := time.Now()
	rows := []feedingStatusRow{
		{HiveName: "ok", ApiaryName: "Yard", LatestFeedAt: timePtr(now.AddDate(0, 0, -3))},
		{HiveName: "stale", ApiaryName: "Yard", OpenFeeders: 1,
			OldestOpenAt: timePtr(now.AddDate(0, 0, -9))},
		{HiveName: "attention-new", ApiaryName: "Yard", OpenFeeders: 1,
			OldestOpenAt: timePtr(now.AddDate(0, 0, -25))},
		{HiveName: "attention-old", ApiaryName: "Yard", UnverifiedFeeders: 2,
			OldestUnverifiedAt: timePtr(now.AddDate(0, 0, -120))},
	}
	for index := range rows {
		feedingStatusEvaluate(&rows[index], now)
	}
	feedingStatusSort(rows)

	want := []string{"attention-old", "attention-new", "stale", "ok"}
	for index, name := range want {
		if rows[index].HiveName != name {
			t.Fatalf("row %d = %q, want %q (order: %v)", index, rows[index].HiveName, name,
				[]string{rows[0].HiveName, rows[1].HiveName, rows[2].HiveName, rows[3].HiveName})
		}
	}
}

// --- database-backed lifecycle tests --------------------------------------

type feedingFixture struct {
	server   *Server
	user     *principal
	apiaryID uuid.UUID
	hiveA    uuid.UUID
	hiveB    uuid.UUID
	ctx      context.Context
}

var (
	feedingTestPoolOnce sync.Once
	feedingTestPool     *pgxpool.Pool
	feedingTestPoolErr  error
)

// feedingTestDatabase opens (and migrates) the test database once per package
// run. The retry covers the case where another package's test binary is
// applying the same migrations concurrently on a fresh database.
func feedingTestDatabase(ctx context.Context, databaseURL string) (*pgxpool.Pool, error) {
	feedingTestPoolOnce.Do(func() {
		for attempt := 0; attempt < 6; attempt++ {
			feedingTestPool, feedingTestPoolErr = db.Connect(ctx, databaseURL)
			if feedingTestPoolErr == nil {
				return
			}
			time.Sleep(2 * time.Second)
		}
	})
	return feedingTestPool, feedingTestPoolErr
}

// newFeedingFixture connects to TEST_DATABASE_URL (running migrations) and
// creates an isolated admin user, apiary, and two hives.
func newFeedingFixture(t *testing.T) *feedingFixture {
	t.Helper()
	databaseURL := os.Getenv("TEST_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("TEST_DATABASE_URL is not configured")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	t.Cleanup(cancel)

	pool, err := feedingTestDatabase(ctx, databaseURL)
	if err != nil {
		t.Fatalf("connect test database: %v", err)
	}

	suffix := uuid.NewString()
	fixture := &feedingFixture{server: &Server{pool: pool}, ctx: ctx}

	var userID uuid.UUID
	if err := pool.QueryRow(ctx, `
		INSERT INTO app_users (auth_subject, display_name, is_admin, is_active)
		VALUES ($1,'Feeding test',true,true) RETURNING id`,
		"feeding-test:"+suffix).Scan(&userID); err != nil {
		t.Fatalf("insert test user: %v", err)
	}
	fixture.user = &principal{ID: userID, DisplayName: "Feeding test", IsAdmin: true}

	if err := pool.QueryRow(ctx,
		`INSERT INTO apiaries (name) VALUES ($1) RETURNING id`,
		"Feeding test "+suffix).Scan(&fixture.apiaryID); err != nil {
		t.Fatalf("insert test apiary: %v", err)
	}
	for _, target := range []struct {
		label string
		id    *uuid.UUID
	}{{"A3", &fixture.hiveA}, {"B1", &fixture.hiveB}} {
		if err := pool.QueryRow(ctx, `
			INSERT INTO hives (apiary_id, position_label) VALUES ($1,$2) RETURNING id`,
			fixture.apiaryID, target.label).Scan(target.id); err != nil {
			t.Fatalf("insert test hive: %v", err)
		}
	}

	t.Cleanup(func() {
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cleanupCancel()
		_, _ = pool.Exec(cleanupCtx, `
			UPDATE feedings SET refill_of_id = NULL
			WHERE hive_id IN (SELECT id FROM hives WHERE apiary_id=$1)`, fixture.apiaryID)
		_, _ = pool.Exec(cleanupCtx, `
			DELETE FROM feedings
			WHERE hive_id IN (SELECT id FROM hives WHERE apiary_id=$1)`, fixture.apiaryID)
		_, _ = pool.Exec(cleanupCtx, `DELETE FROM hives WHERE apiary_id=$1`, fixture.apiaryID)
		_, _ = pool.Exec(cleanupCtx, `DELETE FROM apiaries WHERE id=$1`, fixture.apiaryID)
		_, _ = pool.Exec(cleanupCtx, `DELETE FROM app_users WHERE id=$1`, userID)
	})
	return fixture
}

func (f *feedingFixture) pool() *pgxpool.Pool { return f.server.pool }

// insertFeeding writes a feeding row directly, so tests can create the legacy
// shapes (old dates, unverified status) the API itself will never produce.
func (f *feedingFixture) insertFeeding(
	t *testing.T,
	hiveID uuid.UUID,
	dateFed time.Time,
	status string,
) uuid.UUID {
	t.Helper()
	var id uuid.UUID
	var closedAt *time.Time
	if status == feedingStatusClosed {
		closedAt = &dateFed
	}
	err := f.pool().QueryRow(f.ctx, `
		INSERT INTO feedings
			(hive_id, date_fed, type, quantity, quantity_unit, feeder_type, status, closed_at)
		VALUES ($1,$2,'sugar_syrup_1to1',2,'quarts','top',$3,$4)
		RETURNING id`, hiveID, dateFed, status, closedAt).Scan(&id)
	if err != nil {
		t.Fatalf("insert feeding: %v", err)
	}
	return id
}

// call invokes a handler directly with the authenticated principal and chi URL
// params in place (the router's auth middleware is covered by router_test.go).
func (f *feedingFixture) call(
	t *testing.T,
	handler http.HandlerFunc,
	method, target string,
	body any,
	params map[string]string,
) *httptest.ResponseRecorder {
	t.Helper()
	var request *http.Request
	if body != nil {
		encoded, err := json.Marshal(body)
		if err != nil {
			t.Fatalf("encode body: %v", err)
		}
		request = httptest.NewRequest(method, target, bytes.NewReader(encoded))
		request.Header.Set("Content-Type", "application/json")
	} else {
		request = httptest.NewRequest(method, target, nil)
	}
	routeCtx := chi.NewRouteContext()
	for key, value := range params {
		routeCtx.URLParams.Add(key, value)
	}
	ctx := context.WithValue(f.ctx, chi.RouteCtxKey, routeCtx)
	ctx = context.WithValue(ctx, principalKey, f.user)
	response := httptest.NewRecorder()
	handler(response, request.WithContext(ctx))
	return response
}

func (f *feedingFixture) readStatus(t *testing.T, id uuid.UUID) (string, *time.Time, *string) {
	t.Helper()
	var status string
	var closedAt *time.Time
	var reason *string
	if err := f.pool().QueryRow(f.ctx,
		`SELECT status::text, closed_at, closed_reason FROM feedings WHERE id=$1`, id).
		Scan(&status, &closedAt, &reason); err != nil {
		t.Fatalf("read feeding status: %v", err)
	}
	return status, closedAt, reason
}

// A feeding recorded with no feeder is a feed event (syrup poured, patty on
// the frames), not equipment on the hive: it must never open the feeder
// lifecycle or count as an active feeder.
func TestFeedingWithoutFeederIsRecordedClosed(t *testing.T) {
	fixture := newFeedingFixture(t)

	response := fixture.call(t, fixture.server.handleFeedingCreate, http.MethodPost,
		"/feedings", map[string]any{
			"hiveId":       fixture.hiveA.String(),
			"dateFed":      time.Now().Format("2006-01-02"),
			"type":         "pollen_patty",
			"quantity":     1,
			"quantityUnit": "lbs",
		}, nil)
	if response.Code != http.StatusCreated {
		t.Fatalf("create = %d (%s)", response.Code, response.Body.String())
	}
	var created feedingJSON
	if err := json.Unmarshal(response.Body.Bytes(), &created); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if created.Status != feedingStatusClosed ||
		created.ClosedReason == nil || *created.ClosedReason != "not_installed" {
		t.Fatalf("feederless feeding = %q / %v, want closed / not_installed",
			created.Status, created.ClosedReason)
	}
	if created.DateEmpty == nil {
		t.Error("feederless feeding was left without a date_empty")
	}

	// Naming a feeder still opens the lifecycle.
	response = fixture.call(t, fixture.server.handleFeedingCreate, http.MethodPost,
		"/feedings", map[string]any{
			"hiveId":       fixture.hiveA.String(),
			"dateFed":      time.Now().Format("2006-01-02"),
			"type":         "sugar_syrup_1to1",
			"quantity":     2,
			"quantityUnit": "quarts",
			"feederType":   "top",
		}, nil)
	if response.Code != http.StatusCreated {
		t.Fatalf("create with feeder = %d (%s)", response.Code, response.Body.String())
	}
	if err := json.Unmarshal(response.Body.Bytes(), &created); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if created.Status != feedingStatusOpen {
		t.Fatalf("feeder feeding status = %q, want open", created.Status)
	}
}

func TestFeedingRefillClosesPredecessorAndOpensOneSuccessor(t *testing.T) {
	fixture := newFeedingFixture(t)
	original := fixture.insertFeeding(t, fixture.hiveA,
		time.Now().AddDate(0, 0, -10), feedingStatusOpen)

	response := fixture.call(t, fixture.server.handleFeedingRefill, http.MethodPost,
		"/feedings/"+original.String()+"/refill",
		map[string]any{"quantity": 4}, map[string]string{"id": original.String()})
	if response.Code != http.StatusCreated {
		t.Fatalf("refill status = %d (%s), want 201", response.Code, response.Body.String())
	}
	var refill feedingJSON
	if err := json.Unmarshal(response.Body.Bytes(), &refill); err != nil {
		t.Fatalf("decode refill: %v", err)
	}
	if refill.Status != feedingStatusOpen {
		t.Fatalf("refill status = %q, want open", refill.Status)
	}
	if refill.RefillOfID == nil || *refill.RefillOfID != original {
		t.Fatalf("refill.refillOfId = %v, want %v", refill.RefillOfID, original)
	}
	if refill.Quantity != 4 || refill.Type != "sugar_syrup_1to1" ||
		refill.QuantityUnit != "quarts" {
		t.Fatalf("refill did not inherit the feeder setup: %#v", refill)
	}

	status, closedAt, reason := fixture.readStatus(t, original)
	if status != feedingStatusClosed || closedAt == nil ||
		reason == nil || *reason != feedingCloseReasonRefilled {
		t.Fatalf("predecessor = %q closedAt=%v reason=%v, want closed/refilled",
			status, closedAt, reason)
	}

	// Exactly one open feeder remains on the hive: the whole point of the rule.
	var openCount int
	if err := fixture.pool().QueryRow(fixture.ctx,
		`SELECT count(*) FROM feedings WHERE hive_id=$1 AND status='open'`,
		fixture.hiveA).Scan(&openCount); err != nil {
		t.Fatalf("count open feeders: %v", err)
	}
	if openCount != 1 {
		t.Fatalf("open feeders on hive = %d, want 1", openCount)
	}

	// Both records stay in the hive timeline.
	var total int
	if err := fixture.pool().QueryRow(fixture.ctx,
		`SELECT count(*) FROM feedings WHERE hive_id=$1`, fixture.hiveA).Scan(&total); err != nil {
		t.Fatalf("count feedings: %v", err)
	}
	if total != 2 {
		t.Fatalf("feeding rows on hive = %d, want 2 (history preserved)", total)
	}
}

func TestFeedingRefillRejectsClosedFeeder(t *testing.T) {
	fixture := newFeedingFixture(t)
	closed := fixture.insertFeeding(t, fixture.hiveA,
		time.Now().AddDate(0, 0, -3), feedingStatusClosed)

	response := fixture.call(t, fixture.server.handleFeedingRefill, http.MethodPost,
		"/feedings/"+closed.String()+"/refill", nil,
		map[string]string{"id": closed.String()})
	if response.Code != http.StatusConflict {
		t.Fatalf("refill of closed feeder = %d (%s), want 409",
			response.Code, response.Body.String())
	}
}

func TestFeedingRefillOfUnverifiedRecordResolvesIt(t *testing.T) {
	fixture := newFeedingFixture(t)
	stale := fixture.insertFeeding(t, fixture.hiveA,
		time.Now().AddDate(0, 0, -120), feedingStatusUnverified)

	response := fixture.call(t, fixture.server.handleFeedingRefill, http.MethodPost,
		"/feedings/"+stale.String()+"/refill", map[string]any{"quantity": 2},
		map[string]string{"id": stale.String()})
	if response.Code != http.StatusCreated {
		t.Fatalf("refill of unverified feeder = %d (%s), want 201",
			response.Code, response.Body.String())
	}
	status, _, _ := fixture.readStatus(t, stale)
	if status != feedingStatusClosed {
		t.Fatalf("unverified predecessor = %q, want closed", status)
	}
}

func TestFeedingCloseIsExplicitAndNotRepeatable(t *testing.T) {
	fixture := newFeedingFixture(t)
	stale := fixture.insertFeeding(t, fixture.hiveA,
		time.Now().AddDate(0, 0, -100), feedingStatusUnverified)

	response := fixture.call(t, fixture.server.handleFeedingClose, http.MethodPost,
		"/feedings/"+stale.String()+"/close",
		map[string]any{"reason": "verified_closed", "notes": "Checked the yard, no feeder"},
		map[string]string{"id": stale.String()})
	if response.Code != http.StatusOK {
		t.Fatalf("close status = %d (%s), want 200", response.Code, response.Body.String())
	}
	var closed feedingJSON
	if err := json.Unmarshal(response.Body.Bytes(), &closed); err != nil {
		t.Fatalf("decode close: %v", err)
	}
	if closed.Status != feedingStatusClosed || closed.ClosedAt == nil ||
		closed.ClosedReason == nil || *closed.ClosedReason != "verified_closed" {
		t.Fatalf("closed feeding = %#v", closed)
	}
	if closed.DateEmpty == nil {
		t.Fatal("closing recorded no date_empty, legacy readers would still see it active")
	}
	if closed.Notes == nil || *closed.Notes == "" {
		t.Fatal("close note was not kept")
	}

	// A second close must not silently succeed — that ambiguity is what
	// produced duplicate status rows.
	again := fixture.call(t, fixture.server.handleFeedingClose, http.MethodPost,
		"/feedings/"+stale.String()+"/close", nil,
		map[string]string{"id": stale.String()})
	if again.Code != http.StatusConflict {
		t.Fatalf("second close = %d (%s), want 409", again.Code, again.Body.String())
	}
}

func TestFeedingCloseRejectsUnknownReason(t *testing.T) {
	fixture := newFeedingFixture(t)
	open := fixture.insertFeeding(t, fixture.hiveA, time.Now(), feedingStatusOpen)

	response := fixture.call(t, fixture.server.handleFeedingClose, http.MethodPost,
		"/feedings/"+open.String()+"/close", map[string]any{"reason": "whatever"},
		map[string]string{"id": open.String()})
	if response.Code != http.StatusBadRequest {
		t.Fatalf("close with unknown reason = %d, want 400", response.Code)
	}
}

func TestFeedingEmptyAliasClosesTheFeeder(t *testing.T) {
	fixture := newFeedingFixture(t)
	open := fixture.insertFeeding(t, fixture.hiveA,
		time.Now().AddDate(0, 0, -2), feedingStatusOpen)

	response := fixture.call(t, fixture.server.handleFeedingEmpty, http.MethodPost,
		"/feedings/"+open.String()+"/empty", nil, map[string]string{"id": open.String()})
	if response.Code != http.StatusOK {
		t.Fatalf("empty status = %d (%s), want 200", response.Code, response.Body.String())
	}
	status, closedAt, reason := fixture.readStatus(t, open)
	if status != feedingStatusClosed || closedAt == nil || reason == nil || *reason != "emptied" {
		t.Fatalf("feeding after /empty = %q %v %v", status, closedAt, reason)
	}
}

func TestFeedingDeleteRejectsRefilledRecord(t *testing.T) {
	fixture := newFeedingFixture(t)
	original := fixture.insertFeeding(t, fixture.hiveA,
		time.Now().AddDate(0, 0, -5), feedingStatusOpen)
	refill := fixture.call(t, fixture.server.handleFeedingRefill, http.MethodPost,
		"/feedings/"+original.String()+"/refill", nil,
		map[string]string{"id": original.String()})
	if refill.Code != http.StatusCreated {
		t.Fatalf("refill status = %d (%s)", refill.Code, refill.Body.String())
	}

	response := fixture.call(t, fixture.server.handleFeedingDelete, http.MethodDelete,
		"/feedings/"+original.String(), nil, map[string]string{"id": original.String()})
	if response.Code != http.StatusConflict {
		t.Fatalf("delete of refilled feeding = %d (%s), want 409",
			response.Code, response.Body.String())
	}
}

func TestFeedingsStatusReturnsOneUrgentFirstRowPerHive(t *testing.T) {
	fixture := newFeedingFixture(t)
	// Hive A3: three legacy records with no recorded end, the shape the audit
	// found in production. One hive row, not three.
	for _, age := range []int{94, 130, 200} {
		fixture.insertFeeding(t, fixture.hiveA,
			time.Now().AddDate(0, 0, -age), feedingStatusUnverified)
	}
	// Hive B1: a feeder filled two days ago, plus older closed history.
	fixture.insertFeeding(t, fixture.hiveB, time.Now().AddDate(0, 0, -40), feedingStatusClosed)
	fixture.insertFeeding(t, fixture.hiveB, time.Now().AddDate(0, 0, -2), feedingStatusOpen)

	response := fixture.call(t, fixture.server.handleFeedingsStatus, http.MethodGet,
		"/feedings/status", nil, nil)
	if response.Code != http.StatusOK {
		t.Fatalf("status endpoint = %d (%s), want 200", response.Code, response.Body.String())
	}
	var rows []feedingStatusRow
	if err := json.Unmarshal(response.Body.Bytes(), &rows); err != nil {
		t.Fatalf("decode status: %v", err)
	}

	byHive := map[uuid.UUID]feedingStatusRow{}
	first := -1
	for index, row := range rows {
		if row.HiveID == fixture.hiveA || row.HiveID == fixture.hiveB {
			if _, duplicate := byHive[row.HiveID]; duplicate {
				t.Fatalf("hive %s appeared twice in the status list", row.HiveID)
			}
			byHive[row.HiveID] = row
			if first < 0 {
				first = index
			}
		}
	}
	if len(byHive) != 2 {
		t.Fatalf("got %d fixture rows, want 2", len(byHive))
	}

	rowA := byHive[fixture.hiveA]
	if rowA.State != feedingStateAttention {
		t.Fatalf("A3 state = %q, want attention", rowA.State)
	}
	if rowA.UnverifiedFeeders != 3 {
		t.Fatalf("A3 unverified feeders = %d, want 3", rowA.UnverifiedFeeders)
	}
	if rowA.OpenFeeders != 0 {
		t.Fatalf("A3 open feeders = %d, want 0 (unverified is not active)", rowA.OpenFeeders)
	}
	if rowA.ActionFeedingID == nil || rowA.Action != "Verify and close" {
		t.Fatalf("A3 action = %q / %v, want an actionable verify-and-close",
			rowA.Action, rowA.ActionFeedingID)
	}
	if rowA.Evidence == "" || rowA.LatestFeedAt == nil {
		t.Fatalf("A3 row is missing evidence or a latest feed date: %#v", rowA)
	}

	rowB := byHive[fixture.hiveB]
	if rowB.State != feedingStateOK || rowB.OpenFeeders != 1 {
		t.Fatalf("B1 = %q with %d open feeders, want ok/1", rowB.State, rowB.OpenFeeders)
	}

	// Urgent first: A3 must sort ahead of B1.
	indexA, indexB := -1, -1
	for index, row := range rows {
		if row.HiveID == fixture.hiveA {
			indexA = index
		}
		if row.HiveID == fixture.hiveB {
			indexB = index
		}
	}
	if indexA > indexB {
		t.Fatalf("attention row sorted after ok row (%d > %d)", indexA, indexB)
	}
}

// --- migration guarantees -------------------------------------------------

func TestFeedingLifecycleSchemaGuarantees(t *testing.T) {
	fixture := newFeedingFixture(t)

	// A closed feeding must always record when it closed.
	_, err := fixture.pool().Exec(fixture.ctx, `
		INSERT INTO feedings (hive_id, date_fed, type, quantity, quantity_unit, status)
		VALUES ($1, now(), 'fondant', 1, 'lbs', 'closed')`, fixture.hiveA)
	if err == nil {
		t.Fatal("closed feeding without closed_at was accepted")
	}

	// A feeding can only be refilled once, so a chain cannot fork into two
	// open rows even if two clients race.
	original := fixture.insertFeeding(t, fixture.hiveA, time.Now(), feedingStatusOpen)
	for attempt := 0; attempt < 2; attempt++ {
		_, err := fixture.pool().Exec(fixture.ctx, `
			INSERT INTO feedings
				(hive_id, date_fed, type, quantity, quantity_unit, status, refill_of_id)
			VALUES ($1, now(), 'fondant', 1, 'lbs', 'open', $2)`, fixture.hiveA, original)
		if attempt == 0 && err != nil {
			t.Fatalf("first refill insert failed: %v", err)
		}
		if attempt == 1 && err == nil {
			t.Fatal("a second refill of the same feeding was accepted")
		}
	}
}

// TestFeedingStaleBackfillIsReversible exercises the correction the migration
// applies to the legacy "no end date" rows, and the documented reversal.
// The statements mirror 00007_feeding_lifecycle.sql; a change there that
// breaks reversibility breaks this test.
func TestFeedingStaleBackfillIsReversible(t *testing.T) {
	fixture := newFeedingFixture(t)
	const batch = "00007_stale_open_feeders_test"
	stale := fixture.insertFeeding(t, fixture.hiveA,
		time.Now().AddDate(0, 0, -120), feedingStatusOpen)
	fresh := fixture.insertFeeding(t, fixture.hiveB,
		time.Now().AddDate(0, 0, -3), feedingStatusOpen)
	t.Cleanup(func() {
		_, _ = fixture.pool().Exec(context.Background(),
			`DELETE FROM feeding_status_backfills WHERE batch=$1`, batch)
	})

	if _, err := fixture.pool().Exec(fixture.ctx, `
		INSERT INTO feeding_status_backfills
			(feeding_id, batch, reason, prior_status, prior_date_empty,
			 prior_closed_at, prior_closed_reason, new_status)
		SELECT id, $1, 'stale open feeder', status, date_empty, closed_at, closed_reason,
			'unverified'
		FROM feedings
		WHERE id = ANY($2) AND date_empty IS NULL
		  AND date_fed < now() - interval '90 days'`,
		batch, []uuid.UUID{stale, fresh}); err != nil {
		t.Fatalf("record backfill: %v", err)
	}
	if _, err := fixture.pool().Exec(fixture.ctx, `
		UPDATE feedings SET status='unverified'
		WHERE id = ANY($1) AND date_empty IS NULL
		  AND date_fed < now() - interval '90 days'`,
		[]uuid.UUID{stale, fresh}); err != nil {
		t.Fatalf("apply backfill: %v", err)
	}

	if status, _, _ := fixture.readStatus(t, stale); status != feedingStatusUnverified {
		t.Fatalf("stale feeding = %q, want unverified", status)
	}
	if status, _, _ := fixture.readStatus(t, fresh); status != feedingStatusOpen {
		t.Fatalf("recent feeding = %q, want it left open", status)
	}

	// Original values are preserved, not rewritten.
	var dateEmpty *time.Time
	if err := fixture.pool().QueryRow(fixture.ctx,
		`SELECT date_empty FROM feedings WHERE id=$1`, stale).Scan(&dateEmpty); err != nil {
		t.Fatalf("read date_empty: %v", err)
	}
	if dateEmpty != nil {
		t.Fatal("backfill rewrote date_empty; history must be preserved")
	}

	// The documented reversal restores the prior state exactly.
	if _, err := fixture.pool().Exec(fixture.ctx, `
		UPDATE feedings f
		SET status = b.prior_status,
			closed_at = b.prior_closed_at,
			closed_reason = b.prior_closed_reason
		FROM feeding_status_backfills b
		WHERE b.feeding_id = f.id AND b.batch = $1 AND b.reverted_at IS NULL`,
		batch); err != nil {
		t.Fatalf("revert backfill: %v", err)
	}
	if status, _, _ := fixture.readStatus(t, stale); status != feedingStatusOpen {
		t.Fatalf("after reversal stale feeding = %q, want open", status)
	}
}
