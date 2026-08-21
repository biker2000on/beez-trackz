package jobs

import (
	"context"
	"errors"
	"log/slog"
	"time"

	"github.com/hibiken/asynq"

	"github.com/biker2000on/beez-trackz/backend/internal/recs"
)

// handleGenerateRecs runs the recommendations rules engine.
func (h *Handlers) handleGenerateRecs(ctx context.Context, _ *asynq.Task) error {
	created, skipped, errs := recs.Run(ctx, h.pool, time.Now())

	ruleFailures := 0
	for _, err := range errs {
		var re *recs.RuleError
		if errors.As(err, &re) {
			ruleFailures++
		}
		slog.Error("recommendation engine error", "err", err)
	}
	slog.Info("generate recommendations",
		"created", created,
		"skippedDuplicates", skipped,
		"errors", len(errs))

	// Only fail the task when every rule failed; partial failures were logged.
	if len(errs) > 0 && ruleFailures == recs.RuleCount() {
		return errs[0]
	}
	if h.postRecs != nil {
		h.postRecs(ctx)
	}
	return nil
}
