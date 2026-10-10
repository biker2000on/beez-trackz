package httpapi

import (
	"context"
	"encoding/json"
	"fmt"
	"github.com/google/uuid"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"
)

func TestVoiceBaselineEquipmentCommitsWithInspectionAndRollsBackTogether(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	server, user := baselineEquipServer(ctx, t, "beez_voice_baseline")
	hive := baselineHive(ctx, t, server)
	var apiary uuid.UUID
	if err := server.pool.QueryRow(ctx, `SELECT apiary_id FROM hives WHERE id=$1`, hive).Scan(&apiary); err != nil {
		t.Fatal(err)
	}
	f := &hiveScopeFixture{server: server, editor: &principal{ID: user, IsAdmin: true}, apiaryA: apiary, hiveA: hive, ctx: ctx}
	response, body := call(t, server.equipCreateType, baselineRequest(user, "POST", "/equipment/types", map[string]any{"name": "Voice medium super", "category": "box"}))
	if response.Code >= 300 {
		t.Fatal(response.Body.String())
	}
	typeID := body["id"].(string)
	response, body = call(t, server.equipCreateStock, baselineRequest(user, "POST", "/equipment/stock", map[string]any{"typeId": typeID, "initialQuantity": 2}))
	if response.Code >= 300 {
		t.Fatal(response.Body.String())
	}
	itemID := body["id"].(string)
	media, version, observed := voiceTestCapture(t, f, "single")
	target := "/api/v1/transcriptions/" + media.String() + "/confirm"
	params := map[string]string{"id": media.String()}
	payload := map[string]any{"versionId": version, "inspections": []map[string]any{{"notes": "Added a medium super", "equipmentActions": []map[string]any{{"kind": "deploy", "referenceId": itemID, "quantity": 1, "accepted": true}}}}}
	response = f.call(t, server.handleTranscriptionConfirm, "POST", target, payload, params)
	var result struct {
		Success      bool        `json:"success"`
		OperationIDs []uuid.UUID `json:"operationIds"`
	}
	_ = json.Unmarshal(response.Body.Bytes(), &result)
	if response.Code != 200 || !result.Success || len(result.OperationIDs) != 1 {
		t.Fatalf("atomic deploy %d %s", response.Code, response.Body.String())
	}
	var date time.Time
	if err := server.pool.QueryRow(ctx, `SELECT occurred_at FROM inventory_operations WHERE id=$1`, result.OperationIDs[0]).Scan(&date); err != nil || !date.Equal(observed) {
		t.Fatalf("equipment occurrence %v %v", date, err)
	}
	if row := baselineStockRow(t, server, user, itemID); row.Deployed != 1 || row.Available != 1 {
		t.Fatalf("deployment balances %+v", row)
	}
	failed, failedVersion, _ := voiceTestCapture(t, f, "single")
	payload["versionId"] = failedVersion
	payload["inspections"] = []map[string]any{{"notes": "Must roll back this inspection", "equipmentActions": []map[string]any{{"kind": "deploy", "referenceId": itemID, "quantity": 2, "accepted": true}}}}
	response = f.call(t, server.handleTranscriptionConfirm, "POST", "/api/v1/transcriptions/"+failed.String()+"/confirm", payload, map[string]string{"id": failed.String()})
	var count int
	_ = server.pool.QueryRow(ctx, `SELECT count(*) FROM inspections WHERE source_media_file_id=$1`, failed).Scan(&count)
	if count != 0 {
		t.Fatalf("stock failure left inspection: %s", response.Body.String())
	}
	var failure map[string]any
	_ = json.Unmarshal(response.Body.Bytes(), &failure)
	if failure["success"] != false {
		t.Fatalf("overdeployment accepted: %s", response.Body.String())
	}
}

