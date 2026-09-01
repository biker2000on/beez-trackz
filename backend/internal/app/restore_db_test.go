package app

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/biker2000on/beez-trackz/backend/internal/db"
)

// Database-backed tests for the unit of work and the two template restore
// repositories. They skip without TEST_DATABASE_URL, like the rest of the
// suite, and clean up only the rows they created: this database is shared
// with the other packages' integration tests.

var (
	testPoolOnce sync.Once
	testPool     *pgxpool.Pool
	testPoolErr  error
)

func testRunner(t *testing.T) *Runner {
	t.Helper()
	databaseURL := os.Getenv("TEST_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("TEST_DATABASE_URL is not configured")
	}
	testPoolOnce.Do(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
		defer cancel()
		testPool, testPoolErr = db.Connect(ctx, databaseURL)
	})
	if testPoolErr != nil {
		t.Fatalf("connect test database: %v", testPoolErr)
	}
	return NewRunner(testPool)
}

// dropRows removes exactly what a test created. TRUNCATE is deliberately not
// used: another package's integration tests may be running against the same
// database.
func dropRows(t *testing.T, table string, ids ...uuid.UUID) {
	t.Helper()
	t.Cleanup(func() {
		for _, id := range ids {
			if _, err := testPool.Exec(context.Background(),
				`DELETE FROM `+table+` WHERE id = $1`, id); err != nil {
				t.Errorf("clean up %s %s: %v", table, id, err)
			}
		}
	})
}

func restoreActor() Actor { return SystemRestoreActor(uuid.Nil) }

func sampleCustomer() CustomerRecord {
	email := "corner-" + uuid.NewString()[:8] + "@example.test"
	notes := "Pays on delivery"
	return CustomerRecord{
		ID:         uuid.New(),
		Name:       "Corner Market",
		Email:      &email,
		Notes:      &notes,
		EmailOptIn: true,
		Audit: Audit{
			CreatedAt: time.Date(2024, 3, 4, 15, 30, 0, 0, time.UTC),
			UpdatedAt: time.Date(2025, 7, 1, 9, 0, 0, 0, time.UTC),
		},
	}
}

func customerRow(t *testing.T, id uuid.UUID) (name string, createdAt, updatedAt time.Time, found bool) {
	t.Helper()
	err := testPool.QueryRow(context.Background(),
		`SELECT name, created_at, updated_at FROM customers WHERE id = $1`, id).
		Scan(&name, &createdAt, &updatedAt)
	if err != nil {
		return "", time.Time{}, time.Time{}, false
	}
	return name, createdAt, updatedAt, true
}

// The whole reason this package exists: the preserved id and the preserved
// created_at land in the row exactly as the artifact carried them, which no
// HTTP endpoint can do.
func TestRestoreWritesPreservedIdAndAuditFields(t *testing.T) {
	runner := testRunner(t)
	repo := NewCustomerRestoreRepository()
	record := sampleCustomer()
	dropRows(t, "customers", record.ID)

	ctx := context.Background()
	var outcome Outcome
	err := runner.Run(ctx, restoreActor(), func(ctx context.Context, uow *UnitOfWork) error {
		var err error
		outcome, err = Restore(ctx, uow, repo, record, RestoreOptions{})
		return err
	})
	if err != nil {
		t.Fatalf("restore: %v", err)
	}
	if outcome != OutcomeCreated {
		t.Fatalf("outcome %q, want %q", outcome, OutcomeCreated)
	}

	name, createdAt, updatedAt, found := customerRow(t, record.ID)
	if !found {
		t.Fatal("the restored customer was not committed")
	}
	if name != record.Name {
		t.Fatalf("name %q, want %q", name, record.Name)
	}
	if !createdAt.Equal(record.Audit.CreatedAt) {
		t.Fatalf("created_at %s, want the preserved %s", createdAt, record.Audit.CreatedAt)
	}
	// The set_updated_at trigger is BEFORE UPDATE, so an INSERT keeps the
	// artifact's updated_at. That is what makes the round-trip digest match.
	if !updatedAt.Equal(record.Audit.UpdatedAt) {
		t.Fatalf("updated_at %s, want the preserved %s", updatedAt, record.Audit.UpdatedAt)
	}
}

