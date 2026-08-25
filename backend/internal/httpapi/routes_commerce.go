package httpapi

import (
	"context"
	"errors"
	"fmt"
	"math"
	"net/http"
	"net/mail"
	"net/url"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	qrcode "github.com/skip2/go-qrcode"
)

func (s *Server) mountCommerce(r chi.Router) {
	admin := r.With(s.requireAdmin)
	admin.Get("/harvest-lots", s.harvestLotList)
	admin.Post("/harvest-lots", s.harvestLotCreate)
	admin.Get("/harvest-lots/{id}", s.harvestLotGet)
	admin.Patch("/harvest-lots/{id}", s.harvestLotUpdate)
	admin.Post("/harvest-lots/{id}/bottling-runs", s.bottlingRunCreate)
	admin.Post("/bottling-runs/{id}/void", s.bottlingRunVoid)
	admin.Get("/harvest-lots/{id}/qr", s.harvestLotQR)

	admin.Get("/expenses", s.expenseList)
	admin.Post("/expenses", s.expenseCreate)
	// Soft-deletes; see expenseDelete.
	admin.Delete("/expenses/{id}", s.expenseDelete)
	admin.Get("/customers", s.customerList)
	admin.Post("/customers", s.customerCreate)
	admin.Patch("/customers/{id}", s.customerUpdate)
	admin.Get("/wholesale-price-lists", s.priceListList)
	admin.Post("/wholesale-price-lists", s.priceListCreate)

	admin.Get("/analytics/profitability", s.profitabilityAnalytics)
	admin.Get("/analytics/economics", s.economicsAnalytics)
	admin.Get("/honey/production-plan", s.productionPlan)
	admin.Get("/honey/low-stock", s.lowStockAlerts)
	admin.Get("/market-day/reconciliation", s.marketDayReconciliation)
	admin.Get("/honey/sales/{id}/receipt", s.saleReceipt)
	admin.Get("/sales/{id}/receipt", s.saleReceipt)
	s.mountSerials(admin)
}

// maxSerializedBottlingQuantity is the per-request cap on serialize:true
// quantity. Each unit is a DB insert plus a serial in the response.
const maxSerializedBottlingQuantity = 500

func (s *Server) mountPublicCommerce(r chi.Router) {
	r.Get("/public/honey-stories/{slug}", s.publicHoneyStory)
	r.Get("/public/honey-stories/{slug}/qr", s.publicHoneyStoryQR)
	r.Get("/public/honey-stories/{slug}/photos/{photoId}", s.publicHoneyStoryPhoto)
	r.With(throttleMiddleware(publicPostThrottle)).
		Post("/public/honey-stories/{slug}/subscribe", s.publicHoneyStorySubscribe)
}

var slugCleaner = regexp.MustCompile(`[^a-z0-9]+`)

func commerceSlug(value string) string {
	slug := strings.Trim(slugCleaner.ReplaceAllString(strings.ToLower(strings.TrimSpace(value)), "-"), "-")
	if slug == "" {
		return uuid.NewString()
	}
	return slug
}

func commerceOptionalHTTPURL(value *string) (*string, error) {
	trimmed := honeyTrimPtr(value)
	if trimmed == nil {
		return nil, nil
	}
	parsed, err := url.ParseRequestURI(*trimmed)
	if err != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") || parsed.Host == "" {
		return nil, fmt.Errorf("URL must use http or https")
	}
	return trimmed, nil
}

type harvestLotPayload struct {
	LotCode        string `json:"lotCode"`
	PublicSlug     string `json:"publicSlug"`
	ExtractionDate string `json:"extractionDate"`
	// Pointer so "no weight supplied" is distinguishable from an explicit 0:
	// with linked harvests, omitting it means "derive it".
	HoneyWeightLbs     *float64 `json:"honeyWeightLbs"`
	HoneyWeightEntered *string  `json:"honeyWeightEntered"`
	// HoneyWeightSource lets the client ask for a derivation explicitly
	// ("derived") or pin the typed number ("manual"). Omitted = infer.
	HoneyWeightSource   *string        `json:"honeyWeightSource"`
	HoneyVariety        *string        `json:"honeyVariety"`
	Season              *string        `json:"season"`
	ApiaryRegion        *string        `json:"apiaryRegion"`
	BloomNotes          *string        `json:"bloomNotes"`
	BeekeeperStory      *string        `json:"beekeeperStory"`
	TestingData         map[string]any `json:"testingData"`
	ReorderURL          *string        `json:"reorderUrl"`
	IsPublic            *bool          `json:"isPublic"`
	HarvestIDs          []uuid.UUID    `json:"harvestIds"`
	PhotoIDs            []uuid.UUID    `json:"photoIds"`
	MoisturePct         *float64       `json:"moisturePct"`
	BottlingMoisturePct *float64       `json:"bottlingMoisturePct"`
	ClaimSpecies        *string        `json:"claimSpecies"`
	ClaimYear           *int           `json:"claimYear"`
	ClaimApiaryID       *uuid.UUID     `json:"claimApiaryId"`
	ClaimElevationM     *float64       `json:"claimElevationM"`
	moistureOverrideReq
}

type harvestLotRow struct {
	ID                 uuid.UUID `json:"id"`
	LotCode            string    `json:"lotCode"`
	PublicSlug         string    `json:"publicSlug"`
	ExtractionDate     time.Time `json:"extractionDate"`
	HoneyWeightLbs     float64   `json:"honeyWeightLbs"`
	HoneyWeightEntered *string   `json:"honeyWeightEntered"`
	// HoneyWeightSource is 'manual' (operator typed it) or 'derived' (summed
	// from the linked harvests). DerivedWeightLbs and LinkedHarvestCount are
	// reported either way so the UI can show what the derivation would be.
	HoneyWeightSource   string         `json:"honeyWeightSource"`
	DerivedWeightLbs    float64        `json:"derivedWeightLbs"`
	LinkedHarvestCount  int            `json:"linkedHarvestCount"`
	HoneyVariety        *string        `json:"honeyVariety"`
	Season              *string        `json:"season"`
	ApiaryRegion        *string        `json:"apiaryRegion"`
	BloomNotes          *string        `json:"bloomNotes"`
	BeekeeperStory      *string        `json:"beekeeperStory"`
	TestingData         map[string]any `json:"testingData"`
	ReorderURL          *string        `json:"reorderUrl"`
	IsPublic            bool           `json:"isPublic"`
	MoisturePct         *float64       `json:"moisturePct"`
	BottlingMoisturePct *float64       `json:"bottlingMoisturePct"`
	// Read-only record of an accepted over-threshold reading.
	MoistureOverrideReason *string          `json:"moistureOverrideReason"`
	MoistureOverrideAt     *time.Time       `json:"moistureOverrideAt"`
	ClaimSpecies           *string          `json:"claimSpecies"`
	ClaimYear              *int             `json:"claimYear"`
	ClaimApiaryID          *uuid.UUID       `json:"claimApiaryId"`
	ClaimApiaryName        *string          `json:"claimApiaryName"`
	ClaimElevationM        *float64         `json:"claimElevationM"`
	FloralClaim            string           `json:"floralClaim"`
	Lockout                *hiveLockoutJSON `json:"lockout,omitempty"`
	SourceHarvestIDs       []uuid.UUID      `json:"sourceHarvestIds"`
	SourceApiaries         []string         `json:"sourceApiaries"`
	Photos                 []map[string]any `json:"photos"`
	BottlingRuns           []map[string]any `json:"bottlingRuns"`
	CreatedAt              time.Time        `json:"createdAt"`
	UpdatedAt              time.Time        `json:"updatedAt"`
}

const harvestLotSelect = `
	SELECT lot.id, lot.lot_code, lot.public_slug, lot.extraction_date, lot.honey_weight_lbs,
		lot.honey_weight_entered, lot.honey_weight_source, lot.honey_variety, lot.season, lot.apiary_region, lot.bloom_notes,
		lot.beekeeper_story, COALESCE(lot.testing_data, '{}'::jsonb), lot.reorder_url, lot.is_public,
		lot.moisture_pct, lot.bottling_moisture_pct,
		lot.moisture_override_reason, lot.moisture_override_at,
		lot.claim_species, lot.claim_year, lot.claim_apiary_id, claim_apiary.name, lot.claim_elevation_m,
		lot.created_at, lot.updated_at
	FROM harvest_lots lot
	LEFT JOIN apiaries claim_apiary ON claim_apiary.id = lot.claim_apiary_id`

const metersPerFoot = 0.3048

func operatorUnitsSystem(ctx context.Context, q inspectionQuerier) string {
	var units *string
	if err := q.QueryRow(ctx, `SELECT units FROM user_settings LIMIT 1`).Scan(&units); err != nil {
		return "us"
	}
	if units != nil && (*units == "metric" || *units == "us") {
		return *units
	}
	return "us"
}

func formatClaimElevation(meters float64, units string) string {
	if units == "metric" {
		return strings.TrimRight(strings.TrimRight(strconv.FormatFloat(meters, 'f', 1, 64), "0"), ".") + " m"
	}
	feet := meters / metersPerFoot
	return strings.TrimRight(strings.TrimRight(strconv.FormatFloat(feet, 'f', 0, 64), "0"), ".") + " ft"
}

// formatFloralClaim builds the declared source shared by lot, label, and
// Honey Story, e.g. "Sourwood 2026, Yard B, 2100 ft".
func formatFloralClaim(species *string, year *int, apiaryName *string, elevationM *float64, units string) string {
	head := strings.TrimSpace(ptrString(species))
	if year != nil {
		if head != "" {
			head = fmt.Sprintf("%s %d", head, *year)
		} else {
			head = strconv.Itoa(*year)
		}
	}
	parts := make([]string, 0, 3)
	if head != "" {
		parts = append(parts, head)
	}
	if name := strings.TrimSpace(ptrString(apiaryName)); name != "" {
		parts = append(parts, name)
	}
	if elevationM != nil {
		parts = append(parts, formatClaimElevation(*elevationM, units))
	}
	return strings.Join(parts, ", ")
}

// lotWeightSourceManual / lotWeightSourceDerived are the two values of
// harvest_lots.honey_weight_source (00039).
const (
	lotWeightSourceManual  = "manual"
	lotWeightSourceDerived = "derived"
)

// harvestLotDerivedWeight sums the live harvests a lot is about to be linked
// to. Create and update both replace the link set wholesale, so the requested
// ids — not the rows currently in harvest_lot_harvests — are the input: that
// is what makes a derived lot recompute the moment its harvests change.
func harvestLotDerivedWeight(
	ctx context.Context,
	q inspectionQuerier,
	harvestIDs []uuid.UUID,
) (float64, int, error) {
	if len(harvestIDs) == 0 {
		return 0, 0, nil
	}
	var total float64
	var count int
	err := q.QueryRow(ctx, `
		SELECT COALESCE(SUM(calculated_honey_weight), 0), COUNT(*)
		FROM honey_harvests WHERE id = ANY($1) AND deleted_at IS NULL`,
		harvestIDs).Scan(&total, &count)
	return total, count, err
}

