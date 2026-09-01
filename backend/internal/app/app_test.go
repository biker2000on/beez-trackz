package app

import (
	"context"
	"encoding/json"
	"errors"
	"testing"
	"time"

	"github.com/google/uuid"
)

// Unit tests for the parts of the application layer that need no database:
// the error taxonomy, the actor privilege, the audit rules, the jsonb
// comparison, and the report.

func TestKindOfClassifiesTypedAndUntypedErrors(t *testing.T) {
	cases := []struct {
		name string
		err  error
		want Kind
	}{
		{"invalid", Invalid("restore customer", "name is required"), KindInvalid},
		{"not found", NotFound("restore hive", "apiary %s is missing", uuid.Nil), KindNotFound},
		{"conflict", Conflict("restore customer", "already exists"), KindConflict},
		{"forbidden", Forbidden("restore customer", "not allowed"), KindForbidden},
		{"precondition", Precondition("restore gnucash", "credentials missing"), KindPrecondition},
		{"unsupported", Unsupported("import", "formatVersion 9"), KindUnsupported},
		{"wrapped driver error", Internal("insert", errors.New("boom")), KindInternal},
		{"untyped", errors.New("boom"), KindInternal},
		{"nil", nil, KindInternal},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			if got := KindOf(testCase.err); got != testCase.want {
				t.Fatalf("KindOf(%v) = %q, want %q", testCase.err, got, testCase.want)
			}
		})
	}
}

// The kind has to survive being wrapped, or a repository that adds context
// silently turns an operator-fixable error into an internal one.
func TestKindSurvivesWrapping(t *testing.T) {
	cause := Invalid("restore apiary", "forage radius 10 m is outside 250..8000")
	wrapped := Wrap(KindInternal, "restore run", cause)
	if got := KindOf(wrapped); got != KindInvalid {
		t.Fatalf("kind %q after wrapping, want %q", got, KindInvalid)
	}
	var typed *Error
	if !errors.As(wrapped, &typed) || typed.Kind != KindInvalid {
		t.Fatalf("errors.As did not reach the invalid error: %v", wrapped)
	}
	if !IsKind(wrapped, KindInvalid) {
		t.Fatalf("IsKind did not match: %v", wrapped)
	}
}

func TestErrorMessageNamesTheOperationAndField(t *testing.T) {
	err := Invalid("restore customer", "name is required").WithField("name")
	if got, want := err.Error(), "restore customer: name: name is required"; got != want {
		t.Fatalf("message %q, want %q", got, want)
	}
	// WithField copies: the shared constructor result must not be mutated.
	base := Invalid("restore customer", "name is required")
	_ = base.WithField("name")
	if base.Field != "" {
		t.Fatalf("WithField mutated the receiver: %+v", base)
	}
}

func TestWrapNilIsNil(t *testing.T) {
	if err := Wrap(KindInvalid, "op", nil); err != nil {
		t.Fatalf("Wrap(nil) = %v", err)
	}
	if err := Internal("op", nil); err != nil {
		t.Fatalf("Internal(nil) = %v", err)
	}
}

// Only the restore actor may forge audit history. Admin is not enough: it is
// an end-user authorization level, and the whole point of the separate actor
// is that no HTTP session can reach this privilege.
func TestOnlyTheRestoreActorMayWritePreservedAudit(t *testing.T) {
	user := UserActor(uuid.New(), "admin@example.test")
	restore := SystemRestoreActor(uuid.Nil)
	job := SystemJobActor("transcribe")

	if user.MayWritePreservedAudit() {
		t.Fatal("a signed-in user may write preserved audit fields")
	}
	if job.MayWritePreservedAudit() {
		t.Fatal("a background job may write preserved audit fields")
	}
	if !restore.MayWritePreservedAudit() {
		t.Fatal("the restore actor may not write preserved audit fields")
	}
	if err := restore.requirePreservedAudit("restore customer"); err != nil {
		t.Fatalf("restore actor refused: %v", err)
	}
	err := user.requirePreservedAudit("restore customer")
	if !IsKind(err, KindForbidden) {
		t.Fatalf("user actor error %v, want a forbidden kind", err)
	}
}

