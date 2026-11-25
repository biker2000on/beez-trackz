package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/google/uuid"
)

// record_visit (Contract 4): one call for a whole-yard visit. Every entry is
// resolved, validated, deduplicated, and written in its own transaction, so a
// bad entry fails alone and a re-run of the same visit reports duplicates
// instead of writing twice.

const mcpVisitMaxEntries = 100

// mcpInspectionInput is every inspection create field except hiveId, date,
// and sourceMedia, which a visit supplies or does not accept.
type mcpInspectionInput struct {
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
	MiteCounts      []mcpVisitMiteCount   `json:"miteCounts"`
	Notes           *string               `json:"notes"`
}

type mcpVisitFeeding struct {
	Type         string   `json:"type"`
	Quantity     *float64 `json:"quantity"`
	QuantityUnit string   `json:"quantityUnit"`
	FeederType   *string  `json:"feederType"`
	Notes        *string  `json:"notes"`
}

type mcpVisitMiteCount struct {
	Method      string  `json:"method"`
	MitesCount  *int    `json:"mitesCount"`
	SampleSize  *int    `json:"sampleSize"`
	DaysOnBoard *int    `json:"daysOnBoard"`
	Notes       *string `json:"notes"`
}

type mcpVisitTreatment struct {
	Product     string  `json:"product"`
	Method      *string `json:"method"`
	DateRemoved *string `json:"dateRemoved"`
	Notes       *string `json:"notes"`
}

type mcpVisitEntry struct {
	HiveID        *string             `json:"hiveId"`
	PositionLabel *string             `json:"positionLabel"`
	Inspection    *mcpInspectionInput `json:"inspection"`
	Feeding       *mcpVisitFeeding    `json:"feeding"`
	MiteCount     *mcpVisitMiteCount  `json:"miteCount"`
	Treatment     *mcpVisitTreatment  `json:"treatment"`
}

type mcpVisitRequest struct {
	ApiaryID       string          `json:"apiaryId"`
	Date           string          `json:"date"`
	Observation    *string         `json:"observation"`
	AllowDuplicate bool            `json:"allowDuplicate"`
	Entries        []mcpVisitEntry `json:"entries"`
}

// mcpVisit is a decoded, top-level-validated record_visit call.
type mcpVisit struct {
	mcpVisitRequest
	ApiaryUUID uuid.UUID
	Day        time.Time // calendar day label
	At         time.Time // stored instant for records dated Day (parseDate)
}

// decodeMCPVisit strictly decodes record_visit arguments: unknown fields at
// any depth are rejected, and the visit needs an observation or entries.
func decodeMCPVisit(args map[string]json.RawMessage, now time.Time) (mcpVisit, error) {
	var visit mcpVisit
	raw, err := json.Marshal(args)
	if err != nil {
		return visit, err
	}
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&visit.mcpVisitRequest); err != nil {
		return visit, fmt.Errorf("invalid record_visit arguments: %s",
			strings.TrimPrefix(err.Error(), "json: "))
	}
	id, err := uuid.Parse(visit.ApiaryID)
	if err != nil {
		return visit, errors.New("apiaryId must be a UUID")
	}
	visit.ApiaryUUID = id
	day, err := parseCivilDate(visit.Date)
	if err != nil {
		return visit, errors.New("date must be a date (YYYY-MM-DD)")
	}
	if day.After(civilToday(now)) {
		return visit, errors.New("date cannot be in the future")
	}
	visit.Day = day
	visit.At, err = parseDate(visit.Date)
	if err != nil {
		return visit, errors.New("date must be a date (YYYY-MM-DD)")
	}
	if visit.Observation != nil && strings.TrimSpace(*visit.Observation) == "" {
		visit.Observation = nil
	}
	if len(visit.Entries) == 0 && visit.Observation == nil {
		return visit, errors.New("give an observation or at least one entry")
	}
	if len(visit.Entries) > mcpVisitMaxEntries {
		return visit, fmt.Errorf("at most %d entries per visit", mcpVisitMaxEntries)
	}
	return visit, nil
}

type mcpVisitIssue struct {
	Kind  string `json:"kind"`
	Error string `json:"error"`
}

type mcpVisitRef struct {
	Kind       string     `json:"kind"`
	ID         *uuid.UUID `json:"id,omitempty"`
	ExistingID *uuid.UUID `json:"existingId,omitempty"`
	// DateRemovedDefaulted is set on a one-shot treatment whose dateRemoved
	// was filled in from the visit date.
	DateRemovedDefaulted bool `json:"dateRemovedDefaulted,omitempty"`
}

