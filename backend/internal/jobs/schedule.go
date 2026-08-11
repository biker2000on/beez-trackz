package jobs

import (
	"fmt"
	"time"

	"github.com/hibiken/asynq"
)

// RegisterPeriodic registers recurring jobs on the scheduler.
//
// Every worker replica runs a scheduler, so each registration carries
// asynq.Unique spanning most of its period: N replicas enqueue one task, not
// N (the second enqueue within the window is dropped as a duplicate).
func RegisterPeriodic(scheduler *asynq.Scheduler) error {
	// The recommendations engine runs every 6 hours.
	if _, err := scheduler.Register("0 */6 * * *",
		asynq.NewTask(TypeGenerateRecs, nil), asynq.Unique(5*time.Hour)); err != nil {
		return fmt.Errorf("register %s: %w", TypeGenerateRecs, err)
	}
	// Offline mutation receipts are safe to drop once no replay can still
	// reference them; without cleanup the table (bodies up to 2 MB each)
	// grows forever.
	if _, err := scheduler.Register("30 3 * * *",
		asynq.NewTask(TypeCleanupReceipts, nil), asynq.Unique(23*time.Hour)); err != nil {
		return fmt.Errorf("register %s: %w", TypeCleanupReceipts, err)
	}
	return nil
}
