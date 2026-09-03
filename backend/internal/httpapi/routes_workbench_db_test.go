package httpapi

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/biker2000on/beez-trackz/backend/internal/app/production"
	"github.com/biker2000on/beez-trackz/backend/internal/app/sales"
)

func TestWorkbenchesUseLedgerReadModels(t *testing.T) {
	server := honeyTestServer(t)
	jarID := seedJarSize(t, server, "Workbench 16 oz", 16, 1200)
	lotID := seedLot(t, server, 20)
	jarStockFromLot(t, server, lotID, jarID, 5)

	productionRecorder := httptest.NewRecorder()
	server.productionWorkbench(productionRecorder, adminRequest(http.MethodGet,
		"/api/v1/production/workbench?year="+time.Now().UTC().Format("2006"), nil))
	if productionRecorder.Code != http.StatusOK {
		t.Fatalf("production status=%d body=%s", productionRecorder.Code, productionRecorder.Body.String())
	}
	var productionBody production.WorkbenchView
	if err := json.Unmarshal(productionRecorder.Body.Bytes(), &productionBody); err != nil {
		t.Fatalf("decode production workbench: %v", err)
	}
	if len(productionBody.BulkOnHand) == 0 || productionBody.BulkOnHand[0].AvailableLbs == "" {
		t.Fatalf("production workbench omitted ledger lot balance: %+v", productionBody.BulkOnHand)
	}
	if len(productionBody.Commands) == 0 || productionBody.Commands[0].Offline != "online_only" || productionBody.Commands[0].OfflineReason == nil {
		t.Fatalf("start extraction disposition is not truthful: %+v", productionBody.Commands)
	}

	salesRecorder := httptest.NewRecorder()
	server.salesWorkbench(salesRecorder, adminRequest(http.MethodGet,
		"/api/v1/sales/workbench?year="+time.Now().UTC().Format("2006"), nil))
	if salesRecorder.Code != http.StatusOK {
		t.Fatalf("sales status=%d body=%s", salesRecorder.Code, salesRecorder.Body.String())
	}
	var salesBody sales.WorkbenchView
	if err := json.Unmarshal(salesRecorder.Body.Bytes(), &salesBody); err != nil {
		t.Fatalf("decode sales workbench: %v", err)
	}
	if len(salesBody.Sellable) == 0 || salesBody.Sellable[0].AvailableAtHome <= 0 {
		t.Fatalf("sales workbench omitted home ledger availability: %+v", salesBody.Sellable)
	}

	// Guard the architectural boundary mechanically as well as by fixture:
	// neither query service may grow a dependency on retired quantity tables.
	for _, path := range []string{"../app/production/workbench.go", "../app/sales/workbench.go"} {
		source, err := os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		for _, legacy := range []string{"honey_movements", "stock_movements", "equipment_stock"} {
			if strings.Contains(string(source), legacy) {
				t.Errorf("%s reads legacy quantity source %s", path, legacy)
			}
		}
	}
}
