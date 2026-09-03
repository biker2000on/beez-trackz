package production

import (
	"context"
	"fmt"
	"time"

	"github.com/biker2000on/beez-trackz/backend/internal/app"
	"github.com/google/uuid"
)

// The harvest-session guards (spec 12.1 open item 1).
//
// Before decision 6, "pounds harvested" and "bulk honey on hand" were the same
// number computed two ways, so shrinking a session's declared weight could be
// checked against the bulk balance. Decision 6 separated them: a lot's ceiling
// IS a receipt into the ledger, and bulk on hand is the balance of those
// receipts. A harvest entry that was never allocated to a lot contributes
// nothing to the ledger at all, which is why the old guards became vacuous —
// deleting such an entry cannot drive bulk negative because it never put a
// pound there, and the comparison always passed.
//
// What the declared weight still governs is the residual of spec 7.4:
//
//	unassigned bulk = Σ harvested − Σ live lot ceilings
//
// The pounds a session declares are an upper bound on what its harvests may be
// committed into lots. Taking the declaration below what the lots already hold
// makes that residual negative, which the reset gate refuses as a real data
// problem. These commands enforce it at the point of edit instead, where the
// operator can still be told which number to fix.

// LotWeightSourceDerived is harvest_lots.honey_weight_source for a lot whose
// pounds follow its linked harvests rather than a typed weight.
const LotWeightSourceDerived = "derived"

// ceilingKeyPattern matches every ceiling operation's idempotency key. The key
// shape is fixed by baseFor (spec 5.1); matching it is how a ceiling is found
// without a second index on the operation table.
const ceilingKeyPattern = "harvest_lot:%:ceiling:%"

// HarvestLotCeiling is one harvest lot's position in the ledger.
type HarvestLotCeiling struct {
	HarvestLotID uuid.UUID
	LotCode      string
	// WeightSource is harvest_lots.honey_weight_source: a 'derived' lot follows
	// its linked harvests, a 'manual' one asserts a typed weight.
	WeightSource string
	// CeilingLbs is what the live ceiling receipt put into the lot.
	CeilingLbs float64
	// OnHandLbs is what is still standing in it.
	OnHandLbs float64
	// DerivedLbs is the sum of the lot's remaining live harvests, i.e. what a
	// derived lot's ceiling would become.
	DerivedLbs float64
	// LiveRunCount is how many non-voided bottling runs still stand on the lot.
	LiveRunCount int
}

// DrawnLbs is what bottling runs and batches have already taken out of the lot.
// A ceiling cannot fall below it.
func (c HarvestLotCeiling) DrawnLbs() float64 { return c.CeilingLbs - c.OnHandLbs }

// CommittedCeilingLbs is Σ of every live harvest-lot ceiling: the pounds of the
// harvest that have been committed into a lot and can be drawn from it.
func (s *Service) CommittedCeilingLbs(ctx context.Context, q app.Querier) (float64, error) {
	var pounds float64
	err := q.QueryRow(ctx, `
		SELECT COALESCE(SUM(m.quantity), 0)::float8
		FROM inventory_operations o
		JOIN inventory_movements m ON m.operation_id = o.id
		WHERE o.source_type = 'harvest_lot'
		  AND o.idempotency_key LIKE $1
		  AND o.reverses_operation_id IS NULL
		  AND NOT EXISTS (
		    SELECT 1 FROM inventory_operations r WHERE r.reverses_operation_id = o.id)`,
		ceilingKeyPattern).Scan(&pounds)
	return pounds, wrapDB("sum harvest lot ceilings", err)
}

// TotalHarvestedLbs is the declared harvest: a trued-up session weight when one
// is set, otherwise the sum of that session's live entries, plus every
// session-less live entry. It is the formula honeyBulkOnHand reports, kept here
// so the guard and the report cannot drift apart.
func TotalHarvestedLbs(ctx context.Context, q app.Querier) (float64, error) {
	var pounds float64
	err := q.QueryRow(ctx, `
		SELECT (SELECT COALESCE(SUM(session_lbs), 0) FROM (
			SELECT COALESCE(NULLIF(hs.total_extracted_weight, 0),
			                (SELECT COALESCE(SUM(hh.calculated_honey_weight), 0)
			                 FROM honey_harvests hh
			                 WHERE hh.session_id = hs.id AND hh.deleted_at IS NULL)) AS session_lbs
			FROM harvest_sessions hs) sessions)
		     + (SELECT COALESCE(SUM(calculated_honey_weight), 0)
		        FROM honey_harvests WHERE session_id IS NULL AND deleted_at IS NULL)`).
		Scan(&pounds)
	return pounds, wrapDB("sum harvested pounds", err)
}

