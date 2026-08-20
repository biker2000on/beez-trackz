package httpapi

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgconn"
)

// Jar sizes: the container catalog for the honey ledger. First read seeds the
// default sizes so a fresh instance works out of the box.

func (s *Server) mountJarSizes(r chi.Router) {
	admin := r.With(s.requireAdmin)
	admin.Get("/jar-sizes", s.jarList)
	admin.Post("/jar-sizes", s.jarCreate)
	admin.Put("/jar-sizes/{id}", s.jarUpdate)
}

type jarSizeRow struct {
	ID                uuid.UUID `json:"id"`
	Label             string    `json:"label"`
	HoneyOz           *float64  `json:"honeyOz"`
	DefaultPrice      *money    `json:"defaultPrice"`
	SortOrder         int       `json:"sortOrder"`
	IsActive          bool      `json:"isActive"`
	LowStockThreshold int       `json:"lowStockThreshold"`
}

func jarIsUniqueViolation(err error) bool {
	var pgErr *pgconn.PgError
	return errors.As(err, &pgErr) && pgErr.Code == "23505"
}

// GET /jar-sizes?includeInactive= — seeds the defaults when the table is empty.
func (s *Server) jarList(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	includeInactive := r.URL.Query().Get("includeInactive") == "true" ||
		r.URL.Query().Get("includeInactive") == "1"

	var count int
	if err := s.pool.QueryRow(ctx, `SELECT COUNT(*) FROM jar_sizes`).Scan(&count); err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	if count == 0 {
		// Idempotent seed: ON CONFLICT DO NOTHING guards concurrent first reads.
		if _, err := s.pool.Exec(ctx, `
			INSERT INTO jar_sizes (label, honey_oz, sort_order) VALUES
			('Half Pint', 12, 0),
			('Pint', 22, 1),
			('Quart', 44, 2),
			('Half Gallon', 88, 3),
			('Gallon', 176, 4)
			ON CONFLICT (label) DO NOTHING`); err != nil {
			writeError(w, http.StatusInternalServerError, "database error")
			return
		}
	}

	query := `SELECT id, label, honey_oz, default_price_cents, sort_order, is_active, low_stock_threshold
		FROM jar_sizes`
	if !includeInactive {
		query += ` WHERE is_active`
	}
	query += ` ORDER BY sort_order, label`
	rows, err := s.pool.Query(ctx, query)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	defer rows.Close()
	out := make([]jarSizeRow, 0)
	for rows.Next() {
		var row jarSizeRow
		if err := rows.Scan(&row.ID, &row.Label, &row.HoneyOz, &row.DefaultPrice,
			&row.SortOrder, &row.IsActive, &row.LowStockThreshold); err != nil {
			writeError(w, http.StatusInternalServerError, "database error")
			return
		}
		out = append(out, row)
	}
	if rows.Err() != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	writeJSON(w, http.StatusOK, out)
}

// POST /jar-sizes {label, honeyOz?, defaultPrice?}
func (s *Server) jarCreate(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Label             string   `json:"label"`
		HoneyOz           *float64 `json:"honeyOz"`
		DefaultPrice      *money   `json:"defaultPrice"`
		LowStockThreshold *int     `json:"lowStockThreshold"`
	}
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	label := strings.TrimSpace(req.Label)
	if label == "" {
		writeError(w, http.StatusBadRequest, "Label is required")
		return
	}
	if req.LowStockThreshold != nil && *req.LowStockThreshold < 0 {
		writeError(w, http.StatusBadRequest, "lowStockThreshold must be non-negative")
		return
	}

	ctx := r.Context()
	var row jarSizeRow
	err := s.pool.QueryRow(ctx, `
		INSERT INTO jar_sizes (label, honey_oz, default_price_cents, low_stock_threshold, sort_order, created_by)
		VALUES ($1, $2, $3, COALESCE($4, 6), (SELECT COALESCE(MAX(sort_order), -1) + 1 FROM jar_sizes), $5)
		RETURNING id, label, honey_oz, default_price_cents, sort_order, is_active, low_stock_threshold`,
		label, req.HoneyOz, req.DefaultPrice, req.LowStockThreshold, actorID(r)).
		Scan(&row.ID, &row.Label, &row.HoneyOz, &row.DefaultPrice, &row.SortOrder,
			&row.IsActive, &row.LowStockThreshold)
	if err != nil {
		if jarIsUniqueViolation(err) {
			writeError(w, http.StatusConflict, fmt.Sprintf("%q already exists", label))
			return
		}
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	writeJSON(w, http.StatusCreated, row)
}

