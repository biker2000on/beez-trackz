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

	// /sales is the only path. The /honey/sales alias that kept queued
	// offline mutations replaying across the route rewrite was retired on
	// 2026-09-04 (operator waived the receipt-TTL wait); a mutation still
	// queued against it replays as 404.
	admin.Get("/sales", s.honeyListSalesHandler)
	admin.Post("/sales", s.honeyRecordSale)
	admin.Patch("/sales/{id}", s.honeyUpdateSale)
	admin.Delete("/sales/{id}", s.honeyCancelSale)
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

	commandLines := make([]production.RecordBottlingLine, 0, len(lines))
	for _, line := range lines {
		commandLines = append(commandLines, production.RecordBottlingLine{
			JarSizeID: line.JarSizeID, Quantity: line.Quantity,
		})
	}
	lossLbs := 0.0
	if hasLoss {
		lossLbs = *req.LossLbs
	}
	result, err := s.runApplicationCommand(r, http.StatusOK,
		func(ctx context.Context, uow *app.UnitOfWork) (any, error) {
			return production.RecordBottling(ctx, uow, production.RecordBottlingInput{
				HarvestLotID: lotID, Date: date, Lines: commandLines,
				LossLbs: lossLbs, Notes: notes,
			})
		})
	if err != nil {
		writeCommandError(w, err)
		return
	}
	writeApplicationResult(w, result)
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

