package httpapi

import (
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/jackc/pgx/v5/pgconn"
)

// ASI-5-005: only genuine constraint violations may become 4xx. A transient
// error (deadlock, dropped connection) stored as 4xx by the offline
// idempotency layer would silently lose the mutation on every replay.
func TestWriteDBErrorMapsOnlyConstraintViolations(t *testing.T) {
	t.Parallel()

	cases := []struct {
		name string
		err  error
		want int
	}{
		{"unique violation", &pgconn.PgError{Code: "23505"}, http.StatusConflict},
		{"fk violation", &pgconn.PgError{Code: "23503"}, http.StatusBadRequest},
		{"deadlock", &pgconn.PgError{Code: "40P01"}, http.StatusInternalServerError},
		{"serialization failure", &pgconn.PgError{Code: "40001"}, http.StatusInternalServerError},
		{"plain error", errors.New("connection reset"), http.StatusInternalServerError},
	}
	for _, test := range cases {
		test := test
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			response := httptest.NewRecorder()
			writeDBError(response, test.err, "unique message", "fk message")
			if response.Code != test.want {
				t.Errorf("writeDBError(%v) = %d, want %d", test.err, response.Code, test.want)
			}
		})
	}
}
