package httpapi

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// A position label is reused when a colony dies or is sold, so "the hive at
// A1" on a past date may be a different record from the one at A1 today.
// Harvests re-entered from old notes landed on successor colonies installed
// after the harvest. A colony cannot yield honey before it existed, so a
// harvest dated before the hive's installed date is refused.

// utcCivilDay is the calendar date of t in UTC.
func utcCivilDay(t time.Time) time.Time {
	y, m, d := t.UTC().Date()
	return time.Date(y, m, d, 0, 0, 0, 0, time.UTC)
}

// harvestBeforeInstallMessage returns the refusal for harvesting a hive on
// harvestDate, or "" when the hive was already installed (or its installed
// date is unknown). Calendar dates are compared in UTC.
func harvestBeforeInstallMessage(label string, installed *time.Time, harvestDate time.Time) string {
	if installed == nil {
		return ""
	}
	installedDay := utcCivilDay(*installed)
	harvestDay := utcCivilDay(harvestDate)
	if !installedDay.After(harvestDay) {
		return ""
	}
	return fmt.Sprintf(
		"%s was installed %s, after the %s harvest; pick the colony that was in %s on that date",
		label, installedDay.Format(civilDateLayout), harvestDay.Format(civilDateLayout), label)
}

// refuseHarvestBeforeInstall loads the hive and applies
// harvestBeforeInstallMessage. A missing hive is not refused here; the
// caller's own lookup or foreign key reports it.
func refuseHarvestBeforeInstall(ctx context.Context, q queryRower, hiveID uuid.UUID, harvestDate time.Time) (string, error) {
	var label string
	var installed *time.Time
	err := q.QueryRow(ctx,
		`SELECT position_label, installed_date FROM hives WHERE id = $1`, hiveID).
		Scan(&label, &installed)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", nil
	}
	if err != nil {
		return "", err
	}
	return harvestBeforeInstallMessage(label, installed, harvestDate), nil
}
