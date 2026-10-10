package httpapi

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/hibiken/asynq"
	"github.com/jackc/pgx/v5"

	"github.com/biker2000on/beez-trackz/backend/internal/ai"
	"github.com/biker2000on/beez-trackz/backend/internal/audioformat"
	"github.com/biker2000on/beez-trackz/backend/internal/jobs"
)

const transcriptionMaxUploadBytes = 64 << 20 // 64MB of audio

func (s *Server) mountTranscriptions(r chi.Router) {
	r.Post("/inspection-visits", s.handleInspectionVisitCreate)
	r.Post("/apiary-inspections", s.handleApiaryInspectionCreate)
	r.Get("/apiary-inspections", s.handleApiaryInspectionList)
	r.Post("/transcriptions", s.handleTranscriptionCreate)
	r.Get("/transcriptions", s.handleTranscriptionList)
	r.With(s.requireEntityParamRole("transcription", false)).
		Get("/transcriptions/{id}", s.handleTranscriptionGet)
	r.With(s.requireEntityParamRole("transcription", true)).
		Post("/transcriptions/{id}/parse", s.handleTranscriptionParse)
	r.With(s.requireEntityParamRole("transcription", true)).
		Post("/transcriptions/{id}/confirm", s.handleTranscriptionConfirm)
	r.With(s.requireEntityParamRole("transcription", true)).
		Post("/transcriptions/{id}/retranscribe", s.handleTranscriptionRetranscribe)
	r.With(s.requireEntityParamRole("transcription", true)).
		Post("/transcriptions/{id}/select-version", s.handleTranscriptionSelectVersion)
	r.With(s.requireEntityParamRole("transcription", true)).
		Post("/transcriptions/{id}/apply-reparse", s.handleTranscriptionApplyReparse)
	r.With(s.requireEntityParamRole("transcription", true)).
		Delete("/transcriptions/{id}", s.handleTranscriptionDelete)
}

// transcriptionRow mirrors a media_files record.
type transcriptionRow struct {
	ID                  uuid.UUID
	AudioKey            string
	TranscriptionText   *string
	Status              string
	TranscriptionError  *string
	OwnerType           string
	OwnerID             uuid.UUID
	CurrentVersionID    *uuid.UUID
	CreatedAt           time.Time
	UpdatedAt           time.Time
	CaptureID           *uuid.UUID
	Mode                string
	ObservedAt          time.Time
	TimeZone            string
	ReplacesMediaFileID *uuid.UUID
}

type transcriptVersionRow struct {
	ID             uuid.UUID
	Provider       string
	Model          *string
	PromptRevision *string
	ProducedAt     time.Time
	CreatedAt      time.Time
	Text           string
}

func (s *Server) transcriptionLoad(ctx context.Context, id uuid.UUID) (*transcriptionRow, error) {
	var row transcriptionRow
	err := s.pool.QueryRow(ctx, `
		SELECT id, audio_key, transcription_text, transcription_status, transcription_error,
		       owner_type, owner_id, current_transcript_version_id, created_at, updated_at, capture_id, capture_mode, COALESCE(observed_at,created_at), time_zone, replaces_media_file_id
		FROM media_files WHERE id = $1`, id).
		Scan(&row.ID, &row.AudioKey, &row.TranscriptionText, &row.Status, &row.TranscriptionError,
			&row.OwnerType, &row.OwnerID, &row.CurrentVersionID, &row.CreatedAt, &row.UpdatedAt, &row.CaptureID, &row.Mode, &row.ObservedAt, &row.TimeZone, &row.ReplacesMediaFileID)
	if err != nil {
		return nil, err
	}
	return &row, nil
}

