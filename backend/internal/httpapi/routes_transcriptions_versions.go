package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/google/uuid"

	"github.com/hibiken/asynq"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/biker2000on/beez-trackz/backend/internal/ai"
	"github.com/biker2000on/beez-trackz/backend/internal/jobs"
)

type transcriptionSourceCounts struct {
	Inspections int
	Feedings    int
	Treatments  int
	MiteCounts  int
}

func (c transcriptionSourceCounts) total() int {
	return c.Inspections + c.Feedings + c.Treatments + c.MiteCounts
}

type transcriptionQuerier interface {
	QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
}

func (s *Server) transcriptionSourceCounts(ctx context.Context, mediaID uuid.UUID) (transcriptionSourceCounts, error) {
	return transcriptionSourceCountsOn(ctx, s.pool, mediaID)
}

func transcriptionSourceCountsOn(ctx context.Context, q transcriptionQuerier, mediaID uuid.UUID) (transcriptionSourceCounts, error) {
	var c transcriptionSourceCounts
	err := q.QueryRow(ctx, `
		SELECT
			(SELECT count(*) FROM inspections
			  WHERE source_media_file_id = $1
			     OR (source_media->>'mediaFileId') = $1::text),
			(SELECT count(*) FROM feedings WHERE source_media_file_id = $1),
			(SELECT count(*) FROM treatment_events WHERE source_media_file_id = $1),
			(SELECT count(*) FROM mite_counts WHERE source_media_file_id = $1)`,
		mediaID).Scan(&c.Inspections, &c.Feedings, &c.Treatments, &c.MiteCounts)
	return c, err
}

func (s *Server) transcriptionVersionText(ctx context.Context, mediaID, versionID uuid.UUID) (string, error) {
	var text string
	err := s.pool.QueryRow(ctx, `
		SELECT text FROM transcript_versions WHERE id = $1 AND media_file_id = $2`,
		versionID, mediaID).Scan(&text)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", fmt.Errorf("transcript version not found")
	}
	return text, err
}

func (s *Server) transcriptionEnsureVersion(ctx context.Context, row *transcriptionRow) (uuid.UUID, error) {
	if row.CurrentVersionID != nil {
		return *row.CurrentVersionID, nil
	}
	if row.TranscriptionText == nil || *row.TranscriptionText == "" {
		return uuid.Nil, fmt.Errorf("no transcript version")
	}
	var id uuid.UUID
	err := s.pool.QueryRow(ctx, `
		INSERT INTO transcript_versions
			(media_file_id, provider, model, prompt_revision, produced_at, text)
		VALUES ($1, 'unknown', NULL, 'legacy', now(), $2)
		RETURNING id`, row.ID, *row.TranscriptionText).Scan(&id)
	if err != nil {
		return uuid.Nil, err
	}
	if _, err := s.pool.Exec(ctx, `
		UPDATE media_files SET current_transcript_version_id = $2 WHERE id = $1`,
		row.ID, id); err != nil {
		return uuid.Nil, err
	}
	row.CurrentVersionID = &id
	return id, nil
}

func (s *Server) transcriptionResolveVersion(ctx context.Context, row *transcriptionRow, requested *uuid.UUID) (uuid.UUID, error) {
	if requested != nil {
		var exists bool
		if err := s.pool.QueryRow(ctx, `
			SELECT EXISTS(
				SELECT 1 FROM transcript_versions WHERE id = $1 AND media_file_id = $2)`,
			*requested, row.ID).Scan(&exists); err != nil {
			return uuid.Nil, err
		}
		if !exists {
			return uuid.Nil, fmt.Errorf("transcript version not found")
		}
		return *requested, nil
	}
	return s.transcriptionEnsureVersion(ctx, row)
}

