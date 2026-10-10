package httpapi

import (
	"context"
	"net/http"
	"testing"
	"time"
)

func intPtr(v int) *int { return &v }

func TestYearSpan(t *testing.T) {
	cases := []struct {
		name             string
		earliest, latest *int
		want             metaYearsResponse
	}{
		{"no data", nil, nil, metaYearsResponse{Min: 2026, Max: 2026, Current: 2026}},
		{"older data", intPtr(2019), intPtr(2024), metaYearsResponse{Min: 2019, Max: 2026, Current: 2026}},
		{"dated ahead", intPtr(2021), intPtr(2027), metaYearsResponse{Min: 2021, Max: 2027, Current: 2026}},
		{"only this year", intPtr(2026), intPtr(2026), metaYearsResponse{Min: 2026, Max: 2026, Current: 2026}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := yearSpan(tc.earliest, tc.latest, 2026); got != tc.want {
				t.Fatalf("yearSpan = %+v, want %+v", got, tc.want)
			}
		})
	}
}

// TestMetaYearsReachesEarliestRecord is DB-backed: an expense dated years
// before anything else pulls the span's minimum back to its year, and a
// soft-deleted one does not.
func TestMetaYearsReachesEarliestRecord(t *testing.T) {
	server := honeyTestServer(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	tx, err := server.pool.Begin(ctx)
	if err != nil {
		t.Fatalf("begin: %v", err)
	}
	defer func() { _ = tx.Rollback(context.Background()) }()

	var before *int
	if err := tx.QueryRow(ctx, metaYearsSQL).Scan(&before, new(*int)); err != nil {
		t.Fatalf("query before: %v", err)
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO expenses (expense_date, category, description, amount_cents)
		VALUES ('1931-05-01', 'supplies', 'meta years test', 100)`); err != nil {
		t.Fatalf("insert expense: %v", err)
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO expenses (expense_date, category, description, amount_cents, deleted_at)
		VALUES ('1925-05-01', 'supplies', 'meta years deleted', 100, now())`); err != nil {
		t.Fatalf("insert deleted expense: %v", err)
	}
	var earliest, latest *int
	if err := tx.QueryRow(ctx, metaYearsSQL).Scan(&earliest, &latest); err != nil {
		t.Fatalf("query after: %v", err)
	}
	if earliest == nil || *earliest != 1931 {
		t.Fatalf("earliest = %v, want 1931 (before: %v)", earliest, before)
	}
	span := yearSpan(earliest, latest, time.Now().Year())
	if span.Min != 1931 || span.Max < time.Now().Year() {
		t.Fatalf("span = %+v", span)
	}

	// The handler answers with the same shape from committed data.
	response, body := call(t, server.metaYears,
		adminRequest(http.MethodGet, "/api/v1/meta/years", nil))
	if response.Code != http.StatusOK {
		t.Fatalf("GET /meta/years: %d %s", response.Code, response.Body.String())
	}
	for _, key := range []string{"min", "max", "current"} {
		if _, ok := body[key].(float64); !ok {
			t.Fatalf("missing %s in %v", key, body)
		}
	}
	if body["current"] != float64(time.Now().Year()) {
		t.Fatalf("current = %v", body["current"])
	}
}
