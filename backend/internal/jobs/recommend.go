package jobs

import (
	"context"
	"log/slog"

	"github.com/hibiken/asynq"
)

// handleGenerateRecs — stub; implemented by the recommendations port
// (see docs/rewrite/backend-spec.md).
func (h *Handlers) handleGenerateRecs(ctx context.Context, t *asynq.Task) error {
	slog.Info("generate recommendations (stub)", "payload", string(t.Payload()))
	return nil
}
