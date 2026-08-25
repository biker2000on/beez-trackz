package gnucashsync

import (
	"errors"
	"strings"
	"testing"
	"time"
)

func testMapping() AccountMapping {
	return AccountMapping{
		Revenue: map[string]string{
			"jar":       "acct-revenue-jar",
			"colony":    "acct-revenue-colony",
			"equipment": "acct-revenue-equipment",
			"mead":      "acct-revenue-jar", // deliberately shares an account
		},
		Expenses: map[string]string{
			"feed":  "acct-expense-feed",
			"other": "acct-expense-other",
		},
		Cash:               "acct-cash",
		AccountsReceivable: "acct-ar",
		SalesTax:           "acct-tax",
		Discount:           "acct-discount",
	}
}

func cents(v int64) *int64 { return &v }

func splitFor(t *testing.T, txn Transaction, account string) Split {
	t.Helper()
	for _, split := range txn.Splits {
		if split.AccountGUID == account {
			return split
		}
	}
	t.Fatalf("no split for account %q in %+v", account, txn.Splits)
	return Split{}
}

func countSplits(txn Transaction, account string) int {
	n := 0
	for _, split := range txn.Splits {
		if split.AccountGUID == account {
			n++
		}
	}
	return n
}

func TestBuildSaleBalancesCashAndRevenue(t *testing.T) {
	sale := Sale{
		ID:              "11111111-1111-1111-1111-111111111111",
		Date:            time.Date(2026, 8, 20, 14, 30, 0, 0, time.Local),
		CustomerName:    "Corner Market",
		OrderNumber:     "BT-ABC123",
		TotalCents:      2400,
		AmountPaidCents: 2400,
		Lines: []SaleLine{
			{Kind: "jar", Quantity: 2, UnitPriceCents: 1200, Label: "Pint"},
		},
	}
	txn, err := BuildSale(sale, testMapping())
	if err != nil {
		t.Fatalf("build sale: %v", err)
	}
	if txn.Sum() != 0 {
		t.Fatalf("splits sum to %d, want 0", txn.Sum())
	}
	if txn.ExternalID != "sale:"+sale.ID {
		t.Fatalf("external id %q", txn.ExternalID)
	}
	if txn.PostDate != "2026-08-20" {
		t.Fatalf("post date %q", txn.PostDate)
	}
	if txn.Num != "BT-ABC123" {
		t.Fatalf("num %q", txn.Num)
	}
	if got := splitFor(t, txn, "acct-cash").AmountCents; got != 2400 {
		t.Fatalf("cash debit %d, want 2400", got)
	}
	if got := splitFor(t, txn, "acct-revenue-jar").AmountCents; got != -2400 {
		t.Fatalf("revenue credit %d, want -2400", got)
	}
	if countSplits(txn, "acct-ar") != 0 {
		t.Fatal("a fully paid sale must not open a receivable")
	}
	if !strings.Contains(txn.Description, "Corner Market") {
		t.Fatalf("description %q drops the customer", txn.Description)
	}
}

func TestBuildSalePartialPaymentOpensReceivable(t *testing.T) {
	sale := Sale{
		ID:              "22222222-2222-2222-2222-222222222222",
		Date:            time.Now(),
		TotalCents:      5000,
		AmountPaidCents: 2000,
		Lines: []SaleLine{
			{Kind: "jar", Quantity: 5, UnitPriceCents: 1000},
		},
	}
	txn, err := BuildSale(sale, testMapping())
	if err != nil {
		t.Fatalf("build sale: %v", err)
	}
	if txn.Sum() != 0 {
		t.Fatalf("splits sum to %d, want 0", txn.Sum())
	}
	if got := splitFor(t, txn, "acct-ar").AmountCents; got != 3000 {
		t.Fatalf("receivable %d, want 3000", got)
	}
}

