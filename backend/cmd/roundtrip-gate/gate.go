package main

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"time"

	"github.com/biker2000on/beez-trackz/backend/internal/db"
	"github.com/biker2000on/beez-trackz/backend/internal/snapshot"
)

// options are the driver's inputs. AdminURL is only ever used to create and
// drop the disposable database; SourceURL is only ever read.
type options struct {
	AdminURL     string
	SourceURL    string
	Workdir      string
	GateDatabase string
	RepoRoot     string
	Keep         bool
	SkipMedia    bool
	// LegacySource accepts a source database of the previous schema
	// generation, read only. The disposable target is unaffected.
	LegacySource bool
	// ImporterBinary short-circuits building the CLI. Tests that already
	// built it set this; operators do not.
	ImporterBinary string
	Logf           func(format string, args ...any)
}

// emptyProbes are tables no goose seed writes. "Empty" after migration means
// these are zero — stock_locations and treatment_products legitimately carry
// seed rows at that point (design section 5.6).
var emptyProbes = []string{"apiaries", "hives", "sales", "photos"}

type gate struct {
	options  options
	report   *gateReport
	findings []finding
	step     *stepResult
}

func (g *gate) logf(format string, args ...any) {
	if g.options.Logf != nil {
		g.options.Logf(format, args...)
	}
}

// begin opens a runbook step; end closes it and reports whether it passed.
func (g *gate) begin(number int, name string) {
	g.step = &stepResult{Number: number, Name: name, Started: time.Now().UTC(), Passed: true}
	g.logf("step %d: %s", number, name)
}

func (g *gate) note(format string, args ...any) {
	g.step.Notes = append(g.step.Notes, fmt.Sprintf(format, args...))
}

// record files findings against the current step and returns true when the
// step is still passing. The runbook aborts on the first failing step.
func (g *gate) record(items ...finding) bool {
	for _, item := range items {
		if item.Step == "" {
			item.Step = g.step.Name
		}
		g.findings = append(g.findings, item)
		if !item.Explained {
			g.step.Passed = false
		}
	}
	return g.step.Passed
}

func (g *gate) end() bool {
	g.step.Finished = time.Now().UTC()
	g.report.Steps = append(g.report.Steps, *g.step)
	passed := g.step.Passed
	g.step = nil
	return passed
}