// POST /transcriptions/{id}/retranscribe — new STT version; previous text stays.
func (s *Server) handleTranscriptionRetranscribe(w http.ResponseWriter, r *http.Request) {
	id, err := uuidParam(r, "id")
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	row, err := s.transcriptionLoad(r.Context(), id)
	if errors.Is(err, pgx.ErrNoRows) {
		writeError(w, http.StatusNotFound, "Media file not found")
		return
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	if row.Status == "processing" || row.Status == "pending" {
		writeError(w, http.StatusConflict, "transcription is already in progress")
		return
	}
	if s.queue == nil {
		writeError(w, http.StatusInternalServerError, "queue is not configured")
		return
	}
	task, err := jobs.NewRetranscribeAudioTask(id.String())
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to enqueue transcription job")
		return
	}
	if _, err := s.queue.Enqueue(task, asynq.MaxRetry(3)); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to enqueue transcription job")
		return
	}
	writeJSON(w, http.StatusAccepted, map[string]any{"queued": true, "mediaFileId": id})
}

// POST /transcriptions/{id}/select-version {versionId} — operator picks which
// stored transcript is current for parse/display.
func (s *Server) handleTranscriptionSelectVersion(w http.ResponseWriter, r *http.Request) {
	id, err := uuidParam(r, "id")
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	var req struct {
		VersionID uuid.UUID `json:"versionId"`
	}
	if err := decodeJSON(r, &req); err != nil || req.VersionID == uuid.Nil {
		writeError(w, http.StatusBadRequest, "versionId is required")
		return
	}
	text, err := s.transcriptionVersionText(r.Context(), id, req.VersionID)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	tag, err := s.pool.Exec(r.Context(), `
		UPDATE media_files
		SET current_transcript_version_id = $2, transcription_text = $3
		WHERE id = $1`, id, req.VersionID, text)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	if tag.RowsAffected() == 0 {
		writeError(w, http.StatusNotFound, "Media file not found")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"success": true, "currentVersionId": req.VersionID, "transcriptionText": text,
	})
}

