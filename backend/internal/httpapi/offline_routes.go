package httpapi

import "strings"

// The offline route manifest is the single source of truth for which API
// mutations the PWA may queue while offline. The server enforces receipt
// bookkeeping for exactly these routes (middleware_offline.go) and the
// service worker queues exactly these routes
// (frontend/src/app/sw.js/route.ts). The two lists drifted apart once
// already, so the TypeScript half is generated from this file and
// TestOfflineRouteManifestMatchesFrontend fails when it goes stale.

// offlineRouteRule matches one family of API paths. Methods, when set, is the
// exhaustive list of queueable methods for the family; ExceptMethods removes
// methods from the default set (POST, PUT, PATCH, DELETE). Exact matches the
// path itself rather than a prefix.
type offlineRouteRule struct {
	Prefix        string   `json:"prefix"`
	Exact         bool     `json:"exact,omitempty"`
	Methods       []string `json:"methods,omitempty"`
	ExceptMethods []string `json:"exceptMethods,omitempty"`
}

type offlineRouteManifest struct {
	Rules []offlineRouteRule `json:"rules"`
	// POSTExclusions are exact paths whose POST creates server-side state
	// that cannot be replayed safely (a layout run, a session, an AI job).
	POSTExclusions []string `json:"postExclusions"`
}

var offlineRoutes = offlineRouteManifest{
	Rules: []offlineRouteRule{
		{Prefix: "/api/v1/inspections"},
		{Prefix: "/api/v1/feedings"},
		{Prefix: "/api/v1/bloom-observations"},
		{Prefix: "/api/v1/mite-counts"},
		{Prefix: "/api/v1/treatment-events"},
		{Prefix: "/api/v1/queen-events"},
		{Prefix: "/api/v1/queens"},
		{Prefix: "/api/v1/photos/"},
		{Prefix: "/api/v1/canvas/"},
		{Prefix: "/api/v1/harvest-sessions/"},
		{Prefix: "/api/v1/harvest-entries/"},
		{Prefix: "/api/v1/recommendations/"},
		// Honey and commerce writes. Market day is the most offline-prone
		// surface in the product — a farmers' market with no signal — and
		// every one of these routes was previously excluded, so a replayed
		// queue could book the same sale twice.
		{Prefix: "/api/v1/harvests"},
		{Prefix: "/api/v1/honey/jarring"},
		{Prefix: "/api/v1/honey/bulk-movements"},
		{Prefix: "/api/v1/honey/give-away"},
		{Prefix: "/api/v1/honey/jar-adjustments"},
		{Prefix: "/api/v1/honey/movements/"},
		{Prefix: "/api/v1/honey/sales"},
		{Prefix: "/api/v1/sales"},
		{Prefix: "/api/v1/jar-sizes"},
		{Prefix: "/api/v1/expenses"},
		{Prefix: "/api/v1/customers"},
		{Prefix: "/api/v1/harvest-lots"},
		{Prefix: "/api/v1/wholesale-price-lists"},
		{Prefix: "/api/v1/products"},
		{Prefix: "/api/v1/propolis-harvests"},
		{Prefix: "/api/v1/product-batches"},
		{Prefix: "/api/v1/hives/bulk", Exact: true},
		{Prefix: "/api/v1/hives/", ExceptMethods: []string{"DELETE"}},
		{Prefix: "/api/v1/apiaries/", Methods: []string{"PUT"}},
		{Prefix: "/api/v1/splits/", Methods: []string{"DELETE"}},
		{Prefix: "/api/v1/ops/labor/start", Exact: true, Methods: []string{"POST"}},
		{Prefix: "/api/v1/ops/labor/stop", Exact: true, Methods: []string{"POST"}},
		// Equipment ledger writes. Field work (receive, adjust, damage,
		// repair, retire, physical count, deploy, return) is the other
		// offline-prone surface; these routes were missing from the PWA
		// allowlist, so queued stock changes could never replay. GET
		// list/read routes, catalog/stock creates, PATCH metadata, and
		// seed-defaults stay out — only the idempotent ledger mutations.
		{Prefix: "/api/v1/equipment/stock/", Methods: []string{"POST"}},
		{Prefix: "/api/v1/equipment/physical-count", Exact: true, Methods: []string{"POST"}},
		{Prefix: "/api/v1/equipment/deployments", Methods: []string{"POST"}},
	},
	POSTExclusions: []string{
		"/api/v1/canvas/hives",
		"/api/v1/harvest-sessions",
		"/api/v1/recommendations/run",
	},
}

func (rule offlineRouteRule) matches(method, path string) bool {
	if rule.Exact {
		if path != rule.Prefix {
			return false
		}
	} else if !strings.HasPrefix(path, rule.Prefix) {
		return false
	}
	if len(rule.Methods) > 0 {
		for _, allowed := range rule.Methods {
			if allowed == method {
				return true
			}
		}
		return false
	}
	for _, denied := range rule.ExceptMethods {
		if denied == method {
			return false
		}
	}
	return true
}

func (m offlineRouteManifest) supports(method, path string) bool {
	matched := false
	for _, rule := range m.Rules {
		if rule.matches(method, path) {
			matched = true
			break
		}
	}
	if !matched {
		return false
	}
	if method != "POST" {
		return true
	}
	for _, excluded := range m.POSTExclusions {
		if path == excluded {
			return false
		}
	}
	return true
}
