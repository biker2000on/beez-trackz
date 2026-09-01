package app

import (
	"context"
	"errors"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Querier is the subset of pgx every repository in this package is allowed to
// use. Taking the interface rather than *pgxpool.Pool is what makes a
// repository transaction-bound: it cannot reach around its unit of work and
// write on a pooled connection that will not roll back with it.
type Querier interface {
	Exec(ctx context.Context, sql string, args ...any) (pgconn.CommandTag, error)
	Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error)
	QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
}

// UnitOfWork is one transaction plus the actor it runs under. It is created
// by Runner and is never valid outside the function it was handed to.
type UnitOfWork struct {
	tx     pgx.Tx
	actor  Actor
	dryRun bool
}

// Actor is who this unit of work is acting as.
func (u *UnitOfWork) Actor() Actor { return u.actor }

// DryRun reports whether this unit of work will be rolled back no matter what
// happens. Repositories still perform every read and every validation in a
// dry run — that is the point of it — but must skip side effects that escape
// the transaction (object storage, outbound HTTP, notifications), because a
// rollback cannot take those back.
func (u *UnitOfWork) DryRun() bool { return u.dryRun }

func (u *UnitOfWork) Exec(ctx context.Context, sql string, args ...any) (pgconn.CommandTag, error) {
	return u.tx.Exec(ctx, sql, args...)
}

func (u *UnitOfWork) Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error) {
	return u.tx.Query(ctx, sql, args...)
}

func (u *UnitOfWork) QueryRow(ctx context.Context, sql string, args ...any) pgx.Row {
	return u.tx.QueryRow(ctx, sql, args...)
}

// Savepoint runs fn inside a nested transaction. A failure rolls back only
// fn's writes, which is how a per-record restore failure is isolated from the
// records that already succeeded in the same run.
func (u *UnitOfWork) Savepoint(ctx context.Context, fn func(context.Context, *UnitOfWork) error) error {
	nested, err := u.tx.Begin(ctx)
	if err != nil {
		return Internal("savepoint", err)
	}
	inner := &UnitOfWork{tx: nested, actor: u.actor, dryRun: u.dryRun}
	return runIn(ctx, nested, inner, fn)
}

// Runner opens units of work against a pool.
type Runner struct {
	pool *pgxpool.Pool
}

func NewRunner(pool *pgxpool.Pool) *Runner { return &Runner{pool: pool} }

// Pool exposes the underlying pool for the read paths that do not need a
// transaction. Writes go through Run.
func (r *Runner) Pool() *pgxpool.Pool { return r.pool }

// Run executes fn inside one transaction as actor. fn's error is returned
// unchanged — its Kind survives — and the transaction is rolled back. A panic
// rolls back and re-panics rather than leaving the connection in a
// transaction.
func (r *Runner) Run(ctx context.Context, actor Actor, fn func(context.Context, *UnitOfWork) error) error {
	return r.run(ctx, actor, false, fn)
}

// DryRun executes fn inside a transaction that is ALWAYS rolled back, even
// when fn succeeds. This is the importer's no-write validation pass: every
// constraint, trigger, and reference check runs for real, and nothing
// survives. Repositories additionally see UnitOfWork.DryRun.
func (r *Runner) DryRun(ctx context.Context, actor Actor, fn func(context.Context, *UnitOfWork) error) error {
	return r.run(ctx, actor, true, fn)
}

func (r *Runner) run(
	ctx context.Context, actor Actor, dryRun bool,
	fn func(context.Context, *UnitOfWork) error,
) error {
	if !actor.Valid() {
		return Forbidden("unit of work", "no actor was supplied")
	}
	if r == nil || r.pool == nil {
		return Internal("unit of work", errors.New("no database pool"))
	}
	tx, err := r.pool.Begin(ctx)
	if err != nil {
		return Internal("begin transaction", err)
	}
	uow := &UnitOfWork{tx: tx, actor: actor, dryRun: dryRun}
	if dryRun {
		defer rollback(ctx, tx)
		return callFn(ctx, tx, uow, fn)
	}
	return runIn(ctx, tx, uow, fn)
}

// runIn is the commit-or-rollback boundary shared by Run and Savepoint.
func runIn(
	ctx context.Context, tx pgx.Tx, uow *UnitOfWork,
	fn func(context.Context, *UnitOfWork) error,
) error {
	if err := callFn(ctx, tx, uow, fn); err != nil {
		rollback(ctx, tx)
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		rollback(ctx, tx)
		return Internal("commit transaction", err)
	}
	return nil
}

// callFn isolates the panic path: a repository that panics must not leave an
// open transaction behind, and the panic itself must keep travelling.
func callFn(
	ctx context.Context, tx pgx.Tx, uow *UnitOfWork,
	fn func(context.Context, *UnitOfWork) error,
) (err error) {
	defer func() {
		if recovered := recover(); recovered != nil {
			rollback(ctx, tx)
			panic(recovered)
		}
	}()
	return fn(ctx, uow)
}

// rollback never inherits a cancelled context: a client that hung up mid
// restore must still release the transaction. Its own error is dropped —
// there is nothing left to do about it, and the caller's error is the one
// worth reporting.
func rollback(ctx context.Context, tx pgx.Tx) {
	_ = tx.Rollback(context.WithoutCancel(ctx))
}
