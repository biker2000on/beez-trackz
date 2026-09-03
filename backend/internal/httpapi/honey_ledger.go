package httpapi

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"sort"

	"github.com/biker2000on/beez-trackz/backend/internal/app"
	"github.com/biker2000on/beez-trackz/backend/internal/app/production"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Shared honey derivations. Every surface that reports a quantity reads it
// from here, so two endpoints can never disagree about the same number.
//
// Since the inventory ledger landed (docs/plans/2026-09-01-inventory-ledger-design.md)
// the numbers come from the ledger's projections — inventory_balances for what
// physically stands somewhere, inventory_available for what can still be sold
// — and never from honey_movements, stock_movements, or product_adjustments.
// The breakdown columns (jarred, given away, adjusted) are history aggregates
// over inventory_operations, classified through the operation a reversal
// points at so a reversed movement nets out on its own.

// honeyBulkLockKey serializes the honey commands that used to derive bulk
// on-hand by hand. Review A4 makes the inventory service the only quantity
// locker; this advisory lock is SUBSUMED into the order documented in
// app/inventory/doc.go rather than deleted, and is always taken before any
// tuple lock.
const honeyBulkLockKey int64 = 8_472_113_001

// ledgerClassifiedCTE resolves every movement to the operation that gives it
// meaning: itself, or — when it is a reversal — the operation it negates.
// Without it a reversal would land in no bucket and the breakdowns would drift
// away from the balances.
const ledgerClassifiedCTE = `
	classified AS (
		SELECT m.item_id, m.lot_id, m.location_id, m.quantity,
		       COALESCE(orig.id, o.id) AS classified_operation_id,
		       COALESCE(orig.kind, o.kind) AS kind,
		       COALESCE(orig.reason, o.reason) AS reason,
		       COALESCE(orig.source_type, o.source_type) AS source_type
		FROM inventory_movements m
		JOIN inventory_operations o ON o.id = m.operation_id
		LEFT JOIN inventory_operations orig ON orig.id = o.reverses_operation_id
	)`

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
// Pounds harvested stay a domain sum over harvest sessions and session-less
// harvests: a trued-up extracted weight is authoritative when set, otherwise
// the session falls back to the sum of its live entries, and soft-deleted
// entries never count. Everything else is the ledger: bulk on hand IS the
// honey_bulk balance across its lots (decision 6), and the three draw columns
// are what transforms into jars, transforms into catalog products, and shrink
// took out of it. The output-item classification deliberately ignores
// source_type so imported and live transforms report the same history.
func honeyBulkOnHand(ctx context.Context, q inspectionQuerier) (honeyBulkTotals, error) {
	var totals honeyBulkTotals
	err := q.QueryRow(ctx, `
		WITH `+ledgerClassifiedCTE+`
		SELECT
			(SELECT COALESCE(SUM(session_lbs), 0) FROM (
				SELECT COALESCE(NULLIF(hs.total_extracted_weight, 0),
				                (SELECT COALESCE(SUM(hh.calculated_honey_weight), 0)
				                 FROM honey_harvests hh
				                 WHERE hh.session_id = hs.id AND hh.deleted_at IS NULL)) AS session_lbs
				FROM harvest_sessions hs) sessions) +
			(SELECT COALESCE(SUM(calculated_honey_weight), 0)
			 FROM honey_harvests WHERE session_id IS NULL AND deleted_at IS NULL),
			COALESCE((SELECT SUM(-c.quantity) FROM classified c
			          WHERE c.item_id=$1 AND c.kind='transform'
			            AND EXISTS (
			              SELECT 1 FROM inventory_movements output
			              JOIN inventory_items output_item ON output_item.id=output.item_id
			              WHERE output.operation_id=c.classified_operation_id
			                AND output.quantity > 0 AND output_item.kind='jar'
			            )), 0)::float8,
			COALESCE((SELECT SUM(-c.quantity) FROM classified c
			          WHERE c.item_id=$1 AND (
			            (c.kind='transform' AND EXISTS (
			              SELECT 1 FROM inventory_movements output
			              JOIN inventory_items output_item ON output_item.id=output.item_id
			              WHERE output.operation_id=c.classified_operation_id
			                AND output.quantity > 0 AND output_item.kind='catalog_product'
			            )) OR (c.kind='shrink' AND c.reason <> 'loss')
			          )), 0)::float8,
			COALESCE((SELECT SUM(-quantity) FROM classified
			          WHERE item_id=$1 AND kind='shrink' AND reason='loss'), 0)::float8,
			COALESCE((SELECT SUM(on_hand) FROM inventory_balances WHERE item_id=$1), 0)::float8`,
		production.HoneyBulkItemID).
		Scan(&totals.TotalHarvestedLbs, &totals.JarredLbs, &totals.BulkUsedLbs,
			&totals.LossLbs, &totals.BulkOnHandLbs)
	if err != nil {
		return honeyBulkTotals{}, err
	}
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

// appActor is the application-layer identity for a command started by this
// request. Handlers are transport: they authorize, then hand the command an
// actor. No HTTP session can produce the restore actor.
func appActor(r *http.Request) app.Actor {
	if user := principalFrom(r); user != nil && user.ID != uuid.Nil {
		return app.UserActor(user.ID, user.DisplayName)
	}
	return app.SystemJobActor("httpapi")
}

// runInUnitOfWork runs fn as this request's actor inside one transaction.
func (s *Server) runInUnitOfWork(
	r *http.Request, fn func(context.Context, *app.UnitOfWork) error,
) error {
	return app.NewRunner(s.pool).Run(r.Context(), appActor(r), fn)
}

// honeyHomeJarAvailability reports what each jar size can still be sold at
// HOME, from inventory_available.
//
// It replaces honeyLockJarSizes. Review A4 removed the jar_sizes row locks it
// used to take: quantity locking now belongs to the inventory service alone,
// which takes tuple locks in a documented order inside Record and
// CheckAvailable. The name and signature are kept while routes_jar_sizes.go
// still calls it; that handler moves with the equipment wave.
//
// Home, not the global total: jars consigned to the bike shop are still the
// operator's inventory but they are not on the table at market day, and
// letting the guard count them lets you sell the same jar twice.
func honeyLockJarSizes(
	ctx context.Context,
	tx inspectionQuerier,
	jarSizeIDs []uuid.UUID,
) (onHand map[uuid.UUID]int, labels map[uuid.UUID]string, unknown bool, err error) {
	unique := stockUniqueIDs(jarSizeIDs)
	rows, err := tx.Query(ctx, `
		SELECT js.id, js.label,
		       COALESCE((SELECT SUM(a.available) FROM inventory_available a
		                 JOIN inventory_locations l ON l.id = a.location_id
		                 WHERE a.item_id = js.item_id AND l.is_home), 0)::int
		FROM jar_sizes js WHERE js.id = ANY($1) ORDER BY js.id`, unique)
	if err != nil {
		return nil, nil, false, err
	}
	defer rows.Close()
	onHand = make(map[uuid.UUID]int, len(unique))
	labels = make(map[uuid.UUID]string, len(unique))
	for rows.Next() {
		var id uuid.UUID
		var label string
		var available int
		if err := rows.Scan(&id, &label, &available); err != nil {
			return nil, nil, false, err
		}
		onHand[id] = available
		labels[id] = label
	}
	if err := rows.Err(); err != nil {
		return nil, nil, false, err
	}
	return onHand, labels, len(onHand) != len(unique), nil
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

// honeyLockBulk takes the bulk-honey advisory lock and reports the current
// totals. The lock is class 2 of the order in app/inventory/doc.go: it is
// subsumed by the ledger's tuple locks rather than replaced (review A4,
// outside voice finding 10), and is always taken before Record or
// CheckAvailable so the two disciplines have one order.
func honeyLockBulk(ctx context.Context, tx inspectionQuerier) (honeyBulkTotals, error) {
	if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock($1)`, honeyBulkLockKey); err != nil {
		return honeyBulkTotals{}, err
	}
	return honeyBulkOnHand(ctx, tx)
}

// honeyPoundTolerance is the mass comparison tolerance; pounds are genuinely
// fractional measurements, unlike money and jar counts.
const honeyPoundTolerance = production.PoundTolerance

// honeyBulkShortfall formats the 400 message for a withdrawal larger than the
// bulk honey on hand.
func honeyBulkShortfall(requestedLbs, availableLbs float64) string {
	if requestedLbs <= availableLbs+honeyPoundTolerance {
		return ""
	}
	return fmt.Sprintf("Not enough bulk honey: need %.2f lbs, have %.2f lbs",
		requestedLbs, availableLbs)
}

// honeyLotShortfall is honeyBulkShortfall for one lot's bucket.
func honeyLotShortfall(requestedLbs, availableLbs float64, lotCode string) string {
	if requestedLbs <= availableLbs+honeyPoundTolerance {
		return ""
	}
	return fmt.Sprintf("Lot %s has %.2f lbs left; this needs %.2f lbs",
		lotCode, availableLbs, requestedLbs)
}

// honeyLockLot takes the harvest lot's row lock — a DOMAIN lock on the lot's
// identity, class 2 of honeyLockOrder, always before any tuple lock — and
// reports what that lot still holds from inventory_balances.
//
// The row lock stays because two commands must not edit the same lot's
// identity concurrently. The quantity it reports is the ledger's, not a
// second derivation: the pounds a lot holds are its receipt minus everything
// drawn from it.
func honeyLockLot(
	ctx context.Context,
	tx inspectionQuerier,
	lotID uuid.UUID,
) (lotCode string, onHandLbs float64, err error) {
	if err = tx.QueryRow(ctx,
		`SELECT lot_code FROM harvest_lots WHERE id=$1 FOR UPDATE`, lotID).
		Scan(&lotCode); err != nil {
		return "", 0, err
	}
	if err = tx.QueryRow(ctx, `
		SELECT COALESCE((SELECT SUM(b.on_hand) FROM inventory_balances b
		                 JOIN harvest_lots hl ON hl.inventory_lot_id = b.lot_id
		                 WHERE hl.id = $1 AND b.item_id = $2), 0)::float8`,
		lotID, production.HoneyBulkItemID).Scan(&onHandLbs); err != nil {
		return "", 0, err
	}
	return lotCode, onHandLbs, nil
}

// --- stock locations -------------------------------------------------------
//
// Finished goods (jar sizes and product_catalog SKUs) can stand somewhere
// other than home — consigned to the bike shop, most of all. Home is no
// longer the residual of a second ledger: every location, home included, owns
// its own movements, so "what is at the shop" and "what is at home" are two
// reads of the same projection and cannot drift apart.
//
// During Phase A stock_locations is still the catalog the API exposes; each
// row has an inventory_locations twin that carries the quantities, created on
// demand by app/production.EnsureLocationForStockLocation.

// stockHomeSlug names the one row that is is_home.
const stockHomeSlug = "home"

// stockHomeLocationID resolves the home stock location, creating it if a
// database (a truncated test one, most likely) has lost the row seeded by
// 00024.
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

// stockAwayQuantities is THE away-from-home formula: every non-home
// location's count per SKU, keyed by the stock_locations id the API exposes.
//
// It reads inventory_available rather than inventory_balances because a sale
// scoped to a location takes stock off that shelf the moment the line is
// saved, which is what every caller of this function is asking about.
func stockAwayQuantities(
	ctx context.Context,
	q inspectionQuerier,
) ([]stockLocationQuantity, error) {
	rows, err := q.Query(ctx, `
		SELECT l.source_id, js.id, pc.id, SUM(a.available)::int
		FROM inventory_available a
		JOIN inventory_locations l ON l.id = a.location_id
		LEFT JOIN jar_sizes js ON js.item_id = a.item_id
		LEFT JOIN product_catalog pc ON pc.item_id = a.item_id
		WHERE l.source_type = 'stock_location' AND NOT l.is_home
		  AND (js.id IS NOT NULL OR pc.id IS NOT NULL)
		GROUP BY 1, 2, 3
		HAVING SUM(a.available) <> 0`)
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

// stockAwayJarTotals sums away-from-home jars per size.
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

// stockUniqueIDs sorts and deduplicates ids so a "found == requested" count
// stays meaningful.
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

// poolQuerier lets a handler pass either the pool or a unit of work to a read
// helper without either one caring which it got.
var _ inspectionQuerier = (*pgxpool.Pool)(nil)

// writeCommandError maps an application-layer error onto the response. The
// app package is transport-free on purpose (internal/app/doc.go): each edge
// maps Kind to its own vocabulary, and this is the HTTP one. An equipError
// raised by a handler's own guard keeps the status it chose.
func writeCommandError(w http.ResponseWriter, err error) {
	if err == nil {
		return
	}
	var known equipError
	if errors.As(err, &known) {
		writeError(w, known.status, known.message)
		return
	}
	var typed *app.Error
	if !errors.As(err, &typed) {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	message := typed.Message
	if message == "" {
		message = "database error"
	}
	switch typed.Kind {
	case app.KindInvalid:
		writeError(w, http.StatusBadRequest, message)
	case app.KindNotFound:
		writeError(w, http.StatusNotFound, message)
	case app.KindConflict:
		writeError(w, http.StatusConflict, message)
	case app.KindForbidden:
		writeError(w, http.StatusForbidden, message)
	case app.KindPrecondition:
		// A stock refusal: the request is well formed but the shelf cannot
		// cover it, which every caller of these endpoints reads as a 400.
		writeError(w, http.StatusBadRequest, message)
	case app.KindUnsupported:
		writeError(w, http.StatusUnprocessableEntity, message)
	default:
		writeError(w, http.StatusInternalServerError, "database error")
	}
}

// dbCommandError is writeDBError for a command running inside a unit of work:
// it classifies the driver error and returns it instead of writing a
// response, so the caller's transaction can still roll back.
func dbCommandError(err error, uniqueMsg, fkMsg string) error {
	switch pgErrCode(err) {
	case "23505":
		return equipFail(http.StatusConflict, "%s", uniqueMsg)
	case "23503":
		return equipFail(http.StatusBadRequest, "%s", fkMsg)
	}
	return err
}
