package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"golang.org/x/crypto/bcrypt"

	"github.com/biker2000on/beez-trackz/backend/internal/config"
	"github.com/biker2000on/beez-trackz/backend/internal/db"
)

// DB-backed tests for the honey/commerce ledger. They call handlers directly
// with an admin principal in the request context, which exercises the real SQL
// without standing up sessions.

var (
	testPoolOnce sync.Once
	testPool     *pgxpool.Pool
	testPoolErr  error
	testUserID   uuid.UUID
)

func honeyTestServer(t *testing.T) *Server {
	t.Helper()
	databaseURL := os.Getenv("TEST_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("TEST_DATABASE_URL is not configured")
	}
	testPoolOnce.Do(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
		defer cancel()
		testPool, testPoolErr = db.Connect(ctx, databaseURL)
		if testPoolErr != nil {
			return
		}
		testPoolErr = testPool.QueryRow(ctx, `
			INSERT INTO app_users (auth_subject, display_name, is_admin)
			VALUES ('httpapi-test', 'Test Admin', true)
			ON CONFLICT (auth_subject) DO UPDATE SET display_name=EXCLUDED.display_name
			RETURNING id`).Scan(&testUserID)
	})
	if testPoolErr != nil {
		t.Fatalf("connect test database: %v", testPoolErr)
	}

	server := &Server{
		cfg:  &config.Config{SessionSecret: "test", AppURL: "http://localhost:3000"},
		pool: testPool,
	}
	resetHoneyTables(t, testPool)
	return server
}

// resetHoneyTables clears the ledger between tests. app_users is preserved
// because created_by points at it.
func resetHoneyTables(t *testing.T, pool *pgxpool.Pool) {
	t.Helper()
	_, err := pool.Exec(context.Background(), `
		TRUNCATE harvest_session_true_ups, jar_serials, honey_sale_items, honey_sales,
			honey_movements, bottling_runs, harvest_lot_photos, harvest_lot_harvests,
			harvest_lots, wholesale_price_list_items, wholesale_price_lists,
			honey_harvests, harvest_sessions, jar_sizes, expenses, customers,
			external_sync, offline_mutation_receipts
		RESTART IDENTITY CASCADE`)
	if err != nil {
		t.Fatalf("reset honey tables: %v", err)
	}
}

func adminRequest(method, target string, body any, params ...string) *http.Request {
	var reader *bytes.Reader
	if body != nil {
		encoded, _ := json.Marshal(body)
		reader = bytes.NewReader(encoded)
	} else {
		reader = bytes.NewReader(nil)
	}
	request := httptest.NewRequest(method, target, reader)
	ctx := context.WithValue(request.Context(), principalKey, &principal{
		ID: testUserID, DisplayName: "Test Admin", IsAdmin: true,
	})
	if len(params) > 0 {
		routeCtx := chi.NewRouteContext()
		for i := 0; i+1 < len(params); i += 2 {
			routeCtx.URLParams.Add(params[i], params[i+1])
		}
		ctx = context.WithValue(ctx, chi.RouteCtxKey, routeCtx)
	}
	return request.WithContext(ctx)
}

func call(
	t *testing.T,
	handler http.HandlerFunc,
	request *http.Request,
) (*httptest.ResponseRecorder, map[string]any) {
	t.Helper()
	response := httptest.NewRecorder()
	handler(response, request)
	decoded := map[string]any{}
	if body := response.Body.Bytes(); len(body) > 0 && body[0] == '{' {
		if err := json.Unmarshal(body, &decoded); err != nil {
			t.Fatalf("decode response %q: %v", response.Body.String(), err)
		}
	}
	return response, decoded
}

// seedJarSize inserts a jar size directly so tests control its price and honey
// content precisely.
func seedJarSize(t *testing.T, server *Server, label string, oz float64, priceCents int64) uuid.UUID {
	t.Helper()
	var id uuid.UUID
	if err := server.pool.QueryRow(context.Background(), `
		INSERT INTO jar_sizes (label, honey_oz, default_price_cents)
		VALUES ($1,$2,$3) RETURNING id`, label, oz, priceCents).Scan(&id); err != nil {
		t.Fatalf("seed jar size: %v", err)
	}
	return id
}

// seedHarvest records bulk honey so jarring has something to draw from.
func seedHarvest(t *testing.T, server *Server, pounds float64) {
	t.Helper()
	ctx := context.Background()
	var apiaryID, hiveID uuid.UUID
	if err := server.pool.QueryRow(ctx,
		`INSERT INTO apiaries (name) VALUES ('Test yard') RETURNING id`).Scan(&apiaryID); err != nil {
		t.Fatalf("seed apiary: %v", err)
	}
	if err := server.pool.QueryRow(ctx,
		`INSERT INTO hives (apiary_id, position_label) VALUES ($1,'H1') RETURNING id`,
		apiaryID).Scan(&hiveID); err != nil {
		t.Fatalf("seed hive: %v", err)
	}
	if _, err := server.pool.Exec(ctx, `
		INSERT INTO honey_harvests
			(hive_id, date, super_weight_before, super_weight_after, calculated_honey_weight)
		VALUES ($1, now(), $2, 0, $2)`, hiveID, pounds); err != nil {
		t.Fatalf("seed harvest: %v", err)
	}
}

func jarStock(t *testing.T, server *Server, jarSizeID uuid.UUID, quantity int) {
	t.Helper()
	response, body := call(t, server.honeyRecordJarring, adminRequest(
		http.MethodPost, "/api/v1/honey/jarring", map[string]any{
			"date":  time.Now().Format("2006-01-02"),
			"lines": []map[string]any{{"jarSizeId": jarSizeID.String(), "quantity": quantity}},
		}))
	if response.Code != http.StatusOK {
		t.Fatalf("jarring failed: %d %v", response.Code, body)
	}
}

// --- money round-tripping ---

