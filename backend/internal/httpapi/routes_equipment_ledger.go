package httpapi

import (
	"context"
	"errors"
	"net/http"
	"sort"
	"strconv"
	"time"

	"github.com/biker2000on/beez-trackz/backend/internal/app"
	appequipment "github.com/biker2000on/beez-trackz/backend/internal/app/equipment"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// Ledger actions for equipment: receive, adjust, mark damaged, repair, retire,
// and the physical-count flow that replaced bulk-adjust. Every one of them
// appends a ledger entry inside a transaction that has already locked and
// re-read the stock row, so nothing can drive a count negative and nothing
// changes a quantity without saying why.

// --- shared request plumbing ---

type equipQuantityRequest struct {
	Quantity       int     `json:"quantity"`
	Reason         string  `json:"reason"`
	Notes          *string `json:"notes"`
	Date           *string `json:"date"`
	UnitCostCents  *int    `json:"unitCostCents"`
	IdempotencyKey *string `json:"idempotencyKey"`
	// From selects the pool a state change or removal draws from
	// ('serviceable' by default, or 'damaged' / 'retired').
	From *string `json:"from"`
}

type equipParsedRequest struct {
	StockID        uuid.UUID
	Quantity       int
	Reason         string
	Notes          *string
	Date           time.Time
	Cost           *int
	From           string
	CreatedBy      *uuid.UUID
	IdempotencyKey *string
}

// equipParseQuantityRequest handles the parts every ledger action shares.
// requirePositive rejects zero/negative quantities (only /adjust allows a
// signed value).
func equipParseQuantityRequest(
	r *http.Request,
	allowed map[string]bool,
	requirePositive bool,
) (equipParsedRequest, error) {
	var parsed equipParsedRequest
	stockID, err := uuidParam(r, "id")
	if err != nil {
		return parsed, equipBadRequest("%s", err.Error())
	}
	var req equipQuantityRequest
	if err := decodeJSON(r, &req); err != nil {
		return parsed, equipBadRequest("invalid request body")
	}
	if requirePositive && req.Quantity < 1 {
		return parsed, equipBadRequest("Quantity must be at least 1")
	}
	if !requirePositive && req.Quantity == 0 {
		return parsed, equipBadRequest("Quantity must be non-zero")
	}
	if req.Reason == "" {
		return parsed, equipBadRequest("Reason is required")
	}
	if !allowed[req.Reason] {
		return parsed, equipBadRequest("invalid reason")
	}
	if req.UnitCostCents != nil && *req.UnitCostCents < 0 {
		return parsed, equipBadRequest("Unit cost cannot be negative")
	}
	date := time.Now()
	if d, err := parseDatePtr(req.Date); err != nil {
		return parsed, equipBadRequest("invalid date")
	} else if d != nil {
		date = *d
	}
	from := "serviceable"
	if v := equipTrimPtr(req.From); v != nil {
		from = *v
	}
	if from != "serviceable" && from != "damaged" && from != "retired" {
		return parsed, equipBadRequest("invalid from state")
	}

	parsed = equipParsedRequest{
		StockID:        stockID,
		Quantity:       req.Quantity,
		Reason:         req.Reason,
		Notes:          equipTrimPtr(req.Notes),
		Date:           date,
		Cost:           req.UnitCostCents,
		From:           from,
		CreatedBy:      equipActor(r),
		IdempotencyKey: equipTrimPtr(req.IdempotencyKey),
	}
	return parsed, nil
}

// equipInTx runs a ledger action in its own transaction and writes the result.
func (s *Server) equipInTx(
	w http.ResponseWriter,
	r *http.Request,
	action func(ctx context.Context, tx pgx.Tx) (map[string]any, error),
) {
	ctx := r.Context()
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	defer tx.Rollback(ctx)

	body, err := action(ctx, tx)
	if err != nil {
		equipWriteError(w, err)
		return
	}
	if err := tx.Commit(ctx); err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	if body == nil {
		body = map[string]any{}
	}
	body["success"] = true
	writeJSON(w, http.StatusOK, body)
}

// equipStateSnapshot reports the counts a caller should see after a write.
func equipStateSnapshot(state equipStockState) map[string]any {
	return map[string]any{
		"totalOwned": state.TotalOwned,
		"deployed":   state.Deployed,
		"damaged":    state.Damaged,
		"retired":    state.Retired,
		"available":  state.Available(),
	}
}

func equipLedgerSnapshot(ctx context.Context, q app.Querier, itemID uuid.UUID) (map[string]any, error) {
	var owned, deployed, damaged, retired, available int
	err := q.QueryRow(ctx, `
		SELECT COALESCE(SUM(b.on_hand),0)::int,
		 COALESCE(SUM(b.on_hand) FILTER(WHERE l.kind='deployed'),0)::int,
		 COALESCE(SUM(b.on_hand) FILTER(WHERE b.condition='damaged'),0)::int,
		 COALESCE(SUM(b.on_hand) FILTER(WHERE b.condition='retired'),0)::int,
		 COALESCE((SELECT SUM(a.available)::int FROM inventory_available a JOIN inventory_locations al ON al.id=a.location_id WHERE a.item_id=$1 AND al.is_home AND a.condition='serviceable' AND a.container_hive_id IS NULL),0)
		FROM inventory_balances b JOIN inventory_locations l ON l.id=b.location_id WHERE b.item_id=$1`, itemID).Scan(&owned, &deployed, &damaged, &retired, &available)
	if err != nil {
		return nil, err
	}
	return map[string]any{"totalOwned": owned, "deployed": deployed, "damaged": damaged, "retired": retired, "available": available}, nil
}

// --- receive ---

// POST /equipment/stock/{id}/receive {quantity, reason, unitCostCents?, notes?, date?}
func (s *Server) equipReceiveStock(w http.ResponseWriter, r *http.Request) {
	parsed, err := equipParseQuantityRequest(r, equipReceiveReasons, true)
	if err != nil {
		equipWriteError(w, err)
		return
	}
	s.equipInUOW(w, r, func(ctx context.Context, uow *app.UnitOfWork) (map[string]any, error) {
		cmd := appequipment.Command{Reference: parsed.StockID, Quantity: parsed.Quantity, OccurredAt: parsed.Date, Reason: parsed.Reason, UnitCostCents: parsed.Cost}
		if parsed.Notes != nil {
			cmd.Notes = *parsed.Notes
		}
		if parsed.IdempotencyKey != nil {
			cmd.IdempotencyKey = *parsed.IdempotencyKey
		}
		recorded, err := appequipment.NewService().Receive(ctx, uow, cmd)
		if err != nil {
			return nil, err
		}
		return equipLedgerSnapshot(ctx, uow, recorded.Operation.Lines[0].Tuple.ItemID)
	})
}

// --- adjust ---

// equipAdjustTx applies a signed correction to what is owned, refusing any
// adjustment that would drive a count below zero.
func equipAdjustTx(
	ctx context.Context,
	tx pgx.Tx,
	parsed equipParsedRequest,
) (map[string]any, error) {
	if parsed.Quantity > 0 && parsed.From != "serviceable" {
		return nil, equipBadRequest("Only negative adjustments can name a from state")
	}
	state, err := equipLockStock(ctx, tx, parsed.StockID)
	if err != nil {
		return nil, err
	}
	if _, found, err := equipLookupIdempotent(ctx, tx, "equipment_stock_adjustments", parsed.IdempotencyKey, "stock_id", parsed.StockID); err != nil {
		return nil, err
	} else if found {
		return equipStateSnapshot(state), nil
	}
	removed := -parsed.Quantity
	switch {
	case parsed.Quantity > 0:
		// Nothing to validate: adding stock cannot go negative.
	case parsed.From == "serviceable":
		if removed > state.Available() {
			return nil, equipBadRequest(
				"Not enough %s available: removing %d would leave %d",
				state.TypeName, removed, state.Available()-removed)
		}
	case parsed.From == "damaged":
		if removed > state.Damaged {
			return nil, equipBadRequest(
				"Only %d %s are marked damaged", state.Damaged, state.TypeName)
		}
	case parsed.From == "retired":
		if removed > state.Retired {
			return nil, equipBadRequest(
				"Only %d %s are retired", state.Retired, state.TypeName)
		}
	}

	replayed, err := equipInsertAdjustment(ctx, tx, equipAdjustmentEntry{
		StockID:        state.ID,
		Quantity:       parsed.Quantity,
		Reason:         parsed.Reason,
		Notes:          parsed.Notes,
		UnitCostCents:  parsed.Cost,
		Date:           parsed.Date,
		CreatedBy:      parsed.CreatedBy,
		IdempotencyKey: parsed.IdempotencyKey,
	})
	if err != nil {
		return nil, err
	}
	if replayed {
		return equipStateSnapshot(state), nil
	}
	// The same client key is written onto both the adjustment and the
	// accompanying state-change row (when disposing from damaged/retired).
	// Keys are unique per table, not per operation, so a later /damage or
	// /repair that reuses this key will find the state-change row and
	// silently no-op. Callers must not reuse a key across ledgers.
	// Disposing of damaged or retired units also empties that pool, so the
	// states keep partitioning what is owned.
	if parsed.Quantity < 0 && parsed.From != "serviceable" {
		if _, err := equipInsertStateChange(ctx, tx, equipStateEntry{
			StockID:        state.ID,
			From:           parsed.From,
			To:             "serviceable",
			Quantity:       removed,
			Reason:         "disposed",
			Notes:          parsed.Notes,
			Date:           parsed.Date,
			CreatedBy:      parsed.CreatedBy,
			IdempotencyKey: parsed.IdempotencyKey,
		}); err != nil {
			return nil, err
		}
		if parsed.From == "damaged" {
			state.Damaged -= removed
		} else {
			state.Retired -= removed
		}
	}
	state.TotalOwned += parsed.Quantity
	return equipStateSnapshot(state), nil
}

// POST /equipment/stock/{id}/adjust {quantity, reason, notes?, date?, from?}
// A signed correction to what is owned. Negative adjustments may draw from the
// damaged or retired pools (`from`), which is how written-off equipment finally
// leaves the books.
func (s *Server) equipAdjustStock(w http.ResponseWriter, r *http.Request) {
	parsed, err := equipParseQuantityRequest(r, equipAdjustmentReasons, false)
	if err != nil {
		equipWriteError(w, err)
		return
	}
	s.equipInUOW(w, r, func(ctx context.Context, uow *app.UnitOfWork) (map[string]any, error) {
		cmd := appequipment.Command{Reference: parsed.StockID, Quantity: parsed.Quantity, OccurredAt: parsed.Date, Reason: parsed.Reason, UnitCostCents: parsed.Cost}
		if parsed.Notes != nil {
			cmd.Notes = *parsed.Notes
		}
		if parsed.IdempotencyKey != nil {
			cmd.IdempotencyKey = *parsed.IdempotencyKey
		}
		recorded, err := appequipment.NewService().Adjust(ctx, uow, cmd, parsed.From)
		if err != nil {
			return nil, err
		}
		return equipLedgerSnapshot(ctx, uow, recorded.Operation.Lines[0].Tuple.ItemID)
	})
}

// --- damaged / repaired / retired ---

// equipMoveState validates and records a movement between condition states.
func equipMoveState(
	ctx context.Context,
	tx pgx.Tx,
	parsed equipParsedRequest,
	to string,
) (map[string]any, error) {
	state, err := equipLockStock(ctx, tx, parsed.StockID)
	if err != nil {
		return nil, err
	}
	if _, found, err := equipLookupIdempotent(ctx, tx, "equipment_state_changes", parsed.IdempotencyKey, "stock_id", parsed.StockID); err != nil {
		return nil, err
	} else if found {
		return equipStateSnapshot(state), nil
	}
	if parsed.From == to {
		return nil, equipBadRequest("Equipment is already %s", to)
	}
	switch parsed.From {
	case "serviceable":
		if parsed.Quantity > state.Available() {
			return nil, equipBadRequest(
				"Only %d %s available: cannot mark %d as %s",
				state.Available(), state.TypeName, parsed.Quantity, to)
		}
	case "damaged":
		if parsed.Quantity > state.Damaged {
			return nil, equipBadRequest(
				"Only %d %s are marked damaged", state.Damaged, state.TypeName)
		}
	case "retired":
		if parsed.Quantity > state.Retired {
			return nil, equipBadRequest(
				"Only %d %s are retired", state.Retired, state.TypeName)
		}
	}

	cost := parsed.Cost
	if cost == nil {
		cost = state.UnitCostCents
	}
	replayed, err := equipInsertStateChange(ctx, tx, equipStateEntry{
		StockID:        state.ID,
		From:           parsed.From,
		To:             to,
		Quantity:       parsed.Quantity,
		Reason:         parsed.Reason,
		Notes:          parsed.Notes,
		UnitCostCents:  cost,
		Date:           parsed.Date,
		CreatedBy:      parsed.CreatedBy,
		IdempotencyKey: parsed.IdempotencyKey,
	})
	if err != nil {
		return nil, err
	}
	if replayed {
		return equipStateSnapshot(state), nil
	}

	switch parsed.From {
	case "damaged":
		state.Damaged -= parsed.Quantity
	case "retired":
		state.Retired -= parsed.Quantity
	}
	switch to {
	case "damaged":
		state.Damaged += parsed.Quantity
	case "retired":
		state.Retired += parsed.Quantity
	}
	return equipStateSnapshot(state), nil
}

// POST /equipment/stock/{id}/damage {quantity, reason, notes?, date?}
func (s *Server) equipMarkDamaged(w http.ResponseWriter, r *http.Request) {
	parsed, err := equipParseQuantityRequest(r, equipStateReasons, true)
	if err != nil {
		equipWriteError(w, err)
		return
	}
	if parsed.From != "serviceable" {
		equipWriteError(w, equipBadRequest("Damaged equipment comes from serviceable stock"))
		return
	}
	s.equipConditionHandler(w, r, parsed, "damaged")
}

// POST /equipment/stock/{id}/repair {quantity, reason?, notes?, date?}
func (s *Server) equipRepairStock(w http.ResponseWriter, r *http.Request) {
	parsed, err := equipParseQuantityRequest(r, equipStateReasons, true)
	if err != nil {
		equipWriteError(w, err)
		return
	}
	if parsed.From == "serviceable" {
		parsed.From = "damaged"
	}
	s.equipConditionHandler(w, r, parsed, "serviceable")
}

// POST /equipment/stock/{id}/retire {quantity, reason, from?, notes?, date?}
func (s *Server) equipRetireStock(w http.ResponseWriter, r *http.Request) {
	parsed, err := equipParseQuantityRequest(r, equipStateReasons, true)
	if err != nil {
		equipWriteError(w, err)
		return
	}
	if parsed.From == "retired" {
		equipWriteError(w, equipBadRequest("Equipment is already retired"))
		return
	}
	s.equipConditionHandler(w, r, parsed, "retired")
}

func (s *Server) equipConditionHandler(w http.ResponseWriter, r *http.Request, parsed equipParsedRequest, to string) {
	s.equipInUOW(w, r, func(ctx context.Context, uow *app.UnitOfWork) (map[string]any, error) {
		cmd := appequipment.ConditionCommand{Command: appequipment.Command{Reference: parsed.StockID, Quantity: parsed.Quantity, OccurredAt: parsed.Date, Reason: parsed.Reason, UnitCostCents: parsed.Cost}, From: parsed.From, To: to}
		if parsed.Notes != nil {
			cmd.Notes = *parsed.Notes
		}
		if parsed.IdempotencyKey != nil {
			cmd.IdempotencyKey = *parsed.IdempotencyKey
		}
		recorded, err := appequipment.NewService().ConditionChange(ctx, uow, cmd)
		if err != nil {
			return nil, err
		}
		return equipLedgerSnapshot(ctx, uow, recorded.Operation.Lines[0].Tuple.ItemID)
	})
}

// --- physical count ---

// equipCountLine is one counted shelf quantity.
type equipCountLine struct {
	StockID uuid.UUID
	// CountedQuantity is what the beekeeper physically found in storage, i.e.
	// serviceable units that are not deployed, damaged, or retired.
	CountedQuantity int
	Index           int
}

type equipCountLineResult struct {
	StockID           uuid.UUID `json:"stockId"`
	TypeID            uuid.UUID `json:"typeId"`
	TypeName          string    `json:"typeName"`
	PreviousAvailable int       `json:"previousAvailable"`
	CountedQuantity   int       `json:"countedQuantity"`
	Delta             int       `json:"delta"`
	TotalOwned        int       `json:"totalOwned"`
}

type equipCountLineError struct {
	Index   int     `json:"index"`
	StockID *string `json:"stockId"`
	TypeID  *string `json:"typeId"`
	Message string  `json:"message"`
}

// equipCountRequestLine is one raw counted line as it arrives on the wire.
type equipCountRequestLine struct {
	StockID         *string `json:"stockId"`
	TypeID          *string `json:"typeId"`
	CountedQuantity *int    `json:"countedQuantity"`
}

type equipCountInput struct {
	Lines          []equipCountRequestLine
	Date           time.Time
	Notes          *string
	CreatedBy      *uuid.UUID
	IdempotencyKey *string
}

// equipPhysicalCountTx applies a physical count. It returns per-line results,
// or the list of lines that could not be resolved — in which case it has
// written nothing and the caller must abandon the transaction. Unresolvable
// lines are never skipped in silence, which was the bug in bulk-adjust.
func equipPhysicalCountTx(
	ctx context.Context,
	tx pgx.Tx,
	in equipCountInput,
) ([]equipCountLineResult, []equipCountLineError, error) {
	lines := make([]equipCountLine, 0, len(in.Lines))
	lineErrors := make([]equipCountLineError, 0)
	seen := make(map[uuid.UUID]int, len(in.Lines))

	for index, raw := range in.Lines {
		fail := func(message string) {
			lineErrors = append(lineErrors, equipCountLineError{
				Index: index, StockID: raw.StockID, TypeID: raw.TypeID, Message: message,
			})
		}
		if raw.CountedQuantity == nil {
			fail("Counted quantity is required")
			continue
		}
		if *raw.CountedQuantity < 0 {
			fail("Counted quantity cannot be negative")
			continue
		}

		var stockID uuid.UUID
		switch {
		case raw.StockID != nil && *raw.StockID != "":
			parsed, err := uuid.Parse(*raw.StockID)
			if err != nil {
				fail("Unrecognised stock row")
				continue
			}
			var exists bool
			if err := tx.QueryRow(ctx,
				`SELECT true FROM equipment_stock WHERE id = $1`, parsed).Scan(&exists); err != nil {
				if errors.Is(err, pgx.ErrNoRows) {
					fail("This stock row no longer exists")
					continue
				}
				return nil, nil, err
			}
			stockID = parsed
		case raw.TypeID != nil && *raw.TypeID != "":
			parsed, err := uuid.Parse(*raw.TypeID)
			if err != nil {
				fail("Unrecognised equipment type")
				continue
			}
			if err := tx.QueryRow(ctx,
				`SELECT id FROM equipment_stock WHERE type_id = $1`, parsed).Scan(&stockID); err != nil {
				if errors.Is(err, pgx.ErrNoRows) {
					fail("This equipment type has no stock row to count")
					continue
				}
				return nil, nil, err
			}
		default:
			fail("A stock row or equipment type is required")
			continue
		}

		if first, duplicate := seen[stockID]; duplicate {
			fail("Counted twice (also on line " + strconv.Itoa(first+1) + ")")
			continue
		}
		seen[stockID] = index
		lines = append(lines, equipCountLine{
			StockID:         stockID,
			CountedQuantity: *raw.CountedQuantity,
			Index:           index,
		})
	}

	if len(lineErrors) > 0 {
		return nil, lineErrors, nil
	}

	// Lock in a stable order so two counts running at once cannot deadlock.
	sort.Slice(lines, func(i, j int) bool {
		return lines[i].StockID.String() < lines[j].StockID.String()
	})

	results := make([]equipCountLineResult, 0, len(lines))
	for _, line := range lines {
		state, err := equipLockStock(ctx, tx, line.StockID)
		if err != nil {
			return nil, nil, err
		}
		delta := line.CountedQuantity - state.Available()
		if delta != 0 {
			var lineKey *string
			if in.IdempotencyKey != nil {
				key := *in.IdempotencyKey + ":" + line.StockID.String()
				lineKey = &key
			}
			replayed, err := equipInsertAdjustment(ctx, tx, equipAdjustmentEntry{
				StockID:        state.ID,
				Quantity:       delta,
				Reason:         "physical_count",
				Notes:          in.Notes,
				Date:           in.Date,
				CreatedBy:      in.CreatedBy,
				IdempotencyKey: lineKey,
			})
			if err != nil {
				return nil, nil, err
			}
			if replayed {
				delta = 0
			}
		}
		results = append(results, equipCountLineResult{
			StockID:           state.ID,
			TypeID:            state.TypeID,
			TypeName:          state.TypeName,
			PreviousAvailable: state.Available(),
			CountedQuantity:   line.CountedQuantity,
			Delta:             delta,
			TotalOwned:        state.TotalOwned + delta,
		})
	}
	return results, nil, nil
}

// POST /equipment/physical-count
// {date?, notes?, lines: [{stockId? | typeId?, countedQuantity}]}
//
// The replacement for bulk-adjust. `countedQuantity` is what is physically on
// the shelf (serviceable, not deployed, not damaged, not retired); the server
// computes each signed delta and records it with reason 'physical_count'.
// Nothing is applied unless every line resolves.
func (s *Server) equipPhysicalCount(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Date           *string                 `json:"date"`
		Notes          *string                 `json:"notes"`
		IdempotencyKey *string                 `json:"idempotencyKey"`
		Lines          []equipCountRequestLine `json:"lines"`
	}
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if len(req.Lines) == 0 {
		writeError(w, http.StatusBadRequest, "Count at least one item")
		return
	}
	date := time.Now()
	if d, err := parseDatePtr(req.Date); err != nil {
		writeError(w, http.StatusBadRequest, "invalid date")
		return
	} else if d != nil {
		date = *d
	}

	s.equipInUOW(w, r, func(ctx context.Context, uow *app.UnitOfWork) (map[string]any, error) {
		service := appequipment.NewService()
		seen := map[uuid.UUID]bool{}
		results := make([]equipCountLineResult, 0, len(req.Lines))
		applied := 0
		for index, raw := range req.Lines {
			if raw.CountedQuantity == nil || *raw.CountedQuantity < 0 {
				return nil, app.Invalid("physical count", "line %d has invalid counted quantity", index+1)
			}
			var ref uuid.UUID
			var err error
			if raw.StockID != nil && *raw.StockID != "" {
				ref, err = uuid.Parse(*raw.StockID)
			} else if raw.TypeID != nil && *raw.TypeID != "" {
				ref, err = uuid.Parse(*raw.TypeID)
			} else {
				return nil, app.Invalid("physical count", "line %d requires stockId or typeId", index+1)
			}
			if err != nil {
				return nil, app.Invalid("physical count", "line %d has invalid id", index+1)
			}
			item, err := appequipment.ResolveItem(ctx, uow, ref)
			if err != nil {
				return nil, err
			}
			if seen[item.ItemID] {
				return nil, app.Invalid("physical count", "item %s was counted twice", item.ItemID)
			}
			seen[item.ItemID] = true
			var available int
			if err := uow.QueryRow(ctx, `SELECT COALESCE((SELECT SUM(a.available)::int FROM inventory_available a JOIN inventory_locations l ON l.id=a.location_id WHERE a.item_id=$1 AND l.is_home AND a.condition='serviceable' AND a.container_hive_id IS NULL),0)`, item.ItemID).Scan(&available); err != nil {
				return nil, err
			}
			delta := *raw.CountedQuantity - available
			if delta != 0 {
				key := ""
				if req.IdempotencyKey != nil {
					key = *req.IdempotencyKey + ":" + item.ItemID.String()
				}
				notes := ""
				if req.Notes != nil {
					notes = *req.Notes
				}
				if _, err := service.Adjust(ctx, uow, appequipment.Command{Reference: item.ItemID, Quantity: delta, OccurredAt: date, IdempotencyKey: key, Reason: "count", Notes: notes}, "serviceable"); err != nil {
					return nil, err
				}
				applied++
			}
			results = append(results, equipCountLineResult{StockID: item.ItemID, TypeID: item.TypeID, TypeName: item.Name, PreviousAvailable: available, CountedQuantity: *raw.CountedQuantity, Delta: delta, TotalOwned: available + delta})
		}
		return map[string]any{"counted": len(results), "adjusted": applied, "unchanged": len(results) - applied, "lines": results}, nil
	})
}

