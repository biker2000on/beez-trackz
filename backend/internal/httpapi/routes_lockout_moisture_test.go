package httpapi

import (
	"context"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
)

func seedLockoutHive(t *testing.T, server *Server) (apiaryID, hiveID uuid.UUID) {
	t.Helper()
	ctx := context.Background()
	if err := server.pool.QueryRow(ctx,
		`INSERT INTO apiaries (name) VALUES ($1) RETURNING id`,
		"Lockout yard "+uuid.NewString()).Scan(&apiaryID); err != nil {
		t.Fatalf("seed apiary: %v", err)
	}
	if err := server.pool.QueryRow(ctx,
		`INSERT INTO hives (apiary_id, position_label) VALUES ($1,'L1') RETURNING id`,
		apiaryID).Scan(&hiveID); err != nil {
		t.Fatalf("seed hive: %v", err)
	}
	return apiaryID, hiveID
}

func insertLockoutTreatment(t *testing.T, server *Server, hiveID uuid.UUID, applied, removed *string, days int) {
	t.Helper()
	var removedAt any
	if removed != nil {
		removedAt = *removed
	}
	if _, err := server.pool.Exec(context.Background(), `
		INSERT INTO treatment_events (hive_id, date_applied, product, date_removed, withdrawal_days)
		VALUES ($1,$2,'Apivar',$3,$4)`, hiveID, *applied, removedAt, days); err != nil {
		t.Fatalf("insert treatment: %v", err)
	}
}

func TestHarvestRefusedWhileTreatmentOn(t *testing.T) {
	server := honeyTestServer(t)
	_, hiveID := seedLockoutHive(t, server)
	applied := "2026-08-01"
	insertLockoutTreatment(t, server, hiveID, &applied, nil, 0)

	response, body := call(t, server.honeyCreateHarvest, adminRequest(
		http.MethodPost, "/harvests", map[string]any{
			"hiveId": hiveID.String(), "date": "2026-08-10",
			"harvestedWeight": 12.5,
		}))
	if response.Code != http.StatusConflict {
		t.Fatalf("harvest while on = %d %v, want 409", response.Code, body)
	}
	if got, _ := body["error"].(string); got != "This honey cannot be extracted/sold until Apivar is removed" {
		t.Fatalf("error = %q", got)
	}
}

func TestHarvestRefusedDuringWithdrawalAndAllowedAfter(t *testing.T) {
	server := honeyTestServer(t)
	_, hiveID := seedLockoutHive(t, server)
	applied, removed := "2026-08-01", "2026-08-10"
	insertLockoutTreatment(t, server, hiveID, &applied, &removed, 14)

	blocked, body := call(t, server.honeyCreateHarvest, adminRequest(
		http.MethodPost, "/harvests", map[string]any{
			"hiveId": hiveID.String(), "date": "2026-08-23",
			"harvestedWeight": 8,
		}))
	if blocked.Code != http.StatusConflict {
		t.Fatalf("harvest in window = %d %v, want 409", blocked.Code, body)
	}
	if got, _ := body["error"].(string); got != "This honey cannot be extracted/sold until 2026-08-24" {
		t.Fatalf("error = %q", got)
	}

	allowed, allowedBody := call(t, server.honeyCreateHarvest, adminRequest(
		http.MethodPost, "/harvests", map[string]any{
			"hiveId": hiveID.String(), "date": "2026-08-24",
			"harvestedWeight": 8,
		}))
	if allowed.Code != http.StatusCreated {
		t.Fatalf("harvest on until date = %d %v, want 201", allowed.Code, allowedBody)
	}
}

