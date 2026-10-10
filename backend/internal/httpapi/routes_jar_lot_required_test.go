package httpapi

import (
	"context"
	"net/http"
	"strings"
	"testing"
	"strconv"
	"time"

	"github.com/google/uuid"
)

// Honey is sold by varietal. Every jar line of a sale, and every line of a
// give-away, names the harvest lot the jars come off, and the draw is strictly
// from that lot: a short lot is a refusal, never a spill into another lot.

// twoLotWorld is one jar size jarred out of two harvest lots, the older lot
// first so that a FIFO guess would always pick lotOld.
type twoLotWorld struct {
	jarSizeID        uuid.UUID
	lotOld, lotNew   uuid.UUID
	codeOld, codeNew string
}

func seedTwoLotWorld(t *testing.T, server *Server, oldJars, newJars int) twoLotWorld {
	t.Helper()
	w := twoLotWorld{jarSizeID: seedJarSize(t, server, "Pint", 16, 1200)}
	seedHarvest(t, server, 100)
	w.lotOld = seedLot(t, server, 30)
	w.lotNew = seedLot(t, server, 30)
	// The older lot is jarred first, so its jars are the oldest receipt.
	jarStockFromLot(t, server, w.lotOld, w.jarSizeID, oldJars)
	jarStockFromLot(t, server, w.lotNew, w.jarSizeID, newJars)
	for lot, code := range map[uuid.UUID]*string{w.lotOld: &w.codeOld, w.lotNew: &w.codeNew} {
		if err := server.pool.QueryRow(context.Background(),
			`SELECT lot_code FROM harvest_lots WHERE id=$1`, lot).Scan(code); err != nil {
			t.Fatalf("read lot code: %v", err)
		}
	}
	return w
}

func saleCount(t *testing.T, server *Server) int {
	t.Helper()
	var count int
	if err := server.pool.QueryRow(context.Background(),
		`SELECT COUNT(*) FROM sales`).Scan(&count); err != nil {
		t.Fatalf("count sales: %v", err)
	}
	return count
}

// saleLotQuantities maps each jar line's stored harvest_lot_id to its quantity.
func saleLotQuantities(t *testing.T, server *Server, saleID string) map[uuid.UUID]int {
	t.Helper()
	rows, err := server.pool.Query(context.Background(), `
		SELECT harvest_lot_id, quantity FROM sale_items
		WHERE sale_id=$1 AND kind='jar' AND harvest_lot_id IS NOT NULL`, saleID)
	if err != nil {
		t.Fatalf("read sale lines: %v", err)
	}
	defer rows.Close()
	out := map[uuid.UUID]int{}
	for rows.Next() {
		var lot uuid.UUID
		var quantity int
		if err := rows.Scan(&lot, &quantity); err != nil {
			t.Fatalf("scan sale line: %v", err)
		}
		out[lot] += quantity
	}
	if err := rows.Err(); err != nil {
		t.Fatalf("read sale lines: %v", err)
	}
	return out
}

func TestSaleJarLinesDrawEachFromItsOwnLot(t *testing.T) {
	server := honeyTestServer(t)
	w := seedTwoLotWorld(t, server, 10, 10)

	// Two lines of the SAME size, one per lot. Unpinned, FIFO would take all
	// seven from the older lot.
	response, body := call(t, server.honeyRecordSale, adminRequest(
		http.MethodPost, "/api/v1/sales", map[string]any{
			"date": time.Now().Format("2006-01-02"),
			"lines": []map[string]any{
				{"jarSizeId": w.jarSizeID.String(), "harvestLotId": w.lotOld.String(), "quantity": 3, "unitPrice": 12},
				{"jarSizeId": w.jarSizeID.String(), "harvestLotId": w.lotNew.String(), "quantity": 4, "unitPrice": 12},
			},
		}))
	if response.Code != http.StatusCreated {
		t.Fatalf("two-lot sale = %d %v", response.Code, body)
	}
	saleID, _ := body["id"].(string)

	shelf := shelfByLot(t, server, homeLocation(t, server), w.jarSizeID)
	if shelf[w.lotOld].OnHand != 7 || shelf[w.lotNew].OnHand != 6 {
		t.Errorf("home shelf after the sale = old %d new %d, want 7 and 6 (each line drew its own lot)",
			shelf[w.lotOld].OnHand, shelf[w.lotNew].OnHand)
	}

	stored := saleLotQuantities(t, server, saleID)
	if len(stored) != 2 || stored[w.lotOld] != 3 || stored[w.lotNew] != 4 {
		t.Errorf("sale_items.harvest_lot_id = %v, want old=3 new=4", stored)
	}

	// The consumption is recorded, not inferred.
	var method string
	if err := server.pool.QueryRow(context.Background(), `
		SELECT COALESCE(details->'lot_allocation'->>'method', '')
		FROM inventory_operations
		WHERE source_type='sale' AND source_id=$1 AND kind='sale_consume'`, saleID).
		Scan(&method); err != nil {
		t.Fatalf("read allocation method: %v", err)
	}
	if method != "recorded" {
		t.Errorf("allocation method = %q, want recorded", method)
	}
}

