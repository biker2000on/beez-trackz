package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/google/uuid"
)

// Catalog product tests: the adjustment ledger, the batch void, and the
// per-batch cost reporting. The arithmetic ones run everywhere; the ledger
// ones need TEST_DATABASE_URL and skip without it, like the rest of the honey
// suite.

// --- pure arithmetic -------------------------------------------------------

func TestProductDivideCentsRoundsHalfAwayFromZero(t *testing.T) {
	t.Parallel()
	cases := []struct {
		name  string
		total money
		units int
		want  money
	}{
		{"exact", 2400, 8, 300},
		{"rounds down below the half", 2250, 8, 281},     // 281.25
		{"rounds the half away from zero", 2250, 4, 563}, // 562.5
		{"one unit keeps the whole cost", 999, 1, 999},
		{"no output has no unit cost", 500, 0, 0},
		{"negative totals round symmetrically", -2250, 4, -563},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			if got := productDivideCents(tc.total, tc.units); got != tc.want {
				t.Errorf("productDivideCents(%d, %d) = %d, want %d",
					tc.total, tc.units, got, tc.want)
			}
		})
	}
}

func TestProductBatchApplyCostSumsIngredientsAndHoney(t *testing.T) {
	t.Parallel()
	lbs := func(v float64) *float64 { return &v }
	cases := []struct {
		name        string
		row         productBatchRow
		costPerLb   float64
		wantHoney   money
		wantTotal   money
		wantPerUnit money
	}{
		{
			name:        "honey and ingredients both count",
			row:         productBatchRow{HoneyLbs: lbs(5), QuantityOut: 8, IngredientCost: 2000},
			costPerLb:   0.5,
			wantHoney:   250,
			wantTotal:   2250,
			wantPerUnit: 281,
		},
		{
			name:        "a tincture batch has no honey cost",
			row:         productBatchRow{QuantityOut: 4, IngredientCost: 1000},
			costPerLb:   0.5,
			wantHoney:   0,
			wantTotal:   1000,
			wantPerUnit: 250,
		},
		{
			// Nothing harvested yet, so a pound has no price. Better an
			// unpriced pound than a cost invented by a division by zero.
			name:        "an unpriced pound contributes nothing",
			row:         productBatchRow{HoneyLbs: lbs(40), QuantityOut: 20},
			costPerLb:   0,
			wantHoney:   0,
			wantTotal:   0,
			wantPerUnit: 0,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			row := tc.row
			productBatchApplyCost(&row, tc.costPerLb)
			if row.HoneyCost != tc.wantHoney || row.TotalCost != tc.wantTotal ||
				row.CostPerUnit != tc.wantPerUnit {
				t.Errorf("cost = honey %d, total %d, per unit %d; want %d/%d/%d",
					row.HoneyCost, row.TotalCost, row.CostPerUnit,
					tc.wantHoney, tc.wantTotal, tc.wantPerUnit)
			}
		})
	}
}

// --- ledger ----------------------------------------------------------------

// callArray is call() for the handlers that answer a JSON array.
func callArray(
	t *testing.T,
	handler http.HandlerFunc,
	request *http.Request,
) []map[string]any {
	t.Helper()
	response := httptest.NewRecorder()
	handler(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("%s %s = %d %s", request.Method, request.URL.Path,
			response.Code, response.Body.String())
	}
	var decoded []map[string]any
	if err := json.Unmarshal(response.Body.Bytes(), &decoded); err != nil {
		t.Fatalf("decode %q: %v", response.Body.String(), err)
	}
	return decoded
}

// seedCatalogProduct creates a hot-honey SKU. Hot honey consumes bulk honey
// without needing a harvest lot, which keeps the batch fixtures small.
func seedCatalogProduct(t *testing.T, server *Server, name string, price float64) uuid.UUID {
	t.Helper()
	response, body := call(t, server.productCreate, adminRequest(
		http.MethodPost, "/api/v1/products", map[string]any{
			"name": name, "kind": "hot_honey", "unit": "jar", "defaultPrice": price,
		}))
	if response.Code != http.StatusCreated {
		t.Fatalf("create product = %d %v", response.Code, body)
	}
	id, err := uuid.Parse(body["id"].(string))
	if err != nil {
		t.Fatalf("parse product id: %v", err)
	}
	return id
}

