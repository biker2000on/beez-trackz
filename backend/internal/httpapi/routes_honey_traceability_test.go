package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
	_ "time/tzdata"

	"github.com/google/uuid"
)

// --- A2: forward-dating a record must not clear a withdrawal window --------

func TestDateIsFuture(t *testing.T) {
	day := func(y int, m time.Month, d int, loc *time.Location) time.Time {
		return time.Date(y, m, d, 0, 0, 0, 0, loc)
	}
	at := func(y int, m time.Month, d, hh, mm int) time.Time {
		return time.Date(y, m, d, hh, mm, 0, 0, time.UTC)
	}
	east := time.FixedZone("UTC+10", 10*3600)
	west := time.FixedZone("UTC-08", -8*3600)
	// Spring forward 2026 in America/New_York is 02:00 on Sunday 8 March:
	// EST (-05) before, EDT (-04) after. Embedded via time/tzdata so the case
	// runs on a machine with no system zoneinfo.
	newYork, err := time.LoadLocation("America/New_York")
	if err != nil {
		t.Fatalf("load America/New_York: %v", err)
	}

	// Every case is a genuine cross-midnight instant: the UTC calendar day and
	// the supplied date's local calendar day disagree. Relabelling now.Date()
	// with the date's location (rather than projecting the instant into it)
	// gives the wrong answer on each of them.
	cases := []struct {
		name string
		now  time.Time
		date time.Time
		want bool
	}{
		// Mid-afternoon UTC: already tomorrow ten hours east.
		{"UTC today is allowed", at(2026, 8, 25, 15, 4), day(2026, 8, 25, time.UTC), false},
		{"UTC tomorrow is refused", at(2026, 8, 25, 15, 4), day(2026, 8, 26, time.UTC), true},
		{"a backdated season is allowed", at(2026, 8, 25, 15, 4), day(2025, 6, 1, time.UTC), false},
		{"east of UTC, the operator's own today is allowed",
			at(2026, 8, 25, 15, 4), day(2026, 8, 26, east), false},
		{"east of UTC, their tomorrow is still refused",
			at(2026, 8, 25, 15, 4), day(2026, 8, 27, east), true},
		{"west of UTC at the same instant is a day behind",
			at(2026, 8, 25, 15, 4), day(2026, 8, 25, west), false},
		{"west of UTC, their tomorrow is refused",
			at(2026, 8, 25, 15, 4), day(2026, 8, 26, west), true},

		// Early UTC morning: still yesterday eight hours west. This is the
		// extra bypass day — the west's "25th" has not started yet.
		{"west of UTC, a date their clock has not reached is refused",
			at(2026, 8, 25, 3, 0), day(2026, 8, 25, west), true},
		{"west of UTC, their current day is allowed",
			at(2026, 8, 25, 3, 0), day(2026, 8, 24, west), false},
		{"east of UTC at that instant is on the UTC day",
			at(2026, 8, 25, 3, 0), day(2026, 8, 25, east), false},
		{"east of UTC, their tomorrow is refused",
			at(2026, 8, 25, 3, 0), day(2026, 8, 26, east), true},

		// DST boundary. 06:30 UTC is 01:30 EST on the 8th, minutes before the
		// clocks jump; 07:30 UTC is 03:30 EDT the same morning, minutes after.
		{"New York before the spring-forward jump: that day is today",
			at(2026, 3, 8, 6, 30), day(2026, 3, 8, newYork), false},
		{"New York before the jump: the next day is refused",
			at(2026, 3, 8, 6, 30), day(2026, 3, 9, newYork), true},
		{"New York after the jump: the same day is still today",
			at(2026, 3, 8, 7, 30), day(2026, 3, 8, newYork), false},
		{"New York after the jump: the next day is refused",
			at(2026, 3, 8, 7, 30), day(2026, 3, 9, newYork), true},
		{"New York on the eve of the jump: the jump day is the future",
			at(2026, 3, 8, 4, 0), day(2026, 3, 8, newYork), true},
		{"New York on the eve of the jump: that evening is today",
			at(2026, 3, 8, 4, 0), day(2026, 3, 7, newYork), false},
		{"New York late on the jump day, already tomorrow in UTC",
			at(2026, 3, 9, 3, 30), day(2026, 3, 9, newYork), true},
		{"New York late on the jump day: their day is allowed",
			at(2026, 3, 9, 3, 30), day(2026, 3, 8, newYork), false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := dateIsFuture(tc.date, tc.now); got != tc.want {
				t.Fatalf("dateIsFuture(%s, now=%s) = %v, want %v",
					tc.date.Format(time.RFC3339), tc.now.Format(time.RFC3339),
					got, tc.want)
			}
		})
	}
}

func TestRefuseFutureDateNamesTheField(t *testing.T) {
	msg := refuseFutureDate(time.Now().AddDate(0, 0, 1), "bottledDate")
	if !strings.Contains(msg, "bottledDate") {
		t.Fatalf("refusal %q does not name the field", msg)
	}
	if refuseFutureDate(time.Now().AddDate(0, 0, -1), "bottledDate") != "" {
		t.Fatal("a backdated record was refused; backdating stays legal")
	}
}

// harvestDay renders a calendar date offset from today, so these tests do not
// go stale the way a hard-coded 2026 date would.
func harvestDay(offsetDays int) string {
	return time.Now().AddDate(0, 0, offsetDays).Format("2006-01-02")
}

