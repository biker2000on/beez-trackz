package httpapi

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/google/uuid"

	"github.com/biker2000on/beez-trackz/backend/internal/app"
	"github.com/biker2000on/beez-trackz/backend/internal/gnucashsync"
	"github.com/biker2000on/beez-trackz/backend/internal/snapshot"
)

// --- unit tests (no database) ---

func TestFinanceCategoryKey(t *testing.T) {
	for label, want := range map[string]string{
		"Fuel":                  "fuel",
		"Fuel & oil":            "fuel_oil",
		"  Truck -- repairs!  ": "truck_repairs",
		"2025 grant":            "category_2025_grant",
		"Café":                  "caf",
		"???":                   "category",
		strings.Repeat("a", 70): strings.Repeat("a", 48),
	} {
		if got := financeCategoryKey(label); got != want {
			t.Errorf("financeCategoryKey(%q) = %q, want %q", label, got, want)
		}
		if got := financeCategoryKey(label); !gnucashsync.IsCategoryKey(got) {
			t.Errorf("financeCategoryKey(%q) = %q is not a valid category key", label, got)
		}
	}
}

func TestCleanFinanceLabel(t *testing.T) {
	if got, err := cleanFinanceLabel("op", "  Market   fees "); err != nil || got != "Market fees" {
		t.Fatalf("clean label = %q, %v", got, err)
	}
	if _, err := cleanFinanceLabel("op", "   "); !app.IsKind(err, app.KindInvalid) {
		t.Fatalf("blank label: %v", err)
	}
	if _, err := cleanFinanceLabel("op", strings.Repeat("x", 81)); !app.IsKind(err, app.KindInvalid) {
		t.Fatalf("long label: %v", err)
	}
}

// folioCheckCategory applies the per-kind verdict, but an entry may keep the
// category it already has even after that category was archived.
func TestFolioCheckCategoryUsesTheVerdict(t *testing.T) {
	expenseID := uuid.New()
	incomeID := uuid.New()
	archived := app.Invalid("op", "archived").WithField("category")
	expense := folioImportRow{Direction: gnucashsync.ImportExpense, ExpenseID: &expenseID, Category: "uncategorized"}
	income := folioImportRow{Direction: gnucashsync.ImportIncome, IncomeID: &incomeID, Category: "uncategorized"}

	if err := folioCheckCategory("op", expense, "fuel", folioCategoryVerdict{income: archived}); err != nil {
		t.Fatalf("active expense category refused: %v", err)
	}
	if err := folioCheckCategory("op", expense, "fuel", folioCategoryVerdict{expense: archived}); err != archived {
		t.Fatalf("archived expense category accepted: %v", err)
	}
	if err := folioCheckCategory("op", income, "fuel", folioCategoryVerdict{income: archived}); err != archived {
		t.Fatalf("refused income category accepted: %v", err)
	}
	expense.Category = "fuel"
	if err := folioCheckCategory("op", expense, "fuel", folioCategoryVerdict{expense: archived}); err != nil {
		t.Fatalf("re-choosing the current (archived) category: %v", err)
	}
	expense.EntityDeleted = true
	if err := folioCheckCategory("op", expense, "feed", folioCategoryVerdict{}); !app.IsKind(err, app.KindConflict) {
		t.Fatalf("removed entry: %v", err)
	}
}

// --- DB-backed tests (skip without TEST_DATABASE_URL) ---

// financeTestServer is a honey test server with finance_categories back at
// exactly what the migration seeded, before and after the test. Other income
// and import links are cleared so no row names an operator category.
func financeTestServer(t *testing.T) *Server {
	t.Helper()
	server := honeyTestServer(t)
	resetFinanceCategories(t, server)
	t.Cleanup(func() { resetFinanceCategories(t, server) })
	return server
}