// Beez stores total_amount_cents exclusive of tax, so the customer owes
// total + tax and the tax lands in the liability account.
func TestBuildSaleTaxRidesOnTopOfTheTotal(t *testing.T) {
	sale := Sale{
		ID:              "33333333-3333-3333-3333-333333333333",
		Date:            time.Now(),
		TotalCents:      1000,
		TaxCents:        70,
		AmountPaidCents: 1070,
		Lines:           []SaleLine{{Kind: "jar", Quantity: 1, UnitPriceCents: 1000}},
	}
	txn, err := BuildSale(sale, testMapping())
	if err != nil {
		t.Fatalf("build sale: %v", err)
	}
	if txn.Sum() != 0 {
		t.Fatalf("splits sum to %d, want 0", txn.Sum())
	}
	if got := splitFor(t, txn, "acct-tax").AmountCents; got != -70 {
		t.Fatalf("tax credit %d, want -70", got)
	}
	if got := splitFor(t, txn, "acct-cash").AmountCents; got != 1070 {
		t.Fatalf("cash debit %d, want 1070", got)
	}
}

func TestBuildSaleDiscountDebitsTheDiscountAccount(t *testing.T) {
	sale := Sale{
		ID:              "44444444-4444-4444-4444-444444444444",
		Date:            time.Now(),
		TotalCents:      900,
		DiscountCents:   100,
		AmountPaidCents: 900,
		Lines:           []SaleLine{{Kind: "jar", Quantity: 1, UnitPriceCents: 1000}},
	}
	txn, err := BuildSale(sale, testMapping())
	if err != nil {
		t.Fatalf("build sale: %v", err)
	}
	if txn.Sum() != 0 {
		t.Fatalf("splits sum to %d, want 0", txn.Sum())
	}
	if got := splitFor(t, txn, "acct-discount").AmountCents; got != 100 {
		t.Fatalf("discount debit %d, want 100", got)
	}

	mapping := testMapping()
	mapping.Discount = ""
	if _, err := BuildSale(sale, mapping); err == nil {
		t.Fatal("a discount with no discount account must fail loudly")
	} else if !strings.Contains(err.Error(), "discount") {
		t.Fatalf("error %q does not name the missing mapping", err)
	}
}

func TestBuildSaleGroupsKindsSharingAnAccount(t *testing.T) {
	sale := Sale{
		ID:              "55555555-5555-5555-5555-555555555555",
		Date:            time.Now(),
		TotalCents:      3000,
		AmountPaidCents: 3000,
		Lines: []SaleLine{
			{Kind: "jar", Quantity: 1, UnitPriceCents: 1000, Label: "Pint"},
			{Kind: "mead", Quantity: 2, UnitPriceCents: 1000, Label: "Dry mead"},
		},
	}
	txn, err := BuildSale(sale, testMapping())
	if err != nil {
		t.Fatalf("build sale: %v", err)
	}
	if got := countSplits(txn, "acct-revenue-jar"); got != 1 {
		t.Fatalf("%d splits on the shared revenue account, want 1", got)
	}
	if got := splitFor(t, txn, "acct-revenue-jar").AmountCents; got != -3000 {
		t.Fatalf("grouped revenue %d, want -3000", got)
	}
	memo := splitFor(t, txn, "acct-revenue-jar").Memo
	if !strings.Contains(memo, "Pint") || !strings.Contains(memo, "Dry mead") {
		t.Fatalf("grouped memo %q loses a line", memo)
	}
}

