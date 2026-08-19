package httpapi

import (
	"net/http"
	"testing"

	"github.com/google/uuid"

	"github.com/biker2000on/beez-trackz/backend/internal/ai"
)

// An editor on apiary A must not be able to accept a re-parse "create"
// proposal that targets a hive in apiary B, for any row kind.
func TestApplyReparseCreateRequiresEditRoleOnTargetHive(t *testing.T) {
	fixture := newHiveScopeFixture(t)
	ctx := fixture.ctx
	pool := fixture.server.pool

	mediaID := uuid.New()
	if _, err := pool.Exec(ctx, `
		INSERT INTO media_files (id, audio_key, transcription_status, transcription_text, owner_type, owner_id)
		VALUES ($1, 'audio/scope.webm', 'complete', 'fed syrup', 'hive', $2)`,
		mediaID, fixture.hiveA); err != nil {
		t.Fatalf("insert media: %v", err)
	}
	var versionID uuid.UUID
	if err := pool.QueryRow(ctx, `
		INSERT INTO transcript_versions (media_file_id, provider, prompt_revision, text)
		VALUES ($1, 'gemini', 'stt-v1', 'fed syrup') RETURNING id`, mediaID).Scan(&versionID); err != nil {
		t.Fatalf("insert version: %v", err)
	}
	if _, err := pool.Exec(ctx, `
		UPDATE media_files SET current_transcript_version_id=$2 WHERE id=$1`, mediaID, versionID); err != nil {
		t.Fatalf("set version: %v", err)
	}
	t.Cleanup(func() {
		_, _ = pool.Exec(ctx, `DELETE FROM feedings WHERE source_media_file_id=$1`, mediaID)
		_, _ = pool.Exec(ctx, `DELETE FROM treatment_events WHERE source_media_file_id=$1`, mediaID)
		_, _ = pool.Exec(ctx, `DELETE FROM mite_counts WHERE source_media_file_id=$1`, mediaID)
		_, _ = pool.Exec(ctx, `UPDATE media_files SET current_transcript_version_id=NULL WHERE id=$1`, mediaID)
		_, _ = pool.Exec(ctx, `DELETE FROM media_files WHERE id=$1`, mediaID)
	})

	target := "/api/v1/transcriptions/" + mediaID.String() + "/apply-reparse"
	params := map[string]string{"id": mediaID.String()}

	accept := []map[string]any{
		{"kind": "feeding", "hiveId": fixture.hiveB.String(),
			"fields": ai.Feeding{Type: "sugar_syrup_1to1", Quantity: 1, QuantityUnit: "lbs"}},
		{"kind": "treatment", "hiveId": fixture.hiveB.String(),
			"fields": ai.Treatment{Product: "Apivar", Method: ptr("strips")}},
		{"kind": "mite_count", "hiveId": fixture.hiveB.String(),
			"fields": ai.MiteCount{Method: "alcohol_wash", MitesCount: 3, SampleSize: ptr(300)}},
	}
	for _, item := range accept {
		resp := fixture.call(t, fixture.server.handleTranscriptionApplyReparse,
			http.MethodPost, target, map[string]any{"accept": []map[string]any{item}}, params)
		if resp.Code != http.StatusForbidden {
			t.Fatalf("%s create on apiary B hive = %d %s, want 403", item["kind"], resp.Code, resp.Body.String())
		}
	}

	// Same proposal against the editor's own hive is accepted, and a nil
	// hiveId falls back to the media owner (single-mode behaviour).
	resp := fixture.call(t, fixture.server.handleTranscriptionApplyReparse,
		http.MethodPost, target, map[string]any{"accept": []map[string]any{
			{"kind": "feeding", "fields": ai.Feeding{Type: "sugar_syrup_1to1", Quantity: 1, QuantityUnit: "lbs"}},
		}}, params)
	if resp.Code != http.StatusOK {
		t.Fatalf("feeding create on owner hive = %d %s, want 200", resp.Code, resp.Body.String())
	}
	var hiveID uuid.UUID
	if err := pool.QueryRow(ctx, `SELECT hive_id FROM feedings WHERE source_media_file_id=$1`, mediaID).
		Scan(&hiveID); err != nil {
		t.Fatalf("load feeding: %v", err)
	}
	if hiveID != fixture.hiveA {
		t.Fatalf("feeding hive = %s, want owner hive %s", hiveID, fixture.hiveA)
	}
}
