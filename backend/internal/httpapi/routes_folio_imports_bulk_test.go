package httpapi

import (
	"net/http"
	"testing"

	"github.com/google/uuid"
)

// DB-backed tests for the bulk Categorize routes (PUT /folio-imports/category,
// POST /folio-imports/accept|keep). They reuse the folio fake and import
// helpers from routes_folio_import_test.go.

func bulkCategorize(t *testing.T, server *Server, category string, ids ...uuid.UUID) (int, map[string]any) {
	t.Helper()
	response, body := call(t, server.handleFolioImportBulkCategory,
		adminRequest(http.MethodPut, "/api/v1/folio-imports/category",
			map[string]any{"ids": ids, "category": category}))
	return response.Code, body
}

// rejectedIDs reads the 400's per-id report as id → reason.
func rejectedIDs(t *testing.T, body map[string]any) map[string]string {
	t.Helper()
	list, ok := body["rejected"].([]any)
	if !ok {
		t.Fatalf("no rejected list in %v", body)
	}
	out := map[string]string{}
	for _, item := range list {
		entry := item.(map[string]any)
		out[entry["id"].(string)] = entry["reason"].(string)
	}
	return out
}

func TestFolioBulkCategorizeAppliesToEveryEntry(t *testing.T) {
	fake := newFolioFake(t)
	server := gnucashTestServer(t, fake, beekeepingMapping())
	setImportStart(t, server, "2024-01-01")
	fake.nativeTxn("n-sugar", "2024-03-02", "Sugar", moneyOut(2000)...)
	fake.nativeTxn("n-syrup", "2024-03-03", "Syrup", moneyOut(3000)...)
	fake.nativeTxn("n-refund", "2024-03-04", "Sugar returned", refund(500)...)
	fake.nativeTxn("n-market", "2024-06-01", "Market deposit", moneyIn(4500)...)
	fake.nativeTxn("n-stand", "2024-06-02", "Farm stand", moneyIn(1500)...)
	runImport(t, server, false)
	sugar := importedByGUID(t, server, "n-sugar")
	syrup := importedByGUID(t, server, "n-syrup")
	back := importedByGUID(t, server, "n-refund")

	// A duplicated id is applied once.
	code, body := bulkCategorize(t, server, "feed", sugar.ID, syrup.ID, back.ID, sugar.ID)
	if code != http.StatusOK || body["updated"] != float64(3) {
		t.Fatalf("bulk expenses: %d %v", code, body)
	}
	for _, guid := range []string{"n-sugar", "n-syrup", "n-refund"} {
		if entry := importedByGUID(t, server, guid); entry.Category != "feed" {
			t.Fatalf("%s %+v", guid, entry)
		}
	}
	if back = importedByGUID(t, server, "n-refund"); back.Amount != -500 {
		t.Fatalf("the refund stays a negative expense: %+v", back)
	}

	market := importedByGUID(t, server, "n-market")
	stand := importedByGUID(t, server, "n-stand")
	code, body = bulkCategorize(t, server, "honey_sales", market.ID, stand.ID)
	if code != http.StatusOK || body["updated"] != float64(2) {
		t.Fatalf("bulk income: %d %v", code, body)
	}
	for _, guid := range []string{"n-market", "n-stand"} {
		if entry := importedByGUID(t, server, guid); entry.Category != "honey_sales" {
			t.Fatalf("%s %+v", guid, entry)
		}
	}

	// The categorized entries leave the attention list.
	response, list := call(t, server.handleFolioEntryList,
		adminRequest(http.MethodGet, "/api/v1/folio-imports", nil))
	if response.Code != http.StatusOK {
		t.Fatalf("list: %d %v", response.Code, list)
	}
	if items := list["items"].([]any); len(items) != 0 || list["total"] != float64(0) {
		t.Fatalf("attention list after bulk categorize: %v", list)
	}
}