func resetFinanceCategories(t *testing.T, server *Server) {
	t.Helper()
	var values []string
	for _, seed := range snapshot.FinanceCategorySeeds() {
		values = append(values, fmt.Sprintf("('%s'::uuid, '%s', %d)",
			seed["id"], strings.ReplaceAll(seed["label"].(string), "'", "''"), seed["sort_order"]))
	}
	statement := `
		DELETE FROM folio_imports;
		DELETE FROM other_income;
		DELETE FROM expenses WHERE category NOT IN (
			SELECT key FROM finance_categories WHERE kind = 'expense' AND id IN (` + seedIDList() + `));
		DELETE FROM finance_categories WHERE id NOT IN (` + seedIDList() + `);
		UPDATE finance_categories fc
		SET label = s.label, sort_order = s.sort_order, archived_at = NULL
		FROM (VALUES ` + strings.Join(values, ", ") + `) AS s(id, label, sort_order)
		WHERE fc.id = s.id AND (fc.label <> s.label OR fc.sort_order <> s.sort_order OR fc.archived_at IS NOT NULL)`
	if _, err := server.pool.Exec(context.Background(), statement); err != nil {
		t.Fatalf("reset finance categories: %v", err)
	}
}

func seedIDList() string {
	quoted := make([]string, 0)
	for _, id := range snapshot.FinanceCategorySeedIDs() {
		quoted = append(quoted, "'"+id+"'")
	}
	return strings.Join(quoted, ",")
}

func listCategories(t *testing.T, server *Server, kind string) []financeCategory {
	t.Helper()
	response := httptest.NewRecorder()
	server.handleFinanceCategoryList(response,
		adminRequest(http.MethodGet, "/api/v1/finance-categories?kind="+kind, nil))
	if response.Code != http.StatusOK {
		t.Fatalf("list %s categories: %d %s", kind, response.Code, response.Body.String())
	}
	var out []financeCategory
	if err := json.Unmarshal(response.Body.Bytes(), &out); err != nil {
		t.Fatal(err)
	}
	return out
}

func categoryByKey(t *testing.T, list []financeCategory, key string) financeCategory {
	t.Helper()
	for _, row := range list {
		if row.Key == key {
			return row
		}
	}
	t.Fatalf("no category %q in %+v", key, list)
	return financeCategory{}
}

func createCategory(t *testing.T, server *Server, kind, label string) (int, map[string]any) {
	t.Helper()
	response, body := call(t, server.handleFinanceCategoryCreate,
		adminRequest(http.MethodPost, "/api/v1/finance-categories", map[string]any{"kind": kind, "label": label}))
	return response.Code, body
}

func patchCategory(t *testing.T, server *Server, id uuid.UUID, body map[string]any) (int, map[string]any) {
	t.Helper()
	response, decoded := call(t, server.handleFinanceCategoryUpdate,
		adminRequest(http.MethodPatch, "/api/v1/finance-categories/"+id.String(), body, "id", id.String()))
	return response.Code, decoded
}

func deleteCategory(t *testing.T, server *Server, id uuid.UUID) (int, map[string]any) {
	t.Helper()
	response, decoded := call(t, server.handleFinanceCategoryDelete,
		adminRequest(http.MethodDelete, "/api/v1/finance-categories/"+id.String(), nil, "id", id.String()))
	return response.Code, decoded
}

func createExpense(t *testing.T, server *Server, category string) (int, map[string]any) {
	t.Helper()
	response, body := call(t, server.expenseCreate,
		adminRequest(http.MethodPost, "/api/v1/expenses", map[string]any{
			"expenseDate": "2026-05-01", "category": category,
			"description": "Test expense", "amount": 12.5,
		}))
	return response.Code, body
}

