package httpapi

import (
	"context"
	"net/http"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/biker2000on/beez-trackz/backend/internal/gnucashsync"
)

// DB-backed tests for the Folio history import and book connections
// (00064/00011). They reuse the folio fake from routes_gnucash_sync_test.go.

// beekeepingMapping is the user's real shape: every expense category posts to
// one "Beekeeping" expense account and every income kind to one "Beekeeping"
// income account.
func beekeepingMapping() gnucashsync.AccountMapping {
	revenue := map[string]string{}
	for _, kind := range gnucashsync.SaleLineKinds {
		revenue[kind] = "acct-bee-income"
	}
	expenses := map[string]string{}
	for _, category := range gnucashsync.ExpenseCategories {
		expenses[category] = "acct-bee"
	}
	return gnucashsync.AccountMapping{Revenue: revenue, Expenses: expenses, Cash: "acct-cash"}
}

// nativeTxn records a transaction a human entered (or re-entered) in Folio.
// Folio's feed reports each transaction once, in its current state, so an
// earlier version is blanked in place: a full rescan never replays history,
// and the integer cursors held by incremental readers stay valid.
func (f *folioFake) nativeTxn(guid, postDate, description string, splits ...gnucashsync.ChangeSplit) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.blank(guid)
	f.changes = append(f.changes, gnucashsync.Change{
		TransactionGUID: guid,
		PostDate:        postDate,
		EnterDate:       f.tick().Format(time.RFC3339Nano),
		Description:     description,
		Splits:          splits,
	})
}

// dropNative removes every trace of a native transaction from the feed, the
// way a deleted native transaction simply stops appearing.
func (f *folioFake) dropNative(guid string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.blank(guid)
}

// blank replaces every feed entry of guid with an empty item, which both
// readers treat as nothing.
func (f *folioFake) blank(guid string) {
	for i := range f.changes {
		if f.changes[i].TransactionGUID == guid {
			f.changes[i] = gnucashsync.Change{}
		}
	}
}

func moneyOut(cents int64) []gnucashsync.ChangeSplit {
	return []gnucashsync.ChangeSplit{
		{AccountGUID: "acct-bee", AmountCents: cents, Memo: "supplies"},
		{AccountGUID: "acct-cash", AmountCents: -cents},
	}
}

func moneyIn(cents int64) []gnucashsync.ChangeSplit {
	return []gnucashsync.ChangeSplit{
		{AccountGUID: "acct-cash", AmountCents: cents},
		{AccountGUID: "acct-bee-income", AmountCents: -cents},
	}
}

// refund is money back from a supplier, credited to the expense account.
func refund(cents int64) []gnucashsync.ChangeSplit {
	return []gnucashsync.ChangeSplit{
		{AccountGUID: "acct-cash", AmountCents: cents},
		{AccountGUID: "acct-bee", AmountCents: -cents, Memo: "returned"},
	}
}

// deleteNative deletes a native transaction the way a capable Folio reports
// it: the transaction stops appearing and a guid tombstone joins the feed
// (withheld from readers that did not ask, see changesPage).
func (f *folioFake) deleteNative(guid string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.blank(guid)
	f.changes = append(f.changes, gnucashsync.Change{
		TransactionGUID: guid,
		Deleted:         true,
		DeletedAt:       f.tick().Format(time.RFC3339Nano),
	})
}

// redeliver appends a copy of the last tombstone for guid: the deletion
// stream is at-least-once and re-sends recent deletions.
func (f *folioFake) redeliver(guid string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	for i := len(f.changes) - 1; i >= 0; i-- {
		if f.changes[i].TransactionGUID == guid && f.changes[i].Deleted {
			f.changes = append(f.changes, f.changes[i])
			return
		}
	}
}