func TestSaleRoundTripsMoneyAsCents(t *testing.T) {
	server := honeyTestServer(t)
	jarSizeID := seedJarSize(t, server, "Pint", 16, 1200)
	seedHarvest(t, server, 100)
	jarStock(t, server, jarSizeID, 10)

	// 12.345 must round half away from zero to 1235 cents, which a float
	// multiplication would get wrong.
	response, body := call(t, server.honeyRecordSale, adminRequest(
		http.MethodPost, "/api/v1/honey/sales", map[string]any{
			"date":           time.Now().Format("2006-01-02"),
			"discountAmount": 0.10,
			"lines": []map[string]any{
				{"jarSizeId": jarSizeID.String(), "quantity": 3, "unitPrice": 12.345},
			},
		}))
	if response.Code != http.StatusCreated {
		t.Fatalf("record sale = %d %v", response.Code, body)
	}

	var totalCents, discountCents, unitCents int64
	if err := server.pool.QueryRow(context.Background(), `
		SELECT s.total_amount_cents, s.discount_amount_cents, i.unit_price_cents
		FROM honey_sales s JOIN honey_sale_items i ON i.sale_id=s.id`).
		Scan(&totalCents, &discountCents, &unitCents); err != nil {
		t.Fatalf("read stored cents: %v", err)
	}
	if unitCents != 1235 {
		t.Errorf("unit price = %d cents, want 1235", unitCents)
	}
	if discountCents != 10 {
		t.Errorf("discount = %d cents, want 10", discountCents)
	}
	if totalCents != 1235*3-10 {
		t.Errorf("total = %d cents, want %d", totalCents, 1235*3-10)
	}

	// The wire format is still dollars, to two decimals.
	listResponse := httptest.NewRecorder()
	server.honeyListSalesHandler(listResponse, adminRequest(http.MethodGet, "/api/v1/honey/sales", nil))
	if !strings.Contains(listResponse.Body.String(), `"totalAmount":36.95`) {
		t.Errorf("sale JSON did not carry dollars: %s", listResponse.Body.String())
	}
	if !strings.Contains(listResponse.Body.String(), `"unitPrice":12.35`) {
		t.Errorf("line item JSON did not carry dollars: %s", listResponse.Body.String())
	}
}

func TestParseDollarsToCentsRoundsHalfAwayFromZero(t *testing.T) {
	t.Parallel()
	cases := []struct {
		raw  string
		want int64
	}{
		{"0", 0},
		{"12.34", 1234},
		{"1.005", 101},
		{"12.345", 1235},
		{"12.344", 1234},
		{"-1.005", -101},
		{"0.1", 10},
		{"1e2", 10000},
		{"249.99", 24999},
	}
	for _, test := range cases {
		got, err := parseDollarsToCents(test.raw)
		if err != nil {
			t.Fatalf("parseDollarsToCents(%q): %v", test.raw, err)
		}
		if got != test.want {
			t.Errorf("parseDollarsToCents(%q) = %d, want %d", test.raw, got, test.want)
		}
	}
	if _, err := parseDollarsToCents("twelve"); err == nil {
		t.Error("non-numeric amount was accepted")
	}
}

func TestMoneyMarshalsAsTwoDecimalDollars(t *testing.T) {
	t.Parallel()
	cases := map[money]string{
		0: "0.00", 5: "0.05", 100: "1.00", 1234: "12.34", -1234: "-12.34",
		100000: "1000.00",
	}
	for value, want := range cases {
		encoded, err := json.Marshal(value)
		if err != nil {
			t.Fatalf("marshal %d: %v", int64(value), err)
		}
		if string(encoded) != want {
			t.Errorf("money(%d) marshaled as %s, want %s", int64(value), encoded, want)
		}
	}
}

// --- reversing entries instead of hard deletes ---

func TestDeleteMovementWritesReversingEntry(t *testing.T) {
	server := honeyTestServer(t)
	jarSizeID := seedJarSize(t, server, "Pint", 16, 1200)
	seedHarvest(t, server, 100)
	jarStock(t, server, jarSizeID, 12)

	var movementID uuid.UUID
	if err := server.pool.QueryRow(context.Background(),
		`SELECT id FROM honey_movements WHERE kind='jarring'`).Scan(&movementID); err != nil {
		t.Fatalf("read movement: %v", err)
	}

	response, body := call(t, server.honeyReverseMovement, adminRequest(
		http.MethodDelete, "/api/v1/honey/movements/"+movementID.String(),
		map[string]any{"reason": "miscount"}, "id", movementID.String()))
	if response.Code != http.StatusOK {
		t.Fatalf("reverse movement = %d %v", response.Code, body)
	}
	if body["success"] != true || body["reversalMovementId"] == nil {
		t.Fatalf("unexpected reversal response: %v", body)
	}

	// The original row survives, and the reversal negates it.
	var originalCount, reversalQuantity int
	var reversalActor *uuid.UUID
	if err := server.pool.QueryRow(context.Background(), `
		SELECT (SELECT COUNT(*) FROM honey_movements WHERE id=$1),
			(SELECT quantity FROM honey_movements WHERE reverses_movement_id=$1),
			(SELECT created_by FROM honey_movements WHERE reverses_movement_id=$1)`,
		movementID).Scan(&originalCount, &reversalQuantity, &reversalActor); err != nil {
		t.Fatalf("inspect reversal: %v", err)
	}
	if originalCount != 1 {
		t.Error("the original movement was destroyed")
	}
	if reversalQuantity != -12 {
		t.Errorf("reversal quantity = %d, want -12", reversalQuantity)
	}
	if reversalActor == nil || *reversalActor != testUserID {
		t.Errorf("reversal actor = %v, want %v", reversalActor, testUserID)
	}

	inventory, err := server.honeyJarInventory(context.Background())
	if err != nil {
		t.Fatalf("inventory: %v", err)
	}
	for _, row := range inventory {
		if row.JarSizeID == jarSizeID && row.OnHand != 0 {
			t.Errorf("on hand after reversal = %d, want 0", row.OnHand)
		}
	}

	// A movement can only be reversed once.
	second, _ := call(t, server.honeyReverseMovement, adminRequest(
		http.MethodDelete, "/api/v1/honey/movements/"+movementID.String(), nil,
		"id", movementID.String()))
	if second.Code != http.StatusConflict {
		t.Errorf("second reversal = %d, want %d", second.Code, http.StatusConflict)
	}
}

