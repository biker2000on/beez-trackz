package httpapi

import (
	"regexp"
	"testing"

	"github.com/google/uuid"
)

func TestSyncEntityTypesMatchCheckConstraint(t *testing.T) {
	ctx, tx := equipTx(t)

	var clause string
	if err := tx.QueryRow(ctx, `
		SELECT pg_get_constraintdef(oid)
		FROM pg_constraint
		WHERE conname = 'external_sync_entity_type_check'`).Scan(&clause); err != nil {
		t.Fatalf("read entity_type check: %v", err)
	}

	quoted := regexp.MustCompile(`'([^']+)'`)
	dbTypes := map[string]bool{}
	for _, match := range quoted.FindAllStringSubmatch(clause, -1) {
		dbTypes[match[1]] = true
	}

	codeTypes := map[string]bool{}
	for _, name := range syncEntityTypes {
		codeTypes[name] = true
	}

	for name := range dbTypes {
		if !codeTypes[name] {
			t.Errorf("DB CHECK allows %q but Go constants do not", name)
		}
	}
	for name := range codeTypes {
		if !dbTypes[name] {
			t.Errorf("Go constant %q is not in the DB CHECK", name)
		}
	}

	if dbTypes["honey_sale"] || dbTypes["honey_sale_item"] {
		t.Errorf("pre-rename spellings still on CHECK: %s", clause)
	}
	for _, required := range []string{
		SyncEntitySale, SyncEntitySaleItem, SyncEntityHive,
		SyncEntityEquipmentStock, SyncEntityEquipmentStockAdjustment,
		SyncEntityProductCatalog, SyncEntityProductBatch, SyncEntityProductAdjustment,
	} {
		if !dbTypes[required] {
			t.Errorf("CHECK is missing %q: %s", required, clause)
		}
	}
}

func TestExternalSyncUniqueIndexKeepsLocationCoalesce(t *testing.T) {
	ctx, tx := equipTx(t)

	var def string
	if err := tx.QueryRow(ctx, `
		SELECT indexdef FROM pg_indexes
		WHERE indexname = 'external_sync_entity_idx'`).Scan(&def); err != nil {
		t.Fatalf("read entity unique index: %v", err)
	}
	want := "COALESCE(location_id, '00000000-0000-0000-0000-000000000000'::uuid)"
	if !regexp.MustCompile(`(?i)COALESCE\(\s*location_id\s*,\s*'00000000-0000-0000-0000-000000000000'::uuid\s*\)`).
		MatchString(def) {
		t.Fatalf("external_sync_entity_idx lost the 00024 COALESCE key:\n%s\nwant substring %s", def, want)
	}

	var externalIdx int
	if err := tx.QueryRow(ctx, `
		SELECT COUNT(*) FROM pg_indexes WHERE indexname = 'external_sync_external_idx'`).
		Scan(&externalIdx); err != nil {
		t.Fatalf("count external unique index: %v", err)
	}
	if externalIdx != 1 {
		t.Fatalf("external_sync_external_idx count = %d, want 1", externalIdx)
	}
}

func TestEnsureSyncRowInsertsPendingOnce(t *testing.T) {
	ctx, tx := equipTx(t)
	entityID := uuid.New()

	if err := ensureSyncRow(ctx, tx, SyncSystemGnuCashWeb, SyncEntitySale, entityID); err != nil {
		t.Fatalf("first ensureSyncRow: %v", err)
	}
	if err := ensureSyncRow(ctx, tx, SyncSystemGnuCashWeb, SyncEntitySale, entityID); err != nil {
		t.Fatalf("second ensureSyncRow: %v", err)
	}

	var count int
	var state string
	if err := tx.QueryRow(ctx, `
		SELECT COUNT(*), MIN(sync_state)
		FROM external_sync
		WHERE system = $1 AND entity_type = $2 AND entity_id = $3`,
		SyncSystemGnuCashWeb, SyncEntitySale, entityID).Scan(&count, &state); err != nil {
		t.Fatalf("read sync rows: %v", err)
	}
	if count != 1 {
		t.Fatalf("sync rows = %d, want 1", count)
	}
	if state != "pending" {
		t.Fatalf("sync_state = %q, want pending", state)
	}
}

func TestEnsureSyncRowLeavesExistingState(t *testing.T) {
	ctx, tx := equipTx(t)
	entityID := uuid.New()

	if _, err := tx.Exec(ctx, `
		INSERT INTO external_sync (system, entity_type, entity_id, sync_state, external_id)
		VALUES ($1, $2, $3, 'synced', 'gnucash-1')`,
		SyncSystemGnuCashWeb, SyncEntityHive, entityID); err != nil {
		t.Fatalf("seed synced row: %v", err)
	}
	if err := ensureSyncRow(ctx, tx, SyncSystemGnuCashWeb, SyncEntityHive, entityID); err != nil {
		t.Fatalf("ensureSyncRow on existing: %v", err)
	}

	var state string
	var externalID *string
	var count int
	if err := tx.QueryRow(ctx, `
		SELECT COUNT(*), MIN(sync_state), MIN(external_id)
		FROM external_sync
		WHERE entity_type = $1 AND entity_id = $2`,
		SyncEntityHive, entityID).Scan(&count, &state, &externalID); err != nil {
		t.Fatalf("read existing row: %v", err)
	}
	if count != 1 || state != "synced" || externalID == nil || *externalID != "gnucash-1" {
		t.Fatalf("row was rewritten: count=%d state=%s external=%v", count, state, externalID)
	}
}

func TestExternalSyncRejectsPreRenameEntityTypes(t *testing.T) {
	ctx, tx := equipTx(t)
	_, err := tx.Exec(ctx, `
		INSERT INTO external_sync (entity_type, entity_id)
		VALUES ('honey_sale', $1)`, uuid.New())
	if err == nil {
		t.Fatal("honey_sale was accepted after 00041")
	}
	if !equipPgErrCode(err, "23514") {
		t.Fatalf("honey_sale insert error = %v, want check violation", err)
	}
}