// mcpVisitPlan holds an entry's records, validated and ready to write.
type mcpVisitPlan struct {
	inspection       *inspectionCreateReq
	inspectionFields inspectionFields
	feeding          *feedingFields
	miteCount        *miteCountPayload
	treatment        *treatmentEventFields
	treatmentDefault bool // dateRemoved omitted: apply the one-shot default
}

// mcpVisitEntryTarget checks that an entry names exactly one hive reference.
func mcpVisitEntryTarget(entry mcpVisitEntry) (*uuid.UUID, string, error) {
	hasID := entry.HiveID != nil && strings.TrimSpace(*entry.HiveID) != ""
	hasLabel := entry.PositionLabel != nil && strings.TrimSpace(*entry.PositionLabel) != ""
	switch {
	case hasID && hasLabel:
		return nil, "", errors.New("give hiveId or positionLabel, not both")
	case hasID:
		id, err := uuid.Parse(strings.TrimSpace(*entry.HiveID))
		if err != nil {
			return nil, "", errors.New("hiveId must be a UUID")
		}
		return &id, "", nil
	case hasLabel:
		return nil, strings.TrimSpace(*entry.PositionLabel), nil
	}
	return nil, "", errors.New("hiveId or positionLabel is required")
}

// prepareVisitEntry validates an entry's records against the same rules the
// REST create handlers apply. It never touches the database.
func prepareVisitEntry(entry mcpVisitEntry, hiveID uuid.UUID, visit mcpVisit) (mcpVisitPlan, []mcpVisitIssue) {
	var plan mcpVisitPlan
	issues := []mcpVisitIssue{}
	if entry.Inspection == nil && entry.Feeding == nil && entry.MiteCount == nil && entry.Treatment == nil {
		issues = append(issues, mcpVisitIssue{"entry", "nothing to record: give inspection, feeding, miteCount or treatment"})
		return plan, issues
	}
	if in := entry.Inspection; in != nil {
		req := inspectionCreateReq{
			HiveID: hiveID.String(), Date: visit.Date,
			InspectorName: in.InspectorName, QueenSeen: in.QueenSeen,
			QueenHealth: in.QueenHealth, BroodPattern: in.BroodPattern,
			StoresHoney: in.StoresHoney, StoresPollen: in.StoresPollen,
			Temperament: in.Temperament, FramesOfBees: in.FramesOfBees,
			FramesOfBrood: in.FramesOfBrood, FramesOfStores: in.FramesOfStores,
			CrowdedBrood: in.CrowdedBrood, QueenCupsCount: in.QueenCupsCount,
			QueenCellsCount: in.QueenCellsCount, FlowOn: in.FlowOn,
			Pests: in.Pests, Treatments: in.Treatments, Notes: in.Notes,
		}
		valid := true
		for _, count := range in.MiteCounts {
			payload, msg := visitMitePayload(count, hiveID, visit.Date)
			if msg != "" {
				issues = append(issues, mcpVisitIssue{"inspection", "miteCounts: " + msg})
				valid = false
				continue
			}
			req.MiteCounts = append(req.MiteCounts, payload)
		}
		fields, msg := inspectionFieldsFromReq(&req, hiveID)
		if msg != "" {
			issues = append(issues, mcpVisitIssue{"inspection", msg})
			valid = false
		}
		if valid {
			plan.inspection = &req
			plan.inspectionFields = fields
		}
	}
	if feed := entry.Feeding; feed != nil {
		req := feedingCreateReq{
			HiveID: hiveID.String(), DateFed: visit.Date, Type: feed.Type,
			Quantity: feed.Quantity, QuantityUnit: feed.QuantityUnit,
			FeederType: feed.FeederType, Notes: feed.Notes,
		}
		if msg := feedingValidate(&req); msg != "" {
			issues = append(issues, mcpVisitIssue{"feeding", msg})
		} else {
			plan.feeding = &feedingFields{
				HiveID: hiveID, DateFed: visit.At, Type: req.Type,
				Quantity: *req.Quantity, QuantityUnit: req.QuantityUnit,
				FeederType: feedingFeederPtr(req.FeederType),
				Notes:      inspectionTrimPtr(req.Notes),
			}
		}
	}
	if count := entry.MiteCount; count != nil {
		payload, msg := visitMitePayload(*count, hiveID, visit.Date)
		if msg != "" {
			issues = append(issues, mcpVisitIssue{"miteCount", msg})
		} else {
			plan.miteCount = &payload
		}
	}
	if treatment := entry.Treatment; treatment != nil {
		product := strings.TrimSpace(treatment.Product)
		fields := treatmentEventFields{
			HiveID: hiveID, DateApplied: visit.At, Product: product,
			Method: treatment.Method, Notes: treatment.Notes,
		}
		ok := true
		if product == "" {
			issues = append(issues, mcpVisitIssue{"treatment", "product is required"})
			ok = false
		}
		if treatment.DateRemoved != nil && strings.TrimSpace(*treatment.DateRemoved) != "" {
			removed, err := parseDate(*treatment.DateRemoved)
			switch {
			case err != nil:
				issues = append(issues, mcpVisitIssue{"treatment", "dateRemoved must be a date (YYYY-MM-DD)"})
				ok = false
			case calendarDate(removed).Before(calendarDate(visit.At)):
				issues = append(issues, mcpVisitIssue{"treatment", "dateRemoved must be on or after the visit date"})
				ok = false
			default:
				fields.DateRemoved = &removed
			}
		} else {
			plan.treatmentDefault = true
		}
		if ok {
			plan.treatment = &fields
		}
	}
	return plan, issues
}

