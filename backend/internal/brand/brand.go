// Package brand owns the validated, human-facing deployment identity.
// Machine identifiers deliberately do not belong in this package.
package brand

import (
	"fmt"
	"net/url"
	"os"
	"path"
	"regexp"
	"strings"
	"unicode"
	"unicode/utf8"
)

const (
	Product = "Apiary Atlas"

	defaultTagline         = "Hive, harvest and honey records for a working apiary"
	defaultThemeColor      = "#d97706"
	defaultBackgroundColor = "#fbf7ef"
)

// Brand is the complete public presentation contract resolved at startup.
type Brand struct {
	DisplayName     string `json:"displayName"`
	ShortName       string `json:"shortName"`
	Tagline         string `json:"tagline"`
	WordmarkURL     string `json:"wordmarkUrl"`
	MarkURL         string `json:"markUrl"`
	ThemeColor      string `json:"themeColor"`
	BackgroundColor string `json:"backgroundColor"`
}

// PublicBrand is the browser-safe view of a Brand. It intentionally contains
// presentation values only: no environment names, secrets, or infrastructure.
type PublicBrand struct {
	DisplayName     string `json:"displayName"`
	ShortName       string `json:"shortName"`
	Tagline         string `json:"tagline"`
	WordmarkURL     string `json:"wordmarkUrl"`
	MarkURL         string `json:"markUrl"`
	ThemeColor      string `json:"themeColor"`
	BackgroundColor string `json:"backgroundColor"`
}

var (
	colorPattern  = regexp.MustCompile(`^#[0-9a-fA-F]{6}$`)
	entityPattern = regexp.MustCompile(`(?i)&(?:#[0-9]+|#x[0-9a-f]+|[a-z][a-z0-9]+);`)
)

// Default returns the upstream Apiary Atlas presentation.
func Default() Brand {
	return Brand{
		DisplayName:     Product,
		ShortName:       Product,
		Tagline:         defaultTagline,
		ThemeColor:      defaultThemeColor,
		BackgroundColor: defaultBackgroundColor,
	}
}

// Load resolves the brand from BRAND_* environment variables. Empty variables
// fall back independently; a non-empty invalid value is always an error.
func Load() (Brand, error) {
	defaults := Default()
	resolved := Brand{
		DisplayName:     envOr("BRAND_DISPLAY_NAME", defaults.DisplayName),
		Tagline:         envOr("BRAND_TAGLINE", defaults.Tagline),
		WordmarkURL:     envOr("BRAND_WORDMARK_URL", defaults.WordmarkURL),
		MarkURL:         envOr("BRAND_MARK_URL", defaults.MarkURL),
		ThemeColor:      envOr("BRAND_THEME_COLOR", defaults.ThemeColor),
		BackgroundColor: envOr("BRAND_BACKGROUND_COLOR", defaults.BackgroundColor),
	}
	// The short name is derived from the display name when it is unset
	// (SHARED BRAND CONTRACT, "short-name derivation" — mirrored in
	// frontend/src/lib/brand.ts).
	resolved.ShortName = envOr("BRAND_SHORT_NAME", DeriveShortName(resolved.DisplayName))

	if err := validateText("BRAND_DISPLAY_NAME", resolved.DisplayName, 1, 40); err != nil {
		return Brand{}, err
	}
	if err := validateText("BRAND_SHORT_NAME", resolved.ShortName, 1, 12); err != nil {
		return Brand{}, err
	}
	if err := validateText("BRAND_TAGLINE", resolved.Tagline, 0, 120); err != nil {
		return Brand{}, err
	}
	if err := validateAssetURL("BRAND_WORDMARK_URL", resolved.WordmarkURL); err != nil {
		return Brand{}, err
	}
	if err := validateAssetURL("BRAND_MARK_URL", resolved.MarkURL); err != nil {
		return Brand{}, err
	}
	if !colorPattern.MatchString(resolved.ThemeColor) {
		return Brand{}, fmt.Errorf("BRAND_THEME_COLOR must be a #rrggbb color")
	}
	if !colorPattern.MatchString(resolved.BackgroundColor) {
		return Brand{}, fmt.Errorf("BRAND_BACKGROUND_COLOR must be a #rrggbb color")
	}
	resolved.ThemeColor = strings.ToLower(resolved.ThemeColor)
	resolved.BackgroundColor = strings.ToLower(resolved.BackgroundColor)
	return resolved, nil
}

