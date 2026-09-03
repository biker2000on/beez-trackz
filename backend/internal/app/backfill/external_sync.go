package backfill

import (
	"context"
	"fmt"

	"github.com/biker2000on/beez-trackz/backend/internal/app"
)

// RekeyExternalSync converts all six dissolved allowlist values in place.
// Hashes and sync state are preserved; body rebaselining remains the HTTP
// GnuCash composer's responsibility because this package has no remote-body
// knowledge.
func RekeyExternalSync(ctx context.Context, uow *app.UnitOfWork) (int64, error) {
	if _, err := uow.Exec(ctx, `ALTER TABLE external_sync DROP CONSTRAINT IF EXISTS external_sync_entity_type_check`); err != nil {
		return 0, err
	}
	var changed int64
	tag, err := uow.Exec(ctx, `UPDATE external_sync e SET entity_type='inventory_location',entity_id=l.id FROM inventory_locations l WHERE e.entity_type='stock_location' AND l.source_type='stock_location' AND l.source_id=e.entity_id`)
	if err != nil {
		return 0, err
	}
	changed += tag.RowsAffected()
	for _, legacy := range []string{"honey_movement", "equipment_stock_adjustment", "product_adjustment"} {
		tag, err = uow.Exec(ctx, `UPDATE external_sync e SET entity_type='inventory_operation',entity_id=o.id FROM inventory_operations o WHERE e.entity_type=$1 AND o.legacy_ref_type=$1 AND o.legacy_ref_id=e.entity_id`, legacy)
		if err != nil {
			return 0, err
		}
		changed += tag.RowsAffected()
	}
	// A legacy transfer/return is two stock_movement rows but one paired
	// operation. The translator stores both row ids on that operation so an
	// accounting key attached to either half converges on the same target.
	tag, err = uow.Exec(ctx, `UPDATE external_sync e SET entity_type='inventory_operation',entity_id=o.id FROM inventory_operations o WHERE e.entity_type='stock_movement' AND ((o.legacy_ref_type='stock_movement' AND o.legacy_ref_id=e.entity_id) OR o.details->'legacy_movement_ids' ? e.entity_id::text)`)
	if err != nil {
		return 0, err
	}
	changed += tag.RowsAffected()
	// equipment_stock is catalog-plus-history rather than a one-to-one legacy
	// operation. Bind it to the earliest operation affecting the split item.
	tag, err = uow.Exec(ctx, `UPDATE external_sync e SET entity_type='inventory_operation',entity_id=(
		SELECT m.operation_id FROM equipment_stock es JOIN inventory_items i ON i.source_id=es.type_id
		JOIN inventory_movements m ON m.item_id=i.id JOIN inventory_operations o ON o.id=m.operation_id
		WHERE es.id=e.entity_id ORDER BY o.occurred_at,o.id LIMIT 1)
		WHERE e.entity_type='equipment_stock' AND EXISTS(
		 SELECT 1 FROM equipment_stock es JOIN inventory_items i ON i.source_id=es.type_id
		 JOIN inventory_movements m ON m.item_id=i.id WHERE es.id=e.entity_id)`)
	if err != nil {
		return 0, err
	}
	changed += tag.RowsAffected()
	var unresolved int64
	if err := uow.QueryRow(ctx, `SELECT COUNT(*) FROM external_sync WHERE entity_type=ANY($1)`, []string{"honey_movement", "stock_movement", "equipment_stock", "equipment_stock_adjustment", "product_adjustment", "stock_location"}).Scan(&unresolved); err != nil {
		return 0, err
	}
	if unresolved != 0 {
		return 0, app.Precondition("re-key external sync", "%d dissolved rows have no translated target", unresolved)
	}
	_, err = uow.Exec(ctx, `ALTER TABLE external_sync ADD CONSTRAINT external_sync_entity_type_check CHECK(entity_type IN('sale','sale_item','expense','customer','harvest_lot','jar_size','bottling_run','consignment_settlement','hive','product_catalog','product_batch','inventory_operation','inventory_location'))`)
	if err != nil {
		return 0, fmt.Errorf("install external sync ledger allowlist: %w", err)
	}
	return changed, nil
}
