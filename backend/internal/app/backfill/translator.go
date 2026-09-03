package backfill

import (
	"context"
	"errors"
	"fmt"
	"math"
	"sort"
	"strings"
	"time"

	"github.com/biker2000on/beez-trackz/backend/internal/app"
	"github.com/biker2000on/beez-trackz/backend/internal/app/inventory"
	"github.com/biker2000on/beez-trackz/backend/internal/app/inventory/build"
	"github.com/biker2000on/beez-trackz/backend/internal/app/production"
	"github.com/biker2000on/beez-trackz/backend/internal/app/sales"
	"github.com/google/uuid"
)

type catalogLookup struct {
	home                              uuid.UUID
	jarItems, productItems, locations map[uuid.UUID]uuid.UUID
	bulkLots, propolisLots, batchLots map[uuid.UUID]uuid.UUID
	jarLots                           map[string]uuid.UUID
	unassigned                        map[uuid.UUID]uuid.UUID
}

func preloadCatalog(ctx context.Context, q app.Querier) (*catalogLookup, error) {
	c := &catalogLookup{
		jarItems: map[uuid.UUID]uuid.UUID{}, productItems: map[uuid.UUID]uuid.UUID{},
		locations: map[uuid.UUID]uuid.UUID{}, bulkLots: map[uuid.UUID]uuid.UUID{},
		propolisLots: map[uuid.UUID]uuid.UUID{}, batchLots: map[uuid.UUID]uuid.UUID{},
		jarLots: map[string]uuid.UUID{}, unassigned: map[uuid.UUID]uuid.UUID{},
	}
	if id, err := production.HomeLocationID(ctx, q); err != nil {
		return nil, err
	} else {
		c.home = id
	}
	type sourceRow struct {
		source, id uuid.UUID
		sourceType string
	}
	rows, err := q.Query(ctx, `SELECT source_type,source_id,id FROM inventory_items WHERE source_id IS NOT NULL ORDER BY source_type,source_id`)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var r sourceRow
		if err := rows.Scan(&r.sourceType, &r.source, &r.id); err != nil {
			rows.Close()
			return nil, err
		}
		switch r.sourceType {
		case "jar_size":
			c.jarItems[r.source] = r.id
		case "product_catalog":
			c.productItems[r.source] = r.id
		}
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}
	rows, err = q.Query(ctx, `SELECT source_id,id FROM inventory_locations WHERE source_type='stock_location' ORDER BY source_id`)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var source, id uuid.UUID
		if err := rows.Scan(&source, &id); err != nil {
			rows.Close()
			return nil, err
		}
		c.locations[source] = id
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}
	homeSourceIDs, err := queryIDs(ctx, q, `SELECT id FROM stock_locations WHERE is_home`)
	if err != nil {
		return nil, err
	}
	for _, id := range homeSourceIDs {
		c.locations[id] = c.home
	}
	rows, err = q.Query(ctx, `SELECT item_id,source_type,source_id,id,is_legacy_unassigned FROM inventory_lots ORDER BY item_id,id`)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var item, id uuid.UUID
		var sourceType *string
		var sourceID *uuid.UUID
		var unassigned bool
		if err := rows.Scan(&item, &sourceType, &sourceID, &id, &unassigned); err != nil {
			rows.Close()
			return nil, err
		}
		if unassigned {
			c.unassigned[item] = id
		}
		if sourceType == nil || sourceID == nil {
			continue
		}
		switch *sourceType {
		case "harvest_lot":
			if item == production.HoneyBulkItemID {
				c.bulkLots[*sourceID] = id
			} else {
				c.jarLots[item.String()+":"+sourceID.String()] = id
			}
		case "propolis_harvest":
			c.propolisLots[*sourceID] = id
		case "product_batch":
			c.batchLots[*sourceID] = id
		}
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return c, nil
}

func (c *catalogLookup) location(id *uuid.UUID) (uuid.UUID, error) {
	if id == nil {
		return c.home, nil
	}
	v, ok := c.locations[*id]
	if !ok {
		return uuid.Nil, fmt.Errorf("stock location %s was not preloaded", *id)
	}
	return v, nil
}
func (c *catalogLookup) jarLot(item uuid.UUID, harvest *uuid.UUID) (uuid.UUID, error) {
	if harvest == nil {
		return c.unassigned[item], nil
	}
	v, ok := c.jarLots[item.String()+":"+harvest.String()]
	if !ok {
		return uuid.Nil, fmt.Errorf("jar lot for item %s harvest %s was not preloaded", item, *harvest)
	}
	return v, nil
}

type translator struct {
	uow       *app.UnitOfWork
	catalog   *catalogLookup
	inventory *inventory.Service
	report    *Report
	honeyOps  map[uuid.UUID]inventory.Operation
	stockOps  map[uuid.UUID]inventory.Operation
}

func newTranslator(uow *app.UnitOfWork, c *catalogLookup, r *Report) *translator {
	return &translator{uow: uow, catalog: c, inventory: inventory.NewService(), report: r, honeyOps: map[uuid.UUID]inventory.Operation{}, stockOps: map[uuid.UUID]inventory.Operation{}}
}

