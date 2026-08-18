package recs

import (
	"context"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Honey Bee Health Coalition-style action levels. A stored override on
// user_settings wins; otherwise wash/roll thresholds vary by season and
// board drop uses a single mites-per-day line.
const (
	DefaultBoardThresholdPerDay = 9.0
	springWashThreshold         = 2.0
	summerWashThreshold         = 3.0
	fallWashThreshold           = 2.0
	winterWashThreshold         = 3.0
	inSeasonMiteCheckDays       = 14
	offSeasonMiteCheckDays      = 28
)

// VarroaSettings are the instance-wide action levels and sampling cadence.
type VarroaSettings struct {
	ThresholdPer100    float64
	ThresholdPerDay    float64
	CheckIntervalDays  int
	Per100IsOverride   bool
	PerDayIsOverride   bool
	IntervalIsOverride bool
}

// SeasonalWashThreshold is the mites-per-100 action level for the date.
func SeasonalWashThreshold(now time.Time) float64 {
	switch now.Month() {
	case time.March, time.April, time.May:
		return springWashThreshold
	case time.June, time.July:
		return summerWashThreshold
	case time.August, time.September, time.October:
		return fallWashThreshold
	default:
		return winterWashThreshold
	}
}

// SeasonalMiteCheckDays is how long a hive can go without a mite sample.
func SeasonalMiteCheckDays(now time.Time) int {
	switch now.Month() {
	case time.April, time.May, time.June, time.July, time.August, time.September:
		return inSeasonMiteCheckDays
	default:
		return offSeasonMiteCheckDays
	}
}

// LoadVarroaSettings reads optional overrides from the singleton settings row.
func LoadVarroaSettings(ctx context.Context, pool *pgxpool.Pool, now time.Time) (VarroaSettings, error) {
	out := VarroaSettings{
		ThresholdPer100:   SeasonalWashThreshold(now),
		ThresholdPerDay:   DefaultBoardThresholdPerDay,
		CheckIntervalDays: SeasonalMiteCheckDays(now),
	}
	var per100, perDay *float64
	var interval *int
	err := pool.QueryRow(ctx, `
		SELECT mite_threshold_per_100, mite_threshold_per_day, mite_check_interval_days
		FROM user_settings LIMIT 1`).Scan(&per100, &perDay, &interval)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return out, nil
		}
		return out, err
	}
	if per100 != nil && *per100 > 0 {
		out.ThresholdPer100 = *per100
		out.Per100IsOverride = true
	}
	if perDay != nil && *perDay > 0 {
		out.ThresholdPerDay = *perDay
		out.PerDayIsOverride = true
	}
	if interval != nil && *interval > 0 {
		out.CheckIntervalDays = *interval
		out.IntervalIsOverride = true
	}
	return out, nil
}

// OverThreshold reports whether a comparable mite rate exceeds the action level.
// Washes/rolls use mites per 100; board/visual use mites per day. A count
// with no comparable rate (board without days-on-board) cannot trip treat-now.
func OverThreshold(method string, per100, perDay *float64, settings VarroaSettings) bool {
	switch method {
	case "alcohol_wash", "sugar_roll":
		return per100 != nil && *per100 >= settings.ThresholdPer100
	case "sticky_board", "visual":
		return perDay != nil && *perDay >= settings.ThresholdPerDay
	default:
		return false
	}
}

// ComparableRate returns the number the UI and recs should display for a count:
// mites per 100 for washes/rolls, mites per day for boards/visuals.
func ComparableRate(method string, per100, perDay *float64) (rate float64, kind string, ok bool) {
	switch method {
	case "alcohol_wash", "sugar_roll":
		if per100 == nil {
			return 0, "per_100", false
		}
		return *per100, "per_100", true
	case "sticky_board", "visual":
		if perDay == nil {
			return 0, "per_day", false
		}
		return *perDay, "per_day", true
	default:
		return 0, "", false
	}
}
