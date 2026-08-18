package httpapi

import (
	"testing"

	"github.com/google/uuid"
)

// Unit prices are money (integer cents) here; the dollars in the JSON body are
// converted by money.UnmarshalJSON before these functions see them.
func TestNormalizeHoneySaleLinesAggregatesDuplicateJarSizes(t *testing.T) {
	jarSizeID := uuid.New()
	lines, err := normalizeHoneySaleLines([]honeySaleLineInput{
		{JarSizeID: jarSizeID.String(), Quantity: 4, UnitPrice: 1200},
		{JarSizeID: jarSizeID.String(), Quantity: 7, UnitPrice: 1200},
	})
	if err != nil {
		t.Fatalf("normalizeHoneySaleLines returned error: %v", err)
	}
	if len(lines) != 1 {
		t.Fatalf("got %d lines, want 1", len(lines))
	}
	if lines[0].JarSizeID != jarSizeID || lines[0].Quantity != 11 || lines[0].UnitPrice != 1200 {
		t.Fatalf("normalized line = %#v", lines[0])
	}
	// Exact integer arithmetic: 11 x $12.00 is $132.00 to the cent.
	if total := lines[0].UnitPrice.mulQuantity(lines[0].Quantity); total != 13200 {
		t.Fatalf("line total = %d cents, want 13200", int64(total))
	}
}

func TestHoneyCheckJarAvailability(t *testing.T) {
	small, large := uuid.New(), uuid.New()
	onHand := map[uuid.UUID]int{small: 5, large: 0}
	labels := map[uuid.UUID]string{small: "Half Pint", large: "Quart"}

	if message := honeyCheckJarAvailability(onHand, labels, map[uuid.UUID]int{small: 5}); message != "" {
		t.Fatalf("selling exactly the stock on hand was rejected: %s", message)
	}
	message := honeyCheckJarAvailability(onHand, labels, map[uuid.UUID]int{small: 6})
	if message != "Not enough Half Pint: need 6, have 5" {
		t.Fatalf("shortfall message = %q", message)
	}
	// A jar size with no ledger history reads as zero on hand, not unlimited.
	if honeyCheckJarAvailability(onHand, labels, map[uuid.UUID]int{uuid.New(): 1}) == "" {
		t.Fatal("an unknown jar size was treated as available")
	}
}

func TestHoneyBulkShortfall(t *testing.T) {
	if message := honeyBulkShortfall(3, 10); message != "" {
		t.Fatalf("a withdrawal inside the pool was rejected: %s", message)
	}
	// Pounds are fractional measurements, so the comparison tolerates the
	// float noise that exact-cent money arithmetic does not have to.
	if message := honeyBulkShortfall(10.00000001, 10); message != "" {
		t.Fatalf("float noise rejected a valid withdrawal: %s", message)
	}
	if honeyBulkShortfall(500, 3) == "" {
		t.Fatal("jarring 500 lbs against 3 lbs on hand was accepted")
	}
}

func TestParseBoundedLimitClampsAndDefaults(t *testing.T) {
	if got := parseBoundedLimit("", 50, 200); got != 50 {
		t.Errorf("empty = %d, want default 50", got)
	}
	if got := parseBoundedLimit("10", 50, 200); got != 10 {
		t.Errorf("10 = %d, want 10", got)
	}
	if got := parseBoundedLimit("999999999", 50, 200); got != 200 {
		t.Errorf("huge limit = %d, want max 200", got)
	}
	if got := parseBoundedLimit("0", 50, 200); got != 50 {
		t.Errorf("zero = %d, want default 50", got)
	}
	if got := parseBoundedLimit("-4", 50, 200); got != 50 {
		t.Errorf("negative = %d, want default 50", got)
	}
	if got := parseBoundedLimit("nope", 50, 200); got != 50 {
		t.Errorf("garbage = %d, want default 50", got)
	}
}

func TestHoneySalePriceRequired(t *testing.T) {
	line := honeySaleLine{JarSizeID: uuid.New(), Quantity: 1, UnitPrice: 0}
	if err := honeySalePriceRequired("farmers_market", []honeySaleLine{line}); err == nil {
		t.Fatal("a $0 farmers-market sale was accepted")
	}
	if err := honeySalePriceRequired("gift", []honeySaleLine{line}); err != nil {
		t.Fatalf("a $0 gift was rejected: %v", err)
	}
	priced := line
	priced.UnitPrice = 800
	if err := honeySalePriceRequired("direct", []honeySaleLine{priced}); err != nil {
		t.Fatalf("a priced sale was rejected: %v", err)
	}
}

func TestNormalizeHoneySaleLinesRejectsConflictingOrNegativePrices(t *testing.T) {
	jarSizeID := uuid.New().String()
	tests := []struct {
		name  string
		lines []honeySaleLineInput
	}{
		{
			name: "conflicting duplicate prices",
			lines: []honeySaleLineInput{
				{JarSizeID: jarSizeID, Quantity: 1, UnitPrice: 1000},
				{JarSizeID: jarSizeID, Quantity: 1, UnitPrice: 1100},
			},
		},
		{
			name: "negative price",
			lines: []honeySaleLineInput{
				{JarSizeID: jarSizeID, Quantity: 1, UnitPrice: -1},
			},
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if _, err := normalizeHoneySaleLines(test.lines); err == nil {
				t.Fatal("normalizeHoneySaleLines returned nil error")
			}
		})
	}
}