func TestFutureDatingIsRefusedAtEveryHoneyEntryPoint(t *testing.T) {
	server := honeyTestServer(t)
	_, hiveID := seedLockoutHive(t, server)
	ctx := context.Background()

	var apiaryID uuid.UUID
	if err := server.pool.QueryRow(ctx,
		`SELECT apiary_id FROM hives WHERE id=$1`, hiveID).Scan(&apiaryID); err != nil {
		t.Fatalf("read apiary: %v", err)
	}

	// A lot with a bottling-ready weight and enough bulk honey behind it, so
	// the only thing that can refuse the run is its date.
	seedHarvest(t, server, 60)
	jarSizeID := seedJarSize(t, server, "1 lb", 16, 1200)
	created, body := call(t, server.harvestLotCreate, adminRequest(
		http.MethodPost, "/harvest-lots", map[string]any{
			"lotCode":        "FUTURE-DATE",
			"extractionDate": harvestDay(-5),
			"honeyWeightLbs": 40,
		}))
	if created.Code != http.StatusCreated {
		t.Fatalf("create lot = %d %v", created.Code, body)
	}
	lotID := body["id"].(string)

	cases := []struct {
		name    string
		handler http.HandlerFunc
		request func(date string) *http.Request
	}{
		{
			name:    "bottling run",
			handler: server.bottlingRunCreate,
			request: func(date string) *http.Request {
				return adminRequest(http.MethodPost, "/harvest-lots/x/bottling-runs",
					map[string]any{
						"bottledDate": date, "jarSizeId": jarSizeID.String(), "quantity": 2,
					}, "id", lotID)
			},
		},
		{
			name:    "standalone harvest",
			handler: server.honeyCreateHarvest,
			request: func(date string) *http.Request {
				return adminRequest(http.MethodPost, "/harvests", map[string]any{
					"hiveId": hiveID.String(), "date": date, "harvestedWeight": 5,
				})
			},
		},
		{
			name:    "harvest session",
			handler: server.hsCreate,
			request: func(date string) *http.Request {
				return adminRequest(http.MethodPost, "/harvest-sessions", map[string]any{
					"apiaryId": apiaryID.String(), "date": date,
				})
			},
		},
	}
	for _, tc := range cases {
		t.Run(tc.name+" refuses tomorrow", func(t *testing.T) {
			response, decoded := call(t, tc.handler, tc.request(harvestDay(1)))
			if response.Code != http.StatusUnprocessableEntity {
				t.Fatalf("future-dated %s = %d %v, want 422", tc.name, response.Code, decoded)
			}
			if message, _ := decoded["error"].(string); !strings.Contains(message, "future") {
				t.Fatalf("refusal %q does not explain the future-dating rule", message)
			}
		})
		t.Run(tc.name+" accepts today", func(t *testing.T) {
			response, decoded := call(t, tc.handler, tc.request(harvestDay(0)))
			if response.Code >= 400 {
				t.Fatalf("today's %s = %d %v, want success", tc.name, response.Code, decoded)
			}
		})
	}
}

// TestFutureBottlingCannotStepPastAWithdrawalWindow is the hole itself: the
// lockout is evaluated at the client's date, so before the guard a run dated
// past the window bottled tainted honey with no refusal anywhere.
func TestFutureBottlingCannotStepPastAWithdrawalWindow(t *testing.T) {
	server := honeyTestServer(t)
	_, hiveID := seedLockoutHive(t, server)
	ctx := context.Background()

	applied, removed := harvestDay(-20), harvestDay(-15)
	insertLockoutTreatment(t, server, hiveID, &applied, &removed, 90)

	var harvestID uuid.UUID
	if err := server.pool.QueryRow(ctx, `
		INSERT INTO honey_harvests
			(hive_id, date, super_weight_before, super_weight_after, calculated_honey_weight)
		VALUES ($1,$2,60,0,60) RETURNING id`, hiveID, harvestDay(-10)).Scan(&harvestID); err != nil {
		t.Fatalf("seed tainted harvest: %v", err)
	}
	jarSizeID := seedJarSize(t, server, "1 lb", 16, 1200)
	created, body := call(t, server.harvestLotCreate, adminRequest(
		http.MethodPost, "/harvest-lots", map[string]any{
			"lotCode":        "LOCK-FUTURE",
			"extractionDate": harvestDay(-10),
			"honeyWeightLbs": 40,
			"harvestIds":     []string{harvestID.String()},
		}))
	if created.Code != http.StatusCreated {
		t.Fatalf("create lot = %d %v", created.Code, body)
	}
	lotID := body["id"].(string)

	bottleOn := func(date string) (*httptest.ResponseRecorder, map[string]any) {
		return call(t, server.bottlingRunCreate, adminRequest(
			http.MethodPost, "/harvest-lots/x/bottling-runs", map[string]any{
				"bottledDate": date, "jarSizeId": jarSizeID.String(), "quantity": 2,
			}, "id", lotID))
	}

	response, decoded := bottleOn(harvestDay(0))
	if response.Code != http.StatusConflict {
		t.Fatalf("bottling inside the window = %d %v, want 409", response.Code, decoded)
	}

	// The escape: 120 days out is past the 90-day window, so the lockout
	// evaluates clear. It must now be refused on the date instead.
	response, decoded = bottleOn(harvestDay(120))
	if response.Code != http.StatusUnprocessableEntity {
		t.Fatalf("future-dated bottling = %d %v, want 422", response.Code, decoded)
	}
}

// --- A1: jar sale lines trace back to a lot -------------------------------

