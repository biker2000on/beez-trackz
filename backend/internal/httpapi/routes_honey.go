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

	"github.com/biker2000on/beez-trackz/backend/internal/app"
	"github.com/biker2000on/beez-trackz/backend/internal/app/production"
	"github.com/biker2000on/beez-trackz/backend/internal/app/sales"
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

	// Per-lot bulk balances and the varietal rollup over them.
	admin.Get("/honey/lot-balances", s.honeyLotBalances)
	admin.Get("/honey/varietals", s.honeyListVarietals)
	admin.Post("/honey/varietals", s.honeyCreateVarietal)
	admin.Patch("/honey/varietals/{id}", s.honeyUpdateVarietal)

	admin.Post("/honey/jarring", s.honeyRecordJarring)
	admin.Post("/honey/bulk-movements", s.honeyRecordBulkMovement)
	admin.Post("/honey/give-away", s.honeyRecordGiveAway)
	admin.Post("/honey/jar-adjustments", s.honeyAdjustJarCounts)
	// Reverses rather than deletes; see honeyReverseMovement.
	admin.Delete("/honey/movements/{id}", s.honeyReverseMovement)

	// /sales is the canonical path; /honey/sales stays so queued offline
	// mutations and older clients keep working.
	for _, prefix := range []string{"/sales", "/honey/sales"} {
		admin.Get(prefix, s.honeyListSalesHandler)
		admin.Post(prefix, s.honeyRecordSale)
		admin.Patch(prefix+"/{id}", s.honeyUpdateSale)
		admin.Delete(prefix+"/{id}", s.honeyCancelSale)
	}
	admin.Get("/sales/locations", s.honeySaleLocations)
	admin.Get("/honey/sale-locations", s.honeySaleLocations)
	admin.Get("/hives/{id}/sale-offer", s.hiveSaleOffer)

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
	if msg := refuseFutureDate(date, "date"); msg != "" {
		writeError(w, http.StatusUnprocessableEntity, msg)
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
		Date string `json:"date"`
		// Which harvest lot the honey came from. Supplying it turns each jar
		// line into a real bottling run, so provenance survives the everyday
		// jarring flow instead of only the lot page.
		LotID      *string           `json:"lotId"`
		Lines      []honeyJarLineReq `json:"lines"`
		LossLbs    *float64          `json:"lossLbs"`
		LossReason *string           `json:"lossReason"`
		Notes      *string           `json:"notes"`
	}
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	// Bulk honey is tracked per lot, so a draw has to say which honey it took.
	// Only history is unattributed; nothing new may be.
	v := honeyTrimPtr(req.LotID)
	if v == nil {
		writeError(w, http.StatusBadRequest,
			"Choose the honey lot these jars were filled from")
		return
	}
	lotID, err := uuid.Parse(*v)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid lotId")
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
	// The withdrawal window is evaluated at this date, so a forward-dated run
	// would step past the window and bottle tainted honey.
	if msg := refuseFutureDate(date, "date"); msg != "" {
		writeError(w, http.StatusUnprocessableEntity, msg)
		return
	}
	notes := honeyTrimPtr(req.Notes)

	commands := production.New()
	var warnings []string
	err = s.runInUnitOfWork(r, func(ctx context.Context, uow *app.UnitOfWork) error {
		// Honey per jar size, read inside the transaction: a read on the pool
		// before it began could see a jar-size edit the transaction then would
		// not, deriving pounds from stale ounces.
		ozBySize := make(map[uuid.UUID]*float64)
		packagingBySize := make(map[uuid.UUID]uuid.UUID)
		if len(lines) > 0 {
			ids := make([]uuid.UUID, 0, len(lines))
			for _, line := range lines {
				ids = append(ids, line.JarSizeID)
			}
			rows, err := uow.Query(ctx,
				`SELECT id, honey_oz, packaging_type_id FROM jar_sizes WHERE id = ANY($1)`, ids)
			if err != nil {
				return err
			}
			for rows.Next() {
				var id uuid.UUID
				var oz *float64
				var packagingTypeID *uuid.UUID
				if err := rows.Scan(&id, &oz, &packagingTypeID); err != nil {
					rows.Close()
					return err
				}
				ozBySize[id] = oz
				if packagingTypeID != nil {
					packagingBySize[id] = *packagingTypeID
				}
			}
			rows.Close()
			if err := rows.Err(); err != nil {
				return err
			}
		}

		// Class 2 of honeyLockOrder: the lot row, then the bulk advisory lock
		// (class 3), then — inside Record — the ledger's tuple locks. Same
		// order bottlingRunCreate uses, so the two cannot deadlock.
		lotCode, lotOnHandLbs, err := honeyLockLot(ctx, uow, lotID)
		if errors.Is(err, pgx.ErrNoRows) {
			return equipBadRequest("invalid harvest lot")
		}
		if err != nil {
			return err
		}
		if msg, err := refuseLotBottling(ctx, uow, lotID, lotCode, date); err != nil {
			return err
		} else if msg != "" {
			return equipFail(http.StatusConflict, "%s", msg)
		}
		bulk, err := honeyLockBulk(ctx, uow)
		if err != nil {
			return err
		}

		requestedLbs := 0.0
		amountByLine := make([]float64, len(lines))
		for i, line := range lines {
			// A jar size with no honey_oz attributes no pounds; that is
			// recorded as an explicit zero so the ledger never carries an
			// undefined weight.
			if oz := ozBySize[line.JarSizeID]; oz != nil {
				amountByLine[i] = *oz * float64(line.Quantity) / 16
			}
			requestedLbs += amountByLine[i]
		}
		if hasLoss {
			requestedLbs += *req.LossLbs
		}
		// The ledger refuses an overdraw on its own; these two checks run
		// first so the operator sees the sentence they have always seen
		// instead of a tuple identity.
		if message := honeyBulkShortfall(requestedLbs, bulk.BulkOnHandLbs); message != "" {
			return equipBadRequest("%s", message)
		}
		if message := honeyLotShortfall(requestedLbs, lotOnHandLbs, lotCode); message != "" {
			return equipBadRequest("%s", message)
		}

		actor := actorID(r)
		for i, line := range lines {
			// Each jar line becomes its own bottling run, which is what
			// carries the lot forward to serials and sale traceability.
			runID := uuid.New()
			if _, err := uow.Exec(ctx, `
				INSERT INTO bottling_runs
					(id, lot_id, bottled_date, jar_size_id, quantity, honey_lbs, notes, created_by)
				VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
				runID, lotID, date, line.JarSizeID, line.Quantity, amountByLine[i],
				notes, actor); err != nil {
				return err
			}
			packaging := map[uuid.UUID]int{}
			if typeID, ok := packagingBySize[line.JarSizeID]; ok {
				packaging[typeID] = line.Quantity
			}
			result, err := commands.RecordBottling(ctx, uow, production.BottlingInput{
				RunID: runID, HarvestLotID: lotID, JarSizeID: line.JarSizeID,
				Quantity: line.Quantity, HoneyLbs: amountByLine[i], Date: date,
				PackagingTypes: packaging, Notes: notes,
			})
			if err != nil {
				return err
			}
			warnings = append(warnings, result.PackagingWarnings...)
		}
		if hasLoss {
			if _, err := commands.RecordBulkDraw(ctx, uow, production.BulkDrawInput{
				HarvestLotID: lotID, AmountLbs: *req.LossLbs,
				Reason: production.ReasonLoss, Date: date, Notes: notes,
			}); err != nil {
				return err
			}
		}
		return nil
	})
	if err != nil {
		writeCommandError(w, err)
		return
	}
	if warnings == nil {
		warnings = []string{}
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"success": true,
		// Non-blocking: the jars were filled either way, but the operator is
		// told which empties are now short.
		"packagingWarnings": warnings,
	})
}

// POST /honey/bulk-movements {date, kind, amountLbs, reason?, notes?}
func (s *Server) honeyRecordBulkMovement(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Date      string   `json:"date"`
		Kind      string   `json:"kind"`
		LotID     *string  `json:"lotId"`
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
	// Bulk honey is tracked per lot; a draw has to say which honey it took.
	rawLot := honeyTrimPtr(req.LotID)
	if rawLot == nil {
		writeError(w, http.StatusBadRequest, "Choose the honey lot this came out of")
		return
	}
	lotID, err := uuid.Parse(*rawLot)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid lotId")
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
	// bulk_use is a registry reason ('feeding' when the operator says so,
	// 'none' otherwise); loss is its own reason so reports can group on it.
	reason := production.ReasonNone
	if req.Kind == "loss" {
		reason = production.ReasonLoss
	}

	commands := production.New()
	err = s.runInUnitOfWork(r, func(ctx context.Context, uow *app.UnitOfWork) error {
		// Lot row (class 2), then the bulk advisory lock (class 3).
		lotCode, lotOnHandLbs, err := honeyLockLot(ctx, uow, lotID)
		if errors.Is(err, pgx.ErrNoRows) {
			return equipBadRequest("invalid harvest lot")
		}
		if err != nil {
			return err
		}
		bulk, err := honeyLockBulk(ctx, uow)
		if err != nil {
			return err
		}
		if message := honeyBulkShortfall(*req.AmountLbs, bulk.BulkOnHandLbs); message != "" {
			return equipBadRequest("%s", message)
		}
		if message := honeyLotShortfall(*req.AmountLbs, lotOnHandLbs, lotCode); message != "" {
			return equipBadRequest("%s", message)
		}
		notes := honeyTrimPtr(req.Notes)
		if text := honeyTrimPtr(req.Reason); text != nil && notes == nil {
			notes = text
		}
		_, err = commands.RecordBulkDraw(ctx, uow, production.BulkDrawInput{
			HarvestLotID: lotID, AmountLbs: *req.AmountLbs,
			Reason: reason, Date: date, Notes: notes,
		})
		return err
	})
	if err != nil {
		writeCommandError(w, err)
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

	commands := production.New()
	err = s.runInUnitOfWork(r, func(ctx context.Context, uow *app.UnitOfWork) error {
		// Giving away jars you do not have is a stock error, not a data-entry
		// preference. The availability read is the ledger's; the refusal is
		// phrased the way the operator has always seen it.
		jarSizeIDs := make([]uuid.UUID, 0, len(lines))
		needed := make(map[uuid.UUID]int, len(lines))
		for _, line := range lines {
			jarSizeIDs = append(jarSizeIDs, line.JarSizeID)
			needed[line.JarSizeID] += line.Quantity
		}
		onHand, labels, unknown, err := honeyLockJarSizes(ctx, uow, jarSizeIDs)
		if err != nil {
			return err
		}
		if unknown {
			return equipBadRequest("invalid jarSizeId")
		}
		if message := honeyCheckJarAvailability(onHand, labels, needed); message != "" {
			return equipBadRequest("%s", message)
		}
		jarLines := make([]production.JarLine, 0, len(lines))
		for _, line := range lines {
			jarLines = append(jarLines, production.JarLine{
				JarSizeID: line.JarSizeID, Quantity: line.Quantity,
			})
		}
		notes := honeyTrimPtr(req.Notes)
		if text := honeyTrimPtr(req.Reason); text != nil && notes == nil {
			notes = text
		}
		_, err = commands.RecordGiveAway(ctx, uow, jarLines, date, notes)
		return err
	})
	if err != nil {
		writeCommandError(w, err)
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
	lines := make([]production.JarLine, 0, len(req.Lines))
	for _, l := range req.Lines {
		if l.JarSizeID == "" || l.Delta == 0 {
			continue
		}
		id, err := uuid.Parse(l.JarSizeID)
		if err != nil {
			writeError(w, http.StatusBadRequest, "invalid jarSizeId")
			return
		}
		lines = append(lines, production.JarLine{JarSizeID: id, Quantity: l.Delta})
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
	notes := honeyTrimPtr(req.Reason)
	if notes == nil {
		reason := "manual correction"
		notes = &reason
	}

	commands := production.New()
	err = s.runInUnitOfWork(r, func(ctx context.Context, uow *app.UnitOfWork) error {
		_, err := commands.AdjustJarCounts(ctx, uow, lines, date, notes)
		return err
	})
	if err != nil {
		writeCommandError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"success": true})
}

// DELETE /honey/movements/{id} records a REVERSING ENTRY against an inventory
// operation. The ledger is append-only, so undoing a movement means writing
// its negation, linked to the original, rather than destroying the evidence
// that it happened.
//
// The {id} is an inventory_operations id since the ledger landed: the
// honey_movements table it used to name is being retired (spec 8.1, R4). The
// endpoint and its {"success": true} response are otherwise unchanged.
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

	commands := production.New()
	var reversalID uuid.UUID
	err = s.runInUnitOfWork(r, func(ctx context.Context, uow *app.UnitOfWork) error {
		var (
			sourceType string
			sourceID   uuid.UUID
			reverses   *uuid.UUID
		)
		err := uow.QueryRow(ctx, `
			SELECT source_type, source_id, reverses_operation_id
			FROM inventory_operations WHERE id=$1`, id).
			Scan(&sourceType, &sourceID, &reverses)
		if errors.Is(err, pgx.ErrNoRows) {
			return equipFail(http.StatusNotFound, "movement not found")
		}
		if err != nil {
			return err
		}
		if reverses != nil {
			return equipBadRequest("a reversing entry cannot itself be reversed")
		}
		// A run-linked or batch-linked operation cannot be reversed on its
		// own: the bottling run, its serials, and the batch's output would all
		// survive the reversal and permanently disagree with the ledger.
		switch sourceType {
		case "bottling_run":
			return equipFail(http.StatusConflict,
				"this movement belongs to a bottling run; void the bottling run instead")
		case "product_batch":
			return equipFail(http.StatusConflict,
				"this movement belongs to a product batch and cannot be reversed on its own")
		case "sale", "consignment_settlement":
			return equipFail(http.StatusConflict,
				"this movement belongs to a sale or settlement; cancel that instead")
		}
		var alreadyReversed bool
		if err := uow.QueryRow(ctx,
			`SELECT EXISTS(SELECT 1 FROM inventory_operations WHERE reverses_operation_id=$1)`, id).
			Scan(&alreadyReversed); err != nil {
			return err
		}
		if alreadyReversed {
			return equipFail(http.StatusConflict, "movement has already been reversed")
		}
		recorded, err := commands.Reverse(ctx, uow, id, id.String()+":undo", production.ReasonNone)
		if err != nil {
			return err
		}
		reversalID = recorded.Operation.ID
		return nil
	})
	if err != nil {
		writeCommandError(w, err)
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
	SaleID    uuid.UUID  `json:"saleId"`
	Kind      string     `json:"kind"`
	JarSizeID *uuid.UUID `json:"jarSizeId"`
	HiveID    *uuid.UUID `json:"hiveId"`
	// ItemID replaces equipmentStockId: equipment_stock dissolves into the
	// ledger's items (review OV2), and an item is what a sale line consumes.
	ItemID         *uuid.UUID `json:"itemId"`
	ProductID      *uuid.UUID `json:"productId"`
	Quantity       int        `json:"quantity"`
	UnitPrice      money      `json:"unitPrice"`
	CostBasisCents *int64     `json:"costBasisCents"`
	Label          string     `json:"label"`
	// Provenance of a jar line: the run that filled it and the lot that run
	// drew from. Both nil on non-jar lines and on sales recorded before 00038.
	BottlingRunID *uuid.UUID `json:"bottlingRunId"`
	LotID         *uuid.UUID `json:"lotId"`
	LotCode       *string    `json:"lotCode"`
}

type honeySaleRow struct {
	ID              uuid.UUID  `json:"id"`
	Date            time.Time  `json:"date"`
	CustomerID      *uuid.UUID `json:"customerId"`
	HarvestLotID    *uuid.UUID `json:"harvestLotId"`
	HarvestLotCode  *string    `json:"harvestLotCode"`
	CustomerName    *string    `json:"customerName"`
	Location        *string    `json:"location"`
	StockLocationID *uuid.UUID `json:"stockLocationId"`
	Channel         string     `json:"channel"`
	PaymentMethod   string     `json:"paymentMethod"`
	TotalAmount     money      `json:"totalAmount"`
	DiscountAmount  money      `json:"discountAmount"`
	AmountPaid      money      `json:"amountPaid"`
	Tax             *money     `json:"tax"`
	OrderStatus     string     `json:"orderStatus"`
	OrderNumber     *string    `json:"orderNumber"`
	DueDate         *time.Time `json:"dueDate"`
	Notes           *string    `json:"notes"`
	CreatedAt       time.Time  `json:"createdAt"`
	UpdatedAt       time.Time  `json:"updatedAt"`
	CancelledAt     *time.Time `json:"cancelledAt"`
	// PhysicalAppliedAt is set once the colony/feeder/equipment effects of
	// the sale have been applied (paid/fulfilled); nil for open drafts.
	PhysicalAppliedAt *time.Time         `json:"physicalAppliedAt"`
	LineItems         []honeySaleItemRow `json:"lineItems"`
}

func (s *Server) honeyListSales(ctx context.Context) ([]honeySaleRow, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT s.id, s.date, s.customer_id, s.harvest_lot_id, lot.lot_code,
			COALESCE(c.name, s.customer_name),
			s.location, s.stock_location_id, s.channel, s.payment_method, s.total_amount_cents,
			s.discount_amount_cents, s.amount_paid_cents, s.tax_cents,
			s.order_status, s.order_number,
			s.due_date, s.notes, s.created_at, s.updated_at, s.cancelled_at,
			s.physical_applied_at
		FROM sales s
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
			&sale.Location, &sale.StockLocationID, &sale.Channel, &sale.PaymentMethod,
			&sale.TotalAmount, &sale.DiscountAmount, &sale.AmountPaid, &sale.Tax,
			&sale.OrderStatus, &sale.OrderNumber, &sale.DueDate, &sale.Notes,
			&sale.CreatedAt, &sale.UpdatedAt, &sale.CancelledAt, &sale.PhysicalAppliedAt); err != nil {
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
		SELECT si.sale_id, si.kind, si.jar_size_id, si.hive_id, si.item_id,
		       si.product_id, si.quantity, si.unit_price_cents, si.cost_basis_cents,
		       COALESCE(js.label,
		         CASE WHEN si.kind='colony' THEN h.position_label || ' · ' || a.name END,
		         et.name,
		         NULLIF(CONCAT_WS(' · ', pc.name, pc.size_label), ''),
		         si.kind),
		       si.bottling_run_id, run.lot_id, runlot.lot_code
		FROM sale_items si
		LEFT JOIN jar_sizes js ON js.id = si.jar_size_id
		LEFT JOIN hives h ON h.id = si.hive_id
		LEFT JOIN apiaries a ON a.id = h.apiary_id
		LEFT JOIN equipment_types et ON et.item_id = si.item_id
		LEFT JOIN product_catalog pc ON pc.id = si.product_id
		LEFT JOIN bottling_runs run ON run.id = si.bottling_run_id
		LEFT JOIN harvest_lots runlot ON runlot.id = run.lot_id`)
	if err != nil {
		return nil, err
	}
	defer itemRows.Close()
	itemsBySale := make(map[uuid.UUID][]honeySaleItemRow)
	for itemRows.Next() {
		var item honeySaleItemRow
		if err := itemRows.Scan(&item.SaleID, &item.Kind, &item.JarSizeID, &item.HiveID,
			&item.ItemID, &item.ProductID, &item.Quantity, &item.UnitPrice,
			&item.CostBasisCents, &item.Label,
			&item.BottlingRunID, &item.LotID, &item.LotCode); err != nil {
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

// saleStatusAppliesPhysical reports whether a sale in this status has taken
// its colony, feeders, and equipment (hive marked sold, feeders closed, stock
// disposed). Drafts and pending orders have not.
func saleStatusAppliesPhysical(status string) bool {
	return status == "paid" || status == "fulfilled"
}

// UnitPrice arrives in dollars and is stored in cents; money's UnmarshalJSON
// does the rounding, so no float ever reaches the comparison below.
type honeySaleLineInput struct {
	Kind      string `json:"kind"`
	JarSizeID string `json:"jarSizeId"`
	HiveID    string `json:"hiveId"`
	// ItemID is the inventory item an equipment line consumes (review OV2).
	ItemID string `json:"itemId"`
	// EquipmentStockID is the pre-ledger identity. It is still accepted while
	// equipment_stock exists in Phase A and is resolved to the type's item;
	// it is never written to sale_items any more.
	EquipmentStockID string `json:"equipmentStockId"`
	ProductID        string `json:"productId"`
	Quantity         int    `json:"quantity"`
	UnitPrice        money  `json:"unitPrice"`
	// BottlingRunID traces a jar line back to the run that filled it, and
	// through the run to a harvest lot. Optional: pre-00038 sales and clients
	// that do not track provenance keep working.
	BottlingRunID string `json:"bottlingRunId"`
}

type honeySaleLine struct {
	Kind      string
	JarSizeID uuid.UUID
	HiveID    uuid.UUID
	ItemID    uuid.UUID
	// EquipmentStockID is written alongside ItemID only because migration
	// 00020's sale_items_target_check still demands it for kind='equipment'.
	// Nothing reads it any more; it goes when that CHECK is relaxed to accept
	// item_id instead.
	EquipmentStockID uuid.UUID
	ProductID        uuid.UUID
	Quantity         int
	UnitPrice        money
	// BottlingRunID is uuid.Nil when the jar line names no run.
	BottlingRunID uuid.UUID
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
	// Jar lines merge per (size, bottling run): two lines of the same size off
	// two different runs are two different lots and must stay separate rows,
	// but a client that repeats the same size and run still collapses.
	type jarKey struct{ size, run uuid.UUID }
	byJarSize := make(map[jarKey]int, len(inputs))
	byHive := make(map[uuid.UUID]int, len(inputs))
	byStock := make(map[uuid.UUID]int, len(inputs))
	byProduct := make(map[uuid.UUID]int, len(inputs))
	for _, input := range inputs {
		kind := strings.TrimSpace(input.Kind)
		if kind == "" {
			if input.JarSizeID != "" {
				kind = saleKindJar
			} else if input.HiveID != "" {
				kind = saleKindColony
			} else if input.EquipmentStockID != "" || input.ItemID != "" {
				kind = saleKindEquipment
			} else if input.ProductID != "" {
				// Catalog kind is stored on the SKU; recordSale fills it
				// after locking the product row.
				kind = "product"
			} else {
				continue
			}
		}
		if kind != saleKindJar && kind != saleKindColony && kind != saleKindEquipment &&
			!saleKindIsProduct(kind) && kind != "product" {
			return nil, errors.New("kind must be jar, colony, equipment, or a catalog product")
		}
		if input.Quantity <= 0 {
			continue
		}
		if input.UnitPrice < 0 {
			return nil, errors.New("unitPrice must be non-negative")
		}
		if kind != saleKindJar && strings.TrimSpace(input.BottlingRunID) != "" {
			return nil, errors.New("bottlingRunId is only valid on jar lines")
		}
		switch kind {
		case saleKindJar:
			if input.JarSizeID == "" {
				return nil, errors.New("jar lines require jarSizeId")
			}
			id, err := uuid.Parse(input.JarSizeID)
			if err != nil {
				return nil, errors.New("invalid jarSizeId")
			}
			var runID uuid.UUID
			if trimmed := strings.TrimSpace(input.BottlingRunID); trimmed != "" {
				runID, err = uuid.Parse(trimmed)
				if err != nil {
					return nil, errors.New("invalid bottlingRunId")
				}
			}
			key := jarKey{size: id, run: runID}
			if index, ok := byJarSize[key]; ok {
				if lines[index].UnitPrice != input.UnitPrice {
					return nil, errors.New("duplicate jarSizeId entries must use the same unitPrice")
				}
				lines[index].Quantity += input.Quantity
				continue
			}
			byJarSize[key] = len(lines)
			lines = append(lines, honeySaleLine{
				Kind: saleKindJar, JarSizeID: id, Quantity: input.Quantity,
				UnitPrice: input.UnitPrice, BottlingRunID: runID,
			})
		case saleKindColony:
			id, err := uuid.Parse(input.HiveID)
			if err != nil {
				return nil, errors.New("invalid hiveId")
			}
			if _, ok := byHive[id]; ok {
				return nil, errors.New("a hive can only appear once on a sale")
			}
			qty := input.Quantity
			if qty != 1 {
				return nil, errors.New("a colony line must have quantity 1")
			}
			byHive[id] = len(lines)
			lines = append(lines, honeySaleLine{
				Kind: saleKindColony, HiveID: id, Quantity: 1, UnitPrice: input.UnitPrice,
			})
		case saleKindEquipment:
			// itemId is the ledger identity; equipmentStockId is the legacy
			// one and is resolved to the same item before the sale is stored.
			var id, itemID uuid.UUID
			var err error
			if trimmed := strings.TrimSpace(input.ItemID); trimmed != "" {
				itemID, err = uuid.Parse(trimmed)
				if err != nil {
					return nil, errors.New("invalid itemId")
				}
				id = itemID
			} else {
				id, err = uuid.Parse(input.EquipmentStockID)
				if err != nil {
					return nil, errors.New("invalid equipmentStockId")
				}
			}
			if index, ok := byStock[id]; ok {
				if lines[index].UnitPrice != input.UnitPrice {
					return nil, errors.New("duplicate equipment entries must use the same unitPrice")
				}
				lines[index].Quantity += input.Quantity
				continue
			}
			byStock[id] = len(lines)
			line := honeySaleLine{
				Kind: saleKindEquipment, Quantity: input.Quantity, UnitPrice: input.UnitPrice,
			}
			if itemID != uuid.Nil {
				line.ItemID = itemID
			} else {
				line.EquipmentStockID = id
			}
			lines = append(lines, line)
		default:
			if input.ProductID == "" {
				return nil, errors.New("catalog lines require productId")
			}
			id, err := uuid.Parse(input.ProductID)
			if err != nil {
				return nil, errors.New("invalid productId")
			}
			if index, ok := byProduct[id]; ok {
				if lines[index].UnitPrice != input.UnitPrice {
					return nil, errors.New("duplicate productId entries must use the same unitPrice")
				}
				if kind != "product" && lines[index].Kind != "product" && lines[index].Kind != kind {
					return nil, errors.New("duplicate productId entries must use the same kind")
				}
				if kind != "product" {
					lines[index].Kind = kind
				}
				lines[index].Quantity += input.Quantity
				continue
			}
			byProduct[id] = len(lines)
			lines = append(lines, honeySaleLine{
				Kind: kind, ProductID: id, Quantity: input.Quantity, UnitPrice: input.UnitPrice,
			})
		}
	}
	return lines, nil
}

// honeyResolveSaleLocation maps an optional stockLocationId onto the sale.
// Home (or omitted) leaves stock_location_id NULL — every pre-location sale
// already means home. A named non-home location is validated against that
// shelf; consignment shops still go through their report, not this path.
func (s *Server) honeyResolveSaleLocation(
	ctx context.Context,
	tx inspectionQuerier,
	id *uuid.UUID,
) (*uuid.UUID, *stockLocationRow, error) {
	if id == nil {
		return nil, nil, nil
	}
	locations, err := s.stockLoadLocationsTx(ctx, tx, *id)
	if err != nil {
		return nil, nil, err
	}
	if len(locations) == 0 {
		return nil, nil, equipBadRequest("invalid stockLocationId")
	}
	location := locations[0]
	if !location.IsActive {
		return nil, nil, equipBadRequest("stock location is not active")
	}
	if location.IsHome {
		return nil, &location, nil
	}
	if location.IsConsignment {
		return nil, nil, equipFail(http.StatusConflict,
			"this is a consignment location: record their report instead, so the "+
				"counts and the payment land together")
	}
	return &location.ID, &location, nil
}

func (s *Server) honeyCheckLocationShelf(
	ctx context.Context,
	tx inspectionQuerier,
	location stockLocationRow,
	lines []honeySaleLine,
) error {
	shelf, _, err := s.stockLocationShelf(ctx, tx, location.ID)
	if err != nil {
		return err
	}
	available := make(map[string]int, len(shelf))
	labels := make(map[string]string, len(shelf))
	for _, row := range shelf {
		available[row.key()] = row.OnHand
		labels[row.key()] = row.Label
	}
	needed := make(map[string]int, len(lines))
	for _, line := range lines {
		var key string
		switch {
		case line.Kind == saleKindJar:
			id := line.JarSizeID
			key = stockLineKey(stockTransferLine{JarSizeID: &id})
		case saleKindIsProduct(line.Kind) || line.Kind == "product":
			id := line.ProductID
			key = stockLineKey(stockTransferLine{ProductID: &id})
		default:
			continue
		}
		needed[key] += line.Quantity
	}
	keys := make([]string, 0, len(needed))
	for key := range needed {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	for _, key := range keys {
		if needed[key] > available[key] {
			label, ok := labels[key]
			if !ok {
				label = "units"
			}
			return equipBadRequest("Not enough %s at %s: need %d, have %d",
				label, location.Name, needed[key], available[key])
		}
	}
	return nil
}

// saleBottlingRunLot is the resolved provenance of one jar line's bottling run.
type saleBottlingRunLot struct {
	LotID   uuid.UUID
	LotCode string
	JarSize *uuid.UUID
	Voided  bool
}

// saleResolveBottlingRuns validates every bottlingRunId named by the jar lines
// and returns the lot each one belongs to. A refusal is returned as an
// equipFail so the caller can hand it straight to equipWriteError.
//
// This is what makes a jar sale lot-traced: with the run resolved to a lot,
// refuseLotSale applies to a plain jar sale that names no harvestLotId at all,
// which is the case the withdrawal lockout could never reach before.
func saleResolveBottlingRuns(
	ctx context.Context,
	tx inspectionQuerier,
	lines []honeySaleLine,
	date time.Time,
) (map[uuid.UUID]saleBottlingRunLot, error) {
	runIDs := make([]uuid.UUID, 0, len(lines))
	seen := make(map[uuid.UUID]bool, len(lines))
	for _, line := range lines {
		if line.BottlingRunID == uuid.Nil || seen[line.BottlingRunID] {
			continue
		}
		seen[line.BottlingRunID] = true
		runIDs = append(runIDs, line.BottlingRunID)
	}
	if len(runIDs) == 0 {
		return nil, nil
	}
	rows, err := tx.Query(ctx, `
		SELECT br.id, br.lot_id, lot.lot_code, br.jar_size_id, br.voided_at IS NOT NULL
		FROM bottling_runs br
		JOIN harvest_lots lot ON lot.id = br.lot_id
		WHERE br.id = ANY($1)`, runIDs)
	if err != nil {
		return nil, err
	}
	byRun := make(map[uuid.UUID]saleBottlingRunLot, len(runIDs))
	for rows.Next() {
		var id uuid.UUID
		var run saleBottlingRunLot
		if err := rows.Scan(&id, &run.LotID, &run.LotCode, &run.JarSize, &run.Voided); err != nil {
			rows.Close()
			return nil, err
		}
		byRun[id] = run
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}

	for _, line := range lines {
		if line.BottlingRunID == uuid.Nil {
			continue
		}
		run, ok := byRun[line.BottlingRunID]
		if !ok {
			return nil, saleBadRequest("invalid bottlingRunId")
		}
		if run.Voided {
			return nil, equipFail(http.StatusConflict,
				"bottling run for lot %s is voided; its jars no longer exist", run.LotCode)
		}
		// The run pins the size it filled. Selling a 12 oz line "from" a
		// 1 lb run would attribute pounds to the wrong lot.
		if run.JarSize == nil || *run.JarSize != line.JarSizeID {
			return nil, saleBadRequest(
				"bottlingRunId does not match the jar size on its line")
		}
	}

	// One refusal per lot, evaluated at the sale date like every other
	// lockout check.
	checked := make(map[uuid.UUID]bool, len(byRun))
	for _, run := range byRun {
		if checked[run.LotID] {
			continue
		}
		checked[run.LotID] = true
		msg, err := refuseLotSale(ctx, tx, run.LotID, date)
		if err != nil {
			return nil, err
		}
		if msg != "" {
			return nil, equipFail(http.StatusConflict, "Lot %s: %s", run.LotCode, msg)
		}
	}
	return byRun, nil
}

// POST /honey/sales creates either an immediate sale or an order/invoice.
func (s *Server) honeyRecordSale(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Date                 string               `json:"date"`
		Location             *string              `json:"location"`
		StockLocationID      *uuid.UUID           `json:"stockLocationId"`
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
	// A sale born cancelled would still run saleApplyPhysical (selling the
	// hive / equipment) while a later cancel sees prev status 'cancelled' and
	// skips the restore. Create it live and cancel it through the cancel path.
	if req.OrderStatus == "cancelled" {
		writeError(w, http.StatusBadRequest,
			"a sale cannot be created as cancelled; create it and then cancel it")
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

	saleID := uuid.New()
	orderNumber := honeyTrimPtr(req.OrderNumber)
	if orderNumber == nil {
		value := "BT-" + strings.ToUpper(strings.ReplaceAll(saleID.String()[:8], "-", ""))
		orderNumber = &value
	}
	var subtotal, totalAmount, amountPaid money
	saleCommands := sales.New()
	err = s.runInUnitOfWork(r, func(ctx context.Context, uow *app.UnitOfWork) error {
		saleLocationID, saleLocation, err := s.honeyResolveSaleLocation(ctx, uow, req.StockLocationID)
		if err != nil {
			return err
		}
		if saleLocationID != nil {
			for _, line := range lines {
				if line.Kind == saleKindColony || line.Kind == saleKindEquipment {
					return equipFail(http.StatusBadRequest, "colony and equipment sales come off home, not a stock location")
				}
			}
		}

		// Per-line provenance first: each jar line's bottling run resolves to a
		// lot, and that lot is held to the same withdrawal window the sale-level
		// lot is. Ahead of the availability check on purpose — a voided or
		// mismatched run is a bad reference, and reporting it as "not enough
		// jars" would send the operator to the wrong screen.
		if _, err := saleResolveBottlingRuns(ctx, uow, lines, date); err != nil {
			return err
		}

		// Serialize sales that touch the same jar sizes, then validate availability
		// while holding the locks so this transaction sees sales committed by any
		// checkout that held them immediately before us.
		jarSizeIDs := make([]uuid.UUID, 0, len(lines))
		needed := make(map[uuid.UUID]int, len(lines))
		for _, line := range lines {
			if line.Kind != saleKindJar {
				continue
			}
			jarSizeIDs = append(jarSizeIDs, line.JarSizeID)
			needed[line.JarSizeID] += line.Quantity
		}
		if len(jarSizeIDs) > 0 {
			onHand, labels, unknown, err := honeyLockJarSizes(ctx, uow, jarSizeIDs)
			if err != nil {
				return equipFail(http.StatusInternalServerError, "database error")
			}
			if unknown {
				return equipFail(http.StatusBadRequest, "invalid jarSizeId")
			}
			if saleLocationID == nil {
				if message := honeyCheckJarAvailability(onHand, labels, needed); message != "" {
					return equipFail(http.StatusBadRequest, "%s", message)
				}
			}
		}

		productIDs := make([]uuid.UUID, 0, len(lines))
		neededProducts := make(map[uuid.UUID]int, len(lines))
		for _, line := range lines {
			if !saleKindIsProduct(line.Kind) && line.Kind != "product" {
				continue
			}
			productIDs = append(productIDs, line.ProductID)
			neededProducts[line.ProductID] += line.Quantity
		}
		if len(productIDs) > 0 {
			catalog, unknown, err := productLockCatalogInfo(ctx, uow, productIDs)
			onHand, labels, kinds := catalog.OnHand, catalog.Labels, catalog.Kinds
			if err != nil {
				return equipFail(http.StatusInternalServerError, "database error")
			}
			if unknown {
				return equipFail(http.StatusBadRequest, "invalid productId")
			}
			for i := range lines {
				if !saleKindIsProduct(lines[i].Kind) && lines[i].Kind != "product" {
					continue
				}
				catalogKind := kinds[lines[i].ProductID]
				if lines[i].Kind == "product" {
					lines[i].Kind = catalogKind
				} else if lines[i].Kind != catalogKind {
					return equipFail(http.StatusBadRequest, "line kind must match the catalog product")
				}
			}
			if saleLocationID == nil {
				// A home sale clears home stock, not the world: units standing on a
				// consignment shelf are not available here, or the same jar sells
				// twice (once at home, once on the shop's report).
				away, err := stockAwayProductTotals(ctx, uow)
				if err != nil {
					return equipFail(http.StatusInternalServerError, "database error")
				}
				for id, n := range away {
					if _, ok := onHand[id]; ok {
						onHand[id] -= n
					}
				}
				propolisGrams := 0.0
				for id := range neededProducts {
					if kinds[id] == saleKindPropolis {
						propolisGrams, err = propolisOnHandGrams(ctx, uow)
						if err != nil {
							return equipFail(http.StatusInternalServerError, "database error")
						}
						break
					}
				}
				if message := productCheckAvailabilityGrams(onHand, labels, kinds, catalog.NetGrams, neededProducts, propolisGrams); message != "" {
					return equipFail(http.StatusBadRequest, "%s", message)
				}
			}
		}
		if saleLocationID != nil && saleLocation != nil {
			if err := s.honeyCheckLocationShelf(ctx, uow, *saleLocation, lines); err != nil {
				return err
			}
		}
		if req.HarvestLotID != nil {
			if msg, err := refuseLotSale(ctx, uow, *req.HarvestLotID, date); err != nil {
				return equipFail(http.StatusInternalServerError, "database error")
			} else if msg != "" {
				return equipFail(http.StatusConflict, "%s", msg)
			}
		}

		var wholesaleMinimum *money
		if req.WholesalePriceListID != nil {
			if req.Channel != "wholesale" {
				return equipFail(http.StatusBadRequest, "wholesalePriceListId requires the wholesale channel")
			}
			var minimum money
			if err := uow.QueryRow(ctx, `
			SELECT minimum_order_amount_cents FROM wholesale_price_lists
			WHERE id=$1 AND is_active`, *req.WholesalePriceListID).Scan(&minimum); err != nil {
				return equipFail(http.StatusBadRequest, "invalid wholesale price list")
			}
			wholesaleMinimum = &minimum

			priceRows, err := uow.Query(ctx, `
			SELECT jar_size_id, unit_price_cents
			FROM wholesale_price_list_items
			WHERE price_list_id=$1`, *req.WholesalePriceListID)
			if err != nil {
				return equipFail(http.StatusInternalServerError, "database error")
			}
			prices := make(map[uuid.UUID]money)
			for priceRows.Next() {
				var jarSizeID uuid.UUID
				var unitPrice money
				if err := priceRows.Scan(&jarSizeID, &unitPrice); err != nil {
					priceRows.Close()
					return equipFail(http.StatusInternalServerError, "database error")
				}
				prices[jarSizeID] = unitPrice
			}
			priceErr := priceRows.Err()
			priceRows.Close()
			if priceErr != nil {
				return equipFail(http.StatusInternalServerError, "database error")
			}
			for i := range lines {
				if lines[i].Kind != saleKindJar {
					continue
				}
				unitPrice, ok := prices[lines[i].JarSizeID]
				if !ok {
					return equipFail(http.StatusBadRequest, "wholesale price list does not cover every jar size")
				}
				lines[i].UnitPrice = unitPrice
			}
		}
		if err := honeySalePriceRequired(req.Channel, lines); err != nil {
			return equipFail(http.StatusBadRequest, "%s", err.Error())
		}

		// All money arithmetic is exact integer cents: no float sums, no float
		// comparisons, no 1e-13 artifact rejecting a valid payment.
		subtotal = 0
		for _, line := range lines {
			subtotal += line.UnitPrice.mulQuantity(line.Quantity)
		}
		if req.DiscountAmount < 0 || req.DiscountAmount > subtotal {
			return equipFail(http.StatusBadRequest, "discount must be between zero and the subtotal")
		}
		totalAmount = subtotal - req.DiscountAmount
		amountPaid = totalAmount
		if req.OrderStatus == "draft" || req.OrderStatus == "pending" {
			amountPaid = 0
		}
		if req.AmountPaid != nil {
			amountPaid = *req.AmountPaid
		}
		if amountPaid < 0 || amountPaid > totalAmount {
			return equipFail(http.StatusBadRequest, "amountPaid must be between zero and the total")
		}
		if req.Tax != nil && *req.Tax < 0 {
			return equipFail(http.StatusBadRequest, "tax must be non-negative")
		}
		if wholesaleMinimum != nil {
			if totalAmount < *wholesaleMinimum {
				return equipFail(http.StatusBadRequest, "%s", fmt.Sprintf("Wholesale minimum is $%.2f", wholesaleMinimum.Dollars()))
			}
		}

		// An equipment line that arrived with the pre-ledger identity is
		// resolved onto its type's inventory item here, so nothing downstream
		// has to know the legacy shape (review OV2).
		for i := range lines {
			if lines[i].Kind != saleKindEquipment {
				continue
			}
			if lines[i].ItemID == uuid.Nil {
				var typeID uuid.UUID
				if err := uow.QueryRow(ctx,
					`SELECT type_id FROM equipment_stock WHERE id=$1`,
					lines[i].EquipmentStockID).Scan(&typeID); err != nil {
					if errors.Is(err, pgx.ErrNoRows) {
						return equipBadRequest("invalid equipmentStockId")
					}
					return err
				}
				itemID, err := production.EnsureEquipmentItem(ctx, uow, typeID)
				if err != nil {
					return err
				}
				lines[i].ItemID = itemID
			}
			if lines[i].EquipmentStockID == uuid.Nil {
				// Read only, never written: the legacy row exists solely to
				// satisfy the pre-ledger CHECK, so the Phase A freeze on
				// equipment_stock still holds.
				if err := uow.QueryRow(ctx, `
					SELECT es.id FROM equipment_stock es
					JOIN equipment_types et ON et.id = es.type_id
					WHERE et.item_id = $1`, lines[i].ItemID).
					Scan(&lines[i].EquipmentStockID); err != nil {
					if errors.Is(err, pgx.ErrNoRows) {
						return equipBadRequest("invalid itemId")
					}
					return err
				}
			}
		}
		actor := actorID(r)
		if _, err := uow.Exec(ctx, `
		INSERT INTO sales
			(id, date, customer_id, harvest_lot_id, customer_name, location, channel, payment_method,
			 total_amount_cents, discount_amount_cents, amount_paid_cents, tax_cents,
			 order_status, order_number, due_date, wholesale_price_list_id, notes, created_by,
			 stock_location_id)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)`,
			saleID, date, req.CustomerID, req.HarvestLotID, honeyTrimPtr(req.CustomerName),
			honeyTrimPtr(req.Location), req.Channel, req.PaymentMethod, totalAmount,
			req.DiscountAmount, amountPaid, req.Tax, req.OrderStatus, orderNumber, dueDate,
			req.WholesalePriceListID, honeyTrimPtr(req.Notes), actor, saleLocationID); err != nil {
			return dbCommandError(err, "order number already exists",
				"invalid customer, harvest lot, or wholesale price list")
		}
		for _, line := range lines {
			var jarSizeID, hiveID, itemID, equipmentStockID, productID, bottlingRunID *uuid.UUID
			switch {
			case line.Kind == saleKindJar:
				id := line.JarSizeID
				jarSizeID = &id
				if line.BottlingRunID != uuid.Nil {
					runID := line.BottlingRunID
					bottlingRunID = &runID
				}
			case line.Kind == saleKindColony:
				id := line.HiveID
				hiveID = &id
			case line.Kind == saleKindEquipment:
				id := line.ItemID
				itemID = &id
				stock := line.EquipmentStockID
				equipmentStockID = &stock
			case saleKindIsProduct(line.Kind):
				id := line.ProductID
				productID = &id
			}
			// equipment_stock_id is not written any more: an equipment line names
			// the inventory item it consumes (review OV2). The other identities
			// stay; LinkLines fills item_id and inventory_lot_id for jar and
			// product lines once every line is stored.
			if _, err := uow.Exec(ctx, `
			INSERT INTO sale_items
				(sale_id, kind, jar_size_id, hive_id, item_id, equipment_stock_id,
				 product_id, quantity, unit_price_cents, bottling_run_id, created_by)
			VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
				saleID, line.Kind, jarSizeID, hiveID, itemID, equipmentStockID, productID,
				line.Quantity, line.UnitPrice, bottlingRunID, actor); err != nil {
				if honeyIsFKViolation(err) {
					return equipBadRequest("invalid jar, hive, equipment, or product target")
				}
				return err
			}
		}
		// Drafts and pending orders do not move the hive, feeders, or equipment
		// yet; that happens when the sale becomes paid/fulfilled (see
		// honeyUpdateSale). They are still refused for a hive that is already
		// gone, but two open drafts may name the same hive (no reservation).
		location, err := saleCommands.SaleLocation(ctx, uow, saleID)
		if err != nil {
			return err
		}
		if saleStatusAppliesPhysical(req.OrderStatus) {
			// physical_applied_at is set BEFORE the consumption is recorded:
			// the lines stop being a reservation the moment the sale applies,
			// so on-hand and available do not double-count them.
			if _, err := uow.Exec(ctx,
				`UPDATE sales SET physical_applied_at=now() WHERE id=$1`, saleID); err != nil {
				return err
			}
			if err := saleApplyPhysical(ctx, uow, saleID, date, actor, lines); err != nil {
				return err
			}
		} else {
			// A draft or pending sale records no operation (decision 2). Its
			// lines become a reservation as soon as they name an item, and
			// CheckAvailable holds the same tuple locks a sale does.
			if err := saleCommands.LinkLines(ctx, uow, saleID, location); err != nil {
				return err
			}
			if err := saleCheckHivesSellable(ctx, uow, lines); err != nil {
				return err
			}
		}
		return nil
	})
	if err != nil {
		writeCommandError(w, err)
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

	var totalAmount, amountPaid money
	err = s.runInUnitOfWork(r, func(ctx context.Context, uow *app.UnitOfWork) error {
		var currentPaid money
		var currentPayment string
		var saleDate time.Time
		var physicalAppliedAt *time.Time
		if err := uow.QueryRow(ctx, `
		SELECT total_amount_cents, amount_paid_cents, payment_method, date, physical_applied_at
		FROM sales WHERE id=$1 AND order_status <> 'cancelled'
		FOR UPDATE`, id).Scan(&totalAmount, &currentPaid, &currentPayment,
			&saleDate, &physicalAppliedAt); err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				return equipFail(http.StatusNotFound, "sale not found")
			}
			return equipFail(http.StatusInternalServerError, "database error")
		}
		amountPaid = currentPaid
		if req.AmountPaid != nil {
			amountPaid = *req.AmountPaid
		} else if req.OrderStatus == "paid" || req.OrderStatus == "fulfilled" {
			amountPaid = totalAmount
		}
		if amountPaid < 0 || amountPaid > totalAmount {
			return equipFail(http.StatusBadRequest, "amountPaid must be between zero and the total")
		}
		paymentMethod := currentPayment
		if req.PaymentMethod != nil {
			paymentMethod = *req.PaymentMethod
		}
		if _, err := uow.Exec(ctx, `
		UPDATE sales
		SET order_status=$1, amount_paid_cents=$2, payment_method=$3,
			due_date=CASE WHEN $4::boolean THEN $5 ELSE due_date END,
			tax_cents=COALESCE($6, tax_cents)
		WHERE id=$7`,
			req.OrderStatus, amountPaid, paymentMethod, req.DueDate != nil, dueDate,
			req.Tax, id); err != nil {
			return equipFail(http.StatusInternalServerError, "database error")
		}
		// Physical effects follow the status: moving into paid/fulfilled applies
		// them once (409 if another sale took the hive meanwhile); moving back to
		// draft/pending puts the hive, feeders, and equipment back.
		actor := actorID(r)
		switch {
		case saleStatusAppliesPhysical(req.OrderStatus) && physicalAppliedAt == nil:
			lines, err := saleLoadLines(ctx, uow, id)
			if err != nil {
				return equipFail(http.StatusInternalServerError, "database error")
			}
			// physical_applied_at first: the sale's lines stop being a
			// reservation before their consumption is recorded, so the two
			// never overlap in inventory_available.
			if _, err := uow.Exec(ctx,
				`UPDATE sales SET physical_applied_at=now() WHERE id=$1`, id); err != nil {
				return err
			}
			if err := saleApplyPhysical(ctx, uow, id, saleDate, actor, lines); err != nil {
				return err
			}
		case !saleStatusAppliesPhysical(req.OrderStatus) && physicalAppliedAt != nil:
			if err := saleUnapplyPhysical(ctx, uow, id, actor); err != nil {
				return err
			}
			if _, err := uow.Exec(ctx,
				`UPDATE sales SET physical_applied_at=NULL WHERE id=$1`, id); err != nil {
				return err
			}
		}
		return nil
	})
	if err != nil {
		writeCommandError(w, err)
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

	// A settlement's sale is one half of a larger unit of work (returns,
	// shrink, the statement itself). Cancelling it alone would strand the
	// rest; the settlement void unwinds everything together. (The void's own
	// cancel runs inside its transaction, not through this function.)
	var settled bool
	if err := s.pool.QueryRow(ctx, `
		SELECT EXISTS(
			SELECT 1 FROM consignment_settlements
			WHERE sale_id = $1 AND voided_at IS NULL)`, id).Scan(&settled); err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	if settled {
		writeError(w, http.StatusConflict,
			"this sale was recognised by a consignment settlement; void the settlement instead")
		return
	}
	var totalAmount, amountPaid money
	err := s.runInUnitOfWork(r, func(ctx context.Context, uow *app.UnitOfWork) error {
		var prevStatus string
		var physicalAppliedAt *time.Time
		err := uow.QueryRow(ctx, `
		SELECT order_status, physical_applied_at FROM sales WHERE id=$1 FOR UPDATE`, id).
			Scan(&prevStatus, &physicalAppliedAt)
		if errors.Is(err, pgx.ErrNoRows) {
			return equipFail(http.StatusNotFound, "sale not found")
		}
		if err != nil {
			return equipFail(http.StatusInternalServerError, "database error")
		}
		alreadyCancelled := prevStatus == "cancelled"
		actor := actorID(r)
		// A draft/pending sale never moved the hive or equipment, so there is
		// nothing to put back; only an applied sale is restored.
		if !alreadyCancelled && physicalAppliedAt != nil {
			if err := saleRestorePhysical(ctx, uow, id, actor); err != nil {
				return err
			}
		}
		err = uow.QueryRow(ctx, `
		UPDATE sales
		SET order_status='cancelled',
			physical_applied_at=NULL,
			cancelled_at=COALESCE(cancelled_at, now()),
			cancelled_by=COALESCE(cancelled_by, $2),
			cancellation_reason=COALESCE($3, cancellation_reason)
		WHERE id=$1
		RETURNING total_amount_cents, amount_paid_cents`,
			id, actor, reason).Scan(&totalAmount, &amountPaid)
		if errors.Is(err, pgx.ErrNoRows) {
			return equipFail(http.StatusNotFound, "sale not found")
		}
		if err != nil {
			return equipFail(http.StatusInternalServerError, "database error")
		}
		// The jars are physically back on the shelf, so their serials must stop
		// resolving as sold — a cancelled sale that kept its serial links made
		// the serial lookup disagree with inventory.
		if _, err := uow.Exec(ctx, `
		UPDATE jar_serials SET sale_id=NULL, sold_at=NULL, linked_by=NULL
		WHERE sale_id=$1`, id); err != nil {
			return equipFail(http.StatusInternalServerError, "database error")
		}
		return nil
	})
	if err != nil {
		writeCommandError(w, err)
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
		`SELECT DISTINCT location FROM sales WHERE location IS NOT NULL`)
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

// honeyJarInventory derives jar counts from the inventory ledger's
// projections: onHand is inventory_available, and the breakdown columns are
// operation history. A reversal nets to zero on its own because it is
// classified through the operation it negates.
func (s *Server) honeyJarInventory(ctx context.Context) ([]honeyInventoryRow, error) {
	return honeyJarInventoryWithQuerier(ctx, s.pool)
}

func honeyJarInventoryWithQuerier(ctx context.Context, queryer inspectionQuerier) ([]honeyInventoryRow, error) {
	// onHand is inventory_available summed across every location: what the
	// operator could still sell anywhere. It equals jarred + adjusted - sold -
	// givenAway exactly, because a non-cancelled sale line is either an
	// applied consumption (in the balance) or a reservation (subtracted by
	// the view), never both and never neither (review OV1).
	//
	// Inactive sizes are listed only while they still hold stock. Filtering on
	// is_active alone turned deactivating a size into an invisible inventory
	// write-off: the jars vanished from on-hand, dashboards, valuation, and
	// low-stock alerts while their sales kept counting as revenue.
	rows, err := queryer.Query(ctx, `
		WITH `+ledgerClassifiedCTE+`,
		history AS (
			SELECT item_id,
			       COALESCE(SUM(quantity) FILTER (WHERE source_type='bottling_run'), 0)::int AS jarred,
			       COALESCE(SUM(-quantity) FILTER (WHERE kind='shrink' AND reason='give_away'), 0)::int AS given_away,
			       COALESCE(SUM(quantity) FILTER (WHERE kind='count_adjust'), 0)::int AS adjusted
			FROM classified GROUP BY item_id
		),
		available AS (
			SELECT item_id, COALESCE(SUM(available), 0)::int AS available
			FROM inventory_available GROUP BY item_id
		),
		sold AS (
			SELECT si.jar_size_id, SUM(si.quantity)::int AS sold
			FROM sale_items si
			JOIN sales s ON s.id = si.sale_id
			WHERE s.order_status <> 'cancelled' AND si.kind = 'jar'
			GROUP BY si.jar_size_id
		)
		SELECT js.id, js.label, js.honey_oz, js.default_price_cents, js.is_active,
		       COALESCE(h.jarred, 0), COALESCE(h.given_away, 0), COALESCE(h.adjusted, 0),
		       COALESCE(sd.sold, 0), COALESCE(av.available, 0)
		FROM jar_sizes js
		LEFT JOIN history h ON h.item_id = js.item_id
		LEFT JOIN available av ON av.item_id = js.item_id
		LEFT JOIN sold sd ON sd.jar_size_id = js.id
		WHERE js.is_active OR COALESCE(av.available, 0) <> 0
		ORDER BY js.sort_order, js.label`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]honeyInventoryRow, 0)
	for rows.Next() {
		var row honeyInventoryRow
		if err := rows.Scan(&row.JarSizeID, &row.Label, &row.HoneyOz, &row.DefaultPrice,
			&row.IsActive, &row.Jarred, &row.GivenAway, &row.Adjusted, &row.Sold,
			&row.OnHand); err != nil {
			return nil, err
		}
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
		(SELECT COALESCE(SUM(total_amount_cents), 0) FROM sales WHERE order_status <> 'cancelled'),
		(SELECT COALESCE(SUM(amount_paid_cents), 0) FROM sales WHERE order_status <> 'cancelled'),
		(SELECT COALESCE(SUM(si.quantity), 0) FROM sale_items si
		 JOIN sales s ON s.id=si.sale_id
		 WHERE s.order_status <> 'cancelled' AND si.kind = 'jar')`).
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

// GET /honey/timeline?limit= — operations + sales merged, newest first.
//
// Identity is inventory_operations.id now, not honey_movements.id: the
// movement ledger the timeline used to read is replaced by the one signed
// operation ledger (spec 8.1, R4). "Is this reversed" is an EXISTS over
// reverses_operation_id rather than a stored back-pointer (review Q3).
func (s *Server) honeyTimelineHandler(w http.ResponseWriter, r *http.Request) {
	limit := parseBoundedLimit(r.URL.Query().Get("limit"), honeyTimelineDefaultLimit, honeyTimelineMaxLimit)
	ctx := r.Context()

	rows, err := s.pool.Query(ctx, `
		SELECT o.id, o.occurred_at, o.kind, o.reason, o.source_type,
		       o.reverses_operation_id,
		       COALESCE(SUM(m.quantity) FILTER (WHERE m.item_id = $2), 0)::float8 AS bulk_lbs,
		       COALESCE(SUM(m.quantity) FILTER (WHERE i.kind = 'jar'), 0)::int AS jars,
		       MIN(js.label) FILTER (WHERE i.kind = 'jar') AS jar_label,
		       o.details ->> 'notes'
		FROM inventory_operations o
		JOIN inventory_movements m ON m.operation_id = o.id
		JOIN inventory_items i ON i.id = m.item_id
		LEFT JOIN jar_sizes js ON js.item_id = i.id
		WHERE i.id = $2 OR i.kind = 'jar'
		GROUP BY o.id
		ORDER BY o.occurred_at DESC, o.created_at DESC
		LIMIT $1`, limit, production.HoneyBulkItemID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	entries := make([]honeyTimelineEntry, 0)
	for rows.Next() {
		var (
			id                   uuid.UUID
			occurredAt           time.Time
			kind, reason, source string
			reversesID           *uuid.UUID
			bulkLbs              float64
			jars                 int
			jarLabel, notes      *string
		)
		if err := rows.Scan(&id, &occurredAt, &kind, &reason, &source, &reversesID,
			&bulkLbs, &jars, &jarLabel, &notes); err != nil {
			rows.Close()
			writeError(w, http.StatusInternalServerError, "database error")
			return
		}
		label := "?"
		if jarLabel != nil {
			label = *jarLabel
		}
		entryType, description := honeyTimelineDescribe(kind, reason, source, label, jars, bulkLbs)
		if reversesID != nil {
			description = "Reversed: " + description
		}
		entry := honeyTimelineEntry{
			ID: id, Date: occurredAt, Type: entryType, Description: description,
			Notes: notes, IsReversal: reversesID != nil, ReversesID: reversesID,
		}
		if jars != 0 {
			quantity := jars
			entry.Quantity = &quantity
		}
		if bulkLbs != 0 {
			lbs := bulkLbs
			entry.AmountLbs = &lbs
		}
		entries = append(entries, entry)
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

// honeyTimelineDescribe turns one operation into the timeline's type and its
// sentence. The legacy kinds are preserved on the wire — jarring, give_away,
// jar_adjustment, bulk_use, loss — so the activity tab keeps working; they are
// now derived from the operation kind, its registry reason, and the domain
// record that commanded it rather than from a honey_movements column.
func honeyTimelineDescribe(
	kind, reason, sourceType, label string, jars int, bulkLbs float64,
) (string, string) {
	switch {
	case sourceType == "bottling_run":
		return "jarring", fmt.Sprintf("Jarred %d × %s", jars, label)
	case kind == "shrink" && reason == "give_away":
		return "give_away", fmt.Sprintf("Gave away %d × %s", -jars, label)
	case kind == "count_adjust" && jars != 0:
		return "jar_adjustment", fmt.Sprintf("Adjusted %s by %+d", label, jars)
	case kind == "shrink" && reason == "loss":
		return "loss", fmt.Sprintf("Loss %.1f lbs", -bulkLbs)
	case kind == "shrink":
		return "bulk_use", fmt.Sprintf("Used %.1f lbs bulk", -bulkLbs)
	case sourceType == "product_batch":
		return "bulk_use", fmt.Sprintf("Used %.1f lbs bulk", -bulkLbs)
	case kind == "sale_consume":
		return "sale", fmt.Sprintf("Sold %d × %s", -jars, label)
	case kind == "receive" || kind == "opening_balance":
		return "receipt", fmt.Sprintf("Received %.1f lbs", bulkLbs)
	default:
		return kind, fmt.Sprintf("%s %d × %s", kind, jars, label)
	}
}
