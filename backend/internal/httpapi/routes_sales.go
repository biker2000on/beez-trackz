package httpapi

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

const (
	saleKindJar       = "jar"
	saleKindColony    = "colony"
	saleKindEquipment = "equipment"
)

// saleApplyPhysical moves the colony, feeders, and equipment that a mixed
// sale takes with it. Jar stock is derived from sale_items, so it is not
// written here. needed is mutated as hive deployments consume equipment qty.
func saleApplyPhysical(
	ctx context.Context,
	tx pgx.Tx,
	saleID uuid.UUID,
	date time.Time,
	actor *uuid.UUID,
	lines []honeySaleLine,
) error {
	needed := make(map[uuid.UUID]int)
	var hiveIDs []uuid.UUID
	seenHive := make(map[uuid.UUID]bool, len(lines))
	for _, line := range lines {
		switch line.Kind {
		case saleKindColony:
			if seenHive[line.HiveID] {
				return saleBadRequest("a hive can only appear once on a sale")
			}
			seenHive[line.HiveID] = true
			hiveIDs = append(hiveIDs, line.HiveID)
		case saleKindEquipment:
			needed[line.EquipmentStockID] += line.Quantity
		}
	}
	for _, hiveID := range hiveIDs {
		if err := saleSellHive(ctx, tx, saleID, hiveID, date, actor, needed); err != nil {
			return err
		}
	}
	for stockID, qty := range needed {
		if qty <= 0 {
			continue
		}
		if err := saleSellFromStock(ctx, tx, saleID, stockID, qty, date, actor); err != nil {
			return err
		}
	}
	return nil
}

func saleSellHive(
	ctx context.Context,
	tx pgx.Tx,
	saleID, hiveID uuid.UUID,
	date time.Time,
	actor *uuid.UUID,
	needed map[uuid.UUID]int,
) error {
	var status string
	err := tx.QueryRow(ctx,
		`SELECT status::text FROM hives WHERE id=$1 FOR UPDATE`, hiveID).Scan(&status)
	if errors.Is(err, pgx.ErrNoRows) {
		return saleBadRequest("invalid hiveId")
	}
	if err != nil {
		return err
	}
	if status == "sold" || status == "dead" || status == "combined" {
		return saleBadRequest("cannot sell a hive that is already %s", status)
	}

	type depRow struct {
		ID          uuid.UUID
		StockID     uuid.UUID
		Outstanding int
	}
	rows, err := tx.Query(ctx, `
		SELECT id, stock_id, quantity - quantity_returned
		FROM equipment_deployments
		WHERE hive_id=$1 AND date_removed IS NULL AND quantity > quantity_returned
		ORDER BY date_deployed, id
		FOR UPDATE`, hiveID)
	if err != nil {
		return err
	}
	deps := make([]depRow, 0)
	for rows.Next() {
		var d depRow
		if err := rows.Scan(&d.ID, &d.StockID, &d.Outstanding); err != nil {
			rows.Close()
			return err
		}
		deps = append(deps, d)
	}
	rows.Close()
	if rows.Err() != nil {
		return rows.Err()
	}

	for _, dep := range deps {
		sellQty := needed[dep.StockID]
		if sellQty > dep.Outstanding {
			sellQty = dep.Outstanding
		}
		if sellQty > 0 {
			if err := saleCloseDeployment(ctx, tx, dep.ID, sellQty, "sold_with_hive",
				saleID, date, actor); err != nil {
				return err
			}
			if err := saleInsertSoldAdjustment(ctx, tx, dep.StockID, sellQty, saleID,
				date, actor, "sold with hive"); err != nil {
				return err
			}
			needed[dep.StockID] -= sellQty
		}
		kept := dep.Outstanding - sellQty
		if kept > 0 {
			if err := saleCloseDeployment(ctx, tx, dep.ID, kept, "hive_removed",
				saleID, date, actor); err != nil {
				return err
			}
		}
	}

	if _, err := tx.Exec(ctx, `
		UPDATE feedings
		SET status='closed',
		    closed_at=$2,
		    closed_reason='sold_with_hive',
		    sale_id=$3,
		    status_changed_at=now(),
		    status_changed_by=$4,
		    date_empty=COALESCE(date_empty, $2)
		WHERE hive_id=$1 AND status IN ('open','unverified')`,
		hiveID, date, saleID, actor); err != nil {
		return err
	}

	tag, err := tx.Exec(ctx, `
		UPDATE hives SET status='sold', sale_id=$2
		WHERE id=$1 AND status NOT IN ('sold','dead','combined')`, hiveID, saleID)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return saleBadRequest("cannot sell a hive that is already sold, dead, or combined")
	}
	return nil
}