func TestSessionEntryRefusedDuringLockout(t *testing.T) {
	server := honeyTestServer(t)
	apiaryID, hiveID := seedLockoutHive(t, server)
	applied, removed := "2026-08-01", "2026-08-10"
	insertLockoutTreatment(t, server, hiveID, &applied, &removed, 14)

	created, createdBody := call(t, server.hsCreate, adminRequest(
		http.MethodPost, "/harvest-sessions", map[string]any{
			"apiaryId": apiaryID.String(), "date": "2026-08-15",
		}))
	if created.Code != http.StatusCreated {
		t.Fatalf("create session = %d %v", created.Code, createdBody)
	}
	sessionID, _ := createdBody["id"].(string)

	blocked, body := call(t, server.hsAddEntry, adminRequest(
		http.MethodPost, "/harvest-sessions/"+sessionID+"/entries",
		map[string]any{
			"hiveId": hiveID.String(), "harvestedWeight": 5,
		}, "id", sessionID))
	if blocked.Code != http.StatusConflict {
		t.Fatalf("session entry = %d %v, want 409", blocked.Code, body)
	}
}

func TestSaleRefusedWhileLotLocked(t *testing.T) {
	server := honeyTestServer(t)
	jarSizeID := seedJarSize(t, server, "Pint", 16, 1200)
	_, hiveID := seedLockoutHive(t, server)
	applied, removed := "2026-08-01", "2026-08-10"
	insertLockoutTreatment(t, server, hiveID, &applied, &removed, 14)

	ctx := context.Background()
	var harvestID uuid.UUID
	if err := server.pool.QueryRow(ctx, `
		INSERT INTO honey_harvests
			(hive_id, date, super_weight_before, super_weight_after, calculated_honey_weight)
		VALUES ($1,'2026-08-15',20,0,20) RETURNING id`, hiveID).Scan(&harvestID); err != nil {
		t.Fatalf("seed tainted harvest: %v", err)
	}
	if _, err := server.pool.Exec(ctx, `
		INSERT INTO honey_harvests
			(hive_id, date, super_weight_before, super_weight_after, calculated_honey_weight)
		VALUES ($1,'2026-08-24',80,0,80)`, hiveID); err != nil {
		t.Fatalf("seed bulk harvest: %v", err)
	}
	jarStock(t, server, jarSizeID, 4)

	created, createdBody := call(t, server.harvestLotCreate, adminRequest(
		http.MethodPost, "/harvest-lots", map[string]any{
			"lotCode":        "LOCK-1",
			"extractionDate": "2026-08-15",
			"honeyWeightLbs": 20,
			"harvestIds":     []string{harvestID.String()},
		}))
	if created.Code != http.StatusCreated {
		t.Fatalf("create lot = %d %v", created.Code, createdBody)
	}
	lotID, _ := createdBody["id"].(string)

	blocked, body := call(t, server.honeyRecordSale, adminRequest(
		http.MethodPost, "/honey/sales", map[string]any{
			"date":         "2026-08-16",
			"harvestLotId": lotID,
			"lines": []map[string]any{
				{"jarSizeId": jarSizeID.String(), "quantity": 1, "unitPrice": 10},
			},
		}))
	if blocked.Code != http.StatusConflict {
		t.Fatalf("sale of locked lot = %d %v, want 409", blocked.Code, body)
	}

	allowed, allowedBody := call(t, server.honeyRecordSale, adminRequest(
		http.MethodPost, "/honey/sales", map[string]any{
			"date":         "2026-08-24",
			"harvestLotId": lotID,
			"lines": []map[string]any{
				{"jarSizeId": jarSizeID.String(), "quantity": 1, "unitPrice": 10},
			},
		}))
	if allowed.Code != http.StatusCreated {
		t.Fatalf("sale after lockout = %d %v, want 201", allowed.Code, allowedBody)
	}
}

func TestHarvestSessionMoistureReject(t *testing.T) {
	server := honeyTestServer(t)
	apiaryID, _ := seedLockoutHive(t, server)

	blocked, body := call(t, server.hsCreate, adminRequest(
		http.MethodPost, "/harvest-sessions", map[string]any{
			"apiaryId": apiaryID.String(), "date": "2026-08-01",
			"moisturePct": 19.2,
		}))
	if blocked.Code != http.StatusBadRequest {
		t.Fatalf("wet session = %d %v, want 400", blocked.Code, body)
	}
	if got, _ := body["error"].(string); got != "Moisture 19.2% is over the 18.6% harvest threshold" {
		t.Fatalf("error = %q", got)
	}

	ok, okBody := call(t, server.hsCreate, adminRequest(
		http.MethodPost, "/harvest-sessions", map[string]any{
			"apiaryId": apiaryID.String(), "date": "2026-08-01",
			"moisturePct": 18.6,
		}))
	if ok.Code != http.StatusCreated {
		t.Fatalf("18.6 session = %d %v, want 201", ok.Code, okBody)
	}
}

