package httpapi

import (
	"context"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// External accounting sync entity types. Values must match
// external_sync.entity_type (migration 00041). Mutation paths do not call
// ensureSyncRow yet; the sync-engine wave wires that.

const (
	SyncSystemGnuCashWeb = "gnucash_web"

	SyncEntitySale                     = "sale"
	SyncEntitySaleItem                 = "sale_item"
	SyncEntityExpense                  = "expense"
	SyncEntityCustomer                 = "customer"
	SyncEntityHarvestLot               = "harvest_lot"
	SyncEntityJarSize                  = "jar_size"
	SyncEntityHoneyMovement            = "honey_movement"
	SyncEntityBottlingRun              = "bottling_run"
	SyncEntityStockLocation            = "stock_location"
	SyncEntityStockMovement            = "stock_movement"
	SyncEntityConsignmentSettlement    = "consignment_settlement"
	SyncEntityHive                     = "hive"
	SyncEntityEquipmentStock           = "equipment_stock"
	SyncEntityEquipmentStockAdjustment = "equipment_stock_adjustment"
	SyncEntityProductCatalog           = "product_catalog"
	SyncEntityProductBatch             = "product_batch"
	SyncEntityProductAdjustment        = "product_adjustment"
)

// syncEntityTypes is the allowlist that must equal the DB CHECK.
var syncEntityTypes = []string{
	SyncEntitySale,
	SyncEntitySaleItem,
	SyncEntityExpense,
	SyncEntityCustomer,
	SyncEntityHarvestLot,
	SyncEntityJarSize,
	SyncEntityHoneyMovement,
	SyncEntityBottlingRun,
	SyncEntityStockLocation,
	SyncEntityStockMovement,
	SyncEntityConsignmentSettlement,
	SyncEntityHive,
	SyncEntityEquipmentStock,
	SyncEntityEquipmentStockAdjustment,
	SyncEntityProductCatalog,
	SyncEntityProductBatch,
	SyncEntityProductAdjustment,
}

// ensureSyncRow inserts a pending mapping for (system, entityType, entityID)
// if one is not already present. An existing row — including one already
// synced or failed — is left untouched. location_id stays NULL; the 00024
// unique key treats that as the all-zero uuid.
func ensureSyncRow(
	ctx context.Context,
	tx pgx.Tx,
	system, entityType string,
	entityID uuid.UUID,
) error {
	_, err := tx.Exec(ctx, `
		INSERT INTO external_sync (system, entity_type, entity_id, sync_state)
		VALUES ($1, $2, $3, 'pending')
		ON CONFLICT DO NOTHING`,
		system, entityType, entityID)
	return err
}
