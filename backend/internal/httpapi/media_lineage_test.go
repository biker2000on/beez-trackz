package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/google/uuid"

	"github.com/biker2000on/beez-trackz/backend/internal/ai"
)

func TestSourceAudioDeleteRefusesWhileDomainRowsPointAtIt(t *testing.T) {
	server := honeyTestServer(t)
	ctx := context.Background()
	apiaryID, hiveID := insertMediaTestHive(t, server)

	mediaID := uuid.New()
	if _, err := server.pool.Exec(ctx, `
		INSERT INTO media_files (id, audio_key, transcription_status, transcription_text, owner_type, owner_id)
		VALUES ($1, 'audio/test.webm', 'complete', 'queen seen', 'hive', $2)`,
		mediaID, hiveID); err != nil {
		t.Fatalf("insert media: %v", err)
	}
	var versionID uuid.UUID
	if err := server.pool.QueryRow(ctx, `
		INSERT INTO transcript_versions (media_file_id, provider, prompt_revision, text)
		VALUES ($1, 'gemini', 'stt-v1', 'queen seen') RETURNING id`, mediaID).Scan(&versionID); err != nil {
		t.Fatalf("insert version: %v", err)
	}
	if _, err := server.pool.Exec(ctx, `
		UPDATE media_files SET current_transcript_version_id=$2 WHERE id=$1`, mediaID, versionID); err != nil {
		t.Fatalf("set current version: %v", err)
	}

	source, _ := json.Marshal(map[string]any{"mediaFileId": mediaID.String(), "rawText": "queen seen"})
	var inspectionID uuid.UUID
	if err := server.pool.QueryRow(ctx, `
		INSERT INTO inspections (hive_id, date, notes, source_media, source_media_file_id, source_transcript_version_id)
		VALUES ($1, now(), 'ok', $2, $3, $4) RETURNING id`,
		hiveID, source, mediaID, versionID).Scan(&inspectionID); err != nil {
		t.Fatalf("insert inspection: %v", err)
	}
	if _, err := server.pool.Exec(ctx, `
		INSERT INTO feedings
			(hive_id, date_fed, type, quantity, quantity_unit, notes,
			 source_media_file_id, source_transcript_version_id,
			 status, closed_at, closed_reason, date_empty)
		VALUES ($1, now(), 'fondant', 1, 'lbs', 'from tape', $2, $3,
			'closed', now(), 'not_installed', now())`,
		hiveID, mediaID, versionID); err != nil {
		t.Fatalf("insert feeding: %v", err)
	}

	t.Cleanup(func() {
		_, _ = server.pool.Exec(ctx, `DELETE FROM feedings WHERE source_media_file_id=$1`, mediaID)
		_, _ = server.pool.Exec(ctx, `DELETE FROM inspections WHERE id=$1`, inspectionID)
		_, _ = server.pool.Exec(ctx, `UPDATE media_files SET current_transcript_version_id=NULL WHERE id=$1`, mediaID)
		_, _ = server.pool.Exec(ctx, `DELETE FROM media_files WHERE id=$1`, mediaID)
		_, _ = server.pool.Exec(ctx, `DELETE FROM hives WHERE id=$1`, hiveID)
		_, _ = server.pool.Exec(ctx, `DELETE FROM apiaries WHERE id=$1`, apiaryID)
	})

	resp, body := call(t, server.handleTranscriptionDelete,
		adminRequest(http.MethodDelete, "/api/v1/transcriptions/"+mediaID.String(), nil, "id", mediaID.String()))
	if resp.Code != http.StatusConflict {
		t.Fatalf("delete while pointed = %d %s, want 409", resp.Code, resp.Body.String())
	}
	if body["error"] == nil {
		t.Fatal("expected conflict error")
	}

	if _, err := server.pool.Exec(ctx, `DELETE FROM feedings WHERE source_media_file_id=$1`, mediaID); err != nil {
		t.Fatalf("delete feeding: %v", err)
	}
	if _, err := server.pool.Exec(ctx, `DELETE FROM inspections WHERE id=$1`, inspectionID); err != nil {
		t.Fatalf("delete inspection: %v", err)
	}

	resp, _ = call(t, server.handleTranscriptionDelete,
		adminRequest(http.MethodDelete, "/api/v1/transcriptions/"+mediaID.String(), nil, "id", mediaID.String()))
	if resp.Code != http.StatusOK {
		t.Fatalf("delete after unlink = %d %s, want 200", resp.Code, resp.Body.String())
	}
	var leftover int
	if err := server.pool.QueryRow(ctx, `SELECT count(*) FROM media_files WHERE id=$1`, mediaID).Scan(&leftover); err != nil {
		t.Fatalf("count media: %v", err)
	}
	if leftover != 0 {
		t.Fatal("media row survived delete")
	}
}

