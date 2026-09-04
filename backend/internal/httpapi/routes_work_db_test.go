package httpapi

import (
	"encoding/json"
	"net/http"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/biker2000on/beez-trackz/backend/internal/app/work"
)

// The wave-1 parity fixture was frozen before the old yard queue assembler
// was deleted. Keep the expected item set and order explicit here so the
// replacement cannot drift after its former comparison oracle is gone.

// workParityKey is what the two payloads have in common: which yard, what
// kind of work, on which hive, titled what, at what priority. The projection
// adds ids, evidence, commands and freshness on top; the yard queue has none
// of those, so they are not comparable and are asserted separately.
type workParityKey struct {
	apiary   string
	kind     string
	hive     string
	title    string
	priority string
}

// workParityFixture seeds one of every source across two yards. The lockout
// goes on hive B because a locked-out hive is deliberately not harvest-ready,
// so the two cannot be exercised on the same hive.
type workParityFixture struct {
	*hiveScopeFixture
	recInspect uuid.UUID
	recFeeder  uuid.UUID
	feeding    uuid.UUID
	inspection uuid.UUID
	treatment  uuid.UUID
}

func newWorkParityFixture(t *testing.T) *workParityFixture {
	t.Helper()
	base := newHiveScopeFixture(t)
	f := &workParityFixture{hiveScopeFixture: base}
	pool, ctx := base.server.pool, base.ctx

	// The base fixture grants editor on yard A only; yard B carries the
	// lockout, so the principal needs to see it.
	if _, err := pool.Exec(ctx, `
		INSERT INTO apiary_memberships (user_id, apiary_id, role)
		VALUES ($1,$2,'editor')`, base.editor.ID, base.apiaryB); err != nil {
		t.Fatalf("grant editor on B: %v", err)
	}
	if err := base.server.loadPrincipalMemberships(ctx, base.editor); err != nil {
		t.Fatalf("load actor memberships: %v", err)
	}

	// Registered before the first insert: a seed that fails part way still
	// has to clean up, or ai_recommendations_active_unique (type plus hive,
	// while not dismissed) makes every later test in the package fail too.
	t.Cleanup(func() {
		_, _ = pool.Exec(ctx, `DELETE FROM ai_recommendations WHERE hive_id IN ($1,$2)`,
			base.hiveA, base.hiveB)
		_, _ = pool.Exec(ctx, `DELETE FROM feedings WHERE hive_id IN ($1,$2)`,
			base.hiveA, base.hiveB)
		_, _ = pool.Exec(ctx, `DELETE FROM treatment_events WHERE hive_id IN ($1,$2)`,
			base.hiveA, base.hiveB)
	})

	treatmentDate := time.Now().UTC().AddDate(0, 0, -2)
	seed := []struct {
		into  *uuid.UUID
		query string
		args  []any
	}{
		{&f.recInspect, `
			INSERT INTO ai_recommendations (hive_id, type, message, priority, dismissed)
			VALUES ($1,'inspection_due','Overdue for a look','high',false) RETURNING id`,
			[]any{base.hiveA}},
		{&f.recFeeder, `
			INSERT INTO ai_recommendations (hive_id, type, message, priority, dismissed)
			VALUES ($1,'feeder_check','The feeder may be empty','normal',false) RETURNING id`,
			[]any{base.hiveA}},
		{&f.feeding, `
			INSERT INTO feedings (hive_id, date_fed, type, quantity, quantity_unit,
			                      feeder_type, status)
			VALUES ($1, now() - interval '94 days', 'sugar_syrup_1to1', 2, 'quarts',
			        'top', 'unverified') RETURNING id`,
			[]any{base.hiveA}},
		{&f.inspection, `
			INSERT INTO inspections (hive_id, date, stores_honey, notes)
			VALUES ($1, now() - interval '3 days', 5, 'full supers') RETURNING id`,
			[]any{base.hiveA}},
		{&f.treatment, `
			INSERT INTO treatment_events (hive_id, date_applied, product, withdrawal_days)
			VALUES ($1, $2, 'Apivar', 42) RETURNING id`,
			[]any{base.hiveB, treatmentDate}},
	}
	for _, row := range seed {
		if err := pool.QueryRow(ctx, row.query, row.args...).Scan(row.into); err != nil {
			t.Fatalf("seed: %v", err)
		}
	}
	return f
}

// mine restricts a payload to this fixture's own hives. Both endpoints read
// every yard the principal belongs to, and hive-less recommendations are
// visible to every user in the database, so another test's rows would
// otherwise make the comparison flap without either side being wrong. The
// hive-less catch-all yard is covered by the unit test instead
// (TestWorkYardViewCatchAll) because ai_recommendations_active_unique allows
// only one undismissed hive-less row of a given type at a time.
func (f *workParityFixture) mine(keys []workParityKey) []workParityKey {
	kept := make([]workParityKey, 0, len(keys))
	for _, key := range keys {
		if key.hive == f.hiveA.String() || key.hive == f.hiveB.String() {
			kept = append(kept, key)
		}
	}
	return kept
}

