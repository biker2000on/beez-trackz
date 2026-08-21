package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

// mountInspections wires the inspection CRUD + bulk endpoints.
func (s *Server) mountInspections(r chi.Router) {
	r.Post("/inspections", s.handleInspectionCreate)
	r.Get("/inspections/recent", s.handleInspectionsRecent)
	r.Post("/inspections/bulk", s.handleInspectionsBulk)
	r.With(s.requireEntityParamRole("inspection", false)).
		Get("/inspections/{id}", s.handleInspectionGet)
	r.With(s.requireEntityParamRole("inspection", true)).
		Put("/inspections/{id}", s.handleInspectionUpdate)
	r.With(s.requireEntityParamRole("inspection", true)).
		Delete("/inspections/{id}", s.handleInspectionDelete)
	r.With(s.requireHiveParamRole(false)).
		Get("/hives/{id}/inspections", s.handleInspectionsForHive)
}

// --- shared helpers (inspection-prefixed to avoid collisions in package) ---

// inspectionQuerier is satisfied by both *pgxpool.Pool and pgx.Tx so the
// insert/update write path is shared between CRUD, bulk, and future sync
// endpoints.
type inspectionQuerier interface {
	Exec(ctx context.Context, sql string, args ...any) (pgconn.CommandTag, error)
	QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
	Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error)
}

// inspectionTrimPtr trims an optional string; empty → nil (legacy `?.trim() || null`).
func inspectionTrimPtr(s *string) *string {
	if s == nil {
		return nil
	}
	t := strings.TrimSpace(*s)
	if t == "" {
		return nil
	}
	return &t
}

// inspectionIsFKViolation reports a Postgres foreign-key violation (23503),
// used to turn "referenced hive does not exist" into a 400 instead of a 500.
func inspectionIsFKViolation(err error) bool {
	var pgErr *pgconn.PgError
	return errors.As(err, &pgErr) && pgErr.Code == "23503"
}

type inspectionPest struct {
	Type  string  `json:"type"`
	Count *string `json:"count,omitempty"`
}

type inspectionTreatment struct {
	Product string  `json:"product"`
	Method  *string `json:"method,omitempty"`
}

// inspectionFields is the full set of writable inspection columns.
type inspectionFields struct {
	HiveID          uuid.UUID
	Date            time.Time
	InspectorName   *string
	QueenSeen       *bool
	QueenHealth     *string
	BroodPattern    *string
	StoresHoney     *int
	StoresPollen    *int
	Temperament     *int
	FramesOfBees    *int
	FramesOfBrood   *int
	FramesOfStores  *int
	CrowdedBrood    *bool
	QueenCupsCount  *int
	QueenCellsCount *int
	FlowOn          *bool
	Pests           []byte // JSON array or nil
	Treatments      []byte // JSON array or nil
	Notes           *string
	SourceMedia     []byte // JSON object or nil (passthrough)
	Weather         []byte // provider snapshot captured when the record is created
}

// inspectionInsert is THE single insert path for inspections (CRUD, bulk, and
// future offline-sync endpoints all go through here).
func inspectionInsert(ctx context.Context, q inspectionQuerier, f inspectionFields) (uuid.UUID, error) {
	var id uuid.UUID
	err := q.QueryRow(ctx, `
		INSERT INTO inspections
			(hive_id, date, inspector_name, queen_seen, queen_health, brood_pattern,
			 stores_honey, stores_pollen, temperament, pests, treatments, notes,
			 source_media, weather_snapshot, frames_of_bees, frames_of_brood,
			 frames_of_stores, crowded_brood, queen_cups_count, queen_cells_count, flow_on)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14,
			$15, $16, $17, $18, $19, $20, $21)
		RETURNING id`,
		f.HiveID, f.Date, f.InspectorName, f.QueenSeen, f.QueenHealth, f.BroodPattern,
		f.StoresHoney, f.StoresPollen, f.Temperament, f.Pests, f.Treatments, f.Notes,
		f.SourceMedia, f.Weather, f.FramesOfBees, f.FramesOfBrood, f.FramesOfStores,
		f.CrowdedBrood, f.QueenCupsCount, f.QueenCellsCount, f.FlowOn).Scan(&id)
	return id, err
}