// visitMitePayload validates one mite count the way miteCountCreate does.
func visitMitePayload(count mcpVisitMiteCount, hiveID uuid.UUID, date string) (miteCountPayload, string) {
	if count.MitesCount == nil {
		return miteCountPayload{}, "mitesCount is required"
	}
	payload := miteCountPayload{
		HiveID: hiveID, Date: date, Method: count.Method,
		MitesCount: *count.MitesCount, SampleSize: count.SampleSize,
		DaysOnBoard: count.DaysOnBoard, Notes: count.Notes,
	}
	if err := normalizeMiteCount(&payload); err != nil {
		return miteCountPayload{}, "method must be one of alcohol_wash, sugar_roll, sticky_board, visual, " +
			"with a non-negative mitesCount and positive sampleSize/daysOnBoard"
	}
	return payload, ""
}

type mcpVisitHive struct {
	ID       uuid.UUID
	Label    string
	IsActive bool
}

// resolveVisitHive maps an entry's reference to a hive of this apiary. A
// label resolves only to an ACTIVE hive: retired records keep reused labels.
func resolveVisitHive(hives []mcpVisitHive, id *uuid.UUID, label string) (mcpVisitHive, error) {
	if id != nil {
		for _, hive := range hives {
			if hive.ID == *id {
				return hive, nil
			}
		}
		return mcpVisitHive{}, errors.New("hive is not in this apiary")
	}
	matches := []mcpVisitHive{}
	for _, hive := range hives {
		if hive.IsActive && strings.EqualFold(strings.TrimSpace(hive.Label), label) {
			matches = append(matches, hive)
		}
	}
	switch len(matches) {
	case 0:
		return mcpVisitHive{}, fmt.Errorf("no active hive labelled %q in this apiary", label)
	case 1:
		return matches[0], nil
	}
	return mcpVisitHive{}, fmt.Errorf("%d active hives are labelled %q; give hiveId", len(matches), label)
}

type mcpVisitEntryResult struct {
	Index         int             `json:"index"`
	HiveID        *uuid.UUID      `json:"hiveId"`
	PositionLabel *string         `json:"positionLabel"`
	Status        string          `json:"status"` // saved | duplicate | failed
	Created       []mcpVisitRef   `json:"created"`
	Duplicates    []mcpVisitRef   `json:"duplicates"`
	Errors        []mcpVisitIssue `json:"errors"`
}

type mcpVisitObservationResult struct {
	Status     string     `json:"status"` // created | duplicate | failed
	ID         *uuid.UUID `json:"id,omitempty"`
	ExistingID *uuid.UUID `json:"existingId,omitempty"`
	Error      string     `json:"error,omitempty"`
}

type mcpVisitTotals struct {
	Entries          int `json:"entries"`
	SavedEntries     int `json:"savedEntries"`
	DuplicateEntries int `json:"duplicateEntries"`
	FailedEntries    int `json:"failedEntries"`
	CreatedRecords   int `json:"createdRecords"`
	DuplicateRecords int `json:"duplicateRecords"`
}

