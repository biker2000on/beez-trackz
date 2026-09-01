package app

import (
	"context"
	"strings"

	"github.com/google/uuid"
)

// CustomerRecord is the portable customer domain record: the semantic fields
// plus the preserved ID and audit stamps. It is the shape a snapshot JSONL
// line decodes into, deliberately independent of both the HTTP DTO and the
// table, so a schema change is a repository change and not a format change.
type CustomerRecord struct {
	ID           uuid.UUID
	Name         string
	Email        *string
	Phone        *string
	Notes        *string
	EmailOptIn   bool
	ReferralCode *string
	ReferredBy   *string
	Audit        Audit
}

func (r CustomerRecord) RecordID() uuid.UUID { return r.ID }
func (r CustomerRecord) Domain() string      { return "customer" }

// CustomerRestoreRepository is the template restore repository: preserved id
// and created_at written directly, domain validation ahead of the constraint,
// semantic comparison for idempotency.
type CustomerRestoreRepository struct{}

func NewCustomerRestoreRepository() CustomerRestoreRepository { return CustomerRestoreRepository{} }

const customerRestoreOp = "restore customer"

func (CustomerRestoreRepository) Validate(rec CustomerRecord) error {
	if strings.TrimSpace(rec.Name) == "" {
		return Invalid(customerRestoreOp, "name is required").WithField("name")
	}
	// The unique index is on lower(email), so a blank string is not "no
	// email" — it is a value that collides with the next blank one.
	if rec.Email != nil && strings.TrimSpace(*rec.Email) == "" {
		return Invalid(customerRestoreOp,
			"email is present but blank; omit it instead").WithField("email")
	}
	if rec.ReferralCode != nil && strings.TrimSpace(*rec.ReferralCode) == "" {
		return Invalid(customerRestoreOp,
			"referral code is present but blank; omit it instead").WithField("referralCode")
	}
	return rec.Audit.validate(customerRestoreOp)
}

// Resolve has nothing to check: customers is a root of the reference graph.
// referred_by is free text (00002), not a foreign key, so a restore must not
// invent a customer lookup for it. The method still exists because the
// ordering — resolve before load, both before write — belongs to the driver.
func (CustomerRestoreRepository) Resolve(context.Context, *UnitOfWork, CustomerRecord) error {
	return nil
}

func (CustomerRestoreRepository) Load(
	ctx context.Context, uow *UnitOfWork, id uuid.UUID,
) (CustomerRecord, bool, error) {
	rec := CustomerRecord{ID: id}
	found, err := loadOne(customerRestoreOp, func() error {
		return uow.QueryRow(ctx, `
			SELECT name, email, phone, notes, email_opt_in, referral_code,
				referred_by, created_at, updated_at
			FROM customers WHERE id = $1`, id).
			Scan(&rec.Name, &rec.Email, &rec.Phone, &rec.Notes, &rec.EmailOptIn,
				&rec.ReferralCode, &rec.ReferredBy, &rec.Audit.CreatedAt,
				&rec.Audit.UpdatedAt)
	})
	if err != nil || !found {
		return CustomerRecord{}, false, err
	}
	return rec, true, nil
}

// Equal is semantic equality, which for the restore contract includes
// created_at: a row with the same id and the same fields but a different
// creation time is not the same record, it is a conflict worth reporting.
// updated_at is excluded — the trigger owns it.
func (CustomerRestoreRepository) Equal(stored, incoming CustomerRecord) bool {
	return stored.Name == incoming.Name &&
		equalStringPtr(stored.Email, incoming.Email) &&
		equalStringPtr(stored.Phone, incoming.Phone) &&
		equalStringPtr(stored.Notes, incoming.Notes) &&
		stored.EmailOptIn == incoming.EmailOptIn &&
		equalStringPtr(stored.ReferralCode, incoming.ReferralCode) &&
		equalStringPtr(stored.ReferredBy, incoming.ReferredBy) &&
		stored.Audit.CreatedAt.Equal(incoming.Audit.CreatedAt)
}

func (CustomerRestoreRepository) Insert(
	ctx context.Context, uow *UnitOfWork, rec CustomerRecord,
) error {
	return insertPreserved(ctx, uow, customerRestoreOp, `
		INSERT INTO customers
			(id, name, email, phone, notes, email_opt_in, referral_code,
			 referred_by, created_at, updated_at)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
		ON CONFLICT (id) DO NOTHING`,
		rec.ID, rec.Name, rec.Email, rec.Phone, rec.Notes, rec.EmailOptIn,
		rec.ReferralCode, rec.ReferredBy, rec.Audit.CreatedAt, rec.Audit.updatedAtOr())
}

func (CustomerRestoreRepository) Overwrite(
	ctx context.Context, uow *UnitOfWork, rec CustomerRecord,
) error {
	tag, err := uow.Exec(ctx, `
		UPDATE customers SET
			name = $2, email = $3, phone = $4, notes = $5, email_opt_in = $6,
			referral_code = $7, referred_by = $8, created_at = $9
		WHERE id = $1`,
		rec.ID, rec.Name, rec.Email, rec.Phone, rec.Notes, rec.EmailOptIn,
		rec.ReferralCode, rec.ReferredBy, rec.Audit.CreatedAt)
	if err != nil {
		return classifyPg(customerRestoreOp, err)
	}
	if tag.RowsAffected() == 0 {
		return NotFound(customerRestoreOp, "customer %s disappeared mid-restore", rec.ID)
	}
	return nil
}