// seedTracedRun builds a lot whose honey came from hiveID and bottles jars
// from it, returning the lot id, the run id, and the jar size.
func seedTracedRun(
	t *testing.T,
	server *Server,
	hiveID uuid.UUID,
	lotCode string,
) (lotID, runID, jarSizeID uuid.UUID) {
	t.Helper()
	ctx := context.Background()
	var harvestID uuid.UUID
	if err := server.pool.QueryRow(ctx, `
		INSERT INTO honey_harvests
			(hive_id, date, super_weight_before, super_weight_after, calculated_honey_weight)
		VALUES ($1,$2,60,0,60) RETURNING id`, hiveID, harvestDay(-10)).Scan(&harvestID); err != nil {
		t.Fatalf("seed harvest: %v", err)
	}
	jarSizeID = seedJarSize(t, server, lotCode+" 1 lb", 16, 1200)
	created, body := call(t, server.harvestLotCreate, adminRequest(
		http.MethodPost, "/harvest-lots", map[string]any{
			"lotCode":        lotCode,
			"extractionDate": harvestDay(-10),
			"honeyWeightLbs": 40,
			"harvestIds":     []string{harvestID.String()},
		}))
	if created.Code != http.StatusCreated {
		t.Fatalf("create lot %s = %d %v", lotCode, created.Code, body)
	}
	lotID = uuid.MustParse(body["id"].(string))

	created, body = call(t, server.bottlingRunCreate, adminRequest(
		http.MethodPost, "/harvest-lots/x/bottling-runs", map[string]any{
			"bottledDate": harvestDay(-1), "jarSizeId": jarSizeID.String(), "quantity": 10,
		}, "id", lotID.String()))
	if created.Code != http.StatusCreated {
		t.Fatalf("bottle lot %s = %d %v", lotCode, created.Code, body)
	}
	runID = uuid.MustParse(body["id"].(string))
	return lotID, runID, jarSizeID
}

func TestJarSaleLineCarriesItsBottlingRunAndLot(t *testing.T) {
	server := honeyTestServer(t)
	_, hiveID := seedLockoutHive(t, server)
	lotID, runID, jarSizeID := seedTracedRun(t, server, hiveID, "TRACE-A")

	response, decoded := call(t, server.honeyRecordSale, adminRequest(
		http.MethodPost, "/sales", map[string]any{
			"date":    harvestDay(0),
			"channel": "direct",
			"lines": []map[string]any{{
				"kind": "jar", "jarSizeId": jarSizeID.String(),
				"quantity": 3, "unitPrice": 12, "bottlingRunId": runID.String(),
			}},
		}))
	if response.Code != http.StatusCreated {
		t.Fatalf("traced sale = %d %v", response.Code, decoded)
	}
	saleID := uuid.MustParse(decoded["id"].(string))

	var storedRun *uuid.UUID
	if err := server.pool.QueryRow(context.Background(), `
		SELECT bottling_run_id FROM sale_items WHERE sale_id=$1`, saleID).
		Scan(&storedRun); err != nil {
		t.Fatalf("read sale item: %v", err)
	}
	if storedRun == nil || *storedRun != runID {
		t.Fatalf("stored bottling_run_id = %v, want %s", storedRun, runID)
	}
	if _, err := server.pool.Exec(context.Background(), `
		UPDATE sale_items SET cost_basis_cents=3456 WHERE sale_id=$1`, saleID); err != nil {
		t.Fatalf("seed cost basis: %v", err)
	}

	sales, err := server.honeyListSales(context.Background())
	if err != nil {
		t.Fatalf("list sales: %v", err)
	}
	var seen bool
	for _, sale := range sales {
		if sale.ID != saleID {
			continue
		}
		seen = true
		item := sale.LineItems[0]
		if item.BottlingRunID == nil || *item.BottlingRunID != runID {
			t.Fatalf("line bottlingRunId = %v, want %s", item.BottlingRunID, runID)
		}
		if item.LotID == nil || *item.LotID != lotID {
			t.Fatalf("line lotId = %v, want %s", item.LotID, lotID)
		}
		if item.LotCode == nil || *item.LotCode != "TRACE-A" {
			t.Fatalf("line lotCode = %v, want TRACE-A", item.LotCode)
		}
		if item.CostBasisCents == nil || *item.CostBasisCents != 3456 {
			t.Fatalf("line costBasisCents = %v, want 3456", item.CostBasisCents)
		}
	}
	if !seen {
		t.Fatal("the traced sale is missing from the sale listing")
	}

	listResponse := httptest.NewRecorder()
	server.honeyListSalesHandler(listResponse,
		adminRequest(http.MethodGet, "/honey/sales", nil))
	if listResponse.Code != http.StatusOK {
		t.Fatalf("list sales HTTP = %d: %s", listResponse.Code, listResponse.Body.String())
	}
	var payload []struct {
		ID        uuid.UUID `json:"id"`
		LineItems []struct {
			CostBasisCents *int64 `json:"costBasisCents"`
		} `json:"lineItems"`
	}
	if err := json.Unmarshal(listResponse.Body.Bytes(), &payload); err != nil {
		t.Fatalf("decode sales JSON: %v", err)
	}
	for _, sale := range payload {
		if sale.ID == saleID && len(sale.LineItems) == 1 {
			if got := sale.LineItems[0].CostBasisCents; got == nil || *got != 3456 {
				t.Fatalf("JSON costBasisCents = %v, want 3456", got)
			}
			return
		}
	}
	t.Fatal("the traced sale is missing from the sales JSON")
}

