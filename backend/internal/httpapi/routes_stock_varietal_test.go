package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/biker2000on/beez-trackz/backend/internal/app/sales"
	"github.com/google/uuid"
)

// Consignment by varietal: a consignee's shelf is kept lot by lot, every
// write can pin a harvest lot, and the read models say which varietal is out.

// varietalFixture is two harvest lots of two varietals, jarred into one size
// and partly shipped to one shop.
type varietalFixture struct {
	jarSizeID       uuid.UUID
	shopID          uuid.UUID
	sourwood, wild  uuid.UUID // harvest lot ids
	sourwoodName    string
	wildName        string
	sourwoodCode    string
	wildCode        string
	sourwoodShipped int
	wildShipped     int
	sourwoodJarred  int
	wildJarred      int
}

func seedVarietalLot(t *testing.T, server *Server, name string, weightLbs float64) (uuid.UUID, string) {
	t.Helper()
	ctx := context.Background()
	var varietalID uuid.UUID
	if err := server.pool.QueryRow(ctx,
		`INSERT INTO honey_varietals (name) VALUES ($1) RETURNING id`, name).Scan(&varietalID); err != nil {
		t.Fatalf("seed varietal: %v", err)
	}
	t.Cleanup(func() {
		_, _ = server.pool.Exec(ctx, `DELETE FROM honey_varietals WHERE id=$1`, varietalID)
	})
	lotID := seedLot(t, server, weightLbs)
	var code string
	if err := server.pool.QueryRow(ctx,
		`UPDATE harvest_lots SET varietal_id=$2 WHERE id=$1 RETURNING lot_code`, lotID, varietalID).
		Scan(&code); err != nil {
		t.Fatalf("name the lot's varietal: %v", err)
	}
	return lotID, code
}

func seedVarietalFixture(t *testing.T, server *Server) varietalFixture {
	t.Helper()
	suffix := uuid.NewString()[:8]
	f := varietalFixture{
		sourwoodName: "Sourwood " + suffix, wildName: "Wildflower " + suffix,
		sourwoodJarred: 12, wildJarred: 10, sourwoodShipped: 5, wildShipped: 4,
	}
	f.jarSizeID = seedJarSize(t, server, "Pint", 16, 1200)
	seedHarvest(t, server, 100)
	f.sourwood, f.sourwoodCode = seedVarietalLot(t, server, f.sourwoodName, 30)
	f.wild, f.wildCode = seedVarietalLot(t, server, f.wildName, 30)
	jarStockFromLot(t, server, f.sourwood, f.jarSizeID, f.sourwoodJarred)
	jarStockFromLot(t, server, f.wild, f.jarSizeID, f.wildJarred)
	f.shopID = seedShop(t, server, "Bike shop", 30)

	response, body := transferLines(t, server, f.shopID, []map[string]any{
		{"jarSizeId": f.jarSizeID.String(), "quantity": f.sourwoodShipped, "harvestLotId": f.sourwood.String()},
		{"jarSizeId": f.jarSizeID.String(), "quantity": f.wildShipped, "harvestLotId": f.wild.String()},
	})
	if response.Code != http.StatusCreated {
		t.Fatalf("pinned transfer = %d %v", response.Code, body)
	}
	return f
}

func transferLines(
	t *testing.T, server *Server, locationID uuid.UUID, lines []map[string]any,
) (*httptest.ResponseRecorder, map[string]any) {
	t.Helper()
	return call(t, server.stockTransferCreate, adminRequest(
		http.MethodPost, "/api/v1/stock-locations/"+locationID.String()+"/transfers",
		map[string]any{"date": time.Now().Format("2006-01-02"), "lines": lines},
		"id", locationID.String()))
}

