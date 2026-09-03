package work

import (
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/biker2000on/beez-trackz/backend/internal/app"
)

// allQueueable stands in for the offline route manifest in the tests that are
// not about offline disposition. The test that IS about it lives in
// internal/httpapi, where the real manifest is.
func allQueueable(string, string) bool { return true }

type fixtureIDs struct {
	apiaryA, apiaryB   uuid.UUID
	hiveA, hiveB       uuid.UUID
	feedingA           uuid.UUID
	recFeederA         uuid.UUID
	recInspectB        uuid.UUID
	treatmentB         uuid.UUID
	inspectionB        uuid.UUID
	editor, viewer     app.Actor
	admin, nonMember   app.Actor
	nameA, nameB       string
	hiveNameA, hiveNmB string
}

func newFixture(t *testing.T) fixtureIDs {
	t.Helper()
	f := fixtureIDs{
		apiaryA: uuid.MustParse("11111111-1111-4111-8111-111111111111"),
		apiaryB: uuid.MustParse("22222222-2222-4222-8222-222222222222"),
		hiveA:   uuid.MustParse("33333333-3333-4333-8333-333333333333"),
		hiveB:   uuid.MustParse("44444444-4444-4444-8444-444444444444"),
		feedingA: uuid.MustParse(
			"55555555-5555-4555-8555-555555555555"),
		recFeederA:  uuid.MustParse("66666666-6666-4666-8666-666666666666"),
		recInspectB: uuid.MustParse("77777777-7777-4777-8777-777777777777"),
		treatmentB:  uuid.MustParse("88888888-8888-4888-8888-888888888888"),
		inspectionB: uuid.MustParse("99999999-9999-4999-8999-999999999999"),
		nameA:       "North Ridge",
		nameB:       "River Bend",
		hiveNameA:   "A3",
		hiveNmB:     "B1",
	}
	user := uuid.MustParse("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
	f.admin = app.UserActor(user, "Admin").WithAccess(true, nil)
	f.editor = app.UserActor(user, "Editor").WithAccess(false, map[uuid.UUID]string{
		f.apiaryA: app.RoleEditor, f.apiaryB: app.RoleEditor,
	})
	f.viewer = app.UserActor(user, "Viewer").WithAccess(false, map[uuid.UUID]string{
		f.apiaryA: app.RoleViewer, f.apiaryB: app.RoleViewer,
	})
	f.nonMember = app.UserActor(user, "Stranger").WithAccess(false, nil)
	return f
}

// inputs builds a read covering all four sources. withFeeding controls
// whether hive A has a feeding item, which is the pivot of the feeder_check
// rule.
func (f fixtureIDs) inputs(asOf time.Time, withFeeding bool) Inputs {
	observed := asOf.Add(-94 * 24 * time.Hour)
	in := Inputs{
		AsOf: asOf,
		Recommendations: []RecommendationFact{
			{
				ID: f.recFeederA, Type: "feeder_check",
				Message: "Feeder may be empty", Priority: "normal",
				CreatedAt: observed,
				HiveID:    ptr(f.hiveA), HiveName: ptr(f.hiveNameA),
				ApiaryID: ptr(f.apiaryA), ApiaryName: ptr(f.nameA),
			},
			{
				ID: f.recInspectB, Type: "inspection_due",
				Message: "Overdue for a look", Priority: "high",
				CreatedAt: observed,
				HiveID:    ptr(f.hiveB), HiveName: ptr(f.hiveNmB),
				ApiaryID: ptr(f.apiaryB), ApiaryName: ptr(f.nameB),
			},
		},
		Lockouts: []LockoutFact{{
			TreatmentEventID: f.treatmentB,
			HiveID:           f.hiveB, HiveName: f.hiveNmB,
			ApiaryID: f.apiaryB, ApiaryName: f.nameB,
			Title:       "This honey cannot be extracted/sold until 2026-09-20",
			Detail:      "Apivar off 2026-08-20 · 30-day withdrawal",
			DateApplied: observed,
		}},
		HarvestReady: []HarvestReadyFact{{
			InspectionID: f.inspectionB,
			HiveID:       f.hiveB, HiveName: f.hiveNmB,
			ApiaryID: f.apiaryB, ApiaryName: f.nameB,
			Detail: "Stores 4/5 · not locked out", InspectedAt: observed,
		}},
	}
	if withFeeding {
		in.Feedings = []FeedingFact{{
			FeedingID: f.feedingA,
			HiveID:    f.hiveA, HiveName: f.hiveNameA,
			ApiaryID: f.apiaryA, ApiaryName: f.nameA,
			State: "attention", Action: "Verify and close",
			Evidence:   "Feeder on A3 open 94 days with no refill",
			ObservedAt: &observed,
		}}
	}
	return in
}

func ptr[T any](value T) *T { return &value }

func idsOf(items []Item) []string {
	out := make([]string, 0, len(items))
	for _, item := range items {
		out = append(out, item.ID)
	}
	return out
}

func find(items []Item, id string) (Item, bool) {
	for _, item := range items {
		if item.ID == id {
			return item, true
		}
	}
	return Item{}, false
}

// A projection id must survive a re-read: it is what snooze, dismiss,
// keyboard focus retention and offline receipt correlation hold on to. The
// yard queue this replaces had none, so every refetch reshuffled identity.
func TestWorkItemIDStableAcrossReads(t *testing.T) {
	t.Parallel()
	f := newFixture(t)
	first := Build(f.inputs(time.Date(2026, 9, 3, 12, 0, 0, 0, time.UTC), true),
		f.admin, Filter{}, allQueueable)
	// A second read at a different instant, with the facts in a different
	// order — nothing about the read may enter the id.
	second := f.inputs(time.Date(2026, 9, 3, 18, 30, 0, 0, time.UTC), true)
	second.Recommendations[0], second.Recommendations[1] =
		second.Recommendations[1], second.Recommendations[0]
	secondItems := Build(second, f.admin, Filter{}, allQueueable)

	firstIDs, secondIDs := idsOf(first), idsOf(secondItems)
	if len(firstIDs) == 0 {
		t.Fatal("first read produced no items")
	}
	if len(firstIDs) != len(secondIDs) {
		t.Fatalf("item count changed: %v vs %v", firstIDs, secondIDs)
	}
	for i := range firstIDs {
		if firstIDs[i] != secondIDs[i] {
			t.Fatalf("id %d changed between reads: %q vs %q", i, firstIDs[i], secondIDs[i])
		}
	}

	// And the ids are derived from durable keys, not from position.
	want := map[string]string{
		"wi:feeding:" + f.feedingA.String():                                   "feeding",
		"wi:recommendation:" + f.recInspectB.String():                         "recommendation",
		"wi:lockout:" + f.hiveB.String() + ":" + f.treatmentB.String():        "lockout",
		"wi:harvest_ready:" + f.hiveB.String() + ":" + f.inspectionB.String(): "harvest_ready",
	}
	for id, sourceType := range want {
		item, ok := find(first, id)
		if !ok {
			t.Fatalf("missing item %s; got %v", id, firstIDs)
		}
		if string(item.SourceType) != sourceType {
			t.Errorf("%s sourceType = %q, want %q", id, item.SourceType, sourceType)
		}
	}
}

// Section 4.6, direction one: a feeding item for the same hive is present, so
// the feeder_check recommendation is folded into it.
func TestWorkFeederCheckSuppressedByFeedingItem(t *testing.T) {
	t.Parallel()
	f := newFixture(t)
	items := Build(f.inputs(time.Now(), true), f.admin, Filter{}, allQueueable)

	recID := "wi:recommendation:" + f.recFeederA.String()
	if _, ok := find(items, recID); ok {
		t.Fatalf("feeder_check should be suppressed while a feeding item exists: %v", idsOf(items))
	}
	feeding, ok := find(items, "wi:feeding:"+f.feedingA.String())
	if !ok {
		t.Fatal("feeding item missing")
	}
	if len(feeding.Supersedes) != 1 || feeding.Supersedes[0] != recID {
		t.Fatalf("feeding.supersedes = %v, want [%s]", feeding.Supersedes, recID)
	}
}

// Section 4.6, direction two, and the deliberate behaviour change: with no
// feeding item for the hive, the feeder_check recommendation is emitted.
// Both assemblers this replaces dropped it unconditionally, so this item was
// invisible on every surface and nothing said so.
func TestWorkFeederCheckEmittedWithoutFeedingItem(t *testing.T) {
	t.Parallel()
	f := newFixture(t)
	items := Build(f.inputs(time.Now(), false), f.admin, Filter{}, allQueueable)

	recID := "wi:recommendation:" + f.recFeederA.String()
	item, ok := find(items, recID)
	if !ok {
		t.Fatalf("orphan feeder_check should be emitted: %v", idsOf(items))
	}
	if item.Title != "Check the feeder" {
		t.Errorf("title = %q, want %q", item.Title, "Check the feeder")
	}
	for _, other := range items {
		if len(other.Supersedes) != 0 {
			t.Errorf("%s supersedes %v with nothing suppressed", other.ID, other.Supersedes)
		}
	}
}

// A feeding item on a DIFFERENT hive must not suppress the recommendation:
// the rule is per hive, not per response.
func TestWorkFeederCheckIsPerHive(t *testing.T) {
	t.Parallel()
	f := newFixture(t)
	in := f.inputs(time.Now(), true)
	in.Feedings[0].HiveID = f.hiveB
	in.Feedings[0].HiveName = f.hiveNmB
	in.Feedings[0].ApiaryID = f.apiaryB
	in.Feedings[0].ApiaryName = f.nameB

	items := Build(in, f.admin, Filter{}, allQueueable)
	if _, ok := find(items, "wi:recommendation:"+f.recFeederA.String()); !ok {
		t.Fatalf("feeder_check on hive A suppressed by a feeding on hive B: %v", idsOf(items))
	}
}

// Section 4.4: a viewer sees the item and is told, per command, that they may
// not act; a non-member does not see the item at all.
func TestWorkPermissionFiltering(t *testing.T) {
	t.Parallel()
	f := newFixture(t)
	in := f.inputs(time.Now(), true)

	cases := []struct {
		name       string
		actor      app.Actor
		wantItems  int
		wantAction bool
	}{
		{"admin", f.admin, 4, true},
		{"editor", f.editor, 4, true},
		{"viewer", f.viewer, 4, false},
		{"non-member", f.nonMember, 0, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			items := Build(in, tc.actor, Filter{}, allQueueable)
			if len(items) != tc.wantItems {
				t.Fatalf("items = %d (%v), want %d", len(items), idsOf(items), tc.wantItems)
			}
			for _, item := range items {
				for _, command := range item.Commands {
					// harvest.record needs admin, not editor, so it is
					// only permitted for the admin actor.
					want := tc.wantAction
					if command.ID == "harvest.record" {
						want = tc.actor.MayAdminister()
					}
					if command.Permitted != want {
						t.Errorf("%s %s permitted = %v, want %v",
							item.ID, command.ID, command.Permitted, want)
					}
					if !command.Permitted && command.DeniedReason == nil {
						t.Errorf("%s %s denied with no reason", item.ID, command.ID)
					}
					if command.Permitted && command.DeniedReason != nil {
						t.Errorf("%s %s permitted but carries reason %q",
							item.ID, command.ID, *command.DeniedReason)
					}
				}
			}
		})
	}
}

