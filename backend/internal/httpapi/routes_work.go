package httpapi

import (
	"context"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	"github.com/biker2000on/beez-trackz/backend/internal/app/work"
)

const harvestReadyStores = 4

func hiveLockoutDetail(st lockoutStatus) string {
	product := st.Product
	if product == "" {
		product = "Treatment"
	}
	if st.TreatmentOn {
		return product + " still on · date-on " + calendarDate(st.DateApplied).Format("2006-01-02")
	}
	if st.DateRemoved != nil && st.Until != nil {
		return product + " off " + calendarDate(*st.DateRemoved).Format("2006-01-02") +
			" · " + strconv.Itoa(st.WithdrawalDays) + "-day withdrawal"
	}
	return product
}

func storesLabel(stores int) string {
	return strconv.Itoa(stores) + "/5"
}

// The WorkItem projection endpoints (design 2026-09-03, section 4.8). This
// file is transport only: it reads the facts, hands them to app/work, and
// writes the projection. Every rule — ids, the feeder_check behaviour,
// ranking, per-command permission and offline disposition — lives in
// app/work, so Today and the yard queue cannot disagree about the same item
// the way the two assemblers they replace do.
//
// The retired yard queue assembler is gone. routes_work_db_test.go pins the
// replacement to the fixture expectation that was frozen while both read
// models were available.

func (s *Server) mountWork(r chi.Router) {
	r.Get("/work/today", s.handleWorkToday)
	r.Get("/work/yard", s.handleWorkYard)
}

// GET /work/today — the field slice grouped into "needs attention" and
// "today's field actions".
func (s *Server) handleWorkToday(w http.ResponseWriter, r *http.Request) {
	items, asOf, ok := s.workItems(w, r)
	if !ok {
		return
	}
	writeJSON(w, http.StatusOK, work.Today(asOf, items))
}

// GET /work/yard — the same items grouped by yard.
func (s *Server) handleWorkYard(w http.ResponseWriter, r *http.Request) {
	items, asOf, ok := s.workItems(w, r)
	if !ok {
		return
	}
	writeJSON(w, http.StatusOK, work.YardView(asOf, items))
}

// workItems is the shared body of both handlers: authorize, read, project.
func (s *Server) workItems(w http.ResponseWriter, r *http.Request) ([]work.Item, time.Time, bool) {
	filter, err := workFilter(r)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return nil, time.Time{}, false
	}
	inputs, err := s.workInputs(r, filter)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return nil, time.Time{}, false
	}
	// offlineRoutes.supports is the manifest the service worker is
	// generated from, so no item can advertise a queueable command the
	// service worker would refuse to queue.
	items := work.Build(inputs, appActor(r), filter, offlineRoutes.supports)
	return items, inputs.AsOf, true
}

// workFilter parses the query string. Repeated and comma-separated values
// both work, so status=open,snoozed and status=open&status=snoozed mean the
// same thing.
func workFilter(r *http.Request) (work.Filter, error) {
	query := r.URL.Query()
	filter := work.Filter{
		Statuses:    csvValues(query["status"]),
		Priorities:  csvValues(query["priority"]),
		SourceTypes: csvValues(query["sourceType"]),
	}
	if raw := strings.TrimSpace(query.Get("apiaryId")); raw != "" {
		apiaryID, err := uuid.Parse(raw)
		if err != nil {
			return work.Filter{}, errInvalidApiaryID
		}
		filter.ApiaryID = &apiaryID
	}
	return filter, nil
}

type workFilterError string

func (e workFilterError) Error() string { return string(e) }

const errInvalidApiaryID workFilterError = "invalid apiaryId"

func csvValues(raw []string) []string {
	out := make([]string, 0, len(raw))
	for _, value := range raw {
		for _, part := range strings.Split(value, ",") {
			if part = strings.TrimSpace(part); part != "" {
				out = append(out, part)
			}
		}
	}
	return out
}

