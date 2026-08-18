package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/hibiken/asynq"
	"github.com/jackc/pgx/v5"

	"github.com/biker2000on/beez-trackz/backend/internal/ai"
	"github.com/biker2000on/beez-trackz/backend/internal/jobs"
)

const transcriptionMaxUploadBytes = 64 << 20 // 64MB of audio

func (s *Server) mountTranscriptions(r chi.Router) {
	r.Post("/transcriptions", s.handleTranscriptionCreate)
	r.Get("/transcriptions", s.handleTranscriptionList)
	r.With(s.requireEntityParamRole("transcription", false)).
		Get("/transcriptions/{id}", s.handleTranscriptionGet)
	r.With(s.requireEntityParamRole("transcription", true)).
		Post("/transcriptions/{id}/parse", s.handleTranscriptionParse)
	r.With(s.requireEntityParamRole("transcription", true)).
		Post("/transcriptions/{id}/confirm", s.handleTranscriptionConfirm)
}

// transcriptionRow mirrors a media_files record.
type transcriptionRow struct {
	ID                 uuid.UUID
	AudioKey           string
	TranscriptionText  *string
	Status             string
	TranscriptionError *string
	OwnerType          string
	OwnerID            uuid.UUID
	CreatedAt          time.Time
	UpdatedAt          time.Time
}

func (s *Server) transcriptionLoad(ctx context.Context, id uuid.UUID) (*transcriptionRow, error) {
	var row transcriptionRow
	err := s.pool.QueryRow(ctx, `
		SELECT id, audio_key, transcription_text, transcription_status, transcription_error,
		       owner_type, owner_id, created_at, updated_at
		FROM media_files WHERE id = $1`, id).
		Scan(&row.ID, &row.AudioKey, &row.TranscriptionText, &row.Status, &row.TranscriptionError,
			&row.OwnerType, &row.OwnerID, &row.CreatedAt, &row.UpdatedAt)
	if err != nil {
		return nil, err
	}
	return &row, nil
}

func transcriptionRowJSON(row *transcriptionRow) map[string]any {
	return map[string]any{
		"id":                row.ID,
		"status":            row.Status,
		"transcriptionText": row.TranscriptionText,
		"error":             row.TranscriptionError,
		"ownerType":         row.OwnerType,
		"ownerId":           row.OwnerID,
		"createdAt":         row.CreatedAt,
		"updatedAt":         row.UpdatedAt,
	}
}

// transcriptionMode validates a mode string, defaulting to "single".
func transcriptionMode(mode string) (string, bool) {
	switch mode {
	case "":
		return "single", true
	case "single", "batch":
		return mode, true
	default:
		return "", false
	}
}