func (f *workParityFixture) workYard(t *testing.T) work.YardResponse {
	t.Helper()
	// These tests call the handler directly, so perform the authentication
	// edge's per-request snapshot before each request.
	if err := f.server.loadPrincipalMemberships(f.ctx, f.editor); err != nil {
		t.Fatalf("load actor memberships: %v", err)
	}
	response := f.call(t, f.server.handleWorkYard, http.MethodGet, "/work/yard", nil, nil)
	if response.Code != http.StatusOK {
		t.Fatalf("work/yard: status %d: %s", response.Code, response.Body.String())
	}
	var body work.YardResponse
	if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode work/yard: %v", err)
	}
	return body
}

func workYardKeys(f *workParityFixture, body work.YardResponse) []workParityKey {
	keys := make([]workParityKey, 0)
	for _, yard := range body.Yards {
		apiary := uuid.Nil.String()
		if yard.ApiaryID != nil {
			apiary = yard.ApiaryID.String()
		}
		for _, item := range yard.Items {
			key := workParityKey{
				apiary: apiary, kind: string(item.SourceType),
				title: item.Title, priority: item.Priority,
			}
			if item.Context.HiveID != nil {
				key.hive = item.Context.HiveID.String()
			}
			keys = append(keys, key)
		}
	}
	return f.mine(keys)
}

func TestWorkYardMatchesFrozenFixture(t *testing.T) {
	fixture := newWorkParityFixture(t)

	want := []workParityKey{
		{apiary: fixture.apiaryA.String(), kind: "feeding", hive: fixture.hiveA.String(), title: "Verify and close", priority: "urgent"},
		{apiary: fixture.apiaryA.String(), kind: "recommendation", hive: fixture.hiveA.String(), title: "Inspect this hive", priority: "high"},
		{apiary: fixture.apiaryA.String(), kind: "harvest_ready", hive: fixture.hiveA.String(), title: "Pull honey", priority: "normal"},
		{apiary: fixture.apiaryB.String(), kind: "lockout", hive: fixture.hiveB.String(), title: "This honey cannot be extracted/sold until 42 days after Apivar is removed", priority: "high"},
	}
	body := fixture.workYard(t)
	got := workYardKeys(fixture, body)

	if len(got) != len(want) {
		t.Fatalf("item count: got %d, want %d\n got: %+v\n want: %+v",
			len(got), len(want), got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("item %d differs:\n got:  %+v\n want: %+v", i, got[i], want[i])
		}
	}

	if body.AsOf.IsZero() {
		t.Error("asOf missing")
	}
	if body.Freshness.Origin != "server" || body.Freshness.Stale {
		t.Errorf("freshness = %+v, want a live server read", body.Freshness)
	}
}

// The projection's ids are stable across reads and derived from durable keys;
// the yard queue had none, which is what made snooze, dismiss and keyboard
// focus retention impossible.
func TestWorkYardIDsAreStableAcrossReads(t *testing.T) {
	fixture := newWorkParityFixture(t)

	ids := func() []string {
		out := make([]string, 0)
		for _, yard := range fixture.workYard(t).Yards {
			for _, item := range yard.Items {
				if item.Context.HiveID != nil &&
					*item.Context.HiveID != fixture.hiveA && *item.Context.HiveID != fixture.hiveB {
					continue
				}
				out = append(out, item.ID)
			}
		}
		return out
	}

	first, second := ids(), ids()
	if len(first) == 0 {
		t.Fatal("no items")
	}
	if len(first) != len(second) {
		t.Fatalf("count changed between reads: %v vs %v", first, second)
	}
	for i := range first {
		if first[i] != second[i] {
			t.Fatalf("id %d changed between reads: %q vs %q", i, first[i], second[i])
		}
		if first[i] == "" {
			t.Fatalf("item %d has no id", i)
		}
	}

	want := map[string]bool{
		"wi:recommendation:" + fixture.recInspect.String():                               true,
		"wi:feeding:" + fixture.feeding.String():                                         true,
		"wi:lockout:" + fixture.hiveB.String() + ":" + fixture.treatment.String():        true,
		"wi:harvest_ready:" + fixture.hiveA.String() + ":" + fixture.inspection.String(): true,
	}
	for _, id := range first {
		delete(want, id)
	}
	if len(want) > 0 {
		t.Fatalf("missing derived ids %v; got %v", want, first)
	}
}

