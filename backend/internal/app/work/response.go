package work

import (
	"sort"
	"time"

	"github.com/google/uuid"
)

// The two field read models (section 4.8). Same item shape, different
// grouping; both carry asOf and freshness so a cached render can say so.

// Group is one section of Today.
type Group struct {
	Key   string `json:"key"`
	Label string `json:"label"`
	Items []Item `json:"items"`
}

// TodayCounts are the badge numbers, over the items actually returned.
type TodayCounts struct {
	Attention int `json:"attention"`
	Today     int `json:"today"`
	Snoozed   int `json:"snoozed"`
}

// TodayResponse is GET /work/today.
type TodayResponse struct {
	AsOf      time.Time   `json:"asOf"`
	Freshness Freshness   `json:"freshness"`
	Counts    TodayCounts `json:"counts"`
	Groups    []Group     `json:"groups"`
}

// YardCounts are the per-yard badge numbers.
type YardCounts struct {
	Urgent int `json:"urgent"`
	High   int `json:"high"`
	Normal int `json:"normal"`
}

// Yard is one apiary group. ApiaryID is nil for the catch-all that carries
// hive-less recommendations, which is how they stay visible at all
// (yard_queue.go:172-176).
type Yard struct {
	ApiaryID   *uuid.UUID `json:"apiaryId"`
	ApiaryName string     `json:"apiaryName"`
	Counts     YardCounts `json:"counts"`
	Items      []Item     `json:"items"`
}

// YardResponse is GET /work/yard.
type YardResponse struct {
	AsOf      time.Time `json:"asOf"`
	Freshness Freshness `json:"freshness"`
	Yards     []Yard    `json:"yards"`
}

// Today groups the projection into "needs attention" and "today's field
// actions". The split is a threshold on the one sortRank (section 4.7), not a
// second rule: the hook it replaces re-derived urgency from priority strings
// in the client and could disagree with the server about the same item.
func Today(asOf time.Time, items []Item) TodayResponse {
	attention := make([]Item, 0, len(items))
	today := make([]Item, 0, len(items))
	snoozed := 0
	for _, item := range items {
		if item.Status == StatusSnoozed {
			snoozed++
		}
		if item.SortRank <= attentionRankCeiling {
			attention = append(attention, item)
			continue
		}
		today = append(today, item)
	}
	return TodayResponse{
		AsOf:      asOf,
		Freshness: ServerFreshness(),
		Counts: TodayCounts{
			Attention: len(attention),
			Today:     len(today),
			Snoozed:   snoozed,
		},
		Groups: []Group{
			{Key: "attention", Label: "Needs attention", Items: attention},
			{Key: "today", Label: "Today's field actions", Items: today},
		},
	}
}

// YardView groups the same projection by apiary, ordered by yard name with
// the hive-less catch-all last (yard_queue.go:266-274). Empty yards are
// omitted, as they are today.
func YardView(asOf time.Time, items []Item) YardResponse {
	order := make([]uuid.UUID, 0)
	byApiary := map[uuid.UUID]*Yard{}
	for _, item := range items {
		key := uuid.Nil
		name := "All yards"
		if item.Context.ApiaryID != nil {
			key = *item.Context.ApiaryID
			if item.Context.ApiaryName != nil {
				name = *item.Context.ApiaryName
			} else {
				name = key.String()
			}
		}
		yard, ok := byApiary[key]
		if !ok {
			yard = &Yard{ApiaryName: name, Items: []Item{}}
			if key != uuid.Nil {
				id := key
				yard.ApiaryID = &id
			}
			byApiary[key] = yard
			order = append(order, key)
		}
		yard.Items = append(yard.Items, item)
		switch item.Priority {
		case "urgent":
			yard.Counts.Urgent++
		case "high":
			yard.Counts.High++
		default:
			yard.Counts.Normal++
		}
	}
	yards := make([]Yard, 0, len(order))
	for _, key := range order {
		yards = append(yards, *byApiary[key])
	}
	sort.SliceStable(yards, func(i, j int) bool {
		if yards[i].ApiaryID == nil {
			return false
		}
		if yards[j].ApiaryID == nil {
			return true
		}
		return yards[i].ApiaryName < yards[j].ApiaryName
	})
	return YardResponse{AsOf: asOf, Freshness: ServerFreshness(), Yards: yards}
}