// inspectionUpdate is THE single update path for inspections. cols are column
// names (trusted, package-internal), vals the matching values. updated_at bumps
// via the table trigger. Returns pgx.ErrNoRows when the id does not exist.
func inspectionUpdate(ctx context.Context, q inspectionQuerier, id uuid.UUID, cols []string, vals []any) error {
	if len(cols) == 0 {
		return nil
	}
	sets := make([]string, len(cols))
	for i, c := range cols {
		sets[i] = fmt.Sprintf("%s = $%d", c, i+2)
	}
	args := append([]any{id}, vals...)
	tag, err := q.Exec(ctx,
		"UPDATE inspections SET "+strings.Join(sets, ", ")+" WHERE id = $1", args...)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return pgx.ErrNoRows
	}
	return nil
}

// inspectionJSON mirrors the legacy drizzle row shape (camelCase).
type inspectionJSON struct {
	ID              uuid.UUID                 `json:"id"`
	HiveID          uuid.UUID                 `json:"hiveId"`
	Date            time.Time                 `json:"date"`
	InspectorName   *string                   `json:"inspectorName"`
	QueenSeen       *bool                     `json:"queenSeen"`
	QueenHealth     *string                   `json:"queenHealth"`
	BroodPattern    *string                   `json:"broodPattern"`
	StoresHoney     *int                      `json:"storesHoney"`
	StoresPollen    *int                      `json:"storesPollen"`
	Temperament     *int                      `json:"temperament"`
	FramesOfBees    *int                      `json:"framesOfBees"`
	FramesOfBrood   *int                      `json:"framesOfBrood"`
	FramesOfStores  *int                      `json:"framesOfStores"`
	CrowdedBrood    *bool                     `json:"crowdedBrood"`
	QueenCupsCount  *int                      `json:"queenCupsCount"`
	QueenCellsCount *int                      `json:"queenCellsCount"`
	FlowOn          *bool                     `json:"flowOn"`
	Pests           any                       `json:"pests"`
	Treatments      any                       `json:"treatments"`
	Notes           *string                   `json:"notes"`
	SourceMedia     any                       `json:"sourceMedia"`
	Weather         any                       `json:"weather"`
	CreatedAt       time.Time                 `json:"createdAt"`
	UpdatedAt       time.Time                 `json:"updatedAt"`
	MiteCounts      []inspectionMiteCountJSON `json:"miteCounts"`
}

type inspectionMiteCountJSON struct {
	ID          uuid.UUID `json:"id"`
	Method      string    `json:"method"`
	MitesCount  int       `json:"mitesCount"`
	SampleSize  *int      `json:"sampleSize"`
	DaysOnBoard *int      `json:"daysOnBoard"`
	MitesPer100 *float64  `json:"mitesPer100"`
	MitesPerDay *float64  `json:"mitesPerDay"`
	Notes       *string   `json:"notes"`
}

const inspectionSelectCols = `id, hive_id, date, inspector_name, queen_seen, queen_health,
	brood_pattern, stores_honey, stores_pollen, temperament, pests, treatments, notes,
	source_media, weather_snapshot, frames_of_bees, frames_of_brood, frames_of_stores,
	crowded_brood, queen_cups_count, queen_cells_count, flow_on, created_at, updated_at`

func inspectionScan(row pgx.Row) (inspectionJSON, error) {
	var v inspectionJSON
	err := row.Scan(&v.ID, &v.HiveID, &v.Date, &v.InspectorName, &v.QueenSeen, &v.QueenHealth,
		&v.BroodPattern, &v.StoresHoney, &v.StoresPollen, &v.Temperament, &v.Pests,
		&v.Treatments, &v.Notes, &v.SourceMedia, &v.Weather, &v.FramesOfBees,
		&v.FramesOfBrood, &v.FramesOfStores, &v.CrowdedBrood, &v.QueenCupsCount,
		&v.QueenCellsCount, &v.FlowOn, &v.CreatedAt, &v.UpdatedAt)
	return v, err
}