// run executes the ordered runbook of design section 2 and returns the gate
// report. An error is a driver malfunction (could not connect, could not
// write the report); a report with Passed=false is a gate failure, which is
// the normal way a bad artifact is reported.
func run(ctx context.Context, opts options) (*gateReport, error) {
	if opts.GateDatabase == "" {
		opts.GateDatabase = gateDatabaseName
	}
	started := time.Now().UTC()
	sourceArtifact := filepath.Join(opts.Workdir, "artifact")
	restoredArtifact := filepath.Join(opts.Workdir, "artifact.restored")
	aggregateFamily := "legacy"
	if db.ActiveProfile() == db.ProfileBaseline {
		aggregateFamily = "newLedger"
	}
	g := &gate{options: opts, report: &gateReport{
		Version:         1,
		StartedAt:       started,
		AggregateFamily: aggregateFamily,
		SourceDatabase:  redactURL(opts.SourceURL),
		GateDatabase:    opts.GateDatabase,
		Workdir:         opts.Workdir,
		SourceArtifact:  sourceArtifact,
		RestoredArtifac: restoredArtifact,
		SkipMedia:       opts.SkipMedia,
		KeptDatabase:    opts.Keep,
		Fingerprints:    map[string]any{},
		RestoreReports:  map[string]any{},
	}}

	defer func() {
		g.report.FinishedAt = time.Now().UTC()
		g.report.Failures = failures(g.findings)
		g.report.Explained = explanations(g.findings)
		g.report.Passed = len(g.report.Failures) == 0
	}()

	// --- step 0: preconditions -------------------------------------------
	g.begin(0, "preconditions")
	if err := os.MkdirAll(opts.Workdir, 0o700); err != nil {
		g.record(fail("step0", "workdir-unusable", "%v", err))
		g.end()
		return g.report, nil
	}
	if databaseNameOf(opts.SourceURL) == opts.GateDatabase {
		g.record(fail("step0", "source-is-target",
			"the source URL names %s, which is the disposable gate database", opts.GateDatabase))
	}
	g.note("source database %s (read only)", redactURL(opts.SourceURL))
	if opts.LegacySource {
		g.note("source accepted as a %s-generation database on a read-only connection (-legacy-source)",
			db.LegacyGeneration)
	}
	g.note("admin database %s (CREATE/DROP only)", redactURL(opts.AdminURL))
	if !g.end() {
		return g.report, nil
	}

	sourcePool, err := openSourcePool(ctx, opts.SourceURL, opts.LegacySource)
	if err != nil {
		return nil, fmt.Errorf("connect source database: %w", err)
	}
	defer sourcePool.Close()

	// --- step 1: fresh snapshot ------------------------------------------
	g.begin(1, "export the source database")
	sourceBefore, err := fingerprintDatabase(ctx, sourcePool)
	if err != nil {
		return nil, fmt.Errorf("fingerprint source: %w", err)
	}
	g.report.Fingerprints["source.before"] = sourceBefore
	exportResult, err := snapshot.Export(ctx, sourcePool, snapshot.ExportOptions{
		OutputDirectory:  sourceArtifact,
		ExporterVersion:  snapshot.ExporterVersion,
		BusinessTimezone: "UTC",
		Currency:         "USD",
	})
	if err != nil {
		g.record(fail("step1", "export-failed", "%v", err))
		g.end()
		return g.report, nil
	}
	g.report.RecordCounts = exportResult.Verification.RecordCounts
	g.note("exported %d domain files at schema migration %d",
		len(exportResult.Manifest.Files), exportResult.Manifest.SchemaMigration)
	if !g.end() {
		return g.report, nil
	}

	// --- step 2: independent checksum pass -------------------------------
	g.begin(2, "checksum the artifact independently of the exporter")
	source, checksumFindings := loadArtifact(sourceArtifact)
	g.record(checksumFindings...)
	if source == nil {
		g.end()
		return g.report, nil
	}
	g.report.WrapChecksum = source.WrapChecksum
	checksumPath := filepath.Join(opts.Workdir, "artifact.sha256")
	if err := os.WriteFile(checksumPath,
		[]byte(source.WrapChecksum+"  artifact\n"), 0o600); err != nil {
		return nil, fmt.Errorf("write wrapping checksum: %w", err)
	}
	g.note("wrapping checksum %s written to %s (outside the artifact)", source.WrapChecksum, checksumPath)
	if !g.end() {
		return g.report, nil
	}

	// --- disposable target ------------------------------------------------
	g.begin(3, "create and migrate the disposable database")
	gateURL, dropDatabase, err := freshDatabase(ctx, opts.AdminURL, opts.GateDatabase)
	if err != nil {
		return nil, err
	}
	if !opts.Keep {
		defer dropDatabase()
	} else {
		defer func() { g.logf("keeping %s as asked; drop it yourself", opts.GateDatabase) }()
	}
	g.report.GateDatabaseURL = redactURL(gateURL)
	migrated, err := db.Connect(ctx, gateURL)
	if err != nil {
		return nil, fmt.Errorf("migrate the disposable database: %w", err)
	}
	migrated.Close()
	targetPool, err := openUTCPool(ctx, gateURL)
	if err != nil {
		return nil, fmt.Errorf("connect the disposable database: %w", err)
	}
	defer targetPool.Close()
	for _, table := range emptyProbes {
		if db.BaselineDrops(table) && db.ActiveProfile() == db.ProfileBaseline {
			continue
		}
		count, err := countRows(ctx, targetPool, table)
		if err != nil {
			return nil, fmt.Errorf("probe %s: %w", table, err)
		}
		if count != 0 {
			g.record(fail("step3", "target-not-empty",
				"%s already holds %d rows in the disposable database", table, count))
		}
	}
	if !g.end() {
		return g.report, nil
	}

	// --- the importer, strictly through its CLI ---------------------------
	g.begin(4, "build the import-snapshot CLI")
	importerCLI := &importer{binary: opts.ImporterBinary}
	if importerCLI.binary == "" {
		importerCLI, err = buildImporter(ctx, opts.RepoRoot, opts.Workdir)
		if err != nil {
			g.record(fail("step4", "importer-unavailable", "%v", err))
			g.end()
			return g.report, nil
		}
	}
	g.note("importer binary %s", importerCLI.binary)
	if !g.end() {
		return g.report, nil
	}

	// --- step 5: dry run, which must not write ----------------------------
	g.begin(5, "importer dry run (must make no writes)")
	targetBefore, err := fingerprintDatabase(ctx, targetPool)
	if err != nil {
		return nil, fmt.Errorf("fingerprint target: %w", err)
	}
	g.report.Fingerprints["target.beforeDryRun"] = targetBefore
	dryRun, err := importerCLI.run(ctx, sourceArtifact, gateURL,
		filepath.Join(opts.Workdir, "restore-report.dry-run.json"), "-dry-run")
	if err != nil {
		return nil, err
	}
	g.report.RestoreReports["dryRun"] = dryRun
	if dryRun.ExitCode != 0 {
		g.record(fail("step5", "dry-run-failed",
			"import-snapshot -dry-run exited %d: %s", dryRun.ExitCode, firstLine(dryRun.Stderr, dryRun.Stdout)))
	}
	targetAfter, err := fingerprintDatabase(ctx, targetPool)
	if err != nil {
		return nil, fmt.Errorf("fingerprint target: %w", err)
	}
	g.report.Fingerprints["target.afterDryRun"] = targetAfter
	for _, difference := range diffFingerprints(targetBefore, targetAfter) {
		g.record(fail("step5", "dry-run-wrote", "disposable database changed: %s", difference))
	}
	sourceAfterDryRun, err := fingerprintDatabase(ctx, sourcePool)
	if err != nil {
		return nil, fmt.Errorf("fingerprint source: %w", err)
	}
	g.report.Fingerprints["source.afterDryRun"] = sourceAfterDryRun
	for _, difference := range diffFingerprints(sourceBefore, sourceAfterDryRun) {
		g.record(fail("step5", "dry-run-wrote", "source database changed: %s", difference))
	}
	if dryRun.Counters.Found && dryRun.Counters.Failed > 0 {
		g.record(fail("step5", "dry-run-failed",
			"the dry-run report counts %d failed records", dryRun.Counters.Failed))
	}
	g.note("content fingerprints identical before and after the dry run on both databases")
	if !g.end() {
		return g.report, nil
	}

	// --- step 6: restore --------------------------------------------------
	g.begin(6, "restore into the disposable database")
	restore, err := importerCLI.run(ctx, sourceArtifact, gateURL,
		filepath.Join(opts.Workdir, "restore-report.json"))
	if err != nil {
		return nil, err
	}
	g.report.RestoreReports["restore"] = restore
	g.report.ImporterCommand = importerCLI.command
	if restore.ExitCode != 0 {
		g.record(fail("step6", "restore-failed",
			"import-snapshot exited %d: %s", restore.ExitCode, firstLine(restore.Stderr, restore.Stdout)))
	}
	if !restore.Counters.Found {
		g.record(fail("step6", "restore-report-unreadable",
			"the restore report does not carry created/unchanged/updated/skipped/conflicted/failed totals"))
	} else {
		if restore.Counters.Failed != 0 || restore.Counters.Conflicted != 0 {
			g.record(fail("step6", "restore-failed",
				"restore report: %d failed, %d conflicted", restore.Counters.Failed, restore.Counters.Conflicted))
		}
		g.note("restore report: %d created, %d unchanged, %d updated, %d skipped",
			restore.Counters.Created, restore.Counters.Unchanged,
			restore.Counters.Updated, restore.Counters.Skipped)
	}
	afterRestore, err := fingerprintDatabase(ctx, targetPool)
	if err != nil {
		return nil, fmt.Errorf("fingerprint target: %w", err)
	}
	g.report.Fingerprints["target.afterRestore"] = afterRestore
	if !g.end() {
		return g.report, nil
	}

	// --- step 7: identical second import ----------------------------------
	g.begin(7, "second identical import is a no-op")
	second, err := importerCLI.run(ctx, sourceArtifact, gateURL,
		filepath.Join(opts.Workdir, "restore-report.second.json"))
	if err != nil {
		return nil, err
	}
	if second.ExitCode != 0 {
		// The CLI contract says a non-empty database is refused unless a
		// conflict policy other than fail is given. An importer that reads
		// "identical records" as "already populated" is within the contract,
		// so the gate retries once under skip and records that it had to.
		g.record(explained("step7", "idempotency-policy-fallback",
			"the second import refused the populated database under the default policy "+
				"(exit %d); retrying with -conflict-policy skip", second.ExitCode))
		second, err = importerCLI.run(ctx, sourceArtifact, gateURL,
			filepath.Join(opts.Workdir, "restore-report.second.json"), "-conflict-policy", "skip")
		if err != nil {
			return nil, err
		}
	}
	g.report.RestoreReports["secondImport"] = second
	if second.ExitCode != 0 {
		g.record(fail("step7", "idempotency-failed",
			"the second identical import exited %d: %s",
			second.ExitCode, firstLine(second.Stderr, second.Stdout)))
	}
	if second.Counters.Found {
		if second.Counters.Created != 0 {
			g.record(fail("step7", "idempotency-failed",
				"the second identical import created %d records", second.Counters.Created))
		}
		if second.Counters.Failed != 0 || second.Counters.Conflicted != 0 {
			g.record(fail("step7", "idempotency-failed",
				"the second identical import reports %d failed and %d conflicted records",
				second.Counters.Failed, second.Counters.Conflicted))
		}
	}
	// The report-independent half of the proof: the database itself did not
	// move. This holds whether the importer calls the outcome "unchanged" or
	// "skipped", which the CLI contract does not settle.
	afterSecond, err := fingerprintDatabase(ctx, targetPool)
	if err != nil {
		return nil, fmt.Errorf("fingerprint target: %w", err)
	}
	g.report.Fingerprints["target.afterSecondImport"] = afterSecond
	for _, difference := range diffFingerprints(afterRestore, afterSecond) {
		g.record(fail("step7", "idempotency-failed",
			"the second identical import changed the database: %s", difference))
	}
	if !g.end() {
		return g.report, nil
	}

	// --- step 8: re-export ------------------------------------------------
	g.begin(8, "re-export the disposable database")
	if _, err := snapshot.Export(ctx, targetPool, snapshot.ExportOptions{
		OutputDirectory:  restoredArtifact,
		ExporterVersion:  snapshot.ExporterVersion,
		BusinessTimezone: "UTC",
		Currency:         "USD",
	}); err != nil {
		g.record(fail("step8", "re-export-failed", "%v", err))
		g.end()
		return g.report, nil
	}
	restoredLoaded, restoredFindings := loadArtifact(restoredArtifact)
	g.record(restoredFindings...)
	if restoredLoaded == nil {
		g.end()
		return g.report, nil
	}
	if !g.end() {
		return g.report, nil
	}

	// --- step 9: compare --------------------------------------------------
	g.begin(9, "compare the source artifact with the re-export")
	g.record(compareArtifacts(source, restoredLoaded, compareOptions{SkipMedia: opts.SkipMedia})...)
	g.note("compared %d domains against the %s aggregate family", len(source.Records), aggregateFamily)
	g.end()

	return g.report, nil
}

// writeReports persists the machine-readable report and the human summary
// into the work directory, which lives outside both databases and outside
// the artifact.
func writeReports(report *gateReport, workdir string) error {
	encoded, err := json.MarshalIndent(report, "", "  ")
	if err != nil {
		return err
	}
	if err := os.WriteFile(filepath.Join(workdir, "gate-report.json"),
		append(encoded, '\n'), 0o600); err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(workdir, "gate-summary.txt"),
		[]byte(report.summary()), 0o600)
}

func firstLine(candidates ...string) string {
	for _, candidate := range candidates {
		for _, line := range splitLines(candidate) {
			if line != "" {
				return line
			}
		}
	}
	return "(no output)"
}

func splitLines(text string) []string {
	var out []string
	current := ""
	for _, character := range text {
		if character == '\n' || character == '\r' {
			out = append(out, current)
			current = ""
			continue
		}
		current += string(character)
	}
	return append(out, current)
}
