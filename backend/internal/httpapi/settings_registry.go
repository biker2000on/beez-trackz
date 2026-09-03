package httpapi

// settingsOwner is the one surface allowed to edit or operate an object that
// used to appear in the catch-all Settings screen.
type settingsOwner string

const (
	ownerMyPreferences     settingsOwner = "My Preferences"
	ownerOperationSetup    settingsOwner = "Operation Setup"
	ownerAdminIntegrations settingsOwner = "Admin & Integrations"
	ownerProduction        settingsOwner = "Production"
	ownerEquipment         settingsOwner = "Equipment"
	ownerYard              settingsOwner = "Yard"
	ownerInsights          settingsOwner = "Insights"
)

type settingsRegistryEntry struct {
	Object string
	Owner  settingsOwner
}

// settingsSectionRegistry is the backend inventory for the Settings split.
// Links may point at an owner, but no second editor may be mounted elsewhere.
var settingsSectionRegistry = []settingsRegistryEntry{
	{"password login", ownerMyPreferences},
	{"theme", ownerMyPreferences},
	{"default apiary", ownerMyPreferences},
	{"date format", ownerMyPreferences},
	{"weight unit", ownerMyPreferences},
	{"unit system", ownerMyPreferences},
	{"temperature unit", ownerMyPreferences},
	{"install app", ownerMyPreferences},
	{"personal apiary access", ownerMyPreferences},
	{"personal API tokens", ownerMyPreferences},
	{"personal MCP connection", ownerMyPreferences},
	{"jar sizes", ownerOperationSetup},
	{"treatment withdrawals", ownerOperationSetup},
	{"labor tracking enable flag", ownerOperationSetup},
	{"AI provider configuration", ownerAdminIntegrations},
	{"photo storage", ownerAdminIntegrations},
	{"ntfy connection", ownerAdminIntegrations},
	{"GnuCash credentials and book", ownerAdminIntegrations},
	{"collaborators and roles", ownerAdminIntegrations},
	{"administrator API tokens", ownerAdminIntegrations},
	{"administrator MCP access", ownerAdminIntegrations},
	{"system health", ownerAdminIntegrations},
	{"honey varietals", ownerProduction},
	{"equipment types and BOMs", ownerEquipment},
	{"labor start and stop", ownerYard},
	{"compliance packet", ownerInsights},
	{"GnuCash reconciliation report", ownerInsights},
}
