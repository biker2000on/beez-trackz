package jobs

import (
	"context"
	"log/slog"

	"github.com/hibiken/asynq"
)

// handleProcessImage — stub; implemented by the media port (see docs/rewrite/backend-spec.md).
func (h *Handlers) handleProcessImage(ctx context.Context, t *asynq.Task) error {
	slog.Info("process image (stub)", "payload", string(t.Payload()))
	return nil
}
