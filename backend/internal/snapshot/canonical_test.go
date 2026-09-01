package snapshot

import (
	"encoding/json"
	"testing"
)

func TestCanonicalJSONStableAcrossJSONBKeyOrderAndNumbers(t *testing.T) {
	left := []byte(`{"z":1.2300,"nested":{"b":1e3,"a":-0.000},"a":[1.0,0.10e1,1.2300e-2]}`)
	right := []byte(`{"a":[1,1,0.012300],"nested":{"a":0,"b":1000.00},"z":1.23}`)
	want := `{"a":[1,1,0.0123],"nested":{"a":0,"b":1000},"z":1.23}`
	for name, raw := range map[string][]byte{"left": left, "right": right} {
		got, err := CanonicalJSON(raw)
		if err != nil {
			t.Fatalf("%s canonicalize: %v", name, err)
		}
		if string(got) != want {
			t.Errorf("%s = %s, want %s", name, got, want)
		}
	}
	leftDigest, err := DigestCanonicalJSON(left)
	if err != nil {
		t.Fatal(err)
	}
	rightDigest, err := DigestCanonicalJSON(right)
	if err != nil {
		t.Fatal(err)
	}
	if leftDigest != rightDigest {
		t.Fatalf("equivalent jsonb digests differ: %s != %s", leftDigest, rightDigest)
	}
}

func TestCanonicalJSONFixedNumberFormatting(t *testing.T) {
	tests := map[string]string{
		`1e3`: "1000", `1.2300e-2`: "0.0123", `-0`: "0", `-0.000e9`: "0",
		`100.000`: "100", `1e-6`: "0.000001", `123e-2`: "1.23", `0.001e3`: "1",
	}
	for input, want := range tests {
		got, err := CanonicalJSON([]byte(input))
		if err != nil {
			t.Errorf("%s: %v", input, err)
			continue
		}
		if string(got) != want {
			t.Errorf("canonical(%s) = %s, want %s", input, got, want)
		}
	}
}

func TestCanonicalJSONDoesNotHTMLEscapeAndRejectsTrailingValue(t *testing.T) {
	got, err := CanonicalJSON([]byte(`{"x":"<tag>&"}`))
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != `{"x":"<tag>&"}` {
		t.Fatalf("unexpected string escaping: %s", got)
	}
	if _, err := CanonicalJSON([]byte(`{} []`)); err == nil {
		t.Fatal("accepted multiple JSON values")
	}
}

func TestNormalizeRecordRemovesSecretsPerKeyAndNormalizesTimestamp(t *testing.T) {
	item := Domain{Name: "user_settings", Table: "user_settings",
		ExcludedColumns: []string{"password_hash", "ntfy_access_token"},
		JSONSecretPaths: map[string][][]string{"ai_provider_config": {{"apiKeys", "anthropic"}, {"apiKeys", "google"}}},
	}
	raw := []byte(`{"id":"00000000-0000-0000-0000-000000000001","password_hash":"hash","ntfy_access_token":"token","updated_at":"2026-09-01T12:34:56-04:00","ai_provider_config":{"apiKeys":{"anthropic":"a","google":"g","ollamaUrl":"http://ollama"},"transcription":{"provider":"whisper"}}}`)
	data, id, err := normalizeRecord(raw, item, []string{"id"}, map[string]string{"updated_at": "timestamp with time zone"})
	if err != nil {
		t.Fatal(err)
	}
	if string(id) != `"00000000-0000-0000-0000-000000000001"` {
		t.Errorf("id = %s", id)
	}
	var decoded map[string]any
	if err := json.Unmarshal(data, &decoded); err != nil {
		t.Fatal(err)
	}
	if _, exists := decoded["password_hash"]; exists {
		t.Fatal("password hash survived filtering")
	}
	if _, exists := decoded["ntfy_access_token"]; exists {
		t.Fatal("ntfy token survived filtering")
	}
	keys := decoded["ai_provider_config"].(map[string]any)["apiKeys"].(map[string]any)
	if _, exists := keys["anthropic"]; exists {
		t.Fatal("Anthropic credential survived filtering")
	}
	if _, exists := keys["google"]; exists {
		t.Fatal("Google credential survived filtering")
	}
	if keys["ollamaUrl"] != "http://ollama" {
		t.Fatal("safe AI endpoint was removed")
	}
	if decoded["updated_at"] != "2026-09-01T16:34:56Z" {
		t.Errorf("timestamp = %v", decoded["updated_at"])
	}
}

func TestNormalizeRecordRenamesGnuCashAttemptTimestamp(t *testing.T) {
	item := Domain{Name: "gnucash_sync_settings", Table: "gnucash_sync_settings",
		ExcludedColumns: []string{"api_token"}, RenameColumns: map[string]string{"last_synced_at": "last_attempt_at"}}
	data, _, err := normalizeRecord([]byte(`{"id":true,"api_token":"secret","last_synced_at":"2026-09-01T12:00:00Z"}`), item, []string{"id"}, map[string]string{"last_synced_at": "timestamp with time zone"})
	if err != nil {
		t.Fatal(err)
	}
	if string(data) != `{"id":true,"last_attempt_at":"2026-09-01T12:00:00Z"}` {
		t.Fatalf("normalized settings = %s", data)
	}
}