// TestJarSaleFromLockedLotIsRefusedWithoutASaleLevelLot is the gap A1 closes:
// the sale names no harvestLotId, so before the run reference there was
// nothing for refuseLotSale to check.
func TestJarSaleFromLockedLotIsRefusedWithoutASaleLevelLot(t *testing.T) {
	server := honeyTestServer(t)
	_, hiveID := seedLockoutHive(t, server)
	_, runID, jarSizeID := seedTracedRun(t, server, hiveID, "TRACE-LOCK")

	// The treatment lands after the jars are bottled — a mite treatment
	// recorded late, which is exactly when the honey is already in jars.
	applied, removed := harvestDay(-20), harvestDay(-15)
	insertLockoutTreatment(t, server, hiveID, &applied, &removed, 90)

	sale := func(line map[string]any) (*httptest.ResponseRecorder, map[string]any) {
		return call(t, server.honeyRecordSale, adminRequest(
			http.MethodPost, "/sales", map[string]any{
				"date": harvestDay(0), "channel": "direct",
				"lines": []map[string]any{line},
			}))
	}

	// Untraced, the sale still goes through: nothing links it to a lot. That
	// is the residual hole the run reference is opt-in against.
	response, decoded := sale(map[string]any{
		"kind": "jar", "jarSizeId": jarSizeID.String(), "quantity": 1, "unitPrice": 12,
	})
	if response.Code != http.StatusCreated {
		t.Fatalf("untraced sale = %d %v", response.Code, decoded)
	}

	response, decoded = sale(map[string]any{
		"kind": "jar", "jarSizeId": jarSizeID.String(), "quantity": 1, "unitPrice": 12,
		"bottlingRunId": runID.String(),
	})
	if response.Code != http.StatusConflict {
		t.Fatalf("traced sale from a locked lot = %d %v, want 409", response.Code, decoded)
	}
	if message, _ := decoded["error"].(string); !strings.Contains(message, "TRACE-LOCK") {
		t.Fatalf("refusal %q does not name the lot", message)
	}
}

func TestJarSaleBottlingRunValidation(t *testing.T) {
	server := honeyTestServer(t)
	_, hiveID := seedLockoutHive(t, server)
	_, runID, jarSizeID := seedTracedRun(t, server, hiveID, "TRACE-B")
	otherSizeID := seedJarSize(t, server, "12 oz", 12, 900)

	cases := []struct {
		name string
		line map[string]any
		want int
	}{
		{
			name: "unknown run",
			line: map[string]any{
				"kind": "jar", "jarSizeId": jarSizeID.String(), "quantity": 1,
				"unitPrice": 12, "bottlingRunId": uuid.NewString(),
			},
			want: http.StatusBadRequest,
		},
		{
			name: "malformed run id",
			line: map[string]any{
				"kind": "jar", "jarSizeId": jarSizeID.String(), "quantity": 1,
				"unitPrice": 12, "bottlingRunId": "not-a-uuid",
			},
			want: http.StatusBadRequest,
		},
		{
			name: "run filled a different jar size",
			line: map[string]any{
				"kind": "jar", "jarSizeId": otherSizeID.String(), "quantity": 1,
				"unitPrice": 12, "bottlingRunId": runID.String(),
			},
			want: http.StatusBadRequest,
		},
		{
			name: "a colony line cannot carry a run",
			line: map[string]any{
				"kind": "colony", "hiveId": hiveID.String(), "quantity": 1,
				"unitPrice": 200, "bottlingRunId": runID.String(),
			},
			want: http.StatusBadRequest,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			response, decoded := call(t, server.honeyRecordSale, adminRequest(
				http.MethodPost, "/sales", map[string]any{
					"date": harvestDay(0), "channel": "direct",
					"lines": []map[string]any{tc.line},
				}))
			if response.Code != tc.want {
				t.Fatalf("%s = %d %v, want %d", tc.name, response.Code, decoded, tc.want)
			}
		})
	}
}

func TestVoidedBottlingRunCannotBeSold(t *testing.T) {
	server := honeyTestServer(t)
	_, hiveID := seedLockoutHive(t, server)
	_, runID, jarSizeID := seedTracedRun(t, server, hiveID, "TRACE-VOID")

	response, decoded := call(t, server.bottlingRunVoid, adminRequest(
		http.MethodPost, "/bottling-runs/x/void", map[string]any{"reason": "spoiled"},
		"id", runID.String()))
	if response.Code >= 400 {
		t.Fatalf("void run = %d %v", response.Code, decoded)
	}

	response, decoded = call(t, server.honeyRecordSale, adminRequest(
		http.MethodPost, "/sales", map[string]any{
			"date": harvestDay(0), "channel": "direct",
			"lines": []map[string]any{{
				"kind": "jar", "jarSizeId": jarSizeID.String(), "quantity": 1,
				"unitPrice": 12, "bottlingRunId": runID.String(),
			}},
		}))
	if response.Code != http.StatusConflict {
		t.Fatalf("sale off a voided run = %d %v, want 409", response.Code, decoded)
	}
}