func TestDeleteSaleCancelsAndRestoresStock(t *testing.T) {
	server := honeyTestServer(t)
	jarSizeID := seedJarSize(t, server, "Pint", 16, 1200)
	seedHarvest(t, server, 100)
	jarStock(t, server, jarSizeID, 10)

	_, saleBody := call(t, server.honeyRecordSale, adminRequest(
		http.MethodPost, "/api/v1/honey/sales", map[string]any{
			"date": time.Now().Format("2006-01-02"),
			"lines": []map[string]any{
				{"jarSizeId": jarSizeID.String(), "quantity": 4, "unitPrice": 12},
			},
		}))
	saleID, _ := saleBody["id"].(string)
	if saleID == "" {
		t.Fatalf("no sale id in %v", saleBody)
	}

	inventory, _ := server.honeyJarInventory(context.Background())
	if inventory[0].OnHand != 6 {
		t.Fatalf("on hand after sale = %d, want 6", inventory[0].OnHand)
	}

	response, body := call(t, server.honeyCancelSale, adminRequest(
		http.MethodDelete, "/api/v1/honey/sales/"+saleID,
		map[string]any{"reason": "customer changed their mind"}, "id", saleID))
	if response.Code != http.StatusOK || body["success"] != true {
		t.Fatalf("cancel sale = %d %v", response.Code, body)
	}

	var status string
	var cancelledBy *uuid.UUID
	var reason *string
	if err := server.pool.QueryRow(context.Background(),
		`SELECT order_status, cancelled_by, cancellation_reason FROM honey_sales WHERE id=$1`,
		saleID).Scan(&status, &cancelledBy, &reason); err != nil {
		t.Fatalf("the sale row was destroyed instead of cancelled: %v", err)
	}
	if status != "cancelled" {
		t.Errorf("order status = %q, want cancelled", status)
	}
	if cancelledBy == nil || *cancelledBy != testUserID {
		t.Errorf("cancelled_by = %v, want %v", cancelledBy, testUserID)
	}
	if reason == nil || *reason != "customer changed their mind" {
		t.Errorf("cancellation reason = %v", reason)
	}

	inventory, _ = server.honeyJarInventory(context.Background())
	if inventory[0].OnHand != 10 {
		t.Errorf("on hand after cancellation = %d, want the jars back (10)", inventory[0].OnHand)
	}
}

func TestPatchSaleReachesCancelled(t *testing.T) {
	server := honeyTestServer(t)
	jarSizeID := seedJarSize(t, server, "Pint", 16, 1200)
	seedHarvest(t, server, 100)
	jarStock(t, server, jarSizeID, 10)
	_, saleBody := call(t, server.honeyRecordSale, adminRequest(
		http.MethodPost, "/api/v1/honey/sales", map[string]any{
			"date":        time.Now().Format("2006-01-02"),
			"orderStatus": "pending",
			"lines": []map[string]any{
				{"jarSizeId": jarSizeID.String(), "quantity": 2, "unitPrice": 12},
			},
		}))
	saleID, _ := saleBody["id"].(string)

	response, body := call(t, server.honeyUpdateSale, adminRequest(
		http.MethodPatch, "/api/v1/honey/sales/"+saleID,
		map[string]any{"orderStatus": "cancelled"}, "id", saleID))
	if response.Code != http.StatusOK {
		t.Fatalf("PATCH to cancelled = %d %v", response.Code, body)
	}
	var status string
	if err := server.pool.QueryRow(context.Background(),
		`SELECT order_status FROM honey_sales WHERE id=$1`, saleID).Scan(&status); err != nil {
		t.Fatalf("read sale: %v", err)
	}
	if status != "cancelled" {
		t.Errorf("order status = %q, want cancelled", status)
	}
}

func TestDeleteHarvestEntrySoftDeletes(t *testing.T) {
	server := honeyTestServer(t)
	ctx := context.Background()
	var apiaryID, hiveID, sessionID, entryID uuid.UUID
	if err := server.pool.QueryRow(ctx,
		`INSERT INTO apiaries (name) VALUES ('Soft delete yard') RETURNING id`).Scan(&apiaryID); err != nil {
		t.Fatalf("seed apiary: %v", err)
	}
	if err := server.pool.QueryRow(ctx,
		`INSERT INTO hives (apiary_id, position_label) VALUES ($1,'H1') RETURNING id`,
		apiaryID).Scan(&hiveID); err != nil {
		t.Fatalf("seed hive: %v", err)
	}
	if err := server.pool.QueryRow(ctx,
		`INSERT INTO harvest_sessions (apiary_id, date) VALUES ($1, now()) RETURNING id`,
		apiaryID).Scan(&sessionID); err != nil {
		t.Fatalf("seed session: %v", err)
	}
	if err := server.pool.QueryRow(ctx, `
		INSERT INTO honey_harvests
			(session_id, hive_id, date, super_weight_before, super_weight_after, calculated_honey_weight)
		VALUES ($1,$2,now(),50,10,40) RETURNING id`, sessionID, hiveID).Scan(&entryID); err != nil {
		t.Fatalf("seed entry: %v", err)
	}

	response, body := call(t, server.hsDeleteEntry, adminRequest(
		http.MethodDelete, "/api/v1/harvest-entries/"+entryID.String(),
		map[string]any{"reason": "duplicate"}, "id", entryID.String()))
	if response.Code != http.StatusOK || body["success"] != true {
		t.Fatalf("delete entry = %d %v", response.Code, body)
	}

	var deletedBy *uuid.UUID
	var reason *string
	if err := server.pool.QueryRow(ctx,
		`SELECT deleted_by, deletion_reason FROM honey_harvests WHERE id=$1 AND deleted_at IS NOT NULL`,
		entryID).Scan(&deletedBy, &reason); err != nil {
		t.Fatalf("the entry row was destroyed instead of soft-deleted: %v", err)
	}
	if deletedBy == nil || *deletedBy != testUserID || reason == nil || *reason != "duplicate" {
		t.Errorf("actor/reason = %v / %v", deletedBy, reason)
	}

	// Excluded from the aggregate.
	bulk, err := honeyBulkOnHand(ctx, server.pool)
	if err != nil {
		t.Fatalf("bulk on hand: %v", err)
	}
	if bulk.TotalHarvestedLbs != 0 {
		t.Errorf("harvested = %v lbs, want a soft-deleted entry to be excluded", bulk.TotalHarvestedLbs)
	}
}

// --- one formula per number ---

