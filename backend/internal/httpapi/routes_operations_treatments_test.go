package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"testing"
	"time"

	"github.com/google/uuid"
)

func TestTreatmentEventPatchEndsAndReopensLockout(t *testing.T) {
	fixture := newHiveScopeFixture(t)
	hive := fixture.hiveA
	t.Cleanup(func() {
		_, _ = fixture.server.pool.Exec(context.Background(),
			`DELETE FROM treatment_events WHERE hive_id=$1`, hive)
	})

	created := fixture.call(t, fixture.server.treatmentEventCreate,
		http.MethodPost, "/treatment-events",
		map[string]any{
			"hiveId": hive.String(), "dateApplied": "2026-08-01",
			"product": "Apivar", "withdrawalDays": 14,
		}, nil)
	if created.Code != http.StatusCreated {
		t.Fatalf("create: %d %s", created.Code, created.Body.String())
	}
	var body map[string]any
	if err := json.Unmarshal(created.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	id := body["id"].(string)
	params := map[string]string{"id": id}

	// Lockout surfaces the treatment id so the UI can end it.
	hiveGet := fixture.call(t, fixture.server.handleHiveGet,
		http.MethodGet, "/hives/"+hive.String(), nil, map[string]string{"id": hive.String()})
	if hiveGet.Code != http.StatusOK {
		t.Fatalf("hive get: %d %s", hiveGet.Code, hiveGet.Body.String())
	}
	var hiveBody struct {
		Lockout *hiveLockoutJSON `json:"lockout"`
	}
	if err := json.Unmarshal(hiveGet.Body.Bytes(), &hiveBody); err != nil {
		t.Fatalf("decode hive: %v", err)
	}
	if hiveBody.Lockout == nil || !hiveBody.Lockout.Locked ||
		hiveBody.Lockout.TreatmentEventID == nil || *hiveBody.Lockout.TreatmentEventID != id {
		t.Fatalf("lockout should name treatment %s: %+v", id, hiveBody.Lockout)
	}

	// Removal before application is rejected.
	early := fixture.call(t, fixture.server.treatmentEventUpdate,
		http.MethodPatch, "/treatment-events/"+id,
		map[string]any{"dateRemoved": "2026-07-20T00:00:00Z"}, params)
	if early.Code != http.StatusBadRequest {
		t.Fatalf("early removal = %d, want 400: %s", early.Code, early.Body.String())
	}

	// Happy path: removed, still in withdrawal.
	ended := fixture.call(t, fixture.server.treatmentEventUpdate,
		http.MethodPatch, "/treatment-events/"+id,
		map[string]any{"dateRemoved": "2026-08-10T00:00:00Z", "notes": "strips out"}, params)
	if ended.Code != http.StatusOK {
		t.Fatalf("end: %d %s", ended.Code, ended.Body.String())
	}
	var updated map[string]any
	if err := json.Unmarshal(ended.Body.Bytes(), &updated); err != nil {
		t.Fatalf("decode end: %v", err)
	}
	if updated["id"] != id || updated["dateRemoved"] == nil || updated["notes"] != "strips out" {
		t.Fatalf("unexpected patch response: %v", updated)
	}
	var removed *string
	if err := fixture.server.pool.QueryRow(fixture.ctx,
		`SELECT date_removed::text FROM treatment_events WHERE id=$1`, id).Scan(&removed); err != nil {
		t.Fatalf("read back: %v", err)
	}
	if removed == nil {
		t.Fatal("date_removed not persisted")
	}

	// Omitting dateRemoved keeps it; explicit null clears it and re-locks.
	notesOnly := fixture.call(t, fixture.server.treatmentEventUpdate,
		http.MethodPatch, "/treatment-events/"+id,
		map[string]any{"notes": "still removed"}, params)
	if notesOnly.Code != http.StatusOK {
		t.Fatalf("notes only: %d %s", notesOnly.Code, notesOnly.Body.String())
	}
	if err := fixture.server.pool.QueryRow(fixture.ctx,
		`SELECT date_removed::text FROM treatment_events WHERE id=$1`, id).Scan(&removed); err != nil || removed == nil {
		t.Fatalf("notes-only patch cleared date_removed: %v %v", removed, err)
	}
	reopened := fixture.call(t, fixture.server.treatmentEventUpdate,
		http.MethodPatch, "/treatment-events/"+id,
		map[string]any{"dateRemoved": nil}, params)
	if reopened.Code != http.StatusOK {
		t.Fatalf("reopen: %d %s", reopened.Code, reopened.Body.String())
	}
	if err := fixture.server.pool.QueryRow(fixture.ctx,
		`SELECT date_removed::text FROM treatment_events WHERE id=$1`, id).Scan(&removed); err != nil || removed != nil {
		t.Fatalf("null did not clear date_removed: %v %v", removed, err)
	}
	st, err := hiveLockoutAsOf(fixture.ctx, fixture.server.pool, hive, time.Date(2026, time.September, 30, 12, 0, 0, 0, time.UTC))
	if err != nil {
		t.Fatalf("lockout: %v", err)
	}
	if !st.Locked || !st.TreatmentOn || st.TreatmentID.String() != id {
		t.Fatalf("expected hive re-locked by %s: %+v", id, st)
	}

	// Missing row.
	missing := fixture.call(t, fixture.server.treatmentEventUpdate,
		http.MethodPatch, "/treatment-events/"+uuid.Nil.String(),
		map[string]any{"notes": "x"}, map[string]string{"id": uuid.Nil.String()})
	if missing.Code != http.StatusNotFound {
		t.Fatalf("missing = %d, want 404", missing.Code)
	}
}

func TestMiteCountPatchToleratesHiveIDAndCreateChecksInspectionHive(t *testing.T) {
	fixture := newHiveScopeFixture(t)
	t.Cleanup(func() {
		_, _ = fixture.server.pool.Exec(context.Background(),
			`DELETE FROM mite_counts WHERE hive_id IN ($1,$2)`, fixture.hiveA, fixture.hiveB)
	})
	created := fixture.call(t, fixture.server.miteCountCreate,
		http.MethodPost, "/mite-counts",
		map[string]any{
			"hiveId": fixture.hiveA.String(), "date": "2026-08-04",
			"method": "alcohol_wash", "mitesCount": 9, "sampleSize": 300,
		}, nil)
	if created.Code != http.StatusCreated {
		t.Fatalf("create: %d %s", created.Code, created.Body.String())
	}
	var body map[string]any
	if err := json.Unmarshal(created.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	id := body["id"].(string)

	patched := fixture.call(t, fixture.server.miteCountUpdate,
		http.MethodPatch, "/mite-counts/"+id,
		map[string]any{"hiveId": fixture.hiveA.String(), "mitesCount": 3},
		map[string]string{"id": id})
	if patched.Code != http.StatusOK {
		t.Fatalf("patch with hiveId: %d %s", patched.Code, patched.Body.String())
	}
	moved := fixture.call(t, fixture.server.miteCountUpdate,
		http.MethodPatch, "/mite-counts/"+id,
		map[string]any{"hiveId": fixture.hiveB.String(), "mitesCount": 3},
		map[string]string{"id": id})
	if moved.Code != http.StatusBadRequest {
		t.Fatalf("patch changing hiveId = %d, want 400", moved.Code)
	}

	// An inspection on hive B cannot be targeted through hive A.
	var inspectionB uuid.UUID
	if err := fixture.server.pool.QueryRow(fixture.ctx, `
		INSERT INTO inspections (hive_id, date) VALUES ($1,'2026-08-04') RETURNING id`,
		fixture.hiveB).Scan(&inspectionB); err != nil {
		t.Fatalf("insert inspection: %v", err)
	}
	cross := fixture.call(t, fixture.server.miteCountCreate,
		http.MethodPost, "/mite-counts",
		map[string]any{
			"hiveId": fixture.hiveA.String(), "inspectionId": inspectionB.String(),
			"date": "2026-08-04", "method": "sugar_roll", "mitesCount": 2, "sampleSize": 300,
		}, nil)
	if cross.Code != http.StatusBadRequest {
		t.Fatalf("cross-hive inspection = %d, want 400: %s", cross.Code, cross.Body.String())
	}
}
