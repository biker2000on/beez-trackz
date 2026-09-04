package httpapi

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strings"

	"github.com/biker2000on/beez-trackz/backend/internal/app/production"
	"github.com/google/uuid"
)

// Per-lot bulk balances and the varietal rollup over them. Bulk honey is one
// pool split into labelled buckets (migration 00047): every lot holds what it
// yielded minus what has been jarred, used, or lost from it, and whatever is
// not in any lot sits in the unassigned bucket that history left behind.

type honeyLotBalanceRow struct {
	LotID          uuid.UUID  `json:"lotId"`
	LotCode        string     `json:"lotCode"`
	VarietalID     *uuid.UUID `json:"varietalId"`
	VarietalName   *string    `json:"varietalName"`
	ExtractionDate string     `json:"extractionDate"`
	LotLbs         float64    `json:"lotLbs"`
	JarredLbs      float64    `json:"jarredLbs"`
	BulkUsedLbs    float64    `json:"bulkUsedLbs"`
	LossLbs        float64    `json:"lossLbs"`
	OnHandLbs      float64    `json:"onHandLbs"`
}

// GET /honey/lot-balances
func (s *Server) honeyLotBalances(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	// Per-lot balances come from the one ledger: a lot holds its receipt
	// (decision 6) minus everything drawn from it. The columns keep their
	// names — the jars tab and the varietal view read them unchanged — but
	// they are operation history now, not honey_movements sums, and a
	// reversal nets out through the operation it negates.
	rows, err := s.pool.Query(ctx, `
		WITH `+ledgerClassifiedCTE+`,
		per_lot AS (
			SELECT c.lot_id,
			       COALESCE(SUM(quantity) FILTER (WHERE kind IN ('receive','opening_balance')), 0)::float8 AS lot_lbs,
			       COALESCE(SUM(-quantity) FILTER (WHERE kind='transform' AND EXISTS (
			         SELECT 1 FROM inventory_movements output
			         JOIN inventory_items output_item ON output_item.id=output.item_id
			         WHERE output.operation_id=c.classified_operation_id
			           AND output.quantity > 0 AND output_item.kind='jar'
			       )), 0)::float8 AS jarred_lbs,
			       COALESCE(SUM(-quantity) FILTER (WHERE
			         (kind='transform' AND EXISTS (
			           SELECT 1 FROM inventory_movements output
			           JOIN inventory_items output_item ON output_item.id=output.item_id
			           WHERE output.operation_id=c.classified_operation_id
			             AND output.quantity > 0 AND output_item.kind='catalog_product'
			         )) OR (kind='shrink' AND reason <> 'loss')), 0)::float8 AS bulk_used_lbs,
			       COALESCE(SUM(-quantity) FILTER (WHERE kind='shrink' AND reason='loss'), 0)::float8 AS loss_lbs,
			       COALESCE(SUM(quantity), 0)::float8 AS on_hand_lbs
			FROM classified c WHERE item_id = $1 AND lot_id IS NOT NULL
			GROUP BY c.lot_id
		)
		SELECT hl.id, hl.lot_code, hl.varietal_id, v.name,
		       to_char(hl.extraction_date, 'YYYY-MM-DD'),
		       COALESCE(b.lot_lbs, 0), COALESCE(b.jarred_lbs, 0),
		       COALESCE(b.bulk_used_lbs, 0), COALESCE(b.loss_lbs, 0),
		       COALESCE(b.on_hand_lbs, 0)
		FROM harvest_lots hl
		LEFT JOIN honey_varietals v ON v.id = hl.varietal_id
		LEFT JOIN per_lot b ON b.lot_id = hl.inventory_lot_id
		ORDER BY hl.extraction_date DESC, hl.lot_code`, production.HoneyBulkItemID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	defer rows.Close()
	lots := make([]honeyLotBalanceRow, 0)
	for rows.Next() {
		var row honeyLotBalanceRow
		if err := rows.Scan(&row.LotID, &row.LotCode,
			&row.VarietalID, &row.VarietalName, &row.ExtractionDate, &row.LotLbs,
			&row.JarredLbs, &row.BulkUsedLbs, &row.LossLbs, &row.OnHandLbs); err != nil {
			writeError(w, http.StatusInternalServerError, "database error")
			return
		}
		lots = append(lots, row)
	}
	if rows.Err() != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}

	// The unassigned bucket is the residual of the one pool, never a second
	// ledger: everything harvested that no lot claims, minus the draws that
	// name no lot. Only history can land here now.
	totals, err := honeyBulkOnHand(ctx, s.pool)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	// The unassigned bucket is a real lot after the ledger landed, not a
	// computed residual: whatever the legacy tables could not attribute sits
	// in honey_bulk's legacy-unassigned lot, and only history can land there.
	var lotLbs, unassignedLbs, unattributedDraws float64
	if err := s.pool.QueryRow(ctx, `
		WITH `+ledgerClassifiedCTE+`
		SELECT
			COALESCE((SELECT SUM(c.quantity) FROM classified c
			          JOIN inventory_lots l ON l.id = c.lot_id
			          WHERE c.item_id=$1 AND NOT l.is_legacy_unassigned), 0)::float8,
			COALESCE((SELECT SUM(c.quantity) FROM classified c
			          JOIN inventory_lots l ON l.id = c.lot_id
			          WHERE c.item_id=$1 AND l.is_legacy_unassigned), 0)::float8,
			COALESCE((SELECT SUM(-c.quantity) FROM classified c
			          JOIN inventory_lots l ON l.id = c.lot_id
			          WHERE c.item_id=$1 AND l.is_legacy_unassigned
			            AND c.kind IN ('transform','shrink')), 0)::float8`,
		production.HoneyBulkItemID).
		Scan(&lotLbs, &unassignedLbs, &unattributedDraws); err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"lots": lots,
		"unassigned": map[string]any{
			"lbs":       unassignedLbs,
			"drawnLbs":  unattributedDraws,
			"inLotsLbs": lotLbs,
		},
		"totals": totals,
	})
}

