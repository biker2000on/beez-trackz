package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/biker2000on/beez-trackz/backend/internal/config"
	"github.com/biker2000on/beez-trackz/backend/internal/db"
)

// The equipment surface on a Phase B baseline database (spec section 9,
// 12.1 open item 3).
//
// A baseline database has no equipment_stock, no equipment_stock_adjustments,
// no equipment_deployments, and none of the three views over them. Every count
// an equipment endpoint reports has to come from inventory_balances,
// inventory_available, and the operation history instead. That is not something
// a code review can settle — a stale join only fails when the table is missing
// — so this boots the real handlers against a database migrated with the
// baseline profile and walks the whole surface: create, stock status, adjust,
// deploy, return, damage, loss report, reconciliation, and the two history
// listings.
//
// It also pins the two profile-aware id resolvers (equipItemSelect /
// equipTypeSelect): with BEEZ_SCHEMA_BASELINE set they must not emit the
// equipment_stock arm, and a PATCH addressed by item id must still land on the
// catalog row the attributes moved to.

// baselineEquipServer builds a scratch database on the baseline chain and a
// Server bound to it. The BEEZ_SCHEMA_BASELINE env var is set for the whole
// test, because db.ActiveProfile reads it on every call and the handlers
// consult it while composing SQL.
func baselineEquipServer(ctx context.Context, t *testing.T, name string) (*Server, uuid.UUID) {
	t.Helper()
	url := os.Getenv("TEST_DATABASE_URL")
	if url == "" {
		t.Skip("TEST_DATABASE_URL is not configured")
	}
	t.Setenv(db.BaselineEnvVar, "1")
	if db.ActiveProfile() != db.ProfileBaseline {
		t.Fatalf("active profile = %q, want the baseline", db.ActiveProfile())
	}

	admin, err := pgxpool.New(ctx, url)
	if err != nil {
		t.Fatalf("connect admin: %v", err)
	}
	defer admin.Close()
	if _, err := admin.Exec(ctx, "DROP DATABASE IF EXISTS "+name+" WITH (FORCE)"); err != nil {
		t.Fatalf("drop scratch database: %v", err)
	}
	if _, err := admin.Exec(ctx, "CREATE DATABASE "+name); err != nil {
		t.Fatalf("create scratch database: %v", err)
	}
	scratchURL := replaceBaselineDatabase(url, name)
	if err := db.MigrateProfile(ctx, scratchURL, db.ProfileBaseline); err != nil {
		t.Fatalf("migrate baseline: %v", err)
	}

	pool, err := pgxpool.New(ctx, scratchURL)
	if err != nil {
		t.Fatalf("connect scratch database: %v", err)
	}
	t.Cleanup(pool.Close)

	// The dropped tables are the point of the fixture: if any of them survived
	// the migration this test would prove nothing.
	for _, gone := range []string{
		"equipment_stock", "equipment_stock_adjustments", "equipment_deployments",
		"equipment_deployment_returns", "equipment_state_changes",
		"equipment_stock_status", "equipment_stock_reconciliation",
		"equipment_loss_events",
	} {
		var exists bool
		if err := pool.QueryRow(ctx,
			`SELECT to_regclass('public.'||$1) IS NOT NULL`, gone).Scan(&exists); err != nil {
			t.Fatalf("probe %s: %v", gone, err)
		}
		if exists {
			t.Fatalf("%s still exists on the baseline schema", gone)
		}
	}

	var userID uuid.UUID
	if err := pool.QueryRow(ctx, `
		INSERT INTO app_users (auth_subject, display_name, is_admin)
		VALUES ('httpapi-baseline-test', 'Baseline Admin', true)
		RETURNING id`).Scan(&userID); err != nil {
		t.Fatalf("seed admin: %v", err)
	}

	return &Server{
		cfg:  &config.Config{SessionSecret: "test", AppURL: "http://localhost:3000"},
		pool: pool,
	}, userID
}

// replaceBaselineDatabase swaps the database name in a postgres URL.
func replaceBaselineDatabase(url, name string) string {
	cut := strings.LastIndex(url, "/")
	if cut < 0 {
		return url
	}
	rest := ""
	if query := strings.Index(url[cut:], "?"); query >= 0 {
		rest = url[cut+query:]
	}
	return url[:cut+1] + name + rest
}

// baselineRequest is adminRequest bound to the scratch database's admin.
func baselineRequest(
	userID uuid.UUID, method, target string, body any, params ...string,
) *http.Request {
	request := adminRequest(method, target, body, params...)
	return request.WithContext(context.WithValue(request.Context(), principalKey, &principal{
		ID: userID, DisplayName: "Baseline Admin", IsAdmin: true,
	}))
}