func TestSaleJarLineWithNoLotIsRefused(t *testing.T) {
	server := honeyTestServer(t)
	w := seedTwoLotWorld(t, server, 5, 5)

	response, body := call(t, server.honeyRecordSale, adminRequest(
		http.MethodPost, "/api/v1/sales", map[string]any{
			"date": time.Now().Format("2006-01-02"),
			"lines": []map[string]any{
				{"jarSizeId": w.jarSizeID.String(), "quantity": 2, "unitPrice": 12},
			},
		}))
	if response.Code != http.StatusBadRequest {
		t.Fatalf("lotless jar line = %d %v, want 400", response.Code, body)
	}
	if message, _ := body["error"].(string); !strings.Contains(message, "varietal / lot") {
		t.Errorf("refusal %q does not ask for a varietal / lot", message)
	}
	if got := saleCount(t, server); got != 0 {
		t.Errorf("a refused sale left %d sale rows", got)
	}

	// One line naming a lot does not excuse its lotless sibling.
	response, body = call(t, server.honeyRecordSale, adminRequest(
		http.MethodPost, "/api/v1/sales", map[string]any{
			"date": time.Now().Format("2006-01-02"),
			"lines": []map[string]any{
				{"jarSizeId": w.jarSizeID.String(), "harvestLotId": w.lotOld.String(), "quantity": 1, "unitPrice": 12},
				{"jarSizeId": w.jarSizeID.String(), "quantity": 1, "unitPrice": 12},
			},
		}))
	if response.Code != http.StatusBadRequest {
		t.Fatalf("one lotless line among two = %d %v, want 400", response.Code, body)
	}
	if got := saleCount(t, server); got != 0 {
		t.Errorf("a refused sale left %d sale rows", got)
	}
}

func TestSaleJarLineRefusedWhenItsLotIsShortEvenIfAnotherLotHasPlenty(t *testing.T) {
	server := honeyTestServer(t)
	w := seedTwoLotWorld(t, server, 2, 20)

	response, body := call(t, server.honeyRecordSale, adminRequest(
		http.MethodPost, "/api/v1/sales", map[string]any{
			"date": time.Now().Format("2006-01-02"),
			"lines": []map[string]any{
				{"jarSizeId": w.jarSizeID.String(), "harvestLotId": w.lotOld.String(), "quantity": 3, "unitPrice": 12},
			},
		}))
	if response.Code < 400 || response.Code >= 500 {
		t.Fatalf("sale of 3 from a lot holding 2 = %d %v, want a 4xx", response.Code, body)
	}
	if message, _ := body["error"].(string); !strings.Contains(message, w.codeOld) {
		t.Errorf("refusal %q does not name lot %s", message, w.codeOld)
	}
	if got := saleCount(t, server); got != 0 {
		t.Errorf("a refused sale left %d sale rows", got)
	}
	// Nothing spilled into the other lot.
	shelf := shelfByLot(t, server, homeLocation(t, server), w.jarSizeID)
	if shelf[w.lotOld].OnHand != 2 || shelf[w.lotNew].OnHand != 20 {
		t.Errorf("home shelf after the refusal = old %d new %d, want 2 and 20",
			shelf[w.lotOld].OnHand, shelf[w.lotNew].OnHand)
	}

	// The same quantity from the lot that has plenty is fine.
	response, body = call(t, server.honeyRecordSale, adminRequest(
		http.MethodPost, "/api/v1/sales", map[string]any{
			"date": time.Now().Format("2006-01-02"),
			"lines": []map[string]any{
				{"jarSizeId": w.jarSizeID.String(), "harvestLotId": w.lotNew.String(), "quantity": 3, "unitPrice": 12},
			},
		}))
	if response.Code != http.StatusCreated {
		t.Fatalf("sale of 3 from the lot holding 20 = %d %v", response.Code, body)
	}
}