func TestVoiceManualRecoveryRetainsOriginalAudioAndSource(t *testing.T) {
	f := newHiveScopeFixture(t)
	media, version, _ := voiceTestCapture(t, f, "single")
	capture := uuid.New()
	_, err := f.server.pool.Exec(f.ctx, `UPDATE media_files SET capture_id=$2,transcription_status='failed',transcription_text=NULL,current_transcript_version_id=NULL WHERE id=$1`, media, capture)
	if err != nil {
		t.Fatal(err)
	}
	// Keep the former version as retained source history, even when recovering manually.
	_ = version
	res := f.call(t, f.server.handleTranscriptionConfirm, "POST", "/api/v1/transcriptions/"+media.String()+"/confirm", map[string]any{"manualEntry": true, "inspections": []map[string]any{{"itemKey": "manual-" + capture.String(), "notes": "Typed after failed transcription"}}}, map[string]string{"id": media.String()})
	var result map[string]any
	_ = json.Unmarshal(res.Body.Bytes(), &result)
	if result["success"] != true {
		t.Fatalf("manual recovery %s", res.Body.String())
	}
	var provider, status, audio string
	if err = f.server.pool.QueryRow(f.ctx, `SELECT v.provider,m.transcription_status,m.audio_key FROM inspections i JOIN media_files m ON m.id=i.source_media_file_id JOIN transcript_versions v ON v.id=i.source_transcript_version_id WHERE i.source_media_file_id=$1`, media).Scan(&provider, &status, &audio); err != nil || provider != "manual-entry" || status != "failed" || audio != "audio/test" {
		t.Fatalf("recovery provenance %s %s %s %v", provider, status, audio, err)
	}
}

func TestVoiceModernSourceIdentityAndCachedReview(t *testing.T) {
	f := newHiveScopeFixture(t)
	media, version, _ := voiceTestCapture(t, f, "single")
	capture := uuid.New()
	_, err := f.server.pool.Exec(f.ctx, `UPDATE media_files SET capture_id=$2 WHERE id=$1`, media, capture)
	if err != nil {
		t.Fatal(err)
	}
	_, err = f.server.pool.Exec(f.ctx, `UPDATE transcript_versions SET parsed_inspections='[{"itemKey":"item-0","scope":"hive","notes":"original proposal"}]' WHERE id=$1`, version)
	if err != nil {
		t.Fatal(err)
	}
	row, err := f.server.transcriptionLoad(f.ctx, media)
	if err != nil {
		t.Fatal(err)
	}
	// The cached review succeeds without a provider configuration or network call.
	parsed, err := f.server.transcriptionParseAndMatch(f.ctx, row, "single")
	if err != nil || parsed["inspections"] == nil {
		t.Fatalf("cached parse %v %v", parsed, err)
	}
	target := "/api/v1/transcriptions/" + media.String() + "/confirm"
	params := map[string]string{"id": media.String()}
	body := map[string]any{"versionId": version, "inspections": []map[string]any{{"itemKey": "made-up-key", "scope": "hive", "notes": "attempt to invent another item"}}}
	res := f.call(t, f.server.handleTranscriptionConfirm, "POST", target, body, params)
	if res.Code != 400 {
		t.Fatalf("fabricated source key %d %s", res.Code, res.Body.String())
	}
	body["inspections"] = []map[string]any{{"itemKey": "item-0", "scope": "hive", "notes": "reviewed correction"}}
	res = f.call(t, f.server.handleTranscriptionConfirm, "POST", target, body, params)
	var result map[string]any
	_ = json.Unmarshal(res.Body.Bytes(), &result)
	if result["success"] != true {
		t.Fatalf("reviewed source %s", res.Body.String())
	}
	body["manualEntry"] = true
	body["inspections"] = []map[string]any{{"itemKey": "manual-" + capture.String(), "scope": "hive", "notes": "cannot duplicate already saved audio"}}
	res = f.call(t, f.server.handleTranscriptionConfirm, "POST", target, body, params)
	_ = json.Unmarshal(res.Body.Bytes(), &result)
	if result["success"] != false {
		t.Fatalf("manual duplicate %s", res.Body.String())
	}
}

func TestVoiceSiblingReplacementsCannotBothSave(t *testing.T) {
	f := newHiveScopeFixture(t)
	original, _, _ := voiceTestCapture(t, f, "single")
	first, v1, _ := voiceTestCapture(t, f, "single")
	second, v2, _ := voiceTestCapture(t, f, "single")
	_, err := f.server.pool.Exec(f.ctx, `UPDATE media_files SET replaces_media_file_id=$1 WHERE id IN ($2,$3)`, original, first, second)
	if err != nil {
		t.Fatal(err)
	}
	ids := []uuid.UUID{first, second}
	versions := []uuid.UUID{v1, v2}
	saved := make([]bool, 2)
	var wg sync.WaitGroup
	for i := range ids {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			res := f.call(t, f.server.handleTranscriptionConfirm, "POST", "/api/v1/transcriptions/"+ids[i].String()+"/confirm", map[string]any{"versionId": versions[i], "inspections": []map[string]any{{"notes": "replacement"}}}, map[string]string{"id": ids[i].String()})
			var result map[string]any
			_ = json.Unmarshal(res.Body.Bytes(), &result)
			saved[i] = result["success"] == true
		}(i)
	}
	wg.Wait()
	if saved[0] == saved[1] {
		t.Fatalf("replacement race outcomes %v, want exactly one saved", saved)
	}
	var count int
	err = f.server.pool.QueryRow(f.ctx, `SELECT count(*) FROM inspections WHERE source_media_file_id IN ($1,$2,$3)`, original, first, second).Scan(&count)
	if err != nil || count != 1 {
		t.Fatalf("replacement inspection count %d %v", count, err)
	}
}

