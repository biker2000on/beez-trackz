package main

import (
	"bytes"
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/biker2000on/beez-trackz/backend/internal/app"
	ledgerbackfill "github.com/biker2000on/beez-trackz/backend/internal/app/backfill"
	"github.com/biker2000on/beez-trackz/backend/internal/db"
	"github.com/biker2000on/beez-trackz/backend/internal/snapshot"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

type options struct {
	input, database, conflict, report string
	dryRun                            bool
	backfillLedger                    bool
}

type reportRecord struct {
	Domain           string          `json:"domain"`
	ID               json.RawMessage `json:"id"`
	Outcome          app.Outcome     `json:"outcome"`
	Transform        string          `json:"transform,omitempty"`
	TransformVersion string          `json:"transformVersion,omitempty"`
	Kind             app.Kind        `json:"kind,omitempty"`
	Error            string          `json:"error,omitempty"`
}

type restoreReport struct {
	Success          bool                   `json:"success"`
	DryRun           bool                   `json:"dryRun"`
	Counts           map[app.Outcome]int    `json:"counts"`
	Records          []reportRecord         `json:"records"`
	MissingMedia     []string               `json:"missingMedia"`
	ExcludedConfig   []string               `json:"excludedConfiguration"`
	ValidationErrors []string               `json:"validationErrors"`
	LedgerBackfill   *ledgerbackfill.Report `json:"ledgerBackfill,omitempty"`
}

func newReport(dryRun bool) *restoreReport {
	// Every outcome key is always present so report consumers (the
	// roundtrip-gate counter extraction in particular) never have to guess
	// whether an absent key means zero.
	counts := map[app.Outcome]int{
		app.OutcomeCreated: 0, app.OutcomeUnchanged: 0, app.OutcomeUpdated: 0,
		app.OutcomeSkipped: 0, app.OutcomeConflicted: 0, app.OutcomeFailed: 0,
	}
	return &restoreReport{DryRun: dryRun, Counts: counts, Records: []reportRecord{}, MissingMedia: []string{}, ExcludedConfig: []string{}, ValidationErrors: []string{}}
}

func (r *restoreReport) add(domain string, id json.RawMessage, outcome app.Outcome, err error) {
	item := reportRecord{Domain: domain, ID: append(json.RawMessage(nil), id...), Outcome: outcome}
	if err != nil {
		item.Kind, item.Error = app.KindOf(err), err.Error()
	}
	r.Counts[outcome]++
	r.Records = append(r.Records, item)
}

func (r *restoreReport) addBaselineDrop(domain string) {
	r.Counts[app.OutcomeSkipped]++
	r.Records = append(r.Records, reportRecord{
		Domain: domain, Outcome: app.OutcomeSkipped,
		Transform: db.BaselineTransform, TransformVersion: db.BaselineTransformVersion,
	})
}

func (r *restoreReport) addPreLedgerDomain(domain string) {
	r.Counts[app.OutcomeSkipped]++
	r.Records = append(r.Records, reportRecord{
		Domain: domain, Outcome: app.OutcomeSkipped, Transform: snapshot.PreLedgerTransform,
	})
}

func (r *restoreReport) addSchemaAheadMigration(applied snapshot.AppliedPostArtifactMigration) {
	r.Counts[app.OutcomeSkipped]++
	r.Records = append(r.Records, reportRecord{
		Domain: strings.Join(applied.Domains, ","), Outcome: app.OutcomeSkipped,
		Transform: applied.Name, TransformVersion: fmt.Sprintf("legacy-%05d", applied.Migration),
	})
}

func main() { os.Exit(run(os.Args[1:])) }

func run(args []string) int {
	flags := flag.NewFlagSet("import-snapshot", flag.ContinueOnError)
	flags.SetOutput(os.Stderr)
	var opts options
	flags.StringVar(&opts.input, "input", "", "snapshot directory")
	flags.StringVar(&opts.database, "database", "", "Postgres target URL")
	flags.BoolVar(&opts.dryRun, "dry-run", false, "validate without writes")
	flags.BoolVar(&opts.backfillLedger, "backfill-ledger", false, "translate live legacy inventory tables and freeze them after parity")
	flags.StringVar(&opts.conflict, "conflict-policy", "fail", "fail, skip, or overwrite")
	flags.StringVar(&opts.report, "report", "./restore-report.json", "restore report path outside the snapshot")
	if err := flags.Parse(args); err != nil {
		report := newReport(opts.dryRun)
		report.ValidationErrors = append(report.ValidationErrors, err.Error())
		_ = writeReport(opts.report, report)
		return 2
	}
	report := newReport(opts.dryRun)
	var executeErr error
	if unsafeReportPath(opts.input, opts.report) {
		executeErr = fmt.Errorf("-report must be outside the snapshot artifact")
		fallback, _ := filepath.Abs("./restore-report.json")
		if unsafeReportPath(opts.input, fallback) {
			fallback = filepath.Join(filepath.Dir(opts.input), "restore-report.json")
		}
		opts.report = fallback
	}
	if executeErr == nil {
		executeErr = execute(context.Background(), opts, report)
	}
	if executeErr != nil {
		report.ValidationErrors = append(report.ValidationErrors, executeErr.Error())
	}
	report.Success = len(report.ValidationErrors) == 0 && report.Counts[app.OutcomeFailed] == 0 && report.Counts[app.OutcomeConflicted] == 0
	if err := writeReport(opts.report, report); err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	if !report.Success {
		for _, message := range report.ValidationErrors {
			fmt.Fprintln(os.Stderr, message)
		}
		return 1
	}
	if opts.backfillLedger && report.LedgerBackfill != nil {
		printLedgerBackfillSummary(os.Stdout, *report.LedgerBackfill)
	}
	return 0
}

func printLedgerBackfillSummary(w io.Writer, report ledgerbackfill.Report) {
	fmt.Fprintf(w, "ledger backfill: operations=%d frozen_tables=%d draw_before_receipt_injections=%d draw_before_receipt_reconciles=%d\n",
		report.Operations, len(report.FrozenTables), len(report.DrawBeforeReceiptInjections), len(report.DrawBeforeReceiptReconciles))
	for _, entry := range report.DrawBeforeReceiptInjections {
		fmt.Fprintf(w, "draw-before-receipt injection: item=%s location=%s lot=%s quantity=%s source=%s\n",
			entry.ItemID, entry.LocationID, entry.LotID, entry.Quantity, entry.Source)
	}
	for _, entry := range report.DrawBeforeReceiptReconciles {
		fmt.Fprintf(w, "draw-before-receipt reconcile: item=%s location=%s lot=%s quantity=%s source=%s\n",
			entry.ItemID, entry.LocationID, entry.LotID, entry.Quantity, entry.Source)
	}
}

func unsafeReportPath(input, report string) bool {
	if strings.TrimSpace(input) == "" || strings.TrimSpace(report) == "" {
		return false
	}
	inputPath, inputErr := filepath.Abs(input)
	reportPath, reportErr := filepath.Abs(report)
	if inputErr != nil || reportErr != nil {
		return false
	}
	relative, err := filepath.Rel(inputPath, reportPath)
	return err == nil && relative != ".." && !strings.HasPrefix(relative, ".."+string(filepath.Separator))
}

func execute(ctx context.Context, opts options, report *restoreReport) error {
	if !opts.backfillLedger && strings.TrimSpace(opts.input) == "" {
		return fmt.Errorf("-input is required")
	}
	if strings.TrimSpace(opts.database) == "" {
		return fmt.Errorf("-database is required")
	}
	if opts.report == "" {
		return fmt.Errorf("-report may not be empty")
	}
	if opts.backfillLedger {
		if opts.dryRun {
			return fmt.Errorf("-dry-run is not supported with -backfill-ledger; the gate is already all-or-nothing")
		}
		pool, err := db.Connect(ctx, opts.database)
		if err != nil {
			return err
		}
		defer pool.Close()
		// A pre-ledger restore deliberately leaves every ledger domain empty,
		// including migration registries. Re-establish the canonical schema
		// identities immediately before the translator needs them. The inserts
		// are idempotent for ordinary head databases.
		if err := ensureLedgerBackfillSeeds(ctx, pool); err != nil {
			return err
		}
		result, err := ledgerbackfill.Run(ctx, pool, ledgerbackfill.Options{})
		report.LedgerBackfill = &result
		return err
	}
	input, err := filepath.Abs(opts.input)
	if err != nil {
		return fmt.Errorf("resolve input: %w", err)
	}
	reportPath, err := filepath.Abs(opts.report)
	if err != nil {
		return fmt.Errorf("resolve report: %w", err)
	}
	inside, err := filepath.Rel(input, reportPath)
	if err == nil && inside != ".." && !strings.HasPrefix(inside, ".."+string(filepath.Separator)) {
		return fmt.Errorf("-report must be outside the snapshot artifact")
	}
	policy, err := parsePolicy(opts.conflict)
	if err != nil {
		return err
	}
	artifact, err := snapshot.OpenArtifact(input)
	if err != nil {
		return err
	}
	appliedMigrations, err := snapshot.ApplyPostArtifactMigrations(artifact)
	if err != nil {
		return err
	}
	for _, applied := range appliedMigrations {
		// Migration 00050 retains its established per-missing-domain report
		// below. Later schema-ahead migrations are reported once by name.
		if applied.Name != snapshot.PreLedgerTransform {
			report.addSchemaAheadMigration(applied)
		}
	}
	for _, excluded := range artifact.Manifest.ExcludedConfiguration {
		report.ExcludedConfig = append(report.ExcludedConfig, excluded.Domain+": "+strings.Join(excluded.Keys, ", ")+" — "+excluded.Reason)
	}
	for _, media := range artifact.Media.Objects {
		if media.HashState == "missing-or-unreadable" {
			report.MissingMedia = append(report.MissingMedia, media.RecordDomain+"/"+media.RecordID+": "+media.Reference)
		}
	}
	sort.Strings(report.MissingMedia)
	sort.Strings(report.ExcludedConfig)

	// Both paths are the strict generation guard: the importer writes, so it
	// never accepts the previous generation, with or without -dry-run
	// (design review OV3). Only export-snapshot --legacy-source and the
	// gate's source connection get that exception.
	var pool *pgxpool.Pool
	if opts.dryRun {
		pool, err = db.ConnectWithoutMigrations(ctx, opts.database)
	} else {
		pool, err = db.Connect(ctx, opts.database)
	}
	if err != nil {
		return err
	}
	defer pool.Close()
	runner := app.NewRunner(pool)
	actor := app.SystemRestoreActor(uuid.Nil)
	hasLegacyInventory := artifactHasLegacyInventory(artifact)
	preLedgerArtifact := len(artifact.PreLedgerDomains) > 0
	restoreFn := func(ctx context.Context, uow *app.UnitOfWork) error {
		equipmentTriggerDisabled := false
		if _, err := uow.Exec(ctx, `SET LOCAL TIME ZONE 'UTC'`); err != nil {
			return err
		}
		if hasLegacyInventory || preLedgerArtifact {
			if err := app.EnsureLegacyRestoreTargetIsWritable(ctx, uow); err != nil {
				if preLedgerArtifact && app.IsKind(err, app.KindPrecondition) {
					return app.Precondition("import pre-ledger snapshot", "target database has inventory_legacy_freeze triggers; restore the pre-Phase-A artifact onto a fresh replacement database per docs/restore-runbook.md section 6.5")
				}
				return err
			}
		}
		nonempty, err := databaseNonempty(ctx, uow)
		if err != nil {
			return err
		}
		if !opts.dryRun && nonempty && policy == app.ConflictFail {
			return app.Precondition("import snapshot", "target database is non-empty; choose -conflict-policy skip or overwrite")
		}
		if !nonempty {
			// DryRun rolls this transaction back. Performing the same seed
			// deletions is necessary for the validation pass to see the same
			// empty logical target as the real restore.
			if err := seededRowsYieldToSnapshot(ctx, uow, preLedgerArtifact); err != nil {
				return err
			}
		}
		presentTables := make(map[string]bool, len(snapshot.Domains))
		for _, domain := range snapshot.RegisteredDomains() {
			present, err := targetTablePresent(ctx, uow, domain.Table)
			if err != nil {
				return err
			}
			presentTables[domain.Table] = present
		}
		for _, domainName := range artifact.PreLedgerDomains {
			if presentTables[domainName] {
				report.addPreLedgerDomain(domainName)
			}
		}
		if !opts.dryRun {
			// Ledger replay updates a newly restored materialized stock row.
			// Suppress only its audit trigger on that first population; an
			// idempotent second import performs no DDL and no record writes.
			if presentTables["equipment_stock"] && len(artifact.Records["equipment_stock"]) > 0 {
				var stockEmpty bool
				if err := uow.QueryRow(ctx, `SELECT NOT EXISTS(SELECT 1 FROM equipment_stock)`).Scan(&stockEmpty); err != nil { // legacy-chain-only
					return err
				}
				if stockEmpty {
					if _, err := uow.Exec(ctx, `ALTER TABLE equipment_stock DISABLE TRIGGER equipment_stock_updated_at`); err != nil {
						return err
					}
					equipmentTriggerDisabled = true
				}
			}
		}

		repositories := make(map[string]*app.PortableRepository, len(snapshot.Domains))
		byName := make(map[string]snapshot.Domain, len(snapshot.Domains))
		for _, domain := range snapshot.RegisteredDomains() {
			byName[domain.Name] = domain
			if !presentTables[domain.Table] && db.BaselineDrops(domain.Name) {
				report.addBaselineDrop(domain.Name)
				continue
			}
			repo, err := app.NewPortableRepository(ctx, uow, domain.Name, domain.Table, domain.ExcludedColumns, domain.RenameColumns)
			if err != nil {
				return err
			}
			repositories[domain.Name] = repo
		}
		var recordErrors []error
		for _, domainName := range domainOrder(artifact) {
			domain := byName[domainName]
			if repositories[domainName] == nil {
				continue
			}
			records := recordOrder(domainName, artifact.Records[domainName], artifact.Verification.ReferenceChecks)
			for _, envelope := range records {
				outcome := app.OutcomeFailed
				var restoreErr error
				err := uow.Savepoint(ctx, func(ctx context.Context, inner *app.UnitOfWork) error {
					outcome, restoreErr = repositories[domainName].Restore(ctx, inner, app.PortableRecord{Domain: domainName, Table: domain.Table, ID: envelope.ID, Data: envelope.Data}, app.RestoreOptions{OnConflict: policy})
					return restoreErr
				})
				if err != nil {
					restoreErr = err
					if outcome != app.OutcomeConflicted {
						outcome = app.OutcomeFailed
					}
					recordErrors = append(recordErrors, err)
				}
				report.add(domainName, envelope.ID, outcome, restoreErr)
			}
		}
		if equipmentTriggerDisabled {
			if _, err := uow.Exec(ctx, `ALTER TABLE equipment_stock ENABLE TRIGGER equipment_stock_updated_at`); err != nil {
				return err
			}
		}
		if len(recordErrors) > 0 {
			return fmt.Errorf("restore failed for %d record(s); transaction rolled back", len(recordErrors))
		}
		return nil
	}
	if opts.dryRun {
		return runner.DryRun(ctx, actor, restoreFn)
	}
	return runner.Run(ctx, actor, restoreFn)
}

func artifactHasLegacyInventory(artifact *snapshot.Artifact) bool {
	for _, domain := range []string{
		"honey_movements", "stock_movements", "product_adjustments", "equipment_stock",
		"equipment_stock_adjustments", "equipment_deployments",
		"equipment_deployment_returns", "equipment_state_changes",
	} {
		if len(artifact.Records[domain]) > 0 {
			return true
		}
	}
	return false
}

func parsePolicy(value string) (app.ConflictPolicy, error) {
	switch value {
	case "fail":
		return app.ConflictFail, nil
	case "skip":
		return app.ConflictSkip, nil
	case "overwrite":
		return app.ConflictOverwrite, nil
	default:
		return app.ConflictFail, fmt.Errorf("-conflict-policy must be fail, skip, or overwrite")
	}
}

func writeReport(path string, report *restoreReport) error {
	if path == "" {
		path = "./restore-report.json"
	}
	content, err := json.MarshalIndent(report, "", "  ")
	if err != nil {
		return fmt.Errorf("encode restore report: %w", err)
	}
	content = append(content, '\n')
	if err := os.WriteFile(path, content, 0o600); err != nil {
		return fmt.Errorf("write restore report %s: %w", path, err)
	}
	return nil
}

func databaseNonempty(ctx context.Context, uow *app.UnitOfWork) (bool, error) {
	seedProducts := []string{
		"apivar", "apistan", "checkmite+", "formic pro", "apiguard", "apilife var", "oxalic acid", "hopguard",
		"terramycin", "tylan", "lincomix", "fumagilin-b", "thymovar", "varroxsan", "bayvarol", "para-moth", "certan",
	}
	for _, domain := range snapshot.RegisteredDomains() {
		present, err := targetTablePresent(ctx, uow, domain.Table)
		if err != nil {
			return false, err
		}
		if !present && db.BaselineDrops(domain.Name) {
			continue
		}
		table := quoteIdent(domain.Table)
		predicate := "TRUE"
		switch domain.Name {
		case "inventory_item_kinds", "inventory_location_kinds", "inventory_operation_kinds",
			"inventory_conditions", "inventory_operation_reasons", "schema_generation":
			// These rows are schema registries, not user data. Fresh databases
			// contain them immediately after migrations.
			continue
		case "inventory_items", "inventory_locations":
			// Migration 00050 installs singleton/default rows with no legacy
			// source identity. Backfilled or live catalog rows always have one.
			predicate = "source_type IS NOT NULL"
		case "stock_locations":
			predicate = "slug <> 'home'"
		case "treatment_products":
			quoted := make([]string, len(seedProducts))
			for i, value := range seedProducts {
				quoted[i] = "'" + strings.ReplaceAll(value, "'", "''") + "'"
			}
			predicate = "name_key NOT IN (" + strings.Join(quoted, ",") + ")"
		}
		var exists bool
		if err := uow.QueryRow(ctx, fmt.Sprintf("SELECT EXISTS(SELECT 1 FROM %s WHERE %s)", table, predicate)).Scan(&exists); err != nil {
			return false, err
		}
		if exists {
			return true, nil
		}
	}
	return false, nil
}

func targetTablePresent(ctx context.Context, uow *app.UnitOfWork, table string) (bool, error) {
	var present bool
	if err := uow.QueryRow(ctx, `SELECT to_regclass('public.' || $1) IS NOT NULL`, table).Scan(&present); err != nil {
		return false, err
	}
	return present, nil
}

func seededRowsYieldToSnapshot(ctx context.Context, uow *app.UnitOfWork, clearLedgerSeeds bool) error {
	stockLocationsPresent, err := targetTablePresent(ctx, uow, "stock_locations")
	if err != nil {
		return err
	}
	if stockLocationsPresent {
		if clearLedgerSeeds {
			// The artifact predates every inventory_* record. Clear the head
			// migration seeds in dependency order so its declared transform is
			// literally an empty ledger, not a mixture of artifact and target
			// state. -backfill-ledger restores the schema identities before use.
			for _, statement := range []string{
				`DELETE FROM stock_locations WHERE slug='home'`, // legacy-chain-only
				`DELETE FROM treatment_products`,
				`DELETE FROM inventory_balance_checkpoints`,
				`DELETE FROM inventory_bom_lines`,
				`DELETE FROM inventory_boms`,
				`DELETE FROM inventory_movements`,
				`DELETE FROM inventory_operations`,
				`DELETE FROM inventory_lots`,
				`DELETE FROM inventory_locations`,
				`DELETE FROM inventory_items`,
				`DELETE FROM inventory_operation_reasons`,
				`DELETE FROM inventory_conditions`,
				`DELETE FROM inventory_operation_kinds`,
				`DELETE FROM inventory_location_kinds`,
				`DELETE FROM inventory_item_kinds`,
			} {
				if _, err := uow.Exec(ctx, statement); err != nil {
					return err
				}
			}
			return nil
		}
		return app.SeededRowsYieldToSnapshot(ctx, uow)
	}
	if !db.BaselineDrops("stock_locations") {
		return fmt.Errorf("restore seeds: stock_locations is absent from an undeclared target schema")
	}
	for _, statement := range []string{
		`DELETE FROM treatment_products`,
		`DELETE FROM inventory_locations WHERE id IN ('00000000-0000-0000-0000-000000000201','00000000-0000-0000-0000-000000000202')`,
		`DELETE FROM inventory_items WHERE id IN ('00000000-0000-0000-0000-000000000101','00000000-0000-0000-0000-000000000102')`,
	} {
		if _, err := uow.Exec(ctx, statement); err != nil {
			return err
		}
	}
	return nil
}

func ensureLedgerBackfillSeeds(ctx context.Context, pool *pgxpool.Pool) error {
	_, err := pool.Exec(ctx, `
		INSERT INTO inventory_item_kinds (kind, description, unit_family) VALUES
		  ('honey_bulk', 'Bulk honey', 'mass'),
		  ('jar', 'Filled honey jar', 'count'),
		  ('catalog_product', 'Finished catalog product', 'count'),
		  ('propolis_raw', 'Raw propolis', 'mass'),
		  ('equipment', 'Beekeeping equipment', 'count'),
		  ('packaging', 'Packaging material', 'count')
		ON CONFLICT (kind) DO NOTHING;
		INSERT INTO inventory_location_kinds (kind, description) VALUES
		  ('site', 'Physical site'),
		  ('storage_area', 'Storage area'),
		  ('apiary', 'Apiary'),
		  ('consignee', 'Consignment location'),
		  ('in_transit', 'Goods in transit'),
		  ('deployed', 'Virtual location for hive-deployed stock')
		ON CONFLICT (kind) DO NOTHING;
		INSERT INTO inventory_operation_kinds (kind, description, sided) VALUES
		  ('receive', 'Receipt into inventory', 'one'),
		  ('opening_balance', 'Imported opening balance', 'one'),
		  ('transfer', 'Location-to-location transfer', 'paired'),
		  ('deploy', 'Deploy stock to a hive', 'paired'),
		  ('return', 'Return stock from a hive', 'paired'),
		  ('transform', 'Consume inputs and produce outputs', 'transform'),
		  ('sale_consume', 'Physical sale consumption', 'one'),
		  ('sale_return', 'Physical sale return', 'one'),
		  ('shrink', 'Loss or other shrink', 'one'),
		  ('count_adjust', 'Physical count adjustment', 'one'),
		  ('condition_change', 'Move stock between conditions', 'paired'),
		  ('reversal', 'Exact negation of an operation', 'paired')
		ON CONFLICT (kind) DO NOTHING;
		INSERT INTO inventory_conditions (condition, description, sellable) VALUES
		  ('serviceable', 'Available for service or sale', true),
		  ('damaged', 'Damaged and unavailable for ordinary use', false),
		  ('retired', 'Retired from service', false)
		ON CONFLICT (condition) DO NOTHING;
		INSERT INTO inventory_operation_reasons (reason, description, applies_to_kinds) VALUES
		  ('none', 'No additional reason applies', ARRAY['receive','opening_balance','transfer','deploy','return','transform','sale_consume','sale_return','reversal']),
		  ('give_away', 'Given away', ARRAY['shrink']),
		  ('loss', 'Lost or destroyed', ARRAY['shrink']),
		  ('feeding', 'Consumed as bee feed', ARRAY['shrink','transform']),
		  ('settlement_shrink', 'Consignee-reported shrink', ARRAY['shrink']),
		  ('count', 'Physical count correction', ARRAY['count_adjust']),
		  ('packaging_consumed_untraced', 'Packaging consumption without a traced BOM line', ARRAY['shrink','transform']),
		  ('damage', 'Changed to damaged condition', ARRAY['condition_change']),
		  ('retire', 'Changed to retired condition', ARRAY['condition_change']),
		  ('repair', 'Returned to serviceable condition', ARRAY['condition_change'])
		ON CONFLICT (reason) DO NOTHING;
		INSERT INTO inventory_items
		  (id, kind, name, canonical_unit, quantity_scale, lot_tracked, condition_tracked, container_tracked)
		VALUES
		  ('00000000-0000-0000-0000-000000000101', 'honey_bulk', 'Bulk honey', 'lb', 4, true, false, false),
		  ('00000000-0000-0000-0000-000000000102', 'propolis_raw', 'Raw propolis', 'g', 4, true, false, false)
		ON CONFLICT (id) DO NOTHING;
		INSERT INTO inventory_locations (id, kind, name, is_home) VALUES
		  ('00000000-0000-0000-0000-000000000201', 'site', 'Home', true)
		ON CONFLICT (id) DO NOTHING;
		INSERT INTO inventory_locations (id, kind, name) VALUES
		  ('00000000-0000-0000-0000-000000000202', 'deployed', 'Deployed')
		ON CONFLICT (id) DO NOTHING`)
	if err != nil {
		return fmt.Errorf("restore ledger schema seeds before backfill: %w", err)
	}
	return nil
}

func quoteIdent(value string) string { return `"` + strings.ReplaceAll(value, `"`, `""`) + `"` }

// domainOrder is a stable topological sort built from the registry and the
// exporter's reference registry. Same-domain links are handled by recordOrder;
// the no-FK media pointer is excluded from this file-level graph.
func domainOrder(artifact *snapshot.Artifact) []string {
	names := make([]string, 0, len(snapshot.Domains))
	present := map[string]bool{}
	for _, domain := range snapshot.RegisteredDomains() {
		names = append(names, domain.Name)
		present[domain.Name] = true
	}
	indegree := map[string]int{}
	edges := map[string]map[string]bool{}
	for _, check := range artifact.Verification.ReferenceChecks {
		if check.FromDomain == check.ToDomain || check.Name == "media_files_current_transcript_version" || !present[check.FromDomain] || !present[check.ToDomain] {
			continue
		}
		// An unpopulated reference cannot be violated by this artifact, so it
		// must not constrain the order. Without this, the inspections ↔
		// media_files reference pair forms a cycle even when zero media rows
		// exist, stalls every transitive dependent (feedings, and through it
		// feeding_status_backfills), and the alphabetical fallback then
		// inserts backfills before feedings — 81 FK failures on the first
		// real-data rehearsal.
		if check.PopulatedCount == 0 {
			continue
		}
		if edges[check.ToDomain] == nil {
			edges[check.ToDomain] = map[string]bool{}
		}
		if !edges[check.ToDomain][check.FromDomain] {
			edges[check.ToDomain][check.FromDomain] = true
			indegree[check.FromDomain]++
		}
	}
	priority := documentedPriority()
	less := func(a, b string) bool {
		if priority[a] != priority[b] {
			return priority[a] < priority[b]
		}
		return a < b
	}
	ready := []string{}
	for _, name := range names {
		if indegree[name] == 0 {
			ready = append(ready, name)
		}
	}
	result := make([]string, 0, len(names))
	for len(ready) > 0 {
		sort.Slice(ready, func(i, j int) bool { return less(ready[i], ready[j]) })
		name := ready[0]
		ready = ready[1:]
		result = append(result, name)
		for child := range edges[name] {
			indegree[child]--
			if indegree[child] == 0 {
				ready = append(ready, child)
			}
		}
	}
	// Any true graph cycle is handled deterministically and will produce a
	// precise per-record FK/guard error rather than silently changing data.
	if len(result) != len(names) {
		used := map[string]bool{}
		for _, name := range result {
			used[name] = true
		}
		remaining := []string{}
		for _, name := range names {
			if !used[name] {
				remaining = append(remaining, name)
			}
		}
		sort.Slice(remaining, func(i, j int) bool { return less(remaining[i], remaining[j]) })
		result = append(result, remaining...)
	}
	return result
}

func documentedPriority() map[string]int {
	groups := [][]string{
		{"app_users", "apiaries", "jar_sizes", "product_catalog", "equipment_types", "equipment_type_components", "treatment_products", "honey_varietals", "customers", "wholesale_price_lists"},
		{"user_preferences", "hives", "queens", "stock_locations", "photos", "media_files"},
		{"sales", "consignment_settlements", "bottling_runs", "transcript_versions"},
		{"equipment_stock", "equipment_stock_adjustments", "equipment_state_changes"},
		{"honey_movements", "stock_movements", "jar_serials", "harvest_lot_photos"},
		{"external_sync", "gnucash_sync_settings"},
	}
	out := map[string]int{}
	for i, group := range groups {
		for _, name := range group {
			out[name] = i + 1
		}
	}
	return out
}

func recordOrder(domain string, records []snapshot.RecordEnvelope, checks []snapshot.ReferenceCheck) []snapshot.RecordEnvelope {
	if len(records) < 2 {
		return records
	}
	var self []snapshot.ReferenceCheck
	for _, check := range checks {
		if check.FromDomain == domain && check.ToDomain == domain {
			self = append(self, check)
		}
	}
	if len(self) == 0 {
		return records
	}
	byID := map[string]snapshot.RecordEnvelope{}
	for _, record := range records {
		id, _ := snapshot.CanonicalJSON(record.ID)
		byID[string(id)] = record
	}
	deps := map[string]map[string]bool{}
	for key, record := range byID {
		var data map[string]json.RawMessage
		_ = json.Unmarshal(record.Data, &data)
		for _, check := range self {
			if len(check.FromFields) != 1 || len(check.ToFields) != 1 {
				continue
			}
			value := data[check.FromFields[0]]
			if len(value) == 0 || bytes.Equal(bytes.TrimSpace(value), []byte("null")) {
				continue
			}
			canonical, err := snapshot.CanonicalJSON(value)
			if err == nil && byID[string(canonical)].Domain != "" {
				if deps[key] == nil {
					deps[key] = map[string]bool{}
				}
				deps[key][string(canonical)] = true
			}
		}
	}
	result := make([]snapshot.RecordEnvelope, 0, len(records))
	done := map[string]bool{}
	for len(result) < len(records) {
		ready := []string{}
		for key := range byID {
			if done[key] {
				continue
			}
			ok := true
			for dep := range deps[key] {
				if !done[dep] {
					ok = false
					break
				}
			}
			if ok {
				ready = append(ready, key)
			}
		}
		if len(ready) == 0 {
			for key := range byID {
				if !done[key] {
					ready = append(ready, key)
				}
			}
		}
		sort.Strings(ready)
		for _, key := range ready {
			done[key] = true
			result = append(result, byID[key])
		}
	}
	return result
}
