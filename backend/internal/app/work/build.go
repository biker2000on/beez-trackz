package work

import (
	"sort"
	"strings"

	"github.com/google/uuid"

	"github.com/biker2000on/beez-trackz/backend/internal/app"
)

// Filter is the query string of /work/today and /work/yard. An empty
// Statuses means open items only; the recommendation triage view asks for
// open, snoozed and dismissed explicitly.
type Filter struct {
	Statuses    []string
	Priorities  []string
	SourceTypes []string
	ApiaryID    *uuid.UUID
}

func (f Filter) matches(item Item) bool {
	if !containsFold(f.Statuses, item.Status, StatusOpen) {
		return false
	}
	if len(f.Priorities) > 0 && !containsFold(f.Priorities, item.Priority, "") {
		return false
	}
	if len(f.SourceTypes) > 0 && !containsFold(f.SourceTypes, string(item.SourceType), "") {
		return false
	}
	if f.ApiaryID != nil {
		if item.Context.ApiaryID == nil || *item.Context.ApiaryID != *f.ApiaryID {
			return false
		}
	}
	return true
}

// containsFold reports whether value is in list, treating an empty list as
// the supplied default (an empty default means "no constraint").
func containsFold(list []string, value, fallback string) bool {
	if len(list) == 0 {
		if fallback == "" {
			return true
		}
		return value == fallback
	}
	for _, candidate := range list {
		if strings.EqualFold(strings.TrimSpace(candidate), value) {
			return true
		}
	}
	return false
}

// Build turns one read of the facts into the projection, for one actor.
//
// Order of operations matters and is fixed here so it cannot drift: derive
// every item, drop the ones this actor may not even see, apply the
// feeder_check rule across the surviving set, then filter, rank and sort.
// The feeder_check rule runs before the filter because it is defined over
// "the same response" (section 4.6) — suppressing a recommendation because a
// feeding item exists, only to have that feeding item filtered out, would
// hide both.
func Build(in Inputs, actor app.Actor, filter Filter, offline OfflinePredicate) []Item {
	items := make([]Item, 0,
		len(in.Recommendations)+len(in.Feedings)+len(in.Lockouts)+len(in.HarvestReady))

	for _, fact := range in.Lockouts {
		items = append(items, lockoutItem(fact, in, actor, offline))
	}
	for _, fact := range in.Recommendations {
		items = append(items, recommendationItem(fact, in, actor, offline))
	}
	for _, fact := range in.Feedings {
		items = append(items, feedingItem(fact, in, actor, offline))
	}
	for _, fact := range in.HarvestReady {
		items = append(items, harvestReadyItem(fact, in, actor, offline))
	}

	items = visibleTo(items, actor)
	items = applyFeederCheckRule(items)

	kept := make([]Item, 0, len(items))
	for _, item := range items {
		if filter.matches(item) {
			kept = append(kept, item)
		}
	}
	sortItems(kept)
	return kept
}

// visibleTo drops items for apiaries this actor may not read. The SQL at the
// edge already scopes the same way; doing it here too means a projection
// reached through a different transport, or from a future cache, cannot leak
// a yard the actor was never a member of.
func visibleTo(items []Item, actor app.Actor) []Item {
	kept := make([]Item, 0, len(items))
	for _, item := range items {
		// Items with no apiary (hive-less recommendations) stay visible to
		// everyone, which is the yard queue behaviour today
		// (yard_queue.go:172-176).
		if item.Context.ApiaryID == nil || actor.MayViewApiary(*item.Context.ApiaryID) {
			kept = append(kept, item)
		}
	}
	return kept
}

// applyFeederCheckRule is section 4.6, and it is a DELIBERATE BEHAVIOUR
// CHANGE from both assemblers it replaces.
//
// hooks.ts:163-165 (rec.type !== "feeder_check") and yard_queue.go:132
// (AND rec.type <> 'feeder_check') drop the type unconditionally. That looks
// right only because the feeding-status row usually exists: a feeder_check
// recommendation for a hive with no feeding item is invisible on every
// surface today, and the failure is silent.
//
// The rule here: a feeder_check recommendation is suppressed if and only if
// the same response carries a feeding item for the same hive. When it is
// suppressed, the surviving feeding item lists it in supersedes, so the UI
// can still explain what was folded into it.
func applyFeederCheckRule(items []Item) []Item {
	feedingIDByHive := map[uuid.UUID]string{}
	for _, item := range items {
		if item.SourceType == SourceFeeding && item.Context.HiveID != nil {
			feedingIDByHive[*item.Context.HiveID] = item.ID
		}
	}
	if len(feedingIDByHive) == 0 {
		return items
	}
	kept := make([]Item, 0, len(items))
	superseded := map[string][]string{}
	for _, item := range items {
		if item.SourceType == SourceRecommendation && item.recType == "feeder_check" &&
			item.Context.HiveID != nil {
			if feedingID, ok := feedingIDByHive[*item.Context.HiveID]; ok {
				superseded[feedingID] = append(superseded[feedingID], item.ID)
				continue
			}
		}
		kept = append(kept, item)
	}
	for i := range kept {
		if ids, ok := superseded[kept[i].ID]; ok {
			kept[i].Supersedes = append(kept[i].Supersedes, ids...)
			sort.Strings(kept[i].Supersedes)
		}
	}
	return kept
}