func voiceTestCapture(t *testing.T, f *hiveScopeFixture, mode string) (uuid.UUID, uuid.UUID, time.Time) {
	t.Helper()
	media, version := uuid.New(), uuid.New()
	observed := time.Now().UTC().Add(-48 * time.Hour).Truncate(time.Microsecond)
	ownerType := "apiary"
	owner := f.apiaryA
	if mode == "single" {
		ownerType = "hive"
		owner = f.hiveA
	}
	_, err := f.server.pool.Exec(f.ctx, `INSERT INTO media_files(id,audio_key,transcription_status,transcription_text,owner_type,owner_id,capture_mode,observed_at) VALUES($1,'audio/test','complete','observations',$2,$3,$4,$5)`, media, ownerType, owner, mode, observed)
	if err != nil {
		t.Fatal(err)
	}
	_, err = f.server.pool.Exec(f.ctx, `INSERT INTO transcript_versions(id,media_file_id,provider,text) VALUES($1,$2,'test','observations')`, version, media)
	if err != nil {
		t.Fatal(err)
	}
	_, err = f.server.pool.Exec(f.ctx, `UPDATE media_files SET current_transcript_version_id=$2 WHERE id=$1`, media, version)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		for _, table := range []string{"feedings", "mite_counts", "treatment_events", "apiary_inspections", "inspections"} {
			_, _ = f.server.pool.Exec(f.ctx, `DELETE FROM `+table+` WHERE source_media_file_id=$1`, media)
		}
		_, _ = f.server.pool.Exec(f.ctx, `UPDATE media_files SET current_transcript_version_id=NULL WHERE id=$1`, media)
		_, _ = f.server.pool.Exec(f.ctx, `DELETE FROM media_files WHERE id=$1`, media)
	})
	return media, version, observed
}

func TestVoiceConcurrentConfirmationReplayAndOccurrence(t *testing.T) {
	f := newHiveScopeFixture(t)
	media, version, observed := voiceTestCapture(t, f, "single")
	body := map[string]any{"versionId": version, "inspections": []map[string]any{{"notes": "Brood looks good", "feedings": []map[string]any{{"type": "sugar_syrup_1to1", "quantity": 1, "quantityUnit": "quarts"}}}}}
	path := "/api/v1/transcriptions/" + media.String() + "/confirm"
	params := map[string]string{"id": media.String()}
	var responses [2][]byte
	var codes [2]int
	var wg sync.WaitGroup
	for i := range responses {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			res := f.call(t, f.server.handleTranscriptionConfirm, http.MethodPost, path, body, params)
			responses[i] = res.Body.Bytes()
			codes[i] = res.Code
		}(i)
	}
	wg.Wait()
	var first, second map[string]any
	if codes[0] != 200 || codes[1] != 200 {
		t.Fatalf("response %d %s / %d %s", codes[0], responses[0], codes[1], responses[1])
	}
	_ = json.Unmarshal(responses[0], &first)
	_ = json.Unmarshal(responses[1], &second)
	if first["success"] != true || second["success"] != true || string(responses[0]) != string(responses[1]) {
		t.Fatalf("replays differ: %s / %s", responses[0], responses[1])
	}
	var count int
	var date time.Time
	var queen *bool
	if err := f.server.pool.QueryRow(f.ctx, `SELECT count(*) FROM inspections WHERE source_media_file_id=$1`, media).Scan(&count); err != nil || count != 1 {
		t.Fatalf("inspection count %d: %v", count, err)
	}
	if err := f.server.pool.QueryRow(f.ctx, `SELECT date,queen_seen FROM inspections WHERE source_media_file_id=$1`, media).Scan(&date, &queen); err != nil || !date.Equal(observed) || queen != nil {
		t.Fatalf("observation %v queen %v err %v", date, queen, err)
	}
	if err := f.server.pool.QueryRow(f.ctx, `SELECT date_fed FROM feedings WHERE source_media_file_id=$1`, media).Scan(&date); err != nil || !date.Equal(observed) {
		t.Fatalf("feeding occurrence %v: %v", date, err)
	}
	body["inspections"] = []map[string]any{{"notes": "different payload"}}
	changed := f.call(t, f.server.handleTranscriptionConfirm, http.MethodPost, path, body, params)
	var failed map[string]any
	_ = json.Unmarshal(changed.Body.Bytes(), &failed)
	if failed["success"] != false {
		t.Fatalf("changed replay accepted %s", changed.Body.String())
	}
	outcomes, err := f.server.transcriptionOutcomes(f.ctx, media)
	if err != nil || len(outcomes) != 1 {
		t.Fatalf("resume outcomes %v %v", outcomes, err)
	}
}

