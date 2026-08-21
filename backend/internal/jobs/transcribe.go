package jobs

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os"
	"time"

	"github.com/google/uuid"
	"github.com/hibiken/asynq"
	"github.com/jackc/pgx/v5"

	"github.com/biker2000on/beez-trackz/backend/internal/ai"
)

// transcriptionAlreadyComplete is true when a later asynq delivery must not
// call the provider or overwrite the stored text — unless this is an explicit
// re-transcribe (Force), which writes a new version instead.
func transcriptionAlreadyComplete(status string, text *string) bool {
	return status == "complete" && text != nil && *text != ""
}

// transcribeIncompleteSQL matches rows that are still allowed to be claimed
// or overwritten. A complete transcript is left alone.
const transcribeIncompleteSQL = `NOT (transcription_status = 'complete' AND COALESCE(transcription_text, '') <> '')`

const (
	transcribeLockSQL   = `SELECT pg_advisory_lock(hashtextextended($1::text, 20260821))`
	transcribeUnlockSQL = `SELECT pg_advisory_unlock(hashtextextended($1::text, 20260821))`
)

type transcribeConfigQuerier interface {
	QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
}

// loadTranscribeConfigOn mirrors ai.LoadConfig on the worker's dedicated
// advisory-lock connection. Querying through h.pool while all four workers
// hold such a connection can exhaust a small pool and deadlock the workers.
func loadTranscribeConfigOn(ctx context.Context, q transcribeConfigQuerier) (*ai.AIProviderConfig, error) {
	var raw []byte
	err := q.QueryRow(ctx, `SELECT ai_provider_config FROM user_settings LIMIT 1`).Scan(&raw)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return nil, fmt.Errorf("load ai config: %w", err)
	}
	cfg := ai.ParseConfig(raw)
	if cfg.APIKeys.Anthropic == "" {
		cfg.APIKeys.Anthropic = os.Getenv("ANTHROPIC_API_KEY")
	}
	if cfg.APIKeys.Google == "" {
		cfg.APIKeys.Google = os.Getenv("GOOGLE_AI_API_KEY")
	}
	if cfg.APIKeys.OllamaURL == "" {
		cfg.APIKeys.OllamaURL = os.Getenv("OLLAMA_URL")
	}
	if cfg.APIKeys.WhisperURL == "" {
		cfg.APIKeys.WhisperURL = os.Getenv("WHISPER_URL")
	}
	return cfg, nil
}