func TestLotMoistureReject(t *testing.T) {
	server := honeyTestServer(t)

	blocked, body := call(t, server.harvestLotCreate, adminRequest(
		http.MethodPost, "/harvest-lots", map[string]any{
			"lotCode":        "WET-1",
			"extractionDate": "2026-08-01",
			"honeyWeightLbs": 10,
			"moisturePct":    20,
		}))
	if blocked.Code != http.StatusBadRequest {
		t.Fatalf("wet lot = %d %v, want 400", blocked.Code, body)
	}

	ok, okBody := call(t, server.harvestLotCreate, adminRequest(
		http.MethodPost, "/harvest-lots", map[string]any{
			"lotCode":        "DRY-1",
			"extractionDate": "2026-08-01",
			"honeyWeightLbs": 10,
			"moisturePct":    17.4,
		}))
	if ok.Code != http.StatusCreated {
		t.Fatalf("dry lot = %d %v, want 201", ok.Code, okBody)
	}
}

func TestHiveGetSurfacesLockout(t *testing.T) {
	server := honeyTestServer(t)
	_, hiveID := seedLockoutHive(t, server)
	applied, removed := "2026-08-01", "2026-08-10"
	insertLockoutTreatment(t, server, hiveID, &applied, &removed, 14)

	response, hive := call(t, server.handleHiveGet, adminRequest(
		http.MethodGet, "/hives/"+hiveID.String(), nil, "id", hiveID.String()))
	if response.Code != http.StatusOK {
		t.Fatalf("hive get = %d %s", response.Code, response.Body.String())
	}
	lockout, _ := hive["lockout"].(map[string]any)
	if lockout == nil {
		t.Fatalf("expected lockout on hive: %v", hive)
	}
	if _, ok := lockout["message"].(string); !ok {
		t.Fatalf("lockout missing message: %v", lockout)
	}
}

func TestMoistureThresholdSettingOverride(t *testing.T) {
	server := honeyTestServer(t)
	ctx := context.Background()
	var previous *float64
	err := server.pool.QueryRow(ctx, `SELECT moisture_threshold_pct FROM user_settings LIMIT 1`).Scan(&previous)
	if err != nil {
		if _, err := server.pool.Exec(ctx, `
			INSERT INTO user_settings (moisture_threshold_pct) VALUES (20)`); err != nil {
			t.Fatalf("insert settings: %v", err)
		}
	} else if _, err := server.pool.Exec(ctx, `
		UPDATE user_settings SET moisture_threshold_pct = 20
		WHERE id = (SELECT id FROM user_settings LIMIT 1)`); err != nil {
		t.Fatalf("set threshold: %v", err)
	}
	t.Cleanup(func() {
		_, _ = server.pool.Exec(context.Background(), `
			UPDATE user_settings SET moisture_threshold_pct = $1
			WHERE id = (SELECT id FROM user_settings LIMIT 1)`, previous)
	})

	apiaryID, _ := seedLockoutHive(t, server)
	ok, body := call(t, server.hsCreate, adminRequest(
		http.MethodPost, "/harvest-sessions", map[string]any{
			"apiaryId": apiaryID.String(), "date": time.Now().Format("2006-01-02"),
			"moisturePct": 19.5,
		}))
	if ok.Code != http.StatusCreated {
		t.Fatalf("19.5 under a 20%% threshold = %d %v", ok.Code, body)
	}
}