// shelfByLot indexes one location's jar rows by harvest lot id.
func shelfByLot(t *testing.T, server *Server, locationID, jarSizeID uuid.UUID) map[uuid.UUID]stockShelfRow {
	t.Helper()
	shelf, _, err := server.stockLocationShelf(context.Background(), server.pool, locationID)
	if err != nil {
		t.Fatalf("shelf: %v", err)
	}
	out := map[uuid.UUID]stockShelfRow{}
	for _, row := range shelf {
		if row.JarSizeID == nil || *row.JarSizeID != jarSizeID {
			continue
		}
		if row.HarvestLotID == nil {
			t.Fatalf("jar row without a harvest lot: %+v", row)
		}
		out[*row.HarvestLotID] = row
	}
	return out
}

func TestConsigneeShelfIsReportedPerVarietal(t *testing.T) {
	server := honeyTestServer(t)
	f := seedVarietalFixture(t, server)

	shelf := shelfByLot(t, server, f.shopID, f.jarSizeID)
	if len(shelf) != 2 {
		t.Fatalf("shop shelf has %d jar rows, want one per lot", len(shelf))
	}
	sourwood, wild := shelf[f.sourwood], shelf[f.wild]
	if sourwood.OnHand != f.sourwoodShipped || sourwood.VarietalName == nil || *sourwood.VarietalName != f.sourwoodName ||
		sourwood.LotCode == nil || *sourwood.LotCode != f.sourwoodCode {
		t.Errorf("sourwood row = %+v, want %d of %s (%s)", sourwood, f.sourwoodShipped, f.sourwoodName, f.sourwoodCode)
	}
	if wild.OnHand != f.wildShipped || wild.VarietalName == nil || *wild.VarietalName != f.wildName {
		t.Errorf("wildflower row = %+v, want %d of %s", wild, f.wildShipped, f.wildName)
	}
	// The whole SKU still adds up, and home keeps the remainder per lot.
	total := 0
	for _, row := range shelf {
		total += row.OnHand
	}
	if total != f.sourwoodShipped+f.wildShipped {
		t.Errorf("shop total = %d, want %d", total, f.sourwoodShipped+f.wildShipped)
	}
	home := shelfByLot(t, server, homeLocation(t, server), f.jarSizeID)
	if home[f.sourwood].OnHand != f.sourwoodJarred-f.sourwoodShipped || home[f.wild].OnHand != f.wildJarred-f.wildShipped {
		t.Errorf("home = %d sourwood, %d wildflower; want %d and %d",
			home[f.sourwood].OnHand, home[f.wild].OnHand,
			f.sourwoodJarred-f.sourwoodShipped, f.wildJarred-f.wildShipped)
	}

	// The movement history names the varietal each transfer carried.
	movements, err := server.stockMovementHistory(context.Background(), ledgerLocation(t, server, f.shopID), 100)
	if err != nil {
		t.Fatalf("movements: %v", err)
	}
	named := 0
	for _, movement := range movements {
		if movement.VarietalName != nil {
			named++
		}
	}
	if named == 0 {
		t.Errorf("no movement names its varietal: %+v", movements)
	}
}

