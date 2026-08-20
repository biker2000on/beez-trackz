package recs

import "testing"

func readinessInt(v int) *int    { return &v }
func readinessBool(v bool) *bool { return &v }

func TestDeriveReadiness(t *testing.T) {
	tests := []struct {
		name string
		in   readinessEvidence
		want string
	}{
		{"queen cells and crowding will swarm", readinessEvidence{
			CrowdedBrood: readinessBool(true), QueenCells: readinessInt(2),
		}, "will_swarm"},
		{"strong stocked hive on flow is split ready", readinessEvidence{
			FramesOfBees: readinessInt(9), FramesOfBrood: readinessInt(6),
			FramesOfStores: readinessInt(3), FlowOn: readinessBool(true),
			Temperament: readinessInt(4), DaysSinceSplit: readinessInt(90),
		}, "ready_to_split"},
		{"recent split is neither", readinessEvidence{
			CrowdedBrood: readinessBool(true), QueenCups: readinessInt(3),
			StoresHoney: readinessInt(4), FlowOn: readinessBool(true),
			DaysSinceSplit: readinessInt(12),
		}, "neither"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, _ := deriveReadiness(tt.in)
			if got != tt.want {
				t.Fatalf("deriveReadiness() = %q, want %q", got, tt.want)
			}
		})
	}
}