func (s *Server) inspectionByID(ctx context.Context, id uuid.UUID) (inspectionJSON, error) {
	v, err := inspectionScan(s.pool.QueryRow(ctx,
		`SELECT `+inspectionSelectCols+` FROM inspections WHERE id = $1`, id))
	if err != nil {
		return v, err
	}
	byID, err := loadMiteCountsByInspection(ctx, s.pool, []uuid.UUID{id})
	if err != nil {
		return v, err
	}
	v.MiteCounts = byID[id]
	if v.MiteCounts == nil {
		v.MiteCounts = []inspectionMiteCountJSON{}
	}
	return v, nil
}

func loadMiteCountsByInspection(
	ctx context.Context,
	q inspectionQuerier,
	ids []uuid.UUID,
) (map[uuid.UUID][]inspectionMiteCountJSON, error) {
	out := make(map[uuid.UUID][]inspectionMiteCountJSON, len(ids))
	if len(ids) == 0 {
		return out, nil
	}
	rows, err := q.Query(ctx, `
		SELECT id, inspection_id, method, mites_count, sample_size, days_on_board,
			mites_per_100, mites_per_day, notes
		FROM mite_counts
		WHERE inspection_id = ANY($1) AND deleted_at IS NULL
		ORDER BY method`, ids)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var inspectionID uuid.UUID
		var row inspectionMiteCountJSON
		if err := rows.Scan(&row.ID, &inspectionID, &row.Method, &row.MitesCount,
			&row.SampleSize, &row.DaysOnBoard, &row.MitesPer100, &row.MitesPerDay,
			&row.Notes); err != nil {
			return nil, err
		}
		out[inspectionID] = append(out[inspectionID], row)
	}
	return out, rows.Err()
}

func replaceInspectionMiteCounts(
	ctx context.Context,
	q inspectionQuerier,
	inspectionID, hiveID uuid.UUID,
	date time.Time,
	counts []miteCountPayload,
) error {
	// Rows are matched by (inspection_id, method): resubmitted methods are
	// updated in place by the upsert (which leaves source_media_file_id /
	// source_transcript_version_id untouched); only methods dropped from
	// the submission are deleted.
	methods := make([]string, 0, len(counts))
	for _, count := range counts {
		methods = append(methods, count.Method)
	}
	// Soft delete, matching the standalone endpoint: the audit trail keeps
	// dropped methods and every aggregate already filters deleted_at IS NULL.
	if _, err := q.Exec(ctx, `
		UPDATE mite_counts SET deleted_at = now()
		WHERE inspection_id = $1 AND method <> ALL($2) AND deleted_at IS NULL`,
		inspectionID, methods); err != nil {
		return err
	}
	for _, count := range counts {
		count.HiveID = hiveID
		count.InspectionID = &inspectionID
		if err := normalizeMiteCount(&count); err != nil {
			return err
		}
		if _, _, _, err := upsertMiteCount(ctx, q, count, date); err != nil {
			return err
		}
	}
	return nil
}