func TestBuildSaleAddsCostOfGoodsPairWhenMapped(t *testing.T) {
	mapping := testMapping()
	mapping.COGS = "acct-cogs"
	mapping.Inventory = "acct-inventory"
	sale := Sale{
		ID:              "66666666-6666-6666-6666-666666666666",
		Date:            time.Now(),
		TotalCents:      4000,
		AmountPaidCents: 4000,
		Lines: []SaleLine{
			{Kind: "equipment", Quantity: 2, UnitPriceCents: 2000, CostBasisCents: cents(1500)},
		},
	}
	txn, err := BuildSale(sale, mapping)
	if err != nil {
		t.Fatalf("build sale: %v", err)
	}
	if txn.Sum() != 0 {
		t.Fatalf("splits sum to %d, want 0", txn.Sum())
	}
	if got := splitFor(t, txn, "acct-cogs").AmountCents; got != 1500 {
		t.Fatalf("cogs debit %d, want 1500", got)
	}
	if got := splitFor(t, txn, "acct-inventory").AmountCents; got != -1500 {
		t.Fatalf("inventory credit %d, want -1500", got)
	}

	// A nil basis is "unknown cost", not zero, and must not post anything.
	sale.Lines[0].CostBasisCents = nil
	txn, err = BuildSale(sale, mapping)
	if err != nil {
		t.Fatalf("build sale: %v", err)
	}
	if countSplits(txn, "acct-cogs") != 0 {
		t.Fatal("an unknown cost basis must not post a COGS split")
	}
	if txn.Sum() != 0 {
		t.Fatalf("splits sum to %d, want 0", txn.Sum())
	}
}

func TestBuildSaleWithoutCostMappingSkipsCostOfGoods(t *testing.T) {
	mapping := testMapping()
	mapping.COGS = "acct-cogs" // inventory half missing: cannot balance
	sale := Sale{
		ID:              "77777777-7777-7777-7777-777777777777",
		Date:            time.Now(),
		TotalCents:      1000,
		AmountPaidCents: 1000,
		Lines: []SaleLine{
			{Kind: "jar", Quantity: 1, UnitPriceCents: 1000, CostBasisCents: cents(400)},
		},
	}
	txn, err := BuildSale(sale, mapping)
	if err != nil {
		t.Fatalf("build sale: %v", err)
	}
	if countSplits(txn, "acct-cogs") != 0 {
		t.Fatal("half a COGS pair must post nothing")
	}
	if txn.Sum() != 0 {
		t.Fatalf("splits sum to %d, want 0", txn.Sum())
	}
}

func TestBuildSaleUnmappedKindNamesTheMapping(t *testing.T) {
	sale := Sale{
		ID:              "88888888-8888-8888-8888-888888888888",
		Date:            time.Now(),
		TotalCents:      500,
		AmountPaidCents: 500,
		Lines:           []SaleLine{{Kind: "propolis", Quantity: 1, UnitPriceCents: 500}},
	}
	_, err := BuildSale(sale, testMapping())
	if err == nil {
		t.Fatal("an unmapped sale line kind must fail")
	}
	if !strings.Contains(err.Error(), "propolis") {
		t.Fatalf("error %q does not name the unmapped kind", err)
	}
}

func TestBuildSaleRejectsATotalThatContradictsItsLines(t *testing.T) {
	sale := Sale{
		ID:              "99999999-9999-9999-9999-999999999999",
		Date:            time.Now(),
		TotalCents:      9999,
		AmountPaidCents: 9999,
		Lines:           []SaleLine{{Kind: "jar", Quantity: 1, UnitPriceCents: 1000}},
	}
	if _, err := BuildSale(sale, testMapping()); err == nil {
		t.Fatal("an inconsistent total must not be papered over")
	}
}

func TestBuildExpenseIsATwoSplitBalancedEntry(t *testing.T) {
	expense := Expense{
		ID:          "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
		Date:        time.Date(2026, 3, 2, 0, 0, 0, 0, time.Local),
		Category:    "feed",
		Description: "Sugar",
		Vendor:      "Feed Store",
		AmountCents: 4599,
	}
	txn, err := BuildExpense(expense, testMapping())
	if err != nil {
		t.Fatalf("build expense: %v", err)
	}
	if len(txn.Splits) != 2 || txn.Sum() != 0 {
		t.Fatalf("expense splits %+v", txn.Splits)
	}
	if got := splitFor(t, txn, "acct-expense-feed").AmountCents; got != 4599 {
		t.Fatalf("expense debit %d", got)
	}
	if got := splitFor(t, txn, "acct-cash").AmountCents; got != -4599 {
		t.Fatalf("cash credit %d", got)
	}
	if txn.PostDate != "2026-03-02" {
		t.Fatalf("post date %q", txn.PostDate)
	}
	if !strings.Contains(txn.Description, "Feed Store") {
		t.Fatalf("description %q drops the vendor", txn.Description)
	}
}