func TestBulkOnHandAgreesAcrossOverviewAndProductionPlan(t *testing.T) {
	server := honeyTestServer(t)
	jarSizeID := seedJarSize(t, server, "Pint", 16, 1200)
	seedHarvest(t, server, 100)
	jarStock(t, server, jarSizeID, 20)

	// Editing honey_oz after jarring is exactly what used to make the two
	// endpoints disagree: one summed the stored pounds, the other recomputed
	// them from the current jar size.
	if _, err := server.pool.Exec(context.Background(),
		`UPDATE jar_sizes SET honey_oz = 32 WHERE id = $1`, jarSizeID); err != nil {
		t.Fatalf("edit jar size: %v", err)
	}

	_, overview := call(t, server.honeyOverviewHandler,
		adminRequest(http.MethodGet, "/api/v1/honey/overview", nil))
	_, plan := call(t, server.productionPlan,
		adminRequest(http.MethodGet, "/api/v1/honey/production-plan", nil))

	overviewBulk, ok := overview["bulkOnHandLbs"].(float64)
	if !ok {
		t.Fatalf("overview has no bulkOnHandLbs: %v", overview)
	}
	planBulk, ok := plan["bulkOnHandLbs"].(float64)
	if !ok {
		t.Fatalf("production plan has no bulkOnHandLbs: %v", plan)
	}
	if overviewBulk != planBulk {
		t.Errorf("bulkOnHandLbs disagree: overview %v, production plan %v", overviewBulk, planBulk)
	}
	// 100 lbs harvested minus 20 jars x 16 oz / 16 = 20 lbs jarred.
	if overviewBulk != 80 {
		t.Errorf("bulkOnHandLbs = %v, want 80 (the stored ledger value)", overviewBulk)
	}
}

func TestOverviewSeparatesCollectedAndInvoicedRevenue(t *testing.T) {
	server := honeyTestServer(t)
	jarSizeID := seedJarSize(t, server, "Pint", 16, 1200)
	seedHarvest(t, server, 100)
	jarStock(t, server, jarSizeID, 20)

	// One paid sale and one unpaid invoice.
	call(t, server.honeyRecordSale, adminRequest(
		http.MethodPost, "/api/v1/honey/sales", map[string]any{
			"date":  time.Now().Format("2006-01-02"),
			"lines": []map[string]any{{"jarSizeId": jarSizeID.String(), "quantity": 2, "unitPrice": 10}},
		}))
	call(t, server.honeyRecordSale, adminRequest(
		http.MethodPost, "/api/v1/honey/sales", map[string]any{
			"date":        time.Now().Format("2006-01-02"),
			"orderStatus": "pending",
			"lines":       []map[string]any{{"jarSizeId": jarSizeID.String(), "quantity": 3, "unitPrice": 10}},
		}))

	_, overview := call(t, server.honeyOverviewHandler,
		adminRequest(http.MethodGet, "/api/v1/honey/overview", nil))
	if overview["invoicedRevenue"] != 50.0 {
		t.Errorf("invoicedRevenue = %v, want 50", overview["invoicedRevenue"])
	}
	if overview["collectedRevenue"] != 20.0 {
		t.Errorf("collectedRevenue = %v, want 20", overview["collectedRevenue"])
	}
	if overview["unpaidRevenue"] != 30.0 {
		t.Errorf("unpaidRevenue = %v, want 30", overview["unpaidRevenue"])
	}
	if overview["totalRevenue"] != overview["invoicedRevenue"] {
		t.Errorf("totalRevenue must stay the invoiced definition for compatibility: %v", overview)
	}
}

func TestBottlingRunLinksMovementAndRequiresJarSize(t *testing.T) {
	server := honeyTestServer(t)
	jarSizeID := seedJarSize(t, server, "Pint", 16, 1200)
	seedHarvest(t, server, 100)

	ctx := context.Background()
	var lotID uuid.UUID
	if err := server.pool.QueryRow(ctx, `
		INSERT INTO harvest_lots (lot_code, public_slug, extraction_date, honey_weight_lbs)
		VALUES ('LOT-1','lot-1',CURRENT_DATE, 40) RETURNING id`).Scan(&lotID); err != nil {
		t.Fatalf("seed lot: %v", err)
	}

	// A run with no jar size would create jars that exist on the lot page and
	// nowhere in inventory.
	response, _ := call(t, server.bottlingRunCreate, adminRequest(
		http.MethodPost, "/api/v1/harvest-lots/"+lotID.String()+"/bottling-runs",
		map[string]any{"bottledDate": time.Now().Format("2006-01-02"), "quantity": 5},
		"id", lotID.String()))
	if response.Code != http.StatusBadRequest {
		t.Errorf("run without a jar size = %d, want %d", response.Code, http.StatusBadRequest)
	}

	response, body := call(t, server.bottlingRunCreate, adminRequest(
		http.MethodPost, "/api/v1/harvest-lots/"+lotID.String()+"/bottling-runs",
		map[string]any{
			"bottledDate": time.Now().Format("2006-01-02"),
			"jarSizeId":   jarSizeID.String(),
			"quantity":    10,
		}, "id", lotID.String()))
	if response.Code != http.StatusCreated {
		t.Fatalf("bottling run = %d %v", response.Code, body)
	}
	runID, _ := body["id"].(string)
	var linked int
	if err := server.pool.QueryRow(ctx,
		`SELECT COUNT(*) FROM honey_movements WHERE bottling_run_id=$1`, runID).Scan(&linked); err != nil {
		t.Fatalf("read movement link: %v", err)
	}
	if linked != 1 {
		t.Errorf("movements linked to the run = %d, want 1", linked)
	}

	// A run cannot bottle more than the lot yielded (40 lbs; 10 jars used 10).
	response, _ = call(t, server.bottlingRunCreate, adminRequest(
		http.MethodPost, "/api/v1/harvest-lots/"+lotID.String()+"/bottling-runs",
		map[string]any{
			"bottledDate": time.Now().Format("2006-01-02"),
			"jarSizeId":   jarSizeID.String(),
			"quantity":    100,
		}, "id", lotID.String()))
	if response.Code != http.StatusBadRequest {
		t.Errorf("over-bottling a lot = %d, want %d", response.Code, http.StatusBadRequest)
	}
}