func setImportStart(t *testing.T, server *Server, date string) {
	t.Helper()
	response, body := call(t, server.handleGnuCashSettingsPut,
		adminRequest(http.MethodPut, "/api/v1/settings/gnucash", map[string]any{
			"importStartDate": date,
		}))
	if response.Code != http.StatusOK {
		t.Fatalf("set import start: %d %v", response.Code, body)
	}
}

func runImport(t *testing.T, server *Server, full bool) map[string]any {
	t.Helper()
	response, body := call(t, server.handleGnuCashImport,
		adminRequest(http.MethodPost, "/api/v1/settings/gnucash/import", map[string]any{"full": full}))
	if response.Code != http.StatusOK {
		t.Fatalf("import: %d %v", response.Code, body)
	}
	if errs, ok := body["errors"].([]any); ok && len(errs) > 0 {
		t.Fatalf("import reported errors: %v", errs)
	}
	return body
}

type importedEntry struct {
	ID        uuid.UUID
	Direction string
	EntityID  uuid.UUID
	Category  string
	Amount    int64
	Date      time.Time
	State     string
	Deleted   bool
}

func importedByGUID(t *testing.T, server *Server, guid string) importedEntry {
	t.Helper()
	var (
		entry importedEntry
		state *string
	)
	err := server.pool.QueryRow(context.Background(), `
		SELECT fi.id, fi.direction, COALESCE(fi.expense_id, fi.income_id),
			COALESCE(e.category, oi.category), COALESCE(e.amount_cents, oi.amount_cents),
			COALESCE(e.expense_date, oi.income_date), fi.state,
			COALESCE(e.deleted_at, oi.deleted_at) IS NOT NULL
		FROM folio_imports fi
		LEFT JOIN expenses e ON e.id = fi.expense_id
		LEFT JOIN other_income oi ON oi.id = fi.income_id
		WHERE fi.transaction_guid = $1`, guid).
		Scan(&entry.ID, &entry.Direction, &entry.EntityID, &entry.Category, &entry.Amount,
			&entry.Date, &state, &entry.Deleted)
	if err != nil {
		t.Fatalf("load import %s: %v", guid, err)
	}
	entry.State = derefString(state)
	return entry
}

func countRows(t *testing.T, server *Server, query string, args ...any) int {
	t.Helper()
	var count int
	if err := server.pool.QueryRow(context.Background(), query, args...).Scan(&count); err != nil {
		t.Fatalf("count %q: %v", query, err)
	}
	return count
}

func TestFolioImportCreatesUncategorizedEntriesIdempotently(t *testing.T) {
	fake := newFolioFake(t)
	server := gnucashTestServer(t, fake, beekeepingMapping())
	setImportStart(t, server, "2024-01-01")

	fake.nativeTxn("n-old", "2023-12-31", "Before the start date", moneyOut(1000)...)
	fake.nativeTxn("n-frames", "2024-03-02", "Mann Lake frames", moneyOut(12999)...)
	fake.nativeTxn("n-deposit", "2024-06-10", "Market deposit", moneyIn(4500)...)
	fake.nativeTxn("n-groceries", "2024-06-11", "Groceries",
		gnucashsync.ChangeSplit{AccountGUID: "acct-food", AmountCents: 800},
		gnucashsync.ChangeSplit{AccountGUID: "acct-cash", AmountCents: -800})
	// Something Atlas pushed itself shows up in the feed with its externalId.
	expenseID := seedExpense(t, server, "feed", 2500)
	runSync(t, server)

	report := runImport(t, server, false)
	if report["importedExpenses"] != float64(1) || report["importedIncome"] != float64(1) {
		t.Fatalf("report %v", report)
	}
	if report["skippedBeforeStart"] != float64(1) || report["skippedPushedByAtlas"] == float64(0) {
		t.Fatalf("report %v", report)
	}

	frames := importedByGUID(t, server, "n-frames")
	if frames.Direction != "expense" || frames.Category != "uncategorized" || frames.Amount != 12999 {
		t.Fatalf("frames %+v", frames)
	}
	deposit := importedByGUID(t, server, "n-deposit")
	if deposit.Direction != "income" || deposit.Category != "uncategorized" || deposit.Amount != 4500 {
		t.Fatalf("deposit %+v", deposit)
	}

	// Re-running, incrementally and as a full rescan, duplicates nothing.
	runImport(t, server, false)
	runImport(t, server, true)
	if got := countRows(t, server, `SELECT count(*) FROM folio_imports`); got != 2 {
		t.Fatalf("folio_imports = %d, want 2", got)
	}

	// Moving the start date earlier picks up the older history once.
	setImportStart(t, server, "2023-01-01")
	report = runImport(t, server, false)
	if report["importedExpenses"] != float64(1) {
		t.Fatalf("widened import report %v", report)
	}
	if got := countRows(t, server, `SELECT count(*) FROM folio_imports`); got != 3 {
		t.Fatalf("folio_imports = %d, want 3", got)
	}

	// The imported expense is never pushed back; the Atlas one stays synced.
	posts, _, _ := fake.counts()
	runSync(t, server)
	if after, _, _ := fake.counts(); after != posts {
		t.Fatalf("sync pushed %d new transactions; imported expenses must not be pushed", after-posts)
	}
	if got := countRows(t, server,
		`SELECT count(*) FROM external_sync WHERE entity_id = $1`, frames.EntityID); got != 0 {
		t.Fatalf("imported expense got a sync row")
	}
	if row := syncRowFor(t, server, SyncEntityExpense, expenseID); row.SyncState != "synced" {
		t.Fatalf("atlas expense row %+v", row)
	}
}

