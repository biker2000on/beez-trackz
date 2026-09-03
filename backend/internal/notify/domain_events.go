package notify

import (
	"context"

	"github.com/biker2000on/beez-trackz/backend/internal/app"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// DomainEventPublisher sends the small set of operator-facing outbox facts.
// Event-id deduplication is owned by the worker's durable consumer claim; this
// type owns only settings lookup and ntfy transport.
type DomainEventPublisher struct {
	Pool   *pgxpool.Pool
	Client *Client
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
	msg := Message{Priority: 3, Tags: "bee"}
	switch event.Type {
	case "sale.recorded":
		msg.Title = "Sale recorded"
		msg.Body = "A sale was recorded in Beez Trackz."
	case "harvest_entry.added":
		msg.Title = "Harvest entry added"
		msg.Body = "A harvest weight was added in Beez Trackz."
	default:
		return nil
	}
	return p.Client.Publish(ctx, cfg, msg)
}
