package work

import (
	"time"

	"github.com/google/uuid"
)

// The fact types below are the projection's input contract. They are what the
// transport edge reads; nothing here knows how to read them, which is what
// keeps the lockout walk and the feeding-status evaluation in one place each.

// RecommendationFact is one ai_recommendations row plus its hive and apiary.
// A recommendation may have no hive (a seasonal note for the whole
// operation), which is why every location field is a pointer.
type RecommendationFact struct {
	ID         uuid.UUID
	Type       string
	Message    string
	Priority   string
	CreatedAt  time.Time
	HiveID     *uuid.UUID
	HiveName   *string
	ApiaryID   *uuid.UUID
	ApiaryName *string

	Dismissed    bool
	SnoozedUntil *time.Time
}

// status derives the triage state (§4.2) from the row's own columns, using
// the same predicate the recommendation views use (recPendingWhere).
func (f RecommendationFact) status(now time.Time) string {
	switch {
	case f.Dismissed:
		return StatusDismissed
	case f.SnoozedUntil != nil && f.SnoozedUntil.After(now):
		return StatusSnoozed
	default:
		return StatusOpen
	}
}

// FeedingFact is one hive's feeding status row, already evaluated. FeedingID
// is the row the action applies to — routes_feedings_status.go's
// actionFeedingId, not the hive id the old client used as a key
// (hooks.ts:118), which silently changed meaning when the feeder was
// replaced.
type FeedingFact struct {
	FeedingID  uuid.UUID
	HiveID     uuid.UUID
	HiveName   string
	ApiaryID   uuid.UUID
	ApiaryName string

	State      string // attention | stale
	Action     string
	Evidence   string
	ObservedAt *time.Time
}

// priority mirrors yard_queue.go:196-200: a feeder needing a field decision
// is urgent, one merely due for a level check is high.
func (f FeedingFact) priority() string {
	if f.State == "attention" {
		return "urgent"
	}
	return "high"
}

// LockoutFact is one hive's active withdrawal window. A lockout is a
// recomputed walk over treatment events, not a row, so TreatmentEventID — the
// treatment that causes it — is the durable key the item is derived from.
type LockoutFact struct {
	TreatmentEventID uuid.UUID
	HiveID           uuid.UUID
	HiveName         string
	ApiaryID         uuid.UUID
	ApiaryName       string

	Title       string // lockoutMessage
	Detail      string // hiveLockoutDetail
	Until       *time.Time
	DateApplied time.Time
}

// HarvestReadyFact is a hive whose latest inspection reported full stores and
// which is not locked out. InspectionID is the reading it came from, so a
// re-read is the same item and a new inspection is a new one.
type HarvestReadyFact struct {
	InspectionID uuid.UUID
	HiveID       uuid.UUID
	HiveName     string
	ApiaryID     uuid.UUID
	ApiaryName   string

	Detail      string
	InspectedAt time.Time
}

// Inputs is everything one projection read produced. AsOf is the read's
// transaction time and becomes both the response asOf and every item's asOf
// (§4.5) — the facts were all read together.
type Inputs struct {
	AsOf            time.Time
	Recommendations []RecommendationFact
	Feedings        []FeedingFact
	Lockouts        []LockoutFact
	HarvestReady    []HarvestReadyFact
}

// recommendationTitle is yardQueueRecTitle (yard_queue.go:322-341) with one
// addition: feeder_check now has a title, because under the §4.6 rule it can
// actually be emitted. Both old assemblers dropped the type unconditionally,
// so it never needed one.
func recommendationTitle(recType string) string {
	switch recType {
	case "treat_now":
		return "Treat for Varroa"
	case "mite_check_due":
		return "Sample for mites"
	case "inspection_due":
		return "Inspect this hive"
	case "treatment_reminder":
		return "Review treatment"
	case "equipment_needed":
		return "Add equipment"
	case "seasonal_prep":
		return "Seasonal prep"
	case "feeder_check":
		return "Check the feeder"
	default:
		return "Review"
	}
}
