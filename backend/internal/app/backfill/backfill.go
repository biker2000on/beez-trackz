// Package backfill translates the Phase-A compatibility tables into the
// immutable inventory ledger and freezes those tables only after parity.
package backfill

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/biker2000on/beez-trackz/backend/internal/app"
	"github.com/biker2000on/beez-trackz/backend/internal/app/equipment"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

var FreezeTables = []string{
	"honey_movements", "stock_movements", "product_adjustments",
	"equipment_stock", "equipment_stock_adjustments", "equipment_deployments",
	"equipment_deployment_returns", "equipment_state_changes",
}

type Options struct{ Currency string }

type Report struct {
	AlreadyFrozen       bool     `json:"alreadyFrozen"`
	Operations          int      `json:"operations"`
	EquipmentItems      int      `json:"equipmentItems"`
	ExternalSyncRekeyed int64    `json:"externalSyncRekeyed"`
	FrozenTables        []string `json:"frozenTables"`
}

// Run is the app-level gate used by import-snapshot and operators. The runner
// owns one transaction, so any translation/parity/freeze failure rolls the
// ledger and all DDL back together.
func Run(ctx context.Context, pool *pgxpool.Pool, opts Options) (Report, error) {
	if pool == nil {
		return Report{}, app.Invalid("backfill inventory ledger", "database pool is required")
	}
	var report Report
	err := app.NewRunner(pool).Run(ctx, app.SystemRestoreActor(uuid.Nil), func(ctx context.Context, uow *app.UnitOfWork) error {
		if _, err := uow.Exec(ctx, `SET LOCAL TIME ZONE 'UTC'`); err != nil {
			return err
		}
		frozen, err := isFrozen(ctx, uow)
		if err != nil {
			return err
		}
		if frozen {
			report.AlreadyFrozen = true
			report.FrozenTables = append([]string(nil), FreezeTables...)
			return nil
		}
		if err := ensureCatalogs(ctx, uow, &report); err != nil {
			return err
		}
		if err := rejectNegativeBulkResidual(ctx, uow); err != nil {
			return err
		}
		if err := translateEquipment(ctx, uow, &report); err != nil {
			return err
		}
		if err := rejectUntranslatedDomains(ctx, uow); err != nil {
			return err
		}
		if err := verifyEquipmentParity(ctx, uow); err != nil {
			return err
		}
		n, err := RekeyExternalSync(ctx, uow)
		if err != nil {
			return err
		}
		report.ExternalSyncRekeyed = n
		if err := freeze(ctx, uow); err != nil {
			return err
		}
		report.FrozenTables = append([]string(nil), FreezeTables...)
		return nil
	})
	return report, err
}