func TestProductBatchRefusedWhileLotLocked(t *testing.T) {
	server := honeyTestServer(t)
	_, hiveID := seedLockoutHive(t, server)
	applied, removed := "2026-08-01", "2026-08-10"
	insertLockoutTreatment(t, server, hiveID, &applied, &removed, 14)

	ctx := context.Background()
	var harvestID uuid.UUID
	if err := server.pool.QueryRow(ctx, `
		INSERT INTO honey_harvests
			(hive_id, date, super_weight_before, super_weight_after, calculated_honey_weight)
		VALUES ($1,'2026-08-15',20,0,20) RETURNING id`, hiveID).Scan(&harvestID); err != nil {
		t.Fatalf("seed tainted harvest: %v", err)
	}
	created, createdBody := call(t, server.harvestLotCreate, adminRequest(
		http.MethodPost, "/harvest-lots", map[string]any{
			"lotCode":        "LOCK-BATCH",
			"extractionDate": "2026-08-15",
			"honeyWeightLbs": 20,
			"harvestIds":     []string{harvestID.String()},
		}))
	if created.Code != http.StatusCreated {
		t.Fatalf("create lot = %d %v", created.Code, createdBody)
	}
	lotID, _ := createdBody["id"].(string)

	createProduct, productBody := call(t, server.productCreate, adminRequest(
		http.MethodPost, "/api/v1/products", map[string]any{
			"name": "Creamed locked", "kind": "creamed_honey", "unit": "jar",
			"defaultPrice": 14, "sizeLabel": "8 oz",
		}))
	if createProduct.Code != http.StatusCreated {
		t.Fatalf("create product = %d %v", createProduct.Code, productBody)
	}
	productID, _ := productBody["id"].(string)

	batch := func(startedAt string) (int, map[string]any) {
		response, body := call(t, server.productBatchCreate, adminRequest(
			http.MethodPost, "/api/v1/product-batches", map[string]any{
				"kind": "creamed_honey", "productId": productID, "harvestLotId": lotID,
				"startedAt": startedAt, "honeyLbs": 5, "quantityOut": 8,
			}))
		return response.Code, body
	}
	if code, body := batch("2026-08-16"); code != http.StatusConflict {
		t.Fatalf("batch from locked lot = %d %v, want 409", code, body)
	}
	if code, body := batch("2026-08-24"); code != http.StatusCreated {
		t.Fatalf("batch after lockout = %d %v, want 201", code, body)
	}
}

// --- bottling refusal ----------------------------------------------------

func TestBottlingLockoutMessage(t *testing.T) {
	until := time.Date(2026, 8, 24, 0, 0, 0, 0, time.UTC)
	cases := []struct {
		name      string
		status    lockoutStatus
		lotCode   string
		hiveLabel string
		want      string
	}{
		{
			name:   "not locked says nothing",
			status: lockoutStatus{Locked: false, Product: "Apivar"},
			want:   "",
		},
		{
			name: "treatment still on names the days it clears after removal",
			status: lockoutStatus{
				Locked: true, TreatmentOn: true, Product: "Apivar", WithdrawalDays: 14,
			},
			lotCode:   "LOT-1",
			hiveLabel: "L1",
			want: "Lot LOT-1 cannot be bottled: Apivar is still on hive L1; " +
				"this honey clears 14 days after it is removed",
		},
		{
			name: "zero-day product still blocks while it is on",
			status: lockoutStatus{
				Locked: true, TreatmentOn: true, Product: "Formic Pro", WithdrawalDays: 0,
			},
			lotCode:   "LOT-2",
			hiveLabel: "B7",
			want: "Lot LOT-2 cannot be bottled: Formic Pro is still on hive B7; " +
				"this honey clears once it is removed",
		},
		{
			name: "removed treatment names the end date",
			status: lockoutStatus{
				Locked: true, Product: "CheckMite+", WithdrawalDays: 14, Until: &until,
			},
			lotCode:   "LOT-3",
			hiveLabel: "A2",
			want: "Lot LOT-3 cannot be bottled: CheckMite+ was applied to hive A2; " +
				"this honey clears 2026-08-24",
		},
		{
			name:   "missing lot code and hive label still produce a usable message",
			status: lockoutStatus{Locked: true, Product: "  ", Until: &until},
			want: "This lot cannot be bottled: a treatment was applied to the source hive; " +
				"this honey clears 2026-08-24",
		},
		{
			name:      "locked with no end date falls back",
			status:    lockoutStatus{Locked: true, Product: "Apiguard"},
			lotCode:   "LOT-4",
			hiveLabel: "C3",
			want: "Lot LOT-4 cannot be bottled: Apiguard was applied to hive C3 " +
				"and the withdrawal window has not ended",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := bottlingLockoutMessage(tc.status, tc.lotCode, tc.hiveLabel); got != tc.want {
				t.Fatalf("message = %q, want %q", got, tc.want)
			}
		})
	}
}

