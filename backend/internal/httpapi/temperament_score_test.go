package httpapi

import "testing"

// Temperament is 1 = calm, 5 = aggressive everywhere; queen scoring must
// reward the calm end.
func TestTemperamentScoreRewardsCalm(t *testing.T) {
	want := map[int]float64{1: 100, 2: 80, 3: 60, 4: 40, 5: 20}
	for temperament, score := range want {
		if got := temperamentScore(temperament); got != score {
			t.Errorf("temperamentScore(%d) = %v, want %v", temperament, got, score)
		}
	}
	if temperamentScore(1) <= temperamentScore(5) {
		t.Fatal("a calm colony must outscore an aggressive one")
	}
}

func TestMCPTemperamentDescriptionNamesTheCalmEnd(t *testing.T) {
	const want = "Temperament: integer 1–5, 1 calm, 5 aggressive."
	properties := func(tool string) map[string]any {
		return mcpToolIndex()[tool]["inputSchema"].(map[string]any)["properties"].(map[string]any)
	}
	visitInspection := properties("record_visit")["entries"].(map[string]any)["items"].(map[string]any)["properties"].(map[string]any)["inspection"].(map[string]any)["properties"].(map[string]any)
	for name, props := range map[string]map[string]any{
		"record_inspection": properties("record_inspection"),
		"update_inspection": properties("update_inspection"),
		"record_visit":      visitInspection,
	} {
		schema := props["temperament"].(map[string]any)
		if schema["description"] != want || schema["minimum"] != 1 || schema["maximum"] != 5 {
			t.Errorf("%s temperament schema = %v", name, schema)
		}
	}
}