// CheckHarvestResidual refuses a declared-weight change that would BREACH the
// spec 7.4 residual. Call it AFTER the change is applied in the caller's
// transaction, so it reads the post-change figures; removed is the magnitude
// the change took away, which words the refusal and reconstructs what the
// residual was before it.
//
// Breach, not merely violate: a residual that was ALREADY negative before this
// edit is a data problem the edit did not create — a manual lot weight typed
// higher than the harvests behind it, or a legacy import the backfill carried
// in. Refusing there would trap the operator, because the fix (lowering the
// lot) is a different command and the entry they are trying to delete is not
// what put the number wrong. The reset gate still refuses to carry a negative
// residual into Phase B, which is where that data gets confronted.
//
// The empty string means the change may stand.
func (s *Service) CheckHarvestResidual(
	ctx context.Context, uow *app.UnitOfWork, removed float64,
) (string, error) {
	harvested, err := TotalHarvestedLbs(ctx, uow)
	if err != nil {
		return "", err
	}
	committed, err := s.CommittedCeilingLbs(ctx, uow)
	if err != nil {
		return "", err
	}
	if harvested >= committed-PoundTolerance {
		return "", nil
	}
	if harvested+removed < committed-PoundTolerance {
		// Already short before this edit: not this command to refuse.
		return "", nil
	}
	return fmt.Sprintf(
		"This would take %.2f lbs off the harvest, leaving %.2f lbs recorded "+
			"against %.2f lbs already allocated to harvest lots. Lower or unlink "+
			"those lots first.",
		removed, harvested, committed), nil
}

// HarvestLotCeilings lists every harvest lot one harvest is linked to, with the
// ledger position of each. The harvest_lots rows are locked in id order, which
// is the same class-2 lock the bottling and lot-edit writers take.
func (s *Service) HarvestLotCeilings(
	ctx context.Context, uow *app.UnitOfWork, harvestID uuid.UUID,
) ([]HarvestLotCeiling, error) {
	const op = "read harvest lot ceilings"
	rows, err := uow.Query(ctx, `
		SELECT l.id, l.lot_code, l.honey_weight_source
		FROM harvest_lots l
		JOIN harvest_lot_harvests hl ON hl.lot_id = l.id
		WHERE hl.harvest_id = $1
		ORDER BY l.id
		FOR UPDATE OF l`, harvestID)
	if err != nil {
		return nil, wrapDB(op, err)
	}
	lots := make([]HarvestLotCeiling, 0)
	for rows.Next() {
		var lot HarvestLotCeiling
		if err := rows.Scan(&lot.HarvestLotID, &lot.LotCode, &lot.WeightSource); err != nil {
			rows.Close()
			return nil, wrapDB(op, err)
		}
		lots = append(lots, lot)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, wrapDB(op, err)
	}
	// A second statement per lot, deliberately: a locking SELECT in READ
	// COMMITTED keeps the statement snapshot for scalar subqueries in its
	// target list, so a run that committed while this waited for the lock
	// would be invisible to them. Reading the quantities once the locks are
	// held is what makes the guard see it.
	for i := range lots {
		if err := uow.QueryRow(ctx, `
			SELECT
			  COALESCE((SELECT SUM(hh.calculated_honey_weight)
			            FROM harvest_lot_harvests link
			            JOIN honey_harvests hh
			              ON hh.id = link.harvest_id AND hh.deleted_at IS NULL
			            WHERE link.lot_id = $1), 0)::float8,
			  COALESCE((SELECT SUM(m.quantity)
			            FROM inventory_operations o
			            JOIN inventory_movements m ON m.operation_id = o.id
			            WHERE o.source_type = 'harvest_lot' AND o.source_id = $1
			              AND o.idempotency_key LIKE $2
			              AND o.reverses_operation_id IS NULL
			              AND NOT EXISTS (SELECT 1 FROM inventory_operations r
			                              WHERE r.reverses_operation_id = o.id)), 0)::float8,
			  COALESCE((SELECT SUM(b.on_hand) FROM inventory_balances b
			            JOIN harvest_lots hl ON hl.inventory_lot_id = b.lot_id
			            WHERE hl.id = $1 AND b.item_id = $3), 0)::float8,
			  (SELECT COUNT(*)::int FROM bottling_runs run
			   WHERE run.lot_id = $1 AND run.voided_at IS NULL)`,
			lots[i].HarvestLotID, ceilingKeyPattern, HoneyBulkItemID).
			Scan(&lots[i].DerivedLbs, &lots[i].CeilingLbs, &lots[i].OnHandLbs,
				&lots[i].LiveRunCount); err != nil {
			return nil, wrapDB(op, err)
		}
	}
	return lots, nil
}

