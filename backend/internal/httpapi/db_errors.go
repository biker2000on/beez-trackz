package httpapi

import (
	"errors"
	"net/http"

	"github.com/jackc/pgx/v5/pgconn"
)

// writeDBError maps a mutation's database error onto an HTTP status. Only
// genuine constraint violations become client errors; anything else —
// deadlock, serialization failure, dropped connection — must stay a 500,
// because the offline idempotency layer stores any sub-500 status as the
// mutation's permanent answer, and a queued sale that hit a transient error
// recorded as 4xx would be silently lost on replay.
func writeDBError(w http.ResponseWriter, err error, uniqueMsg, fkMsg string) {
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) {
		switch pgErr.Code {
		case "23505":
			writeError(w, http.StatusConflict, uniqueMsg)
			return
		case "23503":
			writeError(w, http.StatusBadRequest, fkMsg)
			return
		}
	}
	writeError(w, http.StatusInternalServerError, "database error")
}