// transcriptionCandidateHives lists hives to fuzzy-match references against:
// the owner apiary's hives when owned by an apiary, otherwise all non-archived.
func (s *Server) transcriptionCandidateHives(ctx context.Context, ownerType string, ownerID uuid.UUID) ([]ai.HiveRef, error) {
	query := `SELECT id, position_label FROM hives WHERE is_archived = false`
	args := []any{}
	if ownerType == "apiary" {
		query += ` AND apiary_id = $1`
		args = append(args, ownerID)
	}
	rows, err := s.pool.Query(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var hives []ai.HiveRef
	for rows.Next() {
		var h ai.HiveRef
		if err := rows.Scan(&h.ID, &h.PositionLabel); err != nil {
			return nil, err
		}
		hives = append(hives, h)
	}
	return hives, rows.Err()
}

// transcriptionParseAndMatch parses the text with the configured transcription
// provider and annotates inspections with fuzzy hive matches.
func (s *Server) transcriptionParseAndMatch(ctx context.Context, row *transcriptionRow, mode string) (map[string]any, error) {
	cfg, err := ai.LoadConfig(ctx, s.pool)
	if err != nil {
		return nil, err
	}
	provider, err := ai.ProviderForTask(cfg, ai.TaskTranscription)
	if err != nil {
		return nil, err
	}
	text := ""
	if row.TranscriptionText != nil {
		text = *row.TranscriptionText
	}
	result, err := ai.ParseTranscription(ctx, provider, text, mode)
	if err != nil {
		return nil, err
	}
	hives, err := s.transcriptionCandidateHives(ctx, row.OwnerType, row.OwnerID)
	if err != nil {
		return nil, err
	}
	return map[string]any{
		"rawText":     result.RawText,
		"inspections": ai.MatchHiveReferences(result.Inspections, hives),
	}, nil
}

// POST /transcriptions — multipart audio upload; inserts a pending media_files
// row, stores the audio in MinIO under audio/{id}.webm, and enqueues the
// transcription job.
func (s *Server) handleTranscriptionCreate(w http.ResponseWriter, r *http.Request) {
	// ParseMultipartForm's argument only controls the memory-vs-tempfile
	// spill, not the request size; without MaxBytesReader a single multi-GB
	// upload is read fully into RAM. Bound a bit above the file limit to
	// leave room for the other multipart fields.
	r.Body = http.MaxBytesReader(w, r.Body, transcriptionMaxUploadBytes+(1<<20))
	if err := r.ParseMultipartForm(transcriptionMaxUploadBytes); err != nil {
		var maxErr *http.MaxBytesError
		if errors.As(err, &maxErr) {
			writeError(w, http.StatusBadRequest, "Audio must be under 64MB")
			return
		}
		writeError(w, http.StatusBadRequest, "invalid multipart form")
		return
	}
	file, header, err := r.FormFile("audio")
	if err != nil {
		// Legacy field name.
		file, header, err = r.FormFile("audioBlob")
	}
	if err != nil {
		writeError(w, http.StatusBadRequest, "Audio file is required")
		return
	}
	defer file.Close()
	if header != nil && header.Size > transcriptionMaxUploadBytes {
		writeError(w, http.StatusBadRequest, "Audio must be under 64MB")
		return
	}

	ownerType := r.FormValue("ownerType")
	if ownerType != "hive" && ownerType != "apiary" {
		writeError(w, http.StatusBadRequest, "ownerType must be hive or apiary")
		return
	}
	ownerID, err := uuid.Parse(r.FormValue("ownerId"))
	if err != nil {
		writeError(w, http.StatusBadRequest, "Owner ID is required")
		return
	}
	if !s.requireOwnerRole(w, r, ownerType, ownerID, true) {
		return
	}
	if _, ok := transcriptionMode(r.FormValue("mode")); !ok {
		writeError(w, http.StatusBadRequest, "mode must be single or batch")
		return
	}

	data, err := io.ReadAll(file)
	if err != nil || len(data) == 0 {
		writeError(w, http.StatusBadRequest, "Audio file is required")
		return
	}

	id := uuid.New()
	audioKey := "audio/" + id.String() + ".webm"
	ctx := r.Context()

	if _, err := s.pool.Exec(ctx, `
		INSERT INTO media_files (id, audio_key, transcription_status, owner_type, owner_id)
		VALUES ($1, $2, 'pending', $3, $4)`, id, audioKey, ownerType, ownerID); err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}

	contentType := "audio/webm"
	if header != nil && header.Header.Get("Content-Type") != "" {
		contentType = header.Header.Get("Content-Type")
	}
	if err := s.store.Put(ctx, audioKey, bytes.NewReader(data), int64(len(data)), contentType); err != nil {
		_, _ = s.pool.Exec(ctx, `DELETE FROM media_files WHERE id = $1`, id)
		writeError(w, http.StatusInternalServerError, "failed to store audio")
		return
	}

	task, err := jobs.NewTranscribeAudioTask(id.String())
	if err != nil {
		_, _ = s.pool.Exec(ctx, `
			UPDATE media_files SET transcription_status = 'failed', transcription_error = $2
			WHERE id = $1`, id, "failed to enqueue transcription job")
		writeError(w, http.StatusInternalServerError, "failed to enqueue transcription job")
		return
	}
	if _, err := s.queue.Enqueue(task, asynq.MaxRetry(3)); err != nil {
		if errors.Is(err, asynq.ErrTaskIDConflict) {
			// Same recording is already queued; treat as success.
			writeJSON(w, http.StatusCreated, map[string]any{"mediaFileId": id})
			return
		}
		_, _ = s.pool.Exec(ctx, `
			UPDATE media_files SET transcription_status = 'failed', transcription_error = $2
			WHERE id = $1`, id, "failed to enqueue transcription job")
		writeError(w, http.StatusInternalServerError, "failed to enqueue transcription job")
		return
	}

	writeJSON(w, http.StatusCreated, map[string]any{"mediaFileId": id})
}

