package httpapi

import (
	"testing"

	"github.com/biker2000on/beez-trackz/backend/internal/app/production"
	"github.com/google/uuid"
)

// Two lines of one size from two lots stay two lines; repeats of the same
// (size, lot) merge, so each lot's draw is checked whole.
func TestNormalizeHoneySaleLinesKeepsLotsApart(t *testing.T) {
	size, sourwood, wildflower := uuid.New(), uuid.New(), uuid.New()
	lines, err := normalizeHoneySaleLines([]honeySaleLineInput{
		{JarSizeID: size.String(), HarvestLotID: sourwood.String(), Quantity: 2, UnitPrice: 1500},
		{JarSizeID: size.String(), HarvestLotID: wildflower.String(), Quantity: 3, UnitPrice: 1500},
		{JarSizeID: size.String(), HarvestLotID: sourwood.String(), Quantity: 1, UnitPrice: 1500},
	})
	if err != nil {
		t.Fatalf("normalizeHoneySaleLines: %v", err)
	}
	if len(lines) != 2 {
		t.Fatalf("got %d lines, want 2: %#v", len(lines), lines)
	}
	if lines[0].HarvestLotID != sourwood || lines[0].Quantity != 3 {
		t.Fatalf("sourwood line = %#v", lines[0])
	}
	if lines[1].HarvestLotID != wildflower || lines[1].Quantity != 3 {
		t.Fatalf("wildflower line = %#v", lines[1])
	}
}

func TestNormalizeHoneySaleLinesRejectsLotOnNonJar(t *testing.T) {
	_, err := normalizeHoneySaleLines([]honeySaleLineInput{
		{Kind: "mead", ProductID: uuid.NewString(), HarvestLotID: uuid.NewString(), Quantity: 1, UnitPrice: 1000},
	})
	if err == nil || err.Error() != "harvestLotId is only valid on jar lines" {
		t.Fatalf("err = %v", err)
	}
	_, err = normalizeHoneySaleLines([]honeySaleLineInput{
		{JarSizeID: uuid.NewString(), HarvestLotID: "not-a-uuid", Quantity: 1, UnitPrice: 1000},
	})
	if err == nil || err.Error() != "invalid harvestLotId" {
		t.Fatalf("err = %v", err)
	}
}

// A give-away line needs a lot; blank lines are skipped; repeats merge.
func TestHoneyValidGiveAwayLines(t *testing.T) {
	size, lot := uuid.New(), uuid.New()
	lines, err := honeyValidGiveAwayLines([]honeyGiveAwayLineReq{
		{JarSizeID: size.String(), HarvestLotID: lot.String(), Quantity: 2},
		{JarSizeID: size.String(), HarvestLotID: lot.String(), Quantity: 3},
		{JarSizeID: size.String(), Quantity: 0},
		{JarSizeID: "", HarvestLotID: lot.String(), Quantity: 4},
	})
	if err != nil {
		t.Fatalf("honeyValidGiveAwayLines: %v", err)
	}
	if len(lines) != 1 || lines[0].Quantity != 5 || lines[0].HarvestLotID != lot || lines[0].JarSizeID != size {
		t.Fatalf("lines = %#v", lines)
	}

	_, err = honeyValidGiveAwayLines([]honeyGiveAwayLineReq{{JarSizeID: size.String(), Quantity: 1}})
	if err == nil || err.Error() != production.ErrGiveAwayNeedsLot {
		t.Fatalf("missing lot err = %v, want %q", err, production.ErrGiveAwayNeedsLot)
	}
	_, err = honeyValidGiveAwayLines([]honeyGiveAwayLineReq{{JarSizeID: size.String(), HarvestLotID: "x", Quantity: 1}})
	if err == nil || err.Error() != "invalid harvestLotId" {
		t.Fatalf("bad lot err = %v", err)
	}
}