// syncInspectionTreatmentEvents reconciles the treatment_events rows this
// inspection owns with the treatments jsonb just submitted. The create path
// writes one event per treatment; a PATCH that rewrote the jsonb used to leave
// those events untouched, so a corrected product kept locking the hive on the
// old withdrawal days and a removed treatment locked it forever.
//
// Rows are matched by product, case-insensitively, the same key
// resolveWithdrawalDays uses. A resubmitted product keeps its row id and its
// date_removed, so an in-progress withdrawal window is not reset by an
// unrelated edit to the same inspection; only products dropped from the array
// are deleted. withdrawal_days is re-resolved on every pass because the
// catalog (or the product spelling) may have changed since the event was
// written.
func (s *Server) syncInspectionTreatmentEvents(
	ctx context.Context,
	q inspectionQuerier,
	inspectionID, hiveID uuid.UUID,
	date time.Time,
	treatments []inspectionTreatment,
) error {
	keys := make([]string, 0, len(treatments))
	seen := make(map[string]bool, len(treatments))
	kept := make([]inspectionTreatment, 0, len(treatments))
	for _, treatment := range treatments {
		product := strings.TrimSpace(treatment.Product)
		if product == "" {
			continue
		}
		key := strings.ToLower(product)
		if seen[key] {
			// The jsonb allows duplicates; treatment_events is keyed by
			// product here, so the first spelling wins.
			continue
		}
		seen[key] = true
		keys = append(keys, key)
		treatment.Product = product
		kept = append(kept, treatment)
	}
	if _, err := q.Exec(ctx, `
		DELETE FROM treatment_events
		WHERE inspection_id = $1 AND lower(btrim(product)) <> ALL($2)`,
		inspectionID, keys); err != nil {
		return err
	}
	for _, treatment := range kept {
		days, err := s.resolveWithdrawalDays(ctx, treatment.Product)
		if err != nil {
			return err
		}
		tag, err := q.Exec(ctx, `
			UPDATE treatment_events
			SET product = $3, method = $4, date_applied = $5, withdrawal_days = $6
			WHERE inspection_id = $1 AND lower(btrim(product)) = $2`,
			inspectionID, strings.ToLower(treatment.Product), treatment.Product,
			inspectionTrimPtr(treatment.Method), date, days)
		if err != nil {
			return err
		}
		if tag.RowsAffected() > 0 {
			continue
		}
		if _, err := q.Exec(ctx, `
			INSERT INTO treatment_events
				(hive_id, inspection_id, date_applied, product, method, withdrawal_days)
			VALUES ($1,$2,$3,$4,$5,$6)`,
			hiveID, inspectionID, date, treatment.Product,
			inspectionTrimPtr(treatment.Method), days); err != nil {
			return err
		}
	}
	return nil
}

// inspectionMarshal marshals an optional typed slice/object to jsonb bytes; nil in → nil out.
func inspectionMarshal(v any, present bool) []byte {
	if !present {
		return nil
	}
	b, err := json.Marshal(v)
	if err != nil {
		return nil
	}
	return b
}

func (s *Server) inspectionWeatherSnapshot(
	r *http.Request,
	hiveID uuid.UUID,
) []byte {
	var apiaryID uuid.UUID
	if err := s.pool.QueryRow(r.Context(),
		`SELECT apiary_id FROM hives WHERE id=$1`, hiveID).Scan(&apiaryID); err != nil {
		return nil
	}
	weather, err := s.loadApiaryWeather(r, apiaryID)
	if err != nil {
		return nil
	}
	raw, err := json.Marshal(map[string]any{
		"source": weather.Source, "fetchedAt": weather.Fetched,
		"timezone": weather.Forecast.Timezone,
		"current":  weather.Forecast.Current,
	})
	if err != nil {
		return nil
	}
	return raw
}

// --- handlers ---

type inspectionCreateReq struct {
	HiveID          string                `json:"hiveId"`
	Date            string                `json:"date"`
	InspectorName   *string               `json:"inspectorName"`
	QueenSeen       *bool                 `json:"queenSeen"`
	QueenHealth     *string               `json:"queenHealth"`
	BroodPattern    *string               `json:"broodPattern"`
	StoresHoney     *int                  `json:"storesHoney"`
	StoresPollen    *int                  `json:"storesPollen"`
	Temperament     *int                  `json:"temperament"`
	FramesOfBees    *int                  `json:"framesOfBees"`
	FramesOfBrood   *int                  `json:"framesOfBrood"`
	FramesOfStores  *int                  `json:"framesOfStores"`
	CrowdedBrood    *bool                 `json:"crowdedBrood"`
	QueenCupsCount  *int                  `json:"queenCupsCount"`
	QueenCellsCount *int                  `json:"queenCellsCount"`
	FlowOn          *bool                 `json:"flowOn"`
	Pests           []inspectionPest      `json:"pests"`
	Treatments      []inspectionTreatment `json:"treatments"`
	MiteCounts      []miteCountPayload    `json:"miteCounts"`
	Notes           *string               `json:"notes"`
	SourceMedia     json.RawMessage       `json:"sourceMedia"`
}