// sortItems is the yard queue order (yard_queue.go:257-264): rank first, then
// the hive the work is on, with the projection id as a final tie-break so two
// items on the same hive at the same rank never swap between reads.
func sortItems(items []Item) {
	sort.SliceStable(items, func(i, j int) bool {
		if items[i].SortRank != items[j].SortRank {
			return items[i].SortRank < items[j].SortRank
		}
		nameI, nameJ := itemName(items[i]), itemName(items[j])
		if nameI != nameJ {
			return nameI < nameJ
		}
		return items[i].ID < items[j].ID
	})
}

// --- per-source derivation ------------------------------------------------

func lockoutItem(fact LockoutFact, in Inputs, actor app.Actor, offline OfflinePredicate) Item {
	ctx := Context{
		ApiaryID: &fact.ApiaryID, ApiaryName: &fact.ApiaryName,
		HiveID: &fact.HiveID, HiveName: &fact.HiveName,
	}
	applied := fact.DateApplied
	item := newItem(SourceLockout, fact.TreatmentEventID.String(), in,
		itemID(SourceLockout, fact.HiveID.String(), fact.TreatmentEventID.String()))
	item.Context = ctx
	item.Title = fact.Title
	item.Priority = "high"
	item.DueAt = fact.Until
	item.Evidence = []Evidence{{
		Text:       fact.Detail,
		SourceType: SourceLockout,
		SourceID:   fact.TreatmentEventID.String(),
		ObservedAt: &applied,
	}}
	item.Commands = buildCommands(item.ID, lockoutCommands(fact.TreatmentEventID), actor, ctx, offline)
	item.SortRank = sortRank(SourceLockout, item.Priority)
	return item
}

func recommendationItem(fact RecommendationFact, in Inputs, actor app.Actor, offline OfflinePredicate) Item {
	ctx := Context{
		ApiaryID: fact.ApiaryID, ApiaryName: fact.ApiaryName,
		HiveID: fact.HiveID, HiveName: fact.HiveName,
	}
	created := fact.CreatedAt
	status := fact.status(in.AsOf)
	item := newItem(SourceRecommendation, fact.ID.String(), in,
		itemID(SourceRecommendation, fact.ID.String()))
	item.Context = ctx
	item.Title = recommendationTitle(fact.Type)
	item.Priority = fact.Priority
	item.Status = status
	item.recType = fact.Type
	item.Evidence = []Evidence{{
		Text:       fact.Message,
		SourceType: SourceRecommendation,
		SourceID:   fact.ID.String(),
		ObservedAt: &created,
	}}
	if status == StatusSnoozed {
		item.DueAt = fact.SnoozedUntil
	}
	item.Commands = buildCommands(item.ID, recommendationCommands(fact.ID, status), actor, ctx, offline)
	item.SortRank = sortRank(SourceRecommendation, item.Priority)
	return item
}

func feedingItem(fact FeedingFact, in Inputs, actor app.Actor, offline OfflinePredicate) Item {
	ctx := Context{
		ApiaryID: &fact.ApiaryID, ApiaryName: &fact.ApiaryName,
		HiveID: &fact.HiveID, HiveName: &fact.HiveName,
	}
	item := newItem(SourceFeeding, fact.FeedingID.String(), in,
		itemID(SourceFeeding, fact.FeedingID.String()))
	item.Context = ctx
	item.Title = fact.Action
	item.Priority = fact.priority()
	item.Evidence = []Evidence{{
		Text:       fact.Evidence,
		SourceType: SourceFeeding,
		SourceID:   fact.FeedingID.String(),
		ObservedAt: fact.ObservedAt,
	}}
	item.Commands = buildCommands(item.ID, feedingCommands(fact.FeedingID), actor, ctx, offline)
	item.SortRank = sortRank(SourceFeeding, item.Priority)
	return item
}

func harvestReadyItem(fact HarvestReadyFact, in Inputs, actor app.Actor, offline OfflinePredicate) Item {
	ctx := Context{
		ApiaryID: &fact.ApiaryID, ApiaryName: &fact.ApiaryName,
		HiveID: &fact.HiveID, HiveName: &fact.HiveName,
	}
	inspected := fact.InspectedAt
	item := newItem(SourceHarvestReady, fact.InspectionID.String(), in,
		itemID(SourceHarvestReady, fact.HiveID.String(), fact.InspectionID.String()))
	item.Context = ctx
	item.Title = "Pull honey"
	item.Priority = "normal"
	item.Evidence = []Evidence{{
		Text:       fact.Detail,
		SourceType: SourceHarvestReady,
		SourceID:   fact.InspectionID.String(),
		ObservedAt: &inspected,
	}}
	item.Commands = buildCommands(item.ID,
		harvestReadyCommands(fact.HiveID, fact.ApiaryID), actor, ctx, offline)
	item.SortRank = sortRank(SourceHarvestReady, item.Priority)
	return item
}

func newItem(sourceType SourceType, sourceID string, in Inputs, id string) Item {
	return Item{
		ID:         id,
		SourceType: sourceType,
		SourceID:   sourceID,
		Status:     StatusOpen,
		Supersedes: []string{},
		Evidence:   []Evidence{},
		Commands:   []Command{},
		AsOf:       in.AsOf,
		Freshness:  ServerFreshness(),
	}
}

func buildCommands(
	id string, specs []commandSpec, actor app.Actor, ctx Context, offline OfflinePredicate,
) []Command {
	out := make([]Command, 0, len(specs))
	for _, spec := range specs {
		out = append(out, spec.build(id, actor, ctx, offline))
	}
	return out
}