// A viewer's denial names the yard, so the UI does not have to invent a
// message and the operator knows which membership is missing.
func TestWorkDeniedReasonNamesTheYard(t *testing.T) {
	t.Parallel()
	f := newFixture(t)
	items := Build(f.inputs(time.Now(), true), f.viewer, Filter{}, allQueueable)
	feeding, ok := find(items, "wi:feeding:"+f.feedingA.String())
	if !ok {
		t.Fatal("feeding item missing for viewer")
	}
	if len(feeding.Commands) == 0 || feeding.Commands[0].DeniedReason == nil {
		t.Fatal("expected a denied command")
	}
	if got := *feeding.Commands[0].DeniedReason; got != "editor access on North Ridge is required" {
		t.Errorf("deniedReason = %q", got)
	}
}

// sortRank is yardQueueRank (yard_queue.go:343-366) moved, not rewritten.
func TestWorkSortRankMatchesYardQueueRank(t *testing.T) {
	t.Parallel()
	cases := []struct {
		sourceType SourceType
		priority   string
		want       int
	}{
		{SourceLockout, "high", 0},
		{SourceRecommendation, "urgent", 1},
		{SourceRecommendation, "high", 2},
		{SourceRecommendation, "normal", 4},
		{SourceRecommendation, "low", 4},
		{SourceFeeding, "urgent", 1},
		{SourceFeeding, "high", 3},
		{SourceHarvestReady, "normal", 5},
		{SourceType("other"), "", 6},
	}
	for _, tc := range cases {
		if got := sortRank(tc.sourceType, tc.priority); got != tc.want {
			t.Errorf("sortRank(%s/%s) = %d, want %d", tc.sourceType, tc.priority, got, tc.want)
		}
	}
}

