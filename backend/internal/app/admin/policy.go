// Package admin owns commands that change operation-wide policy.
package admin

import (
	"context"

	"github.com/biker2000on/beez-trackz/backend/internal/app"
)

const updatePolicyOp = "update operation policy"

// UpdatePolicyCommand is a patch. The Set fields distinguish an omitted JSON
// property from an explicit null, which clears a nullable threshold.
type UpdatePolicyCommand struct {
	SetLaborTrackingEnabled bool
	LaborTrackingEnabled    bool
	SetMiteThresholdPer100  bool
	MiteThresholdPer100     *float64
	SetMiteThresholdPerDay  bool
	MiteThresholdPerDay     *float64
	SetMiteCheckInterval    bool
	MiteCheckIntervalDays   *int
	SetMoistureThresholdPct bool
	MoistureThresholdPct    *float64

	SetNtfy            bool
	NtfyServerURL      *string
	NtfyTopic          *string
	NtfyEnabled        bool
	NtfyEventKinds     []string
	SetNtfyAccessToken bool
	NtfyAccessToken    *string
}

// UpdatePolicy changes the singleton only for an administrator. Authorization
// is repeated here so an internal caller cannot bypass the HTTP middleware.
func UpdatePolicy(ctx context.Context, uow *app.UnitOfWork, command UpdatePolicyCommand) error {
	if uow == nil || !uow.Actor().Valid() || !uow.Actor().MayAdminister() {
		return app.Forbidden(updatePolicyOp, "administrator access is required")
	}
	if command.MiteThresholdPer100 != nil && *command.MiteThresholdPer100 <= 0 {
		return app.Invalid(updatePolicyOp, "mite threshold per 100 must be positive")
	}
	if command.MiteThresholdPerDay != nil && *command.MiteThresholdPerDay <= 0 {
		return app.Invalid(updatePolicyOp, "mite threshold per day must be positive")
	}
	if command.MiteCheckIntervalDays != nil && *command.MiteCheckIntervalDays <= 0 {
		return app.Invalid(updatePolicyOp, "mite check interval days must be positive")
	}
	if command.MoistureThresholdPct != nil &&
		(*command.MoistureThresholdPct <= 0 || *command.MoistureThresholdPct > 100) {
		return app.Invalid(updatePolicyOp, "moisture threshold must be between 0 and 100")
	}

	tag, err := uow.Exec(ctx, `
		UPDATE user_settings
		SET labor_tracking_enabled = CASE WHEN $1 THEN $2 ELSE labor_tracking_enabled END,
			mite_threshold_per_100 = CASE WHEN $3 THEN $4 ELSE mite_threshold_per_100 END,
			mite_threshold_per_day = CASE WHEN $5 THEN $6 ELSE mite_threshold_per_day END,
			mite_check_interval_days = CASE WHEN $7 THEN $8 ELSE mite_check_interval_days END,
			moisture_threshold_pct = CASE WHEN $9 THEN $10 ELSE moisture_threshold_pct END,
			ntfy_server_url = CASE WHEN $11 THEN $12 ELSE ntfy_server_url END,
			ntfy_topic = CASE WHEN $11 THEN $13 ELSE ntfy_topic END,
			ntfy_enabled = CASE WHEN $11 THEN $14 ELSE ntfy_enabled END,
			ntfy_event_kinds = CASE WHEN $11 THEN $15 ELSE ntfy_event_kinds END,
			ntfy_access_token = CASE WHEN $16 THEN $17 ELSE ntfy_access_token END
		WHERE id = (SELECT id FROM user_settings LIMIT 1)`,
		command.SetLaborTrackingEnabled, command.LaborTrackingEnabled,
		command.SetMiteThresholdPer100, command.MiteThresholdPer100,
		command.SetMiteThresholdPerDay, command.MiteThresholdPerDay,
		command.SetMiteCheckInterval, command.MiteCheckIntervalDays,
		command.SetMoistureThresholdPct, command.MoistureThresholdPct,
		command.SetNtfy, command.NtfyServerURL, command.NtfyTopic,
		command.NtfyEnabled, command.NtfyEventKinds,
		command.SetNtfyAccessToken, command.NtfyAccessToken)
	if err != nil {
		return app.Internal(updatePolicyOp, err)
	}
	if tag.RowsAffected() == 0 {
		return app.NotFound(updatePolicyOp, "operation policy is not configured")
	}
	return nil
}
