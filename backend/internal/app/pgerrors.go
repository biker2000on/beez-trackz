package app

import (
	"errors"

	"github.com/jackc/pgx/v5/pgconn"
)

// SQLSTATE classes the restore path can turn into something an operator can
// act on. Anything else stays KindInternal, which is the honest answer for a
// disk error or a lost connection.
const (
	sqlstateUniqueViolation     = "23505"
	sqlstateForeignKeyViolation = "23503"
	sqlstateCheckViolation      = "23514"
	sqlstateNotNullViolation    = "23502"
	sqlstateRaiseException      = "P0001" // trigger RAISE EXCEPTION
)

// classifyPg maps a driver error onto a Kind. A restore replays tens of
// thousands of rows behind guard triggers; "ERROR: duplicate key value
// violates unique constraint" with no domain context is not a usable error
// message, so the constraint name is carried into the typed error and the
// kind tells the caller whether the artifact or the database is at fault.
func classifyPg(op string, err error) error {
	if err == nil {
		return nil
	}
	var pgErr *pgconn.PgError
	if !errors.As(err, &pgErr) {
		return Internal(op, err)
	}
	detail := pgErr.Message
	if pgErr.Detail != "" {
		detail = detail + ": " + pgErr.Detail
	}
	switch pgErr.Code {
	case sqlstateUniqueViolation:
		return &Error{Kind: KindConflict, Op: op, Field: pgErr.ConstraintName,
			Message: "a row with the same unique value already exists (" + detail + ")", Err: err}
	case sqlstateForeignKeyViolation:
		return &Error{Kind: KindNotFound, Op: op, Field: pgErr.ConstraintName,
			Message: "a referenced row does not exist (" + detail + ")", Err: err}
	case sqlstateCheckViolation, sqlstateNotNullViolation:
		return &Error{Kind: KindInvalid, Op: op, Field: pgErr.ConstraintName,
			Message: "the database rejected the value (" + detail + ")", Err: err}
	case sqlstateRaiseException:
		// A guard trigger — equipment_stock_reconcile_guard,
		// honey_movement_lot_matches_run, the settlement amount checks. These
		// are ordering problems in the restore, not corrupt data, and the
		// trigger's own message says which one fired.
		return &Error{Kind: KindPrecondition, Op: op,
			Message: "a database guard refused the write (" + detail + ")", Err: err}
	default:
		return Internal(op, err)
	}
}
