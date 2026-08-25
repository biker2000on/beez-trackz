package httpapi

import (
	"context"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

func saleFixture(t *testing.T, ctx context.Context, tx pgx.Tx) uuid.UUID {
	t.Helper()
	var id uuid.UUID
	if err := tx.QueryRow(ctx, `
		INSERT INTO sales (date, total_amount_cents, order_status)
		VALUES (now(), 0, 'paid') RETURNING id`).Scan(&id); err != nil {
		t.Fatalf("insert sale: %v", err)
	}
	return id
}

func TestSaleEquipmentCOGSSnapshot(t *testing.T) {
	ctx, tx := equipTx(t)
	typeID := equipFixtureType(t, ctx, tx, "box")
	stockID := equipFixtureStock(t, ctx, tx, typeID, 10)
	if _, err := tx.Exec(ctx,
		`UPDATE equipment_stock SET unit_cost_cents = 1500 WHERE id = $1`, stockID); err != nil {
		t.Fatalf("set unit cost: %v", err)
	}

	saleID := saleFixture(t, ctx, tx)
	if _, err := tx.Exec(ctx, `
		INSERT INTO sale_items
			(sale_id, kind, equipment_stock_id, quantity, unit_price_cents)
		VALUES ($1, 'equipment', $2, 3, 4000)`, saleID, stockID); err != nil {
		t.Fatalf("insert equipment line: %v", err)
	}

	if err := saleApplyPhysical(ctx, tx, saleID, time.Now(), nil, []honeySaleLine{{
		Kind: saleKindEquipment, EquipmentStockID: stockID, Quantity: 3, UnitPrice: 4000,
	}}); err != nil {
		t.Fatalf("apply physical: %v", err)
	}

	var snapshot *int
	var reason string
	if err := tx.QueryRow(ctx, `
		SELECT unit_cost_cents_snapshot, reason::text
		FROM equipment_stock_adjustments
		WHERE sale_id = $1 AND reason = 'sold'`, saleID).Scan(&snapshot, &reason); err != nil {
		t.Fatalf("read sold adjustment: %v", err)
	}
	if snapshot == nil || *snapshot != 1500 {
		t.Fatalf("unit_cost_cents_snapshot = %v, want 1500", snapshot)
	}

	var basis *int64
	if err := tx.QueryRow(ctx, `
		SELECT cost_basis_cents FROM sale_items WHERE sale_id = $1`, saleID).
		Scan(&basis); err != nil {
		t.Fatalf("read cost basis: %v", err)
	}
	if basis == nil || *basis != 4500 {
		t.Fatalf("cost_basis_cents = %v, want 4500 (3 * 1500)", basis)
	}

	if _, err := tx.Exec(ctx,
		`UPDATE equipment_stock SET unit_cost_cents = 9999 WHERE id = $1`, stockID); err != nil {
		t.Fatalf("edit live unit cost: %v", err)
	}
	if err := tx.QueryRow(ctx, `
		SELECT unit_cost_cents_snapshot FROM equipment_stock_adjustments
		WHERE sale_id = $1 AND reason = 'sold'`, saleID).Scan(&snapshot); err != nil {
		t.Fatalf("re-read snapshot: %v", err)
	}
	if snapshot == nil || *snapshot != 1500 {
		t.Fatalf("snapshot after price edit = %v, want 1500", snapshot)
	}
	if err := tx.QueryRow(ctx, `
		SELECT cost_basis_cents FROM sale_items WHERE sale_id = $1`, saleID).
		Scan(&basis); err != nil {
		t.Fatalf("re-read cost basis: %v", err)
	}
	if basis == nil || *basis != 4500 {
		t.Fatalf("cost_basis_cents after price edit = %v, want 4500", basis)
	}
}

func TestSaleEquipmentCOGSSnapshotNilWhenNoUnitCost(t *testing.T) {
	ctx, tx := equipTx(t)
	typeID := equipFixtureType(t, ctx, tx, "box")
	stockID := equipFixtureStock(t, ctx, tx, typeID, 4)
	saleID := saleFixture(t, ctx, tx)
	if _, err := tx.Exec(ctx, `
		INSERT INTO sale_items
			(sale_id, kind, equipment_stock_id, quantity, unit_price_cents)
		VALUES ($1, 'equipment', $2, 2, 1000)`, saleID, stockID); err != nil {
		t.Fatalf("insert equipment line: %v", err)
	}

	if err := saleApplyPhysical(ctx, tx, saleID, time.Now(), nil, []honeySaleLine{{
		Kind: saleKindEquipment, EquipmentStockID: stockID, Quantity: 2, UnitPrice: 1000,
	}}); err != nil {
		t.Fatalf("apply physical: %v", err)
	}

	var snapshot *int
	var basis *int64
	if err := tx.QueryRow(ctx, `
		SELECT a.unit_cost_cents_snapshot, i.cost_basis_cents
		FROM equipment_stock_adjustments a
		JOIN sale_items i ON i.sale_id = a.sale_id
		WHERE a.sale_id = $1 AND a.reason = 'sold'`, saleID).
		Scan(&snapshot, &basis); err != nil {
		t.Fatalf("read snapshot/basis: %v", err)
	}
	if snapshot != nil {
		t.Fatalf("snapshot = %v, want NULL when stock has no unit cost", snapshot)
	}
	if basis != nil {
		t.Fatalf("cost_basis_cents = %v, want NULL", basis)
	}
}

func TestSaleColonyCostBasisFromBeesQueens(t *testing.T) {
	ctx, tx := equipTx(t)
	hiveID := equipFixtureHive(t, ctx, tx)
	saleID := saleFixture(t, ctx, tx)
	if _, err := tx.Exec(ctx, `
		INSERT INTO sale_items (sale_id, kind, hive_id, quantity, unit_price_cents)
		VALUES ($1, 'colony', $2, 1, 25000)`, saleID, hiveID); err != nil {
		t.Fatalf("insert colony line: %v", err)
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO expenses (expense_date, category, description, amount_cents, hive_id)
		VALUES
			(CURRENT_DATE, 'bees_queens', 'Nuc', 12500, $1),
			(CURRENT_DATE, 'bees_queens', 'Queen', 3500, $1),
			(CURRENT_DATE, 'feed', 'Syrup', 800, $1)`, hiveID); err != nil {
		t.Fatalf("insert expenses: %v", err)
	}
	var deletedID uuid.UUID
	if err := tx.QueryRow(ctx, `
		INSERT INTO expenses (expense_date, category, description, amount_cents, hive_id, deleted_at)
		VALUES (CURRENT_DATE, 'bees_queens', 'voided nuc', 99999, $1, now())
		RETURNING id`, hiveID).Scan(&deletedID); err != nil {
		t.Fatalf("insert deleted expense: %v", err)
	}

	if err := saleApplyPhysical(ctx, tx, saleID, time.Now(), nil, []honeySaleLine{{
		Kind: saleKindColony, HiveID: hiveID, Quantity: 1, UnitPrice: 25000,
	}}); err != nil {
		t.Fatalf("apply physical: %v", err)
	}

	var basis *int64
	if err := tx.QueryRow(ctx, `
		SELECT cost_basis_cents FROM sale_items WHERE sale_id = $1`, saleID).
		Scan(&basis); err != nil {
		t.Fatalf("read cost basis: %v", err)
	}
	if basis == nil || *basis != 16000 {
		t.Fatalf("cost_basis_cents = %v, want 16000 (12500+3500, feed and deleted excluded)", basis)
	}
}

func TestSaleColonyCostBasisNilWhenNoBeesQueens(t *testing.T) {
	ctx, tx := equipTx(t)
	hiveID := equipFixtureHive(t, ctx, tx)
	saleID := saleFixture(t, ctx, tx)
	if _, err := tx.Exec(ctx, `
		INSERT INTO sale_items (sale_id, kind, hive_id, quantity, unit_price_cents)
		VALUES ($1, 'colony', $2, 1, 25000)`, saleID, hiveID); err != nil {
		t.Fatalf("insert colony line: %v", err)
	}

	if err := saleApplyPhysical(ctx, tx, saleID, time.Now(), nil, []honeySaleLine{{
		Kind: saleKindColony, HiveID: hiveID, Quantity: 1, UnitPrice: 25000,
	}}); err != nil {
		t.Fatalf("apply physical: %v", err)
	}

	var basis *int64
	if err := tx.QueryRow(ctx, `
		SELECT cost_basis_cents FROM sale_items WHERE sale_id = $1`, saleID).
		Scan(&basis); err != nil {
		t.Fatalf("read cost basis: %v", err)
	}
	if basis != nil {
		t.Fatalf("cost_basis_cents = %v, want NULL when no bees_queens expenses exist", basis)
	}
}

func TestSaleUnapplyClearsCostBasisAndReapplyResnapshots(t *testing.T) {
	ctx, tx := equipTx(t)
	hiveID := equipFixtureHive(t, ctx, tx)
	typeID := equipFixtureType(t, ctx, tx, "box")
	stockID := equipFixtureStock(t, ctx, tx, typeID, 6)
	if _, err := tx.Exec(ctx,
		`UPDATE equipment_stock SET unit_cost_cents = 2000 WHERE id = $1`, stockID); err != nil {
		t.Fatalf("set unit cost: %v", err)
	}

	saleID := saleFixture(t, ctx, tx)
	if _, err := tx.Exec(ctx, `
		INSERT INTO sale_items (sale_id, kind, hive_id, quantity, unit_price_cents)
		VALUES ($1, 'colony', $2, 1, 25000)`, saleID, hiveID); err != nil {
		t.Fatalf("insert colony line: %v", err)
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO sale_items
			(sale_id, kind, equipment_stock_id, quantity, unit_price_cents)
		VALUES ($1, 'equipment', $2, 2, 4000)`, saleID, stockID); err != nil {
		t.Fatalf("insert equipment line: %v", err)
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO expenses (expense_date, category, description, amount_cents, hive_id)
		VALUES (CURRENT_DATE, 'bees_queens', 'Nuc', 10000, $1)`, hiveID); err != nil {
		t.Fatalf("insert expense: %v", err)
	}

	lines := []honeySaleLine{
		{Kind: saleKindColony, HiveID: hiveID, Quantity: 1, UnitPrice: 25000},
		{Kind: saleKindEquipment, EquipmentStockID: stockID, Quantity: 2, UnitPrice: 4000},
	}
	if err := saleApplyPhysical(ctx, tx, saleID, time.Now(), nil, lines); err != nil {
		t.Fatalf("apply physical: %v", err)
	}

	if err := saleUnapplyPhysical(ctx, tx, saleID, nil); err != nil {
		t.Fatalf("unapply: %v", err)
	}

	var colonyBasis, equipBasis *int64
	if err := tx.QueryRow(ctx, `
		SELECT cost_basis_cents FROM sale_items
		WHERE sale_id = $1 AND kind = 'colony'`, saleID).Scan(&colonyBasis); err != nil {
		t.Fatalf("read colony basis after unapply: %v", err)
	}
	if err := tx.QueryRow(ctx, `
		SELECT cost_basis_cents FROM sale_items
		WHERE sale_id = $1 AND kind = 'equipment'`, saleID).Scan(&equipBasis); err != nil {
		t.Fatalf("read equipment basis after unapply: %v", err)
	}
	if colonyBasis != nil || equipBasis != nil {
		t.Fatalf("cost_basis after unapply = colony %v equipment %v, want both NULL",
			colonyBasis, equipBasis)
	}

	if _, err := tx.Exec(ctx, `
		INSERT INTO expenses (expense_date, category, description, amount_cents, hive_id)
		VALUES (CURRENT_DATE, 'bees_queens', 'extra queen', 2500, $1)`, hiveID); err != nil {
		t.Fatalf("insert extra expense: %v", err)
	}
	if _, err := tx.Exec(ctx,
		`UPDATE equipment_stock SET unit_cost_cents = 3000 WHERE id = $1`, stockID); err != nil {
		t.Fatalf("update unit cost: %v", err)
	}

	if err := saleApplyPhysical(ctx, tx, saleID, time.Now(), nil, lines); err != nil {
		t.Fatalf("re-apply physical: %v", err)
	}
	if err := tx.QueryRow(ctx, `
		SELECT cost_basis_cents FROM sale_items
		WHERE sale_id = $1 AND kind = 'colony'`, saleID).Scan(&colonyBasis); err != nil {
		t.Fatalf("read colony basis after re-apply: %v", err)
	}
	if err := tx.QueryRow(ctx, `
		SELECT cost_basis_cents FROM sale_items
		WHERE sale_id = $1 AND kind = 'equipment'`, saleID).Scan(&equipBasis); err != nil {
		t.Fatalf("read equipment basis after re-apply: %v", err)
	}
	if colonyBasis == nil || *colonyBasis != 12500 {
		t.Fatalf("colony cost_basis after re-apply = %v, want 12500", colonyBasis)
	}
	if equipBasis == nil || *equipBasis != 6000 {
		t.Fatalf("equipment cost_basis after re-apply = %v, want 6000 (2 * 3000)", equipBasis)
	}
}

func TestSaleRestoreClearsCostBasis(t *testing.T) {
	ctx, tx := equipTx(t)
	hiveID := equipFixtureHive(t, ctx, tx)
	saleID := saleFixture(t, ctx, tx)
	if _, err := tx.Exec(ctx, `
		INSERT INTO sale_items (sale_id, kind, hive_id, quantity, unit_price_cents)
		VALUES ($1, 'colony', $2, 1, 25000)`, saleID, hiveID); err != nil {
		t.Fatalf("insert colony line: %v", err)
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO expenses (expense_date, category, description, amount_cents, hive_id)
		VALUES (CURRENT_DATE, 'bees_queens', 'Nuc', 8000, $1)`, hiveID); err != nil {
		t.Fatalf("insert expense: %v", err)
	}
	if err := saleApplyPhysical(ctx, tx, saleID, time.Now(), nil, []honeySaleLine{{
		Kind: saleKindColony, HiveID: hiveID, Quantity: 1, UnitPrice: 25000,
	}}); err != nil {
		t.Fatalf("apply physical: %v", err)
	}

	if err := saleRestorePhysical(ctx, tx, saleID, nil); err != nil {
		t.Fatalf("restore: %v", err)
	}

	var basis *int64
	if err := tx.QueryRow(ctx, `
		SELECT cost_basis_cents FROM sale_items WHERE sale_id = $1`, saleID).
		Scan(&basis); err != nil {
		t.Fatalf("read cost basis: %v", err)
	}
	if basis != nil {
		t.Fatalf("cost_basis after restore = %v, want NULL", basis)
	}
}
