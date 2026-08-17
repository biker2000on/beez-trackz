package jobs

import (
	"context"
	"os"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/hibiken/asynq"

	"github.com/biker2000on/beez-trackz/backend/internal/db"
)

func TestTranscribeTaskID(t *testing.T) {
	id := "abc-123"
	if got := TranscribeTaskID(id); got != "transcribe:"+id {
		t.Fatalf("TranscribeTaskID = %q", got)
	}
	task, err := NewTranscribeAudioTask(id)
	if err != nil {
		t.Fatalf("NewTranscribeAudioTask: %v", err)
	}
	if task.Type() != TypeTranscribeAudio {
		t.Fatalf("type = %q, want %q", task.Type(), TypeTranscribeAudio)
	}
}

func TestTranscriptionAlreadyComplete(t *testing.T) {
	text := "hello hive"
	empty := ""
	if !transcriptionAlreadyComplete("complete", &text) {
		t.Fatal("complete + text should skip")
	}
	if transcriptionAlreadyComplete("complete", &empty) {
		t.Fatal("complete + empty text should not skip")
	}
	if transcriptionAlreadyComplete("complete", nil) {
		t.Fatal("complete + nil text should not skip")
	}
	if transcriptionAlreadyComplete("processing", &text) {
		t.Fatal("processing should not skip")
	}
	if transcriptionAlreadyComplete("pending", &text) {
		t.Fatal("pending should not skip")
	}
}

func TestHandleTranscribeAudioSkipsCompleteTranscript(t *testing.T) {
	databaseURL := os.Getenv("TEST_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("TEST_DATABASE_URL is not configured")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	t.Cleanup(cancel)

	pool, err := db.Connect(ctx, databaseURL)
	if err != nil {
		t.Fatalf("connect test database: %v", err)
	}

	id := uuid.New()
	const original = "original good transcript"
	if _, err := pool.Exec(ctx, `
		INSERT INTO media_files (id, audio_key, transcription_status, transcription_text, owner_type, owner_id)
		VALUES ($1,'audio/skip-test.webm','complete',$2,'hive',$3)`,
		id, original, uuid.New()); err != nil {
		t.Fatalf("insert media file: %v", err)
	}
	t.Cleanup(func() {
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cleanupCancel()
		_, _ = pool.Exec(cleanupCtx, `DELETE FROM media_files WHERE id=$1`, id)
	})

	h := &Handlers{pool: pool}
	task := asynq.NewTask(TypeTranscribeAudio, mustJSON(t, TranscribeAudioPayload{RecordingID: id.String()}))
	if err := h.handleTranscribeAudio(ctx, task); err != nil {
		t.Fatalf("handleTranscribeAudio: %v", err)
	}

	var status, text string
	if err := pool.QueryRow(ctx,
		`SELECT transcription_status, transcription_text FROM media_files WHERE id=$1`, id).
		Scan(&status, &text); err != nil {
		t.Fatalf("reread: %v", err)
	}
	if status != "complete" || text != original {
		t.Fatalf("row = %s %q, want complete %q", status, text, original)
	}
}

func mustJSON(t *testing.T, payload TranscribeAudioPayload) []byte {
	t.Helper()
	task, err := NewTranscribeAudioTask(payload.RecordingID)
	if err != nil {
		t.Fatalf("payload: %v", err)
	}
	return task.Payload()
}