// Idempotent re-execution: an identical record is a no-op, a conflicting one
// is reported, and neither silently rewrites the database.
func TestRestoreIsIdempotentAndReportsConflicts(t *testing.T) {
	runner := testRunner(t)
	repo := NewCustomerRestoreRepository()
	record := sampleCustomer()
	dropRows(t, "customers", record.ID)
	ctx := context.Background()

	apply := func(rec CustomerRecord, opts RestoreOptions) (Outcome, error) {
		var outcome Outcome
		err := runner.Run(ctx, restoreActor(), func(ctx context.Context, uow *UnitOfWork) error {
			var err error
			outcome, err = Restore(ctx, uow, repo, rec, opts)
			return err
		})
		return outcome, err
	}

	if outcome, err := apply(record, RestoreOptions{}); err != nil || outcome != OutcomeCreated {
		t.Fatalf("first import: %q %v", outcome, err)
	}
	if outcome, err := apply(record, RestoreOptions{}); err != nil || outcome != OutcomeUnchanged {
		t.Fatalf("second import of the same artifact: %q %v", outcome, err)
	}

	edited := record
	edited.Name = "Corner Market LLC"
	outcome, err := apply(edited, RestoreOptions{})
	if outcome != OutcomeConflicted || !IsKind(err, KindConflict) {
		t.Fatalf("conflicting record: %q %v", outcome, err)
	}
	if name, _, _, _ := customerRow(t, record.ID); name != record.Name {
		t.Fatalf("a reported conflict changed the row to %q", name)
	}

	if outcome, err := apply(edited, RestoreOptions{OnConflict: ConflictSkip}); err != nil ||
		outcome != OutcomeSkipped {
		t.Fatalf("skip policy: %q %v", outcome, err)
	}
	if name, _, _, _ := customerRow(t, record.ID); name != record.Name {
		t.Fatalf("the skip policy changed the row to %q", name)
	}

	if outcome, err := apply(edited, RestoreOptions{OnConflict: ConflictOverwrite}); err != nil ||
		outcome != OutcomeUpdated {
		t.Fatalf("overwrite policy: %q %v", outcome, err)
	}
	name, createdAt, _, _ := customerRow(t, record.ID)
	if name != edited.Name {
		t.Fatalf("the overwrite policy left %q", name)
	}
	if !createdAt.Equal(record.Audit.CreatedAt) {
		t.Fatalf("overwrite moved created_at to %s", createdAt)
	}
}

// The dry run is the contract's no-write validation pass. Both halves are
// tested: the outcome is still reported, and nothing is written even before
// the rollback.
func TestDryRunReportsOutcomesAndWritesNothing(t *testing.T) {
	runner := testRunner(t)
	repo := NewCustomerRestoreRepository()
	record := sampleCustomer()
	dropRows(t, "customers", record.ID)
	ctx := context.Background()

	var outcome Outcome
	err := runner.DryRun(ctx, restoreActor(), func(ctx context.Context, uow *UnitOfWork) error {
		if !uow.DryRun() {
			t.Error("the unit of work does not know it is a dry run")
		}
		var err error
		outcome, err = Restore(ctx, uow, repo, record, RestoreOptions{})
		if err != nil {
			return err
		}
		// Still inside the transaction: a repository that wrote anyway would
		// be visible here, before the rollback could hide it.
		var count int
		if err := uow.QueryRow(ctx,
			`SELECT count(*) FROM customers WHERE id = $1`, record.ID).Scan(&count); err != nil {
			return err
		}
		if count != 0 {
			t.Errorf("the dry run wrote %d rows", count)
		}
		return nil
	})
	if err != nil {
		t.Fatalf("dry run: %v", err)
	}
	if outcome != OutcomeCreated {
		t.Fatalf("dry run outcome %q, want %q (would create)", outcome, OutcomeCreated)
	}
	if _, _, _, found := customerRow(t, record.ID); found {
		t.Fatal("the dry run committed a row")
	}
}

