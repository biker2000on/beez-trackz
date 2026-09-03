package production

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/biker2000on/beez-trackz/backend/internal/app"
	"github.com/biker2000on/beez-trackz/backend/internal/app/inventory"
	"github.com/biker2000on/beez-trackz/backend/internal/app/inventory/build"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// Service is the honey and product command surface. It holds no state beyond
// the inventory service it delegates quantity work to.
type Service struct {
	inventory *inventory.Service
}

func New() *Service { return &Service{inventory: inventory.NewService()} }

// Inventory exposes the ledger service for callers that need a read model.
func (s *Service) Inventory() *inventory.Service { return s.inventory }

// Guard is a beekeeping rule evaluated before any builder runs (decision 7).
// The rules themselves — treatment lockout, moisture, withdrawal windows,
// future-dated refusals — live with the domain records they read; a command
// only guarantees that they are checked first and that a refusal stops the
// operation from ever being built.
type Guard func(ctx context.Context, uow *app.UnitOfWork) error

func runGuards(ctx context.Context, uow *app.UnitOfWork, guards []Guard) error {
	for _, guard := range guards {
		if guard == nil {
			continue
		}
		if err := guard(ctx, uow); err != nil {
			return err
		}
	}
	return nil
}

// baseFor builds the common operation header. Every producer in this package
// goes through it so idempotency keys keep one shape:
// <source_type>:<source_id>:<command>:<attempt> (spec 5.1).
func baseFor(
	uow *app.UnitOfWork, sourceType string, sourceID uuid.UUID,
	command string, attempt int, reason string, occurredAt time.Time, details map[string]any,
) build.Base {
	return build.Base{
		ID:             uuid.New(),
		OccurredAt:     occurredAt.UTC(),
		IdempotencyKey: fmt.Sprintf("%s:%s:%s:%d", sourceType, sourceID, command, attempt),
		SourceType:     sourceType,
		SourceID:       sourceID,
		Reason:         reason,
		Actor:          uow.Actor(),
		Details:        details,
	}
}

// attemptFor counts the operations already recorded for one source and
// command, so a re-applied sale or a second ceiling adjustment gets a fresh
// payload-bound key instead of colliding with its predecessor.
func attemptFor(
	ctx context.Context, uow *app.UnitOfWork, sourceType string, sourceID uuid.UUID, command string,
) (int, error) {
	var count int
	err := uow.QueryRow(ctx, `
		SELECT COUNT(*) FROM inventory_operations
		WHERE source_type=$1 AND source_id=$2 AND idempotency_key LIKE $3`,
		sourceType, sourceID, fmt.Sprintf("%s:%s:%s:%%", sourceType, sourceID, command)).Scan(&count)
	if err != nil {
		return 0, wrapDB("count operations", err)
	}
	return count + 1, nil
}

// liveOperation finds the one operation recorded for a source and command
// that has not been reversed. It is how a void, an unapply, or a ceiling
// change finds what to negate without storing a back-pointer (review Q3).
func liveOperation(
	ctx context.Context, uow *app.UnitOfWork, sourceType string, sourceID uuid.UUID, command string,
) (uuid.UUID, bool, error) {
	var id uuid.UUID
	err := uow.QueryRow(ctx, `
		SELECT o.id FROM inventory_operations o
		WHERE o.source_type=$1 AND o.source_id=$2
		  AND o.idempotency_key LIKE $3
		  AND o.reverses_operation_id IS NULL
		  AND NOT EXISTS (SELECT 1 FROM inventory_operations r WHERE r.reverses_operation_id = o.id)
		ORDER BY o.created_at DESC, o.id DESC
		LIMIT 1`,
		sourceType, sourceID, fmt.Sprintf("%s:%s:%s:%%", sourceType, sourceID, command)).Scan(&id)
	if errors.Is(err, pgx.ErrNoRows) {
		return uuid.Nil, false, nil
	}
	if err != nil {
		return uuid.Nil, false, wrapDB("find live operation", err)
	}
	return id, true, nil
}

// liveOperations is liveOperation for a source that recorded several (a
// jarring session's runs, a transfer's two halves).
func liveOperations(
	ctx context.Context, uow *app.UnitOfWork, sourceType string, sourceID uuid.UUID,
) ([]uuid.UUID, error) {
	rows, err := uow.Query(ctx, `
		SELECT o.id FROM inventory_operations o
		WHERE o.source_type=$1 AND o.source_id=$2
		  AND o.reverses_operation_id IS NULL
		  AND NOT EXISTS (SELECT 1 FROM inventory_operations r WHERE r.reverses_operation_id = o.id)
		ORDER BY o.created_at, o.id`, sourceType, sourceID)
	if err != nil {
		return nil, wrapDB("list live operations", err)
	}
	defer rows.Close()
	ids := make([]uuid.UUID, 0)
	for rows.Next() {
		var id uuid.UUID
		if err := rows.Scan(&id); err != nil {
			return nil, wrapDB("list live operations", err)
		}
		ids = append(ids, id)
	}
	return ids, wrapDB("list live operations", rows.Err())
}

// Reverse negates one operation through the inventory service, which refuses
// a second reversal by unique index rather than by application code.
func (s *Service) Reverse(
	ctx context.Context, uow *app.UnitOfWork, operationID uuid.UUID, key, reason string,
) (inventory.Recorded, error) {
	return s.inventory.Reverse(ctx, uow, operationID, key, reason)
}

// The three helpers below are the same bookkeeping app/sales needs for the
// sale lifecycle. They are exported rather than duplicated so both packages
// keep one idempotency-key shape and one definition of "the operation this
// source has not had reversed yet".

// OperationBase is baseFor for callers outside this package.
func OperationBase(
	uow *app.UnitOfWork, sourceType string, sourceID uuid.UUID,
	command string, attempt int, reason string, occurredAt time.Time, details map[string]any,
) build.Base {
	return baseFor(uow, sourceType, sourceID, command, attempt, reason, occurredAt, details)
}

// AttemptFor is attemptFor for callers outside this package.
func AttemptFor(
	ctx context.Context, uow *app.UnitOfWork, sourceType string, sourceID uuid.UUID, command string,
) (int, error) {
	return attemptFor(ctx, uow, sourceType, sourceID, command)
}

// LiveOperations is liveOperations for callers outside this package.
func LiveOperations(
	ctx context.Context, uow *app.UnitOfWork, sourceType string, sourceID uuid.UUID,
) ([]uuid.UUID, error) {
	return liveOperations(ctx, uow, sourceType, sourceID)
}

// LiveOperation is liveOperation for callers outside this package.
func LiveOperation(
	ctx context.Context, uow *app.UnitOfWork, sourceType string, sourceID uuid.UUID, command string,
) (uuid.UUID, bool, error) {
	return liveOperation(ctx, uow, sourceType, sourceID, command)
}

// AllocationMethod names an allocation as recorded or inferred (review A3).
func AllocationMethod(inferred bool) string { return allocationMethod(inferred) }

// DetailNotes seeds an operation's details with the operator's note.
func DetailNotes(notes *string) map[string]any { return detailNotes(notes) }
