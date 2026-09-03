package main

import (
	"encoding/json"
	"testing"

	"github.com/biker2000on/beez-trackz/backend/internal/app"
	"github.com/biker2000on/beez-trackz/backend/internal/db"
	"github.com/biker2000on/beez-trackz/backend/internal/snapshot"
)

func TestRestoreReportNamesBaselineDomainTransform(t *testing.T) {
	report := newReport(true)
	report.addBaselineDrop("honey_movements")

	if report.Counts[app.OutcomeSkipped] != 1 || len(report.Records) != 1 {
		t.Fatalf("baseline drop was not counted once: %+v", report)
	}
	encoded, err := json.Marshal(report)
	if err != nil {
		t.Fatal(err)
	}
	var decoded struct {
		Records []struct {
			Domain           string `json:"domain"`
			Transform        string `json:"transform"`
			TransformVersion string `json:"transformVersion"`
		}
	}
	if err := json.Unmarshal(encoded, &decoded); err != nil {
		t.Fatal(err)
	}
	got := decoded.Records[0]
	if got.Domain != "honey_movements" || got.Transform != db.BaselineTransform || got.TransformVersion != db.BaselineTransformVersion {
		t.Fatalf("baseline transform record = %+v", got)
	}
}

func TestRestoreReportNamesPreLedgerArtifactTransform(t *testing.T) {
	report := newReport(false)
	report.addPreLedgerDomain("inventory_movements")

	if got := report.Records[0]; got.Domain != "inventory_movements" ||
		got.Outcome != app.OutcomeSkipped || got.Transform != snapshot.PreLedgerTransform {
		t.Fatalf("pre-ledger transform record = %+v", got)
	}
	if report.Counts[app.OutcomeSkipped] != 1 {
		t.Fatalf("skipped count = %d, want 1", report.Counts[app.OutcomeSkipped])
	}
}