// A dry run that succeeds is still rolled back, so a caller cannot get a
// half-applied restore by forgetting which method it called.
func TestDryRunRollsBackEvenOnSuccess(t *testing.T) {
	runner := testRunner(t)
	record := sampleCustomer()
	dropRows(t, "customers", record.ID)
	ctx := context.Background()

	err := runner.DryRun(ctx, restoreActor(), func(ctx context.Context, uow *UnitOfWork) error {
		_, err := uow.Exec(ctx,
			`INSERT INTO customers (id, name, created_at) VALUES ($1, $2, $3)`,
			record.ID, record.Name, record.Audit.CreatedAt)
		return err
	})
	if err != nil {
		t.Fatalf("dry run: %v", err)
	}
	if _, _, _, found := customerRow(t, record.ID); found {
		t.Fatal("a direct write survived a dry run")
	}
}

func TestRunRollsBackOnError(t *testing.T) {
	runner := testRunner(t)
	record := sampleCustomer()
	dropRows(t, "customers", record.ID)
	ctx := context.Background()

	sentinel := errors.New("record 41 is bad")
	err := runner.Run(ctx, restoreActor(), func(ctx context.Context, uow *UnitOfWork) error {
		if _, err := uow.Exec(ctx,
			`INSERT INTO customers (id, name, created_at) VALUES ($1, $2, $3)`,
			record.ID, record.Name, record.Audit.CreatedAt); err != nil {
			return err
		}
		return sentinel
	})
	if !errors.Is(err, sentinel) {
		t.Fatalf("Run returned %v, want the caller's error unchanged", err)
	}
	if _, _, _, found := customerRow(t, record.ID); found {
		t.Fatal("the failed unit of work committed")
	}
}

// A panic in a repository must not leave the transaction open on a pooled
// connection, and must keep travelling.
func TestRunRollsBackAndRepanics(t *testing.T) {
	runner := testRunner(t)
	record := sampleCustomer()
	dropRows(t, "customers", record.ID)
	ctx := context.Background()

	func() {
		defer func() {
			if recovered := recover(); recovered == nil {
				t.Fatal("the panic was swallowed")
			}
		}()
		_ = runner.Run(ctx, restoreActor(), func(ctx context.Context, uow *UnitOfWork) error {
			if _, err := uow.Exec(ctx,
				`INSERT INTO customers (id, name, created_at) VALUES ($1, $2, $3)`,
				record.ID, record.Name, record.Audit.CreatedAt); err != nil {
				return err
			}
			panic("repository bug")
		})
	}()
	if _, _, _, found := customerRow(t, record.ID); found {
		t.Fatal("a panicking unit of work committed")
	}
	// The pool is still usable, which is the point of rolling back on panic.
	if _, _, _, found := customerRow(t, uuid.New()); found {
		t.Fatal("impossible row")
	}
}

// One bad record must not discard the records that already succeeded in the
// same run — that is what the savepoint is for.
func TestSavepointIsolatesOneFailedRecord(t *testing.T) {
	runner := testRunner(t)
	repo := NewCustomerRestoreRepository()
	good, bad := sampleCustomer(), sampleCustomer()
	bad.Name = "" // rejected by Validate, not by the constraint
	dropRows(t, "customers", good.ID, bad.ID)
	ctx := context.Background()

	report := NewReport()
	err := runner.Run(ctx, restoreActor(), func(ctx context.Context, uow *UnitOfWork) error {
		for _, record := range []CustomerRecord{good, bad} {
			var outcome Outcome
			inner := uow.Savepoint(ctx, func(ctx context.Context, uow *UnitOfWork) error {
				var err error
				outcome, err = Restore(ctx, uow, repo, record, RestoreOptions{})
				return err
			})
			if inner != nil {
				outcome = OutcomeFailed
			}
			report.Add(record.Domain(), record.ID, outcome, inner)
		}
		return nil
	})
	if err != nil {
		t.Fatalf("restore run: %v", err)
	}
	if report.Count(OutcomeCreated) != 1 || report.Count(OutcomeFailed) != 1 {
		t.Fatalf("counts %v", report.Counts)
	}
	if _, _, _, found := customerRow(t, good.ID); !found {
		t.Fatal("the good record was rolled back with the bad one")
	}
	if _, _, _, found := customerRow(t, bad.ID); found {
		t.Fatal("the rejected record was written")
	}
}

