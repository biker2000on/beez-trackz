package httpapi

import (
	"bytes"
	"errors"
	"math"
	"strconv"
	"strings"
)

// Money is stored and computed as integer cents everywhere inside the process
// and the database. The JSON contract stays in dollars, so every conversion
// funnels through this file: cents -> dollars when marshaling (always two
// decimal places), dollars -> cents when parsing (half away from zero).
//
// Nothing outside this file may do float arithmetic on an amount, and no code
// anywhere may compare two amounts with float equality.

// money is a signed amount in cents.
type money int64

const centsPerDollar = 100

// Dollars renders the amount as a float for ratio math (cost per pound, margin
// percentages). Never use it to store, compare, or accumulate an amount.
func (m money) Dollars() float64 { return float64(m) / centsPerDollar }

// MarshalJSON writes dollars with exactly two decimals, so the wire format is
// identical to what the float columns produced before the cents migration.
func (m money) MarshalJSON() ([]byte, error) {
	sign := ""
	value := int64(m)
	if value < 0 {
		sign = "-"
		value = -value
	}
	return []byte(sign + strconv.FormatInt(value/centsPerDollar, 10) + "." +
		pad2(value%centsPerDollar)), nil
}

func pad2(v int64) string {
	if v < 10 {
		return "0" + strconv.FormatInt(v, 10)
	}
	return strconv.FormatInt(v, 10)
}

// UnmarshalJSON accepts a JSON number (or a numeric string) in dollars.
func (m *money) UnmarshalJSON(data []byte) error {
	raw := strings.TrimSpace(string(bytes.Trim(data, `"`)))
	if raw == "" || raw == "null" {
		*m = 0
		return nil
	}
	cents, err := parseDollarsToCents(raw)
	if err != nil {
		return err
	}
	*m = money(cents)
	return nil
}

var errInvalidMoney = errors.New("invalid monetary amount")

// maxMoneyDollars is far beyond any real honey or equipment price and keeps
// dollars*centsPerDollar inside int64.
const maxMoneyDollars int64 = 1_000_000_000_000 // 1e12

// parseDollarsToCents converts a decimal dollar string to cents, rounding half
// away from zero. It works on the decimal text rather than a float so that
// "1.005" becomes 101 cents instead of the 100 a binary float would produce.
func parseDollarsToCents(raw string) (int64, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return 0, errInvalidMoney
	}
	if strings.ContainsAny(raw, "eE") {
		// Exponent notation is rare enough that the float path is acceptable.
		value, err := strconv.ParseFloat(raw, 64)
		if err != nil || math.IsNaN(value) || math.IsInf(value, 0) ||
			math.Abs(value) > float64(maxMoneyDollars) {
			return 0, errInvalidMoney
		}
		return dollarsToCents(value), nil
	}

	negative := false
	switch raw[0] {
	case '-':
		negative, raw = true, raw[1:]
	case '+':
		raw = raw[1:]
	}
	whole, fraction, _ := strings.Cut(raw, ".")
	if whole == "" {
		whole = "0"
	}
	if !allDigits(whole) || !allDigits(fraction) {
		return 0, errInvalidMoney
	}
	dollars, err := strconv.ParseInt(whole, 10, 64)
	if err != nil || dollars > maxMoneyDollars {
		return 0, errInvalidMoney
	}
	// Pad/truncate the fraction to three digits: two for cents plus one to
	// decide the rounding.
	for len(fraction) < 3 {
		fraction += "0"
	}
	digits, err := strconv.ParseInt(fraction[:3], 10, 64)
	if err != nil {
		return 0, errInvalidMoney
	}
	cents := dollars*centsPerDollar + digits/10
	if digits%10 >= 5 {
		cents++
	}
	if negative {
		cents = -cents
	}
	return cents, nil
}

func allDigits(value string) bool {
	for _, r := range value {
		if r < '0' || r > '9' {
			return false
		}
	}
	return true
}

// dollarsToCents converts a float amount, correcting the binary representation
// before rounding so 1.005 does not silently round down.
func dollarsToCents(dollars float64) int64 {
	if math.IsNaN(dollars) || math.IsInf(dollars, 0) {
		return 0
	}
	// Six decimals is far beyond any real price and re-collapses artifacts such
	// as 100.49999999999999 onto 100.5 before the half-away-from-zero rounding.
	cleaned, err := strconv.ParseFloat(strconv.FormatFloat(dollars*centsPerDollar, 'f', 6, 64), 64)
	if err != nil {
		return 0
	}
	return int64(math.Round(cleaned))
}

// moneyFromDollarsPtr converts an optional dollar amount from a request body.
func moneyFromDollarsPtr(dollars *float64) *money {
	if dollars == nil {
		return nil
	}
	value := money(dollarsToCents(*dollars))
	return &value
}

// moneyPtr is the pointer form used for nullable response fields.
func moneyPtr(cents *int64) *money {
	if cents == nil {
		return nil
	}
	value := money(*cents)
	return &value
}

// mulQuantity multiplies a unit amount by a whole quantity in exact cents.
func (m money) mulQuantity(quantity int) money { return m * money(quantity) }
