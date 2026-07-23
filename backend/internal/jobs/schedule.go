package jobs

import (
	"fmt"

	"github.com/hibiken/asynq"
)

// RegisterPeriodic registers recurring jobs on the scheduler.
// The recommendations engine runs every 6 hours.
func RegisterPeriodic(scheduler *asynq.Scheduler) error {
	if _, err := scheduler.Register("0 */6 * * *", asynq.NewTask(TypeGenerateRecs, nil)); err != nil {
		return fmt.Errorf("register %s: %w", TypeGenerateRecs, err)
	}
	return nil
}
