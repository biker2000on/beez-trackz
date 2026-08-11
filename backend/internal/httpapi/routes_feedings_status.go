package httpapi

import (
	"fmt"
	"net/http"
	"sort"
	"strings"
	"time"

	"github.com/google/uuid"
)

// One dashboard row per hive: how many feeders are on it, when it was last
// fed, and a single actionable state with the evidence behind it. This
// replaces the per-feeding "active feeders" list, which showed a hive once per
// record and repeated the same stale row forever.

const (
	// feedingStaleDays — an open feeder untouched this long needs a level check.
	feedingStaleDays = 7
	// feedingAttentionDays — an open feeder untouched this long is either empty
	// or was never taken off; it needs a field decision, not a reminder.
	feedingAttentionDays = 21
)

const (
	feedingStateOK        = "ok"
	feedingStateStale     = "stale"
	feedingStateAttention = "attention"
)

// feedingTypeLabels renders feed types inside evidence sentences.
var feedingTypeLabels = map[string]string{
	"sugar_syrup_1to1": "1:1 sugar syrup",
	"sugar_syrup_2to1": "2:1 sugar syrup",
	"dry_sugar":        "dry sugar",
	"pollen_patty":     "pollen patty",
	"fondant":          "fondant",
	"other":            "other feed",
}

func feedingTypeLabel(value *string) string {
	if value == nil || *value == "" {
		return "feed"
	}
	if label, ok := feedingTypeLabels[*value]; ok {
		return label
	}
	return strings.ReplaceAll(*value, "_", " ")
}

type feedingStatusRow struct {
	HiveID     uuid.UUID `json:"hiveId"`
	HiveName   string    `json:"hiveName"`
	ApiaryID   uuid.UUID `json:"apiaryId"`
	ApiaryName string    `json:"apiaryName"`

	OpenFeeders       int `json:"openFeeders"`
	UnverifiedFeeders int `json:"unverifiedFeeders"`

	OldestOpenAt       *time.Time `json:"oldestOpenAt"`
	OldestUnverifiedAt *time.Time `json:"oldestUnverifiedAt"`
	OpenFeederAgeDays  *int       `json:"openFeederAgeDays"`
	UnverifiedAgeDays  *int       `json:"unverifiedAgeDays"`

	LatestFeedAt       *time.Time `json:"latestFeedAt"`
	LatestFeedType     *string    `json:"latestFeedType"`
	LatestQuantity     *float64   `json:"latestQuantity"`
	LatestQuantityUnit *string    `json:"latestQuantityUnit"`
	LatestFeederType   *string    `json:"latestFeederType"`
	DaysSinceLastFeed  *int       `json:"daysSinceLastFeed"`

	// State is the one word the dashboard sorts and colors by.
	State string `json:"state"`
	// Evidence names the concrete observation behind the state, so the
	// dashboard never has to invent generic advice.
	Evidence string `json:"evidence"`
	// Action is the field action to take, empty when nothing is needed.
	Action string `json:"action"`
	// ActionFeedingID is the feeding the action applies to (close/refill).
	// It always matches the Action: the oldest unverified record when the
	// action is a verify, otherwise the oldest open feeder. A hive with both
	// used to get "Verify and close" pointed at an open feeder.
	ActionFeedingID *uuid.UUID `json:"actionFeedingId"`
	LatestFeedingID *uuid.UUID `json:"latestFeedingId"`

	// Per-state action candidates, resolved by feedingStatusEvaluate.
	oldestOpenID       *uuid.UUID
	oldestUnverifiedID *uuid.UUID
}

func feedingDaysSince(t *time.Time, now time.Time) *int {
	if t == nil {
		return nil
	}
	days := int(now.Sub(*t).Hours() / 24)
	if days < 0 {
		days = 0
	}
	return &days
}

