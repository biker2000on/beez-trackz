package main

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"time"

	"github.com/biker2000on/beez-trackz/backend/internal/app"
	"github.com/biker2000on/beez-trackz/backend/internal/notify"
	"github.com/biker2000on/beez-trackz/backend/internal/recs"
	"github.com/google/uuid"
	"github.com/hibiken/asynq"
	"github.com/jackc/pgx/v5"
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

type domainEventConsumer struct {
	pool     *pgxpool.Pool
	notifier notify.DomainEventPublisher
	now      func() time.Time
}

func (c *domainEventConsumer) ProcessTask(ctx context.Context, task *asynq.Task) error {
	var event app.StoredEvent
	if err := json.Unmarshal(task.Payload(), &event); err != nil {
		return err
	}
	consumer := ""
	switch event.Type {
	case "sale.recorded", "harvest_entry.added":
		consumer = "ntfy"
	case "feeding.refilled":
		consumer = "recommendations"
	}
	if consumer != "" {
		claimed, err := c.claim(ctx, event.ID, consumer)
		if err != nil {
			return err
		}
		if !claimed {
			return nil
		}
		var consumeErr error
		switch consumer {
		case "ntfy":
			consumeErr = c.notifier.Publish(ctx, event)
		case "recommendations":
			now := time.Now().UTC()
			if c.now != nil {
				now = c.now()
			}
			_, _, errs := recs.Run(ctx, c.pool, now)
			if len(errs) > 0 {
				consumeErr = errs[0]
			}
		}
		if consumeErr != nil {
			c.release(ctx, event.ID, consumer)
			return consumeErr
		}
	}
	slog.Info("domain event delivered", "id", event.ID, "type", event.Type,
		"aggregate_type", event.AggregateType, "aggregate_id", event.AggregateID)
	return nil
}

// claim stores the consumer receipt in the event envelope itself, avoiding a
// second schema/table while remaining durable across worker restarts.
func (c *domainEventConsumer) claim(ctx context.Context, id uuid.UUID, name string) (bool, error) {
	var claimed bool
	err := c.pool.QueryRow(ctx, `UPDATE domain_events SET payload=jsonb_set(jsonb_set(payload,'{_consumers}',COALESCE(payload->'_consumers','{}'::jsonb),true),ARRAY['_consumers',$2],'true'::jsonb,true) WHERE id=$1 AND NOT COALESCE((payload #>> ARRAY['_consumers',$2])::boolean,false) RETURNING true`, id, name).Scan(&claimed)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, nil
	}
	return claimed, err
}
func (c *domainEventConsumer) release(ctx context.Context, id uuid.UUID, name string) {
	_, err := c.pool.Exec(ctx, `UPDATE domain_events SET payload=payload #- ARRAY['_consumers',$2] WHERE id=$1`, id, name)
	if err != nil {
		slog.Error("release domain event consumer claim", "id", id, "consumer", name, "err", err)
	}
}