// reconcileDerivedLotsForHarvest keeps derived lots honest when one of the
// harvests behind them is soft-deleted. Called inside the deleting
// transaction, AFTER the harvest row has been marked deleted, so the
// recomputed sum already excludes it.
//
// A derived lot claims to be the sum of its live harvests. Letting a harvest
// vanish without touching the lot leaves that claim false, and if the new sum
// falls under what the lot's runs have already bottled the lot is claiming
// fewer pounds than it demonstrably produced. The delete is refused in that
// case: the operator has to type a manual weight on the lot or void the runs
// first, which is the deliberate act that belongs in the audit trail.
//
// Refusing also preserves treatment-lockout provenance. refuseLotBottling
// walks a lot's linked harvests back to their hives to find the treatment
// covering them; a harvest that disappeared from under an already-bottled lot
// takes its hive — and therefore the withdrawal window that justified or
// blocked those runs — out of that walk, leaving bottled jars whose lockout
// history can no longer be reconstructed. While the lot's runs stand, the
// harvest behind them cannot silently leave.
//
// Manual-weight lots are untouched: their weight was typed, not derived, so a
// harvest leaving the link set changes nothing they assert.
//
// Returns a user-facing refusal ("" when the delete may proceed).
func reconcileDerivedLotsForHarvest(
	ctx context.Context,
	tx pgx.Tx,
	harvestID uuid.UUID,
) (string, error) {
	type lotRecompute struct {
		id      uuid.UUID
		code    string
		derived float64
		bottled float64
	}
	// FOR UPDATE OF l takes the same harvest_lots row lock bottlingRunCreate
	// and harvestLotUpdate take, so a run cannot commit between this read and
	// the UPDATE below. ORDER BY l.id keeps multi-lot deletes in a stable lock
	// order.
	rows, err := tx.Query(ctx, `
		SELECT l.id, l.lot_code,
			COALESCE((SELECT SUM(hh.calculated_honey_weight)
				FROM harvest_lot_harvests link
				JOIN honey_harvests hh
					ON hh.id = link.harvest_id AND hh.deleted_at IS NULL
				WHERE link.lot_id = l.id), 0) AS derived_lbs,
			COALESCE((SELECT SUM(COALESCE(run.honey_lbs,
					run.quantity * COALESCE(size.honey_oz, 0) / 16.0))
				FROM bottling_runs run
				LEFT JOIN jar_sizes size ON size.id = run.jar_size_id
				WHERE run.lot_id = l.id AND run.voided_at IS NULL), 0) AS bottled_lbs
		FROM harvest_lots l
		JOIN harvest_lot_harvests hl ON hl.lot_id = l.id
		WHERE hl.harvest_id = $1 AND l.honey_weight_source = $2
		ORDER BY l.id
		FOR UPDATE OF l`, harvestID, lotWeightSourceDerived)
	if err != nil {
		return "", err
	}
	var lots []lotRecompute
	for rows.Next() {
		var lot lotRecompute
		if err := rows.Scan(&lot.id, &lot.code, &lot.derived, &lot.bottled); err != nil {
			rows.Close()
			return "", err
		}
		lots = append(lots, lot)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return "", err
	}
	for _, lot := range lots {
		if lot.derived < lot.bottled-honeyPoundTolerance {
			return fmt.Sprintf(
				"Lot %s derives its weight from this harvest: without it the lot "+
					"totals %.2f lbs but its bottling runs already used %.2f lbs. "+
					"Type a manual weight on the lot or void those runs first.",
				lot.code, lot.derived, lot.bottled), nil
		}
	}
	for _, lot := range lots {
		if _, err := tx.Exec(ctx,
			`UPDATE harvest_lots SET honey_weight_lbs=$2 WHERE id=$1`,
			lot.id, lot.derived); err != nil {
			return "", err
		}
	}
	return "", nil
}

// resolveLotWeight decides the stored weight and its source.
//
//   - honeyWeightSource:"derived" — always the SUM; refused with no harvests
//     to sum, because an empty derivation is a silent zero-pound lot.
//   - a typed honeyWeightLbs — manual, and honey_weight_entered keeps
//     recording the raw string the operator typed (00026).
//   - neither — derived when the lot has linked harvests, otherwise the old
//     behaviour of an unset weight (0, manual).
//
// entered is returned nil for a derived lot: nothing was typed, so keeping a
// stale sidecar string would misreport how the number was arrived at.
func resolveLotWeight(
	requested *float64,
	source *string,
	entered *string,
	derived float64,
	linked int,
) (weight float64, resolvedSource string, resolvedEntered *string, errMsg string) {
	want := ""
	if source != nil {
		want = strings.TrimSpace(*source)
	}
	if want != "" && want != lotWeightSourceManual && want != lotWeightSourceDerived {
		return 0, "", nil, "honeyWeightSource must be 'manual' or 'derived'"
	}
	if want == lotWeightSourceDerived {
		if linked == 0 {
			return 0, "", nil, "honeyWeightSource 'derived' needs at least one linked harvest"
		}
		return derived, lotWeightSourceDerived, nil, ""
	}
	if want == lotWeightSourceManual || requested != nil {
		if requested == nil {
			return 0, "", nil, "honeyWeightSource 'manual' requires honeyWeightLbs"
		}
		if *requested < 0 {
			return 0, "", nil, "honeyWeightLbs must be non-negative"
		}
		return *requested, lotWeightSourceManual, entered, ""
	}
	if linked > 0 {
		return derived, lotWeightSourceDerived, nil, ""
	}
	return 0, lotWeightSourceManual, entered, ""
}

func ptrString(v *string) string {
	if v == nil {
		return ""
	}
	return *v
}

func resolveLotClaim(req harvestLotPayload) (species *string, year *int, apiaryID *uuid.UUID, elevation *float64, err error) {
	species = honeyTrimPtr(req.ClaimSpecies)
	if req.ClaimYear != nil {
		if *req.ClaimYear < 1900 || *req.ClaimYear > 2100 {
			return nil, nil, nil, nil, errors.New("claimYear must be between 1900 and 2100")
		}
		year = req.ClaimYear
	}
	if req.ClaimApiaryID != nil {
		apiaryID = req.ClaimApiaryID
	}
	if req.ClaimElevationM != nil {
		if *req.ClaimElevationM < -500 || *req.ClaimElevationM > 9000 {
			return nil, nil, nil, nil, errors.New("claimElevationM is out of range")
		}
		elevation = req.ClaimElevationM
	}
	return species, year, apiaryID, elevation, nil
}

// fillClaimElevation copies the yard pin's elevation onto the claim when the
// operator named a yard but did not type an elevation. Elevation stays
// canonical meters; display converts.
func fillClaimElevation(ctx context.Context, q inspectionQuerier, apiaryID *uuid.UUID, elevation *float64) (*float64, error) {
	if elevation != nil || apiaryID == nil {
		return elevation, nil
	}
	var meters *float64
	err := q.QueryRow(ctx, `SELECT elevation_m FROM apiaries WHERE id=$1`, *apiaryID).Scan(&meters)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, errors.New("invalid claimApiaryId")
		}
		return nil, err
	}
	return meters, nil
}

func (s *Server) harvestLotRows(r *http.Request, where string, args ...any) ([]harvestLotRow, error) {
	if s.pool == nil {
		return nil, errors.New("database unavailable")
	}
	units := operatorUnitsSystem(r.Context(), s.pool)
	rows, err := s.pool.Query(r.Context(), harvestLotSelect+" "+where, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]harvestLotRow, 0)
	for rows.Next() {
		var item harvestLotRow
		if err := rows.Scan(&item.ID, &item.LotCode, &item.PublicSlug, &item.ExtractionDate,
			&item.HoneyWeightLbs, &item.HoneyWeightEntered, &item.HoneyWeightSource,
			&item.HoneyVariety, &item.Season,
			&item.ApiaryRegion, &item.BloomNotes, &item.BeekeeperStory, &item.TestingData,
			&item.ReorderURL, &item.IsPublic, &item.MoisturePct, &item.BottlingMoisturePct,
			&item.MoistureOverrideReason, &item.MoistureOverrideAt,
			&item.ClaimSpecies, &item.ClaimYear, &item.ClaimApiaryID, &item.ClaimApiaryName,
			&item.ClaimElevationM, &item.CreatedAt, &item.UpdatedAt); err != nil {
			return nil, err
		}
		item.FloralClaim = formatFloralClaim(item.ClaimSpecies, item.ClaimYear,
			item.ClaimApiaryName, item.ClaimElevationM, units)
		item.SourceHarvestIDs = []uuid.UUID{}
		item.SourceApiaries = []string{}
		item.Photos = []map[string]any{}
		item.BottlingRuns = []map[string]any{}
		out = append(out, item)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	for i := range out {
		if err := s.populateHarvestLot(r, &out[i]); err != nil {
			return nil, err
		}
	}
	return out, nil
}

func (s *Server) populateHarvestLot(r *http.Request, item *harvestLotRow) error {
	// The derivation is reported on every lot, not just derived ones, so the
	// UI can offer "derived from N harvests" as a switch on a manual lot and
	// show the two numbers side by side when they disagree. Same SUM the
	// product and business-report readers use, soft-deleted harvests excluded.
	if err := s.pool.QueryRow(r.Context(), `
		SELECT COALESCE(SUM(hh.calculated_honey_weight), 0), COUNT(*)
		FROM harvest_lot_harvests lhh
		JOIN honey_harvests hh ON hh.id = lhh.harvest_id
		WHERE lhh.lot_id = $1 AND hh.deleted_at IS NULL`, item.ID).
		Scan(&item.DerivedWeightLbs, &item.LinkedHarvestCount); err != nil {
		return err
	}

	sourceRows, err := s.pool.Query(r.Context(), `
		SELECT hh.id, a.name
		FROM harvest_lot_harvests lhh
		JOIN honey_harvests hh ON hh.id = lhh.harvest_id
		JOIN hives h ON h.id = hh.hive_id
		JOIN apiaries a ON a.id = h.apiary_id
		WHERE lhh.lot_id = $1 ORDER BY a.name, hh.date`, item.ID)
	if err != nil {
		return err
	}
	apiarySeen := map[string]bool{}
	for sourceRows.Next() {
		var id uuid.UUID
		var apiary string
		if err := sourceRows.Scan(&id, &apiary); err != nil {
			sourceRows.Close()
			return err
		}
		item.SourceHarvestIDs = append(item.SourceHarvestIDs, id)
		if !apiarySeen[apiary] {
			item.SourceApiaries = append(item.SourceApiaries, apiary)
			apiarySeen[apiary] = true
		}
	}
	sourceRows.Close()

	photoRows, err := s.pool.Query(r.Context(), `
		SELECT p.id,
			COALESCE(
				CASE WHEN p.medium_key IS NOT NULL AND p.medium_key <> ''
					THEN '/api/v1/photos/file/' || p.medium_key END,
				CASE WHEN p.thumbnail_key IS NOT NULL AND p.thumbnail_key <> ''
					THEN '/api/v1/photos/file/' || p.thumbnail_key END,
				'/api/v1/photos/' || p.id::text || '/original'
			),
			p.caption
		FROM harvest_lot_photos lp JOIN photos p ON p.id = lp.photo_id
		WHERE lp.lot_id = $1 ORDER BY lp.sort_order, p.created_at`, item.ID)
	if err != nil {
		return err
	}
	for photoRows.Next() {
		var id uuid.UUID
		var url string
		var caption *string
		if err := photoRows.Scan(&id, &url, &caption); err != nil {
			photoRows.Close()
			return err
		}
		item.Photos = append(item.Photos, map[string]any{"id": id, "url": url, "caption": caption})
	}
	photoRows.Close()

	runRows, err := s.pool.Query(r.Context(), `
		SELECT br.id, br.bottled_date, br.jar_size_id, js.label, br.quantity,
			br.honey_lbs, br.notes, COUNT(serial.id)
		FROM bottling_runs br
		LEFT JOIN jar_sizes js ON js.id = br.jar_size_id
		LEFT JOIN jar_serials serial ON serial.bottling_run_id = br.id
		WHERE br.lot_id = $1 AND br.voided_at IS NULL
		GROUP BY br.id, js.label ORDER BY br.bottled_date DESC`, item.ID)
	if err != nil {
		return err
	}
	for runRows.Next() {
		var id uuid.UUID
		var date time.Time
		var jarSizeID *uuid.UUID
		var label *string
		var quantity int
		var pounds *float64
		var notes *string
		var serialCount int
		if err := runRows.Scan(&id, &date, &jarSizeID, &label, &quantity, &pounds, &notes, &serialCount); err != nil {
			runRows.Close()
			return err
		}
		item.BottlingRuns = append(item.BottlingRuns, map[string]any{
			"id": id, "bottledDate": date, "jarSizeId": jarSizeID, "jarSizeLabel": label,
			"quantity": quantity, "honeyLbs": pounds, "notes": notes, "serialCount": serialCount,
		})
	}
	runRows.Close()
	return runRows.Err()
}

