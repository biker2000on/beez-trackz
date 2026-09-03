package production

import (
	"context"
	"time"

	"github.com/biker2000on/beez-trackz/backend/internal/app"
	"github.com/biker2000on/beez-trackz/backend/internal/app/work"
	"github.com/google/uuid"
)

// WorkbenchCommand is an action advertised by the production read model.
// Refusals are included beside the affected lot before a caller invokes one.
type WorkbenchCommand = work.Command

type OpenSession struct {
	ID                  uuid.UUID          `json:"id"`
	ApiaryName          string             `json:"apiaryName"`
	Date                time.Time          `json:"date"`
	EntryCount          int                `json:"entryCount"`
	CalculatedTotalLbs  float64            `json:"calculatedTotalLbs"`
	TrueUpDifferenceLbs *float64           `json:"trueUpDifferenceLbs"`
	Commands            []WorkbenchCommand `json:"commands"`
}

type BulkLot struct {
	LotID        uuid.UUID  `json:"lotId"`
	LotCode      string     `json:"lotCode"`
	Varietal     *string    `json:"varietal"`
	AvailableLbs string     `json:"availableLbs"`
	LockedOut    bool       `json:"lockedOut"`
	LockoutUntil *time.Time `json:"lockoutUntil"`
	Explanation  *string    `json:"explanation"`
}

type AwaitingLot struct {
	LotID        uuid.UUID `json:"lotId"`
	LotCode      string    `json:"lotCode"`
	AvailableLbs string    `json:"availableLbs"`
	LockedOut    bool      `json:"lockedOut"`
	Explanation  *string   `json:"explanation"`
}

type JarStock struct {
	JarSizeID uuid.UUID `json:"jarSizeId"`
	Label     string    `json:"label"`
	OnHand    int       `json:"onHand"`
	Reserved  int       `json:"reserved"`
	Available int       `json:"available"`
	ParLevel  int       `json:"parLevel"`
}

type ProductBatchStock struct {
	ID          uuid.UUID `json:"id"`
	ProductName string    `json:"productName"`
	OnHand      int       `json:"onHand"`
}

// WorkbenchView is the cohesive production workbench read model. Quantity
// fields are populated exclusively from inventory_available.
type WorkbenchView struct {
	AsOf                 time.Time           `json:"asOf"`
	Freshness            workbenchFreshness  `json:"freshness"`
	OpenSessions         []OpenSession       `json:"openSessions"`
	BulkOnHand           []BulkLot           `json:"bulkOnHand"`
	LotsAwaitingBottling []AwaitingLot       `json:"lotsAwaitingBottling"`
	JarStock             []JarStock          `json:"jarStock"`
	ProductBatches       []ProductBatchStock `json:"productBatches"`
	Commands             []WorkbenchCommand  `json:"commands"`
}

type workbenchFreshness struct {
	Origin   string     `json:"origin"`
	CachedAt *time.Time `json:"cachedAt"`
	Stale    bool       `json:"stale"`
}

