package httpapi

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

const offlineResponseLimit = 2 << 20

type offlineCaptureWriter struct {
	http.ResponseWriter
	status int
	body   bytes.Buffer
}

func (writer *offlineCaptureWriter) WriteHeader(status int) {
	if writer.status == 0 {
		writer.status = status
	}
}

func (writer *offlineCaptureWriter) Write(value []byte) (int, error) {
	if writer.status == 0 {
		writer.status = http.StatusOK
	}
	_, _ = writer.body.Write(value)
	return len(value), nil
}

// Flush is a no-op so handlers that type-assert http.Flusher cannot send
// the response before the receipt is durable.
func (writer *offlineCaptureWriter) Flush() {}

func flushOfflineResponse(w http.ResponseWriter, capture *offlineCaptureWriter) {
	status := capture.status
	if status == 0 {
		status = http.StatusOK
	}
	w.WriteHeader(status)
	if capture.body.Len() > 0 {
		_, _ = w.Write(capture.body.Bytes())
	}
}

func mutationMethod(method string) bool {
	switch method {
	case http.MethodPost, http.MethodPut, http.MethodPatch, http.MethodDelete:
		return true
	default:
		return false
	}
}

func offlineMutationSupported(method, path string) bool {
	prefixes := []string{
		"/api/v1/inspections",
		"/api/v1/feedings",
		"/api/v1/bloom-observations",
		"/api/v1/mite-counts",
		"/api/v1/treatment-events",
		"/api/v1/queen-events",
		"/api/v1/queens",
		"/api/v1/photos/",
		"/api/v1/canvas/",
		"/api/v1/harvest-sessions/",
		"/api/v1/harvest-entries/",
		"/api/v1/recommendations/",
		// Honey and commerce writes. Market day is the most offline-prone
		// surface in the product — a farmers' market with no signal — and
		// every one of these routes was previously excluded, so a replayed
		// queue could book the same sale twice.
		"/api/v1/harvests",
		"/api/v1/honey/jarring",
		"/api/v1/honey/bulk-movements",
		"/api/v1/honey/give-away",
		"/api/v1/honey/jar-adjustments",
		"/api/v1/honey/movements/",
		"/api/v1/honey/sales",
		"/api/v1/sales",
		"/api/v1/jar-sizes",
		"/api/v1/expenses",
		"/api/v1/customers",
		"/api/v1/harvest-lots",
		"/api/v1/wholesale-price-lists",
	}
	supported := false
	for _, prefix := range prefixes {
		if strings.HasPrefix(path, prefix) {
			supported = true
			break
		}
	}
	supported = supported ||
		(path == "/api/v1/hives/bulk" ||
			(strings.HasPrefix(path, "/api/v1/hives/") && method != http.MethodDelete)) ||
		(strings.HasPrefix(path, "/api/v1/apiaries/") && method == http.MethodPut) ||
		(strings.HasPrefix(path, "/api/v1/splits/") && method == http.MethodDelete)
	if !supported {
		return false
	}
	if method != http.MethodPost {
		return true
	}
	switch path {
	case "/api/v1/canvas/hives", "/api/v1/harvest-sessions",
		"/api/v1/recommendations/run":
		return false
	default:
		return true
	}
}

func (s *Server) offlineResourceUpdatedAt(r *http.Request) (*time.Time, error) {
	parts := strings.Split(strings.Trim(r.URL.Path, "/"), "/")
	if len(parts) < 4 || parts[0] != "api" || parts[1] != "v1" {
		return nil, nil
	}
	tableByResource := map[string]string{
		"apiaries":     "apiaries",
		"hives":        "hives",
		"inspections":  "inspections",
		"photos":       "photos",
		"queens":       "queens",
		"expenses":     "expenses",
		"customers":    "customers",
		"harvest-lots": "harvest_lots",
		"jar-sizes":    "jar_sizes",
	}
	resource, idPart := parts[2], parts[3]
	// /honey/sales/{id} nests one level deeper than the flat resources.
	if resource == "honey" && len(parts) >= 5 && parts[3] == "sales" {
		resource, idPart = "sales", parts[4]
	}
	tableByResource["sales"] = "sales"
	table, ok := tableByResource[resource]
	if !ok {
		return nil, nil
	}
	id, err := uuid.Parse(idPart)
	if err != nil {
		return nil, nil
	}
	var updated time.Time
	err = s.pool.QueryRow(r.Context(),
		"SELECT updated_at FROM "+table+" WHERE id=$1", id).Scan(&updated)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &updated, nil
}

