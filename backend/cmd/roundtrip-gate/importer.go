package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
)

// importerPackage is the Go package that provides the importer CLI. The gate
// talks to the importer STRICTLY through that CLI contract:
//
//	import-snapshot -input <snapshot-dir> -database <postgres-url>
//	                [-dry-run] [-conflict-policy fail|skip|overwrite]
//	                [-report <path>]
//
// Exit 0 means full success (a dry run whose validation passed counts);
// anything else is a validation, reference, digest, or restore failure. The
// gate deliberately does not import the importer's internals: the process
// boundary is what keeps this driver an honest second implementation rather
// than a re-run of the same code with the same blind spots.
const importerPackage = "./cmd/import-snapshot"

type importer struct {
	binary  string
	command []string
}

// findRepoRoot walks up from a starting directory for the backend go.mod, so
// the driver can build the sibling CLI from the same tree it was built from.
func findRepoRoot(start string) (string, error) {
	directory, err := filepath.Abs(start)
	if err != nil {
		return "", err
	}
	for {
		if content, err := os.ReadFile(filepath.Join(directory, "go.mod")); err == nil {
			if bytes.Contains(content, []byte("module github.com/biker2000on/beez-trackz/backend")) {
				return directory, nil
			}
		}
		parent := filepath.Dir(directory)
		if parent == directory {
			return "", fmt.Errorf("no backend go.mod found at or above %s", start)
		}
		directory = parent
	}
}

// errImporterMissing is returned when the importer package does not exist in
// this tree. It is a distinct error so the integration test can skip with a
// clear reason instead of reporting a gate failure for work that is not in
// this worktree yet.
var errImporterMissing = errors.New("the import-snapshot CLI is not present in this tree")

// buildImporter compiles the importer CLI into the work directory. Building
// from source at run time keeps the driver and the importer pinned to the
// same commit, which is the only way "the same binaries" in the design's
// adversarial step means anything.
func buildImporter(ctx context.Context, repoRoot, outputDirectory string) (*importer, error) {
	packageDirectory := filepath.Join(repoRoot, filepath.FromSlash(strings.TrimPrefix(importerPackage, "./")))
	if info, err := os.Stat(packageDirectory); err != nil || !info.IsDir() {
		return nil, fmt.Errorf("%w (looked for %s)", errImporterMissing, packageDirectory)
	}
	binary := filepath.Join(outputDirectory, "import-snapshot")
	if runtime.GOOS == "windows" {
		binary += ".exe"
	}
	command := exec.CommandContext(ctx, "go", "build", "-o", binary, importerPackage)
	command.Dir = repoRoot
	command.Env = append(os.Environ(), "TZ=UTC")
	output, err := command.CombinedOutput()
	if err != nil {
		return nil, fmt.Errorf("build %s: %v: %s", importerPackage, err, strings.TrimSpace(string(output)))
	}
	return &importer{binary: binary}, nil
}

// importRun is one invocation of the CLI and everything the gate learned
// from it.
type importRun struct {
	Args     []string       `json:"args"`
	ExitCode int            `json:"exitCode"`
	Stdout   string         `json:"stdout,omitempty"`
	Stderr   string         `json:"stderr,omitempty"`
	Report   map[string]any `json:"report,omitempty"`
	Counters importCounters `json:"counters"`
}

// importCounters are the per-record outcome totals the restore report is
// required to carry.
type importCounters struct {
	Found      bool  `json:"found"`
	Created    int64 `json:"created"`
	Unchanged  int64 `json:"unchanged"`
	Updated    int64 `json:"updated"`
	Skipped    int64 `json:"skipped"`
	Conflicted int64 `json:"conflicted"`
	Failed     int64 `json:"failed"`
}

