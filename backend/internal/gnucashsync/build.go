package gnucashsync

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strings"
	"time"
)

// External id prefixes. They are the stable identity folio links against, so
// they must never be recomputed from anything mutable.
const (
	externalIDSale    = "sale:"
	externalIDExpense = "expense:"
)

// SaleExternalID is the folio externalId for a beez sale.
func SaleExternalID(id string) string { return externalIDSale + id }

// ExpenseExternalID is the folio externalId for a beez expense.
func ExpenseExternalID(id string) string { return externalIDExpense + id }

// SaleLine is one sale_items row as the builder needs it.
type SaleLine struct {
	Kind           string
	Quantity       int64
	UnitPriceCents int64
	// CostBasisCents is sale_items.cost_basis_cents: COGS frozen at physical
	// apply. Nil means no recorded basis, which is not the same as zero and
	// contributes nothing to the COGS pair.
	CostBasisCents *int64
	// Label is a human hint for the split memo (jar size label, product
	// name, hive tag). Optional.
	Label string
}

// Sale is one sales row plus its lines.
type Sale struct {
	ID              string
	Date            time.Time
	CustomerName    string
	OrderNumber     string
	Location        string
	TotalCents      int64
	DiscountCents   int64
	AmountPaidCents int64
	// TaxCents is sales.tax_cents. Beez stores the total EXCLUSIVE of tax,
	// so tax is money collected on top of the total.
	TaxCents int64
	Lines    []SaleLine
}

// Expense is one expenses row.
type Expense struct {
	ID          string
	Date        time.Time
	Category    string
	Description string
	Vendor      string
	AmountCents int64
}

// ErrUnbalanced means the splits the builder produced do not sum to zero. It
// is a bug guard, not an operator-facing condition: no unbalanced body is
// ever put on the wire.
var ErrUnbalanced = errors.New("transaction splits do not sum to zero")

// postDate renders a timestamp as the contract YYYY-MM-DD in the local zone,
// matching how beez parses date-only input elsewhere.
func postDate(t time.Time) string {
	return t.In(time.Local).Format("2006-01-02")
}

// BuildSale turns a sale into one balanced GnuCash transaction.
//
// Beez stores total_amount_cents as subtotal - discount, exclusive of tax, so
// the customer owes total + tax. The entry is therefore:
//
//	debit  cash                amount_paid
//	debit  accounts receivable total + tax - amount_paid   (omitted when zero)
//	debit  sales discount      discount                    (omitted when zero)
//	credit revenue/<kind>      quantity * unit_price       (one per mapped account)
//	credit sales tax           tax                         (omitted when zero)
//
// When COGS and inventory are both mapped and at least one line carries a
// cost basis, one more balanced pair rides in the SAME transaction:
//
//	debit  cost of goods sold  sum(cost_basis)
//	credit inventory           sum(cost_basis)
//
// Keeping COGS in the same transaction (rather than a sibling externalId)
// means revenue and its cost can never be half-pushed, and one externalId per
// entity keeps the external_sync link one-to-one.
func BuildSale(sale Sale, mapping AccountMapping) (Transaction, error) {
	if mapping.Cash == "" {
		return Transaction{}, MissingMapping("the cash account")
	}

	// Revenue is grouped by resolved account, because two kinds may map to
	// the same account and folio should see one split, not two.
	gross := int64(0)
	revenueByAccount := map[string]int64{}
	memoByAccount := map[string][]string{}
	for _, line := range sale.Lines {
		account, err := mapping.RevenueAccount(line.Kind)
		if err != nil {
			return Transaction{}, err
		}
		amount := line.Quantity * line.UnitPriceCents
		gross += amount
		revenueByAccount[account] += amount
		memoByAccount[account] = append(memoByAccount[account], lineMemo(line))
	}

	// The lines are the authority on what was sold. If the stored total does
	// not equal subtotal - discount the row is inconsistent, and guessing
	// which side is right would put a wrong number in the books.
	if gross-sale.DiscountCents != sale.TotalCents {
		return Transaction{}, fmt.Errorf(
			"sale total %d cents does not match lines (%d) minus discount (%d)",
			sale.TotalCents, gross, sale.DiscountCents)
	}
	if sale.DiscountCents > 0 && mapping.Discount == "" {
		return Transaction{}, MissingMapping("the sales discount account")
	}
	if sale.TaxCents > 0 && mapping.SalesTax == "" {
		return Transaction{}, MissingMapping("the sales tax liability account")
	}

	receivable := sale.TotalCents + sale.TaxCents - sale.AmountPaidCents
	if receivable != 0 && mapping.AccountsReceivable == "" {
		return Transaction{}, MissingMapping("the accounts receivable account")
	}

	splits := make([]Split, 0, len(revenueByAccount)+5)
	if sale.AmountPaidCents != 0 {
		splits = append(splits, Split{
			AccountGUID: mapping.Cash,
			AmountCents: sale.AmountPaidCents,
			Memo:        "Payment received",
		})
	}
	if receivable != 0 {
		splits = append(splits, Split{
			AccountGUID: mapping.AccountsReceivable,
			AmountCents: receivable,
			Memo:        "Balance due",
		})
	}
	if sale.DiscountCents > 0 {
		splits = append(splits, Split{
			AccountGUID: mapping.Discount,
			AmountCents: sale.DiscountCents,
			Memo:        "Discount",
		})
	}
	for _, account := range sortedKeys(revenueByAccount) {
		splits = append(splits, Split{
			AccountGUID: account,
			AmountCents: -revenueByAccount[account],
			Memo:        truncateMemo(strings.Join(memoByAccount[account], ", ")),
		})
	}
	if sale.TaxCents > 0 {
		splits = append(splits, Split{
			AccountGUID: mapping.SalesTax,
			AmountCents: -sale.TaxCents,
			Memo:        "Sales tax collected",
		})
	}

	if mapping.HasCostOfGoods() {
		basis := int64(0)
		for _, line := range sale.Lines {
			if line.CostBasisCents != nil {
				basis += *line.CostBasisCents
			}
		}
		if basis > 0 {
			splits = append(splits,
				Split{AccountGUID: mapping.COGS, AmountCents: basis, Memo: "Cost of goods sold"},
				Split{AccountGUID: mapping.Inventory, AmountCents: -basis, Memo: "Inventory relieved"},
			)
		}
	}

	txn := Transaction{
		ExternalID:  SaleExternalID(sale.ID),
		PostDate:    postDate(sale.Date),
		Description: saleDescription(sale),
		Num:         sale.OrderNumber,
		Splits:      splits,
	}
	return validate(txn)
}

