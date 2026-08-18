package httpapi

import (
	"context"
	"errors"
	"net/http"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/biker2000on/beez-trackz/backend/internal/recs"
)

// Comparable mite rate: washes/rolls stay mites per 100 bees; board/visual
// become mites per day once days_on_board is known.
const varroaComparableRateSQL = `
	CASE
		WHEN method IN ('alcohol_wash', 'sugar_roll') THEN mites_per_100
		WHEN method IN ('sticky_board', 'visual') THEN mites_per_day
	END`

const varroaRateKindSQL = `
	CASE
		WHEN method IN ('alcohol_wash', 'sugar_roll') AND mites_per_100 IS NOT NULL THEN 'per_100'
		WHEN method IN ('sticky_board', 'visual') AND mites_per_day IS NOT NULL THEN 'per_day'
	END`

// varroaEfficacySQL pairs each treatment with bounded before/after counts.
//
// Before: last comparable count in the 21 days up to date_applied.
// After: first comparable count after the treatment ends (date_removed, or
// date_applied when there is no removal), within 42 days, and before the
// next treatment on the same hive. Board rates (mites/day) are eligible.
// $1 is an optional hive filter (NULL = every hive).
const varroaEfficacySQL = `
WITH treatments AS (
	SELECT t.id, t.hive_id, t.date_applied, t.date_removed, t.product, t.method,
		COALESCE(t.date_removed, t.date_applied) AS ended_at,
		LEAD(t.date_applied) OVER (
			PARTITION BY t.hive_id ORDER BY t.date_applied, t.id
		) AS next_applied
	FROM treatment_events t
	WHERE ($1::uuid IS NULL OR t.hive_id = $1)
)
SELECT t.id, t.hive_id, t.date_applied, t.product, t.method, t.date_removed,
	before_count.rate, after_count.rate,
	before_count.rate_kind, after_count.rate_kind
FROM treatments t
LEFT JOIN LATERAL (
	SELECT ` + varroaComparableRateSQL + ` AS rate,
		` + varroaRateKindSQL + ` AS rate_kind
	FROM mite_counts
	WHERE hive_id = t.hive_id
		AND date <= t.date_applied
		AND date >= t.date_applied - interval '21 days'
		AND (` + varroaRateKindSQL + `) IS NOT NULL
	ORDER BY date DESC
	LIMIT 1
) before_count ON true
LEFT JOIN LATERAL (
	SELECT ` + varroaComparableRateSQL + ` AS rate,
		` + varroaRateKindSQL + ` AS rate_kind
	FROM mite_counts
	WHERE hive_id = t.hive_id
		AND date > t.ended_at
		AND date <= t.ended_at + interval '42 days'
		AND (t.next_applied IS NULL OR date < t.next_applied)
		AND (` + varroaRateKindSQL + `) IS NOT NULL
	ORDER BY date
	LIMIT 1
) after_count ON true
ORDER BY t.date_applied, t.id`

type varroaEfficacyRow struct {
	ID          uuid.UUID
	HiveID      uuid.UUID
	DateApplied time.Time
	Product     string
	Method      *string
	DateRemoved *time.Time
	Before      *float64
	After       *float64
	BeforeKind  *string
	AfterKind   *string
}

func (row varroaEfficacyRow) efficacyPercent() *float64 {
	if row.Before == nil || row.After == nil || row.BeforeKind == nil ||
		row.AfterKind == nil || *row.BeforeKind != *row.AfterKind || *row.Before <= 0 {
		return nil
	}
	v := (*row.Before - *row.After) / *row.Before * 100
	return &v
}

func queryVarroaEfficacy(
	ctx context.Context,
	pool *pgxpool.Pool,
	hiveID *uuid.UUID,
) ([]varroaEfficacyRow, error) {
	rows, err := pool.Query(ctx, varroaEfficacySQL, hiveID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]varroaEfficacyRow, 0)
	for rows.Next() {
		var row varroaEfficacyRow
		if err := rows.Scan(
			&row.ID, &row.HiveID, &row.DateApplied, &row.Product, &row.Method,
			&row.DateRemoved, &row.Before, &row.After, &row.BeforeKind, &row.AfterKind,
		); err != nil {
			return nil, err
		}
		out = append(out, row)
	}
	return out, rows.Err()
}