// POST /inspections
func (s *Server) handleInspectionCreate(w http.ResponseWriter, r *http.Request) {
	var req inspectionCreateReq
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	hiveID, err := uuid.Parse(req.HiveID)
	if err != nil {
		writeError(w, http.StatusBadRequest, "Hive is required")
		return
	}
	if !s.requireHiveRole(w, r, hiveID, true) {
		return
	}
	if strings.TrimSpace(req.Date) == "" {
		writeError(w, http.StatusBadRequest, "Date is required")
		return
	}
	for name, value := range map[string]*int{
		"framesOfBees": req.FramesOfBees, "framesOfBrood": req.FramesOfBrood,
		"framesOfStores": req.FramesOfStores, "queenCupsCount": req.QueenCupsCount,
		"queenCellsCount": req.QueenCellsCount,
	} {
		if value != nil && *value < 0 {
			writeError(w, http.StatusBadRequest, name+" cannot be negative")
			return
		}
	}
	date, err := parseDate(req.Date)
	if err != nil {
		writeError(w, http.StatusBadRequest, "Invalid date")
		return
	}
	var sourceMedia []byte
	if len(req.SourceMedia) > 0 && string(req.SourceMedia) != "null" {
		sourceMedia = req.SourceMedia
	}
	fields := inspectionFields{
		HiveID:          hiveID,
		Date:            date,
		InspectorName:   inspectionTrimPtr(req.InspectorName),
		QueenSeen:       req.QueenSeen,
		QueenHealth:     inspectionTrimPtr(req.QueenHealth),
		BroodPattern:    inspectionTrimPtr(req.BroodPattern),
		StoresHoney:     clampRating(req.StoresHoney),
		StoresPollen:    clampRating(req.StoresPollen),
		Temperament:     clampRating(req.Temperament),
		FramesOfBees:    req.FramesOfBees,
		FramesOfBrood:   req.FramesOfBrood,
		FramesOfStores:  req.FramesOfStores,
		CrowdedBrood:    req.CrowdedBrood,
		QueenCupsCount:  req.QueenCupsCount,
		QueenCellsCount: req.QueenCellsCount,
		FlowOn:          req.FlowOn,
		Pests:           inspectionMarshal(req.Pests, req.Pests != nil),
		Treatments:      inspectionMarshal(req.Treatments, req.Treatments != nil),
		Notes:           inspectionTrimPtr(req.Notes),
		SourceMedia:     sourceMedia,
		Weather:         s.inspectionWeatherSnapshot(r, hiveID),
	}
	tx, err := s.pool.Begin(r.Context())
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	defer tx.Rollback(r.Context())
	id, err := inspectionInsert(r.Context(), tx, fields)
	if err != nil {
		if inspectionIsFKViolation(err) {
			writeError(w, http.StatusBadRequest, "Hive not found")
			return
		}
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	// Same reconcile the PATCH path runs; on a brand-new inspection it is
	// pure inserts, so create and update can never drift apart.
	if err := s.syncInspectionTreatmentEvents(
		r.Context(), tx, id, hiveID, date, req.Treatments); err != nil {
		writeError(w, http.StatusBadRequest, "invalid treatment")
		return
	}
	if err := replaceInspectionMiteCounts(r.Context(), tx, id, hiveID, date, req.MiteCounts); err != nil {
		writeError(w, http.StatusBadRequest, "invalid mite count")
		return
	}
	if err := tx.Commit(r.Context()); err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	created, err := s.inspectionByID(r.Context(), id)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	writeJSON(w, http.StatusCreated, created)
}

// GET /inspections/{id}
func (s *Server) handleInspectionGet(w http.ResponseWriter, r *http.Request) {
	id, err := uuidParam(r, "id")
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	v, err := s.inspectionByID(r.Context(), id)
	if errors.Is(err, pgx.ErrNoRows) {
		writeError(w, http.StatusNotFound, "Inspection not found")
		return
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	writeJSON(w, http.StatusOK, v)
}

// inspectionUpdatableCols maps JSON field names to their column + decoder.
// hiveId is intentionally not updatable.
var inspectionUpdatableCols = map[string]string{
	"date":            "date",
	"inspectorName":   "inspector_name",
	"queenSeen":       "queen_seen",
	"queenHealth":     "queen_health",
	"broodPattern":    "brood_pattern",
	"storesHoney":     "stores_honey",
	"storesPollen":    "stores_pollen",
	"temperament":     "temperament",
	"framesOfBees":    "frames_of_bees",
	"framesOfBrood":   "frames_of_brood",
	"framesOfStores":  "frames_of_stores",
	"crowdedBrood":    "crowded_brood",
	"queenCupsCount":  "queen_cups_count",
	"queenCellsCount": "queen_cells_count",
	"flowOn":          "flow_on",
	"pests":           "pests",
	"treatments":      "treatments",
	"notes":           "notes",
	"sourceMedia":     "source_media",
}

// PUT /inspections/{id} — partial update: only fields present in the body are
// written; explicit nulls clear nullable columns. updated_at bumps via trigger.
func (s *Server) handleInspectionUpdate(w http.ResponseWriter, r *http.Request) {
	id, err := uuidParam(r, "id")
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	var body map[string]json.RawMessage
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	var miteCounts []miteCountPayload
	var miteCountsSet bool
	var treatments []inspectionTreatment
	var treatmentsSet bool
	if raw, ok := body["miteCounts"]; ok {
		if string(raw) != "null" {
			if err := json.Unmarshal(raw, &miteCounts); err != nil {
				writeError(w, http.StatusBadRequest, "miteCounts must be an array")
				return
			}
		}
		miteCountsSet = true
		delete(body, "miteCounts")
	}

	var cols []string
	var vals []any
	var updatedDate *time.Time
	for key, raw := range body {
		col, ok := inspectionUpdatableCols[key]
		if !ok {
			writeError(w, http.StatusBadRequest, "unknown field: "+key)
			return
		}
		isNull := string(raw) == "null"
		switch key {
		case "date":
			if isNull {
				writeError(w, http.StatusBadRequest, "Date is required")
				return
			}
			var ds string
			if err := json.Unmarshal(raw, &ds); err != nil {
				writeError(w, http.StatusBadRequest, "Invalid date")
				return
			}
			t, err := parseDate(ds)
			if err != nil {
				writeError(w, http.StatusBadRequest, "Invalid date")
				return
			}
			updatedDate = &t
			vals = append(vals, t)
		case "queenSeen":
			var v *bool
			if err := json.Unmarshal(raw, &v); err != nil {
				writeError(w, http.StatusBadRequest, "queenSeen must be a boolean")
				return
			}
			vals = append(vals, v)
		case "storesHoney", "storesPollen", "temperament":
			var v *int
			if err := json.Unmarshal(raw, &v); err != nil {
				writeError(w, http.StatusBadRequest, key+" must be an integer 1-5")
				return
			}
			vals = append(vals, clampRating(v))
		case "framesOfBees", "framesOfBrood", "framesOfStores", "queenCupsCount", "queenCellsCount":
			var v *int
			if err := json.Unmarshal(raw, &v); err != nil || (v != nil && *v < 0) {
				writeError(w, http.StatusBadRequest, key+" must be a non-negative integer")
				return
			}
			vals = append(vals, v)
		case "crowdedBrood", "flowOn":
			var v *bool
			if err := json.Unmarshal(raw, &v); err != nil {
				writeError(w, http.StatusBadRequest, key+" must be a boolean")
				return
			}
			vals = append(vals, v)
		case "pests":
			var v []inspectionPest
			if err := json.Unmarshal(raw, &v); err != nil {
				writeError(w, http.StatusBadRequest, "pests must be an array of {type, count?}")
				return
			}
			vals = append(vals, inspectionMarshal(v, !isNull && v != nil))
		case "treatments":
			var v []inspectionTreatment
			if err := json.Unmarshal(raw, &v); err != nil {
				writeError(w, http.StatusBadRequest, "treatments must be an array of {product, method?}")
				return
			}
			// Whatever lands in the jsonb also has to land in
			// treatment_events, which is what actually drives the lockout.
			treatments, treatmentsSet = v, true
			vals = append(vals, inspectionMarshal(v, !isNull && v != nil))
		case "sourceMedia":
			if isNull {
				vals = append(vals, []byte(nil))
			} else {
				vals = append(vals, []byte(raw))
			}
		default: // free-text fields: inspectorName, queenHealth, broodPattern, notes
			var v *string
			if err := json.Unmarshal(raw, &v); err != nil {
				writeError(w, http.StatusBadRequest, key+" must be a string")
				return
			}
			vals = append(vals, inspectionTrimPtr(v))
		}
		cols = append(cols, col)
	}
	if len(cols) == 0 && !miteCountsSet {
		writeError(w, http.StatusBadRequest, "No fields to update")
		return
	}
	tx, err := s.pool.Begin(r.Context())
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	defer tx.Rollback(r.Context())
	if len(cols) > 0 {
		err = inspectionUpdate(r.Context(), tx, id, cols, vals)
		if errors.Is(err, pgx.ErrNoRows) {
			writeError(w, http.StatusNotFound, "Inspection not found")
			return
		}
		if err != nil {
			writeError(w, http.StatusInternalServerError, "database error")
			return
		}
	}
	var hiveID uuid.UUID
	var date time.Time
	if err := tx.QueryRow(r.Context(),
		`SELECT hive_id, date FROM inspections WHERE id = $1`, id,
	).Scan(&hiveID, &date); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			writeError(w, http.StatusNotFound, "Inspection not found")
			return
		}
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	if updatedDate != nil {
		date = *updatedDate
		if _, err := tx.Exec(r.Context(),
			`UPDATE mite_counts SET date = $2 WHERE inspection_id = $1`,
			id, date); err != nil {
			writeError(w, http.StatusInternalServerError, "database error")
			return
		}
		// A treatment's lockout is anchored to date_applied, so moving the
		// inspection has to move its events with it.
		if _, err := tx.Exec(r.Context(),
			`UPDATE treatment_events SET date_applied = $2 WHERE inspection_id = $1`,
			id, date); err != nil {
			writeError(w, http.StatusInternalServerError, "database error")
			return
		}
	}
	if treatmentsSet {
		if err := s.syncInspectionTreatmentEvents(
			r.Context(), tx, id, hiveID, date, treatments); err != nil {
			writeError(w, http.StatusBadRequest, "invalid treatment")
			return
		}
	}
	if miteCountsSet {
		if err := replaceInspectionMiteCounts(r.Context(), tx, id, hiveID, date, miteCounts); err != nil {
			writeError(w, http.StatusBadRequest, "invalid mite count")
			return
		}
	}
	if err := tx.Commit(r.Context()); err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	updated, err := s.inspectionByID(r.Context(), id)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	writeJSON(w, http.StatusOK, updated)
}

// DELETE /inspections/{id}
func (s *Server) handleInspectionDelete(w http.ResponseWriter, r *http.Request) {
	id, err := uuidParam(r, "id")
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	tag, err := s.pool.Exec(r.Context(), `DELETE FROM inspections WHERE id = $1`, id)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	if tag.RowsAffected() == 0 {
		writeError(w, http.StatusNotFound, "Inspection not found")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"success": true})
}

