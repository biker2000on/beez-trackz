package brand

import (
	"reflect"
	"strings"
	"testing"
)

var brandEnvironment = []string{
	"BRAND_DISPLAY_NAME", "BRAND_SHORT_NAME", "BRAND_TAGLINE",
	"BRAND_WORDMARK_URL", "BRAND_MARK_URL", "BRAND_THEME_COLOR",
	"BRAND_BACKGROUND_COLOR",
}

func clearBrandEnvironment(t *testing.T) {
	t.Helper()
	for _, key := range brandEnvironment {
		t.Setenv(key, "")
	}
}

func TestBrandLoadDefaults(t *testing.T) {
	clearBrandEnvironment(t)
	got, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	if want := Default(); !reflect.DeepEqual(got, want) {
		t.Fatalf("Load() = %#v, want %#v", got, want)
	}
	if got.MarkURL != "" || got.WordmarkURL != "" {
		t.Fatal("built-in assets must be represented by empty override URLs")
	}
}

func TestBrandLoadGentleBeeOverride(t *testing.T) {
	clearBrandEnvironment(t)
	t.Setenv("BRAND_DISPLAY_NAME", "GentleBee Atlas")
	t.Setenv("BRAND_SHORT_NAME", "GentleBee")
	got, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	if got.DisplayName != "GentleBee Atlas" || got.ShortName != "GentleBee" {
		t.Fatalf("resolved brand = %#v", got)
	}
	if got.Tagline != Default().Tagline {
		t.Fatal("unset tagline did not fall back independently")
	}
}

func TestBrandLoadThirdBrandWithoutRebuild(t *testing.T) {
	clearBrandEnvironment(t)
	t.Setenv("BRAND_DISPLAY_NAME", "Orchard Ledger")
	t.Setenv("BRAND_SHORT_NAME", "Orchard")
	t.Setenv("BRAND_TAGLINE", "Pollination records for community orchards")
	t.Setenv("BRAND_WORDMARK_URL", "/brand/orchard-wordmark.svg")
	t.Setenv("BRAND_MARK_URL", "https://cdn.example.test/mark.png")
	t.Setenv("BRAND_THEME_COLOR", "#A1B2C3")
	t.Setenv("BRAND_BACKGROUND_COLOR", "#102030")
	got, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	if got.DisplayName != "Orchard Ledger" || got.ThemeColor != "#a1b2c3" ||
		got.WordmarkURL != "/brand/orchard-wordmark.svg" {
		t.Fatalf("third brand = %#v", got)
	}
	if got.Public().DisplayName != got.DisplayName {
		t.Fatal("public view lost presentation values")
	}
}

func TestBrandLoadRejectsInvalidValues(t *testing.T) {
	tests := []struct {
		name, key, value, errorPart string
	}{
		{"display too long", "BRAND_DISPLAY_NAME", strings.Repeat("x", 41), "1-40"},
		{"short too long", "BRAND_SHORT_NAME", strings.Repeat("x", 13), "1-12"},
		{"tagline too long", "BRAND_TAGLINE", strings.Repeat("x", 121), "0-120"},
		{"markup", "BRAND_DISPLAY_NAME", "<b>Atlas</b>", "markup"},
		{"entity markup", "BRAND_TAGLINE", "Atlas &copy;", "markup"},
		{"short color", "BRAND_THEME_COLOR", "#fff", "#rrggbb"},
		{"invalid color", "BRAND_BACKGROUND_COLOR", "orange", "#rrggbb"},
		{"relative URL", "BRAND_MARK_URL", "brand/mark.svg", "absolute /brand/"},
		{"wrong local path", "BRAND_MARK_URL", "/assets/mark.svg", "under /brand/"},
		{"path traversal", "BRAND_MARK_URL", "/brand/../secret.svg", "under /brand/"},
		{"data URL", "BRAND_MARK_URL", "data:image/svg+xml,test", "https"},
		{"javascript URL", "BRAND_WORDMARK_URL", "javascript:alert(1)", "https"},
		{"http URL", "BRAND_WORDMARK_URL", "http://example.test/mark.svg", "https"},
		{"credential URL", "BRAND_MARK_URL", "https://user@example.test/mark.svg", "credentials"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			clearBrandEnvironment(t)
			t.Setenv(test.key, test.value)
			_, err := Load()
			if err == nil || !strings.Contains(err.Error(), test.errorPart) {
				t.Fatalf("Load() error = %v, want containing %q", err, test.errorPart)
			}
		})
	}
}

func TestDeriveShortNameMatchesTheSharedContract(t *testing.T) {
	cases := map[string]string{
		"Apiary Atlas":          "Apiary Atlas",
		"GentleBee Atlas":       "GentleBee",
		"Sunny Meadow Apiary":   "Sunny Meadow",
		"Thistledownbeekeeping": "Thistledownb",
	}
	for in, want := range cases {
		if got := DeriveShortName(in); got != want {
			t.Errorf("DeriveShortName(%q) = %q, want %q", in, got, want)
		}
	}
	t.Setenv("BRAND_DISPLAY_NAME", "  GentleBee Atlas  ")
	t.Setenv("BRAND_SHORT_NAME", "")
	got, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	if got.DisplayName != "GentleBee Atlas" || got.ShortName != "GentleBee" {
		t.Fatalf("Load() = %+v", got)
	}
}