func seedProductBatch(
	t *testing.T,
	server *Server,
	productID uuid.UUID,
	honeyLbs float64,
	quantityOut int,
	expenseIDs ...uuid.UUID,
) uuid.UUID {
	t.Helper()
	// The batch names the lot its honey came out of. Bulk honey lives in lots
	// since decision 6, so a batch that names none draws the
	// legacy-unassigned bucket, which is empty in a fresh test database.
	payload := map[string]any{
		"kind":         "hot_honey",
		"productId":    productID.String(),
		"harvestLotId": seedFixtureLot(t, server, honeyLbs).String(),
		"startedAt":    time.Now().Format("2006-01-02"),
		"honeyLbs":     honeyLbs,
		"quantityOut":  quantityOut,
	}
	if len(expenseIDs) > 0 {
		ids := make([]string, 0, len(expenseIDs))
		for _, id := range expenseIDs {
			ids = append(ids, id.String())
		}
		payload["expenseIds"] = ids
	}
	response, body := call(t, server.productBatchCreate, adminRequest(
		http.MethodPost, "/api/v1/product-batches", payload))
	if response.Code != http.StatusCreated {
		t.Fatalf("create batch = %d %v", response.Code, body)
	}
	id, err := uuid.Parse(body["id"].(string))
	if err != nil {
		t.Fatalf("parse batch id: %v", err)
	}
	return id
}

// productOnHand reads one SKU out of the canonical inventory formula.
func productOnHand(t *testing.T, server *Server, productID uuid.UUID) int {
	t.Helper()
	inventory, err := productInventoryQuery(context.Background(), server.pool)
	if err != nil {
		t.Fatalf("product inventory: %v", err)
	}
	for _, row := range inventory {
		if row.ID == productID {
			return row.OnHand
		}
	}
	t.Fatalf("product %s missing from inventory", productID)
	return 0
}

// The gap this closes: a broken bottle had nowhere to go, because a catalog
// SKU's on-hand was batches minus sales and nothing else.
func TestProductAdjustmentRecordsShrink(t *testing.T) {
	server := honeyTestServer(t)
	seedHarvest(t, server, 100)
	productID := seedCatalogProduct(t, server, "Hot honey", 14)
	seedProductBatch(t, server, productID, 5, 8)

	if got := productOnHand(t, server, productID); got != 8 {
		t.Fatalf("on hand after the batch = %d, want 8", got)
	}

	response, body := call(t, server.productAdjustmentCreate, adminRequest(
		http.MethodPost, "/api/v1/product-adjustments", map[string]any{
			"productId": productID.String(),
			"date":      time.Now().Format("2006-01-02"),
			"delta":     -1,
			"reason":    "dropped it",
		}))
	if response.Code != http.StatusCreated {
		t.Fatalf("adjustment = %d %v", response.Code, body)
	}
	if got := productOnHand(t, server, productID); got != 7 {
		t.Errorf("on hand after shrink = %d, want 7", got)
	}

	// Shrink is a withdrawal, so it clears the same bar a sale does.
	over, overBody := call(t, server.productAdjustmentCreate, adminRequest(
		http.MethodPost, "/api/v1/product-adjustments", map[string]any{
			"productId": productID.String(),
			"date":      time.Now().Format("2006-01-02"),
			"delta":     -8,
		}))
	if over.Code != http.StatusBadRequest {
		t.Fatalf("shrink below zero = %d %v, want 400", over.Code, overBody)
	}
	if got := productOnHand(t, server, productID); got != 7 {
		t.Errorf("a rejected shrink still moved the count to %d", got)
	}

	// Undo is a soft delete: the row survives, the count comes back.
	adjustmentID, err := uuid.Parse(body["id"].(string))
	if err != nil {
		t.Fatalf("parse adjustment id: %v", err)
	}
	undo, undoBody := call(t, server.productAdjustmentDelete, adminRequest(
		http.MethodDelete, "/api/v1/product-adjustments/"+adjustmentID.String(), nil,
		"id", adjustmentID.String()))
	if undo.Code != http.StatusOK {
		t.Fatalf("undo = %d %v", undo.Code, undoBody)
	}
	if got := productOnHand(t, server, productID); got != 8 {
		t.Errorf("on hand after undo = %d, want 8", got)
	}
	// The ledger is append-only, so the undo is a reversing operation rather
	// than a deleted_at stamp: the original operation and its lines survive
	// and the reversal negates them.
	if reversalID := reversalOf(t, server, adjustmentID); reversalID == uuid.Nil {
		t.Error("the undo wrote no reversing operation")
	} else if got := operationItemQuantity(
		t, server, reversalID, productItemID(t, server, productID)); got != 1 {
		t.Errorf("reversal quantity = %v, want +1", got)
	}
	var original int
	if err := server.pool.QueryRow(context.Background(),
		`SELECT COUNT(*) FROM inventory_operations WHERE id=$1`, adjustmentID).
		Scan(&original); err != nil {
		t.Fatalf("read original adjustment: %v", err)
	}
	if original != 1 {
		t.Error("the undo destroyed the original operation")
	}
	// A second undo finds nothing live rather than adjusting twice.
	again, _ := call(t, server.productAdjustmentDelete, adminRequest(
		http.MethodDelete, "/api/v1/product-adjustments/"+adjustmentID.String(), nil,
		"id", adjustmentID.String()))
	if again.Code != http.StatusNotFound {
		t.Errorf("second undo = %d, want 404", again.Code)
	}
}