// Ordering is rank first, then the hive the work is on.
func TestWorkOrdering(t *testing.T) {
	t.Parallel()
	f := newFixture(t)
	items := Build(f.inputs(time.Now(), true), f.admin, Filter{}, allQueueable)
	want := []string{
		"wi:lockout:" + f.hiveB.String() + ":" + f.treatmentB.String(),
		"wi:feeding:" + f.feedingA.String(),
		"wi:recommendation:" + f.recInspectB.String(),
		"wi:harvest_ready:" + f.hiveB.String() + ":" + f.inspectionB.String(),
	}
	got := idsOf(items)
	if len(got) != len(want) {
		t.Fatalf("items = %v, want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("order = %v, want %v", got, want)
		}
	}
}

// Today's two groups are a threshold on the one rank, not a second rule.
func TestWorkTodayGrouping(t *testing.T) {
	t.Parallel()
	f := newFixture(t)
	asOf := time.Now()
	response := Today(asOf, Build(f.inputs(asOf, true), f.admin, Filter{}, allQueueable))

	if !response.AsOf.Equal(asOf) {
		t.Errorf("asOf = %v, want %v", response.AsOf, asOf)
	}
	if response.Freshness.Origin != "server" || response.Freshness.Stale {
		t.Errorf("freshness = %+v, want a live server read", response.Freshness)
	}
	if len(response.Groups) != 2 {
		t.Fatalf("groups = %d, want 2", len(response.Groups))
	}
	// lockout (0) and feeding attention (1) need attention; the high
	// recommendation is rank 2 and also attention; harvest-ready (5) is not.
	if response.Counts.Attention != 3 || response.Counts.Today != 1 {
		t.Errorf("counts = %+v, want attention 3 / today 1", response.Counts)
	}
	for _, item := range response.Groups[0].Items {
		if item.SortRank > attentionRankCeiling {
			t.Errorf("%s (rank %d) is in the attention group", item.ID, item.SortRank)
		}
	}
	for _, item := range response.Groups[1].Items {
		if item.SortRank <= attentionRankCeiling {
			t.Errorf("%s (rank %d) is in the today group", item.ID, item.SortRank)
		}
	}
}

