package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

type serialFixture struct {
	server       *Server
	user         *principal
	lotID        uuid.UUID
	lotCode      string
	runID        uuid.UUID
	customerName string
	ctx          context.Context
}

// newSerialFixture builds one harvest lot with one bottling run so tests can
// mint serials on it, plus an isolated admin user to attribute links to.
func newSerialFixture(t *testing.T) *serialFixture {
	t.Helper()
	databaseURL := os.Getenv("TEST_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("TEST_DATABASE_URL is not configured")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	t.Cleanup(cancel)

	pool, err := feedingTestDatabase(ctx, databaseURL)
	if err != nil {
		t.Fatalf("connect test database: %v", err)
	}

	suffix := uuid.NewString()
	fixture := &serialFixture{server: &Server{pool: pool}, ctx: ctx}

	var userID uuid.UUID
	if err := pool.QueryRow(ctx, `
		INSERT INTO app_users (auth_subject, display_name, is_admin, is_active)
		VALUES ($1,'Serial test',true,true) RETURNING id`,
		"serial-test:"+suffix).Scan(&userID); err != nil {
		t.Fatalf("insert test user: %v", err)
	}
	fixture.user = &principal{ID: userID, DisplayName: "Serial test", IsAdmin: true}

	fixture.lotCode = "SER-" + suffix[:8]
	if err := pool.QueryRow(ctx, `
		INSERT INTO harvest_lots
			(lot_code, public_slug, extraction_date, honey_weight_lbs, honey_variety, season)
		VALUES ($1,$2,'2026-07-01',120,'Wildflower','2026') RETURNING id`,
		fixture.lotCode, "ser-"+suffix).Scan(&fixture.lotID); err != nil {
		t.Fatalf("insert harvest lot: %v", err)
	}
	if err := pool.QueryRow(ctx, `
		INSERT INTO bottling_runs (lot_id, bottled_date, quantity)
		VALUES ($1,'2026-07-05',24) RETURNING id`,
		fixture.lotID).Scan(&fixture.runID); err != nil {
		t.Fatalf("insert bottling run: %v", err)
	}

	t.Cleanup(func() {
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cleanupCancel()
		_, _ = pool.Exec(cleanupCtx, `DELETE FROM jar_serials WHERE bottling_run_id=$1`, fixture.runID)
		_, _ = pool.Exec(cleanupCtx, `DELETE FROM honey_movements WHERE bottling_run_id=$1`, fixture.runID)
		_, _ = pool.Exec(cleanupCtx, `DELETE FROM bottling_runs WHERE id=$1`, fixture.runID)
		_, _ = pool.Exec(cleanupCtx,
			`DELETE FROM honey_sales WHERE customer_name=$1`, "Serial test "+suffix)
		_, _ = pool.Exec(cleanupCtx, `DELETE FROM harvest_lots WHERE id=$1`, fixture.lotID)
		_, _ = pool.Exec(cleanupCtx, `DELETE FROM app_users WHERE id=$1`, userID)
	})
	fixture.customerName = "Serial test " + suffix
	return fixture
}

func (f *serialFixture) pool() *pgxpool.Pool { return f.server.pool }

func (f *serialFixture) insertSerial(t *testing.T, serial string) string {
	t.Helper()
	if _, err := f.pool().Exec(f.ctx, `
		INSERT INTO jar_serials (bottling_run_id, serial_number) VALUES ($1,$2)`,
		f.runID, serial); err != nil {
		t.Fatalf("insert jar serial %s: %v", serial, err)
	}
	return serial
}

func (f *serialFixture) insertSale(t *testing.T, status string) uuid.UUID {
	t.Helper()
	var id uuid.UUID
	if err := f.pool().QueryRow(f.ctx, `
		INSERT INTO honey_sales (date, customer_name, total_amount_cents, order_status)
		VALUES (now(), $1, 1200, $2) RETURNING id`,
		f.customerName, status).Scan(&id); err != nil {
		t.Fatalf("insert sale: %v", err)
	}
	return id
}

func (f *serialFixture) call(
	t *testing.T,
	handler http.HandlerFunc,
	method, target string,
	body any,
	params map[string]string,
) *httptest.ResponseRecorder {
	t.Helper()
	var request *http.Request
	if body != nil {
		encoded, err := json.Marshal(body)
		if err != nil {
			t.Fatalf("encode body: %v", err)
		}
		request = httptest.NewRequest(method, target, bytes.NewReader(encoded))
		request.Header.Set("Content-Type", "application/json")
	} else {
		request = httptest.NewRequest(method, target, nil)
	}
	routeCtx := chi.NewRouteContext()
	for key, value := range params {
		routeCtx.URLParams.Add(key, value)
	}
	ctx := context.WithValue(f.ctx, chi.RouteCtxKey, routeCtx)
	ctx = context.WithValue(ctx, principalKey, f.user)
	response := httptest.NewRecorder()
	handler(response, request.WithContext(ctx))
	return response
}

func (f *serialFixture) lookup(t *testing.T, serial string) (*httptest.ResponseRecorder, jarSerialLookupJSON) {
	t.Helper()
	response := f.call(t, f.server.jarSerialLookup, http.MethodGet,
		"/honey/serials/"+serial, nil, map[string]string{"serialNumber": serial})
	var item jarSerialLookupJSON
	if response.Code == http.StatusOK {
		if err := json.Unmarshal(response.Body.Bytes(), &item); err != nil {
			t.Fatalf("decode lookup: %v", err)
		}
	}
	return response, item
}

func (f *serialFixture) link(t *testing.T, saleID uuid.UUID, serials ...string) *httptest.ResponseRecorder {
	t.Helper()
	return f.call(t, f.server.saleSerialLink, http.MethodPost,
		"/honey/sales/"+saleID.String()+"/serials",
		map[string]any{"serialNumbers": serials},
		map[string]string{"id": saleID.String()})
}

func TestJarSerialLookupWalksTheChainForAnUnsoldJar(t *testing.T) {
	fixture := newSerialFixture(t)
	serial := fixture.insertSerial(t, fixture.lotCode+"-20260705-AAAAAA-0001")

	response, item := fixture.lookup(t, serial)
	if response.Code != http.StatusOK {
		t.Fatalf("lookup: status %d: %s", response.Code, response.Body.String())
	}
	if item.SerialNumber != serial {
		t.Fatalf("serialNumber = %q, want %q", item.SerialNumber, serial)
	}
	if item.BottlingRun.ID != fixture.runID {
		t.Fatalf("bottlingRun.id = %v, want %v", item.BottlingRun.ID, fixture.runID)
	}
	if item.HarvestLot.ID != fixture.lotID || item.HarvestLot.LotCode != fixture.lotCode {
		t.Fatalf("harvestLot = %+v, want lot %v/%s", item.HarvestLot, fixture.lotID, fixture.lotCode)
	}
	if item.HarvestLot.Variety == nil || *item.HarvestLot.Variety != "Wildflower" {
		t.Fatalf("harvestLot.variety = %v, want Wildflower", item.HarvestLot.Variety)
	}
	if item.Sale != nil {
		t.Fatalf("unsold jar reported a sale: %+v", item.Sale)
	}

	// Serials are read off a jar lid, so case must not matter.
	lowerResponse, lowerItem := fixture.lookup(t, strings.ToLower(serial))
	if lowerResponse.Code != http.StatusOK || lowerItem.SerialNumber != serial {
		t.Fatalf("case-insensitive lookup failed: status %d body %s",
			lowerResponse.Code, lowerResponse.Body.String())
	}

	unknown, _ := fixture.lookup(t, "NO-SUCH-SERIAL-0001")
	if unknown.Code != http.StatusNotFound {
		t.Fatalf("unknown serial: status %d, want 404", unknown.Code)
	}
}

func TestJarSerialLinkSurfacesTheSaleAndIsIdempotent(t *testing.T) {
	fixture := newSerialFixture(t)
	serial := fixture.insertSerial(t, fixture.lotCode+"-20260705-BBBBBB-0001")
	saleID := fixture.insertSale(t, "paid")

	response := fixture.link(t, saleID, serial)
	if response.Code != http.StatusOK {
		t.Fatalf("link: status %d: %s", response.Code, response.Body.String())
	}
	var linked []jarSerialLinkJSON
	if err := json.Unmarshal(response.Body.Bytes(), &linked); err != nil {
		t.Fatalf("decode link response: %v", err)
	}
	if len(linked) != 1 || linked[0].SerialNumber != serial || linked[0].LotCode != fixture.lotCode {
		t.Fatalf("link response = %+v, want one row for %s", linked, serial)
	}

	_, item := fixture.lookup(t, serial)
	if item.Sale == nil {
		t.Fatal("linked jar does not report its sale")
	}
	if item.Sale.ID != saleID || item.Sale.OrderStatus != "paid" || item.Sale.SoldAt == nil {
		t.Fatalf("sale linkage = %+v, want sale %v paid with soldAt", item.Sale, saleID)
	}
	if item.Sale.LinkedByName == nil || *item.Sale.LinkedByName != "Serial test" {
		t.Fatalf("linkedByName = %v, want the session principal", item.Sale.LinkedByName)
	}

	var firstSoldAt time.Time
	if err := fixture.pool().QueryRow(fixture.ctx,
		`SELECT sold_at FROM jar_serials WHERE serial_number=$1`, serial).Scan(&firstSoldAt); err != nil {
		t.Fatalf("read sold_at: %v", err)
	}

	// Re-linking the same jar to the same sale is a retry, not a conflict —
	// and must not rewrite when the jar actually went out.
	again := fixture.link(t, saleID, serial)
	if again.Code != http.StatusOK {
		t.Fatalf("idempotent re-link: status %d: %s", again.Code, again.Body.String())
	}
	var secondSoldAt time.Time
	if err := fixture.pool().QueryRow(fixture.ctx,
		`SELECT sold_at FROM jar_serials WHERE serial_number=$1`, serial).Scan(&secondSoldAt); err != nil {
		t.Fatalf("read sold_at: %v", err)
	}
	if !secondSoldAt.Equal(firstSoldAt) {
		t.Fatalf("re-link rewrote sold_at: %v then %v", firstSoldAt, secondSoldAt)
	}

	listResponse := fixture.call(t, fixture.server.saleSerialList, http.MethodGet,
		"/honey/sales/"+saleID.String()+"/serials", nil,
		map[string]string{"id": saleID.String()})
	if listResponse.Code != http.StatusOK {
		t.Fatalf("list: status %d: %s", listResponse.Code, listResponse.Body.String())
	}
	var list []jarSerialLinkJSON
	if err := json.Unmarshal(listResponse.Body.Bytes(), &list); err != nil {
		t.Fatalf("decode list: %v", err)
	}
	if len(list) != 1 || list[0].SerialNumber != serial {
		t.Fatalf("sale serial list = %+v, want one row for %s", list, serial)
	}
}

func TestJarSerialLinkRejectsTheWholeBatchOnABadSerial(t *testing.T) {
	fixture := newSerialFixture(t)
	owned := fixture.insertSerial(t, fixture.lotCode+"-20260705-CCCCCC-0001")
	free := fixture.insertSerial(t, fixture.lotCode+"-20260705-CCCCCC-0002")
	firstSale := fixture.insertSale(t, "paid")
	secondSale := fixture.insertSale(t, "paid")

	if response := fixture.link(t, firstSale, owned); response.Code != http.StatusOK {
		t.Fatalf("seed link: status %d: %s", response.Code, response.Body.String())
	}

	response := fixture.link(t, secondSale, free, owned)
	if response.Code != http.StatusBadRequest {
		t.Fatalf("cross-sale link: status %d, want 400: %s", response.Code, response.Body.String())
	}
	if !strings.Contains(response.Body.String(), owned) {
		t.Fatalf("error does not name the offending serial: %s", response.Body.String())
	}
	// All-or-nothing: the good serial in the same batch must not have landed.
	var saleID *uuid.UUID
	if err := fixture.pool().QueryRow(fixture.ctx,
		`SELECT sale_id FROM jar_serials WHERE serial_number=$1`, free).Scan(&saleID); err != nil {
		t.Fatalf("read sale_id: %v", err)
	}
	if saleID != nil {
		t.Fatalf("rejected batch still linked %s to %v", free, *saleID)
	}

	unknown := fixture.link(t, secondSale, "GHOST-0001")
	if unknown.Code != http.StatusBadRequest ||
		!strings.Contains(unknown.Body.String(), "GHOST-0001") {
		t.Fatalf("unknown serial: status %d body %s", unknown.Code, unknown.Body.String())
	}
}

func TestJarSerialUnlinkClearsTheLinkage(t *testing.T) {
	fixture := newSerialFixture(t)
	serial := fixture.insertSerial(t, fixture.lotCode+"-20260705-DDDDDD-0001")
	saleID := fixture.insertSale(t, "paid")
	if response := fixture.link(t, saleID, serial); response.Code != http.StatusOK {
		t.Fatalf("link: status %d: %s", response.Code, response.Body.String())
	}

	response := fixture.call(t, fixture.server.saleSerialUnlink, http.MethodDelete,
		"/honey/sales/"+saleID.String()+"/serials/"+serial, nil,
		map[string]string{"id": saleID.String(), "serialNumber": serial})
	if response.Code != http.StatusOK {
		t.Fatalf("unlink: status %d: %s", response.Code, response.Body.String())
	}

	var saleRef *uuid.UUID
	var soldAt *time.Time
	var linkedBy *uuid.UUID
	if err := fixture.pool().QueryRow(fixture.ctx, `
		SELECT sale_id, sold_at, linked_by FROM jar_serials WHERE serial_number=$1`,
		serial).Scan(&saleRef, &soldAt, &linkedBy); err != nil {
		t.Fatalf("read serial: %v", err)
	}
	if saleRef != nil || soldAt != nil || linkedBy != nil {
		t.Fatalf("unlink left residue: sale=%v soldAt=%v linkedBy=%v", saleRef, soldAt, linkedBy)
	}

	// Unlinking a jar that is not on this sale is a 404, not a silent no-op.
	repeat := fixture.call(t, fixture.server.saleSerialUnlink, http.MethodDelete,
		"/honey/sales/"+saleID.String()+"/serials/"+serial, nil,
		map[string]string{"id": saleID.String(), "serialNumber": serial})
	if repeat.Code != http.StatusNotFound {
		t.Fatalf("repeat unlink: status %d, want 404", repeat.Code)
	}
}

func TestJarSerialLinkRejectsCancelledSales(t *testing.T) {
	fixture := newSerialFixture(t)
	serial := fixture.insertSerial(t, fixture.lotCode+"-20260705-EEEEEE-0001")
	saleID := fixture.insertSale(t, "cancelled")

	response := fixture.link(t, saleID, serial)
	if response.Code != http.StatusBadRequest {
		t.Fatalf("cancelled sale link: status %d, want 400: %s", response.Code, response.Body.String())
	}
	var stillFree *uuid.UUID
	if err := fixture.pool().QueryRow(fixture.ctx,
		`SELECT sale_id FROM jar_serials WHERE serial_number=$1`, serial).Scan(&stillFree); err != nil {
		t.Fatalf("read sale_id: %v", err)
	}
	if stillFree != nil {
		t.Fatal("a cancelled sale captured a jar serial")
	}

	missing := fixture.link(t, uuid.New(), serial)
	if missing.Code != http.StatusNotFound {
		t.Fatalf("unknown sale: status %d, want 404", missing.Code)
	}
}
