package app

import (
	"bytes"
	"context"
	"errors"
	"sync/atomic"
	"testing"

	"github.com/google/uuid"
)

func idempotencyUser(t *testing.T) uuid.UUID {
	t.Helper()
	_ = testRunner(t)
	id := uuid.New()
	if _, err := testPool.Exec(context.Background(),
		`INSERT INTO app_users (id, display_name) VALUES ($1, 'Idempotency Test')`, id); err != nil {
		t.Fatalf("insert test user: %v", err)
	}
	t.Cleanup(func() {
		_, _ = testPool.Exec(context.Background(), `DELETE FROM offline_mutation_receipts WHERE user_id=$1`, id)
		_, _ = testPool.Exec(context.Background(), `DELETE FROM domain_events WHERE actor_id=$1`, id)
		_, _ = testPool.Exec(context.Background(), `DELETE FROM app_users WHERE id=$1`, id)
	})
	return id
}

func TestRunIdempotentHasNoCrashBetweenCommitAndReceiptWindow(t *testing.T) {
	runner := testRunner(t)
	userID := idempotencyUser(t)
	mutationID := uuid.New()
	aggregateID := uuid.New()
	identity := Identity{UserID: userID, MutationID: mutationID, RequestHash: "request-a", ResponseStatus: 201}
	var executions atomic.Int32
	command := func(ctx context.Context, uow *UnitOfWork) (any, error) {
		executions.Add(1)
		if err := uow.Emit(ctx, Event{
			AggregateType: "test", AggregateID: aggregateID, Type: "test.committed",
			Payload: map[string]any{"answer": 42},
		}); err != nil {
			return nil, err
		}
		return map[string]any{"id": aggregateID, "answer": 42}, nil
	}

	first, err := runner.RunIdempotent(context.Background(), UserActor(userID, "test"), identity, command)
	if err != nil {
		t.Fatalf("first run: %v", err)
	}
	second, err := runner.RunIdempotent(context.Background(), UserActor(userID, "test"), identity, command)
	if err != nil {
		t.Fatalf("replay: %v", err)
	}
	if executions.Load() != 1 {
		t.Fatalf("command executions = %d, want 1", executions.Load())
	}
	if !second.Replayed || first.Status != 201 || second.Status != first.Status || !bytes.Equal(second.Body, first.Body) {
		t.Fatalf("replay = %+v, first = %+v; want identical stored result", second, first)
	}
	var events, receipts int
	if err := testPool.QueryRow(context.Background(), `SELECT COUNT(*) FROM domain_events WHERE aggregate_id=$1`, aggregateID).Scan(&events); err != nil {
		t.Fatal(err)
	}
	if err := testPool.QueryRow(context.Background(), `SELECT COUNT(*) FROM offline_mutation_receipts WHERE user_id=$1 AND mutation_id=$2`, userID, mutationID).Scan(&receipts); err != nil {
		t.Fatal(err)
	}
	if events != 1 || receipts != 1 {
		t.Fatalf("committed events=%d receipts=%d, want one of each", events, receipts)
	}
}

func TestRunIdempotentRollbackLeavesNeitherWriteNorReceipt(t *testing.T) {
	runner := testRunner(t)
	userID := idempotencyUser(t)
	mutationID := uuid.New()
	aggregateID := uuid.New()
	wantErr := errors.New("simulated crash before commit")
	_, err := runner.RunIdempotent(context.Background(), UserActor(userID, "test"),
		Identity{UserID: userID, MutationID: mutationID, RequestHash: "request-b"},
		func(ctx context.Context, uow *UnitOfWork) (any, error) {
			if err := uow.Emit(ctx, Event{AggregateType: "test", AggregateID: aggregateID,
				Type: "test.rolled_back", Payload: map[string]any{}}); err != nil {
				return nil, err
			}
			return nil, wantErr
		})
	if !errors.Is(err, wantErr) {
		t.Fatalf("run error = %v, want simulated crash", err)
	}
	var events, receipts int
	_ = testPool.QueryRow(context.Background(), `SELECT COUNT(*) FROM domain_events WHERE aggregate_id=$1`, aggregateID).Scan(&events)
	_ = testPool.QueryRow(context.Background(), `SELECT COUNT(*) FROM offline_mutation_receipts WHERE user_id=$1 AND mutation_id=$2`, userID, mutationID).Scan(&receipts)
	if events != 0 || receipts != 0 {
		t.Fatalf("rolled-back events=%d receipts=%d, want zero", events, receipts)
	}
}

func TestRunIdempotentRejectsPayloadMismatchAndPreHashReceipt(t *testing.T) {
	runner := testRunner(t)
	userID := idempotencyUser(t)
	actor := UserActor(userID, "test")
	mutationID := uuid.New()
	identity := Identity{UserID: userID, MutationID: mutationID, RequestHash: "request-c"}
	if _, err := runner.RunIdempotent(context.Background(), actor, identity,
		func(context.Context, *UnitOfWork) (any, error) { return map[string]bool{"ok": true}, nil }); err != nil {
		t.Fatal(err)
	}
	identity.RequestHash = "different"
	if _, err := runner.RunIdempotent(context.Background(), actor, identity,
		func(context.Context, *UnitOfWork) (any, error) { return nil, nil }); !IsKind(err, KindConflict) {
		t.Fatalf("payload mismatch = %v, want conflict", err)
	}

	preHashID := uuid.New()
	if _, err := testPool.Exec(context.Background(), `
		INSERT INTO offline_mutation_receipts
			(user_id, mutation_id, state, response_status, response_body, request_hash)
		VALUES ($1,$2,'complete',200,'{}',NULL)`, userID, preHashID); err != nil {
		t.Fatal(err)
	}
	if _, err := runner.RunIdempotent(context.Background(), actor,
		Identity{UserID: userID, MutationID: preHashID, RequestHash: "known"},
		func(context.Context, *UnitOfWork) (any, error) { return nil, nil }); !IsKind(err, KindConflict) {
		t.Fatalf("pre-hash receipt = %v, want conflict", err)
	}
}
