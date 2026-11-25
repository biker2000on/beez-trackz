package httpapi

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/google/uuid"
)

const mcpObservationLimit = 500

// mcpOptionalCivilRange parses optional from/to dates. Either end may be
// open; nil means unbounded.
func mcpOptionalCivilRange(args map[string]json.RawMessage) (*time.Time, *time.Time, error) {
	parse := func(name string) (*time.Time, error) {
		raw, err := mcpString(args, name)
		if err != nil || raw == nil || strings.TrimSpace(*raw) == "" {
			return nil, err
		}
		day, err := parseCivilDate(*raw)
		if err != nil {
			return nil, fmt.Errorf("%s must be a date (YYYY-MM-DD)", name)
		}
		return &day, nil
	}
	from, err := parse("from")
	if err != nil {
		return nil, nil, err
	}
	to, err := parse("to")
	if err != nil {
		return nil, nil, err
	}
	if from != nil && to != nil && from.After(*to) {
		return nil, nil, errors.New("from must be on or before to")
	}
	return from, to, nil
}

func (s *Server) mcpListApiaryObservations(r *http.Request, args map[string]json.RawMessage) (mcpToolResult, error) {
	apiaryID, err := mcpUUID(args, "apiaryId", true)
	if err != nil {
		return mcpToolResult{}, err
	}
	from, to, err := mcpOptionalCivilRange(args)
	if err != nil {
		return mcpToolResult{}, err
	}
	// Same rule as GET /apiary-inspections.
	if err := s.mcpRequireOwner(r, "apiary", *apiaryID, false); err != nil {
		return mcpToolResult{}, err
	}
	var lower, upper *time.Time
	if from != nil {
		v := from.AddDate(0, 0, -2)
		lower = &v
	}
	if to != nil {
		v := to.AddDate(0, 0, 3)
		upper = &v
	}
	rows, err := s.pool.Query(r.Context(), `
		SELECT id, observed_at, notes, created_at FROM apiary_inspections
		WHERE apiary_id = $1
		  AND ($2::timestamptz IS NULL OR observed_at >= $2::timestamptz)
		  AND ($3::timestamptz IS NULL OR observed_at < $3::timestamptz)
		ORDER BY observed_at DESC, id DESC
		LIMIT $4`, *apiaryID, lower, upper, mcpObservationLimit+50)
	if err != nil {
		return mcpToolResult{}, err
	}
	defer rows.Close()
	out := []map[string]any{}
	for rows.Next() {
		var id uuid.UUID
		var observed, created time.Time
		var notes string
		if err := rows.Scan(&id, &observed, &notes, &created); err != nil {
			return mcpToolResult{}, err
		}
		day := eventDay(observed)
		if (from != nil && day.Before(*from)) || (to != nil && day.After(*to)) {
			continue
		}
		if len(out) >= mcpObservationLimit {
			break
		}
		out = append(out, map[string]any{
			"id": id, "apiaryId": *apiaryID, "observedAt": observed,
			"date": formatCivil(day), "notes": notes, "createdAt": created,
		})
	}
	if err := rows.Err(); err != nil {
		return mcpToolResult{}, err
	}
	return mcpToolSuccess(out), nil
}

