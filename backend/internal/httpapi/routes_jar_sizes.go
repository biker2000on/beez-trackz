package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/biker2000on/beez-trackz/backend/internal/app"
	"github.com/biker2000on/beez-trackz/backend/internal/app/production"
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
	// Empty containers this size is filled into, if the operator linked one.
	PackagingTypeID   *uuid.UUID `json:"packagingTypeId"`
	PackagingTypeName *string    `json:"packagingTypeName"`
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

	query := `SELECT js.id, js.label, js.honey_oz, js.default_price_cents,
			js.sort_order, js.is_active, js.low_stock_threshold,
			js.packaging_type_id, et.name
		FROM jar_sizes js
		LEFT JOIN equipment_types et ON et.id = js.packaging_type_id`
	if !includeInactive {
		query += ` WHERE js.is_active`
	}
	query += ` ORDER BY js.sort_order, js.label`
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
			&row.SortOrder, &row.IsActive, &row.LowStockThreshold,
			&row.PackagingTypeID, &row.PackagingTypeName); err != nil {
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
// records a visible count_adjust operation zeroing the remaining stock.
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
		// Equipment type holding this size's empty containers. null unlinks.
		PackagingTypeID   json.RawMessage `json:"packagingTypeId"`
		WriteOffRemaining bool            `json:"writeOffRemaining"`
		WriteOffReason    *string         `json:"writeOffReason"`
	}
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}

	input := production.UpdateJarSizeInput{JarSizeID: id, OccurredAt: time.Now().UTC()}
	hasChanges := false
	if req.PackagingTypeID != nil {
		var packagingTypeID *uuid.UUID
		if err := json.Unmarshal(req.PackagingTypeID, &packagingTypeID); err != nil {
			writeError(w, http.StatusBadRequest, "invalid packagingTypeId")
			return
		}
		input.SetPackagingType, input.PackagingTypeID, hasChanges = true, packagingTypeID, true
	}
	if req.Label != nil {
		var label *string
		if err := json.Unmarshal(req.Label, &label); err != nil || label == nil ||
			strings.TrimSpace(*label) == "" {
			writeError(w, http.StatusBadRequest, "Label is required")
			return
		}
		input.SetLabel, input.Label, hasChanges = true, strings.TrimSpace(*label), true
	}
	if req.HoneyOz != nil {
		var oz *float64
		if err := json.Unmarshal(req.HoneyOz, &oz); err != nil {
			writeError(w, http.StatusBadRequest, "invalid honeyOz")
			return
		}
		input.SetHoneyOz, input.HoneyOz, hasChanges = true, oz, true
	}
	if req.DefaultPrice != nil {
		var price *money
		if err := json.Unmarshal(req.DefaultPrice, &price); err != nil {
			writeError(w, http.StatusBadRequest, "invalid defaultPrice")
			return
		}
		input.SetDefaultPrice, hasChanges = true, true
		if price != nil {
			value := int64(*price)
			input.DefaultPriceCents = &value
		}
	}
	if req.IsActive != nil {
		var active bool
		if err := json.Unmarshal(req.IsActive, &active); err != nil {
			writeError(w, http.StatusBadRequest, "invalid isActive")
			return
		}
		input.SetActive, input.Active, hasChanges = true, active, true
	}
	if req.LowStockThreshold != nil {
		var threshold int
		if err := json.Unmarshal(req.LowStockThreshold, &threshold); err != nil || threshold < 0 {
			writeError(w, http.StatusBadRequest, "lowStockThreshold must be non-negative")
			return
		}
		input.SetLowStockThreshold, input.LowStockThreshold, hasChanges = true, threshold, true
	}
	if !hasChanges {
		writeJSON(w, http.StatusOK, map[string]any{"success": true})
		return
	}

	// One unit of work for both halves: the write-off operation and the
	// jar_sizes UPDATE either both land or neither does.
	input.WriteOffRemaining = req.WriteOffRemaining
	input.WriteOffReason = req.WriteOffReason
	var commandResult production.UpdateJarSizeResult
	err = s.runInUnitOfWork(r, func(ctx context.Context, uow *app.UnitOfWork) error {
		var err error
		commandResult, err = production.UpdateJarSize(ctx, uow, input)
		return err
	})
	if err != nil {
		writeCommandError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, commandResult)
}