// GET /transcriptions?ownerType=&ownerId= — list transcriptions, optionally
// filtered by owner.
func (s *Server) handleTranscriptionList(w http.ResponseWriter, r *http.Request) {
	ownerType := r.URL.Query().Get("ownerType")
	ownerIDRaw := r.URL.Query().Get("ownerId")

	query := `
		SELECT id, audio_key, transcription_text, transcription_status, transcription_error,
		       owner_type, owner_id, created_at, updated_at
		FROM media_files`
	args := []any{}
	if ownerType != "" || ownerIDRaw != "" {
		if ownerType == "" || ownerIDRaw == "" {
			writeError(w, http.StatusBadRequest, "ownerType and ownerId must be provided together")
			return
		}
		ownerID, err := uuid.Parse(ownerIDRaw)
		if err != nil {
			writeError(w, http.StatusBadRequest, "invalid ownerId")
			return
		}
		if !s.requireOwnerRole(w, r, ownerType, ownerID, false) {
			return
		}
		query += ` WHERE owner_type = $1 AND owner_id = $2`
		args = append(args, ownerType, ownerID)
	} else if !principalFrom(r).IsAdmin {
		writeError(w, http.StatusBadRequest, "ownerType and ownerId are required")
		return
	}
	query += ` ORDER BY created_at DESC`

	rows, err := s.pool.Query(r.Context(), query, args...)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	defer rows.Close()

	list := []map[string]any{}
	for rows.Next() {
		var row transcriptionRow
		if err := rows.Scan(&row.ID, &row.AudioKey, &row.TranscriptionText, &row.Status,
			&row.TranscriptionError, &row.OwnerType, &row.OwnerID, &row.CreatedAt, &row.UpdatedAt); err != nil {
			writeError(w, http.StatusInternalServerError, "database error")
			return
		}
		list = append(list, transcriptionRowJSON(&row))
	}
	if err := rows.Err(); err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	writeJSON(w, http.StatusOK, list)
}

