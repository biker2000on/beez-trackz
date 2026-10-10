package httpapi

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/biker2000on/beez-trackz/backend/internal/ai"
	"github.com/biker2000on/beez-trackz/backend/internal/app"
	appequipment "github.com/biker2000on/beez-trackz/backend/internal/app/equipment"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"net/http"
	"strings"
	"time"
)

type transcriptionEquipmentAction struct {
	Kind             string     `json:"kind"`
	ReferenceID      uuid.UUID  `json:"referenceId"`
	Quantity         int        `json:"quantity"`
	Accepted         bool       `json:"accepted"`
	SourceLocationID *uuid.UUID `json:"sourceLocationId,omitempty"`
	Description      string     `json:"description,omitempty"`
}
type transcriptionConfirmItem struct {
	HiveID           *uuid.UUID                     `json:"hiveId"`
	MatchedHiveID    *uuid.UUID                     `json:"matchedHiveId"`
	ObservedAt       *time.Time                     `json:"observedAt,omitempty"`
	MutationID       *uuid.UUID                     `json:"mutationId,omitempty"`
	EquipmentActions []transcriptionEquipmentAction `json:"equipmentActions,omitempty"`
	ai.ParsedInspection
}
type transcriptionOutcome struct {
	Scope           string     `json:"scope,omitempty"`
	HiveID          *uuid.UUID `json:"hiveId,omitempty"`
	ApiaryID        *uuid.UUID `json:"apiaryId,omitempty"`
	ObservedAt      *time.Time `json:"observedAt,omitempty"`
	SourceVersionID *uuid.UUID `json:"sourceVersionId,omitempty"`

	ItemKey             string      `json:"itemKey"`
	Status              string      `json:"status"`
	Error               string      `json:"error,omitempty"`
	InspectionIDs       []uuid.UUID `json:"inspectionIds"`
	ApiaryInspectionIDs []uuid.UUID `json:"apiaryInspectionIds"`
	FeedingIDs          []uuid.UUID `json:"feedingIds"`
	TreatmentEventIDs   []uuid.UUID `json:"treatmentEventIds"`
	QueenEventIDs       []uuid.UUID `json:"queenEventIds"`
	MiteCountIDs        []uuid.UUID `json:"miteCountIds"`
	OperationIDs        []uuid.UUID `json:"operationIds"`
}

func (s *Server) transcriptionOutcomes(ctx context.Context, id uuid.UUID) ([]transcriptionOutcome, error) {
	rows, err := s.pool.Query(ctx, `SELECT outcome FROM transcription_confirmations WHERE media_file_id=$1 ORDER BY created_at,item_key`, id)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []transcriptionOutcome{}
	for rows.Next() {
		var raw []byte
		var value transcriptionOutcome
		if err = rows.Scan(&raw); err != nil {
			return nil, err
		}
		if err = json.Unmarshal(raw, &value); err != nil {
			return nil, err
		}
		out = append(out, value)
	}
	return out, rows.Err()
}