func (t *translator) base(table, sourceType string, id uuid.UUID, at time.Time, reason, provenance string, details map[string]any) build.Base {
	legacyType := strings.TrimSuffix(table, "s")
	return build.Base{ID: uuid.New(), OccurredAt: at.UTC(), IdempotencyKey: legacyKey(table, id), SourceType: sourceType, SourceID: id, Reason: reason, Actor: t.uow.Actor(), Details: details, Provenance: provenance, LegacyRefType: &legacyType, LegacyRefID: &id}
}
func (t *translator) record(ctx context.Context, op inventory.Operation) (inventory.Operation, error) {
	rec, err := t.inventory.Record(ctx, t.uow, op)
	if err != nil {
		return inventory.Operation{}, err
	}
	if !rec.Existing {
		t.report.Operations++
	}
	return rec.Operation, nil
}
func movement(item, location, lot uuid.UUID, quantity string, scale int) inventory.Movement {
	return inventory.Movement{Tuple: inventory.Tuple{ItemID: item, LocationID: location, LotID: &lot}, Quantity: quantity, QuantityScale: scale}
}

func (t *translator) harvestReceipts(ctx context.Context) error {
	type row struct {
		id     uuid.UUID
		lot    *uuid.UUID
		at     time.Time
		amount float64
	}
	rows, err := t.uow.Query(ctx, `SELECT h.id,link.lot_id,h.date,h.calculated_honey_weight FROM honey_harvests h LEFT JOIN harvest_lot_harvests link ON link.harvest_id=h.id WHERE h.deleted_at IS NULL ORDER BY h.date,h.created_at,h.id,link.lot_id`)
	if err != nil {
		return err
	}
	var all []row
	for rows.Next() {
		var r row
		if err := rows.Scan(&r.id, &r.lot, &r.at, &r.amount); err != nil {
			rows.Close()
			return err
		}
		all = append(all, r)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return err
	}
	seen := map[uuid.UUID]int{}
	for _, r := range all {
		if r.amount <= 0 {
			continue
		}
		lot := t.catalog.unassigned[production.HoneyBulkItemID]
		if r.lot != nil {
			var ok bool
			lot, ok = t.catalog.bulkLots[*r.lot]
			if !ok {
				return fmt.Errorf("harvest %s references unpreloaded lot %s", r.id, *r.lot)
			}
		}
		index := seen[r.id]
		seen[r.id]++
		base := t.base("honey_harvests", "honey_harvest", r.id, r.at, production.ReasonNone, "legacy-import", map[string]any{"link_index": index})
		base.LegacyRefType = nil
		base.LegacyRefID = nil
		base.IdempotencyKey = fmt.Sprintf("legacy:honey_harvests:%s:lot:%s", r.id, lot)
		op, err := build.Receive(build.SingleParams{Base: base, Line: movement(production.HoneyBulkItemID, t.catalog.home, lot, production.Pounds(r.amount), production.MassScale)})
		if err != nil {
			return err
		}
		if _, err = t.record(ctx, op); err != nil {
			return fmt.Errorf("translate harvest %s: %w", r.id, err)
		}
	}
	return nil
}

