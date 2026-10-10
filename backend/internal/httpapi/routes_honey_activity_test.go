package httpapi

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"reflect"
	"testing"
	"time"

	"github.com/google/uuid"
)

func TestHoneyActivityCursorRoundTrips(t *testing.T) {
	want := honeyActivityCursor{
		At: time.Date(2026, 10, 9, 14, 3, 7, 123456000, time.UTC),
		ID: uuid.MustParse("0b5f2a8e-4c1d-4b7a-9e2f-6a1c3d5e7f90"),
	}
	got, err := decodeHoneyActivityCursor(encodeHoneyActivityCursor(want))
	if err != nil {
		t.Fatalf("decode: %v", err)
	}
	if !got.At.Equal(want.At) || got.ID != want.ID {
		t.Fatalf("round trip = %+v, want %+v", got, want)
	}
	for _, bad := range []string{"!!", "bm9waXBl", "MjAyNi0xMC0wOXxub3QtYS11dWlk"} {
		if _, err := decodeHoneyActivityCursor(bad); err == nil {
			t.Errorf("cursor %q decoded; want an error", bad)
		}
	}
}

func TestHoneyActivityTypesAndTerms(t *testing.T) {
	got, err := parseHoneyActivityTypes([]string{"sale,jarring", "sale", " loss "})
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if want := []string{"sale", "jarring", "loss"}; !reflect.DeepEqual(got, want) {
		t.Errorf("types = %v, want %v", got, want)
	}
	if _, err := parseHoneyActivityTypes([]string{"sale,bogus"}); err == nil {
		t.Error("unknown type accepted")
	}
	none, err := parseHoneyActivityTypes(nil)
	if err != nil || none == nil || len(none) != 0 {
		// A nil slice would reach Postgres as NULL and match nothing.
		t.Errorf("no types = %#v, %v; want an empty non-nil slice", none, err)
	}
	if got := honeyActivitySearchTerms("  Pint   MARKET "); !reflect.DeepEqual(got, []string{"pint", "market"}) {
		t.Errorf("terms = %v", got)
	}
	if got := honeyActivitySearchTerms(""); got == nil || len(got) != 0 {
		t.Errorf("empty terms = %#v; want an empty non-nil slice", got)
	}
}

func TestHoneyActivityRejectsBadCursorAndType(t *testing.T) {
	server := &Server{}
	for _, target := range []string{
		"/api/v1/honey/activity?cursor=%21%21",
		"/api/v1/honey/activity?type=bogus",
	} {
		response := httptest.NewRecorder()
		server.honeyActivityHandler(response, httptest.NewRequest(http.MethodGet, target, nil))
		if response.Code != http.StatusBadRequest {
			t.Errorf("%s = %d, want 400", target, response.Code)
		}
	}
}

func TestHoneyActivitySaleEntrySentence(t *testing.T) {
	cents := int64(2400)
	status, location, customer, summary := "cancelled", "Market", "Pat", "2 × Pint"
	entry := honeyActivitySaleEntry(uuid.New(), time.Now(), 2, &cents,
		&status, &location, &customer, &summary, nil)
	if entry.Description != "Cancelled: Sold 2 × Pint @ Market to Pat" {
		t.Errorf("description = %q", entry.Description)
	}
	if !entry.Cancelled || entry.TotalAmount == nil || *entry.TotalAmount != 2400 {
		t.Errorf("entry = %+v", entry)
	}
}

// --- DB-backed ---

func fetchHoneyActivity(t *testing.T, server *Server, params url.Values) honeyActivityPage {
	t.Helper()
	response := httptest.NewRecorder()
	server.honeyActivityHandler(response, adminRequest(http.MethodGet,
		"/api/v1/honey/activity?"+params.Encode(), nil))
	if response.Code != http.StatusOK {
		t.Fatalf("activity %v = %d %s", params, response.Code, response.Body.String())
	}
	var page honeyActivityPage
	if err := json.Unmarshal(response.Body.Bytes(), &page); err != nil {
		t.Fatalf("decode activity page: %v", err)
	}
	return page
}

// pageAllHoneyActivity follows nextCursor to the end and returns every row.
func pageAllHoneyActivity(t *testing.T, server *Server, params url.Values) []honeyTimelineEntry {
	t.Helper()
	var all []honeyTimelineEntry
	cursor := ""
	for guard := 0; guard < 100; guard++ {
		query := url.Values{}
		for k, v := range params {
			query[k] = v
		}
		if cursor != "" {
			query.Set("cursor", cursor)
		}
		page := fetchHoneyActivity(t, server, query)
		all = append(all, page.Entries...)
		if page.NextCursor == nil {
			return all
		}
		if *page.NextCursor == cursor {
			t.Fatal("nextCursor did not advance")
		}
		cursor = *page.NextCursor
	}
	t.Fatal("activity paging did not terminate")
	return nil
}

