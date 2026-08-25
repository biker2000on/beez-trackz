package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgconn"
)

// --- honeyLockOrder: the honey write paths take their locks in one order ----
//
// The order is harvest rows, then lot rows, then the bulk advisory lock (see
// honeyLockOrder in routes_commerce.go). Two cycles used to exist:
//
//   - hsDeleteEntry took the bulk lock before the lot rows it reconciles,
//     while bottlingRunCreate holds a lot row and then waits for the bulk
//     lock. Whoever got there first held what the other needed.
//   - harvestLotUpdate held its lot row and then reached back for an FK
//     key-share lock on a harvest row, while hsDeleteEntry held that harvest
//     row and waited for the lot.
//
// Two kinds of test below. The ordering probes are deterministic: they park a
// lock in a helper transaction, wait for the handler to block on it, and then
// prove from a third connection that the handler is NOT already holding a lock
// that comes later in the order — which is exactly what the old code did. The
// concurrency tests then run the real handlers against each other and assert
// nobody comes back with a serialization failure.

// waitForBlockedBackends blocks until at least want backends on this database
// are waiting on a lock, so a probe runs at a known point rather than a hoped-
// for one.
func waitForBlockedBackends(t *testing.T, server *Server, want int) {
	t.Helper()
	ctx := context.Background()
	deadline := time.Now().Add(15 * time.Second)
	for time.Now().Before(deadline) {
		var blocked int
		if err := server.pool.QueryRow(ctx, `
			SELECT count(*) FROM pg_stat_activity
			WHERE datname = current_database() AND wait_event_type = 'Lock'`).
			Scan(&blocked); err != nil {
			t.Fatalf("read pg_stat_activity: %v", err)
		}
		if blocked >= want {
			return
		}
		time.Sleep(25 * time.Millisecond)
	}
	t.Fatalf("no handler blocked on a lock within 15s (wanted %d)", want)
}

// bulkLockIsFree reports whether the bulk advisory lock can be taken right
// now, from a connection of its own.
func bulkLockIsFree(t *testing.T, server *Server) bool {
	t.Helper()
	ctx := context.Background()
	tx, err := server.pool.Begin(ctx)
	if err != nil {
		t.Fatalf("begin probe tx: %v", err)
	}
	defer tx.Rollback(ctx)
	var got bool
	if err := tx.QueryRow(ctx, `SELECT pg_try_advisory_xact_lock($1)`, honeyBulkLockKey).
		Scan(&got); err != nil {
		t.Fatalf("probe bulk lock: %v", err)
	}
	return got
}

// lotRowIsFree reports whether the lot row can be locked right now. NOWAIT
// turns "somebody else holds it" into an error instead of a wait.
func lotRowIsFree(t *testing.T, server *Server, lotID uuid.UUID) bool {
	t.Helper()
	ctx := context.Background()
	tx, err := server.pool.Begin(ctx)
	if err != nil {
		t.Fatalf("begin probe tx: %v", err)
	}
	defer tx.Rollback(ctx)
	var code string
	err = tx.QueryRow(ctx,
		`SELECT lot_code FROM harvest_lots WHERE id=$1 FOR UPDATE NOWAIT`, lotID).Scan(&code)
	if err == nil {
		return true
	}
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) && pgErr.Code == "55P03" {
		return false
	}
	t.Fatalf("probe lot row: %v", err)
	return false
}

// runHandler drives a handler on its own goroutine and reports when it is done.
func runHandler(
	handler http.HandlerFunc,
	request *http.Request,
) (*httptest.ResponseRecorder, chan struct{}) {
	response := httptest.NewRecorder()
	done := make(chan struct{})
	go func() {
		defer close(done)
		handler(response, request)
	}()
	return response, done
}

func awaitHandler(t *testing.T, done chan struct{}, what string) {
	t.Helper()
	select {
	case <-done:
	case <-time.After(30 * time.Second):
		t.Fatalf("%s never returned: the honey write paths deadlocked", what)
	}
}

