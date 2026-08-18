package httpapi

import (
	"net/http"
	"sort"
	"strconv"
	"time"

	"github.com/google/uuid"
)

// Saturday yard queue: one payload the phone can cache. Composed from open
// recommendations, harvest-ready hives, feeders that need a refill, and
// current lockout end dates. Not a fourth recommendations inbox.

const harvestReadyStores = 4

type yardQueueItem struct {
	Kind     string     `json:"kind"`
	HiveID   *uuid.UUID `json:"hiveId"`
	HiveName *string    `json:"hiveName"`
	Title    string     `json:"title"`
	Detail   string     `json:"detail"`
	Priority string     `json:"priority"`
	Href     string     `json:"href"`
	Until    *time.Time `json:"lockoutUntil,omitempty"`
}

type yardQueueYard struct {
	ApiaryID   uuid.UUID       `json:"apiaryId"`
	ApiaryName string          `json:"apiaryName"`
	Items      []yardQueueItem `json:"items"`
}

func (s *Server) yardQueue(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	user := principalFrom(r)
	now := time.Now()

	type hiveRef struct {
		ID         uuid.UUID
		Name       string
		ApiaryID   uuid.UUID
		ApiaryName string
	}
	hives := make([]hiveRef, 0)
	hiveRows, err := s.pool.Query(ctx, `
		SELECT h.id, h.position_label, a.id, a.name
		FROM hives h
		JOIN apiaries a ON a.id = h.apiary_id
		WHERE h.is_archived = false
		  AND ($1::boolean OR EXISTS (
			SELECT 1 FROM apiary_memberships membership
			WHERE membership.user_id = $2 AND membership.apiary_id = a.id
		  ))
		ORDER BY a.name, h.position_label`, user.IsAdmin, user.ID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	hiveIDs := make([]uuid.UUID, 0)
	byHive := map[uuid.UUID]hiveRef{}
	for hiveRows.Next() {
		var hive hiveRef
		if err := hiveRows.Scan(&hive.ID, &hive.Name, &hive.ApiaryID, &hive.ApiaryName); err != nil {
			hiveRows.Close()
			writeError(w, http.StatusInternalServerError, "database error")
			return
		}
		hives = append(hives, hive)
		hiveIDs = append(hiveIDs, hive.ID)
		byHive[hive.ID] = hive
	}
	hiveErr := hiveRows.Err()
	hiveRows.Close()
	if hiveErr != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}

	lockouts, err := loadHiveLockouts(ctx, s.pool, hiveIDs, now)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}

	yards := map[uuid.UUID]*yardQueueYard{}
	ensure := func(apiaryID uuid.UUID, name string) *yardQueueYard {
		if yard, ok := yards[apiaryID]; ok {
			return yard
		}
		yard := &yardQueueYard{
			ApiaryID: apiaryID, ApiaryName: name, Items: []yardQueueItem{},
		}
		yards[apiaryID] = yard
		return yard
	}
	addHiveItem := func(hive hiveRef, item yardQueueItem) {
		id := hive.ID
		name := hive.Name
		item.HiveID = &id
		item.HiveName = &name
		if item.Href == "" {
			item.Href = "/hives/" + hive.ID.String()
		}
		ensure(hive.ApiaryID, hive.ApiaryName).Items = append(
			ensure(hive.ApiaryID, hive.ApiaryName).Items, item)
	}

	for _, hive := range hives {
		st := lockouts[hive.ID]
		if !st.Locked {
			continue
		}
		item := yardQueueItem{
			Kind:     "lockout",
			Title:    lockoutMessage(st),
			Detail:   hiveLockoutDetail(st),
			Priority: "high",
			Until:    st.Until,
		}
		addHiveItem(hive, item)
	}

	recRows, err := s.pool.Query(ctx, `
		SELECT rec.id, rec.hive_id, rec.type, rec.message, rec.priority,
		       h.position_label, h.apiary_id, a.name
		FROM ai_recommendations rec
		LEFT JOIN hives h ON h.id = rec.hive_id
		LEFT JOIN apiaries a ON a.id = h.apiary_id
		WHERE `+recPendingWhere+`
		  AND rec.type <> 'feeder_check'
		  AND ($1::boolean OR rec.hive_id IS NULL OR EXISTS (
			SELECT 1 FROM apiary_memberships membership
			WHERE membership.user_id=$2 AND membership.apiary_id=h.apiary_id
		  ))
		ORDER BY rec.created_at DESC`, user.IsAdmin, user.ID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	for recRows.Next() {
		var (
			id       uuid.UUID
			hiveID   *uuid.UUID
			recType  string
			message  string
			priority string
			hiveName *string
			apiaryID *uuid.UUID
			apiary   *string
		)
		if err := recRows.Scan(&id, &hiveID, &recType, &message, &priority,
			&hiveName, &apiaryID, &apiary); err != nil {
			recRows.Close()
			writeError(w, http.StatusInternalServerError, "database error")
			return
		}
		item := yardQueueItem{
			Kind:     "recommendation",
			HiveID:   hiveID,
			HiveName: hiveName,
			Title:    yardQueueRecTitle(recType),
			Detail:   message,
			Priority: priority,
			Href:     "/recommendations",
		}
		if hiveID != nil {
			item.Href = "/hives/" + hiveID.String()
		}
		if apiaryID != nil && apiary != nil {
			ensure(*apiaryID, *apiary).Items = append(ensure(*apiaryID, *apiary).Items, item)
			continue
		}
		// Hive-less recs sit on a catch-all yard so they still appear.
		unassigned := uuid.Nil
		ensure(unassigned, "All yards").Items = append(
			ensure(unassigned, "All yards").Items, item)
	}
	recErr := recRows.Err()
	recRows.Close()
	if recErr != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}

	feedRows, err := s.listFeedingStatus(ctx, user)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	for _, row := range feedRows {
		if row.State == feedingStateOK || row.Action == "" {
			continue
		}
		hive, ok := byHive[row.HiveID]
		if !ok {
			hive = hiveRef{
				ID: row.HiveID, Name: row.HiveName,
				ApiaryID: row.ApiaryID, ApiaryName: row.ApiaryName,
			}
		}
		priority := "high"
		if row.State == feedingStateAttention {
			priority = "urgent"
		}
		addHiveItem(hive, yardQueueItem{
			Kind:     "feeding",
			Title:    row.Action,
			Detail:   row.Evidence,
			Priority: priority,
			Href:     "/hives/" + row.HiveID.String() + "?tab=timeline&view=feedings",
		})
	}

	readyRows, err := s.pool.Query(ctx, `
		SELECT DISTINCT ON (h.id)
			h.id, i.stores_honey, i.date
		FROM hives h
		JOIN inspections i ON i.hive_id = h.id
		WHERE h.is_archived = false AND h.status = 'active'
		  AND i.stores_honey IS NOT NULL AND i.stores_honey >= $1
		  AND ($2::boolean OR EXISTS (
			SELECT 1 FROM apiary_memberships membership
			WHERE membership.user_id = $3 AND membership.apiary_id = h.apiary_id
		  ))
		ORDER BY h.id, i.date DESC`, harvestReadyStores, user.IsAdmin, user.ID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	for readyRows.Next() {
		var hiveID uuid.UUID
		var stores int
		var inspected time.Time
		if err := readyRows.Scan(&hiveID, &stores, &inspected); err != nil {
			readyRows.Close()
			writeError(w, http.StatusInternalServerError, "database error")
			return
		}
		if lockouts[hiveID].Locked {
			continue
		}
		hive, ok := byHive[hiveID]
		if !ok {
			continue
		}
		addHiveItem(hive, yardQueueItem{
			Kind:     "harvest_ready",
			Title:    "Pull honey",
			Detail:   "Stores " + storesLabel(stores) + " · not locked out",
			Priority: "normal",
			Href:     "/hives/" + hiveID.String(),
		})
	}
	readyErr := readyRows.Err()
	readyRows.Close()
	if readyErr != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}

	out := make([]yardQueueYard, 0, len(yards))
	for _, yard := range yards {
		if len(yard.Items) == 0 {
			continue
		}
		sort.SliceStable(yard.Items, func(i, j int) bool {
			ri, rj := yardQueueRank(yard.Items[i]), yardQueueRank(yard.Items[j])
			if ri != rj {
				return ri < rj
			}
			return yardQueueItemName(yard.Items[i]) < yardQueueItemName(yard.Items[j])
		})
		out = append(out, *yard)
	}
	sort.SliceStable(out, func(i, j int) bool {
		if out[i].ApiaryID == uuid.Nil {
			return false
		}
		if out[j].ApiaryID == uuid.Nil {
			return true
		}
		return out[i].ApiaryName < out[j].ApiaryName
	})

	writeJSON(w, http.StatusOK, map[string]any{
		"asOf":  now,
		"yards": out,
	})
}

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

func yardQueueRecTitle(recType string) string {
	switch recType {
	case "treat_now":
		return "Treat for Varroa"
	case "mite_check_due":
		return "Sample for mites"
	case "inspection_due":
		return "Inspect this hive"
	case "treatment_reminder":
		return "Review treatment"
	case "equipment_needed":
		return "Add equipment"
	case "seasonal_prep":
		return "Seasonal prep"
	default:
		return "Review"
	}
}

func yardQueueRank(item yardQueueItem) int {
	switch item.Kind {
	case "lockout":
		return 0
	case "recommendation":
		switch item.Priority {
		case "urgent":
			return 1
		case "high":
			return 2
		default:
			return 4
		}
	case "feeding":
		if item.Priority == "urgent" {
			return 1
		}
		return 3
	case "harvest_ready":
		return 5
	default:
		return 6
	}
}

func yardQueueItemName(item yardQueueItem) string {
	if item.HiveName != nil {
		return *item.HiveName
	}
	return item.Title
}
