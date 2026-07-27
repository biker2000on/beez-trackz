package httpapi

import (
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
	r.With(s.requireEntityParamRole("recommendation", true)).
		Post("/recommendations/{id}/dismiss", s.handleRecommendationDismiss)
	r.With(s.requireAdmin).Post("/recommendations/run", s.handleRecommendationsRun)
}

type recommendationJSON struct {
	ID        uuid.UUID  `json:"id"`
	HiveID    *uuid.UUID `json:"hiveId"`
	Type      string     `json:"type"`
	Message   string     `json:"message"`
	Priority  string     `json:"priority"`
	Dismissed bool       `json:"dismissed"`
	CreatedAt time.Time  `json:"createdAt"`
	HiveName  *string    `json:"hiveName"`
}

// GET /recommendations — undismissed, urgent<high<normal<low then newest first,
// with the hive position label joined for display.
func (s *Server) handleRecommendationsList(w http.ResponseWriter, r *http.Request) {
	rows, err := s.pool.Query(r.Context(), `
		SELECT rec.id, rec.hive_id, rec.type, rec.message, rec.priority, rec.dismissed,
		       rec.created_at, h.position_label
		FROM ai_recommendations rec
		LEFT JOIN hives h ON h.id = rec.hive_id
		WHERE rec.dismissed = false
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
			&v.Dismissed, &v.CreatedAt, &v.HiveName); err != nil {
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

// GET /recommendations/count — undismissed count (nav badge).
func (s *Server) handleRecommendationsCount(w http.ResponseWriter, r *http.Request) {
	var count int
	err := s.pool.QueryRow(r.Context(), `
		SELECT count(*) FROM ai_recommendations rec
		LEFT JOIN hives hive ON hive.id=rec.hive_id
		WHERE rec.dismissed=false AND ($1::boolean OR EXISTS (
			SELECT 1 FROM apiary_memberships membership
			WHERE membership.user_id=$2 AND membership.apiary_id=hive.apiary_id
		))`, principalFrom(r).IsAdmin, principalFrom(r).ID).Scan(&count)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"count": count})
}

// POST /recommendations/{id}/dismiss
func (s *Server) handleRecommendationDismiss(w http.ResponseWriter, r *http.Request) {
	id, err := uuidParam(r, "id")
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	tag, err := s.pool.Exec(r.Context(),
		`UPDATE ai_recommendations SET dismissed = true WHERE id = $1`, id)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	if tag.RowsAffected() == 0 {
		writeError(w, http.StatusNotFound, "Recommendation not found")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"success": true})
}

// POST /recommendations/run — enqueue the recommendation engine job.
func (s *Server) handleRecommendationsRun(w http.ResponseWriter, r *http.Request) {
	task := asynq.NewTask(jobs.TypeGenerateRecs, nil)
	if _, err := s.queue.Enqueue(task); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to queue recommendation check")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"queued": true})
}
