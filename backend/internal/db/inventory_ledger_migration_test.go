package db

import (
	"context"
	"errors"
	"os"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgconn"
)

func TestInventoryLedgerMigrationAppliesAndSeedsLocations(t *testing.T) {
	if os.Getenv("TEST_DATABASE_URL") == "" {
		t.Skip("TEST_DATABASE_URL is not configured")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
	defer cancel()
	pool, cleanup := freshDatabase(ctx, t, "beez_inventory_ledger_migration")
	defer cleanup()

	if err := migrateTo(pool, 49); err != nil {
		t.Fatalf("migrate through 00049: %v", err)
	}
	apiaryID, customerID := uuid.New(), uuid.New()
	mustExec(ctx, t, pool, `INSERT INTO apiaries(id,name) VALUES($1,'Ledger Apiary')`, apiaryID)
	mustExec(ctx, t, pool, `INSERT INTO customers(id,name) VALUES($1,'Ledger Shop')`, customerID)
	mustExec(ctx, t, pool, `INSERT INTO stock_locations
		(name,slug,is_consignment,customer_id,price_basis,commission_bps,settlement_cadence)
		VALUES('Ledger Shop','ledger-shop',true,$1,'commission',2500,'biweekly')`, customerID)

	if err := migrate(ctx, pool); err != nil {
		t.Fatalf("apply 00050: %v", err)
	}

	checks := []struct {
		name  string
		query string
		want  int
	}{
		{"one home", `SELECT count(*) FROM inventory_locations WHERE is_home`, 1},
		{"one deployed", `SELECT count(*) FROM inventory_locations WHERE kind='deployed'`, 1},
		{"apiary seed", `SELECT count(*) FROM inventory_locations WHERE source_type='apiary' AND source_id='` + apiaryID.String() + `'`, 1},
		{"consignee seed", `SELECT count(*) FROM inventory_locations WHERE source_type='stock_location' AND name='Ledger Shop' AND settlement_cadence='biweekly'`, 1},
		{"singleton items", `SELECT count(*) FROM inventory_items WHERE kind IN ('honey_bulk','propolis_raw')`, 2},
		{"three conditions", `SELECT count(*) FROM inventory_conditions`, 3},
	}
	for _, check := range checks {
		var got int
		if err := pool.QueryRow(ctx, check.query).Scan(&got); err != nil {
			t.Fatalf("%s: %v", check.name, err)
		}
		if got != check.want {
			t.Errorf("%s = %d, want %d", check.name, got, check.want)
		}
	}
	var conditions []string
	rows, err := pool.Query(ctx, `SELECT condition FROM inventory_conditions ORDER BY condition`)
	if err != nil {
		t.Fatal(err)
	}
	for rows.Next() {
		var condition string
		if err := rows.Scan(&condition); err != nil {
			t.Fatal(err)
		}
		conditions = append(conditions, condition)
	}
	rows.Close()
	if got := len(conditions) == 3 && conditions[0] == "damaged" && conditions[1] == "retired" && conditions[2] == "serviceable"; !got {
		t.Errorf("conditions = %v, want damaged/retired/serviceable", conditions)
	}

	// The migration remains additive in Phase A.
	for _, table := range []string{"equipment_stock", "stock_movements", "honey_movements"} {
		var reg *string
		if err := pool.QueryRow(ctx, `SELECT to_regclass($1)::text`, table).Scan(&reg); err != nil || reg == nil {
			t.Errorf("legacy table %s was not retained (reg=%v err=%v)", table, reg, err)
		}
	}
}

func TestInventoryLedgerMigrationGuardsScaleAndHiveDelete(t *testing.T) {
	if os.Getenv("TEST_DATABASE_URL") == "" {
		t.Skip("TEST_DATABASE_URL is not configured")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
	defer cancel()
	pool, cleanup := freshDatabase(ctx, t, "beez_inventory_ledger_guards")
	defer cleanup()
	if err := migrate(ctx, pool); err != nil {
		t.Fatalf("migrate: %v", err)
	}

	apiaryID, hiveID := uuid.New(), uuid.New()
	itemID, opID := uuid.New(), uuid.New()
	mustExec(ctx, t, pool, `INSERT INTO apiaries(id,name) VALUES($1,'Guard Apiary')`, apiaryID)
	mustExec(ctx, t, pool, `INSERT INTO hives(id,apiary_id,position_label) VALUES($1,$2,'A1')`, hiveID, apiaryID)
	mustExec(ctx, t, pool, `INSERT INTO inventory_items
		(id,kind,name,canonical_unit,quantity_scale,lot_tracked,condition_tracked,container_tracked)
		VALUES($1,'equipment','Guard box','count',0,false,true,true)`, itemID)
	mustExec(ctx, t, pool, `INSERT INTO inventory_operations
		(id,kind,reason,occurred_at,idempotency_key,source_type,source_id)
		VALUES($1,'receive','none',now(),'guard-op','test',$1)`, opID)
	var deployedID uuid.UUID
	if err := pool.QueryRow(ctx, `SELECT id FROM inventory_locations WHERE kind='deployed'`).Scan(&deployedID); err != nil {
		t.Fatal(err)
	}
	condition := "serviceable"
	_, err := pool.Exec(ctx, `INSERT INTO inventory_movements
		(operation_id,line_no,item_id,location_id,condition,container_hive_id,quantity)
		VALUES($1,1,$2,$3,$4,$5,0.1)`, opID, itemID, deployedID, condition, hiveID)
	assertSQLState(t, err, "23514")

	mustExec(ctx, t, pool, `INSERT INTO inventory_movements
		(operation_id,line_no,item_id,location_id,condition,container_hive_id,quantity)
		VALUES($1,1,$2,$3,$4,$5,1)`, opID, itemID, deployedID, condition, hiveID)
	_, err = pool.Exec(ctx, `DELETE FROM hives WHERE id=$1`, hiveID)
	assertSQLState(t, err, "23514")

	reversalID := uuid.New()
	mustExec(ctx, t, pool, `INSERT INTO inventory_operations
		(id,kind,reason,occurred_at,idempotency_key,source_type,source_id,reverses_operation_id)
		VALUES($1,'reversal','none',now(),'guard-reverse','test',$2,$2)`, reversalID, opID)
	mustExec(ctx, t, pool, `INSERT INTO inventory_movements
		(operation_id,line_no,item_id,location_id,condition,container_hive_id,quantity)
		VALUES($1,1,$2,$3,$4,$5,-1)`, reversalID, itemID, deployedID, condition, hiveID)
	if _, err := pool.Exec(ctx, `DELETE FROM hives WHERE id=$1`, hiveID); err != nil {
		t.Fatalf("delete balanced hive: %v", err)
	}
}

func assertSQLState(t *testing.T, err error, want string) {
	t.Helper()
	if err == nil {
		t.Fatalf("expected SQLSTATE %s", want)
	}
	var pgErr *pgconn.PgError
	if !errors.As(err, &pgErr) || pgErr.Code != want {
		t.Fatalf("error = %v, want SQLSTATE %s", err, want)
	}
}
