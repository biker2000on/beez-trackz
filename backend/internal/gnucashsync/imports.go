package gnucashsync

import (
	"sort"
	"strings"
	"time"
)

// The history import: turning Folio transactions that Atlas did not write
// into Atlas expenses and other-income entries.
//
// Which transactions. An item of GET changes is a candidate when it posts at
// least one split to an "import account" (the operator's choice; by default
// every account the category mapping uses — for a book kept under a single
// "Beekeeping" account, that one account) and Atlas did not push it (it
// carries no beez externalId). The engine applies the rest of the filtering:
// post date on or after the configured start, not already linked by an
// external_sync row.
//
// Direction and amount. GnuCash splits are signed: positive is a debit,
// negative a credit. The ACCOUNT TYPE of the import accounts a transaction
// touches decides what the entry is, and the amount is signed, so a refund
// reduces the total it belongs to instead of appearing as the opposite kind:
//
//   - an EXPENSE account (and an account whose type is unknown — deleted in
//     Folio since, or never listed — the shape import accounts almost always
//     have): the entry is an EXPENSE of the net debit. A net credit is a
//     NEGATIVE expense — a refund from a supplier — which lowers expense
//     totals. It is never other income.
//   - an INCOME account: the entry is OTHER INCOME of the net credit. A net
//     debit is NEGATIVE other income — money paid back to a customer, a
//     reversed deposit — which lowers other income. (Flagging it instead was
//     considered; a signed entry keeps the totals right without a decision
//     the operator has no better answer to, and it mirrors the expense rule.)
//   - an asset, bank, cash, liability or credit-card account (balance sheet)
//     is debited when money arrives and credited when it leaves, so its sign
//     reads the other way round: a net credit (money out) is an expense, a
//     net debit (money in) is other income, both positive. These say nothing
//     about what the money was FOR, so there is no refund reading here.
//
// A transaction touching expense AND income import accounts nets them as
// money out (expense debits plus income debits, minus credits): a positive
// net is an expense, a negative net is other income, both positive.
//
// A net of zero is a transfer between import accounts and is skipped.
//
// When one transaction touches import accounts of BOTH the P&L and the
// balance-sheet kind (checking -> Beekeeping expense, both chosen as import
// accounts) the two halves describe the same money and would cancel. The P&L
// splits win: they are what says what the money was for. Balance-sheet splits
// are used only when the transaction touches no P&L import account.

// ImportDirection is which kind of Atlas entry a Folio transaction becomes.
type ImportDirection string

const (
	ImportExpense ImportDirection = "expense"
	ImportIncome  ImportDirection = "income"
)

// ImportSkip names why an item was not turned into an entry.
type ImportSkip string

const (
	ImportSkipNone            ImportSkip = ""
	ImportSkipPushedByAtlas   ImportSkip = "pushed_by_atlas"
	ImportSkipTombstone       ImportSkip = "tombstone"
	ImportSkipUnrepresentable ImportSkip = "unrepresentable"
	ImportSkipNoImportAccount ImportSkip = "no_import_account"
	ImportSkipTransfer        ImportSkip = "transfer"
)

// ImportCandidate is one Folio transaction classified for import.
type ImportCandidate struct {
	TransactionGUID string
	Direction       ImportDirection
	// AmountCents is signed: negative is a refund (expense) or a reversal
	// (income) and reduces its total. Never zero.
	AmountCents int64
	PostDate    time.Time
	HasPostDate bool
	EnterDate   string
	Description string
	// Memo joins the memos of the splits that decided the direction.
	Memo string
	// AccountGUIDs are the import accounts the transaction posts to, sorted.
	AccountGUIDs []string
}

// IsProfitAndLoss reports whether a GnuCash account type is an income or
// expense account. Unknown and empty types count as P&L (see the file note).
func IsProfitAndLoss(accountType string) bool {
	switch strings.ToUpper(strings.TrimSpace(accountType)) {
	case "ASSET", "BANK", "CASH", "CREDIT", "LIABILITY", "RECEIVABLE", "PAYABLE",
		"EQUITY", "STOCK", "MUTUAL", "TRADING", "ROOT", "CURRENCY":
		return false
	default:
		return true
	}
}

// IsIncomeAccount reports whether a GnuCash account type is an income
// account. Every other P&L type (EXPENSE, unknown, empty) reads as expense.
func IsIncomeAccount(accountType string) bool {
	return strings.ToUpper(strings.TrimSpace(accountType)) == "INCOME"
}

