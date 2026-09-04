package production

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/biker2000on/beez-trackz/backend/internal/app"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

// bulkAdvisoryLockKey preserves the cross-command lock shared by harvest
// deletion, lot updates, jarring, and bottling. Inventory tuple locks remain
// the source of quantity integrity; this domain lock orders those workflows.
const bulkAdvisoryLockKey int64 = 8_472_113_001

type UpdateJarSizeInput struct {
	JarSizeID            uuid.UUID
	SetLabel             bool
	Label                string
	SetHoneyOz           bool
	HoneyOz              *float64
	SetDefaultPrice      bool
	DefaultPriceCents    *int64
	SetActive            bool
	Active               bool
	SetLowStockThreshold bool
	LowStockThreshold    int
	SetPackagingType     bool
	PackagingTypeID      *uuid.UUID
	WriteOffRemaining    bool
	WriteOffReason       *string
	OccurredAt           time.Time
}
type UpdateJarSizeResult struct {
	Success        bool `json:"success"`
	JarsWrittenOff int  `json:"jarsWrittenOff,omitempty"`
}

func UpdateJarSize(ctx context.Context, uow *app.UnitOfWork, in UpdateJarSizeInput) (UpdateJarSizeResult, error) {
	const op = "update jar size"
	out := UpdateJarSizeResult{Success: true}
	if in.JarSizeID == uuid.Nil {
		return out, app.Invalid(op, "jar size is required")
	}
	if in.SetLabel && strings.TrimSpace(in.Label) == "" {
		return out, app.Invalid(op, "label is required")
	}
	if in.SetLowStockThreshold && in.LowStockThreshold < 0 {
		return out, app.Invalid(op, "low stock threshold must be non-negative")
	}
	sets := []string{}
	args := []any{in.JarSizeID}
	add := func(column string, value any) {
		args = append(args, value)
		sets = append(sets, column+"=$"+strconv.Itoa(len(args)))
	}
	if in.SetLabel {
		add("label", strings.TrimSpace(in.Label))
	}
	if in.SetHoneyOz {
		add("honey_oz", in.HoneyOz)
	}
	if in.SetDefaultPrice {
		add("default_price_cents", in.DefaultPriceCents)
	}
	if in.SetActive {
		add("is_active", in.Active)
	}
	if in.SetLowStockThreshold {
		add("low_stock_threshold", in.LowStockThreshold)
	}
	if in.SetPackagingType {
		add("packaging_type_id", in.PackagingTypeID)
	}
	if len(sets) == 0 {
		return out, nil
	}
	if in.SetActive && !in.Active {
		var remaining, away int
		if err := uow.QueryRow(ctx, `SELECT COALESCE(SUM(a.available) FILTER(WHERE l.is_home),0)::int,COALESCE(SUM(a.available) FILTER(WHERE NOT l.is_home),0)::int FROM jar_sizes js LEFT JOIN inventory_available a ON a.item_id=js.item_id LEFT JOIN inventory_locations l ON l.id=a.location_id WHERE js.id=$1 GROUP BY js.id`, in.JarSizeID).Scan(&remaining, &away); errors.Is(err, pgx.ErrNoRows) {
			return out, app.NotFound(op, "jar size not found")
		} else if err != nil {
			return out, wrapDB(op, err)
		}
		if away != 0 {
			return out, app.Conflict(op, "%d jars of this size are at non-home locations; return or settle them first", away)
		}
		if remaining != 0 {
			if !in.WriteOffRemaining {
				return out, app.Conflict(op, "%d jars are still on hand; sell, give away, adjust, or explicitly write them off first", remaining)
			}
			reason := "jar size deactivation write-off"
			if v := trim(in.WriteOffReason); v != nil {
				reason = *v
			}
			when := in.OccurredAt
			if when.IsZero() {
				when = time.Now().UTC()
			}
			if _, err := New().AdjustJarCounts(ctx, uow, []JarLine{{JarSizeID: in.JarSizeID, Quantity: -remaining}}, when, &reason); err != nil {
				return out, err
			}
			out.JarsWrittenOff = remaining
		}
	}
	query := "UPDATE jar_sizes SET " + strings.Join(sets, ",") + " WHERE id=$1"
	tag, err := uow.Exec(ctx, query, args...)
	if err != nil {
		return out, classifyCommandDB(op, err)
	}
	if tag.RowsAffected() == 0 {
		return out, app.NotFound(op, "jar size not found")
	}
	return out, nil
}

