package inventory

import (
	"context"
	"errors"
	"fmt"

	"github.com/biker2000on/beez-trackz/backend/internal/app"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

type checkpointCandidate struct {
	tuple       Tuple
	onHand      string
	operationID uuid.UUID
}

// RefreshCheckpoints advances the cache to the latest operation on every
// currently known tuple. It samples before locking and refuses a tuple that
// moved before its lock was acquired, leaving the caller to retry the job.
func (s *Service) RefreshCheckpoints(ctx context.Context, uow *app.UnitOfWork) error {
	const action = "refresh inventory checkpoints"
	if uow == nil || !uow.Actor().Valid() {
		return app.Forbidden(action, "an active unit of work with an actor is required")
	}
	candidates, err := checkpointCandidates(ctx, uow)
	if err != nil {
		return classifyDB(action, err)
	}
	tuples := make([]Tuple, len(candidates))
	for i := range candidates {
		tuples[i] = candidates[i].tuple
	}
	if err := lockTuples(ctx, uow, tuples); err != nil {
		return classifyDB(action, err)
	}
	createdBy := actorID(uow.Actor())
	for _, candidate := range candidates {
		current, found, err := checkpointCandidateFor(ctx, uow, candidate.tuple)
		if err != nil {
			return classifyDB(action, err)
		}
		if !found || current.onHand != candidate.onHand || current.operationID != candidate.operationID {
			return app.Precondition(action, "tuple %s moved while its checkpoint was computed", candidate.tuple)
		}
		if _, err := uow.Exec(ctx, `INSERT INTO inventory_balance_checkpoints
			(item_id,location_id,lot_id,condition,container_hive_id,as_of_operation_id,on_hand,created_by)
			VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
			ON CONFLICT (item_id,location_id,lot_id,condition,container_hive_id)
			DO UPDATE SET as_of_operation_id=EXCLUDED.as_of_operation_id,
			 on_hand=EXCLUDED.on_hand, refreshed_at=now(), created_by=EXCLUDED.created_by`,
			candidate.tuple.ItemID, candidate.tuple.LocationID, candidate.tuple.LotID,
			candidate.tuple.Condition, candidate.tuple.ContainerHiveID, candidate.operationID,
			candidate.onHand, createdBy); err != nil {
			return classifyDB(action, err)
		}
	}
	return nil
}

// RefreshCheckpoints is also available as a package function for jobs that do
// not retain a Service value.
func RefreshCheckpoints(ctx context.Context, uow *app.UnitOfWork) error {
	return NewService().RefreshCheckpoints(ctx, uow)
}

func checkpointCandidates(ctx context.Context, q app.Querier) ([]checkpointCandidate, error) {
	rows, err := q.Query(ctx, `SELECT m.item_id,m.location_id,m.lot_id,m.condition,m.container_hive_id,
		SUM(m.quantity)::text,(array_agg(o.id ORDER BY o.created_at DESC,o.id DESC))[1]
		FROM inventory_movements m JOIN inventory_operations o ON o.id=m.operation_id
		GROUP BY 1,2,3,4,5`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var result []checkpointCandidate
	for rows.Next() {
		var c checkpointCandidate
		if err := rows.Scan(&c.tuple.ItemID, &c.tuple.LocationID, &c.tuple.LotID,
			&c.tuple.Condition, &c.tuple.ContainerHiveID, &c.onHand, &c.operationID); err != nil {
			return nil, err
		}
		result = append(result, c)
	}
	return result, rows.Err()
}

func checkpointCandidateFor(ctx context.Context, q app.Querier, tuple Tuple) (checkpointCandidate, bool, error) {
	var c checkpointCandidate
	c.tuple = tuple
	err := q.QueryRow(ctx, `SELECT SUM(m.quantity)::text,
		(array_agg(o.id ORDER BY o.created_at DESC,o.id DESC))[1]
		FROM inventory_movements m JOIN inventory_operations o ON o.id=m.operation_id
		WHERE m.item_id=$1 AND m.location_id=$2 AND m.lot_id IS NOT DISTINCT FROM $3
		AND m.condition IS NOT DISTINCT FROM $4 AND m.container_hive_id IS NOT DISTINCT FROM $5
		HAVING COUNT(*) > 0`, tuple.ItemID, tuple.LocationID, tuple.LotID, tuple.Condition, tuple.ContainerHiveID).
		Scan(&c.onHand, &c.operationID)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return c, false, nil
		}
		return c, false, fmt.Errorf("read raw checkpoint sum: %w", err)
	}
	return c, true, nil
}
