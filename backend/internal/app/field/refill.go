package field

import (
	"context"
	"errors"
	"time"

	"github.com/biker2000on/beez-trackz/backend/internal/app"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

// RefillFeederInput describes one feeder lifecycle transition. Nil optional
// values inherit from the feeder being refilled.
type RefillFeederInput struct {
	FeedingID    uuid.UUID
	DateFed      time.Time
	Type         *string
	Quantity     *float64
	QuantityUnit *string
	FeederType   *string
	Notes        *string
}

// FeedingResult is the newly-open successor returned by RefillFeeder.
type FeedingResult struct {
	ID           uuid.UUID  `json:"id"`
	HiveID       uuid.UUID  `json:"hiveId"`
	DateFed      time.Time  `json:"dateFed"`
	Type         string     `json:"type"`
	Quantity     float64    `json:"quantity"`
	QuantityUnit string     `json:"quantityUnit"`
	FeederType   *string    `json:"feederType"`
	DateEmpty    *time.Time `json:"dateEmpty"`
	Notes        *string    `json:"notes"`
	CreatedAt    time.Time  `json:"createdAt"`
	Status       string     `json:"status"`
	ClosedAt     *time.Time `json:"closedAt"`
	ClosedReason *string    `json:"closedReason"`
	RefillOfID   *uuid.UUID `json:"refillOfId"`
}

// RefillFeeder closes one feeder episode and opens exactly one successor.
func RefillFeeder(ctx context.Context, uow *app.UnitOfWork, input RefillFeederInput) (FeedingResult, error) {
	const op = "refill feeder"
	var result FeedingResult
	if input.FeedingID == uuid.Nil || input.DateFed.IsZero() {
		return result, app.Invalid(op, "feeding and refill date are required")
	}
	if input.Quantity != nil && *input.Quantity <= 0 {
		return result, app.Invalid(op, "Quantity must be greater than zero")
	}

	var source struct {
		hiveID       uuid.UUID
		feedType     string
		quantity     float64
		quantityUnit string
		feederType   *string
		status       string
	}
	err := uow.QueryRow(ctx, `
		SELECT hive_id, type::text, quantity, quantity_unit::text,
		       feeder_type::text, status::text
		FROM feedings WHERE id=$1 FOR UPDATE`, input.FeedingID).
		Scan(&source.hiveID, &source.feedType, &source.quantity, &source.quantityUnit,
			&source.feederType, &source.status)
	if errors.Is(err, pgx.ErrNoRows) {
		return result, app.NotFound(op, "Feeding not found")
	}
	if err != nil {
		return result, app.Internal(op, err)
	}
	if source.status == "closed" {
		return result, app.Conflict(op,
			"This feeder is already closed — record a new feeding instead")
	}

	actorID := uow.Actor().AuditUserID()
	var actor any
	if actorID != uuid.Nil {
		actor = actorID
	}
	if _, err := uow.Exec(ctx, `
		UPDATE feedings
		SET status='closed', closed_at=$2, closed_reason='refilled',
		    status_changed_at=now(), status_changed_by=$3,
		    date_empty=COALESCE(date_empty,$2)
		WHERE id=$1`, input.FeedingID, input.DateFed, actor); err != nil {
		return result, app.Internal(op, err)
	}

	if input.Type != nil && *input.Type != "" {
		source.feedType = *input.Type
	}
	if input.Quantity != nil {
		source.quantity = *input.Quantity
	}
	if input.QuantityUnit != nil && *input.QuantityUnit != "" {
		source.quantityUnit = *input.QuantityUnit
	}
	if input.FeederType != nil {
		if *input.FeederType == "" {
			source.feederType = nil
		} else {
			source.feederType = input.FeederType
		}
	}

	var newID uuid.UUID
	err = uow.QueryRow(ctx, `
		INSERT INTO feedings
			(hive_id, date_fed, type, quantity, quantity_unit, feeder_type, notes,
			 status, refill_of_id, status_changed_at, status_changed_by)
		VALUES ($1,$2,$3,$4,$5,$6,$7,'open',$8,now(),$9)
		RETURNING id`, source.hiveID, input.DateFed, source.feedType, source.quantity,
		source.quantityUnit, source.feederType, input.Notes, input.FeedingID, actor).Scan(&newID)
	if err != nil {
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) && pgErr.Code == "23505" {
			return result, app.Conflict(op, "This feeder has already been refilled")
		}
		return result, app.Internal(op, err)
	}
	err = uow.QueryRow(ctx, `
		SELECT id, hive_id, date_fed, type, quantity, quantity_unit,
		       feeder_type, date_empty, notes, created_at,
		       status::text, closed_at, closed_reason, refill_of_id
		FROM feedings WHERE id=$1`, newID).
		Scan(&result.ID, &result.HiveID, &result.DateFed, &result.Type, &result.Quantity,
			&result.QuantityUnit, &result.FeederType, &result.DateEmpty, &result.Notes,
			&result.CreatedAt, &result.Status, &result.ClosedAt, &result.ClosedReason,
			&result.RefillOfID)
	if err != nil {
		return FeedingResult{}, app.Internal(op, err)
	}
	if err := uow.Emit(ctx, app.Event{
		AggregateType: "feeding", AggregateID: input.FeedingID,
		Type: "feeding.refilled", Payload: map[string]any{"refillId": newID},
	}); err != nil {
		return FeedingResult{}, err
	}
	return result, nil
}
