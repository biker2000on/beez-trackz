package httpapi

import (
	"testing"

	"github.com/google/uuid"
)

// The retranscribe intent claim is the race guard: exactly one request may
// stamp retranscription_requested_at while the recording is idle, a second
// concurrent claim must touch zero rows, and a claim stranded by a crash
// becomes claimable again after the 15-minute window.
func TestRetranscribeIntentClaim(t *testing.T) {
	fixture := newHiveScopeFixture(t)
	ctx := fixture.ctx
	pool := fixture.server.pool

	mediaID := uuid.New()
	if _, err := pool.Exec(ctx, `
		INSERT INTO media_files (id, audio_key, transcription_status, transcription_text, owner_type, owner_id)
		VALUES ($1, 'audio/race.webm', 'complete', 'checked brood', 'hive', $2)`,
		mediaID, fixture.hiveA); err != nil {
		t.Fatalf("insert media: %v", err)
	}
	t.Cleanup(func() {
		_, _ = pool.Exec(ctx, `DELETE FROM media_files WHERE id=$1`, mediaID)
	})

	const claim = `
		UPDATE media_files
		SET retranscription_requested_at = now()
		WHERE id = $1
		  AND transcription_status NOT IN ('pending', 'processing')
		  AND (retranscription_requested_at IS NULL
		    OR retranscription_requested_at < now() - interval '15 minutes')`

	tag, err := pool.Exec(ctx, claim, mediaID)
	if err != nil {
		t.Fatalf("first claim: %v", err)
	}
	if tag.RowsAffected() != 1 {
		t.Fatalf("first claim affected %d rows, want 1", tag.RowsAffected())
	}

	// A second request inside the window claims nothing — the HTTP handler
	// turns this into a 409.
	tag, err = pool.Exec(ctx, claim, mediaID)
	if err != nil {
		t.Fatalf("second claim: %v", err)
	}
	if tag.RowsAffected() != 0 {
		t.Fatalf("second claim affected %d rows, want 0", tag.RowsAffected())
	}

	// A processing recording is never claimable, even with a stale flag.
	if _, err := pool.Exec(ctx, `
		UPDATE media_files
		SET transcription_status='processing',
		    retranscription_requested_at = now() - interval '20 minutes'
		WHERE id=$1`, mediaID); err != nil {
		t.Fatalf("set processing: %v", err)
	}
	tag, err = pool.Exec(ctx, claim, mediaID)
	if err != nil {
		t.Fatalf("processing claim: %v", err)
	}
	if tag.RowsAffected() != 0 {
		t.Fatalf("processing claim affected %d rows, want 0", tag.RowsAffected())
	}

	// A crash-stranded flag (idle status, stale timestamp) is claimable again.
	if _, err := pool.Exec(ctx, `
		UPDATE media_files SET transcription_status='complete' WHERE id=$1`, mediaID); err != nil {
		t.Fatalf("set complete: %v", err)
	}
	tag, err = pool.Exec(ctx, claim, mediaID)
	if err != nil {
		t.Fatalf("stale reclaim: %v", err)
	}
	if tag.RowsAffected() != 1 {
		t.Fatalf("stale reclaim affected %d rows, want 1", tag.RowsAffected())
	}
}