// LotInput carries a harvest lot as the operator entered it. VarietalID names
// the honey: honey_varietals.name is the lot's only name, titling the public
// Honey Story and every operator-facing list; there is no free-text name.
// ClaimSpecies left blank with a VarietalID set is filled from the varietal's
// name, so the floral claim never has to repeat the honey's name; an explicit
// ClaimSpecies (a blend) still wins. PulledOn is the day the frames/supers
// were pulled; nil when unknown.
type LotInput struct {
	ID                                               uuid.UUID
	LotCode, PublicSlug                              string
	ExtractionDate                                   time.Time
	PulledOn                                         *time.Time
	HoneyWeightLbs                                   *float64
	HoneyWeightEntered, HoneyWeightSource            *string
	VarietalID                                       *uuid.UUID
	Season, ApiaryRegion, BloomNotes, BeekeeperStory *string
	TestingData                                      map[string]any
	ReorderURL                                       *string
	IsPublic                                         bool
	HarvestIDs, PhotoIDs                             []uuid.UUID
	MoisturePct, BottlingMoisturePct                 *float64
	MoistureOverrideReason                           *string
	ClaimSpecies                                     *string
	ClaimYear                                        *int
	ClaimApiaryID                                    *uuid.UUID
	ClaimElevationM                                  *float64
	StoryBaseURL                                     string
}
type CreateLotResult struct {
	ID         uuid.UUID `json:"id"`
	PublicSlug string    `json:"publicSlug"`
	StoryURL   string    `json:"storyUrl"`
}
type UpdateLotResult struct {
	Success bool `json:"success"`
}

func CreateLot(ctx context.Context, uow *app.UnitOfWork, in LotInput) (CreateLotResult, error) {
	const op = "create harvest lot"
	out := CreateLotResult{ID: in.ID, PublicSlug: in.PublicSlug, StoryURL: strings.TrimRight(in.StoryBaseURL, "/") + "/honey/" + in.PublicSlug}
	if in.ID == uuid.Nil || strings.TrimSpace(in.LotCode) == "" || strings.TrimSpace(in.PublicSlug) == "" || in.ExtractionDate.IsZero() {
		return out, app.Invalid(op, "lot code, public slug, and extraction date are required")
	}
	weight, source, entered, elevation, err := prepareLot(ctx, uow, in)
	if err != nil {
		return out, err
	}
	species, err := lotClaimSpecies(ctx, uow, in)
	if err != nil {
		return out, err
	}
	if _, err := uow.Exec(ctx, `INSERT INTO harvest_lots(id,lot_code,public_slug,extraction_date,honey_weight_lbs,honey_weight_entered,honey_weight_source,season,apiary_region,bloom_notes,beekeeper_story,testing_data,reorder_url,is_public,moisture_pct,bottling_moisture_pct,claim_species,claim_year,claim_apiary_id,claim_elevation_m,varietal_id,pulled_on,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23)`, in.ID, strings.TrimSpace(in.LotCode), in.PublicSlug, in.ExtractionDate, weight, entered, source, trim(in.Season), trim(in.ApiaryRegion), trim(in.BloomNotes), trim(in.BeekeeperStory), in.TestingData, in.ReorderURL, in.IsPublic, in.MoisturePct, in.BottlingMoisturePct, species, in.ClaimYear, in.ClaimApiaryID, elevation, in.VarietalID, in.PulledOn, actorValue(uow)); err != nil {
		return out, classifyCommandDB(op, err)
	}
	if err := replaceLotLinks(ctx, uow, in); err != nil {
		return out, err
	}
	if err := stampLotMoisture(ctx, uow, in.ID, in.MoistureOverrideReason); err != nil {
		return out, err
	}
	if err := New().SetLotCeiling(ctx, uow, in.ID, weight, in.ExtractionDate); err != nil {
		return out, err
	}
	if err := uow.Emit(ctx, app.Event{AggregateType: "harvest_lot", AggregateID: in.ID, Type: "harvest_lot.created", Payload: map[string]any{"publicSlug": in.PublicSlug}}); err != nil {
		return out, err
	}
	return out, nil
}

