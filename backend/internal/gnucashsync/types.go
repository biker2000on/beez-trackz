// Package gnucashsync speaks the folio "beez integration" HTTP contract and
// builds the double-entry transactions beez pushes into it.
//
// The wire contract is owned by folio and is fixed:
//
//	GET    status
//	GET    accounts
//	POST   transactions
//	PUT    transactions/{externalId}
//	DELETE transactions/{externalId}
//	GET    changes?since=<cursor>&limit=<=500
//
// Amounts are integer cents in the book's root currency. Positive is a debit,
// negative a credit, and the cents of a transaction's splits must sum to zero.
//
// Nothing in this package touches the beez database or mutates physical
// records; accounting is downstream of the yard, never upstream of it.
package gnucashsync

// Status is GET status: the book a token is bound to.
type Status struct {
	OK           bool   `json:"ok"`
	BookGUID     string `json:"bookGuid"`
	BookName     string `json:"bookName"`
	RootCurrency string `json:"rootCurrency"`
}

// Account is one row of GET accounts.
type Account struct {
	GUID              string `json:"guid"`
	Name              string `json:"name"`
	FullName          string `json:"fullName"`
	Type              string `json:"type"`
	CommodityMnemonic string `json:"commodityMnemonic"`
	Placeholder       bool   `json:"placeholder"`
	Hidden            bool   `json:"hidden"`
}

// Split is one leg of a transaction. AmountCents is positive for a debit and
// negative for a credit.
type Split struct {
	AccountGUID string `json:"accountGuid"`
	AmountCents int64  `json:"amountCents"`
	Memo        string `json:"memo,omitempty"`
}

// Transaction is the POST/PUT body. ExternalID is omitted on PUT, where the
// path already carries it.
type Transaction struct {
	ExternalID  string  `json:"externalId,omitempty"`
	PostDate    string  `json:"postDate"`
	Description string  `json:"description"`
	Num         string  `json:"num,omitempty"`
	Splits      []Split `json:"splits"`
}

// Sum returns the signed cents of every split. A valid transaction sums to 0.
func (t Transaction) Sum() int64 {
	var total int64
	for _, split := range t.Splits {
		total += split.AmountCents
	}
	return total
}

// WriteResult is the 200/201 body of POST and PUT transactions.
type WriteResult struct {
	TransactionGUID string `json:"transactionGuid"`
	EnterDate       string `json:"enterDate"`
	ExternalID      string `json:"externalId,omitempty"`
	AlreadyLinked   bool   `json:"alreadyLinked,omitempty"`
}

// ChangeSplit is a split as reported by GET changes. Unlike a pushed split it
// also carries folio's reconcile state.
type ChangeSplit struct {
	AccountGUID    string `json:"accountGuid"`
	AmountCents    int64  `json:"amountCents"`
	Memo           string `json:"memo"`
	ReconcileState string `json:"reconcileState"`
}

// Change is one item of GET changes. A tombstone carries only ExternalID and
// Deleted. Unrepresentable items (a transaction folio cannot express in this
// contract, e.g. multi-currency) arrive with no splits and must be surfaced
// to the operator rather than silently ignored.
type Change struct {
	TransactionGUID string        `json:"transactionGuid"`
	ExternalID      *string       `json:"externalId"`
	PostDate        string        `json:"postDate"`
	EnterDate       string        `json:"enterDate"`
	Description     string        `json:"description"`
	Splits          []ChangeSplit `json:"splits"`
	Deleted         bool          `json:"deleted"`
	Unrepresentable bool          `json:"unrepresentable"`
}

// ChangesPage is the GET changes envelope. NextCursor is opaque: store it,
// never parse it.
type ChangesPage struct {
	Items      []Change `json:"items"`
	NextCursor string   `json:"nextCursor"`
	HasMore    bool     `json:"hasMore"`
}
