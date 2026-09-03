package main

import (
	"context"
	"os"
	"testing"

	"github.com/biker2000on/beez-trackz/backend/internal/db"
	"github.com/google/uuid"
)

func TestDomainEventConsumerClaimsAreIdempotentPerEvent(t *testing.T) {
	url := os.Getenv("TEST_DATABASE_URL")
	if url == "" {
		t.Skip("TEST_DATABASE_URL is not configured")
	}
	ctx := context.Background()
	pool, err := db.Connect(ctx, url)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()

	consumer := &domainEventConsumer{pool: pool}
	for _, name := range []string{"ntfy", "recommendations"} {
		t.Run(name, func(t *testing.T) {
			id := uuid.New()
			aggregateID := uuid.New()
			if _, err := pool.Exec(ctx, `INSERT INTO domain_events(id,aggregate_type,aggregate_id,event_type,payload) VALUES($1,'test',$2,'test.created','{}')`, id, aggregateID); err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() { _, _ = pool.Exec(context.Background(), `DELETE FROM domain_events WHERE id=$1`, id) })
			claimed, err := consumer.claim(ctx, id, name)
			if err != nil || !claimed {
				t.Fatalf("first claim = %v, %v; want true, nil", claimed, err)
			}
			claimed, err = consumer.claim(ctx, id, name)
			if err != nil || claimed {
				t.Fatalf("duplicate claim = %v, %v; want false, nil", claimed, err)
			}
			consumer.release(ctx, id, name)
			claimed, err = consumer.claim(ctx, id, name)
			if err != nil || !claimed {
				t.Fatalf("retry claim = %v, %v; want true, nil", claimed, err)
			}
		})
	}
}