func TestFolioImportAppliesEditsAndFlagsConflicts(t *testing.T) {
	fake := newFolioFake(t)
	server := gnucashTestServer(t, fake, beekeepingMapping())
	setImportStart(t, server, "2024-01-01")
	fake.nativeTxn("n-a", "2024-03-02", "Frames", moneyOut(1000)...)
	fake.nativeTxn("n-b", "2024-03-03", "Sugar", moneyOut(2000)...)
	runImport(t, server, false)

	// Uncategorized: an amount change is simply applied.
	fake.nativeTxn("n-a", "2024-03-02", "Frames", moneyOut(1100)...)
	// Categorized: a date/description change is applied, keeping the category.
	b := importedByGUID(t, server, "n-b")
	response, body := call(t, server.handleFolioImportCategory,
		adminRequest(http.MethodPut, "/api/v1/folio-imports/"+b.ID.String()+"/category",
			map[string]any{"category": "feed"}, "id", b.ID.String()))
	if response.Code != http.StatusOK {
		t.Fatalf("categorize: %d %v", response.Code, body)
	}
	fake.nativeTxn("n-b", "2024-03-05", "Sugar (corrected)", moneyOut(2000)...)
	runImport(t, server, false)

	if a := importedByGUID(t, server, "n-a"); a.Amount != 1100 || a.State != "" {
		t.Fatalf("a %+v", a)
	}
	b = importedByGUID(t, server, "n-b")
	if b.Category != "feed" || b.Date.Format("2006-01-02") != "2024-03-05" || b.State != "" {
		t.Fatalf("b %+v", b)
	}

	// Categorized and the amount changes: flagged, Atlas untouched.
	fake.nativeTxn("n-b", "2024-03-05", "Sugar (corrected)", moneyOut(2600)...)
	report := runImport(t, server, false)
	if report["conflicts"] != float64(1) {
		t.Fatalf("report %v", report)
	}
	b = importedByGUID(t, server, "n-b")
	if b.State != "remote_changed" || b.Amount != 2000 {
		t.Fatalf("b %+v", b)
	}
	// The same remote version re-emitted is not judged again.
	runImport(t, server, true)

	response, body = call(t, server.handleFolioImportAccept,
		adminRequest(http.MethodPost, "/api/v1/folio-imports/"+b.ID.String()+"/accept", nil,
			"id", b.ID.String()))
	if response.Code != http.StatusOK {
		t.Fatalf("accept: %d %v", response.Code, body)
	}
	if b = importedByGUID(t, server, "n-b"); b.Amount != 2600 || b.State != "" || b.Category != "feed" {
		t.Fatalf("b after accept %+v", b)
	}
}