// Workbench composes the complete production screen in one query-service
// call. The service may execute several set-oriented statements, but the
// transport never assembles widgets or calls per-widget endpoints.
func Workbench(ctx context.Context, q app.Querier, actor app.Actor, year int, now time.Time, offline work.OfflinePredicate) (WorkbenchView, error) {
	const op = "read production workbench"
	if q == nil || !actor.Valid() {
		return WorkbenchView{}, app.Forbidden(op, "an authenticated actor is required")
	}
	if year < 2000 || year > 9999 {
		return WorkbenchView{}, app.Invalid(op, "year must be between 2000 and 9999")
	}
	now = now.UTC()
	view := WorkbenchView{
		AsOf: now, Freshness: workbenchFreshness{Origin: "server"},
		OpenSessions: []OpenSession{}, BulkOnHand: []BulkLot{},
		LotsAwaitingBottling: []AwaitingLot{}, JarStock: []JarStock{},
		ProductBatches: []ProductBatchStock{},
		Commands:       []WorkbenchCommand{workbenchCommand("production", "harvest.start_session", "Start extraction day", "POST", "/api/v1/harvest-sessions", "x", actor.MayAdminister(), offline)},
	}

	rows, err := q.Query(ctx, `
		SELECT s.id, s.apiary_id, a.name, s.date, COUNT(h.id)::int,
		       COALESCE(SUM(h.calculated_honey_weight), 0)::float8,
		       CASE WHEN s.total_extracted_weight IS NULL OR s.total_extracted_weight=0
		            THEN NULL ELSE COALESCE(SUM(h.calculated_honey_weight),0)-s.total_extracted_weight END
		FROM harvest_sessions s
		JOIN apiaries a ON a.id=s.apiary_id
		LEFT JOIN honey_harvests h ON h.session_id=s.id AND h.deleted_at IS NULL
		WHERE EXTRACT(YEAR FROM s.date)=$1
		GROUP BY s.id,a.name
		ORDER BY s.date DESC,s.id`, year)
	if err != nil {
		return WorkbenchView{}, app.Wrap(app.KindInternal, op, err)
	}
	for rows.Next() {
		var item OpenSession
		var apiaryID uuid.UUID
		if err := rows.Scan(&item.ID, &apiaryID, &item.ApiaryName, &item.Date, &item.EntryCount, &item.CalculatedTotalLbs, &item.TrueUpDifferenceLbs); err != nil {
			rows.Close()
			return WorkbenchView{}, app.Wrap(app.KindInternal, op, err)
		}
		if !actor.MayViewApiary(apiaryID) {
			continue
		}
		item.Commands = []WorkbenchCommand{workbenchCommand("production", "harvest.add_entry", "Add harvest entry", "POST", "/api/v1/harvest-sessions/"+item.ID.String()+"/entries", "h", actor.MayEditApiary(apiaryID), offline)}
		view.OpenSessions = append(view.OpenSessions, item)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return WorkbenchView{}, app.Wrap(app.KindInternal, op, err)
	}
	rows.Close()

	rows, err = q.Query(ctx, `
		WITH stock AS (
		 SELECT hl.id,hl.lot_code,COALESCE(v.name,hl.honey_variety) varietal,
		        COALESCE(SUM(a.available),0)::numeric(14,3)::text available
		 FROM harvest_lots hl
		 LEFT JOIN honey_varietals v ON v.id=hl.varietal_id
		 LEFT JOIN inventory_available a ON a.item_id=$2 AND a.lot_id=hl.inventory_lot_id
		 WHERE EXTRACT(YEAR FROM hl.extraction_date)=$1
		 GROUP BY hl.id,v.name
		), source_treatments AS (
		 SELECT DISTINCT lhh.lot_id,t.id,t.product,t.date_removed,t.withdrawal_days,
		        (t.date_removed IS NULL OR $3::date < (t.date_removed::date+t.withdrawal_days)) locked
		 FROM harvest_lot_harvests lhh JOIN honey_harvests h ON h.id=lhh.harvest_id AND h.deleted_at IS NULL
		 JOIN treatment_events t ON t.hive_id=h.hive_id AND t.deleted_at IS NULL AND t.date_applied::date<=h.date::date
		), locks AS (
		 SELECT lot_id,BOOL_OR(locked) locked,
		        MAX((date_removed::date+withdrawal_days)) FILTER (WHERE date_removed IS NOT NULL AND locked) until_date,
		        MIN(product) FILTER (WHERE locked) product,
		        BOOL_OR(date_removed IS NULL AND locked) treatment_on
		 FROM source_treatments GROUP BY lot_id
		)
		SELECT s.id,s.lot_code,s.varietal,s.available,COALESCE(l.locked,false),l.until_date,
		 CASE WHEN NOT COALESCE(l.locked,false) THEN NULL
		      WHEN l.treatment_on THEN 'Cannot bottle or sell this lot until '||COALESCE(l.product,'the treatment')||' is removed'
		      ELSE 'Cannot bottle or sell this lot until '||to_char(l.until_date,'YYYY-MM-DD') END
		FROM stock s LEFT JOIN locks l ON l.lot_id=s.id ORDER BY s.lot_code`, year, HoneyBulkItemID, now)
	if err != nil {
		return WorkbenchView{}, app.Wrap(app.KindInternal, op, err)
	}
	for rows.Next() {
		var item BulkLot
		if err := rows.Scan(&item.LotID, &item.LotCode, &item.Varietal, &item.AvailableLbs, &item.LockedOut, &item.LockoutUntil, &item.Explanation); err != nil {
			rows.Close()
			return WorkbenchView{}, app.Wrap(app.KindInternal, op, err)
		}
		view.BulkOnHand = append(view.BulkOnHand, item)
		if item.AvailableLbs != "0.000" {
			view.LotsAwaitingBottling = append(view.LotsAwaitingBottling, AwaitingLot{LotID: item.LotID, LotCode: item.LotCode, AvailableLbs: item.AvailableLbs, LockedOut: item.LockedOut, Explanation: item.Explanation})
		}
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return WorkbenchView{}, app.Wrap(app.KindInternal, op, err)
	}
	rows.Close()

	rows, err = q.Query(ctx, `SELECT js.id,js.label,COALESCE(SUM(a.on_hand),0)::int,COALESCE(SUM(a.reserved),0)::int,COALESCE(SUM(a.available),0)::int,js.low_stock_threshold FROM jar_sizes js LEFT JOIN inventory_available a ON a.item_id=js.item_id GROUP BY js.id ORDER BY js.sort_order,js.label`)
	if err != nil {
		return WorkbenchView{}, app.Wrap(app.KindInternal, op, err)
	}
	for rows.Next() {
		var item JarStock
		if err := rows.Scan(&item.JarSizeID, &item.Label, &item.OnHand, &item.Reserved, &item.Available, &item.ParLevel); err != nil {
			rows.Close()
			return WorkbenchView{}, app.Wrap(app.KindInternal, op, err)
		}
		view.JarStock = append(view.JarStock, item)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return WorkbenchView{}, app.Wrap(app.KindInternal, op, err)
	}
	rows.Close()

	rows, err = q.Query(ctx, `SELECT b.id,p.name,COALESCE(SUM(a.available),0)::int FROM product_batches b JOIN product_catalog p ON p.id=b.product_id LEFT JOIN inventory_available a ON a.item_id=p.item_id AND a.lot_id=b.inventory_lot_id WHERE b.voided_at IS NULL AND EXTRACT(YEAR FROM b.started_at)=$1 GROUP BY b.id,p.name ORDER BY b.started_at DESC`, year)
	if err != nil {
		return WorkbenchView{}, app.Wrap(app.KindInternal, op, err)
	}
	for rows.Next() {
		var item ProductBatchStock
		if err := rows.Scan(&item.ID, &item.ProductName, &item.OnHand); err != nil {
			rows.Close()
			return WorkbenchView{}, app.Wrap(app.KindInternal, op, err)
		}
		view.ProductBatches = append(view.ProductBatches, item)
	}
	if err := rows.Err(); err != nil {
		return WorkbenchView{}, app.Wrap(app.KindInternal, op, err)
	}
	return view, nil
}

func workbenchCommand(namespace, id, label, method, path, keyboard string, permitted bool, offline work.OfflinePredicate) WorkbenchCommand {
	var denied *string
	if !permitted {
		text := "administrator or editor access is required"
		denied = &text
	}
	disposition := work.OfflineOnlyOnline
	var offlineReason *string
	if offline != nil && offline(method, path) {
		disposition = work.OfflineQueueable
	} else {
		text := method + " " + path + " is not in the offline queue manifest; it needs a connection"
		offlineReason = &text
	}
	return WorkbenchCommand{ID: id, Label: label, Method: method, Path: path, BodyTemplate: map[string]any{}, Permitted: permitted, DeniedReason: denied, Offline: disposition, OfflineReason: offlineReason, IdempotencyKeyTemplate: namespace + ":" + id + ":{clientMutationId}", Keyboard: keyboard}
}