// --- moisture override tier ----------------------------------------------

func TestMoistureOverrideDecision(t *testing.T) {
	pct := func(v float64) *float64 { return &v }
	str := func(v string) *string { return &v }
	long := strings.Repeat("x", maxMoistureOverrideReason+1)
	cases := []struct {
		name       string
		pct        *float64
		override   moistureOverrideReq
		wantMsg    string
		wantReason *string
	}{
		{
			name: "no reading is nothing to judge",
			pct:  nil,
		},
		{
			name:    "out of range is still a validation error",
			pct:     pct(120),
			wantMsg: "Moisture must be between 0 and 100",
		},
		{
			name:     "an override on an out of range reading does not rescue it",
			pct:      pct(120),
			override: moistureOverrideReq{MoistureOverride: true, MoistureOverrideReason: str("because")},
			wantMsg:  "Moisture must be between 0 and 100",
		},
		{
			name: "under threshold passes",
			pct:  pct(17.2),
		},
		{
			name:     "under threshold drops an unnecessary override",
			pct:      pct(17.2),
			override: moistureOverrideReq{MoistureOverride: true, MoistureOverrideReason: str("habit")},
		},
		{
			name:    "over threshold without the flag is still a hard reject",
			pct:     pct(19.4),
			wantMsg: "Moisture 19.4% is over the 18.6% harvest threshold",
		},
		{
			name:     "the flag alone is not enough",
			pct:      pct(19.4),
			override: moistureOverrideReq{MoistureOverride: true},
			wantMsg: "Moisture 19.4% is over the 18.6% harvest threshold. " +
				"Set moistureOverrideReason to record why it is being accepted anyway",
		},
		{
			name:     "a blank reason is not a reason",
			pct:      pct(19.4),
			override: moistureOverrideReq{MoistureOverride: true, MoistureOverrideReason: str("   ")},
			wantMsg: "Moisture 19.4% is over the 18.6% harvest threshold. " +
				"Set moistureOverrideReason to record why it is being accepted anyway",
		},
		{
			name:       "flag plus reason is accepted and the reason is trimmed",
			pct:        pct(19.4),
			override:   moistureOverrideReq{MoistureOverride: true, MoistureOverrideReason: str("  going to mead  ")},
			wantReason: str("going to mead"),
		},
		{
			name:     "an unbounded reason is refused",
			pct:      pct(19.4),
			override: moistureOverrideReq{MoistureOverride: true, MoistureOverrideReason: &long},
			wantMsg:  "moistureOverrideReason cannot exceed 500 characters",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			msg, reason := moistureOverrideDecision(tc.pct, 18.6, tc.override)
			if msg != tc.wantMsg {
				t.Fatalf("message = %q, want %q", msg, tc.wantMsg)
			}
			switch {
			case tc.wantReason == nil && reason != nil:
				t.Fatalf("reason = %q, want none recorded", *reason)
			case tc.wantReason != nil && reason == nil:
				t.Fatalf("reason = none, want %q", *tc.wantReason)
			case tc.wantReason != nil && *reason != *tc.wantReason:
				t.Fatalf("reason = %q, want %q", *reason, *tc.wantReason)
			}
		})
	}
}

func mustLockoutDate(t *testing.T, value string) time.Time {
	t.Helper()
	parsed, err := time.Parse("2006-01-02", value)
	if err != nil {
		t.Fatalf("parse %q: %v", value, err)
	}
	return parsed
}