func TestFolioImportFullScanFlagsDeletionsWithoutDeleting(t *testing.T) {
	fake := newFolioFake(t)
	server := gnucashTestServer(t, fake, beekeepingMapping())
	setImportStart(t, server, "2024-01-01")
	fake.nativeTxn("n-gone", "2024-04-01", "Duplicate entry", moneyOut(500)...)
	fake.nativeTxn("n-stays", "2024-04-02", "Wax", moneyOut(700)...)
	runImport(t, server, false)

	fake.dropNative("n-gone")
	report := runImport(t, server, true)
	if report["deleted"] != float64(1) || report["scanComplete"] != true {
		t.Fatalf("report %v", report)
	}
	gone := importedByGUID(t, server, "n-gone")
	if gone.State != "remote_deleted" || gone.Deleted {
		t.Fatalf("gone %+v — must be flagged, not deleted", gone)
	}
	if stays := importedByGUID(t, server, "n-stays"); stays.State != "" {
		t.Fatalf("stays %+v", stays)
	}

	response, body := call(t, server.handleFolioImportAccept,
		adminRequest(http.MethodPost, "/api/v1/folio-imports/"+gone.ID.String()+"/accept", nil,
			"id", gone.ID.String()))
	if response.Code != http.StatusOK {
		t.Fatalf("accept deletion: %d %v", response.Code, body)
	}
	if gone = importedByGUID(t, server, "n-gone"); !gone.Deleted || gone.State != "" {
		t.Fatalf("gone after accept %+v", gone)
	}
}

func TestFolioImportLinksIncomeToASale(t *testing.T) {
	fake := newFolioFake(t)
	server := gnucashTestServer(t, fake, beekeepingMapping())
	setImportStart(t, server, "2020-01-01")
	jarSizeID := seedJarSize(t, server, "Pint", 16, 1200)
	saleID := seedAppliedSale(t, server, jarSizeID, 2, 1200)
	fake.nativeTxn("n-deposit", time.Now().Format("2006-01-02"), "Deposit", moneyIn(2400)...)
	runImport(t, server, false)
	deposit := importedByGUID(t, server, "n-deposit")

	response, body := call(t, server.handleFolioImportSale,
		adminRequest(http.MethodPut, "/api/v1/folio-imports/"+deposit.ID.String()+"/sale",
			map[string]any{"saleId": saleID}, "id", deposit.ID.String()))
	if response.Code != http.StatusOK {
		t.Fatalf("link sale: %d %v", response.Code, body)
	}
	if deposit = importedByGUID(t, server, "n-deposit"); deposit.Category != "sales_deposit" {
		t.Fatalf("deposit %+v", deposit)
	}
	response, body = call(t, server.profitabilityAnalytics,
		adminRequest(http.MethodGet, "/api/v1/analytics/profitability", nil))
	if response.Code != http.StatusOK {
		t.Fatalf("profitability: %d %v", response.Code, body)
	}
	if body["otherIncome"] != float64(0) {
		t.Fatalf("a linked deposit was counted as other income: %v", body["otherIncome"])
	}
}

