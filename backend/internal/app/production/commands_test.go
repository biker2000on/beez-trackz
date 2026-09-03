package production

import (
	"context"
	"testing"

	"github.com/biker2000on/beez-trackz/backend/internal/app"
)

func TestExtractedCommandsReturnTypedInvalidFailures(t *testing.T) {
	tests := map[string]func() error{
		"create lot": func() error { _, err := CreateLot(context.Background(), nil, LotInput{}); return err },
		"update lot": func() error { _, err := UpdateLot(context.Background(), nil, LotInput{}); return err },
		"record bottling": func() error {
			_, err := RecordBottling(context.Background(), nil, RecordBottlingInput{})
			return err
		},
		"record bottling run": func() error {
			_, err := RecordBottlingRun(context.Background(), nil, RecordBottlingRunInput{})
			return err
		},
		"record batch": func() error { _, err := RecordBatch(context.Background(), nil, RecordBatchInput{}); return err },
		"update jar size": func() error {
			_, err := UpdateJarSize(context.Background(), nil, UpdateJarSizeInput{})
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
