package httpapi

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgconn"
)

// Honey ledger: harvests, movements (jarring / bulk use / loss / give-away /
// adjustments), sales, and the derived inventory + overview + timeline.
// Inventory is ALWAYS derived from the ledger, never stored.

func (s *Server) mountHoney(r chi.Router) {
	r.Get("/harvests", s.honeyListHarvests)
	r.Post("/harvests", s.honeyCreateHarvest)

	r.Post("/honey/jarring", s.honeyRecordJarring)
	r.Post("/honey/bulk-movements", s.honeyRecordBulkMovement)
	r.Post("/honey/give-away", s.honeyRecordGiveAway)
	r.Post("/honey/jar-adjustments", s.honeyAdjustJarCounts)
	r.Delete("/honey/movements/{id}", s.honeyDeleteMovement)

	r.Get("/honey/sales", s.honeyListSalesHandler)
	r.Post("/honey/sales", s.honeyRecordSale)
	r.Delete("/honey/sales/{id}", s.honeyDeleteSale)
	r.Get("/honey/sale-locations", s.honeySaleLocations)

	r.Get("/honey/inventory", s.honeyInventoryHandler)
	r.Get("/honey/overview", s.honeyOverviewHandler)
	r.Get("/honey/timeline", s.honeyTimelineHandler)
}

// --- shared helpers ---

func honeyTrimPtr(p *string) *string {
	if p == nil {
		return nil
	}
	v := strings.TrimSpace(*p)
	if v == "" {
		return nil
	}
	return &v
}

func honeyReasonSuffix(reason *string) string {
	if reason == nil || *reason == "" {
		return ""
	}
	return " (" + *reason + ")"
}

// honeyIsFKViolation reports whether err is a foreign-key violation.
func honeyIsFKViolation(err error) bool {
	var pgErr *pgconn.PgError
	return errors.As(err, &pgErr) && pgErr.Code == "23503"
}

type honeyJarLineReq struct {
	JarSizeID string `json:"jarSizeId"`
	Quantity  int    `json:"quantity"`
}

type honeyParsedJarLine struct {
	JarSizeID uuid.UUID
	Quantity  int
}

// honeyValidJarLines filters lines to those with a jar size and quantity > 0,
// parsing jar size ids. Mirrors the legacy filter (blank lines are skipped).
func honeyValidJarLines(lines []honeyJarLineReq) ([]honeyParsedJarLine, error) {
	out := make([]honeyParsedJarLine, 0, len(lines))
	for _, l := range lines {
		if l.JarSizeID == "" || l.Quantity <= 0 {
			continue
		}
		id, err := uuid.Parse(l.JarSizeID)
		if err != nil {
			return nil, fmt.Errorf("invalid jarSizeId")
		}
		out = append(out, honeyParsedJarLine{JarSizeID: id, Quantity: l.Quantity})
	}
	return out, nil
}

// --- harvests ---

// GET /harvests
func (s *Server) honeyListHarvests(w http.ResponseWriter, r *http.Request) {
	rows, err := s.pool.Query(r.Context(), `
		SELECT hh.id, hh.hive_id, hh.date, hh.super_weight_before, hh.super_weight_after,
		       hh.calculated_honey_weight, hh.notes, h.position_label, a.name
		FROM honey_harvests hh
		JOIN hives h ON h.id = hh.hive_id
		JOIN apiaries a ON a.id = h.apiary_id
		ORDER BY hh.date DESC`)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	defer rows.Close()

	type harvestRow struct {
		ID                    uuid.UUID `json:"id"`
		HiveID                uuid.UUID `json:"hiveId"`
		Date                  time.Time `json:"date"`
		SuperWeightBefore     float64   `json:"superWeightBefore"`
		SuperWeightAfter      float64   `json:"superWeightAfter"`
		CalculatedHoneyWeight float64   `json:"calculatedHoneyWeight"`
		Notes                 *string   `json:"notes"`
		HiveName              string    `json:"hiveName"`
		ApiaryName            string    `json:"apiaryName"`
	}
	out := make([]harvestRow, 0)
	for rows.Next() {
		var h harvestRow
		if err := rows.Scan(&h.ID, &h.HiveID, &h.Date, &h.SuperWeightBefore, &h.SuperWeightAfter,
			&h.CalculatedHoneyWeight, &h.Notes, &h.HiveName, &h.ApiaryName); err != nil {
			writeError(w, http.StatusInternalServerError, "database error")
			return
		}
		out = append(out, h)
	}
	if rows.Err() != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	writeJSON(w, http.StatusOK, out)
}