// --- loss report ---

// GET /equipment/loss-report?from=&to=
// Damaged, retired, and written-off equipment with its cost, from the single
// equipment_loss_events view so the totals and the event list cannot disagree.
func (s *Server) equipLossReport(w http.ResponseWriter, r *http.Request) {
	query := r.URL.Query()
	fromParam := query.Get("from")
	toParam := query.Get("to")
	var from, to *time.Time
	if fromParam != "" {
		parsed, err := parseDate(fromParam)
		if err != nil {
			writeError(w, http.StatusBadRequest, "invalid from date")
			return
		}
		from = &parsed
	}
	if toParam != "" {
		parsed, err := parseDate(toParam)
		if err != nil {
			writeError(w, http.StatusBadRequest, "invalid to date")
			return
		}
		// Inclusive end-of-day so a date-only filter covers the whole day.
		end := parsed.Add(24 * time.Hour)
		to = &end
	}

	ctx := r.Context()
	type lossTypeRow struct {
		TypeID       uuid.UUID `json:"typeId"`
		TypeName     string    `json:"typeName"`
		TypeCategory string    `json:"typeCategory"`
		Damaged      int       `json:"damaged"`
		Retired      int       `json:"retired"`
		WrittenOff   int       `json:"writtenOff"`
		ValueCents   int       `json:"valueCents"`
	}
	rows, err := s.pool.Query(ctx, `
		WITH events AS (
		 SELECT o.id,i.source_id type_id,et.name type_name,et.category type_category,
		  CASE WHEN o.kind='shrink' THEN 'written_off' ELSE m.condition END kind,
		  abs(m.quantity)::int quantity,COALESCE(et.unit_cost_cents,0)*abs(m.quantity)::int value_cents,o.occurred_at date
		 FROM inventory_operations o JOIN inventory_movements m ON m.operation_id=o.id
		 JOIN inventory_items i ON i.id=m.item_id JOIN equipment_types et ON et.id=i.source_id
		 WHERE (o.kind='condition_change' AND m.quantity>0 AND m.condition IN('damaged','retired')) OR (o.kind='shrink' AND m.quantity<0))
		SELECT type_id,type_name,type_category,
		       COALESCE(SUM(quantity) FILTER(WHERE kind='damaged'),0)::int,
		       COALESCE(SUM(quantity) FILTER(WHERE kind='retired'),0)::int,
		       COALESCE(SUM(quantity) FILTER(WHERE kind='written_off'),0)::int,
		       COALESCE(SUM(value_cents),0)::int
		FROM events WHERE ($1::timestamptz IS NULL OR date >= $1)
		  AND ($2::timestamptz IS NULL OR date < $2)
		GROUP BY type_id, type_name, type_category
		ORDER BY type_category, type_name`, from, to)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	defer rows.Close()

	byType := make([]lossTypeRow, 0)
	totals := lossTypeRow{}
	for rows.Next() {
		var row lossTypeRow
		if err := rows.Scan(&row.TypeID, &row.TypeName, &row.TypeCategory,
			&row.Damaged, &row.Retired, &row.WrittenOff, &row.ValueCents); err != nil {
			writeError(w, http.StatusInternalServerError, "database error")
			return
		}
		totals.Damaged += row.Damaged
		totals.Retired += row.Retired
		totals.WrittenOff += row.WrittenOff
		totals.ValueCents += row.ValueCents
		byType = append(byType, row)
	}
	if rows.Err() != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}

	type lossEventRow struct {
		ID           uuid.UUID `json:"id"`
		StockID      uuid.UUID `json:"stockId"`
		TypeName     string    `json:"typeName"`
		TypeCategory string    `json:"typeCategory"`
		Kind         string    `json:"kind"`
		Quantity     int       `json:"quantity"`
		Reason       string    `json:"reason"`
		Notes        *string   `json:"notes"`
		ValueCents   int       `json:"valueCents"`
		Date         time.Time `json:"date"`
	}
	eventRows, err := s.pool.Query(ctx, `
		SELECT o.id,m.item_id,et.name,et.category,
		       CASE WHEN o.kind='shrink' THEN 'written_off' ELSE m.condition END,
		       abs(m.quantity)::int,o.reason,o.details->>'notes',
		       COALESCE(et.unit_cost_cents,0)*abs(m.quantity)::int,o.occurred_at
		FROM inventory_operations o JOIN inventory_movements m ON m.operation_id=o.id
		JOIN inventory_items i ON i.id=m.item_id JOIN equipment_types et ON et.id=i.source_id
		WHERE ((o.kind='condition_change' AND m.quantity>0 AND m.condition IN('damaged','retired')) OR (o.kind='shrink' AND m.quantity<0))
		  AND ($1::timestamptz IS NULL OR o.occurred_at >= $1)
		  AND ($2::timestamptz IS NULL OR o.occurred_at < $2)
		ORDER BY o.occurred_at DESC
		LIMIT 200`, from, to)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	defer eventRows.Close()

	events := make([]lossEventRow, 0)
	for eventRows.Next() {
		var row lossEventRow
		if err := eventRows.Scan(&row.ID, &row.StockID, &row.TypeName, &row.TypeCategory,
			&row.Kind, &row.Quantity, &row.Reason, &row.Notes, &row.ValueCents,
			&row.Date); err != nil {
			writeError(w, http.StatusInternalServerError, "database error")
			return
		}
		events = append(events, row)
	}
	if eventRows.Err() != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"from": fromParam,
		"to":   toParam,
		"totals": map[string]int{
			"damaged":    totals.Damaged,
			"retired":    totals.Retired,
			"writtenOff": totals.WrittenOff,
			"valueCents": totals.ValueCents,
		},
		"byType": byType,
		"events": events,
	})
}