// The privilege check is enforced by the driver, so no repository can be
// reached by an end-user command that would forge audit history.
func TestRestoreRefusesAnEndUserActor(t *testing.T) {
	runner := testRunner(t)
	repo := NewCustomerRestoreRepository()
	record := sampleCustomer()
	dropRows(t, "customers", record.ID)
	ctx := context.Background()

	var outcome Outcome
	err := runner.Run(ctx, UserActor(uuid.New(), "admin@example.test"),
		func(ctx context.Context, uow *UnitOfWork) error {
			var err error
			outcome, err = Restore(ctx, uow, repo, record, RestoreOptions{})
			return err
		})
	if !IsKind(err, KindForbidden) {
		t.Fatalf("restore under a user actor: %v", err)
	}
	if outcome != OutcomeFailed {
		t.Fatalf("outcome %q, want %q", outcome, OutcomeFailed)
	}
	if _, _, _, found := customerRow(t, record.ID); found {
		t.Fatal("a refused restore wrote a row")
	}
}

// refusingRefRepo stands in for a repository whose record points at something
// the artifact does not contain. It proves the driver resolves references
// before writing, which is the difference between an actionable error and a
// half-restored database.
type refusingRefRepo struct{ CustomerRestoreRepository }

func (refusingRefRepo) Resolve(context.Context, *UnitOfWork, CustomerRecord) error {
	return NotFound(customerRestoreOp, "customer references price list %s, which is not in the artifact",
		uuid.Nil)
}

func TestResolveFailureStopsTheRecordBeforeAnyWrite(t *testing.T) {
	runner := testRunner(t)
	record := sampleCustomer()
	dropRows(t, "customers", record.ID)
	ctx := context.Background()

	var outcome Outcome
	err := runner.Run(ctx, restoreActor(), func(ctx context.Context, uow *UnitOfWork) error {
		var err error
		outcome, err = Restore(ctx, uow, refusingRefRepo{}, record, RestoreOptions{})
		return err
	})
	if !IsKind(err, KindNotFound) {
		t.Fatalf("unresolved reference gave %v", err)
	}
	if outcome != OutcomeFailed {
		t.Fatalf("outcome %q", outcome)
	}
	if _, _, _, found := customerRow(t, record.ID); found {
		t.Fatal("a record with an unresolved reference was written")
	}
}

// A unique-index collision on a DIFFERENT id is not "internal error": it is a
// conflict the operator can act on, and the constraint name says which one.
func TestUniqueViolationBecomesATypedConflict(t *testing.T) {
	runner := testRunner(t)
	repo := NewCustomerRestoreRepository()
	first := sampleCustomer()
	second := sampleCustomer()
	second.Email = first.Email // the unique lower(email) index
	dropRows(t, "customers", first.ID, second.ID)
	ctx := context.Background()

	err := runner.Run(ctx, restoreActor(), func(ctx context.Context, uow *UnitOfWork) error {
		if _, err := Restore(ctx, uow, repo, first, RestoreOptions{}); err != nil {
			return err
		}
		_, err := Restore(ctx, uow, repo, second, RestoreOptions{})
		return err
	})
	if !IsKind(err, KindConflict) {
		t.Fatalf("duplicate email gave %v, want a conflict", err)
	}
	var typed *Error
	if errors.As(err, &typed) && typed.Field == "" {
		t.Fatalf("the conflict does not name the constraint: %+v", typed)
	}
}