func TestFinanceCategoriesAreSeeded(t *testing.T) {
	server := financeTestServer(t)
	expenses := listCategories(t, server, "expense")
	if len(expenses) != 11 {
		t.Fatalf("expense categories = %d, want the 11 seeded", len(expenses))
	}
	for _, key := range []string{"bees_queens", "feed", "treatments", "packaging", "equipment",
		"mileage", "market_fees", "labor", "other", "grocery", "uncategorized"} {
		row := categoryByKey(t, expenses, key)
		if row.Archived || row.Kind != "expense" || row.Label == "" {
			t.Errorf("seeded %s = %+v", key, row)
		}
	}
	if !categoryByKey(t, expenses, "uncategorized").IsSystem || !categoryByKey(t, expenses, "bees_queens").IsSystem ||
		categoryByKey(t, expenses, "feed").IsSystem {
		t.Fatalf("system flags: %+v", expenses)
	}
	if expenses[0].Key != "uncategorized" {
		t.Fatalf("display order starts with %q, want uncategorized", expenses[0].Key)
	}
	income := listCategories(t, server, "income")
	if len(income) != 9 {
		t.Fatalf("income categories = %d, want the 9 seeded", len(income))
	}
	if !categoryByKey(t, income, "sales_deposit").IsSystem || !categoryByKey(t, income, "uncategorized").IsSystem ||
		categoryByKey(t, income, "grant").IsSystem {
		t.Fatalf("income system flags: %+v", income)
	}
	if categoryByKey(t, income, "honey_sales").Label != "Honey sales" {
		t.Fatalf("seeded label: %+v", categoryByKey(t, income, "honey_sales"))
	}
	response := httptest.NewRecorder()
	server.handleFinanceCategoryList(response,
		adminRequest(http.MethodGet, "/api/v1/finance-categories?kind=assets", nil))
	if response.Code != http.StatusBadRequest {
		t.Fatalf("bad kind: %d", response.Code)
	}
}