// Hive-less recommendations keep their catch-all yard, which is the only
// thing that makes them visible at all.
func TestWorkYardViewCatchAll(t *testing.T) {
	t.Parallel()
	f := newFixture(t)
	asOf := time.Now()
	in := f.inputs(asOf, true)
	free := uuid.MustParse("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb")
	in.Recommendations = append(in.Recommendations, RecommendationFact{
		ID: free, Type: "seasonal_prep", Message: "Wrap the yards",
		Priority: "normal", CreatedAt: asOf,
	})

	response := YardView(asOf, Build(in, f.admin, Filter{}, allQueueable))
	if len(response.Yards) != 3 {
		t.Fatalf("yards = %d, want 3", len(response.Yards))
	}
	last := response.Yards[len(response.Yards)-1]
	if last.ApiaryID != nil || last.ApiaryName != "All yards" {
		t.Fatalf("catch-all yard = %+v, want the hive-less yard last", last)
	}
	if len(last.Items) != 1 || last.Items[0].ID != "wi:recommendation:"+free.String() {
		t.Fatalf("catch-all items = %v", idsOf(last.Items))
	}
	// Named yards sort by name: North Ridge before River Bend.
	if response.Yards[0].ApiaryName != "North Ridge" ||
		response.Yards[1].ApiaryName != "River Bend" {
		t.Errorf("yard order = %q, %q",
			response.Yards[0].ApiaryName, response.Yards[1].ApiaryName)
	}
	if response.Yards[1].Counts.High != 2 {
		t.Errorf("River Bend high count = %d, want 2 (lockout + inspection_due)",
			response.Yards[1].Counts.High)
	}
}