func TestJarSizeDeactivationBlocksOrWritesOff(t *testing.T) {
	server := honeyTestServer(t)
	jarSizeID := seedJarSize(t, server, "Pint", 16, 1200)
	seedHarvest(t, server, 100)
	jarStock(t, server, jarSizeID, 7)

	response, body := call(t, server.jarUpdate, adminRequest(
		http.MethodPut, "/api/v1/jar-sizes/"+jarSizeID.String(),
		map[string]any{"isActive": false}, "id", jarSizeID.String()))
	if response.Code != http.StatusConflict {
		t.Fatalf("deactivating with stock on hand = %d %v, want %d",
			response.Code, body, http.StatusConflict)
	}

	response, body = call(t, server.jarUpdate, adminRequest(
		http.MethodPut, "/api/v1/jar-sizes/"+jarSizeID.String(),
		map[string]any{"isActive": false, "writeOffRemaining": true}, "id", jarSizeID.String()))
	if response.Code != http.StatusOK {
		t.Fatalf("explicit write-off = %d %v", response.Code, body)
	}
	if body["jarsWrittenOff"] != 7.0 {
		t.Errorf("jarsWrittenOff = %v, want 7", body["jarsWrittenOff"])
	}
	var writeOffs int
	if err := server.pool.QueryRow(context.Background(), `
		SELECT COUNT(*) FROM honey_movements
		WHERE kind='jar_adjustment' AND jar_size_id=$1 AND quantity=-7`,
		jarSizeID).Scan(&writeOffs); err != nil {
		t.Fatalf("read write-off movement: %v", err)
	}
	if writeOffs != 1 {
		t.Errorf("write-off movements = %d, want 1 visible ledger entry", writeOffs)
	}
}

// --- negative-stock validation ---

func TestNegativeStockIsRejected(t *testing.T) {
	server := honeyTestServer(t)
	jarSizeID := seedJarSize(t, server, "Pint", 16, 1200)
	seedHarvest(t, server, 3)

	t.Run("jarring beyond bulk on hand", func(t *testing.T) {
		response, body := call(t, server.honeyRecordJarring, adminRequest(
			http.MethodPost, "/api/v1/honey/jarring", map[string]any{
				"date":  time.Now().Format("2006-01-02"),
				"lines": []map[string]any{{"jarSizeId": jarSizeID.String(), "quantity": 500}},
			}))
		if response.Code != http.StatusBadRequest {
			t.Fatalf("jarring 500 jars against 3 lbs = %d %v", response.Code, body)
		}
	})

	t.Run("give-away beyond jars on hand", func(t *testing.T) {
		jarStock(t, server, jarSizeID, 2)
		response, body := call(t, server.honeyRecordGiveAway, adminRequest(
			http.MethodPost, "/api/v1/honey/give-away", map[string]any{
				"date":  time.Now().Format("2006-01-02"),
				"lines": []map[string]any{{"jarSizeId": jarSizeID.String(), "quantity": 9}},
			}))
		if response.Code != http.StatusBadRequest {
			t.Fatalf("giving away 9 of 2 jars = %d %v", response.Code, body)
		}
	})

	t.Run("bulk use beyond bulk on hand", func(t *testing.T) {
		response, body := call(t, server.honeyRecordBulkMovement, adminRequest(
			http.MethodPost, "/api/v1/honey/bulk-movements", map[string]any{
				"date":      time.Now().Format("2006-01-02"),
				"kind":      "bulk_use",
				"amountLbs": 900,
			}))
		if response.Code != http.StatusBadRequest {
			t.Fatalf("using 900 lbs of bulk = %d %v", response.Code, body)
		}
	})

	t.Run("jar adjustment stays unbounded", func(t *testing.T) {
		response, body := call(t, server.honeyAdjustJarCounts, adminRequest(
			http.MethodPost, "/api/v1/honey/jar-adjustments", map[string]any{
				"date":  time.Now().Format("2006-01-02"),
				"lines": []map[string]any{{"jarSizeId": jarSizeID.String(), "delta": -50}},
			}))
		if response.Code != http.StatusOK {
			t.Fatalf("jar_adjustment must stay unbounded: %d %v", response.Code, body)
		}
	})
}

// --- true-up audit ---

func TestTrueUpKeepsPriorValueAndRejectsNegatives(t *testing.T) {
	server := honeyTestServer(t)
	ctx := context.Background()
	var apiaryID, sessionID uuid.UUID
	if err := server.pool.QueryRow(ctx,
		`INSERT INTO apiaries (name) VALUES ('True-up yard') RETURNING id`).Scan(&apiaryID); err != nil {
		t.Fatalf("seed apiary: %v", err)
	}
	if err := server.pool.QueryRow(ctx,
		`INSERT INTO harvest_sessions (apiary_id, date) VALUES ($1, now()) RETURNING id`,
		apiaryID).Scan(&sessionID); err != nil {
		t.Fatalf("seed session: %v", err)
	}

	for _, weight := range []float64{42, 44.5} {
		response, body := call(t, server.hsTrueUp, adminRequest(
			http.MethodPost, "/api/v1/harvest-sessions/"+sessionID.String()+"/true-up",
			map[string]any{"totalExtractedWeight": weight, "reason": "scale recheck"},
			"id", sessionID.String()))
		if response.Code != http.StatusOK {
			t.Fatalf("true-up %v = %d %v", weight, response.Code, body)
		}
	}

	rows, err := server.pool.Query(ctx, `
		SELECT previous_weight_lbs, new_weight_lbs FROM harvest_session_true_ups
		WHERE session_id=$1 ORDER BY created_at`, sessionID)
	if err != nil {
		t.Fatalf("read true-up history: %v", err)
	}
	defer rows.Close()
	type record struct {
		previous *float64
		next     float64
	}
	history := []record{}
	for rows.Next() {
		var item record
		if err := rows.Scan(&item.previous, &item.next); err != nil {
			t.Fatalf("scan: %v", err)
		}
		history = append(history, item)
	}
	if len(history) != 2 {
		t.Fatalf("true-up history has %d rows, want 2", len(history))
	}
	if history[0].previous != nil {
		t.Errorf("first true-up recorded a previous value of %v, want nil", *history[0].previous)
	}
	if history[1].previous == nil || *history[1].previous != 42 {
		t.Errorf("second true-up did not preserve the prior value 42: %v", history[1].previous)
	}

	response, _ := call(t, server.hsTrueUp, adminRequest(
		http.MethodPost, "/api/v1/harvest-sessions/"+sessionID.String()+"/true-up",
		map[string]any{"totalExtractedWeight": -5}, "id", sessionID.String()))
	if response.Code != http.StatusBadRequest {
		t.Errorf("negative true-up = %d, want %d", response.Code, http.StatusBadRequest)
	}
}

