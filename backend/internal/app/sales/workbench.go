package sales

import (
	"context"
	"time"

	"github.com/biker2000on/beez-trackz/backend/internal/app"
	"github.com/biker2000on/beez-trackz/backend/internal/app/work"
	"github.com/google/uuid"
)

type WorkbenchCommand = work.Command
type TodayTakings struct {
	SalesCount   int   `json:"salesCount"`
	RevenueCents int64 `json:"revenueCents"`
}
type DraftShortfall struct {
	ItemLabel   string `json:"itemLabel"`
	Wanted      int    `json:"wanted"`
	Available   int    `json:"available"`
	Explanation string `json:"explanation"`
}
type Draft struct {
	SaleID       uuid.UUID        `json:"saleId"`
	CustomerName *string          `json:"customerName"`
	LineCount    int              `json:"lineCount"`
	Shortfalls   []DraftShortfall `json:"shortfalls"`
}

// ConsignmentVarietal is how many units of one varietal stand at a consignee.
// VarietalName is nil for catalog products and legacy-unassigned jar lots.
type ConsignmentVarietal struct {
	VarietalName *string `json:"varietalName"`
	Units        int     `json:"units"`
}
type ConsignmentLocation struct {
	LocationID      uuid.UUID             `json:"locationId"`
	Name            string                `json:"name"`
	UnitsOut        int                   `json:"unitsOut"`
	ByVarietal      []ConsignmentVarietal `json:"byVarietal"`
	SettlementDueAt *time.Time            `json:"settlementDueAt"`
	LastSettledAt   *time.Time            `json:"lastSettledAt"`
}
type SellableItem struct {
	ItemID          uuid.UUID `json:"itemId"`
	Label           string    `json:"label"`
	LotCode         *string   `json:"lotCode"`
	AvailableAtHome int       `json:"availableAtHome"`
}
type workbenchFreshness struct {
	Origin   string     `json:"origin"`
	CachedAt *time.Time `json:"cachedAt"`
	Stale    bool       `json:"stale"`
}
type WorkbenchView struct {
	AsOf         time.Time             `json:"asOf"`
	Freshness    workbenchFreshness    `json:"freshness"`
	TodayTakings TodayTakings          `json:"todayTakings"`
	Drafts       []Draft               `json:"drafts"`
	Consignment  []ConsignmentLocation `json:"consignment"`
	Sellable     []SellableItem        `json:"sellable"`
	Commands     []WorkbenchCommand    `json:"commands"`
}

