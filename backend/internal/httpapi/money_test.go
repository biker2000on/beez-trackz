package httpapi

import (
	"testing"
)

func TestParseDollarsToCentsRoundingAndSign(t *testing.T) {
	tests := []struct {
		in   string
		want int64
	}{
		{"1.005", 101},
		{"1.004", 100},
		{"0.015", 2},
		{"12.34", 1234},
		{"-12.34", -1234},
		{"-1.005", -101},
		{"0", 0},
		{"+2.5", 250},
	}
	for _, test := range tests {
		got, err := parseDollarsToCents(test.in)
		if err != nil {
			t.Errorf("parseDollarsToCents(%q) error: %v", test.in, err)
			continue
		}
		if got != test.want {
			t.Errorf("parseDollarsToCents(%q) = %d, want %d", test.in, got, test.want)
		}
	}
}

func TestParseDollarsToCentsRejectsOverflow(t *testing.T) {
	// Fits in int64 before *100, but would wrap signed cents.
	for _, in := range []string{
		"1000000000001",
		"92233720368547758",
		"1e20",
		"-1000000000001",
		"1e13",
	} {
		if _, err := parseDollarsToCents(in); err == nil {
			t.Errorf("parseDollarsToCents(%q) accepted an overflowing amount", in)
		}
	}
}

func TestParseDollarsToCentsRejectsInvalid(t *testing.T) {
	for _, in := range []string{"", "   ", "abc", "1.2.3", "12dollars"} {
		if _, err := parseDollarsToCents(in); err == nil {
			t.Errorf("parseDollarsToCents(%q) accepted invalid input", in)
		}
	}
}