const (
	hiveInspectionsDefaultLimit = 50
	hiveInspectionsMaxLimit     = 200
)

// GET /hives/{id}/inspections?limit= — recent rows, date desc. Default 50,
// hard max 200; the hive page only renders a handful of cards.
func (s *Server) handleInspectionsForHive(w http.ResponseWriter, r *http.Request) {
	hiveID, err := uuidParam(r, "id")
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	limit := parseBoundedLimit(r.URL.Query().Get("limit"), hiveInspectionsDefaultLimit, hiveInspectionsMaxLimit)
	rows, err := s.pool.Query(r.Context(),
		`SELECT `+inspectionSelectCols+` FROM inspections WHERE hive_id = $1 ORDER BY date DESC LIMIT $2`,
		hiveID, limit)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	defer rows.Close()
	list := []inspectionJSON{}
	ids := make([]uuid.UUID, 0)
	for rows.Next() {
		v, err := inspectionScan(rows)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "database error")
			return
		}
		v.MiteCounts = []inspectionMiteCountJSON{}
		list = append(list, v)
		ids = append(ids, v.ID)
	}
	if rows.Err() != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	byID, err := loadMiteCountsByInspection(r.Context(), s.pool, ids)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	for i := range list {
		if counts := byID[list[i].ID]; counts != nil {
			list[i].MiteCounts = counts
		}
	}
	writeJSON(w, http.StatusOK, list)
}