func UpdateLot(ctx context.Context, uow *app.UnitOfWork, in LotInput) (UpdateLotResult, error) {
	const op = "update harvest lot"
	out := UpdateLotResult{Success: true}
	if in.ID == uuid.Nil {
		return out, app.Invalid(op, "lot id is required")
	}
	weight, source, entered, elevation, err := prepareLot(ctx, uow, in)
	if err != nil {
		return out, err
	}
	// Lock source harvests before the lot everywhere. Bottling runs are the
	// production fact for how much of a lot is already committed; reading them
	// only after the lot lock also observes any run that was in flight.
	_, _, err = lockLotBalance(ctx, uow, in.ID)
	if err != nil {
		return out, err
	}
	var used float64
	if err := uow.QueryRow(ctx, `SELECT COALESCE(SUM(COALESCE(r.honey_lbs,r.quantity*COALESCE(js.honey_oz,0)/16.0)),0)::float8 FROM bottling_runs r LEFT JOIN jar_sizes js ON js.id=r.jar_size_id WHERE r.lot_id=$1 AND r.voided_at IS NULL`, in.ID).Scan(&used); err != nil {
		return out, wrapDB(op, err)
	}
	if weight < used-PoundTolerance {
		if source == "derived" {
			return out, app.Precondition(op, "The linked harvests total %.2f lbs but this lot's bottling runs already used %.2f lbs; fix the harvests or type a manual weight", weight, used)
		}
		return out, app.Precondition(op, "Lot weight cannot be below the %.2f lbs its bottling runs already used", used)
	}
	species, err := lotClaimSpecies(ctx, uow, in)
	if err != nil {
		return out, err
	}
	tag, err := uow.Exec(ctx, `UPDATE harvest_lots SET lot_code=$2,public_slug=$3,extraction_date=$4,honey_weight_lbs=$5,honey_weight_entered=$6,honey_weight_source=$7,season=$8,apiary_region=$9,bloom_notes=$10,beekeeper_story=$11,testing_data=$12,reorder_url=$13,is_public=$14,moisture_pct=$15,bottling_moisture_pct=$16,claim_species=$17,claim_year=$18,claim_apiary_id=$19,claim_elevation_m=$20,varietal_id=$21,pulled_on=$22 WHERE id=$1`, in.ID, strings.TrimSpace(in.LotCode), in.PublicSlug, in.ExtractionDate, weight, entered, source, trim(in.Season), trim(in.ApiaryRegion), trim(in.BloomNotes), trim(in.BeekeeperStory), in.TestingData, in.ReorderURL, in.IsPublic, in.MoisturePct, in.BottlingMoisturePct, species, in.ClaimYear, in.ClaimApiaryID, elevation, in.VarietalID, in.PulledOn)
	if err != nil {
		return out, classifyCommandDB(op, err)
	}
	if tag.RowsAffected() == 0 {
		return out, app.NotFound(op, "harvest lot not found")
	}
	if _, err := uow.Exec(ctx, `DELETE FROM harvest_lot_harvests WHERE lot_id=$1`, in.ID); err != nil {
		return out, wrapDB(op, err)
	}
	if _, err := uow.Exec(ctx, `DELETE FROM harvest_lot_photos WHERE lot_id=$1`, in.ID); err != nil {
		return out, wrapDB(op, err)
	}
	if err := replaceLotLinks(ctx, uow, in); err != nil {
		return out, err
	}
	if err := stampLotMoisture(ctx, uow, in.ID, in.MoistureOverrideReason); err != nil {
		return out, err
	}
	if err := New().SetLotCeiling(ctx, uow, in.ID, weight, in.ExtractionDate); err != nil {
		return out, err
	}
	return out, nil
}

