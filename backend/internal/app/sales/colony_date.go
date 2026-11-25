package sales

import (
	"time"

	"github.com/biker2000on/beez-trackz/backend/internal/app"
)

// colonySaleDateRefusal refuses a colony line whose hive was installed after
// the sale date.
//
// Hive labels are reused: when a colony at A1 is sold, the next colony put in
// A1 gets a new hive record with the same label. A backdated sale picked by
// label alone lands on that successor, and marking it sold gives the new
// colony the old one's terminal status. That is how sale BT-4A8A1055 (dated
// 2026-04-25) came to mark the 2026-04-27 A1 swarm and the 2026-05-18 C2
// split as sold. A colony cannot leave before it arrived, so the date alone
// rules the successor out.
//
// Both dates are compared as UTC calendar days, the way the API stores
// date-only fields (midnight UTC). A hive with no installed date passes,
// because there is nothing to check it against.
func colonySaleDateRefusal(label string, installed *time.Time, saleDate time.Time) error {
	if installed == nil || installed.IsZero() {
		return nil
	}
	installedDay := calendarDay(*installed)
	saleDay := calendarDay(saleDate)
	if !installedDay.After(saleDay) {
		return nil
	}
	return app.Invalid("mark hive sold",
		"%s was installed %s, after the %s sale date; pick the colony that was in %s on that date.",
		label, installedDay.Format(time.DateOnly), saleDay.Format(time.DateOnly), label)
}

func calendarDay(value time.Time) time.Time {
	year, month, day := value.UTC().Date()
	return time.Date(year, month, day, 0, 0, 0, 0, time.UTC)
}