// POST /honey/sales creates either an immediate sale or an order/invoice.
// Parsing and wire defaults remain here; sales.RecordSale owns all database
// orchestration and failure semantics.
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
	date, err := parseDate(req.Date)
	if err != nil || req.Date == "" {
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
	if !honeySaleChannels[req.Channel] || !honeyPaymentMethods[req.PaymentMethod] || !honeyOrderStatuses[req.OrderStatus] || req.DiscountAmount < 0 {
		writeError(w, http.StatusBadRequest, "invalid channel, payment method, order status, or discount")
		return
	}
	var due *time.Time
	if req.DueDate != nil && *req.DueDate != "" {
		v, e := parseDate(*req.DueDate)
		if e != nil {
			writeError(w, http.StatusBadRequest, "invalid dueDate")
			return
		}
		due = &v
	}
	id := uuid.New()
	order := honeyTrimPtr(req.OrderNumber)
	if order == nil {
		v := "BT-" + strings.ToUpper(id.String()[:8])
		order = &v
	}
	commandLines := make([]sales.SaleLine, 0, len(lines))
	for _, line := range lines {
		commandLines = append(commandLines, sales.SaleLine{Kind: line.Kind, JarSizeID: line.JarSizeID, HiveID: line.HiveID, ItemID: line.ItemID, EquipmentStockID: line.EquipmentStockID, ProductID: line.ProductID, BottlingRunID: line.BottlingRunID, Quantity: line.Quantity, UnitPriceCents: int64(line.UnitPrice)})
	}
	var paid, tax *int64
	if req.AmountPaid != nil {
		v := int64(*req.AmountPaid)
		paid = &v
	}
	if req.Tax != nil {
		v := int64(*req.Tax)
		tax = &v
	}
	result, err := s.runApplicationCommand(r, http.StatusCreated, func(ctx context.Context, uow *app.UnitOfWork) (any, error) {
		return sales.RecordSale(ctx, uow, sales.RecordSaleInput{SaleID: id, Date: date, Location: req.Location, StockLocationID: req.StockLocationID, CustomerID: req.CustomerID, HarvestLotID: req.HarvestLotID, CustomerName: req.CustomerName, Channel: req.Channel, PaymentMethod: req.PaymentMethod, OrderStatus: req.OrderStatus, DiscountAmountCents: int64(req.DiscountAmount), AmountPaidCents: paid, TaxCents: tax, OrderNumber: order, DueDate: due, WholesalePriceListID: req.WholesalePriceListID, Lines: commandLines, Notes: req.Notes})
	})
	if err != nil {
		writeCommandError(w, err)
		return
	}
	writeApplicationResult(w, result)
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
	var due *time.Time
	if req.DueDate != nil && *req.DueDate != "" {
		v, e := parseDate(*req.DueDate)
		if e != nil {
			writeError(w, http.StatusBadRequest, "invalid dueDate")
			return
		}
		due = &v
	}
	var paid, tax *int64
	if req.AmountPaid != nil {
		v := int64(*req.AmountPaid)
		paid = &v
	}
	if req.Tax != nil {
		v := int64(*req.Tax)
		tax = &v
	}
	result, err := s.runApplicationCommand(r, http.StatusOK, func(ctx context.Context, uow *app.UnitOfWork) (any, error) {
		if req.OrderStatus == "cancelled" {
			return sales.CancelSale(ctx, uow, sales.CancelSaleInput{SaleID: id, Reason: req.CancellationReason})
		}
		return sales.UpdateSale(ctx, uow, sales.UpdateSaleInput{SaleID: id, OrderStatus: req.OrderStatus, AmountPaidCents: paid, PaymentMethod: req.PaymentMethod, DueDateSet: req.DueDate != nil, DueDate: due, TaxCents: tax})
	})
	if err != nil {
		writeCommandError(w, err)
		return
	}
	writeApplicationResult(w, result)
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
	result, err := s.runApplicationCommand(r, http.StatusOK, func(ctx context.Context, uow *app.UnitOfWork) (any, error) {
		return sales.CancelSale(ctx, uow, sales.CancelSaleInput{SaleID: id, Reason: req.Reason})
	})
	if err != nil {
		writeCommandError(w, err)
		return
	}
	writeApplicationResult(w, result)
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
	// operator could still sell anywhere. The history buckets are classified
	// by ledger semantics, never live-only provenance: jarred is every net
	// transform output for a jar item, adjusted is net count_adjust plus
	// opening_balance, and givenAway is shrink reason give_away. Therefore
	// onHand = jarred + adjusted - sold - givenAway exactly, because a
	// non-cancelled sale line is either an applied consumption (in the balance)
	// or a reservation (subtracted by the view), never both and never neither
	// (review OV1).
	//
	// Inactive sizes are listed only while they still hold stock. Filtering on
	// is_active alone turned deactivating a size into an invisible inventory
	// write-off: the jars vanished from on-hand, dashboards, valuation, and
	// low-stock alerts while their sales kept counting as revenue.
	rows, err := queryer.Query(ctx, `
		WITH `+ledgerClassifiedCTE+`,
		history AS (
			SELECT item_id,
			       COALESCE(SUM(quantity) FILTER (WHERE kind='transform'), 0)::int AS jarred,
			       COALESCE(SUM(-quantity) FILTER (WHERE kind='shrink' AND reason='give_away'), 0)::int AS given_away,
			       COALESCE(SUM(quantity) FILTER (WHERE kind IN ('count_adjust','opening_balance')), 0)::int AS adjusted
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
		SELECT o.id, o.occurred_at,
		       COALESCE(original.kind, o.kind), COALESCE(original.reason, o.reason),
		       o.reverses_operation_id,
		       COALESCE(SUM(m.quantity) FILTER (WHERE m.item_id = $2), 0)::float8 AS bulk_lbs,
		       COALESCE(SUM(m.quantity) FILTER (WHERE i.kind = 'jar'), 0)::int AS jars,
		       MIN(js.label) FILTER (WHERE i.kind = 'jar') AS jar_label,
		       o.details ->> 'notes'
		FROM inventory_operations o
		LEFT JOIN inventory_operations original ON original.id = o.reverses_operation_id
		JOIN inventory_movements m ON m.operation_id = o.id
		JOIN inventory_items i ON i.id = m.item_id
		LEFT JOIN jar_sizes js ON js.item_id = i.id
		WHERE i.id = $2 OR i.kind = 'jar'
		GROUP BY o.id, original.id
		ORDER BY o.occurred_at DESC, o.created_at DESC
		LIMIT $1`, limit, production.HoneyBulkItemID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	entries := make([]honeyTimelineEntry, 0)
	for rows.Next() {
		var (
			id              uuid.UUID
			occurredAt      time.Time
			kind, reason    string
			reversesID      *uuid.UUID
			bulkLbs         float64
			jars            int
			jarLabel, notes *string
		)
		if err := rows.Scan(&id, &occurredAt, &kind, &reason, &reversesID,
			&bulkLbs, &jars, &jarLabel, &notes); err != nil {
			rows.Close()
			writeError(w, http.StatusInternalServerError, "database error")
			return
		}
		label := "?"
		if jarLabel != nil {
			label = *jarLabel
		}
		entryType, description := honeyTimelineDescribe(kind, reason, label, jars, bulkLbs)
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
// now derived from the operation kind, its registry reason, and its movement
// shape rather than live-only source provenance.
func honeyTimelineDescribe(
	kind, reason, label string, jars int, bulkLbs float64,
) (string, string) {
	switch {
	case kind == "transform" && jars != 0:
		return "jarring", fmt.Sprintf("Jarred %d × %s", jars, label)
	case kind == "shrink" && reason == "give_away":
		return "give_away", fmt.Sprintf("Gave away %d × %s", -jars, label)
	case kind == "count_adjust" && jars != 0:
		return "jar_adjustment", fmt.Sprintf("Adjusted %s by %+d", label, jars)
	case kind == "shrink" && reason == "loss":
		return "loss", fmt.Sprintf("Loss %.1f lbs", -bulkLbs)
	case kind == "shrink":
		return "bulk_use", fmt.Sprintf("Used %.1f lbs bulk", -bulkLbs)
	case kind == "transform":
		return "bulk_use", fmt.Sprintf("Used %.1f lbs bulk", -bulkLbs)
	case kind == "sale_consume":
		return "sale", fmt.Sprintf("Sold %d × %s", -jars, label)
	case kind == "receive" || kind == "opening_balance":
		return "receipt", fmt.Sprintf("Received %.1f lbs", bulkLbs)
	default:
		return kind, fmt.Sprintf("%s %d × %s", kind, jars, label)
	}
}
