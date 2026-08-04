package httpapi

import (
	"encoding/json"
	"testing"
)

func TestCommerceOptionalHTTPURL(t *testing.T) {
	valid := "https://example.com/honey?lot=summer"
	got, err := commerceOptionalHTTPURL(&valid)
	if err != nil {
		t.Fatalf("valid URL returned error: %v", err)
	}
	if got == nil || *got != valid {
		t.Fatalf("URL = %#v, want %q", got, valid)
	}

	for _, value := range []string{
		"javascript:alert(1)",
		"data:text/html,unsafe",
		"/relative/path",
		"not a url",
	} {
		t.Run(value, func(t *testing.T) {
			if _, err := commerceOptionalHTTPURL(&value); err == nil {
				t.Fatal("unsafe URL returned nil error")
			}
		})
	}
}

// Commerce request bodies stay in dollars on the wire and become integer cents
// the moment they are decoded, so no handler ever performs float money math.
func TestCommerceMoneyFieldsDecodeDollarsIntoCents(t *testing.T) {
	var payload struct {
		Amount             money  `json:"amount"`
		MinimumOrderAmount money  `json:"minimumOrderAmount"`
		Tax                *money `json:"tax"`
	}
	body := []byte(`{"amount":249.99,"minimumOrderAmount":150,"tax":null}`)
	if err := json.Unmarshal(body, &payload); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if payload.Amount != 24999 {
		t.Errorf("amount = %d cents, want 24999", int64(payload.Amount))
	}
	if payload.MinimumOrderAmount != 15000 {
		t.Errorf("minimumOrderAmount = %d cents, want 15000", int64(payload.MinimumOrderAmount))
	}
	if payload.Tax != nil {
		t.Errorf("null tax decoded as %v, want nil (no tax recorded is not tax of zero)", payload.Tax)
	}

	// And they marshal back to the same dollars the frontend already renders.
	encoded, err := json.Marshal(map[string]any{"amount": payload.Amount})
	if err != nil {
		t.Fatalf("encode: %v", err)
	}
	if string(encoded) != `{"amount":249.99}` {
		t.Errorf("re-encoded as %s, want {\"amount\":249.99}", encoded)
	}
}
