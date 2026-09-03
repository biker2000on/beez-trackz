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
	// isAdmin is the END-USER admin flag, carried so a command can answer
	// "may this actor do this?" itself. It is deliberately unrelated to
	// MayWritePreservedAudit: admin is an authorization level that still
	// may not forge audit history.
	isAdmin bool
	// memberships is apiary id -> "viewer" | "editor", loaded once per
	// request at the edge. A command never queries it: authorization inputs
	// travel with the actor, decisions are made from them.
	memberships map[uuid.UUID]string
}

// Apiary membership roles, as stored in apiary_memberships.role.
const (
	RoleViewer = "viewer"
	RoleEditor = "editor"
)

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

// WithAccess returns a copy of a user actor carrying its authorization
// inputs (design section 5.3). It is a no-op for every other kind: a
// background job and the restore actor never acquire end-user admin, and the
// restore privilege is never reachable from a membership.
//
// The map is copied, so a caller that keeps a per-request cache cannot have
// an actor mutated out from under it.
func (a Actor) WithAccess(isAdmin bool, memberships map[uuid.UUID]string) Actor {
	if a.kind != ActorUser {
		return a
	}
	out := a
	out.isAdmin = isAdmin
	if len(memberships) > 0 {
		out.memberships = make(map[uuid.UUID]string, len(memberships))
		for apiaryID, role := range memberships {
			out.memberships[apiaryID] = role
		}
	} else {
		out.memberships = nil
	}
	return out
}

// MayAdminister is the end-user admin level the chi requireAdmin middleware
// checks. It is NOT MayWritePreservedAudit and never implies it.
func (a Actor) MayAdminister() bool { return a.kind == ActorUser && a.isAdmin }

// ApiaryRole is this actor's role on one apiary, or "" for none. An admin
// reads as editor everywhere, matching Server.apiaryRole.
func (a Actor) ApiaryRole(apiaryID uuid.UUID) string {
	if a.MayAdminister() {
		return RoleEditor
	}
	return a.memberships[apiaryID]
}

// MayViewApiary reports read access to one apiary.
func (a Actor) MayViewApiary(apiaryID uuid.UUID) bool {
	return a.ApiaryRole(apiaryID) != ""
}

// MayEditApiary reports write access to one apiary.
func (a Actor) MayEditApiary(apiaryID uuid.UUID) bool {
	return a.ApiaryRole(apiaryID) == RoleEditor
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
