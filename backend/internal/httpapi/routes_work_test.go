package httpapi

import (
	"net/http/httptest"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/biker2000on/beez-trackz/backend/internal/app"
	"github.com/biker2000on/beez-trackz/backend/internal/app/work"
)

// workProbeInputs is one fact of every source type, enough to emit every
// command the field slice knows how to build.
func workProbeInputs(asOf time.Time) (work.Inputs, uuid.UUID) {
	apiaryID := uuid.New()
	hiveID := uuid.New()
	return work.Inputs{
		AsOf: asOf,
		Recommendations: []work.RecommendationFact{
			{
				ID: uuid.New(), Type: "inspection_due", Message: "Overdue",
				Priority: "high", CreatedAt: asOf,
				HiveID: &hiveID, ApiaryID: &apiaryID,
			},
			{
				// A dismissed row emits the restore command instead.
				ID: uuid.New(), Type: "seasonal_prep", Message: "Wrap up",
				Priority: "normal", CreatedAt: asOf, Dismissed: true,
				HiveID: &hiveID, ApiaryID: &apiaryID,
			},
		},
		Feedings: []work.FeedingFact{{
			FeedingID: uuid.New(), HiveID: hiveID, ApiaryID: apiaryID,
			State: "attention", Action: "Verify and close", Evidence: "94 days",
		}},
		Lockouts: []work.LockoutFact{{
			TreatmentEventID: uuid.New(), HiveID: hiveID, ApiaryID: apiaryID,
			Title: "Locked out", Detail: "Apivar", DateApplied: asOf,
		}},
		HarvestReady: []work.HarvestReadyFact{{
			InspectionID: uuid.New(), HiveID: hiveID, ApiaryID: apiaryID,
			Detail: "Stores 4/5", InspectedAt: asOf,
		}},
	}, apiaryID
}

// The acceptance criterion for wave 1: no work item may advertise a
// queueable command the service worker would refuse to queue. The projection
// computes offline disposition from offlineRoutes.supports — the manifest the
// service worker is generated from — so this test asserts the two cannot
// diverge for any command the field slice emits.
func TestWorkCommandOfflineMatchesRouteManifest(t *testing.T) {
	t.Parallel()
	asOf := time.Now()
	inputs, _ := workProbeInputs(asOf)
	actor := app.UserActor(uuid.New(), "Admin").WithAccess(true, nil)
	items := work.Build(inputs, actor,
		work.Filter{Statuses: []string{"open", "snoozed", "dismissed"}},
		offlineRoutes.supports)

	var queueable, onlineOnly, commands int
	for _, item := range items {
		for _, command := range item.Commands {
			commands++
			want := work.OfflineOnlyOnline
			if offlineRoutes.supports(command.Method, command.Path) {
				want = work.OfflineQueueable
			}
			if command.Offline != want {
				t.Errorf("%s %s (%s %s): offline = %q, manifest says %q",
					item.ID, command.ID, command.Method, command.Path,
					command.Offline, want)
			}
			switch command.Offline {
			case work.OfflineQueueable:
				queueable++
				if command.OfflineReason != nil {
					t.Errorf("%s %s is queueable but carries a reason",
						item.ID, command.ID)
				}
			case work.OfflineOnlyOnline:
				onlineOnly++
				if command.OfflineReason == nil {
					t.Errorf("%s %s is online_only with no reason",
						item.ID, command.ID)
				}
			}
		}
	}
	if commands == 0 {
		t.Fatal("no commands were emitted, so nothing was checked")
	}
	// Both dispositions must actually occur, or the check above is vacuous:
	// POST /harvest-sessions is an offline POST exclusion and is the field
	// slice's online-only command.
	if queueable == 0 || onlineOnly == 0 {
		t.Fatalf("queueable = %d, online_only = %d; expected both to occur",
			queueable, onlineOnly)
	}
}

// A command must never point at a path the manifest would match by accident
// through a prefix that is not the route it names.
func TestWorkOnlineOnlyCommandIsTheHarvestSession(t *testing.T) {
	t.Parallel()
	asOf := time.Now()
	inputs, _ := workProbeInputs(asOf)
	actor := app.UserActor(uuid.New(), "Admin").WithAccess(true, nil)
	items := work.Build(inputs, actor, work.Filter{}, offlineRoutes.supports)

	for _, item := range items {
		for _, command := range item.Commands {
			if command.Offline != work.OfflineOnlyOnline {
				continue
			}
			if command.ID != "harvest.start_session" {
				t.Errorf("unexpected online-only command %s (%s %s)",
					command.ID, command.Method, command.Path)
			}
		}
	}
}

func TestWorkFilterParsing(t *testing.T) {
	t.Parallel()
	apiaryID := uuid.New()
	request := httptest.NewRequest("GET", "/work/today?status=open,snoozed&status=dismissed"+
		"&sourceType=recommendation&priority=urgent&apiaryId="+apiaryID.String(), nil)
	filter, err := workFilter(request)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if got := len(filter.Statuses); got != 3 {
		t.Errorf("statuses = %v, want three across both forms", filter.Statuses)
	}
	if len(filter.SourceTypes) != 1 || filter.SourceTypes[0] != "recommendation" {
		t.Errorf("sourceTypes = %v", filter.SourceTypes)
	}
	if len(filter.Priorities) != 1 || filter.Priorities[0] != "urgent" {
		t.Errorf("priorities = %v", filter.Priorities)
	}
	if filter.ApiaryID == nil || *filter.ApiaryID != apiaryID {
		t.Errorf("apiaryId = %v, want %s", filter.ApiaryID, apiaryID)
	}

	if _, err := workFilter(httptest.NewRequest("GET", "/work/today?apiaryId=nope", nil)); err == nil {
		t.Error("a malformed apiaryId should be a 400, not a silent full read")
	}
}

// The recommendation read widens only when a non-open status is asked for,
// so the default field read keeps the pending predicate the yard queue uses.
func TestWorkRecommendationWhere(t *testing.T) {
	t.Parallel()
	if got := workRecommendationWhere(work.Filter{}); got != recPendingWhere {
		t.Errorf("default predicate = %q, want recPendingWhere", got)
	}
	if got := workRecommendationWhere(work.Filter{Statuses: []string{"open"}}); got != recPendingWhere {
		t.Errorf("open-only predicate = %q, want recPendingWhere", got)
	}
	if got := workRecommendationWhere(work.Filter{Statuses: []string{"open", "dismissed"}}); got != "TRUE" {
		t.Errorf("widened predicate = %q, want TRUE", got)
	}
}