func TestBuildExpenseUnmappedCategoryNamesTheCategory(t *testing.T) {
	expense := Expense{
		ID: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", Date: time.Now(),
		Category: "mileage", Description: "Yard run", AmountCents: 1000,
	}
	_, err := BuildExpense(expense, testMapping())
	if err == nil || !strings.Contains(err.Error(), "mileage") {
		t.Fatalf("error %v does not name the unmapped category", err)
	}
}

func TestBuildRequiresACashAccount(t *testing.T) {
	mapping := testMapping()
	mapping.Cash = ""
	_, saleErr := BuildSale(Sale{ID: "x", Date: time.Now()}, mapping)
	_, expenseErr := BuildExpense(Expense{ID: "y", Date: time.Now(), Category: "feed"}, mapping)
	for _, err := range []error{saleErr, expenseErr} {
		if err == nil || !strings.Contains(err.Error(), "cash") {
			t.Fatalf("error %v does not name the missing cash account", err)
		}
	}
}

// validate is the last line of defence: nothing unbalanced reaches the wire
// even if a future builder gets the arithmetic wrong.
func TestValidateRejectsUnbalancedAndSingleSplitTransactions(t *testing.T) {
	_, err := validate(Transaction{Splits: []Split{{AccountGUID: "a", AmountCents: 5}}})
	if !errors.Is(err, ErrUnbalanced) {
		t.Fatalf("single split error %v", err)
	}
	_, err = validate(Transaction{Splits: []Split{
		{AccountGUID: "a", AmountCents: 5},
		{AccountGUID: "b", AmountCents: -4},
	}})
	if !errors.Is(err, ErrUnbalanced) {
		t.Fatalf("unbalanced error %v", err)
	}
}

func TestContentHashTracksTheBody(t *testing.T) {
	sale := Sale{
		ID: "cccccccc-cccc-cccc-cccc-cccccccccccc", Date: time.Now(),
		TotalCents: 1000, AmountPaidCents: 1000,
		Lines: []SaleLine{{Kind: "jar", Quantity: 1, UnitPriceCents: 1000}},
	}
	first, err := BuildSale(sale, testMapping())
	if err != nil {
		t.Fatalf("build sale: %v", err)
	}
	again, err := BuildSale(sale, testMapping())
	if err != nil {
		t.Fatalf("build sale: %v", err)
	}
	if ContentHash(first) != ContentHash(again) {
		t.Fatal("the same sale must hash the same twice")
	}

	sale.AmountPaidCents = 500
	changed, err := BuildSale(sale, testMapping())
	if err != nil {
		t.Fatalf("build sale: %v", err)
	}
	if ContentHash(first) == ContentHash(changed) {
		t.Fatal("a changed payment must change the hash")
	}
	if key := IdempotencyKey(first.ExternalID, ContentHash(first)); len(key) > 200 {
		t.Fatalf("idempotency key is %d characters", len(key))
	}
}

func TestNormalizeDropsBlanksAndUnknownKeys(t *testing.T) {
	mapping := AccountMapping{
		Revenue:  map[string]string{"jar": " guid ", "not_a_kind": "guid", "colony": "  "},
		Expenses: map[string]string{"feed": "guid-feed", "not_a_category": "guid"},
		Cash:     " acct-cash ",
	}.Normalize()
	if mapping.Revenue["jar"] != "guid" {
		t.Fatalf("revenue guid %q not trimmed", mapping.Revenue["jar"])
	}
	if _, present := mapping.Revenue["not_a_kind"]; present {
		t.Fatal("an unknown kind must not be stored")
	}
	if _, present := mapping.Revenue["colony"]; present {
		t.Fatal("a blank guid must not be stored")
	}
	if _, present := mapping.Expenses["not_a_category"]; present {
		t.Fatal("an unknown category must not be stored")
	}
	if mapping.Cash != "acct-cash" || !mapping.Complete() {
		t.Fatalf("cash %q", mapping.Cash)
	}
}