func saleCloseDeployment(
	ctx context.Context,
	tx pgx.Tx,
	deploymentID uuid.UUID,
	qty int,
	reason string,
	saleID uuid.UUID,
	date time.Time,
	actor *uuid.UUID,
) error {
	_, err := equipReturnTx(ctx, tx, equipReturnInput{
		DeploymentID: deploymentID,
		Quantity:     &qty,
		Reason:       reason,
		Condition:    "good",
		Date:         date,
		CreatedBy:    actor,
		SaleID:       &saleID,
	})
	return err
}

func saleSellFromStock(
	ctx context.Context,
	tx pgx.Tx,
	saleID, stockID uuid.UUID,
	qty int,
	date time.Time,
	actor *uuid.UUID,
) error {
	state, err := equipLockStock(ctx, tx, stockID)
	if err != nil {
		return err
	}
	if qty > state.Available() {
		return saleBadRequest("Not enough %s available: need %d, have %d",
			state.TypeName, qty, state.Available())
	}
	return saleInsertSoldAdjustment(ctx, tx, stockID, qty, saleID, date, actor, "sold from stock")
}

func saleInsertSoldAdjustment(
	ctx context.Context,
	tx pgx.Tx,
	stockID uuid.UUID,
	qty int,
	saleID uuid.UUID,
	date time.Time,
	actor *uuid.UUID,
	notes string,
) error {
	_, err := tx.Exec(ctx, `
		INSERT INTO equipment_stock_adjustments
			(stock_id, quantity, reason, notes, date, created_by, sale_id)
		VALUES ($1, $2, 'sold', $3, $4, $5, $6)`,
		stockID, -qty, notes, date, actor, saleID)
	return err
}

// saleRestorePhysical undoes the first cancel of a mixed sale. Idempotent
// replays must not call this after the sale is already cancelled.
func saleRestorePhysical(
	ctx context.Context,
	tx pgx.Tx,
	saleID uuid.UUID,
	actor *uuid.UUID,
) error {
	// Reverse sold adjustments first so owned is restored before deployments
	// go back on the hive (available never goes negative in between).
	adjRows, err := tx.Query(ctx, `
		SELECT stock_id, -quantity
		FROM equipment_stock_adjustments
		WHERE sale_id=$1 AND quantity < 0 AND reason='sold'
		ORDER BY created_at`, saleID)
	if err != nil {
		return err
	}
	type adj struct {
		StockID uuid.UUID
		Qty     int
	}
	adjustments := make([]adj, 0)
	for adjRows.Next() {
		var a adj
		if err := adjRows.Scan(&a.StockID, &a.Qty); err != nil {
			adjRows.Close()
			return err
		}
		adjustments = append(adjustments, a)
	}
	adjRows.Close()
	if adjRows.Err() != nil {
		return adjRows.Err()
	}
	for _, a := range adjustments {
		if _, err := equipLockStock(ctx, tx, a.StockID); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `
			INSERT INTO equipment_stock_adjustments
				(stock_id, quantity, reason, notes, date, created_by)
			VALUES ($1, $2, 'other', 'sale cancelled', now(), $3)`,
			a.StockID, a.Qty, actor); err != nil {
			return err
		}
	}

	retRows, err := tx.Query(ctx, `
		SELECT id, deployment_id, quantity
		FROM equipment_deployment_returns
		WHERE sale_id=$1
		ORDER BY created_at DESC`, saleID)
	if err != nil {
		return err
	}
	type ret struct {
		ID, DeploymentID uuid.UUID
		Qty              int
	}
	returns := make([]ret, 0)
	for retRows.Next() {
		var r ret
		if err := retRows.Scan(&r.ID, &r.DeploymentID, &r.Qty); err != nil {
			retRows.Close()
			return err
		}
		returns = append(returns, r)
	}
	retRows.Close()
	if retRows.Err() != nil {
		return retRows.Err()
	}
	for _, r := range returns {
		if _, err := tx.Exec(ctx, `
			UPDATE equipment_deployments
			SET quantity_returned = quantity_returned - $2,
			    date_removed = NULL
			WHERE id=$1`, r.DeploymentID, r.Qty); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx,
			`DELETE FROM equipment_deployment_returns WHERE id=$1`, r.ID); err != nil {
			return err
		}
	}

	if _, err := tx.Exec(ctx, `
		UPDATE feedings
		SET status='open',
		    closed_at=NULL,
		    date_empty=NULL,
		    closed_reason=NULL,
		    sale_id=NULL,
		    status_changed_at=now(),
		    status_changed_by=$2
		WHERE sale_id=$1 AND closed_reason='sold_with_hive'`,
		saleID, actor); err != nil {
		return err
	}

	if _, err := tx.Exec(ctx, `
		UPDATE hives SET status='active', sale_id=NULL WHERE sale_id=$1`,
		saleID); err != nil {
		return err
	}
	return nil
}

