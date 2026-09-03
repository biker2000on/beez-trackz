package app

import (
	"context"
	"sync"
	"testing"

	"github.com/google/uuid"
)

type deduplicatingPublisher struct {
	mu    sync.Mutex
	seen  map[uuid.UUID]int
	calls int
}

func (p *deduplicatingPublisher) PublishDomainEvent(_ context.Context, event StoredEvent) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.calls++
	p.seen[event.ID]++
	return nil
}

func TestDrainEventsIsIdempotentByEventID(t *testing.T) {
	runner := testRunner(t)
	userID := idempotencyUser(t)
	eventID := uuid.New()
	aggregateID := uuid.New()
	if err := runner.Run(context.Background(), UserActor(userID, "test"),
		func(ctx context.Context, uow *UnitOfWork) error {
			return uow.Emit(ctx, Event{ID: eventID, AggregateType: "test",
				AggregateID: aggregateID, Type: "test.ready", Payload: map[string]any{"n": 1}})
		}); err != nil {
		t.Fatal(err)
	}
	publisher := &deduplicatingPublisher{seen: map[uuid.UUID]int{}}
	if n, err := DrainEvents(context.Background(), testPool, publisher, 10000); err != nil || n < 1 {
		t.Fatalf("first drain = %d, %v; want at least 1, nil", n, err)
	}
	if _, err := testPool.Exec(context.Background(),
		`UPDATE domain_events SET published_at=NULL WHERE id=$1`, eventID); err != nil {
		t.Fatal(err)
	}
	if n, err := DrainEvents(context.Background(), testPool, publisher, 10000); err != nil || n != 1 {
		t.Fatalf("retry drain = %d, %v; want 1, nil", n, err)
	}
	if publisher.seen[eventID] != 2 {
		t.Fatalf("event %s deliveries=%d (total calls=%d), want two attempts with one identity",
			eventID, publisher.seen[eventID], publisher.calls)
	}
}