type mcpVisitResponse struct {
	ApiaryID    uuid.UUID                  `json:"apiaryId"`
	Date        string                     `json:"date"`
	Observation *mcpVisitObservationResult `json:"observation"`
	Entries     []mcpVisitEntryResult      `json:"entries"`
	Totals      mcpVisitTotals             `json:"totals"`
}

func (s *Server) mcpRecordVisit(r *http.Request, args map[string]json.RawMessage) (mcpToolResult, error) {
	visit, err := decodeMCPVisit(args, time.Now())
	if err != nil {
		return mcpToolResult{}, err
	}
	if err := s.mcpRequireApiary(r, visit.ApiaryUUID, true); err != nil {
		return mcpToolResult{}, err
	}
	ctx := r.Context()
	hiveRows, err := s.pool.Query(ctx, `
		SELECT id, position_label, status = 'active' AND NOT is_archived
		FROM hives WHERE apiary_id = $1`, visit.ApiaryUUID)
	if err != nil {
		return mcpToolResult{}, err
	}
	hives := []mcpVisitHive{}
	for hiveRows.Next() {
		var hive mcpVisitHive
		if err := hiveRows.Scan(&hive.ID, &hive.Label, &hive.IsActive); err != nil {
			hiveRows.Close()
			return mcpToolResult{}, err
		}
		hives = append(hives, hive)
	}
	hiveRows.Close()
	if err := hiveRows.Err(); err != nil {
		return mcpToolResult{}, err
	}

	response := mcpVisitResponse{
		ApiaryID: visit.ApiaryUUID,
		Date:     formatCivil(visit.Day),
		Entries:  make([]mcpVisitEntryResult, 0, len(visit.Entries)),
	}
	if visit.Observation != nil {
		response.Observation = s.mcpVisitObservation(ctx, r, visit)
	}
	// Weather is a snapshot of now; only a same-day visit gets one.
	sameDay := visit.Day.Equal(civilToday(time.Now()))
	for index, entry := range visit.Entries {
		result := s.mcpVisitEntry(ctx, r, visit, hives, index, entry, sameDay)
		response.Totals.CreatedRecords += len(result.Created)
		response.Totals.DuplicateRecords += len(result.Duplicates)
		switch result.Status {
		case "saved":
			response.Totals.SavedEntries++
		case "duplicate":
			response.Totals.DuplicateEntries++
		default:
			response.Totals.FailedEntries++
		}
		response.Entries = append(response.Entries, result)
	}
	response.Totals.Entries = len(visit.Entries)
	return mcpToolSuccess(response), nil
}

func (s *Server) mcpVisitObservation(ctx context.Context, r *http.Request, visit mcpVisit) *mcpVisitObservationResult {
	notes := strings.TrimSpace(*visit.Observation)
	if !visit.AllowDuplicate {
		existing, err := findDuplicateObservation(ctx, s.pool, visit.ApiaryUUID, visit.At, notes)
		if err != nil {
			return &mcpVisitObservationResult{Status: "failed", Error: "database error"}
		}
		if existing != nil {
			return &mcpVisitObservationResult{Status: "duplicate", ExistingID: existing}
		}
	}
	var id uuid.UUID
	if err := s.pool.QueryRow(ctx, `
		INSERT INTO apiary_inspections (apiary_id, observed_at, notes, created_by)
		VALUES ($1, $2, $3, $4) RETURNING id`,
		visit.ApiaryUUID, visit.At, notes, actorID(r)).Scan(&id); err != nil {
		return &mcpVisitObservationResult{Status: "failed", Error: "database error"}
	}
	return &mcpVisitObservationResult{Status: "created", ID: &id}
}

