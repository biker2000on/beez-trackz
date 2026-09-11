package httpapi

import (
	"context"
	"encoding/json"
	"github.com/biker2000on/beez-trackz/backend/internal/app"
	"github.com/google/uuid"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/biker2000on/beez-trackz/backend/internal/app/production"
	"github.com/biker2000on/beez-trackz/backend/internal/app/sales"
	"github.com/go-chi/chi/v5"
)

func (s *Server) mountWorkbenches(r chi.Router) {
	r.Get("/stock", s.atlasStock)
	r.Get("/stock/{id}", s.atlasStock)
	r.With(s.requireAdmin).Post("/sales/{id}/payment", s.atlasPayment)
	r.With(s.requireAdmin).Post("/sales/{id}/fulfill", s.atlasFulfill)
	r.Get("/production/workbench", s.productionWorkbench)
	r.Get("/sales/workbench", s.salesWorkbench)
}

func workbenchYear(r *http.Request) (int, error) {
	year := time.Now().UTC().Year()
	raw := r.URL.Query().Get("year")
	if raw == "" {
		return year, nil
	}
	return strconv.Atoi(raw)
}

func (s *Server) productionWorkbench(w http.ResponseWriter, r *http.Request) {
	year, err := workbenchYear(r)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid year")
		return
	}
	// Memberships already ride on the principal (requireSession loads them once).
	view, err := production.Workbench(r.Context(), s.pool, appActor(r), year, time.Now().UTC(), offlineRoutes.supports)
	if err != nil {
		writeCommandError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, view)
}
func (s *Server) salesWorkbench(w http.ResponseWriter, r *http.Request) {
	year, err := workbenchYear(r)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid year")
		return
	}
	view, err := sales.Workbench(r.Context(), s.pool, appActor(r), year, time.Now().UTC(), offlineRoutes.supports)
	if err != nil {
		writeCommandError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, view)
}