// assertNoDeadlock fails on the shapes a lock cycle surfaces as: pgx reports
// 40P01 and the handlers turn any unexpected database error into a 500.
func assertNoDeadlock(t *testing.T, what string, response *httptest.ResponseRecorder) {
	t.Helper()
	if response.Code == http.StatusInternalServerError {
		t.Errorf("%s = 500 %s; a lock cycle surfaces exactly this way",
			what, strings.TrimSpace(response.Body.String()))
	}
	if strings.Contains(response.Body.String(), "40P01") {
		t.Errorf("%s reported a deadlock: %s", what, response.Body)
	}
}

// jsonRequest builds an admin request whose body is read at handler time, for
// the cases that cannot use call().
func jsonRequest(
	t *testing.T,
	method, target string,
	body map[string]any,
	params ...string,
) *http.Request {
	t.Helper()
	encoded, err := json.Marshal(body)
	if err != nil {
		t.Fatalf("encode payload: %v", err)
	}
	request := adminRequest(method, target, nil, params...)
	request.Body = io.NopCloser(bytes.NewReader(encoded))
	return request
}

// deadlockTestLot seeds a hive, a harvest of the given weight, plenty of
// unlinked bulk honey so the bulk guard never fires first, and a derived lot
// over that harvest.
func deadlockTestLot(
	t *testing.T,
	server *Server,
	lotCode string,
	pounds float64,
) (harvestID, lotID, jarSizeID uuid.UUID) {
	t.Helper()
	_, hiveID := seedLockoutHive(t, server)
	harvestID = seedDerivedLotHarvest(t, server, hiveID, pounds)
	seedDerivedLotHarvest(t, server, hiveID, 500)
	lotID = seedDerivedLot(t, server, lotCode, []uuid.UUID{harvestID}, nil)
	jarSizeID = seedJarSize(t, server, lotCode+" 1 lb", 16, 1200)
	return harvestID, lotID, jarSizeID
}

// Cycle 1, ordering probe. A harvest delete must reach the lot rows it
// reconciles BEFORE it takes the bulk advisory lock. Park the lot row the way
// an in-flight bottling run does, and the delete must be waiting on it with
// the bulk lock still free for anyone else.
func TestHarvestDeleteTakesLotRowsBeforeTheBulkLock(t *testing.T) {
	server := honeyTestServer(t)
	ctx := context.Background()
	harvestID, lotID, _ := deadlockTestLot(t, server, "ORDER-BULK", 20)

	holder, err := server.pool.Begin(ctx)
	if err != nil {
		t.Fatalf("begin holder tx: %v", err)
	}
	defer holder.Rollback(ctx)
	var lotCode string
	if err := holder.QueryRow(ctx,
		`SELECT lot_code FROM harvest_lots WHERE id=$1 FOR UPDATE`, lotID).
		Scan(&lotCode); err != nil {
		t.Fatalf("hold lot row: %v", err)
	}

	response, done := runHandler(server.hsDeleteEntry, adminRequest(
		http.MethodDelete, "/harvest-entries/x", nil, "id", harvestID.String()))
	waitForBlockedBackends(t, server, 1)
	select {
	case <-done:
		t.Fatalf("delete finished while the lot row was held: %d %s",
			response.Code, response.Body)
	default:
	}

	if !bulkLockIsFree(t, server) {
		t.Fatal("hsDeleteEntry is holding the bulk advisory lock while it waits " +
			"for a lot row: that is the cycle against bottlingRunCreate, which " +
			"holds a lot row while it waits for the bulk lock")
	}

	if err := holder.Rollback(ctx); err != nil {
		t.Fatalf("release lot row: %v", err)
	}
	awaitHandler(t, done, "hsDeleteEntry")
	assertNoDeadlock(t, "hsDeleteEntry", response)
	if response.Code != http.StatusOK {
		t.Fatalf("delete = %d %s, want 200 once the lot row was free",
			response.Code, response.Body)
	}
}