func (s *Server) attachLotLockouts(r *http.Request, items []harvestLotRow) error {
	for i := range items {
		st, err := lotLockoutAsOf(r.Context(), s.pool, items[i].ID, time.Now())
		if err != nil {
			return err
		}
		items[i].Lockout = st.toJSON()
	}
	return nil
}

func (s *Server) harvestLotList(w http.ResponseWriter, r *http.Request) {
	items, err := s.harvestLotRows(r, "ORDER BY lot.extraction_date DESC, lot.lot_code DESC")
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	if err := s.attachLotLockouts(r, items); err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	writeJSON(w, http.StatusOK, items)
}

func (s *Server) harvestLotGet(w http.ResponseWriter, r *http.Request) {
	id, err := uuidParam(r, "id")
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	items, err := s.harvestLotRows(r, "WHERE lot.id = $1", id)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	if len(items) == 0 {
		writeError(w, http.StatusNotFound, "harvest lot not found")
		return
	}
	if err := s.attachLotLockouts(r, items); err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	writeJSON(w, http.StatusOK, items[0])
}

func (s *Server) harvestLotCreate(w http.ResponseWriter, r *http.Request) {
	var req harvestLotPayload
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	date, err := parseDate(req.ExtractionDate)
	if err != nil || strings.TrimSpace(req.LotCode) == "" ||
		(req.HoneyWeightLbs != nil && *req.HoneyWeightLbs < 0) {
		writeError(w, http.StatusBadRequest, "lotCode, extractionDate, and non-negative honeyWeightLbs are required")
		return
	}
	moistureMsg, overrideReason, err := s.refuseLotMoisture(
		r.Context(), req.MoisturePct, req.moistureOverrideReq)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	if moistureMsg != "" {
		writeError(w, http.StatusBadRequest, moistureMsg)
		return
	}
	if msg := validateMoisturePct(req.BottlingMoisturePct); msg != "" {
		writeError(w, http.StatusBadRequest, msg)
		return
	}
	public := true
	if req.IsPublic != nil {
		public = *req.IsPublic
	}
	reorderURL, err := commerceOptionalHTTPURL(req.ReorderURL)
	if err != nil {
		writeError(w, http.StatusBadRequest, "reorderUrl must be an http or https URL")
		return
	}
	claimSpecies, claimYear, claimApiaryID, claimElevation, err := resolveLotClaim(req)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	slug := commerceSlug(req.PublicSlug)
	if strings.TrimSpace(req.PublicSlug) == "" {
		slug = commerceSlug(req.LotCode)
	}
	tx, err := s.pool.Begin(r.Context())
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	defer tx.Rollback(r.Context())
	claimElevation, err = fillClaimElevation(r.Context(), tx, claimApiaryID, claimElevation)
	if err != nil {
		if err.Error() == "invalid claimApiaryId" {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	derivedLbs, linkedHarvests, err := harvestLotDerivedWeight(r.Context(), tx, req.HarvestIDs)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	weightLbs, weightSource, weightEntered, weightMsg := resolveLotWeight(
		req.HoneyWeightLbs, req.HoneyWeightSource, honeyTrimPtr(req.HoneyWeightEntered),
		derivedLbs, linkedHarvests)
	if weightMsg != "" {
		writeError(w, http.StatusBadRequest, weightMsg)
		return
	}
	var id uuid.UUID
	err = tx.QueryRow(r.Context(), `
		INSERT INTO harvest_lots
			(lot_code, public_slug, extraction_date, honey_weight_lbs, honey_weight_entered,
			 honey_weight_source,
			 honey_variety, season, apiary_region, bloom_notes, beekeeper_story, testing_data,
			 reorder_url, is_public, moisture_pct, bottling_moisture_pct,
			 claim_species, claim_year, claim_apiary_id, claim_elevation_m, created_by)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21) RETURNING id`,
		strings.TrimSpace(req.LotCode), slug, date, weightLbs,
		weightEntered, weightSource,
		honeyTrimPtr(req.HoneyVariety), honeyTrimPtr(req.Season),
		honeyTrimPtr(req.ApiaryRegion), honeyTrimPtr(req.BloomNotes),
		honeyTrimPtr(req.BeekeeperStory), req.TestingData,
		reorderURL, public, req.MoisturePct, req.BottlingMoisturePct,
		claimSpecies, claimYear, claimApiaryID, claimElevation, actorID(r)).Scan(&id)
	if err != nil {
		writeDBError(w, err, "lot code or public slug already exists",
			"invalid reference")
		return
	}
	if err := stampMoistureOverride(r.Context(), tx, id, overrideReason, actorID(r)); err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	for _, harvestID := range req.HarvestIDs {
		if _, err := tx.Exec(r.Context(), `
			INSERT INTO harvest_lot_harvests (lot_id, harvest_id) VALUES ($1, $2)`,
			id, harvestID); err != nil {
			writeDBError(w, err, "duplicate harvestId", "invalid harvestId")
			return
		}
	}
	for i, photoID := range req.PhotoIDs {
		if _, err := tx.Exec(r.Context(), `
			INSERT INTO harvest_lot_photos (lot_id, photo_id, sort_order) VALUES ($1, $2, $3)`,
			id, photoID, i); err != nil {
			writeDBError(w, err, "duplicate photoId", "invalid photoId")
			return
		}
	}
	if err := tx.Commit(r.Context()); err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{
		"id": id, "publicSlug": slug,
		"storyUrl": strings.TrimRight(s.cfg.AppURL, "/") + "/honey/" + slug,
	})
}

func (s *Server) harvestLotUpdate(w http.ResponseWriter, r *http.Request) {
	id, err := uuidParam(r, "id")
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	var req harvestLotPayload
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	date, err := parseDate(req.ExtractionDate)
	if err != nil || strings.TrimSpace(req.LotCode) == "" ||
		(req.HoneyWeightLbs != nil && *req.HoneyWeightLbs < 0) {
		writeError(w, http.StatusBadRequest, "lotCode, extractionDate, and non-negative honeyWeightLbs are required")
		return
	}
	moistureMsg, overrideReason, err := s.refuseLotMoisture(
		r.Context(), req.MoisturePct, req.moistureOverrideReq)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	if moistureMsg != "" {
		writeError(w, http.StatusBadRequest, moistureMsg)
		return
	}
	if msg := validateMoisturePct(req.BottlingMoisturePct); msg != "" {
		writeError(w, http.StatusBadRequest, msg)
		return
	}
	public := true
	if req.IsPublic != nil {
		public = *req.IsPublic
	}
	reorderURL, err := commerceOptionalHTTPURL(req.ReorderURL)
	if err != nil {
		writeError(w, http.StatusBadRequest, "reorderUrl must be an http or https URL")
		return
	}
	claimSpecies, claimYear, claimApiaryID, claimElevation, err := resolveLotClaim(req)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	slug := commerceSlug(req.PublicSlug)
	tx, err := s.pool.Begin(r.Context())
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	defer tx.Rollback(r.Context())
	// Lock the lot row FIRST, before anything is read off it. The bottled
	// total below and the UPDATE that acts on it have to be one atomic step:
	// without this, a bottling run committing between the two stores a derived
	// weight lower than the pounds live runs have already taken out of the lot,
	// and every later run 400s on a ceiling that was never really there.
	// bottlingRunCreate takes the same lock on the same row first, so both
	// paths order their locks identically and neither can deadlock the other.
	var lockedLotCode string
	if err := tx.QueryRow(r.Context(),
		`SELECT lot_code FROM harvest_lots WHERE id=$1 FOR UPDATE`, id).
		Scan(&lockedLotCode); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			writeError(w, http.StatusNotFound, "harvest lot not found")
			return
		}
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	claimElevation, err = fillClaimElevation(r.Context(), tx, claimApiaryID, claimElevation)
	if err != nil {
		if err.Error() == "invalid claimApiaryId" {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	derivedLbs, linkedHarvests, err := harvestLotDerivedWeight(r.Context(), tx, req.HarvestIDs)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	// req.HarvestIDs replaces the link set wholesale below, so a derived lot
	// whose harvests were added, dropped, or soft-deleted picks up the new sum
	// on this same update — the weight can never drift from its sources.
	weightLbs, weightSource, weightEntered, weightMsg := resolveLotWeight(
		req.HoneyWeightLbs, req.HoneyWeightSource, honeyTrimPtr(req.HoneyWeightEntered),
		derivedLbs, linkedHarvests)
	if weightMsg != "" {
		writeError(w, http.StatusBadRequest, weightMsg)
		return
	}
	// The lot's weight cannot drop below what its runs already bottled —
	// existing runs would exceed capacity and every future run would 400.
	var alreadyBottledLbs float64
	if err := tx.QueryRow(r.Context(), `
		SELECT COALESCE(SUM(COALESCE(run.honey_lbs,
			run.quantity * COALESCE(size.honey_oz, 0) / 16.0)), 0)
		FROM bottling_runs run
		LEFT JOIN jar_sizes size ON size.id = run.jar_size_id
		WHERE run.lot_id = $1 AND run.voided_at IS NULL`, id).Scan(&alreadyBottledLbs); err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	if weightLbs < alreadyBottledLbs-honeyPoundTolerance {
		if weightSource == lotWeightSourceDerived {
			writeError(w, http.StatusBadRequest, fmt.Sprintf(
				"The linked harvests total %.2f lbs but this lot's bottling runs already used %.2f lbs; "+
					"fix the harvests or type a manual weight",
				weightLbs, alreadyBottledLbs))
			return
		}
		writeError(w, http.StatusBadRequest, fmt.Sprintf(
			"Lot weight cannot be below the %.2f lbs its bottling runs already used",
			alreadyBottledLbs))
		return
	}
	// The row has been held FOR UPDATE since the top of this transaction, so
	// the bottled total read above is still current and the row still exists.
	_, err = tx.Exec(r.Context(), `
		UPDATE harvest_lots SET lot_code=$1, public_slug=$2, extraction_date=$3,
			honey_weight_lbs=$4, honey_weight_entered=$5, honey_variety=$6, season=$7,
			apiary_region=$8, bloom_notes=$9, beekeeper_story=$10, testing_data=$11,
			reorder_url=$12, is_public=$13, moisture_pct=$14, bottling_moisture_pct=$15,
			claim_species=$16, claim_year=$17, claim_apiary_id=$18, claim_elevation_m=$19,
			honey_weight_source=$21
		WHERE id=$20`,
		strings.TrimSpace(req.LotCode), slug, date, weightLbs,
		weightEntered,
		honeyTrimPtr(req.HoneyVariety), honeyTrimPtr(req.Season),
		honeyTrimPtr(req.ApiaryRegion), honeyTrimPtr(req.BloomNotes),
		honeyTrimPtr(req.BeekeeperStory), req.TestingData,
		reorderURL, public, req.MoisturePct, req.BottlingMoisturePct,
		claimSpecies, claimYear, claimApiaryID, claimElevation, id, weightSource)
	if err != nil {
		writeDBError(w, err, "lot code or public slug already exists",
			"invalid reference")
		return
	}
	// nil reason (reading within threshold) clears any previous override, so a
	// corrected reading does not leave a stale justification behind.
	if err := stampMoistureOverride(r.Context(), tx, id, overrideReason, actorID(r)); err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	if _, err := tx.Exec(r.Context(), `DELETE FROM harvest_lot_harvests WHERE lot_id=$1`, id); err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	if _, err := tx.Exec(r.Context(), `DELETE FROM harvest_lot_photos WHERE lot_id=$1`, id); err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	for _, harvestID := range req.HarvestIDs {
		if _, err := tx.Exec(r.Context(), `INSERT INTO harvest_lot_harvests VALUES ($1,$2)`, id, harvestID); err != nil {
			writeDBError(w, err, "duplicate harvestId", "invalid harvestId")
			return
		}
	}
	for i, photoID := range req.PhotoIDs {
		if _, err := tx.Exec(r.Context(), `INSERT INTO harvest_lot_photos VALUES ($1,$2,$3)`, id, photoID, i); err != nil {
			writeDBError(w, err, "duplicate photoId", "invalid photoId")
			return
		}
	}
	if err := tx.Commit(r.Context()); err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"success": true})
}