// POST /harvests {hiveId, date, superWeightBefore, superWeightAfter, notes?}
func (s *Server) honeyCreateHarvest(w http.ResponseWriter, r *http.Request) {
	var req struct {
		HiveID            string   `json:"hiveId"`
		Date              string   `json:"date"`
		SuperWeightBefore *float64 `json:"superWeightBefore"`
		SuperWeightAfter  *float64 `json:"superWeightAfter"`
		Notes             *string  `json:"notes"`
	}
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if req.HiveID == "" {
		writeError(w, http.StatusBadRequest, "Hive is required")
		return
	}
	hiveID, err := uuid.Parse(req.HiveID)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid hiveId")
		return
	}
	if req.Date == "" {
		writeError(w, http.StatusBadRequest, "Date is required")
		return
	}
	date, err := parseDate(req.Date)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid date")
		return
	}
	if req.SuperWeightBefore == nil || req.SuperWeightAfter == nil {
		writeError(w, http.StatusBadRequest, "Both weights are required")
		return
	}
	honeyWeight := *req.SuperWeightBefore - *req.SuperWeightAfter
	if honeyWeight < 0 {
		writeError(w, http.StatusBadRequest, "Weight before must be greater than weight after")
		return
	}

	var id uuid.UUID
	err = s.pool.QueryRow(r.Context(), `
		INSERT INTO honey_harvests (hive_id, date, super_weight_before, super_weight_after, calculated_honey_weight, notes)
		VALUES ($1, $2, $3, $4, $5, $6)
		RETURNING id`,
		hiveID, date, *req.SuperWeightBefore, *req.SuperWeightAfter, honeyWeight, honeyTrimPtr(req.Notes)).Scan(&id)
	if err != nil {
		if honeyIsFKViolation(err) {
			writeError(w, http.StatusBadRequest, "invalid hiveId")
			return
		}
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{
		"id":                    id,
		"hiveId":                hiveID,
		"date":                  date,
		"superWeightBefore":     *req.SuperWeightBefore,
		"superWeightAfter":      *req.SuperWeightAfter,
		"calculatedHoneyWeight": honeyWeight,
		"notes":                 honeyTrimPtr(req.Notes),
	})
}

// --- movements ---