// ClassifyImport decides whether change becomes an Atlas entry and of what
// kind. importAccounts is the set of account GUIDs to import from and
// accountTypes maps a GUID to its GnuCash type.
func ClassifyImport(
	change Change, importAccounts map[string]bool, accountTypes map[string]string,
) (ImportCandidate, ImportSkip) {
	if change.Deleted {
		return ImportCandidate{}, ImportSkipTombstone
	}
	if change.ExternalID != nil && strings.TrimSpace(*change.ExternalID) != "" {
		return ImportCandidate{}, ImportSkipPushedByAtlas
	}
	if change.Unrepresentable {
		return ImportCandidate{}, ImportSkipUnrepresentable
	}

	var expenseSplits, incomeSplits, bs []ChangeSplit
	touched := map[string]bool{}
	for _, split := range change.Splits {
		if !importAccounts[split.AccountGUID] {
			continue
		}
		touched[split.AccountGUID] = true
		accountType := accountTypes[split.AccountGUID]
		switch {
		case !IsProfitAndLoss(accountType):
			bs = append(bs, split)
		case IsIncomeAccount(accountType):
			incomeSplits = append(incomeSplits, split)
		default:
			expenseSplits = append(expenseSplits, split)
		}
	}
	if len(touched) == 0 {
		return ImportCandidate{}, ImportSkipNoImportAccount
	}

	// See the file note for each case. net is the signed amount of the entry
	// in the chosen direction.
	var (
		chosen    []ChangeSplit
		direction ImportDirection
		net       int64
	)
	sum := func(splits []ChangeSplit) int64 {
		var total int64
		for _, split := range splits {
			total += split.AmountCents
		}
		return total
	}
	switch {
	case len(expenseSplits) > 0 && len(incomeSplits) == 0:
		chosen, direction, net = expenseSplits, ImportExpense, sum(expenseSplits)
	case len(incomeSplits) > 0 && len(expenseSplits) == 0:
		chosen, direction, net = incomeSplits, ImportIncome, -sum(incomeSplits)
	default:
		// Both P&L kinds (net money out), or balance sheet only (whose sign
		// reads the other way round). Either way the result is positive.
		var outflow int64
		if len(expenseSplits) > 0 {
			chosen = append(append(chosen, expenseSplits...), incomeSplits...)
			outflow = sum(chosen)
		} else {
			chosen = bs
			outflow = -sum(bs)
		}
		direction, net = ImportExpense, outflow
		if outflow < 0 {
			direction, net = ImportIncome, -outflow
		}
	}
	memos := []string{}
	for _, split := range chosen {
		if memo := strings.TrimSpace(split.Memo); memo != "" {
			memos = append(memos, memo)
		}
	}

	accounts := make([]string, 0, len(touched))
	for guid := range touched {
		accounts = append(accounts, guid)
	}
	sort.Strings(accounts)

	candidate := ImportCandidate{
		TransactionGUID: change.TransactionGUID,
		EnterDate:       change.EnterDate,
		Description:     truncateMemo(change.Description),
		Memo:            truncateMemo(strings.Join(memos, "; ")),
		AccountGUIDs:    accounts,
	}
	if parsed, ok := ParsePostDate(change.PostDate); ok {
		candidate.PostDate, candidate.HasPostDate = parsed, true
	}
	if net == 0 {
		return candidate, ImportSkipTransfer
	}
	candidate.Direction, candidate.AmountCents = direction, net
	if candidate.Description == "" {
		candidate.Description = candidate.Memo
	}
	if candidate.Description == "" {
		candidate.Description = "Imported from Folio"
	}
	return candidate, ImportSkipNone
}

// ParsePostDate reads the contract's YYYY-MM-DD post date. A full timestamp
// is accepted too and reduced to its date.
func ParsePostDate(raw string) (time.Time, bool) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return time.Time{}, false
	}
	if len(raw) >= 10 {
		if parsed, err := time.Parse("2006-01-02", raw[:10]); err == nil {
			return parsed, true
		}
	}
	return time.Time{}, false
}

// ImportAccountGUIDs is the default import account set: every account the
// revenue and expense category mapping uses, de-duplicated and sorted. Cash,
// receivable, tax, discount, COGS and inventory are deliberately left out —
// importing everything that touched the bank account would import the whole
// household.
func (m AccountMapping) ImportAccountGUIDs() []string {
	seen := map[string]bool{}
	for _, guid := range m.Revenue {
		if guid = strings.TrimSpace(guid); guid != "" {
			seen[guid] = true
		}
	}
	for _, guid := range m.Expenses {
		if guid = strings.TrimSpace(guid); guid != "" {
			seen[guid] = true
		}
	}
	out := make([]string, 0, len(seen))
	for guid := range seen {
		out = append(out, guid)
	}
	sort.Strings(out)
	return out
}

// NormalizeGUIDList trims, drops empties and duplicates, and sorts.
func NormalizeGUIDList(in []string) []string {
	seen := map[string]bool{}
	out := []string{}
	for _, guid := range in {
		guid = strings.TrimSpace(guid)
		if guid == "" || seen[guid] {
			continue
		}
		seen[guid] = true
		out = append(out, guid)
	}
	sort.Strings(out)
	return out
}