// GET /inspections/recent?limit= — joined with hive position label + apiary name.
func (s *Server) handleInspectionsRecent(w http.ResponseWriter, r *http.Request) {
	limit := 10
	if raw := r.URL.Query().Get("limit"); raw != "" {
		n, err := strconv.Atoi(raw)
		if err != nil || n < 1 {
			writeError(w, http.StatusBadRequest, "invalid limit")
			return
		}
		limit = n
	}
	rows, err := s.pool.Query(r.Context(), `
		SELECT i.id, i.hive_id, i.date, i.queen_seen, i.notes, h.position_label, a.name
		FROM inspections i
		JOIN hives h ON h.id = i.hive_id
		JOIN apiaries a ON a.id = h.apiary_id
		WHERE ($1::boolean OR EXISTS (
			SELECT 1 FROM apiary_memberships membership
			WHERE membership.user_id=$2 AND membership.apiary_id=a.id
		))
		ORDER BY i.date DESC
		LIMIT $3`, principalFrom(r).IsAdmin, principalFrom(r).ID, limit)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	defer rows.Close()
	type recentJSON struct {
		ID         uuid.UUID `json:"id"`
		HiveID     uuid.UUID `json:"hiveId"`
		Date       time.Time `json:"date"`
		QueenSeen  *bool     `json:"queenSeen"`
		Notes      *string   `json:"notes"`
		HiveName   string    `json:"hiveName"`
		ApiaryName string    `json:"apiaryName"`
	}
	list := []recentJSON{}
	for rows.Next() {
		var v recentJSON
		if err := rows.Scan(&v.ID, &v.HiveID, &v.Date, &v.QueenSeen, &v.Notes, &v.HiveName, &v.ApiaryName); err != nil {
			writeError(w, http.StatusInternalServerError, "database error")
			return
		}
		list = append(list, v)
	}
	if rows.Err() != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	writeJSON(w, http.StatusOK, list)
}