func TestFinanceCategoryLifecycle(t *testing.T) {
	server := financeTestServer(t)

	code, body := createCategory(t, server, "expense", "  Fuel &  oil ")
	if code != http.StatusCreated || body["key"] != "fuel_oil" || body["label"] != "Fuel & oil" ||
		body["sortOrder"] != float64(110) || body["isSystem"] != false {
		t.Fatalf("create: %d %v", code, body)
	}
	fuelID := uuid.MustParse(body["id"].(string))

	// The same name (any case) is refused; a different name whose slug is
	// taken gets a suffixed key.
	if code, body = createCategory(t, server, "expense", "FUEL & OIL"); code != http.StatusConflict {
		t.Fatalf("duplicate label: %d %v", code, body)
	}
	if code, body = createCategory(t, server, "expense", "Fuel/oil"); code != http.StatusCreated || body["key"] != "fuel_oil_2" {
		t.Fatalf("slug collision: %d %v", code, body)
	}
	// The same name is fine in the other kind.
	if code, body = createCategory(t, server, "income", "Fuel & oil"); code != http.StatusCreated || body["key"] != "fuel_oil" {
		t.Fatalf("other kind: %d %v", code, body)
	}
	if code, body = createCategory(t, server, "assets", "Fuel"); code != http.StatusBadRequest {
		t.Fatalf("bad kind: %d %v", code, body)
	}
	if code, body = createCategory(t, server, "expense", "   "); code != http.StatusBadRequest {
		t.Fatalf("blank label: %d %v", code, body)
	}

	// A new category is usable at once.
	if code, body = createExpense(t, server, "fuel_oil"); code != http.StatusCreated {
		t.Fatalf("expense in new category: %d %v", code, body)
	}

	// Rename keeps the key.
	if code, body = patchCategory(t, server, fuelID, map[string]any{"label": "Truck fuel"}); code != http.StatusOK {
		t.Fatalf("rename: %d %v", code, body)
	}
	fuel := categoryByKey(t, listCategories(t, server, "expense"), "fuel_oil")
	if fuel.Label != "Truck fuel" || fuel.UsageCount != 1 || fuel.Deletable {
		t.Fatalf("after rename: %+v", fuel)
	}
	if code, body = patchCategory(t, server, fuelID, map[string]any{"label": "feed"}); code != http.StatusConflict {
		t.Fatalf("rename onto an existing name: %d %v", code, body)
	}

	// Archived: refused for new entries, still listed and still on old rows.
	if code, body = patchCategory(t, server, fuelID, map[string]any{"archived": true}); code != http.StatusOK {
		t.Fatalf("archive: %d %v", code, body)
	}
	if code, body = createExpense(t, server, "fuel_oil"); code != http.StatusBadRequest ||
		!strings.Contains(body["error"].(string), "archived") {
		t.Fatalf("expense in archived category: %d %v", code, body)
	}
	fuel = categoryByKey(t, listCategories(t, server, "expense"), "fuel_oil")
	if !fuel.Archived || fuel.UsageCount != 1 {
		t.Fatalf("archived category: %+v", fuel)
	}
	if code, body = patchCategory(t, server, fuelID, map[string]any{"archived": false}); code != http.StatusOK {
		t.Fatalf("unarchive: %d %v", code, body)
	}
	if code, body = createExpense(t, server, "fuel_oil"); code != http.StatusCreated {
		t.Fatalf("expense after unarchive: %d %v", code, body)
	}

	// In use: delete is refused (soft-deleted rows count too).
	if code, body = deleteCategory(t, server, fuelID); code != http.StatusConflict ||
		!strings.Contains(body["error"].(string), "archive it instead") {
		t.Fatalf("delete in use: %d %v", code, body)
	}
	if _, err := server.pool.Exec(context.Background(),
		`UPDATE expenses SET deleted_at = now() WHERE category = 'fuel_oil'`); err != nil {
		t.Fatal(err)
	}
	if code, body = deleteCategory(t, server, fuelID); code != http.StatusConflict {
		t.Fatalf("delete used by soft-deleted rows: %d %v", code, body)
	}
	// The database refuses it as well, whatever the caller.
	if _, err := server.pool.Exec(context.Background(),
		`DELETE FROM finance_categories WHERE id = $1`, fuelID); err == nil {
		t.Fatal("the delete guard let a used category go")
	}

	// System categories: renamable, never archived or deleted.
	expenses := listCategories(t, server, "expense")
	uncategorized := categoryByKey(t, expenses, "uncategorized")
	if code, body = patchCategory(t, server, uncategorized.ID, map[string]any{"archived": true}); code != http.StatusBadRequest {
		t.Fatalf("archive system: %d %v", code, body)
	}
	if code, body = deleteCategory(t, server, uncategorized.ID); code != http.StatusBadRequest {
		t.Fatalf("delete system: %d %v", code, body)
	}
	if code, body = patchCategory(t, server, uncategorized.ID, map[string]any{"label": "Needs a category"}); code != http.StatusOK {
		t.Fatalf("rename system: %d %v", code, body)
	}

	// Unused: deleted.
	spare := categoryByKey(t, listCategories(t, server, "expense"), "fuel_oil_2")
	if !spare.Deletable {
		t.Fatalf("unused category not deletable: %+v", spare)
	}
	if code, body = deleteCategory(t, server, spare.ID); code != http.StatusOK {
		t.Fatalf("delete unused: %d %v", code, body)
	}
	for _, row := range listCategories(t, server, "expense") {
		if row.Key == "fuel_oil_2" {
			t.Fatal("deleted category still listed")
		}
	}
	if code, _ = deleteCategory(t, server, spare.ID); code != http.StatusNotFound {
		t.Fatalf("delete twice: %d", code)
	}
}

func TestFinanceCategoryOrder(t *testing.T) {
	server := financeTestServer(t)
	income := listCategories(t, server, "income")
	grant := categoryByKey(t, income, "grant")
	services := categoryByKey(t, income, "services")
	response, body := call(t, server.handleFinanceCategoryOrder,
		adminRequest(http.MethodPut, "/api/v1/finance-categories/order", map[string]any{
			"kind": "income", "ids": []uuid.UUID{grant.ID, services.ID},
		}))
	if response.Code != http.StatusOK {
		t.Fatalf("reorder: %d %v", response.Code, body)
	}
	income = listCategories(t, server, "income")
	if income[0].Key != "grant" || income[1].Key != "services" || len(income) != 9 {
		t.Fatalf("order after reorder: %v, %v", income[0].Key, income[1].Key)
	}
	feed := categoryByKey(t, listCategories(t, server, "expense"), "feed")
	response, body = call(t, server.handleFinanceCategoryOrder,
		adminRequest(http.MethodPut, "/api/v1/finance-categories/order", map[string]any{
			"kind": "income", "ids": []uuid.UUID{feed.ID},
		}))
	if response.Code != http.StatusBadRequest {
		t.Fatalf("an expense id in an income reorder: %d %v", response.Code, body)
	}
}

