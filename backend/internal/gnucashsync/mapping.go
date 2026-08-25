package gnucashsync

import (
	"fmt"
	"strings"
)

// SaleLineKinds is the sale_items.kind CHECK list (00015 + 00020). Every kind
// needs a revenue account before a sale carrying that kind can be pushed.
var SaleLineKinds = []string{
	"jar",
	"colony",
	"equipment",
	"creamed_honey",
	"hot_honey",
	"mead",
	"propolis",
	"tincture",
}

// ExpenseCategories is the expenses.category CHECK list (00002 + the later
// grocery addition). Each needs an expense account.
var ExpenseCategories = []string{
	"bees_queens",
	"feed",
	"treatments",
	"packaging",
	"equipment",
	"mileage",
	"market_fees",
	"labor",
	"other",
	"grocery",
}

// AccountMapping is the operator-maintained bridge between beez concepts and
// folio account GUIDs. It is stored as gnucash_sync_settings.account_mapping.
//
// Cash, AccountsReceivable and the per-kind revenue accounts are required for
// sales; per-category expense accounts are required for expenses. SalesTax is
// required only when a sale records tax, Discount only when it records a
// discount, and COGS/Inventory are an optional pair — mapping neither means
// beez posts revenue without cost of goods.
type AccountMapping struct {
	Revenue            map[string]string `json:"revenue,omitempty"`
	Expenses           map[string]string `json:"expenses,omitempty"`
	Cash               string            `json:"cash,omitempty"`
	AccountsReceivable string            `json:"accountsReceivable,omitempty"`
	SalesTax           string            `json:"salesTax,omitempty"`
	Discount           string            `json:"discount,omitempty"`
	COGS               string            `json:"cogs,omitempty"`
	Inventory          string            `json:"inventory,omitempty"`
}

// mappingError names the missing mapping so the operator can act on the
// failure without reading logs.
type mappingError struct{ what string }

func (e *mappingError) Error() string {
	return "no GnuCash account mapped for " + e.what
}

// MissingMapping builds the error the engine stores in last_error.
func MissingMapping(what string) error { return &mappingError{what: what} }

// Normalize trims every GUID and drops empty entries, so "" and "absent" are
// the same state everywhere downstream.
func (m AccountMapping) Normalize() AccountMapping {
	out := AccountMapping{
		Cash:               strings.TrimSpace(m.Cash),
		AccountsReceivable: strings.TrimSpace(m.AccountsReceivable),
		SalesTax:           strings.TrimSpace(m.SalesTax),
		Discount:           strings.TrimSpace(m.Discount),
		COGS:               strings.TrimSpace(m.COGS),
		Inventory:          strings.TrimSpace(m.Inventory),
	}
	out.Revenue = normalizeGUIDs(m.Revenue, SaleLineKinds)
	out.Expenses = normalizeGUIDs(m.Expenses, ExpenseCategories)
	return out
}

// normalizeGUIDs keeps only known keys with a non-empty GUID. An unknown key
// is dropped rather than stored: the CHECK lists are the source of truth, and
// a stale key would quietly shadow a rename.
func normalizeGUIDs(in map[string]string, allowed []string) map[string]string {
	if len(in) == 0 {
		return nil
	}
	permitted := make(map[string]bool, len(allowed))
	for _, key := range allowed {
		permitted[key] = true
	}
	out := make(map[string]string, len(in))
	for key, guid := range in {
		guid = strings.TrimSpace(guid)
		if guid == "" || !permitted[key] {
			continue
		}
		out[key] = guid
	}
	if len(out) == 0 {
		return nil
	}
	return out
}

// RevenueAccount resolves the revenue account for a sale line kind.
func (m AccountMapping) RevenueAccount(kind string) (string, error) {
	if guid := m.Revenue[kind]; guid != "" {
		return guid, nil
	}
	return "", MissingMapping(fmt.Sprintf("sale line kind %q", kind))
}

// ExpenseAccount resolves the expense account for an expense category.
func (m AccountMapping) ExpenseAccount(category string) (string, error) {
	if guid := m.Expenses[category]; guid != "" {
		return guid, nil
	}
	return "", MissingMapping(fmt.Sprintf("expense category %q", category))
}

// HasCostOfGoods reports whether both halves of the optional COGS pair are
// mapped. One half alone cannot balance, so it counts as unmapped.
func (m AccountMapping) HasCostOfGoods() bool {
	return m.COGS != "" && m.Inventory != ""
}

// Complete reports whether the mapping can push anything at all: without a
// cash account there is no funding side to any entry.
func (m AccountMapping) Complete() bool {
	return m.Cash != ""
}
