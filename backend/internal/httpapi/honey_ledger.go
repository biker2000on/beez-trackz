package httpapi

import (
	"context"
	"fmt"
	"net/http"
	"sort"

	"github.com/google/uuid"
)

// Shared honey-ledger derivations. Every surface that reports a quantity of
// honey reads it from here, so two endpoints can never disagree about the same
// number. Inventory is always derived from the append-only ledger; reversing
// entries carry negative quantities and therefore net out on their own.

// honeyBulkLockKey serializes transactions that consume bulk honey. Bulk honey
// has no row of its own to lock, so an advisory lock plays the part that
// SELECT ... FOR UPDATE on jar_sizes plays for jars.
const honeyBulkLockKey int64 = 8_472_113_001

type honeyBulkTotals struct {
	TotalHarvestedLbs float64 `json:"totalHarvestedLbs"`
	JarredLbs         float64 `json:"jarredLbs"`
	BulkUsedLbs       float64 `json:"bulkUsedLbs"`
	LossLbs           float64 `json:"lossLbs"`
	BulkOnHandLbs     float64 `json:"bulkOnHandLbs"`
}

// honeyBulkOnHand is THE bulk-on-hand formula. /honey/overview and
// /honey/production-plan both call it.
//
// Pounds jarred come from the stored amount_lbs on each jarring movement, not
// from a live recomputation of quantity * honey_oz / 16: the ledger records
// what was actually attributed at jarring time, so editing a jar size today
// cannot rewrite last season's history. Migration 00005 backfilled the rows
// that predate that rule.
//
// Per session, a trued-up extracted weight is authoritative when set; otherwise
// the session falls back to the sum of its live entries. Harvests recorded
// outside any session always count. Soft-deleted harvest entries never count.
func honeyBulkOnHand(ctx context.Context, q inspectionQuerier) (honeyBulkTotals, error) {
	var totals honeyBulkTotals
	err := q.QueryRow(ctx, `
		SELECT
			(SELECT COALESCE(SUM(session_lbs), 0) FROM (
				SELECT COALESCE(NULLIF(hs.total_extracted_weight, 0),
				                (SELECT COALESCE(SUM(hh.calculated_honey_weight), 0)
				                 FROM honey_harvests hh
				                 WHERE hh.session_id = hs.id AND hh.deleted_at IS NULL)) AS session_lbs
				FROM harvest_sessions hs) sessions) +
			(SELECT COALESCE(SUM(calculated_honey_weight), 0)
			 FROM honey_harvests WHERE session_id IS NULL AND deleted_at IS NULL),
			COALESCE((SELECT SUM(amount_lbs) FROM honey_movements WHERE kind='jarring'), 0),
			COALESCE((SELECT SUM(amount_lbs) FROM honey_movements WHERE kind='bulk_use'), 0),
			COALESCE((SELECT SUM(amount_lbs) FROM honey_movements WHERE kind='loss'), 0)`).
		Scan(&totals.TotalHarvestedLbs, &totals.JarredLbs, &totals.BulkUsedLbs, &totals.LossLbs)
	if err != nil {
		return honeyBulkTotals{}, err
	}
	totals.BulkOnHandLbs = totals.TotalHarvestedLbs - totals.JarredLbs -
		totals.BulkUsedLbs - totals.LossLbs
	return totals, nil
}

// actorID resolves the authenticated user for created_by / deleted_by columns.
// It is nil-safe: a request without a principal records no actor rather than
// failing the write.
func actorID(r *http.Request) *uuid.UUID {
	user := principalFrom(r)
	if user == nil || user.ID == uuid.Nil {
		return nil
	}
	id := user.ID
	return &id
}

// honeyLockJarSizes takes the row locks that make an availability check
// meaningful, then reports the derived on-hand count per size. Without the
// locks two concurrent checkouts can both observe the same inventory and each
// commit a sale the stock cannot cover.
//
// It returns an error message suitable for a 400 when a jar size id is unknown.
func honeyLockJarSizes(
	ctx context.Context,
	tx inspectionQuerier,
	jarSizeIDs []uuid.UUID,
) (onHand map[uuid.UUID]int, labels map[uuid.UUID]string, unknown bool, err error) {
	sorted := append([]uuid.UUID(nil), jarSizeIDs...)
	sort.Slice(sorted, func(i, j int) bool { return sorted[i].String() < sorted[j].String() })
	// Deduplicate so the "locked == requested" count stays meaningful.
	unique := make([]uuid.UUID, 0, len(sorted))
	for i, id := range sorted {
		if i == 0 || sorted[i-1] != id {
			unique = append(unique, id)
		}
	}

	rows, err := tx.Query(ctx, `
		SELECT id FROM jar_sizes WHERE id = ANY($1) ORDER BY id FOR UPDATE`, unique)
	if err != nil {
		return nil, nil, false, err
	}
	locked := 0
	for rows.Next() {
		locked++
	}
	lockErr := rows.Err()
	rows.Close()
	if lockErr != nil {
		return nil, nil, false, lockErr
	}
	if locked != len(unique) {
		return nil, nil, true, nil
	}

	inventory, err := honeyJarInventoryWithQuerier(ctx, tx)
	if err != nil {
		return nil, nil, false, err
	}
	onHand = make(map[uuid.UUID]int, len(inventory))
	labels = make(map[uuid.UUID]string, len(inventory))
	for _, row := range inventory {
		onHand[row.JarSizeID] = row.OnHand
		labels[row.JarSizeID] = row.Label
	}
	return onHand, labels, false, nil
}

// honeyCheckJarAvailability reports the first line that would drive a jar size
// negative, as a user-facing message. An empty string means every line fits.
func honeyCheckJarAvailability(
	onHand map[uuid.UUID]int,
	labels map[uuid.UUID]string,
	needed map[uuid.UUID]int,
) string {
	ids := make([]uuid.UUID, 0, len(needed))
	for id := range needed {
		ids = append(ids, id)
	}
	sort.Slice(ids, func(i, j int) bool { return ids[i].String() < ids[j].String() })
	for _, id := range ids {
		have := onHand[id]
		if needed[id] > have {
			label, ok := labels[id]
			if !ok {
				label = "jars"
			}
			return fmt.Sprintf("Not enough %s: need %d, have %d", label, needed[id], have)
		}
	}
	return ""
}

// honeyLockBulk takes the advisory lock guarding bulk honey and returns the
// current totals, so a caller can validate a withdrawal against a value no
// concurrent transaction can move underneath it.
func honeyLockBulk(ctx context.Context, tx inspectionQuerier) (honeyBulkTotals, error) {
	if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock($1)`, honeyBulkLockKey); err != nil {
		return honeyBulkTotals{}, err
	}
	return honeyBulkOnHand(ctx, tx)
}

// honeyBulkShortfall formats the 400 message for a withdrawal larger than the
// bulk honey on hand. Pounds are compared with a small tolerance because they
// are genuinely fractional measurements, unlike money and jar counts.
const honeyPoundTolerance = 0.0001

func honeyBulkShortfall(requestedLbs, availableLbs float64) string {
	if requestedLbs <= availableLbs+honeyPoundTolerance {
		return ""
	}
	return fmt.Sprintf("Not enough bulk honey: need %.2f lbs, have %.2f lbs",
		requestedLbs, availableLbs)
}
