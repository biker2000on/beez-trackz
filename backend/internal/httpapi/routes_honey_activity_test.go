package httpapi

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/biker2000on/beez-trackz/backend/internal/app/production"
	"github.com/google/uuid"
)

func TestHoneyActivityCursorRoundTrips(t *testing.T) {
	id := uuid.MustParse("0b5f2a8e-4c1d-4b7a-9e2f-6a1c3d5e7f90")
	for _, want := range []honeyActivityCursor{
		{Sort: "date", Dir: "desc", Key: "2026-10-09T14:03:07.123456Z", ID: id},
		{Sort: "quantity", Dir: "asc", Key: "-12.5", ID: id},
		{Sort: "type", Dir: "desc", Key: "give-away", ID: id},
		// A text key may contain the separator.
		{Sort: "item", Dir: "asc", Key: "pint | squeeze", ID: id},
		{Sort: "item", Dir: "asc", Key: "", ID: id},
	} {
		got, err := decodeHoneyActivityCursor(encodeHoneyActivityCursor(want))
		if err != nil {
			t.Fatalf("decode %+v: %v", want, err)
		}
		if got != want {
			t.Fatalf("round trip = %+v, want %+v", got, want)
		}
	}
	encode := func(raw string) string { return base64.RawURLEncoding.EncodeToString([]byte(raw)) }
	for _, bad := range []string{
		"!!",
		"bm9waXBl",
		encode("date|desc|not-a-uuid|2026-10-09T00:00:00Z"),
		encode("bogus|desc|" + id.String() + "|x"),
		encode("date|sideways|" + id.String() + "|2026-10-09T00:00:00Z"),
		encode("date|desc|" + id.String() + "|yesterday"),
		encode("quantity|asc|" + id.String() + "|lots"),
		// The pre-sort cursor format ("<time>|<id>").
		encode("2026-10-09T00:00:00Z|" + id.String()),
	} {
		if _, err := decodeHoneyActivityCursor(bad); err == nil {
			t.Errorf("cursor %q decoded; want an error", bad)
		}
	}
}

func TestHoneyActivitySortKeyTextParsesBack(t *testing.T) {
	at := time.Date(2026, 10, 9, 14, 3, 7, 123456000, time.FixedZone("x", -5*3600))
	key, err := honeyActivityCursorKey("date", honeyActivitySortKeyText("date", at, 0, "", ""))
	if err != nil || !key.(time.Time).Equal(at) {
		t.Errorf("date key = %v, %v; want %v", key, err, at)
	}
	for _, qty := range []float64{-3, 0.1, 1.0 / 3, 1e-7, 12} {
		key, err := honeyActivityCursorKey("quantity",
			honeyActivitySortKeyText("quantity", at, qty, "", ""))
		if err != nil || key.(float64) != qty {
			t.Errorf("quantity key = %v, %v; want exactly %v", key, err, qty)
		}
	}
	if got := honeyActivitySortKeyText("type", at, 0, "sale", "pint"); got != "sale" {
		t.Errorf("type key = %q", got)
	}
	if got := honeyActivitySortKeyText("item", at, 0, "sale", "pint"); got != "pint" {
		t.Errorf("item key = %q", got)
	}
}