// Public returns a copy containing only values safe to expose to clients.
func (b Brand) Public() PublicBrand {
	return PublicBrand{
		DisplayName:     b.DisplayName,
		ShortName:       b.ShortName,
		Tagline:         b.Tagline,
		WordmarkURL:     b.WordmarkURL,
		MarkURL:         b.MarkURL,
		ThemeColor:      b.ThemeColor,
		BackgroundColor: b.BackgroundColor,
	}
}

// envOr trims the variable; unset, empty and whitespace-only all mean "use
// the default for this field" (same rule as the web side).
func envOr(key, fallback string) string {
	value := strings.TrimSpace(os.Getenv(key))
	if value == "" {
		return fallback
	}
	return value
}

// ShortNameMax is the launcher-label limit in Unicode code points.
const ShortNameMax = 12

// DeriveShortName applies the shared derivation rule: a display name of at
// most 12 code points is used whole; otherwise the first 12 code points form
// the window — if the next code point is a space the window is used (trailing
// space trimmed), else cut at the last space inside the window, else the
// window is used unchanged. No ellipsis is ever added.
func DeriveShortName(displayName string) string {
	points := []rune(displayName)
	if len(points) <= ShortNameMax {
		return displayName
	}
	window := string(points[:ShortNameMax])
	if points[ShortNameMax] == ' ' {
		return strings.TrimRight(window, " ")
	}
	cut := window
	if last := strings.LastIndex(window, " "); last > 0 {
		cut = window[:last]
	}
	if trimmed := strings.TrimSpace(cut); trimmed != "" {
		return trimmed
	}
	return strings.TrimSpace(window)
}

func validateText(key, value string, minimum, maximum int) error {
	if !utf8.ValidString(value) {
		return fmt.Errorf("%s must be valid UTF-8", key)
	}
	if strings.TrimSpace(value) != value {
		return fmt.Errorf("%s must not have leading or trailing whitespace", key)
	}
	length := utf8.RuneCountInString(value)
	if length < minimum || length > maximum {
		return fmt.Errorf("%s must be %d-%d characters", key, minimum, maximum)
	}
	if looksLikeMarkup(value) {
		return fmt.Errorf("%s must not contain markup", key)
	}
	return nil
}

func validateAssetURL(key, value string) error {
	if value == "" {
		return nil
	}
	if len(value) > 2048 || strings.TrimSpace(value) != value || looksLikeMarkup(value) {
		return fmt.Errorf("%s must be a safe asset URL", key)
	}
	parsed, err := url.ParseRequestURI(value)
	if err != nil {
		return fmt.Errorf("%s must be an absolute /brand/ path or an https URL", key)
	}
	if parsed.Scheme == "" {
		if parsed.Host != "" || parsed.RawQuery != "" || parsed.Fragment != "" ||
			!strings.HasPrefix(parsed.Path, "/brand/") || parsed.Path == "/brand/" ||
			strings.Contains(parsed.Path, `\`) || path.Clean(parsed.Path) != parsed.Path ||
			looksLikeMarkup(parsed.Path) {
			return fmt.Errorf("%s same-origin paths must be under /brand/", key)
		}
		return nil
	}
	if parsed.Scheme != "https" || parsed.Host == "" || parsed.User != nil || parsed.Opaque != "" {
		return fmt.Errorf("%s remote assets must use https without credentials", key)
	}
	return nil
}

func looksLikeMarkup(value string) bool {
	if strings.ContainsAny(value, "<>") || strings.Contains(value, "{{") ||
		strings.Contains(value, "}}") || entityPattern.MatchString(value) {
		return true
	}
	for _, r := range value {
		if unicode.IsControl(r) {
			return true
		}
	}
	return false
}