func ensureCatalogs(ctx context.Context, uow *app.UnitOfWork, report *Report) error {
	actor := auditID(uow)
	if _, err := uow.Exec(ctx, `
		INSERT INTO inventory_items(kind,name,canonical_unit,quantity_scale,lot_tracked,condition_tracked,container_tracked,source_type,source_id,created_by)
		SELECT 'jar',label,'count',0,true,false,false,'jar_size',id,$1 FROM jar_sizes
		ON CONFLICT(source_type,source_id) DO UPDATE SET name=EXCLUDED.name,is_active=true`, actor); err != nil {
		return app.Internal("seed jar inventory items", err)
	}
	if _, err := uow.Exec(ctx, `UPDATE jar_sizes j SET item_id=i.id FROM inventory_items i WHERE i.source_type='jar_size' AND i.source_id=j.id AND j.item_id IS DISTINCT FROM i.id`); err != nil {
		return err
	}
	if _, err := uow.Exec(ctx, `
		INSERT INTO inventory_items(kind,name,canonical_unit,quantity_scale,lot_tracked,condition_tracked,container_tracked,source_type,source_id,created_by)
		SELECT 'catalog_product',name || COALESCE(' '||size_label,''),'count',0,true,false,false,'product_catalog',id,$1 FROM product_catalog
		ON CONFLICT(source_type,source_id) DO UPDATE SET name=EXCLUDED.name,is_active=true`, actor); err != nil {
		return app.Internal("seed product inventory items", err)
	}
	if _, err := uow.Exec(ctx, `UPDATE product_catalog p SET item_id=i.id FROM inventory_items i WHERE i.source_type='product_catalog' AND i.source_id=p.id AND p.item_id IS DISTINCT FROM i.id`); err != nil {
		return err
	}
	rows, err := uow.Query(ctx, `SELECT et.id,COALESCE(es.frame_condition::text,'') FROM equipment_types et LEFT JOIN equipment_stock es ON es.type_id=et.id ORDER BY et.id`)
	if err != nil {
		return err
	}
	type row struct {
		id    uuid.UUID
		frame string
	}
	var types []row
	for rows.Next() {
		var r row
		if err := rows.Scan(&r.id, &r.frame); err != nil {
			rows.Close()
			return err
		}
		types = append(types, r)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return err
	}
	for _, r := range types {
		if _, err := equipment.EnsureItem(ctx, uow, r.id, r.frame); err != nil {
			return err
		}
		report.EquipmentItems++
	}
	// Catalog facts were historically stored on the quantity row. Move them
	// once; COALESCE makes the job idempotent and preserves later catalog edits.
	if _, err := uow.Exec(ctx, `
		UPDATE equipment_types et SET
		 unit_cost_cents=COALESCE(et.unit_cost_cents,es.unit_cost_cents),
		 needed_quantity=COALESCE(et.needed_quantity,es.needed_quantity),
		 storage_location=COALESCE(et.storage_location,es.storage_location),
		 first_deployed_year=COALESCE(et.first_deployed_year,es.first_deployed_year)
		FROM equipment_stock es WHERE es.type_id=et.id`); err != nil {
		return err
	}
	if _, err := uow.Exec(ctx, `
		INSERT INTO inventory_boms(name,output_item_id,created_by)
		SELECT et.name,et.item_id,$1 FROM equipment_types et
		WHERE et.item_id IS NOT NULL AND EXISTS(SELECT 1 FROM equipment_type_components c WHERE c.parent_type_id=et.id)
		AND NOT EXISTS(SELECT 1 FROM inventory_boms b WHERE b.output_item_id=et.item_id)`, actor); err != nil {
		return err
	}
	if _, err := uow.Exec(ctx, `
		INSERT INTO inventory_bom_lines(bom_id,role,item_id,quantity,created_by)
		SELECT b.id,'input',ct.item_id,c.quantity,$1 FROM equipment_type_components c
		JOIN equipment_types pt ON pt.id=c.parent_type_id JOIN inventory_boms b ON b.output_item_id=pt.item_id
		JOIN equipment_types ct ON ct.id=c.component_type_id WHERE ct.item_id IS NOT NULL
		ON CONFLICT(bom_id,role,item_id) DO UPDATE SET quantity=EXCLUDED.quantity`, actor); err != nil {
		return err
	}
	return nil
}