// --- offline idempotency on a honey mutation ---

func TestOfflineIdempotencyCoversHoneyMutations(t *testing.T) {
	server := honeyTestServer(t)
	jarSizeID := seedJarSize(t, server, "Pint", 16, 1200)
	mutationID := uuid.New().String()

	handler := server.offlineMutations(http.HandlerFunc(server.honeyAdjustJarCounts))
	send := func() *httptest.ResponseRecorder {
		request := adminRequest(http.MethodPost, "/api/v1/honey/jar-adjustments", map[string]any{
			"date":  time.Now().Format("2006-01-02"),
			"lines": []map[string]any{{"jarSizeId": jarSizeID.String(), "delta": 5}},
		})
		request.Header.Set("X-Offline-Mutation-ID", mutationID)
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, request)
		return response
	}

	if first := send(); first.Code != http.StatusOK {
		t.Fatalf("first submission = %d %s", first.Code, first.Body.String())
	}
	second := send()
	if second.Code != http.StatusOK {
		t.Fatalf("replay = %d %s", second.Code, second.Body.String())
	}
	if second.Header().Get("X-Offline-Replayed") != "true" {
		t.Error("replayed honey mutation was not served from the receipt")
	}

	var adjustments int
	if err := server.pool.QueryRow(context.Background(),
		`SELECT COUNT(*) FROM honey_movements WHERE kind='jar_adjustment'`).Scan(&adjustments); err != nil {
		t.Fatalf("count adjustments: %v", err)
	}
	if adjustments != 1 {
		t.Errorf("replaying the mutation wrote %d ledger rows, want 1", adjustments)
	}
}

func TestExpenseDeleteSoftDeletesAndLeavesAggregates(t *testing.T) {
	server := honeyTestServer(t)
	response, body := call(t, server.expenseCreate, adminRequest(
		http.MethodPost, "/api/v1/expenses", map[string]any{
			"expenseDate": time.Now().Format("2006-01-02"),
			"category":    "feed",
			"description": "Sugar",
			"amount":      249.99,
		}))
	if response.Code != http.StatusCreated {
		t.Fatalf("create expense = %d %v", response.Code, body)
	}
	expenseID, _ := body["id"].(string)

	var cents int64
	if err := server.pool.QueryRow(context.Background(),
		`SELECT amount_cents FROM expenses WHERE id=$1`, expenseID).Scan(&cents); err != nil {
		t.Fatalf("read expense: %v", err)
	}
	if cents != 24999 {
		t.Errorf("expense stored %d cents, want 24999", cents)
	}

	response, body = call(t, server.expenseDelete, adminRequest(
		http.MethodDelete, "/api/v1/expenses/"+expenseID,
		map[string]any{"reason": "entered twice"}, "id", expenseID))
	if response.Code != http.StatusOK || body["softDeleted"] != true {
		t.Fatalf("delete expense = %d %v", response.Code, body)
	}
	var stillThere bool
	if err := server.pool.QueryRow(context.Background(),
		`SELECT deleted_at IS NOT NULL FROM expenses WHERE id=$1`, expenseID).Scan(&stillThere); err != nil {
		t.Fatalf("the expense row was destroyed instead of soft-deleted: %v", err)
	}
	if !stillThere {
		t.Error("expense was not marked deleted")
	}

	listResponse := httptest.NewRecorder()
	server.expenseList(listResponse, adminRequest(http.MethodGet, "/api/v1/expenses", nil))
	if strings.Contains(listResponse.Body.String(), expenseID) {
		t.Error("a soft-deleted expense still appears in the listing")
	}
}

// --- ASI review regressions (2026-08-04) ---

// ASI-1-001: reversing a jarring movement removes jars, so it must clear the
// same availability bar as any other withdrawal — sold jars cannot be
// reversed into negative stock.
func TestReverseJarringBlockedWhenJarsAreSold(t *testing.T) {
	server := honeyTestServer(t)
	jarSizeID := seedJarSize(t, server, "Pint", 16, 1200)
	seedHarvest(t, server, 100)
	jarStock(t, server, jarSizeID, 10)

	response, body := call(t, server.honeyRecordSale, adminRequest(
		http.MethodPost, "/api/v1/honey/sales", map[string]any{
			"date": time.Now().Format("2006-01-02"),
			"lines": []map[string]any{
				{"jarSizeId": jarSizeID.String(), "quantity": 10, "unitPrice": 12},
			},
		}))
	if response.Code != http.StatusCreated {
		t.Fatalf("record sale = %d %v", response.Code, body)
	}

	var movementID uuid.UUID
	if err := server.pool.QueryRow(context.Background(),
		`SELECT id FROM honey_movements WHERE kind='jarring'`).Scan(&movementID); err != nil {
		t.Fatalf("read movement: %v", err)
	}
	response, body = call(t, server.honeyReverseMovement, adminRequest(
		http.MethodDelete, "/api/v1/honey/movements/"+movementID.String(), nil,
		"id", movementID.String()))
	if response.Code != http.StatusBadRequest {
		t.Fatalf("reversing a sold-out jarring = %d %v, want 400", response.Code, body)
	}

	var reversals int
	if err := server.pool.QueryRow(context.Background(),
		`SELECT COUNT(*) FROM honey_movements WHERE reverses_movement_id=$1`,
		movementID).Scan(&reversals); err != nil {
		t.Fatalf("count reversals: %v", err)
	}
	if reversals != 0 {
		t.Errorf("a reversal row was written despite the shortfall")
	}
}

