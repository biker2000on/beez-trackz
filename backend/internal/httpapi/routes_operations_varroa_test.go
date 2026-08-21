package httpapi

import (
	"encoding/json"
	"math"
	"net/http"
	"testing"

	"github.com/google/uuid"
)

func TestMiteCountBoardRateAndStandaloneConflict(t *testing.T) {
	fixture := newHiveScopeFixture(t)
	hive := fixture.hiveA.String()

	created := fixture.call(t, fixture.server.miteCountCreate,
		http.MethodPost, "/mite-counts",
		map[string]any{
			"hiveId": hive, "date": "2026-08-01", "method": "sticky_board",
			"mitesCount": 18, "daysOnBoard": 3,
		}, nil)
	if created.Code != http.StatusCreated {
		t.Fatalf("create: status %d: %s", created.Code, created.Body.String())
	}
	var first map[string]any
	if err := json.Unmarshal(created.Body.Bytes(), &first); err != nil {
		t.Fatalf("decode create: %v", err)
	}
	if first["mitesPer100"] != nil {
		t.Fatalf("board count should not have mitesPer100: %#v", first)
	}
	if got, _ := first["mitesPerDay"].(float64); math.Abs(got-6) > 0.0001 {
		t.Fatalf("mitesPerDay = %v, want 6", first["mitesPerDay"])
	}

	again := fixture.call(t, fixture.server.miteCountCreate,
		http.MethodPost, "/mite-counts",
		map[string]any{
			"hiveId": hive, "date": "2026-08-01", "method": "sticky_board",
			"mitesCount": 24, "daysOnBoard": 3,
		}, nil)
	if again.Code != http.StatusConflict {
		t.Fatalf("duplicate: status %d: %s", again.Code, again.Body.String())
	}
	var conflict map[string]any
	if err := json.Unmarshal(again.Body.Bytes(), &conflict); err != nil {
		t.Fatalf("decode conflict: %v", err)
	}
	existing, _ := conflict["existing"].(map[string]any)
	if existing == nil || existing["id"] != first["id"] {
		t.Fatalf("409 should return the existing row, got %#v", conflict)
	}
	if got, _ := existing["mitesPerDay"].(float64); math.Abs(got-6) > 0.0001 {
		t.Fatalf("existing mitesPerDay = %v, want 6 (not overwritten)", existing["mitesPerDay"])
	}

	overwritten := fixture.call(t, fixture.server.miteCountCreate,
		http.MethodPost, "/mite-counts",
		map[string]any{
			"hiveId": hive, "date": "2026-08-01", "method": "sticky_board",
			"mitesCount": 24, "daysOnBoard": 3, "overwrite": true,
		}, nil)
	if overwritten.Code != http.StatusOK {
		t.Fatalf("overwrite: status %d: %s", overwritten.Code, overwritten.Body.String())
	}
	var second map[string]any
	if err := json.Unmarshal(overwritten.Body.Bytes(), &second); err != nil {
		t.Fatalf("decode overwrite: %v", err)
	}
	if first["id"] != second["id"] {
		t.Fatalf("overwrite changed id: %v → %v", first["id"], second["id"])
	}
	if got, _ := second["mitesPerDay"].(float64); math.Abs(got-8) > 0.0001 {
		t.Fatalf("overwritten mitesPerDay = %v, want 8", second["mitesPerDay"])
	}

	var n int
	if err := fixture.server.pool.QueryRow(fixture.ctx, `
		SELECT count(*) FROM mite_counts WHERE hive_id=$1 AND deleted_at IS NULL`,
		fixture.hiveA).Scan(&n); err != nil {
		t.Fatalf("count rows: %v", err)
	}
	if n != 1 {
		t.Fatalf("overwrite left %d live rows, want 1", n)
	}
}