func TestExpenseCreateRefusesUnknownCategory(t *testing.T) {
	server := financeTestServer(t)
	for _, category := range []string{"not_a_thing", "honey_sales", "uncategorized", ""} {
		if code, body := createExpense(t, server, category); code != http.StatusBadRequest {
			t.Fatalf("expense in %q: %d %v", category, code, body)
		}
	}
	if code, body := createExpense(t, server, "feed"); code != http.StatusCreated {
		t.Fatalf("expense in feed: %d %v", code, body)
	}
}

// Bulk categorize takes a category the operator added, refuses it once
// archived, and refuses a category of the other kind.
func TestFolioBulkCategorizeWithAnOperatorCategory(t *testing.T) {
	fake := newFolioFake(t)
	server := gnucashTestServer(t, fake, beekeepingMapping())
	resetFinanceCategories(t, server)
	t.Cleanup(func() { resetFinanceCategories(t, server) })
	setImportStart(t, server, "2024-01-01")
	fake.nativeTxn("n-diesel", "2024-03-02", "Diesel", moneyOut(4000)...)
	fake.nativeTxn("n-gas", "2024-03-03", "Gas", moneyOut(3000)...)
	fake.nativeTxn("n-tour", "2024-06-01", "Apiary tour", moneyIn(2500)...)
	runImport(t, server, false)
	diesel := importedByGUID(t, server, "n-diesel")
	gas := importedByGUID(t, server, "n-gas")
	tour := importedByGUID(t, server, "n-tour")

	code, body := createCategory(t, server, "expense", "Fuel")
	if code != http.StatusCreated {
		t.Fatalf("create fuel: %d %v", code, body)
	}
	fuelID := uuid.MustParse(body["id"].(string))
	if code, body = createCategory(t, server, "income", "Tours"); code != http.StatusCreated {
		t.Fatalf("create tours: %d %v", code, body)
	}

	if code, body = bulkCategorize(t, server, "fuel", diesel.ID, gas.ID); code != http.StatusOK || body["updated"] != float64(2) {
		t.Fatalf("bulk into new category: %d %v", code, body)
	}
	for _, guid := range []string{"n-diesel", "n-gas"} {
		if entry := importedByGUID(t, server, guid); entry.Category != "fuel" {
			t.Fatalf("%s %+v", guid, entry)
		}
	}
	if code, body = bulkCategorize(t, server, "fuel", tour.ID); code != http.StatusBadRequest {
		t.Fatalf("expense category on income: %d %v", code, body)
	}
	response, single := call(t, server.handleFolioImportCategory,
		adminRequest(http.MethodPut, "/api/v1/folio-imports/"+tour.ID.String()+"/category",
			map[string]any{"category": "tours"}, "id", tour.ID.String()))
	if response.Code != http.StatusOK {
		t.Fatalf("single categorize into new income category: %d %v", response.Code, single)
	}
	if entry := importedByGUID(t, server, "n-tour"); entry.Category != "tours" {
		t.Fatalf("tour %+v", entry)
	}

	// The list offers the new categories to pickers.
	response, list := call(t, server.handleFolioEntryList,
		adminRequest(http.MethodGet, "/api/v1/folio-imports?view=all", nil))
	if response.Code != http.StatusOK {
		t.Fatalf("list: %d %v", response.Code, list)
	}
	if !strings.Contains(fmt.Sprint(list["expenseCategories"]), "fuel") ||
		!strings.Contains(fmt.Sprint(list["otherIncomeCategories"]), "tours") {
		t.Fatalf("pickers lack the new categories: %v / %v", list["expenseCategories"], list["otherIncomeCategories"])
	}

	// Archived: no longer offered, refused for other entries, but an entry
	// may keep it.
	if code, body = patchCategory(t, server, fuelID, map[string]any{"archived": true}); code != http.StatusOK {
		t.Fatalf("archive fuel: %d %v", code, body)
	}
	if code, body = bulkCategorize(t, server, "uncategorized", gas.ID); code != http.StatusOK {
		t.Fatalf("back to uncategorized: %d %v", code, body)
	}
	code, body = bulkCategorize(t, server, "fuel", gas.ID)
	if code != http.StatusBadRequest || !strings.Contains(rejectedIDs(t, body)[gas.ID.String()], "archived") {
		t.Fatalf("bulk into archived category: %d %v", code, body)
	}
	if code, body = bulkCategorize(t, server, "fuel", diesel.ID); code != http.StatusOK {
		t.Fatalf("re-choosing the archived category an entry has: %d %v", code, body)
	}
	_, list = call(t, server.handleFolioEntryList,
		adminRequest(http.MethodGet, "/api/v1/folio-imports?view=all", nil))
	for _, key := range list["expenseCategories"].([]any) {
		if key == "fuel" {
			t.Fatal("an archived category is still offered")
		}
	}
	if code, body = bulkCategorize(t, server, "not_a_category", gas.ID); code != http.StatusBadRequest {
		t.Fatalf("unknown category: %d %v", code, body)
	}
}