func TestRefuseLotBottlingMatchesSaleLockout(t *testing.T) {
	server := honeyTestServer(t)
	_, hiveID := seedLockoutHive(t, server)
	applied, removed := "2026-08-01", "2026-08-10"
	insertLockoutTreatment(t, server, hiveID, &applied, &removed, 14)

	ctx := context.Background()
	var harvestID uuid.UUID
	if err := server.pool.QueryRow(ctx, `
		INSERT INTO honey_harvests
			(hive_id, date, super_weight_before, super_weight_after, calculated_honey_weight)
		VALUES ($1,'2026-08-15',20,0,20) RETURNING id`, hiveID).Scan(&harvestID); err != nil {
		t.Fatalf("seed tainted harvest: %v", err)
	}
	created, body := call(t, server.harvestLotCreate, adminRequest(
		http.MethodPost, "/harvest-lots", map[string]any{
			"lotCode":        "LOCK-BOTTLE",
			"extractionDate": "2026-08-15",
			"honeyWeightLbs": 20,
			"harvestIds":     []string{harvestID.String()},
		}))
	if created.Code != http.StatusCreated {
		t.Fatalf("create lot = %d %v", created.Code, body)
	}
	lotID := uuid.MustParse(body["id"].(string))

	// Inside the window: refused, and the message has to name the hive, the
	// product and the date the honey clears.
	msg, err := refuseLotBottling(ctx, server.pool, lotID, "LOCK-BOTTLE",
		mustLockoutDate(t, "2026-08-16"))
	if err != nil {
		t.Fatalf("refuseLotBottling: %v", err)
	}
	for _, want := range []string{"LOCK-BOTTLE", "hive L1", "Apivar", "2026-08-24"} {
		if !strings.Contains(msg, want) {
			t.Fatalf("refusal %q does not name %q", msg, want)
		}
	}

	// Same rule as refuseLotSale, so both must agree on the same day.
	saleMsg, err := refuseLotSale(ctx, server.pool, lotID, mustLockoutDate(t, "2026-08-16"))
	if err != nil {
		t.Fatalf("refuseLotSale: %v", err)
	}
	if saleMsg == "" {
		t.Fatal("sale allowed while bottling refused: the two rules diverged")
	}

	// After the window both clear.
	msg, err = refuseLotBottling(ctx, server.pool, lotID, "LOCK-BOTTLE",
		mustLockoutDate(t, "2026-08-24"))
	if err != nil {
		t.Fatalf("refuseLotBottling after window: %v", err)
	}
	if msg != "" {
		t.Fatalf("bottling still refused after the window: %q", msg)
	}
}

// --- inspection PATCH keeps treatment_events in step -----------------------

func inspectionTreatmentEvents(t *testing.T, server *Server, inspectionID uuid.UUID) []treatmentLockoutRow {
	t.Helper()
	rows, err := server.pool.Query(context.Background(), `
		SELECT id, hive_id, product, date_applied, date_removed, withdrawal_days
		FROM treatment_events WHERE inspection_id = $1 ORDER BY product`, inspectionID)
	if err != nil {
		t.Fatalf("load treatment events: %v", err)
	}
	defer rows.Close()
	out := []treatmentLockoutRow{}
	for rows.Next() {
		var row treatmentLockoutRow
		if err := rows.Scan(&row.ID, &row.HiveID, &row.Product, &row.DateApplied,
			&row.DateRemoved, &row.WithdrawalDays); err != nil {
			t.Fatalf("scan treatment event: %v", err)
		}
		out = append(out, row)
	}
	return out
}

func createLockoutInspection(
	t *testing.T,
	server *Server,
	hiveID uuid.UUID,
	treatments []map[string]any,
) uuid.UUID {
	t.Helper()
	response, body := call(t, server.handleInspectionCreate, adminRequest(
		http.MethodPost, "/inspections", map[string]any{
			"hiveId": hiveID.String(), "date": "2026-08-05",
			"treatments": treatments,
		}))
	if response.Code != http.StatusCreated {
		t.Fatalf("create inspection = %d %v", response.Code, body)
	}
	id := uuid.MustParse(body["id"].(string))
	t.Cleanup(func() {
		_, _ = server.pool.Exec(context.Background(),
			`DELETE FROM treatment_events WHERE inspection_id = $1`, id)
		_, _ = server.pool.Exec(context.Background(),
			`DELETE FROM inspections WHERE id = $1`, id)
	})
	return id
}

