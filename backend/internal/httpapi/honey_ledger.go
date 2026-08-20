package httpapi

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"sort"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
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
// The count is HOME on-hand, not the global total: jars consigned to the bike
// shop are still the operator's inventory but they are not on the table at
// market day, and letting the guard count them lets you sell the same jar
// twice. Every caller of this function is validating a withdrawal from home
// (a sale, a give-away, a reversed jarring, a voided bottling run), so home is
// the number all of them want. Stock standing at another location is only ever
// withdrawn through routes_stock_locations.go, which locks the same jar_sizes
// rows and checks that location instead.
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
	away, err := stockAwayJarTotals(ctx, tx)
	if err != nil {
		return nil, nil, false, err
	}
	onHand = make(map[uuid.UUID]int, len(inventory))
	labels = make(map[uuid.UUID]string, len(inventory))
	for _, row := range inventory {
		onHand[row.JarSizeID] = row.OnHand - away[row.JarSizeID]
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

// --- stock locations -------------------------------------------------------
//
// Finished goods (jar sizes and product_catalog SKUs) can stand somewhere
// other than home — consigned to the bike shop, most of all. Home is the
// RESIDUAL of the one ledger, never a second one:
//
//	onHand(L)    = SUM(stock_movements at L) - sold on sales scoped to L
//	onHand(home) = globalOnHand - SUM over every non-home L
//
// So nothing had to be backfilled when locations arrived, and the two numbers
// cannot drift apart. See migration 00024 for the same statement in SQL.

// stockHomeSlug names the one row that is is_home.
const stockHomeSlug = "home"

// stockHomeLocationID resolves the home location, creating it if a database
// (a truncated test one, most likely) has lost the row seeded by 00024.
// Everything not standing at another location is here by definition.
func stockHomeLocationID(ctx context.Context, q inspectionQuerier) (uuid.UUID, error) {
	var id uuid.UUID
	err := q.QueryRow(ctx, `SELECT id FROM stock_locations WHERE is_home`).Scan(&id)
	if err == nil {
		return id, nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return uuid.Nil, err
	}
	err = q.QueryRow(ctx, `
		INSERT INTO stock_locations (name, slug, is_home, notes)
		VALUES ('Home', $1, true, 'Default location for everything bottled or made.')
		ON CONFLICT (slug) DO UPDATE SET is_home = true
		RETURNING id`, stockHomeSlug).Scan(&id)
	return id, err
}

// stockLocationQuantity is the net count of one SKU standing at one location.
type stockLocationQuantity struct {
	LocationID uuid.UUID
	JarSizeID  *uuid.UUID
	ProductID  *uuid.UUID
	Quantity   int
}

// stockAwayQuantities is THE away-from-home formula: every non-home location's
// net count per SKU. Movements add and subtract; sales scoped to that location
// take stock off its shelf.
//
// Home never appears in the result even when a transfer wrote a row against it
// (the -n half of "24 jars to the shop"): counting that row would subtract the
// same 24 jars twice, once here and once as the residual.
func stockAwayQuantities(
	ctx context.Context,
	q inspectionQuerier,
) ([]stockLocationQuantity, error) {
	rows, err := q.Query(ctx, `
		SELECT location_id, jar_size_id, product_id, SUM(qty)::int
		FROM (
			SELECT m.location_id, m.jar_size_id, m.product_id, m.quantity AS qty
			FROM stock_movements m
			UNION ALL
			SELECT s.stock_location_id, si.jar_size_id, si.product_id, -si.quantity
			FROM sale_items si
			JOIN sales s ON s.id = si.sale_id
			WHERE s.order_status <> 'cancelled'
			  AND s.stock_location_id IS NOT NULL
			  AND (si.jar_size_id IS NOT NULL OR si.product_id IS NOT NULL)
		) movements
		WHERE location_id NOT IN (SELECT id FROM stock_locations WHERE is_home)
		GROUP BY 1, 2, 3
		HAVING SUM(qty) <> 0`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]stockLocationQuantity, 0)
	for rows.Next() {
		var row stockLocationQuantity
		if err := rows.Scan(&row.LocationID, &row.JarSizeID, &row.ProductID,
			&row.Quantity); err != nil {
			return nil, err
		}
		out = append(out, row)
	}
	return out, rows.Err()
}

// stockAwayJarTotals sums away-from-home jars per size. Subtracting it from the
// global ledger gives what is actually on the shelf at home.
func stockAwayJarTotals(
	ctx context.Context,
	q inspectionQuerier,
) (map[uuid.UUID]int, error) {
	quantities, err := stockAwayQuantities(ctx, q)
	if err != nil {
		return nil, err
	}
	totals := make(map[uuid.UUID]int)
	for _, row := range quantities {
		if row.JarSizeID != nil {
			totals[*row.JarSizeID] += row.Quantity
		}
	}
	return totals, nil
}

// stockAwayProductTotals is stockAwayJarTotals for product_catalog SKUs.
func stockAwayProductTotals(
	ctx context.Context,
	q inspectionQuerier,
) (map[uuid.UUID]int, error) {
	quantities, err := stockAwayQuantities(ctx, q)
	if err != nil {
		return nil, err
	}
	totals := make(map[uuid.UUID]int)
	for _, row := range quantities {
		if row.ProductID != nil {
			totals[*row.ProductID] += row.Quantity
		}
	}
	return totals, nil
}

// stockLockProducts is honeyLockJarSizes' counterpart for catalog SKUs: it
// takes the product_catalog row locks so a transfer and a sale of the same
// product cannot both read the same on-hand count and both commit.
func stockLockProducts(
	ctx context.Context,
	tx inspectionQuerier,
	productIDs []uuid.UUID,
) (unknown bool, err error) {
	unique := stockUniqueIDs(productIDs)
	if len(unique) == 0 {
		return false, nil
	}
	rows, err := tx.Query(ctx, `
		SELECT id FROM product_catalog WHERE id = ANY($1) ORDER BY id FOR UPDATE`, unique)
	if err != nil {
		return false, err
	}
	locked := 0
	for rows.Next() {
		locked++
	}
	lockErr := rows.Err()
	rows.Close()
	if lockErr != nil {
		return false, lockErr
	}
	return locked != len(unique), nil
}

// stockUniqueIDs sorts and deduplicates ids so lock order is deterministic
// (no deadlock between two transactions taking the same rows) and a
// "locked == requested" count stays meaningful.
func stockUniqueIDs(ids []uuid.UUID) []uuid.UUID {
	sorted := append([]uuid.UUID(nil), ids...)
	sort.Slice(sorted, func(i, j int) bool { return sorted[i].String() < sorted[j].String() })
	unique := make([]uuid.UUID, 0, len(sorted))
	for i, id := range sorted {
		if i == 0 || sorted[i-1] != id {
			unique = append(unique, id)
		}
	}
	return unique
}