// atlasStock returns individual ledger tuples. Decimal text prevents rounding
// and absence of movements is not asserted to be a known physical zero.
func (s *Server) atlasStock(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	actor := appActor(r)
	editorOptions := false
	if !actor.MayAdminister() || q.Get("apiaryId") != "" {
		apiaryID, err := uuid.Parse(q.Get("apiaryId"))
		if err != nil || !actor.MayEditApiary(apiaryID) || q.Get("kind") != "equipment" {
			writeError(w, 403, "apiary editor access and equipment scope are required")
			return
		}
		editorOptions = true
	}
	item := q.Get("itemId")
	if id := chi.URLParam(r, "id"); id != "" {
		item = id
	}
	for _, value := range []string{item, q.Get("locationId"), q.Get("lotId"), q.Get("hiveId"), q.Get("harvestLotId")} {
		if value != "" && value != "any" && value != "null" {
			if _, err := uuid.Parse(value); err != nil {
				writeError(w, 400, "invalid stock dimension")
				return
			}
		}
	}
	kind := q.Get("kind")
	if kind == "bulk_honey" {
		kind = "honey_bulk"
	}
	rows, err := s.pool.Query(r.Context(), `SELECT i.id,i.name,i.kind,i.canonical_unit,l.id,l.name,a.lot_id,lot.code,a.condition,a.container_hive_id, CASE WHEN lot.source_type='harvest_lot' THEN lot.source_id ELSE (SELECT pb.harvest_lot_id FROM product_batches pb WHERE pb.inventory_lot_id=lot.id LIMIT 1) END,
 COALESCE(a.on_hand,0)::text,COALESCE(a.reserved,0)::text,COALESCE(a.available,0)::text,
 EXISTS(SELECT 1 FROM inventory_movements m WHERE m.item_id=a.item_id AND m.location_id=a.location_id AND m.lot_id IS NOT DISTINCT FROM a.lot_id AND m.condition IS NOT DISTINCT FROM a.condition AND m.container_hive_id IS NOT DISTINCT FROM a.container_hive_id),
 (NOT i.lot_tracked OR (lot.source_id IS NOT NULL AND NOT lot.is_legacy_unassigned)),
 COALESCE((SELECT jsonb_agg(jsonb_build_object('kind','treatment','reason',CASE WHEN t.date_removed IS NULL THEN 'Treatment remains on source hive: '||t.product ELSE 'Withdrawal period for '||t.product END,'until',CASE WHEN t.date_removed IS NOT NULL THEN (t.date_removed::date+t.withdrawal_days) END))
 FROM harvest_lot_harvests lhh JOIN honey_harvests h ON h.id=lhh.harvest_id AND h.deleted_at IS NULL
 JOIN treatment_events t ON t.hive_id=h.hive_id AND t.deleted_at IS NULL AND t.date_applied::date<=h.date::date
 WHERE lhh.lot_id=CASE WHEN lot.source_type='harvest_lot' THEN lot.source_id ELSE (SELECT pb.harvest_lot_id FROM product_batches pb WHERE pb.inventory_lot_id=lot.id LIMIT 1) END
 AND (t.date_removed IS NULL OR CURRENT_DATE<(t.date_removed::date+t.withdrawal_days))), '[]'::jsonb),
 (i.kind NOT IN ('honey_bulk','jar','catalog_product') OR EXISTS(SELECT 1 FROM harvest_lot_harvests lhh JOIN honey_harvests h ON h.id=lhh.harvest_id AND h.deleted_at IS NULL WHERE lhh.lot_id=CASE WHEN lot.source_type='harvest_lot' THEN lot.source_id ELSE (SELECT pb.harvest_lot_id FROM product_batches pb WHERE pb.inventory_lot_id=lot.id LIMIT 1) END))
 FROM inventory_items i LEFT JOIN inventory_available a ON i.id=a.item_id JOIN inventory_locations l ON l.id=COALESCE(a.location_id,(SELECT id FROM inventory_locations WHERE is_home)) LEFT JOIN inventory_lots lot ON lot.id=a.lot_id
 WHERE ($1='' OR i.kind=$1) AND ($2 IN ('','any') OR i.id::text=$2)
 AND ($3 IN ('','any') OR COALESCE(l.id::text,'null')=$3)
 AND ($4 IN ('','any') OR COALESCE(a.lot_id::text,'null')=$4)
 AND ($5 IN ('','any') OR COALESCE(a.condition,'null')=$5)
 AND ($6 IN ('','any') OR COALESCE(a.container_hive_id::text,'null')=$6)
 AND ($8 IN ('','any') OR COALESCE((CASE WHEN lot.source_type='harvest_lot' THEN lot.source_id ELSE (SELECT pb.harvest_lot_id FROM product_batches pb WHERE pb.inventory_lot_id=lot.id LIMIT 1) END)::text,'null')=$8)
 AND (NOT $7 OR (l.is_home AND a.condition='serviceable' AND a.container_hive_id IS NULL))
 ORDER BY i.name,l.name,lot.code,a.condition`, kind, item, q.Get("locationId"), q.Get("lotId"), q.Get("condition"), q.Get("hiveId"), editorOptions, q.Get("harvestLotId"))
	if err != nil {
		writeCommandError(w, app.Internal("read stock", err))
		return
	}
	out := []map[string]any{}
	for rows.Next() {
		var itemID, locationID uuid.UUID
		var name, k, unit, location string
		var lotID, hiveID, harvestLotID *uuid.UUID
		var lotCode, condition *string
		var onHand, reserved, available string
		var countKnown, originKnown, holdsKnown bool
		var holds json.RawMessage
		if err := rows.Scan(&itemID, &name, &k, &unit, &locationID, &location, &lotID, &lotCode, &condition, &hiveID, &harvestLotID, &onHand, &reserved, &available, &countKnown, &originKnown, &holds, &holdsKnown); err != nil {
			rows.Close()
			writeCommandError(w, app.Internal("read stock", err))
			return
		}
		out = append(out, map[string]any{"itemId": itemID, "itemName": name, "kind": k, "unit": unit, "locationId": locationID, "locationName": location, "lotId": lotID, "lotCode": lotCode, "condition": condition, "hiveId": hiveID, "harvestLotId": harvestLotID, "onHand": onHand, "reserved": reserved, "available": available, "countKnown": countKnown, "originKnown": originKnown, "holds": holds, "holdsKnown": holdsKnown})
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		writeCommandError(w, app.Internal("read stock", err))
		return
	}
	result := map[string]any{"asOf": time.Now().UTC(), "freshness": map[string]any{"origin": "server", "stale": false}, "rows": out}
	if chi.URLParam(r, "id") != "" && !editorOptions {
		history := []map[string]any{}
		hr, err := s.pool.Query(r.Context(), `SELECT o.id,o.kind,o.reason,o.occurred_at,o.source_type,o.source_id,m.quantity::text,m.location_id,m.lot_id,m.condition,m.container_hive_id,CASE WHEN lot.source_type='harvest_lot' THEN lot.source_id ELSE (SELECT pb.harvest_lot_id FROM product_batches pb WHERE pb.inventory_lot_id=lot.id LIMIT 1) END FROM inventory_movements m JOIN inventory_operations o ON o.id=m.operation_id LEFT JOIN inventory_lots lot ON lot.id=m.lot_id WHERE m.item_id::text=$1
 AND ($2 IN ('','any') OR m.location_id::text=$2)
 AND ($3 IN ('','any') OR COALESCE(m.lot_id::text,'null')=$3)
 AND ($4 IN ('','any') OR COALESCE(m.condition,'null')=$4)
 AND ($5 IN ('','any') OR COALESCE(m.container_hive_id::text,'null')=$5)
 AND ($6 IN ('','any') OR COALESCE((CASE WHEN lot.source_type='harvest_lot' THEN lot.source_id ELSE (SELECT pb.harvest_lot_id FROM product_batches pb WHERE pb.inventory_lot_id=lot.id LIMIT 1) END)::text,'null')=$6)
 ORDER BY o.occurred_at DESC,o.id,m.line_no LIMIT 200`, item, q.Get("locationId"), q.Get("lotId"), q.Get("condition"), q.Get("hiveId"), q.Get("harvestLotId"))
		if err != nil {
			writeCommandError(w, app.Internal("read stock history", err))
			return
		}
		for hr.Next() {
			var id, sourceID, locationID uuid.UUID
			var kind, reason, source, quantity string
			var at time.Time
			var lot, hive, harvestLot *uuid.UUID
			var condition *string
			if err := hr.Scan(&id, &kind, &reason, &at, &source, &sourceID, &quantity, &locationID, &lot, &condition, &hive, &harvestLot); err != nil {
				hr.Close()
				writeCommandError(w, app.Internal("read stock history", err))
				return
			}
			history = append(history, map[string]any{"operationId": id, "kind": kind, "reason": reason, "occurredAt": at, "sourceType": source, "sourceId": sourceID, "quantity": quantity, "locationId": locationID, "lotId": lot, "condition": condition, "hiveId": hive, "harvestLotId": harvestLot})
		}
		err = hr.Err()
		hr.Close()
		if err != nil {
			writeCommandError(w, app.Internal("read stock history", err))
			return
		}
		result["history"] = history
	}
	writeJSON(w, 200, result)
}