// Section 4.6 end to end, and the reason wave 1 is a behaviour change: the
// seeded feeder_check is suppressed while hive A has a feeding item, and
// becomes visible the moment that feeding item goes away.
func TestWorkFeederCheckRuleAgainstTheDatabase(t *testing.T) {
	fixture := newWorkParityFixture(t)
	feederItemID := "wi:recommendation:" + fixture.recFeeder.String()
	feedingItemID := "wi:feeding:" + fixture.feeding.String()

	items := func() map[string]work.Item {
		out := map[string]work.Item{}
		for _, yard := range fixture.workYard(t).Yards {
			for _, item := range yard.Items {
				out[item.ID] = item
			}
		}
		return out
	}

	withFeeding := items()
	if _, ok := withFeeding[feederItemID]; ok {
		t.Error("feeder_check emitted while a feeding item covers the same hive")
	}
	feeding, ok := withFeeding[feedingItemID]
	if !ok {
		t.Fatal("feeding item missing")
	}
	if len(feeding.Supersedes) != 1 || feeding.Supersedes[0] != feederItemID {
		t.Fatalf("feeding.supersedes = %v, want [%s]", feeding.Supersedes, feederItemID)
	}

	// Close the feeder. The feeding item goes away and the recommendation is
	// now the only thing left saying anything about that feeder — which both
	// old assemblers dropped unconditionally, silently.
	if _, err := fixture.server.pool.Exec(fixture.ctx, `
		UPDATE feedings SET status='closed', closed_at=now(), closed_reason='test'
		WHERE id=$1`, fixture.feeding); err != nil {
		t.Fatalf("close feeder: %v", err)
	}

	withoutFeeding := items()
	if _, ok := withoutFeeding[feedingItemID]; ok {
		t.Fatal("feeding item survived closing the feeder")
	}
	orphan, ok := withoutFeeding[feederItemID]
	if !ok {
		t.Fatalf("orphan feeder_check not emitted: %v", withoutFeeding)
	}
	if orphan.Title != "Check the feeder" {
		t.Errorf("title = %q", orphan.Title)
	}
}

// /work/today is the same projection with a different grouping, and its
// commands are answered for the caller.
func TestWorkTodayEndpoint(t *testing.T) {
	fixture := newWorkParityFixture(t)

	response := fixture.call(t, fixture.server.handleWorkToday,
		http.MethodGet, "/work/today", nil, nil)
	if response.Code != http.StatusOK {
		t.Fatalf("status %d: %s", response.Code, response.Body.String())
	}
	var body work.TodayResponse
	if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(body.Groups) != 2 ||
		body.Groups[0].Key != "attention" || body.Groups[1].Key != "today" {
		t.Fatalf("groups = %+v", body.Groups)
	}
	if body.Counts.Attention+body.Counts.Today == 0 {
		t.Fatal("no items in either group")
	}

	// The fixture principal is an editor on both yards, so the apiary-scoped
	// commands are permitted and the admin-only harvest write is not.
	var sawFeeding, sawHarvest bool
	for _, group := range body.Groups {
		for _, item := range group.Items {
			if item.Context.HiveID == nil ||
				(*item.Context.HiveID != fixture.hiveA && *item.Context.HiveID != fixture.hiveB) {
				continue
			}
			for _, command := range item.Commands {
				switch command.ID {
				case "feeding.refill":
					sawFeeding = true
					if !command.Permitted {
						t.Errorf("editor refused feeding.refill: %v", command.DeniedReason)
					}
					if command.Offline != work.OfflineQueueable {
						t.Errorf("feeding.refill offline = %q", command.Offline)
					}
				case "harvest.record":
					sawHarvest = true
					if command.Permitted {
						t.Error("a non-admin editor was permitted harvest.record")
					}
					if command.DeniedReason == nil {
						t.Error("harvest.record refused with no reason")
					}
				}
			}
		}
	}
	if !sawFeeding || !sawHarvest {
		t.Errorf("commands not exercised: feeding=%v harvest=%v", sawFeeding, sawHarvest)
	}
}

// A yard the principal is not a member of contributes nothing, even though
// the projection is assembled in process rather than filtered only in SQL.
func TestWorkYardRespectsMembership(t *testing.T) {
	fixture := newWorkParityFixture(t)

	if _, err := fixture.server.pool.Exec(fixture.ctx,
		`DELETE FROM apiary_memberships WHERE user_id=$1 AND apiary_id=$2`,
		fixture.editor.ID, fixture.apiaryB); err != nil {
		t.Fatalf("revoke B: %v", err)
	}

	for _, yard := range fixture.workYard(t).Yards {
		for _, item := range yard.Items {
			if item.Context.HiveID != nil && *item.Context.HiveID == fixture.hiveB {
				t.Fatalf("hive B item leaked after the membership was revoked: %s", item.ID)
			}
		}
	}
}