// mcpVarroaSummary wraps the fleet varroa analytics (GET /analytics/varroa),
// narrowed to one apiary and, with season, to one year.
func (s *Server) mcpVarroaSummary(r *http.Request, args map[string]json.RawMessage) (mcpToolResult, error) {
	apiaryID, err := mcpUUID(args, "apiaryId", false)
	if err != nil {
		return mcpToolResult{}, err
	}
	var season *int
	if raw, ok := args["season"]; ok && string(raw) != "null" {
		var year int
		if err := json.Unmarshal(raw, &year); err != nil || year < 2000 || year > 2200 {
			return mcpToolResult{}, errors.New("season must be a year between 2000 and 2200")
		}
		season = &year
	}
	if apiaryID != nil {
		if err := s.mcpRequireApiary(r, *apiaryID, false); err != nil {
			return mcpToolResult{}, err
		}
	}
	recorder, err := mcpInvoke(r, s.varroaAnalytics, nil, nil, nil)
	if err != nil {
		return mcpToolResult{}, err
	}
	if recorder.Code != http.StatusOK {
		return mcpToolResult{}, mcpRecorderError(recorder)
	}
	var fleet map[string]any
	if err := json.Unmarshal(recorder.Body.Bytes(), &fleet); err != nil {
		return mcpToolResult{}, err
	}

	hives, _ := fleet["hives"].([]any)
	kept := make([]any, 0, len(hives))
	keptIDs := map[string]bool{}
	ids := make([]uuid.UUID, 0, len(hives))
	over := 0
	for _, raw := range hives {
		hive, _ := raw.(map[string]any)
		if apiaryID != nil && hive["apiaryId"] != apiaryID.String() {
			continue
		}
		id, _ := hive["hiveId"].(string)
		keptIDs[id] = true
		if parsed, err := uuid.Parse(id); err == nil {
			ids = append(ids, parsed)
		}
		if flag, _ := hive["overThreshold"].(bool); flag {
			over++
		}
		kept = append(kept, hive)
	}
	treatments, _ := fleet["treatments"].([]any)
	keptTreatments := make([]any, 0, len(treatments))
	for _, raw := range treatments {
		treatment, _ := raw.(map[string]any)
		if id, _ := treatment["hiveId"].(string); !keptIDs[id] {
			continue
		}
		if season != nil {
			applied, _ := treatment["dateApplied"].(string)
			at, err := time.Parse(time.RFC3339Nano, applied)
			if err != nil || eventDay(at).Year() != *season {
				continue
			}
		}
		keptTreatments = append(keptTreatments, treatment)
	}
	fleet["hives"] = kept
	fleet["treatments"] = keptTreatments
	fleet["overThresholdCount"] = over
	fleet["apiaryId"] = apiaryID
	fleet["season"] = season

	if season != nil && len(ids) > 0 {
		lower := time.Date(*season, time.January, 1, 0, 0, 0, 0, time.UTC).AddDate(0, 0, -2)
		upper := time.Date(*season+1, time.January, 1, 0, 0, 0, 0, time.UTC).AddDate(0, 0, 2)
		rows, err := s.pool.Query(r.Context(), `
			SELECT `+miteCountSelectCols+` FROM mite_counts
			WHERE hive_id = ANY($1) AND deleted_at IS NULL AND date >= $2 AND date < $3
			ORDER BY date, method`, ids, lower, upper)
		if err != nil {
			return mcpToolResult{}, err
		}
		byHive := map[string][]miteCountJSON{}
		for rows.Next() {
			count, err := scanMiteCount(rows)
			if err != nil {
				rows.Close()
				return mcpToolResult{}, err
			}
			if eventDay(count.Date).Year() == *season {
				byHive[count.HiveID.String()] = append(byHive[count.HiveID.String()], count)
			}
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return mcpToolResult{}, err
		}
		for _, raw := range kept {
			hive := raw.(map[string]any)
			id, _ := hive["hiveId"].(string)
			counts := byHive[id]
			if counts == nil {
				counts = []miteCountJSON{}
			}
			hive["seasonCounts"] = counts
		}
	}
	return mcpToolSuccess(fleet), nil
}

type mcpTreatmentLock struct {
	HiveID        uuid.UUID `json:"hiveId"`
	PositionLabel string    `json:"positionLabel"`
	ApiaryID      uuid.UUID `json:"apiaryId"`
	ApiaryName    string    `json:"apiaryName"`
	hiveLockoutJSON
	// LockoutUntilDate is the first day honey is clear, as YYYY-MM-DD; null
	// while a treatment is still in (or nothing is locking the hive).
	LockoutUntilDate *string `json:"lockoutUntilDate"`
}

// mcpTreatmentLocks reports, for every visible active hive, the lockout the
// hive record shows (lockout.go), evaluated today.
func (s *Server) mcpTreatmentLocks(r *http.Request, args map[string]json.RawMessage) (mcpToolResult, error) {
	apiaryID, err := mcpUUID(args, "apiaryId", false)
	if err != nil {
		return mcpToolResult{}, err
	}
	if apiaryID != nil {
		if err := s.mcpRequireApiary(r, *apiaryID, false); err != nil {
			return mcpToolResult{}, err
		}
	}
	user := principalFrom(r)
	rows, err := s.pool.Query(r.Context(), `
		SELECT h.id, h.position_label, a.id, a.name
		FROM hives h JOIN apiaries a ON a.id = h.apiary_id
		WHERE h.status = 'active' AND NOT h.is_archived
		  AND ($1::uuid IS NULL OR h.apiary_id = $1)
		  AND ($2::boolean OR EXISTS (
			SELECT 1 FROM apiary_memberships membership
			WHERE membership.user_id=$3 AND membership.apiary_id=h.apiary_id
		  ))
		ORDER BY a.name, h.position_label`, apiaryID, user.IsAdmin, user.ID)
	if err != nil {
		return mcpToolResult{}, err
	}
	items := make([]mcpTreatmentLock, 0)
	ids := make([]uuid.UUID, 0)
	for rows.Next() {
		var item mcpTreatmentLock
		if err := rows.Scan(&item.HiveID, &item.PositionLabel, &item.ApiaryID, &item.ApiaryName); err != nil {
			rows.Close()
			return mcpToolResult{}, err
		}
		items = append(items, item)
		ids = append(ids, item.HiveID)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return mcpToolResult{}, err
	}
	now := time.Now()
	byHive, err := loadHiveLockouts(r.Context(), s.pool, ids, now)
	if err != nil {
		return mcpToolResult{}, err
	}
	locked := 0
	for i := range items {
		status := byHive[items[i].HiveID]
		items[i].hiveLockoutJSON = *status.toJSON()
		if status.Locked {
			locked++
			if status.Until != nil {
				// Until is a calendar date in its own location (calendarDate).
				until := status.Until.Format(civilDateLayout)
				items[i].LockoutUntilDate = &until
			}
		}
	}
	return mcpToolSuccess(map[string]any{
		"asOf":        formatCivil(civilToday(now)),
		"lockedCount": locked,
		"hives":       items,
	}), nil
}