func (s *Server) bottlingRunCreate(w http.ResponseWriter, r *http.Request) {
	lotID, err := uuidParam(r, "id")
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	var req struct {
		BottledDate string     `json:"bottledDate"`
		JarSizeID   *uuid.UUID `json:"jarSizeId"`
		Quantity    int        `json:"quantity"`
		HoneyLbs    *float64   `json:"honeyLbs"`
		Notes       *string    `json:"notes"`
		Serialize   bool       `json:"serialize"`
		MoisturePct *float64   `json:"moisturePct"`
	}
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	date, err := parseDate(req.BottledDate)
	if err != nil || req.Quantity <= 0 || (req.HoneyLbs != nil && *req.HoneyLbs < 0) {
		writeError(w, http.StatusBadRequest, "bottledDate and a positive quantity are required")
		return
	}
	// refuseLotBottling below is evaluated at this date; a forward-dated run
	// would step past the withdrawal window and bottle tainted honey.
	if msg := refuseFutureDate(date, "bottledDate"); msg != "" {
		writeError(w, http.StatusUnprocessableEntity, msg)
		return
	}
	// Serialized runs insert one jar_serials row per unit and accumulate every
	// serial in the response, all inside one transaction. Bound that loop.
	if req.Serialize && req.Quantity > maxSerializedBottlingQuantity {
		writeError(w, http.StatusBadRequest, fmt.Sprintf(
			"serialized quantity cannot exceed %d", maxSerializedBottlingQuantity))
		return
	}
	// A run with no jar size used to create no inventory movement at all: the
	// jars showed on the lot page and nowhere in inventory. Rejecting is the
	// only honest option — the jars have to land in a size to be counted.
	if req.JarSizeID == nil {
		writeError(w, http.StatusBadRequest,
			"jarSizeId is required so the bottled jars enter inventory")
		return
	}
	if msg := validateMoisturePct(req.MoisturePct); msg != "" {
		writeError(w, http.StatusBadRequest, msg)
		return
	}

	ctx := r.Context()
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	defer tx.Rollback(ctx)

	var lotCode string
	var lotWeightLbs float64
	if err := tx.QueryRow(ctx,
		`SELECT lot_code, honey_weight_lbs FROM harvest_lots WHERE id=$1 FOR UPDATE`, lotID).
		Scan(&lotCode, &lotWeightLbs); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			writeError(w, http.StatusBadRequest, "invalid harvest lot")
			return
		}
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}

	// Jar lines are not traced back to a lot, so the bottling run is the last
	// point where a withdrawal window can still be enforced. Same rule
	// refuseLotSale applies to sales.
	if msg, err := refuseLotBottling(ctx, tx, lotID, lotCode, date); err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	} else if msg != "" {
		writeError(w, http.StatusConflict, msg)
		return
	}

	// Pounds this run consumes. When honeyLbs is omitted it is derived from the
	// jar size, using the same oz/16 rule as jarring.
	var honeyOz *float64
	if err := tx.QueryRow(ctx, `SELECT honey_oz FROM jar_sizes WHERE id=$1`, *req.JarSizeID).
		Scan(&honeyOz); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			writeError(w, http.StatusBadRequest, "invalid jar size")
			return
		}
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	runLbs := 0.0
	switch {
	case req.HoneyLbs != nil:
		runLbs = *req.HoneyLbs
	case honeyOz != nil:
		runLbs = *honeyOz * float64(req.Quantity) / 16
	}

	// A run cannot bottle more than its lot yielded, and cannot bottle honey
	// that is not in the bulk pool.
	var alreadyBottledLbs float64
	if err := tx.QueryRow(ctx, `
		SELECT COALESCE(SUM(COALESCE(run.honey_lbs,
			run.quantity * COALESCE(size.honey_oz, 0) / 16.0)), 0)
		FROM bottling_runs run
		LEFT JOIN jar_sizes size ON size.id = run.jar_size_id
		WHERE run.lot_id = $1 AND run.voided_at IS NULL`, lotID).Scan(&alreadyBottledLbs); err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	if alreadyBottledLbs+runLbs > lotWeightLbs+honeyPoundTolerance {
		writeError(w, http.StatusBadRequest, fmt.Sprintf(
			"Lot %s holds %.2f lbs; %.2f lbs are already bottled and this run needs %.2f lbs",
			lotCode, lotWeightLbs, alreadyBottledLbs, runLbs))
		return
	}
	bulk, err := honeyLockBulk(ctx, tx)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	if message := honeyBulkShortfall(runLbs, bulk.BulkOnHandLbs); message != "" {
		writeError(w, http.StatusBadRequest, message)
		return
	}

	actor := actorID(r)
	var runID uuid.UUID
	err = tx.QueryRow(ctx, `
		INSERT INTO bottling_runs (lot_id, bottled_date, jar_size_id, quantity, honey_lbs, notes, created_by)
		VALUES ($1, $2, $3, $4, $5, $6, $7)
		RETURNING id`, lotID, date, req.JarSizeID, req.Quantity, req.HoneyLbs,
		honeyTrimPtr(req.Notes), actor).Scan(&runID)
	if err != nil {
		writeDBError(w, err, "duplicate bottling run",
			"invalid harvest lot or jar size")
		return
	}
	// bottling_run_id is a real foreign key now. The old link was the text
	// reason "bottling run LOT-CODE", which nothing enforced.
	if _, err := tx.Exec(ctx, `
		INSERT INTO honey_movements
			(date, kind, jar_size_id, quantity, amount_lbs, reason, notes, bottling_run_id, created_by)
		VALUES ($1, 'jarring', $2, $3, $4, $5, $6, $7, $8)`,
		date, req.JarSizeID, req.Quantity, runLbs,
		"bottling run "+lotCode, honeyTrimPtr(req.Notes), runID, actor); err != nil {
		writeDBError(w, err, "duplicate movement", "invalid jar size")
		return
	}
	serials := make([]string, 0)
	if req.Serialize {
		for i := 1; i <= req.Quantity; i++ {
			serial := fmt.Sprintf(
				"%s-%s-%s-%04d",
				lotCode,
				date.Format("20060102"),
				strings.ToUpper(strings.ReplaceAll(runID.String()[:6], "-", "")),
				i,
			)
			if _, err := tx.Exec(r.Context(), `
				INSERT INTO jar_serials (bottling_run_id, serial_number) VALUES ($1,$2)`,
				runID, serial); err != nil {
				writeError(w, http.StatusConflict, "serial numbers already exist for this lot and date")
				return
			}
			serials = append(serials, serial)
		}
	}
	if req.MoisturePct != nil {
		if _, err := tx.Exec(ctx, `
			UPDATE harvest_lots SET bottling_moisture_pct = $2 WHERE id = $1`,
			lotID, req.MoisturePct); err != nil {
			writeError(w, http.StatusInternalServerError, "database error")
			return
		}
	}
	if err := tx.Commit(r.Context()); err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"id": runID, "serialNumbers": serials})
}

// POST /bottling-runs/{id}/void — undo a bottling run.
//
// A run-linked honey_movement refuses reversal on its own (409): reversing it
// alone would leave the run, its serials, and the lot's bottled total claiming
// jars the ledger no longer has. Voiding is the whole-unit operation — it
// reverses every movement the run created, drops the run's serials, and marks
// the run voided in one transaction, so the ledger and the lot agree at every
// commit boundary.
func (s *Server) bottlingRunVoid(w http.ResponseWriter, r *http.Request) {
	runID, err := uuidParam(r, "id")
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	var req struct {
		Reason *string `json:"reason"`
	}
	_ = decodeJSON(r, &req)

	ctx := r.Context()
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	defer tx.Rollback(ctx)

	var voidedAt *time.Time
	if err := tx.QueryRow(ctx,
		`SELECT voided_at FROM bottling_runs WHERE id=$1 FOR UPDATE`, runID).
		Scan(&voidedAt); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			writeError(w, http.StatusNotFound, "bottling run not found")
			return
		}
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	if voidedAt != nil {
		writeError(w, http.StatusConflict, "this bottling run is already voided")
		return
	}

	// A serial that reached a customer is provenance, not inventory: voiding
	// the run that produced it would erase the jar's chain of custody.
	var soldSerials int
	if err := tx.QueryRow(ctx, `
		SELECT COUNT(*) FROM jar_serials
		WHERE bottling_run_id=$1 AND sale_id IS NOT NULL`, runID).Scan(&soldSerials); err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	if soldSerials > 0 {
		writeError(w, http.StatusConflict,
			"jars from this run have already been sold; cancel those sales first")
		return
	}

	// Only the run's own entries, never a reversal of one, and never one that
	// somehow already carries a reversal.
	rows, err := tx.Query(ctx, `
		SELECT m.id, m.kind, m.amount_lbs, m.quantity, m.jar_size_id, m.reason, m.notes
		FROM honey_movements m
		WHERE m.bottling_run_id=$1 AND m.reverses_movement_id IS NULL
			AND NOT EXISTS (
				SELECT 1 FROM honey_movements rev WHERE rev.reverses_movement_id = m.id)
		ORDER BY m.id
		FOR UPDATE OF m`, runID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	type runMovement struct {
		id        uuid.UUID
		kind      string
		amountLbs *float64
		quantity  *int
		jarSizeID *uuid.UUID
		reason    *string
		notes     *string
	}
	movements := make([]runMovement, 0, 1)
	for rows.Next() {
		var m runMovement
		if err := rows.Scan(&m.id, &m.kind, &m.amountLbs, &m.quantity,
			&m.jarSizeID, &m.reason, &m.notes); err != nil {
			rows.Close()
			writeError(w, http.StatusInternalServerError, "database error")
			return
		}
		movements = append(movements, m)
	}
	rowsErr := rows.Err()
	rows.Close()
	if rowsErr != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}

	// Reversing a jarring entry takes those jars back off the shelf, so the
	// removal has to clear the same availability bar as any other withdrawal.
	needed := make(map[uuid.UUID]int)
	for _, m := range movements {
		if m.jarSizeID != nil && m.quantity != nil && *m.quantity > 0 {
			needed[*m.jarSizeID] += *m.quantity
		}
	}
	if len(needed) > 0 {
		ids := make([]uuid.UUID, 0, len(needed))
		for id := range needed {
			ids = append(ids, id)
		}
		onHand, labels, unknown, lockErr := honeyLockJarSizes(ctx, tx, ids)
		if lockErr != nil {
			writeError(w, http.StatusInternalServerError, "database error")
			return
		}
		if unknown {
			writeError(w, http.StatusInternalServerError, "database error")
			return
		}
		if message := honeyCheckJarAvailability(onHand, labels, needed); message != "" {
			writeError(w, http.StatusConflict, message)
			return
		}
	}

	actor := actorID(r)
	reason := honeyTrimPtr(req.Reason)
	for _, m := range movements {
		reversalReason := "void of bottling run"
		if reason != nil {
			reversalReason = *reason
		} else if m.reason != nil && *m.reason != "" {
			reversalReason += " (" + *m.reason + ")"
		}
		var negatedLbs *float64
		if m.amountLbs != nil {
			v := -*m.amountLbs
			negatedLbs = &v
		}
		var negatedQuantity *int
		if m.quantity != nil {
			v := -*m.quantity
			negatedQuantity = &v
		}
		if _, err := tx.Exec(ctx, `
			INSERT INTO honey_movements
				(date, kind, amount_lbs, jar_size_id, quantity, reason, notes,
				 reverses_movement_id, bottling_run_id, created_by)
			VALUES (now(), $1, $2, $3, $4, $5, $6, $7, $8, $9)`,
			m.kind, negatedLbs, m.jarSizeID, negatedQuantity, reversalReason,
			m.notes, m.id, runID, actor); err != nil {
			writeError(w, http.StatusInternalServerError, "database error")
			return
		}
	}

	// Every remaining serial is unsold (sold ones refused the void above); a
	// voided run's serials must stop resolving or a scan would tell a customer
	// about jars that were never bottled.
	serials, err := tx.Exec(ctx, `DELETE FROM jar_serials WHERE bottling_run_id=$1`, runID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	if _, err := tx.Exec(ctx, `
		UPDATE bottling_runs SET voided_at=now(), voided_by=$2, void_reason=$3
		WHERE id=$1`, runID, actor, reason); err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	if err := tx.Commit(ctx); err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"success": true, "voided": true, "id": runID,
		"reversedMovements": len(movements),
		"removedSerials":    serials.RowsAffected(),
	})
}

