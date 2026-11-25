package httpapi

import (
	"context"
	"net/http"
	"strings"
	"testing"
	"time"
)

func TestHarvestBeforeInstallMessage(t *testing.T) {
	installed := time.Date(2026, time.April, 27, 0, 0, 0, 0, time.UTC)
	cases := []struct {
		name      string
		installed *time.Time
		harvest   time.Time
		want      string
	}{
		{"unknown install date", nil, time.Date(2025, 7, 18, 0, 0, 0, 0, time.UTC), ""},
		{"harvest after install", &installed, time.Date(2026, 7, 19, 0, 0, 0, 0, time.UTC), ""},
		{"harvest on install day", &installed, time.Date(2026, 4, 27, 15, 0, 0, 0, time.UTC), ""},
		{"harvest before install", &installed, time.Date(2025, 7, 18, 0, 0, 0, 0, time.UTC),
			"A1 was installed 2026-04-27, after the 2025-07-18 harvest; pick the colony that was in A1 on that date"},
		{"day before install", &installed, time.Date(2026, 4, 26, 23, 0, 0, 0, time.UTC),
			"A1 was installed 2026-04-27, after the 2026-04-26 harvest; pick the colony that was in A1 on that date"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := harvestBeforeInstallMessage("A1", tc.installed, tc.harvest); got != tc.want {
				t.Fatalf("got %q, want %q", got, tc.want)
			}
		})
	}
}

func TestHarvestBeforeInstallComparesUTCCalendarDates(t *testing.T) {
	// 2026-04-27 01:00 in UTC+05 is still 2026-04-26 in UTC.
	east := time.FixedZone("UTC+05", 5*3600)
	installed := time.Date(2026, 4, 27, 1, 0, 0, 0, east)
	harvest := time.Date(2026, 4, 26, 12, 0, 0, 0, time.UTC)
	if msg := harvestBeforeInstallMessage("B2", &installed, harvest); msg != "" {
		t.Fatalf("same UTC day must not be refused: %q", msg)
	}
}

func TestHarvestRefusedBeforeHiveInstalled(t *testing.T) {
	server := honeyTestServer(t)
	apiaryID, hiveID := seedLockoutHive(t, server)
	if _, err := server.pool.Exec(context.Background(),
		`UPDATE hives SET position_label='A1', installed_date='2026-04-27T00:00:00Z' WHERE id=$1`,
		hiveID); err != nil {
		t.Fatalf("set installed date: %v", err)
	}

	standalone, body := call(t, server.honeyCreateHarvest, adminRequest(
		http.MethodPost, "/harvests", map[string]any{
			"hiveId": hiveID.String(), "date": "2025-07-18", "harvestedWeight": 10,
		}))
	if standalone.Code != http.StatusBadRequest {
		t.Fatalf("standalone harvest = %d %v, want 400", standalone.Code, body)
	}
	want := "A1 was installed 2026-04-27, after the 2025-07-18 harvest; pick the colony that was in A1 on that date"
	if got, _ := body["error"].(string); got != want {
		t.Fatalf("error = %q", got)
	}

	created, createdBody := call(t, server.hsCreate, adminRequest(
		http.MethodPost, "/harvest-sessions", map[string]any{
			"apiaryId": apiaryID.String(), "date": "2025-07-18",
		}))
	if created.Code != http.StatusCreated {
		t.Fatalf("create session = %d %v", created.Code, createdBody)
	}
	sessionID, _ := createdBody["id"].(string)
	batch, batchBody := call(t, server.hsAddEntry, adminRequest(
		http.MethodPost, "/harvest-sessions/"+sessionID+"/entries",
		map[string]any{"entries": []map[string]any{
			{"hiveId": hiveID.String(), "harvestedWeight": 5},
		}}, "id", sessionID))
	if batch.Code != http.StatusBadRequest {
		t.Fatalf("session entry = %d %v, want 400", batch.Code, batchBody)
	}
	if got, _ := batchBody["error"].(string); !strings.HasPrefix(got, "Entry 1: A1 was installed 2026-04-27") {
		t.Fatalf("batch error = %q", got)
	}

	// After the install date the same hive harvests normally.
	allowed, allowedBody := call(t, server.honeyCreateHarvest, adminRequest(
		http.MethodPost, "/harvests", map[string]any{
			"hiveId": hiveID.String(), "date": "2026-07-19", "harvestedWeight": 10,
		}))
	if allowed.Code != http.StatusCreated {
		t.Fatalf("harvest after install = %d %v, want 201", allowed.Code, allowedBody)
	}
}