// POST /honey/jarring {date, lines, lossLbs?, lossReason?, notes?}
func (s *Server) honeyRecordJarring(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Date       string            `json:"date"`
		Lines      []honeyJarLineReq `json:"lines"`
		LossLbs    *float64          `json:"lossLbs"`
		LossReason *string           `json:"lossReason"`
		Notes      *string           `json:"notes"`
	}
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	lines, err := honeyValidJarLines(req.Lines)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	hasLoss := req.LossLbs != nil && *req.LossLbs > 0
	if len(lines) == 0 && !hasLoss {
		writeError(w, http.StatusBadRequest, "Add at least one jar line")
		return
	}
	if req.Date == "" {
		writeError(w, http.StatusBadRequest, "Date is required")
		return
	}
	date, err := parseDate(req.Date)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid date")
		return
	}
	notes := honeyTrimPtr(req.Notes)

	ctx := r.Context()

	// Look up honey_oz per jar size so we can derive the pounds jarred.
	ozBySize := make(map[uuid.UUID]*float64)
	if len(lines) > 0 {
		ids := make([]uuid.UUID, 0, len(lines))
		for _, l := range lines {
			ids = append(ids, l.JarSizeID)
		}
		rows, err := s.pool.Query(ctx, `SELECT id, honey_oz FROM jar_sizes WHERE id = ANY($1)`, ids)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "database error")
			return
		}
		for rows.Next() {
			var id uuid.UUID
			var oz *float64
			if err := rows.Scan(&id, &oz); err != nil {
				rows.Close()
				writeError(w, http.StatusInternalServerError, "database error")
				return
			}
			ozBySize[id] = oz
		}
		rows.Close()
		if rows.Err() != nil {
			writeError(w, http.StatusInternalServerError, "database error")
			return
		}
	}

	tx, err := s.pool.Begin(ctx)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	defer tx.Rollback(ctx)

	for _, line := range lines {
		var amountLbs *float64
		if oz := ozBySize[line.JarSizeID]; oz != nil {
			v := *oz * float64(line.Quantity) / 16
			amountLbs = &v
		}
		if _, err := tx.Exec(ctx, `
			INSERT INTO honey_movements (date, kind, jar_size_id, quantity, amount_lbs, notes)
			VALUES ($1, 'jarring', $2, $3, $4, $5)`,
			date, line.JarSizeID, line.Quantity, amountLbs, notes); err != nil {
			if honeyIsFKViolation(err) {
				writeError(w, http.StatusBadRequest, "invalid jarSizeId")
				return
			}
			writeError(w, http.StatusInternalServerError, "database error")
			return
		}
	}
	if hasLoss {
		reason := "jarring loss"
		if v := honeyTrimPtr(req.LossReason); v != nil {
			reason = *v
		}
		if _, err := tx.Exec(ctx, `
			INSERT INTO honey_movements (date, kind, amount_lbs, reason, notes)
			VALUES ($1, 'loss', $2, $3, $4)`,
			date, *req.LossLbs, reason, notes); err != nil {
			writeError(w, http.StatusInternalServerError, "database error")
			return
		}
	}
	if err := tx.Commit(ctx); err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"success": true})
}

// POST /honey/bulk-movements {date, kind, amountLbs, reason?, notes?}
func (s *Server) honeyRecordBulkMovement(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Date      string   `json:"date"`
		Kind      string   `json:"kind"`
		AmountLbs *float64 `json:"amountLbs"`
		Reason    *string  `json:"reason"`
		Notes     *string  `json:"notes"`
	}
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if req.Kind != "bulk_use" && req.Kind != "loss" {
		writeError(w, http.StatusBadRequest, "Kind must be bulk_use or loss")
		return
	}
	if req.AmountLbs == nil || *req.AmountLbs <= 0 {
		writeError(w, http.StatusBadRequest, "Amount must be greater than zero")
		return
	}
	if req.Date == "" {
		writeError(w, http.StatusBadRequest, "Date is required")
		return
	}
	date, err := parseDate(req.Date)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid date")
		return
	}
	if _, err := s.pool.Exec(r.Context(), `
		INSERT INTO honey_movements (date, kind, amount_lbs, reason, notes)
		VALUES ($1, $2, $3, $4, $5)`,
		date, req.Kind, *req.AmountLbs, honeyTrimPtr(req.Reason), honeyTrimPtr(req.Notes)); err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"success": true})
}