// GET /transcriptions/{id}?mode= — status plus, when complete, the parsed
// inspections (server-side parse with the configured provider).
func (s *Server) handleTranscriptionGet(w http.ResponseWriter, r *http.Request) {
	id, err := uuidParam(r, "id")
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	mode, ok := transcriptionMode(r.URL.Query().Get("mode"))
	if !ok {
		writeError(w, http.StatusBadRequest, "mode must be single or batch")
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
	resp := transcriptionRowJSON(row)
	if row.Status == "complete" && row.TranscriptionText != nil && *row.TranscriptionText != "" {
		parsed, err := s.transcriptionParseAndMatch(r.Context(), row, mode)
		if err != nil {
			resp["parseError"] = err.Error()
		} else {
			resp["parsed"] = parsed
		}
	}
	writeJSON(w, http.StatusOK, resp)
}

// POST /transcriptions/{id}/parse {mode} — re-parse the stored transcription
// text ("Re-parse with AI").
func (s *Server) handleTranscriptionParse(w http.ResponseWriter, r *http.Request) {
	id, err := uuidParam(r, "id")
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	var req struct {
		Mode string `json:"mode"`
	}
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	mode, ok := transcriptionMode(req.Mode)
	if !ok {
		writeError(w, http.StatusBadRequest, "mode must be single or batch")
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
	if row.TranscriptionText == nil || *row.TranscriptionText == "" {
		writeError(w, http.StatusBadRequest, "No transcription text to parse")
		return
	}
	parsed, err := s.transcriptionParseAndMatch(r.Context(), row, mode)
	if err != nil {
		writeError(w, http.StatusBadGateway, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, parsed)
}

// transcriptionConfirmItem is one confirmed inspection from the review UI.
type transcriptionConfirmItem struct {
	HiveID        *uuid.UUID `json:"hiveId"`
	MatchedHiveID *uuid.UUID `json:"matchedHiveId"` // tolerated from parse output; ignored
	ai.ParsedInspection
}

// POST /transcriptions/{id}/confirm {mode, inspections} — create inspection
// rows from confirmed parsed data. Single mode defaults hiveId to the media
// owner (which must be a hive); batch mode requires hiveId per item.
func (s *Server) handleTranscriptionConfirm(w http.ResponseWriter, r *http.Request) {
	id, err := uuidParam(r, "id")
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	var req struct {
		Mode        string                     `json:"mode"`
		Inspections []transcriptionConfirmItem `json:"inspections"`
	}
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	mode, ok := transcriptionMode(req.Mode)
	if !ok {
		writeError(w, http.StatusBadRequest, "mode must be single or batch")
		return
	}
	if len(req.Inspections) == 0 {
		writeError(w, http.StatusBadRequest, "No inspections to confirm")
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

	tx, err := s.pool.Begin(ctx)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	defer tx.Rollback(ctx)

	now := time.Now()
	inspectionIDs := make([]uuid.UUID, 0, len(req.Inspections))
	inspectionHiveIDs := make([]uuid.UUID, 0, len(req.Inspections))
	feedingIDs := make([]uuid.UUID, 0)
	treatmentEventIDs := make([]uuid.UUID, 0)
	queenEventIDs := make([]uuid.UUID, 0)
	miteCountIDs := make([]uuid.UUID, 0)
	for _, item := range req.Inspections {
		hiveID := item.HiveID
		if hiveID == nil && mode == "single" && row.OwnerType == "hive" {
			hiveID = &row.OwnerID
		}
		if hiveID == nil {
			writeError(w, http.StatusBadRequest, "Hive ID is required for each inspection")
			return
		}
		if !s.requireHiveRole(w, r, *hiveID, true) {
			return
		}

		pestsJSON, err := transcriptionNullableJSON(item.Pests)
		if err != nil {
			writeError(w, http.StatusBadRequest, "invalid pests")
			return
		}
		treatmentsJSON, err := transcriptionNullableJSON(item.Treatments)
		if err != nil {
			writeError(w, http.StatusBadRequest, "invalid treatments")
			return
		}
		sourceMedia, err := json.Marshal(struct {
			MediaFileID   uuid.UUID `json:"mediaFileId"`
			HiveReference *string   `json:"hiveReference,omitempty"`
			RawText       *string   `json:"rawText"`
		}{MediaFileID: row.ID, HiveReference: item.HiveReference, RawText: row.TranscriptionText})
		if err != nil {
			writeError(w, http.StatusInternalServerError, "encoding error")
			return
		}

		var createdID uuid.UUID
		err = tx.QueryRow(ctx, `
			INSERT INTO inspections
				(hive_id, date, queen_seen, queen_health, brood_pattern,
				 stores_honey, stores_pollen, temperament, pests, treatments, notes, source_media)
			VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
			RETURNING id`,
			*hiveID, now, item.QueenSeen, item.QueenHealth, item.BroodPattern,
			clampRating(item.StoresHoney), clampRating(item.StoresPollen), clampRating(item.Temperament),
			pestsJSON, treatmentsJSON, item.Notes, sourceMedia).Scan(&createdID)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "database error")
			return
		}
		inspectionIDs = append(inspectionIDs, createdID)
		inspectionHiveIDs = append(inspectionHiveIDs, *hiveID)

		for _, feeding := range item.Feedings {
			// The shared insert path applies the feeder-lifecycle rule: a
			// feeding with no feeder is recorded closed, not left open.
			eventID, err := feedingInsert(ctx, tx, feedingFields{
				HiveID:       *hiveID,
				DateFed:      now,
				Type:         feeding.Type,
				Quantity:     feeding.Quantity,
				QuantityUnit: feeding.QuantityUnit,
				FeederType:   feedingFeederPtr(feeding.FeederType),
				Notes:        feeding.Notes,
			}, actorID(r))
			if err != nil {
				writeError(w, http.StatusBadRequest, "invalid feeding extracted from transcript")
				return
			}
			feedingIDs = append(feedingIDs, eventID)
		}
		for _, treatment := range item.Treatments {
			days, resolveErr := s.resolveWithdrawalDays(ctx, treatment.Product)
			if resolveErr != nil {
				writeError(w, http.StatusInternalServerError, "database error")
				return
			}
			var eventID uuid.UUID
			err = tx.QueryRow(ctx, `
				INSERT INTO treatment_events
					(hive_id, inspection_id, date_applied, product, method, withdrawal_days)
				VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
				*hiveID, createdID, now, treatment.Product, treatment.Method, days).Scan(&eventID)
			if err != nil {
				writeError(w, http.StatusBadRequest, "invalid treatment extracted from transcript")
				return
			}
			treatmentEventIDs = append(treatmentEventIDs, eventID)
		}
		for _, event := range item.QueenEvents {
			var eventID uuid.UUID
			err = tx.QueryRow(ctx, `
				INSERT INTO queen_events (hive_id, event_date, event_type, notes)
				VALUES ($1,$2,$3,$4) RETURNING id`,
				*hiveID, now, event.EventType, event.Notes).Scan(&eventID)
			if err != nil {
				writeError(w, http.StatusBadRequest, "invalid queen event extracted from transcript")
				return
			}
			queenEventIDs = append(queenEventIDs, eventID)
		}
		for _, miteCount := range item.MiteCounts {
			var eventID uuid.UUID
			err = tx.QueryRow(ctx, `
				INSERT INTO mite_counts
					(hive_id, inspection_id, date, method, mites_count, sample_size, notes)
				VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
				*hiveID, createdID, now, miteCount.Method, miteCount.MitesCount,
				miteCount.SampleSize, miteCount.Notes).Scan(&eventID)
			if err != nil {
				writeError(w, http.StatusBadRequest, "invalid mite count extracted from transcript")
				return
			}
			miteCountIDs = append(miteCountIDs, eventID)
		}
	}

	if err := tx.Commit(ctx); err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	for index, inspectionID := range inspectionIDs {
		if snapshot := s.inspectionWeatherSnapshot(r, inspectionHiveIDs[index]); len(snapshot) > 0 {
			_, _ = s.pool.Exec(ctx,
				`UPDATE inspections SET weather_snapshot=$1 WHERE id=$2`,
				snapshot, inspectionID)
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"success": true, "inspectionIds": inspectionIDs, "feedingIds": feedingIDs,
		"treatmentEventIds": treatmentEventIDs, "queenEventIds": queenEventIDs,
		"miteCountIds": miteCountIDs,
	})
}

// transcriptionNullableJSON marshals a slice for a jsonb column, mapping nil
// slices to SQL NULL.
func transcriptionNullableJSON[T any](v []T) (any, error) {
	if v == nil {
		return nil, nil
	}
	b, err := json.Marshal(v)
	if err != nil {
		return nil, err
	}
	return b, nil
}
