package jobs

import (
	"context"
	"log/slog"

	"github.com/hibiken/asynq"
)

// handleTranscribeAudio — stub; implemented by the AI port (see docs/rewrite/backend-spec.md).
func (h *Handlers) handleTranscribeAudio(ctx context.Context, t *asynq.Task) error {
	slog.Info("transcribe audio (stub)", "payload", string(t.Payload()))
	return nil
}