func (s *Server) harvestLotQR(w http.ResponseWriter, r *http.Request) {
	id, err := uuidParam(r, "id")
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	var slug string
	if err := s.pool.QueryRow(r.Context(), `SELECT public_slug FROM harvest_lots WHERE id=$1`, id).Scan(&slug); err != nil {
		writeError(w, http.StatusNotFound, "harvest lot not found")
		return
	}
	s.writeHoneyStoryQR(w, slug)
}

func (s *Server) publicHoneyStoryQR(w http.ResponseWriter, r *http.Request) {
	slug := chi.URLParam(r, "slug")
	var exists bool
	if err := s.pool.QueryRow(r.Context(), `
		SELECT EXISTS(SELECT 1 FROM harvest_lots WHERE public_slug=$1 AND is_public)`, slug).Scan(&exists); err != nil || !exists {
		writeError(w, http.StatusNotFound, "honey story not found")
		return
	}
	s.writeHoneyStoryQR(w, slug)
}

func (s *Server) writeHoneyStoryQR(w http.ResponseWriter, slug string) {
	url := strings.TrimRight(s.cfg.AppURL, "/") + "/honey/" + slug
	png, err := qrcode.Encode(url, qrcode.Medium, 512)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "could not generate QR code")
		return
	}
	w.Header().Set("Content-Type", "image/png")
	w.Header().Set("Cache-Control", "public, max-age=86400")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(png)
}

func (s *Server) publicHoneyStory(w http.ResponseWriter, r *http.Request) {
	slug := chi.URLParam(r, "slug")
	rows, err := s.harvestLotRows(r, "WHERE lot.public_slug=$1 AND lot.is_public", slug)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	if len(rows) == 0 {
		writeError(w, http.StatusNotFound, "honey story not found")
		return
	}
	item := rows[0]
	name := item.LotCode
	if item.HoneyVariety != nil {
		name = *item.HoneyVariety
	}
	publicPhotos := make([]map[string]any, 0, len(item.Photos))
	for _, photo := range item.Photos {
		id := fmt.Sprint(photo["id"])
		publicPhotos = append(publicPhotos, map[string]any{
			"id":      photo["id"],
			"url":     "/api/v1/public/honey-stories/" + item.PublicSlug + "/photos/" + id,
			"caption": photo["caption"],
		})
	}
	publicBottlingRuns := make([]map[string]any, 0, len(item.BottlingRuns))
	for _, run := range item.BottlingRuns {
		publicBottlingRuns = append(publicBottlingRuns, map[string]any{
			"bottledDate":  run["bottledDate"],
			"jarSizeLabel": run["jarSizeLabel"],
			"quantity":     run["quantity"],
		})
	}
	floralSource := item.HoneyVariety
	if item.FloralClaim != "" {
		floralSource = &item.FloralClaim
	}
	units := operatorUnitsSystem(r.Context(), s.pool)
	var temperatureUnit *string
	_ = s.pool.QueryRow(r.Context(), `
		SELECT temperature_unit FROM user_settings LIMIT 1`).Scan(&temperatureUnit)
	// Deliberately curated response: no hive IDs, apiary IDs, coordinates,
	// inspection data, expenses, or customer data can cross this boundary.
	// Units are the operator's stored preference so Honey Story does not
	// follow the viewer's locale.
	writeJSON(w, http.StatusOK, map[string]any{
		"slug": item.PublicSlug, "name": name,
		"lotCode": item.LotCode, "season": item.Season,
		"description": item.BloomNotes, "floralSource": floralSource,
		"floralClaim":  item.FloralClaim,
		"claimSpecies": item.ClaimSpecies, "claimYear": item.ClaimYear,
		"claimApiaryName": item.ClaimApiaryName, "claimElevationM": item.ClaimElevationM,
		"apiaryRegion": item.ApiaryRegion, "sourceApiaries": item.SourceApiaries,
		"harvestDate": item.ExtractionDate, "harvestedPounds": item.HoneyWeightLbs,
		"beekeeperNotes": item.BeekeeperStory, "testingData": item.TestingData,
		"reorderUrl": item.ReorderURL, "photos": publicPhotos,
		"bottlingRuns": publicBottlingRuns,
		"units":        units, "temperatureUnit": temperatureUnit,
	})
}

func (s *Server) publicHoneyStoryPhoto(w http.ResponseWriter, r *http.Request) {
	slug := chi.URLParam(r, "slug")
	photoID, err := uuid.Parse(chi.URLParam(r, "photoId"))
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid photoId")
		return
	}
	var (
		backend     string
		ref         string
		originalKey *string
		mediumKey   *string
		thumbKey    *string
	)
	err = s.pool.QueryRow(r.Context(), `
		SELECT p.storage_backend::text, p.original_ref, p.original_key, p.medium_key, p.thumbnail_key
		FROM harvest_lots lot
		JOIN harvest_lot_photos lp ON lp.lot_id=lot.id
		JOIN photos p ON p.id=lp.photo_id
		WHERE lot.public_slug=$1 AND lot.is_public AND p.id=$2`,
		slug, photoID).Scan(&backend, &ref, &originalKey, &mediumKey, &thumbKey)
	if err != nil {
		writeError(w, http.StatusNotFound, "photo not found")
		return
	}
	s.servePhotoPreferred(w, r, backend, ref, originalKey, mediumKey, thumbKey)
}

// honeyStorySignupThrottle caps anonymous customer creation per Honey Story
// slug (SEAM-024). The 5/min/IP throttle in front of this route stops one
// noisy client; it does nothing about a botnet, and every accepted signup
// writes a row to the customer list a beekeeper has to look at. A jar's QR
// code realistically produces a handful of signups a day, so 50 a day per lot
// is far above real use and far below a useful spam run. Process-local and
// fixed-window, like the other throttles.
var honeyStorySignupThrottle = newIPThrottle(50, 24*time.Hour)

func (s *Server) publicHoneyStorySubscribe(w http.ResponseWriter, r *http.Request) {
	slug := chi.URLParam(r, "slug")
	var exists bool
	if err := s.pool.QueryRow(r.Context(), `
		SELECT EXISTS(SELECT 1 FROM harvest_lots WHERE public_slug=$1 AND is_public)`,
		slug).Scan(&exists); err != nil || !exists {
		writeError(w, http.StatusNotFound, "honey story not found")
		return
	}
	var req struct {
		Name       string  `json:"name"`
		Email      string  `json:"email"`
		ReferredBy *string `json:"referredBy"`
	}
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "a valid email is required")
		return
	}
	email := strings.ToLower(strings.TrimSpace(req.Email))
	address, err := mail.ParseAddress(email)
	if err != nil || address.Address != email || len(email) > 254 {
		writeError(w, http.StatusBadRequest, "a valid email is required")
		return
	}
	name := strings.TrimSpace(req.Name)
	if name == "" {
		name = email
	}
	if len(name) > 200 || (req.ReferredBy != nil && len(strings.TrimSpace(*req.ReferredBy)) > 200) {
		writeError(w, http.StatusBadRequest, "name or referral is too long")
		return
	}
	// Charged only once the payload is known good, so malformed spam cannot
	// burn a real visitor's budget for the day.
	if allowed, wait := honeyStorySignupThrottle.take(slug); !allowed {
		w.Header().Set("Retry-After", strconv.Itoa(int(wait.Seconds())+1))
		writeError(w, http.StatusTooManyRequests,
			"this Honey Story has taken too many signups today; try again tomorrow")
		return
	}
	var id uuid.UUID
	referral := strings.ToUpper(uuid.NewString()[:8])
	// An unauthenticated signup must never rewrite an existing customer:
	// name and referred_by feed receipts and sale displays, so on conflict
	// only the opt-in flag may change.
	err = s.pool.QueryRow(r.Context(), `
		INSERT INTO customers (name,email,email_opt_in,referral_code,referred_by)
		VALUES ($1,$2,true,$3,$4)
		ON CONFLICT (lower(email)) WHERE email IS NOT NULL DO UPDATE SET
			email_opt_in=true
		RETURNING id`,
		name, email, referral, honeyTrimPtr(req.ReferredBy)).Scan(&id)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "could not save signup")
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"success": true})
}

var expenseCategories = map[string]bool{
	"bees_queens": true, "feed": true, "treatments": true, "packaging": true,
	"equipment": true, "mileage": true, "market_fees": true, "labor": true,
	"other": true, "grocery": true,
}

func (s *Server) expenseList(w http.ResponseWriter, r *http.Request) {
	year := r.URL.Query().Get("year")
	// Soft-deleted expenses never appear in listings or aggregates.
	query := `
		SELECT e.id, e.expense_date, e.category, e.description, e.amount_cents,
			e.apiary_id, a.name, e.hive_id, h.position_label, e.harvest_lot_id,
			hl.lot_code, e.season, e.vendor, e.quantity, e.unit, e.notes
		FROM expenses e
		LEFT JOIN apiaries a ON a.id=e.apiary_id
		LEFT JOIN hives h ON h.id=e.hive_id
		LEFT JOIN harvest_lots hl ON hl.id=e.harvest_lot_id
		WHERE e.deleted_at IS NULL`
	args := []any{}
	if year != "" {
		y, err := strconv.Atoi(year)
		if err != nil {
			writeError(w, http.StatusBadRequest, "invalid year")
			return
		}
		query += ` AND EXTRACT(YEAR FROM e.expense_date)::integer=$1`
		args = append(args, y)
	}
	query += ` ORDER BY e.expense_date DESC, e.created_at DESC`
	rows, err := s.pool.Query(r.Context(), query, args...)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	defer rows.Close()
	out := make([]map[string]any, 0)
	for rows.Next() {
		var id uuid.UUID
		var date time.Time
		var category, description string
		var amount money
		var apiaryID, hiveID, lotID *uuid.UUID
		var apiaryName, hiveName, lotCode, season, vendor, unit, notes *string
		var quantity *float64
		if err := rows.Scan(&id, &date, &category, &description, &amount,
			&apiaryID, &apiaryName, &hiveID, &hiveName, &lotID, &lotCode,
			&season, &vendor, &quantity, &unit, &notes); err != nil {
			writeError(w, http.StatusInternalServerError, "database error")
			return
		}
		out = append(out, map[string]any{
			"id": id, "expenseDate": date, "category": category, "description": description,
			"amount": amount, "apiaryId": apiaryID, "apiaryName": apiaryName,
			"hiveId": hiveID, "hiveName": hiveName, "harvestLotId": lotID,
			"lotCode": lotCode, "season": season, "vendor": vendor,
			"quantity": quantity, "unit": unit, "notes": notes,
		})
	}
	writeJSON(w, http.StatusOK, out)
}