// ASI-1-002: a run-linked movement cannot be reversed on its own — the run,
// its serials, and the lot's bottled total would survive and disagree with
// the ledger.
func TestReverseBottlingRunMovementRefused(t *testing.T) {
	server := honeyTestServer(t)
	jarSizeID := seedJarSize(t, server, "Pint", 16, 1200)
	seedHarvest(t, server, 100)

	response, body := call(t, server.harvestLotCreate, adminRequest(
		http.MethodPost, "/api/v1/harvest-lots", map[string]any{
			"lotCode":        "2026-TEST-01",
			"extractionDate": time.Now().Format("2006-01-02"),
			"honeyWeightLbs": 50,
		}))
	if response.Code != http.StatusCreated {
		t.Fatalf("create lot = %d %v", response.Code, body)
	}
	lotID, _ := body["id"].(string)

	response, body = call(t, server.bottlingRunCreate, adminRequest(
		http.MethodPost, "/api/v1/harvest-lots/"+lotID+"/bottling-runs", map[string]any{
			"bottledDate": time.Now().Format("2006-01-02"),
			"jarSizeId":   jarSizeID.String(),
			"quantity":    10,
		}, "id", lotID))
	if response.Code != http.StatusCreated {
		t.Fatalf("create bottling run = %d %v", response.Code, body)
	}

	var movementID uuid.UUID
	if err := server.pool.QueryRow(context.Background(),
		`SELECT id FROM honey_movements WHERE bottling_run_id IS NOT NULL`).Scan(&movementID); err != nil {
		t.Fatalf("read run movement: %v", err)
	}
	response, body = call(t, server.honeyReverseMovement, adminRequest(
		http.MethodDelete, "/api/v1/honey/movements/"+movementID.String(), nil,
		"id", movementID.String()))
	if response.Code != http.StatusConflict {
		t.Fatalf("reversing a run-linked movement = %d %v, want 409", response.Code, body)
	}
}

// ASI-5-004: a true-up cannot take back pounds that were already jarred, and
// a true-up of exactly 0 is rejected because the bulk formula would silently
// treat it as unset.
func TestTrueUpCannotShrinkBulkBelowJarredPounds(t *testing.T) {
	server := honeyTestServer(t)
	jarSizeID := seedJarSize(t, server, "Pound", 16, 1200)
	ctx := context.Background()

	var apiaryID, hiveID, sessionID uuid.UUID
	if err := server.pool.QueryRow(ctx,
		`INSERT INTO apiaries (name) VALUES ('True-up yard') RETURNING id`).Scan(&apiaryID); err != nil {
		t.Fatalf("seed apiary: %v", err)
	}
	if err := server.pool.QueryRow(ctx,
		`INSERT INTO hives (apiary_id, position_label) VALUES ($1,'H1') RETURNING id`,
		apiaryID).Scan(&hiveID); err != nil {
		t.Fatalf("seed hive: %v", err)
	}
	if err := server.pool.QueryRow(ctx,
		`INSERT INTO harvest_sessions (apiary_id, date) VALUES ($1, now()) RETURNING id`,
		apiaryID).Scan(&sessionID); err != nil {
		t.Fatalf("seed session: %v", err)
	}
	if _, err := server.pool.Exec(ctx, `
		INSERT INTO honey_harvests
			(hive_id, session_id, date, super_weight_before, super_weight_after, calculated_honey_weight)
		VALUES ($1, $2, now(), 100, 0, 100)`, hiveID, sessionID); err != nil {
		t.Fatalf("seed entry: %v", err)
	}
	jarStock(t, server, jarSizeID, 90) // 90 lbs of the 100 are now jarred

	trueUp := func(weight float64) (*httptest.ResponseRecorder, map[string]any) {
		return call(t, server.hsTrueUp, adminRequest(
			http.MethodPost, "/api/v1/harvest-sessions/"+sessionID.String()+"/true-up",
			map[string]any{"totalExtractedWeight": weight}, "id", sessionID.String()))
	}

	if response, body := trueUp(50); response.Code != http.StatusBadRequest {
		t.Errorf("true-up to 50 with 90 jarred = %d %v, want 400", response.Code, body)
	}
	if response, body := trueUp(0); response.Code != http.StatusBadRequest {
		t.Errorf("true-up to 0 = %d %v, want 400 (formula treats 0 as unset)", response.Code, body)
	}
	if response, body := trueUp(95); response.Code != http.StatusOK {
		t.Errorf("true-up to 95 = %d %v, want 200", response.Code, body)
	}
}

// ASI-5-004: soft-deleting a harvest entry is a bulk withdrawal too.
func TestDeleteEntryCannotRemoveJarredPounds(t *testing.T) {
	server := honeyTestServer(t)
	jarSizeID := seedJarSize(t, server, "Pound", 16, 1200)
	seedHarvest(t, server, 100)
	jarStock(t, server, jarSizeID, 90)

	var entryID uuid.UUID
	if err := server.pool.QueryRow(context.Background(),
		`SELECT id FROM honey_harvests`).Scan(&entryID); err != nil {
		t.Fatalf("read entry: %v", err)
	}
	response, body := call(t, server.hsDeleteEntry, adminRequest(
		http.MethodDelete, "/api/v1/harvest-entries/"+entryID.String(), nil,
		"id", entryID.String()))
	if response.Code != http.StatusBadRequest {
		t.Fatalf("deleting the only entry with 90 lbs jarred = %d %v, want 400",
			response.Code, body)
	}

	// A second small entry keeps bulk above zero, so it can still be deleted.
	seedHarvest(t, server, 5)
	var smallID uuid.UUID
	if err := server.pool.QueryRow(context.Background(),
		`SELECT id FROM honey_harvests WHERE calculated_honey_weight=5`).Scan(&smallID); err != nil {
		t.Fatalf("read small entry: %v", err)
	}
	response, body = call(t, server.hsDeleteEntry, adminRequest(
		http.MethodDelete, "/api/v1/harvest-entries/"+smallID.String(), nil,
		"id", smallID.String()))
	if response.Code != http.StatusOK {
		t.Fatalf("deleting a covered entry = %d %v, want 200", response.Code, body)
	}
}

