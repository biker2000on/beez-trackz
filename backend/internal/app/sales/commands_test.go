package sales

import (
	"context"
	"testing"

	"github.com/biker2000on/beez-trackz/backend/internal/app"
)

func TestExtractedCommandsReturnTypedInvalidFailures(t *testing.T) {
	tests := map[string]func() error{
		"record sale": func() error { _, err := RecordSale(context.Background(), nil, RecordSaleInput{}); return err },
		"update sale": func() error { _, err := UpdateSale(context.Background(), nil, UpdateSaleInput{}); return err },
		"cancel sale": func() error { _, err := CancelSale(context.Background(), nil, CancelSaleInput{}); return err },
		"apply settlement": func() error {
			_, err := ApplySettlement(context.Background(), nil, ApplySettlementInput{})
			return err
		},
	}
	for name, invoke := range tests {
		t.Run(name, func(t *testing.T) {
			if err := invoke(); !app.IsKind(err, app.KindInvalid) {
				t.Fatalf("error kind = %q, want %q: %v", app.KindOf(err), app.KindInvalid, err)
			}
		})
	}
}
