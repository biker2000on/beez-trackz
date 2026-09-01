package app

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"sort"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// Outcome is what happened to one restored record. The set is exactly what
// the restore report has to distinguish (P0: "a final restore report listing
// created, unchanged, skipped, conflicted, and failed records").
type Outcome string

const (
	// OutcomeCreated: the preserved ID was absent and the record was written.
	// In a dry run it means "would be created".
	OutcomeCreated Outcome = "created"
	// OutcomeUnchanged: the preserved ID was present with identical semantic
	// content. This is what makes a second import of the same artifact safe.
	OutcomeUnchanged Outcome = "unchanged"
	// OutcomeUpdated: the preserved ID was present with different content and
	// the explicit ConflictOverwrite policy replaced it.
	OutcomeUpdated Outcome = "updated"
	// OutcomeSkipped: a conflict left alone under ConflictSkip.
	OutcomeSkipped Outcome = "skipped"
	// OutcomeConflicted: the preserved ID exists with different content and no
	// policy authorised a change. Always accompanied by a KindConflict error.
	OutcomeConflicted Outcome = "conflicted"
	// OutcomeFailed: validation, reference resolution, or the write itself
	// failed. Always accompanied by an error.
	OutcomeFailed Outcome = "failed"
)

// ConflictPolicy is the explicit resolution the restore contract requires for
// a preserved ID that already exists with different content. There is no
// implicit default beyond "fail": silently taking either side is how a
// restore quietly loses data.
type ConflictPolicy string

const (
	// ConflictFail reports the conflict and stops that record. Zero value.
	ConflictFail ConflictPolicy = ""
	// ConflictSkip keeps what is in the database and records the skip.
	ConflictSkip ConflictPolicy = "skip"
	// ConflictOverwrite replaces the stored record with the artifact's.
	// Preserved updated_at is NOT restored on this path: the set_updated_at
	// trigger stamps now() on every UPDATE, so an overwrite is a repair, not
	// a faithful reproduction. Prefer restoring into an empty database.
	ConflictOverwrite ConflictPolicy = "overwrite"
)

// RestoreOptions are the per-run knobs shared by every restore repository.
type RestoreOptions struct {
	OnConflict ConflictPolicy
}

// Audit carries the fields the ordinary API refuses to accept from a client.
// Only the system restore actor may supply them; see Actor.
type Audit struct {
	// CreatedAt is required: a restored row with a fabricated creation time
	// breaks every "since" query and the round-trip digest.
	CreatedAt time.Time
	// UpdatedAt is preserved on insert. Tables with a set_updated_at trigger
	// fire it on UPDATE only, so this survives a create and not an overwrite.
	UpdatedAt time.Time
	// CreatedBy, DeletedAt, DeletedBy, and VoidedAt are set only for the
	// tables that have them. A nil pointer means the column stays NULL.
	CreatedBy *uuid.UUID
	DeletedAt *time.Time
	DeletedBy *uuid.UUID
	VoidedAt  *time.Time
}

// validate enforces the audit rules every restore repository shares.
func (a Audit) validate(op string) error {
	if a.CreatedAt.IsZero() {
		return Invalid(op, "created_at is required for a restored record").WithField("createdAt")
	}
	if a.DeletedAt != nil && a.DeletedAt.Before(a.CreatedAt) {
		return Invalid(op, "deleted_at precedes created_at").WithField("deletedAt")
	}
	if a.VoidedAt != nil && a.VoidedAt.Before(a.CreatedAt) {
		return Invalid(op, "voided_at precedes created_at").WithField("voidedAt")
	}
	return nil
}

// updatedAtOr falls back to created_at, so a record whose artifact omits
// updated_at does not land in year 1.
func (a Audit) updatedAtOr() time.Time {
	if a.UpdatedAt.IsZero() {
		return a.CreatedAt
	}
	return a.UpdatedAt
}

// Record is what every restorable domain record provides: a preserved stable
// ID and the domain name used in errors and in the report.
type Record interface {
	RecordID() uuid.UUID
	Domain() string
}