func TestConfirmWritesLineageAndRefusesSilentRewrite(t *testing.T) {
	server := honeyTestServer(t)
	ctx := context.Background()
	apiaryID, hiveID := insertMediaTestHive(t, server)

	mediaID := uuid.New()
	if _, err := server.pool.Exec(ctx, `
		INSERT INTO media_files (id, audio_key, transcription_status, transcription_text, owner_type, owner_id)
		VALUES ($1, 'audio/lineage.webm', 'complete', 'fed fondant', 'hive', $2)`,
		mediaID, hiveID); err != nil {
		t.Fatalf("insert media: %v", err)
	}
	var versionID uuid.UUID
	if err := server.pool.QueryRow(ctx, `
		INSERT INTO transcript_versions (media_file_id, provider, prompt_revision, text)
		VALUES ($1, 'gemini', 'stt-v1', 'fed fondant') RETURNING id`, mediaID).Scan(&versionID); err != nil {
		t.Fatalf("insert version: %v", err)
	}
	if _, err := server.pool.Exec(ctx, `
		UPDATE media_files SET current_transcript_version_id=$2 WHERE id=$1`, mediaID, versionID); err != nil {
		t.Fatalf("set version: %v", err)
	}
	t.Cleanup(func() {
		_, _ = server.pool.Exec(ctx, `DELETE FROM feedings WHERE source_media_file_id=$1`, mediaID)
		_, _ = server.pool.Exec(ctx, `DELETE FROM inspections WHERE source_media_file_id=$1`, mediaID)
		_, _ = server.pool.Exec(ctx, `UPDATE media_files SET current_transcript_version_id=NULL WHERE id=$1`, mediaID)
		_, _ = server.pool.Exec(ctx, `DELETE FROM media_files WHERE id=$1`, mediaID)
		_, _ = server.pool.Exec(ctx, `DELETE FROM hives WHERE id=$1`, hiveID)
		_, _ = server.pool.Exec(ctx, `DELETE FROM apiaries WHERE id=$1`, apiaryID)
	})

	notes := "first pass"
	resp, body := call(t, server.handleTranscriptionConfirm, adminRequest(
		http.MethodPost, "/api/v1/transcriptions/"+mediaID.String()+"/confirm",
		map[string]any{
			"mode": "single",
			"inspections": []map[string]any{{
				"hiveId": hiveID.String(),
				"notes":  notes,
				"feedings": []map[string]any{{
					"type": "fondant", "quantity": 1, "quantityUnit": "lbs",
				}},
			}},
		}, "id", mediaID.String()))
	if resp.Code != http.StatusOK {
		t.Fatalf("confirm = %d %s", resp.Code, resp.Body.String())
	}
	if body["success"] != true {
		t.Fatalf("confirm body = %#v", body)
	}

	var gotMedia, gotVersion uuid.UUID
	if err := server.pool.QueryRow(ctx, `
		SELECT source_media_file_id, source_transcript_version_id
		FROM inspections WHERE source_media_file_id=$1`, mediaID).
		Scan(&gotMedia, &gotVersion); err != nil {
		t.Fatalf("inspection lineage: %v", err)
	}
	if gotMedia != mediaID || gotVersion != versionID {
		t.Fatalf("inspection lineage = %s %s", gotMedia, gotVersion)
	}
	if err := server.pool.QueryRow(ctx, `
		SELECT source_media_file_id, source_transcript_version_id
		FROM feedings WHERE source_media_file_id=$1`, mediaID).
		Scan(&gotMedia, &gotVersion); err != nil {
		t.Fatalf("feeding lineage: %v", err)
	}
	if gotMedia != mediaID || gotVersion != versionID {
		t.Fatalf("feeding lineage = %s %s", gotMedia, gotVersion)
	}

	resp, _ = call(t, server.handleTranscriptionConfirm, adminRequest(
		http.MethodPost, "/api/v1/transcriptions/"+mediaID.String()+"/confirm",
		map[string]any{
			"mode": "single",
			"inspections": []map[string]any{{
				"hiveId": hiveID.String(),
				"notes":  "second walkthrough",
			}},
		}, "id", mediaID.String()))
	if resp.Code != http.StatusConflict {
		t.Fatalf("second confirm = %d %s, want 409", resp.Code, resp.Body.String())
	}

	var inspectionID uuid.UUID
	var currentNotes *string
	if err := server.pool.QueryRow(ctx, `
		SELECT id, notes FROM inspections WHERE source_media_file_id=$1`, mediaID).
		Scan(&inspectionID, &currentNotes); err != nil {
		t.Fatalf("load inspection: %v", err)
	}

	// Empty accept is a no-op and must not rewrite.
	resp, body = call(t, server.handleTranscriptionApplyReparse, adminRequest(
		http.MethodPost, "/api/v1/transcriptions/"+mediaID.String()+"/apply-reparse",
		map[string]any{"accept": []any{}}, "id", mediaID.String()))
	if resp.Code != http.StatusOK {
		t.Fatalf("empty apply = %d %s", resp.Code, resp.Body.String())
	}
	var notesAfter string
	if err := server.pool.QueryRow(ctx, `SELECT notes FROM inspections WHERE id=$1`, inspectionID).
		Scan(&notesAfter); err != nil {
		t.Fatalf("reread notes: %v", err)
	}
	if notesAfter != notes {
		t.Fatalf("empty apply rewrote notes to %q", notesAfter)
	}

	resp, _ = call(t, server.handleTranscriptionApplyReparse, adminRequest(
		http.MethodPost, "/api/v1/transcriptions/"+mediaID.String()+"/apply-reparse",
		map[string]any{
			"accept": []map[string]any{{
				"kind":       "inspection",
				"existingId": inspectionID.String(),
				"fields":     ai.ParsedInspection{Notes: ptr("revised notes")},
			}},
		}, "id", mediaID.String()))
	if resp.Code != http.StatusOK {
		t.Fatalf("apply-reparse = %d %s", resp.Code, resp.Body.String())
	}
	if err := server.pool.QueryRow(ctx, `SELECT notes FROM inspections WHERE id=$1`, inspectionID).
		Scan(&notesAfter); err != nil {
		t.Fatalf("reread after apply: %v", err)
	}
	if notesAfter != "revised notes" {
		t.Fatalf("accepted apply notes = %q", notesAfter)
	}
}