// PUT /jar-sizes/{id} {label?, honeyOz?, defaultPrice?, isActive?} — only the
// fields present in the body are updated (explicit null clears nullable ones).
//
// Deactivating a size that still holds jars is refused. It used to hide them
// from on-hand, dashboard totals, inventory value, and low-stock alerts while
// their sales kept counting as revenue: an untracked write-off performed by a
// settings toggle. Pass {"writeOffRemaining": true} to deactivate anyway, which
// records a visible jar_adjustment movement zeroing the remaining stock.
func (s *Server) jarUpdate(w http.ResponseWriter, r *http.Request) {
	id, err := uuidParam(r, "id")
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	var req struct {
		Label             json.RawMessage `json:"label"`
		HoneyOz           json.RawMessage `json:"honeyOz"`
		DefaultPrice      json.RawMessage `json:"defaultPrice"`
		IsActive          json.RawMessage `json:"isActive"`
		LowStockThreshold json.RawMessage `json:"lowStockThreshold"`
		WriteOffRemaining bool            `json:"writeOffRemaining"`
		WriteOffReason    *string         `json:"writeOffReason"`
	}
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}

	sets := make([]string, 0, 4)
	args := make([]any, 0, 5)
	addSet := func(column string, value any) {
		args = append(args, value)
		sets = append(sets, fmt.Sprintf("%s = $%d", column, len(args)))
	}
	if req.Label != nil {
		var label *string
		if err := json.Unmarshal(req.Label, &label); err != nil || label == nil ||
			strings.TrimSpace(*label) == "" {
			writeError(w, http.StatusBadRequest, "Label is required")
			return
		}
		addSet("label", strings.TrimSpace(*label))
	}
	if req.HoneyOz != nil {
		var oz *float64
		if err := json.Unmarshal(req.HoneyOz, &oz); err != nil {
			writeError(w, http.StatusBadRequest, "invalid honeyOz")
			return
		}
		addSet("honey_oz", oz)
	}
	if req.DefaultPrice != nil {
		var price *money
		if err := json.Unmarshal(req.DefaultPrice, &price); err != nil {
			writeError(w, http.StatusBadRequest, "invalid defaultPrice")
			return
		}
		addSet("default_price_cents", price)
	}
	deactivating := false
	if req.IsActive != nil {
		var active bool
		if err := json.Unmarshal(req.IsActive, &active); err != nil {
			writeError(w, http.StatusBadRequest, "invalid isActive")
			return
		}
		deactivating = !active
		addSet("is_active", active)
	}
	if req.LowStockThreshold != nil {
		var threshold int
		if err := json.Unmarshal(req.LowStockThreshold, &threshold); err != nil || threshold < 0 {
			writeError(w, http.StatusBadRequest, "lowStockThreshold must be non-negative")
			return
		}
		addSet("low_stock_threshold", threshold)
	}
	if len(sets) == 0 {
		writeJSON(w, http.StatusOK, map[string]any{"success": true})
		return
	}

	ctx := r.Context()
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	defer tx.Rollback(ctx)

	wroteOff := 0
	if deactivating {
		onHand, _, unknown, err := honeyLockJarSizes(ctx, tx, []uuid.UUID{id})
		if err != nil {
			writeError(w, http.StatusInternalServerError, "database error")
			return
		}
		if unknown {
			writeError(w, http.StatusNotFound, "jar size not found")
			return
		}
		away, err := stockAwayJarTotals(ctx, tx)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "database error")
			return
		}
		if consigned := away[id]; consigned != 0 {
			writeError(w, http.StatusConflict, fmt.Sprintf(
				"%d jars of this size are at consignment locations. Return or settle "+
					"them before deactivating the size.", consigned))
			return
		}
		remaining := onHand[id]
		if remaining != 0 {
			if !req.WriteOffRemaining {
				writeError(w, http.StatusConflict, fmt.Sprintf(
					"%d jars are still on hand for this size. Sell, give away, or adjust them "+
						"to zero first, or resend with writeOffRemaining=true to record a write-off.",
					remaining))
				return
			}
			reason := "jar size deactivation write-off"
			if value := honeyTrimPtr(req.WriteOffReason); value != nil {
				reason = *value
			}
			if _, err := tx.Exec(ctx, `
				INSERT INTO honey_movements (date, kind, jar_size_id, quantity, reason, created_by)
				VALUES (now(), 'jar_adjustment', $1, $2, $3, $4)`,
				id, -remaining, reason, actorID(r)); err != nil {
				writeError(w, http.StatusInternalServerError, "database error")
				return
			}
			wroteOff = remaining
		}
	}

	args = append(args, id)
	query := fmt.Sprintf("UPDATE jar_sizes SET %s WHERE id = $%d",
		strings.Join(sets, ", "), len(args))
	tag, err := tx.Exec(ctx, query, args...)
	if err != nil {
		if jarIsUniqueViolation(err) {
			writeError(w, http.StatusConflict, "label already exists")
			return
		}
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	if tag.RowsAffected() == 0 {
		writeError(w, http.StatusNotFound, "jar size not found")
		return
	}
	if err := tx.Commit(ctx); err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	response := map[string]any{"success": true}
	if wroteOff != 0 {
		response["jarsWrittenOff"] = wroteOff
	}
	writeJSON(w, http.StatusOK, response)
}
