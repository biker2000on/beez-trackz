package httpapi

import (
	"context"
	"github.com/biker2000on/beez-trackz/backend/internal/app"
	"github.com/biker2000on/beez-trackz/backend/internal/app/production"
	"github.com/biker2000on/beez-trackz/backend/internal/app/sales"
	"github.com/google/uuid"
	"net/http"
	"testing"
	"time"
)

func TestAtlasStockReservationsPaymentAndFulfilment(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	server, user := baselineEquipServer(ctx, t, "beez_atlas_stock_regression")
	response, body := call(t, server.equipCreateType, baselineRequest(user, "POST", "/equipment/types", map[string]any{"name": "Atlas super", "category": "box"}))
	if response.Code != 200 && response.Code != 201 {
		t.Fatal(response.Body.String())
	}
	typeID := body["id"].(string)
	response, body = call(t, server.equipCreateStock, baselineRequest(user, "POST", "/equipment/stock", map[string]any{"typeId": typeID, "initialQuantity": 12}))
	if response.Code != 200 && response.Code != 201 {
		t.Fatal(response.Body.String())
	}
	itemID := body["id"].(string)
	hive := baselineHive(ctx, t, server)
	var sale uuid.UUID
	if err := server.pool.QueryRow(ctx, `INSERT INTO sales(date,total_amount_cents,amount_paid_cents,order_status,payment_method,channel,order_number) VALUES(CURRENT_DATE,1200,0,'draft','cash','direct','ATLAS-1') RETURNING id`).Scan(&sale); err != nil {
		t.Fatal(err)
	}
	if _, err := server.pool.Exec(ctx, `INSERT INTO sale_items(sale_id,kind,item_id,quantity,unit_price_cents) VALUES($1,'equipment',$2,12,100)`, sale, itemID); err != nil {
		t.Fatal(err)
	}
	response, body = call(t, server.atlasStock, baselineRequest(user, "GET", "/stock?kind=equipment&condition=serviceable", nil))
	if response.Code != 200 {
		t.Fatal(response.Body.String())
	}
	rows := body["rows"].([]any)
	if len(rows) != 1 {
		t.Fatalf("rows=%v", rows)
	}
	row := rows[0].(map[string]any)
	if row["onHand"] != "12.0000" || row["reserved"] != "12.0000" || row["available"] != "0.0000" {
		t.Fatalf("tuple=%v", row)
	}
	view, err := sales.Workbench(ctx, server.pool, app.UserActor(user, "test").WithAccess(true, nil), time.Now().Year(), time.Now(), nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(view.Drafts) != 1 || len(view.Drafts[0].Shortfalls) != 0 {
		t.Fatalf("own reservation shortage: %+v", view.Drafts)
	}
	response, _ = call(t, server.equipDeploy, baselineRequest(user, "POST", "/equipment/deployments", map[string]any{"stockId": itemID, "hiveId": hive.String(), "quantity": 1}))
	if response.Code != http.StatusUnprocessableEntity && response.Code != http.StatusConflict {
		t.Fatalf("reserved deployment = %d %s", response.Code, response.Body.String())
	}
	// Damaged stock cannot disguise a serviceable equipment order shortage.
	response, _ = call(t, server.equipMarkDamaged, baselineRequest(user, "POST", "/equipment/stock/"+itemID+"/damage", map[string]any{"quantity": 1, "reason": "broken"}, "id", itemID))
	if response.Code != 200 {
		t.Fatal(response.Body.String())
	}
	shortageView, err := sales.Workbench(ctx, server.pool, app.UserActor(user, "test").WithAccess(true, nil), time.Now().Year(), time.Now(), nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(shortageView.Drafts) != 1 || len(shortageView.Drafts[0].Shortfalls) != 1 || shortageView.Drafts[0].Shortfalls[0].Available != 11 {
		t.Fatalf("condition shortage=%+v", shortageView.Drafts)
	}
	response, _ = call(t, server.equipRepairStock, baselineRequest(user, "POST", "/equipment/stock/"+itemID+"/repair", map[string]any{"quantity": 1, "reason": "repaired"}, "id", itemID))
	if response.Code != 200 {
		t.Fatal(response.Body.String())
	}
	response, body = call(t, server.atlasPayment, baselineRequest(user, "POST", "/sales/"+sale.String()+"/payment", map[string]any{"amountPaidCents": 600}, "id", sale.String()))
	if response.Code != 200 || body["physicalAppliedAt"] != nil {
		t.Fatalf("payment=%d %v", response.Code, body)
	}
	var onHand string
	if err := server.pool.QueryRow(ctx, `SELECT SUM(on_hand)::text FROM inventory_balances WHERE item_id=$1`, itemID).Scan(&onHand); err != nil {
		t.Fatal(err)
	}
	if onHand != "12.0000" {
		t.Fatalf("payment moved stock: %s", onHand)
	}
	response, body = call(t, server.atlasFulfill, baselineRequest(user, "POST", "/sales/"+sale.String()+"/fulfill", map[string]any{}, "id", sale.String()))
	if response.Code != 200 || body["amountPaidCents"] != float64(600) || body["physicalAppliedAt"] == nil {
		t.Fatalf("fulfill=%d %v", response.Code, body)
	}
	at := body["physicalAppliedAt"]
	response, body = call(t, server.atlasFulfill, baselineRequest(user, "POST", "/sales/"+sale.String()+"/fulfill", map[string]any{}, "id", sale.String()))
	if response.Code != 200 || body["physicalAppliedAt"] != at {
		t.Fatalf("replay=%d %v", response.Code, body)
	}
	var count int
	if err := server.pool.QueryRow(ctx, `SELECT COUNT(*) FROM inventory_operations WHERE source_type='sale' AND source_id=$1 AND kind='sale_consume'`, sale).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 1 {
		t.Fatalf("consumption count %d", count)
	}
}

func TestAtlasStockScopeAndApiaryEditor(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	server, user := baselineEquipServer(ctx, t, "beez_atlas_scope_regression")
	response, body := call(t, server.equipCreateType, baselineRequest(user, "POST", "/equipment/types", map[string]any{"name": "Scoped box", "category": "box"}))
	if response.Code != 200 && response.Code != 201 {
		t.Fatal(response.Body.String())
	}
	typeID := body["id"].(string)
	response, body = call(t, server.equipCreateStock, baselineRequest(user, "POST", "/equipment/stock", map[string]any{"typeId": typeID, "initialQuantity": 22}))
	if response.Code != 200 && response.Code != 201 {
		t.Fatal(response.Body.String())
	}
	itemID := body["id"].(string)
	var home, shop, operation uuid.UUID
	if err := server.pool.QueryRow(ctx, `SELECT id FROM inventory_locations WHERE is_home`).Scan(&home); err != nil {
		t.Fatal(err)
	}
	if err := server.pool.QueryRow(ctx, `INSERT INTO inventory_locations(kind,name,is_consignment) VALUES('consignee','Atlas shop',true) RETURNING id`).Scan(&shop); err != nil {
		t.Fatal(err)
	}
	if err := server.pool.QueryRow(ctx, `INSERT INTO inventory_operations(id,kind,reason,occurred_at,idempotency_key,source_type,source_id,provenance) VALUES(gen_random_uuid(),'receive','none',now(),'atlas-shop-seed','equipment_type',$1,'recorded') RETURNING id`, typeID).Scan(&operation); err != nil {
		t.Fatal(err)
	}
	if _, err := server.pool.Exec(ctx, `INSERT INTO inventory_movements(id,operation_id,line_no,item_id,location_id,condition,quantity) VALUES(gen_random_uuid(),$1,1,$2,$3,'serviceable',8)`, operation, itemID, shop); err != nil {
		t.Fatal(err)
	}
	var sale uuid.UUID
	if err := server.pool.QueryRow(ctx, `INSERT INTO sales(date,total_amount_cents,order_status,payment_method,channel,order_number) VALUES(CURRENT_DATE,200,'draft','cash','direct','ATLAS-SCOPE') RETURNING id`).Scan(&sale); err != nil {
		t.Fatal(err)
	}
	if _, err := server.pool.Exec(ctx, `INSERT INTO sale_items(sale_id,kind,item_id,quantity,unit_price_cents) VALUES($1,'equipment',$2,2,100)`, sale, itemID); err != nil {
		t.Fatal(err)
	}
	for _, test := range []struct {
		location                    uuid.UUID
		onHand, reserved, available string
	}{{home, "22.0000", "2.0000", "20.0000"}, {shop, "8.0000", "0.0000", "8.0000"}} {
		response, body = call(t, server.atlasStock, baselineRequest(user, "GET", "/stock?itemId="+itemID+"&locationId="+test.location.String()+"&lotId=null&hiveId=null", nil))
		if response.Code != 200 {
			t.Fatal(response.Body.String())
		}
		rows := body["rows"].([]any)
		if len(rows) != 1 {
			t.Fatalf("rows=%v", rows)
		}
		row := rows[0].(map[string]any)
		if row["onHand"] != test.onHand || row["reserved"] != test.reserved || row["available"] != test.available {
			t.Fatalf("tuple=%v", row)
		}
	}
	hive := baselineHive(ctx, t, server)
	var apiary uuid.UUID
	if err := server.pool.QueryRow(ctx, `SELECT apiary_id FROM hives WHERE id=$1`, hive).Scan(&apiary); err != nil {
		t.Fatal(err)
	}
	editor := func(method, url string, body any) *http.Request {
		r := baselineRequest(user, method, url, body)
		return r.WithContext(context.WithValue(r.Context(), principalKey, &principal{ID: user, Memberships: map[uuid.UUID]string{apiary: "editor"}}))
	}
	response, body = call(t, server.atlasStock, editor("GET", "/stock?kind=equipment&apiaryId="+apiary.String(), nil))
	if response.Code != 200 {
		t.Fatal(response.Body.String())
	}
	rows := body["rows"].([]any)
	if len(rows) != 1 || rows[0].(map[string]any)["locationId"] != home.String() {
		t.Fatalf("editor scopes=%v", rows)
	}
	response, _ = call(t, server.atlasStock, editor("GET", "/stock?kind=equipment&apiaryId="+uuid.NewString(), nil))
	if response.Code != 403 {
		t.Fatalf("other apiary=%d", response.Code)
	}
	response, _ = call(t, server.equipDeploy, editor("POST", "/equipment/deployments", map[string]any{"stockId": itemID, "hiveId": hive.String(), "quantity": 1}))
	if response.Code != 200 {
		t.Fatalf("editor deploy=%d %s", response.Code, response.Body.String())
	}

	// Explicit apiary options must mean home even for an administrator.
	response, body = call(t, server.atlasStock, baselineRequest(user, "GET", "/stock?kind=equipment&apiaryId="+apiary.String(), nil))
	if response.Code != 200 {
		t.Fatal(response.Body.String())
	}
	for _, v := range body["rows"].([]any) {
		if v.(map[string]any)["locationId"] != home.String() {
			t.Fatalf("admin voice option escaped home: %v", v)
		}
	}
	response, body = call(t, server.atlasStock, baselineRequest(user, "GET", "/stock/"+itemID+"?locationId="+shop.String()+"&hiveId=null", nil, "id", itemID))
	if response.Code != 200 {
		t.Fatal(response.Body.String())
	}
	history := body["history"].([]any)
	if len(history) != 1 || history[0].(map[string]any)["locationId"] != shop.String() {
		t.Fatalf("history escaped selected shelf: %v", history)
	}
	var harvestLot uuid.UUID
	err := app.NewRunner(server.pool).Run(ctx, app.UserActor(user, "test").WithAccess(true, nil), func(ctx context.Context, uow *app.UnitOfWork) error {
		if err := uow.QueryRow(ctx, `INSERT INTO harvest_lots(lot_code,public_slug,extraction_date,honey_weight_lbs) VALUES('ATLAS-SOURCE','atlas-source',CURRENT_DATE,40) RETURNING id`).Scan(&harvestLot); err != nil {
			return err
		}
		return production.New().SetLotCeiling(ctx, uow, harvestLot, 40, time.Now())
	})
	if err != nil {
		t.Fatal(err)
	}
	response, body = call(t, server.atlasStock, baselineRequest(user, "GET", "/stock?kind=bulk_honey&harvestLotId="+harvestLot.String(), nil))
	if response.Code != 200 {
		t.Fatal(response.Body.String())
	}
	sourceRows := body["rows"].([]any)
	if len(sourceRows) != 1 {
		t.Fatalf("source filter: %v", sourceRows)
	}
	sourceRow := sourceRows[0].(map[string]any)
	if sourceRow["harvestLotId"] != harvestLot.String() || sourceRow["lotId"] == harvestLot.String() {
		t.Fatalf("domain/inventory identity mixed: %v", sourceRow)
	}
	otherHive := baselineHive(ctx, t, server)
	response, _ = call(t, server.equipDeploy, editor("POST", "/equipment/deployments", map[string]any{"stockId": itemID, "hiveId": otherHive.String(), "quantity": 1}))
	if response.Code != 403 {
		t.Fatalf("other apiary deploy=%d %s", response.Code, response.Body.String())
	}
}

func TestAtlasExtractionCompletionIsExplicit(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	server, user := baselineEquipServer(ctx, t, "beez_atlas_extraction_regression")
	hive := baselineHive(ctx, t, server)
	var apiary, session uuid.UUID
	if err := server.pool.QueryRow(ctx, `SELECT apiary_id FROM hives WHERE id=$1`, hive).Scan(&apiary); err != nil {
		t.Fatal(err)
	}
	if err := server.pool.QueryRow(ctx, `INSERT INTO harvest_sessions(apiary_id,date,total_extracted_weight) VALUES($1,CURRENT_DATE,0) RETURNING id`, apiary).Scan(&session); err != nil {
		t.Fatal(err)
	}
	actor := app.UserActor(user, "test").WithAccess(true, nil)
	view, err := production.Workbench(ctx, server.pool, actor, time.Now().Year(), time.Now(), nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(view.OpenSessions) != 1 {
		t.Fatalf("zero stock/weight incorrectly hides session: %+v", view.OpenSessions)
	}
	response, body := call(t, server.hsClose, baselineRequest(user, "POST", "/harvest-sessions/"+session.String()+"/close", map[string]any{}, "id", session.String()))
	if response.Code != 200 || body["closedAt"] == nil {
		t.Fatalf("close=%d %v", response.Code, body)
	}
	at := body["closedAt"]
	response, body = call(t, server.hsClose, baselineRequest(user, "POST", "/harvest-sessions/"+session.String()+"/close", map[string]any{}, "id", session.String()))
	if response.Code != 200 || body["closedAt"] != at {
		t.Fatalf("close replay=%d %v", response.Code, body)
	}
	view, err = production.Workbench(ctx, server.pool, actor, time.Now().Year(), time.Now(), nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(view.OpenSessions) != 0 {
		t.Fatalf("closed session active=%+v", view.OpenSessions)
	}
	err = app.NewRunner(server.pool).Run(ctx, actor, func(ctx context.Context, uow *app.UnitOfWork) error {
		_, err := production.AddHarvestEntry(ctx, uow, production.AddHarvestEntryInput{SessionID: session, SessionDate: time.Now(), Entries: []production.HarvestEntryInput{{HiveID: hive, HoneyWeight: 1}}})
		return err
	})
	if !app.IsKind(err, app.KindConflict) {
		t.Fatalf("entry accepted after close: %v", err)
	}
	response, body = call(t, server.hsDetail, baselineRequest(user, "GET", "/harvest-sessions/"+session.String(), nil, "id", session.String()))
	if response.Code != 200 || body["closedAt"] != at {
		t.Fatalf("history detail=%d %v", response.Code, body)
	}
}