// workInputs reads every fact the projection needs, at one wall-clock
// instant. It reuses the existing readers — loadHiveLockouts and
// listFeedingStatus — rather than restating them, so the lockout walk and
// the feeding-status evaluation keep exactly one implementation each.
func (s *Server) workInputs(r *http.Request, filter work.Filter) (work.Inputs, error) {
	ctx := r.Context()
	user := principalFrom(r)
	now := time.Now()
	inputs := work.Inputs{AsOf: now}

	hives, byHive, err := s.workVisibleHives(ctx, user)
	if err != nil {
		return work.Inputs{}, err
	}
	hiveIDs := make([]uuid.UUID, 0, len(hives))
	for _, hive := range hives {
		hiveIDs = append(hiveIDs, hive.ID)
	}

	lockouts, err := loadHiveLockouts(ctx, s.pool, hiveIDs, now)
	if err != nil {
		return work.Inputs{}, err
	}
	for _, hive := range hives {
		status := lockouts[hive.ID]
		if !status.Locked {
			continue
		}
		inputs.Lockouts = append(inputs.Lockouts, work.LockoutFact{
			TreatmentEventID: status.TreatmentID,
			HiveID:           hive.ID,
			HiveName:         hive.Name,
			ApiaryID:         hive.ApiaryID,
			ApiaryName:       hive.ApiaryName,
			Title:            lockoutMessage(status),
			Detail:           hiveLockoutDetail(status),
			Until:            status.Until,
			DateApplied:      status.DateApplied,
		})
	}

	inputs.Recommendations, err = s.workRecommendations(ctx, user, filter)
	if err != nil {
		return work.Inputs{}, err
	}

	feedings, err := s.listFeedingStatus(ctx, user)
	if err != nil {
		return work.Inputs{}, err
	}
	for _, row := range feedings {
		// Same gate as the yard queue: a hive is only work when the status
		// evaluation produced an action to take.
		if row.State == feedingStateOK || row.Action == "" || row.ActionFeedingID == nil {
			continue
		}
		inputs.Feedings = append(inputs.Feedings, work.FeedingFact{
			FeedingID:  *row.ActionFeedingID,
			HiveID:     row.HiveID,
			HiveName:   row.HiveName,
			ApiaryID:   row.ApiaryID,
			ApiaryName: row.ApiaryName,
			State:      row.State,
			Action:     row.Action,
			Evidence:   row.Evidence,
			ObservedAt: workFeedingObservedAt(row),
		})
	}

	inputs.HarvestReady, err = s.workHarvestReady(ctx, user, byHive, lockouts)
	if err != nil {
		return work.Inputs{}, err
	}
	return inputs, nil
}

// workFeedingObservedAt is the observation the action is about: the
// unverified record when the action is a verify, otherwise the open feeder —
// the same choice feedingStatusEvaluate makes for ActionFeedingID.
func workFeedingObservedAt(row feedingStatusRow) *time.Time {
	if row.UnverifiedFeeders > 0 {
		return row.OldestUnverifiedAt
	}
	return row.OldestOpenAt
}

type workHiveRef struct {
	ID         uuid.UUID
	Name       string
	ApiaryID   uuid.UUID
	ApiaryName string
}

// workVisibleHives is yard_queue.go:44-56 verbatim: active, unarchived hives
// in yards this principal may read, ordered by yard then hive.
func (s *Server) workVisibleHives(
	ctx context.Context, user *principal,
) ([]workHiveRef, map[uuid.UUID]workHiveRef, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT h.id, h.position_label, a.id, a.name
		FROM hives h
		JOIN apiaries a ON a.id = h.apiary_id
		WHERE h.is_archived = false AND h.status = 'active'
		  AND ($1::boolean OR EXISTS (
			SELECT 1 FROM apiary_memberships membership
			WHERE membership.user_id = $2 AND membership.apiary_id = a.id
		  ))
		ORDER BY a.name, h.position_label`, user.IsAdmin, user.ID)
	if err != nil {
		return nil, nil, err
	}
	defer rows.Close()
	hives := make([]workHiveRef, 0)
	byHive := map[uuid.UUID]workHiveRef{}
	for rows.Next() {
		var hive workHiveRef
		if err := rows.Scan(&hive.ID, &hive.Name, &hive.ApiaryID, &hive.ApiaryName); err != nil {
			return nil, nil, err
		}
		hives = append(hives, hive)
		byHive[hive.ID] = hive
	}
	return hives, byHive, rows.Err()
}

// workRecommendations reads the recommendation rows in scope.
//
// Two differences from yard_queue.go:131-135. There is no
// `rec.type <> 'feeder_check'` exclusion — the suppression decision belongs
// to the projection now (section 4.6), and doing it in SQL is what made an
// orphan feeder_check invisible. And the visibility predicate follows the
// requested statuses, so the recommendation triage view can ask for snoozed
// and dismissed rows through the same endpoint.
func (s *Server) workRecommendations(
	ctx context.Context, user *principal, filter work.Filter,
) ([]work.RecommendationFact, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT rec.id, rec.hive_id, rec.type, rec.message, rec.priority,
		       rec.created_at, rec.dismissed, rec.snoozed_until,
		       h.position_label, h.apiary_id, a.name
		FROM ai_recommendations rec
		LEFT JOIN hives h ON h.id = rec.hive_id
		LEFT JOIN apiaries a ON a.id = h.apiary_id
		WHERE `+workRecommendationWhere(filter)+`
		  AND ($1::boolean OR rec.hive_id IS NULL OR EXISTS (
			SELECT 1 FROM apiary_memberships membership
			WHERE membership.user_id=$2 AND membership.apiary_id=h.apiary_id
		  ))
		ORDER BY rec.created_at DESC`, user.IsAdmin, user.ID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]work.RecommendationFact, 0)
	for rows.Next() {
		var fact work.RecommendationFact
		if err := rows.Scan(&fact.ID, &fact.HiveID, &fact.Type, &fact.Message,
			&fact.Priority, &fact.CreatedAt, &fact.Dismissed, &fact.SnoozedUntil,
			&fact.HiveName, &fact.ApiaryID, &fact.ApiaryName); err != nil {
			return nil, err
		}
		out = append(out, fact)
	}
	return out, rows.Err()
}

