package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/biker2000on/beez-trackz/backend/internal/app"
	"github.com/biker2000on/beez-trackz/backend/internal/app/production"
	"github.com/biker2000on/beez-trackz/backend/internal/app/sales"
	"github.com/google/uuid"
)

// TestStockLocationReadersServeABaselineDatabase is the Phase B regression
// fixture for the five readers that used to name stock_locations. It uses a
// real baseline-profile database, where that table is absent.
func TestStockLocationReadersServeABaselineDatabase(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Minute)
	defer cancel()
	server, userID := baselineEquipServer(ctx, t, "beez_httpapi_stock_locations_baseline")

	var customerID uuid.UUID
	if err := server.pool.QueryRow(ctx, `
		INSERT INTO customers (name, email)
		VALUES ('Carolina Pedal Works', 'baseline-location@example.test')
		RETURNING id`).Scan(&customerID); err != nil {
		t.Fatalf("seed customer: %v", err)
	}

	shopID := baselineCreateLocation(t, server, userID, map[string]any{
		"name": "Carolina Pedal Works", "slug": "carolina-pedal-works",
		"isConsignment": true, "customerId": customerID.String(),
		"priceBasis": "commission", "commissionPercent": 30,
		"settlementCadence": "monthly", "address": "101 Baseline Way",
		"notes": "baseline consignee",
	})
	standID := baselineCreateLocation(t, server, userID, map[string]any{
		"name": "Baseline Farm Stand", "priceBasis": "retail",
		"settlementCadence": "monthly",
	})
	emptyID := baselineCreateLocation(t, server, userID, map[string]any{
		"name": "Baseline Empty", "priceBasis": "retail",
		"settlementCadence": "monthly",
	})

	active := true
	response, body := call(t, server.stockLocationUpdate,
		baselineRequest(userID, http.MethodPatch, "/stock-locations/"+emptyID.String(), map[string]any{
			"name": "Baseline Empty Updated", "priceBasis": "retail",
			"settlementCadence": "on_request", "isActive": active,
		}, "id", emptyID.String()))
	baselineOK(t, "update location", response)
	if body["id"] != emptyID.String() {
		t.Fatalf("updated id = %v, want %s", body["id"], emptyID)
	}

	// A mirrored Phase A row remains addressable by its old id, while its JSON
	// identity is the canonical inventory location id.
	legacyID, mirroredID := uuid.New(), uuid.New()
	if _, err := server.pool.Exec(ctx, `
		INSERT INTO inventory_locations
			(id,kind,name,slug,source_type,source_id,is_consignment,price_basis,
			 commission_bps,settlement_cadence,customer_id,address,notes,created_by)
		VALUES ($1,'consignee','Mirrored Shop','mirrored-shop','stock_location',$2,
		        true,'commission',2500,'monthly',$3,'Old address','migrated',$4)`,
		mirroredID, legacyID, customerID, userID); err != nil {
		t.Fatalf("seed mirrored location: %v", err)
	}
	detail := httptest.NewRecorder()
	server.stockLocationDetail(detail, baselineRequest(userID, http.MethodGet,
		"/stock-locations/"+legacyID.String(), nil, "id", legacyID.String()))
	baselineOK(t, "detail by legacy id", detail)
	var detailBody struct {
		Location stockLocationRow `json:"location"`
	}
	if err := json.Unmarshal(detail.Body.Bytes(), &detailBody); err != nil {
		t.Fatalf("decode detail: %v", err)
	}
	if detailBody.Location.ID != mirroredID {
		t.Fatalf("detail id = %s, want canonical %s", detailBody.Location.ID, mirroredID)
	}

	jarID := baselineJarStock(t, server, userID, 12)
	baselineTransfer(t, server, userID, standID, jarID, 4)
	baselineTransfer(t, server, userID, shopID, jarID, 4)

	// A draft addressed by a new post-reset location id must reserve at that
	// exact location; such rows have no legacy source_id to fall back to.
	response, body = call(t, server.stockLocationSaleCreate,
		baselineRequest(userID, http.MethodPost, "/stock-locations/"+standID.String()+"/sales", map[string]any{
			"date": time.Now().UTC().AddDate(0, 0, -1).Format("2006-01-02"), "channel": "farm_stand",
			"orderStatus": "draft",
			"lines":       []map[string]any{{"jarSizeId": jarID.String(), "quantity": 2, "unitPrice": 12.00}},
		}, "id", standID.String()))
	baselineOK(t, "record location sale", response)
	if body["id"] == nil {
		t.Fatalf("sale response omitted id: %v", body)
	}
	var reservationLocation uuid.UUID
	if err := server.pool.QueryRow(ctx, `
		SELECT r.location_id
		FROM inventory_reservations r
		JOIN jar_sizes js ON js.item_id=r.item_id
		WHERE js.id=$1`, jarID).Scan(&reservationLocation); err != nil {
		t.Fatalf("read reservation: %v", err)
	}
	if reservationLocation != standID {
		t.Fatalf("reservation location = %s, want new consignee %s", reservationLocation, standID)
	}

	// A real consignment report records a sale and settlement directly against
	// the inventory location id.
	response, body = call(t, server.stockSettlementCreate,
		baselineRequest(userID, http.MethodPost, "/stock-locations/"+shopID.String()+"/settlements", map[string]any{
			"periodStart": "2026-09-01", "periodEnd": "2026-09-03",
			"reportedAt": "2026-09-03", "paymentMethod": "check",
			"lines": []map[string]any{{"jarSizeId": jarID.String(), "quantitySold": 1, "unitPrice": 12.00}},
		}, "id", shopID.String()))
	baselineOK(t, "record consignment sale", response)
	if body["saleId"] == nil {
		t.Fatalf("settlement omitted sale id: %v", body)
	}
	var recordedLocation uuid.UUID
	if err := server.pool.QueryRow(ctx, `SELECT stock_location_id FROM sales WHERE id=$1`, body["saleId"]).Scan(&recordedLocation); err != nil {
		t.Fatalf("read consignment sale location: %v", err)
	}
	if recordedLocation != shopID {
		t.Fatalf("consignment sale location = %s, want %s", recordedLocation, shopID)
	}

	list := httptest.NewRecorder()
	server.stockLocationList(list, baselineRequest(userID, http.MethodGet, "/stock-locations", nil))
	baselineOK(t, "list locations", list)
	var locations []stockLocationRow
	if err := json.Unmarshal(list.Body.Bytes(), &locations); err != nil {
		t.Fatalf("decode location list: %v", err)
	}
	byID := make(map[uuid.UUID]stockLocationRow, len(locations))
	for _, location := range locations {
		byID[location.ID] = location
	}
	if got := byID[shopID]; got.CustomerName == nil || *got.CustomerName != "Carolina Pedal Works" || got.OnHandUnits != 3 {
		t.Fatalf("shop row = %+v, want customer and 3 on hand", got)
	}
	if got := byID[standID].OnHandUnits; got != 4 {
		t.Fatalf("stand onHandUnits = %d, want physical balance 4", got)
	}

	honey := httptest.NewRecorder()
	server.honeyInventoryHandler(honey, baselineRequest(userID, http.MethodGet, "/honey/inventory", nil))
	baselineOK(t, "honey inventory", honey)
	var honeyRows []honeyInventoryRow
	if err := json.Unmarshal(honey.Body.Bytes(), &honeyRows); err != nil || len(honeyRows) != 1 || honeyRows[0].OnHand <= 0 {
		t.Fatalf("honey inventory = %+v (decode err %v)", honeyRows, err)
	}

	baselineWorkbenches(t, server, userID, shopID)

	response, _ = call(t, server.stockLocationDelete,
		baselineRequest(userID, http.MethodDelete, "/stock-locations/"+emptyID.String(), nil,
			"id", emptyID.String()))
	baselineOK(t, "delete empty location", response)
	var deleted bool
	if err := server.pool.QueryRow(ctx,
		`SELECT deleted_at IS NOT NULL AND NOT is_active FROM inventory_locations WHERE id=$1`, emptyID).
		Scan(&deleted); err != nil || !deleted {
		t.Fatalf("deleted location state = %v (query err %v)", deleted, err)
	}
}