// POST /honey/give-away {date, lines, reason?, notes?}
func (s *Server) honeyRecordGiveAway(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Date   string            `json:"date"`
		Lines  []honeyJarLineReq `json:"lines"`
		Reason *string           `json:"reason"`
		Notes  *string           `json:"notes"`
	}
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	lines, err := honeyValidJarLines(req.Lines)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	if len(lines) == 0 {
		writeError(w, http.StatusBadRequest, "Add at least one jar line")
		return
	}
	if req.Date == "" {
		writeError(w, http.StatusBadRequest, "Date is required")
		return
	}
	date, err := parseDate(req.Date)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid date")
		return
	}

	ctx := r.Context()
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	defer tx.Rollback(ctx)
	for _, line := range lines {
		if _, err := tx.Exec(ctx, `
			INSERT INTO honey_movements (date, kind, jar_size_id, quantity, reason, notes)
			VALUES ($1, 'give_away', $2, $3, $4, $5)`,
			date, line.JarSizeID, line.Quantity, honeyTrimPtr(req.Reason), honeyTrimPtr(req.Notes)); err != nil {
			if honeyIsFKViolation(err) {
				writeError(w, http.StatusBadRequest, "invalid jarSizeId")
				return
			}
			writeError(w, http.StatusInternalServerError, "database error")
			return
		}
	}
	if err := tx.Commit(ctx); err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"success": true})
}

// POST /honey/jar-adjustments {date, lines:[{jarSizeId, delta}], reason?}
func (s *Server) honeyAdjustJarCounts(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Date  string `json:"date"`
		Lines []struct {
			JarSizeID string `json:"jarSizeId"`
			Delta     int    `json:"delta"`
		} `json:"lines"`
		Reason *string `json:"reason"`
	}
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	type adjLine struct {
		JarSizeID uuid.UUID
		Delta     int
	}
	lines := make([]adjLine, 0, len(req.Lines))
	for _, l := range req.Lines {
		if l.JarSizeID == "" || l.Delta == 0 {
			continue
		}
		id, err := uuid.Parse(l.JarSizeID)
		if err != nil {
			writeError(w, http.StatusBadRequest, "invalid jarSizeId")
			return
		}
		lines = append(lines, adjLine{JarSizeID: id, Delta: l.Delta})
	}
	if len(lines) == 0 {
		writeError(w, http.StatusBadRequest, "No changes to apply")
		return
	}
	if req.Date == "" {
		writeError(w, http.StatusBadRequest, "Date is required")
		return
	}
	date, err := parseDate(req.Date)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid date")
		return
	}
	reason := "manual correction"
	if v := honeyTrimPtr(req.Reason); v != nil {
		reason = *v
	}

	ctx := r.Context()
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	defer tx.Rollback(ctx)
	for _, line := range lines {
		if _, err := tx.Exec(ctx, `
			INSERT INTO honey_movements (date, kind, jar_size_id, quantity, reason)
			VALUES ($1, 'jar_adjustment', $2, $3, $4)`,
			date, line.JarSizeID, line.Delta, reason); err != nil {
			if honeyIsFKViolation(err) {
				writeError(w, http.StatusBadRequest, "invalid jarSizeId")
				return
			}
			writeError(w, http.StatusInternalServerError, "database error")
			return
		}
	}
	if err := tx.Commit(ctx); err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"success": true})
}

// DELETE /honey/movements/{id}
func (s *Server) honeyDeleteMovement(w http.ResponseWriter, r *http.Request) {
	id, err := uuidParam(r, "id")
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	tag, err := s.pool.Exec(r.Context(), `DELETE FROM honey_movements WHERE id = $1`, id)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	if tag.RowsAffected() == 0 {
		writeError(w, http.StatusNotFound, "movement not found")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"success": true})
}

// --- sales ---

type honeySaleItemRow struct {
	SaleID    uuid.UUID `json:"saleId"`
	JarSizeID uuid.UUID `json:"jarSizeId"`
	Quantity  int       `json:"quantity"`
	UnitPrice float64   `json:"unitPrice"`
	Label     string    `json:"label"`
}

type honeySaleRow struct {
	ID           uuid.UUID          `json:"id"`
	Date         time.Time          `json:"date"`
	CustomerName *string            `json:"customerName"`
	Location     *string            `json:"location"`
	TotalAmount  float64            `json:"totalAmount"`
	Notes        *string            `json:"notes"`
	CreatedAt    time.Time          `json:"createdAt"`
	LineItems    []honeySaleItemRow `json:"lineItems"`
}