// Repository is the shape every restore repository implements. The generic
// Restore driver below owns the ordering — privilege, validation, reference
// resolution, existence, comparison, policy — so a new domain in Wave 2 is
// six small methods and no new control flow.
type Repository[T Record] interface {
	// Validate checks the record against the domain rules without touching
	// the database. It must reject anything a CHECK constraint would, with a
	// message naming the field, because SQLSTATE 23514 is not an actionable
	// error for an operator holding a 40 MB artifact.
	Validate(rec T) error
	// Resolve verifies that every reference this record makes resolves, and
	// fails with KindNotFound naming BOTH ends of the relationship.
	Resolve(ctx context.Context, uow *UnitOfWork, rec T) error
	// Load reads the stored record for a preserved ID.
	Load(ctx context.Context, uow *UnitOfWork, id uuid.UUID) (T, bool, error)
	// Equal compares two records by their normalized semantic fields only —
	// never by raw jsonb bytes and never by updated_at, both of which differ
	// for reasons that are not data differences.
	Equal(stored, incoming T) bool
	// Insert writes the record with its preserved ID and audit fields.
	Insert(ctx context.Context, uow *UnitOfWork, rec T) error
	// Overwrite replaces a stored record under ConflictOverwrite.
	Overwrite(ctx context.Context, uow *UnitOfWork, rec T) error
}

// Restore applies one record through repo. It is the only place the restore
// semantics live; repositories contribute SQL and domain rules, not policy.
//
// A dry run performs every read and every check and skips both writes, so
// "the dry run makes no writes" is a property of this function rather than of
// each repository's discipline.
func Restore[T Record](
	ctx context.Context, uow *UnitOfWork, repo Repository[T], rec T, opts RestoreOptions,
) (Outcome, error) {
	op := "restore " + rec.Domain()
	if err := uow.Actor().requirePreservedAudit(op); err != nil {
		return OutcomeFailed, err
	}
	if rec.RecordID() == uuid.Nil {
		return OutcomeFailed, Invalid(op, "preserved id is required").WithField("id")
	}
	if err := repo.Validate(rec); err != nil {
		return OutcomeFailed, err
	}
	if err := repo.Resolve(ctx, uow, rec); err != nil {
		return OutcomeFailed, err
	}

	stored, found, err := repo.Load(ctx, uow, rec.RecordID())
	if err != nil {
		return OutcomeFailed, err
	}
	if !found {
		if uow.DryRun() {
			return OutcomeCreated, nil
		}
		if err := repo.Insert(ctx, uow, rec); err != nil {
			return OutcomeFailed, err
		}
		return OutcomeCreated, nil
	}
	if repo.Equal(stored, rec) {
		return OutcomeUnchanged, nil
	}
	switch opts.OnConflict {
	case ConflictSkip:
		return OutcomeSkipped, nil
	case ConflictOverwrite:
		if uow.DryRun() {
			return OutcomeUpdated, nil
		}
		if err := repo.Overwrite(ctx, uow, rec); err != nil {
			return OutcomeFailed, err
		}
		return OutcomeUpdated, nil
	default:
		return OutcomeConflicted, Conflict(op,
			"%s %s already exists with different content; choose a conflict policy",
			rec.Domain(), rec.RecordID())
	}
}

// RecordResult is one line of the restore report.
type RecordResult struct {
	Domain  string    `json:"domain"`
	ID      uuid.UUID `json:"id"`
	Outcome Outcome   `json:"outcome"`
	Kind    Kind      `json:"kind,omitempty"`
	Error   string    `json:"error,omitempty"`
}

// Report accumulates the outcome of a restore run.
type Report struct {
	Counts  map[Outcome]int `json:"counts"`
	Records []RecordResult  `json:"records"`
	// MissingMedia and ExcludedConfig are the two non-record findings the
	// restore report has to carry: originals the artifact could not resolve,
	// and configuration (credentials, keys) that was deliberately excluded
	// and has to be entered again before the system is whole.
	MissingMedia   []string `json:"missingMedia"`
	ExcludedConfig []string `json:"excludedConfig"`
}

func NewReport() *Report {
	return &Report{
		Counts:         map[Outcome]int{},
		Records:        []RecordResult{},
		MissingMedia:   []string{},
		ExcludedConfig: []string{},
	}
}

// Add records one outcome. A non-nil error is attached to the outcome given
// rather than reclassifying it, so a conflicted record is reported as
// conflicted instead of being flattened into "failed".
func (r *Report) Add(domain string, id uuid.UUID, outcome Outcome, err error) {
	line := RecordResult{Domain: domain, ID: id, Outcome: outcome}
	if err != nil {
		line.Kind = KindOf(err)
		line.Error = err.Error()
	}
	r.Counts[outcome]++
	r.Records = append(r.Records, line)
}

// Count is the number of records with an outcome.
func (r *Report) Count(outcome Outcome) int { return r.Counts[outcome] }