func (t *translator) honeyMovements(ctx context.Context) error {
	type row struct {
		id                uuid.UUID
		at                time.Time
		kind              string
		amount            *float64
		jar               *uuid.UUID
		qty               *int
		reason, notes     *string
		run, lot, reverse *uuid.UUID
		batch             *uuid.UUID
	}
	rows, err := t.uow.Query(ctx, `SELECT id,date,kind::text,amount_lbs,jar_size_id,quantity,reason,notes,bottling_run_id,lot_id,reverses_movement_id,product_batch_id FROM honey_movements ORDER BY created_at,id`)
	if err != nil {
		return err
	}
	var all []row
	for rows.Next() {
		var r row
		if err := rows.Scan(&r.id, &r.at, &r.kind, &r.amount, &r.jar, &r.qty, &r.reason, &r.notes, &r.run, &r.lot, &r.reverse, &r.batch); err != nil {
			rows.Close()
			return err
		}
		all = append(all, r)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return err
	}
	for _, r := range all {
		// The product batch transform folds in these legacy input rows. Writing
		// them as standalone shrinks as well would consume the same honey twice.
		if r.batch != nil {
			continue
		}
		details := map[string]any{}
		if r.reason != nil && *r.reason != "" {
			details["legacy_reason"] = *r.reason
		}
		if r.notes != nil && *r.notes != "" {
			details["notes"] = *r.notes
		}
		base := t.base("honey_movements", "honey_movement", r.id, r.at, production.ReasonNone, "legacy-unattributed", details)
		if r.reverse != nil {
			original, ok := t.honeyOps[*r.reverse]
			if !ok {
				return app.Precondition("translate honey reversal", "referenced movement %s has not been translated", *r.reverse)
			}
			op, err := build.Reversal(base, original)
			if err != nil {
				return err
			}
			recorded, err := t.record(ctx, op)
			if err != nil {
				return fmt.Errorf("translate honey reversal %s: %w", r.id, err)
			}
			t.honeyOps[r.id] = recorded
			continue
		}
		var op inventory.Operation
		switch r.kind {
		case "jarring":
			if r.jar == nil || r.qty == nil || r.amount == nil {
				return app.Precondition("translate jarring", "movement %s is incomplete", r.id)
			}
			item, ok := t.catalog.jarItems[*r.jar]
			if !ok {
				return fmt.Errorf("jar item %s was not preloaded", *r.jar)
			}
			bulkLot := t.catalog.unassigned[production.HoneyBulkItemID]
			if r.lot != nil {
				bulkLot = t.catalog.bulkLots[*r.lot]
			}
			jarLot, err := t.catalog.jarLot(item, r.lot)
			if err != nil {
				return err
			}
			input := movement(production.HoneyBulkItemID, t.catalog.home, bulkLot, production.Negate(production.Pounds(math.Abs(*r.amount))), production.MassScale)
			output := movement(item, t.catalog.home, jarLot, production.Quantity(abs(*r.qty)), production.CountScale)
			op, err = build.BottlingTransform(build.TransformParams{Base: base, Inputs: []inventory.Movement{input}, Outputs: []inventory.Movement{output}})
			if err != nil {
				return err
			}
		case "bulk_use", "loss":
			if r.amount == nil {
				return app.Precondition("translate bulk draw", "movement %s has no amount", r.id)
			}
			lot := t.catalog.unassigned[production.HoneyBulkItemID]
			if r.lot != nil {
				lot = t.catalog.bulkLots[*r.lot]
			}
			reason := production.ReasonNone
			if r.kind == "loss" {
				reason = production.ReasonLoss
			} else if r.reason != nil && strings.Contains(strings.ToLower(*r.reason), "feed") {
				reason = production.ReasonFeeding
			}
			base.Reason = reason
			var e error
			op, e = build.Shrink(build.SingleParams{Base: base, Line: movement(production.HoneyBulkItemID, t.catalog.home, lot, production.Negate(production.Pounds(math.Abs(*r.amount))), production.MassScale)})
			if e != nil {
				return e
			}
		case "give_away", "jar_adjustment":
			if r.jar == nil || r.qty == nil {
				return app.Precondition("translate jar movement", "movement %s is incomplete", r.id)
			}
			item := t.catalog.jarItems[*r.jar]
			delta := *r.qty
			if r.kind == "give_away" {
				delta = -abs(delta)
			}
			lines, err := t.jarAdjustmentLines(ctx, item, delta)
			if err != nil {
				return err
			}
			if len(lines) == 0 {
				continue
			}
			if r.kind == "give_away" {
				base.Reason = production.ReasonGiveAway
				op, err = build.Shrink(build.SingleParams{Base: base, Line: lines[0]})
			} else {
				base.Reason = production.ReasonCount
				op, err = build.CountAdjust(build.SingleParams{Base: base, Line: lines[0]})
			}
			if err != nil {
				return err
			}
			op.Lines = lines
		default:
			return app.Precondition("translate honey movement", "unsupported kind %q", r.kind)
		}
		recorded, err := t.record(ctx, op)
		if err != nil {
			return fmt.Errorf("translate honey movement %s: %w", r.id, err)
		}
		t.honeyOps[r.id] = recorded
	}
	return nil
}

func (t *translator) jarAdjustmentLines(ctx context.Context, item uuid.UUID, delta int) ([]inventory.Movement, error) {
	if delta > 0 {
		lot := t.catalog.unassigned[item]
		return []inventory.Movement{movement(item, t.catalog.home, lot, production.Quantity(delta), production.CountScale)}, nil
	}
	alloc, _, err := production.AllocateFIFO(ctx, t.uow, "inventory_balances", item, t.catalog.home, -delta, nil)
	if err != nil {
		return nil, err
	}
	out := make([]inventory.Movement, 0, len(alloc))
	for _, a := range alloc {
		out = append(out, movement(item, t.catalog.home, a.LotID, production.Negate(production.Quantity(a.Quantity)), production.CountScale))
	}
	return out, nil
}