// BuildExpense turns an expense into a two-split transaction: the category
// account is debited and cash is credited.
func BuildExpense(expense Expense, mapping AccountMapping) (Transaction, error) {
	if mapping.Cash == "" {
		return Transaction{}, MissingMapping("the cash account")
	}
	account, err := mapping.ExpenseAccount(expense.Category)
	if err != nil {
		return Transaction{}, err
	}
	txn := Transaction{
		ExternalID:  ExpenseExternalID(expense.ID),
		PostDate:    postDate(expense.Date),
		Description: expenseDescription(expense),
		Splits: []Split{
			{AccountGUID: account, AmountCents: expense.AmountCents, Memo: truncateMemo(expense.Description)},
			{AccountGUID: mapping.Cash, AmountCents: -expense.AmountCents, Memo: "Paid"},
		},
	}
	return validate(txn)
}

// validate enforces the two invariants the contract states: at least two
// splits, and cents summing to zero.
func validate(txn Transaction) (Transaction, error) {
	if len(txn.Splits) < 2 {
		return Transaction{}, fmt.Errorf(
			"%w: only %d split(s)", ErrUnbalanced, len(txn.Splits))
	}
	if sum := txn.Sum(); sum != 0 {
		return Transaction{}, fmt.Errorf("%w: off by %d cents", ErrUnbalanced, sum)
	}
	return txn, nil
}

// ContentHash fingerprints the body beez intends to push. It is part of the
// idempotency key (so a corrected body is a new request rather than a replay
// of the old answer) and is stored so a later scan can tell "unchanged since
// last push" from "edited locally".
func ContentHash(txn Transaction) string {
	encoded, err := json.Marshal(txn)
	if err != nil {
		// Transaction holds only strings, ints and a slice; marshaling it
		// cannot fail. Fall back to a value that never matches a stored hash
		// so the row re-pushes rather than being wrongly considered clean.
		return "unhashable"
	}
	sum := sha256.Sum256(encoded)
	return hex.EncodeToString(sum[:])
}

// IdempotencyKey combines the stable external id with the content hash. Two
// attempts at the same body replay; a corrected body is a new write. The
// contract caps the header at 200 characters, which this cannot exceed
// (external ids are a prefix plus a uuid, the hash is 64 hex digits).
func IdempotencyKey(externalID, contentHash string) string {
	key := externalID + ":" + contentHash
	if len(key) > 200 {
		key = key[:200]
	}
	return key
}

// DeleteIdempotencyKey is the key for removing a link. A delete is not
// content-addressed, so it keys off the external id alone.
func DeleteIdempotencyKey(externalID string) string {
	key := externalID + ":delete"
	if len(key) > 200 {
		key = key[:200]
	}
	return key
}

func sortedKeys(in map[string]int64) []string {
	out := make([]string, 0, len(in))
	for key := range in {
		out = append(out, key)
	}
	sort.Strings(out)
	return out
}

func lineMemo(line SaleLine) string {
	label := strings.TrimSpace(line.Label)
	if label == "" {
		label = line.Kind
	}
	return fmt.Sprintf("%d x %s", line.Quantity, label)
}

func saleDescription(sale Sale) string {
	parts := []string{"Beez sale"}
	if order := strings.TrimSpace(sale.OrderNumber); order != "" {
		parts = append(parts, order)
	}
	if customer := strings.TrimSpace(sale.CustomerName); customer != "" {
		parts = append(parts, customer)
	} else if location := strings.TrimSpace(sale.Location); location != "" {
		parts = append(parts, location)
	}
	return truncateMemo(strings.Join(parts, " — "))
}

func expenseDescription(expense Expense) string {
	description := strings.TrimSpace(expense.Description)
	if description == "" {
		description = expense.Category
	}
	if vendor := strings.TrimSpace(expense.Vendor); vendor != "" {
		description += " — " + vendor
	}
	return truncateMemo(description)
}

// truncateMemo keeps free text inside a sane column width for GnuCash, on a
// rune boundary so a multi-byte character is never cut in half.
func truncateMemo(text string) string {
	const limit = 200
	text = strings.TrimSpace(text)
	if len(text) <= limit {
		return text
	}
	runes := []rune(text)
	if len(runes) <= limit {
		return string(runes)
	}
	return strings.TrimSpace(string(runes[:limit]))
}