func patchLockoutInspection(t *testing.T, server *Server, id uuid.UUID, body map[string]any) {
	t.Helper()
	response, decoded := call(t, server.handleInspectionUpdate, adminRequest(
		http.MethodPut, "/inspections/"+id.String(), body, "id", id.String()))
	if response.Code != http.StatusOK {
		t.Fatalf("patch inspection = %d %v", response.Code, decoded)
	}
}

func TestInspectionPatchSyncsTreatmentEvents(t *testing.T) {
	server := honeyTestServer(t)
	_, hiveID := seedLockoutHive(t, server)
	id := createLockoutInspection(t, server, hiveID, []map[string]any{
		{"product": "Apivar", "method": "strips"},
	})

	events := inspectionTreatmentEvents(t, server, id)
	if len(events) != 1 || events[0].Product != "Apivar" {
		t.Fatalf("create wrote %#v, want one Apivar event", events)
	}
	apivarDays := events[0].WithdrawalDays

	// Corrected product: the old event must stop locking the hive, and the new
	// one must carry the new product days from the catalog.
	patchLockoutInspection(t, server, id, map[string]any{
		"treatments": []map[string]any{{"product": "ApiLife Var", "method": "wafer"}},
	})
	events = inspectionTreatmentEvents(t, server, id)
	if len(events) != 1 {
		t.Fatalf("after product change: %#v, want exactly one event", events)
	}
	if events[0].Product != "ApiLife Var" {
		t.Fatalf("product = %q, want ApiLife Var", events[0].Product)
	}
	if events[0].WithdrawalDays == apivarDays && apivarDays != 0 {
		t.Fatalf("withdrawal days stayed at %d: the catalog was not re-resolved",
			events[0].WithdrawalDays)
	}

	// Treatment dropped from the inspection: the lockout goes with it.
	patchLockoutInspection(t, server, id, map[string]any{"treatments": []map[string]any{}})
	if events = inspectionTreatmentEvents(t, server, id); len(events) != 0 {
		t.Fatalf("after clearing treatments: %#v, want none", events)
	}
}

func TestInspectionPatchKeepsWithdrawalInFlight(t *testing.T) {
	server := honeyTestServer(t)
	_, hiveID := seedLockoutHive(t, server)
	id := createLockoutInspection(t, server, hiveID, []map[string]any{
		{"product": "Apivar", "method": "strips"},
	})
	if _, err := server.pool.Exec(context.Background(), `
		UPDATE treatment_events SET date_removed = '2026-08-20'
		WHERE inspection_id = $1`, id); err != nil {
		t.Fatalf("end treatment: %v", err)
	}

	// Editing the method must not restart a withdrawal clock already running.
	patchLockoutInspection(t, server, id, map[string]any{
		"treatments": []map[string]any{{"product": "apivar", "method": "2 strips"}},
	})
	events := inspectionTreatmentEvents(t, server, id)
	if len(events) != 1 {
		t.Fatalf("events = %#v, want one", events)
	}
	if events[0].DateRemoved == nil {
		t.Fatal("date_removed was cleared: the withdrawal window restarted")
	}
	if events[0].Product != "apivar" {
		t.Fatalf("product = %q, want the resubmitted spelling", events[0].Product)
	}
}

func TestInspectionDateChangeMovesTreatmentEvents(t *testing.T) {
	server := honeyTestServer(t)
	_, hiveID := seedLockoutHive(t, server)
	id := createLockoutInspection(t, server, hiveID, []map[string]any{
		{"product": "Apivar"},
	})
	patchLockoutInspection(t, server, id, map[string]any{"date": "2026-08-09"})
	events := inspectionTreatmentEvents(t, server, id)
	if len(events) != 1 {
		t.Fatalf("events = %#v, want one", events)
	}
	if got := calendarDate(events[0].DateApplied).Format("2006-01-02"); got != "2026-08-09" {
		t.Fatalf("date_applied = %s, want it to follow the inspection to 2026-08-09", got)
	}
}
