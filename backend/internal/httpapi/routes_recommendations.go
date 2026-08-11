package httpapi

import (
	"errors"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/hibiken/asynq"

	"github.com/biker2000on/beez-trackz/backend/internal/jobs"
)

// mountRecommendations wires the recommendation endpoints.
func (s *Server) mountRecommendations(r chi.Router) {
	r.Get("/recommendations", s.handleRecommendationsList)
	r.Get("/recommendations/count", s.handleRecommendationsCount)
	r.Post("/recommendations/state", s.handleRecommendationsState)
	r.With(s.requireEntityParamRole("recommendation", true)).
		Post("/recommendations/{id}/dismiss", s.handleRecommendationDismiss)
	r.With(s.requireEntityParamRole("recommendation", true)).
		Post("/recommendations/{id}/snooze", s.handleRecommendationSnooze)
	r.With(s.requireEntityParamRole("recommendation", true)).
		Post("/recommendations/{id}/restore", s.handleRecommendationRestore)
	r.With(s.requireAdmin).Post("/recommendations/run", s.handleRecommendationsRun)
}

type recommendationJSON struct {
	ID           uuid.UUID  `json:"id"`
	HiveID       *uuid.UUID `json:"hiveId"`
	Type         string     `json:"type"`
	Message      string     `json:"message"`
	Priority     string     `json:"priority"`
	Dismissed    bool       `json:"dismissed"`
	CreatedAt    time.Time  `json:"createdAt"`
	HiveName     *string    `json:"hiveName"`
	SnoozedUntil *time.Time `json:"snoozedUntil"`
	DismissedAt  *time.Time `json:"dismissedAt"`
}

// Visibility predicates per view. "pending" is what needs triage now: not
// dismissed and not under an active snooze. "dismissed" is the completed
// pile. "all" additionally surfaces rows that are merely snoozed.
const recPendingWhere = `rec.dismissed = false
	AND (rec.snoozed_until IS NULL OR rec.snoozed_until <= now())`

func recViewWhere(view string) string {
	switch view {
	case "all":
		return "TRUE"
	case "dismissed":
		return "rec.dismissed = true"
	default:
		return recPendingWhere
	}
}