func TestFolioBookSwitchKeepsHistoryWithTheOldBook(t *testing.T) {
	fake := newFolioFake(t)
	server := gnucashTestServer(t, fake, beekeepingMapping())
	setImportStart(t, server, "2024-01-01")
	oldExpense := seedExpense(t, server, "feed", 2500)
	runSync(t, server)
	fake.nativeTxn("n-old-book", "2024-05-01", "Old book purchase", moneyOut(900)...)
	runImport(t, server, false)
	oldBook := gnucashSettingsOf(t, server).ActiveBookID
	if oldBook == nil {
		t.Fatal("sync did not create the active book connection")
	}

	// A token for another book through the ordinary settings is refused.
	fake.bookGUID = "book-2"
	response, body := call(t, server.handleGnuCashTest,
		adminRequest(http.MethodPost, "/api/v1/settings/gnucash/test", nil))
	if response.Code != http.StatusOK || body["error"] == nil {
		t.Fatalf("implicit switch was not refused: %d %v", response.Code, body)
	}

	response, body = call(t, server.handleGnuCashBookSwitch,
		adminRequest(http.MethodPost, "/api/v1/settings/gnucash/books/switch", map[string]any{
			"label": "Bee business", "baseUrl": fake.server.URL, "apiToken": "gcw_new",
			"importStartDate": "2025-01-01",
		}))
	if response.Code != http.StatusOK {
		t.Fatalf("switch: %d %v", response.Code, body)
	}
	response, body = call(t, server.handleGnuCashTest,
		adminRequest(http.MethodPost, "/api/v1/settings/gnucash/test", nil))
	if response.Code != http.StatusOK || body["success"] != true {
		t.Fatalf("test new book: %d %v", response.Code, body)
	}
	settings := gnucashSettingsOf(t, server)
	if settings.ActiveBookID == nil || *settings.ActiveBookID == *oldBook {
		t.Fatalf("active book %v did not change from %v", settings.ActiveBookID, *oldBook)
	}
	if settings.SyncEnabled || len(settings.Mapping.Expenses) != 0 {
		t.Fatalf("switch must disable sync and clear the mapping: %+v", settings)
	}

	// Map and enable the new book, edit the old expense, add a new one.
	response, body = call(t, server.handleGnuCashSettingsPut,
		adminRequest(http.MethodPut, "/api/v1/settings/gnucash", map[string]any{
			"accountMapping": beekeepingMapping(), "syncEnabled": true,
		}))
	if response.Code != http.StatusOK {
		t.Fatalf("map new book: %d %v", response.Code, body)
	}
	if _, err := server.pool.Exec(context.Background(),
		`UPDATE expenses SET amount_cents = 9999 WHERE id = $1`, oldExpense); err != nil {
		t.Fatal(err)
	}
	newExpense := seedExpense(t, server, "feed", 1500)
	_, puts, _ := fake.counts()
	runSync(t, server)
	if _, after, _ := fake.counts(); after != puts {
		t.Fatalf("the old-book expense was re-pushed after the switch")
	}

	var oldRowBook, newRowBook uuid.UUID
	if err := server.pool.QueryRow(context.Background(),
		`SELECT book_id FROM external_sync WHERE entity_id = $1`, oldExpense).Scan(&oldRowBook); err != nil {
		t.Fatal(err)
	}
	if err := server.pool.QueryRow(context.Background(),
		`SELECT book_id FROM external_sync WHERE entity_id = $1`, newExpense).Scan(&newRowBook); err != nil {
		t.Fatal(err)
	}
	if oldRowBook != *oldBook || newRowBook != *settings.ActiveBookID {
		t.Fatalf("books: old row %v (want %v), new row %v (want %v)",
			oldRowBook, *oldBook, newRowBook, *settings.ActiveBookID)
	}
	var importBook uuid.UUID
	if err := server.pool.QueryRow(context.Background(),
		`SELECT book_id FROM folio_imports WHERE transaction_guid = 'n-old-book'`).Scan(&importBook); err != nil {
		t.Fatal(err)
	}
	if importBook != *oldBook {
		t.Fatalf("import moved to book %v", importBook)
	}
}