func (s *Server) honeyListSales(ctx context.Context) ([]honeySaleRow, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT id, date, customer_name, location, total_amount, notes, created_at
		FROM honey_sales
		ORDER BY date DESC`)
	if err != nil {
		return nil, err
	}
	sales := make([]honeySaleRow, 0)
	for rows.Next() {
		var sale honeySaleRow
		if err := rows.Scan(&sale.ID, &sale.Date, &sale.CustomerName, &sale.Location,
			&sale.TotalAmount, &sale.Notes, &sale.CreatedAt); err != nil {
			rows.Close()
			return nil, err
		}
		sale.LineItems = make([]honeySaleItemRow, 0)
		sales = append(sales, sale)
	}
	rows.Close()
	if rows.Err() != nil {
		return nil, rows.Err()
	}

	itemRows, err := s.pool.Query(ctx, `
		SELECT si.sale_id, si.jar_size_id, si.quantity, si.unit_price, js.label
		FROM honey_sale_items si
		JOIN jar_sizes js ON js.id = si.jar_size_id`)
	if err != nil {
		return nil, err
	}
	defer itemRows.Close()
	itemsBySale := make(map[uuid.UUID][]honeySaleItemRow)
	for itemRows.Next() {
		var item honeySaleItemRow
		if err := itemRows.Scan(&item.SaleID, &item.JarSizeID, &item.Quantity, &item.UnitPrice, &item.Label); err != nil {
			return nil, err
		}
		itemsBySale[item.SaleID] = append(itemsBySale[item.SaleID], item)
	}
	if itemRows.Err() != nil {
		return nil, itemRows.Err()
	}
	for i := range sales {
		if items, ok := itemsBySale[sales[i].ID]; ok {
			sales[i].LineItems = items
		}
	}
	return sales, nil
}

// GET /honey/sales
func (s *Server) honeyListSalesHandler(w http.ResponseWriter, r *http.Request) {
	sales, err := s.honeyListSales(r.Context())
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	writeJSON(w, http.StatusOK, sales)
}

// POST /honey/sales {date, location?, customerName?, lines:[{jarSizeId, quantity, unitPrice}], notes?}
func (s *Server) honeyRecordSale(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Date         string  `json:"date"`
		Location     *string `json:"location"`
		CustomerName *string `json:"customerName"`
		Lines        []struct {
			JarSizeID string  `json:"jarSizeId"`
			Quantity  int     `json:"quantity"`
			UnitPrice float64 `json:"unitPrice"`
		} `json:"lines"`
		Notes *string `json:"notes"`
	}
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	type saleLine struct {
		JarSizeID uuid.UUID
		Quantity  int
		UnitPrice float64
	}
	lines := make([]saleLine, 0, len(req.Lines))
	for _, l := range req.Lines {
		if l.JarSizeID == "" || l.Quantity <= 0 {
			continue
		}
		id, err := uuid.Parse(l.JarSizeID)
		if err != nil {
			writeError(w, http.StatusBadRequest, "invalid jarSizeId")
			return
		}
		lines = append(lines, saleLine{JarSizeID: id, Quantity: l.Quantity, UnitPrice: l.UnitPrice})
	}
	if len(lines) == 0 {
		writeError(w, http.StatusBadRequest, "Add at least one line")
		return
	}
	if req.Date == "" {
		writeError(w, http.StatusBadRequest, "Date is required")
		return
	}
	date, err := parseDate(req.Date)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid date")
		return
	}

	ctx := r.Context()

	// Validate availability against the derived inventory.
	inventory, err := s.honeyJarInventory(ctx)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	onHand := make(map[uuid.UUID]int, len(inventory))
	labels := make(map[uuid.UUID]string, len(inventory))
	for _, row := range inventory {
		onHand[row.JarSizeID] = row.OnHand
		labels[row.JarSizeID] = row.Label
	}
	for _, line := range lines {
		have := onHand[line.JarSizeID]
		if line.Quantity > have {
			label, ok := labels[line.JarSizeID]
			if !ok {
				label = "jars"
			}
			writeError(w, http.StatusBadRequest,
				fmt.Sprintf("Not enough %s: need %d, have %d", label, line.Quantity, have))
			return
		}
	}

	totalAmount := 0.0
	for _, line := range lines {
		totalAmount += float64(line.Quantity) * line.UnitPrice
	}

	tx, err := s.pool.Begin(ctx)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	defer tx.Rollback(ctx)
	var saleID uuid.UUID
	if err := tx.QueryRow(ctx, `
		INSERT INTO honey_sales (date, customer_name, location, total_amount, notes)
		VALUES ($1, $2, $3, $4, $5)
		RETURNING id`,
		date, honeyTrimPtr(req.CustomerName), honeyTrimPtr(req.Location), totalAmount,
		honeyTrimPtr(req.Notes)).Scan(&saleID); err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	for _, line := range lines {
		if _, err := tx.Exec(ctx, `
			INSERT INTO honey_sale_items (sale_id, jar_size_id, quantity, unit_price)
			VALUES ($1, $2, $3, $4)`,
			saleID, line.JarSizeID, line.Quantity, line.UnitPrice); err != nil {
			if honeyIsFKViolation(err) {
				writeError(w, http.StatusBadRequest, "invalid jarSizeId")
				return
			}
			writeError(w, http.StatusInternalServerError, "database error")
			return
		}
	}
	if err := tx.Commit(ctx); err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"success": true, "id": saleID, "totalAmount": totalAmount})
}

// DELETE /honey/sales/{id} — items cascade via FK.
func (s *Server) honeyDeleteSale(w http.ResponseWriter, r *http.Request) {
	id, err := uuidParam(r, "id")
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	tag, err := s.pool.Exec(r.Context(), `DELETE FROM honey_sales WHERE id = $1`, id)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	if tag.RowsAffected() == 0 {
		writeError(w, http.StatusNotFound, "sale not found")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"success": true})
}

// GET /honey/sale-locations — distinct non-null locations for autocomplete.
func (s *Server) honeySaleLocations(w http.ResponseWriter, r *http.Request) {
	rows, err := s.pool.Query(r.Context(),
		`SELECT DISTINCT location FROM honey_sales WHERE location IS NOT NULL`)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	defer rows.Close()
	out := make([]string, 0)
	for rows.Next() {
		var loc string
		if err := rows.Scan(&loc); err != nil {
			writeError(w, http.StatusInternalServerError, "database error")
			return
		}
		out = append(out, loc)
	}
	if rows.Err() != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	writeJSON(w, http.StatusOK, out)
}

// --- derived inventory + overview + timeline ---

type honeyInventoryRow struct {
	JarSizeID    uuid.UUID `json:"jarSizeId"`
	Label        string    `json:"label"`
	HoneyOz      *float64  `json:"honeyOz"`
	DefaultPrice *float64  `json:"defaultPrice"`
	Jarred       int       `json:"jarred"`
	Sold         int       `json:"sold"`
	GivenAway    int       `json:"givenAway"`
	Adjusted     int       `json:"adjusted"`
	OnHand       int       `json:"onHand"`
}

// honeyJarInventory derives jar counts from the ledger for each active size:
// onHand = jarred + adjusted − sold − givenAway.
func (s *Server) honeyJarInventory(ctx context.Context) ([]honeyInventoryRow, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT js.id, js.label, js.honey_oz, js.default_price,
		       COALESCE(m.jarred, 0), COALESCE(m.given_away, 0), COALESCE(m.adjusted, 0),
		       COALESCE(si.sold, 0)
		FROM jar_sizes js
		LEFT JOIN (
			SELECT jar_size_id,
			       COALESCE(SUM(quantity) FILTER (WHERE kind = 'jarring'), 0)        AS jarred,
			       COALESCE(SUM(quantity) FILTER (WHERE kind = 'give_away'), 0)      AS given_away,
			       COALESCE(SUM(quantity) FILTER (WHERE kind = 'jar_adjustment'), 0) AS adjusted
			FROM honey_movements
			GROUP BY jar_size_id
		) m ON m.jar_size_id = js.id
		LEFT JOIN (
			SELECT jar_size_id, SUM(quantity) AS sold
			FROM honey_sale_items
			GROUP BY jar_size_id
		) si ON si.jar_size_id = js.id
		WHERE js.is_active
		ORDER BY js.sort_order, js.label`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]honeyInventoryRow, 0)
	for rows.Next() {
		var row honeyInventoryRow
		if err := rows.Scan(&row.JarSizeID, &row.Label, &row.HoneyOz, &row.DefaultPrice,
			&row.Jarred, &row.GivenAway, &row.Adjusted, &row.Sold); err != nil {
			return nil, err
		}
		row.OnHand = row.Jarred + row.Adjusted - row.Sold - row.GivenAway
		out = append(out, row)
	}
	return out, rows.Err()
}

