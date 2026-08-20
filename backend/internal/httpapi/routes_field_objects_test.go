package httpapi

import "testing"

func TestFieldObjectEnums(t *testing.T) {
	for _, value := range []string{"robbing", "yellowjackets", "bears", "skunks", "flood"} {
		if !fieldValidIncident(value) {
			t.Errorf("incident %q should be valid", value)
		}
	}
	if fieldValidIncident("dead") {
		t.Error("hive status must not be an incident type")
	}
	for _, value := range []string{"package", "nuc", "split", "swarm", "catch_box", "other"} {
		if !fieldValidIntakeSource(value) {
			t.Errorf("intake source %q should be valid", value)
		}
	}
	for _, value := range []string{"yard", "stand", "fence_line"} {
		if !fieldValidLocation(value) {
			t.Errorf("location %q should be valid", value)
		}
	}
}