func (t *translator) products(ctx context.Context) error {
	// Receipts precede transforms so tincture inputs are available.
	type propRow struct {
		id    uuid.UUID
		at    time.Time
		grams float64
	}
	rows, err := t.uow.Query(ctx, `SELECT id,date,amount_grams FROM propolis_harvests WHERE deleted_at IS NULL ORDER BY date,created_at,id`)
	if err != nil {
		return err
	}
	var props []propRow
	for rows.Next() {
		var r propRow
		if err := rows.Scan(&r.id, &r.at, &r.grams); err != nil {
			rows.Close()
			return err
		}
		props = append(props, r)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return err
	}
	for _, r := range props {
		base := t.base("propolis_harvests", "propolis_harvest", r.id, r.at, production.ReasonNone, "legacy-import", nil)
		op, err := build.Receive(build.SingleParams{Base: base, Line: movement(production.PropolisItemID, t.catalog.home, t.catalog.propolisLots[r.id], production.Pounds(r.grams), production.MassScale)})
		if err != nil {
			return err
		}
		if _, err = t.record(ctx, op); err != nil {
			return fmt.Errorf("translate propolis harvest %s: %w", r.id, err)
		}
	}
	type batchRow struct {
		id, product     uuid.UUID
		harvest, prop   *uuid.UUID
		at              time.Time
		honey, grams    *float64
		qty             int
		voided          *time.Time
		notes           *string
		inputMovement   *uuid.UUID
		reverseMovement *uuid.UUID
	}
	rows, err = t.uow.Query(ctx, `SELECT pb.id,pb.product_id,pb.harvest_lot_id,pb.propolis_harvest_id,pb.started_at,pb.honey_lbs,pb.propolis_amount_grams,pb.quantity_out,pb.voided_at,pb.notes,
		(SELECT id FROM honey_movements m WHERE m.product_batch_id=pb.id AND m.reverses_movement_id IS NULL ORDER BY m.created_at,m.id LIMIT 1),
		(SELECT id FROM honey_movements m WHERE m.product_batch_id=pb.id AND m.reverses_movement_id IS NOT NULL ORDER BY m.created_at,m.id LIMIT 1)
		FROM product_batches pb ORDER BY pb.started_at,pb.created_at,pb.id`)
	if err != nil {
		return err
	}
	var batches []batchRow
	for rows.Next() {
		var r batchRow
		if err := rows.Scan(&r.id, &r.product, &r.harvest, &r.prop, &r.at, &r.honey, &r.grams, &r.qty, &r.voided, &r.notes, &r.inputMovement, &r.reverseMovement); err != nil {
			rows.Close()
			return err
		}
		batches = append(batches, r)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return err
	}
	for _, r := range batches {
		item := t.catalog.productItems[r.product]
		details := map[string]any{}
		if r.notes != nil {
			details["notes"] = *r.notes
		}
		base := t.base("product_batches", "product_batch", r.id, r.at, production.ReasonNone, "legacy-import", details)
		if r.inputMovement != nil {
			legacyType := "honey_movement"
			base.LegacyRefType, base.LegacyRefID = &legacyType, r.inputMovement
			details["legacy_honey_movement_id"] = r.inputMovement.String()
		}
		inputs := []inventory.Movement{}
		if r.honey != nil && *r.honey > 0 {
			lot := t.catalog.unassigned[production.HoneyBulkItemID]
			if r.harvest != nil {
				lot = t.catalog.bulkLots[*r.harvest]
			}
			inputs = append(inputs, movement(production.HoneyBulkItemID, t.catalog.home, lot, production.Negate(production.Pounds(*r.honey)), production.MassScale))
		}
		if r.grams != nil && *r.grams > 0 {
			if r.prop == nil {
				return app.Precondition("translate product batch", "batch %s has propolis amount without harvest", r.id)
			}
			inputs = append(inputs, movement(production.PropolisItemID, t.catalog.home, t.catalog.propolisLots[*r.prop], production.Negate(production.Pounds(*r.grams)), production.MassScale))
		}
		output := movement(item, t.catalog.home, t.catalog.batchLots[r.id], production.Quantity(r.qty), production.CountScale)
		var op inventory.Operation
		if len(inputs) == 0 {
			op, err = build.Receive(build.SingleParams{Base: base, Line: output})
		} else {
			op, err = build.BatchTransform(build.TransformParams{Base: base, Inputs: inputs, Outputs: []inventory.Movement{output}})
		}
		if err != nil {
			return err
		}
		recorded, err := t.record(ctx, op)
		if err != nil {
			return fmt.Errorf("translate product batch %s: %w", r.id, err)
		}
		if r.voided != nil {
			revBase := t.base("product_batches_void", "product_batch", r.id, *r.voided, production.ReasonNone, "legacy-import", map[string]any{"void": true})
			revBase.IdempotencyKey = legacyKey("product_batches", r.id) + ":void"
			if r.reverseMovement != nil {
				legacyType := "honey_movement"
				revBase.LegacyRefType, revBase.LegacyRefID = &legacyType, r.reverseMovement
			} else {
				revBase.LegacyRefType = nil
				revBase.LegacyRefID = nil
			}
			rev, err := build.Reversal(revBase, recorded)
			if err != nil {
				return err
			}
			if _, err = t.record(ctx, rev); err != nil {
				return fmt.Errorf("translate voided product batch %s: %w", r.id, err)
			}
		}
	}
	type adjustRow struct {
		id, product   uuid.UUID
		location      *uuid.UUID
		at            time.Time
		delta         int
		reason, notes *string
	}
	rows, err = t.uow.Query(ctx, `SELECT id,product_id,location_id,date,delta,reason,notes FROM product_adjustments WHERE deleted_at IS NULL ORDER BY date,created_at,id`)
	if err != nil {
		return err
	}
	var adjustments []adjustRow
	for rows.Next() {
		var r adjustRow
		if err := rows.Scan(&r.id, &r.product, &r.location, &r.at, &r.delta, &r.reason, &r.notes); err != nil {
			rows.Close()
			return err
		}
		adjustments = append(adjustments, r)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return err
	}
	for _, r := range adjustments {
		loc, err := t.catalog.location(r.location)
		if err != nil {
			return err
		}
		item := t.catalog.productItems[r.product]
		details := map[string]any{}
		if r.reason != nil {
			details["legacy_reason"] = *r.reason
		}
		if r.notes != nil {
			details["notes"] = *r.notes
		}
		base := t.base("product_adjustments", "product_adjustment", r.id, r.at, production.ReasonCount, "legacy-import", details)
		lines, err := t.countLines(ctx, item, loc, r.delta, nil)
		if err != nil {
			return err
		}
		op, err := build.CountAdjust(build.SingleParams{Base: base, Line: lines[0]})
		if err != nil {
			return err
		}
		op.Lines = lines
		if _, err = t.record(ctx, op); err != nil {
			return fmt.Errorf("translate product adjustment %s: %w", r.id, err)
		}
	}
	return nil
}