// GET /honey/inventory
func (s *Server) honeyInventoryHandler(w http.ResponseWriter, r *http.Request) {
	inventory, err := s.honeyJarInventory(r.Context())
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	writeJSON(w, http.StatusOK, inventory)
}

// GET /honey/overview
func (s *Server) honeyOverviewHandler(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	var sessionTotal, harvestTotal, totalRevenue float64
	var jarsSold int
	err := s.pool.QueryRow(ctx, `SELECT
		(SELECT COALESCE(SUM(total_extracted_weight), 0) FROM harvest_sessions),
		(SELECT COALESCE(SUM(calculated_honey_weight), 0) FROM honey_harvests),
		(SELECT COALESCE(SUM(total_amount), 0) FROM honey_sales),
		(SELECT COALESCE(SUM(quantity), 0) FROM honey_sale_items)`).
		Scan(&sessionTotal, &harvestTotal, &totalRevenue, &jarsSold)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}

	// Sessions hold the authoritative extracted weight when used; per-hive
	// harvest entries are the fallback.
	totalHarvested := harvestTotal
	if sessionTotal > 0 {
		totalHarvested = sessionTotal
	}

	lbsByKind := make(map[string]float64)
	rows, err := s.pool.Query(ctx,
		`SELECT kind, COALESCE(SUM(amount_lbs), 0) FROM honey_movements GROUP BY kind`)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	for rows.Next() {
		var kind string
		var total float64
		if err := rows.Scan(&kind, &total); err != nil {
			rows.Close()
			writeError(w, http.StatusInternalServerError, "database error")
			return
		}
		lbsByKind[kind] = total
	}
	rows.Close()
	if rows.Err() != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}

	inventory, err := s.honeyJarInventory(ctx)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}

	jarredLbs := lbsByKind["jarring"]
	bulkUsedLbs := lbsByKind["bulk_use"]
	lossLbs := lbsByKind["loss"]
	writeJSON(w, http.StatusOK, map[string]any{
		"totalHarvestedLbs": totalHarvested,
		"jarredLbs":         jarredLbs,
		"bulkUsedLbs":       bulkUsedLbs,
		"lossLbs":           lossLbs,
		"bulkOnHandLbs":     totalHarvested - jarredLbs - bulkUsedLbs - lossLbs,
		"totalRevenue":      totalRevenue,
		"jarsSold":          jarsSold,
		"inventory":         inventory,
	})
}

