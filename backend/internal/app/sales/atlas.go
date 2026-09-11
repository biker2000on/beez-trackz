package sales

import (
	"context"
	"errors"
	"time"

	"github.com/biker2000on/beez-trackz/backend/internal/app"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

type FactResult struct {
	ID                uuid.UUID  `json:"id"`
	AmountPaidCents   int64      `json:"amountPaidCents"`
	PhysicalAppliedAt *time.Time `json:"physicalAppliedAt"`
	Success           bool       `json:"success"`
}

func RecordPayment(ctx context.Context, uow *app.UnitOfWork, id uuid.UUID, paid int64, method *string) (FactResult, error) {
	const op = "record payment"
	out := FactResult{ID: id, AmountPaidCents: paid, Success: true}
	if uow == nil || !uow.Actor().MayAdminister() {
		return out, app.Forbidden(op, "administrator access is required")
	}
	if method != nil {
		switch *method {
		case "cash", "card", "check", "venmo", "paypal", "invoice", "other":
		default:
			return out, app.Invalid(op, "invalid payment method")
		}
	}
	var total int64
	err := uow.QueryRow(ctx, `SELECT total_amount_cents,physical_applied_at FROM sales WHERE id=$1 AND order_status<>'cancelled' FOR UPDATE`, id).Scan(&total, &out.PhysicalAppliedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return out, app.NotFound(op, "sale not found")
	}
	if err != nil {
		return out, dbError(op, err)
	}
	if paid < 0 || paid > total {
		return out, app.Invalid(op, "amount paid must be between zero and total")
	}
	if _, err = uow.Exec(ctx, `UPDATE sales SET amount_paid_cents=$2,payment_method=COALESCE($3,payment_method) WHERE id=$1`, id, paid, method); err != nil {
		return out, dbError(op, err)
	}
	return out, uow.Emit(ctx, app.Event{AggregateType: "sale", AggregateID: id, Type: "sale.payment_recorded", Payload: map[string]any{"amountPaidCents": paid}})
}
func Fulfill(ctx context.Context, uow *app.UnitOfWork, id uuid.UUID) (FactResult, error) {
	const op = "fulfill sale"
	out := FactResult{ID: id, Success: true}
	if uow == nil || !uow.Actor().MayAdminister() {
		return out, app.Forbidden(op, "administrator access is required")
	}
	err := uow.QueryRow(ctx, `SELECT amount_paid_cents,physical_applied_at FROM sales WHERE id=$1 AND order_status<>'cancelled' FOR UPDATE`, id).Scan(&out.AmountPaidCents, &out.PhysicalAppliedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return out, app.NotFound(op, "sale not found")
	}
	if err != nil {
		return out, dbError(op, err)
	}
	if out.PhysicalAppliedAt != nil {
		return out, nil
	}
	lines, err := loadCommandLines(ctx, uow, id)
	if err != nil {
		return out, err
	}
	// Mark applied inside this transaction before consumption, releasing this order's own reservation only.
	if err = uow.QueryRow(ctx, `UPDATE sales SET physical_applied_at=now(),order_status='fulfilled' WHERE id=$1 RETURNING physical_applied_at`, id).Scan(&out.PhysicalAppliedAt); err != nil {
		return out, dbError(op, err)
	}
	if err = applyPhysical(ctx, uow, id, *out.PhysicalAppliedAt, lines); err != nil {
		return out, err
	}
	return out, uow.Emit(ctx, app.Event{AggregateType: "sale", AggregateID: id, Type: "sale.fulfilled", Payload: map[string]any{}})
}