func normalizeMiteCount(req *miteCountPayload) error {
	if !miteMethods[req.Method] || req.MitesCount < 0 ||
		(req.SampleSize != nil && *req.SampleSize <= 0) ||
		(req.DaysOnBoard != nil && *req.DaysOnBoard <= 0) {
		return errors.New("invalid mite count")
	}
	switch req.Method {
	case "alcohol_wash", "sugar_roll":
		req.DaysOnBoard = nil
	case "sticky_board":
		req.SampleSize = nil
		if req.DaysOnBoard == nil {
			one := 1
			req.DaysOnBoard = &one
		}
	case "visual":
		req.SampleSize = nil
	}
	return nil
}

func miteCountUpsertSQL(inspectionLinked bool) string {
	conflict := `(hive_id, date, method) WHERE inspection_id IS NULL`
	if inspectionLinked {
		conflict = `(inspection_id, method) WHERE inspection_id IS NOT NULL`
	}
	return `
		INSERT INTO mite_counts
			(hive_id, inspection_id, date, method, mites_count, sample_size, days_on_board, notes)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
		ON CONFLICT ` + conflict + ` DO UPDATE SET
			hive_id = EXCLUDED.hive_id,
			date = EXCLUDED.date,
			method = EXCLUDED.method,
			mites_count = EXCLUDED.mites_count,
			sample_size = EXCLUDED.sample_size,
			days_on_board = EXCLUDED.days_on_board,
			notes = EXCLUDED.notes
		RETURNING id, mites_per_100, mites_per_day`
}

func upsertMiteCount(
	ctx context.Context,
	q inspectionQuerier,
	req miteCountPayload,
	date time.Time,
) (uuid.UUID, *float64, *float64, error) {
	if err := normalizeMiteCount(&req); err != nil {
		return uuid.Nil, nil, nil, err
	}
	var id uuid.UUID
	var per100, perDay *float64
	err := q.QueryRow(ctx, miteCountUpsertSQL(req.InspectionID != nil),
		req.HiveID, req.InspectionID, date, req.Method, req.MitesCount,
		req.SampleSize, req.DaysOnBoard, honeyTrimPtr(req.Notes),
	).Scan(&id, &per100, &perDay)
	return id, per100, perDay, err
}

type miteCountJSON struct {
	ID          uuid.UUID  `json:"id"`
	HiveID      uuid.UUID  `json:"hiveId"`
	Date        time.Time  `json:"date"`
	Method      string     `json:"method"`
	MitesCount  int        `json:"mitesCount"`
	SampleSize  *int       `json:"sampleSize"`
	DaysOnBoard *int       `json:"daysOnBoard"`
	MitesPer100 *float64   `json:"mitesPer100"`
	MitesPerDay *float64   `json:"mitesPerDay"`
	Notes       *string    `json:"notes"`
	HiveName    *string    `json:"hiveName,omitempty"`
	ApiaryID    *uuid.UUID `json:"apiaryId,omitempty"`
	ApiaryName  *string    `json:"apiaryName,omitempty"`
}

func miteCountResponse(id uuid.UUID, per100, perDay *float64) map[string]any {
	return map[string]any{"id": id, "mitesPer100": per100, "mitesPerDay": perDay}
}

func treatmentJSON(row varroaEfficacyRow) map[string]any {
	return map[string]any{
		"id":                row.ID,
		"hiveId":            row.HiveID,
		"dateApplied":       row.DateApplied,
		"dateRemoved":       row.DateRemoved,
		"product":           row.Product,
		"method":            row.Method,
		"beforeRate":        row.Before,
		"afterRate":         row.After,
		"beforeRateKind":    row.BeforeKind,
		"afterRateKind":     row.AfterKind,
		"beforeMitesPer100": per100FromRate(row.Before, row.BeforeKind),
		"afterMitesPer100":  per100FromRate(row.After, row.AfterKind),
		"efficacyPercent":   row.efficacyPercent(),
	}
}

// per100FromRate keeps the existing frontend field populated when the paired
// rate is a wash/roll. Board pairings use beforeRate/afterRate instead.
func per100FromRate(rate *float64, kind *string) *float64 {
	if rate == nil || kind == nil || *kind != "per_100" {
		return nil
	}
	return rate
}

func (s *Server) loadVarroaSettings(r *http.Request) recs.VarroaSettings {
	settings, err := recs.LoadVarroaSettings(r.Context(), s.pool, time.Now())
	if err != nil {
		return recs.VarroaSettings{
			ThresholdPer100:   recs.SeasonalWashThreshold(time.Now()),
			ThresholdPerDay:   recs.DefaultBoardThresholdPerDay,
			CheckIntervalDays: recs.SeasonalMiteCheckDays(time.Now()),
		}
	}
	return settings
}

func countOverThreshold(method string, per100, perDay *float64, settings recs.VarroaSettings) bool {
	return recs.OverThreshold(method, per100, perDay, settings)
}
