package notify

import (
	"context"
	"fmt"

	"github.com/biker2000on/beez-trackz/backend/internal/app"
	"github.com/biker2000on/beez-trackz/backend/internal/brand"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// DomainEventPublisher sends the small set of operator-facing outbox facts.
// Event-id deduplication is owned by the worker's durable consumer claim; this
// type owns only settings lookup and ntfy transport.
type DomainEventPublisher struct {
	Pool   *pgxpool.Pool
	Client *Client
	Brand  brand.Brand
}

func (p DomainEventPublisher) Publish(ctx context.Context, event app.StoredEvent) error {
	if p.Pool == nil {
		return nil
	}
	var enabled bool
	var server, topic, token *string
	err := p.Pool.QueryRow(ctx, `SELECT ntfy_enabled,ntfy_server_url,ntfy_topic,ntfy_access_token FROM user_settings LIMIT 1`).Scan(&enabled, &server, &topic, &token)
	if err == pgx.ErrNoRows || !enabled {
		return nil
	}
	if err != nil {
		return err
	}
	cfg := Config{}
	if server != nil {
		cfg.ServerURL = *server
	}
	if topic != nil {
		cfg.Topic = *topic
	}
	if token != nil {
		cfg.AccessToken = *token
	}
	msg, ok := messageForDomainEvent(p.Brand, event.Type)
	if !ok {
		return nil
	}
	return p.Client.Publish(ctx, cfg, msg)
}

func messageForDomainEvent(deployment brand.Brand, eventType string) (Message, bool) {
	if deployment.DisplayName == "" {
		deployment = brand.Default()
	}
	msg := Message{Priority: 3, Tags: "bee"}
	switch eventType {
	case "sale.recorded":
		msg.Title = fmt.Sprintf("Sale recorded · %s", deployment.DisplayName)
		msg.Body = fmt.Sprintf("A sale was recorded in %s.", deployment.DisplayName)
	case "harvest_entry.added":
		msg.Title = fmt.Sprintf("Harvest entry added · %s", deployment.DisplayName)
		msg.Body = fmt.Sprintf("A harvest weight was added in %s.", deployment.DisplayName)
	default:
		return Message{}, false
	}
	return msg, true
}
