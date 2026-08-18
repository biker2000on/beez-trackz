package httpapi

import (
	"context"
	"net/http"
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
