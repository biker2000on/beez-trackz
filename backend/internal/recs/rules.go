// Package recs implements the recommendations rules engine ported from the
// legacy TypeScript implementation (src/lib/recommendations/{rules,engine}.ts).
package recs

import (
	"context"
	"encoding/json"
	"fmt"
	"math"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// Result is a single recommendation produced by a rule.
type Result struct {
	// HiveID is the target hive (nil = apiary-wide).
	HiveID   *string
	Message  string
	Priority string // low | normal | high | urgent
}

type rule struct {
	Type  string
	Check func(ctx context.Context, pool *pgxpool.Pool, now time.Time) ([]Result, error)
}

func allRules() []rule {
	return []rule{
		{Type: "inspection_due", Check: checkInspectionDue},
		{Type: "treatment_reminder", Check: checkTreatmentReminder},
		{Type: "equipment_needed", Check: checkEquipmentNeeded},
		{Type: "feeder_check", Check: checkFeederCheck},
		{Type: "seasonal_prep", Check: checkSeasonalPrep},
	}
}

// RuleCount reports how many rules the engine evaluates per run.
func RuleCount() int { return len(allRules()) }

// daysBetween returns the floor of the day difference b - a.
func daysBetween(a, b time.Time) int {
	return int(math.Floor(b.Sub(a).Hours() / 24))
}

// estimateTreatmentDurationDays estimates treatment duration in days based on
// the method/type string. Conservative defaults so we remind rather than miss.
func estimateTreatmentDurationDays(method string) int {
	lower := strings.ToLower(method)
	has := func(s string) bool { return strings.Contains(lower, s) }
	switch {
	case has("oxalic") && has("vapor"):
		return 7
	case has("oxalic"):
		return 1 // oxalic acid dribble — single application
	case has("apivar"), has("amitraz"):
		return 42
	case has("apiguard"), has("thymol"):
		return 28
	case has("formic"), has("mite away"):
		return 14
	case has("hopguard"):
		return 30
	case has("checkmite"), has("coumaphos"):
		return 42
	default:
		return 14
	}
}

// ---------------------------------------------------------------------------
// Rule: inspection_due
// ---------------------------------------------------------------------------

func checkInspectionDue(ctx context.Context, pool *pgxpool.Pool, now time.Time) ([]Result, error) {
	const defaultIntervalDays = 14

	rows, err := pool.Query(ctx, `
		SELECT h.id, h.position_label,
		       (SELECT max(i.date) FROM inspections i WHERE i.hive_id = h.id)
		FROM hives h
		WHERE h.status = 'active' AND h.is_archived = false`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var results []Result
	for rows.Next() {
		var (
			hiveID   string
			label    string
			lastDate *time.Time
		)
		if err := rows.Scan(&hiveID, &label, &lastDate); err != nil {
			return nil, err
		}

		if lastDate == nil {
			// Never inspected
			id := hiveID
			results = append(results, Result{
				HiveID:   &id,
				Message:  fmt.Sprintf(`Hive "%s" has never been inspected. Schedule an inspection soon.`, label),
				Priority: "high",
			})
			continue
		}

		overdueDays := daysBetween(*lastDate, now) - defaultIntervalDays
		id := hiveID
		switch {
		case overdueDays > 14:
			results = append(results, Result{
				HiveID:   &id,
				Message:  fmt.Sprintf(`Hive "%s" is %d days since last inspection. Immediate inspection recommended.`, label, overdueDays+defaultIntervalDays),
				Priority: "urgent",
			})
		case overdueDays > 7:
			results = append(results, Result{
				HiveID:   &id,
				Message:  fmt.Sprintf(`Hive "%s" is %d days since last inspection.`, label, overdueDays+defaultIntervalDays),
				Priority: "high",
			})
		case overdueDays > 0:
			results = append(results, Result{
				HiveID:   &id,
				Message:  fmt.Sprintf(`Hive "%s" inspection is overdue by %d days.`, label, overdueDays),
				Priority: "normal",
			})
		}
	}
	return results, rows.Err()
}

// ---------------------------------------------------------------------------
// Rule: treatment_reminder
// ---------------------------------------------------------------------------

// treatmentMethod extracts a display/matching string from one treatments entry.
// Entries may be plain strings or objects with method/name/type/product keys.
func treatmentMethod(t any) string {
	switch v := t.(type) {
	case string:
		return v
	case map[string]any:
		for _, key := range []string{"method", "name", "type", "product"} {
			if s, ok := v[key].(string); ok {
				return s
			}
		}
		if b, err := json.Marshal(v); err == nil {
			return string(b)
		}
		return fmt.Sprint(v)
	default:
		return fmt.Sprint(t)
	}
}

func checkTreatmentReminder(ctx context.Context, pool *pgxpool.Pool, now time.Time) ([]Result, error) {
	// Latest inspection with treatments recorded, per active hive.
	rows, err := pool.Query(ctx, `
		SELECT DISTINCT ON (i.hive_id) i.hive_id, i.date, i.treatments, h.position_label
		FROM inspections i
		JOIN hives h ON h.id = i.hive_id
		WHERE h.status = 'active' AND h.is_archived = false
		  AND i.treatments IS NOT NULL AND jsonb_typeof(i.treatments) <> 'null'
		ORDER BY i.hive_id, i.date DESC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var results []Result
	for rows.Next() {
		var (
			hiveID     string
			date       time.Time
			treatments []byte
			label      string
		)
		if err := rows.Scan(&hiveID, &date, &treatments, &label); err != nil {
			return nil, err
		}

		var parsed any
		if err := json.Unmarshal(treatments, &parsed); err != nil {
			continue
		}
		list, ok := parsed.([]any)
		if !ok {
			list = []any{parsed}
		}

		for _, t := range list {
			method := treatmentMethod(t)
			durationDays := estimateTreatmentDurationDays(method)
			daysSinceTreatment := daysBetween(date, now)

			if daysSinceTreatment >= durationDays {
				overdue := daysSinceTreatment - durationDays
				priority := "normal"
				if overdue > 7 {
					priority = "high"
				}
				id := hiveID
				results = append(results, Result{
					HiveID:   &id,
					Message:  fmt.Sprintf(`Treatment "%s" on hive "%s" may need follow-up. Applied %d days ago (estimated %d-day duration).`, method, label, daysSinceTreatment, durationDays),
					Priority: priority,
				})
			}
		}
	}
	return results, rows.Err()
}

// ---------------------------------------------------------------------------
// Rule: equipment_needed
// ---------------------------------------------------------------------------

func checkEquipmentNeeded(ctx context.Context, pool *pgxpool.Pool, _ time.Time) ([]Result, error) {
	// Frame shortage per hive from active deployments: box deployments provide
	// capacity (frames_per_box), frame deployments fill it.
	rows, err := pool.Query(ctx, `
		SELECT d.hive_id, h.position_label, d.quantity - d.quantity_returned,
			t.category, t.frames_per_box
		FROM equipment_deployments d
		JOIN equipment_stock s ON s.id = d.stock_id
		JOIN equipment_types t ON t.id = s.type_id
		JOIN hives h ON h.id = d.hive_id
		WHERE d.date_removed IS NULL AND d.quantity > d.quantity_returned
			AND h.status = 'active' AND h.is_archived = false`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	type shortage struct {
		hiveName       string
		totalCapacity  int
		totalInstalled int
	}
	entries := map[string]*shortage{}
	var order []string // stable iteration order

	for rows.Next() {
		var (
			hiveID       string
			label        string
			quantity     int
			category     string
			framesPerBox *int
		)
		if err := rows.Scan(&hiveID, &label, &quantity, &category, &framesPerBox); err != nil {
			return nil, err
		}
		entry, ok := entries[hiveID]
		if !ok {
			entry = &shortage{hiveName: label}
			entries[hiveID] = entry
			order = append(order, hiveID)
		}
		if category == "box" && framesPerBox != nil && *framesPerBox != 0 {
			entry.totalCapacity += quantity * *framesPerBox
		} else if category == "frame" {
			entry.totalInstalled += quantity
		}
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}

	var results []Result
	for _, hiveID := range order {
		entry := entries[hiveID]
		short := entry.totalCapacity - entry.totalInstalled
		if short > 0 {
			pct := int(math.Round(float64(short) / float64(entry.totalCapacity) * 100))
			priority := "normal"
			if pct > 50 {
				priority = "high"
			}
			id := hiveID
			results = append(results, Result{
				HiveID:   &id,
				Message:  fmt.Sprintf(`Hive "%s" needs %d more frames (%d%% capacity unfilled).`, entry.hiveName, short, pct),
				Priority: priority,
			})
		}
	}
	return results, nil
}

// ---------------------------------------------------------------------------
// Rule: feeder_check
// ---------------------------------------------------------------------------

func checkFeederCheck(ctx context.Context, pool *pgxpool.Pool, now time.Time) ([]Result, error) {
	const defaultCheckDays = 7

	// Active feeders are the explicitly open ones (migration
	// 00007_feeding_lifecycle). Legacy records with no recorded end are
	// 'unverified' and are handled by the dashboard feeding-status row, which
	// carries the evidence needed to close them, instead of generating the
	// same generic feeder reminder forever.
	rows, err := pool.Query(ctx, `
		SELECT f.hive_id, f.date_fed, f.type, h.position_label
		FROM feedings f
		JOIN hives h ON h.id = f.hive_id
		WHERE f.status = 'open'`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var results []Result
	for rows.Next() {
		var (
			hiveID   string
			dateFed  time.Time
			feedType string
			label    string
		)
		if err := rows.Scan(&hiveID, &dateFed, &feedType, &label); err != nil {
			return nil, err
		}

		daysSinceFed := daysBetween(dateFed, now)
		if daysSinceFed >= defaultCheckDays {
			priority := "normal"
			if daysSinceFed > 14 {
				priority = "high"
			}
			id := hiveID
			results = append(results, Result{
				HiveID:   &id,
				Message:  fmt.Sprintf(`Feeder on hive "%s" (%s) placed %d days ago. Check if empty or needs refill.`, label, strings.ReplaceAll(feedType, "_", " "), daysSinceFed),
				Priority: priority,
			})
		}
	}
	return results, rows.Err()
}

// ---------------------------------------------------------------------------
// Rule: seasonal_prep
// ---------------------------------------------------------------------------

func checkSeasonalPrep(ctx context.Context, pool *pgxpool.Pool, now time.Time) ([]Result, error) {
	var (
		seasonalMessage string
		priority        string
	)
	switch now.Month() {
	case time.February, time.March: // Spring buildup
		seasonalMessage = "Spring buildup season. Check food stores, assess colony strength, and consider supplemental feeding if stores are low."
		priority = "normal"
	case time.April, time.May: // Swarm season
		seasonalMessage = "Swarm season alert. Inspect for swarm cells, ensure adequate space, and consider splits for strong colonies."
		priority = "high"
	case time.September, time.October: // Fall prep
		seasonalMessage = "Fall preparation time. Assess winter stores, treat for varroa if needed, and reduce entrances."
		priority = "high"
	case time.December, time.January: // Winter check
		seasonalMessage = "Winter monitoring period. Check hive weight for adequate stores, ensure ventilation, and minimize disturbance."
		priority = "low"
	default:
		return nil, nil
	}

	rows, err := pool.Query(ctx, `
		SELECT h.id, h.position_label
		FROM hives h
		WHERE h.status = 'active' AND h.is_archived = false`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var results []Result
	for rows.Next() {
		var hiveID, label string
		if err := rows.Scan(&hiveID, &label); err != nil {
			return nil, err
		}
		id := hiveID
		results = append(results, Result{
			HiveID:   &id,
			Message:  fmt.Sprintf(`%s (Hive: %s)`, seasonalMessage, label),
			Priority: priority,
		})
	}
	return results, rows.Err()
}
