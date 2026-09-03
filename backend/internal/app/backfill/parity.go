package backfill

import (
	"context"

	"github.com/biker2000on/beez-trackz/backend/internal/app"
	"github.com/biker2000on/beez-trackz/backend/internal/snapshot"
)

// verifyParity evaluates the canonical legacy aggregate family first, then
// compares every stock-bearing member named by design section 7.2 to its
// ledger projection. The focused SQL comparisons retain source identities in
// their errors, which makes a failed rehearsal actionable instead of merely
// reporting that two aggregate JSON documents differ.
func verifyParity(ctx context.Context, uow *app.UnitOfWork, currency string) error {
	if currency == "" {
		currency = "USD"
	}
	if _, err := snapshot.ComputeLegacyAggregates(ctx, uow, currency); err != nil {
		return app.Internal("compute legacy parity oracle", err)
	}
	checks := []struct {
		name  string
		query string
	}{
		{"global_bulk_honey", `
			WITH legacy AS (
			 SELECT (SELECT COALESCE(SUM(COALESCE(NULLIF(hs.total_extracted_weight,0),
			   (SELECT COALESCE(SUM(h.calculated_honey_weight),0) FROM honey_harvests h WHERE h.session_id=hs.id AND h.deleted_at IS NULL))),0) FROM harvest_sessions hs)
			 + (SELECT COALESCE(SUM(calculated_honey_weight),0) FROM honey_harvests WHERE session_id IS NULL AND deleted_at IS NULL)
			 - COALESCE((SELECT SUM(amount_lbs) FROM honey_movements WHERE kind IN('jarring','bulk_use','loss')),0) value),
			 ledger AS (SELECT COALESCE(SUM(b.on_hand),0)::float8 value FROM inventory_balances b WHERE b.item_id='00000000-0000-0000-0000-000000000101')
			SELECT COUNT(*) FROM legacy,ledger WHERE abs(legacy.value-ledger.value)>0.0001`},
		{"lot_bulk_honey", `
			WITH legacy AS (SELECT l.id,l.honey_weight_lbs-COALESCE(SUM(m.amount_lbs) FILTER(WHERE m.kind IN('jarring','bulk_use','loss')),0) value FROM harvest_lots l LEFT JOIN honey_movements m ON m.lot_id=l.id GROUP BY l.id),
			ledger AS (SELECT l.source_id id,COALESCE(SUM(b.on_hand),0)::float8 value FROM inventory_lots l LEFT JOIN inventory_balances b ON b.lot_id=l.id WHERE l.item_id='00000000-0000-0000-0000-000000000101' AND l.source_type='harvest_lot' GROUP BY l.source_id)
			SELECT COUNT(*) FROM legacy FULL JOIN ledger USING(id) WHERE legacy.id IS NULL OR ledger.id IS NULL OR abs(legacy.value-ledger.value)>0.0001`},
		{"finished_jar_inventory", `
			WITH legacy AS (SELECT js.id,COALESCE(SUM(m.quantity) FILTER(WHERE m.kind IN('jarring','jar_adjustment')),0)-COALESCE(SUM(m.quantity) FILTER(WHERE m.kind='give_away'),0)-(SELECT COALESCE(SUM(si.quantity),0) FROM sale_items si JOIN sales s ON s.id=si.sale_id WHERE si.jar_size_id=js.id AND s.order_status<>'cancelled') value FROM jar_sizes js LEFT JOIN honey_movements m ON m.jar_size_id=js.id GROUP BY js.id),
			ledger AS (SELECT i.source_id id,COALESCE(SUM(a.available),0)::int value FROM inventory_items i LEFT JOIN inventory_available a ON a.item_id=i.id WHERE i.source_type='jar_size' GROUP BY i.source_id)
			SELECT COUNT(*) FROM legacy FULL JOIN ledger USING(id) WHERE legacy.id IS NULL OR ledger.id IS NULL OR legacy.value<>ledger.value`},
		{"catalog_product_inventory", `
			WITH legacy AS (SELECT p.id,COALESCE((SELECT SUM(quantity_out) FROM product_batches WHERE product_id=p.id AND voided_at IS NULL),0)+COALESCE((SELECT SUM(delta) FROM product_adjustments WHERE product_id=p.id AND deleted_at IS NULL),0)-COALESCE((SELECT SUM(si.quantity) FROM sale_items si JOIN sales s ON s.id=si.sale_id WHERE si.product_id=p.id AND s.order_status<>'cancelled'),0) value FROM product_catalog p),
			ledger AS (SELECT i.source_id id,COALESCE(SUM(a.available),0)::int value FROM inventory_items i LEFT JOIN inventory_available a ON a.item_id=i.id WHERE i.source_type='product_catalog' GROUP BY i.source_id)
			SELECT COUNT(*) FROM legacy FULL JOIN ledger USING(id) WHERE legacy.id IS NULL OR ledger.id IS NULL OR legacy.value<>ledger.value`},
		{"raw_propolis_inventory", `
			WITH legacy AS (SELECT COALESCE((SELECT SUM(amount_grams) FROM propolis_harvests WHERE deleted_at IS NULL),0)-COALESCE((SELECT SUM(propolis_amount_grams) FROM product_batches WHERE kind='tincture' AND voided_at IS NULL),0)-COALESCE((SELECT SUM(si.quantity*p.net_grams) FROM sale_items si JOIN sales s ON s.id=si.sale_id JOIN product_catalog p ON p.id=si.product_id WHERE si.kind='propolis' AND s.order_status<>'cancelled'),0) value),
			ledger AS (SELECT COALESCE(SUM(a.available),0)::float8-(SELECT COALESCE(SUM(si.quantity*p.net_grams),0) FROM sale_items si JOIN sales s ON s.id=si.sale_id JOIN product_catalog p ON p.id=si.product_id WHERE si.kind='propolis' AND s.order_status<>'cancelled' AND s.physical_applied_at IS NULL) value FROM inventory_available a WHERE a.item_id='00000000-0000-0000-0000-000000000102')
			SELECT COUNT(*) FROM legacy,ledger WHERE abs(legacy.value-ledger.value)>0.0001`},
		{"away_finished_goods", `
			WITH legacy AS (SELECT location_id,jar_size_id,product_id,SUM(qty)::int value FROM (SELECT location_id,jar_size_id,product_id,quantity qty FROM stock_movements UNION ALL SELECT s.stock_location_id,si.jar_size_id,si.product_id,-si.quantity FROM sale_items si JOIN sales s ON s.id=si.sale_id WHERE s.order_status<>'cancelled' AND s.stock_location_id IS NOT NULL AND (si.jar_size_id IS NOT NULL OR si.product_id IS NOT NULL)) x WHERE location_id NOT IN(SELECT id FROM stock_locations WHERE is_home) GROUP BY 1,2,3),
			ledger AS (SELECT loc.source_id location_id,CASE WHEN i.source_type='jar_size' THEN i.source_id END jar_size_id,CASE WHEN i.source_type='product_catalog' THEN i.source_id END product_id,SUM(b.on_hand)::int value FROM inventory_balances b JOIN inventory_locations loc ON loc.id=b.location_id JOIN inventory_items i ON i.id=b.item_id WHERE loc.source_type='stock_location' AND i.source_type IN('jar_size','product_catalog') GROUP BY 1,2,3)
			SELECT COUNT(*) FROM legacy FULL JOIN ledger ON ledger.location_id=legacy.location_id AND ledger.jar_size_id IS NOT DISTINCT FROM legacy.jar_size_id AND ledger.product_id IS NOT DISTINCT FROM legacy.product_id WHERE COALESCE(legacy.value,0)<>COALESCE(ledger.value,0)`},
	}
	for _, check := range checks {
		var differences int
		if err := uow.QueryRow(ctx, check.query).Scan(&differences); err != nil {
			return app.Internal("verify "+check.name+" parity", err)
		}
		if differences != 0 {
			return app.Precondition("verify inventory ledger parity", "%s has %d differing value(s)", check.name, differences)
		}
	}
	if err := verifyEquipmentParity(ctx, uow); err != nil {
		return err
	}
	return nil
}