func TestJarLinesMergeOnlyWithinTheSameRun(t *testing.T) {
	const size = "11111111-1111-1111-1111-111111111111"
	const runA = "22222222-2222-2222-2222-222222222222"
	const runB = "33333333-3333-3333-3333-333333333333"
	lines, err := normalizeHoneySaleLines([]honeySaleLineInput{
		{Kind: "jar", JarSizeID: size, Quantity: 2, UnitPrice: 1200, BottlingRunID: runA},
		{Kind: "jar", JarSizeID: size, Quantity: 3, UnitPrice: 1200, BottlingRunID: runA},
		{Kind: "jar", JarSizeID: size, Quantity: 4, UnitPrice: 1200, BottlingRunID: runB},
		{Kind: "jar", JarSizeID: size, Quantity: 5, UnitPrice: 1200},
	})
	if err != nil {
		t.Fatalf("normalize: %v", err)
	}
	if len(lines) != 3 {
		t.Fatalf("got %d lines, want 3 (two runs plus the untraced remainder)", len(lines))
	}
	if lines[0].Quantity != 5 {
		t.Fatalf("same-run lines did not merge: quantity %d, want 5", lines[0].Quantity)
	}
	if lines[1].Quantity != 4 || lines[2].Quantity != 5 {
		t.Fatalf("lines merged across runs: %+v", lines)
	}
	if lines[2].BottlingRunID != uuid.Nil {
		t.Fatalf("untraced line picked up a run: %v", lines[2].BottlingRunID)
	}
}

// --- A3: lot weight derived from its harvests ------------------------------

func TestResolveLotWeight(t *testing.T) {
	weight := func(v float64) *float64 { return &v }
	text := func(v string) *string { return &v }

	cases := []struct {
		name        string
		requested   *float64
		source      *string
		entered     *string
		derived     float64
		linked      int
		wantWeight  float64
		wantSource  string
		wantEntered *string
		wantErr     string
	}{
		{
			// Pre-00039 behaviour: an unset weight stored 0 and stayed typed.
			name:       "no weight and no harvests keeps the old empty lot",
			wantSource: lotWeightSourceManual,
		},
		{
			name: "no weight with harvests derives", derived: 41.5, linked: 3,
			wantWeight: 41.5, wantSource: lotWeightSourceDerived,
		},
		{
			name:      "a typed weight stays manual and keeps its sidecar",
			requested: weight(40), entered: text("40 lb"), derived: 41.5, linked: 3,
			wantWeight: 40, wantSource: lotWeightSourceManual, wantEntered: text("40 lb"),
		},
		{
			name:      "an explicit zero is a typed weight, not a missing one",
			requested: weight(0), derived: 41.5, linked: 3,
			wantWeight: 0, wantSource: lotWeightSourceManual,
		},
		{
			name:      "asking for derived overrides a typed weight",
			requested: weight(40), source: text(lotWeightSourceDerived),
			entered: text("40 lb"), derived: 41.5, linked: 3,
			wantWeight: 41.5, wantSource: lotWeightSourceDerived,
		},
		{
			// Deriving from zero harvests is a silent zero-pound lot, which
			// would then refuse every bottling run against it.
			name:    "derived with nothing to sum is refused",
			source:  text(lotWeightSourceDerived),
			wantErr: "at least one linked harvest",
		},
		{
			name:   "manual without a weight is refused",
			source: text(lotWeightSourceManual), derived: 41.5, linked: 3,
			wantErr: "requires honeyWeightLbs",
		},
		{
			name:      "a negative typed weight is refused",
			requested: weight(-1), wantErr: "non-negative",
		},
		{
			name:   "an unknown source is refused",
			source: text("guessed"), wantErr: "'manual' or 'derived'",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			gotWeight, gotSource, gotEntered, errMsg := resolveLotWeight(
				tc.requested, tc.source, tc.entered, tc.derived, tc.linked)
			if tc.wantErr != "" {
				if !strings.Contains(errMsg, tc.wantErr) {
					t.Fatalf("error = %q, want it to mention %q", errMsg, tc.wantErr)
				}
				return
			}
			if errMsg != "" {
				t.Fatalf("unexpected refusal %q", errMsg)
			}
			if gotWeight != tc.wantWeight || gotSource != tc.wantSource {
				t.Fatalf("got (%v, %s), want (%v, %s)",
					gotWeight, gotSource, tc.wantWeight, tc.wantSource)
			}
			switch {
			case tc.wantEntered == nil && gotEntered != nil:
				t.Fatalf("entered = %q, want nil", *gotEntered)
			case tc.wantEntered != nil && (gotEntered == nil || *gotEntered != *tc.wantEntered):
				t.Fatalf("entered = %v, want %q", gotEntered, *tc.wantEntered)
			}
		})
	}
}