func (s *Server) expenseCreate(w http.ResponseWriter, r *http.Request) {
	var req struct {
		ExpenseDate  string     `json:"expenseDate"`
		Category     string     `json:"category"`
		Description  string     `json:"description"`
		Amount       money      `json:"amount"`
		ApiaryID     *uuid.UUID `json:"apiaryId"`
		HiveID       *uuid.UUID `json:"hiveId"`
		HarvestLotID *uuid.UUID `json:"harvestLotId"`
		Season       *string    `json:"season"`
		Vendor       *string    `json:"vendor"`
		Quantity     *float64   `json:"quantity"`
		Unit         *string    `json:"unit"`
		Notes        *string    `json:"notes"`
	}
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	date, err := parseDate(req.ExpenseDate)
	if err != nil || !expenseCategories[req.Category] ||
		strings.TrimSpace(req.Description) == "" || req.Amount < 0 {
		writeError(w, http.StatusBadRequest, "date, category, description, and non-negative amount are required")
		return
	}
	var id uuid.UUID
	err = s.pool.QueryRow(r.Context(), `
		INSERT INTO expenses
			(expense_date, category, description, amount_cents, apiary_id, hive_id,
			 harvest_lot_id, season, vendor, quantity, unit, notes, created_by)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id`,
		date, req.Category, strings.TrimSpace(req.Description), req.Amount,
		req.ApiaryID, req.HiveID, req.HarvestLotID, honeyTrimPtr(req.Season),
		honeyTrimPtr(req.Vendor), req.Quantity, honeyTrimPtr(req.Unit),
		honeyTrimPtr(req.Notes), actorID(r)).Scan(&id)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid apiary, hive, or harvest lot")
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"id": id})
}

// DELETE /expenses/{id} SOFT-deletes: the row survives with the actor, the
// time, and an optional reason, and is excluded from every listing and
// aggregate. Deleting an expense used to retroactively change every break-even
// and lot margin for the year with no trace of what changed.
//
// Optional body: {"reason": "..."}.
func (s *Server) expenseDelete(w http.ResponseWriter, r *http.Request) {
	id, err := uuidParam(r, "id")
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	var req struct {
		Reason *string `json:"reason"`
	}
	_ = decodeJSON(r, &req)
	tag, err := s.pool.Exec(r.Context(), `
		UPDATE expenses
		SET deleted_at=now(), deleted_by=$2, deletion_reason=$3
		WHERE id=$1 AND deleted_at IS NULL`,
		id, actorID(r), honeyTrimPtr(req.Reason))
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	if tag.RowsAffected() == 0 {
		writeError(w, http.StatusNotFound, "expense not found")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"success": true, "softDeleted": true})
}

func (s *Server) customerList(w http.ResponseWriter, r *http.Request) {
	rows, err := s.pool.Query(r.Context(), `
		SELECT c.id, c.name, c.email, c.phone, c.notes, c.email_opt_in,
			c.referral_code, c.referred_by, c.created_at,
			COUNT(s.id), COALESCE(SUM(s.total_amount_cents), 0), MAX(s.date)
		FROM customers c
		LEFT JOIN sales s ON s.customer_id=c.id AND s.order_status <> 'cancelled'
		GROUP BY c.id ORDER BY c.name`)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	defer rows.Close()
	out := make([]map[string]any, 0)
	for rows.Next() {
		var id uuid.UUID
		var name string
		var email, phone, notes, referral, referredBy *string
		var optIn bool
		var created time.Time
		var orders int
		var revenue money
		var lastOrder *time.Time
		if err := rows.Scan(&id, &name, &email, &phone, &notes, &optIn,
			&referral, &referredBy, &created, &orders, &revenue, &lastOrder); err != nil {
			writeError(w, http.StatusInternalServerError, "database error")
			return
		}
		out = append(out, map[string]any{
			"id": id, "name": name, "email": email, "phone": phone, "notes": notes,
			"emailOptIn": optIn, "referralCode": referral, "referredBy": referredBy,
			"createdAt": created, "orderCount": orders, "lifetimeRevenue": revenue,
			"lastOrderDate": lastOrder,
			"reorderReminderDue": optIn && lastOrder != nil &&
				lastOrder.Before(time.Now().AddDate(0, 0, -90)),
		})
	}
	writeJSON(w, http.StatusOK, out)
}

type customerPayload struct {
	Name         string  `json:"name"`
	Email        *string `json:"email"`
	Phone        *string `json:"phone"`
	Notes        *string `json:"notes"`
	EmailOptIn   bool    `json:"emailOptIn"`
	ReferralCode *string `json:"referralCode"`
	ReferredBy   *string `json:"referredBy"`
}