// ASI-3-001: a public signup may set the opt-in flag on an existing customer
// but must never rewrite the CRM record's name or referral.
func TestPublicSubscribeCannotRewriteExistingCustomer(t *testing.T) {
	server := honeyTestServer(t)
	ctx := context.Background()

	if _, err := server.pool.Exec(ctx, `
		INSERT INTO customers (name, email, email_opt_in, referral_code)
		VALUES ('Real Name', 'buyer@example.com', false, 'REF12345')`); err != nil {
		t.Fatalf("seed customer: %v", err)
	}
	response, body := call(t, server.harvestLotCreate, adminRequest(
		http.MethodPost, "/api/v1/harvest-lots", map[string]any{
			"lotCode":        "2026-STORY-01",
			"publicSlug":     "asi-story",
			"extractionDate": time.Now().Format("2006-01-02"),
			"honeyWeightLbs": 10,
		}))
	if response.Code != http.StatusCreated {
		t.Fatalf("create lot = %d %v", response.Code, body)
	}

	response, body = call(t, server.publicHoneyStorySubscribe, adminRequest(
		http.MethodPost, "/api/v1/public/honey-stories/asi-story/subscribe",
		map[string]any{
			"name":       "Attacker",
			"email":      "buyer@example.com",
			"referredBy": "EVIL",
		}, "slug", "asi-story"))
	if response.Code != http.StatusCreated {
		t.Fatalf("subscribe = %d %v", response.Code, body)
	}

	var name string
	var referredBy *string
	var optIn bool
	if err := server.pool.QueryRow(ctx, `
		SELECT name, referred_by, email_opt_in FROM customers
		WHERE lower(email)='buyer@example.com'`).Scan(&name, &referredBy, &optIn); err != nil {
		t.Fatalf("read customer: %v", err)
	}
	if name != "Real Name" {
		t.Errorf("subscribe rewrote the customer name to %q", name)
	}
	if referredBy != nil {
		t.Errorf("subscribe stamped referred_by = %q", *referredBy)
	}
	if !optIn {
		t.Error("subscribe did not set the opt-in flag")
	}
}

// ASI-3-003 / ASI-3-004: repeated login failures from one IP get throttled,
// and a successful login no longer echoes the session JWT in the body.
func TestLoginOmitsTokenAndThrottlesFailures(t *testing.T) {
	server := honeyTestServer(t)
	ctx := context.Background()
	hash, err := bcrypt.GenerateFromPassword([]byte("correct-horse"), bcrypt.MinCost)
	if err != nil {
		t.Fatalf("hash password: %v", err)
	}
	if _, err := server.pool.Exec(ctx, `DELETE FROM user_settings`); err != nil {
		t.Fatalf("clear settings: %v", err)
	}
	if _, err := server.pool.Exec(ctx, `
		INSERT INTO user_settings (password_hash, display_name)
		VALUES ($1, 'Tester')`, string(hash)); err != nil {
		t.Fatalf("seed settings: %v", err)
	}

	send := func(password, remoteAddr string) *httptest.ResponseRecorder {
		request := httptest.NewRequest(http.MethodPost, "/api/v1/auth/login",
			strings.NewReader(`{"password":"`+password+`"}`))
		request.RemoteAddr = remoteAddr
		response := httptest.NewRecorder()
		server.handleLogin(response, request)
		return response
	}

	good := send("correct-horse", "198.51.100.7:1000")
	if good.Code != http.StatusOK {
		t.Fatalf("login = %d %s", good.Code, good.Body.String())
	}
	if strings.Contains(good.Body.String(), `"token"`) {
		t.Error("login response still echoes the session token")
	}
	if len(good.Result().Cookies()) == 0 {
		t.Error("login did not set the session cookie")
	}

	throttled := false
	for i := 0; i < 10; i++ {
		response := send("wrong-password", "198.51.100.8:1000")
		if response.Code == http.StatusTooManyRequests {
			throttled = true
			break
		}
		if response.Code != http.StatusUnauthorized {
			t.Fatalf("failed login = %d, want 401 or 429", response.Code)
		}
	}
	if !throttled {
		t.Error("ten rapid wrong-password attempts were never throttled")
	}
}

// ASI-5-001: the receipt-completion write must survive the client
// disconnecting right after the handler commits; otherwise a later replay
// re-executes the mutation.
func TestOfflineReceiptCompletesAfterClientDisconnect(t *testing.T) {
	server := honeyTestServer(t)
	mutationID := uuid.New().String()

	var cancel context.CancelFunc
	handler := server.offlineMutations(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusCreated, map[string]any{"ok": true})
		cancel() // the flaky-signal market-day disconnect
	}))

	request := adminRequest(http.MethodPost, "/api/v1/expenses", map[string]any{})
	ctx, cancelFunc := context.WithCancel(request.Context())
	cancel = cancelFunc
	defer cancelFunc()
	request = request.WithContext(ctx)
	request.Header.Set("X-Offline-Mutation-ID", mutationID)
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusCreated {
		t.Fatalf("mutation = %d %s", response.Code, response.Body.String())
	}

	var state string
	if err := server.pool.QueryRow(context.Background(),
		`SELECT state FROM offline_mutation_receipts WHERE mutation_id=$1`,
		mutationID).Scan(&state); err != nil {
		t.Fatalf("read receipt: %v", err)
	}
	if state != "complete" {
		t.Errorf("receipt state = %q after client disconnect, want complete", state)
	}
}

// ASI-5-001 aggravator: a response over the capture limit is truncated to
// invalid JSON; storing it used to fail the jsonb insert and strand the
// receipt in 'processing'. The body is skipped instead and the replay serves
// the stored status.
func TestOfflineReceiptSkipsTruncatedBody(t *testing.T) {
	server := honeyTestServer(t)
	mutationID := uuid.New().String()
	blob := strings.Repeat("x", offlineResponseLimit)
	handler := server.offlineMutations(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusCreated, map[string]any{"blob": blob})
	}))

	send := func() *httptest.ResponseRecorder {
		request := adminRequest(http.MethodPost, "/api/v1/expenses", map[string]any{})
		request.Header.Set("X-Offline-Mutation-ID", mutationID)
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, request)
		return response
	}

	if first := send(); first.Code != http.StatusCreated {
		t.Fatalf("first submission = %d", first.Code)
	}
	var state string
	var storedBody []byte
	if err := server.pool.QueryRow(context.Background(),
		`SELECT state, response_body FROM offline_mutation_receipts WHERE mutation_id=$1`,
		mutationID).Scan(&state, &storedBody); err != nil {
		t.Fatalf("read receipt: %v", err)
	}
	if state != "complete" {
		t.Fatalf("receipt state = %q, want complete", state)
	}
	if len(storedBody) != 0 {
		t.Error("a truncated body was stored instead of skipped")
	}
	second := send()
	if second.Code != http.StatusCreated ||
		second.Header().Get("X-Offline-Replayed") != "true" {
		t.Errorf("replay = %d, replayed header %q; want stored 201",
			second.Code, second.Header().Get("X-Offline-Replayed"))
	}
}