// GET /equipment/reconciliation — the ledger-versus-column check. Database
// triggers keep these equal; this endpoint is how an operator confirms it.
func (s *Server) equipReconciliation(w http.ResponseWriter, r *http.Request) {
	rows, err := s.pool.Query(r.Context(), `
		WITH raw AS(SELECT m.item_id,SUM(m.quantity)::int total,
		 COALESCE(SUM(m.quantity) FILTER(WHERE m.condition='damaged'),0)::int damaged,
		 COALESCE(SUM(m.quantity) FILTER(WHERE m.condition='retired'),0)::int retired FROM inventory_movements m GROUP BY m.item_id),
		 projected AS(SELECT item_id,SUM(on_hand)::int total,
		 COALESCE(SUM(on_hand) FILTER(WHERE condition='damaged'),0)::int damaged,
		 COALESCE(SUM(on_hand) FILTER(WHERE condition='retired'),0)::int retired FROM inventory_balances GROUP BY item_id)
		SELECT i.id,et.name,COALESCE(p.total,0),COALESCE(r.total,0),
		 COALESCE(p.damaged,0),COALESCE(r.damaged,0),COALESCE(p.retired,0),COALESCE(r.retired,0),
		 COALESCE(p.total,0)=COALESCE(r.total,0) AND COALESCE(p.damaged,0)=COALESCE(r.damaged,0) AND COALESCE(p.retired,0)=COALESCE(r.retired,0)
		FROM inventory_items i JOIN equipment_types et ON et.id=i.source_id
		LEFT JOIN raw r ON r.item_id=i.id LEFT JOIN projected p ON p.item_id=i.id
		WHERE i.source_type IN('equipment_type','equipment_type_frame_drawn','equipment_type_frame_fresh') ORDER BY et.name,i.source_type`)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	defer rows.Close()

	type reconciliationRow struct {
		StockID          uuid.UUID `json:"stockId"`
		TypeName         string    `json:"typeName"`
		TotalOwned       int       `json:"totalOwned"`
		LedgerTotalOwned int       `json:"ledgerTotalOwned"`
		Damaged          int       `json:"damaged"`
		LedgerDamaged    int       `json:"ledgerDamaged"`
		Retired          int       `json:"retired"`
		LedgerRetired    int       `json:"ledgerRetired"`
		Reconciled       bool      `json:"reconciled"`
	}
	out := make([]reconciliationRow, 0)
	drift := 0
	for rows.Next() {
		var row reconciliationRow
		if err := rows.Scan(&row.StockID, &row.TypeName, &row.TotalOwned,
			&row.LedgerTotalOwned, &row.Damaged, &row.LedgerDamaged, &row.Retired,
			&row.LedgerRetired, &row.Reconciled); err != nil {
			writeError(w, http.StatusInternalServerError, "database error")
			return
		}
		if !row.Reconciled {
			drift++
		}
		out = append(out, row)
	}
	if rows.Err() != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"reconciled":   drift == 0,
		"driftedRows":  drift,
		"stockRows":    out,
		"checkedCount": len(out),
	})
}