// A wrong 40 lb mead batch used to consume bulk honey permanently.
func TestProductBatchVoidReleasesHoneyAndOutput(t *testing.T) {
	server := honeyTestServer(t)
	seedHarvest(t, server, 100)
	productID := seedCatalogProduct(t, server, "Hot honey", 14)
	batchID := seedProductBatch(t, server, productID, 5, 8)

	ctx := context.Background()
	before, err := honeyBulkOnHand(ctx, server.pool)
	if err != nil {
		t.Fatalf("bulk before void: %v", err)
	}
	if before.BulkOnHandLbs > 95.1 {
		t.Fatalf("the batch did not consume its honey: %v", before.BulkOnHandLbs)
	}

	response, body := call(t, server.productBatchVoid, adminRequest(
		http.MethodPost, "/api/v1/product-batches/"+batchID.String()+"/void",
		map[string]any{"reason": "wrong recipe"}, "id", batchID.String()))
	if response.Code != http.StatusOK {
		t.Fatalf("void = %d %v", response.Code, body)
	}
	if body["reversedMovements"] != float64(1) {
		t.Errorf("reversed %v movements, want the batch's one bulk_use", body["reversedMovements"])
	}

	after, err := honeyBulkOnHand(ctx, server.pool)
	if err != nil {
		t.Fatalf("bulk after void: %v", err)
	}
	if after.BulkOnHandLbs < 99.9 || after.BulkOnHandLbs > 100.1 {
		t.Errorf("bulk on hand after void = %v, want the 100 lbs back", after.BulkOnHandLbs)
	}
	if got := productOnHand(t, server, productID); got != 0 {
		t.Errorf("a voided batch still made %d units", got)
	}
	// Reversal, not deletion: the batch's transform and its reversal both
	// survive and net to zero.
	var operations int
	if err := server.pool.QueryRow(ctx, `
		SELECT COUNT(*) FROM inventory_operations
		WHERE (source_type='product_batch' AND source_id=$1)
		   OR reverses_operation_id IN (
		        SELECT id FROM inventory_operations
		        WHERE source_type='product_batch' AND source_id=$1)`, batchID).
		Scan(&operations); err != nil {
		t.Fatalf("count operations: %v", err)
	}
	if operations != 2 {
		t.Errorf("batch operations = %d, want the original plus its reversal", operations)
	}
	var net float64
	if err := server.pool.QueryRow(ctx, `
		SELECT COALESCE(SUM(m.quantity), 0)::float8
		FROM inventory_movements m
		JOIN inventory_operations o ON o.id = m.operation_id
		WHERE o.source_type='product_batch' AND o.source_id=$1
		   OR o.reverses_operation_id IN (
		        SELECT id FROM inventory_operations
		        WHERE source_type='product_batch' AND source_id=$1)`, batchID).Scan(&net); err != nil {
		t.Fatalf("sum batch movements: %v", err)
	}
	if net != 0 {
		t.Errorf("batch movements net to %v, want 0", net)
	}

	second, _ := call(t, server.productBatchVoid, adminRequest(
		http.MethodPost, "/api/v1/product-batches/"+batchID.String()+"/void", nil,
		"id", batchID.String()))
	if second.Code != http.StatusConflict {
		t.Errorf("second void = %d, want 409", second.Code)
	}
}

