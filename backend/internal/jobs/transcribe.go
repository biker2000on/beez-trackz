package jobs

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"time"

	"github.com/hibiken/asynq"
	"github.com/jackc/pgx/v5"

	"github.com/biker2000on/beez-trackz/backend/internal/ai"
)

// transcriptionAlreadyComplete is true when a later asynq delivery must not
// call the provider or overwrite the stored text.
func transcriptionAlreadyComplete(status string, text *string) bool {
	return status == "complete" && text != nil && *text != ""
}

// transcribeIncompleteSQL matches rows that are still allowed to be claimed
// or overwritten. A complete transcript is left alone.
const transcribeIncompleteSQL = `NOT (transcription_status = 'complete' AND COALESCE(transcription_text, '') <> '')`

// handleTranscribeAudio downloads the recording from MinIO, transcribes it with
// the configured provider, and stores the text. Errors mark the row failed and
// are returned so asynq retries (MaxRetry set at enqueue). A late retry of an
// already-complete transcript is a no-op.
func (h *Handlers) handleTranscribeAudio(ctx context.Context, t *asynq.Task) error {
	var p TranscribeAudioPayload
	if err := json.Unmarshal(t.Payload(), &p); err != nil {
		return fmt.Errorf("transcribe payload: %v: %w", err, asynq.SkipRetry)
	}

	var audioKey string
	err := h.pool.QueryRow(ctx, `
		UPDATE media_files
		SET transcription_status = 'processing', transcription_error = NULL
		WHERE id = $1 AND `+transcribeIncompleteSQL+`
		RETURNING audio_key`, p.RecordingID).Scan(&audioKey)
	if errors.Is(err, pgx.ErrNoRows) {
		var status string
		var existing *string
		lookup := h.pool.QueryRow(ctx, `
			SELECT transcription_status, transcription_text FROM media_files WHERE id = $1`,
			p.RecordingID)
		if lerr := lookup.Scan(&status, &existing); errors.Is(lerr, pgx.ErrNoRows) {
			slog.Warn("transcribe: media file not found", "recordingId", p.RecordingID)
			return fmt.Errorf("media file %s not found: %w", p.RecordingID, asynq.SkipRetry)
		} else if lerr != nil {
			return fmt.Errorf("transcribe: lookup: %w", lerr)
		}
		if transcriptionAlreadyComplete(status, existing) {
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
		if _, uerr := h.pool.Exec(writeCtx, `
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

	cfg, err := ai.LoadConfig(ctx, h.pool)
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

	if _, err := h.pool.Exec(ctx, `
		UPDATE media_files
		SET transcription_status = 'complete', transcription_text = $2, transcription_error = NULL
		WHERE id = $1 AND `+transcribeIncompleteSQL, p.RecordingID, text); err != nil {
		return fail(fmt.Errorf("save transcription: %w", err))
	}
	slog.Info("transcribe: complete", "recordingId", p.RecordingID, "chars", len(text))
	return nil
}
