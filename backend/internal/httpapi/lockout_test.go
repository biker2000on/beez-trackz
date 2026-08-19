package httpapi

import (
	"testing"
	"time"

	"github.com/google/uuid"
)

func testDay(s string) time.Time {
	t, err := time.ParseInLocation("2006-01-02", s, time.Local)
	if err != nil {
		panic(err)
	}
	return t
}

func TestLockoutWindowUsesPostgresDateNotServerTZ(t *testing.T) {
	// DATE columns come back as UTC midnight even when the host is not UTC.
	removed := time.Date(2026, 8, 10, 0, 0, 0, 0, time.UTC)
	row := treatmentLockoutRow{
		Product:        "Apivar",
		DateApplied:    time.Date(2026, 8, 1, 0, 0, 0, 0, time.UTC),
		DateRemoved:    &removed,
		WithdrawalDays: 14,
	}
	inside := evaluateTreatment(row, testDay("2026-08-23"))
	if !inside.Locked {
		t.Fatal("UTC DATE + local as-of must still lock the day before until")
	}
	if inside.Until == nil || calendarDate(*inside.Until).Format("2006-01-02") != "2026-08-24" {
		t.Fatalf("until = %v, want 2026-08-24", inside.Until)
	}
}

func TestEvaluateTreatmentStillOnLocks(t *testing.T) {
	st := evaluateTreatment(treatmentLockoutRow{
		Product:        "Apivar",
		DateApplied:    testDay("2026-08-01"),
		WithdrawalDays: 0,
	}, testDay("2026-08-10"))
	if !st.Locked || !st.TreatmentOn {
		t.Fatalf("still-on treatment: locked=%v treatmentOn=%v", st.Locked, st.TreatmentOn)
	}
	msg := lockoutMessage(st)
	if msg != "This honey cannot be extracted/sold until Apivar is removed" {
		t.Fatalf("message = %q", msg)
	}
}

func TestEvaluateTreatmentWithdrawalWindow(t *testing.T) {
	removed := testDay("2026-08-10")
	row := treatmentLockoutRow{
		Product:        "Apivar",
		DateApplied:    testDay("2026-08-01"),
		DateRemoved:    &removed,
		WithdrawalDays: 14,
	}
	inside := evaluateTreatment(row, testDay("2026-08-23"))
	if !inside.Locked {
		t.Fatal("expected lockout on the day before the until date")
	}
	if inside.Until == nil || !calendarDate(*inside.Until).Equal(testDay("2026-08-24")) {
		t.Fatalf("until = %v, want 2026-08-24", inside.Until)
	}
	if got := lockoutMessage(inside); got != "This honey cannot be extracted/sold until 2026-08-24" {
		t.Fatalf("message = %q", got)
	}

	onUntil := evaluateTreatment(row, testDay("2026-08-24"))
	if onUntil.Locked {
		t.Fatal("harvest/sale on the until date must be allowed")
	}

	after := evaluateTreatment(row, testDay("2026-08-25"))
	if after.Locked {
		t.Fatal("expected clear after the until date")
	}
}

func TestEvaluateTreatmentZeroDaysAfterRemoval(t *testing.T) {
	removed := testDay("2026-08-10")
	row := treatmentLockoutRow{
		Product:        "OA",
		DateApplied:    testDay("2026-08-10"),
		DateRemoved:    &removed,
		WithdrawalDays: 0,
	}
	sameDay := evaluateTreatment(row, testDay("2026-08-10"))
	if sameDay.Locked {
		t.Fatal("zero-day withdrawal must clear on the removal date")
	}
	before := evaluateTreatment(row, testDay("2026-08-09"))
	if !before.Locked {
		t.Fatal("expected lockout before removal")
	}
}

func TestPickLockoutPrefersStillOnThenLatestUntil(t *testing.T) {
	removed := testDay("2026-08-01")
	later := testDay("2026-08-20")
	rows := []treatmentLockoutRow{
		{
			HiveID: uuid.New(), Product: "old", DateApplied: testDay("2026-07-01"),
			DateRemoved: &removed, WithdrawalDays: 0,
		},
		{
			HiveID: uuid.New(), Product: "Apivar", DateApplied: testDay("2026-08-05"),
			WithdrawalDays: 14,
		},
		{
			HiveID: uuid.New(), Product: "short", DateApplied: testDay("2026-08-01"),
			DateRemoved: &later, WithdrawalDays: 2,
		},
	}
	st := pickLockout(rows, testDay("2026-08-10"))
	if !st.TreatmentOn || st.Product != "Apivar" {
		t.Fatalf("wanted still-on Apivar, got %+v", st)
	}
}

func TestMoistureOverThreshold(t *testing.T) {
	ok := 18.6
	if msg := moistureOverThreshold(&ok, 18.6); msg != "" {
		t.Fatalf("18.6 on a 18.6 threshold must pass: %s", msg)
	}
	high := 18.61
	if msg := moistureOverThreshold(&high, 18.6); msg == "" {
		t.Fatal("18.61 must reject")
	}
	if msg := moistureOverThreshold(nil, 18.6); msg != "" {
		t.Fatalf("omitted moisture must pass: %s", msg)
	}
	if msg := validateMoisturePct(ptrFloat(-1)); msg == "" {
		t.Fatal("negative moisture must fail")
	}
}

func ptrFloat(v float64) *float64 { return &v }