func TestPhotoDeleteRefusesWhileLotPointsAtIt(t *testing.T) {
	server := honeyTestServer(t)
	ctx := context.Background()
	apiaryID, hiveID := insertMediaTestHive(t, server)

	photoID := uuid.New()
	if _, err := server.pool.Exec(ctx, `
		INSERT INTO photos (id, owner_type, owner_id, original_key, original_ref, storage_backend)
		VALUES ($1, 'hive', $2, 'photos/hive/x.jpg', 'photos/hive/x.jpg', 'minio')`,
		photoID, hiveID); err != nil {
		t.Fatalf("insert photo: %v", err)
	}
	lotID := uuid.New()
	if _, err := server.pool.Exec(ctx, `
		INSERT INTO harvest_lots (id, lot_code, public_slug, extraction_date, honey_weight_lbs, is_public)
		VALUES ($1, $2, $3, CURRENT_DATE, 10, true)`,
		lotID, "LOT-"+photoID.String()[:8], "slug-"+photoID.String()[:8]); err != nil {
		t.Fatalf("insert lot: %v", err)
	}
	if _, err := server.pool.Exec(ctx, `
		INSERT INTO harvest_lot_photos (lot_id, photo_id) VALUES ($1, $2)`, lotID, photoID); err != nil {
		t.Fatalf("link lot photo: %v", err)
	}
	t.Cleanup(func() {
		_, _ = server.pool.Exec(ctx, `DELETE FROM harvest_lot_photos WHERE photo_id=$1`, photoID)
		_, _ = server.pool.Exec(ctx, `DELETE FROM harvest_lots WHERE id=$1`, lotID)
		_, _ = server.pool.Exec(ctx, `DELETE FROM photos WHERE id=$1`, photoID)
		_, _ = server.pool.Exec(ctx, `DELETE FROM hives WHERE id=$1`, hiveID)
		_, _ = server.pool.Exec(ctx, `DELETE FROM apiaries WHERE id=$1`, apiaryID)
	})

	resp, _ := call(t, server.handlePhotoDelete,
		adminRequest(http.MethodDelete, "/api/v1/photos/"+photoID.String(), nil, "id", photoID.String()))
	if resp.Code != http.StatusConflict {
		t.Fatalf("delete used photo = %d %s, want 409", resp.Code, resp.Body.String())
	}

	if _, err := server.pool.Exec(ctx, `DELETE FROM harvest_lot_photos WHERE photo_id=$1`, photoID); err != nil {
		t.Fatalf("unlink: %v", err)
	}
	resp, _ = call(t, server.handlePhotoDelete,
		adminRequest(http.MethodDelete, "/api/v1/photos/"+photoID.String(), nil, "id", photoID.String()))
	if resp.Code != http.StatusOK {
		t.Fatalf("delete unused photo = %d %s, want 200", resp.Code, resp.Body.String())
	}
}