func TestEquipmentEndpointsServeABaselineDatabase(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Minute)
	defer cancel()
	server, userID := baselineEquipServer(ctx, t, "beez_httpapi_equipment_baseline")

	ok := func(t *testing.T, what string, response *httptest.ResponseRecorder) {
		t.Helper()
		if response.Code >= 300 {
			t.Fatalf("%s = %d %s", what, response.Code, response.Body.String())
		}
	}

	// --- catalog + opening count ---
	response, body := call(t, server.equipCreateType,
		baselineRequest(userID, http.MethodPost, "/equipment/types",
			map[string]any{"name": "Baseline deep", "category": "box"}))
	ok(t, "create type", response)
	typeID := body["id"].(string)

	response, body = call(t, server.equipCreateStock,
		baselineRequest(userID, http.MethodPost, "/equipment/stock",
			map[string]any{"typeId": typeID, "initialQuantity": 10, "unitCostCents": 1500}))
	ok(t, "create stock", response)
	itemID := body["id"].(string)

	// --- stock status ---
	stock := baselineStockRow(t, server, userID, itemID)
	if stock.TotalOwned != 10 || stock.Available != 10 {
		t.Fatalf("opening stock = owned %d available %d, want 10/10", stock.TotalOwned, stock.Available)
	}

	// --- descriptive PATCH, addressed by the ITEM id ---
	// equipTypeSelect has to resolve it to the catalog row without touching
	// equipment_stock, which is where the attributes used to live.
	response, _ = call(t, server.equipUpdateStock,
		baselineRequest(userID, http.MethodPatch, "/equipment/stock/"+itemID,
			map[string]any{"storageLocation": "Shed B", "neededQuantity": 12}, "id", itemID))
	ok(t, "patch stock", response)
	stock = baselineStockRow(t, server, userID, itemID)
	if stock.StorageLocation == nil || *stock.StorageLocation != "Shed B" || stock.Needed != 12 {
		t.Fatalf("patched row = %+v, want Shed B / needed 12", stock)
	}

	// --- adjust ---
	response, _ = call(t, server.equipAdjustStock,
		baselineRequest(userID, http.MethodPost, "/equipment/stock/"+itemID+"/adjust",
			map[string]any{"quantity": 4, "reason": "purchased"}, "id", itemID))
	ok(t, "adjust", response)
	if stock = baselineStockRow(t, server, userID, itemID); stock.TotalOwned != 14 {
		t.Fatalf("owned after +4 = %d, want 14", stock.TotalOwned)
	}

	// --- deploy and return ---
	hiveID := baselineHive(ctx, t, server)
	response, body = call(t, server.equipDeploy,
		baselineRequest(userID, http.MethodPost, "/equipment/deployments",
			map[string]any{"stockId": itemID, "hiveId": hiveID.String(), "quantity": 3}))
	ok(t, "deploy", response)
	deploymentID := body["id"].(string)
	if stock = baselineStockRow(t, server, userID, itemID); stock.Deployed != 3 || stock.Available != 11 {
		t.Fatalf("after deploy = deployed %d available %d, want 3/11", stock.Deployed, stock.Available)
	}

	response, body = call(t, server.equipReturnDeployment,
		baselineRequest(userID, http.MethodPost, "/equipment/deployments/"+deploymentID+"/return",
			map[string]any{"quantity": 1}, "id", deploymentID))
	ok(t, "return", response)
	if outstanding, _ := body["outstanding"].(float64); outstanding != 2 {
		t.Fatalf("outstanding after returning 1 of 3 = %v, want 2", body["outstanding"])
	}
	if stock = baselineStockRow(t, server, userID, itemID); stock.Deployed != 2 {
		t.Fatalf("deployed after partial return = %d, want 2", stock.Deployed)
	}

	// --- damage, then the loss report that used to read equipment_loss_events ---
	response, _ = call(t, server.equipMarkDamaged,
		baselineRequest(userID, http.MethodPost, "/equipment/stock/"+itemID+"/damage",
			map[string]any{"quantity": 2, "reason": "broken"}, "id", itemID))
	ok(t, "damage", response)
	if stock = baselineStockRow(t, server, userID, itemID); stock.Damaged != 2 {
		t.Fatalf("damaged = %d, want 2", stock.Damaged)
	}

	response, body = call(t, server.equipLossReport,
		baselineRequest(userID, http.MethodGet, "/equipment/loss-report", nil))
	ok(t, "loss report", response)
	totals := body["totals"].(map[string]any)
	if totals["damaged"].(float64) != 2 {
		t.Errorf("loss report damaged = %v, want 2", totals["damaged"])
	}
	if totals["valueCents"].(float64) != 3000 {
		t.Errorf("loss report value = %v, want 3000 (2 x 1500)", totals["valueCents"])
	}
	if len(body["events"].([]any)) == 0 {
		t.Error("loss report listed no events")
	}

	// --- reconciliation: the projection against the raw movements ---
	response, body = call(t, server.equipReconciliation,
		baselineRequest(userID, http.MethodGet, "/equipment/reconciliation", nil))
	ok(t, "reconciliation", response)
	if body["reconciled"] != true {
		t.Errorf("reconciliation = %v, want reconciled", body["reconciled"])
	}
	if body["checkedCount"].(float64) < 1 {
		t.Error("reconciliation checked no rows")
	}

	// --- history listings, addressed by the item id ---
	response, _ = call(t, server.equipListAdjustments,
		baselineRequest(userID, http.MethodGet, "/equipment/stock/"+itemID+"/adjustments", nil,
			"id", itemID))
	ok(t, "list adjustments", response)
	if entries := baselineDecodeArray(t, response); len(entries) != 2 {
		t.Errorf("adjustments = %d, want the opening count and the +4", len(entries))
	}
	response, _ = call(t, server.equipListStateChanges,
		baselineRequest(userID, http.MethodGet, "/equipment/stock/"+itemID+"/state-changes", nil,
			"id", itemID))
	ok(t, "list state changes", response)
	if entries := baselineDecodeArray(t, response); len(entries) != 1 {
		t.Errorf("state changes = %d, want the one damage", len(entries))
	}
}

