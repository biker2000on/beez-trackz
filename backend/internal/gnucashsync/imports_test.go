package gnucashsync

import (
	"reflect"
	"testing"
)

func importChange(splits ...ChangeSplit) Change {
	return Change{
		TransactionGUID: "tx-1",
		PostDate:        "2024-05-04",
		EnterDate:       "2024-05-04T10:00:00.000001Z",
		Description:     "Mann Lake",
		Splits:          splits,
	}
}

var importTypes = map[string]string{
	"beekeeping": "EXPENSE",
	"bee-income": "INCOME",
	"checking":   "BANK",
	"bee-bank":   "BANK",
	"card":       "CREDIT",
	"groceries":  "EXPENSE",
}

func TestClassifyImportSingleExpenseAccount(t *testing.T) {
	// Everything recorded under one "Beekeeping" expense account: paying a
	// supplier debits it, a refund from the supplier credits it.
	imports := map[string]bool{"beekeeping": true}

	purchase, skip := ClassifyImport(importChange(
		ChangeSplit{AccountGUID: "beekeeping", AmountCents: 12999, Memo: "Frames"},
		ChangeSplit{AccountGUID: "checking", AmountCents: -12999},
	), imports, importTypes)
	if skip != ImportSkipNone || purchase.Direction != ImportExpense || purchase.AmountCents != 12999 {
		t.Fatalf("purchase = %+v skip %q", purchase, skip)
	}
	if !purchase.HasPostDate || purchase.PostDate.Format("2006-01-02") != "2024-05-04" {
		t.Fatalf("post date = %v %v", purchase.PostDate, purchase.HasPostDate)
	}
	if purchase.Memo != "Frames" || !reflect.DeepEqual(purchase.AccountGUIDs, []string{"beekeeping"}) {
		t.Fatalf("memo/accounts = %q %v", purchase.Memo, purchase.AccountGUIDs)
	}

	// A credit to an expense account is a NEGATIVE expense (a refund), never
	// other income: it lowers expense totals.
	refund, skip := ClassifyImport(importChange(
		ChangeSplit{AccountGUID: "checking", AmountCents: 4500},
		ChangeSplit{AccountGUID: "beekeeping", AmountCents: -4500},
	), imports, importTypes)
	if skip != ImportSkipNone || refund.Direction != ImportExpense || refund.AmountCents != -4500 {
		t.Fatalf("refund = %+v skip %q", refund, skip)
	}
}

func TestClassifyImportIncomeAccount(t *testing.T) {
	imports := map[string]bool{"bee-income": true}
	// A credit to an income account is other income.
	deposit, skip := ClassifyImport(importChange(
		ChangeSplit{AccountGUID: "checking", AmountCents: 4500},
		ChangeSplit{AccountGUID: "bee-income", AmountCents: -4500},
	), imports, importTypes)
	if skip != ImportSkipNone || deposit.Direction != ImportIncome || deposit.AmountCents != 4500 {
		t.Fatalf("deposit = %+v skip %q", deposit, skip)
	}
	// A debit to it (a customer refund, a reversed deposit) is NEGATIVE
	// other income, not an expense.
	reversal, skip := ClassifyImport(importChange(
		ChangeSplit{AccountGUID: "bee-income", AmountCents: 1200},
		ChangeSplit{AccountGUID: "checking", AmountCents: -1200},
	), imports, importTypes)
	if skip != ImportSkipNone || reversal.Direction != ImportIncome || reversal.AmountCents != -1200 {
		t.Fatalf("reversal = %+v skip %q", reversal, skip)
	}
}

func TestClassifyImportExpenseAndIncomeAccountsNetAsMoneyOut(t *testing.T) {
	imports := map[string]bool{"beekeeping": true, "bee-income": true}
	// 30.00 of supplies paid partly from 10.00 of income: net 20.00 out.
	got, skip := ClassifyImport(importChange(
		ChangeSplit{AccountGUID: "beekeeping", AmountCents: 3000},
		ChangeSplit{AccountGUID: "bee-income", AmountCents: -1000},
		ChangeSplit{AccountGUID: "checking", AmountCents: -2000},
	), imports, importTypes)
	if skip != ImportSkipNone || got.Direction != ImportExpense || got.AmountCents != 2000 {
		t.Fatalf("got %+v skip %q", got, skip)
	}
	got, skip = ClassifyImport(importChange(
		ChangeSplit{AccountGUID: "beekeeping", AmountCents: 500},
		ChangeSplit{AccountGUID: "bee-income", AmountCents: -2500},
		ChangeSplit{AccountGUID: "checking", AmountCents: 2000},
	), imports, importTypes)
	if skip != ImportSkipNone || got.Direction != ImportIncome || got.AmountCents != 2000 {
		t.Fatalf("got %+v skip %q", got, skip)
	}
}

func TestClassifyImportBalanceSheetAccountReadsTheOtherWay(t *testing.T) {
	imports := map[string]bool{"bee-bank": true}
	spend, skip := ClassifyImport(importChange(
		ChangeSplit{AccountGUID: "groceries", AmountCents: 800},
		ChangeSplit{AccountGUID: "bee-bank", AmountCents: -800},
	), imports, importTypes)
	if skip != ImportSkipNone || spend.Direction != ImportExpense || spend.AmountCents != 800 {
		t.Fatalf("spend = %+v skip %q", spend, skip)
	}
	in, skip := ClassifyImport(importChange(
		ChangeSplit{AccountGUID: "bee-bank", AmountCents: 2500},
		ChangeSplit{AccountGUID: "bee-income", AmountCents: -2500},
	), imports, importTypes)
	if skip != ImportSkipNone || in.Direction != ImportIncome || in.AmountCents != 2500 {
		t.Fatalf("income = %+v skip %q", in, skip)
	}
	// A credit card is a liability: a charge credits it, which is money out.
	card, skip := ClassifyImport(importChange(
		ChangeSplit{AccountGUID: "groceries", AmountCents: 300},
		ChangeSplit{AccountGUID: "card", AmountCents: -300},
	), map[string]bool{"card": true}, importTypes)
	if skip != ImportSkipNone || card.Direction != ImportExpense || card.AmountCents != 300 {
		t.Fatalf("card = %+v skip %q", card, skip)
	}
}