// Cycle 2, ordering probe. A lot write must lock the harvests it is about to
// link BEFORE its lot row, because inserting the link takes an FK key-share
// lock on the harvest. Park the harvest row the way an in-flight delete does,
// and the update must be waiting on it with its lot row still free.
func TestLotUpdateTakesHarvestRowsBeforeItsLotRow(t *testing.T) {
	server := honeyTestServer(t)
	ctx := context.Background()
	harvestID, lotID, _ := deadlockTestLot(t, server, "ORDER-LINK", 20)

	holder, err := server.pool.Begin(ctx)
	if err != nil {
		t.Fatalf("begin holder tx: %v", err)
	}
	defer holder.Rollback(ctx)
	var held uuid.UUID
	if err := holder.QueryRow(ctx,
		`SELECT id FROM honey_harvests WHERE id=$1 FOR UPDATE`, harvestID).
		Scan(&held); err != nil {
		t.Fatalf("hold harvest row: %v", err)
	}

	response, done := runHandler(server.harvestLotUpdate, jsonRequest(t,
		http.MethodPut, "/harvest-lots/x", map[string]any{
			"lotCode": "ORDER-LINK", "extractionDate": harvestDay(-10),
			"harvestIds": []string{harvestID.String()},
		}, "id", lotID.String()))
	waitForBlockedBackends(t, server, 1)
	select {
	case <-done:
		t.Fatalf("update finished while the harvest row was held: %d %s",
			response.Code, response.Body)
	default:
	}

	if !lotRowIsFree(t, server, lotID) {
		t.Fatal("harvestLotUpdate is holding its lot row while it waits for a " +
			"harvest row: that is the cycle against hsDeleteEntry, which holds " +
			"the harvest row and waits for the lot")
	}

	if err := holder.Rollback(ctx); err != nil {
		t.Fatalf("release harvest row: %v", err)
	}
	awaitHandler(t, done, "harvestLotUpdate")
	assertNoDeadlock(t, "harvestLotUpdate", response)
	if response.Code != http.StatusOK {
		t.Fatalf("update = %d %s, want 200 once the harvest row was free",
			response.Code, response.Body)
	}
}

// Cycle 1, real handlers. A delete and a bottling run against the same lot,
// released together from behind the bulk lock so they contend for the lot row
// and the bulk lock at once. Both have to come back, and neither may come back
// a deadlock.
func TestHarvestDeleteAndBottlingRunDoNotDeadlock(t *testing.T) {
	server := honeyTestServer(t)
	ctx := context.Background()
	harvestID, lotID, jarSizeID := deadlockTestLot(t, server, "DEADLOCK-BULK", 20)

	// The gate: hold the bulk advisory lock so both handlers pile up behind
	// the same starting line instead of finishing one after the other.
	gate, err := server.pool.Begin(ctx)
	if err != nil {
		t.Fatalf("begin gate tx: %v", err)
	}
	defer gate.Rollback(ctx)
	if _, err := gate.Exec(ctx, `SELECT pg_advisory_xact_lock($1)`, honeyBulkLockKey); err != nil {
		t.Fatalf("hold bulk lock: %v", err)
	}

	bottleResponse, bottleDone := runHandler(server.bottlingRunCreate, jsonRequest(t,
		http.MethodPost, "/harvest-lots/x/bottling-runs", map[string]any{
			"bottledDate": harvestDay(-1), "jarSizeId": jarSizeID.String(), "quantity": 5,
		}, "id", lotID.String()))
	waitForBlockedBackends(t, server, 1)

	deleteResponse, deleteDone := runHandler(server.hsDeleteEntry, adminRequest(
		http.MethodDelete, "/harvest-entries/x", nil, "id", harvestID.String()))
	waitForBlockedBackends(t, server, 2)

	if err := gate.Rollback(ctx); err != nil {
		t.Fatalf("release the gate: %v", err)
	}
	awaitHandler(t, bottleDone, "bottlingRunCreate")
	awaitHandler(t, deleteDone, "hsDeleteEntry")
	assertNoDeadlock(t, "bottlingRunCreate", bottleResponse)
	assertNoDeadlock(t, "hsDeleteEntry", deleteResponse)

	if bottleResponse.Code != http.StatusCreated {
		t.Fatalf("bottling run = %d %s, want 201: it took the lot row first",
			bottleResponse.Code, bottleResponse.Body)
	}
	// The run committed, so the harvest behind it can no longer leave.
	if deleteResponse.Code != http.StatusConflict {
		t.Fatalf("delete = %d %s, want 409: a non-voided run stands on the lot",
			deleteResponse.Code, deleteResponse.Body)
	}
}