func prepareLot(ctx context.Context, uow *app.UnitOfWork, in LotInput) (float64, string, *string, *float64, error) {
	const op = "prepare harvest lot"
	if len(in.HarvestIDs) > 0 {
		rows, err := uow.Query(ctx, `SELECT id,deleted_at IS NOT NULL FROM honey_harvests WHERE id=ANY($1) ORDER BY id FOR UPDATE`, in.HarvestIDs)
		if err != nil {
			return 0, "", nil, nil, wrapDB(op, err)
		}
		found := 0
		for rows.Next() {
			var id uuid.UUID
			var deleted bool
			if err := rows.Scan(&id, &deleted); err != nil {
				rows.Close()
				return 0, "", nil, nil, wrapDB(op, err)
			}
			found++
			if deleted {
				rows.Close()
				return 0, "", nil, nil, app.Unsupported(op, "harvest %s has been deleted and cannot be linked to a lot", id)
			}
		}
		if err := rows.Err(); err != nil {
			rows.Close()
			return 0, "", nil, nil, wrapDB(op, err)
		}
		rows.Close()
		if found != len(uniqueUUIDs(in.HarvestIDs)) {
			return 0, "", nil, nil, app.NotFound(op, "invalid harvest")
		}
	}
	var derived float64
	var linked int
	if len(in.HarvestIDs) > 0 {
		if err := uow.QueryRow(ctx, `SELECT COALESCE(SUM(calculated_honey_weight),0),COUNT(*)::int FROM honey_harvests WHERE id=ANY($1) AND deleted_at IS NULL`, in.HarvestIDs).Scan(&derived, &linked); err != nil {
			return 0, "", nil, nil, wrapDB(op, err)
		}
	}
	source := ""
	if in.HoneyWeightSource != nil {
		source = strings.TrimSpace(*in.HoneyWeightSource)
	}
	var weight float64
	var entered *string
	switch {
	case source == "derived":
		if linked == 0 {
			return 0, "", nil, nil, app.Invalid(op, "honeyWeightSource 'derived' needs at least one linked harvest")
		}
		weight = derived
	case source == "manual" || in.HoneyWeightLbs != nil:
		if in.HoneyWeightLbs == nil {
			return 0, "", nil, nil, app.Invalid(op, "honeyWeightSource 'manual' requires honeyWeightLbs")
		}
		weight = *in.HoneyWeightLbs
		source = "manual"
		entered = trim(in.HoneyWeightEntered)
	case linked > 0:
		weight = derived
		source = "derived"
	default:
		source = "manual"
	}
	if source != "manual" && source != "derived" {
		return 0, "", nil, nil, app.Invalid(op, "honeyWeightSource must be 'manual' or 'derived'")
	}
	if weight < 0 {
		return 0, "", nil, nil, app.Invalid(op, "honeyWeightLbs must be non-negative")
	}
	elevation := in.ClaimElevationM
	if elevation == nil && in.ClaimApiaryID != nil {
		if err := uow.QueryRow(ctx, `SELECT elevation_m FROM apiaries WHERE id=$1`, *in.ClaimApiaryID).Scan(&elevation); errors.Is(err, pgx.ErrNoRows) {
			return 0, "", nil, nil, app.NotFound(op, "invalid claimApiaryId")
		} else if err != nil {
			return 0, "", nil, nil, wrapDB(op, err)
		}
	}
	return weight, source, entered, elevation, nil
}

// lotClaimSpecies resolves the floral claim's species: the operator's own
// text when present (a blend), else the varietal's name (the varietal IS the
// honey's name, and the public Honey Story reads claim_species), else nil.
func lotClaimSpecies(ctx context.Context, uow *app.UnitOfWork, in LotInput) (*string, error) {
	const op = "resolve lot claim species"
	if species := trim(in.ClaimSpecies); species != nil {
		return species, nil
	}
	if in.VarietalID == nil {
		return nil, nil
	}
	var name string
	if err := uow.QueryRow(ctx, `SELECT name FROM honey_varietals WHERE id=$1`, *in.VarietalID).Scan(&name); errors.Is(err, pgx.ErrNoRows) {
		return nil, app.NotFound(op, "invalid varietalId")
	} else if err != nil {
		return nil, wrapDB(op, err)
	}
	return trim(&name), nil
}

func replaceLotLinks(ctx context.Context, uow *app.UnitOfWork, in LotInput) error {
	for _, id := range in.HarvestIDs {
		if _, err := uow.Exec(ctx, `INSERT INTO harvest_lot_harvests(lot_id,harvest_id) VALUES($1,$2)`, in.ID, id); err != nil {
			return classifyCommandDB("link harvest lot", err)
		}
	}
	for i, id := range in.PhotoIDs {
		if _, err := uow.Exec(ctx, `INSERT INTO harvest_lot_photos(lot_id,photo_id,sort_order) VALUES($1,$2,$3)`, in.ID, id, i); err != nil {
			return classifyCommandDB("link harvest lot photo", err)
		}
	}
	return nil
}
func stampLotMoisture(ctx context.Context, uow *app.UnitOfWork, id uuid.UUID, reason *string) error {
	reason = trim(reason)
	if reason == nil {
		_, err := uow.Exec(ctx, `UPDATE harvest_lots SET moisture_override_reason=NULL,moisture_override_by=NULL,moisture_override_at=NULL WHERE id=$1`, id)
		return wrapDB("stamp moisture override", err)
	}
	_, err := uow.Exec(ctx, `UPDATE harvest_lots SET moisture_override_reason=$2,moisture_override_by=CASE WHEN moisture_override_reason IS DISTINCT FROM $2 THEN $3 ELSE moisture_override_by END,moisture_override_at=CASE WHEN moisture_override_reason IS DISTINCT FROM $2 THEN now() ELSE moisture_override_at END WHERE id=$1`, id, *reason, actorValue(uow))
	return wrapDB("stamp moisture override", err)
}

