package db

import (
	"context"
	"io/fs"
	"sort"
	"strings"
	"testing"
)

// Phase B, spec section 9 step 6: 00001_baseline.sql must be the post-00054
// schema minus the dropped legacy quantity tables — no more, no less. The only
// way to assert that honestly is to build both databases and diff the
// catalogue, which is what these tests do. They skip cleanly without
// TEST_DATABASE_URL like every other database-backed test here.

// droppedTables and droppedViews are read from the shared declaration in
// baseline_domains.go rather than restated here: a test that keeps its own
// copy of the list it is checking proves only that the copy is consistent.
var droppedTables = BaselineDroppedTables()

var droppedViews = BaselineDroppedViews()

// droppedFunctions and droppedEnums exist only to serve the dropped tables.
// They are asserted explicitly rather than left to "whatever CASCADE did",
// because a function that survives its only table is a silently broken object
// that the next reader will assume still works.
var droppedFunctions = []string{
	"equipment_component_cycle_guard",
	"equipment_ledger_sync",
	"equipment_merge_duplicate_stock",
	"equipment_stock_ledger_totals",
	"equipment_stock_reconcile_guard",
	"equipment_stock_sync",
	"honey_movement_lot_matches_run",
}

var droppedEnums = []string{
	"equipment_state",
	"frame_condition",
	"honey_movement_kind",
	"stock_adjustment_reason",
}

func isDropped(name string) bool { return BaselineDrops(name) }

// buildProfileDatabase creates a scratch database and migrates it with one of
// the two embedded chains, returning its URL.
func buildProfileDatabase(ctx context.Context, t *testing.T, name string, profile SchemaProfile) (string, func()) {
	t.Helper()
	adminURL := requireGuardDatabase(t)
	pool, cleanup := freshDatabase(ctx, t, name)
	pool.Close()
	url := replaceDatabase(adminURL, name)
	if err := MigrateProfile(ctx, url, profile); err != nil {
		cleanup()
		t.Fatalf("migrate %s with the %s profile: %v", name, profile, err)
	}
	return url, cleanup
}

// catalogRow is one comparable fact about a schema. Tables, columns, and
// constraints are compared as sorted string sets so a diff names the object
// rather than reporting "schemas differ".
func catalogRows(ctx context.Context, t *testing.T, url string, query string) []string {
	t.Helper()
	pool, err := openPool(ctx, url)
	if err != nil {
		t.Fatalf("open %s: %v", url, err)
	}
	defer pool.Close()
	rows, err := pool.Query(ctx, query)
	if err != nil {
		t.Fatalf("catalogue query: %v", err)
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var value string
		if err := rows.Scan(&value); err != nil {
			t.Fatalf("scan catalogue row: %v", err)
		}
		out = append(out, value)
	}
	if err := rows.Err(); err != nil {
		t.Fatalf("catalogue query: %v", err)
	}
	sort.Strings(out)
	return out
}

// diffSets reports what only the chain has and what only the baseline has.
func diffSets(chain, baseline []string) (chainOnly, baselineOnly []string) {
	inBaseline := map[string]bool{}
	for _, value := range baseline {
		inBaseline[value] = true
	}
	inChain := map[string]bool{}
	for _, value := range chain {
		inChain[value] = true
		if !inBaseline[value] {
			chainOnly = append(chainOnly, value)
		}
	}
	for _, value := range baseline {
		if !inChain[value] {
			baselineOnly = append(baselineOnly, value)
		}
	}
	return chainOnly, baselineOnly
}

