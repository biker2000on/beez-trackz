// Package me owns commands whose scope is the signed-in user.
package me

import (
	"context"
	"errors"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/biker2000on/beez-trackz/backend/internal/app"
)

const updatePreferencesOp = "update preferences"

// UpdatePreferencesCommand is a full replacement of one user's display
// preferences. UserID is deliberately absent: the target always comes from
// the actor attached to the unit of work.
type UpdatePreferencesCommand struct {
	Theme           string
	DefaultApiaryID *uuid.UUID
	DateFormat      string
	WeightUnit      string
	Units           *string
	TemperatureUnit *string
}

// UpdatePreferences updates only the actor's row, creating it for users who
// were added after the migration backfill.
func UpdatePreferences(ctx context.Context, uow *app.UnitOfWork, command UpdatePreferencesCommand) error {
	if uow == nil || !uow.Actor().Valid() || uow.Actor().Kind() != app.ActorUser {
		return app.Forbidden(updatePreferencesOp, "an authenticated user is required")
	}
	if command.Theme == "" {
		command.Theme = "system"
	}
	if command.DateFormat == "" {
		command.DateFormat = "MM/DD/YYYY"
	}
	if command.WeightUnit == "" {
		command.WeightUnit = "oz"
	}
	if command.Units != nil && *command.Units != "metric" && *command.Units != "us" {
		return app.Invalid(updatePreferencesOp, "units must be metric or us")
	}
	if command.TemperatureUnit != nil && *command.TemperatureUnit != "c" && *command.TemperatureUnit != "f" {
		return app.Invalid(updatePreferencesOp, "temperature unit must be c or f")
	}

	_, err := uow.Exec(ctx, `
		INSERT INTO user_preferences (
			user_id, theme, default_apiary_id, date_format, weight_unit, units,
			temperature_unit
		)
		VALUES ($1,$2,$3,$4,$5,$6,$7)
		ON CONFLICT (user_id) DO UPDATE
		SET theme=EXCLUDED.theme,
			default_apiary_id=EXCLUDED.default_apiary_id,
			date_format=EXCLUDED.date_format,
			weight_unit=EXCLUDED.weight_unit,
			units=EXCLUDED.units,
			temperature_unit=EXCLUDED.temperature_unit`,
		uow.Actor().AuditUserID(), command.Theme, command.DefaultApiaryID,
		command.DateFormat, command.WeightUnit, command.Units, command.TemperatureUnit)
	if err == nil {
		return nil
	}
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) && pgErr.Code == "23503" &&
		strings.Contains(pgErr.ConstraintName, "default_apiary_id") {
		return app.NotFound(updatePreferencesOp, "default apiary does not exist")
	}
	return app.Internal(updatePreferencesOp, err)
}