type RecordBottlingLine struct {
	JarSizeID uuid.UUID
	Quantity  int
}
type RecordBottlingInput struct {
	HarvestLotID uuid.UUID
	Date         time.Time
	Lines        []RecordBottlingLine
	LossLbs      float64
	Notes        *string
}
type RecordBottlingResult struct {
	Success           bool     `json:"success"`
	PackagingWarnings []string `json:"packagingWarnings"`
}

// RecordBottling owns the everyday jarring transaction orchestration. The
// transport supplies parsed values; this command resolves weights and BOMs,
// checks the lot before refusal, writes runs, ledger transforms, loss and the
// outbox fact through the caller's unit of work.
func RecordBottling(ctx context.Context, uow *app.UnitOfWork, input RecordBottlingInput) (RecordBottlingResult, error) {
	const op = "record bottling"
	out := RecordBottlingResult{PackagingWarnings: []string{}}
	if input.HarvestLotID == uuid.Nil || input.Date.IsZero() {
		return out, app.Invalid(op, "harvest lot and date are required")
	}
	if len(input.Lines) == 0 && input.LossLbs <= 0 {
		return out, app.Invalid(op, "add at least one jar line")
	}
	if input.LossLbs < 0 {
		return out, app.Invalid(op, "loss pounds must not be negative")
	}
	ids := make([]uuid.UUID, 0, len(input.Lines))
	for _, line := range input.Lines {
		if line.JarSizeID == uuid.Nil || line.Quantity <= 0 {
			return out, app.Invalid(op, "jar size and positive quantity are required")
		}
		ids = append(ids, line.JarSizeID)
	}
	type spec struct {
		oz        *float64
		packaging *uuid.UUID
	}
	specs := map[uuid.UUID]spec{}
	if len(ids) > 0 {
		rows, err := uow.Query(ctx, `SELECT id,honey_oz,packaging_type_id FROM jar_sizes WHERE id=ANY($1)`, ids)
		if err != nil {
			return out, wrapDB(op, err)
		}
		for rows.Next() {
			var id uuid.UUID
			var s spec
			if err := rows.Scan(&id, &s.oz, &s.packaging); err != nil {
				rows.Close()
				return out, wrapDB(op, err)
			}
			specs[id] = s
		}
		if err := rows.Err(); err != nil {
			rows.Close()
			return out, wrapDB(op, err)
		}
		rows.Close()
		if len(specs) != len(uniqueUUIDs(ids)) {
			return out, app.NotFound(op, "invalid jar size")
		}
	}
	lotCode, available, err := lockLotBalance(ctx, uow, input.HarvestLotID)
	if err != nil {
		return out, err
	}
	if _, err := uow.Exec(ctx, `SELECT pg_advisory_xact_lock($1)`, bulkAdvisoryLockKey); err != nil {
		return out, wrapDB(op, err)
	}
	if refusal, until, err := lotRefusal(ctx, uow, input.HarvestLotID, input.Date); err != nil {
		return out, err
	} else if refusal != "" {
		if until != nil {
			return out, app.Conflict(op, "%s (locked out until %s)", refusal, until.Format("2006-01-02"))
		}
		return out, app.Conflict(op, "%s", refusal)
	}
	amounts := make([]float64, len(input.Lines))
	need := input.LossLbs
	for i, line := range input.Lines {
		if specs[line.JarSizeID].oz != nil {
			amounts[i] = *specs[line.JarSizeID].oz * float64(line.Quantity) / 16
		}
		need += amounts[i]
	}
	if need > available+PoundTolerance {
		return out, app.Precondition(op, "Lot %s has %.2f lbs left; this needs %.2f lbs", lotCode, available, need)
	}
	svc := New()
	actor := actorValue(uow)
	for i, line := range input.Lines {
		runID := uuid.New()
		if _, err := uow.Exec(ctx, `INSERT INTO bottling_runs(id,lot_id,bottled_date,jar_size_id,quantity,honey_lbs,notes,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`, runID, input.HarvestLotID, input.Date, line.JarSizeID, line.Quantity, amounts[i], trim(input.Notes), actor); err != nil {
			return out, classifyCommandDB(op, err)
		}
		packaging := map[uuid.UUID]int{}
		if p := specs[line.JarSizeID].packaging; p != nil {
			packaging[*p] = line.Quantity
		}
		result, err := svc.RecordBottling(ctx, uow, BottlingInput{RunID: runID, HarvestLotID: input.HarvestLotID, JarSizeID: line.JarSizeID, Quantity: line.Quantity, HoneyLbs: amounts[i], Date: input.Date, PackagingTypes: packaging, Notes: trim(input.Notes)})
		if err != nil {
			return out, err
		}
		out.PackagingWarnings = append(out.PackagingWarnings, result.PackagingWarnings...)
	}
	if input.LossLbs > 0 {
		if _, err := svc.RecordBulkDraw(ctx, uow, BulkDrawInput{HarvestLotID: input.HarvestLotID, AmountLbs: input.LossLbs, Reason: ReasonLoss, Date: input.Date, Notes: trim(input.Notes)}); err != nil {
			return out, err
		}
	}
	if err := uow.Emit(ctx, app.Event{AggregateType: "harvest_lot", AggregateID: input.HarvestLotID, Type: "bottling.recorded", Payload: map[string]any{"lines": len(input.Lines), "lossRecorded": input.LossLbs > 0}}); err != nil {
		return out, err
	}
	out.Success = true
	return out, nil
}