// POST /inspections/bulk {hiveIds[], date, notes?} — one minimal inspection per
// hive, in a single transaction, through the shared insert path.
func (s *Server) handleInspectionsBulk(w http.ResponseWriter, r *http.Request) {
	var req struct {
		HiveIDs []string `json:"hiveIds"`
		Date    string   `json:"date"`
		Notes   *string  `json:"notes"`
	}
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if len(req.HiveIDs) == 0 {
		writeError(w, http.StatusBadRequest, "Select at least one hive")
		return
	}
	if strings.TrimSpace(req.Date) == "" {
		writeError(w, http.StatusBadRequest, "Hives and date are required")
		return
	}
	date, err := parseDate(req.Date)
	if err != nil {
		writeError(w, http.StatusBadRequest, "Invalid date")
		return
	}
	hiveIDs := make([]uuid.UUID, 0, len(req.HiveIDs))
	weatherByHive := map[uuid.UUID][]byte{}
	for _, raw := range req.HiveIDs {
		id, err := uuid.Parse(raw)
		if err != nil {
			writeError(w, http.StatusBadRequest, "invalid hive id: "+raw)
			return
		}
		if !s.requireHiveRole(w, r, id, true) {
			return
		}
		hiveIDs = append(hiveIDs, id)
		weatherByHive[id] = s.inspectionWeatherSnapshot(r, id)
	}
	notes := inspectionTrimPtr(req.Notes)

	ctx := r.Context()
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	defer func() { _ = tx.Rollback(ctx) }()
	for _, hiveID := range hiveIDs {
		if _, err := inspectionInsert(ctx, tx, inspectionFields{
			HiveID: hiveID, Date: date, Notes: notes, Weather: weatherByHive[hiveID],
		}); err != nil {
			if inspectionIsFKViolation(err) {
				writeError(w, http.StatusBadRequest, "Hive not found")
				return
			}
			writeError(w, http.StatusInternalServerError, "database error")
			return
		}
	}
	if err := tx.Commit(ctx); err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"success": true, "count": len(hiveIDs)})
}
