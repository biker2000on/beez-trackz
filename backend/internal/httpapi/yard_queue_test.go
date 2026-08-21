package httpapi

import (
	"encoding/json"
	"net/http"
	"testing"

	"github.com/google/uuid"
)

func TestYardQueueRecTitle(t *testing.T) {
	t.Parallel()
	cases := []struct {
		recType string
		want    string
	}{
		{"treat_now", "Treat for Varroa"},
		{"mite_check_due", "Sample for mites"},
		{"inspection_due", "Inspect this hive"},
		{"treatment_reminder", "Review treatment"},
		{"equipment_needed", "Add equipment"},
		{"seasonal_prep", "Seasonal prep"},
		{"unknown", "Review"},
		{"", "Review"},
	}
	for _, tc := range cases {
		if got := yardQueueRecTitle(tc.recType); got != tc.want {
			t.Errorf("yardQueueRecTitle(%q) = %q, want %q", tc.recType, got, tc.want)
		}
	}
}

func TestYardQueueRank(t *testing.T) {
	t.Parallel()
	cases := []struct {
		kind, priority string
		want           int
	}{
		{"lockout", "high", 0},
		{"recommendation", "urgent", 1},
		{"recommendation", "high", 2},
		{"recommendation", "normal", 4},
		{"feeding", "urgent", 1},
		{"feeding", "high", 3},
		{"harvest_ready", "normal", 5},
		{"other", "", 6},
	}
	for _, tc := range cases {
		got := yardQueueRank(yardQueueItem{Kind: tc.kind, Priority: tc.priority})
		if got != tc.want {
			t.Errorf("rank(%s/%s) = %d, want %d", tc.kind, tc.priority, got, tc.want)
		}
	}
}

func TestYardQueueItemName(t *testing.T) {
	t.Parallel()
	named := "A1"
	if got := yardQueueItemName(yardQueueItem{Title: "Treat", HiveName: &named}); got != "A1" {
		t.Errorf("named item = %q, want A1", got)
	}
	if got := yardQueueItemName(yardQueueItem{Title: "Treat"}); got != "Treat" {
		t.Errorf("title fallback = %q, want Treat", got)
	}
}

func TestStoresLabel(t *testing.T) {
	t.Parallel()
	if got := storesLabel(4); got != "4/5" {
		t.Errorf("storesLabel(4) = %q, want 4/5", got)
	}
}

func TestYardQueueEndpoint(t *testing.T) {
	fixture := newHiveScopeFixture(t)

	empty := fixture.call(t, fixture.server.yardQueue,
		http.MethodGet, "/operations/yard-queue", nil, nil)
	if empty.Code != http.StatusOK {
		t.Fatalf("empty: status %d: %s", empty.Code, empty.Body.String())
	}
	var emptyBody struct {
		Yards []yardQueueYard `json:"yards"`
	}
	if err := json.Unmarshal(empty.Body.Bytes(), &emptyBody); err != nil {
		t.Fatalf("decode empty: %v", err)
	}
	if emptyBody.Yards == nil {
		t.Fatal("yards should be an array, not omitted")
	}

	freeMsg := "Wrap the yards " + fixture.hiveA.String()
	var recID, freeID uuid.UUID
	if err := fixture.server.pool.QueryRow(fixture.ctx, `
		INSERT INTO ai_recommendations (hive_id, type, message, priority, dismissed)
		VALUES ($1, 'inspection_due', 'Overdue for a look', 'high', false)
		RETURNING id`, fixture.hiveA).Scan(&recID); err != nil {
		t.Fatalf("insert rec: %v", err)
	}
	if err := fixture.server.pool.QueryRow(fixture.ctx, `
		INSERT INTO ai_recommendations (type, message, priority, dismissed)
		VALUES ('seasonal_prep', $1, 'normal', false)
		RETURNING id`, freeMsg).Scan(&freeID); err != nil {
		t.Fatalf("insert hive-less rec: %v", err)
	}
	t.Cleanup(func() {
		_, _ = fixture.server.pool.Exec(fixture.ctx,
			`DELETE FROM ai_recommendations WHERE id IN ($1,$2)`, recID, freeID)
	})

	response := fixture.call(t, fixture.server.yardQueue,
		http.MethodGet, "/operations/yard-queue", nil, nil)
	if response.Code != http.StatusOK {
		t.Fatalf("queue: status %d: %s", response.Code, response.Body.String())
	}
	var body struct {
		AsOf  string          `json:"asOf"`
		Yards []yardQueueYard `json:"yards"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if body.AsOf == "" {
		t.Fatal("asOf missing")
	}

	var (
		sawHiveRec bool
		sawAllYard bool
	)
	for _, yard := range body.Yards {
		for _, item := range yard.Items {
			if item.Kind == "recommendation" && item.Title == "Inspect this hive" &&
				item.HiveID != nil && *item.HiveID == fixture.hiveA {
				sawHiveRec = true
				if item.Href != "/hives/"+fixture.hiveA.String() {
					t.Errorf("hive rec href = %q", item.Href)
				}
			}
			if item.Kind == "recommendation" && item.Title == "Seasonal prep" &&
				item.Detail == freeMsg {
				sawAllYard = true
				if yard.ApiaryID != uuid.Nil {
					t.Errorf("hive-less rec yard id = %s, want nil", yard.ApiaryID)
				}
			}
		}
	}
	if !sawHiveRec {
		t.Fatalf("missing inspection_due rec for hive A: %#v", body.Yards)
	}
	if !sawAllYard {
		t.Fatalf("missing hive-less rec on All yards: %#v", body.Yards)
	}
}