// handleTranscribeAudio downloads the recording from MinIO, transcribes it with
// the configured provider, and stores the text as a new transcript_versions
// row. The first complete text is never overwritten in place: a late retry is
// a no-op, and a re-transcribe (Force) inserts another version.
func (h *Handlers) handleTranscribeAudio(ctx context.Context, t *asynq.Task) error {
	var p TranscribeAudioPayload
	if err := json.Unmarshal(t.Payload(), &p); err != nil {
		return fmt.Errorf("transcribe payload: %v: %w", err, asynq.SkipRetry)
	}

	// Session advisory locks serialize every delivery for one recording. This
	// covers an asynq retry overlapping another delivery without holding a
	// database transaction open during the provider call.
	conn, err := h.pool.Acquire(ctx)
	if err != nil {
		return fmt.Errorf("transcribe: acquire connection: %w", err)
	}
	locked := false
	defer func() {
		if locked {
			unlockCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			var unlocked bool
			if err := conn.QueryRow(unlockCtx, transcribeUnlockSQL, p.RecordingID).Scan(&unlocked); err != nil || !unlocked {
				// Never return a session with a possibly-held advisory lock to
				// the pool. Closing the hijacked connection releases the lock.
				raw := conn.Hijack()
				_ = raw.Close(unlockCtx)
				return
			}
		}
		conn.Release()
	}()
	if _, err := conn.Exec(ctx, transcribeLockSQL, p.RecordingID); err != nil {
		return fmt.Errorf("transcribe: acquire recording lock: %w", err)
	}
	locked = true

	var audioKey string
	var hadComplete bool
	err = conn.QueryRow(ctx, `
		UPDATE media_files
		SET transcription_status = 'processing', transcription_error = NULL
		WHERE id = $1
		  AND (($2::boolean AND retranscription_requested_at IS NOT NULL)
		    OR (NOT $2::boolean AND retranscription_requested_at IS NULL AND `+transcribeIncompleteSQL+`))
		RETURNING audio_key, COALESCE(transcription_text, '') <> ''`, p.RecordingID, p.Force).
		Scan(&audioKey, &hadComplete)
	if errors.Is(err, pgx.ErrNoRows) {
		var status string
		var existing *string
		var retranscriptionPending bool
		lookup := conn.QueryRow(ctx, `
			SELECT transcription_status, transcription_text,
			       retranscription_requested_at IS NOT NULL
			FROM media_files WHERE id = $1`,
			p.RecordingID)
		if lerr := lookup.Scan(&status, &existing, &retranscriptionPending); errors.Is(lerr, pgx.ErrNoRows) {
			slog.Warn("transcribe: media file not found", "recordingId", p.RecordingID)
			return fmt.Errorf("media file %s not found: %w", p.RecordingID, asynq.SkipRetry)
		} else if lerr != nil {
			return fmt.Errorf("transcribe: lookup: %w", lerr)
		}
		if p.Force && !retranscriptionPending {
			slog.Info("transcribe: forced delivery already completed, skipping", "recordingId", p.RecordingID)
			return nil
		}
		if !p.Force && retranscriptionPending {
			slog.Info("transcribe: original retry superseded by re-transcribe, skipping", "recordingId", p.RecordingID)
			return nil
		}
		if !p.Force && transcriptionAlreadyComplete(status, existing) {
			slog.Info("transcribe: already complete, skipping", "recordingId", p.RecordingID)
			return nil
		}
		return fmt.Errorf("transcribe: mark processing: no claimable row")
	}
	if err != nil {
		return fmt.Errorf("transcribe: mark processing: %w", err)
	}

	fail := func(cause error) error {
		// Detached from the job context: if the final retry's context was
		// canceled, writing the failure on it would itself fail and strand
		// the row in 'processing' forever. Do not clobber a complete
		// transcript written by a concurrent delivery.
		writeCtx, cancel := context.WithTimeout(
			context.WithoutCancel(ctx), 10*time.Second)
		defer cancel()
		if hadComplete {
			// Re-transcribe failed: restore complete and keep the old text.
			if _, uerr := conn.Exec(writeCtx, `
				UPDATE media_files
				SET transcription_status = 'complete', transcription_error = $2
				WHERE id = $1 AND COALESCE(transcription_text, '') <> ''`,
				p.RecordingID, cause.Error()); uerr != nil {
				slog.Error("transcribe: failed to record error", "recordingId", p.RecordingID, "err", uerr)
			}
			return cause
		}
		if _, uerr := conn.Exec(writeCtx, `
			UPDATE media_files
			SET transcription_status = 'failed', transcription_error = $2
			WHERE id = $1 AND `+transcribeIncompleteSQL,
			p.RecordingID, cause.Error()); uerr != nil {
			slog.Error("transcribe: failed to record error", "recordingId", p.RecordingID, "err", uerr)
		}
		return cause
	}

	obj, err := h.store.Get(ctx, audioKey)
	if err != nil {
		return fail(fmt.Errorf("download audio: %w", err))
	}
	audio, err := io.ReadAll(obj)
	obj.Close()
	if err != nil {
		return fail(fmt.Errorf("download audio: %w", err))
	}

	cfg, err := loadTranscribeConfigOn(ctx, conn)
	if err != nil {
		return fail(err)
	}
	provider, err := ai.ProviderForTask(cfg, ai.TaskTranscription)
	if err != nil {
		return fail(err)
	}

	text, err := provider.Transcribe(ctx, audio, "audio/webm")
	if err != nil {
		return fail(err)
	}

	mediaID, err := uuid.Parse(p.RecordingID)
	if err != nil {
		return fail(fmt.Errorf("recording id: %w", err))
	}
	model := cfg.Transcription.Model
	var modelArg any
	if model != "" {
		modelArg = model
	}
	// Linearize completion with the API's retranscription_requested_at update. If
	// the operator requested a forced pass while an original retry was using
	// the provider, discard that stale result instead of creating two versions.
	tx, err := conn.Begin(ctx)
	if err != nil {
		return fail(fmt.Errorf("begin transcript completion: %w", err))
	}
	defer func() { _ = tx.Rollback(context.Background()) }()
	abortCompletion := func(cause error) error {
		rollbackCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = tx.Rollback(rollbackCtx)
		return fail(cause)
	}
	var retranscriptionPending bool
	if err := tx.QueryRow(ctx, `
		SELECT retranscription_requested_at IS NOT NULL
		FROM media_files WHERE id = $1 FOR UPDATE`,
		mediaID).Scan(&retranscriptionPending); err != nil {
		return abortCompletion(fmt.Errorf("lock transcript completion: %w", err))
	}
	if (!p.Force && retranscriptionPending) || (p.Force && !retranscriptionPending) {
		if err := tx.Rollback(ctx); err != nil {
			return abortCompletion(fmt.Errorf("cancel superseded transcription: %w", err))
		}
		slog.Info("transcribe: delivery superseded before completion, skipping",
			"recordingId", p.RecordingID, "force", p.Force)
		return nil
	}

	var versionID uuid.UUID
	err = tx.QueryRow(ctx, `
		INSERT INTO transcript_versions
			(media_file_id, provider, model, prompt_revision, produced_at, text)
		VALUES ($1, $2, $3, $4, now(), $5)
		RETURNING id`,
		mediaID, cfg.Transcription.Provider, modelArg, ai.STTPromptRevision, text).
		Scan(&versionID)
	if err != nil {
		return abortCompletion(fmt.Errorf("save transcript version: %w", err))
	}

	if _, err := tx.Exec(ctx, `
		UPDATE media_files
		SET transcription_status = 'complete',
		    transcription_text = $2,
		    transcription_error = NULL,
		    current_transcript_version_id = $3,
		    retranscription_requested_at = CASE
		      WHEN $4::boolean THEN NULL ELSE retranscription_requested_at END
		WHERE id = $1`,
		p.RecordingID, text, versionID, p.Force); err != nil {
		return abortCompletion(fmt.Errorf("save transcription: %w", err))
	}
	if err := tx.Commit(ctx); err != nil {
		return fail(fmt.Errorf("commit transcription: %w", err))
	}
	slog.Info("transcribe: complete", "recordingId", p.RecordingID,
		"versionId", versionID, "chars", len(text), "force", p.Force)
	return nil
}
