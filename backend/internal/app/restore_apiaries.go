package app

import (
	"context"
	"encoding/json"
	"strings"

	"github.com/google/uuid"
)

// ApiaryRecord is the portable apiary domain record. It is the second
// template repository on purpose: apiaries carry a jsonb column
// (canvas_layout), a paired-nullable CHECK (elevation), and a bounded numeric
// CHECK (forage radius) — the three shapes most of the remaining domains are
// made of.
type ApiaryRecord struct {
	ID        uuid.UUID
	Name      string
	Latitude  *float64
	Longitude *float64
	Notes     *string
	// CanvasLayout is jsonb. Postgres does not preserve key order or numeric
	// literal formatting, so it is compared canonically, never byte for byte.
	CanvasLayout json.RawMessage
	// ElevationM and ElevationSource are a pair: 00018 CHECKs that they are
	// both set or both NULL, and that the source is one of the three known
	// values.
	ElevationM      *float64
	ElevationSource *string
	// ForageRadiusM is NOT NULL with a 250..8000 CHECK (00027).
	ForageRadiusM int
	Audit         Audit
}

func (r ApiaryRecord) RecordID() uuid.UUID { return r.ID }
func (r ApiaryRecord) Domain() string      { return "apiary" }

// apiaryElevationSources mirrors the 00018 CHECK. Keeping the list here is
// what turns a 23514 into "elevation source must be one of ...".
var apiaryElevationSources = map[string]bool{"geolocation": true, "terrain": true, "override": true}

const (
	apiaryRestoreOp    = "restore apiary"
	apiaryMinForageM   = 250
	apiaryMaxForageM   = 8000
	apiaryMaxLatitude  = 90
	apiaryMaxLongitude = 180
)

type ApiaryRestoreRepository struct{}

func NewApiaryRestoreRepository() ApiaryRestoreRepository { return ApiaryRestoreRepository{} }

func (ApiaryRestoreRepository) Validate(rec ApiaryRecord) error {
	if strings.TrimSpace(rec.Name) == "" {
		return Invalid(apiaryRestoreOp, "name is required").WithField("name")
	}
	if rec.Latitude != nil && (*rec.Latitude < -apiaryMaxLatitude || *rec.Latitude > apiaryMaxLatitude) {
		return Invalid(apiaryRestoreOp, "latitude %v is outside -90..90", *rec.Latitude).
			WithField("latitude")
	}
	if rec.Longitude != nil &&
		(*rec.Longitude < -apiaryMaxLongitude || *rec.Longitude > apiaryMaxLongitude) {
		return Invalid(apiaryRestoreOp, "longitude %v is outside -180..180", *rec.Longitude).
			WithField("longitude")
	}
	if (rec.ElevationM == nil) != (rec.ElevationSource == nil) {
		return Invalid(apiaryRestoreOp,
			"elevation and its source are a pair: set both or neither").WithField("elevationM")
	}
	if rec.ElevationSource != nil && !apiaryElevationSources[*rec.ElevationSource] {
		return Invalid(apiaryRestoreOp,
			"elevation source %q must be geolocation, terrain, or override", *rec.ElevationSource).
			WithField("elevationSource")
	}
	if rec.ForageRadiusM < apiaryMinForageM || rec.ForageRadiusM > apiaryMaxForageM {
		return Invalid(apiaryRestoreOp, "forage radius %d m is outside %d..%d",
			rec.ForageRadiusM, apiaryMinForageM, apiaryMaxForageM).WithField("forageRadiusM")
	}
	if len(rec.CanvasLayout) > 0 && !json.Valid(rec.CanvasLayout) {
		return Invalid(apiaryRestoreOp, "canvas layout is not valid JSON").WithField("canvasLayout")
	}
	return rec.Audit.validate(apiaryRestoreOp)
}

