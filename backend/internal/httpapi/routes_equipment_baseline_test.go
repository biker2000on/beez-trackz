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
// baseline profile and walks the surface: create, stock status, adjust,
// deploy, return, damage, loss report, reconciliation, the two history
// listings, delete type, and — since spec 12.1 open item 8 closed — the whole
// bill-of-materials surface: list, set, the cycle refusal, assemble, and
// disassemble, all against inventory_boms / inventory_bom_lines.
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

	// --- bill of materials and assembly (spec 12.1 open item 8) ---
	//
	// equipment_type_components is dropped here, so every one of these used to
	// fail outright. The editor writes inventory_boms / inventory_bom_lines,
	// the listing reads them back in catalog terms, and assembly consumes the
	// components the recipe names.
	response, body = call(t, server.equipCreateType,
		baselineRequest(userID, http.MethodPost, "/equipment/types",
			map[string]any{"name": "Baseline super", "category": "box"}))
	ok(t, "create super type", response)
	superTypeID := body["id"].(string)
	response, body = call(t, server.equipCreateStock,
		baselineRequest(userID, http.MethodPost, "/equipment/stock",
			map[string]any{"typeId": superTypeID, "initialQuantity": 0}))
	ok(t, "create super stock", response)
	superItemID := body["id"].(string)

	response, body = call(t, server.equipCreateType,
		baselineRequest(userID, http.MethodPost, "/equipment/types",
			map[string]any{"name": "Baseline body", "category": "box"}))
	ok(t, "create body type", response)
	bodyTypeID := body["id"].(string)
	response, body = call(t, server.equipCreateStock,
		baselineRequest(userID, http.MethodPost, "/equipment/stock",
			map[string]any{"typeId": bodyTypeID, "initialQuantity": 5, "unitCostCents": 2000}))
	ok(t, "create body stock", response)
	bodyItemID := body["id"].(string)

	response, body = call(t, server.equipCreateType,
		baselineRequest(userID, http.MethodPost, "/equipment/types",
			map[string]any{"name": "Baseline foundation", "category": "accessory"}))
	ok(t, "create foundation type", response)
	foundationTypeID := body["id"].(string)
	response, body = call(t, server.equipCreateStock,
		baselineRequest(userID, http.MethodPost, "/equipment/stock",
			map[string]any{"typeId": foundationTypeID, "initialQuantity": 50, "unitCostCents": 300}))
	ok(t, "create foundation stock", response)
	foundationItemID := body["id"].(string)

	response, body = call(t, server.equipSetComponents,
		baselineRequest(userID, http.MethodPut, "/equipment/types/"+superTypeID+"/components",
			map[string]any{"components": []map[string]any{
				{"componentTypeId": bodyTypeID, "quantity": 1},
				{"componentTypeId": foundationTypeID, "quantity": 9},
			}}, "id", superTypeID))
	ok(t, "set components", response)
	if count, _ := body["count"].(float64); count != 2 {
		t.Fatalf("set components count = %v, want 2", body["count"])
	}

	response, _ = call(t, server.equipListComponents,
		baselineRequest(userID, http.MethodGet, "/equipment/components", nil))
	ok(t, "list components", response)
	var listed []equipComponentRow
	if err := json.Unmarshal(response.Body.Bytes(), &listed); err != nil {
		t.Fatalf("decode component listing %q: %v", response.Body.String(), err)
	}
	recipe := map[string]int{}
	for _, line := range listed {
		if line.ParentTypeID.String() == superTypeID {
			if line.ParentTypeName != "Baseline super" {
				t.Errorf("listed parent name = %q", line.ParentTypeName)
			}
			recipe[line.ComponentTypeID.String()] = line.Quantity
		}
	}
	if recipe[bodyTypeID] != 1 || recipe[foundationTypeID] != 9 || len(recipe) != 2 {
		t.Fatalf("listed recipe = %v, want 1 body and 9 foundations", recipe)
	}

	// The cycle refusal, with equipment_type_components and its 00046 trigger
	// both gone: the Go walk over the ledger graph and the trigger on
	// inventory_bom_lines are what refuse it here.
	response, _ = call(t, server.equipSetComponents,
		baselineRequest(userID, http.MethodPut, "/equipment/types/"+bodyTypeID+"/components",
			map[string]any{"components": []map[string]any{
				{"componentTypeId": superTypeID, "quantity": 1},
			}}, "id", bodyTypeID))
	if response.Code != http.StatusConflict {
		t.Fatalf("a cycle in the bill of materials = %d %s, want 409",
			response.Code, response.Body.String())
	}
	var cycleLines int
	if err := server.pool.QueryRow(ctx, `
		SELECT COUNT(*) FROM inventory_bom_lines l
		JOIN inventory_boms b ON b.id = l.bom_id
		WHERE b.output_item_id = $1`, bodyItemID).Scan(&cycleLines); err != nil {
		t.Fatalf("probe the refused cycle: %v", err)
	}
	if cycleLines != 0 {
		t.Fatalf("the refused cycle left %d BOM lines behind", cycleLines)
	}

	// Assemble two supers: 2 bodies and 18 foundations consumed, 2 supers made.
	response, body = call(t, server.equipAssemble,
		baselineRequest(userID, http.MethodPost, "/equipment/assemblies",
			map[string]any{"typeId": superTypeID, "quantity": 2, "action": "assemble"}))
	ok(t, "assemble", response)
	if components, _ := body["components"].([]any); len(components) != 2 {
		t.Fatalf("assembly reported %v components, want 2", body["components"])
	}
	if stock = baselineStockRow(t, server, userID, superItemID); stock.TotalOwned != 2 {
		t.Fatalf("supers after assembling 2 = %d, want 2", stock.TotalOwned)
	}
	if stock = baselineStockRow(t, server, userID, bodyItemID); stock.TotalOwned != 3 {
		t.Fatalf("bodies after assembling 2 = %d, want 3", stock.TotalOwned)
	}
	if stock = baselineStockRow(t, server, userID, foundationItemID); stock.TotalOwned != 32 {
		t.Fatalf("foundations after assembling 2 = %d, want 32", stock.TotalOwned)
	}

	// Disassembling one is the exact inverse.
	response, _ = call(t, server.equipAssemble,
		baselineRequest(userID, http.MethodPost, "/equipment/assemblies",
			map[string]any{"typeId": superTypeID, "quantity": 1, "action": "disassemble"}))
	ok(t, "disassemble", response)
	if stock = baselineStockRow(t, server, userID, superItemID); stock.TotalOwned != 1 {
		t.Fatalf("supers after disassembling 1 = %d, want 1", stock.TotalOwned)
	}
	if stock = baselineStockRow(t, server, userID, bodyItemID); stock.TotalOwned != 4 {
		t.Fatalf("bodies after disassembling 1 = %d, want 4", stock.TotalOwned)
	}
	if stock = baselineStockRow(t, server, userID, foundationItemID); stock.TotalOwned != 41 {
		t.Fatalf("foundations after disassembling 1 = %d, want 41", stock.TotalOwned)
	}

	// More than there are: the ledger's own availability refusal, unchanged.
	response, _ = call(t, server.equipAssemble,
		baselineRequest(userID, http.MethodPost, "/equipment/assemblies",
			map[string]any{"typeId": superTypeID, "quantity": 99, "action": "assemble"}))
	if response.Code != http.StatusConflict {
		t.Fatalf("assembling more than the components allow = %d %s, want 409",
			response.Code, response.Body.String())
	}

	// --- delete type ---
	//
	// It used to select equipment_stock, probe the three history tables, and
	// delete the stock row, so on a baseline database it failed outright
	// (wave-3c finding F2). On the ledger the refusal is "this item has
	// inventory_movements", and a clean type takes its inventory item and its
	// bill of materials with it.
	response, _ = call(t, server.equipDeleteType,
		baselineRequest(userID, http.MethodDelete, "/equipment/types/"+typeID, nil, "id", typeID))
	if response.Code != http.StatusConflict {
		t.Fatalf("delete a type with ledger history = %d %s, want 409",
			response.Code, response.Body.String())
	}
	if stock = baselineStockRow(t, server, userID, itemID); stock.TotalOwned != 14 {
		t.Fatalf("refused delete changed the balance: owned = %d, want 14", stock.TotalOwned)
	}

	// A parent with a bill of materials, and a component that may not leave it.
	// The recipe goes in through the editor, which writes the same
	// inventory_boms / inventory_bom_lines shape app/backfill mirrors into.
	response, body = call(t, server.equipCreateType,
		baselineRequest(userID, http.MethodPost, "/equipment/types",
			map[string]any{"name": "Baseline spare", "category": "box"}))
	ok(t, "create spare type", response)
	spareTypeID := body["id"].(string)
	response, body = call(t, server.equipCreateStock,
		baselineRequest(userID, http.MethodPost, "/equipment/stock",
			map[string]any{"typeId": spareTypeID, "initialQuantity": 0}))
	ok(t, "create spare stock", response)
	spareItemID := body["id"].(string)

	response, body = call(t, server.equipCreateType,
		baselineRequest(userID, http.MethodPost, "/equipment/types",
			map[string]any{"name": "Baseline spare part", "category": "accessory"}))
	ok(t, "create component type", response)
	componentTypeID := body["id"].(string)
	response, body = call(t, server.equipCreateStock,
		baselineRequest(userID, http.MethodPost, "/equipment/stock",
			map[string]any{"typeId": componentTypeID, "initialQuantity": 0}))
	ok(t, "create component stock", response)

	response, _ = call(t, server.equipSetComponents,
		baselineRequest(userID, http.MethodPut, "/equipment/types/"+spareTypeID+"/components",
			map[string]any{"components": []map[string]any{
				{"componentTypeId": componentTypeID, "quantity": 2},
			}}, "id", spareTypeID))
	ok(t, "set the spare type's components", response)
	var bomID uuid.UUID
	if err := server.pool.QueryRow(ctx,
		`SELECT id FROM inventory_boms WHERE output_item_id = $1`, spareItemID).Scan(&bomID); err != nil {
		t.Fatalf("read the ledger BOM the editor wrote: %v", err)
	}

	response, _ = call(t, server.equipDeleteType,
		baselineRequest(userID, http.MethodDelete, "/equipment/types/"+componentTypeID, nil,
			"id", componentTypeID))
	if response.Code != http.StatusConflict {
		t.Fatalf("delete a component of another type = %d %s, want 409",
			response.Code, response.Body.String())
	}

	// The parent has an inventory item (opening count zero, so no movements)
	// and a recipe. Both go with it.
	response, _ = call(t, server.equipDeleteType,
		baselineRequest(userID, http.MethodDelete, "/equipment/types/"+spareTypeID, nil,
			"id", spareTypeID))
	ok(t, "delete spare type", response)

	var typeRows, itemRows, bomRows, bomLineRows int
	if err := server.pool.QueryRow(ctx, `
		SELECT (SELECT COUNT(*) FROM equipment_types WHERE id = $1),
		       (SELECT COUNT(*) FROM inventory_items WHERE id = $2),
		       (SELECT COUNT(*) FROM inventory_boms WHERE id = $3),
		       (SELECT COUNT(*) FROM inventory_bom_lines WHERE bom_id = $3)`,
		spareTypeID, spareItemID, bomID).Scan(&typeRows, &itemRows, &bomRows, &bomLineRows); err != nil {
		t.Fatalf("probe the deleted type: %v", err)
	}
	if typeRows != 0 || itemRows != 0 || bomRows != 0 || bomLineRows != 0 {
		t.Fatalf("after delete: types %d items %d boms %d bom lines %d, want 0/0/0/0",
			typeRows, itemRows, bomRows, bomLineRows)
	}

	// The component is free once its only parent is gone, and a second delete
	// of a type that is already gone is a 404, not a 500.
	response, _ = call(t, server.equipDeleteType,
		baselineRequest(userID, http.MethodDelete, "/equipment/types/"+componentTypeID, nil,
			"id", componentTypeID))
	ok(t, "delete freed component type", response)
	response, _ = call(t, server.equipDeleteType,
		baselineRequest(userID, http.MethodDelete, "/equipment/types/"+spareTypeID, nil,
			"id", spareTypeID))
	if response.Code != http.StatusNotFound {
		t.Fatalf("delete a missing type = %d %s, want 404",
			response.Code, response.Body.String())
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
	// equipment_type_components is dropped at Phase B too, so the delete-type
	// component check has to be composed the same way.
	if strings.Contains(equipComponentParentSQL(), "equipment_type_components") {
		t.Errorf("equipComponentParentSQL still reads equipment_type_components on the baseline:\n%s",
			equipComponentParentSQL())
	}

	t.Setenv(db.BaselineEnvVar, "")
	if !strings.Contains(equipItemSelect("$1"), "FROM equipment_stock") {
		t.Error("equipItemSelect dropped the Phase A stock-id arm on the legacy chain")
	}
	if !strings.Contains(gnucashLegacyEquipmentJoin(), "equipment_stock") {
		t.Error("the GnuCash composer dropped its historical fallback on the legacy chain")
	}
	if !strings.Contains(equipComponentParentSQL(), "equipment_type_components") {
		t.Error("equipComponentParentSQL left the operator-edited BOM table on the legacy chain")
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