// OK reports whether the run produced no conflicted and no failed records.
func (r *Report) OK() bool {
	return r.Counts[OutcomeConflicted] == 0 && r.Counts[OutcomeFailed] == 0
}

// --- shared repository helpers ---------------------------------------------

// insertPreserved runs an INSERT that carries its own id and audit fields and
// reports whether the row was actually written. Every restore repository uses
// it so that "someone inserted the same id between our Load and our Insert"
// is handled the same way everywhere: ON CONFLICT DO NOTHING plus a row-count
// check, rather than a unique violation surfacing as a raw 23505.
func insertPreserved(
	ctx context.Context, uow *UnitOfWork, op, sql string, args ...any,
) error {
	tag, err := uow.Exec(ctx, sql, args...)
	if err != nil {
		return classifyPg(op, err)
	}
	if tag.RowsAffected() == 0 {
		return Conflict(op, "the preserved id was created concurrently; re-run the restore")
	}
	return nil
}

// loadOne is the Load half: pgx.ErrNoRows is "not found", not an error.
func loadOne(op string, scan func() error) (bool, error) {
	err := scan()
	if errors.Is(err, pgx.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, classifyPg(op, err)
	}
	return true, nil
}

// equalJSON compares two jsonb payloads by value, not by bytes. Postgres does
// not preserve object key order and rewrites numeric literals, so a byte
// comparison of a round-tripped jsonb column reports differences that are not
// data differences. The canonical, versioned digest algorithm belongs to the
// snapshot format; this is only the in-process comparison the conflict check
// needs.
func equalJSON(stored, incoming []byte) bool {
	left, right := bytes.TrimSpace(stored), bytes.TrimSpace(incoming)
	if len(left) == 0 || len(right) == 0 {
		return len(left) == len(right)
	}
	leftCanonical, leftErr := canonicalJSON(left)
	rightCanonical, rightErr := canonicalJSON(right)
	if leftErr != nil || rightErr != nil {
		return bytes.Equal(left, right)
	}
	return leftCanonical == rightCanonical
}

// canonicalJSON re-serialises a JSON value with object keys sorted, which is
// what makes equalJSON order-insensitive. Numbers keep their literal text
// (json.Number), so 1.50 and 1.5 stay distinct here rather than being
// silently unified by float parsing.
func canonicalJSON(raw []byte) (string, error) {
	var value any
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	if err := decoder.Decode(&value); err != nil {
		return "", err
	}
	var buf bytes.Buffer
	if err := writeCanonical(&buf, value); err != nil {
		return "", err
	}
	return buf.String(), nil
}

func writeCanonical(buf *bytes.Buffer, value any) error {
	switch typed := value.(type) {
	case map[string]any:
		keys := make([]string, 0, len(typed))
		for key := range typed {
			keys = append(keys, key)
		}
		sort.Strings(keys)
		buf.WriteByte('{')
		for i, key := range keys {
			if i > 0 {
				buf.WriteByte(',')
			}
			encoded, err := json.Marshal(key)
			if err != nil {
				return err
			}
			buf.Write(encoded)
			buf.WriteByte(':')
			if err := writeCanonical(buf, typed[key]); err != nil {
				return err
			}
		}
		buf.WriteByte('}')
		return nil
	case []any:
		buf.WriteByte('[')
		for i, item := range typed {
			if i > 0 {
				buf.WriteByte(',')
			}
			if err := writeCanonical(buf, item); err != nil {
				return err
			}
		}
		buf.WriteByte(']')
		return nil
	default:
		encoded, err := json.Marshal(typed)
		if err != nil {
			return err
		}
		buf.Write(encoded)
		return nil
	}
}

// equalStringPtr treats NULL and "" as different, because the schema does:
// customers.email NULL is "no address", while an empty string would collide
// in the unique lower(email) index the moment a second such customer lands.
func equalStringPtr(a, b *string) bool {
	if a == nil || b == nil {
		return a == nil && b == nil
	}
	return *a == *b
}

func equalFloatPtr(a, b *float64) bool {
	if a == nil || b == nil {
		return a == nil && b == nil
	}
	return *a == *b
}

// equalTimePtr compares instants, not wall-clock representations: a restored
// timestamptz comes back in the session time zone.
func equalTimePtr(a, b *time.Time) bool {
	if a == nil || b == nil {
		return a == nil && b == nil
	}
	return a.Equal(*b)
}