func (s *Server) mcpVisitEntry(
	ctx context.Context,
	r *http.Request,
	visit mcpVisit,
	hives []mcpVisitHive,
	index int,
	entry mcpVisitEntry,
	sameDay bool,
) mcpVisitEntryResult {
	result := mcpVisitEntryResult{
		Index: index, Status: "failed",
		Created: []mcpVisitRef{}, Duplicates: []mcpVisitRef{}, Errors: []mcpVisitIssue{},
	}
	fail := func(kind, message string) mcpVisitEntryResult {
		result.Status = "failed"
		result.Created = []mcpVisitRef{}
		result.Errors = append(result.Errors, mcpVisitIssue{kind, message})
		return result
	}
	id, label, err := mcpVisitEntryTarget(entry)
	if err != nil {
		return fail("entry", err.Error())
	}
	if label != "" {
		result.PositionLabel = &label
	}
	hive, err := resolveVisitHive(hives, id, label)
	if err != nil {
		return fail("entry", err.Error())
	}
	result.HiveID = &hive.ID
	result.PositionLabel = &hive.Label

	plan, issues := prepareVisitEntry(entry, hive.ID, visit)
	if len(issues) > 0 {
		result.Errors = append(result.Errors, issues...)
		return result
	}
	if plan.inspection != nil && sameDay {
		plan.inspectionFields.Weather = s.inspectionWeatherSnapshot(r, hive.ID)
	}
	treatmentDefaulted := false
	if plan.treatment != nil && plan.treatmentDefault {
		oneShot, err := s.treatmentIsOneShot(ctx, plan.treatment.Product)
		if err != nil {
			return fail("treatment", "database error")
		}
		if oneShot {
			removed := plan.treatment.DateApplied
			plan.treatment.DateRemoved = &removed
			treatmentDefaulted = true
		}
	}

	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return fail("entry", "database error")
	}
	defer func() { _ = tx.Rollback(ctx) }()
	actor := actorID(r)

	// step runs one record: dedupe (inside the transaction, so it sees what
	// this entry already wrote), then insert.
	step := func(kind string, find func() (*uuid.UUID, error), insert func() (uuid.UUID, string)) bool {
		if !visit.AllowDuplicate {
			existing, err := find()
			if err != nil {
				result.Errors = append(result.Errors, mcpVisitIssue{kind, "database error"})
				return false
			}
			if existing != nil {
				result.Duplicates = append(result.Duplicates, mcpVisitRef{Kind: kind, ExistingID: existing})
				return true
			}
		}
		created, msg := insert()
		if msg != "" {
			result.Errors = append(result.Errors, mcpVisitIssue{kind, msg})
			return false
		}
		ref := mcpVisitRef{Kind: kind, ID: &created}
		if kind == dedupeTreatment {
			ref.DateRemovedDefaulted = treatmentDefaulted
		}
		result.Created = append(result.Created, ref)
		return true
	}

	ok := true
	if plan.inspection != nil {
		ok = step(dedupeInspection,
			func() (*uuid.UUID, error) { return findDuplicateInspection(ctx, tx, hive.ID, visit.Day) },
			func() (uuid.UUID, string) {
				created, _, msg := s.inspectionCreateTx(ctx, tx, plan.inspectionFields, plan.inspection, actor)
				if msg != "" {
					return uuid.Nil, msg
				}
				if err := closeOneShotInspectionTreatments(ctx, tx, created); err != nil {
					return uuid.Nil, "database error"
				}
				return created, ""
			})
	}
	if ok && plan.feeding != nil {
		ok = step(dedupeFeeding,
			func() (*uuid.UUID, error) {
				return findDuplicateFeeding(ctx, tx, hive.ID, visit.Day, plan.feeding.Type)
			},
			func() (uuid.UUID, string) {
				created, err := feedingInsert(ctx, tx, *plan.feeding, actor)
				if err != nil {
					return uuid.Nil, "database error"
				}
				return created, ""
			})
	}
	if ok && plan.miteCount != nil {
		ok = step(dedupeMiteCount,
			func() (*uuid.UUID, error) {
				return findDuplicateMiteCount(ctx, tx, hive.ID, visit.Day, plan.miteCount.Method)
			},
			func() (uuid.UUID, string) {
				created, _, _, err := insertMiteCount(ctx, tx, *plan.miteCount, visit.At, actor)
				if err != nil {
					if miteCountIsUniqueViolation(err) {
						return uuid.Nil, "a mite count already exists for this hive, date, and method"
					}
					return uuid.Nil, "database error"
				}
				return created, ""
			})
	}
	if ok && plan.treatment != nil {
		ok = step(dedupeTreatment,
			func() (*uuid.UUID, error) {
				return findDuplicateTreatment(ctx, tx, hive.ID, visit.Day, plan.treatment.Product)
			},
			func() (uuid.UUID, string) {
				created, err := s.treatmentEventInsert(ctx, tx, *plan.treatment)
				if err != nil {
					return uuid.Nil, "database error"
				}
				return created, ""
			})
	}
	if !ok {
		// Rolled back by the deferred Rollback: nothing from this entry
		// was written.
		result.Status = "failed"
		result.Created = []mcpVisitRef{}
		return result
	}
	if err := tx.Commit(ctx); err != nil {
		return fail("entry", "database error")
	}
	if len(result.Created) > 0 {
		result.Status = "saved"
	} else {
		result.Status = "duplicate"
	}
	return result
}