// A refund credited to the Beekeeping expense account is a NEGATIVE expense:
// it lowers the expense total and never shows up as other income.
func TestFolioImportRefundIsANegativeExpense(t *testing.T) {
	fake := newFolioFake(t)
	server := gnucashTestServer(t, fake, beekeepingMapping())
	setImportStart(t, server, "2020-01-01")
	today := time.Now().Format("2006-01-02")
	fake.nativeTxn("n-frames", today, "Frames", moneyOut(5000)...)
	fake.nativeTxn("n-refund", today, "Frames returned", refund(1200)...)
	report := runImport(t, server, false)
	if report["importedExpenses"] != float64(2) || report["importedIncome"] != float64(0) {
		t.Fatalf("report %v", report)
	}
	back := importedByGUID(t, server, "n-refund")
	if back.Direction != "expense" || back.Amount != -1200 || back.Category != "uncategorized" {
		t.Fatalf("refund %+v", back)
	}
	// Categorizing a refund works like any expense.
	response, body := call(t, server.handleFolioImportCategory,
		adminRequest(http.MethodPut, "/api/v1/folio-imports/"+back.ID.String()+"/category",
			map[string]any{"category": "equipment"}, "id", back.ID.String()))
	if response.Code != http.StatusOK {
		t.Fatalf("categorize refund: %d %v", response.Code, body)
	}

	response, body = call(t, server.profitabilityAnalytics,
		adminRequest(http.MethodGet, "/api/v1/analytics/profitability", nil))
	if response.Code != http.StatusOK {
		t.Fatalf("profitability: %d %v", response.Code, body)
	}
	if body["expenses"] != float64(38) || body["expenseRefunds"] != float64(12) {
		t.Fatalf("expenses %v refunds %v, want 38 net of a 12 refund", body["expenses"], body["expenseRefunds"])
	}
	if body["otherIncome"] != float64(0) {
		t.Fatalf("a refund was counted as other income: %v", body["otherIncome"])
	}

	// Manual entry still refuses a negative amount.
	response, _ = call(t, server.expenseCreate,
		adminRequest(http.MethodPost, "/api/v1/expenses", map[string]any{
			"expenseDate": today, "category": "feed", "description": "Sugar", "amount": -5,
		}))
	if response.Code != http.StatusBadRequest {
		t.Fatalf("manual negative expense: %d, want 400", response.Code)
	}
}

// With a capable Folio a deleted native transaction is flagged by an ordinary
// incremental import — no full rescan — and a re-delivered report of the same
// deletion does not raise it again after the operator kept the entry.
func TestFolioImportDeletionFeedFlagsWithoutAFullScan(t *testing.T) {
	fake := newFolioFake(t)
	fake.deletionFeed = true
	server := gnucashTestServer(t, fake, beekeepingMapping())
	setImportStart(t, server, "2024-01-01")
	fake.nativeTxn("n-gone", "2024-04-01", "Duplicate entry", moneyOut(500)...)
	fake.nativeTxn("n-kept", "2024-04-02", "Wax", moneyOut(700)...)
	fake.nativeTxn("n-stays", "2024-04-03", "Jars", moneyOut(900)...)
	runImport(t, server, false)

	// A categorized entry is flagged too, never deleted.
	kept := importedByGUID(t, server, "n-kept")
	response, body := call(t, server.handleFolioImportCategory,
		adminRequest(http.MethodPut, "/api/v1/folio-imports/"+kept.ID.String()+"/category",
			map[string]any{"category": "packaging"}, "id", kept.ID.String()))
	if response.Code != http.StatusOK {
		t.Fatalf("categorize: %d %v", response.Code, body)
	}

	fake.deleteNative("n-gone")
	fake.deleteNative("n-kept")
	report := runImport(t, server, false)
	if report["full"] != false || report["deletionFeed"] != true || report["deleted"] != float64(2) {
		t.Fatalf("report %v", report)
	}
	for _, guid := range []string{"n-gone", "n-kept"} {
		if entry := importedByGUID(t, server, guid); entry.State != "remote_deleted" || entry.Deleted {
			t.Fatalf("%s %+v — must be flagged, not deleted", guid, entry)
		}
	}
	if stays := importedByGUID(t, server, "n-stays"); stays.State != "" {
		t.Fatalf("stays %+v", stays)
	}

	// Keep one; the at-least-once stream sends the same deletion again.
	kept = importedByGUID(t, server, "n-kept")
	response, body = call(t, server.handleFolioImportKeep,
		adminRequest(http.MethodPost, "/api/v1/folio-imports/"+kept.ID.String()+"/keep", nil,
			"id", kept.ID.String()))
	if response.Code != http.StatusOK {
		t.Fatalf("keep: %d %v", response.Code, body)
	}
	fake.redeliver("n-kept")
	report = runImport(t, server, false)
	if report["deleted"] != float64(0) {
		t.Fatalf("re-delivered deletion raised again: %v", report)
	}
	if kept = importedByGUID(t, server, "n-kept"); kept.State != "" || kept.Deleted || kept.Category != "packaging" {
		t.Fatalf("kept %+v", kept)
	}
	// Nor does a full rescan re-raise a deletion the operator already kept.
	if report = runImport(t, server, true); report["deleted"] != float64(0) {
		t.Fatalf("full scan re-raised a kept deletion: %v", report)
	}

	// Restored in Folio: seen alive again, the flag clears.
	fake.nativeTxn("n-gone", "2024-04-01", "Duplicate entry", moneyOut(500)...)
	runImport(t, server, false)
	if gone := importedByGUID(t, server, "n-gone"); gone.State != "" || gone.Deleted {
		t.Fatalf("restored %+v", gone)
	}
}