func (t *translator) countLines(ctx context.Context, item, location uuid.UUID, delta int, preferred *uuid.UUID) ([]inventory.Movement, error) {
	if delta > 0 {
		lot := t.catalog.unassigned[item]
		return []inventory.Movement{movement(item, location, lot, production.Quantity(delta), production.CountScale)}, nil
	}
	alloc, _, err := production.AllocateFIFO(ctx, t.uow, "inventory_balances", item, location, -delta, preferred)
	if err != nil {
		return nil, err
	}
	out := make([]inventory.Movement, 0, len(alloc))
	for _, a := range alloc {
		out = append(out, movement(item, location, a.LotID, production.Negate(production.Quantity(a.Quantity)), production.CountScale))
	}
	return out, nil
}

type stockRow struct {
	id                      uuid.UUID
	at                      time.Time
	kind                    string
	location, counter       *uuid.UUID
	transfer                *uuid.UUID
	jar, product            *uuid.UUID
	qty                     int
	harvest, batch, reverse *uuid.UUID
	reason, notes           *string
}

func (t *translator) stockMovements(ctx context.Context) error {
	rows, err := t.uow.Query(ctx, `SELECT id,date,kind,location_id,counterparty_location_id,transfer_id,jar_size_id,product_id,quantity,harvest_lot_id,product_batch_id,reverses_movement_id,reason,notes FROM stock_movements ORDER BY date,created_at,id`)
	if err != nil {
		return err
	}
	var all []stockRow
	for rows.Next() {
		var r stockRow
		if err := rows.Scan(&r.id, &r.at, &r.kind, &r.location, &r.counter, &r.transfer, &r.jar, &r.product, &r.qty, &r.harvest, &r.batch, &r.reverse, &r.reason, &r.notes); err != nil {
			rows.Close()
			return err
		}
		all = append(all, r)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return err
	}
	byTransfer := map[uuid.UUID][]stockRow{}
	for _, r := range all {
		if r.transfer != nil {
			byTransfer[*r.transfer] = append(byTransfer[*r.transfer], r)
		}
	}
	done := map[uuid.UUID]bool{}
	for _, r := range all {
		if done[r.id] {
			continue
		}
		if r.transfer != nil {
			group := byTransfer[*r.transfer]
			for _, g := range group {
				done[g.id] = true
			}
			if err := t.stockPair(ctx, group); err != nil {
				return err
			}
			continue
		}
		done[r.id] = true
		if err := t.stockAdjustment(ctx, r); err != nil {
			return err
		}
	}
	return nil
}

func (t *translator) stockItem(r stockRow) (uuid.UUID, *uuid.UUID, error) {
	if r.jar != nil {
		item := t.catalog.jarItems[*r.jar]
		lot, err := t.catalog.jarLot(item, r.harvest)
		return item, &lot, err
	}
	if r.product != nil {
		item := t.catalog.productItems[*r.product]
		if r.batch != nil {
			lot := t.catalog.batchLots[*r.batch]
			return item, &lot, nil
		}
		return item, nil, nil
	}
	return uuid.Nil, nil, errors.New("stock movement has no SKU")
}
func (t *translator) stockPair(ctx context.Context, group []stockRow) error {
	if len(group) < 2 {
		return app.Precondition("translate stock transfer", "transfer %s does not have both sides", *group[0].transfer)
	}
	sort.Slice(group, func(i, j int) bool { return group[i].qty < group[j].qty })
	neg, pos := group[0], group[len(group)-1]
	if neg.reverse != nil || pos.reverse != nil {
		var original inventory.Operation
		var ok bool
		if neg.reverse != nil {
			original, ok = t.stockOps[*neg.reverse]
		}
		if !ok && pos.reverse != nil {
			original, ok = t.stockOps[*pos.reverse]
		}
		if !ok {
			return app.Precondition("translate stock reversal", "referenced stock movement was not translated")
		}
		base := t.stockBase(group, pos.at, production.ReasonNone)
		op, err := build.Reversal(base, original)
		if err != nil {
			return err
		}
		rec, err := t.record(ctx, op)
		if err != nil {
			return err
		}
		for _, r := range group {
			t.stockOps[r.id] = rec
		}
		return nil
	}
	item, preferred, err := t.stockItem(pos)
	if err != nil {
		return err
	}
	from, err := t.catalog.location(neg.location)
	if err != nil {
		return err
	}
	to, err := t.catalog.location(pos.location)
	if err != nil {
		return err
	}
	alloc, _, err := production.AllocateFIFO(ctx, t.uow, "inventory_balances", item, from, pos.qty, preferred)
	if err != nil {
		return err
	}
	base := t.stockBase(group, pos.at, production.ReasonNone)
	var lines []inventory.Movement
	var op inventory.Operation
	for i, a := range alloc {
		p, err := build.Transfer(build.TransferParams{Base: base, From: inventory.Tuple{ItemID: item, LocationID: from, LotID: &a.LotID}, To: inventory.Tuple{ItemID: item, LocationID: to, LotID: &a.LotID}, Quantity: production.Quantity(a.Quantity), QuantityScale: production.CountScale})
		if err != nil {
			return err
		}
		if i == 0 {
			op = p
		}
		lines = append(lines, p.Lines...)
	}
	if strings.EqualFold(pos.kind, "return") {
		p, err := build.Return(build.TransferParams{Base: base, From: lines[0].Tuple, To: lines[1].Tuple, Quantity: production.Quantity(alloc[0].Quantity), QuantityScale: production.CountScale})
		if err != nil {
			return err
		}
		op = p
	}
	op.Lines = lines
	rec, err := t.record(ctx, op)
	if err != nil {
		return fmt.Errorf("translate stock transfer %s: %w", *pos.transfer, err)
	}
	for _, r := range group {
		t.stockOps[r.id] = rec
	}
	return nil
}
func (t *translator) stockBase(group []stockRow, at time.Time, reason string) build.Base {
	ids := make([]string, 0, len(group))
	for _, r := range group {
		ids = append(ids, r.id.String())
	}
	sort.Strings(ids)
	base := t.base("stock_movements", "stock_movement", group[0].id, at, reason, "legacy-import", map[string]any{"legacy_movement_ids": ids})
	base.IdempotencyKey = "legacy:stock_transfer:" + group[0].transfer.String()
	return base
}
func (t *translator) stockAdjustment(ctx context.Context, r stockRow) error {
	item, preferred, err := t.stockItem(r)
	if err != nil {
		return err
	}
	loc, err := t.catalog.location(r.location)
	if err != nil {
		return err
	}
	details := map[string]any{}
	if r.reason != nil {
		details["legacy_reason"] = *r.reason
	}
	if r.notes != nil {
		details["notes"] = *r.notes
	}
	base := t.base("stock_movements", "stock_movement", r.id, r.at, production.ReasonCount, "legacy-import", details)
	lines, err := t.countLines(ctx, item, loc, r.qty, preferred)
	if err != nil {
		return err
	}
	var op inventory.Operation
	if r.qty < 0 {
		base.Reason = production.ReasonSettled
		op, err = build.Shrink(build.SingleParams{Base: base, Line: lines[0]})
	} else {
		op, err = build.CountAdjust(build.SingleParams{Base: base, Line: lines[0]})
	}
	if err != nil {
		return err
	}
	op.Lines = lines
	rec, err := t.record(ctx, op)
	if err != nil {
		return fmt.Errorf("translate stock adjustment %s: %w", r.id, err)
	}
	t.stockOps[r.id] = rec
	return nil
}