func TestHoneyActivityKeysetPagesTheWholeLedger(t *testing.T) {
	server := honeyTestServer(t)
	jarSizeID := seedJarSize(t, server, "Pint", 16, 1200)
	seedHarvest(t, server, 100)
	// Sales name the lot their jars come off, so the fixture keeps the lot id.
	lotID := seedFixtureLot(t, server, 12)
	jarStockFromLot(t, server, lotID, jarSizeID, 12)

	today := time.Now().Format("2006-01-02")
	for _, delta := range []int{2, -1, 3} {
		response, body := call(t, server.honeyAdjustJarCounts, adminRequest(
			http.MethodPost, "/api/v1/honey/jar-adjustments", map[string]any{
				"date":   today,
				"reason": "recount",
				"lines":  []map[string]any{{"jarSizeId": jarSizeID.String(), "delta": delta}},
			}))
		if response.Code != http.StatusOK {
			t.Fatalf("adjustment = %d %v", response.Code, body)
		}
	}
	var saleIDs []string
	for i, location := range []string{"Farmers Market", "Roadside stand"} {
		response, body := call(t, server.honeyRecordSale, adminRequest(
			http.MethodPost, "/api/v1/sales", map[string]any{
				"date":         today,
				"location":     location,
				"harvestLotId": lotID.String(),
				"lines": []map[string]any{
					{"jarSizeId": jarSizeID.String(), "quantity": i + 1, "unitPrice": 12},
				},
			}))
		if response.Code != http.StatusOK && response.Code != http.StatusCreated {
			t.Fatalf("sale = %d %v", response.Code, body)
		}
		id, _ := body["id"].(string)
		if id == "" {
			t.Fatalf("no sale id in %v", body)
		}
		saleIDs = append(saleIDs, id)
	}

	reference := fetchHoneyActivity(t, server, url.Values{"limit": {"200"}})
	if reference.NextCursor != nil {
		t.Fatalf("a 200-row page of a small ledger has a nextCursor")
	}
	if len(reference.Entries) < 6 {
		t.Fatalf("reference page has %d rows, want at least 6 (receipt, jarring, 3 adjustments, 2 sales)",
			len(reference.Entries))
	}

	// Every row appears exactly once and the order never goes backwards:
	// (date DESC, id DESC). Most rows share today's date, so the id
	// tie-break is what keeps the pages apart.
	paged := pageAllHoneyActivity(t, server, url.Values{"limit": {"2"}})
	if len(paged) != len(reference.Entries) {
		t.Fatalf("paged %d rows, reference has %d", len(paged), len(reference.Entries))
	}
	for i := range paged {
		if paged[i].ID != reference.Entries[i].ID {
			t.Fatalf("row %d: paged %s, reference %s", i, paged[i].ID, reference.Entries[i].ID)
		}
		if i == 0 {
			continue
		}
		prev, cur := paged[i-1], paged[i]
		if cur.Date.After(prev.Date) ||
			(cur.Date.Equal(prev.Date) && cur.ID.String() >= prev.ID.String()) {
			t.Fatalf("row %d (%s %s) is not after row %d (%s %s)",
				i, cur.Date, cur.ID, i-1, prev.Date, prev.ID)
		}
	}

	// A sale is one row: its stock consumption is not listed again.
	sales := 0
	for _, entry := range reference.Entries {
		if entry.Type == "sale" {
			sales++
			if entry.TotalAmount == nil {
				t.Errorf("sale row %s has no total", entry.ID)
			}
		}
	}
	if sales != len(saleIDs) {
		t.Errorf("sale rows = %d, want %d (one per sale)", sales, len(saleIDs))
	}

	// Filters are applied before paging.
	adjustments := pageAllHoneyActivity(t, server, url.Values{
		"limit": {"1"}, "type": {"jar_adjustment"},
	})
	if len(adjustments) != 3 {
		t.Errorf("jar_adjustment rows = %d, want 3", len(adjustments))
	}
	for _, entry := range adjustments {
		if entry.Type != "jar_adjustment" {
			t.Errorf("type filter let through %q", entry.Type)
		}
	}
	market := pageAllHoneyActivity(t, server, url.Values{"limit": {"1"}, "q": {"farmers MARKET"}})
	if len(market) != 1 || market[0].ID.String() != saleIDs[0] {
		t.Errorf("search rows = %+v, want only the farmers market sale", market)
	}
	none := fetchHoneyActivity(t, server, url.Values{"q": {"no-such-thing"}})
	if len(none.Entries) != 0 || none.NextCursor != nil {
		t.Errorf("unmatched search = %+v, want an empty last page", none)
	}
}