// The jsonb column round-trips through Postgres with its keys reordered. A
// second import of the same artifact must still be a no-op.
func TestApiaryRestoreSurvivesJsonbKeyReordering(t *testing.T) {
	runner := testRunner(t)
	repo := NewApiaryRestoreRepository()
	elevation := 312.5
	source := "terrain"
	latitude, longitude := 39.1, -84.5
	record := ApiaryRecord{
		ID:              uuid.New(),
		Name:            "Restored Yard " + uuid.NewString()[:8],
		Latitude:        &latitude,
		Longitude:       &longitude,
		CanvasLayout:    json.RawMessage(`{"zoom":1.5,"hives":[{"y":2,"x":1}],"anchor":null}`),
		ElevationM:      &elevation,
		ElevationSource: &source,
		ForageRadiusM:   2500,
		Audit: Audit{
			CreatedAt: time.Date(2023, 4, 5, 8, 0, 0, 0, time.UTC),
			UpdatedAt: time.Date(2026, 1, 2, 3, 4, 5, 0, time.UTC),
		},
	}
	dropRows(t, "apiaries", record.ID)
	ctx := context.Background()

	apply := func(rec ApiaryRecord) (Outcome, error) {
		var outcome Outcome
		err := runner.Run(ctx, restoreActor(), func(ctx context.Context, uow *UnitOfWork) error {
			var err error
			outcome, err = Restore(ctx, uow, repo, rec, RestoreOptions{})
			return err
		})
		return outcome, err
	}

	if outcome, err := apply(record); err != nil || outcome != OutcomeCreated {
		t.Fatalf("first import: %q %v", outcome, err)
	}
	if outcome, err := apply(record); err != nil || outcome != OutcomeUnchanged {
		t.Fatalf("re-import: %q %v — jsonb key order was treated as a change", outcome, err)
	}

	var storedCreated, storedUpdated time.Time
	var storedRadius int
	if err := testPool.QueryRow(ctx,
		`SELECT created_at, updated_at, forage_radius_m FROM apiaries WHERE id = $1`, record.ID).
		Scan(&storedCreated, &storedUpdated, &storedRadius); err != nil {
		t.Fatalf("load restored apiary: %v", err)
	}
	if !storedCreated.Equal(record.Audit.CreatedAt) || !storedUpdated.Equal(record.Audit.UpdatedAt) {
		t.Fatalf("audit fields %s / %s were not preserved", storedCreated, storedUpdated)
	}
	if storedRadius != record.ForageRadiusM {
		t.Fatalf("forage radius %d", storedRadius)
	}

	// A real layout change is still a conflict.
	changed := record
	changed.CanvasLayout = json.RawMessage(`{"zoom":2,"hives":[{"x":1,"y":2}],"anchor":null}`)
	if outcome, err := apply(changed); outcome != OutcomeConflicted || !IsKind(err, KindConflict) {
		t.Fatalf("changed layout: %q %v", outcome, err)
	}
}

// A CHECK the repository re-states in Go must be rejected before the database
// ever sees it, so the error names the field instead of the constraint.
func TestApiaryValidationRunsBeforeTheConstraint(t *testing.T) {
	runner := testRunner(t)
	repo := NewApiaryRestoreRepository()
	record := ApiaryRecord{
		ID: uuid.New(), Name: "Too Tight", ForageRadiusM: 10,
		Audit: Audit{CreatedAt: time.Date(2024, 1, 1, 0, 0, 0, 0, time.UTC)},
	}
	dropRows(t, "apiaries", record.ID)

	err := runner.Run(context.Background(), restoreActor(),
		func(ctx context.Context, uow *UnitOfWork) error {
			_, err := Restore(ctx, uow, repo, record, RestoreOptions{})
			return err
		})
	if !IsKind(err, KindInvalid) {
		t.Fatalf("out-of-range forage radius gave %v", err)
	}
	var typed *Error
	if !errors.As(err, &typed) || typed.Field != "forageRadiusM" {
		t.Fatalf("the error does not name the field: %+v", typed)
	}
}
