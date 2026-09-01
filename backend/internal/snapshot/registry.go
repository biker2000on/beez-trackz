package snapshot

import "sort"

// Domain describes one portable application record stream. Table is an
// implementation detail used only by the format-v1 exporter; importers bind
// Name and the documented fields to domain services, never to this table.
type Domain struct {
	Name            string
	Table           string
	ExcludedColumns []string
	RenameColumns   map[string]string
	JSONSecretPaths map[string][][]string
}

func domain(name string) Domain { return Domain{Name: name, Table: name} }

// Domains is the complete format-v1 registry for the live schema after
// migrations 00001-00048. Strength scores are fields on inspections rather
// than a separate table. Offline mutation receipts are retained as owned
// idempotency/audit history.
var Domains = []Domain{
	{Name: "app_users", Table: "app_users", ExcludedColumns: []string{"auth_subject", "password_hash"}},
	{Name: "user_settings", Table: "user_settings", ExcludedColumns: []string{"password_hash", "ntfy_access_token"}, JSONSecretPaths: map[string][][]string{"ai_provider_config": {{"apiKeys", "anthropic"}, {"apiKeys", "google"}}}},
	domain("apiaries"), domain("apiary_memberships"), domain("hives"),
	domain("hive_location_history"), domain("hive_splits"), domain("queens"),
	domain("queen_events"), domain("inspections"), domain("feedings"),
	domain("feeding_status_backfills"), domain("mite_counts"),
	domain("treatment_products"), domain("treatment_events"),
	domain("harvest_sessions"), domain("harvest_session_true_ups"),
	domain("honey_harvests"), domain("harvest_lots"),
	domain("harvest_lot_harvests"), domain("harvest_lot_photos"),
	domain("honey_varietals"), domain("jar_sizes"), domain("bottling_runs"),
	domain("jar_serials"), domain("honey_movements"),
	domain("product_catalog"), domain("propolis_harvests"),
	domain("product_batches"), domain("product_batch_expenses"),
	domain("product_adjustments"), domain("customers"),
	domain("wholesale_price_lists"), domain("wholesale_price_list_items"),
	domain("sales"), domain("sale_items"), domain("stock_locations"),
	domain("stock_movements"), domain("consignment_settlements"),
	domain("equipment_types"), domain("equipment_type_components"),
	domain("equipment_stock"), domain("equipment_stock_adjustments"),
	domain("equipment_deployments"), domain("equipment_deployment_returns"),
	domain("equipment_state_changes"), domain("expenses"),
	domain("catch_boxes"), domain("colony_intakes"), domain("field_incidents"),
	domain("deadout_autopsies"), domain("bloom_observations"),
	domain("yard_scales"), domain("scale_readings"),
	domain("apiary_weather_cache"), domain("immich_timeline_scans"),
	domain("immich_timeline_candidates"), domain("photos"),
	domain("media_files"), domain("transcript_versions"),
	domain("yard_labor_sessions"), domain("ai_recommendations"),
	domain("offline_mutation_receipts"), domain("external_sync"),
	{Name: "gnucash_sync_settings", Table: "gnucash_sync_settings", ExcludedColumns: []string{"api_token", "restore_state"}, RenameColumns: map[string]string{"last_synced_at": "last_attempt_at"}},
}

var omittedDomains = []OmittedDomain{
	{Domain: "api_tokens", Reason: "API tokens and token hashes are credentials and must be recreated."},
	{Domain: "oidc_identities", Reason: "OIDC login identities are authentication configuration and must be relinked."},
	{Domain: "ntfy_dispatches", Reason: "Notification delivery attempts are ephemeral queue/session state, not owned domain history."},
	{Domain: "sessions", Reason: "Authentication/session state is outside the portable restoration boundary (no durable table exists)."},
	{Domain: "payments", Reason: "No payments table exists; collected and invoiced money is preserved on sales and consignment_settlements."},
	{Domain: "deletion_tombstones", Reason: "The sync engine stores only conflict projections; durable deletion tombstones do not exist."},
	{Domain: "external_write_idempotency_keys", Reason: "Keys are derived at send time from externalID + contentHash and are not stored."},
}

func RegisteredDomains() []Domain {
	out := append([]Domain(nil), Domains...)
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out
}

func OmittedDomains() []OmittedDomain {
	return append([]OmittedDomain(nil), omittedDomains...)
}

func domainByTable() map[string]string {
	out := make(map[string]string, len(Domains))
	for _, item := range Domains {
		out[item.Table] = item.Name
	}
	return out
}

func excludedConfiguration() []ExcludedConfiguration {
	return []ExcludedConfiguration{
		{Domain: "app_users", Keys: []string{"auth_subject", "password_hash"}, Reason: "Login identities and password hashes must be reconfigured."},
		{Domain: "user_settings", Keys: []string{"password_hash", "ntfy_access_token", "ai_provider_config.apiKeys.anthropic", "ai_provider_config.apiKeys.google"}, Reason: "Passwords, notification tokens, and AI provider credentials are excluded per key."},
		{Domain: "gnucash_sync_settings", Keys: []string{"api_token"}, Reason: "The personal access token must be re-entered through guarded restore."},
	}
}