// TestBaselineProfileDropsTheLegacyEquipmentArm pins the composed SQL itself,
// which is cheap and catches a regression without a database.
func TestBaselineProfileDropsTheLegacyEquipmentArm(t *testing.T) {
	t.Setenv(db.BaselineEnvVar, "1")
	for name, sql := range map[string]string{
		"equipItemSelect":            equipItemSelect("$1"),
		"equipTypeSelect":            equipTypeSelect("$1"),
		"gnucashLegacyEquipmentJoin": gnucashLegacyEquipmentJoin(),
	} {
		if strings.Contains(sql, "FROM equipment_stock") {
			t.Errorf("%s still reads equipment_stock on the baseline:\n%s", name, sql)
		}
	}

	t.Setenv(db.BaselineEnvVar, "")
	if !strings.Contains(equipItemSelect("$1"), "FROM equipment_stock") {
		t.Error("equipItemSelect dropped the Phase A stock-id arm on the legacy chain")
	}
	if !strings.Contains(gnucashLegacyEquipmentJoin(), "equipment_stock") {
		t.Error("the GnuCash composer dropped its historical fallback on the legacy chain")
	}
}

// --- helpers ---

func baselineStockRow(
	t *testing.T, server *Server, userID uuid.UUID, itemID string,
) equipStockRow {
	t.Helper()
	response := httptest.NewRecorder()
	server.equipListStock(response, baselineRequest(userID, http.MethodGet, "/equipment/stock", nil))
	if response.Code >= 300 {
		t.Fatalf("list stock = %d %s", response.Code, response.Body.String())
	}
	var rows []equipStockRow
	if err := json.Unmarshal(response.Body.Bytes(), &rows); err != nil {
		t.Fatalf("decode stock listing %q: %v", response.Body.String(), err)
	}
	for _, row := range rows {
		if row.ID.String() == itemID {
			return row
		}
	}
	t.Fatalf("item %s is not in the stock listing (%d rows)", itemID, len(rows))
	return equipStockRow{}
}

func baselineHive(ctx context.Context, t *testing.T, server *Server) uuid.UUID {
	t.Helper()
	var apiaryID, hiveID uuid.UUID
	if err := server.pool.QueryRow(ctx,
		`INSERT INTO apiaries (name) VALUES ($1) RETURNING id`,
		"Baseline yard "+uuid.NewString()).Scan(&apiaryID); err != nil {
		t.Fatalf("insert apiary: %v", err)
	}
	if err := server.pool.QueryRow(ctx,
		`INSERT INTO hives (apiary_id, position_label) VALUES ($1, 'B1') RETURNING id`,
		apiaryID).Scan(&hiveID); err != nil {
		t.Fatalf("insert hive: %v", err)
	}
	return hiveID
}

func baselineDecodeArray(t *testing.T, response *httptest.ResponseRecorder) []any {
	t.Helper()
	var entries []any
	if err := json.Unmarshal(response.Body.Bytes(), &entries); err != nil {
		t.Fatalf("decode listing %q: %v", response.Body.String(), err)
	}
	return entries
}
