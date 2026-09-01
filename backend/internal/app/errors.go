package app

import (
	"errors"
	"fmt"
)

// Kind classifies a failure by what the caller should do about it. It is
// deliberately transport-free: no HTTP status, no SQLSTATE. The importer runs
// from a CLI, a test harness, and (for the GnuCash half) an HTTP handler, and
// all three need the same taxonomy. Each edge maps Kind to its own vocabulary.
type Kind string

const (
	// KindInternal is the zero value: an unclassified failure. A database
	// error, a marshalling bug, anything the operator cannot fix by editing
	// the artifact. Always retryable in principle.
	KindInternal Kind = ""

	// KindInvalid is a record the domain rejects: a missing required field, a
	// value outside its allowed set, a malformed identifier.
	KindInvalid Kind = "invalid"

	// KindNotFound is a reference that resolves to nothing — the restore
	// equivalent of a dangling foreign key.
	KindNotFound Kind = "not_found"

	// KindConflict is a preserved ID that already exists with different
	// content. The restore contract requires an explicit resolution policy
	// rather than a silent overwrite, so this is reported, never guessed at.
	KindConflict Kind = "conflict"

	// KindForbidden is an actor that may not perform this operation — for
	// example an end user trying to write preserved audit fields.
	KindForbidden Kind = "forbidden"

	// KindPrecondition is a well-formed request against state that is not
	// ready for it: restoring GnuCash identity before credentials are
	// configured, importing into a database that is not empty.
	KindPrecondition Kind = "precondition"

	// KindUnsupported is a version or shape this build cannot handle — an
	// unknown snapshot formatVersion, an entity type with no repository.
	KindUnsupported Kind = "unsupported"
)

// Error is the typed application error. Op names the operation ("restore
// customer"), Field names the offending field when there is one, and Err
// carries the cause so errors.Is/As still work through the boundary.
type Error struct {
	Kind    Kind
	Op      string
	Field   string
	Message string
	Err     error
}

func (e *Error) Error() string {
	parts := e.Message
	if parts == "" && e.Err != nil {
		parts = e.Err.Error()
	}
	switch {
	case e.Op != "" && e.Field != "":
		return fmt.Sprintf("%s: %s: %s", e.Op, e.Field, parts)
	case e.Op != "":
		return fmt.Sprintf("%s: %s", e.Op, parts)
	case e.Field != "":
		return fmt.Sprintf("%s: %s", e.Field, parts)
	default:
		return parts
	}
}

func (e *Error) Unwrap() error { return e.Err }

// Errorf builds a typed error. Use the named constructors below unless the
// kind is computed.
func Errorf(kind Kind, op, format string, args ...any) *Error {
	return &Error{Kind: kind, Op: op, Message: fmt.Sprintf(format, args...)}
}

// WithField returns a copy naming the field at fault. Repositories use it so
// a per-record error says which column failed without re-formatting the
// message.
func (e *Error) WithField(field string) *Error {
	clone := *e
	clone.Field = field
	return &clone
}

// Wrap tags an arbitrary error (usually a driver error) with a kind and an
// operation. A nil error wraps to nil so callers can return app.Wrap(...) on
// the happy path.
//
// Wrapping with KindInternal — the unclassified kind — keeps whatever
// classification the cause already carried. Adding context must never
// downgrade an operator-fixable error into "internal error", which is the
// difference between "apiary 3f2a: forage radius 10 m is outside 250..8000"
// and a support ticket.
func Wrap(kind Kind, op string, err error) error {
	if err == nil {
		return nil
	}
	if kind == KindInternal {
		if inner := KindOf(err); inner != KindInternal {
			kind = inner
		}
	}
	return &Error{Kind: kind, Op: op, Err: err}
}

func Invalid(op, format string, args ...any) *Error {
	return Errorf(KindInvalid, op, format, args...)
}

func NotFound(op, format string, args ...any) *Error {
	return Errorf(KindNotFound, op, format, args...)
}

func Conflict(op, format string, args ...any) *Error {
	return Errorf(KindConflict, op, format, args...)
}

func Forbidden(op, format string, args ...any) *Error {
	return Errorf(KindForbidden, op, format, args...)
}

func Precondition(op, format string, args ...any) *Error {
	return Errorf(KindPrecondition, op, format, args...)
}

func Unsupported(op, format string, args ...any) *Error {
	return Errorf(KindUnsupported, op, format, args...)
}

// Internal wraps a cause that the operator cannot act on. The message is kept
// separate from the cause so an edge can log the cause and show the message.
func Internal(op string, err error) error { return Wrap(KindInternal, op, err) }

// KindOf reports the kind of the first *Error in the chain. An untyped error
// — a driver failure, a context cancellation — is KindInternal, which is the
// safe default: unclassified means "not the operator's fault".
func KindOf(err error) Kind {
	var typed *Error
	if errors.As(err, &typed) {
		return typed.Kind
	}
	return KindInternal
}

// IsKind is the predicate form of KindOf.
func IsKind(err error, kind Kind) bool { return err != nil && KindOf(err) == kind }
