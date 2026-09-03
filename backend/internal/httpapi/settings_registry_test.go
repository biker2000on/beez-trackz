package httpapi

import "testing"

func TestSectionRegistryAssignsEveryConfigurationObjectExactlyOnce(t *testing.T) {
	want := []string{
		"password login", "theme", "default apiary", "date format", "weight unit",
		"unit system", "temperature unit", "install app", "personal apiary access",
		"personal API tokens", "personal MCP connection", "jar sizes",
		"treatment withdrawals", "labor tracking enable flag",
		"AI provider configuration", "photo storage", "ntfy connection",
		"GnuCash credentials and book", "collaborators and roles",
		"administrator API tokens", "administrator MCP access", "system health",
		"honey varietals", "equipment types and BOMs", "labor start and stop",
		"compliance packet", "GnuCash reconciliation report",
	}
	counts := make(map[string]int, len(settingsSectionRegistry))
	for _, entry := range settingsSectionRegistry {
		if entry.Owner == "" {
			t.Errorf("%q has no owning surface", entry.Object)
		}
		counts[entry.Object]++
	}
	for _, object := range want {
		if counts[object] != 1 {
			t.Errorf("%q appears %d times, want exactly once", object, counts[object])
		}
		delete(counts, object)
	}
	for object, count := range counts {
		t.Errorf("unreviewed registry object %q appears %d times", object, count)
	}
}

func TestSectionRegistryResolvesFormerDualHomes(t *testing.T) {
	wantOwner := map[string]settingsOwner{
		"labor tracking enable flag":    ownerOperationSetup,
		"labor start and stop":          ownerYard,
		"compliance packet":             ownerInsights,
		"GnuCash reconciliation report": ownerInsights,
	}
	for _, entry := range settingsSectionRegistry {
		if want, ok := wantOwner[entry.Object]; ok {
			if entry.Owner != want {
				t.Errorf("%q owner = %q, want %q", entry.Object, entry.Owner, want)
			}
			delete(wantOwner, entry.Object)
		}
	}
	for object := range wantOwner {
		t.Errorf("former dual-homed object %q is missing", object)
	}
}