// run executes the importer and reads back the JSON restore report.
//
// The report path is always supplied and always lives outside the snapshot
// directory: writing a report inside the artifact would change the bytes the
// wrapping checksum covers, so the default of <input>/restore-report.json is
// forbidden by the run contract.
func (item *importer) run(ctx context.Context, snapshotDirectory, databaseURL, reportPath string, extra ...string) (*importRun, error) {
	if inside, err := isInside(snapshotDirectory, reportPath); err != nil || inside {
		return nil, fmt.Errorf("refusing to write the restore report inside the snapshot artifact (%s)", reportPath)
	}
	args := append([]string{
		"-input", snapshotDirectory,
		"-database", databaseURL,
		"-report", reportPath,
	}, extra...)
	command := exec.CommandContext(ctx, item.binary, args...)
	command.Env = append(os.Environ(), "TZ=UTC")
	var stdout, stderr bytes.Buffer
	command.Stdout = &stdout
	command.Stderr = &stderr
	err := command.Run()
	run := &importRun{Args: args, Stdout: tail(stdout.String()), Stderr: tail(stderr.String())}
	var exitError *exec.ExitError
	switch {
	case err == nil:
		run.ExitCode = 0
	case errors.As(err, &exitError):
		run.ExitCode = exitError.ExitCode()
	default:
		return run, fmt.Errorf("run import-snapshot: %w", err)
	}
	item.command = append([]string{item.binary}, args...)
	if content, readErr := os.ReadFile(reportPath); readErr == nil {
		report := map[string]any{}
		if json.Unmarshal(content, &report) == nil {
			run.Report = report
			run.Counters = extractCounters(report)
		}
	}
	return run, nil
}

// isInside reports whether path lives under root.
func isInside(root, path string) (bool, error) {
	absoluteRoot, err := filepath.Abs(root)
	if err != nil {
		return false, err
	}
	absolutePath, err := filepath.Abs(path)
	if err != nil {
		return false, err
	}
	relative, err := filepath.Rel(absoluteRoot, absolutePath)
	if err != nil {
		return false, err
	}
	return relative != ".." && !strings.HasPrefix(relative, ".."+string(filepath.Separator)), nil
}

// extractCounters finds the outcome totals in a restore report without
// pinning this driver to one nesting. The CLI contract fixes the counter
// names — created, unchanged, updated, skipped, conflicted, failed — but not
// whether they sit at the top level or under a totals/summary object, and the
// gate is not entitled to invent that half of the contract. It takes the
// shallowest object that carries both "created" and "unchanged" as numbers,
// which is the totals object in every reasonable layout and never a per-domain
// breakdown nested beneath one.
func extractCounters(report map[string]any) importCounters {
	type candidate struct {
		depth  int
		object map[string]any
	}
	var best *candidate
	var walk func(value any, depth int)
	walk = func(value any, depth int) {
		object, ok := value.(map[string]any)
		if !ok {
			list, isList := value.([]any)
			if !isList {
				return
			}
			for _, item := range list {
				walk(item, depth+1)
			}
			return
		}
		_, hasCreated := numberField(object, "created")
		_, hasUnchanged := numberField(object, "unchanged")
		if hasCreated && hasUnchanged && (best == nil || depth < best.depth) {
			best = &candidate{depth: depth, object: object}
		}
		for _, item := range object {
			walk(item, depth+1)
		}
	}
	walk(report, 0)
	if best == nil {
		return importCounters{}
	}
	out := importCounters{Found: true}
	out.Created, _ = numberField(best.object, "created")
	out.Unchanged, _ = numberField(best.object, "unchanged")
	out.Updated, _ = numberField(best.object, "updated")
	out.Skipped, _ = numberField(best.object, "skipped")
	out.Conflicted, _ = numberField(best.object, "conflicted")
	out.Failed, _ = numberField(best.object, "failed")
	return out
}

func numberField(object map[string]any, name string) (int64, bool) {
	value, present := object[name]
	if !present {
		return 0, false
	}
	switch typed := value.(type) {
	case float64:
		return int64(typed), true
	case json.Number:
		parsed, err := typed.Int64()
		return parsed, err == nil
	}
	return 0, false
}

// tail keeps a bounded amount of child output in the report.
func tail(text string) string {
	text = strings.TrimSpace(text)
	const limit = 4000
	if len(text) <= limit {
		return text
	}
	return "..." + text[len(text)-limit:]
}
