package app

import (
	"github.com/google/uuid"
)

// ActorKind separates who is asking from what they are allowed to do.
type ActorKind string

const (
	// ActorUser is a signed-in human acting through the ordinary API. Their
	// authorization (admin, apiary membership) is decided at the edge; this
	// package only records that the actor is a user and which one.
	ActorUser ActorKind = "user"

	// ActorSystemRestore is the privileged importer identity. It exists only
	// inside a restore run and is deliberately NOT an admin user: admin is
	// an end-user authorization level that still may not forge audit
	// history, while the restore actor may write preserved IDs, created_at,
	// created_by, deleted_at, and voided_at — and nothing else. No HTTP
	// session ever produces this actor.
	ActorSystemRestore ActorKind = "system_restore"

	// ActorSystemJob is a background worker (asynq, cron). Listed so the
	// restore privilege cannot be obtained by "some system thing did it";
	// jobs get no audit-forging rights.
	ActorSystemJob ActorKind = "system_job"
)

// Actor is the identity a unit of work runs under. The zero Actor is invalid
// on purpose — every command has to say who it is.
type Actor struct {
	kind ActorKind
	// userID is the app_users row to attribute writes to. It is set for
	// ActorUser, and may be set for ActorSystemRestore when the operator who
	// launched the restore should own rows whose preserved created_by is
	// absent from the artifact.
	userID uuid.UUID
	// label is what a report or a log line shows.
	label string
}

// UserActor is an ordinary signed-in principal.
func UserActor(userID uuid.UUID, label string) Actor {
	if label == "" {
		label = "user " + userID.String()
	}
	return Actor{kind: ActorUser, userID: userID, label: label}
}

// SystemRestoreActor is the importer identity. fallbackUserID is attributed
// to restored rows whose preserved created_by is missing from the artifact;
// pass uuid.Nil when the artifact is complete and a missing created_by should
// stay NULL.
func SystemRestoreActor(fallbackUserID uuid.UUID) Actor {
	return Actor{kind: ActorSystemRestore, userID: fallbackUserID, label: "system:restore"}
}

// SystemJobActor is a background worker.
func SystemJobActor(name string) Actor {
	return Actor{kind: ActorSystemJob, label: "system:job:" + name}
}

func (a Actor) Kind() ActorKind { return a.kind }
func (a Actor) String() string {
	if a.label == "" {
		return "actor(unset)"
	}
	return a.label
}

// Valid reports whether the actor was built by one of the constructors.
func (a Actor) Valid() bool {
	switch a.kind {
	case ActorUser:
		return a.userID != uuid.Nil
	case ActorSystemRestore, ActorSystemJob:
		return true
	default:
		return false
	}
}

// MayWritePreservedAudit is the single privilege this slice defines: the
// right to supply id, created_at, created_by, deleted_at, and voided_at
// instead of letting the database generate them. Only the restore actor has
// it. Repositories must check it before writing an audit field, so a future
// user-facing command cannot reach a restore repository and forge history.
func (a Actor) MayWritePreservedAudit() bool { return a.kind == ActorSystemRestore }

// AuditUserID is the app_users id to record as created_by when the record
// being restored does not carry one. uuid.Nil means "leave it NULL".
func (a Actor) AuditUserID() uuid.UUID { return a.userID }

// requirePreservedAudit is the guard every restore repository calls first.
func (a Actor) requirePreservedAudit(op string) error {
	if !a.Valid() {
		return Forbidden(op, "no actor was supplied")
	}
	if !a.MayWritePreservedAudit() {
		return Forbidden(op,
			"%s may not write preserved audit fields; only the system restore actor may", a)
	}
	return nil
}
