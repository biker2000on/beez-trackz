package httpapi

import (
	"testing"

	"github.com/google/uuid"
)

func TestNormalizeHoneySaleLinesAggregatesDuplicateJarSizes(t *testing.T) {
	jarSizeID := uuid.New()
	lines, err := normalizeHoneySaleLines([]honeySaleLineInput{
		{JarSizeID: jarSizeID.String(), Quantity: 4, UnitPrice: 12},
		{JarSizeID: jarSizeID.String(), Quantity: 7, UnitPrice: 12},
	})
	if err != nil {
		t.Fatalf("normalizeHoneySaleLines returned error: %v", err)
	}
	if len(lines) != 1 {
		t.Fatalf("got %d lines, want 1", len(lines))
	}
	if lines[0].JarSizeID != jarSizeID || lines[0].Quantity != 11 || lines[0].UnitPrice != 12 {
		t.Fatalf("normalized line = %#v", lines[0])
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
				{JarSizeID: jarSizeID, Quantity: 1, UnitPrice: 10},
				{JarSizeID: jarSizeID, Quantity: 1, UnitPrice: 11},
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