// The Folio mapping covers operator categories: the settings list them, a
// mapping for one is stored, a key that names no category is dropped, and
// deleting a category drops its mapping.
func TestFolioMappingWithAnOperatorCategory(t *testing.T) {
	fake := newFolioFake(t)
	server := gnucashTestServer(t, fake, beekeepingMapping())
	resetFinanceCategories(t, server)
	t.Cleanup(func() { resetFinanceCategories(t, server) })

	code, body := createCategory(t, server, "expense", "Fuel")
	if code != http.StatusCreated {
		t.Fatalf("create fuel: %d %v", code, body)
	}
	fuelID := uuid.MustParse(body["id"].(string))

	response, settings := call(t, server.handleGnuCashSettings,
		adminRequest(http.MethodGet, "/api/v1/settings/gnucash", nil))
	if response.Code != http.StatusOK {
		t.Fatalf("settings: %d %v", response.Code, settings)
	}
	listed := fmt.Sprint(settings["expenseCategories"])
	if !strings.Contains(listed, "fuel") || strings.Contains(listed, "uncategorized") {
		t.Fatalf("mapping categories = %s", listed)
	}

	mapping := beekeepingMapping()
	mapping.Expenses["fuel"] = "acct-fuel"
	mapping.Expenses["not_a_category"] = "acct-x"
	response, body = call(t, server.handleGnuCashSettingsPut,
		adminRequest(http.MethodPut, "/api/v1/settings/gnucash", map[string]any{"accountMapping": mapping}))
	if response.Code != http.StatusOK {
		t.Fatalf("save mapping: %d %v", response.Code, body)
	}
	stored, err := loadGnuCashSettings(context.Background(), server.pool)
	if err != nil {
		t.Fatal(err)
	}
	if stored.Mapping.Expenses["fuel"] != "acct-fuel" {
		t.Fatalf("operator category mapping not stored: %v", stored.Mapping.Expenses)
	}
	if _, present := stored.Mapping.Expenses["not_a_category"]; present {
		t.Fatalf("a key naming no category was stored: %v", stored.Mapping.Expenses)
	}
	if account, err := stored.Mapping.ExpenseAccount("fuel"); err != nil || account != "acct-fuel" {
		t.Fatalf("fuel account = %q, %v", account, err)
	}

	if code, body = deleteCategory(t, server, fuelID); code != http.StatusOK {
		t.Fatalf("delete fuel: %d %v", code, body)
	}
	stored, err = loadGnuCashSettings(context.Background(), server.pool)
	if err != nil {
		t.Fatal(err)
	}
	if _, present := stored.Mapping.Expenses["fuel"]; present {
		t.Fatalf("a deleted category kept its mapping: %v", stored.Mapping.Expenses)
	}
	if stored.Mapping.Expenses["feed"] != "acct-bee" {
		t.Fatalf("other mappings changed: %v", stored.Mapping.Expenses)
	}
}