// Cycle 2, real handlers: a delete of the harvest and an update of the lot
// that links it, started together. Whichever wins, both must return and
// neither may deadlock.
func TestHarvestDeleteAndLotUpdateDoNotDeadlock(t *testing.T) {
	server := honeyTestServer(t)
	ctx := context.Background()
	harvestID, lotID, _ := deadlockTestLot(t, server, "DEADLOCK-LINK", 20)

	// The gate here is the harvest row itself: both handlers want it first
	// now, so parking it lines them up.
	gate, err := server.pool.Begin(ctx)
	if err != nil {
		t.Fatalf("begin gate tx: %v", err)
	}
	defer gate.Rollback(ctx)
	var held uuid.UUID
	if err := gate.QueryRow(ctx,
		`SELECT id FROM honey_harvests WHERE id=$1 FOR UPDATE`, harvestID).
		Scan(&held); err != nil {
		t.Fatalf("hold harvest row: %v", err)
	}

	deleteResponse, deleteDone := runHandler(server.hsDeleteEntry, adminRequest(
		http.MethodDelete, "/harvest-entries/x", nil, "id", harvestID.String()))
	waitForBlockedBackends(t, server, 1)

	updateResponse, updateDone := runHandler(server.harvestLotUpdate, jsonRequest(t,
		http.MethodPut, "/harvest-lots/x", map[string]any{
			"lotCode": "DEADLOCK-LINK", "extractionDate": harvestDay(-10),
			"harvestIds": []string{harvestID.String()},
		}, "id", lotID.String()))
	waitForBlockedBackends(t, server, 2)

	if err := gate.Rollback(ctx); err != nil {
		t.Fatalf("release the gate: %v", err)
	}
	awaitHandler(t, deleteDone, "hsDeleteEntry")
	awaitHandler(t, updateDone, "harvestLotUpdate")
	assertNoDeadlock(t, "hsDeleteEntry", deleteResponse)
	assertNoDeadlock(t, "harvestLotUpdate", updateResponse)

	// The delete queued first, so it wins the harvest row and the update finds
	// a harvest it may no longer link.
	if deleteResponse.Code != http.StatusOK {
		t.Fatalf("delete = %d %s, want 200: no run stands on the lot",
			deleteResponse.Code, deleteResponse.Body)
	}
	if updateResponse.Code != http.StatusUnprocessableEntity {
		t.Fatalf("update = %d %s, want 422: the harvest it wanted to link is gone",
			updateResponse.Code, updateResponse.Body)
	}
}

// --- create vs. delete ------------------------------------------------------