func TestHoneyActivitySortDefaultsAndQuery(t *testing.T) {
	for _, tc := range []struct{ sort, dir, wantSort, wantDir string }{
		{"", "", "date", "desc"},
		{"date", "", "date", "desc"},
		{"date", "ASC", "date", "asc"},
		{"quantity", "", "quantity", "asc"},
		{"item", "desc", "item", "desc"},
	} {
		sort, dir, err := parseHoneyActivitySort(tc.sort, tc.dir)
		if err != nil || sort != tc.wantSort || dir != tc.wantDir {
			t.Errorf("parse(%q, %q) = %q %q %v; want %q %q",
				tc.sort, tc.dir, sort, dir, err, tc.wantSort, tc.wantDir)
		}
	}
	for _, bad := range [][2]string{{"description", ""}, {"date", "up"}} {
		if _, _, err := parseHoneyActivitySort(bad[0], bad[1]); err == nil {
			t.Errorf("parse(%q, %q) accepted", bad[0], bad[1])
		}
	}

	for _, tc := range []struct{ sort, dir, keyset, order string }{
		{"quantity", "desc", "(qty_sort, id) < ($9::float8, $10::uuid)", "ORDER BY qty_sort DESC, id DESC"},
		{"item", "asc", "(item_sort, id) > ($9::text, $10::uuid)", "ORDER BY item_sort ASC, id ASC"},
		{"type", "asc", "(type_sort, id) > ($9::text, $10::uuid)", "ORDER BY type_sort ASC, id ASC"},
		{"date", "desc", "(occurred_at, id) < ($9::timestamptz, $10::uuid)", "ORDER BY occurred_at DESC, id DESC"},
	} {
		query := honeyActivityQuery(tc.sort, tc.dir)
		if !strings.Contains(query, tc.keyset) || !strings.Contains(query, tc.order) {
			t.Errorf("%s %s query lacks %q / %q", tc.sort, tc.dir, tc.keyset, tc.order)
		}
	}
}

func TestHoneyActivityFilterParsing(t *testing.T) {
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

	jar := uuid.New()
	items, err := parseHoneyActivityItems([]string{"bulk,jar:" + jar.String(), "bulk"})
	if err != nil || !reflect.DeepEqual(items, []string{"bulk", "jar:" + jar.String()}) {
		t.Errorf("items = %v, %v", items, err)
	}
	for _, bad := range []string{"jar:nope", "pint", jar.String()} {
		if _, err := parseHoneyActivityItems([]string{bad}); err == nil {
			t.Errorf("item %q accepted", bad)
		}
	}
	noItems, err := parseHoneyActivityItems(nil)
	if err != nil || noItems == nil || len(noItems) != 0 {
		t.Errorf("no items = %#v, %v; want an empty non-nil slice", noItems, err)
	}

	ids, err := parseHoneyActivityIDs("location", []string{strings.ToUpper(jar.String())})
	if err != nil || !reflect.DeepEqual(ids, []string{jar.String()}) {
		t.Errorf("ids = %v, %v; want the canonical lower-case form", ids, err)
	}
	noIDs, err := parseHoneyActivityIDs("location", nil)
	if err != nil || noIDs == nil || len(noIDs) != 0 {
		t.Errorf("no ids = %#v, %v; want an empty non-nil slice", noIDs, err)
	}
	if _, err := parseHoneyActivityIDs("varietal", []string{"wildflower"}); err == nil {
		t.Error("non-uuid varietal accepted")
	}

	if got := honeyActivitySearchTerms("  Pint   MARKET "); !reflect.DeepEqual(got, []string{"pint", "market"}) {
		t.Errorf("terms = %v", got)
	}
	if got := honeyActivitySearchTerms(""); got == nil || len(got) != 0 {
		t.Errorf("empty terms = %#v; want an empty non-nil slice", got)
	}
}