func TestClassifyImportPrefersProfitAndLossSplits(t *testing.T) {
	// Both halves are import accounts; counting both would cancel to zero.
	imports := map[string]bool{"beekeeping": true, "bee-bank": true}
	got, skip := ClassifyImport(importChange(
		ChangeSplit{AccountGUID: "beekeeping", AmountCents: 1500},
		ChangeSplit{AccountGUID: "bee-bank", AmountCents: -1500},
	), imports, importTypes)
	if skip != ImportSkipNone || got.Direction != ImportExpense || got.AmountCents != 1500 {
		t.Fatalf("got %+v skip %q", got, skip)
	}
	if !reflect.DeepEqual(got.AccountGUIDs, []string{"bee-bank", "beekeeping"}) {
		t.Fatalf("accounts = %v", got.AccountGUIDs)
	}
}

func TestClassifyImportNetsSplitsOnTheSameAccount(t *testing.T) {
	imports := map[string]bool{"beekeeping": true}
	got, skip := ClassifyImport(importChange(
		ChangeSplit{AccountGUID: "beekeeping", AmountCents: 1000, Memo: "Jars"},
		ChangeSplit{AccountGUID: "beekeeping", AmountCents: -250, Memo: "Coupon"},
		ChangeSplit{AccountGUID: "checking", AmountCents: -750},
	), imports, importTypes)
	if skip != ImportSkipNone || got.Direction != ImportExpense || got.AmountCents != 750 {
		t.Fatalf("got %+v skip %q", got, skip)
	}
	if got.Memo != "Jars; Coupon" {
		t.Fatalf("memo = %q", got.Memo)
	}
}

func TestClassifyImportSkips(t *testing.T) {
	imports := map[string]bool{"beekeeping": true}
	external := "expense:abc"
	cases := []struct {
		name   string
		change Change
		want   ImportSkip
	}{
		{"pushed by atlas", Change{ExternalID: &external, Splits: []ChangeSplit{
			{AccountGUID: "beekeeping", AmountCents: 5}, {AccountGUID: "checking", AmountCents: -5}}}, ImportSkipPushedByAtlas},
		{"tombstone", Change{ExternalID: &external, Deleted: true}, ImportSkipTombstone},
		{"unrepresentable", Change{TransactionGUID: "x", Unrepresentable: true}, ImportSkipUnrepresentable},
		{"other accounts", importChange(
			ChangeSplit{AccountGUID: "groceries", AmountCents: 5},
			ChangeSplit{AccountGUID: "checking", AmountCents: -5}), ImportSkipNoImportAccount},
		{"transfer", importChange(
			ChangeSplit{AccountGUID: "beekeeping", AmountCents: 5},
			ChangeSplit{AccountGUID: "beekeeping", AmountCents: -5}), ImportSkipTransfer},
	}
	for _, tc := range cases {
		if _, skip := ClassifyImport(tc.change, imports, importTypes); skip != tc.want {
			t.Errorf("%s: skip %q, want %q", tc.name, skip, tc.want)
		}
	}
}

func TestClassifyImportUnknownAccountTypeIsProfitAndLoss(t *testing.T) {
	got, skip := ClassifyImport(importChange(
		ChangeSplit{AccountGUID: "gone", AmountCents: 700},
		ChangeSplit{AccountGUID: "checking", AmountCents: -700},
	), map[string]bool{"gone": true}, importTypes)
	if skip != ImportSkipNone || got.Direction != ImportExpense {
		t.Fatalf("got %+v skip %q", got, skip)
	}
	// It reads as an expense account, so a credit is a refund.
	got, _ = ClassifyImport(importChange(
		ChangeSplit{AccountGUID: "gone", AmountCents: -700},
		ChangeSplit{AccountGUID: "checking", AmountCents: 700},
	), map[string]bool{"gone": true}, importTypes)
	if got.Direction != ImportExpense || got.AmountCents != -700 {
		t.Fatalf("got %+v", got)
	}
}

func TestClassifyImportDescriptionFallsBack(t *testing.T) {
	change := importChange(
		ChangeSplit{AccountGUID: "beekeeping", AmountCents: 700},
		ChangeSplit{AccountGUID: "checking", AmountCents: -700},
	)
	change.Description = "  "
	got, _ := ClassifyImport(change, map[string]bool{"beekeeping": true}, importTypes)
	if got.Description != "Imported from Folio" {
		t.Fatalf("description = %q", got.Description)
	}
}

func TestImportAccountGUIDsUsesCategoryMappingOnly(t *testing.T) {
	mapping := AccountMapping{
		Revenue:  map[string]string{"jar": "bee", "colony": "bee"},
		Expenses: map[string]string{"feed": "bee", "other": "misc"},
		Cash:     "checking",
	}
	if got := mapping.ImportAccountGUIDs(); !reflect.DeepEqual(got, []string{"bee", "misc"}) {
		t.Fatalf("got %v", got)
	}
	if got := NormalizeGUIDList([]string{" b ", "a", "", "b"}); !reflect.DeepEqual(got, []string{"a", "b"}) {
		t.Fatalf("normalize = %v", got)
	}
}
