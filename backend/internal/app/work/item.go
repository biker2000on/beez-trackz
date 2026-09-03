package work

import (
	"time"

	"github.com/google/uuid"
)

// SourceType names the durable domain a work item was derived from. The field
// slice has four; Production and Sales add more without changing the shape.
type SourceType string

const (
	SourceRecommendation SourceType = "recommendation"
	SourceFeeding        SourceType = "feeding"
	SourceLockout        SourceType = "lockout"
	SourceHarvestReady   SourceType = "harvest_ready"
)

// Item statuses. Only recommendations currently carry a state other than
// open; the other three sources are recomputed facts that exist while they
// are true and vanish when they are not.
const (
	StatusOpen      = "open"
	StatusSnoozed   = "snoozed"
	StatusDismissed = "dismissed"
	StatusDone      = "done"
)

// Offline dispositions.
const (
	OfflineQueueable  = "queueable"
	OfflineOnlyOnline = "online_only"
)

// Context is where the item is, so the phone can group and the operator can
// walk to it. LocationID is always nil in the field slice; Production and
// Sales items set it.
type Context struct {
	ApiaryID   *uuid.UUID `json:"apiaryId"`
	ApiaryName *string    `json:"apiaryName"`
	HiveID     *uuid.UUID `json:"hiveId"`
	HiveName   *string    `json:"hiveName"`
	LocationID *uuid.UUID `json:"locationId"`
}

// Evidence is why. Never advice without a fact: every entry names the record
// the claim came from and when it was observed, so the operator can go and
// check it.
type Evidence struct {
	Text       string     `json:"text"`
	SourceType SourceType `json:"sourceType"`
	SourceID   string     `json:"sourceId"`
	ObservedAt *time.Time `json:"observedAt"`
}

// Command is one thing that can be done about an item, already answered for
// this actor (Permitted) and this transport (Offline).
type Command struct {
	ID           string         `json:"id"`
	Label        string         `json:"label"`
	Method       string         `json:"method"`
	Path         string         `json:"path"`
	BodyTemplate map[string]any `json:"bodyTemplate"`

	// Permitted is this actor's answer, not the route's. DeniedReason says
	// what is missing in words the field UI can render next to the button.
	Permitted    bool    `json:"permitted"`
	DeniedReason *string `json:"deniedReason"`

	// Offline is queueable or online_only, decided by the offline route
	// manifest and never by this package's opinion of the command.
	Offline       string  `json:"offline"`
	OfflineReason *string `json:"offlineReason"`

	// IdempotencyKeyTemplate binds a replayed offline mutation to this
	// command identity (§5.1). The client substitutes its mutation id for
	// {clientMutationId}.
	IdempotencyKeyTemplate string `json:"idempotencyKeyTemplate"`

	// Keyboard is the action-center key that runs this command (D8).
	Keyboard string `json:"keyboard"`
}

// Item is the projection. One shape for every surface: Today, the yard queue,
// and later the Production and Sales workbenches.
type Item struct {
	ID         string     `json:"id"`
	SourceType SourceType `json:"sourceType"`
	SourceID   string     `json:"sourceId"`
	Context    Context    `json:"context"`
	Title      string     `json:"title"`
	Evidence   []Evidence `json:"evidence"`
	Priority   string     `json:"priority"`
	Status     string     `json:"status"`
	DueAt      *time.Time `json:"dueAt"`

	// Supersedes lists the projection ids this item stands in for. The
	// feeder_check rule (§4.6) is the only producer in the field slice.
	Supersedes []string `json:"supersedes"`

	AsOf      time.Time `json:"asOf"`
	Freshness Freshness `json:"freshness"`
	Commands  []Command `json:"commands"`
	SortRank  int       `json:"sortRank"`

	// recType is the ai_recommendations.type behind a recommendation item.
	// It is not part of the wire contract — the client reads sourceType and
	// title — but the feeder_check rule needs it after derivation.
	recType string
}

// Freshness distinguishes a live server read from a cached one. The server
// always reports origin "server"; only the service-worker cache path sets
// origin "cache", stale, and cachedAt (§4.5, wave 2).
type Freshness struct {
	Origin   string     `json:"origin"`
	CachedAt *time.Time `json:"cachedAt"`
	Stale    bool       `json:"stale"`
}

// ServerFreshness is what a live response carries.
func ServerFreshness() Freshness {
	return Freshness{Origin: "server", CachedAt: nil, Stale: false}
}

// itemID derives the stable projection id (§4.3):
//
//	id = "wi:" + sourceType + ":" + sourceId [+ ":" + facet]
//
// sourceID is always a durable primary key, and facet disambiguates several
// items derived from one row. Two reads of the same fact must produce the
// same id or snooze, dismiss, focus retention and offline receipt
// correlation all break — which is exactly the state the yard queue was in.
func itemID(sourceType SourceType, sourceID string, facet ...string) string {
	id := "wi:" + string(sourceType) + ":" + sourceID
	for _, part := range facet {
		id += ":" + part
	}
	return id
}

// sortRank is yardQueueRank (yard_queue.go:343-366) moved into the
// projection, unchanged: lockout first, then anything urgent, then high
// recommendations, then feeding, then normal recommendations, then
// harvest-ready.
func sortRank(sourceType SourceType, priority string) int {
	switch sourceType {
	case SourceLockout:
		return 0
	case SourceRecommendation:
		switch priority {
		case "urgent":
			return 1
		case "high":
			return 2
		default:
			return 4
		}
	case SourceFeeding:
		if priority == "urgent" {
			return 1
		}
		return 3
	case SourceHarvestReady:
		return 5
	default:
		return 6
	}
}

// itemName is the tie-break inside a rank (yard_queue.go:368-373): the hive
// the work is on, or the title for the hive-less items.
func itemName(item Item) string {
	if item.Context.HiveName != nil {
		return *item.Context.HiveName
	}
	return item.Title
}

// attentionRankCeiling splits "needs attention" from "today's field actions".
// It reproduces the hook's split (hooks.ts:167-181) exactly — feeding items
// in the attention state and urgent or high recommendations are rank 0-2,
// stale feeders and normal recommendations are rank 3+ — without being a
// second, independent rule.
const attentionRankCeiling = 2