// Workbench composes Sales in one query-service call. All stock values and
// draft shortfalls read inventory_available; sales rows supply only workflow
// and money facts.
func Workbench(ctx context.Context, q app.Querier, actor app.Actor, year int, now time.Time, offline work.OfflinePredicate) (WorkbenchView, error) {
	const op = "read sales workbench"
	if q == nil || !actor.Valid() {
		return WorkbenchView{}, app.Forbidden(op, "an authenticated actor is required")
	}
	if year < 2000 || year > 9999 {
		return WorkbenchView{}, app.Invalid(op, "year must be between 2000 and 9999")
	}
	now = now.UTC()
	v := WorkbenchView{AsOf: now, Freshness: workbenchFreshness{Origin: "server"}, Drafts: []Draft{}, Consignment: []ConsignmentLocation{}, Sellable: []SellableItem{}, Commands: []WorkbenchCommand{salesWorkbenchCommand("sale.record", "Record sale", "POST", "/api/v1/sales", "s", actor.MayAdminister(), offline), salesWorkbenchCommand("consignment.transfer", "Transfer stock", "POST", "/api/v1/stock-locations/transfers", "t", actor.MayAdminister(), offline)}}
	if err := q.QueryRow(ctx, `SELECT COUNT(*)::int,COALESCE(SUM(amount_paid_cents),0)::bigint FROM sales WHERE order_status<>'cancelled' AND date::date=$1::date AND EXTRACT(YEAR FROM date)=$2`, now, year).Scan(&v.TodayTakings.SalesCount, &v.TodayTakings.RevenueCents); err != nil {
		return WorkbenchView{}, app.Wrap(app.KindInternal, op, err)
	}
	rows, err := q.Query(ctx, `
		WITH draft_lines AS (SELECT s.id sale_id,s.customer_name,COUNT(si.id) OVER(PARTITION BY s.id)::int line_count,si.item_id,si.inventory_lot_id,SUM(si.quantity) OVER(PARTITION BY s.id,si.item_id,si.inventory_lot_id)::int wanted,COALESCE(js.label,p.name,i.name,'item') label,COALESCE(mapped.id,home.id) location_id FROM sales s JOIN sale_items si ON si.sale_id=s.id LEFT JOIN jar_sizes js ON js.id=si.jar_size_id LEFT JOIN product_catalog p ON p.id=si.product_id LEFT JOIN inventory_items i ON i.id=si.item_id CROSS JOIN (SELECT id FROM inventory_locations WHERE is_home LIMIT 1) home LEFT JOIN inventory_locations mapped ON mapped.id=s.stock_location_id OR (mapped.source_type='stock_location' AND mapped.source_id=s.stock_location_id) WHERE s.order_status IN ('draft','pending') AND EXTRACT(YEAR FROM s.date)=$1), needs AS (SELECT DISTINCT sale_id,customer_name,line_count,item_id,inventory_lot_id,wanted,label,location_id FROM draft_lines WHERE item_id IS NOT NULL), avail AS (SELECT n.*,COALESCE(SUM(a.available),0)::int available FROM needs n LEFT JOIN inventory_available a ON a.item_id=n.item_id AND a.location_id=n.location_id AND (n.inventory_lot_id IS NULL OR a.lot_id=n.inventory_lot_id) GROUP BY n.sale_id,n.customer_name,n.line_count,n.item_id,n.inventory_lot_id,n.wanted,n.label,n.location_id) SELECT sale_id,customer_name,line_count,label,wanted,available FROM avail ORDER BY sale_id,label`, year)
	if err != nil {
		return WorkbenchView{}, app.Wrap(app.KindInternal, op, err)
	}
	byID := map[uuid.UUID]int{}
	for rows.Next() {
		var id uuid.UUID
		var name *string
		var count int
		var label string
		var wanted, available int
		if err := rows.Scan(&id, &name, &count, &label, &wanted, &available); err != nil {
			rows.Close()
			return WorkbenchView{}, app.Wrap(app.KindInternal, op, err)
		}
		idx, ok := byID[id]
		if !ok {
			idx = len(v.Drafts)
			byID[id] = idx
			v.Drafts = append(v.Drafts, Draft{SaleID: id, CustomerName: name, LineCount: count, Shortfalls: []DraftShortfall{}})
		}
		if wanted > available {
			v.Drafts[idx].Shortfalls = append(v.Drafts[idx].Shortfalls, DraftShortfall{ItemLabel: label, Wanted: wanted, Available: available, Explanation: "Not enough " + label + " to fulfill this draft"})
		}
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return WorkbenchView{}, app.Wrap(app.KindInternal, op, err)
	}
	rows.Close()
	rows, err = q.Query(ctx, `SELECT il.id,il.name,COALESCE(SUM(b.on_hand),0)::int,CASE il.settlement_cadence WHEN 'weekly' THEN COALESCE(MAX(cs.period_end),CURRENT_DATE)+7 WHEN 'biweekly' THEN COALESCE(MAX(cs.period_end),CURRENT_DATE)+14 WHEN 'monthly' THEN (COALESCE(MAX(cs.period_end),CURRENT_DATE)+INTERVAL '1 month')::date WHEN 'quarterly' THEN (COALESCE(MAX(cs.period_end),CURRENT_DATE)+INTERVAL '3 months')::date ELSE NULL END,MAX(cs.period_end) FROM inventory_locations il LEFT JOIN inventory_balances b ON b.location_id=il.id LEFT JOIN consignment_settlements cs ON (cs.location_id=il.id OR (il.source_type='stock_location' AND cs.location_id=il.source_id)) AND cs.voided_at IS NULL WHERE il.kind='consignee' AND il.is_consignment AND il.deleted_at IS NULL GROUP BY il.id ORDER BY il.name`)
	if err != nil {
		return WorkbenchView{}, app.Wrap(app.KindInternal, op, err)
	}
	consignmentIndex := map[uuid.UUID]int{}
	for rows.Next() {
		x := ConsignmentLocation{ByVarietal: []ConsignmentVarietal{}}
		if err := rows.Scan(&x.LocationID, &x.Name, &x.UnitsOut, &x.SettlementDueAt, &x.LastSettledAt); err != nil {
			rows.Close()
			return WorkbenchView{}, app.Wrap(app.KindInternal, op, err)
		}
		consignmentIndex[x.LocationID] = len(v.Consignment)
		v.Consignment = append(v.Consignment, x)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return WorkbenchView{}, app.Wrap(app.KindInternal, op, err)
	}
	rows.Close()
	// The same shelves split by varietal (lot -> harvest lot -> varietal), so
	// the workbench can say "12 Sourwood · 5 Wildflower out". Named varietals
	// first, then the unnamed remainder.
	rows, err = q.Query(ctx, `SELECT b.location_id,hv.name,SUM(b.on_hand)::int FROM inventory_balances b JOIN inventory_locations il ON il.id=b.location_id AND il.kind='consignee' AND il.is_consignment AND il.deleted_at IS NULL LEFT JOIN inventory_lots lot ON lot.id=b.lot_id LEFT JOIN harvest_lots hl ON hl.id=lot.source_id AND lot.source_type='harvest_lot' LEFT JOIN honey_varietals hv ON hv.id=hl.varietal_id GROUP BY b.location_id,hv.name HAVING SUM(b.on_hand)<>0 ORDER BY b.location_id,hv.name NULLS LAST`)
	if err != nil {
		return WorkbenchView{}, app.Wrap(app.KindInternal, op, err)
	}
	for rows.Next() {
		var locationID uuid.UUID
		var x ConsignmentVarietal
		if err := rows.Scan(&locationID, &x.VarietalName, &x.Units); err != nil {
			rows.Close()
			return WorkbenchView{}, app.Wrap(app.KindInternal, op, err)
		}
		if idx, ok := consignmentIndex[locationID]; ok {
			v.Consignment[idx].ByVarietal = append(v.Consignment[idx].ByVarietal, x)
		}
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return WorkbenchView{}, app.Wrap(app.KindInternal, op, err)
	}
	rows.Close()
	rows, err = q.Query(ctx, `SELECT a.item_id,COALESCE(js.label,p.name,i.name),hl.lot_code,SUM(a.available)::int FROM inventory_available a JOIN inventory_locations l ON l.id=a.location_id AND l.is_home JOIN inventory_items i ON i.id=a.item_id LEFT JOIN jar_sizes js ON js.item_id=a.item_id LEFT JOIN product_catalog p ON p.item_id=a.item_id LEFT JOIN harvest_lots hl ON hl.inventory_lot_id=a.lot_id WHERE i.kind IN ('jar','catalog_product') GROUP BY a.item_id,js.label,p.name,i.name,hl.lot_code HAVING SUM(a.available)>0 ORDER BY 2,3`)
	if err != nil {
		return WorkbenchView{}, app.Wrap(app.KindInternal, op, err)
	}
	for rows.Next() {
		var x SellableItem
		if err := rows.Scan(&x.ItemID, &x.Label, &x.LotCode, &x.AvailableAtHome); err != nil {
			rows.Close()
			return WorkbenchView{}, app.Wrap(app.KindInternal, op, err)
		}
		v.Sellable = append(v.Sellable, x)
	}
	if err := rows.Err(); err != nil {
		return WorkbenchView{}, app.Wrap(app.KindInternal, op, err)
	}
	return v, nil
}

func salesWorkbenchCommand(id, label, method, path, keyboard string, permitted bool, offline work.OfflinePredicate) WorkbenchCommand {
	var denied *string
	if !permitted {
		text := "administrator access is required"
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
	return WorkbenchCommand{ID: id, Label: label, Method: method, Path: path, BodyTemplate: map[string]any{}, Permitted: permitted, DeniedReason: denied, Offline: disposition, OfflineReason: offlineReason, IdempotencyKeyTemplate: "sales:" + id + ":{clientMutationId}", Keyboard: keyboard}
}
