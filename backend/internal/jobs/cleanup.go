package jobs

import (
	"context"
	"fmt"
	"log/slog"

	"github.com/hibiken/asynq"
)

// handleCleanupReceipts deletes offline mutation receipts past the retention
// window. A receipt only matters while its mutation could still replay; 30
// days is far beyond any realistic offline stretch, and without cleanup the
// table (response bodies up to 2 MB each) grows forever.
func (h *Handlers) handleCleanupReceipts(ctx context.Context, _ *asynq.Task) error {
	tag, err := h.pool.Exec(ctx, `
		DELETE FROM offline_mutation_receipts
		WHERE created_at < now() - interval '30 days'`)
	if err != nil {
		return fmt.Errorf("cleanup receipts: %w", err)
	}
	if deleted := tag.RowsAffected(); deleted > 0 {
		slog.Info("cleanup receipts: done", "deleted", deleted)
	}
	return nil
}