type RecordBottlingRunInput struct {
	RunID, HarvestLotID, JarSizeID uuid.UUID
	Date                           time.Time
	Quantity                       int
	HoneyLbs                       *float64
	Notes                          *string
	Serialize                      bool
	MoisturePct                    *float64
}
type RecordBottlingRunResult struct {
	ID            uuid.UUID `json:"id"`
	SerialNumbers []string  `json:"serialNumbers"`
}

func RecordBottlingRun(ctx context.Context, uow *app.UnitOfWork, in RecordBottlingRunInput) (RecordBottlingRunResult, error) {
	const op = "record bottling run"
	out := RecordBottlingRunResult{ID: in.RunID, SerialNumbers: []string{}}
	if in.RunID == uuid.Nil || in.HarvestLotID == uuid.Nil || in.JarSizeID == uuid.Nil || in.Date.IsZero() || in.Quantity <= 0 {
		return out, app.Invalid(op, "run, lot, jar size, date, and positive quantity are required")
	}
	if in.HoneyLbs != nil && *in.HoneyLbs < 0 {
		return out, app.Invalid(op, "honey pounds must not be negative")
	}
	if in.MoisturePct != nil && (*in.MoisturePct < 0 || *in.MoisturePct > 100) {
		return out, app.Invalid(op, "moisture must be between 0 and 100")
	}
	lotCode, available, err := lockLotBalance(ctx, uow, in.HarvestLotID)
	if err != nil {
		return out, err
	}
	if _, err := uow.Exec(ctx, `SELECT pg_advisory_xact_lock($1)`, bulkAdvisoryLockKey); err != nil {
		return out, wrapDB(op, err)
	}
	if refusal, until, err := lotRefusal(ctx, uow, in.HarvestLotID, in.Date); err != nil {
		return out, err
	} else if refusal != "" {
		if until != nil {
			return out, app.Conflict(op, "%s (locked out until %s)", refusal, until.Format("2006-01-02"))
		}
		return out, app.Conflict(op, "%s", refusal)
	}
	var oz *float64
	var packaging *uuid.UUID
	if err := uow.QueryRow(ctx, `SELECT honey_oz,packaging_type_id FROM jar_sizes WHERE id=$1`, in.JarSizeID).Scan(&oz, &packaging); errors.Is(err, pgx.ErrNoRows) {
		return out, app.NotFound(op, "invalid jar size")
	} else if err != nil {
		return out, wrapDB(op, err)
	}
	lbs := 0.0
	if in.HoneyLbs != nil {
		lbs = *in.HoneyLbs
	} else if oz != nil {
		lbs = *oz * float64(in.Quantity) / 16
	}
	if lbs > available+PoundTolerance {
		return out, app.Precondition(op, "Lot %s has %.2f lbs left; this run needs %.2f lbs", lotCode, available, lbs)
	}
	if _, err := uow.Exec(ctx, `INSERT INTO bottling_runs(id,lot_id,bottled_date,jar_size_id,quantity,honey_lbs,notes,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`, in.RunID, in.HarvestLotID, in.Date, in.JarSizeID, in.Quantity, in.HoneyLbs, trim(in.Notes), actorValue(uow)); err != nil {
		return out, classifyCommandDB(op, err)
	}
	bom := map[uuid.UUID]int{}
	if packaging != nil {
		bom[*packaging] = in.Quantity
	}
	if _, err := New().RecordBottling(ctx, uow, BottlingInput{RunID: in.RunID, HarvestLotID: in.HarvestLotID, JarSizeID: in.JarSizeID, Quantity: in.Quantity, HoneyLbs: lbs, Date: in.Date, PackagingTypes: bom, Notes: trim(in.Notes)}); err != nil {
		return out, err
	}
	if in.Serialize {
		for i := 1; i <= in.Quantity; i++ {
			serial := fmt.Sprintf("%s-%s-%s-%04d", lotCode, in.Date.Format("20060102"), strings.ToUpper(in.RunID.String()[:6]), i)
			if _, err := uow.Exec(ctx, `INSERT INTO jar_serials(bottling_run_id,serial_number) VALUES($1,$2)`, in.RunID, serial); err != nil {
				return out, app.Conflict(op, "serial numbers already exist for this lot and date")
			}
			out.SerialNumbers = append(out.SerialNumbers, serial)
		}
	}
	if in.MoisturePct != nil {
		if _, err := uow.Exec(ctx, `UPDATE harvest_lots SET bottling_moisture_pct=$2 WHERE id=$1`, in.HarvestLotID, in.MoisturePct); err != nil {
			return out, wrapDB(op, err)
		}
	}
	return out, nil
}