func (t *translator) sales(ctx context.Context) error {
	type saleRow struct {
		id       uuid.UUID
		at       time.Time
		location *uuid.UUID
	}
	rows, err := t.uow.Query(ctx, `SELECT id,date,stock_location_id FROM sales WHERE physical_applied_at IS NOT NULL AND order_status<>'cancelled' ORDER BY physical_applied_at,created_at,id`)
	if err != nil {
		return err
	}
	var all []saleRow
	for rows.Next() {
		var r saleRow
		if err := rows.Scan(&r.id, &r.at, &r.location); err != nil {
			rows.Close()
			return err
		}
		all = append(all, r)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return err
	}
	for _, r := range all {
		location, err := t.catalog.location(r.location)
		if err != nil {
			return err
		}
		saleLines, err := sales.LoadLines(ctx, t.uow, r.id)
		if err != nil {
			return err
		}
		var lines []inventory.Movement
		inferred := false
		for _, line := range saleLines {
			switch {
			case line.Kind == sales.KindJar && line.JarSizeID != nil:
				item := t.catalog.jarItems[*line.JarSizeID]
				var preferred *uuid.UUID
				if line.BottlingRunID != nil {
					var harvest uuid.UUID
					if err := t.uow.QueryRow(ctx, `SELECT lot_id FROM bottling_runs WHERE id=$1`, *line.BottlingRunID).Scan(&harvest); err != nil {
						return err
					}
					lot, e := t.catalog.jarLot(item, &harvest)
					if e != nil {
						return e
					}
					preferred = &lot
				}
				alloc, method, e := production.AllocateFIFO(ctx, t.uow, "inventory_balances", item, location, line.Quantity, preferred)
				if e != nil {
					return e
				}
				inferred = inferred || method == production.MethodFIFOInferred
				for _, a := range alloc {
					lines = append(lines, movement(item, location, a.LotID, production.Negate(production.Quantity(a.Quantity)), production.CountScale))
				}
			case line.Kind == sales.KindPropolis && line.NetGrams != nil:
				drawn, e := t.propolisDraw(ctx, location, *line.NetGrams*float64(line.Quantity))
				if e != nil {
					return e
				}
				lines = append(lines, drawn...)
				inferred = true
			case line.ProductID != nil && line.Kind != sales.KindEquipment:
				item := t.catalog.productItems[*line.ProductID]
				alloc, method, e := production.AllocateFIFO(ctx, t.uow, "inventory_balances", item, location, line.Quantity, line.LotID)
				if e != nil {
					return e
				}
				inferred = inferred || method == production.MethodFIFOInferred
				for _, a := range alloc {
					lines = append(lines, movement(item, location, a.LotID, production.Negate(production.Quantity(a.Quantity)), production.CountScale))
				}
			}
		}
		if len(lines) == 0 {
			continue
		}
		method := production.MethodRecorded
		if inferred {
			method = production.MethodFIFOInferred
		}
		base := build.Base{ID: uuid.New(), OccurredAt: r.at.UTC(), IdempotencyKey: legacyKey("sales", r.id) + ":consume", SourceType: "sale", SourceID: r.id, Reason: production.ReasonNone, Actor: t.uow.Actor(), Details: map[string]any{"lot_allocation": map[string]any{"method": method}}, Provenance: "legacy-import"}
		op, err := build.SaleConsume(build.SingleParams{Base: base, Line: lines[0]})
		if err != nil {
			return err
		}
		for _, line := range lines[1:] {
			if _, err := build.SaleConsume(build.SingleParams{Base: base, Line: line}); err != nil {
				return err
			}
		}
		op.Lines = lines
		if _, err = t.record(ctx, op); err != nil {
			return fmt.Errorf("translate sale %s: %w", r.id, err)
		}
	}
	return nil
}
func (t *translator) propolisDraw(ctx context.Context, location uuid.UUID, grams float64) ([]inventory.Movement, error) {
	lots, err := production.LotsFIFO(ctx, t.uow, "inventory_balances", production.PropolisItemID, location)
	if err != nil {
		return nil, err
	}
	remaining := grams
	var out []inventory.Movement
	for _, lot := range lots {
		if remaining <= .0001 {
			break
		}
		available, _ := lot.OnHand.Float64()
		take := math.Min(available, remaining)
		if take <= .0001 {
			continue
		}
		out = append(out, movement(production.PropolisItemID, location, lot.LotID, production.Negate(production.Pounds(take)), production.MassScale))
		remaining -= take
	}
	if remaining > .0001 {
		return nil, app.Precondition("translate propolis sale", "%.4f grams are unavailable", remaining)
	}
	return out, nil
}