// Against an older Folio (no capability) the guid tombstones never arrive:
// the plain feed is read and deletions are found only by the full rescan.
func TestFolioImportWithoutDeletionFeedFallsBackToFullScan(t *testing.T) {
	fake := newFolioFake(t)
	server := gnucashTestServer(t, fake, beekeepingMapping())
	setImportStart(t, server, "2024-01-01")
	fake.nativeTxn("n-gone", "2024-04-01", "Duplicate entry", moneyOut(500)...)
	runImport(t, server, false)

	fake.deleteNative("n-gone")
	report := runImport(t, server, false)
	if report["deletionFeed"] != false || report["deleted"] != float64(0) {
		t.Fatalf("report %v", report)
	}
	if gone := importedByGUID(t, server, "n-gone"); gone.State != "" {
		t.Fatalf("an older Folio cannot report deletions incrementally: %+v", gone)
	}
	if report = runImport(t, server, true); report["deleted"] != float64(1) {
		t.Fatalf("full scan report %v", report)
	}
	if gone := importedByGUID(t, server, "n-gone"); gone.State != "remote_deleted" {
		t.Fatalf("gone %+v", gone)
	}
}

// Pure: which deletion-stream tombstones raise a flag (no database).
func TestFolioShouldFlagDeletion(t *testing.T) {
	at := func(minute int) *time.Time {
		stamp := time.Date(2026, 10, 10, 12, minute, 0, 0, time.UTC)
		return &stamp
	}
	cases := []struct {
		name      string
		row       folioImportRow
		deletedAt *time.Time
		want      bool
	}{
		{"first report", folioImportRow{}, at(1), true},
		{"first report without a timestamp", folioImportRow{}, nil, true},
		{"entry already removed", folioImportRow{EntityDeleted: true}, at(1), false},
		{"same deletion re-delivered", folioImportRow{RemoteDeletedAt: at(1)}, at(1), false},
		{"older deletion re-delivered", folioImportRow{RemoteDeletedAt: at(5)}, at(1), false},
		{"untimed repeat of a reported deletion", folioImportRow{RemoteDeletedAt: at(1)}, nil, false},
		{"deleted again after a restore", folioImportRow{RemoteDeletedAt: at(1)}, at(9), true},
	}
	for _, tc := range cases {
		if got := folioShouldFlagDeletion(tc.row, tc.deletedAt); got != tc.want {
			t.Errorf("%s: got %v, want %v", tc.name, got, tc.want)
		}
	}
}