func TestVoiceMixedYardRejectsBeforeWritesAndPartialItemRollback(t *testing.T) {
	f := newHiveScopeFixture(t)
	media, version, _ := voiceTestCapture(t, f, "batch")
	// Even an editor of both yards cannot change this capture's apiary scope.
	_, err := f.server.pool.Exec(f.ctx, `INSERT INTO apiary_memberships(user_id,apiary_id,role) VALUES($1,$2,'editor')`, f.editor.ID, f.apiaryB)
	if err != nil {
		t.Fatal(err)
	}
	path := "/api/v1/transcriptions/" + media.String() + "/confirm"
	params := map[string]string{"id": media.String()}
	body := map[string]any{"versionId": version, "mode": "batch", "inspections": []map[string]any{{"hiveId": f.hiveA, "notes": "ok"}, {"hiveId": f.hiveB, "notes": "wrong yard"}}}
	res := f.call(t, f.server.handleTranscriptionConfirm, http.MethodPost, path, body, params)
	if res.Code != 400 {
		t.Fatalf("wrong yard accepted %d %s", res.Code, res.Body.String())
	}
	var count int
	_ = f.server.pool.QueryRow(f.ctx, `SELECT count(*) FROM inspections WHERE source_media_file_id=$1`, media).Scan(&count)
	if count != 0 {
		t.Fatal("mixed-yard request wrote an inspection")
	}
	body["inspections"] = []map[string]any{{"scope": "apiary", "notes": "Water source is dry"}, {"hiveId": f.hiveA, "notes": "Good brood", "equipmentActions": []map[string]any{{"kind": "deploy", "referenceId": uuid.New(), "quantity": 1, "accepted": true}}}}
	res = f.call(t, f.server.handleTranscriptionConfirm, http.MethodPost, path, body, params)
	var result struct {
		Success  bool                   `json:"success"`
		Outcomes []transcriptionOutcome `json:"outcomes"`
	}
	_ = json.Unmarshal(res.Body.Bytes(), &result)
	if res.Code != 200 || result.Success || len(result.Outcomes) != 2 || result.Outcomes[0].Status != "saved" || result.Outcomes[1].Status != "failed" {
		t.Fatalf("partial outcome %d %s", res.Code, res.Body.String())
	}
	_ = f.server.pool.QueryRow(f.ctx, `SELECT count(*) FROM inspections WHERE source_media_file_id=$1`, media).Scan(&count)
	if count != 0 {
		t.Fatal("failed equipment left an observation committed")
	}
	_ = f.server.pool.QueryRow(f.ctx, `SELECT count(*) FROM apiary_inspections WHERE source_media_file_id=$1`, media).Scan(&count)
	if count != 1 {
		t.Fatal("successful apiary item was lost")
	}
}

func TestVoiceRejectsStaleVersion(t *testing.T) {
	f := newHiveScopeFixture(t)
	media, version, _ := voiceTestCapture(t, f, "single")
	replacement := uuid.New()
	_, err := f.server.pool.Exec(f.ctx, `INSERT INTO transcript_versions(id,media_file_id,provider,text) VALUES($1,$2,'test','corrected')`, replacement, media)
	if err != nil {
		t.Fatal(err)
	}
	_, err = f.server.pool.Exec(f.ctx, `UPDATE media_files SET current_transcript_version_id=$2 WHERE id=$1`, media, replacement)
	if err != nil {
		t.Fatal(err)
	}
	res := f.call(t, f.server.handleTranscriptionConfirm, http.MethodPost, "/api/v1/transcriptions/"+media.String()+"/confirm", map[string]any{"versionId": version, "inspections": []map[string]any{{"notes": "old interpretation"}}}, map[string]string{"id": media.String()})
	var result map[string]any
	_ = json.Unmarshal(res.Body.Bytes(), &result)
	if result["success"] != false {
		t.Fatalf("stale version accepted %s", res.Body.String())
	}
}

