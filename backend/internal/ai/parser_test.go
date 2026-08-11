package ai

import (
	"context"
	"errors"
	"strings"
	"testing"
)

type parserProvider struct {
	response string
	err      error
	prompt   string
	context  string
}

func (p *parserProvider) Chat(_ context.Context, prompt, context string) (string, error) {
	p.prompt = prompt
	p.context = context
	return p.response, p.err
}

func (*parserProvider) Transcribe(context.Context, []byte, string) (string, error) {
	return "", errors.New("not implemented")
}

func (*parserProvider) AnalyzeImage(context.Context, []byte, string) (string, error) {
	return "", errors.New("not implemented")
}

func TestParseTranscriptionExtractsOperationalEvents(t *testing.T) {
	provider := &parserProvider{response: "```json\n" + `{
		"queenSeen": true,
		"feedings": [
			{"type":"sugar_syrup_1to1","quantity":2,"quantityUnit":"quarts","feederType":"top"}
		],
		"treatments": [{"product":"oxalic acid","method":"vapor"}],
		"queenEvents": [{"eventType":"observed","notes":"marked blue"}],
		"miteCounts": [{"method":"alcohol_wash","mitesCount":6,"sampleSize":300}]
	}` + "\n```"}

	result, err := ParseTranscription(context.Background(), provider, "Hive one received feed and treatment.", "single")
	if err != nil {
		t.Fatalf("ParseTranscription returned error: %v", err)
	}
	if len(result.Inspections) != 1 {
		t.Fatalf("got %d inspections, want 1", len(result.Inspections))
	}

	inspection := result.Inspections[0]
	if len(inspection.Feedings) != 1 || inspection.Feedings[0].Quantity != 2 {
		t.Fatalf("feeding was not preserved: %#v", inspection.Feedings)
	}
	if len(inspection.Treatments) != 1 || inspection.Treatments[0].Product != "oxalic acid" {
		t.Fatalf("treatment was not preserved: %#v", inspection.Treatments)
	}
	if len(inspection.QueenEvents) != 1 || inspection.QueenEvents[0].EventType != "observed" {
		t.Fatalf("queen event was not preserved: %#v", inspection.QueenEvents)
	}
	if len(inspection.MiteCounts) != 1 || inspection.MiteCounts[0].MitesCount != 6 {
		t.Fatalf("mite count was not preserved: %#v", inspection.MiteCounts)
	}
	if inspection.MiteCounts[0].SampleSize == nil || *inspection.MiteCounts[0].SampleSize != 300 {
		t.Fatalf("mite sample size was not preserved: %#v", inspection.MiteCounts[0])
	}
	if !strings.Contains(provider.prompt, `"queenEvents"`) || !strings.Contains(provider.prompt, `"miteCounts"`) {
		t.Fatalf("prompt does not request all operational events: %q", provider.prompt)
	}
}

func TestParseTranscriptionRejectsInvalidOperationalValues(t *testing.T) {
	provider := &parserProvider{response: `{
		"feedings": [
			{"type":"unknown","quantity":2,"quantityUnit":"quarts"},
			{"type":"fondant","quantity":0,"quantityUnit":"lbs"},
			{"type":"fondant","quantity":1.5,"quantityUnit":"lbs","feederType":"invalid"}
		],
		"queenEvents": [
			{"eventType":"hatched"},
			{"eventType":"requeened"}
		],
		"miteCounts": [
			{"method":"guess","mitesCount":5},
			{"method":"sugar_roll","mitesCount":-1},
			{"method":"sticky_board","mitesCount":9,"sampleSize":0}
		]
	}`}

	result, err := ParseTranscription(context.Background(), provider, "Operational events", "single")
	if err != nil {
		t.Fatalf("ParseTranscription returned error: %v", err)
	}
	inspection := result.Inspections[0]

	if len(inspection.Feedings) != 1 || inspection.Feedings[0].FeederType != nil {
		t.Fatalf("feeding validation mismatch: %#v", inspection.Feedings)
	}
	if len(inspection.QueenEvents) != 1 || inspection.QueenEvents[0].EventType != "requeened" {
		t.Fatalf("queen-event validation mismatch: %#v", inspection.QueenEvents)
	}
	if len(inspection.MiteCounts) != 1 || inspection.MiteCounts[0].SampleSize != nil {
		t.Fatalf("mite-count validation mismatch: %#v", inspection.MiteCounts)
	}
}

func TestParseTranscriptionBatchKeepsHiveAssociations(t *testing.T) {
	provider := &parserProvider{response: `[
		{"hiveReference":"Blue Hive","queenEvents":[{"eventType":"missing"}]},
		{"hiveReference":"Hive 2","miteCounts":[{"method":"visual","mitesCount":1}]}
	]`}

	result, err := ParseTranscription(context.Background(), provider, "Checked two hives", "batch")
	if err != nil {
		t.Fatalf("ParseTranscription returned error: %v", err)
	}
	if len(result.Inspections) != 2 {
		t.Fatalf("got %d inspections, want 2", len(result.Inspections))
	}

	matched := MatchHiveReferences(result.Inspections, []HiveRef{
		{ID: "blue", PositionLabel: "Blue Hive"},
		{ID: "two", PositionLabel: "Hive 2"},
	})
	if matched[0].MatchedHiveID == nil || *matched[0].MatchedHiveID != "blue" {
		t.Fatalf("first match = %#v, want blue", matched[0].MatchedHiveID)
	}
	if matched[1].MatchedHiveID == nil || *matched[1].MatchedHiveID != "two" {
		t.Fatalf("second match = %#v, want two", matched[1].MatchedHiveID)
	}
}

// ASI-1-007: a whitespace-only reference (or an empty position label) makes
// strings.Contains true for everything and used to pre-select the first hive.
func TestMatchHiveReferencesIgnoresEmptyValues(t *testing.T) {
	blank := " "
	labeled := "A3"
	matched := MatchHiveReferences(
		[]ParsedInspection{
			{HiveReference: &blank},
			{HiveReference: &labeled},
		},
		[]HiveRef{
			{ID: "empty-label", PositionLabel: ""},
			{ID: "a3", PositionLabel: "A3"},
		})
	if matched[0].MatchedHiveID != nil {
		t.Errorf("whitespace reference matched hive %q", *matched[0].MatchedHiveID)
	}
	if matched[1].MatchedHiveID == nil || *matched[1].MatchedHiveID != "a3" {
		t.Errorf("A3 reference = %#v, want a3", matched[1].MatchedHiveID)
	}
}