// A hive-less recommendation cannot be acted on by a non-admin: there is no
// apiary to hold a membership on.
func TestWorkHiveLessRecommendationNeedsAdmin(t *testing.T) {
	t.Parallel()
	f := newFixture(t)
	asOf := time.Now()
	in := Inputs{AsOf: asOf, Recommendations: []RecommendationFact{{
		ID:   uuid.MustParse("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"),
		Type: "seasonal_prep", Message: "Wrap the yards",
		Priority: "normal", CreatedAt: asOf,
	}}}
	for _, tc := range []struct {
		name  string
		actor app.Actor
		want  bool
	}{{"admin", f.admin, true}, {"editor", f.editor, false}} {
		items := Build(in, tc.actor, Filter{}, allQueueable)
		if len(items) != 1 {
			t.Fatalf("%s: items = %d, want 1", tc.name, len(items))
		}
		if items[0].Commands[0].Permitted != tc.want {
			t.Errorf("%s: permitted = %v, want %v",
				tc.name, items[0].Commands[0].Permitted, tc.want)
		}
	}
}

// Snoozed and dismissed rows are only returned when they are asked for, and
// their status is derived from the row rather than from the SQL predicate
// that selected it.
func TestWorkStatusFilter(t *testing.T) {
	t.Parallel()
	f := newFixture(t)
	asOf := time.Date(2026, 9, 3, 12, 0, 0, 0, time.UTC)
	in := f.inputs(asOf, false)
	later := asOf.Add(48 * time.Hour)
	in.Recommendations[1].SnoozedUntil = &later

	open := Build(in, f.admin, Filter{}, allQueueable)
	if _, ok := find(open, "wi:recommendation:"+f.recInspectB.String()); ok {
		t.Error("snoozed recommendation returned by the default open filter")
	}

	all := Build(in, f.admin, Filter{Statuses: []string{"open", "snoozed"}}, allQueueable)
	item, ok := find(all, "wi:recommendation:"+f.recInspectB.String())
	if !ok {
		t.Fatal("snoozed recommendation missing when asked for")
	}
	if item.Status != StatusSnoozed {
		t.Errorf("status = %q, want snoozed", item.Status)
	}
	if item.DueAt == nil || !item.DueAt.Equal(later) {
		t.Errorf("dueAt = %v, want the snooze end %v", item.DueAt, later)
	}
	if Today(asOf, all).Counts.Snoozed != 1 {
		t.Error("snoozed count did not follow the item")
	}
}

