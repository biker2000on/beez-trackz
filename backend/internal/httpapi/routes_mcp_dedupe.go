package httpapi

import (
	"context"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"
)

// MCP write deduplication (Contract 4). Before inserting, a write tool looks
// for a record with the same natural key and returns it instead of writing a
// second copy, unless the caller passes allowDuplicate. The keys:
//
//	inspection          hive + date
//	feeding             hive + date + type
//	mite count          hive + date + method
//	treatment           hive + date + product (case-insensitive)
//	queen event         hive + date + type
//	apiary observation  apiary + observedAt + notes
//	bloom observation   apiary + dateFirstSeen + species (case-insensitive)
//
// "Date" is the calendar day (eventDay), so a record written as 2026-09-13
// matches one stored at 13:41 that day.

const (
	dedupeInspection        = "inspection"
	dedupeFeeding           = "feeding"
	dedupeMiteCount         = "mite_count"
	dedupeTreatment         = "treatment"
	dedupeQueenEvent        = "queen_event"
	dedupeApiaryObservation = "apiary_observation"
	dedupeBloomObservation  = "bloom_observation"
)

// mcpDuplicate is the response a write tool returns instead of writing.
type mcpDuplicate struct {
	Duplicate  bool      `json:"duplicate"`
	ExistingID uuid.UUID `json:"existingId"`
	Record     any       `json:"record"`
}

// dedupeFirstOnDay runs query with args plus a widened instant window around
// day ($n+1, $n+2) and returns the first row whose timestamp falls on day.
// The query must select (id, timestamp).
func dedupeFirstOnDay(
	ctx context.Context,
	q inspectionQuerier,
	query string,
	day time.Time,
	args ...any,
) (*uuid.UUID, error) {
	lower, upper := day.AddDate(0, 0, -2), day.AddDate(0, 0, 3)
	rows, err := q.Query(ctx, query, append(args, lower, upper)...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var id uuid.UUID
		var at time.Time
		if err := rows.Scan(&id, &at); err != nil {
			return nil, err
		}
		if eventDay(at).Equal(day) {
			found := id
			return &found, nil
		}
	}
	return nil, rows.Err()
}

func findDuplicateInspection(ctx context.Context, q inspectionQuerier, hiveID uuid.UUID, day time.Time) (*uuid.UUID, error) {
	return dedupeFirstOnDay(ctx, q, `
		SELECT id, date FROM inspections
		WHERE hive_id = $1 AND date >= $2 AND date < $3
		ORDER BY created_at, id`, day, hiveID)
}

func findDuplicateFeeding(ctx context.Context, q inspectionQuerier, hiveID uuid.UUID, day time.Time, feedType string) (*uuid.UUID, error) {
	return dedupeFirstOnDay(ctx, q, `
		SELECT id, date_fed FROM feedings
		WHERE hive_id = $1 AND type::text = $2 AND date_fed >= $3 AND date_fed < $4
		ORDER BY created_at, id`, day, hiveID, feedType)
}

func findDuplicateMiteCount(ctx context.Context, q inspectionQuerier, hiveID uuid.UUID, day time.Time, method string) (*uuid.UUID, error) {
	return dedupeFirstOnDay(ctx, q, `
		SELECT id, date FROM mite_counts
		WHERE hive_id = $1 AND method = $2 AND deleted_at IS NULL
		  AND date >= $3 AND date < $4
		ORDER BY created_at, id`, day, hiveID, method)
}

func findDuplicateTreatment(ctx context.Context, q inspectionQuerier, hiveID uuid.UUID, day time.Time, product string) (*uuid.UUID, error) {
	return dedupeFirstOnDay(ctx, q, `
		SELECT id, date_applied FROM treatment_events
		WHERE hive_id = $1 AND lower(btrim(product)) = lower(btrim($2::text))
		  AND deleted_at IS NULL AND date_applied >= $3 AND date_applied < $4
		ORDER BY created_at, id`, day, hiveID, product)
}

func findDuplicateQueenEvent(ctx context.Context, q inspectionQuerier, hiveID uuid.UUID, day time.Time, eventType string) (*uuid.UUID, error) {
	return dedupeFirstOnDay(ctx, q, `
		SELECT id, event_date FROM queen_events
		WHERE hive_id = $1 AND event_type = $2 AND event_date >= $3 AND event_date < $4
		ORDER BY created_at, id`, day, hiveID, eventType)
}

func findDuplicateBloom(ctx context.Context, q inspectionQuerier, apiaryID uuid.UUID, day time.Time, species string) (*uuid.UUID, error) {
	// date_first_seen is a date column; it scans as midnight UTC, which
	// eventDay reads as that calendar date.
	return dedupeFirstOnDay(ctx, q, `
		SELECT id, date_first_seen::timestamp AT TIME ZONE 'UTC' FROM bloom_observations
		WHERE apiary_id = $1 AND lower(btrim(species)) = lower(btrim($2::text))
		  AND date_first_seen >= $3::date AND date_first_seen < $4::date
		ORDER BY created_at, id`, day, apiaryID, species)
}

