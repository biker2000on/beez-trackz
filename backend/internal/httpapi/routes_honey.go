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
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

// Honey ledger: harvests, movements (jarring / bulk use / loss / give-away /
// adjustments), sales, and the derived inventory + overview + timeline.
// Inventory is ALWAYS derived from the ledger, never stored.

func (s *Server) mountHoney(r chi.Router) {
	admin := r.With(s.requireAdmin)
	admin.Get("/harvests", s.honeyListHarvests)
	admin.Post("/harvests", s.honeyCreateHarvest)

	admin.Post("/honey/jarring", s.honeyRecordJarring)
	admin.Post("/honey/bulk-movements", s.honeyRecordBulkMovement)
	admin.Post("/honey/give-away", s.honeyRecordGiveAway)
	admin.Post("/honey/jar-adjustments", s.honeyAdjustJarCounts)
	// Reverses rather than deletes; see honeyReverseMovement.
	admin.Delete("/honey/movements/{id}", s.honeyReverseMovement)

	admin.Get("/honey/sales", s.honeyListSalesHandler)
	admin.Post("/honey/sales", s.honeyRecordSale)
	admin.Patch("/honey/sales/{id}", s.honeyUpdateSale)
	// Cancels rather than deletes; see honeyCancelSale.
	admin.Delete("/honey/sales/{id}", s.honeyCancelSale)
	admin.Get("/honey/sale-locations", s.honeySaleLocations)

	admin.Get("/honey/inventory", s.honeyInventoryHandler)
	admin.Get("/honey/overview", s.honeyOverviewHandler)
	admin.Get("/honey/timeline", s.honeyTimelineHandler)
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
		SELECT hh.id, hh.hive_id, hh.session_id, hh.date, hh.super_weight_before,
		       hh.super_weight_after, hh.calculated_honey_weight, hh.direct_weight,
		       hh.notes, h.position_label, a.name
		FROM honey_harvests hh
		JOIN hives h ON h.id = hh.hive_id
		JOIN apiaries a ON a.id = h.apiary_id
		WHERE hh.deleted_at IS NULL
		ORDER BY hh.date DESC`)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	defer rows.Close()

	type harvestRow struct {
		ID                    uuid.UUID  `json:"id"`
		HiveID                uuid.UUID  `json:"hiveId"`
		SessionID             *uuid.UUID `json:"sessionId"`
		Date                  time.Time  `json:"date"`
		SuperWeightBefore     float64    `json:"superWeightBefore"`
		SuperWeightAfter      float64    `json:"superWeightAfter"`
		CalculatedHoneyWeight float64    `json:"calculatedHoneyWeight"`
		DirectWeight          bool       `json:"directWeight"`
		Notes                 *string    `json:"notes"`
		HiveName              string     `json:"hiveName"`
		ApiaryName            string     `json:"apiaryName"`
	}
	out := make([]harvestRow, 0)
	for rows.Next() {
		var h harvestRow
		if err := rows.Scan(&h.ID, &h.HiveID, &h.SessionID, &h.Date,
			&h.SuperWeightBefore, &h.SuperWeightAfter,
			&h.CalculatedHoneyWeight, &h.DirectWeight,
			&h.Notes, &h.HiveName, &h.ApiaryName); err != nil {
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

// POST /harvests {hiveId, date, superWeightBefore+superWeightAfter |
// harvestedWeight, notes?} — a standalone (session-less) harvest, measured
// either as a super-weight pair or as the harvested honey directly.
func (s *Server) honeyCreateHarvest(w http.ResponseWriter, r *http.Request) {
	var req struct {
		HiveID string `json:"hiveId"`
		Date   string `json:"date"`
		hsEntryReq
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
	before, after, honeyWeight, direct, msg := hsEntryWeights(req.hsEntryReq)
	if msg != "" {
		writeError(w, http.StatusBadRequest, msg)
		return
	}
	if msg, err := refuseHiveHarvest(r.Context(), s.pool, hiveID, date); err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	} else if msg != "" {
		writeError(w, http.StatusConflict, msg)
		return
	}

	var id uuid.UUID
	err = s.pool.QueryRow(r.Context(), `
		INSERT INTO honey_harvests
			(hive_id, date, super_weight_before, super_weight_after,
			 calculated_honey_weight, direct_weight, notes, created_by)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
		RETURNING id`,
		hiveID, date, before, after, honeyWeight, direct,
		honeyTrimPtr(req.Notes), actorID(r)).Scan(&id)
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
		"superWeightBefore":     before,
		"superWeightAfter":      after,
		"calculatedHoneyWeight": honeyWeight,
		"directWeight":          direct,
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

	tx, err := s.pool.Begin(ctx)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	defer tx.Rollback(ctx)

	// Look up honey_oz per jar size so we can derive the pounds jarred.
	// Inside the transaction: a read on the pool before Begin could see a
	// jar-size edit the transaction then wouldn't, deriving amount_lbs from
	// stale ounces.
	ozBySize := make(map[uuid.UUID]*float64)
	if len(lines) > 0 {
		ids := make([]uuid.UUID, 0, len(lines))
		for _, l := range lines {
			ids = append(ids, l.JarSizeID)
		}
		rows, err := tx.Query(ctx, `SELECT id, honey_oz FROM jar_sizes WHERE id = ANY($1)`, ids)
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

	// Jarring and its loss line both draw down bulk honey. Lock the bulk pool
	// and validate the whole request against it before writing anything —
	// jarring 500 lbs against 3 lbs on hand used to succeed silently.
	bulk, err := honeyLockBulk(ctx, tx)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	requestedLbs := 0.0
	amountByLine := make([]float64, len(lines))
	for i, line := range lines {
		// A jar size with no honey_oz attributes no pounds; that is recorded as
		// an explicit zero so the ledger never carries an undefined weight.
		if oz := ozBySize[line.JarSizeID]; oz != nil {
			amountByLine[i] = *oz * float64(line.Quantity) / 16
		}
		requestedLbs += amountByLine[i]
	}
	if hasLoss {
		requestedLbs += *req.LossLbs
	}
	if message := honeyBulkShortfall(requestedLbs, bulk.BulkOnHandLbs); message != "" {
		writeError(w, http.StatusBadRequest, message)
		return
	}

	actor := actorID(r)
	for i, line := range lines {
		if _, err := tx.Exec(ctx, `
			INSERT INTO honey_movements (date, kind, jar_size_id, quantity, amount_lbs, notes, created_by)
			VALUES ($1, 'jarring', $2, $3, $4, $5, $6)`,
			date, line.JarSizeID, line.Quantity, amountByLine[i], notes, actor); err != nil {
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
			INSERT INTO honey_movements (date, kind, amount_lbs, reason, notes, created_by)
			VALUES ($1, 'loss', $2, $3, $4, $5)`,
			date, *req.LossLbs, reason, notes, actor); err != nil {
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

	ctx := r.Context()
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	defer tx.Rollback(ctx)
	bulk, err := honeyLockBulk(ctx, tx)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	if message := honeyBulkShortfall(*req.AmountLbs, bulk.BulkOnHandLbs); message != "" {
		writeError(w, http.StatusBadRequest, message)
		return
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO honey_movements (date, kind, amount_lbs, reason, notes, created_by)
		VALUES ($1, $2, $3, $4, $5, $6)`,
		date, req.Kind, *req.AmountLbs, honeyTrimPtr(req.Reason),
		honeyTrimPtr(req.Notes), actorID(r)); err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	if err := tx.Commit(ctx); err != nil {
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

	// Same lock-and-validate pattern the sale path uses: giving away jars you
	// do not have is a stock error, not a data-entry preference.
	jarSizeIDs := make([]uuid.UUID, 0, len(lines))
	needed := make(map[uuid.UUID]int, len(lines))
	for _, line := range lines {
		jarSizeIDs = append(jarSizeIDs, line.JarSizeID)
		needed[line.JarSizeID] += line.Quantity
	}
	onHand, labels, unknown, err := honeyLockJarSizes(ctx, tx, jarSizeIDs)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	if unknown {
		writeError(w, http.StatusBadRequest, "invalid jarSizeId")
		return
	}
	if message := honeyCheckJarAvailability(onHand, labels, needed); message != "" {
		writeError(w, http.StatusBadRequest, message)
		return
	}

	actor := actorID(r)
	for _, line := range lines {
		if _, err := tx.Exec(ctx, `
			INSERT INTO honey_movements (date, kind, jar_size_id, quantity, reason, notes, created_by)
			VALUES ($1, 'give_away', $2, $3, $4, $5, $6)`,
			date, line.JarSizeID, line.Quantity, honeyTrimPtr(req.Reason),
			honeyTrimPtr(req.Notes), actor); err != nil {
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
	// jar_adjustment is deliberately unbounded: correcting a miscount to a
	// number below the derived total is exactly what it exists for.
	actor := actorID(r)
	for _, line := range lines {
		if _, err := tx.Exec(ctx, `
			INSERT INTO honey_movements (date, kind, jar_size_id, quantity, reason, created_by)
			VALUES ($1, 'jar_adjustment', $2, $3, $4, $5)`,
			date, line.JarSizeID, line.Delta, reason, actor); err != nil {
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

// DELETE /honey/movements/{id} records a REVERSING ENTRY. The ledger is
// append-only, so undoing a movement means writing its negation, linked to the
// original, rather than destroying the evidence that it happened. The endpoint
// and its {"success": true} response are unchanged for callers.
//
// Optional body: {"reason": "..."}.
func (s *Server) honeyReverseMovement(w http.ResponseWriter, r *http.Request) {
	id, err := uuidParam(r, "id")
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	var req struct {
		Reason *string `json:"reason"`
	}
	// A DELETE may legitimately carry no body.
	_ = decodeJSON(r, &req)

	ctx := r.Context()
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	defer tx.Rollback(ctx)

	var (
		kind          string
		amountLbs     *float64
		quantity      *int
		jarSizeID     *uuid.UUID
		bottlingRunID *uuid.UUID
		originReason  *string
		notes         *string
		reversesID    *uuid.UUID
	)
	err = tx.QueryRow(ctx, `
		SELECT kind, amount_lbs, quantity, jar_size_id, bottling_run_id, reason, notes,
			reverses_movement_id
		FROM honey_movements WHERE id = $1 FOR UPDATE`, id).
		Scan(&kind, &amountLbs, &quantity, &jarSizeID, &bottlingRunID,
			&originReason, &notes, &reversesID)
	if errors.Is(err, pgx.ErrNoRows) {
		writeError(w, http.StatusNotFound, "movement not found")
		return
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	if reversesID != nil {
		writeError(w, http.StatusBadRequest, "a reversing entry cannot itself be reversed")
		return
	}

	var alreadyReversed uuid.UUID
	err = tx.QueryRow(ctx,
		`SELECT id FROM honey_movements WHERE reverses_movement_id = $1`, id).Scan(&alreadyReversed)
	if err == nil {
		writeError(w, http.StatusConflict, "movement has already been reversed")
		return
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}

	// A run-linked movement cannot be reversed on its own: the bottling run,
	// its serials, and the lot's bottled total would all survive the reversal
	// and permanently disagree with the ledger.
	if bottlingRunID != nil {
		writeError(w, http.StatusConflict,
			"this movement belongs to a bottling run and cannot be reversed on its own")
		return
	}

	// Reversing a movement that added jars removes them, so the removal must
	// clear the same availability bar as any other jar withdrawal — otherwise
	// jars that were already sold could be reversed into negative stock.
	if jarSizeID != nil && quantity != nil && *quantity > 0 &&
		(kind == "jarring" || kind == "jar_adjustment") {
		onHand, labels, unknown, lockErr := honeyLockJarSizes(ctx, tx, []uuid.UUID{*jarSizeID})
		if lockErr != nil {
			writeError(w, http.StatusInternalServerError, "database error")
			return
		}
		if unknown {
			writeError(w, http.StatusBadRequest, "invalid jarSizeId")
			return
		}
		if message := honeyCheckJarAvailability(onHand, labels,
			map[uuid.UUID]int{*jarSizeID: *quantity}); message != "" {
			writeError(w, http.StatusBadRequest, message)
			return
		}
	}

	reversalReason := "reversal of " + kind
	if v := honeyTrimPtr(req.Reason); v != nil {
		reversalReason = *v
	} else if originReason != nil && *originReason != "" {
		reversalReason += " (" + *originReason + ")"
	}
	var negatedLbs *float64
	if amountLbs != nil {
		v := -*amountLbs
		negatedLbs = &v
	}
	var negatedQuantity *int
	if quantity != nil {
		v := -*quantity
		negatedQuantity = &v
	}

	var reversalID uuid.UUID
	if err := tx.QueryRow(ctx, `
		INSERT INTO honey_movements
			(date, kind, amount_lbs, jar_size_id, quantity, reason, notes,
			 reverses_movement_id, bottling_run_id, created_by)
		VALUES (now(), $1, $2, $3, $4, $5, $6, $7, $8, $9)
		RETURNING id`,
		kind, negatedLbs, jarSizeID, negatedQuantity, reversalReason, notes,
		id, bottlingRunID, actorID(r)).Scan(&reversalID); err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	if err := tx.Commit(ctx); err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"success":            true,
		"reversed":           true,
		"reversalMovementId": reversalID,
		"reversedMovementId": id,
	})
}

// --- sales ---

// Monetary fields are money (integer cents) in Go and in Postgres; they
// marshal back out as two-decimal dollars, so the JSON contract is unchanged.
type honeySaleItemRow struct {
	SaleID    uuid.UUID `json:"saleId"`
	JarSizeID uuid.UUID `json:"jarSizeId"`
	Quantity  int       `json:"quantity"`
	UnitPrice money     `json:"unitPrice"`
	Label     string    `json:"label"`
}

type honeySaleRow struct {
	ID             uuid.UUID          `json:"id"`
	Date           time.Time          `json:"date"`
	CustomerID     *uuid.UUID         `json:"customerId"`
	HarvestLotID   *uuid.UUID         `json:"harvestLotId"`
	HarvestLotCode *string            `json:"harvestLotCode"`
	CustomerName   *string            `json:"customerName"`
	Location       *string            `json:"location"`
	Channel        string             `json:"channel"`
	PaymentMethod  string             `json:"paymentMethod"`
	TotalAmount    money              `json:"totalAmount"`
	DiscountAmount money              `json:"discountAmount"`
	AmountPaid     money              `json:"amountPaid"`
	Tax            *money             `json:"tax"`
	OrderStatus    string             `json:"orderStatus"`
	OrderNumber    *string            `json:"orderNumber"`
	DueDate        *time.Time         `json:"dueDate"`
	Notes          *string            `json:"notes"`
	CreatedAt      time.Time          `json:"createdAt"`
	UpdatedAt      time.Time          `json:"updatedAt"`
	CancelledAt    *time.Time         `json:"cancelledAt"`
	LineItems      []honeySaleItemRow `json:"lineItems"`
}

func (s *Server) honeyListSales(ctx context.Context) ([]honeySaleRow, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT s.id, s.date, s.customer_id, s.harvest_lot_id, lot.lot_code,
			COALESCE(c.name, s.customer_name),
			s.location, s.channel, s.payment_method, s.total_amount_cents,
			s.discount_amount_cents, s.amount_paid_cents, s.tax_cents,
			s.order_status, s.order_number,
			s.due_date, s.notes, s.created_at, s.updated_at, s.cancelled_at
		FROM honey_sales s
		LEFT JOIN customers c ON c.id=s.customer_id
		LEFT JOIN harvest_lots lot ON lot.id=s.harvest_lot_id
		ORDER BY s.date DESC, s.created_at DESC`)
	if err != nil {
		return nil, err
	}
	sales := make([]honeySaleRow, 0)
	for rows.Next() {
		var sale honeySaleRow
		if err := rows.Scan(&sale.ID, &sale.Date, &sale.CustomerID,
			&sale.HarvestLotID, &sale.HarvestLotCode, &sale.CustomerName,
			&sale.Location, &sale.Channel, &sale.PaymentMethod, &sale.TotalAmount,
			&sale.DiscountAmount, &sale.AmountPaid, &sale.Tax, &sale.OrderStatus,
			&sale.OrderNumber, &sale.DueDate, &sale.Notes, &sale.CreatedAt,
			&sale.UpdatedAt, &sale.CancelledAt); err != nil {
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
		SELECT si.sale_id, si.jar_size_id, si.quantity, si.unit_price_cents, js.label
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

var honeySaleChannels = map[string]bool{
	"farm_stand": true, "farmers_market": true, "wholesale": true,
	"pickup": true, "online": true, "gift": true, "consignment": true, "direct": true,
}

var honeyPaymentMethods = map[string]bool{
	"cash": true, "card": true, "check": true, "venmo": true,
	"paypal": true, "invoice": true, "other": true,
}

var honeyOrderStatuses = map[string]bool{
	"draft": true, "pending": true, "paid": true, "fulfilled": true, "cancelled": true,
}

// UnitPrice arrives in dollars and is stored in cents; money's UnmarshalJSON
// does the rounding, so no float ever reaches the comparison below.
type honeySaleLineInput struct {
	JarSizeID string `json:"jarSizeId"`
	Quantity  int    `json:"quantity"`
	UnitPrice money  `json:"unitPrice"`
}

type honeySaleLine struct {
	JarSizeID uuid.UUID
	Quantity  int
	UnitPrice money
}

// honeySalePriceRequired rejects a $0 paid sale. Gift is the only channel
// that may give jars away; every other channel needs a unit price so a
// missing jar-size default cannot silently understate revenue.
func honeySalePriceRequired(channel string, lines []honeySaleLine) error {
	if channel == "gift" {
		return nil
	}
	for _, line := range lines {
		if line.UnitPrice == 0 {
			return errors.New("unitPrice must be greater than zero unless the channel is gift")
		}
	}
	return nil
}

func normalizeHoneySaleLines(inputs []honeySaleLineInput) ([]honeySaleLine, error) {
	lines := make([]honeySaleLine, 0, len(inputs))
	byJarSize := make(map[uuid.UUID]int, len(inputs))
	for _, input := range inputs {
		if input.JarSizeID == "" || input.Quantity <= 0 {
			continue
		}
		if input.UnitPrice < 0 {
			return nil, errors.New("unitPrice must be non-negative")
		}
		id, err := uuid.Parse(input.JarSizeID)
		if err != nil {
			return nil, errors.New("invalid jarSizeId")
		}
		if index, ok := byJarSize[id]; ok {
			if lines[index].UnitPrice != input.UnitPrice {
				return nil, errors.New("duplicate jarSizeId entries must use the same unitPrice")
			}
			lines[index].Quantity += input.Quantity
			continue
		}
		byJarSize[id] = len(lines)
		lines = append(lines, honeySaleLine{
			JarSizeID: id,
			Quantity:  input.Quantity,
			UnitPrice: input.UnitPrice,
		})
	}
	return lines, nil
}

// POST /honey/sales creates either an immediate sale or an order/invoice.
func (s *Server) honeyRecordSale(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Date                 string               `json:"date"`
		Location             *string              `json:"location"`
		CustomerID           *uuid.UUID           `json:"customerId"`
		HarvestLotID         *uuid.UUID           `json:"harvestLotId"`
		CustomerName         *string              `json:"customerName"`
		Channel              string               `json:"channel"`
		PaymentMethod        string               `json:"paymentMethod"`
		DiscountAmount       money                `json:"discountAmount"`
		AmountPaid           *money               `json:"amountPaid"`
		Tax                  *money               `json:"tax"`
		OrderStatus          string               `json:"orderStatus"`
		OrderNumber          *string              `json:"orderNumber"`
		DueDate              *string              `json:"dueDate"`
		WholesalePriceListID *uuid.UUID           `json:"wholesalePriceListId"`
		Lines                []honeySaleLineInput `json:"lines"`
		Notes                *string              `json:"notes"`
	}
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	lines, err := normalizeHoneySaleLines(req.Lines)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
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
	if req.Channel == "" {
		req.Channel = "direct"
	}
	if req.PaymentMethod == "" {
		req.PaymentMethod = "cash"
	}
	if req.OrderStatus == "" {
		req.OrderStatus = "paid"
	}
	if !honeySaleChannels[req.Channel] || !honeyPaymentMethods[req.PaymentMethod] ||
		!honeyOrderStatuses[req.OrderStatus] || req.DiscountAmount < 0 {
		writeError(w, http.StatusBadRequest, "invalid channel, payment method, order status, or discount")
		return
	}
	var dueDate *time.Time
	if req.DueDate != nil && *req.DueDate != "" {
		v, err := parseDate(*req.DueDate)
		if err != nil {
			writeError(w, http.StatusBadRequest, "invalid dueDate")
			return
		}
		dueDate = &v
	}

	ctx := r.Context()

	tx, err := s.pool.Begin(ctx)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	defer tx.Rollback(ctx)

	// Serialize sales that touch the same jar sizes, then validate availability
	// while holding the locks so this transaction sees sales committed by any
	// checkout that held them immediately before us.
	jarSizeIDs := make([]uuid.UUID, 0, len(lines))
	needed := make(map[uuid.UUID]int, len(lines))
	for _, line := range lines {
		jarSizeIDs = append(jarSizeIDs, line.JarSizeID)
		needed[line.JarSizeID] += line.Quantity
	}
	onHand, labels, unknown, err := honeyLockJarSizes(ctx, tx, jarSizeIDs)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	if unknown {
		writeError(w, http.StatusBadRequest, "invalid jarSizeId")
		return
	}
	if message := honeyCheckJarAvailability(onHand, labels, needed); message != "" {
		writeError(w, http.StatusBadRequest, message)
		return
	}
	if req.HarvestLotID != nil {
		if msg, err := refuseLotSale(ctx, tx, *req.HarvestLotID, date); err != nil {
			writeError(w, http.StatusInternalServerError, "database error")
			return
		} else if msg != "" {
			writeError(w, http.StatusConflict, msg)
			return
		}
	}

	var wholesaleMinimum *money
	if req.WholesalePriceListID != nil {
		if req.Channel != "wholesale" {
			writeError(w, http.StatusBadRequest, "wholesalePriceListId requires the wholesale channel")
			return
		}
		var minimum money
		if err := tx.QueryRow(ctx, `
			SELECT minimum_order_amount_cents FROM wholesale_price_lists
			WHERE id=$1 AND is_active`, *req.WholesalePriceListID).Scan(&minimum); err != nil {
			writeError(w, http.StatusBadRequest, "invalid wholesale price list")
			return
		}
		wholesaleMinimum = &minimum

		priceRows, err := tx.Query(ctx, `
			SELECT jar_size_id, unit_price_cents
			FROM wholesale_price_list_items
			WHERE price_list_id=$1`, *req.WholesalePriceListID)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "database error")
			return
		}
		prices := make(map[uuid.UUID]money)
		for priceRows.Next() {
			var jarSizeID uuid.UUID
			var unitPrice money
			if err := priceRows.Scan(&jarSizeID, &unitPrice); err != nil {
				priceRows.Close()
				writeError(w, http.StatusInternalServerError, "database error")
				return
			}
			prices[jarSizeID] = unitPrice
		}
		priceErr := priceRows.Err()
		priceRows.Close()
		if priceErr != nil {
			writeError(w, http.StatusInternalServerError, "database error")
			return
		}
		for i := range lines {
			unitPrice, ok := prices[lines[i].JarSizeID]
			if !ok {
				writeError(w, http.StatusBadRequest, "wholesale price list does not cover every jar size")
				return
			}
			lines[i].UnitPrice = unitPrice
		}
	}
	if err := honeySalePriceRequired(req.Channel, lines); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}

	// All money arithmetic is exact integer cents: no float sums, no float
	// comparisons, no 1e-13 artifact rejecting a valid payment.
	subtotal := money(0)
	for _, line := range lines {
		subtotal += line.UnitPrice.mulQuantity(line.Quantity)
	}
	if req.DiscountAmount < 0 || req.DiscountAmount > subtotal {
		writeError(w, http.StatusBadRequest, "discount must be between zero and the subtotal")
		return
	}
	totalAmount := subtotal - req.DiscountAmount
	amountPaid := totalAmount
	if req.OrderStatus == "draft" || req.OrderStatus == "pending" {
		amountPaid = 0
	}
	if req.AmountPaid != nil {
		amountPaid = *req.AmountPaid
	}
	if amountPaid < 0 || amountPaid > totalAmount {
		writeError(w, http.StatusBadRequest, "amountPaid must be between zero and the total")
		return
	}
	if req.Tax != nil && *req.Tax < 0 {
		writeError(w, http.StatusBadRequest, "tax must be non-negative")
		return
	}
	if wholesaleMinimum != nil {
		if totalAmount < *wholesaleMinimum {
			writeError(w, http.StatusBadRequest,
				fmt.Sprintf("Wholesale minimum is $%.2f", wholesaleMinimum.Dollars()))
			return
		}
	}

	saleID := uuid.New()
	orderNumber := honeyTrimPtr(req.OrderNumber)
	if orderNumber == nil {
		v := "BT-" + strings.ToUpper(strings.ReplaceAll(saleID.String()[:8], "-", ""))
		orderNumber = &v
	}
	actor := actorID(r)
	if _, err := tx.Exec(ctx, `
		INSERT INTO honey_sales
			(id, date, customer_id, harvest_lot_id, customer_name, location, channel, payment_method,
			 total_amount_cents, discount_amount_cents, amount_paid_cents, tax_cents,
			 order_status, order_number, due_date, wholesale_price_list_id, notes, created_by)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
		saleID, date, req.CustomerID, req.HarvestLotID, honeyTrimPtr(req.CustomerName),
		honeyTrimPtr(req.Location), req.Channel, req.PaymentMethod, totalAmount,
		req.DiscountAmount, amountPaid, req.Tax, req.OrderStatus, orderNumber, dueDate,
		req.WholesalePriceListID, honeyTrimPtr(req.Notes), actor); err != nil {
		writeDBError(w, err, "order number already exists",
			"invalid customer, harvest lot, or wholesale price list")
		return
	}
	for _, line := range lines {
		if _, err := tx.Exec(ctx, `
			INSERT INTO honey_sale_items (sale_id, jar_size_id, quantity, unit_price_cents, created_by)
			VALUES ($1, $2, $3, $4, $5)`,
			saleID, line.JarSizeID, line.Quantity, line.UnitPrice, actor); err != nil {
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
	writeJSON(w, http.StatusCreated, map[string]any{
		"success": true, "id": saleID, "orderNumber": orderNumber,
		"subtotal": subtotal, "discountAmount": req.DiscountAmount,
		"totalAmount": totalAmount, "amountPaid": amountPaid,
		"balanceDue": totalAmount - amountPaid,
	})
}

// PATCH /honey/sales/{id} advances an invoice/order through payment and
// fulfillment without recreating its line items or disturbing inventory.
//
// 'cancelled' is now reachable here. It used to be accepted at creation but
// rejected on update, which left destroying the row as the only way to void a
// sale. Cancelling releases the sale's jars because every inventory aggregate
// excludes cancelled sales.
func (s *Server) honeyUpdateSale(w http.ResponseWriter, r *http.Request) {
	id, err := uuidParam(r, "id")
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	var req struct {
		OrderStatus        string  `json:"orderStatus"`
		AmountPaid         *money  `json:"amountPaid"`
		PaymentMethod      *string `json:"paymentMethod"`
		DueDate            *string `json:"dueDate"`
		Tax                *money  `json:"tax"`
		CancellationReason *string `json:"cancellationReason"`
	}
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if !honeyOrderStatuses[req.OrderStatus] {
		writeError(w, http.StatusBadRequest, "invalid order status")
		return
	}
	if req.PaymentMethod != nil && !honeyPaymentMethods[*req.PaymentMethod] {
		writeError(w, http.StatusBadRequest, "invalid payment method")
		return
	}
	if req.Tax != nil && *req.Tax < 0 {
		writeError(w, http.StatusBadRequest, "tax must be non-negative")
		return
	}
	var dueDate *time.Time
	if req.DueDate != nil && *req.DueDate != "" {
		value, err := parseDate(*req.DueDate)
		if err != nil {
			writeError(w, http.StatusBadRequest, "invalid dueDate")
			return
		}
		dueDate = &value
	}

	if req.OrderStatus == "cancelled" {
		s.honeyCancelSaleByID(w, r, id, honeyTrimPtr(req.CancellationReason))
		return
	}

	tx, err := s.pool.Begin(r.Context())
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	defer tx.Rollback(r.Context())
	var totalAmount, currentPaid money
	var currentPayment string
	if err := tx.QueryRow(r.Context(), `
		SELECT total_amount_cents, amount_paid_cents, payment_method
		FROM honey_sales WHERE id=$1 AND order_status <> 'cancelled'
		FOR UPDATE`, id).Scan(&totalAmount, &currentPaid, &currentPayment); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			writeError(w, http.StatusNotFound, "sale not found")
			return
		}
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	amountPaid := currentPaid
	if req.AmountPaid != nil {
		amountPaid = *req.AmountPaid
	} else if req.OrderStatus == "paid" || req.OrderStatus == "fulfilled" {
		amountPaid = totalAmount
	}
	if amountPaid < 0 || amountPaid > totalAmount {
		writeError(w, http.StatusBadRequest, "amountPaid must be between zero and the total")
		return
	}
	paymentMethod := currentPayment
	if req.PaymentMethod != nil {
		paymentMethod = *req.PaymentMethod
	}
	if _, err := tx.Exec(r.Context(), `
		UPDATE honey_sales
		SET order_status=$1, amount_paid_cents=$2, payment_method=$3,
			due_date=CASE WHEN $4::boolean THEN $5 ELSE due_date END,
			tax_cents=COALESCE($6, tax_cents)
		WHERE id=$7`,
		req.OrderStatus, amountPaid, paymentMethod, req.DueDate != nil, dueDate,
		req.Tax, id); err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	if err := tx.Commit(r.Context()); err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"success": true, "orderStatus": req.OrderStatus,
		"amountPaid": amountPaid, "balanceDue": totalAmount - amountPaid,
	})
}

// DELETE /honey/sales/{id} CANCELS the sale. The route, the method, and the
// {"success": true} response are unchanged, but the row survives: order_status
// becomes 'cancelled' and the actor, timestamp, and reason are recorded.
//
// Cancelling restores the jars. Every inventory and revenue aggregate filters
// order_status <> 'cancelled', so the sale's line items stop consuming stock
// the moment it is cancelled — writing reversing movements as well would
// double-count the jars back into inventory.
//
// Optional body: {"reason": "..."}.
func (s *Server) honeyCancelSale(w http.ResponseWriter, r *http.Request) {
	id, err := uuidParam(r, "id")
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	var req struct {
		Reason *string `json:"reason"`
	}
	_ = decodeJSON(r, &req)
	s.honeyCancelSaleByID(w, r, id, honeyTrimPtr(req.Reason))
}

func (s *Server) honeyCancelSaleByID(
	w http.ResponseWriter,
	r *http.Request,
	id uuid.UUID,
	reason *string,
) {
	// Cancelling twice is not an error: the endpoint is idempotent so an
	// offline queue replaying a cancel does not surface a spurious failure.
	ctx := r.Context()
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	defer tx.Rollback(ctx)
	var totalAmount, amountPaid money
	err = tx.QueryRow(ctx, `
		UPDATE honey_sales
		SET order_status='cancelled',
			cancelled_at=COALESCE(cancelled_at, now()),
			cancelled_by=COALESCE(cancelled_by, $2),
			cancellation_reason=COALESCE($3, cancellation_reason)
		WHERE id=$1
		RETURNING total_amount_cents, amount_paid_cents`,
		id, actorID(r), reason).Scan(&totalAmount, &amountPaid)
	if errors.Is(err, pgx.ErrNoRows) {
		writeError(w, http.StatusNotFound, "sale not found")
		return
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	// The jars are physically back on the shelf, so their serials must stop
	// resolving as sold — a cancelled sale that kept its serial links made
	// the serial lookup disagree with inventory.
	if _, err := tx.Exec(ctx, `
		UPDATE jar_serials SET sale_id=NULL, sold_at=NULL, linked_by=NULL
		WHERE sale_id=$1`, id); err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	if err := tx.Commit(ctx); err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"success": true, "cancelled": true, "orderStatus": "cancelled", "id": id,
		"amountPaid": amountPaid, "balanceDue": totalAmount - amountPaid,
	})
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
	DefaultPrice *money    `json:"defaultPrice"`
	IsActive     bool      `json:"isActive"`
	Jarred       int       `json:"jarred"`
	Sold         int       `json:"sold"`
	GivenAway    int       `json:"givenAway"`
	Adjusted     int       `json:"adjusted"`
	OnHand       int       `json:"onHand"`
}

// honeyJarInventory derives jar counts from the ledger:
// onHand = jarred + adjusted − sold − givenAway.
//
// Reversing entries carry negative quantities, so a reversed movement nets to
// zero here without any special case.
func (s *Server) honeyJarInventory(ctx context.Context) ([]honeyInventoryRow, error) {
	return honeyJarInventoryWithQuerier(ctx, s.pool)
}

func honeyJarInventoryWithQuerier(ctx context.Context, queryer inspectionQuerier) ([]honeyInventoryRow, error) {
	// Inactive sizes are listed only while they still hold stock. Filtering on
	// is_active alone turned deactivating a size into an invisible inventory
	// write-off: the jars vanished from on-hand, dashboards, valuation, and
	// low-stock alerts while their sales kept counting as revenue. Deactivation
	// now blocks on remaining stock (see routes_jar_sizes.go); this clause is
	// the safety net for rows deactivated before that rule existed.
	rows, err := queryer.Query(ctx, `
		SELECT js.id, js.label, js.honey_oz, js.default_price_cents, js.is_active,
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
			SELECT si.jar_size_id, SUM(si.quantity) AS sold
			FROM honey_sale_items si
			JOIN honey_sales s ON s.id=si.sale_id
			WHERE s.order_status <> 'cancelled'
			GROUP BY si.jar_size_id
		) si ON si.jar_size_id = js.id
		WHERE js.is_active
		   OR COALESCE(m.jarred,0) + COALESCE(m.adjusted,0)
		      - COALESCE(si.sold,0) - COALESCE(m.given_away,0) <> 0
		ORDER BY js.sort_order, js.label`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]honeyInventoryRow, 0)
	for rows.Next() {
		var row honeyInventoryRow
		if err := rows.Scan(&row.JarSizeID, &row.Label, &row.HoneyOz, &row.DefaultPrice,
			&row.IsActive, &row.Jarred, &row.GivenAway, &row.Adjusted, &row.Sold); err != nil {
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

	// Bulk honey comes from the one shared formula, so this endpoint and
	// /honey/production-plan can never disagree.
	bulk, err := honeyBulkOnHand(ctx, s.pool)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}

	// Two revenue definitions, both reported and both named. The old
	// totalRevenue included unpaid draft/pending orders while market-day
	// reconciliation counted only cash actually taken, so the two surfaces
	// disagreed by design. totalRevenue keeps its former meaning (invoiced)
	// for compatibility.
	var invoicedRevenue, collectedRevenue money
	var jarsSold int
	err = s.pool.QueryRow(ctx, `SELECT
		(SELECT COALESCE(SUM(total_amount_cents), 0) FROM honey_sales WHERE order_status <> 'cancelled'),
		(SELECT COALESCE(SUM(amount_paid_cents), 0) FROM honey_sales WHERE order_status <> 'cancelled'),
		(SELECT COALESCE(SUM(si.quantity), 0) FROM honey_sale_items si
		 JOIN honey_sales s ON s.id=si.sale_id WHERE s.order_status <> 'cancelled')`).
		Scan(&invoicedRevenue, &collectedRevenue, &jarsSold)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}

	inventory, err := s.honeyJarInventory(ctx)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"totalHarvestedLbs": bulk.TotalHarvestedLbs,
		"jarredLbs":         bulk.JarredLbs,
		"bulkUsedLbs":       bulk.BulkUsedLbs,
		"lossLbs":           bulk.LossLbs,
		"bulkOnHandLbs":     bulk.BulkOnHandLbs,
		// Invoiced: every non-cancelled order, paid or not.
		"invoicedRevenue": invoicedRevenue,
		// Collected: money actually received.
		"collectedRevenue": collectedRevenue,
		"unpaidRevenue":    invoicedRevenue - collectedRevenue,
		// Deprecated alias for invoicedRevenue; kept so existing callers work.
		"totalRevenue": invoicedRevenue,
		"jarsSold":     jarsSold,
		"inventory":    inventory,
	})
}

type honeyTimelineEntry struct {
	ID          uuid.UUID  `json:"id"`
	Date        time.Time  `json:"date"`
	Type        string     `json:"type"`
	Description string     `json:"description"`
	AmountLbs   *float64   `json:"amountLbs"`
	Quantity    *int       `json:"quantity"`
	TotalAmount *money     `json:"totalAmount"`
	Notes       *string    `json:"notes"`
	IsReversal  bool       `json:"isReversal"`
	ReversesID  *uuid.UUID `json:"reversesMovementId"`
	Cancelled   bool       `json:"cancelled"`
}

const (
	honeyTimelineDefaultLimit = 50
	honeyTimelineMaxLimit     = 200
)

// parseBoundedLimit reads ?limit= with a default and a hard max. Invalid or
// non-positive values keep the default; values above max are clamped.
func parseBoundedLimit(raw string, defaultLimit, maxLimit int) int {
	if raw == "" {
		return defaultLimit
	}
	n, err := strconv.Atoi(raw)
	if err != nil || n <= 0 {
		return defaultLimit
	}
	if n > maxLimit {
		return maxLimit
	}
	return n
}

// GET /honey/timeline?limit= — movements + sales merged, newest first.
func (s *Server) honeyTimelineHandler(w http.ResponseWriter, r *http.Request) {
	limit := parseBoundedLimit(r.URL.Query().Get("limit"), honeyTimelineDefaultLimit, honeyTimelineMaxLimit)
	ctx := r.Context()

	rows, err := s.pool.Query(ctx, `
		SELECT m.id, m.date, m.kind, m.amount_lbs, m.quantity, m.reason, m.notes,
			js.label, m.reverses_movement_id
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
			reversesID          *uuid.UUID
		)
		if err := rows.Scan(&id, &date, &kind, &amountLbs, &quantity, &reason, &notes,
			&size, &reversesID); err != nil {
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
		if reversesID != nil {
			description = "Reversed: " + description
		}
		entries = append(entries, honeyTimelineEntry{
			ID: id, Date: date, Type: kind, Description: description,
			AmountLbs: amountLbs, Quantity: quantity, Notes: notes,
			IsReversal: reversesID != nil, ReversesID: reversesID,
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
		cancelled := sale.OrderStatus == "cancelled"
		if cancelled {
			description = "Cancelled: " + description
		}
		qty := jarCount
		total := sale.TotalAmount
		entries = append(entries, honeyTimelineEntry{
			ID: sale.ID, Date: sale.Date, Type: "sale", Description: description,
			Quantity: &qty, TotalAmount: &total, Notes: sale.Notes, Cancelled: cancelled,
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
