package sales

import (
	"strings"
	"testing"

	"github.com/google/uuid"
)

func cents(v int64) *int64 { return &v }

func TestConsignmentDefaultShelfPrefersTheStorePrice(t *testing.T) {
	t.Parallel()
	prices := ConsignmentSKUPrices{ListPriceCents: 1200}
	if got := prices.DefaultShelfCents(); got != 1200 {
		t.Errorf("default shelf = %d, want the list price 1200", got)
	}
	prices.StoreShelfCents = cents(1400)
	if got := prices.DefaultShelfCents(); got != 1400 {
		t.Errorf("default shelf = %d, want the store's 1400", got)
	}
}

func TestConsignmentUnitSplit(t *testing.T) {
	t.Parallel()
	bps := 3000
	jar := ConsignmentSKUPrices{Label: "Pint", ListPriceCents: 1200}
	product := ConsignmentSKUPrices{Label: "Lip balm", ListPriceCents: 400, IsProduct: true}
	withStore := func(p ConsignmentSKUPrices, wholesale int64) ConsignmentSKUPrices {
		p.StoreWholesaleCents = cents(wholesale)
		return p
	}
	withList := func(p ConsignmentSKUPrices, list int64) ConsignmentSKUPrices {
		p.PriceListCents = cents(list)
		return p
	}
	retail := ConsignmentTerms{Basis: "retail"}
	commission := ConsignmentTerms{Basis: "commission", CommissionBPS: &bps}
	wholesale := ConsignmentTerms{Basis: "wholesale_list"}

	cases := []struct {
		name             string
		terms            ConsignmentTerms
		prices           ConsignmentSKUPrices
		shelf            int64
		owed, commission int64
		problem          string
	}{
		{"retail owes the shelf price", retail, jar, 1200, 1200, 0, ""},
		{"commission keeps 30%", commission, jar, 1200, 840, 360, ""},
		{"commission ignores store wholesale", commission, withStore(jar, 500), 1200, 840, 360, ""},
		{"store wholesale is owed as is", wholesale, withStore(jar, 800), 1400, 800, 600, ""},
		{"store wholesale beats the list", wholesale, withList(withStore(jar, 800), 700), 1400, 800, 600, ""},
		{"store wholesale is not capped", wholesale, withStore(jar, 800), 500, 800, 0, ""},
		{"store wholesale needs no shelf price", wholesale, withStore(jar, 800), 0, 800, 0, ""},
		{"store wholesale prices products", wholesale, withStore(product, 250), 400, 250, 150, ""},
		{"list fallback", wholesale, withList(jar, 700), 1200, 700, 500, ""},
		{"list fallback is capped", wholesale, withList(jar, 1500), 1200, 1200, 0, ""},
		{"list fallback needs a shelf price", wholesale, withList(jar, 700), 0, 0, 0, "unit price is required"},
		{"no wholesale price", wholesale, jar, 1200, 0, 0, "no wholesale price for Pint"},
		{"lists never price products", wholesale, withList(product, 200), 400, 0, 0, "no wholesale price for Lip balm"},
		{"retail needs a shelf price", retail, jar, 0, 0, 0, "unit price is required"},
	}
	for _, tc := range cases {
		owed, commissionCents, problem := ConsignmentUnitSplit(tc.terms, tc.prices, tc.shelf)
		if tc.problem != "" {
			if !strings.Contains(problem, tc.problem) {
				t.Errorf("%s: problem = %q, want %q", tc.name, problem, tc.problem)
			}
			continue
		}
		if problem != "" || owed != tc.owed || commissionCents != tc.commission {
			t.Errorf("%s: = %d/%d %q, want %d/%d", tc.name, owed, commissionCents, problem, tc.owed, tc.commission)
		}
	}
}

func TestConsignmentPriceBookAssemblesOneSKU(t *testing.T) {
	t.Parallel()
	jar, product := uuid.New(), uuid.New()
	book := ConsignmentPriceBook{
		Jars:      map[uuid.UUID]ConsignmentStorePrice{jar: {WholesaleCents: cents(800)}},
		Products:  map[uuid.UUID]ConsignmentStorePrice{product: {ShelfCents: cents(500)}},
		PriceList: map[uuid.UUID]int64{jar: 700},
	}
	got := book.SKU(&jar, nil, "Pint", 1200)
	if got.IsProduct || got.ListPriceCents != 1200 || got.StoreWholesaleCents == nil ||
		*got.StoreWholesaleCents != 800 || got.PriceListCents == nil || *got.PriceListCents != 700 ||
		got.StoreShelfCents != nil {
		t.Errorf("jar prices = %+v", got)
	}
	got = book.SKU(nil, &product, "Lip balm", 400)
	if !got.IsProduct || got.PriceListCents != nil || got.StoreShelfCents == nil || *got.StoreShelfCents != 500 {
		t.Errorf("product prices = %+v", got)
	}
}