func baselineCreateLocation(t *testing.T, server *Server, userID uuid.UUID, payload map[string]any) uuid.UUID {
	t.Helper()
	response, body := call(t, server.stockLocationCreate,
		baselineRequest(userID, http.MethodPost, "/stock-locations", payload))
	baselineOK(t, "create location", response)
	id, err := uuid.Parse(body["id"].(string))
	if err != nil {
		t.Fatalf("parse location id: %v", err)
	}
	return id
}

func baselineJarStock(t *testing.T, server *Server, userID uuid.UUID, quantity int) uuid.UUID {
	t.Helper()
	ctx := context.Background()
	var jarID, lotID uuid.UUID
	if err := server.pool.QueryRow(ctx, `
		INSERT INTO jar_sizes (label,honey_oz,default_price_cents)
		VALUES ('Baseline pint',16,1200) RETURNING id`).Scan(&jarID); err != nil {
		t.Fatalf("seed jar size: %v", err)
	}
	code := "BASELINE-" + uuid.NewString()[:8]
	err := app.NewRunner(server.pool).Run(ctx, app.UserActor(userID, "Baseline Admin"),
		func(ctx context.Context, uow *app.UnitOfWork) error {
			if err := uow.QueryRow(ctx, `
				INSERT INTO harvest_lots (lot_code,public_slug,extraction_date,honey_weight_lbs)
				VALUES ($1,$2,CURRENT_DATE,$3) RETURNING id`,
				code, "slug-"+code, float64(quantity)).Scan(&lotID); err != nil {
				return err
			}
			return production.New().SetLotCeiling(ctx, uow, lotID, float64(quantity), time.Now().UTC())
		})
	if err != nil {
		t.Fatalf("seed lot ceiling: %v", err)
	}
	response, body := call(t, server.honeyRecordJarring,
		baselineRequest(userID, http.MethodPost, "/honey/jarring", map[string]any{
			"date": time.Now().UTC().AddDate(0, 0, -1).Format("2006-01-02"), "lotId": lotID.String(),
			"lines": []map[string]any{{"jarSizeId": jarID.String(), "quantity": quantity}},
		}))
	baselineOK(t, "jar stock", response)
	if body["success"] != true {
		t.Fatalf("jarring response = %v", body)
	}
	return jarID
}

