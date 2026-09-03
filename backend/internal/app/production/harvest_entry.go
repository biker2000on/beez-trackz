package production

import (
	"context"
	"time"

	"github.com/biker2000on/beez-trackz/backend/internal/app"
	"github.com/google/uuid"
)

// HarvestEntryInput is one validated hive measurement in a session command.
type HarvestEntryInput struct {
	HiveID            uuid.UUID
	SuperWeightBefore float64
	SuperWeightAfter  float64
	HoneyWeight       float64
	DirectWeight      bool
	Notes             *string
}

type AddHarvestEntryInput struct {
	SessionID   uuid.UUID
	SessionDate time.Time
	Entries     []HarvestEntryInput
	Batch       bool
}

type HarvestEntryResult struct {
	ID                    uuid.UUID `json:"id"`
	SessionID             uuid.UUID `json:"sessionId"`
	HiveID                uuid.UUID `json:"hiveId"`
	Date                  time.Time `json:"date"`
	SuperWeightBefore     float64   `json:"superWeightBefore"`
	SuperWeightAfter      float64   `json:"superWeightAfter"`
	CalculatedHoneyWeight float64   `json:"calculatedHoneyWeight"`
	DirectWeight          bool      `json:"directWeight"`
	Notes                 *string   `json:"notes"`
}

type AddHarvestEntryResult struct {
	Entries []HarvestEntryResult `json:"entries"`
	Count   int                  `json:"count"`
}

// AddHarvestEntry writes a single entry or a whole yard walkthrough as one
// command. The caller performs transport parsing; all writes and the outbox
// fact share the supplied unit of work.
func AddHarvestEntry(ctx context.Context, uow *app.UnitOfWork, input AddHarvestEntryInput) (any, error) {
	const op = "add harvest entry"
	if input.SessionID == uuid.Nil || input.SessionDate.IsZero() || len(input.Entries) == 0 {
		return nil, app.Invalid(op, "session, date, and at least one entry are required")
	}
	actorID := uow.Actor().AuditUserID()
	var actor any
	if actorID != uuid.Nil {
		actor = actorID
	}
	created := make([]HarvestEntryResult, 0, len(input.Entries))
	for _, entry := range input.Entries {
		if entry.HiveID == uuid.Nil {
			return nil, app.Invalid(op, "hive is required")
		}
		var id uuid.UUID
		err := uow.QueryRow(ctx, `
			INSERT INTO honey_harvests
				(session_id, hive_id, date, super_weight_before, super_weight_after,
				 calculated_honey_weight, direct_weight, notes, created_by)
			VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
			RETURNING id`, input.SessionID, entry.HiveID, input.SessionDate,
			entry.SuperWeightBefore, entry.SuperWeightAfter, entry.HoneyWeight,
			entry.DirectWeight, entry.Notes, actor).Scan(&id)
		if err != nil {
			return nil, app.Wrap(app.KindInternal, op, err)
		}
		created = append(created, HarvestEntryResult{
			ID: id, SessionID: input.SessionID, HiveID: entry.HiveID, Date: input.SessionDate,
			SuperWeightBefore: entry.SuperWeightBefore, SuperWeightAfter: entry.SuperWeightAfter,
			CalculatedHoneyWeight: entry.HoneyWeight, DirectWeight: entry.DirectWeight,
			Notes: entry.Notes,
		})
	}
	if err := uow.Emit(ctx, app.Event{
		AggregateType: "harvest_session", AggregateID: input.SessionID,
		Type: "harvest.entries_added", Payload: map[string]any{"count": len(created)},
	}); err != nil {
		return nil, err
	}
	if !input.Batch {
		return created[0], nil
	}
	return AddHarvestEntryResult{Entries: created, Count: len(created)}, nil
}