func feedingAgo(days int) string {
	switch days {
	case 0:
		return "today"
	case 1:
		return "yesterday"
	default:
		return fmt.Sprintf("%d days ago", days)
	}
}

// feedingStatusEvaluate fills in the derived ages, state, evidence and action.
// It is pure so the rules stay testable without a database.
func feedingStatusEvaluate(row *feedingStatusRow, now time.Time) {
	row.OpenFeederAgeDays = feedingDaysSince(row.OldestOpenAt, now)
	row.UnverifiedAgeDays = feedingDaysSince(row.OldestUnverifiedAt, now)
	row.DaysSinceLastFeed = feedingDaysSince(row.LatestFeedAt, now)
	feedType := feedingTypeLabel(row.LatestFeedType)

	switch {
	case row.UnverifiedFeeders > 0:
		days := 0
		if row.UnverifiedAgeDays != nil {
			days = *row.UnverifiedAgeDays
		}
		row.State = feedingStateAttention
		row.Action = "Verify and close"
		row.ActionFeedingID = row.oldestUnverifiedID
		if row.UnverifiedFeeders == 1 {
			row.Evidence = fmt.Sprintf(
				"Feeder on %s open %d days with no refill and no recorded end date — verify and close",
				row.HiveName, days)
		} else {
			row.Evidence = fmt.Sprintf(
				"%d feeding records on %s have no recorded end date (oldest %d days) — verify and close",
				row.UnverifiedFeeders, row.HiveName, days)
		}
		if row.OpenFeeders > 0 {
			row.Evidence += fmt.Sprintf("; %d current feeder(s) also on the hive",
				row.OpenFeeders)
		}

	case row.OpenFeeders > 0 && row.OpenFeederAgeDays != nil &&
		*row.OpenFeederAgeDays > feedingAttentionDays:
		row.State = feedingStateAttention
		row.Action = "Refill or close"
		row.ActionFeedingID = row.oldestOpenID
		if row.OpenFeeders == 1 {
			row.Evidence = fmt.Sprintf(
				"Feeder on %s open %d days with no refill — refill it or close the record",
				row.HiveName, *row.OpenFeederAgeDays)
		} else {
			row.Evidence = fmt.Sprintf(
				"%d open feeders on %s, oldest %d days with no refill — refill or close",
				row.OpenFeeders, row.HiveName, *row.OpenFeederAgeDays)
		}

	case row.OpenFeeders > 0 && row.OpenFeederAgeDays != nil &&
		*row.OpenFeederAgeDays > feedingStaleDays:
		row.State = feedingStateStale
		row.Action = "Check level"
		row.ActionFeedingID = row.oldestOpenID
		row.Evidence = fmt.Sprintf(
			"Feeder on %s filled %d days ago (%s) — check the level",
			row.HiveName, *row.OpenFeederAgeDays, feedType)

	case row.OpenFeeders > 0:
		days := 0
		if row.OpenFeederAgeDays != nil {
			days = *row.OpenFeederAgeDays
		}
		row.State = feedingStateOK
		row.ActionFeedingID = row.oldestOpenID
		row.Evidence = fmt.Sprintf("Feeder on %s filled %s (%s)",
			row.HiveName, feedingAgo(days), feedType)

	default:
		row.State = feedingStateOK
		row.ActionFeedingID = nil
		if row.DaysSinceLastFeed == nil {
			row.Evidence = fmt.Sprintf("No feeder on %s", row.HiveName)
			break
		}
		row.Evidence = fmt.Sprintf("No open feeder on %s; last fed %s (%s)",
			row.HiveName, feedingAgo(*row.DaysSinceLastFeed), feedType)
	}
}

func feedingStateRank(state string) int {
	switch state {
	case feedingStateAttention:
		return 0
	case feedingStateStale:
		return 1
	default:
		return 2
	}
}

