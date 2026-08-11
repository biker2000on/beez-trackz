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

// handleTranscribeAudio downloads the recording from MinIO, transcribes it with
// the configured provider, and stores the text. Errors mark the row failed and
// are returned so asynq retries (MaxRetry set at enqueue).
func (h *Handlers) handleTranscribeAudio(ctx context.Context, t *asynq.Task) error {
	var p TranscribeAudioPayload
	if err := json.Unmarshal(t.Payload(), &p); err != nil {
		return fmt.Errorf("transcribe payload: %v: %w", err, asynq.SkipRetry)
	}

	var audioKey string
	err := h.pool.QueryRow(ctx, `
		UPDATE media_files
		SET transcription_status = 'processing', transcription_error = NULL
		WHERE id = $1
		RETURNING audio_key`, p.RecordingID).Scan(&audioKey)
	if errors.Is(err, pgx.ErrNoRows) {
		slog.Warn("transcribe: media file not found", "recordingId", p.RecordingID)
		return fmt.Errorf("media file %s not found: %w", p.RecordingID, asynq.SkipRetry)
	}
	if err != nil {
		return fmt.Errorf("transcribe: mark processing: %w", err)
	}

	fail := func(cause error) error {
		// Detached from the job context: if the final retry's context was
		// canceled, writing the failure on it would itself fail and strand
		// the row in 'processing' forever.
		writeCtx, cancel := context.WithTimeout(
			context.WithoutCancel(ctx), 10*time.Second)
		defer cancel()
		if _, uerr := h.pool.Exec(writeCtx, `
			UPDATE media_files
			SET transcription_status = 'failed', transcription_error = $2
			WHERE id = $1`, p.RecordingID, cause.Error()); uerr != nil {
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
		WHERE id = $1`, p.RecordingID, text); err != nil {
		return fail(fmt.Errorf("save transcription: %w", err))
	}
	slog.Info("transcribe: complete", "recordingId", p.RecordingID, "chars", len(text))
	return nil
}