func TestZeroActorIsInvalid(t *testing.T) {
	var zero Actor
	if zero.Valid() {
		t.Fatal("the zero actor is valid")
	}
	if !IsKind(zero.requirePreservedAudit("restore customer"), KindForbidden) {
		t.Fatal("the zero actor was not refused")
	}
	// A user actor without an id is a bug, not an anonymous user.
	if UserActor(uuid.Nil, "nobody").Valid() {
		t.Fatal("a user actor with no id is valid")
	}
	// Run refuses before it touches the pool, which is why this needs no
	// database.
	var runner *Runner
	err := runner.Run(context.Background(), zero, func(context.Context, *UnitOfWork) error {
		t.Fatal("the function ran under an invalid actor")
		return nil
	})
	if !IsKind(err, KindForbidden) {
		t.Fatalf("Run error %v, want forbidden", err)
	}
}

func TestSystemRestoreActorCarriesAFallbackAttribution(t *testing.T) {
	operator := uuid.New()
	if got := SystemRestoreActor(operator).AuditUserID(); got != operator {
		t.Fatalf("audit user %s, want %s", got, operator)
	}
	if got := SystemRestoreActor(uuid.Nil).AuditUserID(); got != uuid.Nil {
		t.Fatalf("audit user %s, want nil so created_by stays NULL", got)
	}
}

func TestAuditValidateRequiresACreationTime(t *testing.T) {
	created := time.Date(2026, 5, 1, 12, 0, 0, 0, time.UTC)
	earlier := created.Add(-time.Hour)

	if err := (Audit{}).validate("restore customer"); !IsKind(err, KindInvalid) {
		t.Fatalf("missing created_at gave %v", err)
	}
	if err := (Audit{CreatedAt: created}).validate("restore customer"); err != nil {
		t.Fatalf("valid audit refused: %v", err)
	}
	if err := (Audit{CreatedAt: created, DeletedAt: &earlier}).
		validate("restore customer"); !IsKind(err, KindInvalid) {
		t.Fatalf("deleted before created gave %v", err)
	}
	if err := (Audit{CreatedAt: created, VoidedAt: &earlier}).
		validate("restore customer"); !IsKind(err, KindInvalid) {
		t.Fatalf("voided before created gave %v", err)
	}
	// An absent updated_at falls back to created_at rather than year 1.
	if got := (Audit{CreatedAt: created}).updatedAtOr(); !got.Equal(created) {
		t.Fatalf("updatedAtOr = %s, want %s", got, created)
	}
}

// The jsonb hazard the roadmap calls out: Postgres does not preserve key
// order, so a byte comparison would report every round-tripped layout as a
// conflict.
func TestEqualJSONIgnoresKeyOrderAndWhitespace(t *testing.T) {
	stored := []byte(`{"hives": [{"x": 1, "y": 2}], "zoom": 1.5}`)
	incoming := []byte("{\n \"zoom\":1.5,\n \"hives\":[{\"y\":2,\"x\":1}]\n}")
	if !equalJSON(stored, incoming) {
		t.Fatal("key order or whitespace was treated as a data difference")
	}
	if equalJSON(stored, []byte(`{"zoom": 1.5, "hives": []}`)) {
		t.Fatal("a real difference compared equal")
	}
	// NULL and an empty layout are the same absence; NULL and {} are not.
	if !equalJSON(nil, []byte("  ")) {
		t.Fatal("two absent layouts differ")
	}
	if equalJSON(nil, []byte(`{}`)) {
		t.Fatal("an absent layout equals an empty object")
	}
	// Numeric literals keep their text, so a rescaled value is still a
	// difference rather than being unified by float parsing.
	if equalJSON([]byte(`{"a":1.50}`), []byte(`{"a":1.5}`)) {
		t.Fatal("1.50 and 1.5 compared equal")
	}
}