// A draft or pending sale reserves against its lot, and paying it re-links and
// applies the lines. The per-line pin must survive that: the paid sale draws
// from the lot it named, not from the oldest receipt.
func TestPendingSaleKeepsItsLotPinWhenPatchedToPaid(t *testing.T) {
	server := honeyTestServer(t)
	w := seedTwoLotWorld(t, server, 10, 10)

	// The line names the NEWER lot; a FIFO guess would pick the older one.
	response, body := call(t, server.honeyRecordSale, adminRequest(
		http.MethodPost, "/api/v1/sales", map[string]any{
			"date":        time.Now().Format("2006-01-02"),
			"orderStatus": "pending",
			"lines": []map[string]any{
				{"jarSizeId": w.jarSizeID.String(), "harvestLotId": w.lotNew.String(), "quantity": 4, "unitPrice": 12},
			},
		}))
	if response.Code != http.StatusCreated {
		t.Fatalf("pending sale = %d %v", response.Code, body)
	}
	saleID, _ := body["id"].(string)

	// Pending consumes nothing yet but reserves against the lot it named; the
	// shelf reads available stock, so the reservation shows on the newer lot
	// only.
	shelf := shelfByLot(t, server, homeLocation(t, server), w.jarSizeID)
	if shelf[w.lotOld].OnHand != 10 || shelf[w.lotNew].OnHand != 6 {
		t.Fatalf("home shelf while pending = old %d new %d, want 10 and 6",
			shelf[w.lotOld].OnHand, shelf[w.lotNew].OnHand)
	}

	response, body = call(t, server.honeyUpdateSale, adminRequest(
		http.MethodPatch, "/api/v1/sales/"+saleID, map[string]any{"orderStatus": "paid"},
		"id", saleID))
	if response.Code != http.StatusOK {
		t.Fatalf("pending -> paid = %d %v", response.Code, body)
	}

	shelf = shelfByLot(t, server, homeLocation(t, server), w.jarSizeID)
	if shelf[w.lotOld].OnHand != 10 || shelf[w.lotNew].OnHand != 6 {
		t.Errorf("home shelf after paying = old %d new %d, want 10 and 6 (the pin survived)",
			shelf[w.lotOld].OnHand, shelf[w.lotNew].OnHand)
	}
	stored := saleLotQuantities(t, server, saleID)
	if len(stored) != 1 || stored[w.lotNew] != 4 {
		t.Errorf("sale_items.harvest_lot_id after paying = %v, want new=4", stored)
	}
	var method string
	if err := server.pool.QueryRow(context.Background(), `
		SELECT COALESCE(details->'lot_allocation'->>'method', '')
		FROM inventory_operations
		WHERE source_type='sale' AND source_id=$1 AND kind='sale_consume'
		  AND NOT EXISTS (SELECT 1 FROM inventory_operations r
		                  WHERE r.reverses_operation_id = inventory_operations.id)`, saleID).
		Scan(&method); err != nil {
		t.Fatalf("read allocation method: %v", err)
	}
	if method != "recorded" {
		t.Errorf("allocation method after paying = %q, want recorded", method)
	}
}

