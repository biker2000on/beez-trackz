package db

import "sort"

// The Phase B baseline drops ten tables that a Phase A database still carries
// (frozen and read-only). A snapshot taken from a Phase A database therefore
// contains ten domains that have nowhere to land in a baseline database — by
// design, not by accident.
//
// Reading such an artifact into a baseline target is a declared formatVersion
// 1 transform: the snapshot format does not change, the dropped domains are
// named in advance, and every reader that has to explain a difference reads
// the list from here rather than carrying its own copy. This is the interface
// the exporter, the reader, the importer, and the round-trip gate share; the
// list itself is a property of the migration chain, which is why it lives in
// this package beside the two chains it describes.
const (
	// BaselineTransform is the transform name a report or a verification
	// mapping uses when a domain is absent because the baseline dropped it.
	BaselineTransform = "domains-dropped-by-baseline"
	// BaselineTransformVersion versions that declaration. It changes only if
	// the dropped set changes, which is a design-review event.
	BaselineTransformVersion = "ledger-v1-baseline-drop-v1"
)

// baselineDroppedTables is decision 10's list as amended by section 8: the
// eight legacy quantity tables, plus stock_locations (replaced by
// inventory_locations) and equipment_type_components (replaced by BOMs). All
// ten are registered snapshot domains on the Phase A schema.
var baselineDroppedTables = []string{
	"equipment_deployment_returns",
	"equipment_deployments",
	"equipment_state_changes",
	"equipment_stock",
	"equipment_stock_adjustments",
	"equipment_type_components",
	"honey_movements",
	"product_adjustments",
	"stock_locations",
	"stock_movements",
}

// baselineDroppedViews are the five read surfaces over those tables. They are
// not snapshot domains — no reader has to explain them — but the baseline test
// and the runbook both need the list named once.
var baselineDroppedViews = []string{
	"equipment_loss_events",
	"equipment_stock_reconciliation",
	"equipment_stock_status",
	"honey_lot_balances",
	"honey_varietal_balances",
}

var baselineDroppedSet = func() map[string]bool {
	out := make(map[string]bool, len(baselineDroppedTables)+len(baselineDroppedViews))
	for _, name := range baselineDroppedTables {
		out[name] = true
	}
	for _, name := range baselineDroppedViews {
		out[name] = true
	}
	return out
}()

// BaselineDroppedTables names, in sorted order, the tables (and therefore the
// snapshot domains) that exist on the Phase A chain and not on the baseline.
func BaselineDroppedTables() []string {
	out := append([]string(nil), baselineDroppedTables...)
	sort.Strings(out)
	return out
}

// BaselineDroppedViews names the views dropped with those tables.
func BaselineDroppedViews() []string {
	out := append([]string(nil), baselineDroppedViews...)
	sort.Strings(out)
	return out
}

// BaselineDrops reports whether a table or view is absent from the baseline
// by design. A caller that finds a registered domain missing from a baseline
// database asks this: true means "declared", false means "unexplained", which
// is the difference between a passing and a failing round trip.
func BaselineDrops(name string) bool { return baselineDroppedSet[name] }