// sourceType and apiaryId narrow the same projection; /today/recommendations
// is this filter, not a separate inbox.
func TestWorkSourceAndApiaryFilters(t *testing.T) {
	t.Parallel()
	f := newFixture(t)
	asOf := time.Now()
	in := f.inputs(asOf, true)

	recs := Build(in, f.admin, Filter{SourceTypes: []string{"recommendation"}}, allQueueable)
	if len(recs) != 1 || recs[0].SourceType != SourceRecommendation {
		t.Fatalf("sourceType filter = %v", idsOf(recs))
	}

	yardA := Build(in, f.admin, Filter{ApiaryID: &f.apiaryA}, allQueueable)
	if len(yardA) != 1 || yardA[0].ID != "wi:feeding:"+f.feedingA.String() {
		t.Fatalf("apiaryId filter = %v", idsOf(yardA))
	}
}

// Every item carries the read's asOf and a live freshness stamp (section 4.5).
func TestWorkItemFreshness(t *testing.T) {
	t.Parallel()
	f := newFixture(t)
	asOf := time.Date(2026, 9, 3, 12, 0, 0, 0, time.UTC)
	for _, item := range Build(f.inputs(asOf, true), f.admin, Filter{}, allQueueable) {
		if !item.AsOf.Equal(asOf) {
			t.Errorf("%s asOf = %v, want %v", item.ID, item.AsOf, asOf)
		}
		if item.Freshness.Origin != "server" || item.Freshness.Stale ||
			item.Freshness.CachedAt != nil {
			t.Errorf("%s freshness = %+v", item.ID, item.Freshness)
		}
		if len(item.Evidence) == 0 {
			t.Errorf("%s has no evidence", item.ID)
		}
	}
}

// With no offline manifest the projection under-promises rather than
// over-promises: nothing is advertised as queueable.
func TestWorkOfflineDefaultsToOnlineOnly(t *testing.T) {
	t.Parallel()
	f := newFixture(t)
	for _, item := range Build(f.inputs(time.Now(), true), f.admin, Filter{}, nil) {
		for _, command := range item.Commands {
			if command.Offline != OfflineOnlyOnline || command.OfflineReason == nil {
				t.Errorf("%s %s offline = %q with no manifest",
					item.ID, command.ID, command.Offline)
			}
		}
	}
}

// Every command binds its idempotency key to the projection id, so a
// replayed offline mutation resolves to the same command identity (5.1).
func TestWorkIdempotencyKeyTemplates(t *testing.T) {
	t.Parallel()
	f := newFixture(t)
	for _, item := range Build(f.inputs(time.Now(), true), f.admin, Filter{}, allQueueable) {
		for _, command := range item.Commands {
			want := item.ID + ":" + command.ID + ":{clientMutationId}"
			if command.IdempotencyKeyTemplate != want {
				t.Errorf("%s %s key = %q, want %q",
					item.ID, command.ID, command.IdempotencyKeyTemplate, want)
			}
		}
	}
}

// The actor extension must not have leaked the restore privilege into an
// end-user admin (app/doc.go, "Actors").
func TestWorkAdminIsNotAuditPrivilege(t *testing.T) {
	t.Parallel()
	f := newFixture(t)
	if f.admin.MayWritePreservedAudit() {
		t.Fatal("an admin user must not hold MayWritePreservedAudit")
	}
	if app.SystemJobActor("worker").WithAccess(true, nil).MayAdminister() {
		t.Fatal("a background job acquired end-user admin through WithAccess")
	}
	if !app.SystemRestoreActor(uuid.Nil).MayWritePreservedAudit() {
		t.Fatal("the restore actor lost its privilege")
	}
}

// Memberships are copied into the actor, so a per-request cache cannot be
// mutated through one.
func TestWorkActorCopiesMemberships(t *testing.T) {
	t.Parallel()
	apiary := uuid.New()
	source := map[uuid.UUID]string{apiary: app.RoleEditor}
	actor := app.UserActor(uuid.New(), "Editor").WithAccess(false, source)
	source[apiary] = app.RoleViewer
	if !actor.MayEditApiary(apiary) {
		t.Fatal("mutating the source map changed the actor")
	}
}