type RecordBatchInput struct {
	BatchID           uuid.UUID
	Kind              string
	ProductID         uuid.UUID
	HarvestLotID      *uuid.UUID
	StartedAt         time.Time
	FinishedAt        *time.Time
	HoneyLbs          *float64
	WaterLiters       *float64
	Yeast, Vessel     *string
	PropolisHarvestID *uuid.UUID
	PropolisAmount    *float64
	PropolisUnit      *string
	QuantityOut       int
	Notes             *string
	ExpenseIDs        []uuid.UUID
}
type RecordBatchResult struct {
	ID uuid.UUID `json:"id"`
}

func RecordBatch(ctx context.Context, uow *app.UnitOfWork, in RecordBatchInput) (RecordBatchResult, error) {
	const op = "record product batch"
	out := RecordBatchResult{ID: in.BatchID}
	if in.BatchID == uuid.Nil || in.ProductID == uuid.Nil || in.StartedAt.IsZero() || in.QuantityOut <= 0 {
		return out, app.Invalid(op, "batch, product, start date, and positive quantity are required")
	}
	var kind string
	if err := uow.QueryRow(ctx, `SELECT kind FROM product_catalog WHERE id=$1 FOR UPDATE`, in.ProductID).Scan(&kind); errors.Is(err, pgx.ErrNoRows) {
		return out, app.NotFound(op, "invalid product")
	} else if err != nil {
		return out, wrapDB(op, err)
	}
	if kind != in.Kind {
		return out, app.Invalid(op, "batch kind must match the catalog product")
	}
	if in.HoneyLbs != nil && *in.HoneyLbs > 0 {
		if _, err := uow.Exec(ctx, `SELECT pg_advisory_xact_lock($1)`, bulkAdvisoryLockKey); err != nil {
			return out, wrapDB(op, err)
		}
	}
	if len(in.ExpenseIDs) > 0 {
		var n int
		if err := uow.QueryRow(ctx, `SELECT COUNT(*)::int FROM expenses WHERE id=ANY($1) AND deleted_at IS NULL`, in.ExpenseIDs).Scan(&n); err != nil {
			return out, wrapDB(op, err)
		}
		if n != len(uniqueUUIDs(in.ExpenseIDs)) {
			return out, app.NotFound(op, "invalid expense")
		}
	}
	if in.HarvestLotID != nil {
		if refusal, until, err := lotRefusal(ctx, uow, *in.HarvestLotID, in.StartedAt); err != nil {
			return out, err
		} else if refusal != "" {
			if until != nil {
				return out, app.Conflict(op, "%s (locked out until %s)", refusal, until.Format("2006-01-02"))
			}
			return out, app.Conflict(op, "%s", refusal)
		}
	}
	if _, err := uow.Exec(ctx, `INSERT INTO product_batches(id,kind,product_id,harvest_lot_id,started_at,finished_at,honey_lbs,water_liters,yeast,vessel,propolis_harvest_id,propolis_amount,propolis_unit,quantity_out,notes,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`, in.BatchID, in.Kind, in.ProductID, in.HarvestLotID, in.StartedAt, in.FinishedAt, in.HoneyLbs, in.WaterLiters, trim(in.Yeast), trim(in.Vessel), in.PropolisHarvestID, in.PropolisAmount, in.PropolisUnit, in.QuantityOut, trim(in.Notes), actorValue(uow)); err != nil {
		return out, classifyCommandDB(op, err)
	}
	for _, id := range in.ExpenseIDs {
		if _, err := uow.Exec(ctx, `INSERT INTO product_batch_expenses(batch_id,expense_id) VALUES($1,$2)`, in.BatchID, id); err != nil {
			return out, classifyCommandDB(op, err)
		}
	}
	honey := 0.0
	if in.HoneyLbs != nil {
		honey = *in.HoneyLbs
	}
	propolis := 0.0
	if in.PropolisAmount != nil && in.PropolisUnit != nil {
		propolis = *in.PropolisAmount
		if *in.PropolisUnit == "ounces" {
			propolis *= 28.349523125
		}
	}
	if _, err := New().RecordBatch(ctx, uow, BatchInput{BatchID: in.BatchID, ProductID: in.ProductID, HarvestLotID: in.HarvestLotID, HoneyLbs: honey, PropolisHarvestID: in.PropolisHarvestID, PropolisGrams: propolis, QuantityOut: in.QuantityOut, Date: in.StartedAt, Notes: trim(in.Notes)}); err != nil {
		return out, err
	}
	return out, nil
}