func translateEquipment(ctx context.Context, uow *app.UnitOfWork, report *Report) error {
	service := equipment.NewService()
	type adjustment struct {
		id, stock uuid.UUID
		qty       int
		reason    string
		notes     *string
		cost      *int
		date      time.Time
	}
	rows, err := uow.Query(ctx, `SELECT id,stock_id,quantity,reason::text,notes,unit_cost_cents,date FROM equipment_stock_adjustments ORDER BY date,created_at,id`)
	if err != nil {
		return err
	}
	var adjustments []adjustment
	for rows.Next() {
		var r adjustment
		if err := rows.Scan(&r.id, &r.stock, &r.qty, &r.reason, &r.notes, &r.cost, &r.date); err != nil {
			rows.Close()
			return err
		}
		adjustments = append(adjustments, r)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return err
	}
	for _, r := range adjustments {
		legacyType := "equipment_stock_adjustment"
		cmd := equipment.Command{Reference: r.stock, Quantity: r.qty, OccurredAt: r.date, IdempotencyKey: legacyKey("equipment_stock_adjustments", r.id), Reason: r.reason, UnitCostCents: r.cost, LegacyRefType: &legacyType, LegacyRefID: &r.id, Provenance: "legacy-import"}
		if r.notes != nil {
			cmd.Notes = *r.notes
		}
		var recErr error
		if r.qty > 0 && (r.reason == "purchased" || r.reason == "built") {
			_, recErr = service.Receive(ctx, uow, cmd)
		} else {
			condition := "serviceable"
			_, recErr = service.Adjust(ctx, uow, cmd, condition)
		}
		if recErr != nil {
			return fmt.Errorf("translate equipment adjustment %s: %w", r.id, recErr)
		}
		report.Operations++
	}
	type state struct {
		id, stock        uuid.UUID
		from, to, reason string
		qty              int
		notes            *string
		date             time.Time
	}
	stateRows, err := uow.Query(ctx, `SELECT id,stock_id,from_state::text,to_state::text,quantity,reason,notes,date FROM equipment_state_changes ORDER BY date,created_at,id`)
	if err != nil {
		return err
	}
	var states []state
	for stateRows.Next() {
		var r state
		if err := stateRows.Scan(&r.id, &r.stock, &r.from, &r.to, &r.qty, &r.reason, &r.notes, &r.date); err != nil {
			stateRows.Close()
			return err
		}
		states = append(states, r)
	}
	stateRows.Close()
	if err := stateRows.Err(); err != nil {
		return err
	}
	for _, r := range states {
		legacyType := "equipment_state_change"
		cmd := equipment.ConditionCommand{Command: equipment.Command{Reference: r.stock, Quantity: r.qty, OccurredAt: r.date, IdempotencyKey: legacyKey("equipment_state_changes", r.id), Reason: r.reason, LegacyRefType: &legacyType, LegacyRefID: &r.id, Provenance: "legacy-import"}, From: r.from, To: r.to}
		if r.notes != nil {
			cmd.Notes = *r.notes
		}
		if _, err := service.ConditionChange(ctx, uow, cmd); err != nil {
			return fmt.Errorf("translate equipment state change %s: %w", r.id, err)
		}
		report.Operations++
	}
	type deployment struct {
		id, stock, hive uuid.UUID
		qty             int
		date            time.Time
		notes           *string
	}
	depRows, err := uow.Query(ctx, `SELECT id,stock_id,hive_id,quantity,date_deployed,notes FROM equipment_deployments ORDER BY date_deployed,created_at,id`)
	if err != nil {
		return err
	}
	var deps []deployment
	for depRows.Next() {
		var r deployment
		if err := depRows.Scan(&r.id, &r.stock, &r.hive, &r.qty, &r.date, &r.notes); err != nil {
			depRows.Close()
			return err
		}
		deps = append(deps, r)
	}
	depRows.Close()
	if err := depRows.Err(); err != nil {
		return err
	}
	translated := map[uuid.UUID]uuid.UUID{}
	for _, r := range deps {
		legacyType := "equipment_deployment"
		cmd := equipment.DeployCommand{Command: equipment.Command{Reference: r.stock, Quantity: r.qty, OccurredAt: r.date, IdempotencyKey: legacyKey("equipment_deployments", r.id), LegacyRefType: &legacyType, LegacyRefID: &r.id, Provenance: "legacy-import"}, HiveID: r.hive}
		if r.notes != nil {
			cmd.Notes = *r.notes
		}
		recorded, err := service.Deploy(ctx, uow, cmd)
		if err != nil {
			return fmt.Errorf("translate equipment deployment %s: %w", r.id, err)
		}
		translated[r.id] = recorded.Operation.ID
		report.Operations++
	}
	type returned struct {
		id, deployment    uuid.UUID
		qty               int
		condition, reason string
		notes             *string
		date              time.Time
	}
	returnRows, err := uow.Query(ctx, `SELECT id,deployment_id,quantity,condition,reason,notes,date FROM equipment_deployment_returns ORDER BY date,created_at,id`)
	if err != nil {
		return err
	}
	var returns []returned
	for returnRows.Next() {
		var r returned
		if err := returnRows.Scan(&r.id, &r.deployment, &r.qty, &r.condition, &r.reason, &r.notes, &r.date); err != nil {
			returnRows.Close()
			return err
		}
		returns = append(returns, r)
	}
	returnRows.Close()
	if err := returnRows.Err(); err != nil {
		return err
	}
	for _, r := range returns {
		opID, ok := translated[r.deployment]
		if !ok {
			return app.NotFound("translate equipment return", "deployment %s was not translated", r.deployment)
		}
		legacyType := "equipment_deployment_return"
		cmd := equipment.Command{Quantity: r.qty, OccurredAt: r.date, IdempotencyKey: legacyKey("equipment_deployment_returns", r.id), Reason: r.reason, LegacyRefType: &legacyType, LegacyRefID: &r.id, Provenance: "legacy-import"}
		if r.notes != nil {
			cmd.Notes = *r.notes
		}
		if _, err := service.Return(ctx, uow, opID, r.qty, cmd); err != nil {
			return fmt.Errorf("translate equipment return %s: %w", r.id, err)
		}
		report.Operations++
	}
	return nil
}