func TestHarvestLotWeightDerivesAndRecomputes(t *testing.T) {
	server := honeyTestServer(t)
	_, hiveID := seedLockoutHive(t, server)
	ctx := context.Background()

	seedOne := func(pounds float64) uuid.UUID {
		var id uuid.UUID
		if err := server.pool.QueryRow(ctx, `
			INSERT INTO honey_harvests
				(hive_id, date, super_weight_before, super_weight_after, calculated_honey_weight)
			VALUES ($1,$2,$3,0,$3) RETURNING id`, hiveID, harvestDay(-10), pounds).
			Scan(&id); err != nil {
			t.Fatalf("seed harvest: %v", err)
		}
		return id
	}
	first, second := seedOne(12), seedOne(8)

	created, body := call(t, server.harvestLotCreate, adminRequest(
		http.MethodPost, "/harvest-lots", map[string]any{
			"lotCode":        "DERIVE-1",
			"extractionDate": harvestDay(-10),
			"harvestIds":     []string{first.String(), second.String()},
		}))
	if created.Code != http.StatusCreated {
		t.Fatalf("create lot = %d %v", created.Code, body)
	}
	lotID := body["id"].(string)

	get := func() map[string]any {
		response, decoded := call(t, server.harvestLotGet, adminRequest(
			http.MethodGet, "/harvest-lots/x", nil, "id", lotID))
		if response.Code != http.StatusOK {
			t.Fatalf("get lot = %d %v", response.Code, decoded)
		}
		return decoded
	}
	lot := get()
	if lot["honeyWeightSource"] != lotWeightSourceDerived {
		t.Fatalf("source = %v, want derived", lot["honeyWeightSource"])
	}
	if lot["honeyWeightLbs"] != 20.0 || lot["derivedWeightLbs"] != 20.0 {
		t.Fatalf("weight = %v / derived %v, want 20",
			lot["honeyWeightLbs"], lot["derivedWeightLbs"])
	}
	if lot["linkedHarvestCount"] != 2.0 {
		t.Fatalf("linkedHarvestCount = %v, want 2", lot["linkedHarvestCount"])
	}

	// Dropping a harvest recomputes: a derived weight can never drift from
	// the harvests it claims to summarise.
	update := func(payload map[string]any) (*httptest.ResponseRecorder, map[string]any) {
		payload["lotCode"] = "DERIVE-1"
		payload["extractionDate"] = harvestDay(-10)
		return call(t, server.harvestLotUpdate, adminRequest(
			http.MethodPut, "/harvest-lots/x", payload, "id", lotID))
	}
	response, decoded := update(map[string]any{"harvestIds": []string{first.String()}})
	if response.Code != http.StatusOK {
		t.Fatalf("update lot = %d %v", response.Code, decoded)
	}
	lot = get()
	if lot["honeyWeightLbs"] != 12.0 || lot["honeyWeightSource"] != lotWeightSourceDerived {
		t.Fatalf("after dropping a harvest: %v lbs, source %v; want 12 derived",
			lot["honeyWeightLbs"], lot["honeyWeightSource"])
	}

	// An explicit override takes the lot back to manual and stops tracking.
	response, decoded = update(map[string]any{
		"harvestIds": []string{first.String()}, "honeyWeightLbs": 25,
	})
	if response.Code != http.StatusOK {
		t.Fatalf("manual override = %d %v", response.Code, decoded)
	}
	lot = get()
	if lot["honeyWeightLbs"] != 25.0 || lot["honeyWeightSource"] != lotWeightSourceManual {
		t.Fatalf("after override: %v lbs, source %v; want 25 manual",
			lot["honeyWeightLbs"], lot["honeyWeightSource"])
	}
	if lot["derivedWeightLbs"] != 12.0 {
		t.Fatalf("derivedWeightLbs = %v, want the 12 the harvests still say",
			lot["derivedWeightLbs"])
	}
}

// --- derived lot weight vs. concurrent bottling -----------------------------

// seedDerivedLotHarvest inserts a standalone (sessionless) harvest so the lot
// tests have live pounds to derive from.
func seedDerivedLotHarvest(t *testing.T, server *Server, hiveID uuid.UUID, pounds float64) uuid.UUID {
	t.Helper()
	var id uuid.UUID
	if err := server.pool.QueryRow(context.Background(), `
		INSERT INTO honey_harvests
			(hive_id, date, super_weight_before, super_weight_after, calculated_honey_weight)
		VALUES ($1,$2,$3,0,$3) RETURNING id`, hiveID, harvestDay(-10), pounds).
		Scan(&id); err != nil {
		t.Fatalf("seed harvest: %v", err)
	}
	return id
}

func seedDerivedLot(
	t *testing.T,
	server *Server,
	lotCode string,
	harvestIDs []uuid.UUID,
	extra map[string]any,
) uuid.UUID {
	t.Helper()
	ids := make([]string, len(harvestIDs))
	for i, id := range harvestIDs {
		ids[i] = id.String()
	}
	payload := map[string]any{
		"lotCode": lotCode, "extractionDate": harvestDay(-10), "harvestIds": ids,
	}
	for key, value := range extra {
		payload[key] = value
	}
	created, body := call(t, server.harvestLotCreate, adminRequest(
		http.MethodPost, "/harvest-lots", payload))
	if created.Code != http.StatusCreated {
		t.Fatalf("create lot %s = %d %v", lotCode, created.Code, body)
	}
	return uuid.MustParse(body["id"].(string))
}

func lotStoredWeight(t *testing.T, server *Server, lotID uuid.UUID) float64 {
	t.Helper()
	var lbs float64
	if err := server.pool.QueryRow(context.Background(),
		`SELECT honey_weight_lbs FROM harvest_lots WHERE id=$1`, lotID).Scan(&lbs); err != nil {
		t.Fatalf("read lot weight: %v", err)
	}
	return lbs
}