func TestFolioBulkCategorizeRefusesMixedDirections(t *testing.T) {
	fake := newFolioFake(t)
	server := gnucashTestServer(t, fake, beekeepingMapping())
	setImportStart(t, server, "2024-01-01")
	fake.nativeTxn("n-sugar", "2024-03-02", "Sugar", moneyOut(2000)...)
	fake.nativeTxn("n-jars", "2024-03-03", "Jars", moneyOut(3000)...)
	fake.nativeTxn("n-deposit", "2024-06-01", "Deposit", moneyIn(4500)...)
	runImport(t, server, false)
	sugar := importedByGUID(t, server, "n-sugar")
	jars := importedByGUID(t, server, "n-jars")
	deposit := importedByGUID(t, server, "n-deposit")

	// "other" is valid for both kinds, so only the mixed rule refuses it.
	code, body := bulkCategorize(t, server, "other", sugar.ID, jars.ID, deposit.ID)
	if code != http.StatusBadRequest {
		t.Fatalf("mixed bulk: %d %v, want 400", code, body)
	}
	rejected := rejectedIDs(t, body)
	if len(rejected) != 1 || rejected[deposit.ID.String()] != "Select only expenses or only income" {
		t.Fatalf("rejected %v, want only the income entry", rejected)
	}
	for _, guid := range []string{"n-sugar", "n-jars", "n-deposit"} {
		if entry := importedByGUID(t, server, guid); entry.Category != "uncategorized" {
			t.Fatalf("%s categorized by a refused request: %+v", guid, entry)
		}
	}

	// An expense category is not an income one either.
	code, body = bulkCategorize(t, server, "feed", deposit.ID)
	if code != http.StatusBadRequest {
		t.Fatalf("expense category on income: %d %v, want 400", code, body)
	}
	if _, ok := rejectedIDs(t, body)[deposit.ID.String()]; !ok {
		t.Fatalf("rejected %v", body)
	}
}

func TestFolioBulkCategorizeRefusesEntriesDeletedInFolio(t *testing.T) {
	fake := newFolioFake(t)
	fake.deletionFeed = true
	server := gnucashTestServer(t, fake, beekeepingMapping())
	setImportStart(t, server, "2024-01-01")
	fake.nativeTxn("n-gone", "2024-04-01", "Duplicate entry", moneyOut(500)...)
	fake.nativeTxn("n-stays", "2024-04-02", "Wax", moneyOut(700)...)
	runImport(t, server, false)
	fake.deleteNative("n-gone")
	runImport(t, server, false)
	gone := importedByGUID(t, server, "n-gone")
	stays := importedByGUID(t, server, "n-stays")
	if gone.State != "remote_deleted" {
		t.Fatalf("gone %+v", gone)
	}

	code, body := bulkCategorize(t, server, "packaging", stays.ID, gone.ID)
	if code != http.StatusBadRequest {
		t.Fatalf("bulk with a deleted entry: %d %v, want 400", code, body)
	}
	rejected := rejectedIDs(t, body)
	if len(rejected) != 1 || rejected[gone.ID.String()] == "" {
		t.Fatalf("rejected %v, want only the deleted entry", rejected)
	}
	if stays = importedByGUID(t, server, "n-stays"); stays.Category != "uncategorized" {
		t.Fatalf("stays categorized by a refused request: %+v", stays)
	}

	// Removed from Atlas (Folio's deletion accepted): still refused.
	response, accepted := call(t, server.handleFolioImportBulkAccept,
		adminRequest(http.MethodPost, "/api/v1/folio-imports/accept",
			map[string]any{"ids": []uuid.UUID{gone.ID}}))
	if response.Code != http.StatusOK {
		t.Fatalf("bulk accept deletion: %d %v", response.Code, accepted)
	}
	if gone = importedByGUID(t, server, "n-gone"); !gone.Deleted || gone.State != "" {
		t.Fatalf("gone after accept %+v", gone)
	}
	code, body = bulkCategorize(t, server, "packaging", gone.ID)
	if code != http.StatusBadRequest {
		t.Fatalf("bulk on a removed entry: %d %v, want 400", code, body)
	}
}