func verifyEquipmentParity(ctx context.Context, uow *app.UnitOfWork) error {
	rows, err := uow.Query(ctx, `
		SELECT es.id,es.total_owned,es.damaged_quantity,es.retired_quantity,
		 COALESCE((SELECT SUM(d.quantity-d.quantity_returned) FROM equipment_deployments d WHERE d.stock_id=es.id),0)::int,
		 COALESCE(SUM(b.on_hand) FILTER(WHERE b.condition='serviceable'),0)::int,
		 COALESCE(SUM(b.on_hand) FILTER(WHERE b.condition='damaged'),0)::int,
		 COALESCE(SUM(b.on_hand) FILTER(WHERE b.condition='retired'),0)::int,
		 COALESCE(SUM(b.on_hand) FILTER(WHERE b.location_id=$1),0)::int
		FROM equipment_stock es JOIN equipment_types et ON et.id=es.type_id
		JOIN inventory_items i ON i.source_id=et.id
		LEFT JOIN inventory_balances b ON b.item_id=i.id
		GROUP BY es.id`, equipment.DeployedLocation)
	if err != nil {
		return app.Internal("verify equipment ledger parity", err)
	}
	defer rows.Close()
	for rows.Next() {
		var id uuid.UUID
		var owned, damaged, retired, deployed, serviceableNew, damagedNew, retiredNew, deployedNew int
		if err := rows.Scan(&id, &owned, &damaged, &retired, &deployed, &serviceableNew, &damagedNew, &retiredNew, &deployedNew); err != nil {
			return err
		}
		if damaged != damagedNew || retired != retiredNew || deployed != deployedNew || owned-damaged-retired != serviceableNew {
			return app.Precondition("verify equipment ledger parity", "stock %s differs: legacy owned/damaged/retired/deployed=%d/%d/%d/%d ledger serviceable/damaged/retired/deployed=%d/%d/%d/%d", id, owned, damaged, retired, deployed, serviceableNew, damagedNew, retiredNew, deployedNew)
		}
	}
	return rows.Err()
}

// Until the other Wave-2 workers' producers are integrated, freezing a
// populated non-equipment ledger would make those rows impossible to replay.
// Refusing here preserves the all-or-nothing contract and makes the integration
// dependency explicit instead of committing a partial backfill.
func rejectUntranslatedDomains(ctx context.Context, uow *app.UnitOfWork) error {
	checks := []string{"honey_movements", "stock_movements", "product_adjustments"}
	for _, table := range checks {
		var n int64
		if err := uow.QueryRow(ctx, fmt.Sprintf(`SELECT COUNT(*) FROM %s`, table)).Scan(&n); err != nil {
			return err
		}
		if n > 0 {
			return app.Precondition("backfill inventory ledger", "%s has %d rows; production/sales translation must be integrated before freeze", table, n)
		}
	}
	return nil
}

func rejectNegativeBulkResidual(ctx context.Context, uow *app.UnitOfWork) error {
	var residual float64
	err := uow.QueryRow(ctx, `WITH global_honey AS (SELECT
	 (SELECT COALESCE(SUM(session_lbs),0) FROM(SELECT COALESCE(NULLIF(hs.total_extracted_weight,0),(SELECT COALESCE(SUM(hh.calculated_honey_weight),0) FROM honey_harvests hh WHERE hh.session_id=hs.id AND hh.deleted_at IS NULL)) session_lbs FROM harvest_sessions hs)s)
	 +(SELECT COALESCE(SUM(calculated_honey_weight),0) FROM honey_harvests WHERE session_id IS NULL AND deleted_at IS NULL) total)
	 SELECT total-COALESCE((SELECT SUM(honey_weight_lbs) FROM harvest_lots),0)-COALESCE((SELECT SUM(amount_lbs) FROM honey_movements WHERE lot_id IS NULL AND kind IN('jarring','bulk_use','loss')),0) FROM global_honey`).Scan(&residual)
	if err != nil {
		return err
	}
	if residual < -0.0001 {
		return app.Precondition("backfill inventory ledger", "negative unassigned bulk residual %.4f", residual)
	}
	return nil
}

func legacyKey(table string, id uuid.UUID) string { return "legacy:" + table + ":" + id.String() }
func auditID(uow *app.UnitOfWork) *uuid.UUID {
	id := uow.Actor().AuditUserID()
	if id == uuid.Nil {
		return nil
	}
	return &id
}

func isFrozen(ctx context.Context, q app.Querier) (bool, error) {
	var frozen bool
	err := q.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid WHERE c.relname='honey_movements' AND t.tgname='inventory_legacy_freeze' AND NOT t.tgisinternal)`).Scan(&frozen)
	return frozen, err
}

func freeze(ctx context.Context, uow *app.UnitOfWork) error {
	if _, err := uow.Exec(ctx, `CREATE OR REPLACE FUNCTION inventory_legacy_freeze_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'legacy inventory table % is frozen; write inventory_operations instead',TG_TABLE_NAME USING ERRCODE='55000'; END $$`); err != nil {
		return err
	}
	for _, table := range FreezeTables {
		if strings.ContainsAny(table, `";'`) {
			return errors.New("invalid freeze table")
		}
		if _, err := uow.Exec(ctx, fmt.Sprintf(`DROP TRIGGER IF EXISTS inventory_legacy_freeze ON %s; CREATE TRIGGER inventory_legacy_freeze BEFORE INSERT OR UPDATE OR DELETE ON %s FOR EACH ROW EXECUTE FUNCTION inventory_legacy_freeze_guard()`, table, table)); err != nil {
			return fmt.Errorf("freeze %s: %w", table, err)
		}
	}
	return nil
}
