-- +goose Up
CREATE TABLE domain_events (
  id uuid PRIMARY KEY,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  aggregate_type text NOT NULL,
  aggregate_id uuid NOT NULL,
  event_type text NOT NULL,
  payload jsonb NOT NULL,
  actor_id uuid REFERENCES app_users(id),
  published_at timestamptz,
  attempts integer NOT NULL DEFAULT 0,
  last_error text
);

CREATE INDEX domain_events_undrained_idx
  ON domain_events (occurred_at, id) WHERE published_at IS NULL;

-- +goose Down
DROP TABLE IF EXISTS domain_events;