func TestMiteCountPatchAndDelete(t *testing.T) {
	fixture := newHiveScopeFixture(t)
	created := fixture.call(t, fixture.server.miteCountCreate,
		http.MethodPost, "/mite-counts",
		map[string]any{
			"hiveId": fixture.hiveA.String(), "date": "2026-08-02",
			"method": "alcohol_wash", "mitesCount": 9, "sampleSize": 300,
		}, nil)
	if created.Code != http.StatusCreated {
		t.Fatalf("create: status %d: %s", created.Code, created.Body.String())
	}
	var body map[string]any
	if err := json.Unmarshal(created.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	id := body["id"].(string)

	patched := fixture.call(t, fixture.server.miteCountUpdate,
		http.MethodPatch, "/mite-counts/"+id,
		map[string]any{"mitesCount": 3}, map[string]string{"id": id})
	if patched.Code != http.StatusOK {
		t.Fatalf("patch: status %d: %s", patched.Code, patched.Body.String())
	}
	var after map[string]any
	if err := json.Unmarshal(patched.Body.Bytes(), &after); err != nil {
		t.Fatalf("decode patch: %v", err)
	}
	if got, _ := after["mitesPer100"].(float64); math.Abs(got-1) > 0.0001 {
		t.Fatalf("patched mitesPer100 = %v, want 1", after["mitesPer100"])
	}

	deleted := fixture.call(t, fixture.server.miteCountDelete,
		http.MethodDelete, "/mite-counts/"+id, nil, map[string]string{"id": id})
	if deleted.Code != http.StatusOK {
		t.Fatalf("delete: status %d: %s", deleted.Code, deleted.Body.String())
	}
	var deletedAt *string
	if err := fixture.server.pool.QueryRow(fixture.ctx, `
		SELECT deleted_at::text FROM mite_counts WHERE id=$1`, id).Scan(&deletedAt); err != nil {
		t.Fatalf("load deleted row: %v", err)
	}
	if deletedAt == nil {
		t.Fatal("delete should set deleted_at, not remove the row")
	}
	missing := fixture.call(t, fixture.server.miteCountDelete,
		http.MethodDelete, "/mite-counts/"+id, nil, map[string]string{"id": id})
	if missing.Code != http.StatusNotFound {
		t.Fatalf("second delete = %d, want 404", missing.Code)
	}
	patchedGone := fixture.call(t, fixture.server.miteCountUpdate,
		http.MethodPatch, "/mite-counts/"+id,
		map[string]any{"mitesCount": 1}, map[string]string{"id": id})
	if patchedGone.Code != http.StatusNotFound {
		t.Fatalf("patch of deleted = %d, want 404", patchedGone.Code)
	}
}

func TestInspectionGetAndUpdateMiteCounts(t *testing.T) {
	fixture := newHiveScopeFixture(t)
	created := fixture.call(t, fixture.server.handleInspectionCreate,
		http.MethodPost, "/inspections",
		map[string]any{
			"hiveId": fixture.hiveA.String(), "date": "2026-08-03",
			"miteCounts": []map[string]any{{
				"method": "alcohol_wash", "mitesCount": 6, "sampleSize": 300,
			}},
		}, nil)
	if created.Code != http.StatusCreated {
		t.Fatalf("create: status %d: %s", created.Code, created.Body.String())
	}
	var inspection inspectionJSON
	if err := json.Unmarshal(created.Body.Bytes(), &inspection); err != nil {
		t.Fatalf("decode create: %v", err)
	}
	if len(inspection.MiteCounts) != 1 || inspection.MiteCounts[0].MitesCount != 6 {
		t.Fatalf("create did not return mite data: %#v", inspection.MiteCounts)
	}

	got := fixture.call(t, fixture.server.handleInspectionGet,
		http.MethodGet, "/inspections/"+inspection.ID.String(),
		nil, map[string]string{"id": inspection.ID.String()})
	if got.Code != http.StatusOK {
		t.Fatalf("get: status %d: %s", got.Code, got.Body.String())
	}
	if err := json.Unmarshal(got.Body.Bytes(), &inspection); err != nil {
		t.Fatalf("decode get: %v", err)
	}
	if len(inspection.MiteCounts) != 1 {
		t.Fatalf("GET omitted mite counts: %#v", inspection.MiteCounts)
	}

	updated := fixture.call(t, fixture.server.handleInspectionUpdate,
		http.MethodPut, "/inspections/"+inspection.ID.String(),
		map[string]any{
			"miteCounts": []map[string]any{{
				"method": "alcohol_wash", "mitesCount": 12, "sampleSize": 300,
			}},
		}, map[string]string{"id": inspection.ID.String()})
	if updated.Code != http.StatusOK {
		t.Fatalf("update: status %d: %s", updated.Code, updated.Body.String())
	}
	if err := json.Unmarshal(updated.Body.Bytes(), &inspection); err != nil {
		t.Fatalf("decode update: %v", err)
	}
	if len(inspection.MiteCounts) != 1 || inspection.MiteCounts[0].MitesCount != 12 {
		t.Fatalf("update did not rewrite mite counts: %#v", inspection.MiteCounts)
	}
	if inspection.MiteCounts[0].MitesPer100 == nil ||
		math.Abs(*inspection.MiteCounts[0].MitesPer100-4) > 0.0001 {
		t.Fatalf("updated rate = %#v, want 4", inspection.MiteCounts[0].MitesPer100)
	}
}

func TestInspectionMiteCountsPatchedIndividually(t *testing.T) {
	fixture := newHiveScopeFixture(t)
	created := fixture.call(t, fixture.server.handleInspectionCreate,
		http.MethodPost, "/inspections",
		map[string]any{
			"hiveId": fixture.hiveA.String(), "date": "2026-08-05",
			"miteCounts": []map[string]any{
				{"method": "alcohol_wash", "mitesCount": 6, "sampleSize": 300},
				{"method": "sticky_board", "mitesCount": 12, "daysOnBoard": 2},
			},
		}, nil)
	if created.Code != http.StatusCreated {
		t.Fatalf("create: status %d: %s", created.Code, created.Body.String())
	}
	var inspection inspectionJSON
	if err := json.Unmarshal(created.Body.Bytes(), &inspection); err != nil {
		t.Fatalf("decode create: %v", err)
	}
	if len(inspection.MiteCounts) != 2 {
		t.Fatalf("create mite counts = %d, want 2", len(inspection.MiteCounts))
	}

	listed := fixture.call(t, fixture.server.miteCountList,
		http.MethodGet, "/mite-counts?inspectionId="+inspection.ID.String(), nil, nil)
	if listed.Code != http.StatusOK {
		t.Fatalf("list: %d %s", listed.Code, listed.Body.String())
	}
	var rows []miteCountJSON
	if err := json.Unmarshal(listed.Body.Bytes(), &rows); err != nil {
		t.Fatalf("decode list: %v", err)
	}
	if len(rows) != 2 {
		t.Fatalf("list = %d, want 2", len(rows))
	}

	byMethod := map[string]miteCountJSON{}
	for _, row := range rows {
		byMethod[row.Method] = row
	}
	wash := byMethod["alcohol_wash"]
	board := byMethod["sticky_board"]
	if wash.ID == uuid.Nil || board.ID == uuid.Nil {
		t.Fatalf("missing method rows: %#v", byMethod)
	}

	patched := fixture.call(t, fixture.server.miteCountUpdate,
		http.MethodPatch, "/mite-counts/"+board.ID.String(),
		map[string]any{"mitesCount": 4, "daysOnBoard": 2},
		map[string]string{"id": board.ID.String()})
	if patched.Code != http.StatusOK {
		t.Fatalf("patch board: %d %s", patched.Code, patched.Body.String())
	}
	var after map[string]any
	if err := json.Unmarshal(patched.Body.Bytes(), &after); err != nil {
		t.Fatalf("decode patch: %v", err)
	}
	if got, _ := after["mitesPerDay"].(float64); math.Abs(got-2) > 0.0001 {
		t.Fatalf("patched board mitesPerDay = %v, want 2", after["mitesPerDay"])
	}

	listed = fixture.call(t, fixture.server.miteCountList,
		http.MethodGet, "/mite-counts?inspectionId="+inspection.ID.String(), nil, nil)
	if err := json.Unmarshal(listed.Body.Bytes(), &rows); err != nil {
		t.Fatalf("decode list after patch: %v", err)
	}
	for _, row := range rows {
		byMethod[row.Method] = row
	}
	if byMethod["alcohol_wash"].MitesCount != 6 {
		t.Fatalf("wash was rewritten: %#v", byMethod["alcohol_wash"])
	}
	if byMethod["sticky_board"].MitesCount != 4 {
		t.Fatalf("board was not patched: %#v", byMethod["sticky_board"])
	}

	deleted := fixture.call(t, fixture.server.miteCountDelete,
		http.MethodDelete, "/mite-counts/"+wash.ID.String(),
		nil, map[string]string{"id": wash.ID.String()})
	if deleted.Code != http.StatusOK {
		t.Fatalf("delete wash: %d %s", deleted.Code, deleted.Body.String())
	}
	listed = fixture.call(t, fixture.server.miteCountList,
		http.MethodGet, "/mite-counts?inspectionId="+inspection.ID.String(), nil, nil)
	if err := json.Unmarshal(listed.Body.Bytes(), &rows); err != nil {
		t.Fatalf("decode list after delete: %v", err)
	}
	if len(rows) != 1 || rows[0].Method != "sticky_board" {
		t.Fatalf("after delete list = %#v, want only sticky_board", rows)
	}
}

func TestVarroaAnalyticsFleetAndThreshold(t *testing.T) {
	fixture := newHiveScopeFixture(t)
	if _, err := fixture.server.pool.Exec(fixture.ctx, `
		INSERT INTO mite_counts (hive_id, date, method, mites_count, sample_size)
		VALUES ($1,'2026-08-04','alcohol_wash',12,300)`, fixture.hiveA); err != nil {
		t.Fatalf("insert over-threshold count: %v", err)
	}
	if _, err := fixture.server.pool.Exec(fixture.ctx, `
		INSERT INTO mite_counts (hive_id, date, method, mites_count, sample_size)
		VALUES ($1,'2026-08-04','alcohol_wash',1,300)`, fixture.hiveB); err != nil {
		t.Fatalf("insert under-threshold count: %v", err)
	}

	// Editor can only see apiary A.
	fleet := fixture.call(t, fixture.server.varroaAnalytics,
		http.MethodGet, "/analytics/varroa", nil, nil)
	if fleet.Code != http.StatusOK {
		t.Fatalf("fleet: status %d: %s", fleet.Code, fleet.Body.String())
	}
	var body struct {
		Hives []struct {
			HiveID        string `json:"hiveId"`
			OverThreshold bool   `json:"overThreshold"`
			LastCount     *struct {
				MitesPer100 *float64 `json:"mitesPer100"`
			} `json:"lastCount"`
		} `json:"hives"`
		OverThresholdCount int `json:"overThresholdCount"`
	}
	if err := json.Unmarshal(fleet.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode fleet: %v", err)
	}
	if len(body.Hives) != 1 || body.Hives[0].HiveID != fixture.hiveA.String() {
		t.Fatalf("fleet should list only visible hives, got %#v", body.Hives)
	}
	if !body.Hives[0].OverThreshold || body.OverThresholdCount != 1 {
		t.Fatalf("expected hive A over threshold: %#v", body)
	}

	single := fixture.call(t, fixture.server.varroaAnalytics,
		http.MethodGet, "/analytics/varroa?hiveId="+fixture.hiveA.String(), nil, nil)
	if single.Code != http.StatusOK {
		t.Fatalf("single: status %d: %s", single.Code, single.Body.String())
	}
	var hiveBody struct {
		OverThreshold bool `json:"overThreshold"`
		Counts        []struct {
			MitesPer100 *float64 `json:"mitesPer100"`
		} `json:"counts"`
	}
	if err := json.Unmarshal(single.Body.Bytes(), &hiveBody); err != nil {
		t.Fatalf("decode single: %v", err)
	}
	if !hiveBody.OverThreshold || len(hiveBody.Counts) != 1 {
		t.Fatalf("single-hive analytics: %#v", hiveBody)
	}

	denied := fixture.call(t, fixture.server.varroaAnalytics,
		http.MethodGet, "/analytics/varroa?hiveId="+fixture.hiveB.String(), nil, nil)
	if denied.Code != http.StatusForbidden && denied.Code != http.StatusNotFound {
		t.Fatalf("other-yard hive = %d, want 403/404", denied.Code)
	}
}

func insertMite(
	t *testing.T,
	fixture *hiveScopeFixture,
	hive uuid.UUID,
	date, method string,
	count int,
	sample, days *int,
) {
	t.Helper()
	if _, err := fixture.server.pool.Exec(fixture.ctx, `
		INSERT INTO mite_counts
			(hive_id, date, method, mites_count, sample_size, days_on_board)
		VALUES ($1,$2::timestamptz,$3,$4,$5,$6)`,
		hive, date, method, count, sample, days); err != nil {
		t.Fatalf("insert mite %s %s: %v", date, method, err)
	}
}

func insertTreatment(
	t *testing.T,
	fixture *hiveScopeFixture,
	hive uuid.UUID,
	applied, product string,
	removed *string,
) uuid.UUID {
	t.Helper()
	var id uuid.UUID
	if err := fixture.server.pool.QueryRow(fixture.ctx, `
		INSERT INTO treatment_events (hive_id, date_applied, product, date_removed)
		VALUES ($1,$2::timestamptz,$3,$4) RETURNING id`,
		hive, applied, product, removed).Scan(&id); err != nil {
		t.Fatalf("insert treatment %s: %v", applied, err)
	}
	return id
}

func TestVarroaEfficacyWindowsAndBoardRates(t *testing.T) {
	fixture := newHiveScopeFixture(t)
	hive := fixture.hiveA
	sample := 300
	days := 2

	// In-window wash before (Aug 1) and after (Aug 20) for a treatment applied Aug 5
	// and removed Aug 12. After is after date_removed and before the next treatment.
	insertMite(t, fixture, hive, "2026-08-01", "alcohol_wash", 12, &sample, nil)
	insertTreatment(t, fixture, hive, "2026-08-05", "Apiguard", strPtr("2026-08-12"))
	insertMite(t, fixture, hive, "2026-08-20", "alcohol_wash", 3, &sample, nil)

	// Out-of-window "before" (June 1, 65 days earlier) must not pair.
	insertMite(t, fixture, hive, "2026-06-01", "alcohol_wash", 99, &sample, nil)

	// Second treatment Oct 1. A count after it must not be used as the first
	// treatment's "after", even though it is later. A Sep 20 wash is inside
	// OA's 21-day before window (Aug 20 is not).
	insertMite(t, fixture, hive, "2026-09-20", "alcohol_wash", 6, &sample, nil)
	insertTreatment(t, fixture, hive, "2026-10-01", "OA vapor", nil)
	insertMite(t, fixture, hive, "2026-10-08", "alcohol_wash", 1, &sample, nil)

	// Board-only treatment: mites/day should pair.
	insertMite(t, fixture, hive, "2026-07-01", "sticky_board", 24, nil, &days)
	insertTreatment(t, fixture, hive, "2026-07-03", "HopGuard", strPtr("2026-07-10"))
	insertMite(t, fixture, hive, "2026-07-18", "sticky_board", 6, nil, &days)

	// Count taken while strips are still in (Jul 6) is not an after-count.
	insertMite(t, fixture, hive, "2026-07-06", "sticky_board", 1, nil, &days)

	rows, err := queryVarroaEfficacy(fixture.ctx, fixture.server.pool, &hive)
	if err != nil {
		t.Fatalf("efficacy query: %v", err)
	}
	if len(rows) != 3 {
		t.Fatalf("got %d treatments, want 3", len(rows))
	}

	byProduct := map[string]varroaEfficacyRow{}
	for _, row := range rows {
		byProduct[row.Product] = row
	}

	apiguard := byProduct["Apiguard"]
	if apiguard.Before == nil || math.Abs(*apiguard.Before-4) > 0.0001 {
		t.Fatalf("Apiguard before = %#v, want 4 (12/300); June count must be ignored", apiguard.Before)
	}
	if apiguard.After == nil || math.Abs(*apiguard.After-1) > 0.0001 {
		t.Fatalf("Apiguard after = %#v, want 1; Oct count belongs to the next treatment", apiguard.After)
	}
	if got := apiguard.efficacyPercent(); got == nil || math.Abs(*got-75) > 0.01 {
		t.Fatalf("Apiguard efficacy = %#v, want 75", got)
	}

	oa := byProduct["OA vapor"]
	if oa.Before == nil || math.Abs(*oa.Before-2) > 0.0001 {
		t.Fatalf("OA before should be the Sep 20 count (6/300=2), got %#v", oa.Before)
	}
	if oa.After == nil || math.Abs(*oa.After-(1.0*100.0/300.0)) > 0.0001 {
		t.Fatalf("OA after = %#v, want 0.333", oa.After)
	}

	hop := byProduct["HopGuard"]
	if hop.Before == nil || math.Abs(*hop.Before-12) > 0.0001 {
		t.Fatalf("HopGuard before (board rate) = %#v, want 12 mites/day", hop.Before)
	}
	if hop.After == nil || math.Abs(*hop.After-3) > 0.0001 {
		t.Fatalf("HopGuard after = %#v, want 3 mites/day (not the in-treatment 0.5)", hop.After)
	}
	if hop.BeforeKind == nil || *hop.BeforeKind != "per_day" {
		t.Fatalf("HopGuard should pair as per_day, got %#v", hop.BeforeKind)
	}
	if got := hop.efficacyPercent(); got == nil || math.Abs(*got-75) > 0.01 {
		t.Fatalf("HopGuard efficacy = %#v, want 75", got)
	}
}

func TestVarroaEfficacyIgnoresAfterAfterNextTreatmentAndMismatchedUnits(t *testing.T) {
	fixture := newHiveScopeFixture(t)
	hive := fixture.hiveA
	sample := 300
	days := 1

	insertMite(t, fixture, hive, "2026-05-01", "alcohol_wash", 9, &sample, nil)
	insertTreatment(t, fixture, hive, "2026-05-05", "Formic", nil)
	insertTreatment(t, fixture, hive, "2026-05-12", "OA", nil)
	// This after-count is after the next treatment, so Formic must stay unpaired.
	insertMite(t, fixture, hive, "2026-05-20", "alcohol_wash", 1, &sample, nil)
	// Same-kind, different-method after-count must not pair.
	insertMite(t, fixture, hive, "2026-06-01", "alcohol_wash", 6, &sample, nil)
	insertTreatment(t, fixture, hive, "2026-06-05", "Mixed", nil)
	insertMite(t, fixture, hive, "2026-06-15", "sugar_roll", 2, &sample, nil)
	insertMite(t, fixture, hive, "2026-06-16", "sticky_board", 2, nil, &days)

	rows, err := queryVarroaEfficacy(fixture.ctx, fixture.server.pool, &hive)
	if err != nil {
		t.Fatalf("efficacy query: %v", err)
	}
	byProduct := map[string]varroaEfficacyRow{}
	for _, row := range rows {
		byProduct[row.Product] = row
	}

	formic := byProduct["Formic"]
	if formic.After != nil {
		t.Fatalf("Formic after should be nil (count is after next treatment), got %#v", formic.After)
	}
	if formic.efficacyPercent() != nil {
		t.Fatal("Formic should not report efficacy without an after count")
	}

	mixed := byProduct["Mixed"]
	if mixed.Before == nil {
		t.Fatal("Mixed should keep the wash before-count")
	}
	if mixed.After != nil {
		t.Fatalf("Mixed after should be nil without a same-method count, got %#v", mixed.After)
	}
	if mixed.efficacyPercent() != nil {
		t.Fatal("mismatched-method pairing must not invent a percent reduction")
	}
}

func TestVarroaAnalyticsOmitsDeletedCounts(t *testing.T) {
	fixture := newHiveScopeFixture(t)
	created := fixture.call(t, fixture.server.miteCountCreate,
		http.MethodPost, "/mite-counts",
		map[string]any{
			"hiveId": fixture.hiveA.String(), "date": "2026-08-04",
			"method": "alcohol_wash", "mitesCount": 12, "sampleSize": 300,
		}, nil)
	if created.Code != http.StatusCreated {
		t.Fatalf("create: %d %s", created.Code, created.Body.String())
	}
	var body map[string]any
	if err := json.Unmarshal(created.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	id := body["id"].(string)

	listed := fixture.call(t, fixture.server.miteCountList,
		http.MethodGet, "/mite-counts?hiveId="+fixture.hiveA.String(), nil, nil)
	if listed.Code != http.StatusOK {
		t.Fatalf("list: %d %s", listed.Code, listed.Body.String())
	}
	var live []map[string]any
	if err := json.Unmarshal(listed.Body.Bytes(), &live); err != nil {
		t.Fatalf("decode list: %v", err)
	}
	if len(live) != 1 {
		t.Fatalf("list before delete = %d, want 1", len(live))
	}

	deleted := fixture.call(t, fixture.server.miteCountDelete,
		http.MethodDelete, "/mite-counts/"+id, nil, map[string]string{"id": id})
	if deleted.Code != http.StatusOK {
		t.Fatalf("delete: %d %s", deleted.Code, deleted.Body.String())
	}

	after := fixture.call(t, fixture.server.varroaAnalytics,
		http.MethodGet, "/analytics/varroa?hiveId="+fixture.hiveA.String(), nil, nil)
	if after.Code != http.StatusOK {
		t.Fatalf("analytics: %d %s", after.Code, after.Body.String())
	}
	var report struct {
		Counts []map[string]any `json:"counts"`
		Latest any              `json:"latest"`
	}
	if err := json.Unmarshal(after.Body.Bytes(), &report); err != nil {
		t.Fatalf("decode analytics: %v", err)
	}
	if len(report.Counts) != 0 || report.Latest != nil {
		t.Fatalf("deleted count still in analytics: %#v", report)
	}

	empty := fixture.call(t, fixture.server.miteCountList,
		http.MethodGet, "/mite-counts?hiveId="+fixture.hiveA.String(), nil, nil)
	if empty.Code != http.StatusOK {
		t.Fatalf("list after delete: %d %s", empty.Code, empty.Body.String())
	}
	live = nil
	if err := json.Unmarshal(empty.Body.Bytes(), &live); err != nil {
		t.Fatalf("decode empty list: %v", err)
	}
	if len(live) != 0 {
		t.Fatalf("list after delete = %d, want 0", len(live))
	}
}