// Scope validation occurs for the entire request before any item can commit.
func (s *Server) handleTranscriptionConfirm(w http.ResponseWriter, r *http.Request) {
	id, err := uuidParam(r, "id")
	if err != nil {
		writeError(w, 400, "invalid recording")
		return
	}
	var req struct {
		Mode        string                     `json:"mode"`
		ManualEntry bool                       `json:"manualEntry"`
		VersionID   *uuid.UUID                 `json:"versionId"`
		Inspections []transcriptionConfirmItem `json:"inspections"`
	}
	if decodeJSON(r, &req) != nil || len(req.Inspections) == 0 {
		writeError(w, 400, "No inspections to confirm")
		return
	}
	ctx := r.Context()
	row, err := s.transcriptionLoad(ctx, id)
	if err != nil {
		writeError(w, 404, "Media file not found")
		return
	}
	if row.CaptureID != nil && req.VersionID == nil && !req.ManualEntry {
		writeError(w, 400, "versionId is required to confirm reviewed audio")
		return
	}
	mode := row.Mode
	if req.Mode != "" && req.Mode != mode {
		writeError(w, 409, "Recording mode cannot change during confirmation")
		return
	}
	if req.ManualEntry {
		if len(req.Inspections) != 1 || row.CaptureID == nil || req.Inspections[0].ItemKey != "manual-"+row.CaptureID.String() {
			writeError(w, 400, "Manual recovery requires one stable manual capture item")
			return
		}
		if row.CurrentVersionID == nil {
			notes := req.Inspections[0].Notes
			if notes == nil || strings.TrimSpace(*notes) == "" {
				writeError(w, 400, "Enter observations before recovering this capture")
				return
			}
			tx, e := s.pool.Begin(ctx)
			if e != nil {
				writeError(w, 500, "database error")
				return
			}
			defer tx.Rollback(ctx)
			var current *uuid.UUID
			if e = tx.QueryRow(ctx, `SELECT current_transcript_version_id FROM media_files WHERE id=$1 FOR UPDATE`, id).Scan(&current); e != nil {
				writeError(w, 500, "database error")
				return
			}
			if current == nil {
				var v uuid.UUID
				if e = tx.QueryRow(ctx, `INSERT INTO transcript_versions(media_file_id,provider,prompt_revision,text) VALUES($1,'manual-entry','manual-recovery-v1',$2) RETURNING id`, id, *notes).Scan(&v); e != nil {
					writeError(w, 500, "database error")
					return
				}
				current = &v
				if _, e = tx.Exec(ctx, `UPDATE media_files SET current_transcript_version_id=$2 WHERE id=$1`, id, v); e != nil {
					writeError(w, 500, "database error")
					return
				}
			}
			if e = tx.Commit(ctx); e != nil {
				writeError(w, 500, "database error")
				return
			}
			row.CurrentVersionID = current
		}
	}
	versionID, err := s.transcriptionResolveVersion(ctx, row, req.VersionID)
	if err != nil {
		writeError(w, 400, err.Error())
		return
	}
	var sourceItems []ai.MatchedInspection
	if row.CaptureID != nil && !req.ManualEntry {
		var raw []byte
		if err = s.pool.QueryRow(ctx, `SELECT parsed_inspections FROM transcript_versions WHERE id=$1 AND media_file_id=$2`, versionID, id).Scan(&raw); err != nil || len(raw) == 0 {
			writeError(w, 409, "Parse and review this transcript before confirming")
			return
		}
		if json.Unmarshal(raw, &sourceItems) != nil {
			writeError(w, 500, "invalid saved parse")
			return
		}
	}
	keys := map[string]bool{}
	for i := range req.Inspections {
		item := &req.Inspections[i]
		item.MatchedHiveID = nil
		if raw := r.Header.Get("X-Offline-Mutation-ID"); raw != "" && len(req.Inspections) == 1 {
			mutation, e := uuid.Parse(raw)
			if e != nil || mutation == uuid.Nil {
				writeError(w, 400, "Invalid mutation ID")
				return
			}
			if item.MutationID != nil && *item.MutationID != mutation {
				writeError(w, 400, "Conflicting mutation identity")
				return
			}
			item.MutationID = &mutation
		}

		if item.Scope == "" {
			item.Scope = "hive"
			if mode == "apiary" {
				item.Scope = "apiary"
			}
		}
		if item.Scope != "hive" && item.Scope != "apiary" {
			writeError(w, 400, "Invalid inspection scope")
			return
		}
		if item.Scope == "apiary" {
			if row.OwnerType != "apiary" || item.HiveID != nil || mode == "single" {
				writeError(w, 400, "Apiary observation must belong to an apiary recording")
				return
			}
		} else {
			if item.HiveID == nil && row.OwnerType == "hive" {
				item.HiveID = &row.OwnerID
			}
			if item.HiveID == nil {
				writeError(w, 400, "Hive ID is required for each hive inspection")
				return
			}
			var apiaryID uuid.UUID
			if err = s.pool.QueryRow(ctx, `SELECT apiary_id FROM hives WHERE id=$1`, *item.HiveID).Scan(&apiaryID); err != nil {
				writeError(w, 400, "Hive not found")
				return
			}
			if (row.OwnerType == "hive" && *item.HiveID != row.OwnerID) || (row.OwnerType == "apiary" && apiaryID != row.OwnerID) {
				writeError(w, 400, "Hive does not belong to the recording scope")
				return
			}
			if !s.requireHiveRole(w, r, *item.HiveID, true) {
				return
			}
		}
		if row.CaptureID != nil && !req.ManualEntry {
			found := false
			for _, source := range sourceItems {
				if source.ItemKey == item.ItemKey && source.Scope == item.Scope {
					found = true
					break
				}
			}
			if !found {
				writeError(w, 400, "Inspection key and scope must match a reviewed source item")
				return
			}
		} else if row.CaptureID == nil {
			item.ItemKey = ""
		} // legacy recordings use one stable target identity
		if item.ItemKey == "" {
			if item.Scope == "apiary" {
				item.ItemKey = "apiary"
			} else {
				item.ItemKey = "hive-" + item.HiveID.String()
			}
		}
		if len(item.ItemKey) > 128 || keys[item.ItemKey] {
			writeError(w, 400, "Item keys must be distinct and at most 128 characters")
			return
		}
		keys[item.ItemKey] = true
		if item.ObservedAt != nil && (item.ObservedAt.IsZero() || item.ObservedAt.After(time.Now().Add(5*time.Minute))) {
			writeError(w, 400, "Invalid observation time")
			return
		}
	}
	outcomes := []transcriptionOutcome{}
	success := true
	ids := []uuid.UUID{}
	apiaryIDs := []uuid.UUID{}
	feedingIDs := []uuid.UUID{}
	treatmentIDs := []uuid.UUID{}
	queenIDs := []uuid.UUID{}
	miteIDs := []uuid.UUID{}
	operationIDs := []uuid.UUID{}
	for _, item := range req.Inspections {
		var outcome transcriptionOutcome
		err = app.NewRunner(s.pool).Run(ctx, equipAppActor(r), func(ctx context.Context, tx *app.UnitOfWork) error {
			// Lock the entire replacement ancestry root-first so parent/child
			// confirmations cannot both turn one corrected account into two visits.
			var lineage []uuid.UUID
			rows, e := tx.Query(ctx, `WITH RECURSIVE chain AS (SELECT id,replaces_media_file_id,0 AS depth FROM media_files WHERE id=$1 UNION ALL SELECT m.id,m.replaces_media_file_id,c.depth+1 FROM media_files m JOIN chain c ON m.id=c.replaces_media_file_id) SELECT id FROM chain ORDER BY depth DESC`, id)
			if e != nil {
				return e
			}
			for rows.Next() {
				var ancestor uuid.UUID
				if e = rows.Scan(&ancestor); e != nil {
					rows.Close()
					return e
				}
				lineage = append(lineage, ancestor)
			}
			rows.Close()
			if e = rows.Err(); e != nil {
				return e
			}
			for _, ancestor := range lineage {
				if _, e = tx.Exec(ctx, `SELECT id FROM media_files WHERE id=$1 FOR UPDATE`, ancestor); e != nil {
					return e
				}
			}
			var current *uuid.UUID
			if err := tx.QueryRow(ctx, `SELECT current_transcript_version_id FROM media_files WHERE id=$1 FOR UPDATE`, id).Scan(&current); err != nil {
				return err
			}
			payload, _ := json.Marshal(struct {
				Version uuid.UUID
				Item    transcriptionConfirmItem
			}{versionID, item})
			hash := fmt.Sprintf("%x", sha256.Sum256(payload))
			var savedHash string
			var raw []byte
			err := tx.QueryRow(ctx, `SELECT payload_hash,outcome FROM transcription_confirmations WHERE media_file_id=$1 AND item_key=$2`, id, item.ItemKey).Scan(&savedHash, &raw)
			if err == nil {
				if savedHash != hash {
					return fmt.Errorf("This item was already saved with different values; use correction")
				}
				return json.Unmarshal(raw, &outcome)
			}
			if !errors.Is(err, pgx.ErrNoRows) {
				return err
			}
			if current == nil || *current != versionID {
				return fmt.Errorf("Transcript changed; review the current version before saving")
			}
			if req.ManualEntry {
				var otherSaved bool
				if err = tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM transcription_confirmations WHERE media_file_id=$1 AND item_key<>$2)`, id, item.ItemKey).Scan(&otherSaved); err != nil {
					return err
				}
				if otherSaved {
					return fmt.Errorf("This recording already has saved items; correct those records instead")
				}
			}
			var relatedSaved bool
			if err = tx.QueryRow(ctx, `WITH RECURSIVE ancestors AS (SELECT id,replaces_media_file_id FROM media_files WHERE id=$1 UNION ALL SELECT m.id,m.replaces_media_file_id FROM media_files m JOIN ancestors a ON m.id=a.replaces_media_file_id), descendants AS (SELECT id FROM ancestors WHERE replaces_media_file_id IS NULL UNION ALL SELECT m.id FROM media_files m JOIN descendants d ON m.replaces_media_file_id=d.id), related AS (SELECT id FROM ancestors UNION SELECT id FROM descendants) SELECT EXISTS(SELECT 1 FROM transcription_confirmations c JOIN related r ON r.id=c.media_file_id WHERE r.id<>$1) OR EXISTS(SELECT 1 FROM inspections i JOIN related r ON r.id=i.source_media_file_id WHERE r.id<>$1) OR EXISTS(SELECT 1 FROM apiary_inspections i JOIN related r ON r.id=i.source_media_file_id WHERE r.id<>$1)`, id).Scan(&relatedSaved); err != nil {
				return err
			}
			if relatedSaved {
				return fmt.Errorf("Another version of this recording already has saved observations; correct those records instead")
			}
			// Legacy confirmed recordings cannot acquire new item identities and duplicate their facts.
			var legacy bool
			if err = tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM inspections WHERE source_media_file_id=$1) AND NOT EXISTS(SELECT 1 FROM transcription_confirmations WHERE media_file_id=$1)`, id).Scan(&legacy); err != nil {
				return err
			}
			if legacy {
				return fmt.Errorf("Recording already confirmed; use correction")
			}
			outcome, err = s.transcriptionSaveItem(ctx, tx, r, row, versionID, item)
			if err != nil {
				return err
			}
			raw, err = json.Marshal(outcome)
			if err != nil {
				return err
			}
			_, err = tx.Exec(ctx, `INSERT INTO transcription_confirmations(media_file_id,item_key,source_transcript_version_id,payload_hash,outcome,actor_id,mutation_id) VALUES($1,$2,$3,$4,$5,$6,$7)`, id, item.ItemKey, versionID, hash, raw, actorID(r), item.MutationID)
			return err
		})
		if err != nil {
			success = false
			outcome = transcriptionOutcome{ItemKey: item.ItemKey, Status: "failed", Error: err.Error()}
		}
		outcomes = append(outcomes, outcome)
		ids = append(ids, outcome.InspectionIDs...)
		apiaryIDs = append(apiaryIDs, outcome.ApiaryInspectionIDs...)
		feedingIDs = append(feedingIDs, outcome.FeedingIDs...)
		treatmentIDs = append(treatmentIDs, outcome.TreatmentEventIDs...)
		queenIDs = append(queenIDs, outcome.QueenEventIDs...)
		miteIDs = append(miteIDs, outcome.MiteCountIDs...)
		operationIDs = append(operationIDs, outcome.OperationIDs...)
	}
	writeJSON(w, 200, map[string]any{"success": success, "outcomes": outcomes, "inspectionIds": ids, "apiaryInspectionIds": apiaryIDs, "feedingIds": feedingIDs, "treatmentEventIds": treatmentIDs, "queenEventIds": queenIDs, "miteCountIds": miteIDs, "operationIds": operationIDs})
}
func (s *Server) transcriptionSaveItem(ctx context.Context, tx *app.UnitOfWork, r *http.Request, row *transcriptionRow, versionID uuid.UUID, item transcriptionConfirmItem) (transcriptionOutcome, error) {
	outcome := transcriptionOutcome{ItemKey: item.ItemKey, Status: "saved", InspectionIDs: []uuid.UUID{}, ApiaryInspectionIDs: []uuid.UUID{}, FeedingIDs: []uuid.UUID{}, TreatmentEventIDs: []uuid.UUID{}, QueenEventIDs: []uuid.UUID{}, MiteCountIDs: []uuid.UUID{}, OperationIDs: []uuid.UUID{}}
	var mediaRef, versionRef *uuid.UUID
	if versionID != uuid.Nil {
		mediaRef = &row.ID
		versionRef = &versionID
	}
	now := row.ObservedAt
	if item.ObservedAt != nil {
		now = *item.ObservedAt
	}
	outcome.Scope = item.Scope
	outcome.HiveID = item.HiveID
	outcome.ObservedAt = &now
	outcome.SourceVersionID = versionRef
	if item.Scope == "apiary" {
		outcome.ApiaryID = &row.OwnerID
		if item.Notes == nil || strings.TrimSpace(*item.Notes) == "" {
			return outcome, fmt.Errorf("Apiary observation notes are required")
		}
		if len(item.EquipmentActions)+len(item.Feedings)+len(item.Treatments)+len(item.QueenEvents)+len(item.MiteCounts) > 0 {
			return outcome, fmt.Errorf("Hive actions need an explicit hive item")
		}
		var created uuid.UUID
		err := tx.QueryRow(ctx, `INSERT INTO apiary_inspections(apiary_id,observed_at,notes,created_by,source_media_file_id,source_transcript_version_id) VALUES($1,$2,$3,$4,$5,$6) RETURNING id`, row.OwnerID, now, *item.Notes, actorID(r), mediaRef, versionRef).Scan(&created)
		outcome.ApiaryInspectionIDs = append(outcome.ApiaryInspectionIDs, created)
		return outcome, err
	}
	hiveID := item.HiveID
	var apiaryID uuid.UUID
	if err := tx.QueryRow(ctx, `SELECT apiary_id FROM hives WHERE id=$1 FOR SHARE`, *hiveID).Scan(&apiaryID); err != nil {
		return outcome, fmt.Errorf("Hive not found")
	}
	outcome.ApiaryID = &apiaryID
	if row.OwnerType == "apiary" && apiaryID != row.OwnerID {
		return outcome, fmt.Errorf("Hive moved outside this recording's apiary")
	}

	pestsJSON, err := transcriptionNullableJSON(item.Pests)
	if err != nil {
		return outcome, fmt.Errorf("invalid pests")
	}
	treatmentsJSON, err := transcriptionNullableJSON(item.Treatments)
	if err != nil {
		return outcome, fmt.Errorf("invalid treatments")
	}
	sourceMedia, err := json.Marshal(struct {
		MediaFileID   uuid.UUID `json:"mediaFileId"`
		HiveReference *string   `json:"hiveReference,omitempty"`
		RawText       *string   `json:"rawText"`
	}{MediaFileID: row.ID, HiveReference: item.HiveReference, RawText: row.TranscriptionText})
	if err != nil {
		return outcome, fmt.Errorf("encoding error")
	}

	if versionID == uuid.Nil {
		sourceMedia = nil
	}
	var createdID uuid.UUID
	err = tx.QueryRow(ctx, `
			INSERT INTO inspections
				(hive_id, date, queen_seen, queen_health, brood_pattern,
				 stores_honey, stores_pollen, temperament, pests, treatments, notes, source_media,
				 source_media_file_id, source_transcript_version_id,
				 frames_of_bees, frames_of_brood, frames_of_stores)
			VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
			RETURNING id`,
		*hiveID, now, item.QueenSeen, item.QueenHealth, item.BroodPattern,
		clampRating(item.StoresHoney), clampRating(item.StoresPollen), clampRating(item.Temperament),
		pestsJSON, treatmentsJSON, item.Notes, sourceMedia, mediaRef, versionRef,
		item.FramesOfBees, item.FramesOfBrood, item.FramesOfStores).Scan(&createdID)
	if err != nil {
		return outcome, fmt.Errorf("database error")
	}
	outcome.InspectionIDs = append(outcome.InspectionIDs, createdID)

	for _, feeding := range item.Feedings {
		// The shared insert path applies the feeder-lifecycle rule: a
		// feeding with no feeder is recorded closed, not left open.
		eventID, err := feedingInsert(ctx, tx, feedingFields{
			HiveID:                    *hiveID,
			DateFed:                   now,
			Type:                      feeding.Type,
			Quantity:                  feeding.Quantity,
			QuantityUnit:              feeding.QuantityUnit,
			FeederType:                feedingFeederPtr(feeding.FeederType),
			Notes:                     feeding.Notes,
			SourceMediaFileID:         mediaRef,
			SourceTranscriptVersionID: versionRef,
		}, actorID(r))
		if err != nil {
			return outcome, fmt.Errorf("invalid feeding extracted from transcript")
		}
		outcome.FeedingIDs = append(outcome.FeedingIDs, eventID)
	}
	for _, treatment := range item.Treatments {
		days, resolveErr := s.resolveWithdrawalDays(ctx, treatment.Product)
		if resolveErr != nil {
			return outcome, fmt.Errorf("database error")
		}
		var eventID uuid.UUID
		err = tx.QueryRow(ctx, `
				INSERT INTO treatment_events
					(hive_id, inspection_id, date_applied, product, method, withdrawal_days,
					 source_media_file_id, source_transcript_version_id)
				VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
			*hiveID, createdID, now, treatment.Product, treatment.Method, days,
			mediaRef, versionRef).Scan(&eventID)
		if err != nil {
			return outcome, fmt.Errorf("invalid treatment extracted from transcript")
		}
		outcome.TreatmentEventIDs = append(outcome.TreatmentEventIDs, eventID)
	}
	for _, event := range item.QueenEvents {
		var eventID uuid.UUID
		err = tx.QueryRow(ctx, `
				INSERT INTO queen_events (hive_id, event_date, event_type, notes)
				VALUES ($1,$2,$3,$4) RETURNING id`,
			*hiveID, now, event.EventType, event.Notes).Scan(&eventID)
		if err != nil {
			return outcome, fmt.Errorf("invalid queen event extracted from transcript")
		}
		outcome.QueenEventIDs = append(outcome.QueenEventIDs, eventID)
	}
	for _, miteCount := range item.MiteCounts {
		var eventID uuid.UUID
		err = tx.QueryRow(ctx, `
				INSERT INTO mite_counts
					(hive_id, inspection_id, date, method, mites_count, sample_size, notes,
					 source_media_file_id, source_transcript_version_id)
				VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
			*hiveID, createdID, now, miteCount.Method, miteCount.MitesCount,
			miteCount.SampleSize, miteCount.Notes, mediaRef, versionRef).Scan(&eventID)
		if err != nil {
			return outcome, fmt.Errorf("invalid mite count extracted from transcript")
		}
		outcome.MiteCountIDs = append(outcome.MiteCountIDs, eventID)
	}
	for i, action := range item.EquipmentActions {
		if !action.Accepted {
			continue
		}
		if action.Quantity <= 0 || action.ReferenceID == uuid.Nil {
			return outcome, fmt.Errorf("Choose equipment and a positive quantity")
		}
		cmd := appequipment.Command{Reference: action.ReferenceID, Quantity: action.Quantity, OccurredAt: now, IdempotencyKey: fmt.Sprintf("visit:%s:%s:%s:%d", actorID(r), row.ID, item.ItemKey, i), Provenance: "recorded", Notes: "Reviewed inspection capture " + row.ID.String()}
		service := appequipment.NewService()
		switch action.Kind {
		case "deploy":
			if action.SourceLocationID != nil && *action.SourceLocationID != appequipment.HomeLocation {
				return outcome, fmt.Errorf("Equipment installation uses home storage; transfer other stock home first")
			}
			recorded, err := service.Deploy(ctx, tx, appequipment.DeployCommand{Command: cmd, HiveID: *hiveID})
			if err != nil {
				return outcome, err
			}
			outcome.OperationIDs = append(outcome.OperationIDs, recorded.Operation.ID)
		case "return":
			var belongs bool
			if err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM inventory_movements WHERE operation_id=$1 AND container_hive_id=$2 AND quantity>0)`, action.ReferenceID, *hiveID).Scan(&belongs); err != nil {
				return outcome, err
			}
			if !belongs {
				return outcome, fmt.Errorf("Deployment does not belong to this hive")
			}
			recorded, err := service.Return(ctx, tx, action.ReferenceID, action.Quantity, cmd)
			if err != nil {
				return outcome, err
			}
			outcome.OperationIDs = append(outcome.OperationIDs, recorded.Operation.ID)
		default:
			return outcome, fmt.Errorf("Unknown equipment action")
		}
	}
	return outcome, nil
}