func baselineTransfer(t *testing.T, server *Server, userID, locationID, jarID uuid.UUID, quantity int) {
	t.Helper()
	response, _ := call(t, server.stockTransferCreate,
		baselineRequest(userID, http.MethodPost, "/stock-locations/"+locationID.String()+"/transfers", map[string]any{
			"date":  time.Now().UTC().AddDate(0, 0, -1).Format("2006-01-02"),
			"lines": []map[string]any{{"jarSizeId": jarID.String(), "quantity": quantity}},
		}, "id", locationID.String()))
	baselineOK(t, "transfer stock", response)
}

func baselineWorkbenches(t *testing.T, server *Server, userID, shopID uuid.UUID) {
	t.Helper()
	year := time.Now().UTC().Format("2006")
	productionResponse := httptest.NewRecorder()
	server.productionWorkbench(productionResponse, baselineRequest(userID, http.MethodGet,
		"/production/workbench?year="+year, nil))
	baselineOK(t, "production workbench", productionResponse)
	var productionView production.WorkbenchView
	if err := json.Unmarshal(productionResponse.Body.Bytes(), &productionView); err != nil || len(productionView.JarStock) == 0 {
		t.Fatalf("production workbench = %+v (decode err %v)", productionView, err)
	}

	salesResponse := httptest.NewRecorder()
	server.salesWorkbench(salesResponse, baselineRequest(userID, http.MethodGet,
		"/sales/workbench?year="+year, nil))
	baselineOK(t, "sales workbench", salesResponse)
	var salesView sales.WorkbenchView
	if err := json.Unmarshal(salesResponse.Body.Bytes(), &salesView); err != nil {
		t.Fatalf("decode sales workbench: %v", err)
	}
	found := false
	for _, location := range salesView.Consignment {
		if location.LocationID == shopID {
			found = true
		}
	}
	if !found {
		t.Fatalf("sales workbench omitted consignee %s: %+v", shopID, salesView.Consignment)
	}
}

func baselineOK(t *testing.T, what string, response *httptest.ResponseRecorder) {
	t.Helper()
	if response.Code >= 300 {
		t.Fatalf("%s = %d %s", what, response.Code, response.Body.String())
	}
}