// A bottling run committing between the update's read of the bottled total and
// its UPDATE used to store a derived weight below what live runs had already
// taken out of the lot. The update now holds the same row lock
// bottlingRunCreate takes, so the two serialise: this test drives the
// interleaving explicitly by holding that lock in another transaction and
// asserting the handler waits for it.
func TestDerivedLotUpdateSerialisesWithBottling(t *testing.T) {
	server := honeyTestServer(t)
	_, hiveID := seedLockoutHive(t, server)
	ctx := context.Background()

	first := seedDerivedLotHarvest(t, server, hiveID, 12)
	second := seedDerivedLotHarvest(t, server, hiveID, 8)
	lotID := seedDerivedLot(t, server, "RACE-1", []uuid.UUID{first, second}, nil)
	if got := lotStoredWeight(t, server, lotID); got != 20 {
		t.Fatalf("seeded lot = %v lbs, want 20", got)
	}
	jarSizeID := seedJarSize(t, server, "RACE-1 1 lb", 16, 1200)

	// The bottling side of the race: lock the lot the way bottlingRunCreate
	// does, then insert a run that uses 15 of the lot's 20 lbs. Uncommitted, so
	// a handler reading the bottled total without the lock still sees 0.
	bottling, err := server.pool.Begin(ctx)
	if err != nil {
		t.Fatalf("begin bottling tx: %v", err)
	}
	defer bottling.Rollback(ctx)
	var lockedCode string
	if err := bottling.QueryRow(ctx,
		`SELECT lot_code FROM harvest_lots WHERE id=$1 FOR UPDATE`, lotID).
		Scan(&lockedCode); err != nil {
		t.Fatalf("lock lot: %v", err)
	}
	if _, err := bottling.Exec(ctx, `
		INSERT INTO bottling_runs (lot_id, bottled_date, jar_size_id, quantity, honey_lbs)
		VALUES ($1, current_date, $2, 15, 15)`, lotID, jarSizeID); err != nil {
		t.Fatalf("insert run: %v", err)
	}

	// Drop the 8 lb harvest: the lot would derive 12 lbs, below the 15 the run
	// in flight has already used.
	payload, err := json.Marshal(map[string]any{
		"lotCode": "RACE-1", "extractionDate": harvestDay(-10),
		"harvestIds": []string{first.String()},
	})
	if err != nil {
		t.Fatalf("encode payload: %v", err)
	}
	request := adminRequest(http.MethodPut, "/harvest-lots/x", nil, "id", lotID.String())
	request.Body = io.NopCloser(bytes.NewReader(payload))
	response := httptest.NewRecorder()
	done := make(chan struct{})
	go func() {
		defer close(done)
		server.harvestLotUpdate(response, request)
	}()

	select {
	case <-done:
		t.Fatal("harvestLotUpdate finished while another transaction held the lot " +
			"row: it reads the bottled total without taking the lock, so a run can " +
			"commit underneath it")
	case <-time.After(750 * time.Millisecond):
	}

	if err := bottling.Commit(ctx); err != nil {
		t.Fatalf("commit bottling tx: %v", err)
	}
	select {
	case <-done:
	case <-time.After(20 * time.Second):
		t.Fatal("harvestLotUpdate never returned after the lock was released")
	}

	if response.Code != http.StatusBadRequest {
		t.Fatalf("update = %d %s, want 400: the run that committed first used "+
			"more pounds than the new derivation", response.Code, response.Body)
	}
	if !strings.Contains(response.Body.String(), "15.00") {
		t.Errorf("refusal %q does not name the already-bottled pounds", response.Body)
	}
	if got := lotStoredWeight(t, server, lotID); got != 20 {
		t.Errorf("lot weight = %v, want the original 20 lbs left intact", got)
	}
}

// --- soft-deleting a harvest behind a derived lot ---------------------------

func TestSoftDeletingAHarvestRecomputesItsDerivedLot(t *testing.T) {
	server := honeyTestServer(t)
	_, hiveID := seedLockoutHive(t, server)

	first := seedDerivedLotHarvest(t, server, hiveID, 12)
	second := seedDerivedLotHarvest(t, server, hiveID, 8)
	lotID := seedDerivedLot(t, server, "DELETE-DERIVED", []uuid.UUID{first, second}, nil)

	response, body := call(t, server.hsDeleteEntry, adminRequest(
		http.MethodDelete, "/harvest-entries/x",
		map[string]any{"reason": "double counted"}, "id", second.String()))
	if response.Code != http.StatusOK {
		t.Fatalf("delete entry = %d %v", response.Code, body)
	}
	if got := lotStoredWeight(t, server, lotID); got != 12 {
		t.Fatalf("lot weight = %v lbs, want 12: a derived lot may not keep "+
			"claiming pounds from a harvest that no longer exists", got)
	}
}

