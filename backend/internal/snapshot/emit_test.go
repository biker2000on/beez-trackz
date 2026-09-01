package snapshot

import (
	"bytes"
	"testing"
	"time"
)

func TestEmitVerificationIsCanonicalAndLFTeminated(t *testing.T) {
	input := Verification{Version: 1, FormatVersion: 1,
		GeneratedAt:  time.Date(2026, 9, 1, 0, 0, 0, 0, time.UTC),
		RecordCounts: map[string]int64{"z": 0, "a": 1}}
	var output bytes.Buffer
	if err := EmitVerification(&output, input); err != nil {
		t.Fatal(err)
	}
	if got := output.String(); got[len(got)-1] != '\n' {
		t.Fatalf("emitted document lacks final LF: %q", got)
	}
	if bytes.Index(output.Bytes(), []byte(`"a":1`)) > bytes.Index(output.Bytes(), []byte(`"z":0`)) {
		t.Fatalf("map keys are not canonical: %s", output.String())
	}
}
