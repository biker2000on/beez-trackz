package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
	"golang.org/x/crypto/bcrypt"

	"github.com/biker2000on/beez-trackz/backend/internal/app"
	"github.com/biker2000on/beez-trackz/backend/internal/app/equipment"
	inventoryledger "github.com/biker2000on/beez-trackz/backend/internal/app/inventory"
	inventorybuild "github.com/biker2000on/beez-trackz/backend/internal/app/inventory/build"
	"github.com/biker2000on/beez-trackz/backend/internal/app/production"
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
//
// 00015 added hives/feedings/equipment_*.sale_id → sales. TRUNCATE sales
// CASCADE follows that graph and would wipe hives (TRUNCATE ignores ON
// DELETE SET NULL). Null the links first so the honey reset stays local.
//
// inventory_locations references wholesale_price_lists, so TRUNCATE ... CASCADE
// would take the two seeded locations (home, deployed) with it. The price
// lists are DELETEd instead, so migration 00050's seeds survive every reset.
func resetHoneyTables(t *testing.T, pool *pgxpool.Pool) {
	t.Helper()
	// The ledger is cleared too, and in FK order: movements before operations,
	// lots before the items they belong to. The seeded singletons (honey_bulk,
	// propolis_raw) and the seeded locations carry no source and stay, exactly
	// as a fresh migration leaves them.
	const reset = `
		UPDATE hives SET sale_id = NULL WHERE sale_id IS NOT NULL;
		UPDATE feedings SET sale_id = NULL WHERE sale_id IS NOT NULL;
		UPDATE equipment_stock_adjustments SET sale_id = NULL WHERE sale_id IS NOT NULL;
		UPDATE equipment_deployment_returns SET sale_id = NULL WHERE sale_id IS NOT NULL;
		UPDATE inventory_locations SET wholesale_price_list_id = NULL WHERE wholesale_price_list_id IS NOT NULL;
		UPDATE inventory_locations SET customer_id = NULL WHERE customer_id IS NOT NULL;
		DELETE FROM wholesale_price_list_items;
		DELETE FROM wholesale_price_lists;
		TRUNCATE harvest_session_true_ups, jar_serials, sale_items, sales,
			product_batch_expenses, product_batches, propolis_harvests, product_catalog,
			honey_movements, bottling_runs, harvest_lot_photos, harvest_lot_harvests,
			harvest_lots,
			honey_harvests, harvest_sessions, jar_sizes, expenses,
			external_sync, offline_mutation_receipts
		RESTART IDENTITY CASCADE;
		-- customers is deleted, not truncated: inventory_locations.customer_id
		-- (00056/00003) references it and TRUNCATE ... CASCADE would take the
		-- seeded home and deployed locations with it.
		DELETE FROM customers;
		DELETE FROM inventory_balance_checkpoints;
		DELETE FROM inventory_movements;
		DELETE FROM inventory_operations;
		DELETE FROM inventory_lots;
		DELETE FROM inventory_bom_lines;
		DELETE FROM inventory_boms;
		UPDATE equipment_types SET item_id = NULL WHERE item_id IS NOT NULL;
		DELETE FROM inventory_items WHERE source_type IS NOT NULL;
		DELETE FROM consignment_settlements;
		DELETE FROM inventory_locations WHERE source_type IS NOT NULL OR kind = 'consignee'`
	var err error
	for attempt := 0; attempt < 8; attempt++ {
		_, err = pool.Exec(context.Background(), reset)
		if err == nil {
			return
		}
		var pgErr *pgconn.PgError
		if !errors.As(err, &pgErr) || (pgErr.Code != "40P01" && pgErr.Code != "40001") {
			t.Fatalf("reset honey tables: %v", err)
		}
		time.Sleep(time.Duration(50*(attempt+1)) * time.Millisecond)
	}
	t.Fatalf("reset honey tables: %v", err)
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

// --- ledger assertions ---
//
// The legacy quantity tables (honey_movements, stock_movements,
// product_adjustments) are no longer written: every quantity is an
// inventory_operations row with its inventory_movements lines. These helpers
// are the vocabulary the rewritten assertions use, so a test says "one
// count_adjust operation moved -3 of this jar size" rather than reaching into
// the ledger schema by hand.

// operationIDsForSource lists the live operations a source row produced,
// oldest first. Reversals are excluded: they are their own operations and are
// found through reversalOf.
func operationIDsForSource(
	t *testing.T, server *Server, sourceType string, sourceID uuid.UUID,
) []uuid.UUID {
	t.Helper()
	rows, err := server.pool.Query(context.Background(), `
		SELECT id FROM inventory_operations
		WHERE source_type=$1 AND source_id=$2 AND reverses_operation_id IS NULL
		ORDER BY occurred_at, created_at, id`, sourceType, sourceID)
	if err != nil {
		t.Fatalf("operations for %s %s: %v", sourceType, sourceID, err)
	}
	defer rows.Close()
	var ids []uuid.UUID
	for rows.Next() {
		var id uuid.UUID
		if err := rows.Scan(&id); err != nil {
			t.Fatalf("scan operation id: %v", err)
		}
		ids = append(ids, id)
	}
	if err := rows.Err(); err != nil {
		t.Fatalf("operations for %s %s: %v", sourceType, sourceID, err)
	}
	return ids
}

// operationsOfKind counts live (unreversed, non-reversal) operations of a kind.
func operationsOfKind(t *testing.T, server *Server, kind string) int {
	t.Helper()
	var count int
	if err := server.pool.QueryRow(context.Background(), `
		SELECT COUNT(*) FROM inventory_operations o
		WHERE o.kind=$1 AND o.reverses_operation_id IS NULL
		  AND NOT EXISTS (SELECT 1 FROM inventory_operations r
		                  WHERE r.reverses_operation_id = o.id)`, kind).Scan(&count); err != nil {
		t.Fatalf("count %s operations: %v", kind, err)
	}
	return count
}

// latestOperationOfKind returns the newest live operation of a kind. It fails
// the test when there is none, because every caller is asserting that the
// handler recorded one.
func latestOperationOfKind(t *testing.T, server *Server, kind string) uuid.UUID {
	t.Helper()
	var id uuid.UUID
	if err := server.pool.QueryRow(context.Background(), `
		SELECT o.id FROM inventory_operations o
		WHERE o.kind=$1 AND o.reverses_operation_id IS NULL
		ORDER BY o.occurred_at DESC, o.created_at DESC, o.id DESC
		LIMIT 1`, kind).Scan(&id); err != nil {
		t.Fatalf("latest %s operation: %v", kind, err)
	}
	return id
}

// reversalOf returns the operation that reverses opID, or uuid.Nil when the
// operation still stands.
func reversalOf(t *testing.T, server *Server, opID uuid.UUID) uuid.UUID {
	t.Helper()
	var id uuid.UUID
	err := server.pool.QueryRow(context.Background(),
		`SELECT id FROM inventory_operations WHERE reverses_operation_id=$1`, opID).Scan(&id)
	if errors.Is(err, pgx.ErrNoRows) {
		return uuid.Nil
	}
	if err != nil {
		t.Fatalf("reversal of %s: %v", opID, err)
	}
	return id
}

// operationActor is the app user credited with an operation.
func operationActor(t *testing.T, server *Server, opID uuid.UUID) *uuid.UUID {
	t.Helper()
	var actor *uuid.UUID
	if err := server.pool.QueryRow(context.Background(),
		`SELECT created_by FROM inventory_operations WHERE id=$1`, opID).Scan(&actor); err != nil {
		t.Fatalf("actor of %s: %v", opID, err)
	}
	return actor
}

// operationItemQuantity sums an operation's movement lines for one item, over
// every location and lot. It is the ledger's answer to "what did this
// movement row say".
func operationItemQuantity(
	t *testing.T, server *Server, opID, itemID uuid.UUID,
) float64 {
	t.Helper()
	var total float64
	if err := server.pool.QueryRow(context.Background(), `
		SELECT COALESCE(SUM(quantity), 0)::float8 FROM inventory_movements
		WHERE operation_id=$1 AND item_id=$2`, opID, itemID).Scan(&total); err != nil {
		t.Fatalf("quantity of %s: %v", opID, err)
	}
	return total
}

// jarItemID is the inventory item a jar size maps to. It fails when the size
// has never been through a command, which is itself the bug worth reporting.
func jarItemID(t *testing.T, server *Server, jarSizeID uuid.UUID) uuid.UUID {
	t.Helper()
	var itemID *uuid.UUID
	if err := server.pool.QueryRow(context.Background(),
		`SELECT item_id FROM jar_sizes WHERE id=$1`, jarSizeID).Scan(&itemID); err != nil {
		t.Fatalf("jar item for %s: %v", jarSizeID, err)
	}
	if itemID == nil {
		t.Fatalf("jar size %s has no inventory item", jarSizeID)
	}
	return *itemID
}

// productItemID is jarItemID for a product_catalog SKU.
func productItemID(t *testing.T, server *Server, productID uuid.UUID) uuid.UUID {
	t.Helper()
	var itemID *uuid.UUID
	if err := server.pool.QueryRow(context.Background(),
		`SELECT item_id FROM product_catalog WHERE id=$1`, productID).Scan(&itemID); err != nil {
		t.Fatalf("product item for %s: %v", productID, err)
	}
	if itemID == nil {
		t.Fatalf("product %s has no inventory item", productID)
	}
	return *itemID
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

// seedLot creates a harvest lot big enough to jar against, and books its
// ceiling into the ledger.
//
// The receipt is not optional decoration: since decision 6 a lot's weight IS
// a receive into its bulk-honey lot, so a lot row inserted on its own holds
// no pounds and every draw against it is refused. Creating the lot through
// POST /harvest-lots does the same thing; this fixture takes the short path.
func seedLot(t *testing.T, server *Server, weightLbs float64) uuid.UUID {
	t.Helper()
	var lotID uuid.UUID
	code := "LOT-" + uuid.NewString()[:8]
	ctx := context.Background()
	err := app.NewRunner(server.pool).Run(ctx, app.UserActor(testUserID, "Test Admin"),
		func(ctx context.Context, uow *app.UnitOfWork) error {
			if err := uow.QueryRow(ctx, `
				INSERT INTO harvest_lots (lot_code, public_slug, extraction_date, honey_weight_lbs)
				VALUES ($1, $2, CURRENT_DATE, $3) RETURNING id`,
				code, "slug-"+code, weightLbs).Scan(&lotID); err != nil {
				return err
			}
			return production.New().SetLotCeiling(ctx, uow, lotID, weightLbs, time.Now().UTC())
		})
	if err != nil {
		t.Fatalf("seed lot: %v", err)
	}
	return lotID
}

// jarStock fills jars out of a lot that holds everything seedHarvest
// extracted.
//
// The lot's weight is not arbitrary: since decision 6 a lot's pounds ARE the
// bulk-honey receipt, so a fixture lot bigger than the harvest would show up
// as bulk on hand the harvest never produced. Sizing the lot to the seeded
// harvests keeps "harvested minus jarred" true, which is what the overview
// and production-plan tests read.
func jarStock(t *testing.T, server *Server, jarSizeID uuid.UUID, quantity int) {
	t.Helper()
	var needed float64
	if err := server.pool.QueryRow(context.Background(),
		`SELECT COALESCE((SELECT honey_oz FROM jar_sizes WHERE id=$1), 16) * $2 / 16.0`,
		jarSizeID, quantity).Scan(&needed); err != nil {
		t.Fatalf("size fixture lot: %v", err)
	}
	jarStockFromLot(t, server, seedFixtureLot(t, server, needed), jarSizeID, quantity)
}

// seedFixtureLot creates the lot a fixture draws its honey from, sized to the
// harvests the test already seeded (or to what the caller needs, whichever is
// larger).
//
// The sizing is the point: since decision 6 a lot's pounds ARE the bulk-honey
// receipt, so an arbitrarily large fixture lot would report bulk honey the
// harvests never produced, and the overview, production plan and true-up
// guards would all read a number with nothing behind it.
func seedFixtureLot(t *testing.T, server *Server, minimumLbs float64) uuid.UUID {
	t.Helper()
	var harvested float64
	if err := server.pool.QueryRow(context.Background(),
		`SELECT COALESCE(SUM(calculated_honey_weight), 0) FROM honey_harvests
		 WHERE deleted_at IS NULL`).Scan(&harvested); err != nil {
		t.Fatalf("size fixture lot: %v", err)
	}
	weight := harvested
	if minimumLbs > weight {
		weight = minimumLbs
	}
	return seedLot(t, server, weight)
}

func jarStockFromLot(
	t *testing.T, server *Server, lotID, jarSizeID uuid.UUID, quantity int,
) {
	t.Helper()
	response, body := call(t, server.honeyRecordJarring, adminRequest(
		http.MethodPost, "/api/v1/honey/jarring", map[string]any{
			"date":  time.Now().Format("2006-01-02"),
			"lotId": lotID.String(),
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
		http.MethodPost, "/api/v1/sales", map[string]any{
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
		FROM sales s JOIN sale_items i ON i.sale_id=s.id`).
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
	server.honeyListSalesHandler(listResponse, adminRequest(http.MethodGet, "/api/v1/sales", nil))
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

func TestHoneyInventoryClassifiesBackfilledHistoryByLedgerSemantics(t *testing.T) {
	server := honeyTestServer(t)
	ctx := context.Background()
	pintID := seedJarSize(t, server, "Pint", 16, 1200)
	quartID := seedJarSize(t, server, "Quart", 32, 2000)
	seedHarvest(t, server, 20)
	harvestLotID := seedFixtureLot(t, server, 20)

	// Reproduce the three shapes emitted by the legacy translator: jarring is
	// a transform sourced by honey_movement, a draw-before-receipt injection is
	// an opening balance, and its cleanup is a legacy_reconcile count adjust.
	err := app.NewRunner(server.pool).Run(ctx, app.UserActor(testUserID, "Test Admin"),
		func(ctx context.Context, uow *app.UnitOfWork) error {
			home, err := production.HomeLocationID(ctx, uow)
			if err != nil {
				return err
			}
			jarItem, err := production.EnsureJarItem(ctx, uow, pintID)
			if err != nil {
				return err
			}
			bulkLot, err := production.EnsureHarvestLot(ctx, uow, harvestLotID)
			if err != nil {
				return err
			}
			jarLot, err := production.EnsureJarLotForHarvestLot(ctx, uow, jarItem, harvestLotID)
			if err != nil {
				return err
			}
			unassigned, err := production.LegacyUnassignedLot(ctx, uow, jarItem)
			if err != nil {
				return err
			}

			ledger := inventoryledger.NewService()
			at := time.Date(2026, time.September, 1, 12, 0, 0, 0, time.UTC)
			movementID := uuid.New()
			legacyType := "honey_movement"
			transform, err := inventorybuild.Transform(inventorybuild.TransformParams{
				Base: inventorybuild.Base{
					ID: movementID, OccurredAt: at,
					IdempotencyKey: "test:legacy-honey-movement:" + movementID.String(),
					SourceType:     "honey_movement", SourceID: movementID,
					Reason: production.ReasonNone, Actor: uow.Actor(), Provenance: "legacy-import",
					LegacyRefType: &legacyType, LegacyRefID: &movementID,
				},
				Inputs: []inventoryledger.Movement{{
					Tuple: inventoryledger.Tuple{
						ItemID: production.HoneyBulkItemID, LocationID: home, LotID: &bulkLot,
					},
					Quantity: production.Negate(production.Pounds(10)), QuantityScale: production.MassScale,
				}},
				Outputs: []inventoryledger.Movement{{
					Tuple:    inventoryledger.Tuple{ItemID: jarItem, LocationID: home, LotID: &jarLot},
					Quantity: production.Quantity(10), QuantityScale: production.CountScale,
				}},
			})
			if err != nil {
				return err
			}
			if _, err = ledger.Record(ctx, uow, transform); err != nil {
				return err
			}

			openingID := uuid.New()
			opening, err := inventorybuild.OpeningBalance(inventorybuild.SingleParams{
				Base: inventorybuild.Base{
					ID: openingID, OccurredAt: at.Add(time.Minute),
					IdempotencyKey: "test:legacy-draw-before-receipt:" + openingID.String(),
					SourceType:     "legacy_draw_before_receipt", SourceID: openingID,
					Reason: production.ReasonNone, Actor: uow.Actor(), Provenance: "legacy-import",
					Details: map[string]any{"reason": "draw-before-receipt"},
				},
				Line: inventoryledger.Movement{
					Tuple:    inventoryledger.Tuple{ItemID: jarItem, LocationID: home, LotID: &unassigned},
					Quantity: production.Quantity(3), QuantityScale: production.CountScale,
				},
			})
			if err != nil {
				return err
			}
			if _, err = ledger.Record(ctx, uow, opening); err != nil {
				return err
			}

			reconcileID := uuid.New()
			reconcile, err := inventorybuild.CountAdjust(inventorybuild.SingleParams{
				Base: inventorybuild.Base{
					ID: reconcileID, OccurredAt: at.Add(2 * time.Minute),
					IdempotencyKey: "test:legacy-reconcile:" + reconcileID.String(),
					SourceType:     "legacy_reconcile", SourceID: jarItem,
					Reason: production.ReasonCount, Actor: uow.Actor(), Provenance: "legacy-import",
					Details: map[string]any{"reason": "draw-before-receipt-reconcile"},
				},
				Line: inventoryledger.Movement{
					Tuple:    inventoryledger.Tuple{ItemID: jarItem, LocationID: home, LotID: &unassigned},
					Quantity: production.Negate(production.Quantity(2)), QuantityScale: production.CountScale,
				},
			})
			if err != nil {
				return err
			}
			_, err = ledger.Record(ctx, uow, reconcile)
			return err
		})
	if err != nil {
		t.Fatalf("record legacy-shaped history: %v", err)
	}

	response, body := call(t, server.honeyRecordGiveAway, adminRequest(
		http.MethodPost, "/api/v1/honey/give-away", map[string]any{
			"date": time.Now().Format("2006-01-02"),
			"lines": []map[string]any{{
				"jarSizeId": pintID.String(), "quantity": 1,
			}},
		}))
	if response.Code != http.StatusOK {
		t.Fatalf("record give-away = %d %v", response.Code, body)
	}
	response, body = call(t, server.honeyRecordSale, adminRequest(
		http.MethodPost, "/api/v1/sales", map[string]any{
			"date": time.Now().Format("2006-01-02"),
			"lines": []map[string]any{{
				"jarSizeId": pintID.String(), "quantity": 4, "unitPrice": 12,
			}},
		}))
	if response.Code != http.StatusCreated {
		t.Fatalf("record sale = %d %v", response.Code, body)
	}

	rows := mustJarInventory(t, server)
	tests := []struct {
		id                                      uuid.UUID
		label                                   string
		jarred, sold, givenAway, adjusted, hand int
	}{
		{id: pintID, label: "Pint", jarred: 10, sold: 4, givenAway: 1, adjusted: 1, hand: 6},
		{id: quartID, label: "Quart"},
	}
	byID := make(map[uuid.UUID]honeyInventoryRow, len(rows))
	for _, row := range rows {
		byID[row.JarSizeID] = row
		if row.OnHand != row.Jarred+row.Adjusted-row.Sold-row.GivenAway {
			t.Errorf("%s identity: onHand=%d, jarred=%d adjusted=%d sold=%d givenAway=%d",
				row.Label, row.OnHand, row.Jarred, row.Adjusted, row.Sold, row.GivenAway)
		}
	}
	for _, test := range tests {
		row, ok := byID[test.id]
		if !ok {
			t.Errorf("%s was not returned", test.label)
			continue
		}
		if row.Jarred != test.jarred || row.Sold != test.sold ||
			row.GivenAway != test.givenAway || row.Adjusted != test.adjusted ||
			row.OnHand != test.hand {
			t.Errorf("%s breakdown = jarred %d sold %d givenAway %d adjusted %d onHand %d; want %d/%d/%d/%d/%d",
				test.label, row.Jarred, row.Sold, row.GivenAway, row.Adjusted, row.OnHand,
				test.jarred, test.sold, test.givenAway, test.adjusted, test.hand)
		}
	}

	bulk, err := honeyBulkOnHand(ctx, server.pool)
	if err != nil {
		t.Fatalf("bulk totals: %v", err)
	}
	if bulk.JarredLbs != 10 || bulk.BulkUsedLbs != 0 {
		t.Errorf("legacy transform bulk classification = jarred %.1f used %.1f, want 10/0",
			bulk.JarredLbs, bulk.BulkUsedLbs)
	}
}

// --- reversing entries instead of hard deletes ---

func TestDeleteMovementWritesReversingEntry(t *testing.T) {
	server := honeyTestServer(t)
	jarSizeID := seedJarSize(t, server, "Pint", 16, 1200)
	seedHarvest(t, server, 100)
	jarStock(t, server, jarSizeID, 12)

	// Jarring is always part of a bottling run now and is undone by voiding
	// that run, so the standalone reversal path is exercised with a jar
	// adjustment — the same negation rules apply to both.
	response, body := call(t, server.honeyAdjustJarCounts, adminRequest(
		http.MethodPost, "/api/v1/honey/jar-adjustments", map[string]any{
			"date":   time.Now().Format("2006-01-02"),
			"reason": "recount",
			"lines":  []map[string]any{{"jarSizeId": jarSizeID.String(), "delta": 3}},
		}))
	if response.Code != http.StatusOK {
		t.Fatalf("seed adjustment = %d %v", response.Code, body)
	}
	movementID := latestOperationOfKind(t, server, "count_adjust")

	response, body = call(t, server.honeyReverseMovement, adminRequest(
		http.MethodDelete, "/api/v1/honey/movements/"+movementID.String(),
		map[string]any{"reason": "miscount"}, "id", movementID.String()))
	if response.Code != http.StatusOK {
		t.Fatalf("reverse movement = %d %v", response.Code, body)
	}
	if body["success"] != true || body["reversalMovementId"] == nil {
		t.Fatalf("unexpected reversal response: %v", body)
	}

	// The original operation survives — the ledger is append-only — and the
	// reversal is a separate operation whose lines negate it.
	itemID := jarItemID(t, server, jarSizeID)
	var originalCount int
	if err := server.pool.QueryRow(context.Background(),
		`SELECT COUNT(*) FROM inventory_operations WHERE id=$1`, movementID).
		Scan(&originalCount); err != nil {
		t.Fatalf("inspect original: %v", err)
	}
	if originalCount != 1 {
		t.Error("the original operation was destroyed")
	}
	if got := operationItemQuantity(t, server, movementID, itemID); got != 3 {
		t.Errorf("original quantity = %v, want 3", got)
	}
	reversalID := reversalOf(t, server, movementID)
	if reversalID == uuid.Nil {
		t.Fatal("no reversing operation was written")
	}
	if got := operationItemQuantity(t, server, reversalID, itemID); got != -3 {
		t.Errorf("reversal quantity = %v, want -3", got)
	}
	if reversalActor := operationActor(t, server, reversalID); reversalActor == nil ||
		*reversalActor != testUserID {
		t.Errorf("reversal actor = %v, want %v", reversalActor, testUserID)
	}

	// The reversed adjustment leaves the 12 jarred units untouched.
	inventory, err := server.honeyJarInventory(context.Background())
	if err != nil {
		t.Fatalf("inventory: %v", err)
	}
	for _, row := range inventory {
		if row.JarSizeID == jarSizeID && row.OnHand != 12 {
			t.Errorf("on hand after reversal = %d, want 12", row.OnHand)
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
		http.MethodPost, "/api/v1/sales", map[string]any{
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
		http.MethodDelete, "/api/v1/sales/"+saleID,
		map[string]any{"reason": "customer changed their mind"}, "id", saleID))
	if response.Code != http.StatusOK || body["success"] != true {
		t.Fatalf("cancel sale = %d %v", response.Code, body)
	}

	var status string
	var cancelledBy *uuid.UUID
	var reason *string
	if err := server.pool.QueryRow(context.Background(),
		`SELECT order_status, cancelled_by, cancellation_reason FROM sales WHERE id=$1`,
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
		http.MethodPost, "/api/v1/sales", map[string]any{
			"date":        time.Now().Format("2006-01-02"),
			"orderStatus": "pending",
			"lines": []map[string]any{
				{"jarSizeId": jarSizeID.String(), "quantity": 2, "unitPrice": 12},
			},
		}))
	saleID, _ := saleBody["id"].(string)

	response, body := call(t, server.honeyUpdateSale, adminRequest(
		http.MethodPatch, "/api/v1/sales/"+saleID,
		map[string]any{"orderStatus": "cancelled"}, "id", saleID))
	if response.Code != http.StatusOK {
		t.Fatalf("PATCH to cancelled = %d %v", response.Code, body)
	}
	var status string
	if err := server.pool.QueryRow(context.Background(),
		`SELECT order_status FROM sales WHERE id=$1`, saleID).Scan(&status); err != nil {
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
		http.MethodPost, "/api/v1/sales", map[string]any{
			"date":  time.Now().Format("2006-01-02"),
			"lines": []map[string]any{{"jarSizeId": jarSizeID.String(), "quantity": 2, "unitPrice": 10}},
		}))
	call(t, server.honeyRecordSale, adminRequest(
		http.MethodPost, "/api/v1/sales", map[string]any{
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
	bookLotCeiling(t, server, lotID)

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
	// The run is the operation's source: one transform, bulk honey in and
	// jars out, rather than a pair of honey_movements rows pointing back at
	// the run by id.
	runUUID, err := uuid.Parse(runID)
	if err != nil {
		t.Fatalf("bottling run id %q: %v", runID, err)
	}
	linked := operationIDsForSource(t, server, "bottling_run", runUUID)
	if len(linked) != 1 {
		t.Fatalf("operations for the run = %d, want 1", len(linked))
	}
	if got := operationItemQuantity(t, server, linked[0], jarItemID(t, server, jarSizeID)); got != 10 {
		t.Errorf("jars produced by the run = %v, want 10", got)
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
	// The write-off is a visible count_adjust operation, not a silent
	// disappearance from the on-hand query.
	writeOffID := latestOperationOfKind(t, server, "count_adjust")
	if got := operationItemQuantity(t, server, writeOffID, jarItemID(t, server, jarSizeID)); got != -7 {
		t.Errorf("write-off quantity = %v, want -7", got)
	}
	var reason string
	if err := server.pool.QueryRow(context.Background(),
		`SELECT reason FROM inventory_operations WHERE id=$1`, writeOffID).Scan(&reason); err != nil {
		t.Fatalf("read write-off reason: %v", err)
	}
	if reason != "count" {
		t.Errorf("write-off reason = %q, want %q", reason, "count")
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

	// Amended with the inventory ledger: a count correction can no longer
	// drive a jar size below zero. The old honey_movements ledger let a
	// jar_adjustment go anywhere, which is how a miscount could quietly
	// invent negative stock; the ledger's nonnegative invariant refuses it
	// and names how many are actually on hand. Correcting past that point
	// needs a receipt first.
	t.Run("jar adjustment cannot go below zero", func(t *testing.T) {
		response, body := call(t, server.honeyAdjustJarCounts, adminRequest(
			http.MethodPost, "/api/v1/honey/jar-adjustments", map[string]any{
				"date":  time.Now().Format("2006-01-02"),
				"lines": []map[string]any{{"jarSizeId": jarSizeID.String(), "delta": -50}},
			}))
		if response.Code != http.StatusBadRequest {
			t.Fatalf("over-large jar_adjustment = %d %v, want 400", response.Code, body)
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

	if adjustments := operationsOfKind(t, server, "count_adjust"); adjustments != 1 {
		t.Errorf("replaying the mutation wrote %d ledger operations, want 1", adjustments)
	}
}

func TestOfflineSaleReceiptIsTransactionalAndReplaysIdentically(t *testing.T) {
	server := honeyTestServer(t)
	jarSizeID := seedJarSize(t, server, "Offline sale pint", 16, 1200)
	seedHarvest(t, server, 100)
	jarStock(t, server, jarSizeID, 10)
	mutationID := uuid.New().String()
	handler := server.offlineMutations(http.HandlerFunc(server.honeyRecordSale))

	send := func(quantity int) *httptest.ResponseRecorder {
		request := adminRequest(http.MethodPost, "/api/v1/sales", map[string]any{
			"date": time.Now().Format("2006-01-02"),
			"lines": []map[string]any{{
				"jarSizeId": jarSizeID.String(), "quantity": quantity, "unitPrice": 12,
			}},
		})
		request.Header.Set("X-Offline-Mutation-ID", mutationID)
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, request)
		return response
	}

	first := send(2)
	if first.Code != http.StatusCreated {
		t.Fatalf("first sale = %d %s", first.Code, first.Body.String())
	}
	second := send(2)
	if second.Code != http.StatusCreated || second.Header().Get("X-Offline-Replayed") != "true" {
		t.Fatalf("replay = %d headers=%v body=%s", second.Code, second.Header(), second.Body.String())
	}
	if first.Body.String() != second.Body.String() {
		t.Fatalf("replay body differs:\nfirst %s\nsecond %s", first.Body.String(), second.Body.String())
	}
	var decoded struct {
		ID uuid.UUID `json:"id"`
	}
	if err := json.Unmarshal(first.Body.Bytes(), &decoded); err != nil {
		t.Fatalf("decode first result: %v", err)
	}
	saleID := decoded.ID
	var sales, receipts int
	if err := server.pool.QueryRow(context.Background(), `SELECT COUNT(*) FROM sales WHERE id=$1`, saleID).Scan(&sales); err != nil {
		t.Fatal(err)
	}
	if err := server.pool.QueryRow(context.Background(), `
		SELECT COUNT(*) FROM offline_mutation_receipts
		WHERE mutation_id=$1 AND state='complete'`, mutationID).Scan(&receipts); err != nil {
		t.Fatal(err)
	}
	if sales != 1 || receipts != 1 {
		t.Fatalf("sales=%d complete receipts=%d, want one of each", sales, receipts)
	}
	if mismatch := send(3); mismatch.Code != http.StatusConflict {
		t.Fatalf("payload mismatch = %d %s, want 409", mismatch.Code, mismatch.Body.String())
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
		http.MethodPost, "/api/v1/sales", map[string]any{
			"date": time.Now().Format("2006-01-02"),
			"lines": []map[string]any{
				{"jarSizeId": jarSizeID.String(), "quantity": 10, "unitPrice": 12},
			},
		}))
	if response.Code != http.StatusCreated {
		t.Fatalf("record sale = %d %v", response.Code, body)
	}

	// Jarring is a transform sourced on the bottling run, so the run id and
	// the operation id come from the same row.
	var movementID, runID uuid.UUID
	if err := server.pool.QueryRow(context.Background(),
		`SELECT id, source_id FROM inventory_operations
		 WHERE source_type='bottling_run' AND reverses_operation_id IS NULL`).
		Scan(&movementID, &runID); err != nil {
		t.Fatalf("read bottling operation: %v", err)
	}
	// A run-linked jarring is never reversed on its own.
	response, body = call(t, server.honeyReverseMovement, adminRequest(
		http.MethodDelete, "/api/v1/honey/movements/"+movementID.String(), nil,
		"id", movementID.String()))
	if response.Code != http.StatusConflict {
		t.Fatalf("reversing a run-linked jarring = %d %v, want 409", response.Code, body)
	}
	// Voiding the run is the supported undo, and it still refuses to pull
	// jars that have already been sold off the shelf.
	response, body = call(t, server.bottlingRunVoid, adminRequest(
		http.MethodPost, "/api/v1/bottling-runs/"+runID.String()+"/void",
		map[string]any{"reason": "miscount"}, "id", runID.String()))
	if response.Code != http.StatusConflict {
		t.Fatalf("voiding a sold-out run = %d %v, want 409", response.Code, body)
	}

	if reversalOf(t, server, movementID) != uuid.Nil {
		t.Errorf("a reversing operation was written despite the shortfall")
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

	movementID := latestOperationOfKind(t, server, "transform")
	response, body = call(t, server.honeyReverseMovement, adminRequest(
		http.MethodDelete, "/api/v1/honey/movements/"+movementID.String(), nil,
		"id", movementID.String()))
	if response.Code != http.StatusConflict {
		t.Fatalf("reversing a run-linked movement = %d %v, want 409", response.Code, body)
	}
}

// The counterpart to the refusal above: a run-linked movement cannot be
// reversed alone, but voiding the run reverses it, drops the serials, and
// frees the lot's capacity in one transaction.
func TestVoidBottlingRunReversesMovementsAndFreesLot(t *testing.T) {
	server := honeyTestServer(t)
	jarSizeID := seedJarSize(t, server, "Pint", 16, 1200)
	seedHarvest(t, server, 100)
	ctx := context.Background()

	response, body := call(t, server.harvestLotCreate, adminRequest(
		http.MethodPost, "/api/v1/harvest-lots", map[string]any{
			"lotCode":        "2026-VOID-01",
			"extractionDate": time.Now().Format("2006-01-02"),
			"honeyWeightLbs": 10,
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
			"serialize":   true,
		}, "id", lotID))
	if response.Code != http.StatusCreated {
		t.Fatalf("create bottling run = %d %v", response.Code, body)
	}
	runID, _ := body["id"].(string)

	// The lot is fully bottled: a second run has nowhere to draw from.
	response, body = call(t, server.bottlingRunCreate, adminRequest(
		http.MethodPost, "/api/v1/harvest-lots/"+lotID+"/bottling-runs", map[string]any{
			"bottledDate": time.Now().Format("2006-01-02"),
			"jarSizeId":   jarSizeID.String(),
			"quantity":    5,
		}, "id", lotID))
	if response.Code != http.StatusBadRequest {
		t.Fatalf("run over a fully bottled lot = %d %v, want 400", response.Code, body)
	}

	response, body = call(t, server.bottlingRunVoid, adminRequest(
		http.MethodPost, "/api/v1/bottling-runs/"+runID+"/void",
		map[string]any{"reason": "mislabelled jars"}, "id", runID))
	if response.Code != http.StatusOK {
		t.Fatalf("void run = %d %v", response.Code, body)
	}
	if body["reversedMovements"] != 1.0 {
		t.Errorf("reversedMovements = %v, want 1", body["reversedMovements"])
	}
	if body["removedSerials"] != 10.0 {
		t.Errorf("removedSerials = %v, want 10", body["removedSerials"])
	}

	// One reversing operation against the run's transform, negating the ten
	// jars it produced.
	runUUID, err := uuid.Parse(runID)
	if err != nil {
		t.Fatalf("bottling run id %q: %v", runID, err)
	}
	runOps := operationIDsForSource(t, server, "bottling_run", runUUID)
	if len(runOps) != 1 {
		t.Fatalf("operations for the run = %d, want 1", len(runOps))
	}
	reversalID := reversalOf(t, server, runOps[0])
	if reversalID == uuid.Nil {
		t.Fatal("voiding the run wrote no reversing operation")
	}
	if got := operationItemQuantity(t, server, reversalID, jarItemID(t, server, jarSizeID)); got != -10 {
		t.Errorf("reversed jars = %v, want -10", got)
	}
	var serials int
	if err := server.pool.QueryRow(ctx,
		`SELECT COUNT(*) FROM jar_serials WHERE bottling_run_id=$1`, runID).Scan(&serials); err != nil {
		t.Fatalf("read serials: %v", err)
	}
	if serials != 0 {
		t.Errorf("serials surviving a void = %d, want 0", serials)
	}

	// Voiding is not repeatable: a second call must not write a second
	// reversal for the same movement.
	response, body = call(t, server.bottlingRunVoid, adminRequest(
		http.MethodPost, "/api/v1/bottling-runs/"+runID+"/void", nil, "id", runID))
	if response.Code != http.StatusConflict {
		t.Fatalf("re-voiding = %d %v, want 409", response.Code, body)
	}

	// The lot's capacity came back with the pounds.
	response, body = call(t, server.bottlingRunCreate, adminRequest(
		http.MethodPost, "/api/v1/harvest-lots/"+lotID+"/bottling-runs", map[string]any{
			"bottledDate": time.Now().Format("2006-01-02"),
			"jarSizeId":   jarSizeID.String(),
			"quantity":    5,
		}, "id", lotID))
	if response.Code != http.StatusCreated {
		t.Fatalf("run after the void = %d %v, want 201", response.Code, body)
	}
}

// ASI-5-004, re-based on the lot ceilings (spec 12.1 open item 1).
//
// The old guard compared the declared weight against bulk on hand, which
// decision 6 made a different quantity: bulk on hand is the balance of the lot
// receipts, and jarring moves pounds out of it, so the comparison drifted away
// from what it was meant to protect. What a true-up must not do is take the
// harvest below the pounds the lots have already been given -- the spec 7.4
// residual -- and that is what this pins. A true-up of exactly 0 is still
// rejected outright, because the bulk formula treats a stored 0 as unset.
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

	// Every one of the session 100 lbs is committed: the fixture lot ceiling is
	// a 100 lb receipt, 90 lbs of which are already jars on the shelf.
	if response, body := trueUp(50); response.Code != http.StatusBadRequest {
		t.Errorf("true-up to 50 with 100 lbs in lots = %d %v, want 400", response.Code, body)
	}
	if response, body := trueUp(0); response.Code != http.StatusBadRequest {
		t.Errorf("true-up to 0 = %d %v, want 400 (formula treats 0 as unset)", response.Code, body)
	}
	// Five pounds short of the ceiling is still short: the lot would be
	// claiming 100 lbs out of a 95 lb harvest, which is the negative residual
	// spec 7.4 refuses to carry into the reset.
	response, body := trueUp(95)
	if response.Code != http.StatusBadRequest {
		t.Errorf("true-up to 95 against a 100 lb ceiling = %d %v, want 400", response.Code, body)
	}
	if message, _ := body["error"].(string); !strings.Contains(message, "allocated to harvest lots") {
		t.Errorf("refusal %q does not name the lot allocation", message)
	}
	// Trueing UP is never a withdrawal, so nothing about it can go negative.
	if response, body := trueUp(120); response.Code != http.StatusOK {
		t.Errorf("true-up to 120 = %d %v, want 200", response.Code, body)
	}
	// Nor is coming back down to exactly what the lots hold.
	if response, body := trueUp(100); response.Code != http.StatusOK {
		t.Errorf("true-up back to the committed 100 = %d %v, want 200", response.Code, body)
	}
	var stored float64
	if err := server.pool.QueryRow(ctx,
		`SELECT total_extracted_weight FROM harvest_sessions WHERE id=$1`, sessionID).
		Scan(&stored); err != nil {
		t.Fatalf("read session weight: %v", err)
	}
	if stored != 100 {
		t.Errorf("stored weight = %v, want 100 (the refused true-ups rolled back)", stored)
	}
}

// ASI-5-004 under the ledger: soft-deleting a harvest entry cannot leave a lot
// claiming pounds that nothing harvested (spec 12.1 open item 1).
//
// The pre-ledger guard compared the entry weight against bulk on hand. Since
// decision 6 an entry puts no pounds into the ledger at all -- the lot ceiling
// receipt does -- so that comparison could never fire again and the delete
// went through no matter what stood behind it. The guard is now the spec 7.4
// residual: an entry may not leave while the lots still hold what it measured.
func TestDeleteEntryCannotRemoveJarredPounds(t *testing.T) {
	server := honeyTestServer(t)
	jarSizeID := seedJarSize(t, server, "Pound", 16, 1200)
	seedHarvest(t, server, 100)
	jarStock(t, server, jarSizeID, 90)

	ctx := context.Background()
	before, err := honeyBulkOnHand(ctx, server.pool)
	if err != nil {
		t.Fatalf("bulk before delete: %v", err)
	}

	var entryID uuid.UUID
	if err := server.pool.QueryRow(ctx,
		`SELECT id FROM honey_harvests`).Scan(&entryID); err != nil {
		t.Fatalf("read entry: %v", err)
	}
	response, body := call(t, server.hsDeleteEntry, adminRequest(
		http.MethodDelete, "/api/v1/harvest-entries/"+entryID.String(), nil,
		"id", entryID.String()))
	if response.Code != http.StatusBadRequest {
		t.Fatalf("deleting the only harvest behind a 100 lb lot = %d %v, want 400",
			response.Code, body)
	}
	if message, _ := body["error"].(string); !strings.Contains(message, "allocated to harvest lots") {
		t.Errorf("refusal %q does not name the lot allocation", message)
	}

	// The refusal rolled the soft-delete back with it: nothing half-happened.
	var deletedAt *time.Time
	if err := server.pool.QueryRow(ctx,
		`SELECT deleted_at FROM honey_harvests WHERE id=$1`, entryID).Scan(&deletedAt); err != nil {
		t.Fatalf("read entry after the refusal: %v", err)
	}
	if deletedAt != nil {
		t.Error("the entry was soft-deleted even though the guard refused")
	}

	after, err := honeyBulkOnHand(ctx, server.pool)
	if err != nil {
		t.Fatalf("bulk after delete: %v", err)
	}
	if after.BulkOnHandLbs != before.BulkOnHandLbs {
		t.Errorf("bulk on hand moved from %v to %v on a refused delete",
			before.BulkOnHandLbs, after.BulkOnHandLbs)
	}
	for _, row := range mustJarInventory(t, server) {
		if row.JarSizeID == jarSizeID && row.OnHand != 90 {
			t.Errorf("jars after the refused delete = %d, want 90", row.OnHand)
		}
	}

	// An entry no lot has claimed is a measurement and nothing more: deleting
	// it takes 5 lbs off the harvest and leaves 100 lbs still covering the
	// lots, so it goes through.
	seedHarvest(t, server, 5)
	var smallID uuid.UUID
	if err := server.pool.QueryRow(ctx,
		`SELECT id FROM honey_harvests WHERE calculated_honey_weight=5`).Scan(&smallID); err != nil {
		t.Fatalf("read small entry: %v", err)
	}
	response, body = call(t, server.hsDeleteEntry, adminRequest(
		http.MethodDelete, "/api/v1/harvest-entries/"+smallID.String(), nil,
		"id", smallID.String()))
	if response.Code != http.StatusOK {
		t.Fatalf("deleting an uncommitted entry = %d %v, want 200", response.Code, body)
	}
}

func mustJarInventory(t *testing.T, server *Server) []honeyInventoryRow {
	t.Helper()
	rows, err := server.honeyJarInventory(context.Background())
	if err != nil {
		t.Fatalf("jar inventory: %v", err)
	}
	return rows
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

// Harvest entry polish: a whole yard's entries save in one transaction, a
// line can carry a directly measured weight, and a trued-up (finalized)
// session refuses new entries instead of silently ignoring them.
func TestHarvestSessionBatchEntriesAndFinalization(t *testing.T) {
	server := honeyTestServer(t)
	ctx := context.Background()

	var apiaryID, hiveA, hiveB, sessionID uuid.UUID
	if err := server.pool.QueryRow(ctx,
		`INSERT INTO apiaries (name) VALUES ('Batch yard') RETURNING id`).Scan(&apiaryID); err != nil {
		t.Fatalf("seed apiary: %v", err)
	}
	for label, target := range map[string]*uuid.UUID{"H1": &hiveA, "H2": &hiveB} {
		if err := server.pool.QueryRow(ctx,
			`INSERT INTO hives (apiary_id, position_label) VALUES ($1,$2) RETURNING id`,
			apiaryID, label).Scan(target); err != nil {
			t.Fatalf("seed hive %s: %v", label, err)
		}
	}
	if err := server.pool.QueryRow(ctx,
		`INSERT INTO harvest_sessions (apiary_id, date) VALUES ($1, now()) RETURNING id`,
		apiaryID).Scan(&sessionID); err != nil {
		t.Fatalf("seed session: %v", err)
	}

	// One batch: a super-weight pair and a direct measurement.
	response, body := call(t, server.hsAddEntry, adminRequest(
		http.MethodPost, "/api/v1/harvest-sessions/"+sessionID.String()+"/entries",
		map[string]any{"entries": []map[string]any{
			{"hiveId": hiveA.String(), "superWeightBefore": 60, "superWeightAfter": 20},
			{"hiveId": hiveB.String(), "harvestedWeight": 35},
		}}, "id", sessionID.String()))
	if response.Code != http.StatusCreated {
		t.Fatalf("batch entries = %d %v", response.Code, body)
	}
	if count, ok := body["count"].(float64); !ok || count != 2 {
		t.Fatalf("batch count = %v, want 2", body["count"])
	}

	var total float64
	var directCount int
	if err := server.pool.QueryRow(ctx, `
		SELECT COALESCE(SUM(calculated_honey_weight),0),
		       count(*) FILTER (WHERE direct_weight)
		FROM honey_harvests WHERE session_id=$1`, sessionID).
		Scan(&total, &directCount); err != nil {
		t.Fatalf("read entries: %v", err)
	}
	if total != 75 || directCount != 1 {
		t.Fatalf("total=%v direct=%d, want 75 lbs with 1 direct entry", total, directCount)
	}

	// A line that fails validation aborts the whole batch.
	response, body = call(t, server.hsAddEntry, adminRequest(
		http.MethodPost, "/api/v1/harvest-sessions/"+sessionID.String()+"/entries",
		map[string]any{"entries": []map[string]any{
			{"hiveId": hiveA.String(), "harvestedWeight": 10},
			{"hiveId": hiveB.String(), "superWeightBefore": 10, "superWeightAfter": 40},
		}}, "id", sessionID.String()))
	if response.Code != http.StatusBadRequest {
		t.Fatalf("invalid batch = %d %v, want 400", response.Code, body)
	}
	var rows int
	if err := server.pool.QueryRow(ctx,
		`SELECT count(*) FROM honey_harvests WHERE session_id=$1`, sessionID).Scan(&rows); err != nil {
		t.Fatalf("count rows: %v", err)
	}
	if rows != 2 {
		t.Fatalf("rows after failed batch = %d, want 2 (nothing partial)", rows)
	}

	// Only 65 of the session 75 lbs go into a lot, so trueing the session down
	// to 70 still leaves the lot covered. A lot sized to the whole 75 would
	// make the true-up a negative residual and the guard would refuse it --
	// which is TestTrueUpCannotShrinkBulkBelowJarredPounds subject, not this
	// test.
	seedLot(t, server, 65)

	// Finalize with a true-up, then a new entry must be refused.
	response, body = call(t, server.hsTrueUp, adminRequest(
		http.MethodPost, "/api/v1/harvest-sessions/"+sessionID.String()+"/true-up",
		map[string]any{"totalExtractedWeight": 70}, "id", sessionID.String()))
	if response.Code != http.StatusOK {
		t.Fatalf("true-up = %d %v", response.Code, body)
	}
	response, body = call(t, server.hsAddEntry, adminRequest(
		http.MethodPost, "/api/v1/harvest-sessions/"+sessionID.String()+"/entries",
		map[string]any{"entries": []map[string]any{
			{"hiveId": hiveA.String(), "harvestedWeight": 5},
		}}, "id", sessionID.String()))
	if response.Code != http.StatusConflict {
		t.Fatalf("entry after finalize = %d %v, want 409", response.Code, body)
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

type mixedSaleWorld struct {
	apiaryID, hiveID, typeID, stockID, jarSizeID, feederID, deployID uuid.UUID
}

func seedMixedSaleWorld(t *testing.T, server *Server) mixedSaleWorld {
	t.Helper()
	ctx := context.Background()
	var w mixedSaleWorld
	if err := server.pool.QueryRow(ctx,
		`INSERT INTO apiaries (name) VALUES ('Mixed sale yard') RETURNING id`).Scan(&w.apiaryID); err != nil {
		t.Fatalf("seed apiary: %v", err)
	}
	if err := server.pool.QueryRow(ctx,
		`INSERT INTO hives (apiary_id, position_label) VALUES ($1,'A1') RETURNING id`,
		w.apiaryID).Scan(&w.hiveID); err != nil {
		t.Fatalf("seed hive: %v", err)
	}
	if err := server.pool.QueryRow(ctx, `
		INSERT INTO equipment_types (name, category) VALUES ($1,'box') RETURNING id`,
		"Deep "+uuid.NewString()).Scan(&w.typeID); err != nil {
		t.Fatalf("seed type: %v", err)
	}
	// Five received at home, two of them standing on the hive. Both go in
	// through the equipment commands: a row in equipment_stock_adjustments or
	// equipment_deployments is a legacy record with no balance behind it, and
	// a sale drawing on it would find nothing there.
	w.stockID = equipSeedStockForTest(t, server, w.typeID, 5)
	w.deployID = equipDeployForTest(t, server, w.stockID, w.hiveID, 2)
	if err := server.pool.QueryRow(ctx, `
		INSERT INTO feedings (hive_id, date_fed, type, quantity, quantity_unit, status)
		VALUES ($1, now(), 'sugar_syrup_1to1', 1, 'quarts', 'open') RETURNING id`,
		w.hiveID).Scan(&w.feederID); err != nil {
		t.Fatalf("seed feeder: %v", err)
	}
	w.jarSizeID = seedJarSize(t, server, "Pint mixed", 16, 1200)
	seedHarvest(t, server, 100)
	jarStock(t, server, w.jarSizeID, 10)
	return w
}

func TestRecordMixedSaleAndCancelRestores(t *testing.T) {
	server := honeyTestServer(t)
	w := seedMixedSaleWorld(t, server)
	ctx := context.Background()

	response, body := call(t, server.honeyRecordSale, adminRequest(
		http.MethodPost, "/api/v1/sales", map[string]any{
			"date": time.Now().Format("2006-01-02"),
			"lines": []map[string]any{
				{"kind": "jar", "jarSizeId": w.jarSizeID.String(), "quantity": 2, "unitPrice": 12},
				{"kind": "colony", "hiveId": w.hiveID.String(), "quantity": 1, "unitPrice": 250},
				{"kind": "equipment", "equipmentStockId": w.stockID.String(), "quantity": 2, "unitPrice": 40},
			},
		}))
	if response.Code != http.StatusCreated {
		t.Fatalf("mixed sale = %d %v", response.Code, body)
	}
	saleID, _ := body["id"].(string)

	var hiveStatus, feederStatus, feederReason string
	var hiveSale *uuid.UUID
	if err := server.pool.QueryRow(ctx,
		`SELECT status::text, sale_id FROM hives WHERE id=$1`, w.hiveID).
		Scan(&hiveStatus, &hiveSale); err != nil {
		t.Fatalf("read hive: %v", err)
	}
	if hiveStatus != "sold" || hiveSale == nil || hiveSale.String() != saleID {
		t.Errorf("hive status/sale = %s %v, want sold + sale", hiveStatus, hiveSale)
	}
	if err := server.pool.QueryRow(ctx,
		`SELECT status::text, COALESCE(closed_reason,'') FROM feedings WHERE id=$1`,
		w.feederID).Scan(&feederStatus, &feederReason); err != nil {
		t.Fatalf("read feeder: %v", err)
	}
	if feederStatus != "closed" || feederReason != "sold_with_hive" {
		t.Errorf("feeder = %s/%s, want closed/sold_with_hive", feederStatus, feederReason)
	}

	// The colony took the two that stood on it; the equipment line was
	// satisfied by that same gear, so the three in storage never moved.
	owned, deployed, available := equipStockStatusForTest(t, server, w.typeID)
	if owned != 3 || deployed != 0 || available != 3 {
		t.Errorf("stock owned/deployed/available = %d/%d/%d, want 3/0/3", owned, deployed, available)
	}

	var kinds int
	if err := server.pool.QueryRow(ctx,
		`SELECT COUNT(DISTINCT kind) FROM sale_items WHERE sale_id=$1`, saleID).Scan(&kinds); err != nil {
		t.Fatalf("count kinds: %v", err)
	}
	if kinds != 3 {
		t.Errorf("distinct kinds = %d, want 3", kinds)
	}

	response, body = call(t, server.honeyCancelSale, adminRequest(
		http.MethodDelete, "/api/v1/sales/"+saleID, nil, "id", saleID))
	if response.Code != http.StatusOK {
		t.Fatalf("cancel mixed sale = %d %v", response.Code, body)
	}

	if err := server.pool.QueryRow(ctx,
		`SELECT status::text, sale_id FROM hives WHERE id=$1`, w.hiveID).
		Scan(&hiveStatus, &hiveSale); err != nil {
		t.Fatalf("read hive after cancel: %v", err)
	}
	if hiveStatus != "active" || hiveSale != nil {
		t.Errorf("hive after cancel = %s %v, want active nil", hiveStatus, hiveSale)
	}
	if err := server.pool.QueryRow(ctx,
		`SELECT status::text FROM feedings WHERE id=$1`, w.feederID).Scan(&feederStatus); err != nil {
		t.Fatalf("read feeder after cancel: %v", err)
	}
	if feederStatus != "open" {
		t.Errorf("feeder after cancel = %s, want open", feederStatus)
	}
	owned, deployed, available = equipStockStatusForTest(t, server, w.typeID)
	if owned != 5 || deployed != 2 || available != 3 {
		t.Errorf("stock after cancel = %d/%d/%d, want 5/2/3", owned, deployed, available)
	}

	inventory, err := server.honeyJarInventory(ctx)
	if err != nil {
		t.Fatalf("inventory: %v", err)
	}
	for _, row := range inventory {
		if row.JarSizeID == w.jarSizeID && row.OnHand != 10 {
			t.Errorf("jars on hand after cancel = %d, want 10", row.OnHand)
		}
	}
}

func TestDraftSaleDefersPhysicalUntilPaid(t *testing.T) {
	server := honeyTestServer(t)
	w := seedMixedSaleWorld(t, server)
	ctx := context.Background()

	readWorld := func(label string) (hiveStatus, feederStatus string, owned, deployed int, applied *time.Time, saleID string) {
		t.Helper()
		if err := server.pool.QueryRow(ctx,
			`SELECT status::text FROM hives WHERE id=$1`, w.hiveID).Scan(&hiveStatus); err != nil {
			t.Fatalf("%s read hive: %v", label, err)
		}
		if err := server.pool.QueryRow(ctx,
			`SELECT status::text FROM feedings WHERE id=$1`, w.feederID).Scan(&feederStatus); err != nil {
			t.Fatalf("%s read feeder: %v", label, err)
		}
		owned, deployed, _ = equipStockStatusForTest(t, server, w.typeID)
		return
	}
	readApplied := func(saleID string) *time.Time {
		t.Helper()
		var applied *time.Time
		if err := server.pool.QueryRow(ctx,
			`SELECT physical_applied_at FROM sales WHERE id=$1`, saleID).Scan(&applied); err != nil {
			t.Fatalf("read applied: %v", err)
		}
		return applied
	}

	response, body := call(t, server.honeyRecordSale, adminRequest(
		http.MethodPost, "/api/v1/sales", map[string]any{
			"date":        time.Now().Format("2006-01-02"),
			"orderStatus": "draft",
			"lines": []map[string]any{
				{"kind": "colony", "hiveId": w.hiveID.String(), "quantity": 1, "unitPrice": 250},
				{"kind": "equipment", "equipmentStockId": w.stockID.String(), "quantity": 2, "unitPrice": 40},
			},
		}))
	if response.Code != http.StatusCreated {
		t.Fatalf("draft sale = %d %v", response.Code, body)
	}
	saleID, _ := body["id"].(string)

	hive, feeder, owned, deployed, _, _ := readWorld("after draft")
	if hive != "active" || feeder != "open" || owned != 5 || deployed != 2 {
		t.Errorf("after draft = hive %s feeder %s stock %d/%d, want active/open/5/2",
			hive, feeder, owned, deployed)
	}
	if readApplied(saleID) != nil {
		t.Errorf("draft sale has physical_applied_at set")
	}

	// A second open draft may name the same hive: drafts do not reserve it.
	second, body := call(t, server.honeyRecordSale, adminRequest(
		http.MethodPost, "/api/v1/sales", map[string]any{
			"date":        time.Now().Format("2006-01-02"),
			"orderStatus": "pending",
			"lines": []map[string]any{
				{"kind": "colony", "hiveId": w.hiveID.String(), "quantity": 1, "unitPrice": 250},
			},
		}))
	if second.Code != http.StatusCreated {
		t.Fatalf("second draft on same hive = %d %v, want 201", second.Code, body)
	}
	secondID, _ := body["id"].(string)

	response, body = call(t, server.honeyUpdateSale, adminRequest(
		http.MethodPatch, "/api/v1/sales/"+saleID, map[string]any{"orderStatus": "paid"},
		"id", saleID))
	if response.Code != http.StatusOK {
		t.Fatalf("draft -> paid = %d %v", response.Code, body)
	}
	hive, feeder, owned, deployed, _, _ = readWorld("after paid")
	if hive != "sold" || feeder != "closed" || owned != 3 || deployed != 0 {
		t.Errorf("after paid = hive %s feeder %s stock %d/%d, want sold/closed/3/0",
			hive, feeder, owned, deployed)
	}
	if readApplied(saleID) == nil {
		t.Errorf("paid sale has no physical_applied_at")
	}

	// The other draft can no longer be paid: the hive went with the first sale.
	response, body = call(t, server.honeyUpdateSale, adminRequest(
		http.MethodPatch, "/api/v1/sales/"+secondID, map[string]any{"orderStatus": "paid"},
		"id", secondID))
	if response.Code != http.StatusConflict {
		t.Fatalf("second draft -> paid = %d %v, want 409", response.Code, body)
	}
	if msg, _ := body["error"].(string); !strings.Contains(msg, "BT-") {
		t.Errorf("409 should name the sale, got %v", body)
	}
	// A fresh draft for an already-sold hive is refused outright.
	response, body = call(t, server.honeyRecordSale, adminRequest(
		http.MethodPost, "/api/v1/sales", map[string]any{
			"date":        time.Now().Format("2006-01-02"),
			"orderStatus": "draft",
			"lines": []map[string]any{
				{"kind": "colony", "hiveId": w.hiveID.String(), "quantity": 1, "unitPrice": 250},
			},
		}))
	if response.Code != http.StatusBadRequest {
		t.Fatalf("draft for sold hive = %d %v, want 400", response.Code, body)
	}

	response, body = call(t, server.honeyUpdateSale, adminRequest(
		http.MethodPatch, "/api/v1/sales/"+saleID, map[string]any{"orderStatus": "pending"},
		"id", saleID))
	if response.Code != http.StatusOK {
		t.Fatalf("paid -> pending = %d %v", response.Code, body)
	}
	hive, feeder, owned, deployed, _, _ = readWorld("after pending")
	if hive != "active" || feeder != "open" || owned != 5 || deployed != 2 {
		t.Errorf("after pending = hive %s feeder %s stock %d/%d, want active/open/5/2",
			hive, feeder, owned, deployed)
	}
	if readApplied(saleID) != nil {
		t.Errorf("pending sale still has physical_applied_at")
	}

	// Cancelling a draft runs no restore and leaves the world untouched.
	response, body = call(t, server.honeyCancelSale, adminRequest(
		http.MethodDelete, "/api/v1/sales/"+saleID, nil, "id", saleID))
	if response.Code != http.StatusOK {
		t.Fatalf("cancel draft = %d %v", response.Code, body)
	}
	hive, feeder, owned, deployed, _, _ = readWorld("after cancel")
	if hive != "active" || feeder != "open" || owned != 5 || deployed != 2 {
		t.Errorf("after cancel = hive %s feeder %s stock %d/%d, want active/open/5/2",
			hive, feeder, owned, deployed)
	}
	// Cancelling a sale whose physical effects were already unapplied writes
	// nothing further: the consumption and its reversal both stand, and no
	// live operation is left behind claiming the stock.
	var live int
	if err := server.pool.QueryRow(ctx, `
		SELECT COUNT(*) FROM inventory_operations o
		WHERE o.source_type='sale' AND o.source_id=$1
		  AND NOT EXISTS (SELECT 1 FROM inventory_operations r
		                  WHERE r.reverses_operation_id = o.id)`, saleID).Scan(&live); err != nil {
		t.Fatalf("count sale operations: %v", err)
	}
	if live != 0 {
		t.Errorf("cancelling the sale left %d live ledger operations", live)
	}

	// The hive is free again, so the second draft can now be paid.
	response, body = call(t, server.honeyUpdateSale, adminRequest(
		http.MethodPatch, "/api/v1/sales/"+secondID, map[string]any{"orderStatus": "paid"},
		"id", secondID))
	if response.Code != http.StatusOK {
		t.Fatalf("second draft -> paid after release = %d %v", response.Code, body)
	}
	hive, _, _, _, _, _ = readWorld("after second paid")
	if hive != "sold" {
		t.Errorf("hive after second paid = %s, want sold", hive)
	}
}

func TestRejectDoubleSellHive(t *testing.T) {
	server := honeyTestServer(t)
	w := seedMixedSaleWorld(t, server)

	first, body := call(t, server.honeyRecordSale, adminRequest(
		http.MethodPost, "/api/v1/sales", map[string]any{
			"date": time.Now().Format("2006-01-02"),
			"lines": []map[string]any{
				{"kind": "colony", "hiveId": w.hiveID.String(), "quantity": 1, "unitPrice": 250},
			},
		}))
	if first.Code != http.StatusCreated {
		t.Fatalf("first hive sale = %d %v", first.Code, body)
	}
	second, body := call(t, server.honeyRecordSale, adminRequest(
		http.MethodPost, "/api/v1/sales", map[string]any{
			"date": time.Now().Format("2006-01-02"),
			"lines": []map[string]any{
				{"kind": "colony", "hiveId": w.hiveID.String(), "quantity": 1, "unitPrice": 250},
			},
		}))
	if second.Code != http.StatusConflict {
		t.Fatalf("second hive sale = %d %v, want 409", second.Code, body)
	}
}

func TestPropolisHarvestDoesNotChangeBulkHoney(t *testing.T) {
	server := honeyTestServer(t)
	seedHarvest(t, server, 40)
	ctx := context.Background()

	before, err := honeyBulkOnHand(ctx, server.pool)
	if err != nil {
		t.Fatalf("bulk before: %v", err)
	}

	var hiveID, apiaryID uuid.UUID
	if err := server.pool.QueryRow(ctx, `
		SELECT h.id, h.apiary_id FROM hives h ORDER BY h.created_at LIMIT 1`).
		Scan(&hiveID, &apiaryID); err != nil {
		t.Fatalf("read seeded hive: %v", err)
	}

	response, body := call(t, server.propolisHarvestCreate, adminRequest(
		http.MethodPost, "/api/v1/propolis-harvests", map[string]any{
			"hiveId": hiveID.String(),
			"date":   time.Now().Format("2006-01-02"),
			"amount": 85,
			"unit":   "grams",
			"notes":  "scraped for tincture",
		}))
	if response.Code != http.StatusCreated {
		t.Fatalf("propolis harvest = %d %v", response.Code, body)
	}

	after, err := honeyBulkOnHand(ctx, server.pool)
	if err != nil {
		t.Fatalf("bulk after: %v", err)
	}
	if after != before {
		t.Errorf("bulk honey changed after propolis harvest: before %#v after %#v", before, after)
	}

	grams, err := propolisOnHandGrams(ctx, server.pool)
	if err != nil {
		t.Fatalf("propolis on hand: %v", err)
	}
	if grams < 84.9 || grams > 85.1 {
		t.Errorf("propolis on hand = %v g, want 85", grams)
	}

	// The propolis receipt must not have touched the honey ledger at all.
	var honeyMovements int
	if err := server.pool.QueryRow(ctx, `
		SELECT COUNT(*) FROM inventory_movements m
		JOIN inventory_items i ON i.id = m.item_id
		WHERE i.kind IN ('honey_bulk','jar')`).
		Scan(&honeyMovements); err != nil {
		t.Fatalf("count honey movements: %v", err)
	}
	if honeyMovements != 0 {
		t.Errorf("propolis harvest wrote %d honey movements, want 0", honeyMovements)
	}
}

func TestMixedSaleWithCatalogSKU(t *testing.T) {
	server := honeyTestServer(t)
	w := seedMixedSaleWorld(t, server)
	ctx := context.Background()

	var lotID uuid.UUID
	if err := server.pool.QueryRow(ctx, `
		INSERT INTO harvest_lots (lot_code, public_slug, extraction_date, honey_weight_lbs)
		VALUES ('LOT-CREAM','lot-cream',CURRENT_DATE, 40) RETURNING id`).Scan(&lotID); err != nil {
		t.Fatalf("seed lot: %v", err)
	}
	bookLotCeiling(t, server, lotID)

	createProduct, productBody := call(t, server.productCreate, adminRequest(
		http.MethodPost, "/api/v1/products", map[string]any{
			"name":         "Creamed clover",
			"kind":         "creamed_honey",
			"unit":         "jar",
			"defaultPrice": 14,
			"sizeLabel":    "8 oz",
		}))
	if createProduct.Code != http.StatusCreated {
		t.Fatalf("create product = %d %v", createProduct.Code, productBody)
	}
	productID, _ := productBody["id"].(string)

	bulkBefore, err := honeyBulkOnHand(ctx, server.pool)
	if err != nil {
		t.Fatalf("bulk before batch: %v", err)
	}

	createBatch, batchBody := call(t, server.productBatchCreate, adminRequest(
		http.MethodPost, "/api/v1/product-batches", map[string]any{
			"kind":         "creamed_honey",
			"productId":    productID,
			"harvestLotId": lotID.String(),
			"startedAt":    time.Now().Format("2006-01-02"),
			"honeyLbs":     5,
			"quantityOut":  8,
		}))
	if createBatch.Code != http.StatusCreated {
		t.Fatalf("create batch = %d %v", createBatch.Code, batchBody)
	}

	bulkAfterBatch, err := honeyBulkOnHand(ctx, server.pool)
	if err != nil {
		t.Fatalf("bulk after batch: %v", err)
	}
	used := bulkBefore.BulkOnHandLbs - bulkAfterBatch.BulkOnHandLbs
	if used < 4.9 || used > 5.1 {
		t.Errorf("batch consumed %.2f lbs, want 5", used)
	}

	response, body := call(t, server.honeyRecordSale, adminRequest(
		http.MethodPost, "/api/v1/sales", map[string]any{
			"date": time.Now().Format("2006-01-02"),
			"lines": []map[string]any{
				{"kind": "jar", "jarSizeId": w.jarSizeID.String(), "quantity": 1, "unitPrice": 12},
				{"kind": "creamed_honey", "productId": productID, "quantity": 2, "unitPrice": 14},
				{"kind": "colony", "hiveId": w.hiveID.String(), "quantity": 1, "unitPrice": 250},
			},
		}))
	if response.Code != http.StatusCreated {
		t.Fatalf("mixed catalog sale = %d %v", response.Code, body)
	}
	saleID, _ := body["id"].(string)

	var kinds []string
	rows, err := server.pool.Query(ctx, `
		SELECT kind FROM sale_items WHERE sale_id=$1 ORDER BY kind`, saleID)
	if err != nil {
		t.Fatalf("list kinds: %v", err)
	}
	for rows.Next() {
		var kind string
		if err := rows.Scan(&kind); err != nil {
			rows.Close()
			t.Fatalf("scan kind: %v", err)
		}
		kinds = append(kinds, kind)
	}
	rows.Close()
	if strings.Join(kinds, ",") != "colony,creamed_honey,jar" {
		t.Errorf("sale kinds = %v, want colony,creamed_honey,jar", kinds)
	}

	inventory, err := productInventoryQuery(ctx, server.pool)
	if err != nil {
		t.Fatalf("product inventory: %v", err)
	}
	found := false
	for _, row := range inventory {
		if row.ID.String() == productID {
			found = true
			if row.Made != 8 || row.Sold != 2 || row.OnHand != 6 {
				t.Errorf("catalog stock made/sold/onHand = %d/%d/%d, want 8/2/6",
					row.Made, row.Sold, row.OnHand)
			}
		}
	}
	if !found {
		t.Fatal("catalog product missing from inventory")
	}

	over, overBody := call(t, server.honeyRecordSale, adminRequest(
		http.MethodPost, "/api/v1/sales", map[string]any{
			"date": time.Now().Format("2006-01-02"),
			"lines": []map[string]any{
				{"kind": "creamed_honey", "productId": productID, "quantity": 7, "unitPrice": 14},
			},
		}))
	if over.Code != http.StatusBadRequest {
		t.Fatalf("oversell catalog SKU = %d %v, want 400", over.Code, overBody)
	}
}

func TestSaleCannotBeCreatedCancelled(t *testing.T) {
	server := honeyTestServer(t)
	w := seedMixedSaleWorld(t, server)
	ctx := context.Background()

	response, body := call(t, server.honeyRecordSale, adminRequest(
		http.MethodPost, "/api/v1/sales", map[string]any{
			"date":        time.Now().Format("2006-01-02"),
			"orderStatus": "cancelled",
			"lines": []map[string]any{
				{"kind": "colony", "hiveId": w.hiveID.String(), "quantity": 1, "unitPrice": 250},
				{"kind": "equipment", "equipmentStockId": w.stockID.String(), "quantity": 1, "unitPrice": 40},
			},
		}))
	if response.Code != http.StatusBadRequest {
		t.Fatalf("sale created as cancelled = %d %v, want 400", response.Code, body)
	}
	var hiveStatus string
	if err := server.pool.QueryRow(ctx,
		`SELECT status::text FROM hives WHERE id=$1`, w.hiveID).Scan(&hiveStatus); err != nil {
		t.Fatalf("read hive: %v", err)
	}
	if hiveStatus != "active" {
		t.Errorf("hive status = %s, want active (nothing should have been sold)", hiveStatus)
	}
	if owned, _, _ := equipStockStatusForTest(t, server, w.typeID); owned != 5 {
		t.Errorf("stock owned = %d, want 5", owned)
	}
}

// An equipment line on a sale that does not include the hive must come out
// of free stock; deployments on hives that stay with the operator are
// never consumed.
func TestEquipmentSaleLeavesKeptHiveDeployments(t *testing.T) {
	server := honeyTestServer(t)
	w := seedMixedSaleWorld(t, server)
	ctx := context.Background()

	response, body := call(t, server.honeyRecordSale, adminRequest(
		http.MethodPost, "/api/v1/sales", map[string]any{
			"date": time.Now().Format("2006-01-02"),
			"lines": []map[string]any{
				{"kind": "equipment", "equipmentStockId": w.stockID.String(), "quantity": 2, "unitPrice": 40},
			},
		}))
	if response.Code != http.StatusCreated {
		t.Fatalf("equipment sale = %d %v", response.Code, body)
	}
	// Nothing came off the hive: no return operation was written against the
	// deploy, and the hive still carries its two.
	var returns int
	if err := server.pool.QueryRow(ctx, `
		SELECT COUNT(*) FROM inventory_operations
		WHERE kind='return' AND source_type='inventory_operation' AND source_id=$1`,
		w.deployID).Scan(&returns); err != nil {
		t.Fatalf("count returns: %v", err)
	}
	if returns != 0 {
		t.Errorf("kept hive deployment saw %d returns, want none", returns)
	}
	if got := equipDeployedOnHiveForTest(t, server, w.typeID, w.hiveID); got != 2 {
		t.Errorf("gear left on the kept hive = %d, want 2", got)
	}
	owned, deployed, available := equipStockStatusForTest(t, server, w.typeID)
	if owned != 3 || deployed != 2 || available != 1 {
		t.Errorf("stock owned/deployed/available = %d/%d/%d, want 3/2/1", owned, deployed, available)
	}
	var hiveStatus string
	if err := server.pool.QueryRow(ctx,
		`SELECT status::text FROM hives WHERE id=$1`, w.hiveID).Scan(&hiveStatus); err != nil {
		t.Fatalf("read hive: %v", err)
	}
	if hiveStatus != "active" {
		t.Errorf("hive status = %s, want active", hiveStatus)
	}
}

// Jarring with a lot chosen has to produce the same traceability the lot page
// produces: a bottling run per jar line, the movement linked to it, and the
// lot's remaining weight enforced.
func TestJarringWithLotCreatesBottlingRunsAndRespectsLotWeight(t *testing.T) {
	server := honeyTestServer(t)
	jarSizeID := seedJarSize(t, server, "Pound", 16, 1200)
	seedHarvest(t, server, 100)

	ctx := context.Background()
	var lotID uuid.UUID
	if err := server.pool.QueryRow(ctx, `
		INSERT INTO harvest_lots (lot_code, public_slug, extraction_date, honey_weight_lbs, honey_variety)
		VALUES ('LOT-BASSWOOD','lot-basswood',CURRENT_DATE, 40, 'Basswood') RETURNING id`).
		Scan(&lotID); err != nil {
		t.Fatalf("seed lot: %v", err)
	}
	bookLotCeiling(t, server, lotID)
	today := time.Now().Format("2006-01-02")

	response, body := call(t, server.honeyRecordJarring, adminRequest(
		http.MethodPost, "/api/v1/honey/jarring", map[string]any{
			"date":  today,
			"lotId": lotID.String(),
			"lines": []map[string]any{{"jarSizeId": jarSizeID.String(), "quantity": 10}},
		}))
	if response.Code != http.StatusOK {
		t.Fatalf("lot-linked jarring = %d %v", response.Code, body)
	}

	var runs, linkedOperations int
	if err := server.pool.QueryRow(ctx,
		`SELECT COUNT(*) FROM bottling_runs WHERE lot_id=$1`, lotID).Scan(&runs); err != nil {
		t.Fatalf("count runs: %v", err)
	}
	if runs != 1 {
		t.Errorf("bottling runs for the lot = %d, want 1", runs)
	}
	if err := server.pool.QueryRow(ctx, `
		SELECT COUNT(*) FROM inventory_operations o
		JOIN bottling_runs run ON run.id = o.source_id
		WHERE o.source_type='bottling_run' AND run.lot_id = $1`, lotID).
		Scan(&linkedOperations); err != nil {
		t.Fatalf("count linked operations: %v", err)
	}
	if linkedOperations != 1 {
		t.Errorf("operations linked to the lot = %d, want 1", linkedOperations)
	}

	// 10 lbs are bottled and 90 lbs of bulk remain, so 50 more jars clear the
	// bulk pool but exceed what the 40 lb lot can yield.
	response, body = call(t, server.honeyRecordJarring, adminRequest(
		http.MethodPost, "/api/v1/honey/jarring", map[string]any{
			"date":  today,
			"lotId": lotID.String(),
			"lines": []map[string]any{{"jarSizeId": jarSizeID.String(), "quantity": 50}},
		}))
	if response.Code != http.StatusBadRequest {
		t.Fatalf("over-bottling the lot = %d %v, want %d", response.Code, body, http.StatusBadRequest)
	}

	// Bulk honey is per lot now, so a draw that names no lot is refused
	// rather than silently taken from everything at once.
	response, body = call(t, server.honeyRecordJarring, adminRequest(
		http.MethodPost, "/api/v1/honey/jarring", map[string]any{
			"date":  today,
			"lines": []map[string]any{{"jarSizeId": jarSizeID.String(), "quantity": 5}},
		}))
	if response.Code != http.StatusBadRequest {
		t.Fatalf("lot-less jarring = %d %v, want %d", response.Code, body, http.StatusBadRequest)
	}
	// Nothing was drawn out of bulk honey without naming the lot it came
	// from: every bulk line carries a lot id.
	var untraced int
	if err := server.pool.QueryRow(ctx, `
		SELECT COUNT(*) FROM inventory_movements m
		JOIN inventory_items i ON i.id = m.item_id
		WHERE i.kind='honey_bulk' AND m.lot_id IS NULL`).Scan(&untraced); err != nil {
		t.Fatalf("count untraced: %v", err)
	}
	if untraced != 0 {
		t.Errorf("unattributed bulk honey movements = %d, want 0", untraced)
	}
}

// Filling jars draws down the empties the jar size is linked to. Short stock
// is reported but never refuses the jarring — the jars were really filled.
func TestJarringConsumesLinkedPackaging(t *testing.T) {
	server := honeyTestServer(t)
	jarSizeID := seedJarSize(t, server, "Pound", 16, 1200)
	seedHarvest(t, server, 100)
	lotID := seedLot(t, server, 100)

	ctx := context.Background()
	var packagingTypeID uuid.UUID
	if err := server.pool.QueryRow(ctx, `
		INSERT INTO equipment_types (name, category)
		VALUES ($1, 'packaging') RETURNING id`, "1 lb glass jar "+uuid.NewString()).
		Scan(&packagingTypeID); err != nil {
		t.Fatalf("seed packaging type: %v", err)
	}
	equipSeedStockForTest(t, server, packagingTypeID, 12)
	if _, err := server.pool.Exec(ctx,
		`UPDATE jar_sizes SET packaging_type_id=$2 WHERE id=$1`,
		jarSizeID, packagingTypeID); err != nil {
		t.Fatalf("link packaging: %v", err)
	}

	// 10 of 12 empties: covered, so no warning.
	response, body := call(t, server.honeyRecordJarring, adminRequest(
		http.MethodPost, "/api/v1/honey/jarring", map[string]any{
			"date":  time.Now().Format("2006-01-02"),
			"lotId": lotID.String(),
			"lines": []map[string]any{{"jarSizeId": jarSizeID.String(), "quantity": 10}},
		}))
	if response.Code != http.StatusOK {
		t.Fatalf("jarring = %d %v", response.Code, body)
	}
	if warnings, _ := body["packagingWarnings"].([]any); len(warnings) != 0 {
		t.Errorf("warnings with stock on hand = %v, want none", warnings)
	}
	if owned := equipOnHandForTest(t, server, packagingTypeID); owned != 2 {
		t.Errorf("empties left = %d, want 2", owned)
	}

	// 5 more against 2 on hand: recorded anyway, with a warning.
	response, body = call(t, server.honeyRecordJarring, adminRequest(
		http.MethodPost, "/api/v1/honey/jarring", map[string]any{
			"date":  time.Now().Format("2006-01-02"),
			"lotId": lotID.String(),
			"lines": []map[string]any{{"jarSizeId": jarSizeID.String(), "quantity": 5}},
		}))
	if response.Code != http.StatusOK {
		t.Fatalf("jarring short of empties = %d %v, want it recorded", response.Code, body)
	}
	warnings, _ := body["packagingWarnings"].([]any)
	if len(warnings) != 1 {
		t.Fatalf("warnings when short = %v, want 1", warnings)
	}
	// The overdraw consumes what exists and stops at zero. The ledger has no
	// negative balances, so "we owe 3 empties" is a warning on the run, not a
	// -3 hidden in a stock row.
	if owned := equipOnHandForTest(t, server, packagingTypeID); owned != 0 {
		t.Errorf("empties after overdraw = %d, want 0", owned)
	}
}

// equipSeedStockForTest creates a stock row and books an opening count through
// the equipment command, which is the only way quantities are allowed in: a
// row in equipment_stock_adjustments is a legacy record with no balance
// behind it, so a fixture that writes one seeds nothing the ledger can see.
func equipSeedStockForTest(
	t *testing.T, server *Server, typeID uuid.UUID, opening int,
) uuid.UUID {
	t.Helper()
	ctx := context.Background()
	var stockID uuid.UUID
	if err := server.pool.QueryRow(ctx,
		`INSERT INTO equipment_stock (type_id, total_owned) VALUES ($1, 0) RETURNING id`,
		typeID).Scan(&stockID); err != nil {
		t.Fatalf("seed equipment stock: %v", err)
	}
	if opening == 0 {
		return stockID
	}
	if err := app.NewRunner(server.pool).Run(ctx, app.UserActor(testUserID, "Test Admin"),
		func(ctx context.Context, uow *app.UnitOfWork) error {
			_, err := equipment.NewService().Receive(ctx, uow, equipment.Command{
				Reference: stockID, Quantity: opening, OccurredAt: time.Now().UTC(),
				Reason: "purchased",
			})
			return err
		}); err != nil {
		t.Fatalf("book opening count: %v", err)
	}
	return stockID
}

// equipDeployForTest puts serviceable gear on a hive through the equipment
// command and returns the deploy operation, which is the deployment identity
// under the ledger.
func equipDeployForTest(
	t *testing.T, server *Server, stockID, hiveID uuid.UUID, quantity int,
) uuid.UUID {
	t.Helper()
	var operationID uuid.UUID
	if err := app.NewRunner(server.pool).Run(context.Background(),
		app.UserActor(testUserID, "Test Admin"),
		func(ctx context.Context, uow *app.UnitOfWork) error {
			recorded, err := equipment.NewService().Deploy(ctx, uow, equipment.DeployCommand{
				Command: equipment.Command{
					Reference: stockID, Quantity: quantity, OccurredAt: time.Now().UTC(),
				},
				HiveID: hiveID,
			})
			if err != nil {
				return err
			}
			operationID = recorded.Operation.ID
			return nil
		}); err != nil {
		t.Fatalf("deploy equipment: %v", err)
	}
	return operationID
}

// equipStockStatusForTest is the ledger's answer to the equipment_stock_status
// view: what a type holds at home, what stands on hives, and the total. The
// view still reads the frozen legacy tables, so it reports the world as it was
// before the ledger took over the quantities.
func equipStockStatusForTest(
	t *testing.T, server *Server, typeID uuid.UUID,
) (owned, deployed, available int) {
	t.Helper()
	if err := server.pool.QueryRow(context.Background(), `
		SELECT COALESCE(SUM(b.on_hand) FILTER (WHERE l.is_home), 0)::int,
		       COALESCE(SUM(b.on_hand) FILTER (WHERE l.kind='deployed'), 0)::int
		FROM inventory_balances b
		JOIN equipment_types et ON et.item_id = b.item_id
		JOIN inventory_locations l ON l.id = b.location_id
		WHERE et.id = $1 AND b.condition IS NOT DISTINCT FROM 'serviceable'`, typeID).
		Scan(&available, &deployed); err != nil {
		t.Fatalf("equipment stock status: %v", err)
	}
	return available + deployed, deployed, available
}

// equipDeployedOnHiveForTest is what one hive is still carrying.
func equipDeployedOnHiveForTest(
	t *testing.T, server *Server, typeID, hiveID uuid.UUID,
) int {
	t.Helper()
	var quantity int
	if err := server.pool.QueryRow(context.Background(), `
		SELECT COALESCE(SUM(b.on_hand), 0)::int
		FROM inventory_balances b
		JOIN equipment_types et ON et.item_id = b.item_id
		WHERE et.id = $1 AND b.container_hive_id = $2`, typeID, hiveID).Scan(&quantity); err != nil {
		t.Fatalf("deployed on hive: %v", err)
	}
	return quantity
}

// equipOnHandForTest is the serviceable balance an equipment type holds at
// home, which is what replaced equipment_stock.total_owned.
func equipOnHandForTest(t *testing.T, server *Server, typeID uuid.UUID) int {
	t.Helper()
	var onHand int
	if err := server.pool.QueryRow(context.Background(), `
		SELECT COALESCE(SUM(b.on_hand), 0)::int
		FROM inventory_balances b
		JOIN equipment_types et ON et.item_id = b.item_id
		JOIN inventory_locations l ON l.id = b.location_id
		WHERE et.id = $1 AND l.is_home
		  AND b.condition IS NOT DISTINCT FROM 'serviceable'`, typeID).Scan(&onHand); err != nil {
		t.Fatalf("equipment on hand: %v", err)
	}
	return onHand
}

// bookLotCeiling books an already-inserted lot's stored weight into the
// ledger. Fixtures that write harvest_lots directly need it for the same
// reason seedLot does: since decision 6 a lot's pounds ARE a receive, so a
// lot row on its own is an empty bucket.
func bookLotCeiling(t *testing.T, server *Server, lotID uuid.UUID) {
	t.Helper()
	ctx := context.Background()
	err := app.NewRunner(server.pool).Run(ctx, app.UserActor(testUserID, "Test Admin"),
		func(ctx context.Context, uow *app.UnitOfWork) error {
			var weightLbs float64
			if err := uow.QueryRow(ctx,
				`SELECT honey_weight_lbs FROM harvest_lots WHERE id=$1`, lotID).
				Scan(&weightLbs); err != nil {
				return err
			}
			return production.New().SetLotCeiling(ctx, uow, lotID, weightLbs, time.Now().UTC())
		})
	if err != nil {
		t.Fatalf("book lot ceiling: %v", err)
	}
}