func (s *Server) atlasPayment(w http.ResponseWriter, r *http.Request) {
	id, err := uuidParam(r, "id")
	if err != nil {
		writeError(w, 400, "invalid sale")
		return
	}
	var req struct {
		AmountPaidCents *int64  `json:"amountPaidCents"`
		PaymentMethod   *string `json:"paymentMethod"`
	}
	if decodeJSON(r, &req) != nil || req.AmountPaidCents == nil {
		writeError(w, 400, "amountPaidCents is required")
		return
	}
	if req.PaymentMethod != nil {
		v := strings.TrimSpace(*req.PaymentMethod)
		req.PaymentMethod = &v
	}
	var result sales.FactResult
	err = app.NewRunner(s.pool).Run(r.Context(), appActor(r), func(ctx context.Context, uow *app.UnitOfWork) error {
		var e error
		result, e = sales.RecordPayment(ctx, uow, id, *req.AmountPaidCents, req.PaymentMethod)
		return e
	})
	if err != nil {
		writeCommandError(w, err)
		return
	}
	writeJSON(w, 200, result)
}
func (s *Server) atlasFulfill(w http.ResponseWriter, r *http.Request) {
	id, err := uuidParam(r, "id")
	if err != nil {
		writeError(w, 400, "invalid sale")
		return
	}
	var result sales.FactResult
	err = app.NewRunner(s.pool).Run(r.Context(), appActor(r), func(ctx context.Context, uow *app.UnitOfWork) error {
		var e error
		result, e = sales.Fulfill(ctx, uow, id)
		return e
	})
	if err != nil {
		writeCommandError(w, err)
		return
	}
	writeJSON(w, 200, result)
}