func TestReportCountsOutcomesWithoutReclassifying(t *testing.T) {
	report := NewReport()
	report.Add("customer", uuid.New(), OutcomeCreated, nil)
	report.Add("customer", uuid.New(), OutcomeUnchanged, nil)
	conflicted := uuid.New()
	report.Add("customer", conflicted, OutcomeConflicted,
		Conflict("restore customer", "already exists"))

	if report.Count(OutcomeCreated) != 1 || report.Count(OutcomeUnchanged) != 1 {
		t.Fatalf("counts %v", report.Counts)
	}
	if report.OK() {
		t.Fatal("a report with a conflict is OK")
	}
	last := report.Records[len(report.Records)-1]
	if last.Outcome != OutcomeConflicted || last.Kind != KindConflict || last.ID != conflicted {
		t.Fatalf("conflicted line %+v", last)
	}
	if encoded, err := json.Marshal(report); err != nil {
		t.Fatalf("report is not serialisable: %v", err)
	} else if len(encoded) == 0 {
		t.Fatal("empty report encoding")
	}
}

// Validation runs ahead of the constraint so the operator sees which field of
// which record is wrong, not a SQLSTATE.
func TestCustomerValidateRejectsBlankOptionals(t *testing.T) {
	repo := NewCustomerRestoreRepository()
	created := time.Date(2026, 5, 1, 12, 0, 0, 0, time.UTC)
	blank := ""
	valid := CustomerRecord{ID: uuid.New(), Name: "Corner Market", Audit: Audit{CreatedAt: created}}

	if err := repo.Validate(valid); err != nil {
		t.Fatalf("valid customer refused: %v", err)
	}
	nameless := valid
	nameless.Name = "  "
	if err := repo.Validate(nameless); !IsKind(err, KindInvalid) {
		t.Fatalf("blank name gave %v", err)
	}
	blankEmail := valid
	blankEmail.Email = &blank
	if err := repo.Validate(blankEmail); !IsKind(err, KindInvalid) {
		t.Fatalf("blank email gave %v", err)
	}
	blankCode := valid
	blankCode.ReferralCode = &blank
	if err := repo.Validate(blankCode); !IsKind(err, KindInvalid) {
		t.Fatalf("blank referral code gave %v", err)
	}
}

func TestApiaryValidateMirrorsTheDatabaseChecks(t *testing.T) {
	repo := NewApiaryRestoreRepository()
	created := time.Date(2026, 5, 1, 12, 0, 0, 0, time.UTC)
	elevation := 312.0
	source := "terrain"
	bogusSource := "guess"
	valid := ApiaryRecord{
		ID: uuid.New(), Name: "Home Yard", ForageRadiusM: 2500,
		ElevationM: &elevation, ElevationSource: &source,
		Audit: Audit{CreatedAt: created},
	}
	if err := repo.Validate(valid); err != nil {
		t.Fatalf("valid apiary refused: %v", err)
	}

	lonelyElevation := valid
	lonelyElevation.ElevationSource = nil
	if err := repo.Validate(lonelyElevation); !IsKind(err, KindInvalid) {
		t.Fatalf("half an elevation pair gave %v", err)
	}
	unknownSource := valid
	unknownSource.ElevationSource = &bogusSource
	if err := repo.Validate(unknownSource); !IsKind(err, KindInvalid) {
		t.Fatalf("unknown elevation source gave %v", err)
	}
	tooTight := valid
	tooTight.ForageRadiusM = 10
	if err := repo.Validate(tooTight); !IsKind(err, KindInvalid) {
		t.Fatalf("out-of-range forage radius gave %v", err)
	}
	badJSON := valid
	badJSON.CanvasLayout = json.RawMessage(`{"hives":`)
	if err := repo.Validate(badJSON); !IsKind(err, KindInvalid) {
		t.Fatalf("malformed canvas layout gave %v", err)
	}
	offEarth := valid
	latitude := 120.0
	offEarth.Latitude = &latitude
	if err := repo.Validate(offEarth); !IsKind(err, KindInvalid) {
		t.Fatalf("impossible latitude gave %v", err)
	}
}
