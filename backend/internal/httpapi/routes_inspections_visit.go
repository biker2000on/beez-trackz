package httpapi

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"github.com/biker2000on/beez-trackz/backend/internal/app"
	"github.com/google/uuid"
	"net/http"
	"time"
)

// Manual and dictated visits use the same transaction-bound observation and
// equipment commands. A manual visit has no fabricated media or transcript.
func (s *Server) handleInspectionVisitCreate(w http.ResponseWriter, r *http.Request) {
	var req struct {
		CaptureID  uuid.UUID                `json:"captureId"`
		Scope      string                   `json:"scope"`
		HiveID     *uuid.UUID               `json:"hiveId"`
		ApiaryID   *uuid.UUID               `json:"apiaryId"`
		ObservedAt time.Time                `json:"observedAt"`
		TimeZone   string                   `json:"timeZone"`
		Inspection transcriptionConfirmItem `json:"inspection"`
	}
	if decodeJSON(r, &req) != nil || req.CaptureID == uuid.Nil || req.ObservedAt.IsZero() || req.ObservedAt.After(time.Now().Add(5*time.Minute)) {
		writeError(w, 400, "Capture identity and observation time are required")
		return
	}
	var owner uuid.UUID
	switch req.Scope {
	case "hive":
		if req.HiveID == nil {
			writeError(w, 400, "Hive is required")
			return
		}
		owner = *req.HiveID
	case "apiary":
		if req.ApiaryID == nil || req.HiveID != nil {
			writeError(w, 400, "Apiary is required without a hive")
			return
		}
		owner = *req.ApiaryID
	default:
		writeError(w, 400, "Scope must be hive or apiary")
		return
	}
	if !s.requireOwnerRole(w, r, req.Scope, owner, true) {
		return
	}
	actor := actorID(r)
	if actor == nil {
		writeError(w, 401, "Sign in to save a visit")
		return
	}
	req.Inspection.Scope = req.Scope
	req.Inspection.HiveID = req.HiveID
	req.Inspection.ObservedAt = &req.ObservedAt
	req.Inspection.ItemKey = req.CaptureID.String()
	row := &transcriptionRow{ID: req.CaptureID, OwnerType: req.Scope, OwnerID: owner, ObservedAt: req.ObservedAt}
	payload, _ := json.Marshal(req)
	identity := app.Identity{UserID: *actor, MutationID: req.CaptureID, RequestHash: fmt.Sprintf("manual-visit:%x", sha256.Sum256(payload)), ResponseStatus: 201}
	if offline, ok := offlineCommandIdentity(r); ok {
		if offline.MutationID != req.CaptureID {
			writeError(w, 400, "Mutation ID must equal captureId")
			return
		}
		// Keep the same canonical body identity whether this is an online request or an offline replay.
	}
	result, err := app.NewRunner(s.pool).RunIdempotent(r.Context(), appActor(r), identity, func(ctx context.Context, tx *app.UnitOfWork) (any, error) {
		outcome, err := s.transcriptionSaveItem(ctx, tx, r, row, uuid.Nil, req.Inspection)
		if err != nil {
			return nil, err
		}
		return map[string]any{"success": true, "outcomes": []transcriptionOutcome{outcome}, "inspectionIds": outcome.InspectionIDs, "apiaryInspectionIds": outcome.ApiaryInspectionIDs, "feedingIds": outcome.FeedingIDs, "treatmentEventIds": outcome.TreatmentEventIDs, "queenEventIds": outcome.QueenEventIDs, "miteCountIds": outcome.MiteCountIDs, "operationIds": outcome.OperationIDs}, nil
	})
	if err != nil {
		if app.IsKind(err, app.KindConflict) {
			writeError(w, http.StatusConflict, err.Error())
			return
		}
		writeError(w, 400, err.Error())
		return
	}
	writeApplicationResult(w, result)
}