// One bad id anywhere in the request saves nothing: the rows before and after
// it are rolled back with it.
func TestFolioBulkCategorizeIsAllOrNothing(t *testing.T) {
	fake := newFolioFake(t)
	server := gnucashTestServer(t, fake, beekeepingMapping())
	setImportStart(t, server, "2024-01-01")
	fake.nativeTxn("n-a", "2024-03-02", "Frames", moneyOut(1000)...)
	fake.nativeTxn("n-b", "2024-03-03", "Foundation", moneyOut(2000)...)
	runImport(t, server, false)
	a := importedByGUID(t, server, "n-a")
	b := importedByGUID(t, server, "n-b")
	unknown := uuid.New()

	code, body := bulkCategorize(t, server, "equipment", a.ID, unknown, b.ID)
	if code != http.StatusBadRequest {
		t.Fatalf("bulk with an unknown id: %d %v, want 400", code, body)
	}
	if rejected := rejectedIDs(t, body); len(rejected) != 1 || rejected[unknown.String()] == "" {
		t.Fatalf("rejected %v, want the unknown id", rejected)
	}
	for _, guid := range []string{"n-a", "n-b"} {
		if entry := importedByGUID(t, server, guid); entry.Category != "uncategorized" {
			t.Fatalf("%s saved despite the refusal: %+v", guid, entry)
		}
	}

	// An unknown category refuses every row.
	code, body = bulkCategorize(t, server, "not_a_category", a.ID, b.ID)
	if code != http.StatusBadRequest || len(rejectedIDs(t, body)) != 2 {
		t.Fatalf("unknown category: %d %v", code, body)
	}

	// No ids at all is a plain 400.
	if code, body = bulkCategorize(t, server, "equipment"); code != http.StatusBadRequest {
		t.Fatalf("empty ids: %d %v", code, body)
	}

	// And the same request without the bad id goes through whole.
	if code, body = bulkCategorize(t, server, "equipment", a.ID, b.ID); code != http.StatusOK {
		t.Fatalf("clean bulk: %d %v", code, body)
	}
	for _, guid := range []string{"n-a", "n-b"} {
		if entry := importedByGUID(t, server, guid); entry.Category != "equipment" {
			t.Fatalf("%s %+v", guid, entry)
		}
	}
}

func TestFolioBulkKeepAndAcceptResolveConflicts(t *testing.T) {
	fake := newFolioFake(t)
	server := gnucashTestServer(t, fake, beekeepingMapping())
	setImportStart(t, server, "2024-01-01")
	fake.nativeTxn("n-a", "2024-03-02", "Frames", moneyOut(1000)...)
	fake.nativeTxn("n-b", "2024-03-03", "Sugar", moneyOut(2000)...)
	fake.nativeTxn("n-c", "2024-03-04", "Jars", moneyOut(3000)...)
	runImport(t, server, false)
	a := importedByGUID(t, server, "n-a")
	b := importedByGUID(t, server, "n-b")
	c := importedByGUID(t, server, "n-c")
	if code, body := bulkCategorize(t, server, "equipment", a.ID, b.ID, c.ID); code != http.StatusOK {
		t.Fatalf("categorize: %d %v", code, body)
	}
	// Categorized entries whose amount changes in Folio are flagged.
	fake.nativeTxn("n-a", "2024-03-02", "Frames", moneyOut(1100)...)
	fake.nativeTxn("n-b", "2024-03-03", "Sugar", moneyOut(2200)...)
	runImport(t, server, false)

	// An unflagged entry in the request refuses the whole bulk keep.
	response, body := call(t, server.handleFolioImportBulkKeep,
		adminRequest(http.MethodPost, "/api/v1/folio-imports/keep",
			map[string]any{"ids": []uuid.UUID{a.ID, c.ID}}))
	if response.Code != http.StatusBadRequest {
		t.Fatalf("keep with an unflagged entry: %d %v", response.Code, body)
	}
	if rejected := rejectedIDs(t, body); len(rejected) != 1 || rejected[c.ID.String()] == "" {
		t.Fatalf("rejected %v", rejected)
	}
	if a = importedByGUID(t, server, "n-a"); a.State != "remote_changed" {
		t.Fatalf("a resolved by a refused request: %+v", a)
	}

	response, body = call(t, server.handleFolioImportBulkKeep,
		adminRequest(http.MethodPost, "/api/v1/folio-imports/keep",
			map[string]any{"ids": []uuid.UUID{a.ID}}))
	if response.Code != http.StatusOK {
		t.Fatalf("bulk keep: %d %v", response.Code, body)
	}
	if a = importedByGUID(t, server, "n-a"); a.State != "" || a.Amount != 1000 {
		t.Fatalf("a after keep %+v", a)
	}
	response, body = call(t, server.handleFolioImportBulkAccept,
		adminRequest(http.MethodPost, "/api/v1/folio-imports/accept",
			map[string]any{"ids": []uuid.UUID{b.ID}}))
	if response.Code != http.StatusOK {
		t.Fatalf("bulk accept: %d %v", response.Code, body)
	}
	if b = importedByGUID(t, server, "n-b"); b.State != "" || b.Amount != 2200 || b.Category != "equipment" {
		t.Fatalf("b after accept %+v", b)
	}
}