// feedingStatusUrgency is the age the sort uses: the oldest unresolved feeder,
// or -1 when the hive has none.
func feedingStatusUrgency(row feedingStatusRow) int {
	worst := -1
	for _, value := range []*int{row.UnverifiedAgeDays, row.OpenFeederAgeDays} {
		if value != nil && *value > worst {
			worst = *value
		}
	}
	return worst
}

// feedingStatusSort orders the dashboard list urgent-first.
func feedingStatusSort(rows []feedingStatusRow) {
	sort.SliceStable(rows, func(a, b int) bool {
		rankA, rankB := feedingStateRank(rows[a].State), feedingStateRank(rows[b].State)
		if rankA != rankB {
			return rankA < rankB
		}
		ageA, ageB := feedingStatusUrgency(rows[a]), feedingStatusUrgency(rows[b])
		if ageA != ageB {
			return ageA > ageB
		}
		if rows[a].ApiaryName != rows[b].ApiaryName {
			return rows[a].ApiaryName < rows[b].ApiaryName
		}
		return rows[a].HiveName < rows[b].HiveName
	})
}

// GET /feedings/status — one row per hive that has ever been fed, urgent first.
func (s *Server) handleFeedingsStatus(w http.ResponseWriter, r *http.Request) {
	user := principalFrom(r)
	rows, err := s.pool.Query(r.Context(), `
		WITH scoped AS (
			SELECT feeding.*, hive.position_label AS hive_name,
				hive.apiary_id, apiary.name AS apiary_name
			FROM feedings feeding
			JOIN hives hive ON hive.id = feeding.hive_id
			JOIN apiaries apiary ON apiary.id = hive.apiary_id
			WHERE hive.is_archived = false
			  AND ($1::boolean OR EXISTS (
				SELECT 1 FROM apiary_memberships membership
				WHERE membership.user_id = $2 AND membership.apiary_id = apiary.id
			  ))
		)
		SELECT hive_id, hive_name, apiary_id, apiary_name,
			count(*) FILTER (WHERE status = 'open')::integer,
			count(*) FILTER (WHERE status = 'unverified')::integer,
			min(date_fed) FILTER (WHERE status = 'open'),
			min(date_fed) FILTER (WHERE status = 'unverified'),
			max(date_fed),
			(array_agg(type::text ORDER BY date_fed DESC, created_at DESC))[1],
			(array_agg(quantity ORDER BY date_fed DESC, created_at DESC))[1],
			(array_agg(quantity_unit::text ORDER BY date_fed DESC, created_at DESC))[1],
			(array_agg(feeder_type::text ORDER BY date_fed DESC, created_at DESC))[1],
			(array_agg(id ORDER BY date_fed DESC, created_at DESC))[1],
			(array_agg(id ORDER BY date_fed) FILTER (WHERE status = 'open'))[1],
			(array_agg(id ORDER BY date_fed) FILTER (WHERE status = 'unverified'))[1]
		FROM scoped
		GROUP BY hive_id, hive_name, apiary_id, apiary_name`,
		user.IsAdmin, user.ID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	defer rows.Close()

	now := time.Now()
	list := []feedingStatusRow{}
	for rows.Next() {
		var row feedingStatusRow
		if err := rows.Scan(&row.HiveID, &row.HiveName, &row.ApiaryID, &row.ApiaryName,
			&row.OpenFeeders, &row.UnverifiedFeeders,
			&row.OldestOpenAt, &row.OldestUnverifiedAt, &row.LatestFeedAt,
			&row.LatestFeedType, &row.LatestQuantity, &row.LatestQuantityUnit,
			&row.LatestFeederType, &row.LatestFeedingID,
			&row.oldestOpenID, &row.oldestUnverifiedID); err != nil {
			writeError(w, http.StatusInternalServerError, "database error")
			return
		}
		feedingStatusEvaluate(&row, now)
		list = append(list, row)
	}
	if rows.Err() != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	feedingStatusSort(list)
	writeJSON(w, http.StatusOK, list)
}