// DELETE /transcriptions/{id} — refuses while domain rows still point at it.
// Check-and-delete run in one transaction so a concurrent confirm cannot
// turn a race into a 500 FK error.
func (s *Server) handleTranscriptionDelete(w http.ResponseWriter, r *http.Request) {
	id, err := uuidParam(r, "id")
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	ctx := r.Context()
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	defer tx.Rollback(ctx)

	var audioKey string
	err = tx.QueryRow(ctx, `
		SELECT audio_key FROM media_files WHERE id = $1 FOR UPDATE`, id).Scan(&audioKey)
	if errors.Is(err, pgx.ErrNoRows) {
		writeError(w, http.StatusNotFound, "Media file not found")
		return
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	counts, err := transcriptionSourceCountsOn(ctx, tx, id)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	if counts.total() > 0 {
		writeError(w, http.StatusConflict,
			"recording still has confirmed inspections, feedings, treatments, or mite counts")
		return
	}
	if _, err := tx.Exec(ctx, `
		UPDATE media_files SET current_transcript_version_id = NULL WHERE id = $1`, id); err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	if _, err := tx.Exec(ctx, `DELETE FROM media_files WHERE id = $1`, id); err != nil {
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) && pgErr.Code == "23503" {
			// The named cause holds only for direct source_media_file_id FKs;
			// a cascade through transcript versions is a different constraint.
			msg := "recording is still referenced and cannot be deleted"
			if strings.Contains(pgErr.ConstraintName, "source_media_file_id") {
				msg = "recording still has confirmed inspections, feedings, treatments, or mite counts"
			}
			writeError(w, http.StatusConflict, msg)
			return
		}
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	if err := tx.Commit(ctx); err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	if s.store != nil && audioKey != "" {
		_ = s.store.Delete(ctx, audioKey)
	}
	writeJSON(w, http.StatusOK, map[string]any{"success": true})
}

type reparseProposal struct {
	Action     string     `json:"action"` // create | update | unchanged
	Kind       string     `json:"kind"`
	ExistingID *uuid.UUID `json:"existingId,omitempty"`
	HiveID     *uuid.UUID `json:"hiveId,omitempty"`
	Current    any        `json:"current,omitempty"`
	Proposed   any        `json:"proposed,omitempty"`
}

type reparseDiff struct {
	HasExisting bool              `json:"hasExisting"`
	Counts      map[string]int    `json:"counts"`
	Proposals   []reparseProposal `json:"proposals"`
}

type existingInspection struct {
	ID             uuid.UUID
	HiveID         uuid.UUID
	QueenSeen      *bool
	QueenHealth    *string
	BroodPattern   *string
	StoresHoney    *int
	StoresPollen   *int
	Temperament    *int
	FramesOfBees   *int
	FramesOfBrood  *int
	FramesOfStores *int
	Pests          []byte
	Treatments     []byte
	Notes          *string
}

type existingFeeding struct {
	ID           uuid.UUID
	HiveID       uuid.UUID
	Type         string
	Quantity     float64
	QuantityUnit string
	FeederType   *string
	Notes        *string
}

type existingTreatment struct {
	ID      uuid.UUID
	HiveID  uuid.UUID
	Product string
	Method  *string
}

type existingMite struct {
	ID         uuid.UUID
	HiveID     uuid.UUID
	Method     string
	MitesCount int
	SampleSize *int
	Notes      *string
}

func (s *Server) transcriptionReparseDiff(ctx context.Context, mediaID uuid.UUID, parsed []ai.MatchedInspection) (reparseDiff, error) {
	diff := reparseDiff{
		Counts:    map[string]int{"inspections": 0, "feedings": 0, "treatments": 0, "miteCounts": 0},
		Proposals: []reparseProposal{},
	}
	inspRows, err := s.pool.Query(ctx, `
		SELECT id, hive_id, queen_seen, queen_health, brood_pattern,
		       stores_honey, stores_pollen, temperament,
		       frames_of_bees, frames_of_brood, frames_of_stores,
		       pests, treatments, notes
		FROM inspections
		WHERE source_media_file_id = $1
		   OR (source_media->>'mediaFileId') = $1::text
		ORDER BY date`, mediaID)
	if err != nil {
		return diff, err
	}
	inspections := []existingInspection{}
	for inspRows.Next() {
		var row existingInspection
		if err := inspRows.Scan(&row.ID, &row.HiveID, &row.QueenSeen, &row.QueenHealth, &row.BroodPattern,
			&row.StoresHoney, &row.StoresPollen, &row.Temperament,
			&row.FramesOfBees, &row.FramesOfBrood, &row.FramesOfStores,
			&row.Pests, &row.Treatments, &row.Notes); err != nil {
			inspRows.Close()
			return diff, err
		}
		inspections = append(inspections, row)
	}
	inspRows.Close()
	if err := inspRows.Err(); err != nil {
		return diff, err
	}

	feedRows, err := s.pool.Query(ctx, `
		SELECT id, hive_id, type::text, quantity, quantity_unit::text, feeder_type::text, notes
		FROM feedings WHERE source_media_file_id = $1 ORDER BY date_fed`, mediaID)
	if err != nil {
		return diff, err
	}
	feedings := []existingFeeding{}
	for feedRows.Next() {
		var row existingFeeding
		if err := feedRows.Scan(&row.ID, &row.HiveID, &row.Type, &row.Quantity, &row.QuantityUnit, &row.FeederType, &row.Notes); err != nil {
			feedRows.Close()
			return diff, err
		}
		feedings = append(feedings, row)
	}
	feedRows.Close()

	treatRows, err := s.pool.Query(ctx, `
		SELECT id, hive_id, product, method FROM treatment_events
		WHERE source_media_file_id = $1 ORDER BY date_applied`, mediaID)
	if err != nil {
		return diff, err
	}
	treatments := []existingTreatment{}
	for treatRows.Next() {
		var row existingTreatment
		if err := treatRows.Scan(&row.ID, &row.HiveID, &row.Product, &row.Method); err != nil {
			treatRows.Close()
			return diff, err
		}
		treatments = append(treatments, row)
	}
	treatRows.Close()

	miteRows, err := s.pool.Query(ctx, `
		SELECT id, hive_id, method, mites_count, sample_size, notes
		FROM mite_counts WHERE source_media_file_id = $1 ORDER BY date`, mediaID)
	if err != nil {
		return diff, err
	}
	mites := []existingMite{}
	for miteRows.Next() {
		var row existingMite
		if err := miteRows.Scan(&row.ID, &row.HiveID, &row.Method, &row.MitesCount, &row.SampleSize, &row.Notes); err != nil {
			miteRows.Close()
			return diff, err
		}
		mites = append(mites, row)
	}
	miteRows.Close()

	diff.Counts["inspections"] = len(inspections)
	diff.Counts["feedings"] = len(feedings)
	diff.Counts["treatments"] = len(treatments)
	diff.Counts["miteCounts"] = len(mites)
	diff.HasExisting = len(inspections)+len(feedings)+len(treatments)+len(mites) > 0

	usedInsp := map[uuid.UUID]bool{}
	usedFeed := map[uuid.UUID]bool{}
	usedTreat := map[uuid.UUID]bool{}
	usedMite := map[uuid.UUID]bool{}

	for _, item := range parsed {
		hiveID := parseOptionalUUID(item.MatchedHiveID)
		matched := matchInspection(inspections, hiveID, usedInsp)
		proposal := reparseProposal{Kind: "inspection", HiveID: hiveID, Proposed: item.ParsedInspection}
		if matched == nil {
			proposal.Action = "create"
		} else {
			proposal.ExistingID = &matched.ID
			proposal.Current = matched
			if inspectionFieldsEqual(*matched, item.ParsedInspection) {
				proposal.Action = "unchanged"
			} else {
				proposal.Action = "update"
			}
		}
		diff.Proposals = append(diff.Proposals, proposal)

		for _, feeding := range item.Feedings {
			fmatch := matchFeeding(feedings, hiveID, feeding.Type, usedFeed)
			fp := reparseProposal{Kind: "feeding", HiveID: hiveID, Proposed: feeding}
			if fmatch == nil {
				fp.Action = "create"
			} else {
				fp.ExistingID = &fmatch.ID
				fp.Current = fmatch
				if fmatch.Quantity == feeding.Quantity && fmatch.QuantityUnit == feeding.QuantityUnit {
					fp.Action = "unchanged"
				} else {
					fp.Action = "update"
				}
			}
			diff.Proposals = append(diff.Proposals, fp)
		}
		for _, treatment := range item.Treatments {
			tmatch := matchTreatment(treatments, hiveID, treatment.Product, usedTreat)
			tp := reparseProposal{Kind: "treatment", HiveID: hiveID, Proposed: treatment}
			if tmatch == nil {
				tp.Action = "create"
			} else {
				tp.ExistingID = &tmatch.ID
				tp.Current = tmatch
				tp.Action = "unchanged"
				if !ptrStrEqual(tmatch.Method, treatment.Method) {
					tp.Action = "update"
				}
			}
			diff.Proposals = append(diff.Proposals, tp)
		}
		for _, mite := range item.MiteCounts {
			mmatch := matchMite(mites, hiveID, mite.Method, usedMite)
			mp := reparseProposal{Kind: "mite_count", HiveID: hiveID, Proposed: mite}
			if mmatch == nil {
				mp.Action = "create"
			} else {
				mp.ExistingID = &mmatch.ID
				mp.Current = mmatch
				if mmatch.MitesCount == mite.MitesCount {
					mp.Action = "unchanged"
				} else {
					mp.Action = "update"
				}
			}
			diff.Proposals = append(diff.Proposals, mp)
		}
	}

	for _, row := range inspections {
		if !usedInsp[row.ID] {
			id := row.ID
			hive := row.HiveID
			diff.Proposals = append(diff.Proposals, reparseProposal{
				Action: "unchanged", Kind: "inspection", ExistingID: &id, HiveID: &hive, Current: row,
			})
		}
	}
	return diff, nil
}

func parseOptionalUUID(raw *string) *uuid.UUID {
	if raw == nil || *raw == "" {
		return nil
	}
	id, err := uuid.Parse(*raw)
	if err != nil {
		return nil
	}
	return &id
}

func matchInspection(rows []existingInspection, hiveID *uuid.UUID, used map[uuid.UUID]bool) *existingInspection {
	for i := range rows {
		if used[rows[i].ID] {
			continue
		}
		if hiveID != nil && rows[i].HiveID == *hiveID {
			used[rows[i].ID] = true
			return &rows[i]
		}
	}
	if hiveID == nil && len(rows) == 1 && !used[rows[0].ID] {
		used[rows[0].ID] = true
		return &rows[0]
	}
	return nil
}

func matchFeeding(rows []existingFeeding, hiveID *uuid.UUID, typ string, used map[uuid.UUID]bool) *existingFeeding {
	for i := range rows {
		if used[rows[i].ID] || rows[i].Type != typ {
			continue
		}
		if hiveID == nil || rows[i].HiveID == *hiveID {
			used[rows[i].ID] = true
			return &rows[i]
		}
	}
	return nil
}

func matchTreatment(rows []existingTreatment, hiveID *uuid.UUID, product string, used map[uuid.UUID]bool) *existingTreatment {
	for i := range rows {
		if used[rows[i].ID] || rows[i].Product != product {
			continue
		}
		if hiveID == nil || rows[i].HiveID == *hiveID {
			used[rows[i].ID] = true
			return &rows[i]
		}
	}
	return nil
}

func matchMite(rows []existingMite, hiveID *uuid.UUID, method string, used map[uuid.UUID]bool) *existingMite {
	for i := range rows {
		if used[rows[i].ID] || rows[i].Method != method {
			continue
		}
		if hiveID == nil || rows[i].HiveID == *hiveID {
			used[rows[i].ID] = true
			return &rows[i]
		}
	}
	return nil
}

func inspectionFieldsEqual(cur existingInspection, proposed ai.ParsedInspection) bool {
	return ptrBoolEqual(cur.QueenSeen, proposed.QueenSeen) &&
		ptrStrEqual(cur.QueenHealth, proposed.QueenHealth) &&
		ptrStrEqual(cur.BroodPattern, proposed.BroodPattern) &&
		ptrIntEqual(cur.StoresHoney, proposed.StoresHoney) &&
		ptrIntEqual(cur.StoresPollen, proposed.StoresPollen) &&
		ptrIntEqual(cur.Temperament, proposed.Temperament) &&
		ptrIntEqual(cur.FramesOfBees, proposed.FramesOfBees) &&
		ptrIntEqual(cur.FramesOfBrood, proposed.FramesOfBrood) &&
		ptrIntEqual(cur.FramesOfStores, proposed.FramesOfStores) &&
		ptrStrEqual(cur.Notes, proposed.Notes)
}

func ptrBoolEqual(a, b *bool) bool {
	if a == nil && b == nil {
		return true
	}
	return a != nil && b != nil && *a == *b
}

func ptrStrEqual(a, b *string) bool {
	if a == nil && b == nil {
		return true
	}
	return a != nil && b != nil && *a == *b
}

func ptrIntEqual(a, b *int) bool {
	if a == nil && b == nil {
		return true
	}
	return a != nil && b != nil && *a == *b
}

type reparseApplyItem struct {
	Kind       string          `json:"kind"`
	ExistingID *uuid.UUID      `json:"existingId"`
	HiveID     *uuid.UUID      `json:"hiveId"`
	Fields     json.RawMessage `json:"fields"`
}

// reparseCreateHive resolves the target hive for a "create" proposal: an
// explicit hiveId, else the media owner when it is a hive (mirrors the
// single-mode fallback in confirm). It then requires edit access to that hive,
// writing the error response and returning false otherwise.
func (s *Server) reparseCreateHive(w http.ResponseWriter, r *http.Request, row *transcriptionRow, item *reparseApplyItem, what string) bool {
	if item.HiveID == nil && row.OwnerType == "hive" {
		ownerID := row.OwnerID
		item.HiveID = &ownerID
	}
	if item.HiveID == nil {
		writeError(w, http.StatusBadRequest, "hiveId is required to create "+what)
		return false
	}
	return s.requireHiveRole(w, r, *item.HiveID, true)
}

// POST /transcriptions/{id}/apply-reparse — apply only the accepted proposals.
// Unmentioned confirmed rows stay as they are.
func (s *Server) handleTranscriptionApplyReparse(w http.ResponseWriter, r *http.Request) {
	id, err := uuidParam(r, "id")
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	var req struct {
		VersionID *uuid.UUID         `json:"versionId"`
		Accept    []reparseApplyItem `json:"accept"`
	}
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if len(req.Accept) == 0 {
		writeJSON(w, http.StatusOK, map[string]any{"success": true, "updated": 0, "created": 0})
		return
	}
	ctx := r.Context()
	row, err := s.transcriptionLoad(ctx, id)
	if errors.Is(err, pgx.ErrNoRows) {
		writeError(w, http.StatusNotFound, "Media file not found")
		return
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	versionID, err := s.transcriptionResolveVersion(ctx, row, req.VersionID)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}

	tx, err := s.pool.Begin(ctx)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	defer tx.Rollback(ctx)

	now := time.Now()
	updated, created := 0, 0
	for _, item := range req.Accept {
		switch item.Kind {
		case "inspection":
			var fields ai.ParsedInspection
			if err := json.Unmarshal(item.Fields, &fields); err != nil {
				writeError(w, http.StatusBadRequest, "invalid inspection fields")
				return
			}
			pestsJSON, err := transcriptionNullableJSON(fields.Pests)
			if err != nil {
				writeError(w, http.StatusBadRequest, "invalid pests")
				return
			}
			treatmentsJSON, err := transcriptionNullableJSON(fields.Treatments)
			if err != nil {
				writeError(w, http.StatusBadRequest, "invalid treatments")
				return
			}
			if item.ExistingID != nil {
				tag, err := tx.Exec(ctx, `
					UPDATE inspections SET
						queen_seen = $2, queen_health = $3, brood_pattern = $4,
						stores_honey = $5, stores_pollen = $6, temperament = $7,
						pests = $8, treatments = $9, notes = $10,
						source_transcript_version_id = $11,
						frames_of_bees = $13, frames_of_brood = $14, frames_of_stores = $15
					WHERE id = $1 AND (
						source_media_file_id = $12
						OR (source_media->>'mediaFileId') = $12::text
					)`,
					*item.ExistingID, fields.QueenSeen, fields.QueenHealth, fields.BroodPattern,
					clampRating(fields.StoresHoney), clampRating(fields.StoresPollen), clampRating(fields.Temperament),
					pestsJSON, treatmentsJSON, fields.Notes, versionID, row.ID,
					fields.FramesOfBees, fields.FramesOfBrood, fields.FramesOfStores)
				if err != nil {
					writeError(w, http.StatusInternalServerError, "database error")
					return
				}
				if tag.RowsAffected() == 0 {
					writeError(w, http.StatusConflict, "inspection is not from this recording")
					return
				}
				updated++
				continue
			}
			if !s.reparseCreateHive(w, r, row, &item, "an inspection") {
				return
			}
			sourceMedia, err := json.Marshal(struct {
				MediaFileID uuid.UUID `json:"mediaFileId"`
				RawText     *string   `json:"rawText"`
			}{MediaFileID: row.ID, RawText: row.TranscriptionText})
			if err != nil {
				writeError(w, http.StatusInternalServerError, "encoding error")
				return
			}
			if _, err := tx.Exec(ctx, `
				INSERT INTO inspections
					(hive_id, date, queen_seen, queen_health, brood_pattern,
					 stores_honey, stores_pollen, temperament, pests, treatments, notes, source_media,
					 source_media_file_id, source_transcript_version_id,
					 frames_of_bees, frames_of_brood, frames_of_stores)
				VALUES ($1, now(), $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)`,
				*item.HiveID, fields.QueenSeen, fields.QueenHealth, fields.BroodPattern,
				clampRating(fields.StoresHoney), clampRating(fields.StoresPollen), clampRating(fields.Temperament),
				pestsJSON, treatmentsJSON, fields.Notes, sourceMedia, row.ID, versionID,
				fields.FramesOfBees, fields.FramesOfBrood, fields.FramesOfStores); err != nil {
				writeError(w, http.StatusInternalServerError, "database error")
				return
			}
			created++
		case "feeding":
			var fields ai.Feeding
			if err := json.Unmarshal(item.Fields, &fields); err != nil {
				writeError(w, http.StatusBadRequest, "invalid feeding fields")
				return
			}
			if item.ExistingID != nil {
				tag, err := tx.Exec(ctx, `
					UPDATE feedings SET
						type = $2, quantity = $3, quantity_unit = $4,
						feeder_type = $5, notes = $6, source_transcript_version_id = $7
					WHERE id = $1 AND source_media_file_id = $8`,
					*item.ExistingID, fields.Type, fields.Quantity, fields.QuantityUnit,
					feedingFeederPtr(fields.FeederType), fields.Notes, versionID, row.ID)
				if err != nil {
					writeError(w, http.StatusBadRequest, "invalid feeding extracted from transcript")
					return
				}
				if tag.RowsAffected() == 0 {
					writeError(w, http.StatusConflict, "feeding is not from this recording")
					return
				}
				updated++
				continue
			}
			if !s.reparseCreateHive(w, r, row, &item, "a feeding") {
				return
			}
			if _, err := feedingInsert(ctx, tx, feedingFields{
				HiveID:                    *item.HiveID,
				DateFed:                   now,
				Type:                      fields.Type,
				Quantity:                  fields.Quantity,
				QuantityUnit:              fields.QuantityUnit,
				FeederType:                feedingFeederPtr(fields.FeederType),
				Notes:                     fields.Notes,
				SourceMediaFileID:         &row.ID,
				SourceTranscriptVersionID: &versionID,
			}, actorID(r)); err != nil {
				writeError(w, http.StatusBadRequest, "invalid feeding extracted from transcript")
				return
			}
			created++
		case "treatment":
			var fields ai.Treatment
			if err := json.Unmarshal(item.Fields, &fields); err != nil {
				writeError(w, http.StatusBadRequest, "invalid treatment fields")
				return
			}
			// Product changes move the lockout, so resolve withdrawal_days
			// exactly as the confirm path does on both update and insert.
			days, resolveErr := s.resolveWithdrawalDays(ctx, fields.Product)
			if resolveErr != nil {
				writeError(w, http.StatusInternalServerError, "database error")
				return
			}
			if item.ExistingID != nil {
				tag, err := tx.Exec(ctx, `
					UPDATE treatment_events SET product = $2, method = $3, withdrawal_days = $4,
						source_transcript_version_id = $5
					WHERE id = $1 AND source_media_file_id = $6`,
					*item.ExistingID, fields.Product, fields.Method, days, versionID, row.ID)
				if err != nil {
					writeError(w, http.StatusInternalServerError, "database error")
					return
				}
				if tag.RowsAffected() == 0 {
					writeError(w, http.StatusConflict, "treatment is not from this recording")
					return
				}
				updated++
				continue
			}
			if !s.reparseCreateHive(w, r, row, &item, "a treatment") {
				return
			}
			if _, err := tx.Exec(ctx, `
				INSERT INTO treatment_events
					(hive_id, date_applied, product, method, withdrawal_days,
					 source_media_file_id, source_transcript_version_id)
				VALUES ($1, $2, $3, $4, $5, $6, $7)`,
				*item.HiveID, now, fields.Product, fields.Method, days, row.ID, versionID); err != nil {
				writeError(w, http.StatusBadRequest, "invalid treatment extracted from transcript")
				return
			}
			created++
		case "mite_count":
			var fields ai.MiteCount
			if err := json.Unmarshal(item.Fields, &fields); err != nil {
				writeError(w, http.StatusBadRequest, "invalid mite count fields")
				return
			}
			if item.ExistingID != nil {
				tag, err := tx.Exec(ctx, `
					UPDATE mite_counts SET
						method = $2, mites_count = $3, sample_size = $4, notes = $5,
						source_transcript_version_id = $6
					WHERE id = $1 AND source_media_file_id = $7`,
					*item.ExistingID, fields.Method, fields.MitesCount, fields.SampleSize, fields.Notes,
					versionID, row.ID)
				if err != nil {
					writeError(w, http.StatusInternalServerError, "database error")
					return
				}
				if tag.RowsAffected() == 0 {
					writeError(w, http.StatusConflict, "mite count is not from this recording")
					return
				}
				updated++
				continue
			}
			if !s.reparseCreateHive(w, r, row, &item, "a mite count") {
				return
			}
			if _, err := tx.Exec(ctx, `
				INSERT INTO mite_counts
					(hive_id, date, method, mites_count, sample_size, notes,
					 source_media_file_id, source_transcript_version_id)
				VALUES ($1, now(), $2, $3, $4, $5, $6, $7)`,
				*item.HiveID, fields.Method, fields.MitesCount, fields.SampleSize, fields.Notes,
				row.ID, versionID); err != nil {
				writeError(w, http.StatusBadRequest, "invalid mite count extracted from transcript")
				return
			}
			created++
		default:
			writeError(w, http.StatusBadRequest, "unknown apply-reparse kind")
			return
		}
	}

	if err := tx.Commit(ctx); err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"success": true, "updated": updated, "created": created,
	})
}