func TestLinkedImmichPhotoDeleteRemovesAssociationOnly(t *testing.T) {
	server := honeyTestServer(t)
	ctx := context.Background()
	apiaryID, hiveID := insertMediaTestHive(t, server)
	photoID := uuid.New()
	assetID := uuid.NewString()
	if _, err := server.pool.Exec(ctx, `
		INSERT INTO photos
			(id, owner_type, owner_id, original_key, original_ref, storage_backend, original_external)
		VALUES ($1, 'hive', $2, NULL, $3, 'immich', true)`,
		photoID, hiveID, assetID); err != nil {
		t.Fatalf("insert linked photo: %v", err)
	}
	t.Cleanup(func() {
		_, _ = server.pool.Exec(ctx, `DELETE FROM photos WHERE id=$1`, photoID)
		_, _ = server.pool.Exec(ctx, `DELETE FROM hives WHERE id=$1`, hiveID)
		_, _ = server.pool.Exec(ctx, `DELETE FROM apiaries WHERE id=$1`, apiaryID)
	})

	resp, _ := call(t, server.handlePhotoDelete,
		adminRequest(http.MethodDelete, "/api/v1/photos/"+photoID.String(), nil, "id", photoID.String()))
	if resp.Code != http.StatusOK {
		t.Fatalf("delete linked photo = %d %s", resp.Code, resp.Body.String())
	}
	var leftover int
	if err := server.pool.QueryRow(ctx, `SELECT count(*) FROM photos WHERE id=$1`, photoID).Scan(&leftover); err != nil {
		t.Fatalf("count: %v", err)
	}
	if leftover != 0 {
		t.Fatal("linked photo row survived")
	}
}

