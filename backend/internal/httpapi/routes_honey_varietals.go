package httpapi

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"sort"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// Per-lot bulk balances and the varietal rollup over them. Bulk honey is one
// pool split into labelled buckets (migration 00047): every lot holds what it
// yielded minus what has been jarred, used, or lost from it, and whatever is
// not in any lot sits in the unassigned bucket that history left behind.

type honeyLotBalanceRow struct {
	LotID          uuid.UUID  `json:"lotId"`
	LotCode        string     `json:"lotCode"`
	HoneyVariety   *string    `json:"honeyVariety"`
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
	rows, err := s.pool.Query(ctx, `
		SELECT lot_id, lot_code, honey_variety, varietal_id, varietal_name,
		       to_char(extraction_date, 'YYYY-MM-DD'),
		       lot_lbs, jarred_lbs, bulk_used_lbs, loss_lbs, on_hand_lbs
		FROM honey_lot_balances
		ORDER BY extraction_date DESC, lot_code`)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	defer rows.Close()
	lots := make([]honeyLotBalanceRow, 0)
	for rows.Next() {
		var row honeyLotBalanceRow
		if err := rows.Scan(&row.LotID, &row.LotCode, &row.HoneyVariety,
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
	var lotLbs, unattributedDraws float64
	if err := s.pool.QueryRow(ctx, `
		SELECT
			COALESCE((SELECT SUM(honey_weight_lbs) FROM harvest_lots), 0),
			COALESCE((SELECT SUM(amount_lbs) FROM honey_movements
			          WHERE lot_id IS NULL
			            AND kind IN ('jarring','bulk_use','loss')), 0)`).
		Scan(&lotLbs, &unattributedDraws); err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"lots": lots,
		"unassigned": map[string]any{
			"lbs":       totals.TotalHarvestedLbs - lotLbs - unattributedDraws,
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
	rows, err := s.pool.Query(r.Context(), `
		SELECT v.id, v.name, v.notes, b.lot_count, b.lot_lbs, b.jarred_lbs,
		       b.bulk_used_lbs, b.loss_lbs, b.on_hand_lbs
		FROM honey_varietals v
		JOIN honey_varietal_balances b ON b.varietal_id = v.id
		ORDER BY v.name`)
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

// --- packaging consumption ------------------------------------------------

// honeyConsumePackaging draws down the empty containers a jarring filled.
// Packaging lives on the equipment ledger (migration 00048), so each linked
// jar size writes one negative 'consumed' adjustment against its packaging
// type. Rows are locked in id order, the same discipline the assembly path
// uses, so concurrent jarring cannot deadlock or double-spend.
//
// Running short is reported, not refused: the jars have already been filled,
// so the honest record is a negative count plus a warning to go and correct
// the empties.
func honeyConsumePackaging(
	ctx context.Context,
	tx pgx.Tx,
	lines []honeyParsedJarLine,
	packagingBySize map[uuid.UUID]uuid.UUID,
	date time.Time,
	actor *uuid.UUID,
) ([]string, error) {
	warnings := make([]string, 0)
	if len(packagingBySize) == 0 {
		return warnings, nil
	}
	// One jar size may appear on several lines; consume the total once.
	needed := make(map[uuid.UUID]int)
	for _, line := range lines {
		typeID, ok := packagingBySize[line.JarSizeID]
		if !ok {
			continue
		}
		needed[typeID] += line.Quantity
	}
	if len(needed) == 0 {
		return warnings, nil
	}

	typeIDs := make([]uuid.UUID, 0, len(needed))
	for typeID := range needed {
		typeIDs = append(typeIDs, typeID)
	}
	// A packaging type that has never been stocked still gets a row, so the
	// consumption lands somewhere and the shortfall is visible.
	for _, typeID := range typeIDs {
		if _, err := tx.Exec(ctx, `
			INSERT INTO equipment_stock (type_id, total_owned, created_by)
			VALUES ($1, 0, $2)
			ON CONFLICT (type_id) DO NOTHING`, typeID, actor); err != nil {
			return nil, err
		}
	}

	rows, err := tx.Query(ctx, `
		SELECT id, type_id FROM equipment_stock
		WHERE type_id = ANY($1) ORDER BY id`, typeIDs)
	if err != nil {
		return nil, err
	}
	stockByType := make(map[uuid.UUID]uuid.UUID, len(typeIDs))
	lockOrder := make([]uuid.UUID, 0, len(typeIDs))
	for rows.Next() {
		var stockID, typeID uuid.UUID
		if err := rows.Scan(&stockID, &typeID); err != nil {
			rows.Close()
			return nil, err
		}
		stockByType[typeID] = stockID
		lockOrder = append(lockOrder, stockID)
	}
	rows.Close()
	if rows.Err() != nil {
		return nil, rows.Err()
	}
	sort.Slice(lockOrder, func(i, j int) bool {
		return lockOrder[i].String() < lockOrder[j].String()
	})
	states := make(map[uuid.UUID]equipStockState, len(lockOrder))
	for _, stockID := range lockOrder {
		state, err := equipLockStock(ctx, tx, stockID)
		if err != nil {
			return nil, err
		}
		states[stockID] = state
	}

	for _, typeID := range typeIDs {
		stockID, ok := stockByType[typeID]
		if !ok {
			continue
		}
		state := states[stockID]
		quantity := needed[typeID]
		if state.Available() < quantity {
			warnings = append(warnings, fmt.Sprintf(
				"%s: filled %d but only %d were on hand",
				state.TypeName, quantity, state.Available()))
		}
		note := "consumed by jarring"
		if _, err := equipInsertAdjustment(ctx, tx, equipAdjustmentEntry{
			StockID:       stockID,
			Quantity:      -quantity,
			Reason:        "consumed",
			Notes:         &note,
			UnitCostCents: state.UnitCostCents,
			Date:          date,
			CreatedBy:     actor,
		}); err != nil {
			return nil, err
		}
	}
	return warnings, nil
}
