package main

import (
	"encoding/json"
	"testing"

	"github.com/biker2000on/beez-trackz/backend/internal/snapshot"
)

func TestUserPreferencesSchemaAheadSplit(t *testing.T) {
	settingsID := "00000000-0000-4000-8000-000000000057"
	userOne := "10000000-0000-4000-8000-000000000001"
	userTwo := "10000000-0000-4000-8000-000000000002"
	artifact := &snapshot.Artifact{
		Manifest: snapshot.Manifest{SchemaMigration: 56},
		Records: map[string][]snapshot.RecordEnvelope{
			"app_users": {
				testEnvelope(t, "app_users", userOne, map[string]any{"id": userOne, "display_name": "One"}),
				testEnvelope(t, "app_users", userTwo, map[string]any{"id": userTwo, "display_name": "Two"}),
			},
			"user_settings": {testEnvelope(t, "user_settings", settingsID, map[string]any{
				"id": settingsID, "display_name": "Instance", "theme": "dark",
				"default_apiary_id": nil, "date_format": "YYYY-MM-DD", "weight_unit": "kg",
				"units": "metric", "temperature_unit": "c",
			})},
			"user_preferences": {testEnvelope(t, "user_preferences", userOne, map[string]any{
				"user_id": userOne, "theme": "light", "date_format": "DD/MM/YYYY",
				"weight_unit": "oz", "units": "us", "temperature_unit": "f",
			})},
		},
	}

	applied, err := snapshot.ApplyPostArtifactMigrations(artifact)
	if err != nil {
		t.Fatal(err)
	}
	if len(applied) != 1 || applied[0].Name != snapshot.UserPreferencesTransform {
		t.Fatalf("applied migrations = %+v", applied)
	}

	settings := decodeEnvelope(t, artifact.Records["user_settings"][0])
	for _, moved := range []string{"theme", "default_apiary_id", "date_format", "weight_unit", "units", "temperature_unit"} {
		if _, present := settings[moved]; present {
			t.Errorf("user_settings still contains moved field %s", moved)
		}
	}
	if settings["display_name"] != "Instance" {
		t.Fatalf("unmoved user_settings data changed: %#v", settings)
	}

	preferences := artifact.Records["user_preferences"]
	if len(preferences) != 2 {
		t.Fatalf("user_preferences records = %d, want 2", len(preferences))
	}
	byID := map[string]map[string]any{}
	for _, record := range preferences {
		var id string
		if err := json.Unmarshal(record.ID, &id); err != nil {
			t.Fatal(err)
		}
		byID[id] = decodeEnvelope(t, record)
	}
	if byID[userOne]["theme"] != "light" {
		t.Fatalf("artifact preference did not win: %#v", byID[userOne])
	}
	for key, want := range map[string]any{
		"user_id": userTwo, "theme": "dark", "default_apiary_id": nil,
		"date_format": "YYYY-MM-DD", "weight_unit": "kg", "units": "metric", "temperature_unit": "c",
	} {
		if got := byID[userTwo][key]; got != want {
			t.Errorf("derived preference %s = %#v, want %#v", key, got, want)
		}
	}
}

func TestUserPreferencesSplitDoesNotApplyAtMigration57(t *testing.T) {
	artifact := &snapshot.Artifact{
		Manifest: snapshot.Manifest{SchemaMigration: 57},
		Records: map[string][]snapshot.RecordEnvelope{
			"user_settings": {testEnvelope(t, "user_settings", "00000000-0000-4000-8000-000000000057", map[string]any{
				"id": "00000000-0000-4000-8000-000000000057", "theme": "legacy-invalid-at-57",
			})},
		},
	}
	applied, err := snapshot.ApplyPostArtifactMigrations(artifact)
	if err != nil {
		t.Fatal(err)
	}
	if len(applied) != 0 {
		t.Fatalf("migration-57 artifact was transformed: %+v", applied)
	}
	if _, present := decodeEnvelope(t, artifact.Records["user_settings"][0])["theme"]; !present {
		t.Fatal("migration-57 artifact data was mutated")
	}
}

func testEnvelope(t *testing.T, domain, id string, fields map[string]any) snapshot.RecordEnvelope {
	t.Helper()
	data, err := snapshot.MarshalCanonical(fields)
	if err != nil {
		t.Fatal(err)
	}
	idJSON, err := snapshot.MarshalCanonical(id)
	if err != nil {
		t.Fatal(err)
	}
	return snapshot.RecordEnvelope{
		Domain: domain, ID: idJSON, Data: data, Digest: snapshot.SHA256Hex(data),
		CanonicalizationVersion: snapshot.CanonicalizationVersion,
		DigestAlgorithm:         snapshot.DigestAlgorithmVersion,
	}
}

func decodeEnvelope(t *testing.T, envelope snapshot.RecordEnvelope) map[string]any {
	t.Helper()
	var fields map[string]any
	if err := json.Unmarshal(envelope.Data, &fields); err != nil {
		t.Fatal(err)
	}
	return fields
}
