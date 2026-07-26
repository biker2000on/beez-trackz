package httpapi

import "testing"

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
