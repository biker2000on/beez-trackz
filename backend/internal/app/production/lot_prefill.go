package production

import (
	"fmt"
	"strings"
	"time"
)

// SeasonFor names the meteorological season a date falls in, with its year:
// "Spring 2026" for March-May, "Summer 2026" for June-August, "Fall 2026" for
// September-November, "Winter 2026" for December-February. December belongs to
// the winter that starts in it, so December 2025 is "Winter 2025" and January
// 2026 is "Winter 2026"; the label is the calendar year of the date.
func SeasonFor(day time.Time) string {
	return SeasonName(day.Month()) + " " + fmt.Sprint(day.Year())
}

// SeasonName is the season word for a month, without a year.
func SeasonName(month time.Month) string {
	switch month {
	case time.March, time.April, time.May:
		return "Spring"
	case time.June, time.July, time.August:
		return "Summer"
	case time.September, time.October, time.November:
		return "Fall"
	default:
		return "Winter"
	}
}

// BloomObservation is one bloom_observations row as the lot prefill reads it.
type BloomObservation struct {
	Species   string
	Abundance *int
	DateFirst time.Time
	DateLast  *time.Time
	Notes     *string
}

// DefaultBloomSpan is how long a bloom is assumed to last when the observer
// never recorded a last-seen date.
const DefaultBloomSpan = 21 * 24 * time.Hour

// BloomLookback is how far before the pull date the prefill looks for blooms
// that could have made the honey.
const BloomLookback = 45 * 24 * time.Hour

// bloomAbundanceLabels mirrors the flora tab's 1-5 scale.
var bloomAbundanceLabels = [...]string{"Trace", "Light", "Moderate", "Heavy", "Peak"}

// AbundanceLabel names a 1-5 abundance rating; out-of-range ratings are
// rendered as their number so nothing typed is lost.
func AbundanceLabel(abundance int) string {
	if abundance >= 1 && abundance <= len(bloomAbundanceLabels) {
		return bloomAbundanceLabels[abundance-1]
	}
	return fmt.Sprint(abundance)
}

// BloomWindowEnd is the last day a bloom is assumed to be on: the recorded
// last-seen date, else first-seen plus DefaultBloomSpan.
func BloomWindowEnd(first time.Time, last *time.Time) time.Time {
	if last != nil {
		return *last
	}
	return first.Add(DefaultBloomSpan)
}

// BloomOverlaps reports whether a bloom's window [first, end] touches
// [from, to]; all four are calendar days.
func BloomOverlaps(first time.Time, last *time.Time, from, to time.Time) bool {
	end := BloomWindowEnd(first, last)
	return !first.After(to) && !end.Before(from)
}

// FormatBloomNote renders one observation as a single line:
// "<species> (<abundance>) — first seen <Mon D>[, last seen <Mon D>][ — <notes>]".
// The abundance clause is omitted when the observer did not rate it.
func FormatBloomNote(observation BloomObservation) string {
	var b strings.Builder
	b.WriteString(strings.TrimSpace(observation.Species))
	if observation.Abundance != nil {
		b.WriteString(" (")
		b.WriteString(AbundanceLabel(*observation.Abundance))
		b.WriteString(")")
	}
	b.WriteString(" — first seen ")
	b.WriteString(formatMonthDay(observation.DateFirst))
	if observation.DateLast != nil {
		b.WriteString(", last seen ")
		b.WriteString(formatMonthDay(*observation.DateLast))
	}
	if observation.Notes != nil {
		if notes := strings.TrimSpace(*observation.Notes); notes != "" {
			b.WriteString(" — ")
			b.WriteString(notes)
		}
	}
	return b.String()
}

// FormatBloomNotes joins one FormatBloomNote line per observation, in the
// order given (callers order by date_first_seen). Nil when there is nothing
// to say, so the lot's bloom_notes stays NULL rather than "".
func FormatBloomNotes(observations []BloomObservation) *string {
	if len(observations) == 0 {
		return nil
	}
	lines := make([]string, 0, len(observations))
	for _, observation := range observations {
		lines = append(lines, FormatBloomNote(observation))
	}
	joined := strings.Join(lines, "\n")
	return &joined
}

// formatMonthDay renders "Jun 3" style dates: month abbreviation, day with no
// leading zero.
func formatMonthDay(day time.Time) string {
	return fmt.Sprintf("%s %d", day.Month().String()[:3], day.Day())
}
