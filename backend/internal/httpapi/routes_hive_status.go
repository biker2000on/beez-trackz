package httpapi

import (
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

// Hive status changes (Contract 3). PUT /hives/{id} replaces every detail
// field, so a status change through it wipes whatever the caller did not
// resend. These routes touch only status, is_archived, and deadout_date.

// hiveStatusDate parses the optional status-change date. nil or blank means
// "today" to the caller. A future date is refused: a dead-out has happened.
func hiveStatusDate(raw *string, now time.Time) (*time.Time, error) {
	if raw == nil || strings.TrimSpace(*raw) == "" {
		return nil, nil
	}
	date, err := parseDate(*raw)
	if err != nil {
		return nil, errors.New("date must be a date (YYYY-MM-DD)")
	}
	if dateIsFuture(date, now) {
		return nil, errors.New("date cannot be in the future")
	}
	return &date, nil
}

// POST /hives/{id}/deadout {date?} — with no body (or no date) it stamps now,
// as it always has.
func (s *Server) handleHiveDeadout(w http.ResponseWriter, r *http.Request) {
	id, err := uuidParam(r, "id")
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	var body struct {
		Date *string `json:"date"`
	}
	if err := decodeOptionalJSON(r, &body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	date, err := hiveStatusDate(body.Date, time.Now())
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	tag, err := s.pool.Exec(r.Context(), `
		UPDATE hives SET status = 'dead', is_archived = true,
			deadout_date = COALESCE($2::timestamptz, now())
		WHERE id = $1`, id, date)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	if tag.RowsAffected() == 0 {
		writeError(w, http.StatusNotFound, "hive not found")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"success": true})
}

// hiveStatusUpdateSQL returns the UPDATE for one target status. $1 is the
// hive id; only the dead branch takes $2, the optional date.
//
//   - dead: archive and stamp deadout_date with the given date. Without one,
//     an existing dead-out date is kept (re-sending "dead" must not move a
//     recorded death to today); otherwise today.
//   - sold / combined: archive. The schema has no sold/combined date column,
//     so the date is ignored. deadout_date is cleared because it means "died".
//   - active: unarchive and clear deadout_date.
func hiveStatusUpdateSQL(status string) (query string, usesDate, ok bool) {
	switch status {
	case "dead":
		return `
			UPDATE hives SET status = 'dead', is_archived = true,
				deadout_date = CASE
					WHEN $2::timestamptz IS NOT NULL THEN $2::timestamptz
					WHEN status = 'dead' AND deadout_date IS NOT NULL THEN deadout_date
					ELSE now() END
			WHERE id = $1`, true, true
	case "sold", "combined":
		return `
			UPDATE hives SET status = '` + status + `', is_archived = true, deadout_date = NULL
			WHERE id = $1`, false, true
	case "active":
		return `
			UPDATE hives SET status = 'active', is_archived = false, deadout_date = NULL
			WHERE id = $1`, false, true
	}
	return "", false, false
}

// PATCH /hives/{id}/status {status, date?} — responds with the hive, shaped
// like GET /hives/{id}.
func (s *Server) handleHiveStatus(w http.ResponseWriter, r *http.Request) {
	id, err := uuidParam(r, "id")
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	var req struct {
		Status string  `json:"status"`
		Date   *string `json:"date"`
	}
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	query, usesDate, ok := hiveStatusUpdateSQL(strings.TrimSpace(req.Status))
	if !ok {
		writeError(w, http.StatusBadRequest, "status must be one of active, dead, sold, combined")
		return
	}
	date, err := hiveStatusDate(req.Date, time.Now())
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	args := []any{id}
	if usesDate {
		args = append(args, date)
	}
	tag, err := s.pool.Exec(r.Context(), query, args...)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	if tag.RowsAffected() == 0 {
		writeError(w, http.StatusNotFound, "hive not found")
		return
	}
	hive, err := s.hiveFetch(r.Context(), id)
	if errors.Is(err, pgx.ErrNoRows) {
		writeError(w, http.StatusNotFound, "hive not found")
		return
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	if err := s.fillHiveLockout(r.Context(), hive); err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	writeJSON(w, http.StatusOK, hive)
}
