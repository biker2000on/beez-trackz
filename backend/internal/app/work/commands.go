package work

import (
	"github.com/google/uuid"

	"github.com/biker2000on/beez-trackz/backend/internal/app"
)

// OfflinePredicate answers whether the PWA may queue a mutation while
// offline. In production it is httpapi's offlineRoutes.supports — the same
// manifest the service worker is generated from — injected rather than
// imported so this package does not depend on the transport. When it is nil
// every command is reported online_only, which is the safe direction: the
// projection may under-promise offline support, never over-promise it.
type OfflinePredicate func(method, path string) bool

// access is what a command needs from the actor. It records the requirement
// the transport already enforces (requireAdmin, requireEntityParamRole) so
// the answer can be given before the button is pressed rather than after.
type access int

const (
	// accessApiaryEdit is editor on the item's apiary. An item with no
	// apiary (a hive-less recommendation) falls back to accessAdmin.
	accessApiaryEdit access = iota
	// accessAdmin is end-user admin.
	accessAdmin
)

// commandSpec is a command before it has been asked about an actor or the
// offline manifest.
type commandSpec struct {
	id     string
	label  string
	method string
	path   string
	body   map[string]any
	needs  access
	key    string
}

// build resolves one spec against this actor and this offline manifest.
func (spec commandSpec) build(itemID string, actor app.Actor, ctx Context, offline OfflinePredicate) Command {
	permitted, denied := permits(actor, spec.needs, ctx)
	disposition, reason := offlineDisposition(spec.method, spec.path, offline)
	body := spec.body
	if body == nil {
		body = map[string]any{}
	}
	return Command{
		ID:                     spec.id,
		Label:                  spec.label,
		Method:                 spec.method,
		Path:                   spec.path,
		BodyTemplate:           body,
		Permitted:              permitted,
		DeniedReason:           denied,
		Offline:                disposition,
		OfflineReason:          reason,
		IdempotencyKeyTemplate: itemID + ":" + spec.id + ":{clientMutationId}",
		Keyboard:               spec.key,
	}
}

// permits is §4.4's per-command answer. It never guesses: it asks the actor
// for the same facts the middleware asks the database for, which the edge
// loaded once per request (§5.3).
func permits(actor app.Actor, needs access, ctx Context) (bool, *string) {
	if needs == accessAdmin || ctx.ApiaryID == nil {
		// A recommendation with no hive has no apiary to be a member of,
		// so only an admin can act on it.
		if actor.MayAdminister() {
			return true, nil
		}
		return false, reason("administrator access is required")
	}
	if actor.MayEditApiary(*ctx.ApiaryID) {
		return true, nil
	}
	where := "this yard"
	if ctx.ApiaryName != nil && *ctx.ApiaryName != "" {
		where = *ctx.ApiaryName
	}
	if actor.MayViewApiary(*ctx.ApiaryID) {
		return false, reason("editor access on " + where + " is required")
	}
	return false, reason("you do not have access to " + where)
}

// offlineDisposition asks the manifest, never this package's opinion. The
// reason string is what makes an online-only command visible in the UI
// before the operator is standing in a yard with no signal, instead of
// failing silently in a replay queue.
func offlineDisposition(method, path string, offline OfflinePredicate) (string, *string) {
	if offline != nil && offline(method, path) {
		return OfflineQueueable, nil
	}
	return OfflineOnlyOnline, reason(
		method + " " + path + " is not in the offline queue manifest; it needs a connection")
}

func reason(text string) *string { return &text }

// --- the field slice's command catalog -----------------------------------

// recommendationCommands are the triage actions on an open or snoozed
// recommendation. The keyboard letters are the action center's existing ones
// (dashboard-view.tsx:139-198), now carried by the command rather than
// hardcoded against two item kinds.
func recommendationCommands(id uuid.UUID, status string) []commandSpec {
	base := "/api/v1/recommendations/" + id.String()
	if status == StatusDismissed {
		return []commandSpec{{
			id: "recommendation.restore", label: "Restore",
			method: "POST", path: base + "/restore",
			needs: accessApiaryEdit, key: "u",
		}}
	}
	return []commandSpec{
		{
			id: "recommendation.dismiss", label: "Dismiss",
			method: "POST", path: base + "/dismiss",
			needs: accessApiaryEdit, key: "d",
		},
		{
			id: "recommendation.snooze", label: "Snooze",
			method: "POST", path: base + "/snooze",
			needs: accessApiaryEdit, key: "s",
		},
	}
}

// feedingCommands act on the feeding row the status evaluation nominated,
// not on the hive.
func feedingCommands(feedingID uuid.UUID) []commandSpec {
	base := "/api/v1/feedings/" + feedingID.String()
	return []commandSpec{
		{
			id: "feeding.refill", label: "Refill",
			method: "POST", path: base + "/refill",
			needs: accessApiaryEdit, key: "r",
		},
		{
			id: "feeding.close", label: "Verify and close",
			method: "POST", path: base + "/close",
			needs: accessApiaryEdit, key: "c",
		},
		{
			id: "feeding.empty", label: "Mark empty",
			method: "POST", path: base + "/empty",
			needs: accessApiaryEdit, key: "e",
		},
	}
}

// lockoutCommands end the treatment that causes the window. Ending it is the
// only field action; the window itself is derived and cannot be edited.
func lockoutCommands(treatmentEventID uuid.UUID) []commandSpec {
	return []commandSpec{{
		id: "lockout.end_treatment", label: "Record treatment removed",
		method: "PATCH", path: "/api/v1/treatment-events/" + treatmentEventID.String(),
		body:  map[string]any{"dateRemoved": nil},
		needs: accessApiaryEdit, key: "t",
	}}
}

// harvestReadyCommands are the two ways to act on full stores: log the pull
// against the hive, or open an extraction day for the whole yard. The second
// is deliberately online-only — POST /harvest-sessions is an offline-route
// POST exclusion because it creates server-side state a replay cannot
// safely repeat — and saying so is the point of offlineReason.
func harvestReadyCommands(hiveID, apiaryID uuid.UUID) []commandSpec {
	return []commandSpec{
		{
			id: "harvest.record", label: "Record harvest",
			method: "POST", path: "/api/v1/harvests",
			body:  map[string]any{"hiveId": hiveID.String()},
			needs: accessAdmin, key: "h",
		},
		{
			id: "harvest.start_session", label: "Start extraction day",
			method: "POST", path: "/api/v1/harvest-sessions",
			body:  map[string]any{"apiaryId": apiaryID.String()},
			needs: accessApiaryEdit, key: "x",
		},
	}
}