// A lot creation used to read live harvest weights without locking them, so a
// delete that saw no committed link could commit underneath it: the lot landed
// holding the pre-delete weight, linked only to a harvest that no longer
// exists. The creation now locks the requested harvests first and re-reads
// deleted_at under that lock, so the loser loses cleanly.
func TestLotCreateLosesCleanlyToAConcurrentHarvestDelete(t *testing.T) {
	server := honeyTestServer(t)
	ctx := context.Background()
	_, hiveID := seedLockoutHive(t, server)
	harvestID := seedDerivedLotHarvest(t, server, hiveID, 20)
	seedDerivedLotHarvest(t, server, hiveID, 500)

	gate, err := server.pool.Begin(ctx)
	if err != nil {
		t.Fatalf("begin gate tx: %v", err)
	}
	defer gate.Rollback(ctx)
	var held uuid.UUID
	if err := gate.QueryRow(ctx,
		`SELECT id FROM honey_harvests WHERE id=$1 FOR UPDATE`, harvestID).
		Scan(&held); err != nil {
		t.Fatalf("hold harvest row: %v", err)
	}

	deleteResponse, deleteDone := runHandler(server.hsDeleteEntry, adminRequest(
		http.MethodDelete, "/harvest-entries/x", nil, "id", harvestID.String()))
	waitForBlockedBackends(t, server, 1)

	createResponse, createDone := runHandler(server.harvestLotCreate, jsonRequest(t,
		http.MethodPost, "/harvest-lots", map[string]any{
			"lotCode": "RACE-CREATE", "extractionDate": harvestDay(-10),
			"harvestIds": []string{harvestID.String()},
		}))
	waitForBlockedBackends(t, server, 2)

	if err := gate.Rollback(ctx); err != nil {
		t.Fatalf("release the gate: %v", err)
	}
	awaitHandler(t, deleteDone, "hsDeleteEntry")
	awaitHandler(t, createDone, "harvestLotCreate")
	assertNoDeadlock(t, "hsDeleteEntry", deleteResponse)
	assertNoDeadlock(t, "harvestLotCreate", createResponse)

	if deleteResponse.Code != http.StatusOK {
		t.Fatalf("delete = %d %s, want 200: the harvest was linked to nothing",
			deleteResponse.Code, deleteResponse.Body)
	}
	if createResponse.Code != http.StatusUnprocessableEntity {
		t.Fatalf("create = %d %s, want 422: the harvest it would derive from "+
			"was deleted while it waited", createResponse.Code, createResponse.Body)
	}
	if !strings.Contains(createResponse.Body.String(), harvestID.String()) {
		t.Errorf("refusal %s does not name the deleted harvest", createResponse.Body)
	}
	var lots int
	if err := server.pool.QueryRow(ctx,
		`SELECT count(*) FROM harvest_lots WHERE lot_code='RACE-CREATE'`).Scan(&lots); err != nil {
		t.Fatalf("count lots: %v", err)
	}
	if lots != 0 {
		t.Errorf("the refused creation left %d lot(s) behind", lots)
	}
}

// The same rule outside a race: a lot may not be created over, or updated onto,
// a harvest that is already deleted.
func TestLotWritesRefuseADeletedHarvest(t *testing.T) {
	server := honeyTestServer(t)
	_, hiveID := seedLockoutHive(t, server)
	live := seedDerivedLotHarvest(t, server, hiveID, 12)
	gone := seedDerivedLotHarvest(t, server, hiveID, 8)
	lotID := seedDerivedLot(t, server, "DELETED-LINK", []uuid.UUID{live}, nil)

	deleted, body := call(t, server.hsDeleteEntry, adminRequest(
		http.MethodDelete, "/harvest-entries/x", nil, "id", gone.String()))
	if deleted.Code != http.StatusOK {
		t.Fatalf("delete entry = %d %v", deleted.Code, body)
	}

	created, decoded := call(t, server.harvestLotCreate, adminRequest(
		http.MethodPost, "/harvest-lots", map[string]any{
			"lotCode": "DELETED-LINK-2", "extractionDate": harvestDay(-10),
			"harvestIds": []string{gone.String()},
		}))
	if created.Code != http.StatusUnprocessableEntity {
		t.Fatalf("create over a deleted harvest = %d %v, want 422", created.Code, decoded)
	}

	updated, decoded := call(t, server.harvestLotUpdate, adminRequest(
		http.MethodPut, "/harvest-lots/x", map[string]any{
			"lotCode": "DELETED-LINK", "extractionDate": harvestDay(-10),
			"harvestIds": []string{live.String(), gone.String()},
		}, "id", lotID.String()))
	if updated.Code != http.StatusUnprocessableEntity {
		t.Fatalf("update onto a deleted harvest = %d %v, want 422", updated.Code, decoded)
	}
	if got := lotStoredWeight(t, server, lotID); got != 12 {
		t.Errorf("lot weight = %v, want the 12 lbs it had before the refusal", got)
	}
}