func TestHoneyActivityRejectsBadParams(t *testing.T) {
	server := &Server{}
	dateCursor := encodeHoneyActivityCursor(honeyActivityCursor{
		Sort: "date", Dir: "desc", Key: "2026-10-09T00:00:00Z", ID: uuid.New(),
	})
	for _, target := range []string{
		"/api/v1/honey/activity?cursor=%21%21",
		"/api/v1/honey/activity?type=bogus",
		"/api/v1/honey/activity?sort=description",
		"/api/v1/honey/activity?sort=date&dir=up",
		"/api/v1/honey/activity?item=pint",
		"/api/v1/honey/activity?varietal=wildflower",
		"/api/v1/honey/activity?location=home",
		// A cursor only continues the sort it was made under.
		"/api/v1/honey/activity?sort=quantity&cursor=" + dateCursor,
		"/api/v1/honey/activity?sort=date&dir=asc&cursor=" + dateCursor,
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
func pageAllHoneyActivity(t *testing.T, server *Server, params url.Values) []honeyActivityEntry {
	t.Helper()
	var all []honeyActivityEntry
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

func entryIDs(entries []honeyActivityEntry) []string {
	ids := make([]string, len(entries))
	for i, entry := range entries {
		ids[i] = entry.ID.String()
	}
	return ids
}

// honeyActivityLedgerFixture records a small mixed ledger: a lot receipt, a
// jarring, three jar adjustments and two sales, all today.
type honeyActivityLedgerFixture struct {
	jarSizeID  uuid.UUID
	lotID      uuid.UUID
	varietalID uuid.UUID
	saleIDs    []string
}

func seedHoneyActivityLedger(t *testing.T, server *Server) honeyActivityLedgerFixture {
	t.Helper()
	ctx := context.Background()
	jarSizeID := seedJarSize(t, server, "Pint", 16, 1200)
	seedHarvest(t, server, 100)
	// Sales name the lot their jars come off, so the fixture keeps the lot id.
	lotID := seedFixtureLot(t, server, 12)

	var varietalID uuid.UUID
	if err := server.pool.QueryRow(ctx, `
		INSERT INTO honey_varietals (name) VALUES ($1)
		ON CONFLICT ((lower(name))) DO UPDATE SET name = EXCLUDED.name
		RETURNING id`, "Activity Clover").Scan(&varietalID); err != nil {
		t.Fatalf("seed varietal: %v", err)
	}
	if _, err := server.pool.Exec(ctx,
		`UPDATE harvest_lots SET varietal_id = $1 WHERE id = $2`, varietalID, lotID); err != nil {
		t.Fatalf("name lot varietal: %v", err)
	}
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
	return honeyActivityLedgerFixture{
		jarSizeID: jarSizeID, lotID: lotID, varietalID: varietalID, saleIDs: saleIDs,
	}
}

func TestHoneyActivityKeysetPagesTheWholeLedger(t *testing.T) {
	server := honeyTestServer(t)
	fixture := seedHoneyActivityLedger(t, server)

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
	if !reflect.DeepEqual(entryIDs(paged), entryIDs(reference.Entries)) {
		t.Fatalf("paged %v, reference %v", entryIDs(paged), entryIDs(reference.Entries))
	}
	for i := 1; i < len(paged); i++ {
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
			if entry.Qty >= 0 || entry.QtyUnit != "jars" || entry.Item != "Pint" {
				t.Errorf("sale row %s: qty %v %q item %q; want negative jars of Pint",
					entry.ID, entry.Qty, entry.QtyUnit, entry.Item)
			}
		}
	}
	if sales != len(fixture.saleIDs) {
		t.Errorf("sale rows = %d, want %d (one per sale)", sales, len(fixture.saleIDs))
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
	if len(market) != 1 || market[0].ID.String() != fixture.saleIDs[0] {
		t.Errorf("search rows = %+v, want only the farmers market sale", market)
	}
	none := fetchHoneyActivity(t, server, url.Values{"q": {"no-such-thing"}})
	if len(none.Entries) != 0 || none.NextCursor != nil {
		t.Errorf("unmatched search = %+v, want an empty last page", none)
	}
}

// Every sort pages to exactly the rows of one big page, in the same order,
// and that order really is sorted by the key with ids breaking ties.
func TestHoneyActivitySortsPageStably(t *testing.T) {
	server := honeyTestServer(t)
	seedHoneyActivityLedger(t, server)

	typeLabel := map[string]string{
		"jar_adjustment": "adjustment", "bulk_use": "bulk use", "give_away": "give-away",
	}
	keyOf := func(sort string, entry honeyActivityEntry) string {
		switch sort {
		case "type":
			if label, ok := typeLabel[entry.Type]; ok {
				return label
			}
			return entry.Type
		case "item":
			return strings.ToLower(entry.Item)
		}
		return ""
	}
	for _, tc := range []struct{ sort, dir string }{
		{"date", "asc"}, {"date", "desc"},
		{"quantity", "asc"}, {"quantity", "desc"},
		{"type", "asc"}, {"type", "desc"},
		{"item", "asc"}, {"item", "desc"},
	} {
		params := url.Values{"sort": {tc.sort}, "dir": {tc.dir}}
		reference := fetchHoneyActivity(t, server, url.Values{
			"sort": {tc.sort}, "dir": {tc.dir}, "limit": {"200"},
		})
		params.Set("limit", "2")
		paged := pageAllHoneyActivity(t, server, params)
		if !reflect.DeepEqual(entryIDs(paged), entryIDs(reference.Entries)) {
			t.Errorf("%s %s: paged %v, reference %v", tc.sort, tc.dir,
				entryIDs(paged), entryIDs(reference.Entries))
			continue
		}
		for i := 1; i < len(paged); i++ {
			prev, cur := paged[i-1], paged[i]
			// cmp < 0: cur sorts before prev in ascending key order.
			cmp := 0
			switch tc.sort {
			case "date":
				cmp = cur.Date.Compare(prev.Date)
			case "quantity":
				switch {
				case cur.Qty < prev.Qty:
					cmp = -1
				case cur.Qty > prev.Qty:
					cmp = 1
				}
			default:
				cmp = strings.Compare(keyOf(tc.sort, cur), keyOf(tc.sort, prev))
			}
			if cmp == 0 {
				cmp = strings.Compare(cur.ID.String(), prev.ID.String())
			}
			if (tc.dir == "asc" && cmp <= 0) || (tc.dir == "desc" && cmp >= 0) {
				t.Errorf("%s %s: row %d (%s) is out of order after row %d (%s)",
					tc.sort, tc.dir, i, cur.Description, i-1, prev.Description)
			}
		}
	}

	// The quantity sort orders the signed change: the biggest stock-out first
	// ascending, the jarring's +12 jars last.
	ascending := fetchHoneyActivity(t, server, url.Values{"sort": {"quantity"}, "dir": {"asc"}})
	last := ascending.Entries[len(ascending.Entries)-1]
	if last.Type != "jarring" && last.Type != "receipt" {
		t.Errorf("largest quantity row = %s %q; want the jarring or the receipt", last.Type, last.Description)
	}
}

func TestHoneyActivityColumnFiltersAndFacets(t *testing.T) {
	server := honeyTestServer(t)
	fixture := seedHoneyActivityLedger(t, server)
	ctx := context.Background()

	all := pageAllHoneyActivity(t, server, url.Values{"limit": {"200"}})
	var jarring *honeyActivityEntry
	for i := range all {
		if all[i].Type == "jarring" {
			jarring = &all[i]
		}
	}
	if jarring == nil {
		t.Fatal("no jarring row")
	}
	if jarring.Item != "Pint" || jarring.Qty != 12 || jarring.QtyUnit != "jars" {
		t.Errorf("jarring item/qty = %q %v %q; want Pint +12 jars", jarring.Item, jarring.Qty, jarring.QtyUnit)
	}
	if jarring.Varietal == nil || *jarring.Varietal != "Activity Clover" || jarring.LotCode == nil {
		t.Errorf("jarring varietal/lot = %v %v; want Activity Clover and the lot code",
			jarring.Varietal, jarring.LotCode)
	}
	if jarring.FromLocation == nil || jarring.ToLocation == nil {
		t.Errorf("jarring locations = %v → %v; want both ends", jarring.FromLocation, jarring.ToLocation)
	}

	// Item: the jar size keeps every jar row; bulk keeps rows that moved bulk.
	pints := pageAllHoneyActivity(t, server, url.Values{
		"limit": {"1"}, "item": {"jar:" + fixture.jarSizeID.String()},
	})
	for _, entry := range pints {
		if entry.Item != "Pint" {
			t.Errorf("item filter let through %q (%s)", entry.Item, entry.Description)
		}
	}
	if len(pints) < 6 { // jarring, 3 adjustments, 2 sales
		t.Errorf("pint rows = %d, want at least 6", len(pints))
	}
	bulk := pageAllHoneyActivity(t, server, url.Values{"limit": {"1"}, "item": {"bulk"}})
	for _, entry := range bulk {
		if entry.Type == "sale" || entry.Type == "jar_adjustment" {
			t.Errorf("bulk filter let through %s %q", entry.Type, entry.Description)
		}
	}
	if len(bulk) == 0 {
		t.Error("bulk filter matched nothing; the receipt and jarring move bulk honey")
	}

	// Varietal: the lot's varietal reaches the jarring and the sales.
	clover := pageAllHoneyActivity(t, server, url.Values{
		"limit": {"1"}, "varietal": {fixture.varietalID.String()},
	})
	sales := 0
	for _, entry := range clover {
		if entry.Varietal == nil || *entry.Varietal != "Activity Clover" {
			t.Errorf("varietal filter let through %q", entry.Description)
		}
		if entry.Type == "sale" {
			sales++
		}
	}
	if sales != len(fixture.saleIDs) {
		t.Errorf("clover sales = %d, want %d", sales, len(fixture.saleIDs))
	}
	other := fetchHoneyActivity(t, server, url.Values{"varietal": {uuid.NewString()}})
	if len(other.Entries) != 0 {
		t.Errorf("unknown varietal matched %d rows", len(other.Entries))
	}

	// Location: everything here happened at home.
	homeID, err := production.HomeLocationID(ctx, server.pool)
	if err != nil {
		t.Fatalf("home location: %v", err)
	}
	home := pageAllHoneyActivity(t, server, url.Values{"limit": {"2"}, "location": {homeID.String()}})
	if len(home) != len(all) {
		t.Errorf("home rows = %d, want all %d", len(home), len(all))
	}
	elsewhere := fetchHoneyActivity(t, server, url.Values{"location": {uuid.NewString()}})
	if len(elsewhere.Entries) != 0 {
		t.Errorf("unknown location matched %d rows", len(elsewhere.Entries))
	}

	// Filters combine with a sort and still page cleanly.
	combined := pageAllHoneyActivity(t, server, url.Values{
		"limit": {"1"}, "sort": {"quantity"}, "dir": {"desc"},
		"item": {"jar:" + fixture.jarSizeID.String()}, "type": {"sale,jar_adjustment"},
	})
	if len(combined) != 5 {
		t.Errorf("pint sales+adjustments by quantity = %d rows, want 5", len(combined))
	}

	// Facets list what the filters accept.
	response := httptest.NewRecorder()
	server.honeyActivityFacetsHandler(response, adminRequest(http.MethodGet,
		"/api/v1/honey/activity/facets", nil))
	if response.Code != http.StatusOK {
		t.Fatalf("facets = %d %s", response.Code, response.Body.String())
	}
	var facets honeyActivityFacets
	if err := json.Unmarshal(response.Body.Bytes(), &facets); err != nil {
		t.Fatalf("decode facets: %v", err)
	}
	has := func(list []honeyActivityFacet, value, label string) bool {
		for _, facet := range list {
			if facet.Value == value && facet.Label == label {
				return true
			}
		}
		return false
	}
	if !has(facets.Items, "bulk", "Bulk honey") ||
		!has(facets.Items, "jar:"+fixture.jarSizeID.String(), "Pint") {
		t.Errorf("item facets = %+v", facets.Items)
	}
	if !has(facets.Varietals, fixture.varietalID.String(), "Activity Clover") {
		t.Errorf("varietal facets = %+v", facets.Varietals)
	}
	found := false
	for _, facet := range facets.Locations {
		found = found || facet.Value == homeID.String()
	}
	if !found {
		t.Errorf("location facets = %+v; want home", facets.Locations)
	}
}