type honeyVarietalRow struct {
	ID          uuid.UUID `json:"id"`
	Name        string    `json:"name"`
	Notes       *string   `json:"notes"`
	LotCount    int       `json:"lotCount"`
	LotLbs      float64   `json:"lotLbs"`
	JarredLbs   float64   `json:"jarredLbs"`
	BulkUsedLbs float64   `json:"bulkUsedLbs"`
	LossLbs     float64   `json:"lossLbs"`
	OnHandLbs   float64   `json:"onHandLbs"`
}

// GET /honey/varietals — the canonical list, with each one's bulk balance.
func (s *Server) honeyListVarietals(w http.ResponseWriter, r *http.Request) {
	// The varietal rollup is the same per-lot balances grouped by
	// harvest_lots.varietal_id; honey_varietals stays the canonical list.
	rows, err := s.pool.Query(r.Context(), `
		WITH `+ledgerClassifiedCTE+`,
		per_lot AS (
			SELECT c.lot_id,
			       COALESCE(SUM(quantity) FILTER (WHERE kind IN ('receive','opening_balance')), 0) AS lot_lbs,
			       COALESCE(SUM(-quantity) FILTER (WHERE kind='transform' AND EXISTS (
			         SELECT 1 FROM inventory_movements output
			         JOIN inventory_items output_item ON output_item.id=output.item_id
			         WHERE output.operation_id=c.classified_operation_id
			           AND output.quantity > 0 AND output_item.kind='jar'
			       )), 0) AS jarred_lbs,
			       COALESCE(SUM(-quantity) FILTER (WHERE
			         (kind='transform' AND EXISTS (
			           SELECT 1 FROM inventory_movements output
			           JOIN inventory_items output_item ON output_item.id=output.item_id
			           WHERE output.operation_id=c.classified_operation_id
			             AND output.quantity > 0 AND output_item.kind='catalog_product'
			         )) OR (kind='shrink' AND reason <> 'loss')), 0) AS bulk_used_lbs,
			       COALESCE(SUM(-quantity) FILTER (WHERE kind='shrink' AND reason='loss'), 0) AS loss_lbs,
			       COALESCE(SUM(quantity), 0) AS on_hand_lbs
			FROM classified c WHERE item_id = $1 AND lot_id IS NOT NULL
			GROUP BY c.lot_id
		),
		per_varietal AS (
			SELECT hl.varietal_id,
			       COUNT(*)::int AS lot_count,
			       COALESCE(SUM(b.lot_lbs), 0)::float8 AS lot_lbs,
			       COALESCE(SUM(b.jarred_lbs), 0)::float8 AS jarred_lbs,
			       COALESCE(SUM(b.bulk_used_lbs), 0)::float8 AS bulk_used_lbs,
			       COALESCE(SUM(b.loss_lbs), 0)::float8 AS loss_lbs,
			       COALESCE(SUM(b.on_hand_lbs), 0)::float8 AS on_hand_lbs
			FROM harvest_lots hl
			LEFT JOIN per_lot b ON b.lot_id = hl.inventory_lot_id
			WHERE hl.varietal_id IS NOT NULL
			GROUP BY hl.varietal_id
		)
		SELECT v.id, v.name, v.notes,
		       COALESCE(b.lot_count, 0), COALESCE(b.lot_lbs, 0), COALESCE(b.jarred_lbs, 0),
		       COALESCE(b.bulk_used_lbs, 0), COALESCE(b.loss_lbs, 0), COALESCE(b.on_hand_lbs, 0)
		FROM honey_varietals v
		LEFT JOIN per_varietal b ON b.varietal_id = v.id
		ORDER BY v.name`, production.HoneyBulkItemID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	defer rows.Close()
	out := make([]honeyVarietalRow, 0)
	for rows.Next() {
		var row honeyVarietalRow
		if err := rows.Scan(&row.ID, &row.Name, &row.Notes, &row.LotCount,
			&row.LotLbs, &row.JarredLbs, &row.BulkUsedLbs, &row.LossLbs,
			&row.OnHandLbs); err != nil {
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

// POST /honey/varietals {name, notes?}
func (s *Server) honeyCreateVarietal(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Name  string  `json:"name"`
		Notes *string `json:"notes"`
	}
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	name := strings.TrimSpace(req.Name)
	if name == "" {
		writeError(w, http.StatusBadRequest, "Name is required")
		return
	}
	var id uuid.UUID
	if err := s.pool.QueryRow(r.Context(), `
		INSERT INTO honey_varietals (name, notes, created_by)
		VALUES ($1, $2, $3) RETURNING id`,
		name, honeyTrimPtr(req.Notes), actorID(r)).Scan(&id); err != nil {
		if equipPgErrCode(err, "23505") {
			writeError(w, http.StatusConflict, "That varietal already exists")
			return
		}
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"success": true, "id": id})
}

// PATCH /honey/varietals/{id} {name?, notes?}
func (s *Server) honeyUpdateVarietal(w http.ResponseWriter, r *http.Request) {
	id, err := uuidParam(r, "id")
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	var req struct {
		Name *string `json:"name"`
		// Raw so an explicit null clears the notes; COALESCE would have made
		// blanking them a silent no-op.
		Notes json.RawMessage `json:"notes"`
	}
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	sets := make([]string, 0, 2)
	args := []any{id}
	if req.Name != nil {
		trimmed := strings.TrimSpace(*req.Name)
		if trimmed == "" {
			writeError(w, http.StatusBadRequest, "Name cannot be empty")
			return
		}
		args = append(args, trimmed)
		sets = append(sets, fmt.Sprintf("name = $%d", len(args)))
	}
	if req.Notes != nil {
		var notes *string
		if err := json.Unmarshal(req.Notes, &notes); err != nil {
			writeError(w, http.StatusBadRequest, "invalid notes")
			return
		}
		args = append(args, honeyTrimPtr(notes))
		sets = append(sets, fmt.Sprintf("notes = $%d", len(args)))
	}
	if len(sets) == 0 {
		writeJSON(w, http.StatusOK, map[string]any{"success": true})
		return
	}
	tag, err := s.pool.Exec(r.Context(), fmt.Sprintf(
		"UPDATE honey_varietals SET %s WHERE id = $1", strings.Join(sets, ", ")),
		args...)
	if err != nil {
		if equipPgErrCode(err, "23505") {
			writeError(w, http.StatusConflict, "That varietal already exists")
			return
		}
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	if tag.RowsAffected() == 0 {
		writeError(w, http.StatusNotFound, "varietal not found")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"success": true})
}

// Packaging consumption moved into the bottling transform: the empties a run
// used up are input lines on the same operation that produced its jars (spec
// 6.1), so there is no second ledger and no separate equipment adjustment to
// keep in step. See app/production.RecordBottling.