func (t *translator) residualSplits(ctx context.Context) error {
	var desired, current float64
	err := t.uow.QueryRow(ctx, `WITH global_honey AS (SELECT (SELECT COALESCE(SUM(session_lbs),0) FROM(SELECT COALESCE(NULLIF(hs.total_extracted_weight,0),(SELECT COALESCE(SUM(hh.calculated_honey_weight),0) FROM honey_harvests hh WHERE hh.session_id=hs.id AND hh.deleted_at IS NULL)) session_lbs FROM harvest_sessions hs)s)+(SELECT COALESCE(SUM(calculated_honey_weight),0) FROM honey_harvests WHERE session_id IS NULL AND deleted_at IS NULL) total) SELECT total-COALESCE((SELECT SUM(honey_weight_lbs) FROM harvest_lots),0)-COALESCE((SELECT SUM(amount_lbs) FROM honey_movements WHERE lot_id IS NULL AND kind IN('jarring','bulk_use','loss')),0) FROM global_honey`).Scan(&desired)
	if err != nil {
		return err
	}
	lot := t.catalog.unassigned[production.HoneyBulkItemID]
	if err := t.uow.QueryRow(ctx, `SELECT COALESCE((SELECT on_hand FROM inventory_balances WHERE item_id=$1 AND location_id=$2 AND lot_id=$3),0)::float8`, production.HoneyBulkItemID, t.catalog.home, lot).Scan(&current); err != nil {
		return err
	}
	delta := desired - current
	if delta < -0.0001 {
		return app.Precondition("backfill inventory ledger", "negative unassigned bulk residual %.4f", delta)
	}
	if delta > .0001 {
		var at time.Time
		if err := t.uow.QueryRow(ctx, `SELECT COALESCE(MIN(date),now()) FROM honey_harvests WHERE deleted_at IS NULL`).Scan(&at); err != nil {
			return err
		}
		if err := t.opening(ctx, "unassigned_bulk", uuid.Nil, production.HoneyBulkItemID, lot, production.Pounds(delta), production.MassScale, at); err != nil {
			return err
		}
	}
	if err := t.countResiduals(ctx, "home_jar", `WITH global AS (SELECT js.id source_id,COALESCE(m.jarred,0)+COALESCE(m.adjusted,0)-COALESCE(si.sold,0)-COALESCE(m.given,0) desired FROM jar_sizes js LEFT JOIN(SELECT jar_size_id,SUM(quantity)FILTER(WHERE kind='jarring')jarred,SUM(quantity)FILTER(WHERE kind='jar_adjustment')adjusted,SUM(quantity)FILTER(WHERE kind='give_away')given FROM honey_movements GROUP BY jar_size_id)m ON m.jar_size_id=js.id LEFT JOIN(SELECT si.jar_size_id,SUM(si.quantity)sold FROM sale_items si JOIN sales s ON s.id=si.sale_id WHERE s.order_status<>'cancelled' AND si.jar_size_id IS NOT NULL GROUP BY si.jar_size_id)si ON si.jar_size_id=js.id),away AS(SELECT jar_size_id,SUM(qty)qty FROM(SELECT location_id,jar_size_id,quantity qty FROM stock_movements WHERE jar_size_id IS NOT NULL UNION ALL SELECT s.stock_location_id,si.jar_size_id,-si.quantity FROM sale_items si JOIN sales s ON s.id=si.sale_id WHERE s.order_status<>'cancelled' AND s.stock_location_id IS NOT NULL AND si.jar_size_id IS NOT NULL)x WHERE location_id NOT IN(SELECT id FROM stock_locations WHERE is_home)GROUP BY jar_size_id)SELECT g.source_id,(g.desired-COALESCE(a.qty,0))::int FROM global g LEFT JOIN away a ON a.jar_size_id=g.source_id ORDER BY g.source_id`, t.catalog.jarItems); err != nil {
		return err
	}
	return t.countResiduals(ctx, "home_product", `WITH global AS(SELECT p.id source_id,COALESCE(b.made,0)+COALESCE(a.adjusted,0)-COALESCE(s.sold,0)desired FROM product_catalog p LEFT JOIN(SELECT product_id,SUM(quantity_out)made FROM product_batches WHERE voided_at IS NULL GROUP BY product_id)b ON b.product_id=p.id LEFT JOIN(SELECT product_id,SUM(delta)adjusted FROM product_adjustments WHERE deleted_at IS NULL GROUP BY product_id)a ON a.product_id=p.id LEFT JOIN(SELECT si.product_id,SUM(si.quantity)sold FROM sale_items si JOIN sales sale ON sale.id=si.sale_id WHERE sale.order_status<>'cancelled' AND si.product_id IS NOT NULL GROUP BY si.product_id)s ON s.product_id=p.id),away AS(SELECT product_id,SUM(qty)qty FROM(SELECT location_id,product_id,quantity qty FROM stock_movements WHERE product_id IS NOT NULL UNION ALL SELECT s.stock_location_id,si.product_id,-si.quantity FROM sale_items si JOIN sales s ON s.id=si.sale_id WHERE s.order_status<>'cancelled' AND s.stock_location_id IS NOT NULL AND si.product_id IS NOT NULL)x WHERE location_id NOT IN(SELECT id FROM stock_locations WHERE is_home)GROUP BY product_id)SELECT g.source_id,(g.desired-COALESCE(a.qty,0))::int FROM global g LEFT JOIN away a ON a.product_id=g.source_id ORDER BY g.source_id`, t.catalog.productItems)
}
func (t *translator) countResiduals(ctx context.Context, domain, query string, items map[uuid.UUID]uuid.UUID) error {
	rows, err := t.uow.Query(ctx, query)
	if err != nil {
		return err
	}
	type r struct {
		source  uuid.UUID
		desired int
	}
	var all []r
	for rows.Next() {
		var x r
		if err := rows.Scan(&x.source, &x.desired); err != nil {
			rows.Close()
			return err
		}
		all = append(all, x)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return err
	}
	for _, x := range all {
		item := items[x.source]
		var current int
		if err := t.uow.QueryRow(ctx, `SELECT COALESCE(SUM(available),0)::int FROM inventory_available WHERE item_id=$1 AND location_id=$2`, item, t.catalog.home).Scan(&current); err != nil {
			return err
		}
		delta := x.desired - current
		if delta < 0 {
			return app.Precondition("backfill inventory ledger", "%s %s has negative residual %d", domain, x.source, delta)
		}
		if delta == 0 {
			continue
		}
		if err := t.opening(ctx, domain, x.source, item, t.catalog.unassigned[item], production.Quantity(delta), production.CountScale, time.Unix(0, 0).UTC()); err != nil {
			return err
		}
	}
	return nil
}
func (t *translator) opening(ctx context.Context, domain string, source, item, lot uuid.UUID, amount string, scale int, at time.Time) error {
	id := source
	if id == uuid.Nil {
		id = production.HoneyBulkItemID
	}
	base := build.Base{ID: uuid.New(), OccurredAt: at, IdempotencyKey: "legacy:residual:" + domain + ":" + id.String(), SourceType: "legacy_residual", SourceID: id, Reason: production.ReasonNone, Actor: t.uow.Actor(), Details: map[string]any{"reason": "home-residual-split"}, Provenance: "legacy-import"}
	op, err := build.OpeningBalance(build.SingleParams{Base: base, Line: movement(item, t.catalog.home, lot, amount, scale)})
	if err != nil {
		return err
	}
	rec, err := t.record(ctx, op)
	if err != nil {
		return err
	}
	t.report.ResidualSplits = append(t.report.ResidualSplits, ResidualSplit{Domain: domain, SourceID: source, Amount: amount, OperationID: rec.ID})
	return nil
}

func (t *translator) linkSaleReservations(ctx context.Context) error {
	service := sales.New()
	rows, err := t.uow.Query(ctx, `SELECT id,stock_location_id FROM sales WHERE physical_applied_at IS NULL AND order_status<>'cancelled' ORDER BY id`)
	if err != nil {
		return err
	}
	type r struct {
		id       uuid.UUID
		location *uuid.UUID
	}
	var all []r
	for rows.Next() {
		var x r
		if err := rows.Scan(&x.id, &x.location); err != nil {
			rows.Close()
			return err
		}
		all = append(all, x)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return err
	}
	for _, x := range all {
		loc, err := t.catalog.location(x.location)
		if err != nil {
			return err
		}
		if err := service.LinkLines(ctx, t.uow, x.id, loc); err != nil {
			return err
		}
	}
	return nil
}

func abs(v int) int {
	if v < 0 {
		return -v
	}
	return v
}