// RebaseDerivedLotCeilings is the transactional part of removing a harvest from
// the lots it stood behind. Call it after the harvest row is soft-deleted, so
// the sums it reads already exclude it.
//
// Every derived lot the harvest touched drops to the sum of its remaining live
// harvests, in the stored weight AND in the ledger — the two were allowed to
// disagree before, because the recompute only ever wrote harvest_lots and left
// the receipt standing at the old figure. A drop below what the lot has already
// given up is refused with the lot named, rather than left to the nonnegative
// invariant, so the operator is told which lot to unlock. Manual-weight lots
// are untouched: their pounds were typed, not derived, and a harvest leaving
// the link set changes nothing they assert.
//
// Returns a user-facing refusal ("" when the delete may proceed).
func (s *Service) RebaseDerivedLotCeilings(
	ctx context.Context, uow *app.UnitOfWork, harvestID uuid.UUID, occurredAt time.Time,
) (string, error) {
	lots, err := s.HarvestLotCeilings(ctx, uow, harvestID)
	if err != nil {
		return "", err
	}
	// Rule 1, before any recompute: a harvest that stands behind BOTTLED jars
	// cannot leave, derived lot or manual. The lockout walk that justifies or
	// blocks a run follows a lot's linked harvests back to their hives and
	// skips soft-deleted ones, so a harvest vanishing from under a bottled lot
	// takes the withdrawal window behind those jars with it. Voiding the runs
	// first is the deliberate act that belongs in the audit trail.
	for _, lot := range lots {
		if lot.LiveRunCount == 0 {
			continue
		}
		runs := "bottling run"
		if lot.LiveRunCount > 1 {
			runs = "bottling runs"
		}
		return fmt.Sprintf(
			"Lot %s was bottled from this harvest: %d %s still stand on it, "+
				"and the jars keep the harvest's treatment history behind them. "+
				"Void those runs first, then delete the harvest.",
			lot.LotCode, lot.LiveRunCount, runs), nil
	}
	for _, lot := range lots {
		if lot.WeightSource != LotWeightSourceDerived {
			continue
		}
		if drawn := lot.DrawnLbs(); lot.DerivedLbs < drawn-PoundTolerance {
			return fmt.Sprintf(
				"Lot %s derives its weight from this harvest: without it the lot "+
					"totals %.2f lbs but %.2f lbs have already been drawn from it. "+
					"Type a manual weight on the lot or reverse those draws first.",
				lot.LotCode, lot.DerivedLbs, drawn), nil
		}
	}
	for _, lot := range lots {
		if lot.WeightSource != LotWeightSourceDerived {
			continue
		}
		if _, err := uow.Exec(ctx,
			`UPDATE harvest_lots SET honey_weight_lbs=$2 WHERE id=$1`,
			lot.HarvestLotID, lot.DerivedLbs); err != nil {
			return "", wrapDB("recompute harvest lot weight", err)
		}
		if err := s.SetLotCeiling(ctx, uow, lot.HarvestLotID, lot.DerivedLbs, occurredAt); err != nil {
			return "", err
		}
	}
	return "", nil
}
