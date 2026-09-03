package main

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"time"

	"github.com/biker2000on/beez-trackz/backend/internal/app"
	"github.com/hibiken/asynq"
	"github.com/jackc/pgx/v5/pgxpool"
)

const domainEventTaskType = "domain:event"

type asynqEventPublisher struct {
	client *asynq.Client
}

func (p asynqEventPublisher) PublishDomainEvent(ctx context.Context, event app.StoredEvent) error {
	payload, err := json.Marshal(event)
	if err != nil {
		return err
	}
	_, err = p.client.EnqueueContext(ctx,
		asynq.NewTask(domainEventTaskType, payload),
		asynq.TaskID("domain-event:"+event.ID.String()))
	if errors.Is(err, asynq.ErrTaskIDConflict) {
		return nil
	}
	return err
}

func runDomainEventDrain(ctx context.Context, pool *pgxpool.Pool, client *asynq.Client) {
	publisher := asynqEventPublisher{client: client}
	ticker := time.NewTicker(5 * time.Second)
	defer ticker.Stop()
	for {
		if _, err := app.DrainEvents(ctx, pool, publisher, 100); err != nil && ctx.Err() == nil {
			slog.Error("domain event drain", "err", err)
		}
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}

func handleDomainEvent(_ context.Context, task *asynq.Task) error {
	var event app.StoredEvent
	if err := json.Unmarshal(task.Payload(), &event); err != nil {
		return err
	}
	// The outbox is delivery infrastructure; consumers are added by event
	// type. Logging the durable envelope is the no-op first consumer.
	slog.Info("domain event delivered", "id", event.ID, "type", event.Type,
		"aggregate_type", event.AggregateType, "aggregate_id", event.AggregateID)
	return nil
}