// The core Phase B assertion. Two fresh databases, one per chain; every
// difference in the catalogue must be explained by the dropped set.
func TestBaselineMatchesTheLegacyChain(t *testing.T) {
	ctx := guardContext(t)

	chainURL, dropChain := buildProfileDatabase(ctx, t,
		"beez_trackz_test_pb_cmp_chain", ProfileLegacyChain)
	defer dropChain()
	baselineURL, dropBaseline := buildProfileDatabase(ctx, t,
		"beez_trackz_test_pb_cmp_base", ProfileBaseline)
	defer dropBaseline()

	// goose_db_version is the chain's own bookkeeping and is expected to
	// differ (53 rows vs 1); it is excluded from every comparison below.
	const tableQuery = `
		SELECT table_type || ' ' || table_name
		FROM information_schema.tables
		WHERE table_schema = 'public' AND table_name <> 'goose_db_version'`
	const columnQuery = `
		SELECT c.table_name || '.' || c.column_name || ' ' || c.data_type
			|| ' null=' || c.is_nullable
			|| ' default=' || COALESCE(c.column_default, '-')
		FROM information_schema.columns c
		JOIN information_schema.tables t
			ON t.table_schema = c.table_schema AND t.table_name = c.table_name
		WHERE c.table_schema = 'public' AND c.table_name <> 'goose_db_version'`
	const constraintQuery = `
		SELECT conrelid::regclass::text || ' ' || conname || ' ' || pg_get_constraintdef(oid)
		FROM pg_constraint
		WHERE connamespace = 'public'::regnamespace
			AND conrelid::regclass::text <> 'goose_db_version'`
	const indexQuery = `
		SELECT tablename || ' ' || indexname || ' ' || indexdef
		FROM pg_indexes
		WHERE schemaname = 'public' AND tablename <> 'goose_db_version'`
	const triggerQuery = `
		SELECT event_object_table || ' ' || trigger_name || ' ' || action_statement
		FROM information_schema.triggers
		WHERE trigger_schema = 'public'`

	for _, comparison := range []struct {
		what  string
		query string
	}{
		{"tables and views", tableQuery},
		{"columns", columnQuery},
		{"constraints", constraintQuery},
		{"indexes", indexQuery},
		{"triggers", triggerQuery},
	} {
		chainRows := catalogRows(ctx, t, chainURL, comparison.query)
		baselineRows := catalogRows(ctx, t, baselineURL, comparison.query)
		chainOnly, baselineOnly := diffSets(chainRows, baselineRows)

		// Everything the chain has and the baseline does not must name a
		// dropped object. The four foreign keys that pointed INTO the dropped
		// set go with it and are recognised the same way.
		var unexplained []string
		for _, row := range chainOnly {
			if mentionsDropped(row) {
				continue
			}
			unexplained = append(unexplained, row)
		}
		if len(unexplained) > 0 {
			t.Errorf("%s present on the chain but missing from the baseline for no declared reason:\n  %s",
				comparison.what, strings.Join(unexplained, "\n  "))
		}
		// Nothing may appear on the baseline that the chain does not have:
		// the squash removes, it never invents.
		if len(baselineOnly) > 0 {
			t.Errorf("%s present on the baseline but not on the chain:\n  %s",
				comparison.what, strings.Join(baselineOnly, "\n  "))
		}
	}

	// Spelled out separately, because "the diff is explained" would also be
	// satisfied by a baseline that still carried the tables.
	basePool, err := openPool(ctx, baselineURL)
	if err != nil {
		t.Fatalf("open the baseline: %v", err)
	}
	defer basePool.Close()
	for _, name := range append(append([]string{}, droppedTables...), droppedViews...) {
		var present *string
		if err := basePool.QueryRow(ctx,
			`SELECT to_regclass('public.' || $1)::text`, name).Scan(&present); err != nil {
			t.Fatalf("look up %s: %v", name, err)
		}
		if present != nil {
			t.Errorf("%s is still present in the baseline", name)
		}
	}
	for _, name := range droppedFunctions {
		var count int
		if err := basePool.QueryRow(ctx, `
			SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
			WHERE n.nspname = 'public' AND p.proname = $1`, name).Scan(&count); err != nil {
			t.Fatalf("look up function %s: %v", name, err)
		}
		if count != 0 {
			t.Errorf("function %s outlived its only table in the baseline", name)
		}
	}
	for _, name := range droppedEnums {
		var present *string
		if err := basePool.QueryRow(ctx,
			`SELECT to_regtype('public.' || $1)::text`, name).Scan(&present); err != nil {
			t.Fatalf("look up type %s: %v", name, err)
		}
		if present != nil {
			t.Errorf("enum %s outlived its only column in the baseline", name)
		}
	}

	// And the retained side: a table nobody dropped must still be there, with
	// its rows-shaped seeds. inventory_operation_kinds is the registry the
	// service validates every operation against; an empty one would pass a
	// pure information_schema diff and fail on the first write.
	var kinds int
	if err := basePool.QueryRow(ctx,
		`SELECT count(*) FROM inventory_operation_kinds`).Scan(&kinds); err != nil {
		t.Fatalf("read inventory_operation_kinds: %v", err)
	}
	chainPool, err := openPool(ctx, chainURL)
	if err != nil {
		t.Fatalf("open the chain: %v", err)
	}
	defer chainPool.Close()
	var chainKinds int
	if err := chainPool.QueryRow(ctx,
		`SELECT count(*) FROM inventory_operation_kinds`).Scan(&chainKinds); err != nil {
		t.Fatalf("read inventory_operation_kinds: %v", err)
	}
	if kinds != chainKinds {
		t.Errorf("inventory_operation_kinds: baseline has %d rows, chain has %d", kinds, chainKinds)
	}

	// Every seeded registry and singleton must match row for row, because the
	// producers address them by literal id.
	for _, seed := range []struct {
		what  string
		query string
	}{
		{"item kinds", `SELECT string_agg(kind, ',' ORDER BY kind) FROM inventory_item_kinds`},
		{"location kinds", `SELECT string_agg(kind, ',' ORDER BY kind) FROM inventory_location_kinds`},
		{"operation kinds", `SELECT string_agg(kind || ':' || sided, ',' ORDER BY kind) FROM inventory_operation_kinds`},
		{"conditions", `SELECT string_agg(condition, ',' ORDER BY condition) FROM inventory_conditions`},
		{"reasons", `SELECT string_agg(reason, ',' ORDER BY reason) FROM inventory_operation_reasons`},
		{"items", `SELECT string_agg(id::text || ':' || kind || ':' || canonical_unit, ',' ORDER BY id::text) FROM inventory_items`},
		{"locations", `SELECT string_agg(id::text || ':' || kind || ':' || is_home::text, ',' ORDER BY id::text) FROM inventory_locations`},
		{"treatment products", `SELECT string_agg(name_key || ':' || withdrawal_days::text, ',' ORDER BY name_key) FROM treatment_products`},
	} {
		var chainValue, baseValue *string
		if err := chainPool.QueryRow(ctx, seed.query).Scan(&chainValue); err != nil {
			t.Fatalf("read chain %s: %v", seed.what, err)
		}
		if err := basePool.QueryRow(ctx, seed.query).Scan(&baseValue); err != nil {
			t.Fatalf("read baseline %s: %v", seed.what, err)
		}
		if derefOrEmpty(chainValue) != derefOrEmpty(baseValue) {
			t.Errorf("seeded %s differ:\n  chain:    %s\n  baseline: %s",
				seed.what, derefOrEmpty(chainValue), derefOrEmpty(baseValue))
		}
	}
}