// Output that has already been sold cannot be un-made.
func TestProductBatchVoidRefusedAfterASale(t *testing.T) {
	server := honeyTestServer(t)
	seedHarvest(t, server, 100)
	productID := seedCatalogProduct(t, server, "Hot honey", 14)
	batchID := seedProductBatch(t, server, productID, 5, 8)

	sale, saleBody := call(t, server.honeyRecordSale, adminRequest(
		http.MethodPost, "/api/v1/sales", map[string]any{
			"date": time.Now().Format("2006-01-02"),
			"lines": []map[string]any{
				{"kind": "hot_honey", "productId": productID.String(),
					"quantity": 2, "unitPrice": 14},
			},
		}))
	if sale.Code != http.StatusCreated {
		t.Fatalf("sale = %d %v", sale.Code, saleBody)
	}

	response, body := call(t, server.productBatchVoid, adminRequest(
		http.MethodPost, "/api/v1/product-batches/"+batchID.String()+"/void", nil,
		"id", batchID.String()))
	if response.Code != http.StatusConflict {
		t.Fatalf("void after a sale = %d %v, want 409", response.Code, body)
	}
	if got := productOnHand(t, server, productID); got != 6 {
		t.Errorf("the refused void still moved on hand to %d, want 6", got)
	}
}

// Hot-honey batch expenses were stored but never reported.
func TestProductBatchListReportsCostPerUnit(t *testing.T) {
	server := honeyTestServer(t)
	seedHarvest(t, server, 100)
	ctx := context.Background()

	// One expense stays unlinked, which is what prices a pound of honey; the
	// other is this batch's own ingredients.
	if _, err := server.pool.Exec(ctx, `
		INSERT INTO expenses (expense_date, category, description, amount_cents)
		VALUES (CURRENT_DATE, 'other', 'yard overhead', 5000)`); err != nil {
		t.Fatalf("seed overhead expense: %v", err)
	}
	var ingredients uuid.UUID
	if err := server.pool.QueryRow(ctx, `
		INSERT INTO expenses (expense_date, category, description, amount_cents)
		VALUES (CURRENT_DATE, 'grocery', 'peppers', 2000) RETURNING id`).
		Scan(&ingredients); err != nil {
		t.Fatalf("seed ingredient expense: %v", err)
	}

	productID := seedCatalogProduct(t, server, "Hot honey", 14)
	seedProductBatch(t, server, productID, 5, 8, ingredients)

	batches := callArray(t, server.productBatchList, adminRequest(
		http.MethodGet, "/api/v1/product-batches", nil))
	if len(batches) != 1 {
		t.Fatalf("batch list returned %d rows, want 1", len(batches))
	}
	row := batches[0]
	// $50 of unlinked expense over 100 lbs harvested is $0.50 a pound, so five
	// pounds of honey is $2.50 on top of the $20 of peppers.
	if row["ingredientCost"] != 20.00 || row["honeyCost"] != 2.50 ||
		row["totalCost"] != 22.50 || row["costPerUnit"] != 2.81 {
		t.Errorf("costs = ingredients %v, honey %v, total %v, per unit %v; "+
			"want 20.00/2.50/22.50/2.81",
			row["ingredientCost"], row["honeyCost"], row["totalCost"], row["costPerUnit"])
	}
}
