package app

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Event is a post-commit fact written into the transactional outbox.
type Event struct {
	ID            uuid.UUID
	OccurredAt    time.Time
	AggregateType string
	AggregateID   uuid.UUID
	Type          string
	Payload       any
}

// StoredEvent is the durable shape handed to an outbox publisher.
type StoredEvent struct {
	ID            uuid.UUID       `json:"id"`
	OccurredAt    time.Time       `json:"occurredAt"`
	AggregateType string          `json:"aggregateType"`
	AggregateID   uuid.UUID       `json:"aggregateId"`
	Type          string          `json:"eventType"`
	Payload       json.RawMessage `json:"payload"`
}

// Emit appends an event inside this unit of work. A rollback removes the event
// together with every other command write.
func (u *UnitOfWork) Emit(ctx context.Context, event Event) error {
	const op = "emit domain event"
	if event.ID == uuid.Nil {
		event.ID = uuid.New()
	}
	if event.OccurredAt.IsZero() {
		event.OccurredAt = time.Now().UTC()
	}
	if event.AggregateID == uuid.Nil || strings.TrimSpace(event.AggregateType) == "" || strings.TrimSpace(event.Type) == "" {
		return Invalid(op, "aggregate type, aggregate id, and event type are required")
	}
	payload, err := json.Marshal(event.Payload)
	if err != nil {
		return Internal(op, err)
	}
	var actorID any
	if id := u.actor.AuditUserID(); id != uuid.Nil {
		actorID = id
	}
	_, err = u.Exec(ctx, `
		INSERT INTO domain_events
			(id, occurred_at, aggregate_type, aggregate_id, event_type, payload, actor_id)
		VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)`,
		event.ID, event.OccurredAt.UTC(), event.AggregateType, event.AggregateID,
		event.Type, payload, actorID)
	return Wrap(KindInternal, op, err)
}

// EventPublisher must make publishing idempotent by event ID. The worker uses
// the ID as the asynq task ID, so retrying after a crash cannot enqueue a
// logically different delivery.
type EventPublisher interface {
	PublishDomainEvent(context.Context, StoredEvent) error
}

// DrainEvents publishes up to limit undrained events. Rows are claimed with
// SKIP LOCKED so multiple workers may drain concurrently. Publishing precedes
// the published_at stamp: a crash can redeliver an event, never lose it.
func DrainEvents(ctx context.Context, pool *pgxpool.Pool, publisher EventPublisher, limit int) (int, error) {
	const op = "drain domain events"
	if pool == nil || publisher == nil {
		return 0, Internal(op, errors.New("pool and publisher are required"))
	}
	if limit <= 0 {
		limit = 100
	}
	tx, err := pool.Begin(ctx)
	if err != nil {
		return 0, Internal(op, err)
	}
	defer rollback(ctx, tx)
	rows, err := tx.Query(ctx, `
		SELECT id, occurred_at, aggregate_type, aggregate_id, event_type, payload
		FROM domain_events
		WHERE published_at IS NULL
		ORDER BY occurred_at, id
		FOR UPDATE SKIP LOCKED
		LIMIT $1`, limit)
	if err != nil {
		return 0, Internal(op, err)
	}
	events := make([]StoredEvent, 0, limit)
	for rows.Next() {
		var event StoredEvent
		if err := rows.Scan(&event.ID, &event.OccurredAt, &event.AggregateType,
			&event.AggregateID, &event.Type, &event.Payload); err != nil {
			rows.Close()
			return 0, Internal(op, err)
		}
		events = append(events, event)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return 0, Internal(op, err)
	}

	published := 0
	for _, event := range events {
		if err := publisher.PublishDomainEvent(ctx, event); err != nil {
			if _, dbErr := tx.Exec(ctx, `
				UPDATE domain_events
				SET attempts=attempts+1, last_error=$2
				WHERE id=$1`, event.ID, err.Error()); dbErr != nil {
				return published, Internal(op, dbErr)
			}
			continue
		}
		if _, err := tx.Exec(ctx, `
			UPDATE domain_events
			SET published_at=now(), attempts=attempts+1, last_error=NULL
			WHERE id=$1`, event.ID); err != nil {
			return published, Internal(op, err)
		}
		published++
	}
	if err := tx.Commit(ctx); err != nil && !errors.Is(err, pgx.ErrTxClosed) {
		return published, Internal(op, err)
	}
	return published, nil
}