func TestManualVisitReplayPreservesTimestampAndHasNoMedia(t *testing.T) {
	f := newHiveScopeFixture(t)
	capture := uuid.New()
	observed := time.Now().UTC().Add(-24 * time.Hour).Truncate(time.Microsecond)
	body := map[string]any{"captureId": capture, "scope": "hive", "hiveId": f.hiveA, "observedAt": observed, "inspection": map[string]any{"notes": "Typed visit", "queenSeen": false}}
	first := f.call(t, f.server.handleInspectionVisitCreate, http.MethodPost, "/api/v1/inspection-visits", body, nil)
	second := f.call(t, f.server.handleInspectionVisitCreate, http.MethodPost, "/api/v1/inspection-visits", body, nil)
	if first.Code != 201 || second.Code != 201 || first.Body.String() != second.Body.String() {
		t.Fatalf("manual replay %d %s / %d %s", first.Code, first.Body.String(), second.Code, second.Body.String())
	}
	var count int
	var date time.Time
	var media *uuid.UUID
	var queen *bool
	if err := f.server.pool.QueryRow(f.ctx, `SELECT date,source_media_file_id,queen_seen FROM inspections WHERE hive_id=$1`, f.hiveA).Scan(&date, &media, &queen); err != nil || !date.Equal(observed) || media != nil || queen == nil || *queen {
		t.Fatalf("manual values %v %v %v %v", date, media, queen, err)
	}
	_ = f.server.pool.QueryRow(f.ctx, `SELECT count(*) FROM inspections WHERE hive_id=$1`, f.hiveA).Scan(&count)
	if count != 1 {
		t.Fatalf("duplicate manual visit %d", count)
	}
	t.Cleanup(func() {
		_, _ = f.server.pool.Exec(f.ctx, `DELETE FROM offline_mutation_receipts WHERE user_id=$1`, f.editor.ID)
	})
}

func TestManualVisitMiddlewareReplaysCanonicalReceipts(t *testing.T) {
	for _, firstWithHeader := range []bool{false, true} {
		t.Run(fmt.Sprintf("first-header-%t", firstWithHeader), func(t *testing.T) {
			f := newHiveScopeFixture(t)
			capture := uuid.New()
			t.Cleanup(func() {
				_, _ = f.server.pool.Exec(f.ctx, `DELETE FROM offline_mutation_receipts WHERE user_id=$1`, f.editor.ID)
			})
			body := map[string]any{"captureId": capture, "scope": "hive", "hiveId": f.hiveA,
				"observedAt": time.Now().UTC().Add(-time.Hour).Truncate(time.Microsecond),
				"inspection": map[string]any{"notes": "Original observed facts"}}
			// The headerless first call also models a receipt written by the
			// previous release: its canonical identity must remain recoverable.
			callThroughMiddleware := func(withHeader bool, mutation uuid.UUID) *httptest.ResponseRecorder {
				return f.call(t, func(w http.ResponseWriter, r *http.Request) {
					if withHeader {
						r.Header.Set("X-Offline-Mutation-ID", mutation.String())
					}
					f.server.offlineMutations(http.HandlerFunc(f.server.handleInspectionVisitCreate)).ServeHTTP(w, r)
				}, http.MethodPost, "/api/v1/inspection-visits", body, nil)
			}
			first := callThroughMiddleware(firstWithHeader, capture)
			replayed := callThroughMiddleware(true, capture)
			if first.Code != 201 || replayed.Code != 201 || replayed.Body.String() != first.Body.String() || replayed.Header().Get("X-Offline-Replayed") != "true" {
				t.Fatalf("receipt replay: first=%d %s retry=%d %s", first.Code, first.Body.String(), replayed.Code, replayed.Body.String())
			}
			body["inspection"] = map[string]any{"notes": "Different facts must not reuse the capture"}
			if response := callThroughMiddleware(true, capture); response.Code != http.StatusConflict {
				t.Fatalf("different payload must conflict: %d %s", response.Code, response.Body.String())
			}
			if response := callThroughMiddleware(true, uuid.New()); response.Code != http.StatusBadRequest {
				t.Fatalf("mismatched mutation must fail: %d %s", response.Code, response.Body.String())
			}
			var count int
			if err := f.server.pool.QueryRow(f.ctx, `SELECT count(*) FROM inspections WHERE hive_id=$1 AND notes='Original observed facts'`, f.hiveA).Scan(&count); err != nil || count != 1 {
				t.Fatalf("expected exactly one observation: count=%d err=%v", count, err)
			}
		})
	}
}