func TestPublicHoneyStoryPhotoUsesBeezURLNotImmich(t *testing.T) {
	server := honeyTestServer(t)
	ctx := context.Background()
	apiaryID, hiveID := insertMediaTestHive(t, server)

	photoID := uuid.New()
	if _, err := server.pool.Exec(ctx, `
		INSERT INTO photos
			(id, owner_type, owner_id, original_key, original_ref, storage_backend, original_external, medium_key)
		VALUES ($1, 'hive', $2, NULL, $3, 'immich', true, 'photos/hive/story_medium.jpg')`,
		photoID, hiveID, uuid.NewString()); err != nil {
		t.Fatalf("insert immich photo: %v", err)
	}
	slug := "story-" + photoID.String()[:8]
	lotID := uuid.New()
	if _, err := server.pool.Exec(ctx, `
		INSERT INTO harvest_lots (id, lot_code, public_slug, extraction_date, honey_weight_lbs, is_public)
		VALUES ($1, 'HONEY-1', $2, CURRENT_DATE, 8, true)`, lotID, slug); err != nil {
		t.Fatalf("insert lot: %v", err)
	}
	if _, err := server.pool.Exec(ctx, `
		INSERT INTO harvest_lot_photos (lot_id, photo_id) VALUES ($1, $2)`, lotID, photoID); err != nil {
		t.Fatalf("link photo: %v", err)
	}
	t.Cleanup(func() {
		_, _ = server.pool.Exec(ctx, `DELETE FROM harvest_lot_photos WHERE photo_id=$1`, photoID)
		_, _ = server.pool.Exec(ctx, `DELETE FROM harvest_lots WHERE id=$1`, lotID)
		_, _ = server.pool.Exec(ctx, `DELETE FROM photos WHERE id=$1`, photoID)
		_, _ = server.pool.Exec(ctx, `DELETE FROM hives WHERE id=$1`, hiveID)
		_, _ = server.pool.Exec(ctx, `DELETE FROM apiaries WHERE id=$1`, apiaryID)
	})

	req := httptest.NewRequest(http.MethodGet, "/api/v1/public/honey-stories/"+slug, nil)
	resp, body := call(t, server.publicHoneyStory, withChiParams(req, "slug", slug))
	if resp.Code != http.StatusOK {
		t.Fatalf("public story = %d %s", resp.Code, resp.Body.String())
	}
	photos, _ := body["photos"].([]any)
	if len(photos) != 1 {
		t.Fatalf("photos = %#v", body["photos"])
	}
	item := photos[0].(map[string]any)
	url, _ := item["url"].(string)
	if url == "" || containsImmichHost(url) {
		t.Fatalf("public photo url leaked backend: %q", url)
	}
	if url != "/api/v1/public/honey-stories/"+slug+"/photos/"+photoID.String() {
		t.Fatalf("public photo url = %q", url)
	}
}

func insertMediaTestHive(t *testing.T, server *Server) (uuid.UUID, uuid.UUID) {
	t.Helper()
	ctx := context.Background()
	var apiaryID, hiveID uuid.UUID
	if err := server.pool.QueryRow(ctx,
		`INSERT INTO apiaries (name) VALUES ($1) RETURNING id`,
		"Media yard "+uuid.NewString()).Scan(&apiaryID); err != nil {
		t.Fatalf("insert apiary: %v", err)
	}
	if err := server.pool.QueryRow(ctx,
		`INSERT INTO hives (apiary_id, position_label) VALUES ($1, 'M1') RETURNING id`,
		apiaryID).Scan(&hiveID); err != nil {
		t.Fatalf("insert hive: %v", err)
	}
	return apiaryID, hiveID
}

func withChiParams(req *http.Request, pairs ...string) *http.Request {
	return adminRequest(req.Method, req.URL.String(), nil, pairs...)
}

func containsImmichHost(url string) bool {
	return len(url) > 4 && (url[:4] == "http")
}

func ptr[T any](v T) *T { return &v }
