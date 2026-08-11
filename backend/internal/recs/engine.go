package recs

import (
	"context"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// RuleError wraps a failure of an entire rule evaluation (as opposed to a
// per-recommendation dedup/insert failure).
type RuleError struct {
	RuleType string
	Err      error
}

func (e *RuleError) Error() string {
	return fmt.Sprintf("rule %q failed: %v", e.RuleType, e.Err)
}

func (e *RuleError) Unwrap() error { return e.Err }

// Run evaluates every recommendation rule, deduplicates against existing
// undismissed recommendations, and persists new ones.
//
// A recommendation is a duplicate when an undismissed ai_recommendations row
// with the same type and same hive_id (including both null) already exists.
// The message text is intentionally not compared since wording may change
// slightly between runs (e.g. "15 days" vs "16 days").
//
// Rule failures are collected into errs and do not abort the run.
func Run(ctx context.Context, pool *pgxpool.Pool, now time.Time) (created, skippedDuplicates int, errs []error) {
	for _, r := range allRules() {
		results, err := r.Check(ctx, pool, now)
		if err != nil {
			errs = append(errs, &RuleError{RuleType: r.Type, Err: err})
			continue
		}

		for _, res := range results {
			// Dedup is enforced by the partial unique index
			// ai_recommendations_active_unique; a check-then-insert here
			// raced concurrent runs and produced duplicate cards.
			tag, err := pool.Exec(ctx, `
				INSERT INTO ai_recommendations (hive_id, type, message, priority)
				VALUES ($1, $2, $3, $4)
				ON CONFLICT (type,
					COALESCE(hive_id, '00000000-0000-0000-0000-000000000000'::uuid))
					WHERE dismissed = false
				DO NOTHING`,
				res.HiveID, r.Type, res.Message, res.Priority)
			if err != nil {
				errs = append(errs, fmt.Errorf("insert recommendation (%s): %w", r.Type, err))
				continue
			}
			if tag.RowsAffected() == 0 {
				skippedDuplicates++
				continue
			}
			created++
		}
	}
	return created, skippedDuplicates, errs
}