func (s *Server) offlineMutationConflicts(
	r *http.Request,
	queuedAt *time.Time,
) (bool, error) {
	if queuedAt == nil {
		return false, nil
	}
	updatedAt, err := s.offlineResourceUpdatedAt(r)
	if err != nil {
		return false, err
	}
	return updatedAt != nil && updatedAt.After(*queuedAt), nil
}

// receiptExec runs receipt bookkeeping detached from the request context. If
// the client disconnects right after the handler commits, r.Context() is
// canceled and a bookkeeping write on it would silently fail — leaving the
// receipt in 'processing' so a later replay re-executes the mutation.
func (s *Server) receiptExec(r *http.Request, query string, args ...any) error {
	ctx, cancel := context.WithTimeout(
		context.WithoutCancel(r.Context()), 10*time.Second)
	defer cancel()
	if _, err := s.pool.Exec(ctx, query, args...); err != nil {
		slog.Error("offline receipt bookkeeping failed",
			"err", err, "method", r.Method, "path", r.URL.Path)
		return err
	}
	return nil
}

// offlineMutations makes queued PWA writes safe to replay. A UUID identifies
// one logical mutation; completed responses are returned verbatim on retry.
// For updates and deletes, a queue timestamp also protects against overwriting
// a newer server edit.
func (s *Server) offlineMutations(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !mutationMethod(r.Method) ||
			!offlineMutationSupported(r.Method, r.URL.Path) {
			next.ServeHTTP(w, r)
			return
		}
		var queuedAt *time.Time
		if raw := strings.TrimSpace(r.Header.Get("X-Offline-Queued-At")); raw != "" {
			value, err := time.Parse(time.RFC3339Nano, raw)
			if err != nil {
				writeError(w, http.StatusBadRequest, "invalid offline queue timestamp")
				return
			}
			queuedAt = &value
		}

		rawID := strings.TrimSpace(r.Header.Get("X-Offline-Mutation-ID"))
		if rawID == "" {
			conflict, err := s.offlineMutationConflicts(r, queuedAt)
			if err != nil {
				writeError(w, http.StatusInternalServerError, "database error")
				return
			}
			if conflict {
				w.Header().Set("X-Offline-Conflict", "newer-server-version")
				writeError(w, http.StatusConflict,
					"this record changed after the offline edit was queued")
				return
			}
			next.ServeHTTP(w, r)
			return
		}

		mutationID, err := uuid.Parse(rawID)
		if err != nil {
			writeError(w, http.StatusBadRequest, "invalid offline mutation id")
			return
		}
		user := principalFrom(r)
		if user == nil {
			// The middleware is mounted after requireSession, but a nil
			// principal must fail closed rather than panic if that ever
			// changes.
			writeError(w, http.StatusUnauthorized, "authentication required")
			return
		}

		// Fingerprint the request so a reused mutation id (client bug, UUID
		// collision) cannot silently return request A's stored response to a
		// different request B — B's write would never happen.
		bodyBytes, err := io.ReadAll(r.Body)
		if err != nil {
			writeError(w, http.StatusBadRequest, "could not read request body")
			return
		}
		r.Body = io.NopCloser(bytes.NewReader(bodyBytes))
		digest := sha256.Sum256(append(
			[]byte(r.Method+"\n"+r.URL.Path+"\n"), bodyBytes...))
		requestHash := hex.EncodeToString(digest[:])

		tag, err := s.pool.Exec(r.Context(), `
			INSERT INTO offline_mutation_receipts (user_id,mutation_id,request_hash)
			VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, user.ID, mutationID, requestHash)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "database error")
			return
		}
		if tag.RowsAffected() == 0 {
			var state string
			var status *int
			var body []byte
			var updated time.Time
			var storedHash *string
			err = s.pool.QueryRow(r.Context(), `
				SELECT state,response_status,response_body,updated_at,request_hash
				FROM offline_mutation_receipts
				WHERE user_id=$1 AND mutation_id=$2`,
				user.ID, mutationID).Scan(&state, &status, &body, &updated, &storedHash)
			if err != nil {
				writeError(w, http.StatusInternalServerError, "database error")
				return
			}
			// Receipts from before the hash column exist with NULL — those
			// replay unchecked, exactly as they did before.
			if storedHash != nil && *storedHash != requestHash {
				writeError(w, http.StatusConflict,
					"offline mutation id was reused for a different request")
				return
			}
			if state == "complete" && status != nil {
				w.Header().Set("Content-Type", "application/json")
				w.Header().Set("X-Offline-Replayed", "true")
				w.WriteHeader(*status)
				if len(body) > 0 {
					_, _ = w.Write(body)
				}
				return
			}
			if time.Since(updated) <= 5*time.Minute {
				w.Header().Set("Retry-After", "5")
				writeError(w, http.StatusConflict, "offline mutation is already processing")
				return
			}
			claim, claimErr := s.pool.Exec(r.Context(), `
				UPDATE offline_mutation_receipts SET updated_at=now()
				WHERE user_id=$1 AND mutation_id=$2 AND state='processing'
					AND updated_at=$3`, user.ID, mutationID, updated)
			if claimErr != nil || claim.RowsAffected() == 0 {
				writeError(w, http.StatusConflict, "offline mutation is already processing")
				return
			}
		}

		conflict, err := s.offlineMutationConflicts(r, queuedAt)
		if err != nil {
			s.receiptExec(r, `
				DELETE FROM offline_mutation_receipts
				WHERE user_id=$1 AND mutation_id=$2`,
				user.ID, mutationID)
			writeError(w, http.StatusInternalServerError, "database error")
			return
		}
		if conflict {
			s.receiptExec(r, `
				DELETE FROM offline_mutation_receipts
				WHERE user_id=$1 AND mutation_id=$2`,
				user.ID, mutationID)
			w.Header().Set("X-Offline-Conflict", "newer-server-version")
			writeError(w, http.StatusConflict,
				"this record changed after the offline edit was queued")
			return
		}

		capture := &offlineCaptureWriter{ResponseWriter: w}
		next.ServeHTTP(capture, r)
		status := capture.status
		if status == 0 {
			status = http.StatusOK
		}
		if status >= http.StatusInternalServerError {
			_ = s.receiptExec(r, `
				DELETE FROM offline_mutation_receipts
				WHERE user_id=$1 AND mutation_id=$2`,
				user.ID, mutationID)
			flushOfflineResponse(w, capture)
			return
		}
		var responseBody any
		// A body at the capture limit would be truncated to invalid JSON;
		// storing it would fail the jsonb insert and strand the receipt in
		// 'processing'. Replays then get the status with an empty body.
		if capture.body.Len() > 0 && capture.body.Len() < offlineResponseLimit &&
			strings.Contains(capture.Header().Get("Content-Type"), "application/json") {
			responseBody = json.RawMessage(capture.body.Bytes())
		}
		if err := s.receiptExec(r, `
			UPDATE offline_mutation_receipts
			SET state='complete',response_status=$3,response_body=$4
			WHERE user_id=$1 AND mutation_id=$2`,
			user.ID, mutationID, status, responseBody); err != nil {
			writeError(w, http.StatusInternalServerError, "database error")
			return
		}
		flushOfflineResponse(w, capture)
	})
}