// workRecommendationWhere widens the read to every row when the caller asked
// for a status other than open. The projection then derives each row's own
// status and the filter drops what was not asked for, so the SQL predicate
// and the projection can never disagree about what "snoozed" means.
func workRecommendationWhere(filter work.Filter) string {
	for _, status := range filter.Statuses {
		if !strings.EqualFold(strings.TrimSpace(status), "open") {
			return "TRUE"
		}
	}
	return recPendingWhere
}

// workHarvestReady is yard_queue.go:203-232 with the inspection id added:
// section 4.3 keys the item on the reading it came from, so a re-read is the
// same item and a new inspection is a new one.
func (s *Server) workHarvestReady(
	ctx context.Context,
	user *principal,
	byHive map[uuid.UUID]workHiveRef,
	lockouts map[uuid.UUID]lockoutStatus,
) ([]work.HarvestReadyFact, error) {
	rows, err := s.pool.Query(ctx, `
		WITH latest AS (
			SELECT DISTINCT ON (i.hive_id) i.hive_id, i.id, i.stores_honey, i.date
			FROM inspections i
			ORDER BY i.hive_id, i.date DESC
		)
		SELECT h.id, latest.id, latest.stores_honey, latest.date
		FROM hives h
		JOIN latest ON latest.hive_id = h.id
		WHERE h.is_archived = false AND h.status = 'active'
		  AND latest.stores_honey IS NOT NULL AND latest.stores_honey >= $1
		  AND latest.date >= now() - interval '60 days'
		  AND NOT EXISTS (
			SELECT 1 FROM honey_harvests hh
			WHERE hh.hive_id = h.id AND hh.deleted_at IS NULL
			  AND hh.date >= latest.date
		  )
		  AND ($2::boolean OR EXISTS (
			SELECT 1 FROM apiary_memberships membership
			WHERE membership.user_id = $3 AND membership.apiary_id = h.apiary_id
		  ))`, harvestReadyStores, user.IsAdmin, user.ID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]work.HarvestReadyFact, 0)
	for rows.Next() {
		var hiveID, inspectionID uuid.UUID
		var stores int
		var inspected time.Time
		if err := rows.Scan(&hiveID, &inspectionID, &stores, &inspected); err != nil {
			return nil, err
		}
		// A locked-out hive is not harvest-ready; the lockout item already
		// says why, so a second item saying "pull honey" would contradict it.
		if lockouts[hiveID].Locked {
			continue
		}
		hive, ok := byHive[hiveID]
		if !ok {
			continue
		}
		out = append(out, work.HarvestReadyFact{
			InspectionID: inspectionID,
			HiveID:       hive.ID,
			HiveName:     hive.Name,
			ApiaryID:     hive.ApiaryID,
			ApiaryName:   hive.ApiaryName,
			Detail:       "Stores " + storesLabel(stores) + " · not locked out",
			InspectedAt:  inspected,
		})
	}
	return out, rows.Err()
}