func TestGiveAwayNeedsALotAndDrawsOnlyFromIt(t *testing.T) {
	server := honeyTestServer(t)
	w := seedTwoLotWorld(t, server, 3, 20)
	giveAway := func(line map[string]any) (int, map[string]any) {
		response, body := call(t, server.honeyRecordGiveAway, adminRequest(
			http.MethodPost, "/api/v1/honey/give-away", map[string]any{
				"date":  time.Now().Format("2006-01-02"),
				"lines": []map[string]any{line},
			}))
		return response.Code, body
	}

	t.Run("no lot is refused", func(t *testing.T) {
		code, body := giveAway(map[string]any{"jarSizeId": w.jarSizeID.String(), "quantity": 1})
		if code != http.StatusBadRequest {
			t.Fatalf("lotless give-away = %d %v, want 400", code, body)
		}
		shelf := shelfByLot(t, server, homeLocation(t, server), w.jarSizeID)
		if shelf[w.lotOld].OnHand != 3 || shelf[w.lotNew].OnHand != 20 {
			t.Errorf("a refused give-away moved stock: old %d new %d",
				shelf[w.lotOld].OnHand, shelf[w.lotNew].OnHand)
		}
	})

	t.Run("a lot draws only that lot", func(t *testing.T) {
		// The newer lot is named; the older lot holds the FIFO jars and must
		// not be touched.
		code, body := giveAway(map[string]any{
			"jarSizeId": w.jarSizeID.String(), "harvestLotId": w.lotNew.String(), "quantity": 5,
		})
		if code != http.StatusOK {
			t.Fatalf("give-away from the newer lot = %d %v", code, body)
		}
		shelf := shelfByLot(t, server, homeLocation(t, server), w.jarSizeID)
		if shelf[w.lotOld].OnHand != 3 || shelf[w.lotNew].OnHand != 15 {
			t.Errorf("home shelf after the give-away = old %d new %d, want 3 and 15",
				shelf[w.lotOld].OnHand, shelf[w.lotNew].OnHand)
		}
		var method string
		if err := server.pool.QueryRow(context.Background(), `
			SELECT COALESCE(details->'lot_allocation'->>'method', '')
			FROM inventory_operations WHERE source_type='honey_give_away'
			ORDER BY created_at DESC LIMIT 1`).Scan(&method); err != nil {
			t.Fatalf("read give-away allocation method: %v", err)
		} else if method != "recorded" {
			t.Errorf("give-away allocation method = %q, want recorded", method)
		}
	})

	t.Run("over-asking a lot names it", func(t *testing.T) {
		// 15 pints remain in the newer lot and only 3 in the older one; asking
		// the older lot for 5 must not borrow from the newer one.
		code, body := giveAway(map[string]any{
			"jarSizeId": w.jarSizeID.String(), "harvestLotId": w.lotOld.String(), "quantity": 5,
		})
		if code != http.StatusBadRequest {
			t.Fatalf("over-asking the older lot = %d %v, want 400", code, body)
		}
		want := "Not enough Pint of " + w.codeOld + ": need 5, have 3"
		if message, _ := body["error"].(string); !strings.Contains(message, want) {
			t.Errorf("refusal %q does not contain %q", message, want)
		}
		shelf := shelfByLot(t, server, homeLocation(t, server), w.jarSizeID)
		if shelf[w.lotOld].OnHand != 3 || shelf[w.lotNew].OnHand != 15 {
			t.Errorf("a refused give-away moved stock: old %d new %d",
				shelf[w.lotOld].OnHand, shelf[w.lotNew].OnHand)
		}
	})
}

// Profitability credits each line to the lot it drew from, so a sale spanning
// two lots splits its revenue (net of the discount) between them instead of
// landing on one lot or on "Unassigned".
func TestProfitabilityCreditsEachLineToItsLot(t *testing.T) {
	server := honeyTestServer(t)
	w := seedTwoLotWorld(t, server, 10, 10)
	response, body := call(t, server.honeyRecordSale, adminRequest(
		http.MethodPost, "/api/v1/sales", map[string]any{
			"date":           time.Now().Format("2006-01-02"),
			"discountAmount": 4,
			"lines": []map[string]any{
				{"jarSizeId": w.jarSizeID.String(), "harvestLotId": w.lotOld.String(), "quantity": 1, "unitPrice": 10},
				{"jarSizeId": w.jarSizeID.String(), "harvestLotId": w.lotNew.String(), "quantity": 3, "unitPrice": 10},
			},
		}))
	if response.Code != http.StatusCreated {
		t.Fatalf("sale = %d %v", response.Code, body)
	}
	response, body = call(t, server.profitabilityAnalytics, adminRequest(http.MethodGet,
		"/api/v1/analytics/profitability?year="+strconv.Itoa(time.Now().Year()), nil))
	if response.Code != http.StatusOK {
		t.Fatalf("profitability = %d %v", response.Code, body)
	}
	revenue := map[string]float64{}
	lots, _ := body["byHarvestLot"].([]any)
	for _, raw := range lots {
		lot := raw.(map[string]any)
		revenue[lot["lotCode"].(string)] = lot["revenue"].(float64)
	}
	// $40 of lines less a $4 discount: the old lot's quarter is $9, the new $27.
	if revenue[w.codeOld] != 9 || revenue[w.codeNew] != 27 {
		t.Errorf("lot revenue = old %v new %v, want 9 and 27 (%v)", revenue[w.codeOld], revenue[w.codeNew], revenue)
	}
}