func TestInventoryMatrixSplitsEachSKUByLot(t *testing.T) {
	server := honeyTestServer(t)
	f := seedVarietalFixture(t, server)
	homeID := homeLocation(t, server)

	recorder := httptest.NewRecorder()
	server.stockInventoryHandler(recorder, adminRequest(
		http.MethodGet, "/api/v1/stock-locations/inventory", nil))
	if recorder.Code != http.StatusOK {
		t.Fatalf("inventory = %d %s", recorder.Code, recorder.Body.String())
	}
	var decoded struct {
		Items []stockInventoryRow `json:"items"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &decoded); err != nil {
		t.Fatalf("decode inventory: %v", err)
	}
	if len(decoded.Items) != 1 {
		t.Fatalf("inventory listed %d SKUs, want the one jar size", len(decoded.Items))
	}
	jar := decoded.Items[0]
	if jar.Total != f.sourwoodJarred+f.wildJarred || jar.ByLocation[f.shopID.String()] != f.sourwoodShipped+f.wildShipped {
		t.Errorf("per-SKU shape changed: total %d, shop %d", jar.Total, jar.ByLocation[f.shopID.String()])
	}
	if len(jar.Lots) != 2 {
		t.Fatalf("jar lots = %+v, want two", jar.Lots)
	}
	// Sorted by varietal: Sourwood before Wildflower.
	sourwood, wild := jar.Lots[0], jar.Lots[1]
	if sourwood.HarvestLotID == nil || *sourwood.HarvestLotID != f.sourwood ||
		sourwood.VarietalName == nil || *sourwood.VarietalName != f.sourwoodName ||
		sourwood.LotCode == nil || *sourwood.LotCode != f.sourwoodCode ||
		sourwood.Total != f.sourwoodJarred ||
		sourwood.ByLocation[homeID.String()] != f.sourwoodJarred-f.sourwoodShipped ||
		sourwood.ByLocation[f.shopID.String()] != f.sourwoodShipped {
		t.Errorf("sourwood lot = %+v", sourwood)
	}
	if wild.HarvestLotID == nil || *wild.HarvestLotID != f.wild || wild.Total != f.wildJarred ||
		wild.ByLocation[homeID.String()] != f.wildJarred-f.wildShipped ||
		wild.ByLocation[f.shopID.String()] != f.wildShipped {
		t.Errorf("wildflower lot = %+v", wild)
	}
}

func TestPinnedTransferIsRefusedWhenTheLotIsShort(t *testing.T) {
	server := honeyTestServer(t)
	f := seedVarietalFixture(t, server)
	homeSourwood := f.sourwoodJarred - f.sourwoodShipped // 7

	// 16 pints are at home across both lots, but only 7 of them are Sourwood.
	response, body := transferLines(t, server, f.shopID, []map[string]any{
		{"jarSizeId": f.jarSizeID.String(), "quantity": homeSourwood + 1, "harvestLotId": f.sourwood.String()},
	})
	if response.Code < 400 || response.Code >= 500 {
		t.Fatalf("over-pinned transfer = %d %v, want a 4xx", response.Code, body)
	}
	message, _ := body["error"].(string)
	if !strings.Contains(message, f.sourwoodCode) {
		t.Errorf("refusal %q does not name lot %s", message, f.sourwoodCode)
	}
	// Nothing moved.
	shelf := shelfByLot(t, server, f.shopID, f.jarSizeID)
	if shelf[f.sourwood].OnHand != f.sourwoodShipped || shelf[f.wild].OnHand != f.wildShipped {
		t.Errorf("a refused transfer moved stock: %+v", shelf)
	}

	// The same quantity unpinned FIFOs across both lots and succeeds.
	response, body = transferLines(t, server, f.shopID, []map[string]any{
		{"jarSizeId": f.jarSizeID.String(), "quantity": homeSourwood + 1},
	})
	if response.Code != http.StatusCreated {
		t.Fatalf("unpinned transfer = %d %v", response.Code, body)
	}
	shelf = shelfByLot(t, server, f.shopID, f.jarSizeID)
	if shelf[f.sourwood].OnHand+shelf[f.wild].OnHand != f.sourwoodShipped+f.wildShipped+homeSourwood+1 {
		t.Errorf("unpinned transfer shelf = %+v", shelf)
	}
	// A product line cannot name a harvest lot, and an unknown lot is a 400.
	response, body = transferLines(t, server, f.shopID, []map[string]any{
		{"jarSizeId": f.jarSizeID.String(), "quantity": 1, "harvestLotId": uuid.NewString()},
	})
	if response.Code != http.StatusBadRequest {
		t.Errorf("unknown harvestLotId = %d %v, want 400", response.Code, body)
	}
}

func TestSettlementLinePinnedToALotMovesOnlyThatLot(t *testing.T) {
	server := honeyTestServer(t)
	f := seedVarietalFixture(t, server)
	ctx := context.Background()

	// Of the 4 Wildflower on their shelf: 2 sold, 1 back, they count 0 — so
	// one Wildflower went missing. Sourwood is not mentioned and must not move.
	response, body := call(t, server.stockSettlementCreate, adminRequest(
		http.MethodPost, "/api/v1/stock-locations/"+f.shopID.String()+"/settlements",
		map[string]any{
			"periodStart": "2026-08-01", "periodEnd": "2026-08-31", "reportedAt": "2026-09-02",
			"paymentMethod": "check", "amountPaid": 0,
			"lines": []map[string]any{{
				"jarSizeId": f.jarSizeID.String(), "harvestLotId": f.wild.String(),
				"quantitySold": 2, "quantityReturned": 1, "unitPrice": 12.00, "countOnShelf": 0,
			}},
		}, "id", f.shopID.String()))
	if response.Code != http.StatusCreated {
		t.Fatalf("settlement = %d %v", response.Code, body)
	}
	if body["soldUnits"] != float64(2) || body["returnedUnits"] != float64(1) || body["shrinkUnits"] != float64(1) {
		t.Errorf("units = %v sold, %v returned, %v shrink; want 2/1/1", body["soldUnits"], body["returnedUnits"], body["shrinkUnits"])
	}

	shelf := shelfByLot(t, server, f.shopID, f.jarSizeID)
	if shelf[f.sourwood].OnHand != f.sourwoodShipped {
		t.Errorf("sourwood moved on a wildflower report: %+v", shelf[f.sourwood])
	}
	if _, still := shelf[f.wild]; still {
		t.Errorf("wildflower should be gone from the shelf: %+v", shelf[f.wild])
	}
	home := shelfByLot(t, server, homeLocation(t, server), f.jarSizeID)
	if home[f.wild].OnHand != f.wildJarred-f.wildShipped+1 {
		t.Errorf("home wildflower = %d, want %d (one came back)", home[f.wild].OnHand, f.wildJarred-f.wildShipped+1)
	}
	if home[f.sourwood].OnHand != f.sourwoodJarred-f.sourwoodShipped {
		t.Errorf("home sourwood = %d, want untouched %d", home[f.sourwood].OnHand, f.sourwoodJarred-f.sourwoodShipped)
	}

	// Every ledger line the settlement wrote is on the Wildflower lot.
	var otherLots int
	if err := server.pool.QueryRow(ctx, `
		SELECT COUNT(*) FROM inventory_movements m
		JOIN inventory_operations o ON o.id = m.operation_id
		JOIN inventory_lots lot ON lot.id = m.lot_id
		WHERE ((o.source_type IN ('consignment_settlement','consignment_settlement_return') AND o.source_id=$1)
		   OR (o.source_type='sale' AND o.source_id=(SELECT sale_id FROM consignment_settlements WHERE id=$1)))
		  AND lot.source_id IS DISTINCT FROM $2`, body["id"], f.wild).Scan(&otherLots); err != nil {
		t.Fatalf("count movements: %v", err)
	}
	if otherLots != 0 {
		t.Errorf("%d settlement movements touched a lot other than Wildflower", otherLots)
	}

	// The settlement history reads the same thing back, per lot.
	settlements, err := server.stockSettlementRows(ctx, ledgerLocation(t, server, f.shopID))
	if err != nil {
		t.Fatalf("settlements: %v", err)
	}
	if len(settlements) != 1 || len(settlements[0].Lines) != 1 {
		t.Fatalf("settlement rows = %+v, want one with one line", settlements)
	}
	line := settlements[0].Lines[0]
	if line.HarvestLotID == nil || *line.HarvestLotID != f.wild || line.VarietalName == nil ||
		*line.VarietalName != f.wildName || line.LotCode == nil || *line.LotCode != f.wildCode ||
		line.Sold != 2 || line.Returned != 1 || line.Shrink != 1 {
		t.Errorf("settlement line = %+v, want wildflower 2 sold / 1 returned / 1 shrink", line)
	}

	// A report that accounts for more of a lot than the shop holds is refused
	// by lot, even though the SKU as a whole would cover it.
	response, body = call(t, server.stockSettlementCreate, adminRequest(
		http.MethodPost, "/api/v1/stock-locations/"+f.shopID.String()+"/settlements",
		map[string]any{
			"periodStart": "2026-09-01", "periodEnd": "2026-09-30",
			"paymentMethod": "check", "amountPaid": 0,
			"lines": []map[string]any{{
				"jarSizeId": f.jarSizeID.String(), "harvestLotId": f.wild.String(),
				"quantitySold": 1, "unitPrice": 12.00,
			}},
		}, "id", f.shopID.String()))
	if response.Code < 400 || response.Code >= 500 {
		t.Errorf("over-reported lot = %d %v, want a 4xx", response.Code, body)
	}
}

// A location sale (a farm stand ringing up its own stock; consignees settle
// instead) that names a harvest lot takes that varietal off the shelf.
func TestLocationSaleConsumesThePinnedLot(t *testing.T) {
	server := honeyTestServer(t)
	f := seedVarietalFixture(t, server)
	standID := seedStand(t, server, "Saturday stand")
	response, body := transferLines(t, server, standID, []map[string]any{
		{"jarSizeId": f.jarSizeID.String(), "quantity": 3, "harvestLotId": f.sourwood.String()},
		{"jarSizeId": f.jarSizeID.String(), "quantity": 2, "harvestLotId": f.wild.String()},
	})
	if response.Code != http.StatusCreated {
		t.Fatalf("stand transfer = %d %v", response.Code, body)
	}

	response, body = call(t, server.honeyRecordSale, adminRequest(
		http.MethodPost, "/api/v1/sales", map[string]any{
			"date": time.Now().Format("2006-01-02"), "stockLocationId": standID.String(),
			"harvestLotId": f.sourwood.String(),
			"lines":        []map[string]any{{"jarSizeId": f.jarSizeID.String(), "quantity": 2, "unitPrice": 12.00}},
		}))
	if response.Code != http.StatusCreated {
		t.Fatalf("location sale = %d %v", response.Code, body)
	}
	shelf := shelfByLot(t, server, standID, f.jarSizeID)
	if shelf[f.sourwood].OnHand != 1 || shelf[f.wild].OnHand != 2 {
		t.Errorf("sale did not draw from the pinned lot: %+v", shelf)
	}
	// More Wildflower than the stand holds of that lot is refused, although
	// the SKU total could cover it.
	response, body = call(t, server.honeyRecordSale, adminRequest(
		http.MethodPost, "/api/v1/sales", map[string]any{
			"date": time.Now().Format("2006-01-02"), "stockLocationId": standID.String(),
			"harvestLotId": f.wild.String(),
			"lines":        []map[string]any{{"jarSizeId": f.jarSizeID.String(), "quantity": 3, "unitPrice": 12.00}},
		}))
	if response.Code < 400 || response.Code >= 500 {
		t.Errorf("over-pinned sale = %d %v, want a 4xx", response.Code, body)
	}
	message, _ := body["error"].(string)
	if !strings.Contains(message, f.wildCode) {
		t.Errorf("refusal %q does not name lot %s", message, f.wildCode)
	}
}

func TestSalesWorkbenchSaysWhichVarietalsAreOut(t *testing.T) {
	server := honeyTestServer(t)
	f := seedVarietalFixture(t, server)

	recorder := httptest.NewRecorder()
	server.salesWorkbench(recorder, adminRequest(http.MethodGet,
		"/api/v1/sales/workbench?year="+time.Now().UTC().Format("2006"), nil))
	if recorder.Code != http.StatusOK {
		t.Fatalf("workbench = %d %s", recorder.Code, recorder.Body.String())
	}
	var view sales.WorkbenchView
	if err := json.Unmarshal(recorder.Body.Bytes(), &view); err != nil {
		t.Fatalf("decode workbench: %v", err)
	}
	var shop *sales.ConsignmentLocation
	for i := range view.Consignment {
		if view.Consignment[i].Name == "Bike shop" {
			shop = &view.Consignment[i]
		}
	}
	if shop == nil {
		t.Fatalf("workbench lists no bike shop: %+v", view.Consignment)
	}
	if shop.UnitsOut != f.sourwoodShipped+f.wildShipped {
		t.Errorf("unitsOut = %d, want %d", shop.UnitsOut, f.sourwoodShipped+f.wildShipped)
	}
	if len(shop.ByVarietal) != 2 ||
		shop.ByVarietal[0].VarietalName == nil || *shop.ByVarietal[0].VarietalName != f.sourwoodName ||
		shop.ByVarietal[0].Units != f.sourwoodShipped ||
		shop.ByVarietal[1].VarietalName == nil || *shop.ByVarietal[1].VarietalName != f.wildName ||
		shop.ByVarietal[1].Units != f.wildShipped {
		t.Errorf("byVarietal = %+v, want %d %s and %d %s", shop.ByVarietal,
			f.sourwoodShipped, f.sourwoodName, f.wildShipped, f.wildName)
	}
}

// A value-added product carries the varietal of the honey its batch drew, so
// hot honey made from the Sourwood lot reads as Sourwood on a consignee's
// shelf, in the inventory matrix and in the movement history.
func TestProductBatchCarriesItsHoneyVarietalToTheShelf(t *testing.T) {
	server := honeyTestServer(t)
	f := seedVarietalFixture(t, server)

	response, body := call(t, server.productCreate, adminRequest(
		http.MethodPost, "/api/v1/products", map[string]any{
			"name": "Hot honey " + uuid.NewString()[:6], "kind": "hot_honey", "unit": "jar",
			"defaultPrice": 15.00, "sizeLabel": "8 oz",
		}))
	if response.Code != http.StatusCreated {
		t.Fatalf("create product = %d %v", response.Code, body)
	}
	productID := uuid.MustParse(body["id"].(string))
	response, body = call(t, server.productBatchCreate, adminRequest(
		http.MethodPost, "/api/v1/product-batches", map[string]any{
			"kind": "hot_honey", "productId": productID.String(), "harvestLotId": f.sourwood.String(),
			"startedAt": time.Now().Format("2006-01-02"), "honeyLbs": 4, "quantityOut": 6,
		}))
	if response.Code != http.StatusCreated {
		t.Fatalf("create batch = %d %v", response.Code, body)
	}
	response, body = transferLines(t, server, f.shopID, []map[string]any{
		{"productId": productID.String(), "quantity": 2},
	})
	if response.Code != http.StatusCreated {
		t.Fatalf("product transfer = %d %v", response.Code, body)
	}

	shelf, _, err := server.stockLocationShelf(context.Background(), server.pool, f.shopID)
	if err != nil {
		t.Fatalf("shelf: %v", err)
	}
	var found *stockShelfRow
	for i := range shelf {
		if shelf[i].ProductID != nil && *shelf[i].ProductID == productID {
			found = &shelf[i]
		}
	}
	if found == nil {
		t.Fatalf("product row missing from the shelf: %+v", shelf)
	}
	if found.OnHand != 2 {
		t.Fatalf("product on hand = %d, want 2", found.OnHand)
	}
	if found.VarietalName == nil || *found.VarietalName != f.sourwoodName {
		t.Fatalf("product varietal = %v, want %q", found.VarietalName, f.sourwoodName)
	}
	if found.LotCode == nil || *found.LotCode != f.sourwoodCode {
		t.Fatalf("product lot code = %v, want %q", found.LotCode, f.sourwoodCode)
	}
	history, err := server.stockMovementHistory(context.Background(), f.shopID, 20)
	if err != nil {
		t.Fatalf("history: %v", err)
	}
	var sawProduct bool
	for _, row := range history {
		if row.VarietalName != nil && *row.VarietalName == f.sourwoodName && row.Quantity == 2 && row.LotCode != nil && *row.LotCode == f.sourwoodCode {
			sawProduct = true
		}
	}
	if !sawProduct {
		t.Fatalf("history rows lack the product's varietal: %+v", history)
	}
}