func lockLotBalance(ctx context.Context, uow *app.UnitOfWork, id uuid.UUID) (string, float64, error) {
	var code string
	if err := uow.QueryRow(ctx, `SELECT lot_code FROM harvest_lots WHERE id=$1 FOR UPDATE`, id).Scan(&code); errors.Is(err, pgx.ErrNoRows) {
		return "", 0, app.NotFound("lock harvest lot", "invalid harvest lot")
	} else if err != nil {
		return "", 0, wrapDB("lock harvest lot", err)
	}
	var available float64
	if err := uow.QueryRow(ctx, `SELECT COALESCE(SUM(a.available),0)::float8 FROM harvest_lots hl LEFT JOIN inventory_available a ON a.lot_id=hl.inventory_lot_id AND a.item_id=$2 WHERE hl.id=$1`, id, HoneyBulkItemID).Scan(&available); err != nil {
		return "", 0, wrapDB("read lot availability", err)
	}
	return code, available, nil
}
func lotRefusal(ctx context.Context, uow *app.UnitOfWork, id uuid.UUID, asOf time.Time) (string, *time.Time, error) {
	var treatmentOn bool
	var until *time.Time
	var product *string
	err := uow.QueryRow(ctx, `WITH source AS(SELECT t.product,t.date_removed,t.withdrawal_days FROM harvest_lot_harvests l JOIN honey_harvests h ON h.id=l.harvest_id AND h.deleted_at IS NULL JOIN treatment_events t ON t.hive_id=h.hive_id AND t.deleted_at IS NULL AND t.date_applied::date<=h.date::date WHERE l.lot_id=$1), locked AS(SELECT * FROM source WHERE date_removed IS NULL OR $2::date<(date_removed::date+withdrawal_days)) SELECT COALESCE(BOOL_OR(date_removed IS NULL),false),MAX((date_removed::date+withdrawal_days)) FILTER(WHERE date_removed IS NOT NULL),MIN(product) FROM locked`, id, asOf).Scan(&treatmentOn, &until, &product)
	if err != nil {
		return "", nil, wrapDB("read lot lockout", err)
	}
	if !treatmentOn && until == nil {
		return "", nil, nil
	}
	name := "treatment"
	if product != nil && strings.TrimSpace(*product) != "" {
		name = *product
	}
	if treatmentOn {
		return "This honey cannot be bottled or sold until " + name + " is removed", nil, nil
	}
	return "This honey cannot be bottled or sold until the withdrawal window ends", until, nil
}

// LotRefusal exposes the production withdrawal guard to sales commands. The
// explanation is returned before a command attempts the stock mutation.
func LotRefusal(ctx context.Context, uow *app.UnitOfWork, id uuid.UUID, asOf time.Time) (string, *time.Time, error) {
	return lotRefusal(ctx, uow, id, asOf)
}
func uniqueUUIDs(ids []uuid.UUID) []uuid.UUID {
	set := map[uuid.UUID]struct{}{}
	for _, id := range ids {
		set[id] = struct{}{}
	}
	out := make([]uuid.UUID, 0, len(set))
	for id := range set {
		out = append(out, id)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].String() < out[j].String() })
	return out
}
func actorValue(uow *app.UnitOfWork) any {
	if id := uow.Actor().AuditUserID(); id != uuid.Nil {
		return id
	}
	return nil
}
func trim(v *string) *string {
	if v == nil {
		return nil
	}
	s := strings.TrimSpace(*v)
	if s == "" {
		return nil
	}
	return &s
}
func classifyCommandDB(op string, err error) error {
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) {
		switch pgErr.Code {
		case "23505":
			return app.Conflict(op, "a record with the same value already exists")
		case "23503":
			return app.NotFound(op, "a referenced record does not exist")
		case "23514", "23502":
			return app.Invalid(op, "the database rejected a value")
		}
	}
	return wrapDB(op, err)
}
