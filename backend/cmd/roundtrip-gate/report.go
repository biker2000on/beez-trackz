package main

import (
	"fmt"
	"sort"
	"strings"
	"time"
)

// A finding is one observation the gate made. Failures fail the gate;
// explained findings are recorded with their coded reason and do not.
//
// Every difference the comparator sees becomes one of these, because the
// round-trip gate design (section 3) requires each cell of the comparison
// matrix to be classified rather than silently dropped: a difference is
// either equal, explained with a code, or a failure.
type finding struct {
	Step      string `json:"step"`
	Code      string `json:"code"`
	Detail    string `json:"detail"`
	Explained bool   `json:"explained"`
}

func fail(step, code, format string, args ...any) finding {
	return finding{Step: step, Code: code, Detail: fmt.Sprintf(format, args...)}
}

func explained(step, code, format string, args ...any) finding {
	return finding{Step: step, Code: code, Detail: fmt.Sprintf(format, args...), Explained: true}
}

// failures returns only the findings that fail the gate.
func failures(items []finding) []finding {
	out := make([]finding, 0, len(items))
	for _, item := range items {
		if !item.Explained {
			out = append(out, item)
		}
	}
	return out
}

func explanations(items []finding) []finding {
	out := make([]finding, 0)
	for _, item := range items {
		if item.Explained {
			out = append(out, item)
		}
	}
	return out
}

// stepResult is one runbook step from the design's section 2.
type stepResult struct {
	Number   int       `json:"number"`
	Name     string    `json:"name"`
	Started  time.Time `json:"startedAt"`
	Finished time.Time `json:"finishedAt"`
	Passed   bool      `json:"passed"`
	Notes    []string  `json:"notes,omitempty"`
}

// tableFingerprint is the content contract from design section 4.1: a count
// plus an order-independent md5 over the md5 of every row. It is the oracle
// for "this database was not written to", because pg_stat counters increment
// for rows that later abort and therefore cannot answer the question.
type tableFingerprint struct {
	Rows        int64  `json:"rows"`
	Fingerprint string `json:"fingerprint"`
}

type fingerprintSet map[string]tableFingerprint

// diffFingerprints returns human-readable differences between two snapshots
// of the same database.
func diffFingerprints(before, after fingerprintSet) []string {
	var out []string
	for name, want := range before {
		got, present := after[name]
		if !present {
			out = append(out, fmt.Sprintf("%s: table disappeared", name))
			continue
		}
		if got != want {
			out = append(out, fmt.Sprintf("%s: %d rows/%s became %d rows/%s",
				name, want.Rows, want.Fingerprint, got.Rows, got.Fingerprint))
		}
	}
	for name := range after {
		if _, present := before[name]; !present {
			out = append(out, fmt.Sprintf("%s: table appeared", name))
		}
	}
	sort.Strings(out)
	return out
}

// gateReport is the machine-readable artifact of one gate run. It is written
// to the work directory, which the design requires to live outside both
// databases and outside the snapshot artifact.
type gateReport struct {
	Version         int              `json:"version"`
	StartedAt       time.Time        `json:"startedAt"`
	FinishedAt      time.Time        `json:"finishedAt"`
	Passed          bool             `json:"passed"`
	AggregateFamily string           `json:"aggregateFamily"`
	SourceDatabase  string           `json:"sourceDatabase"`
	GateDatabase    string           `json:"gateDatabase"`
	GateDatabaseURL string           `json:"gateDatabaseUrl"`
	Workdir         string           `json:"workdir"`
	SourceArtifact  string           `json:"sourceArtifact"`
	RestoredArtifac string           `json:"restoredArtifact"`
	WrapChecksum    string           `json:"artifactWrappingChecksum"`
	SkipMedia       bool             `json:"skipMedia"`
	KeptDatabase    bool             `json:"keptDatabase"`
	ImporterCommand []string         `json:"importerCommand,omitempty"`
	Steps           []stepResult     `json:"steps"`
	Failures        []finding        `json:"failures"`
	Explained       []finding        `json:"explained"`
	Fingerprints    map[string]any   `json:"fingerprints"`
	RestoreReports  map[string]any   `json:"restoreReports,omitempty"`
	RecordCounts    map[string]int64 `json:"sourceRecordCounts,omitempty"`
}

// summary renders the operator-facing half of the report.
func (report gateReport) summary() string {
	var out strings.Builder
	verdict := "FAILED"
	if report.Passed {
		verdict = "PASSED"
	}
	fmt.Fprintf(&out, "Beez Trackz round-trip gate: %s\n", verdict)
	fmt.Fprintf(&out, "  started      %s\n", report.StartedAt.UTC().Format(time.RFC3339))
	fmt.Fprintf(&out, "  finished     %s\n", report.FinishedAt.UTC().Format(time.RFC3339))
	fmt.Fprintf(&out, "  family       %s\n", report.AggregateFamily)
	fmt.Fprintf(&out, "  source       %s\n", report.SourceDatabase)
	fmt.Fprintf(&out, "  disposable   %s (kept=%v)\n", report.GateDatabase, report.KeptDatabase)
	fmt.Fprintf(&out, "  artifact     %s\n", report.SourceArtifact)
	fmt.Fprintf(&out, "  re-export    %s\n", report.RestoredArtifac)
	fmt.Fprintf(&out, "  wrapping sha %s\n", report.WrapChecksum)
	out.WriteString("\nSteps\n")
	for _, step := range report.Steps {
		state := "fail"
		if step.Passed {
			state = "ok"
		}
		fmt.Fprintf(&out, "  %d. %-44s %-4s %s\n", step.Number, step.Name, state,
			step.Finished.Sub(step.Started).Round(time.Millisecond))
		for _, note := range step.Notes {
			fmt.Fprintf(&out, "       - %s\n", note)
		}
	}
	if len(report.Explained) > 0 {
		fmt.Fprintf(&out, "\nExplained differences (%d)\n", len(report.Explained))
		for _, item := range report.Explained {
			fmt.Fprintf(&out, "  [%s] %s: %s\n", item.Step, item.Code, item.Detail)
		}
	}
	fmt.Fprintf(&out, "\nFailures (%d)\n", len(report.Failures))
	if len(report.Failures) == 0 {
		out.WriteString("  none\n")
	}
	for _, item := range report.Failures {
		fmt.Fprintf(&out, "  [%s] %s: %s\n", item.Step, item.Code, item.Detail)
	}
	return out.String()
}