func (s *Server) customerCreate(w http.ResponseWriter, r *http.Request) {
	var req customerPayload
	if err := decodeJSON(r, &req); err != nil || strings.TrimSpace(req.Name) == "" {
		writeError(w, http.StatusBadRequest, "name is required")
		return
	}
	referral := honeyTrimPtr(req.ReferralCode)
	if referral == nil {
		v := strings.ToUpper(uuid.NewString()[:8])
		referral = &v
	}
	var id uuid.UUID
	err := s.pool.QueryRow(r.Context(), `
		INSERT INTO customers (name,email,phone,notes,email_opt_in,referral_code,referred_by,created_by)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
		strings.TrimSpace(req.Name), honeyTrimPtr(req.Email), honeyTrimPtr(req.Phone),
		honeyTrimPtr(req.Notes), req.EmailOptIn, referral, honeyTrimPtr(req.ReferredBy),
		actorID(r)).Scan(&id)
	if err != nil {
		writeDBError(w, err, "referral code or email already exists",
			"invalid reference")
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"id": id, "referralCode": referral})
}

func (s *Server) customerUpdate(w http.ResponseWriter, r *http.Request) {
	id, err := uuidParam(r, "id")
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	var req customerPayload
	if err := decodeJSON(r, &req); err != nil || strings.TrimSpace(req.Name) == "" {
		writeError(w, http.StatusBadRequest, "name is required")
		return
	}
	tag, err := s.pool.Exec(r.Context(), `
		UPDATE customers SET name=$1,email=$2,phone=$3,notes=$4,email_opt_in=$5,
			referral_code=$6,referred_by=$7 WHERE id=$8`,
		strings.TrimSpace(req.Name), honeyTrimPtr(req.Email), honeyTrimPtr(req.Phone),
		honeyTrimPtr(req.Notes), req.EmailOptIn, honeyTrimPtr(req.ReferralCode),
		honeyTrimPtr(req.ReferredBy), id)
	if err != nil {
		writeDBError(w, err, "referral code or email already exists",
			"invalid reference")
		return
	}
	if tag.RowsAffected() == 0 {
		writeError(w, http.StatusNotFound, "customer not found")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"success": true})
}

func (s *Server) priceListList(w http.ResponseWriter, r *http.Request) {
	rows, err := s.pool.Query(r.Context(), `
		SELECT p.id, p.name, p.minimum_order_amount_cents, p.is_active,
			COALESCE(jsonb_agg(jsonb_build_object(
				'jarSizeId', i.jar_size_id, 'label', js.label,
				-- The wire format stays in dollars; round to 2dp in SQL so the
				-- JSON aggregate matches what money.MarshalJSON would emit.
				'unitPrice', ROUND(i.unit_price_cents / 100.0, 2)
			) ORDER BY js.sort_order) FILTER (WHERE i.jar_size_id IS NOT NULL), '[]'::jsonb)
		FROM wholesale_price_lists p
		LEFT JOIN wholesale_price_list_items i ON i.price_list_id=p.id
		LEFT JOIN jar_sizes js ON js.id=i.jar_size_id
		GROUP BY p.id ORDER BY p.name`)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	defer rows.Close()
	out := make([]map[string]any, 0)
	for rows.Next() {
		var id uuid.UUID
		var name string
		var minimum money
		var active bool
		var items any
		if err := rows.Scan(&id, &name, &minimum, &active, &items); err != nil {
			writeError(w, http.StatusInternalServerError, "database error")
			return
		}
		out = append(out, map[string]any{"id": id, "name": name, "minimumOrderAmount": minimum, "isActive": active, "items": items})
	}
	writeJSON(w, http.StatusOK, out)
}

func (s *Server) priceListCreate(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Name               string `json:"name"`
		MinimumOrderAmount money  `json:"minimumOrderAmount"`
		Items              []struct {
			JarSizeID uuid.UUID `json:"jarSizeId"`
			UnitPrice money     `json:"unitPrice"`
		} `json:"items"`
	}
	if err := decodeJSON(r, &req); err != nil || strings.TrimSpace(req.Name) == "" || req.MinimumOrderAmount < 0 {
		writeError(w, http.StatusBadRequest, "name and non-negative minimumOrderAmount are required")
		return
	}
	tx, err := s.pool.Begin(r.Context())
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	defer tx.Rollback(r.Context())
	var id uuid.UUID
	if err := tx.QueryRow(r.Context(), `
		INSERT INTO wholesale_price_lists (name,minimum_order_amount_cents,created_by)
		VALUES ($1,$2,$3) RETURNING id`,
		strings.TrimSpace(req.Name), req.MinimumOrderAmount, actorID(r)).Scan(&id); err != nil {
		writeDBError(w, err, "price list name already exists", "invalid reference")
		return
	}
	for _, item := range req.Items {
		if item.JarSizeID == uuid.Nil || item.UnitPrice < 0 {
			writeError(w, http.StatusBadRequest, "each price-list item needs a jarSizeId and non-negative price")
			return
		}
		if _, err := tx.Exec(r.Context(), `
			INSERT INTO wholesale_price_list_items (price_list_id, jar_size_id, unit_price_cents, created_by)
			VALUES ($1,$2,$3,$4)`,
			id, item.JarSizeID, item.UnitPrice, actorID(r)); err != nil {
			writeDBError(w, err, "duplicate jarSizeId", "invalid jarSizeId")
			return
		}
	}
	if err := tx.Commit(r.Context()); err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"id": id})
}

func (s *Server) profitabilityAnalytics(w http.ResponseWriter, r *http.Request) {
	year := requestedYear(r)
	var revenue, collected, expenses, inventoryValue money
	var harvested float64
	var jarsSold int
	err := s.pool.QueryRow(r.Context(), `
		SELECT
			COALESCE((SELECT SUM(total_amount_cents) FROM sales
				WHERE EXTRACT(YEAR FROM date)::integer=$1 AND order_status <> 'cancelled'),0),
			COALESCE((SELECT SUM(amount_paid_cents) FROM sales
				WHERE EXTRACT(YEAR FROM date)::integer=$1 AND order_status <> 'cancelled'),0),
			COALESCE((SELECT SUM(amount_cents) FROM expenses
				WHERE EXTRACT(YEAR FROM expense_date)::integer=$1 AND deleted_at IS NULL),0),
			COALESCE((SELECT SUM(calculated_honey_weight) FROM honey_harvests
				WHERE EXTRACT(YEAR FROM date)::integer=$1 AND deleted_at IS NULL),0),
			COALESCE((SELECT SUM(si.quantity) FROM sale_items si
				JOIN sales s ON s.id=si.sale_id
				WHERE EXTRACT(YEAR FROM s.date)::integer=$1 AND s.order_status <> 'cancelled'
					AND si.kind='jar'),0)`,
		year).Scan(&revenue, &collected, &expenses, &harvested, &jarsSold)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	inventory, err := s.honeyJarInventory(r.Context())
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	breakEven := make([]map[string]any, 0)
	// Per-pound and per-jar costs are ratios, not stored amounts: they stay
	// float dollars, derived from the exact cent totals.
	costPerPound := 0.0
	if harvested > 0 {
		costPerPound = expenses.Dollars() / harvested
	}
	for _, row := range inventory {
		if row.DefaultPrice != nil {
			inventoryValue += row.DefaultPrice.mulQuantity(row.OnHand)
		}
		perJar := 0.0
		if row.HoneyOz != nil {
			perJar = costPerPound * *row.HoneyOz / 16
		}
		breakEven = append(breakEven, map[string]any{
			"jarSizeId": row.JarSizeID, "label": row.Label, "breakEvenPrice": perJar,
			"defaultPrice": row.DefaultPrice, "onHand": row.OnHand,
		})
	}
	channelRows, err := s.pool.Query(r.Context(), `
		SELECT channel, SUM(total_amount_cents), COUNT(*)
		FROM sales WHERE EXTRACT(YEAR FROM date)::integer=$1
			AND order_status <> 'cancelled'
		GROUP BY channel ORDER BY SUM(total_amount_cents) DESC`, year)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	channels := make([]map[string]any, 0)
	for channelRows.Next() {
		var channel string
		var total money
		var count int
		if err := channelRows.Scan(&channel, &total, &count); err != nil {
			channelRows.Close()
			writeError(w, http.StatusInternalServerError, "database error")
			return
		}
		channels = append(channels, map[string]any{"channel": channel, "revenue": total, "orderCount": count})
	}
	channelRows.Close()

	jarRows, err := s.pool.Query(r.Context(), `
		WITH lines AS (
			SELECT si.jar_size_id, js.label, js.honey_oz, si.quantity,
				si.quantity * si.unit_price_cents AS gross_cents,
				s.discount_amount_cents,
				-- Discount is allocated by each jar line's share of the whole
				-- sale subtotal (all kinds), not just its share of jar lines.
				s.total_amount_cents + s.discount_amount_cents AS subtotal_cents
			FROM sale_items si
			JOIN sales s ON s.id=si.sale_id
			JOIN jar_sizes js ON js.id=si.jar_size_id
			WHERE EXTRACT(YEAR FROM s.date)::integer=$1
				AND s.order_status <> 'cancelled'
		)
		SELECT jar_size_id, label, honey_oz, SUM(quantity),
			ROUND(SUM(gross_cents - CASE WHEN subtotal_cents > 0
				THEN discount_amount_cents::numeric * gross_cents / subtotal_cents
				ELSE 0 END))::bigint
		FROM lines GROUP BY jar_size_id, label, honey_oz
		ORDER BY 5 DESC`, year)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	byJarSize := make([]map[string]any, 0)
	for jarRows.Next() {
		var id uuid.UUID
		var label string
		var honeyOz *float64
		var quantity int
		var jarRevenue money
		if err := jarRows.Scan(&id, &label, &honeyOz, &quantity, &jarRevenue); err != nil {
			jarRows.Close()
			writeError(w, http.StatusInternalServerError, "database error")
			return
		}
		estimatedCost := money(0)
		if honeyOz != nil {
			estimatedCost = money(dollarsToCents(float64(quantity) * *honeyOz / 16 * costPerPound))
		}
		byJarSize = append(byJarSize, map[string]any{
			"jarSizeId": id, "label": label, "jarsSold": quantity,
			"revenue": jarRevenue, "estimatedHoneyCost": estimatedCost,
			"estimatedMargin": jarRevenue - estimatedCost,
		})
	}
	jarRows.Close()

	lotRows, err := s.pool.Query(r.Context(), `
		WITH lot_revenue AS (
			SELECT harvest_lot_id, SUM(total_amount_cents) revenue
			FROM sales
			WHERE EXTRACT(YEAR FROM date)::integer=$1
				AND order_status <> 'cancelled' AND harvest_lot_id IS NOT NULL
			GROUP BY harvest_lot_id
		), lot_cost AS (
			SELECT harvest_lot_id, SUM(amount_cents) expenses
			FROM expenses
			WHERE EXTRACT(YEAR FROM expense_date)::integer=$1
				AND harvest_lot_id IS NOT NULL AND deleted_at IS NULL
			GROUP BY harvest_lot_id
		)
		SELECT lot.id, lot.lot_code, lot.season, lot.honey_weight_lbs,
			COALESCE(r.revenue,0), COALESCE(c.expenses,0)
		FROM harvest_lots lot
		LEFT JOIN lot_revenue r ON r.harvest_lot_id=lot.id
		LEFT JOIN lot_cost c ON c.harvest_lot_id=lot.id
		WHERE EXTRACT(YEAR FROM lot.extraction_date)::integer=$1
			OR r.revenue IS NOT NULL OR c.expenses IS NOT NULL
		ORDER BY lot.extraction_date DESC, lot.lot_code`, year)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	byLot := make([]map[string]any, 0)
	for lotRows.Next() {
		var id uuid.UUID
		var code string
		var season *string
		var pounds float64
		var lotRevenue, lotExpenses money
		if err := lotRows.Scan(&id, &code, &season, &pounds, &lotRevenue, &lotExpenses); err != nil {
			lotRows.Close()
			writeError(w, http.StatusInternalServerError, "database error")
			return
		}
		byLot = append(byLot, map[string]any{
			"harvestLotId": id, "lotCode": code, "season": season,
			"harvestedPounds": pounds, "revenue": lotRevenue,
			"expenses": lotExpenses, "margin": lotRevenue - lotExpenses,
		})
	}
	lotRows.Close()

	seasonRows, err := s.pool.Query(r.Context(), `
		WITH revenue AS (
			SELECT COALESCE(lot.season,'Unassigned') season, SUM(s.total_amount_cents) revenue
			FROM sales s
			LEFT JOIN harvest_lots lot ON lot.id=s.harvest_lot_id
			WHERE EXTRACT(YEAR FROM s.date)::integer=$1 AND s.order_status <> 'cancelled'
			GROUP BY 1
		), costs AS (
			SELECT COALESCE(lot.season,e.season,'Unassigned') season, SUM(e.amount_cents) expenses
			FROM expenses e
			LEFT JOIN harvest_lots lot ON lot.id=e.harvest_lot_id
			WHERE EXTRACT(YEAR FROM e.expense_date)::integer=$1 AND e.deleted_at IS NULL
			GROUP BY 1
		), harvest_weight AS (
			SELECT COALESCE(season,'Unassigned') season, SUM(honey_weight_lbs) pounds
			FROM harvest_lots
			WHERE EXTRACT(YEAR FROM extraction_date)::integer=$1
			GROUP BY 1
		), keys AS (
			SELECT season FROM revenue UNION SELECT season FROM costs UNION SELECT season FROM harvest_weight
		)
		SELECT keys.season, COALESCE(h.pounds,0), COALESCE(r.revenue,0), COALESCE(c.expenses,0)
		FROM keys
		LEFT JOIN revenue r USING (season)
		LEFT JOIN costs c USING (season)
		LEFT JOIN harvest_weight h USING (season)
		ORDER BY keys.season`, year)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	bySeason := make([]map[string]any, 0)
	for seasonRows.Next() {
		var season string
		var pounds float64
		var seasonRevenue, seasonExpenses money
		if err := seasonRows.Scan(&season, &pounds, &seasonRevenue, &seasonExpenses); err != nil {
			seasonRows.Close()
			writeError(w, http.StatusInternalServerError, "database error")
			return
		}
		bySeason = append(bySeason, map[string]any{
			"season": season, "harvestedPounds": pounds,
			"revenue": seasonRevenue, "expenses": seasonExpenses,
			"margin": seasonRevenue - seasonExpenses,
		})
	}
	seasonRows.Close()

	kindRows, err := s.pool.Query(r.Context(), `
		SELECT si.kind, COALESCE(SUM(si.quantity * si.unit_price_cents),0)
		FROM sale_items si
		JOIN sales s ON s.id=si.sale_id
		WHERE EXTRACT(YEAR FROM s.date)::integer=$1 AND s.order_status <> 'cancelled'
		GROUP BY si.kind ORDER BY si.kind`, year)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	byKind := make([]map[string]any, 0)
	for kindRows.Next() {
		var kind string
		var kindRevenue money
		if err := kindRows.Scan(&kind, &kindRevenue); err != nil {
			kindRows.Close()
			writeError(w, http.StatusInternalServerError, "database error")
			return
		}
		byKind = append(byKind, map[string]any{"kind": kind, "revenue": kindRevenue})
	}
	kindRows.Close()
	if kindRows.Err() != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}

	margin := revenue - expenses
	writeJSON(w, http.StatusOK, map[string]any{
		// revenue keeps its previous meaning (invoiced, incl. unpaid orders);
		// collectedRevenue and invoicedRevenue name the two definitions.
		"year": year, "revenue": revenue, "invoicedRevenue": revenue,
		"collectedRevenue": collected, "unpaidRevenue": revenue - collected,
		"expenses": expenses, "grossMargin": margin,
		"marginPercent":   safePercent(margin.Dollars(), revenue.Dollars()),
		"harvestedPounds": harvested, "costPerHarvestedPound": costPerPound,
		"costPerJarSold": safeDivide(expenses.Dollars(), float64(jarsSold)),
		"inventoryValue": inventoryValue, "jarsSold": jarsSold,
		"breakEvenByJarSize": breakEven, "byChannel": channels,
		"byJarSize": byJarSize, "byHarvestLot": byLot, "bySeason": bySeason,
		"byKind": byKind,
	})
}

func (s *Server) economicsAnalytics(w http.ResponseWriter, r *http.Request) {
	year := requestedYear(r)
	rows, err := s.pool.Query(r.Context(), `
		WITH yields AS (
			SELECT a.id AS apiary_id, a.name,
				COALESCE(SUM(hh.calculated_honey_weight),0) AS pounds,
				COUNT(DISTINCT h.id) FILTER (WHERE hh.id IS NOT NULL) AS producing_hives
			FROM apiaries a
			LEFT JOIN hives h ON h.apiary_id=a.id
			LEFT JOIN honey_harvests hh ON hh.hive_id=h.id
				AND EXTRACT(YEAR FROM hh.date)::integer=$1 AND hh.deleted_at IS NULL
			GROUP BY a.id
		), costs AS (
			SELECT COALESCE(e.apiary_id, h.apiary_id) apiary_id,
				SUM(e.amount_cents) expenses,
				SUM(e.amount_cents) FILTER (WHERE e.category='feed') feed_cost,
				SUM(e.amount_cents) FILTER (WHERE e.category='treatments') treatment_cost
			FROM expenses e LEFT JOIN hives h ON h.id=e.hive_id
			WHERE EXTRACT(YEAR FROM e.expense_date)::integer=$1 AND e.deleted_at IS NULL
			GROUP BY COALESCE(e.apiary_id, h.apiary_id)
		), general_costs AS (
			SELECT COALESCE(SUM(e.amount_cents),0) expenses,
				COALESCE(SUM(e.amount_cents) FILTER (WHERE e.category='feed'),0) feed_cost,
				COALESCE(SUM(e.amount_cents) FILTER (WHERE e.category='treatments'),0) treatment_cost
			FROM expenses e
			LEFT JOIN hives h ON h.id=e.hive_id
			WHERE EXTRACT(YEAR FROM e.expense_date)::integer=$1 AND e.deleted_at IS NULL
				AND COALESCE(e.apiary_id,h.apiary_id) IS NULL
		), totals AS (
			SELECT COALESCE(SUM(total_amount_cents),0) revenue
			FROM sales WHERE EXTRACT(YEAR FROM date)::integer=$1
				AND order_status <> 'cancelled'
		), yield_total AS (
			SELECT COALESCE(SUM(pounds),0) pounds FROM yields
		)
		-- Allocated cents are rounded once, at the point of allocation, so the
		-- per-apiary numbers stay whole cents.
		SELECT y.apiary_id, y.name, y.pounds, y.producing_hives,
			ROUND(COALESCE(c.expenses,0) + CASE WHEN yt.pounds > 0
				THEN gc.expenses::numeric * y.pounds / yt.pounds ELSE 0 END)::bigint,
			ROUND(COALESCE(c.feed_cost,0) + CASE WHEN yt.pounds > 0
				THEN gc.feed_cost::numeric * y.pounds / yt.pounds ELSE 0 END)::bigint,
			ROUND(COALESCE(c.treatment_cost,0) + CASE WHEN yt.pounds > 0
				THEN gc.treatment_cost::numeric * y.pounds / yt.pounds ELSE 0 END)::bigint,
			ROUND(CASE WHEN yt.pounds > 0
				THEN t.revenue::numeric * y.pounds / yt.pounds ELSE 0 END)::bigint
		FROM yields y
		LEFT JOIN costs c ON c.apiary_id=y.apiary_id
		CROSS JOIN totals t CROSS JOIN yield_total yt CROSS JOIN general_costs gc
		ORDER BY y.pounds DESC`, year)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	defer rows.Close()
	out := make([]map[string]any, 0)
	byID := make(map[uuid.UUID]map[string]any)
	for rows.Next() {
		var id uuid.UUID
		var name string
		var pounds float64
		var expenses, feedCost, treatmentCost, revenue money
		var producing int
		if err := rows.Scan(&id, &name, &pounds, &producing, &expenses,
			&feedCost, &treatmentCost, &revenue); err != nil {
			writeError(w, http.StatusInternalServerError, "database error")
			return
		}
		item := map[string]any{
			"apiaryId": id, "apiaryName": name, "harvestedPounds": pounds,
			"producingHives": producing, "revenueAllocated": revenue,
			"expenses": expenses, "margin": revenue - expenses,
			"poundsPerHive":          safeDivide(pounds, float64(producing)),
			"feedCostPerColony":      safeDivide(feedCost.Dollars(), float64(producing)),
			"treatmentCostPerColony": safeDivide(treatmentCost.Dollars(), float64(producing)),
		}
		out = append(out, item)
		byID[id] = item
	}
	if rows.Err() != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}

	winterStart := time.Date(year, time.October, 1, 0, 0, 0, 0, time.UTC)
	survivalDate := time.Date(year+1, time.April, 1, 0, 0, 0, 0, time.UTC)
	yearStart := time.Date(year, time.January, 1, 0, 0, 0, 0, time.UTC)
	yearEnd := yearStart.AddDate(1, 0, 0)
	outcomeRows, err := s.pool.Query(r.Context(), `
		SELECT a.id,
			COUNT(DISTINCT h.id) FILTER (
				WHERE (h.installed_date IS NULL OR h.installed_date <= $1)
					AND (h.deadout_date IS NULL OR h.deadout_date >= $1)
			),
			COUNT(DISTINCT h.id) FILTER (
				WHERE (h.installed_date IS NULL OR h.installed_date <= $1)
					AND (h.deadout_date IS NULL OR h.deadout_date >= $2)
			),
			COUNT(DISTINCT sp.id) FILTER (
				WHERE sp.split_date >= $3 AND sp.split_date < $4
			),
			COUNT(DISTINCT sp.child_hive_id) FILTER (
				WHERE sp.split_date >= $3 AND sp.split_date < $4
					AND (child.deadout_date IS NULL OR child.deadout_date >= $2)
			),
			COUNT(DISTINCT q.id) FILTER (
				WHERE q.introduced_date >= $3 AND q.introduced_date < $4
			),
			COUNT(DISTINCT q.id) FILTER (
				WHERE q.introduced_date >= $3 AND q.introduced_date < $4
					AND q.status='active'
			)
		FROM apiaries a
		LEFT JOIN hives h ON h.apiary_id=a.id
		LEFT JOIN hive_splits sp ON sp.parent_hive_id=h.id
		LEFT JOIN hives child ON child.id=sp.child_hive_id
		LEFT JOIN queens q ON q.hive_id=h.id
		GROUP BY a.id`,
		winterStart, survivalDate, yearStart, yearEnd)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	for outcomeRows.Next() {
		var id uuid.UUID
		var entered, survived, splits, survivingSplits, queens, activeQueens int
		if err := outcomeRows.Scan(
			&id, &entered, &survived, &splits, &survivingSplits, &queens, &activeQueens,
		); err != nil {
			outcomeRows.Close()
			writeError(w, http.StatusInternalServerError, "database error")
			return
		}
		if item := byID[id]; item != nil {
			item["enteredWinter"] = entered
			item["survivedWinter"] = survived
			item["winterSurvivalRate"] = safePercent(float64(survived), float64(entered))
			item["splitsCreated"] = splits
			item["splitChildrenSurviving"] = survivingSplits
			item["queensIntroduced"] = queens
			item["introducedQueensActive"] = activeQueens
		}
	}
	outcomeRows.Close()
	writeJSON(w, http.StatusOK, map[string]any{"year": year, "apiaries": out})
}

func safeDivide(value, divisor float64) float64 {
	if divisor == 0 {
		return 0
	}
	return value / divisor
}

func safePercent(value, divisor float64) float64 {
	return safeDivide(value, divisor) * 100
}

func (s *Server) productionPlan(w http.ResponseWriter, r *http.Request) {
	lookbackDays := 90
	if raw := r.URL.Query().Get("days"); raw != "" {
		if v, err := strconv.Atoi(raw); err == nil && v >= 7 && v <= 730 {
			lookbackDays = v
		}
	}
	horizonDays := 30
	if raw := r.URL.Query().Get("horizon"); raw != "" {
		if v, err := strconv.Atoi(raw); err == nil && v >= 1 && v <= 180 {
			horizonDays = v
		}
	}
	inventory, err := s.honeyJarInventory(r.Context())
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	salesRows, err := s.pool.Query(r.Context(), `
		SELECT si.jar_size_id, COALESCE(SUM(si.quantity),0)
		FROM sale_items si JOIN sales s ON s.id=si.sale_id
		WHERE s.date >= CURRENT_DATE - $1::integer AND s.order_status <> 'cancelled'
			AND si.kind='jar'
		GROUP BY si.jar_size_id`, lookbackDays)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	sold := map[uuid.UUID]int{}
	for salesRows.Next() {
		var id uuid.UUID
		var quantity int
		if err := salesRows.Scan(&id, &quantity); err != nil {
			salesRows.Close()
			writeError(w, http.StatusInternalServerError, "database error")
			return
		}
		sold[id] = quantity
	}
	salesRows.Close()
	recommendations := make([]map[string]any, 0)
	totalPounds := 0.0
	projectedRevenue := money(0)
	for _, row := range inventory {
		projectedDemand := int(math.Ceil(float64(sold[row.JarSizeID]) / float64(lookbackDays) * float64(horizonDays)))
		needed := projectedDemand - row.OnHand
		if needed < 0 {
			needed = 0
		}
		pounds := 0.0
		if row.HoneyOz != nil {
			pounds = float64(needed) * *row.HoneyOz / 16
		}
		revenue := money(0)
		if row.DefaultPrice != nil {
			revenue = row.DefaultPrice.mulQuantity(needed)
		}
		totalPounds += pounds
		projectedRevenue += revenue
		recommendations = append(recommendations, map[string]any{
			"jarSizeId": row.JarSizeID, "label": row.Label, "onHand": row.OnHand,
			"soldInLookback": sold[row.JarSizeID], "projectedDemand": projectedDemand,
			"recommendedToBottle": needed, "packagingRequired": needed,
			"honeyRequiredLbs": pounds, "projectedRevenue": revenue,
		})
	}
	sort.Slice(recommendations, func(i, j int) bool {
		return recommendations[i]["recommendedToBottle"].(int) > recommendations[j]["recommendedToBottle"].(int)
	})
	var wholesaleReserved float64
	_ = s.pool.QueryRow(r.Context(), `
		SELECT COALESCE(SUM(si.quantity * COALESCE(js.honey_oz,0) / 16.0),0)
		FROM sale_items si
		JOIN sales s ON s.id=si.sale_id
		JOIN jar_sizes js ON js.id=si.jar_size_id
		WHERE s.channel='wholesale' AND s.order_status IN ('draft','pending')
			AND si.kind='jar'`).Scan(&wholesaleReserved)
	// The SAME formula /honey/overview reports. This endpoint used to recompute
	// pounds jarred from quantity * honey_oz / 16, so the two disagreed
	// whenever a jar size had been edited or had no honey_oz at jarring time.
	bulk, err := honeyBulkOnHand(r.Context(), s.pool)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	bulkOnHand := bulk.BulkOnHandLbs
	var optedIn int
	_ = s.pool.QueryRow(r.Context(), `SELECT COUNT(*) FROM customers WHERE email_opt_in`).Scan(&optedIn)
	writeJSON(w, http.StatusOK, map[string]any{
		"lookbackDays": lookbackDays, "horizonDays": horizonDays,
		"recommendations": recommendations, "honeyRequiredLbs": totalPounds,
		"projectedRevenue": projectedRevenue, "bulkOnHandLbs": bulkOnHand,
		"bulkReservedForWholesaleLbs": wholesaleReserved,
		"bulkAvailableAfterPlanLbs":   bulkOnHand - wholesaleReserved - totalPounds,
		"releaseAlertSubscribers":     optedIn,
	})
}

// lowStockAlerts warns about sizes that are running out AT HOME. Jars sitting
// on the bike shop's shelf are still the operator's inventory, but they cannot
// be put on the market-day table, so counting them would keep the warning
// quiet exactly when more needs bottling. Both counts are reported so the
// alert can say where the rest of the stock actually is.
func (s *Server) lowStockAlerts(w http.ResponseWriter, r *http.Request) {
	inventory, err := s.honeyJarInventory(r.Context())
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	away, err := stockAwayJarTotals(r.Context(), s.pool)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	rows, err := s.pool.Query(r.Context(), `SELECT id, low_stock_threshold FROM jar_sizes`)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	thresholds := map[uuid.UUID]int{}
	for rows.Next() {
		var id uuid.UUID
		var threshold int
		if err := rows.Scan(&id, &threshold); err != nil {
			rows.Close()
			writeError(w, http.StatusInternalServerError, "database error")
			return
		}
		thresholds[id] = threshold
	}
	rows.Close()
	out := make([]map[string]any, 0)
	for _, row := range inventory {
		atHome := row.OnHand - away[row.JarSizeID]
		if atHome <= thresholds[row.JarSizeID] {
			out = append(out, map[string]any{
				"jarSizeId": row.JarSizeID, "label": row.Label,
				"onHand": atHome, "threshold": thresholds[row.JarSizeID],
				"totalOnHand": row.OnHand, "atOtherLocations": away[row.JarSizeID],
			})
		}
	}
	writeJSON(w, http.StatusOK, out)
}

func (s *Server) marketDayReconciliation(w http.ResponseWriter, r *http.Request) {
	date := r.URL.Query().Get("date")
	if date == "" {
		date = time.Now().Format("2006-01-02")
	}
	parsed, err := parseDate(date)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid date")
		return
	}
	// Compare against a half-open server-local day range. `date::date` cast
	// the timestamptz in the DB session's timezone while the stored instants
	// were parsed server-local — near-midnight sales landed on the adjacent
	// day's reconciliation.
	dayStart := parsed
	dayEnd := parsed.AddDate(0, 0, 1)
	rows, err := s.pool.Query(r.Context(), `
		SELECT payment_method, channel, COUNT(*), SUM(total_amount_cents), SUM(amount_paid_cents),
			SUM(total_amount_cents-amount_paid_cents)
		FROM sales
		WHERE date >= $1 AND date < $2 AND order_status <> 'cancelled'
		GROUP BY payment_method, channel ORDER BY payment_method, channel`, dayStart, dayEnd)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	defer rows.Close()
	lines := make([]map[string]any, 0)
	totalSales, totalPaid, totalDue := money(0), money(0), money(0)
	orders := 0
	for rows.Next() {
		var payment, channel string
		var count int
		var sales, paid, due money
		if err := rows.Scan(&payment, &channel, &count, &sales, &paid, &due); err != nil {
			writeError(w, http.StatusInternalServerError, "database error")
			return
		}
		orders += count
		totalSales += sales
		totalPaid += paid
		totalDue += due
		lines = append(lines, map[string]any{
			"paymentMethod": payment, "channel": channel, "orderCount": count,
			"sales": sales, "paid": paid, "balanceDue": due,
		})
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"date": parsed, "orderCount": orders, "grossSales": totalSales,
		"amountCollected": totalPaid, "balanceDue": totalDue, "breakdown": lines,
	})
}

func (s *Server) saleReceipt(w http.ResponseWriter, r *http.Request) {
	id, err := uuidParam(r, "id")
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	sales, err := s.honeyListSales(r.Context())
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	for _, sale := range sales {
		if sale.ID == id {
			balanceDue := sale.TotalAmount - sale.AmountPaid
			if balanceDue < 0 {
				balanceDue = 0
			}
			writeJSON(w, http.StatusOK, map[string]any{
				"seller": "Beez Trackz Apiary", "sale": sale,
				"balanceDue":   balanceDue,
				"documentType": map[bool]string{true: "receipt", false: "invoice"}[sale.AmountPaid >= sale.TotalAmount],
			})
			return
		}
	}
	writeError(w, http.StatusNotFound, "sale not found")
}