// GET /recommendations?view=pending|all|dismissed — urgent<high<normal<low
// then newest first, with the hive position label joined for display.
func (s *Server) handleRecommendationsList(w http.ResponseWriter, r *http.Request) {
	rows, err := s.pool.Query(r.Context(), `
		SELECT rec.id, rec.hive_id, rec.type, rec.message, rec.priority, rec.dismissed,
		       rec.created_at, h.position_label, rec.snoozed_until, rec.dismissed_at
		FROM ai_recommendations rec
		LEFT JOIN hives h ON h.id = rec.hive_id
		WHERE `+recViewWhere(r.URL.Query().Get("view"))+`
		  AND ($1::boolean OR EXISTS (
			SELECT 1 FROM apiary_memberships membership
			WHERE membership.user_id=$2 AND membership.apiary_id=h.apiary_id
		  ))
		ORDER BY
			CASE rec.priority
				WHEN 'urgent' THEN 0
				WHEN 'high'   THEN 1
				WHEN 'normal' THEN 2
				WHEN 'low'    THEN 3
				ELSE 4
			END,
			rec.created_at DESC`, principalFrom(r).IsAdmin, principalFrom(r).ID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	defer rows.Close()
	list := []recommendationJSON{}
	for rows.Next() {
		var v recommendationJSON
		if err := rows.Scan(&v.ID, &v.HiveID, &v.Type, &v.Message, &v.Priority,
			&v.Dismissed, &v.CreatedAt, &v.HiveName, &v.SnoozedUntil, &v.DismissedAt); err != nil {
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

// GET /recommendations/count — pending count (nav badge).
func (s *Server) handleRecommendationsCount(w http.ResponseWriter, r *http.Request) {
	var count int
	err := s.pool.QueryRow(r.Context(), `
		SELECT count(*) FROM ai_recommendations rec
		LEFT JOIN hives hive ON hive.id=rec.hive_id
		WHERE rec.dismissed=false
		  AND (rec.snoozed_until IS NULL OR rec.snoozed_until <= now())
		  AND ($1::boolean OR EXISTS (
			SELECT 1 FROM apiary_memberships membership
			WHERE membership.user_id=$2 AND membership.apiary_id=hive.apiary_id
		))`, principalFrom(r).IsAdmin, principalFrom(r).ID).Scan(&count)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"count": count})
}

func (s *Server) applyRecommendationState(
	w http.ResponseWriter,
	r *http.Request,
	ids []uuid.UUID,
	state string,
	snoozeDays int,
) (int64, bool) {
	principal := principalFrom(r)
	var set string
	args := []any{ids, principal.IsAdmin, principal.ID}
	switch state {
	case "dismissed":
		set = `dismissed = true, dismissed_at = now(), dismissed_by = $3,
			snoozed_until = NULL`
	case "snoozed":
		if snoozeDays <= 0 {
			snoozeDays = 7
		}
		if snoozeDays > 365 {
			snoozeDays = 365
		}
		set = `snoozed_until = now() + make_interval(days => $4),
			dismissed = false, dismissed_at = NULL, dismissed_by = NULL`
		args = append(args, snoozeDays)
	case "open":
		set = `dismissed = false, dismissed_at = NULL, dismissed_by = NULL,
			snoozed_until = NULL`
	default:
		writeError(w, http.StatusBadRequest,
			`state must be "dismissed", "snoozed", or "open"`)
		return 0, false
	}
	// Membership is enforced in the UPDATE itself so bulk calls cannot touch
	// recommendations outside the caller's apiaries.
	tag, err := s.pool.Exec(r.Context(), `
		UPDATE ai_recommendations rec SET `+set+`
		WHERE rec.id = ANY($1)
		  AND ($2::boolean OR EXISTS (
			SELECT 1 FROM hives hive
			JOIN apiary_memberships membership
				ON membership.apiary_id = hive.apiary_id
				AND membership.user_id = $3
				AND membership.role = 'editor'
			WHERE hive.id = rec.hive_id
		  ))`, args...)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return 0, false
	}
	return tag.RowsAffected(), true
}

// POST /recommendations/state {ids, state: dismissed|snoozed|open, days?} —
// bulk triage in one statement, action-center style.
func (s *Server) handleRecommendationsState(w http.ResponseWriter, r *http.Request) {
	var payload struct {
		IDs   []uuid.UUID `json:"ids"`
		State string      `json:"state"`
		Days  int         `json:"days"`
	}
	if err := decodeJSON(r, &payload); err != nil {
		writeError(w, http.StatusBadRequest, "invalid JSON body")
		return
	}
	if len(payload.IDs) == 0 || len(payload.IDs) > 500 {
		writeError(w, http.StatusBadRequest, "ids must contain 1-500 entries")
		return
	}
	updated, ok := s.applyRecommendationState(w, r, payload.IDs, payload.State, payload.Days)
	if !ok {
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"updated": updated})
}

func (s *Server) singleRecommendationState(
	w http.ResponseWriter, r *http.Request, state string, days int,
) {
	id, err := uuidParam(r, "id")
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	updated, ok := s.applyRecommendationState(w, r, []uuid.UUID{id}, state, days)
	if !ok {
		return
	}
	if updated == 0 {
		writeError(w, http.StatusNotFound, "Recommendation not found")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"success": true})
}

// POST /recommendations/{id}/dismiss
func (s *Server) handleRecommendationDismiss(w http.ResponseWriter, r *http.Request) {
	s.singleRecommendationState(w, r, "dismissed", 0)
}

// POST /recommendations/{id}/snooze {days?} — default 7.
func (s *Server) handleRecommendationSnooze(w http.ResponseWriter, r *http.Request) {
	var payload struct {
		Days int `json:"days"`
	}
	// An empty body means the default snooze; only reject malformed JSON.
	if r.ContentLength > 0 {
		if err := decodeJSON(r, &payload); err != nil {
			writeError(w, http.StatusBadRequest, "invalid JSON body")
			return
		}
	}
	s.singleRecommendationState(w, r, "snoozed", payload.Days)
}

// POST /recommendations/{id}/restore — back to pending from dismissed/snoozed.
func (s *Server) handleRecommendationRestore(w http.ResponseWriter, r *http.Request) {
	s.singleRecommendationState(w, r, "open", 0)
}

// POST /recommendations/run — enqueue the recommendation engine job. Unique
// so overlapping manual runs (or a manual run racing the scheduler) collapse
// into one execution instead of racing the dedup.
func (s *Server) handleRecommendationsRun(w http.ResponseWriter, r *http.Request) {
	task := asynq.NewTask(jobs.TypeGenerateRecs, nil)
	if _, err := s.queue.Enqueue(task, asynq.Unique(time.Minute)); err != nil {
		if errors.Is(err, asynq.ErrDuplicateTask) {
			writeJSON(w, http.StatusOK, map[string]any{"queued": true, "alreadyQueued": true})
			return
		}
		writeError(w, http.StatusInternalServerError, "failed to queue recommendation check")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"queued": true})
}
