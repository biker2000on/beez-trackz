package sales

import "testing"

func TestSaleCustomerNamePrefersTheCompany(t *testing.T) {
	str := func(s string) *string { return &s }
	cases := []struct {
		company *string
		name    string
		want    string
	}{
		{str("  Carolina Pedal Works "), "Jane Doe", "Carolina Pedal Works"},
		{nil, " Ann Buyer ", "Ann Buyer"},
		{str("   "), "Ann Buyer", "Ann Buyer"},
		{str(""), "Ann Buyer", "Ann Buyer"},
	}
	for _, c := range cases {
		got := SaleCustomerName(c.company, c.name)
		if got == nil || *got != c.want {
			t.Errorf("SaleCustomerName(%v, %q) = %v, want %q", c.company, c.name, got, c.want)
		}
	}
	if got := SaleCustomerName(nil, "  "); got != nil {
		t.Errorf("blank customer = %q, want nil", *got)
	}
}

func TestConsignmentSaleCustomerNameUsesALinkedCompanyElseTheStore(t *testing.T) {
	company := " Hilltop Grocery LLC "
	if got := *consignmentSaleCustomerName("Hilltop Grocery", &company); got != "Hilltop Grocery LLC" {
		t.Errorf("linked company: %q", got)
	}
	blank := "  "
	if got := *consignmentSaleCustomerName("Hilltop Grocery", &blank); got != "Hilltop Grocery" {
		t.Errorf("linked customer without company: %q", got)
	}
	if got := *consignmentSaleCustomerName("Hilltop Grocery", nil); got != "Hilltop Grocery" {
		t.Errorf("no linked customer: %q", got)
	}
}