func (s *Server) transcriptionVersions(ctx context.Context, mediaID uuid.UUID) ([]transcriptVersionRow, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT id, provider, model, prompt_revision, produced_at, created_at, text
		FROM transcript_versions
		WHERE media_file_id = $1
		ORDER BY produced_at DESC, created_at DESC`, mediaID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	list := []transcriptVersionRow{}
	for rows.Next() {
		var v transcriptVersionRow
		if err := rows.Scan(&v.ID, &v.Provider, &v.Model, &v.PromptRevision, &v.ProducedAt, &v.CreatedAt, &v.Text); err != nil {
			return nil, err
		}
		list = append(list, v)
	}
	return list, rows.Err()
}

func transcriptVersionJSON(v transcriptVersionRow) map[string]any {
	return map[string]any{
		"id":             v.ID,
		"provider":       v.Provider,
		"model":          v.Model,
		"promptRevision": v.PromptRevision,
		"producedAt":     v.ProducedAt,
		"createdAt":      v.CreatedAt,
		"text":           v.Text,
	}
}

func transcriptionRowJSON(row *transcriptionRow) map[string]any {
	return map[string]any{
		"id":                row.ID,
		"status":            row.Status,
		"transcriptionText": row.TranscriptionText,
		"error":             row.TranscriptionError,
		"ownerType":         row.OwnerType,
		"ownerId":           row.OwnerID,
		"currentVersionId":  row.CurrentVersionID,
		"createdAt":         row.CreatedAt,
		"updatedAt":         row.UpdatedAt,
		"captureId":         row.CaptureID, "mode": row.Mode, "observedAt": row.ObservedAt, "timeZone": row.TimeZone, "replacesMediaFileId": row.ReplacesMediaFileID,
	}
}

// transcriptionMode validates a mode string, defaulting to "single".
func transcriptionMode(mode string) (string, bool) {
	switch mode {
	case "":
		return "single", true
	case "single", "batch", "apiary":
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
	if ownerType == "hive" {
		query += ` AND id = $1`
		args = append(args, ownerID)
	} else if ownerType == "apiary" {
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
	if mode != row.Mode {
		return nil, fmt.Errorf("Recording mode cannot change; start another capture")
	}
	if row.CurrentVersionID != nil {
		var cached []byte
		if err := s.pool.QueryRow(ctx, `SELECT parsed_inspections FROM transcript_versions WHERE id=$1 AND media_file_id=$2`, *row.CurrentVersionID, row.ID).Scan(&cached); err != nil {
			return nil, err
		}
		if len(cached) > 0 {
			var matched []ai.MatchedInspection
			if err := json.Unmarshal(cached, &matched); err != nil {
				return nil, err
			}
			return map[string]any{"rawText": row.TranscriptionText, "inspections": matched}, nil
		}
	}

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
	matched := ai.MatchHiveReferences(result.Inspections, hives)
	for i := range matched {
		matched[i].ItemKey = fmt.Sprintf("item-%d", i)
		if matched[i].Scope == "" {
			matched[i].Scope = "hive"
		}
		if mode == "apiary" {
			matched[i].Scope = "apiary"
		}
		if matched[i].Scope == "apiary" {
			matched[i].MatchedHiveID = nil
		}
	}
	if row.CurrentVersionID != nil {
		encoded, err := json.Marshal(matched)
		if err != nil {
			return nil, err
		}
		var cached []byte
		if err = s.pool.QueryRow(ctx, `UPDATE transcript_versions SET parsed_inspections=COALESCE(parsed_inspections,$3::jsonb) WHERE id=$1 AND media_file_id=$2 RETURNING parsed_inspections`, *row.CurrentVersionID, row.ID, encoded).Scan(&cached); err != nil {
			return nil, err
		}
		if err = json.Unmarshal(cached, &matched); err != nil {
			return nil, err
		}
	}
	return map[string]any{"rawText": result.RawText, "inspections": matched}, nil
}

// POST /transcriptions — multipart audio upload; inserts a pending media_files
// row, stores the audio in MinIO with its detected format, and enqueues the
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
	defer r.MultipartForm.RemoveAll()
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
	mode, validMode := transcriptionMode(r.FormValue("mode"))
	if !validMode || (mode == "single" && ownerType != "hive") || (mode != "single" && ownerType != "apiary") {
		writeError(w, http.StatusBadRequest, "mode must be single or batch")
		return
	}

	data, err := io.ReadAll(file)
	if err != nil || len(data) == 0 {
		writeError(w, http.StatusBadRequest, "Audio file is required")
		return
	}
	if len(data) > transcriptionMaxUploadBytes {
		writeError(w, http.StatusBadRequest, "Audio must be under 64MB")
		return
	}
	format, err := audioformat.Detect(data)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}

	captureID := uuid.New()
	if raw := r.FormValue("captureId"); raw != "" {
		captureID, err = uuid.Parse(raw)
		if err != nil || captureID == uuid.Nil {
			writeError(w, 400, "Invalid captureId")
			return
		}
	}
	observedAt := time.Now().UTC()
	if raw := r.FormValue("observedAt"); raw != "" {
		observedAt, err = time.Parse(time.RFC3339Nano, raw)
		if err != nil || observedAt.IsZero() || observedAt.After(time.Now().Add(5*time.Minute)) {
			writeError(w, 400, "Invalid observation time")
			return
		}
	}
	zone := r.FormValue("timeZone")
	if zone == "" {
		zone = "UTC"
	}
	if _, err = time.LoadLocation(zone); err != nil {
		writeError(w, 400, "Invalid timeZone")
		return
	}
	var replaces *uuid.UUID
	if raw := r.FormValue("replacesMediaFileId"); raw != "" {
		v, e := uuid.Parse(raw)
		if e != nil {
			writeError(w, 400, "Invalid replaced recording")
			return
		}
		prior, e := s.transcriptionLoad(r.Context(), v)
		if e != nil || prior.OwnerType != ownerType || prior.OwnerID != ownerID {
			writeError(w, 400, "Replacement must have the same owner")
			return
		}
		replaces = &v
	}
	actor := actorID(r)
	if actor == nil {
		writeError(w, 401, "Sign in to save a capture")
		return
	}
	hash := fmt.Sprintf("%x", sha256.Sum256(data))
	ctx := r.Context()
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		writeError(w, 500, "database error")
		return
	}
	defer tx.Rollback(ctx)
	if _, err = tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1,0))`, actor.String()+":"+captureID.String()); err != nil {
		writeError(w, 500, "database error")
		return
	}
	id := uuid.New()
	audioKey := "audio/" + id.String() + format.Extension
	var existingHash, existingOwnerType, existingMode, existingZone string
	var existingOwner uuid.UUID
	var existingObserved time.Time
	var existingReplacement *uuid.UUID
	err = tx.QueryRow(ctx, `SELECT id,audio_sha256,owner_type,owner_id,capture_mode,observed_at,time_zone,replaces_media_file_id FROM media_files WHERE capture_actor_id=$1 AND capture_id=$2`, actor, captureID).Scan(&id, &existingHash, &existingOwnerType, &existingOwner, &existingMode, &existingObserved, &existingZone, &existingReplacement)
	if err == nil {
		sameReplacement := (replaces == nil && existingReplacement == nil) || (replaces != nil && existingReplacement != nil && *replaces == *existingReplacement)
		if hash != existingHash || ownerType != existingOwnerType || ownerID != existingOwner || mode != existingMode || zone != existingZone || !sameReplacement || (r.FormValue("observedAt") != "" && !observedAt.Truncate(time.Microsecond).Equal(existingObserved)) {
			writeError(w, 409, "Capture identity was already used for different audio or context")
			return
		}
	} else if errors.Is(err, pgx.ErrNoRows) {
		if err = s.store.Put(ctx, audioKey, bytes.NewReader(data), int64(len(data)), format.MIME); err != nil {
			writeError(w, 500, "failed to store audio")
			return
		}
		if _, err = tx.Exec(ctx, `INSERT INTO media_files(id,audio_key,transcription_status,owner_type,owner_id,capture_id,capture_actor_id,audio_sha256,capture_mode,observed_at,time_zone,replaces_media_file_id) VALUES($1,$2,'pending',$3,$4,$5,$6,$7,$8,$9,$10,$11)`, id, audioKey, ownerType, ownerID, captureID, actor, hash, mode, observedAt, zone, replaces); err != nil {
			writeError(w, 500, "database error")
			return
		}
	} else {
		writeError(w, 500, "database error")
		return
	}
	if err = tx.Commit(ctx); err != nil {
		writeError(w, 500, "database error")
		return
	}
	// Replaying a completed capture returns its existing result without another job.
	var status string
	if err = s.pool.QueryRow(ctx, `SELECT transcription_status FROM media_files WHERE id=$1`, id).Scan(&status); err != nil {
		writeError(w, 500, "database error")
		return
	}
	if status == "complete" || status == "processing" {
		writeJSON(w, 200, map[string]any{"mediaFileId": id})
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
		       owner_type, owner_id, current_transcript_version_id, created_at, updated_at, capture_id, capture_mode, COALESCE(observed_at,created_at), time_zone, replaces_media_file_id
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
			&row.TranscriptionError, &row.OwnerType, &row.OwnerID, &row.CurrentVersionID,
			&row.CreatedAt, &row.UpdatedAt, &row.CaptureID, &row.Mode, &row.ObservedAt, &row.TimeZone, &row.ReplacesMediaFileID); err != nil {
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
	if r.URL.Query().Get("mode") == "" {
		mode = row.Mode
	}
	resp := transcriptionRowJSON(row)
	outcomes, receiptErr := s.transcriptionOutcomes(r.Context(), row.ID)
	if receiptErr != nil {
		writeError(w, 500, "database error")
		return
	}
	resp["outcomes"] = outcomes
	versions, err := s.transcriptionVersions(r.Context(), row.ID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	versionJSON := make([]map[string]any, 0, len(versions))
	for _, v := range versions {
		versionJSON = append(versionJSON, transcriptVersionJSON(v))
	}
	resp["versions"] = versionJSON
	if row.Status == "complete" && row.TranscriptionText != nil && *row.TranscriptionText != "" {
		parsed, err := s.transcriptionParseAndMatch(r.Context(), row, mode)
		if err != nil {
			resp["parseError"] = err.Error()
		} else {
			if inspections, ok := parsed["inspections"].([]ai.MatchedInspection); ok {
				if diff, derr := s.transcriptionReparseDiff(r.Context(), row.ID, inspections); derr == nil {
					parsed["diff"] = diff
				}
			}
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
		Mode      string     `json:"mode"`
		VersionID *uuid.UUID `json:"versionId"`
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
	if req.Mode == "" {
		mode = row.Mode
	}
	if req.VersionID != nil {
		text, err := s.transcriptionVersionText(r.Context(), id, *req.VersionID)
		if err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
		row.TranscriptionText = &text
		row.CurrentVersionID = req.VersionID
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
	if inspections, ok := parsed["inspections"].([]ai.MatchedInspection); ok {
		diff, derr := s.transcriptionReparseDiff(r.Context(), row.ID, inspections)
		if derr != nil {
			writeError(w, http.StatusInternalServerError, "database error")
			return
		}
		parsed["diff"] = diff
	}
	writeJSON(w, http.StatusOK, parsed)
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