// A harvest that stands behind bottled jars cannot leave, whatever the lot's
// weight would recompute to. lotLockoutAsOf and refuseLotBottling walk a lot's
// live harvests back to their hives for the treatment covering them, so a
// harvest that vanished from under a bottled lot takes the withdrawal window
// that justified those jars out of the record with it.
func TestSoftDeleteRefusedWhileBottlingRunsStandOnTheLot(t *testing.T) {
	server := honeyTestServer(t)
	_, hiveID := seedLockoutHive(t, server)
	ctx := context.Background()

	first := seedDerivedLotHarvest(t, server, hiveID, 30)
	second := seedDerivedLotHarvest(t, server, hiveID, 10)
	// Unlinked bulk honey, so the delete is not stopped by the bulk-ledger
	// guard before it ever reaches the lot check.
	seedDerivedLotHarvest(t, server, hiveID, 100)
	lotID := seedDerivedLot(t, server, "DELETE-BOTTLED", []uuid.UUID{first, second}, nil)

	jarSizeID := seedJarSize(t, server, "DELETE-BOTTLED 1 lb", 16, 1200)
	created, body := call(t, server.bottlingRunCreate, adminRequest(
		http.MethodPost, "/harvest-lots/x/bottling-runs", map[string]any{
			"bottledDate": harvestDay(-1), "jarSizeId": jarSizeID.String(), "quantity": 12,
		}, "id", lotID.String()))
	if created.Code != http.StatusCreated {
		t.Fatalf("bottle lot = %d %v", created.Code, body)
	}
	runID := body["id"].(string)

	// Not just the harvest whose pounds the runs needed: ANY harvest behind a
	// bottled lot is part of the jars' provenance. `second` is only 10 of the
	// lot's 40 lbs and the runs used 12, so the weight ceiling alone would let
	// it go.
	for _, harvest := range []uuid.UUID{first, second} {
		response, decoded := call(t, server.hsDeleteEntry, adminRequest(
			http.MethodDelete, "/harvest-entries/x",
			map[string]any{"reason": "mis-keyed"}, "id", harvest.String()))
		if response.Code != http.StatusConflict {
			t.Fatalf("delete entry = %d %v, want 409: a non-voided bottling run "+
				"still stands on the lot", response.Code, decoded)
		}
		message, _ := decoded["error"].(string)
		for _, want := range []string{"DELETE-BOTTLED", "Void"} {
			if !strings.Contains(message, want) {
				t.Errorf("refusal %q does not mention %q", message, want)
			}
		}
	}

	// Refused means refused: the harvests are still live and the lot untouched,
	// so the bottled jars keep the harvests — and their hive's treatment
	// history — behind them.
	for _, harvest := range []uuid.UUID{first, second} {
		var deletedAt *time.Time
		if err := server.pool.QueryRow(ctx,
			`SELECT deleted_at FROM honey_harvests WHERE id=$1`, harvest).
			Scan(&deletedAt); err != nil {
			t.Fatalf("read harvest: %v", err)
		}
		if deletedAt != nil {
			t.Error("the harvest was soft-deleted despite the refusal")
		}
	}
	if got := lotStoredWeight(t, server, lotID); got != 40 {
		t.Errorf("lot weight = %v, want the original 40 lbs", got)
	}

	// Voiding the run is the deliberate act the refusal asks for. Once the
	// jars are gone the harvest leaves freely and the lot recomputes.
	voided, decoded := call(t, server.bottlingRunVoid, adminRequest(
		http.MethodPost, "/bottling-runs/x/void", map[string]any{"reason": "recalled"},
		"id", runID))
	if voided.Code >= 400 {
		t.Fatalf("void run = %d %v", voided.Code, decoded)
	}
	response, decoded := call(t, server.hsDeleteEntry, adminRequest(
		http.MethodDelete, "/harvest-entries/x",
		map[string]any{"reason": "mis-keyed"}, "id", first.String()))
	if response.Code != http.StatusOK {
		t.Fatalf("delete after voiding = %d %v, want 200", response.Code, decoded)
	}
	if got := lotStoredWeight(t, server, lotID); got != 10 {
		t.Errorf("lot weight = %v, want 10 after the 30 lb harvest left", got)
	}
}

// A manual weight is no exemption. The old rule skipped manual lots because
// nothing about their number changes when a harvest leaves — but the jars'
// treatment provenance is not their number.
func TestSoftDeleteRefusedWhileRunsStandOnAManualLot(t *testing.T) {
	server := honeyTestServer(t)
	_, hiveID := seedLockoutHive(t, server)

	first := seedDerivedLotHarvest(t, server, hiveID, 30)
	seedDerivedLotHarvest(t, server, hiveID, 100)
	lotID := seedDerivedLot(t, server, "DELETE-MANUAL-BOTTLED", []uuid.UUID{first},
		map[string]any{"honeyWeightLbs": 30})

	jarSizeID := seedJarSize(t, server, "DELETE-MANUAL-BOTTLED 1 lb", 16, 1200)
	created, body := call(t, server.bottlingRunCreate, adminRequest(
		http.MethodPost, "/harvest-lots/x/bottling-runs", map[string]any{
			"bottledDate": harvestDay(-1), "jarSizeId": jarSizeID.String(), "quantity": 4,
		}, "id", lotID.String()))
	if created.Code != http.StatusCreated {
		t.Fatalf("bottle lot = %d %v", created.Code, body)
	}

	response, decoded := call(t, server.hsDeleteEntry, adminRequest(
		http.MethodDelete, "/harvest-entries/x", nil, "id", first.String()))
	if response.Code != http.StatusConflict {
		t.Fatalf("delete entry = %d %v, want 409: the manual lot's jars still "+
			"trace their treatment history through this harvest",
			response.Code, decoded)
	}
	if got := lotStoredWeight(t, server, lotID); got != 30 {
		t.Errorf("lot weight = %v, want the typed 30 lbs", got)
	}
}

func TestSoftDeletingAHarvestLeavesAManualLotWeightAlone(t *testing.T) {
	server := honeyTestServer(t)
	_, hiveID := seedLockoutHive(t, server)

	first := seedDerivedLotHarvest(t, server, hiveID, 12)
	second := seedDerivedLotHarvest(t, server, hiveID, 8)
	lotID := seedDerivedLot(t, server, "DELETE-MANUAL", []uuid.UUID{first, second},
		map[string]any{"honeyWeightLbs": 25})

	response, body := call(t, server.hsDeleteEntry, adminRequest(
		http.MethodDelete, "/harvest-entries/x", nil, "id", second.String()))
	if response.Code != http.StatusOK {
		t.Fatalf("delete entry = %d %v", response.Code, body)
	}
	if got := lotStoredWeight(t, server, lotID); got != 25 {
		t.Fatalf("lot weight = %v, want the typed 25 lbs: a manual weight is "+
			"not derived from the harvests and must not move", got)
	}
}
