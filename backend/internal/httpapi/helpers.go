package httpapi

import (
	"fmt"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	"net/http"
)

// uuidParam parses a chi URL parameter as a UUID.
func uuidParam(r *http.Request, name string) (uuid.UUID, error) {
	id, err := uuid.Parse(chi.URLParam(r, name))
	if err != nil {
		return uuid.Nil, fmt.Errorf("invalid %s", name)
	}
	return id, nil
}

// parseDate parses either an RFC3339 timestamp or a date-only string.
// Date-only strings (YYYY-MM-DD) are interpreted in LOCAL time to avoid the
// UTC date-shift bug (see backend-spec.md).
func parseDate(s string) (time.Time, error) {
	s = strings.TrimSpace(s)
	if s == "" {
		return time.Time{}, fmt.Errorf("empty date")
	}
	if len(s) == 10 {
		return time.ParseInLocation("2006-01-02", s, time.Local)
	}
	if t, err := time.Parse(time.RFC3339, s); err == nil {
		return t, nil
	}
	return time.ParseInLocation("2006-01-02T15:04", s, time.Local)
}

// parseDatePtr is parseDate for optional fields: nil for empty input.
func parseDatePtr(s *string) (*time.Time, error) {
	if s == nil || strings.TrimSpace(*s) == "" {
		return nil, nil
	}
	t, err := parseDate(*s)
	if err != nil {
		return nil, err
	}
	return &t, nil
}

// clampRating bounds an optional 1-5 rating.
func clampRating(v *int) *int {
	if v == nil {
		return nil
	}
	n := *v
	if n < 1 {
		n = 1
	}
	if n > 5 {
		n = 5
	}
	return &n
}
