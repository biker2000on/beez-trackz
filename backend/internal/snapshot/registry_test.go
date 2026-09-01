package snapshot

import "testing"

func TestRegistryCoversFormatVersionOneDomains(t *testing.T) {
	required := []string{
		"apiaries", "hives", "queens", "queen_events", "hive_splits", "hive_location_history",
		"inspections", "feedings", "feeding_status_backfills", "mite_counts", "treatment_events", "treatment_products",
		"honey_harvests", "harvest_sessions", "harvest_session_true_ups", "harvest_lots", "honey_varietals",
		"bottling_runs", "jar_serials", "product_catalog", "product_batches", "product_adjustments", "honey_movements",
		"stock_locations", "stock_movements", "consignment_settlements", "sales", "sale_items", "customers",
		"equipment_types", "equipment_type_components", "equipment_stock", "equipment_stock_adjustments",
		"equipment_deployments", "equipment_deployment_returns", "equipment_state_changes", "expenses",
		"catch_boxes", "colony_intakes", "field_incidents", "deadout_autopsies", "bloom_observations",
		"yard_scales", "scale_readings", "apiary_weather_cache", "immich_timeline_candidates", "immich_timeline_scans",
		"photos", "media_files", "transcript_versions", "yard_labor_sessions", "ai_recommendations",
		"apiary_memberships", "jar_sizes", "external_sync", "gnucash_sync_settings", "offline_mutation_receipts",
	}
	seen := make(map[string]bool, len(Domains))
	for _, item := range Domains {
		if seen[item.Name] {
			t.Errorf("duplicate domain %s", item.Name)
		}
		seen[item.Name] = true
	}
	for _, name := range required {
		if !seen[name] {
			t.Errorf("required domain %s is not registered", name)
		}
	}
	for _, forbidden := range []string{"api_tokens", "oidc_identities", "ntfy_dispatches"} {
		if seen[forbidden] {
			t.Errorf("secret/ephemeral domain %s must not be exported", forbidden)
		}
	}
}

func TestAggregateFamiliesAreDistinctAndVersioned(t *testing.T) {
	legacy := legacySpecs("USD")
	if len(legacy) < 15 {
		t.Fatalf("legacy definitions = %d, want at least 15", len(legacy))
	}
	seen := make(map[string]bool)
	for _, item := range legacy {
		if item.definition.Version == "" || item.definition.QueryVersion != LegacyAggregateFamily {
			t.Errorf("unversioned legacy definition %+v", item.definition)
		}
		if seen[item.definition.Name] {
			t.Errorf("duplicate aggregate %s", item.definition.Name)
		}
		seen[item.definition.Name] = true
	}
	newFamily := newLedgerFamily()
	if newFamily.Label != "new-ledger definitions" || newFamily.Version == LegacyAggregateFamily {
		t.Fatalf("new-ledger family not distinct: %+v", newFamily)
	}
	if len(newFamily.Mapping) != 3 {
		t.Fatalf("residual mappings = %d, want 3", len(newFamily.Mapping))
	}
}