type honeyTimelineEntry struct {
	ID          uuid.UUID `json:"id"`
	Date        time.Time `json:"date"`
	Type        string    `json:"type"`
	Description string    `json:"description"`
	AmountLbs   *float64  `json:"amountLbs"`
	Quantity    *int      `json:"quantity"`
	TotalAmount *float64  `json:"totalAmount"`
	Notes       *string   `json:"notes"`
}

// GET /honey/timeline?limit= — movements + sales merged, newest first.
func (s *Server) honeyTimelineHandler(w http.ResponseWriter, r *http.Request) {
	limit := 50
	if v := r.URL.Query().Get("limit"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			limit = n
		}
	}
	ctx := r.Context()

	rows, err := s.pool.Query(ctx, `
		SELECT m.id, m.date, m.kind, m.amount_lbs, m.quantity, m.reason, m.notes, js.label
		FROM honey_movements m
		LEFT JOIN jar_sizes js ON js.id = m.jar_size_id
		ORDER BY m.date DESC
		LIMIT $1`, limit)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	entries := make([]honeyTimelineEntry, 0)
	for rows.Next() {
		var (
			id                  uuid.UUID
			date                time.Time
			kind                string
			amountLbs           *float64
			quantity            *int
			reason, notes, size *string
		)
		if err := rows.Scan(&id, &date, &kind, &amountLbs, &quantity, &reason, &notes, &size); err != nil {
			rows.Close()
			writeError(w, http.StatusInternalServerError, "database error")
			return
		}
		label := "?"
		if size != nil {
			label = *size
		}
		qty := 0
		if quantity != nil {
			qty = *quantity
		}
		lbs := 0.0
		if amountLbs != nil {
			lbs = *amountLbs
		}
		var description string
		switch kind {
		case "jarring":
			description = fmt.Sprintf("Jarred %d × %s", qty, label)
		case "give_away":
			description = fmt.Sprintf("Gave away %d × %s%s", qty, label, honeyReasonSuffix(reason))
		case "jar_adjustment":
			description = fmt.Sprintf("Adjusted %s by %+d%s", label, qty, honeyReasonSuffix(reason))
		case "bulk_use":
			description = fmt.Sprintf("Used %.1f lbs bulk%s", lbs, honeyReasonSuffix(reason))
		default: // loss
			description = fmt.Sprintf("Loss %.1f lbs%s", lbs, honeyReasonSuffix(reason))
		}
		entries = append(entries, honeyTimelineEntry{
			ID: id, Date: date, Type: kind, Description: description,
			AmountLbs: amountLbs, Quantity: quantity, Notes: notes,
		})
	}
	rows.Close()
	if rows.Err() != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}

	sales, err := s.honeyListSales(ctx)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	if len(sales) > limit {
		sales = sales[:limit]
	}
	for _, sale := range sales {
		parts := make([]string, 0, len(sale.LineItems))
		jarCount := 0
		for _, item := range sale.LineItems {
			parts = append(parts, fmt.Sprintf("%d × %s", item.Quantity, item.Label))
			jarCount += item.Quantity
		}
		summary := strings.Join(parts, ", ")
		if summary == "" {
			summary = "items"
		}
		description := "Sold " + summary
		if sale.Location != nil && *sale.Location != "" {
			description += " @ " + *sale.Location
		}
		if sale.CustomerName != nil && *sale.CustomerName != "" {
			description += " to " + *sale.CustomerName
		}
		qty := jarCount
		total := sale.TotalAmount
		entries = append(entries, honeyTimelineEntry{
			ID: sale.ID, Date: sale.Date, Type: "sale", Description: description,
			Quantity: &qty, TotalAmount: &total, Notes: sale.Notes,
		})
	}

	sort.SliceStable(entries, func(i, j int) bool {
		return entries[i].Date.After(entries[j].Date)
	})
	if len(entries) > limit {
		entries = entries[:limit]
	}
	writeJSON(w, http.StatusOK, entries)
}