func derefOrEmpty(value *string) string {
	if value == nil {
		return ""
	}
	return *value
}

// mentionsDropped reports whether a catalogue row is about one of the dropped
// objects. Matching on word boundaries rather than substrings, so
// "equipment_stock" does not silently excuse "equipment_stock_something_new".
func mentionsDropped(row string) bool {
	for _, token := range strings.FieldsFunc(row, func(r rune) bool {
		return !(r == '_' || r == '.' ||
			(r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9'))
	}) {
		for _, part := range strings.Split(token, ".") {
			if isDropped(part) {
				return true
			}
		}
	}
	return false
}

// The baseline stamps its own generation and sits at goose version 1. Both
// halves matter: the stamp is what stops a Phase A database from being served
// by a baseline binary that would otherwise see "version 1, already applied".
func TestBaselineDatabaseIsStampedAndAtVersionOne(t *testing.T) {
	t.Setenv(BaselineEnvVar, "1")
	ctx := guardContext(t)

	if ActiveProfile() != ProfileBaseline {
		t.Fatalf("ActiveProfile() = %s, want %s", ActiveProfile(), ProfileBaseline)
	}
	if got := ExpectedMaxMigration(); got != 1 {
		t.Fatalf("ExpectedMaxMigration() under the baseline = %d, want 1", got)
	}

	adminURL := requireGuardDatabase(t)
	const name = "beez_trackz_test_pb_stamp"
	_, cleanup := freshDatabase(ctx, t, name)
	defer cleanup()
	url := replaceDatabase(adminURL, name)

	pool, err := Connect(ctx, url)
	if err != nil {
		t.Fatalf("Connect a fresh baseline database: %v", err)
	}
	defer pool.Close()

	var generation string
	if err := pool.QueryRow(ctx, `SELECT generation FROM schema_generation`).Scan(&generation); err != nil {
		t.Fatalf("read the generation stamp: %v", err)
	}
	if generation != BaselineGeneration {
		t.Fatalf("generation = %q, want %q", generation, BaselineGeneration)
	}
	var gooseMax int64
	if err := pool.QueryRow(ctx,
		`SELECT COALESCE(MAX(version_id) FILTER (WHERE is_applied), 0) FROM goose_db_version`).Scan(&gooseMax); err != nil {
		t.Fatalf("read goose head: %v", err)
	}
	if gooseMax != 1 {
		t.Fatalf("goose head = %d, want 1", gooseMax)
	}

	worker, err := ConnectWithoutMigrations(ctx, url)
	if err != nil {
		t.Fatalf("ConnectWithoutMigrations a baseline database: %v", err)
	}
	worker.Close()
}

// The whole point of a second generation string (design review A6): neither
// binary will serve the other's database, in either direction, even though
// both look "fully migrated" to goose.
func TestTheTwoGenerationsRefuseEachOther(t *testing.T) {
	ctx := guardContext(t)

	chainURL, dropChain := buildProfileDatabase(ctx, t,
		"beez_trackz_test_pb_cross_chain", ProfileLegacyChain)
	defer dropChain()
	baselineURL, dropBaseline := buildProfileDatabase(ctx, t,
		"beez_trackz_test_pb_cross_base", ProfileBaseline)
	defer dropBaseline()

	// A default-profile binary handed the baseline database.
	_, err := ConnectWithoutMigrations(ctx, baselineURL)
	requireGenerationError(t, err, ReasonGenerationMismatch, BaselineGeneration)
	// ...and it must not be talked into it by --legacy-source either: the
	// exception covers generation 'legacy', not "some other generation".
	_, err = ConnectLegacySource(ctx, baselineURL)
	requireGenerationError(t, err, ReasonGenerationMismatch, BaselineGeneration)

	// A baseline binary handed a Phase A database.
	t.Setenv(BaselineEnvVar, "1")
	_, err = ConnectWithoutMigrations(ctx, chainURL)
	requireGenerationError(t, err, ReasonGenerationMismatch, Generation)
	_, err = ConnectLegacySource(ctx, chainURL)
	requireGenerationError(t, err, ReasonGenerationMismatch, Generation)

	// Connect (which migrates first) must refuse it too rather than running
	// the baseline over a populated Phase A schema. goose would see version 1
	// as unapplied and try to create 72 tables that already exist; the guard
	// is what turns that into a clear refusal instead of a DDL error.
	_, err = Connect(ctx, chainURL)
	if err == nil {
		t.Fatal("Connect must refuse a Phase A database under the baseline profile")
	}
	if _, isGuard := IsGenerationError(err); !isGuard && !strings.Contains(err.Error(), "run migrations") {
		t.Fatalf("unexpected failure shape: %v", err)
	}
}

// The default is the current chain. This is the assertion that protects
// everyone else's work in the tree: nothing about adding the baseline may
// change what an unconfigured binary does.
func TestDefaultProfileIsTheLegacyChain(t *testing.T) {
	if got := ActiveProfile(); got != ProfileLegacyChain {
		t.Fatalf("ActiveProfile() = %s with %s unset, want %s",
			got, BaselineEnvVar, ProfileLegacyChain)
	}
	if got := ActiveGeneration(); got != Generation {
		t.Fatalf("ActiveGeneration() = %q, want %q", got, Generation)
	}
	if got := ExpectedMaxMigration(); got != maxEmbeddedMigrationFor(ProfileLegacyChain) {
		t.Fatalf("ExpectedMaxMigration() = %d, want the legacy chain head %d",
			got, maxEmbeddedMigrationFor(ProfileLegacyChain))
	}
	if got := maxEmbeddedMigrationFor(ProfileBaseline); got != 1 {
		t.Fatalf("the baseline FS holds goose head %d, want exactly 1", got)
	}
	for _, value := range []string{"", "0", "false", "no", "off", "maybe"} {
		t.Setenv(BaselineEnvVar, value)
		if got := ActiveProfile(); got != ProfileLegacyChain {
			t.Fatalf("%s=%q selected %s; only an explicit true value may select the baseline",
				BaselineEnvVar, value, got)
		}
	}
	for _, value := range []string{"1", "true", "TRUE", "Yes", "on"} {
		t.Setenv(BaselineEnvVar, value)
		if got := ActiveProfile(); got != ProfileBaseline {
			t.Fatalf("%s=%q selected %s, want %s", BaselineEnvVar, value, got, ProfileBaseline)
		}
	}
}

// A guard rail for the file itself: the baseline directory holds exactly one
// migration, and the legacy directory holds the chain it replaces. If someone
// adds 00054 to the legacy chain after the baseline is generated, the baseline
// is stale and TestBaselineMatchesTheLegacyChain will say so — but this names
// the layout mistake directly.
func TestEmbeddedLayout(t *testing.T) {
	baseline := catalogNames(t, ProfileBaseline)
	if len(baseline) != 1 || baseline[0] != "00001_baseline.sql" {
		t.Fatalf("baseline directory holds %v, want exactly [00001_baseline.sql]", baseline)
	}
	legacy := catalogNames(t, ProfileLegacyChain)
	if len(legacy) < 54 {
		t.Fatalf("legacy chain holds %d migrations, want the full 00001-00054", len(legacy))
	}
	if legacy[0] != "00001_init.sql" {
		t.Fatalf("legacy chain starts at %s, want 00001_init.sql", legacy[0])
	}
}

func catalogNames(t *testing.T, profile SchemaProfile) []string {
	t.Helper()
	chain, ok := chains[profile]
	if !ok {
		t.Fatalf("unknown profile %q", profile)
	}
	entries, err := fs.ReadDir(chain.fs, chain.dir)
	if err != nil {
		t.Fatalf("read %s: %v", chain.dir, err)
	}
	var names []string
	for _, entry := range entries {
		if !entry.IsDir() && strings.HasSuffix(entry.Name(), ".sql") {
			names = append(names, entry.Name())
		}
	}
	sort.Strings(names)
	return names
}