func saleBadRequest(format string, args ...any) error {
	return equipBadRequest(format, args...)
}

// GET /hives/{id}/sale-offer — deployments and feeder count the sale dialog
// default-offers when the operator adds this hive as a colony line.
func (s *Server) hiveSaleOffer(w http.ResponseWriter, r *http.Request) {
	hiveID, err := uuidParam(r, "id")
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	hive, err := s.hiveFetch(r.Context(), hiveID)
	if errors.Is(err, pgx.ErrNoRows) {
		writeError(w, http.StatusNotFound, "hive not found")
		return
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}

	var openFeeders int
	if err := s.pool.QueryRow(r.Context(), `
		SELECT COUNT(*) FROM feedings
		WHERE hive_id=$1 AND status IN ('open','unverified')`, hiveID).
		Scan(&openFeeders); err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}

	rows, err := s.pool.Query(r.Context(), `
		SELECT ed.id, ed.stock_id, et.name, et.category::text,
		       ed.quantity - ed.quantity_returned, es.unit_cost_cents
		FROM equipment_deployments ed
		JOIN equipment_stock es ON es.id = ed.stock_id
		JOIN equipment_types et ON et.id = es.type_id
		WHERE ed.hive_id=$1 AND ed.date_removed IS NULL
		  AND ed.quantity > ed.quantity_returned
		ORDER BY et.category, et.name`, hiveID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	defer rows.Close()

	type depOffer struct {
		ID            uuid.UUID `json:"id"`
		StockID       uuid.UUID `json:"stockId"`
		TypeName      string    `json:"typeName"`
		TypeCategory  string    `json:"typeCategory"`
		Outstanding   int       `json:"outstanding"`
		UnitCostCents *int      `json:"unitCostCents"`
	}
	deployments := make([]depOffer, 0)
	for rows.Next() {
		var d depOffer
		if err := rows.Scan(&d.ID, &d.StockID, &d.TypeName, &d.TypeCategory,
			&d.Outstanding, &d.UnitCostCents); err != nil {
			writeError(w, http.StatusInternalServerError, "database error")
			return
		}
		deployments = append(deployments, d)
	}
	if rows.Err() != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}

	sellable := hive.Status != "sold" && hive.Status != "dead" && hive.Status != "combined"
	reason := ""
	if !sellable {
		reason = fmt.Sprintf("this hive is already %s", hive.Status)
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"hiveId":      hive.ID,
		"hiveLabel":   hive.PositionLabel,
		"apiaryName":  hive.ApiaryName,
		"status":      hive.Status,
		"sellable":    sellable,
		"reason":      reason,
		"openFeeders": openFeeders,
		"deployments": deployments,
	})
}
