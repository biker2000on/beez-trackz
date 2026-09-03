package app

import (
	"context"
	"encoding/json"
	"errors"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// Identity is the transport-supplied identity of one offline command.
// MutationID is scoped to UserID; RequestHash binds it to one request payload.
type Identity struct {
	UserID         uuid.UUID
	MutationID     uuid.UUID
	RequestHash    string
	ResponseStatus int
}

// Result is the durable JSON result of an idempotent command. Body is the
// exact byte sequence persisted in the receipt and is therefore also the byte
// sequence transports must return. Replayed reports that fn was not invoked.
type Result struct {
	Status   int
	Body     json.RawMessage
	Replayed bool
}

// RunIdempotent executes fn and writes its receipt in the same transaction.
// A receipt therefore exists if and only if the command committed. The
// transaction-scoped advisory lock serializes concurrent first attempts before
// either can perform domain writes.
func (r *Runner) RunIdempotent(
	ctx context.Context,
	actor Actor,
	id Identity,
	fn func(context.Context, *UnitOfWork) (any, error),
) (Result, error) {
	const op = "run idempotent command"
	var zero Result
	if !actor.Valid() {
		return zero, Forbidden(op, "no actor was supplied")
	}
	if r == nil || r.pool == nil {
		return zero, Internal(op, errors.New("no database pool"))
	}
	if id.UserID == uuid.Nil || id.MutationID == uuid.Nil || strings.TrimSpace(id.RequestHash) == "" {
		return zero, Invalid(op, "user, mutation id, and request hash are required")
	}

	tx, err := r.pool.Begin(ctx)
	if err != nil {
		return zero, Internal("begin transaction", err)
	}
	defer rollback(ctx, tx)

	// The lock key includes the user because mutation ids are user-scoped in
	// the receipt primary key. hashtextextended yields the bigint advisory-lock
	// key without relying on process-local hashing.
	if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`,
		id.UserID.String()+":"+id.MutationID.String()); err != nil {
		return zero, Internal(op, err)
	}

	stored, found, err := loadReceipt(ctx, tx, id)
	if err != nil {
		return zero, err
	}
	if found {
		if err := tx.Commit(ctx); err != nil {
			return zero, Internal("commit replay transaction", err)
		}
		stored.Replayed = true
		return stored, nil
	}

	uow := &UnitOfWork{tx: tx, actor: actor}
	value, err := callResultFn(ctx, tx, uow, fn)
	if err != nil {
		return zero, err
	}
	body, err := json.Marshal(value)
	if err != nil {
		return zero, Internal("marshal command result", err)
	}
	status := id.ResponseStatus
	if status == 0 {
		status = 200
	}
	var storedBody []byte
	if err := tx.QueryRow(ctx, `
		INSERT INTO offline_mutation_receipts
			(user_id, mutation_id, request_hash, state, response_status, response_body)
		VALUES ($1, $2, $3, 'complete', $4, $5::jsonb)
		RETURNING response_body`,
		id.UserID, id.MutationID, id.RequestHash, status, body).Scan(&storedBody); err != nil {
		return zero, Internal("write command receipt", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return zero, Internal("commit transaction", err)
	}
	return Result{Status: status, Body: storedBody}, nil
}

func loadReceipt(ctx context.Context, tx pgx.Tx, id Identity) (Result, bool, error) {
	var state string
	var status *int
	var body []byte
	var storedHash *string
	err := tx.QueryRow(ctx, `
		SELECT state, response_status, response_body, request_hash
		FROM offline_mutation_receipts
		WHERE user_id=$1 AND mutation_id=$2`, id.UserID, id.MutationID).
		Scan(&state, &status, &body, &storedHash)
	if errors.Is(err, pgx.ErrNoRows) {
		return Result{}, false, nil
	}
	if err != nil {
		return Result{}, false, Internal("read command receipt", err)
	}
	// A pre-hash receipt cannot prove it belongs to this payload. Fail closed;
	// silently replaying it is the secondary defect called out by the design.
	if storedHash == nil || *storedHash != id.RequestHash {
		return Result{}, false, Conflict("run idempotent command",
			"offline mutation id was reused for a different request")
	}
	if state != "complete" || status == nil {
		return Result{}, false, Conflict("run idempotent command",
			"offline mutation has no committed result")
	}
	if len(body) == 0 {
		body = []byte("null")
	}
	return Result{Status: *status, Body: json.RawMessage(body)}, true, nil
}

func callResultFn(
	ctx context.Context,
	tx pgx.Tx,
	uow *UnitOfWork,
	fn func(context.Context, *UnitOfWork) (any, error),
) (value any, err error) {
	defer func() {
		if recovered := recover(); recovered != nil {
			rollback(ctx, tx)
			panic(recovered)
		}
	}()
	return fn(ctx, uow)
}
