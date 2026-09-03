package httpapi

import (
	"context"
	"fmt"

	"github.com/biker2000on/beez-trackz/backend/internal/db"
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
	SyncEntityInventoryOperation       = "inventory_operation"
	SyncEntityInventoryLocation        = "inventory_location"
)

// legacySyncEntityTypes matches migration 00041 before the one-shot ledger
// backfill. ledgerSyncEntityTypes matches the constraint installed by that
// gate. Restore validation accepts both because this binary operates on
// either side of the transactional cutover.
var legacySyncEntityTypes = []string{
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

var ledgerSyncEntityTypes = []string{
	SyncEntitySale, SyncEntitySaleItem, SyncEntityExpense, SyncEntityCustomer,
	SyncEntityHarvestLot, SyncEntityJarSize, SyncEntityBottlingRun,
	SyncEntityConsignmentSettlement, SyncEntityHive, SyncEntityProductCatalog,
	SyncEntityProductBatch, SyncEntityInventoryOperation, SyncEntityInventoryLocation,
}

// preCutoverSyncEntityTypes is every value the CHECK accepts on a Phase A
// database: migration 00041's list plus the two ledger identities. It is what
// this binary accepts while the legacy quantity tables are still there, so a
// restore artifact captured before the cutover still validates.
var preCutoverSyncEntityTypes = append(append([]string(nil), legacySyncEntityTypes...),
	SyncEntityInventoryOperation, SyncEntityInventoryLocation)

// syncEntityTypes is the allowlist this process enforces, and it follows the
// schema profile. On the baseline (spec section 9, Phase B) the dissolved
// tables have no rows to name, so honey_movement, stock_movement,
// equipment_stock, equipment_stock_adjustment, product_adjustment and
// stock_location stop being addressable identities: accepting them would let a
// restore write a sync row that points at nothing.
//
// The CHECK itself still carries the wide 00041 list in 00001_baseline.sql —
// narrowing it is a later baseline migration (spec 12.1). Until that lands the
// narrowing lives here, which is the only side that can see the profile.
func syncEntityTypes() []string {
	if db.ActiveProfile() == db.ProfileBaseline {
		return ledgerSyncEntityTypes
	}
	return preCutoverSyncEntityTypes
}

// syncEntityTypeAllowed reports whether this process may write a sync row for
// entityType.
func syncEntityTypeAllowed(entityType string) bool {
	for _, allowed := range syncEntityTypes() {
		if allowed == entityType {
			return true
		}
	}
	return false
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
	if !syncEntityTypeAllowed(entityType) {
		return fmt.Errorf("external sync entity type %q is not addressable on the %s schema",
			entityType, db.ActiveProfile())
	}
	_, err := tx.Exec(ctx, `
		INSERT INTO external_sync (system, entity_type, entity_id, sync_state)
		VALUES ($1, $2, $3, 'pending')
		ON CONFLICT DO NOTHING`,
		system, entityType, entityID)
	return err
}