func findDuplicateObservation(ctx context.Context, q inspectionQuerier, apiaryID uuid.UUID, observedAt time.Time, notes string) (*uuid.UUID, error) {
	rows, err := q.Query(ctx, `
		SELECT id FROM apiary_inspections
		WHERE apiary_id = $1 AND observed_at = $2 AND btrim(notes) = btrim($3::text)
		ORDER BY created_at, id LIMIT 1`, apiaryID, observedAt, notes)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	if rows.Next() {
		var id uuid.UUID
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		return &id, nil
	}
	return nil, rows.Err()
}

// --- record loaders for the duplicate response ----------------------------

func (s *Server) treatmentRecord(ctx context.Context, id uuid.UUID) (map[string]any, error) {
	var (
		hiveID         uuid.UUID
		inspectionID   *uuid.UUID
		applied        time.Time
		removed        *time.Time
		product        string
		method, notes  *string
		withdrawalDays int
	)
	if err := s.pool.QueryRow(ctx, `
		SELECT hive_id, inspection_id, date_applied, date_removed, product, method, notes, withdrawal_days
		FROM treatment_events WHERE id = $1`, id).Scan(
		&hiveID, &inspectionID, &applied, &removed, &product, &method, &notes, &withdrawalDays); err != nil {
		return nil, err
	}
	var lockoutUntil *string
	if removed != nil {
		until := formatCivil(lockoutEndDate(*removed, withdrawalDays))
		lockoutUntil = &until
	}
	return map[string]any{
		"id": id, "hiveId": hiveID, "inspectionId": inspectionID,
		"dateApplied": applied, "dateRemoved": removed, "product": product,
		"method": method, "notes": notes, "withdrawalDays": withdrawalDays,
		"lockoutUntil": lockoutUntil,
	}, nil
}

func (s *Server) queenEventRecord(ctx context.Context, id uuid.UUID) (map[string]any, error) {
	var hiveID uuid.UUID
	var queenID *uuid.UUID
	var date time.Time
	var eventType string
	var notes *string
	if err := s.pool.QueryRow(ctx, `
		SELECT hive_id, queen_id, event_date, event_type, notes
		FROM queen_events WHERE id = $1`, id).Scan(&hiveID, &queenID, &date, &eventType, &notes); err != nil {
		return nil, err
	}
	return map[string]any{
		"id": id, "hiveId": hiveID, "queenId": queenID, "eventDate": date,
		"eventType": eventType, "notes": notes,
	}, nil
}

func (s *Server) apiaryObservationRecord(ctx context.Context, id uuid.UUID) (map[string]any, error) {
	var apiaryID uuid.UUID
	var observed, created time.Time
	var notes string
	if err := s.pool.QueryRow(ctx, `
		SELECT apiary_id, observed_at, notes, created_at
		FROM apiary_inspections WHERE id = $1`, id).Scan(&apiaryID, &observed, &notes, &created); err != nil {
		return nil, err
	}
	return map[string]any{
		"id": id, "apiaryId": apiaryID, "observedAt": observed,
		"notes": notes, "createdAt": created,
	}, nil
}

// dedupeRecord loads the existing record a duplicate points at, in the same
// shape the matching create or read returns.
func (s *Server) dedupeRecord(ctx context.Context, kind string, id uuid.UUID) (any, error) {
	switch kind {
	case dedupeInspection:
		return s.inspectionByID(ctx, id)
	case dedupeFeeding:
		return feedingScan(s.pool.QueryRow(ctx,
			`SELECT `+feedingSelectCols+` FROM feedings WHERE id = $1`, id))
	case dedupeMiteCount:
		return scanMiteCount(s.pool.QueryRow(ctx,
			`SELECT `+miteCountSelectCols+` FROM mite_counts WHERE id = $1`, id))
	case dedupeTreatment:
		return s.treatmentRecord(ctx, id)
	case dedupeQueenEvent:
		return s.queenEventRecord(ctx, id)
	case dedupeApiaryObservation:
		return s.apiaryObservationRecord(ctx, id)
	case dedupeBloomObservation:
		return bloomScan(s.pool.QueryRow(ctx,
			`SELECT `+bloomSelectCols+` FROM bloom_observations WHERE id = $1`, id))
	}
	return nil, fmt.Errorf("unknown record kind %q", strings.TrimSpace(kind))
}

// mcpDedupeOr returns the existing record when find reports one (and
// duplicates are not allowed), otherwise runs create.
func (s *Server) mcpDedupeOr(
	ctx context.Context,
	kind string,
	allowDuplicate bool,
	find func() (*uuid.UUID, error),
	create func() (mcpToolResult, error),
) (mcpToolResult, error) {
	if !allowDuplicate {
		existing, err := find()
		if err != nil {
			return mcpToolResult{}, fmt.Errorf("duplicate check failed: %w", err)
		}
		if existing != nil {
			record, err := s.dedupeRecord(ctx, kind, *existing)
			if err != nil {
				return mcpToolResult{}, fmt.Errorf("load existing %s: %w", kind, err)
			}
			return mcpToolSuccess(mcpDuplicate{
				Duplicate: true, ExistingID: *existing, Record: record,
			}), nil
		}
	}
	return create()
}