// Resolve: apiaries reference nothing. Hives, memberships, and yard scales
// reference apiaries, which is why apiaries are restored before them — the
// ordering lives in the Wave 2 plan, not here.
func (ApiaryRestoreRepository) Resolve(context.Context, *UnitOfWork, ApiaryRecord) error {
	return nil
}

func (ApiaryRestoreRepository) Load(
	ctx context.Context, uow *UnitOfWork, id uuid.UUID,
) (ApiaryRecord, bool, error) {
	rec := ApiaryRecord{ID: id}
	var layout []byte
	found, err := loadOne(apiaryRestoreOp, func() error {
		return uow.QueryRow(ctx, `
			SELECT name, latitude, longitude, notes, canvas_layout, elevation_m,
				elevation_source, forage_radius_m, created_at, updated_at
			FROM apiaries WHERE id = $1`, id).
			Scan(&rec.Name, &rec.Latitude, &rec.Longitude, &rec.Notes, &layout,
				&rec.ElevationM, &rec.ElevationSource, &rec.ForageRadiusM,
				&rec.Audit.CreatedAt, &rec.Audit.UpdatedAt)
	})
	if err != nil || !found {
		return ApiaryRecord{}, false, err
	}
	rec.CanvasLayout = layout
	return rec, true, nil
}

func (ApiaryRestoreRepository) Equal(stored, incoming ApiaryRecord) bool {
	return stored.Name == incoming.Name &&
		equalFloatPtr(stored.Latitude, incoming.Latitude) &&
		equalFloatPtr(stored.Longitude, incoming.Longitude) &&
		equalStringPtr(stored.Notes, incoming.Notes) &&
		equalJSON(stored.CanvasLayout, incoming.CanvasLayout) &&
		equalFloatPtr(stored.ElevationM, incoming.ElevationM) &&
		equalStringPtr(stored.ElevationSource, incoming.ElevationSource) &&
		stored.ForageRadiusM == incoming.ForageRadiusM &&
		stored.Audit.CreatedAt.Equal(incoming.Audit.CreatedAt)
}

func (ApiaryRestoreRepository) Insert(
	ctx context.Context, uow *UnitOfWork, rec ApiaryRecord,
) error {
	return insertPreserved(ctx, uow, apiaryRestoreOp, `
		INSERT INTO apiaries
			(id, name, latitude, longitude, notes, canvas_layout, elevation_m,
			 elevation_source, forage_radius_m, created_at, updated_at)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
		ON CONFLICT (id) DO NOTHING`,
		rec.ID, rec.Name, rec.Latitude, rec.Longitude, rec.Notes,
		nullJSON(rec.CanvasLayout), rec.ElevationM, rec.ElevationSource,
		rec.ForageRadiusM, rec.Audit.CreatedAt, rec.Audit.updatedAtOr())
}

func (ApiaryRestoreRepository) Overwrite(
	ctx context.Context, uow *UnitOfWork, rec ApiaryRecord,
) error {
	tag, err := uow.Exec(ctx, `
		UPDATE apiaries SET
			name = $2, latitude = $3, longitude = $4, notes = $5,
			canvas_layout = $6, elevation_m = $7, elevation_source = $8,
			forage_radius_m = $9, created_at = $10
		WHERE id = $1`,
		rec.ID, rec.Name, rec.Latitude, rec.Longitude, rec.Notes,
		nullJSON(rec.CanvasLayout), rec.ElevationM, rec.ElevationSource,
		rec.ForageRadiusM, rec.Audit.CreatedAt)
	if err != nil {
		return classifyPg(apiaryRestoreOp, err)
	}
	if tag.RowsAffected() == 0 {
		return NotFound(apiaryRestoreOp, "apiary %s disappeared mid-restore", rec.ID)
	}
	return nil
}

// nullJSON keeps an absent jsonb column NULL rather than storing the string
// "null", which reads back as a JSON null and would fail the round-trip
// digest against a row that never had a layout.
func nullJSON(raw json.RawMessage) any {
	if len(raw) == 0 {
		return nil
	}
	return []byte(raw)
}
