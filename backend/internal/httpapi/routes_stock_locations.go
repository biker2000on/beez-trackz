package httpapi

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

// Stock locations: finished goods that live somewhere other than home.
//
// The bike shop sells jars on the operator's behalf and pays as they sell, so
// handing them 24 jars is neither a sale nor shrink. It is a TRANSFER: stock
// moves, revenue does not. The jars stay the operator's inventory but stop
// being available at market day, and when the shop reports "we sold 9, here is
// $X" that report is an ordinary sale — location-scoped, channel consignment,
// with the money a receivable until it lands.
//
// Nothing here is a second ledger. Quantities derive from the same
// honey_movements / sale_items spine plus stock_movements, and home is the
// residual (see honey_ledger.go and migration 00024). The three rules the
// roadmap set out are enforced in exactly one place each:
//
//   - never recognise revenue on a transfer  -> stockTransfer writes movements
//     and nothing else; no sale row, no money column is touched.
//   - never let home stock-validation count consigned jars -> honeyLockJarSizes
//     subtracts stockAwayJarTotals.
//   - every movement idempotent and reversible -> stock_movements carries a
//     unique idempotency_key and a reverses_movement_id whose negation nets the
//     pair to zero, exactly like honey_movements.

func (s *Server) mountStockLocations(r chi.Router) {
	admin := r.With(s.requireAdmin)
	admin.Get("/stock-locations", s.stockLocationList)
	admin.Post("/stock-locations", s.stockLocationCreate)
	// Static segment before {id}; chi prefers it, but keeping the noun
	// distinct also keeps the URL readable.
	admin.Get("/stock-locations/inventory", s.stockInventoryHandler)
	admin.Get("/stock-locations/{id}", s.stockLocationDetail)
	admin.Patch("/stock-locations/{id}", s.stockLocationUpdate)
	// Soft-deletes; refuses while stock is still standing there.
	admin.Delete("/stock-locations/{id}", s.stockLocationDelete)

	admin.Post("/stock-locations/{id}/sales", s.stockLocationSaleCreate)
	admin.Post("/stock-locations/{id}/transfers", s.stockTransferCreate)
	admin.Post("/stock-locations/{id}/returns", s.stockReturnCreate)
	// Reverses rather than deletes, like /honey/movements/{id}.
	admin.Delete("/stock-movements/{id}", s.stockMovementReverse)

	admin.Get("/stock-locations/{id}/settlement", s.stockSettlementPreview)
	admin.Get("/stock-locations/{id}/settlements", s.stockSettlementList)
	admin.Post("/stock-locations/{id}/settlements", s.stockSettlementCreate)
	admin.Post("/consignment-settlements/{id}/void", s.stockSettlementVoid)
}

// --- shared vocabulary -----------------------------------------------------

var (
	stockPriceBases = map[string]bool{
		"retail": true, "commission": true, "wholesale_list": true,
	}
	stockCadences = map[string]bool{
		"weekly": true, "biweekly": true, "monthly": true,
		"quarterly": true, "on_request": true,
	}
	stockSlugCleaner = regexp.MustCompile(`[^a-z0-9]+`)
)

const stockBasisPointsPerUnit = 10_000

func stockSlug(value string) string {
	slug := stockSlugCleaner.ReplaceAllString(strings.ToLower(strings.TrimSpace(value)), "-")
	return strings.Trim(slug, "-")
}

func stockBadRequest(format string, args ...any) error {
	return equipBadRequest(format, args...)
}

// --- location rows ---------------------------------------------------------

type stockLocationRow struct {
	ID                     uuid.UUID  `json:"id"`
	Name                   string     `json:"name"`
	Slug                   string     `json:"slug"`
	IsHome                 bool       `json:"isHome"`
	IsConsignment          bool       `json:"isConsignment"`
	CustomerID             *uuid.UUID `json:"customerId"`
	CustomerName           *string    `json:"customerName"`
	PriceBasis             string     `json:"priceBasis"`
	CommissionBps          *int       `json:"commissionBps"`
	WholesalePriceListID   *uuid.UUID `json:"wholesalePriceListId"`
	WholesalePriceListName *string    `json:"wholesalePriceListName"`
	SettlementCadence      string     `json:"settlementCadence"`
	Address                *string    `json:"address"`
	Notes                  *string    `json:"notes"`
	IsActive               bool       `json:"isActive"`
	CreatedAt              time.Time  `json:"createdAt"`
	UpdatedAt              time.Time  `json:"updatedAt"`
	// Units of finished goods standing here right now. Home is the residual.
	OnHandUnits int `json:"onHandUnits"`
	// Money invoiced to this location that has not been collected yet.
	OutstandingBalance money `json:"outstandingBalance"`
}

const stockLocationSelect = `
	SELECT l.id, l.name, l.slug, l.is_home, l.is_consignment, l.customer_id, c.name,
	       l.price_basis, l.commission_bps, l.wholesale_price_list_id, w.name,
	       l.settlement_cadence, l.address, l.notes, l.is_active, l.created_at, l.updated_at
	FROM stock_locations l
	LEFT JOIN customers c ON c.id = l.customer_id
	LEFT JOIN wholesale_price_lists w ON w.id = l.wholesale_price_list_id`

func stockScanLocations(rows pgx.Rows) ([]stockLocationRow, error) {
	defer rows.Close()
	out := make([]stockLocationRow, 0)
	for rows.Next() {
		var row stockLocationRow
		if err := rows.Scan(&row.ID, &row.Name, &row.Slug, &row.IsHome, &row.IsConsignment,
			&row.CustomerID, &row.CustomerName, &row.PriceBasis, &row.CommissionBps,
			&row.WholesalePriceListID, &row.WholesalePriceListName, &row.SettlementCadence,
			&row.Address, &row.Notes, &row.IsActive, &row.CreatedAt, &row.UpdatedAt); err != nil {
			return nil, err
		}
		out = append(out, row)
	}
	return out, rows.Err()
}

// stockLoadLocations reads live locations and decorates each with what is
// standing there and what is still owed on it.
func (s *Server) stockLoadLocations(
	ctx context.Context,
	where string,
	args ...any,
) ([]stockLocationRow, error) {
	rows, err := s.pool.Query(ctx, stockLocationSelect+" "+where, args...)
	if err != nil {
		return nil, err
	}
	locations, err := stockScanLocations(rows)
	if err != nil {
		return nil, err
	}
	if len(locations) == 0 {
		return locations, nil
	}

	quantities, err := stockAwayQuantities(ctx, s.pool)
	if err != nil {
		return nil, err
	}
	units := make(map[uuid.UUID]int, len(quantities))
	awayTotal := 0
	for _, row := range quantities {
		units[row.LocationID] += row.Quantity
		awayTotal += row.Quantity
	}

	// Home holds everything the away locations do not.
	globalUnits, err := stockGlobalUnits(ctx, s.pool)
	if err != nil {
		return nil, err
	}

	balances, err := stockOutstandingByLocation(ctx, s.pool)
	if err != nil {
		return nil, err
	}
	for i := range locations {
		if locations[i].IsHome {
			locations[i].OnHandUnits = globalUnits - awayTotal
		} else {
			locations[i].OnHandUnits = units[locations[i].ID]
		}
		locations[i].OutstandingBalance = balances[locations[i].ID]
	}
	return locations, nil
}

// stockGlobalUnits is every finished-goods unit that exists anywhere. It reads
// the two canonical inventory formulas rather than re-deriving them, so the
// home residual can never disagree with /honey/inventory or /products.
func stockGlobalUnits(ctx context.Context, q inspectionQuerier) (int, error) {
	jars, err := honeyJarInventoryWithQuerier(ctx, q)
	if err != nil {
		return 0, err
	}
	total := 0
	for _, row := range jars {
		total += row.OnHand
	}
	products, err := productInventoryQuery(ctx, q)
	if err != nil {
		return 0, err
	}
	for _, row := range products {
		total += row.OnHand
	}
	return total, nil
}

// stockOutstandingByLocation is invoiced minus collected per location, using
// the sale columns that already carry both — consignment needs no payment
// table of its own.
func stockOutstandingByLocation(
	ctx context.Context,
	q inspectionQuerier,
) (map[uuid.UUID]money, error) {
	rows, err := q.Query(ctx, `
		SELECT stock_location_id,
		       COALESCE(SUM(total_amount_cents - amount_paid_cents), 0)
		FROM sales
		WHERE stock_location_id IS NOT NULL AND order_status <> 'cancelled'
		GROUP BY 1`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make(map[uuid.UUID]money)
	for rows.Next() {
		var id uuid.UUID
		var balance money
		if err := rows.Scan(&id, &balance); err != nil {
			return nil, err
		}
		out[id] = balance
	}
	return out, rows.Err()
}

// GET /stock-locations
func (s *Server) stockLocationList(w http.ResponseWriter, r *http.Request) {
	if _, err := stockHomeLocationID(r.Context(), s.pool); err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	locations, err := s.stockLoadLocations(r.Context(),
		`WHERE l.deleted_at IS NULL ORDER BY l.is_home DESC, lower(l.name)`)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	writeJSON(w, http.StatusOK, locations)
}

type stockLocationPayload struct {
	Name                 string     `json:"name"`
	Slug                 *string    `json:"slug"`
	IsConsignment        bool       `json:"isConsignment"`
	CustomerID           *uuid.UUID `json:"customerId"`
	PriceBasis           string     `json:"priceBasis"`
	CommissionPercent    *float64   `json:"commissionPercent"`
	WholesalePriceListID *uuid.UUID `json:"wholesalePriceListId"`
	SettlementCadence    string     `json:"settlementCadence"`
	Address              *string    `json:"address"`
	Notes                *string    `json:"notes"`
	IsActive             *bool      `json:"isActive"`
}

// stockCommissionBps converts a percent from the wire into basis points. The
// commission split then stays exact integer arithmetic all the way to cents,
// so 30% of $12.00 is 360 cents and never 359.99999.
func stockCommissionBps(percent *float64) (*int, error) {
	if percent == nil {
		return nil, nil
	}
	value := *percent
	if value < 0 || value > 100 {
		return nil, stockBadRequest("commissionPercent must be between 0 and 100")
	}
	bps := int(dollarsToCents(value))
	return &bps, nil
}

func (payload *stockLocationPayload) normalize() error {
	payload.Name = strings.TrimSpace(payload.Name)
	if payload.Name == "" {
		return stockBadRequest("Name is required")
	}
	if payload.PriceBasis == "" {
		payload.PriceBasis = "retail"
	}
	if payload.SettlementCadence == "" {
		payload.SettlementCadence = "monthly"
	}
	if !stockPriceBases[payload.PriceBasis] {
		return stockBadRequest("invalid priceBasis")
	}
	if !stockCadences[payload.SettlementCadence] {
		return stockBadRequest("invalid settlementCadence")
	}
	if payload.PriceBasis == "commission" && payload.CommissionPercent == nil {
		return stockBadRequest("commissionPercent is required for the commission basis")
	}
	if payload.PriceBasis == "wholesale_list" && payload.WholesalePriceListID == nil {
		return stockBadRequest("wholesalePriceListId is required for the wholesale basis")
	}
	return nil
}

// POST /stock-locations
func (s *Server) stockLocationCreate(w http.ResponseWriter, r *http.Request) {
	var payload stockLocationPayload
	if err := decodeJSON(r, &payload); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if err := payload.normalize(); err != nil {
		equipWriteError(w, err)
		return
	}
	bps, err := stockCommissionBps(payload.CommissionPercent)
	if err != nil {
		equipWriteError(w, err)
		return
	}
	slug := stockSlug(payload.Name)
	if payload.Slug != nil && stockSlug(*payload.Slug) != "" {
		slug = stockSlug(*payload.Slug)
	}
	if slug == "" || slug == stockHomeSlug {
		writeError(w, http.StatusBadRequest, "slug must be unique and cannot be 'home'")
		return
	}
	isActive := true
	if payload.IsActive != nil {
		isActive = *payload.IsActive
	}

	var id uuid.UUID
	if err := s.pool.QueryRow(r.Context(), `
		INSERT INTO stock_locations
			(name, slug, is_consignment, customer_id, price_basis, commission_bps,
			 wholesale_price_list_id, settlement_cadence, address, notes, is_active, created_by)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
		RETURNING id`,
		payload.Name, slug, payload.IsConsignment, payload.CustomerID, payload.PriceBasis,
		bps, payload.WholesalePriceListID, payload.SettlementCadence,
		inspectionTrimPtr(payload.Address), inspectionTrimPtr(payload.Notes),
		isActive, actorID(r)).Scan(&id); err != nil {
		writeDBError(w, err, "a location with that name already exists",
			"invalid customer or wholesale price list")
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"success": true, "id": id, "slug": slug})
}

// PATCH /stock-locations/{id}
func (s *Server) stockLocationUpdate(w http.ResponseWriter, r *http.Request) {
	id, err := uuidParam(r, "id")
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	var payload stockLocationPayload
	if err := decodeJSON(r, &payload); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if err := payload.normalize(); err != nil {
		equipWriteError(w, err)
		return
	}
	bps, err := stockCommissionBps(payload.CommissionPercent)
	if err != nil {
		equipWriteError(w, err)
		return
	}
	isActive := true
	if payload.IsActive != nil {
		isActive = *payload.IsActive
	}
	// Home cannot become a consignment location: its stock is the operator's
	// own by definition, and the database CHECK says so too.
	tag, err := s.pool.Exec(r.Context(), `
		UPDATE stock_locations
		SET name=$2, is_consignment=$3, customer_id=$4, price_basis=$5, commission_bps=$6,
		    wholesale_price_list_id=$7, settlement_cadence=$8, address=$9, notes=$10,
		    is_active=$11
		WHERE id=$1 AND deleted_at IS NULL AND NOT is_home`,
		id, payload.Name, payload.IsConsignment, payload.CustomerID, payload.PriceBasis,
		bps, payload.WholesalePriceListID, payload.SettlementCadence,
		inspectionTrimPtr(payload.Address), inspectionTrimPtr(payload.Notes), isActive)
	if err != nil {
		writeDBError(w, err, "a location with that name already exists",
			"invalid customer or wholesale price list")
		return
	}
	if tag.RowsAffected() == 0 {
		writeError(w, http.StatusNotFound, "location not found, or home cannot be edited")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"success": true, "id": id})
}

// DELETE /stock-locations/{id} — soft delete. Stock still standing there has
// to come home first: deleting the row would strand the jars in a place the
// inventory can no longer name, and home would silently absorb them.
func (s *Server) stockLocationDelete(w http.ResponseWriter, r *http.Request) {
	id, err := uuidParam(r, "id")
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	ctx := r.Context()
	onHand, _, err := s.stockLocationShelf(ctx, s.pool, id)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	units := 0
	for _, row := range onHand {
		units += row.OnHand
	}
	if units != 0 {
		writeError(w, http.StatusConflict, fmt.Sprintf(
			"%d units are still at this location. Return or settle them first.", units))
		return
	}
	tag, err := s.pool.Exec(ctx, `
		UPDATE stock_locations SET deleted_at=now(), deleted_by=$2, is_active=false
		WHERE id=$1 AND deleted_at IS NULL AND NOT is_home`, id, actorID(r))
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	if tag.RowsAffected() == 0 {
		writeError(w, http.StatusNotFound, "location not found, or home cannot be deleted")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"success": true, "id": id})
}

// --- shelves ---------------------------------------------------------------

// stockShelfRow is one finished-goods SKU standing at one location.
type stockShelfRow struct {
	JarSizeID *uuid.UUID `json:"jarSizeId"`
	ProductID *uuid.UUID `json:"productId"`
	Label     string     `json:"label"`
	Kind      string     `json:"kind"`
	UnitPrice *money     `json:"unitPrice"`
	OnHand    int        `json:"onHand"`
}

func (row stockShelfRow) key() string {
	if row.JarSizeID != nil {
		return "jar:" + row.JarSizeID.String()
	}
	if row.ProductID != nil {
		return "product:" + row.ProductID.String()
	}
	return ""
}

// stockSKUCatalog is every finished SKU that can travel, with its label and
// list price, so quantities can be reported without a join per row.
type stockSKUCatalog struct {
	JarLabels    map[uuid.UUID]string
	JarPrices    map[uuid.UUID]*money
	JarOrder     []uuid.UUID
	ProductNames map[uuid.UUID]string
	ProductKinds map[uuid.UUID]string
	ProductPrice map[uuid.UUID]money
	ProductOrder []uuid.UUID
}

func stockLoadSKUs(ctx context.Context, q inspectionQuerier) (stockSKUCatalog, error) {
	catalog := stockSKUCatalog{
		JarLabels:    map[uuid.UUID]string{},
		JarPrices:    map[uuid.UUID]*money{},
		ProductNames: map[uuid.UUID]string{},
		ProductKinds: map[uuid.UUID]string{},
		ProductPrice: map[uuid.UUID]money{},
	}
	rows, err := q.Query(ctx, `
		SELECT id, label, default_price_cents FROM jar_sizes ORDER BY sort_order, label`)
	if err != nil {
		return catalog, err
	}
	for rows.Next() {
		var id uuid.UUID
		var label string
		var price *money
		if err := rows.Scan(&id, &label, &price); err != nil {
			rows.Close()
			return catalog, err
		}
		catalog.JarLabels[id] = label
		catalog.JarPrices[id] = price
		catalog.JarOrder = append(catalog.JarOrder, id)
	}
	jarErr := rows.Err()
	rows.Close()
	if jarErr != nil {
		return catalog, jarErr
	}

	productRows, err := q.Query(ctx, `
		SELECT id, name, size_label, kind, default_price_cents
		FROM product_catalog ORDER BY lower(name), size_label NULLS FIRST`)
	if err != nil {
		return catalog, err
	}
	defer productRows.Close()
	for productRows.Next() {
		var id uuid.UUID
		var name, kind string
		var sizeLabel *string
		var price money
		if err := productRows.Scan(&id, &name, &sizeLabel, &kind, &price); err != nil {
			return catalog, err
		}
		label := name
		if sizeLabel != nil && *sizeLabel != "" {
			label = name + " · " + *sizeLabel
		}
		catalog.ProductNames[id] = label
		catalog.ProductKinds[id] = kind
		catalog.ProductPrice[id] = price
		catalog.ProductOrder = append(catalog.ProductOrder, id)
	}
	return catalog, productRows.Err()
}

// stockLocationShelf reports what is standing at one location, in catalog
// order, skipping SKUs that are not there. Home is answered as the residual so
// this function has one meaning for every location.
func (s *Server) stockLocationShelf(
	ctx context.Context,
	q inspectionQuerier,
	locationID uuid.UUID,
) ([]stockShelfRow, stockSKUCatalog, error) {
	catalog, err := stockLoadSKUs(ctx, q)
	if err != nil {
		return nil, catalog, err
	}
	homeID, err := stockHomeLocationID(ctx, q)
	if err != nil {
		return nil, catalog, err
	}
	jars := make(map[uuid.UUID]int)
	products := make(map[uuid.UUID]int)

	if locationID == homeID {
		globalJars, err := honeyJarInventoryWithQuerier(ctx, q)
		if err != nil {
			return nil, catalog, err
		}
		awayJars, err := stockAwayJarTotals(ctx, q)
		if err != nil {
			return nil, catalog, err
		}
		for _, row := range globalJars {
			jars[row.JarSizeID] = row.OnHand - awayJars[row.JarSizeID]
		}
		globalProducts, err := productInventoryQuery(ctx, q)
		if err != nil {
			return nil, catalog, err
		}
		awayProducts, err := stockAwayProductTotals(ctx, q)
		if err != nil {
			return nil, catalog, err
		}
		for _, row := range globalProducts {
			products[row.ID] = row.OnHand - awayProducts[row.ID]
		}
	} else {
		quantities, err := stockAwayQuantities(ctx, q)
		if err != nil {
			return nil, catalog, err
		}
		for _, row := range quantities {
			if row.LocationID != locationID {
				continue
			}
			if row.JarSizeID != nil {
				jars[*row.JarSizeID] += row.Quantity
			}
			if row.ProductID != nil {
				products[*row.ProductID] += row.Quantity
			}
		}
	}

	out := make([]stockShelfRow, 0, len(jars)+len(products))
	for _, id := range catalog.JarOrder {
		quantity, ok := jars[id]
		if !ok || quantity == 0 {
			continue
		}
		jarID := id
		out = append(out, stockShelfRow{
			JarSizeID: &jarID, Label: catalog.JarLabels[id], Kind: saleKindJar,
			UnitPrice: catalog.JarPrices[id], OnHand: quantity,
		})
	}
	for _, id := range catalog.ProductOrder {
		quantity, ok := products[id]
		if !ok || quantity == 0 {
			continue
		}
		productID := id
		price := catalog.ProductPrice[id]
		out = append(out, stockShelfRow{
			ProductID: &productID, Label: catalog.ProductNames[id],
			Kind: catalog.ProductKinds[id], UnitPrice: &price, OnHand: quantity,
		})
	}
	return out, catalog, nil
}

// stockInventoryRow is one SKU across every location: what the honey and sales
// inventory views show as "on hand by location, and a total".
type stockInventoryRow struct {
	JarSizeID  *uuid.UUID     `json:"jarSizeId"`
	ProductID  *uuid.UUID     `json:"productId"`
	Label      string         `json:"label"`
	Kind       string         `json:"kind"`
	UnitPrice  *money         `json:"unitPrice"`
	Total      int            `json:"total"`
	ByLocation map[string]int `json:"byLocation"`
}

// GET /stock-locations/inventory
func (s *Server) stockInventoryHandler(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	locations, err := s.stockLoadLocations(ctx,
		`WHERE l.deleted_at IS NULL ORDER BY l.is_home DESC, lower(l.name)`)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	byKey := make(map[string]*stockInventoryRow)
	order := make([]string, 0)
	for _, location := range locations {
		shelf, _, err := s.stockLocationShelf(ctx, s.pool, location.ID)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "database error")
			return
		}
		for _, row := range shelf {
			key := row.key()
			entry, ok := byKey[key]
			if !ok {
				entry = &stockInventoryRow{
					JarSizeID: row.JarSizeID, ProductID: row.ProductID, Label: row.Label,
					Kind: row.Kind, UnitPrice: row.UnitPrice, ByLocation: map[string]int{},
				}
				byKey[key] = entry
				order = append(order, key)
			}
			entry.ByLocation[location.ID.String()] += row.OnHand
			entry.Total += row.OnHand
		}
	}
	items := make([]stockInventoryRow, 0, len(order))
	for _, key := range order {
		items = append(items, *byKey[key])
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"locations": locations,
		"items":     items,
	})
}

// GET /stock-locations/{id} — the bike shop page: what is on their shelf, what
// they have sold that is not paid for, and the movement history.
func (s *Server) stockLocationDetail(w http.ResponseWriter, r *http.Request) {
	id, err := uuidParam(r, "id")
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	ctx := r.Context()
	locations, err := s.stockLoadLocations(ctx, `WHERE l.id=$1 AND l.deleted_at IS NULL`, id)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	if len(locations) == 0 {
		writeError(w, http.StatusNotFound, "location not found")
		return
	}
	shelf, _, err := s.stockLocationShelf(ctx, s.pool, id)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}

	// Unsettled = reported sold but not yet paid for. Straight off the sale's
	// invoiced-vs-collected columns; consignment adds no payment table.
	saleRows, err := s.pool.Query(ctx, `
		SELECT id, date, order_number, order_status, total_amount_cents, amount_paid_cents
		FROM sales
		WHERE stock_location_id=$1 AND order_status <> 'cancelled'
		  AND amount_paid_cents < total_amount_cents
		ORDER BY date DESC, created_at DESC
		LIMIT 100`, id)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	type unsettledSale struct {
		ID          uuid.UUID `json:"id"`
		Date        time.Time `json:"date"`
		OrderNumber *string   `json:"orderNumber"`
		OrderStatus string    `json:"orderStatus"`
		TotalAmount money     `json:"totalAmount"`
		AmountPaid  money     `json:"amountPaid"`
		BalanceDue  money     `json:"balanceDue"`
	}
	unsettled := make([]unsettledSale, 0)
	for saleRows.Next() {
		var sale unsettledSale
		if err := saleRows.Scan(&sale.ID, &sale.Date, &sale.OrderNumber, &sale.OrderStatus,
			&sale.TotalAmount, &sale.AmountPaid); err != nil {
			saleRows.Close()
			writeError(w, http.StatusInternalServerError, "database error")
			return
		}
		sale.BalanceDue = sale.TotalAmount - sale.AmountPaid
		unsettled = append(unsettled, sale)
	}
	saleErr := saleRows.Err()
	saleRows.Close()
	if saleErr != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}

	movements, err := s.stockMovementHistory(ctx, id, 100)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	settlements, err := s.stockSettlementRows(ctx, id)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"location":    locations[0],
		"shelf":       shelf,
		"unsettled":   unsettled,
		"movements":   movements,
		"settlements": settlements,
	})
}

type stockMovementRow struct {
	ID           uuid.UUID  `json:"id"`
	Date         time.Time  `json:"date"`
	Kind         string     `json:"kind"`
	Label        string     `json:"label"`
	Quantity     int        `json:"quantity"`
	Counterparty *string    `json:"counterpartyName"`
	LotCode      *string    `json:"lotCode"`
	Reason       *string    `json:"reason"`
	Notes        *string    `json:"notes"`
	IsReversal   bool       `json:"isReversal"`
	ReversedBy   *uuid.UUID `json:"reversedByMovementId"`
	SettlementID *uuid.UUID `json:"settlementId"`
}

func (s *Server) stockMovementHistory(
	ctx context.Context,
	locationID uuid.UUID,
	limit int,
) ([]stockMovementRow, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT m.id, m.date, m.kind,
		       COALESCE(js.label, p.name, 'unknown'),
		       m.quantity, c.name, hl.lot_code, m.reason, m.notes,
		       m.reverses_movement_id IS NOT NULL,
		       (SELECT r.id FROM stock_movements r WHERE r.reverses_movement_id = m.id),
		       m.settlement_id
		FROM stock_movements m
		LEFT JOIN jar_sizes js ON js.id = m.jar_size_id
		LEFT JOIN product_catalog p ON p.id = m.product_id
		LEFT JOIN stock_locations c ON c.id = m.counterparty_location_id
		LEFT JOIN harvest_lots hl ON hl.id = m.harvest_lot_id
		WHERE m.location_id=$1
		ORDER BY m.date DESC, m.created_at DESC
		LIMIT $2`, locationID, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]stockMovementRow, 0)
	for rows.Next() {
		var row stockMovementRow
		if err := rows.Scan(&row.ID, &row.Date, &row.Kind, &row.Label, &row.Quantity,
			&row.Counterparty, &row.LotCode, &row.Reason, &row.Notes, &row.IsReversal,
			&row.ReversedBy, &row.SettlementID); err != nil {
			return nil, err
		}
		out = append(out, row)
	}
	return out, rows.Err()
}

// --- transfers -------------------------------------------------------------

type stockTransferLine struct {
	JarSizeID      *uuid.UUID `json:"jarSizeId"`
	ProductID      *uuid.UUID `json:"productId"`
	Quantity       int        `json:"quantity"`
	HarvestLotID   *uuid.UUID `json:"harvestLotId"`
	BottlingRunID  *uuid.UUID `json:"bottlingRunId"`
	ProductBatchID *uuid.UUID `json:"productBatchId"`
}

type stockTransferRequest struct {
	Date           string              `json:"date"`
	FromLocationID *uuid.UUID          `json:"fromLocationId"`
	Lines          []stockTransferLine `json:"lines"`
	Reason         *string             `json:"reason"`
	Notes          *string             `json:"notes"`
	IdempotencyKey *string             `json:"idempotencyKey"`
}

// POST /stock-locations/{id}/transfers — jars leave home and go on the shop's
// shelf. NO REVENUE, no COGS, no pounds bottled: two movement rows and
// nothing else. The lot travels with them so Honey Story still answers.
func (s *Server) stockTransferCreate(w http.ResponseWriter, r *http.Request) {
	s.stockMoveStock(w, r, "transfer")
}

// POST /stock-locations/{id}/returns — the reverse transfer: unsold jars come
// back from the shop to home with their lot ancestry intact.
func (s *Server) stockReturnCreate(w http.ResponseWriter, r *http.Request) {
	s.stockMoveStock(w, r, "return")
}

func (s *Server) stockMoveStock(w http.ResponseWriter, r *http.Request, kind string) {
	locationID, err := uuidParam(r, "id")
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	var req stockTransferRequest
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
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
	if len(req.Lines) == 0 {
		writeError(w, http.StatusBadRequest, "Add at least one line")
		return
	}

	ctx := r.Context()
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	defer tx.Rollback(ctx)

	homeID, err := stockHomeLocationID(ctx, tx)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	// A transfer sends stock TO the named location; a return sends it back.
	// Either way the counterparty defaults to home, and shop-to-shop is a
	// plain transfer with an explicit fromLocationId.
	source, destination := homeID, locationID
	if req.FromLocationID != nil {
		source = *req.FromLocationID
	}
	if kind == "return" {
		source, destination = locationID, homeID
		if req.FromLocationID != nil {
			destination = *req.FromLocationID
		}
	}
	if source == destination {
		writeError(w, http.StatusBadRequest, "a transfer needs two different locations")
		return
	}
	if err := stockRequireLive(ctx, tx, source); err != nil {
		equipWriteError(w, err)
		return
	}
	if err := stockRequireLive(ctx, tx, destination); err != nil {
		equipWriteError(w, err)
		return
	}

	transferID := uuid.New()
	if err := s.stockWriteMovements(ctx, tx, stockWriteInput{
		Kind:           kind,
		TransferID:     &transferID,
		Source:         source,
		Destination:    destination,
		Date:           date,
		Lines:          req.Lines,
		Reason:         inspectionTrimPtr(req.Reason),
		Notes:          inspectionTrimPtr(req.Notes),
		IdempotencyKey: inspectionTrimPtr(req.IdempotencyKey),
		Actor:          actorID(r),
	}); err != nil {
		equipWriteError(w, err)
		return
	}
	if err := tx.Commit(ctx); err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{
		"success": true, "transferId": transferID,
		"fromLocationId": source, "toLocationId": destination,
	})
}

type stockWriteInput struct {
	Kind           string
	TransferID     *uuid.UUID
	Source         uuid.UUID
	Destination    uuid.UUID
	Date           time.Time
	Lines          []stockTransferLine
	Reason         *string
	Notes          *string
	IdempotencyKey *string
	SettlementID   *uuid.UUID
	Actor          *uuid.UUID
}

// stockWriteMovements validates a move against what is actually standing at
// the source and writes the two halves. It is the only place a transfer or a
// return is created, so the "-n here, +n there" invariant lives in one spot.
func (s *Server) stockWriteMovements(
	ctx context.Context,
	tx pgx.Tx,
	input stockWriteInput,
) error {
	jarIDs := make([]uuid.UUID, 0, len(input.Lines))
	productIDs := make([]uuid.UUID, 0, len(input.Lines))
	for _, line := range input.Lines {
		if line.Quantity <= 0 {
			return stockBadRequest("quantity must be greater than zero")
		}
		if (line.JarSizeID == nil) == (line.ProductID == nil) {
			return stockBadRequest("each line needs exactly one of jarSizeId or productId")
		}
		if line.JarSizeID != nil {
			jarIDs = append(jarIDs, *line.JarSizeID)
		} else {
			productIDs = append(productIDs, *line.ProductID)
		}
	}
	// Lock the SKU rows before reading availability, exactly as a sale does,
	// so a concurrent checkout and a concurrent transfer cannot both spend the
	// same jars.
	if len(jarIDs) > 0 {
		_, _, unknown, err := honeyLockJarSizes(ctx, tx, jarIDs)
		if err != nil {
			return err
		}
		if unknown {
			return stockBadRequest("invalid jarSizeId")
		}
	}
	if len(productIDs) > 0 {
		unknown, err := stockLockProducts(ctx, tx, productIDs)
		if err != nil {
			return err
		}
		if unknown {
			return stockBadRequest("invalid productId")
		}
	}

	shelf, _, err := s.stockLocationShelf(ctx, tx, input.Source)
	if err != nil {
		return err
	}
	available := make(map[string]int, len(shelf))
	labels := make(map[string]string, len(shelf))
	for _, row := range shelf {
		available[row.key()] = row.OnHand
		labels[row.key()] = row.Label
	}
	needed := make(map[string]int, len(input.Lines))
	for _, line := range input.Lines {
		needed[stockLineKey(line)] += line.Quantity
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
			return stockBadRequest("Not enough %s at the source location: need %d, have %d",
				label, needed[key], available[key])
		}
	}

	for index, line := range input.Lines {
		var key *string
		if input.IdempotencyKey != nil {
			// One key per side per line: replaying the request hits the unique
			// index instead of moving the stock a second time.
			out := fmt.Sprintf("%s:%d:out", *input.IdempotencyKey, index)
			key = &out
		}
		if err := stockInsertMovement(ctx, tx, input, line, input.Source,
			input.Destination, -line.Quantity, key); err != nil {
			return err
		}
		if input.IdempotencyKey != nil {
			in := fmt.Sprintf("%s:%d:in", *input.IdempotencyKey, index)
			key = &in
		}
		if err := stockInsertMovement(ctx, tx, input, line, input.Destination,
			input.Source, line.Quantity, key); err != nil {
			return err
		}
	}
	return nil
}

func stockLineKey(line stockTransferLine) string {
	if line.JarSizeID != nil {
		return "jar:" + line.JarSizeID.String()
	}
	if line.ProductID != nil {
		return "product:" + line.ProductID.String()
	}
	return ""
}

func stockInsertMovement(
	ctx context.Context,
	tx pgx.Tx,
	input stockWriteInput,
	line stockTransferLine,
	locationID, counterparty uuid.UUID,
	quantity int,
	idempotencyKey *string,
) error {
	_, err := tx.Exec(ctx, `
		INSERT INTO stock_movements
			(date, kind, location_id, counterparty_location_id, transfer_id,
			 jar_size_id, product_id, quantity, harvest_lot_id, bottling_run_id,
			 product_batch_id, settlement_id, idempotency_key, reason, notes, created_by)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
		input.Date, input.Kind, locationID, counterparty, input.TransferID,
		line.JarSizeID, line.ProductID, quantity, line.HarvestLotID, line.BottlingRunID,
		line.ProductBatchID, input.SettlementID, idempotencyKey, input.Reason,
		input.Notes, input.Actor)
	if err != nil {
		var already bool
		if pgErrCode(err) == "23505" {
			already = true
		}
		if already {
			return equipFail(http.StatusConflict,
				"this movement was already recorded (idempotency key reused)")
		}
		if pgErrCode(err) == "23503" {
			return stockBadRequest("invalid jar size, product, lot, or batch")
		}
		return err
	}
	return nil
}

func stockRequireLive(ctx context.Context, q inspectionQuerier, id uuid.UUID) error {
	var deleted *time.Time
	err := q.QueryRow(ctx,
		`SELECT deleted_at FROM stock_locations WHERE id=$1`, id).Scan(&deleted)
	if errors.Is(err, pgx.ErrNoRows) {
		return equipFail(http.StatusNotFound, "location not found")
	}
	if err != nil {
		return err
	}
	if deleted != nil {
		return stockBadRequest("that location has been deleted")
	}
	return nil
}

// DELETE /stock-movements/{id} — reverse a transfer. Reversal, never deletion:
// both halves of the transfer get a negating row so the pair nets to zero and
// the history keeps both. Reversing twice is a 409, not a second reversal.
func (s *Server) stockMovementReverse(w http.ResponseWriter, r *http.Request) {
	id, err := uuidParam(r, "id")
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	var req struct {
		Reason *string `json:"reason"`
	}
	_ = decodeJSON(r, &req)

	ctx := r.Context()
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	defer tx.Rollback(ctx)

	var transferID *uuid.UUID
	var settlementID *uuid.UUID
	err = tx.QueryRow(ctx, `
		SELECT transfer_id, settlement_id FROM stock_movements WHERE id=$1 FOR UPDATE`, id).
		Scan(&transferID, &settlementID)
	if errors.Is(err, pgx.ErrNoRows) {
		writeError(w, http.StatusNotFound, "movement not found")
		return
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	if settlementID != nil {
		// A settlement's movements move with its sale; unwinding one half
		// would leave revenue recognised against stock that came back.
		writeError(w, http.StatusConflict,
			"this movement belongs to a settlement; void the settlement instead")
		return
	}

	// Reverse the whole transfer, not one leg: a half-reversed transfer leaves
	// the two locations disagreeing about where the jars are.
	ids := []uuid.UUID{id}
	if transferID != nil {
		ids = nil
		rows, err := tx.Query(ctx, `
			SELECT id FROM stock_movements
			WHERE transfer_id=$1 AND reverses_movement_id IS NULL
			ORDER BY id FOR UPDATE`, *transferID)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "database error")
			return
		}
		for rows.Next() {
			var movementID uuid.UUID
			if err := rows.Scan(&movementID); err != nil {
				rows.Close()
				writeError(w, http.StatusInternalServerError, "database error")
				return
			}
			ids = append(ids, movementID)
		}
		rowsErr := rows.Err()
		rows.Close()
		if rowsErr != nil {
			writeError(w, http.StatusInternalServerError, "database error")
			return
		}
	}

	reversed, err := stockReverseMovements(ctx, tx, ids, inspectionTrimPtr(req.Reason), actorID(r))
	if err != nil {
		equipWriteError(w, err)
		return
	}
	if err := tx.Commit(ctx); err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"success": true, "reversed": reversed, "id": id,
	})
}

// stockReverseMovements writes the negation of each named movement. The unique
// index on reverses_movement_id is what makes it idempotent: a second attempt
// conflicts instead of double-reversing.
func stockReverseMovements(
	ctx context.Context,
	tx pgx.Tx,
	ids []uuid.UUID,
	reason *string,
	actor *uuid.UUID,
) (int, error) {
	reversed := 0
	for _, id := range ids {
		tag, err := tx.Exec(ctx, `
			INSERT INTO stock_movements
				(date, kind, location_id, counterparty_location_id, transfer_id,
				 jar_size_id, product_id, quantity, harvest_lot_id, bottling_run_id,
				 product_batch_id, sale_id, settlement_id, reverses_movement_id,
				 reason, notes, created_by)
			SELECT now(), m.kind, m.location_id, m.counterparty_location_id, m.transfer_id,
			       m.jar_size_id, m.product_id, -m.quantity, m.harvest_lot_id,
			       m.bottling_run_id, m.product_batch_id, m.sale_id, m.settlement_id,
			       m.id, COALESCE($2, 'reversed'), m.notes, $3
			FROM stock_movements m
			WHERE m.id=$1 AND m.reverses_movement_id IS NULL
			ON CONFLICT DO NOTHING`, id, reason, actor)
		if err != nil {
			return reversed, err
		}
		reversed += int(tag.RowsAffected())
	}
	if reversed == 0 {
		return 0, equipFail(http.StatusConflict, "already reversed")
	}
	return reversed, nil
}

func pgErrCode(err error) string {
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) {
		return pgErr.Code
	}
	return ""
}

// --- settlement ------------------------------------------------------------
//
// "We sold 9 this month, here is $X." One statement reconciles the shop's
// count against ours for a period: opening stock, transferred in, sold per
// SKU, returned, closing stock, owed, paid. The difference between what we
// think is on their shelf and what they counted is shrink AT THAT LOCATION —
// an adjustment there, never at home.

type stockStatementLine struct {
	JarSizeID      *uuid.UUID `json:"jarSizeId"`
	ProductID      *uuid.UUID `json:"productId"`
	Label          string     `json:"label"`
	Kind           string     `json:"kind"`
	Opening        int        `json:"opening"`
	TransferredIn  int        `json:"transferredIn"`
	TransferredOut int        `json:"transferredOut"`
	Sold           int        `json:"sold"`
	Returned       int        `json:"returned"`
	// Positive means stock went missing at this location; negative means more
	// was counted than we expected.
	Shrink    int    `json:"shrink"`
	Closing   int    `json:"closing"`
	Revenue   money  `json:"revenue"`
	UnitPrice *money `json:"unitPrice"`
}

type stockStatement struct {
	LocationID         uuid.UUID            `json:"locationId"`
	LocationName       string               `json:"locationName"`
	PriceBasis         string               `json:"priceBasis"`
	CommissionPercent  float64              `json:"commissionPercent"`
	SettlementCadence  string               `json:"settlementCadence"`
	PeriodStart        string               `json:"periodStart"`
	PeriodEnd          string               `json:"periodEnd"`
	Lines              []stockStatementLine `json:"lines"`
	OpeningUnits       int                  `json:"openingUnits"`
	TransferredInUnits int                  `json:"transferredInUnits"`
	SoldUnits          int                  `json:"soldUnits"`
	ReturnedUnits      int                  `json:"returnedUnits"`
	ShrinkUnits        int                  `json:"shrinkUnits"`
	ClosingUnits       int                  `json:"closingUnits"`
	// Straight off the sale rows: invoiced is what the report recognised,
	// collected is what the shop has actually handed over.
	AmountInvoiced  money `json:"amountInvoiced"`
	AmountCollected money `json:"amountCollected"`
	AmountOwed      money `json:"amountOwed"`
	Commission      money `json:"commission"`
}

// stockPeriodBounds turns an inclusive from/to pair into a half-open range, so
// a sale timestamped late on the last day of the period still lands inside it.
func stockPeriodBounds(from, to string) (time.Time, time.Time, error) {
	start, err := parseDate(from)
	if err != nil {
		return time.Time{}, time.Time{}, stockBadRequest("invalid periodStart")
	}
	end, err := parseDate(to)
	if err != nil {
		return time.Time{}, time.Time{}, stockBadRequest("invalid periodEnd")
	}
	if end.Before(start) {
		return time.Time{}, time.Time{}, stockBadRequest("periodEnd must not precede periodStart")
	}
	return start, end.AddDate(0, 0, 1), nil
}

// stockBuildStatement assembles the per-SKU statement for one location and
// period out of four aggregates over the one ledger.
func (s *Server) stockBuildStatement(
	ctx context.Context,
	q inspectionQuerier,
	location stockLocationRow,
	from, to string,
) (stockStatement, error) {
	start, end, err := stockPeriodBounds(from, to)
	if err != nil {
		return stockStatement{}, err
	}
	catalog, err := stockLoadSKUs(ctx, q)
	if err != nil {
		return stockStatement{}, err
	}

	statement := stockStatement{
		LocationID: location.ID, LocationName: location.Name,
		PriceBasis: location.PriceBasis, SettlementCadence: location.SettlementCadence,
		PeriodStart: from, PeriodEnd: to,
	}
	if location.CommissionBps != nil {
		statement.CommissionPercent = float64(*location.CommissionBps) / 100
	}

	lines := make(map[string]*stockStatementLine)
	order := make([]string, 0)
	touch := func(jarSizeID, productID *uuid.UUID) *stockStatementLine {
		key := stockLineKey(stockTransferLine{JarSizeID: jarSizeID, ProductID: productID})
		if line, ok := lines[key]; ok {
			return line
		}
		line := &stockStatementLine{JarSizeID: jarSizeID, ProductID: productID}
		if jarSizeID != nil {
			line.Label = catalog.JarLabels[*jarSizeID]
			line.Kind = saleKindJar
			line.UnitPrice = catalog.JarPrices[*jarSizeID]
		} else if productID != nil {
			line.Label = catalog.ProductNames[*productID]
			line.Kind = catalog.ProductKinds[*productID]
			price := catalog.ProductPrice[*productID]
			line.UnitPrice = &price
		}
		lines[key] = line
		order = append(order, key)
		return line
	}

	// Opening: everything that had happened at this location before the period.
	openingRows, err := q.Query(ctx, `
		SELECT jar_size_id, product_id, SUM(qty)::int FROM (
			SELECT jar_size_id, product_id, quantity AS qty
			FROM stock_movements WHERE location_id=$1 AND date < $2
			UNION ALL
			SELECT si.jar_size_id, si.product_id, -si.quantity
			FROM sale_items si JOIN sales s ON s.id = si.sale_id
			WHERE s.stock_location_id=$1 AND s.order_status <> 'cancelled' AND s.date < $2
		) opening
		GROUP BY 1, 2`, location.ID, start)
	if err != nil {
		return stockStatement{}, err
	}
	for openingRows.Next() {
		var jarSizeID, productID *uuid.UUID
		var quantity int
		if err := openingRows.Scan(&jarSizeID, &productID, &quantity); err != nil {
			openingRows.Close()
			return stockStatement{}, err
		}
		touch(jarSizeID, productID).Opening = quantity
	}
	openingErr := openingRows.Err()
	openingRows.Close()
	if openingErr != nil {
		return stockStatement{}, openingErr
	}

	// Movements inside the period, split by what they mean to the shop.
	movementRows, err := q.Query(ctx, `
		SELECT jar_size_id, product_id,
		       COALESCE(SUM(quantity) FILTER (WHERE kind='transfer' AND quantity > 0), 0)::int,
		       COALESCE(SUM(-quantity) FILTER (WHERE kind='transfer' AND quantity < 0), 0)::int,
		       COALESCE(SUM(-quantity) FILTER (WHERE kind='return'), 0)::int,
		       COALESCE(SUM(-quantity) FILTER (WHERE kind='adjustment'), 0)::int
		FROM stock_movements
		WHERE location_id=$1 AND date >= $2 AND date < $3
		GROUP BY 1, 2`, location.ID, start, end)
	if err != nil {
		return stockStatement{}, err
	}
	for movementRows.Next() {
		var jarSizeID, productID *uuid.UUID
		var in, out, returned, shrink int
		if err := movementRows.Scan(&jarSizeID, &productID, &in, &out, &returned,
			&shrink); err != nil {
			movementRows.Close()
			return stockStatement{}, err
		}
		line := touch(jarSizeID, productID)
		line.TransferredIn = in
		line.TransferredOut = out
		line.Returned = returned
		line.Shrink = shrink
	}
	movementErr := movementRows.Err()
	movementRows.Close()
	if movementErr != nil {
		return stockStatement{}, movementErr
	}

	// Sold: the shop's reported sales, priced at what the operator is owed.
	soldRows, err := q.Query(ctx, `
		SELECT si.jar_size_id, si.product_id, SUM(si.quantity)::int,
		       COALESCE(SUM(si.quantity * si.unit_price_cents), 0)::bigint
		FROM sale_items si JOIN sales s ON s.id = si.sale_id
		WHERE s.stock_location_id=$1 AND s.order_status <> 'cancelled'
		  AND s.date >= $2 AND s.date < $3
		  AND (si.jar_size_id IS NOT NULL OR si.product_id IS NOT NULL)
		GROUP BY 1, 2`, location.ID, start, end)
	if err != nil {
		return stockStatement{}, err
	}
	for soldRows.Next() {
		var jarSizeID, productID *uuid.UUID
		var quantity int
		var revenue money
		if err := soldRows.Scan(&jarSizeID, &productID, &quantity, &revenue); err != nil {
			soldRows.Close()
			return stockStatement{}, err
		}
		line := touch(jarSizeID, productID)
		line.Sold = quantity
		line.Revenue = revenue
	}
	soldErr := soldRows.Err()
	soldRows.Close()
	if soldErr != nil {
		return stockStatement{}, soldErr
	}

	if err := q.QueryRow(ctx, `
		SELECT COALESCE(SUM(total_amount_cents), 0), COALESCE(SUM(amount_paid_cents), 0)
		FROM sales
		WHERE stock_location_id=$1 AND order_status <> 'cancelled'
		  AND date >= $2 AND date < $3`, location.ID, start, end).
		Scan(&statement.AmountInvoiced, &statement.AmountCollected); err != nil {
		return stockStatement{}, err
	}
	statement.AmountOwed = statement.AmountInvoiced - statement.AmountCollected
	if err := q.QueryRow(ctx, `
		SELECT COALESCE(SUM(commission_cents), 0) FROM consignment_settlements
		WHERE location_id=$1 AND voided_at IS NULL
		  AND period_start >= $2::date AND period_end < $3::date`,
		location.ID, start, end).Scan(&statement.Commission); err != nil {
		return stockStatement{}, err
	}

	statement.Lines = make([]stockStatementLine, 0, len(order))
	for _, key := range order {
		line := lines[key]
		line.Closing = line.Opening + line.TransferredIn - line.TransferredOut -
			line.Returned - line.Shrink - line.Sold
		statement.OpeningUnits += line.Opening
		statement.TransferredInUnits += line.TransferredIn
		statement.SoldUnits += line.Sold
		statement.ReturnedUnits += line.Returned
		statement.ShrinkUnits += line.Shrink
		statement.ClosingUnits += line.Closing
		statement.Lines = append(statement.Lines, *line)
	}
	return statement, nil
}

// GET /stock-locations/{id}/settlement?from=&to=
func (s *Server) stockSettlementPreview(w http.ResponseWriter, r *http.Request) {
	id, err := uuidParam(r, "id")
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	from := r.URL.Query().Get("from")
	to := r.URL.Query().Get("to")
	if from == "" || to == "" {
		// Default to the current month, which is the common cadence.
		now := time.Now()
		first := time.Date(now.Year(), now.Month(), 1, 0, 0, 0, 0, time.Local)
		from = first.Format("2006-01-02")
		to = first.AddDate(0, 1, -1).Format("2006-01-02")
	}
	ctx := r.Context()
	locations, err := s.stockLoadLocations(ctx, `WHERE l.id=$1 AND l.deleted_at IS NULL`, id)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	if len(locations) == 0 {
		writeError(w, http.StatusNotFound, "location not found")
		return
	}
	statement, err := s.stockBuildStatement(ctx, s.pool, locations[0], from, to)
	if err != nil {
		equipWriteError(w, err)
		return
	}
	// What is on their shelf right now, which is what the operator compares
	// the shop's count against when recording the report.
	shelf, _, err := s.stockLocationShelf(ctx, s.pool, id)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"statement": statement,
		"shelf":     shelf,
	})
}

type stockSettlementRow struct {
	ID          uuid.UUID  `json:"id"`
	LocationID  uuid.UUID  `json:"locationId"`
	PeriodStart string     `json:"periodStart"`
	PeriodEnd   string     `json:"periodEnd"`
	ReportedAt  time.Time  `json:"reportedAt"`
	SaleID      *uuid.UUID `json:"saleId"`
	OrderNumber *string    `json:"orderNumber"`
	AmountOwed  money      `json:"amountOwed"`
	AmountPaid  money      `json:"amountPaid"`
	Commission  money      `json:"commission"`
	Notes       *string    `json:"notes"`
	CreatedAt   time.Time  `json:"createdAt"`
	VoidedAt    *time.Time `json:"voidedAt"`
	VoidReason  *string    `json:"voidReason"`
}

func (s *Server) stockSettlementRows(
	ctx context.Context,
	locationID uuid.UUID,
) ([]stockSettlementRow, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT cs.id, cs.location_id, cs.period_start, cs.period_end, cs.reported_at,
		       cs.sale_id, s.order_number, cs.amount_owed_cents, cs.amount_paid_cents,
		       cs.commission_cents, cs.notes, cs.created_at, cs.voided_at, cs.void_reason
		FROM consignment_settlements cs
		LEFT JOIN sales s ON s.id = cs.sale_id
		WHERE cs.location_id=$1
		ORDER BY cs.period_end DESC, cs.created_at DESC
		LIMIT 60`, locationID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]stockSettlementRow, 0)
	for rows.Next() {
		var row stockSettlementRow
		var start, end time.Time
		if err := rows.Scan(&row.ID, &row.LocationID, &start, &end, &row.ReportedAt,
			&row.SaleID, &row.OrderNumber, &row.AmountOwed, &row.AmountPaid,
			&row.Commission, &row.Notes, &row.CreatedAt, &row.VoidedAt,
			&row.VoidReason); err != nil {
			return nil, err
		}
		row.PeriodStart = start.Format("2006-01-02")
		row.PeriodEnd = end.Format("2006-01-02")
		out = append(out, row)
	}
	return out, rows.Err()
}

// GET /stock-locations/{id}/settlements
func (s *Server) stockSettlementList(w http.ResponseWriter, r *http.Request) {
	id, err := uuidParam(r, "id")
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	settlements, err := s.stockSettlementRows(r.Context(), id)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	writeJSON(w, http.StatusOK, settlements)
}

type stockSettlementLineInput struct {
	JarSizeID *uuid.UUID `json:"jarSizeId"`
	ProductID *uuid.UUID `json:"productId"`
	// What the shop says they sold, and what they are handing back.
	QuantitySold     int `json:"quantitySold"`
	QuantityReturned int `json:"quantityReturned"`
	// The shelf price the shop charged. Defaults to the SKU's list price.
	UnitPrice *money `json:"unitPrice"`
	// Their count of what is left. Supplying it turns the difference into
	// shrink at this location.
	CountOnShelf *int `json:"countOnShelf"`
}

type stockSettlementRequest struct {
	PeriodStart   string                     `json:"periodStart"`
	PeriodEnd     string                     `json:"periodEnd"`
	ReportedAt    string                     `json:"reportedAt"`
	Lines         []stockSettlementLineInput `json:"lines"`
	AmountPaid    money                      `json:"amountPaid"`
	PaymentMethod string                     `json:"paymentMethod"`
	OrderNumber   *string                    `json:"orderNumber"`
	Notes         *string                    `json:"notes"`
}

// stockOwedSplit divides one unit's shelf price between what the operator is
// owed and what the shop keeps, in exact integer cents.
func stockOwedSplit(
	location stockLocationRow,
	retail money,
	wholesale *money,
) (owed, commission money) {
	switch location.PriceBasis {
	case "commission":
		bps := money(0)
		if location.CommissionBps != nil {
			bps = money(*location.CommissionBps)
		}
		// Round the shop's cut half away from zero so the two halves always
		// add back up to the shelf price.
		commission = (retail*bps + stockBasisPointsPerUnit/2) / stockBasisPointsPerUnit
		return retail - commission, commission
	case "wholesale_list":
		if wholesale != nil && *wholesale <= retail {
			return *wholesale, retail - *wholesale
		}
		if wholesale != nil {
			// A list price above the shelf price means the operator takes the
			// whole sale rather than being owed more than the shop collected.
			return retail, 0
		}
		return retail, 0
	default:
		return retail, 0
	}
}

// POST /stock-locations/{id}/settlements — "record their report".
//
// One request carries counts sold, jars coming back, their shelf count, and
// the payment. It writes, in one transaction:
//
//   - a consignment_settlements statement row;
//   - one sale (channel consignment, scoped to this location) recognising
//     revenue for what sold — the ONLY point revenue appears in the whole
//     consignment flow;
//   - return movements home for anything handed back;
//   - shrink adjustments AT THIS LOCATION plus their global counterpart.
func (s *Server) stockSettlementCreate(w http.ResponseWriter, r *http.Request) {
	locationID, err := uuidParam(r, "id")
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	var req stockSettlementRequest
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if req.PeriodStart == "" || req.PeriodEnd == "" {
		writeError(w, http.StatusBadRequest, "periodStart and periodEnd are required")
		return
	}
	periodStart, err := parseDate(req.PeriodStart)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid periodStart")
		return
	}
	periodEnd, err := parseDate(req.PeriodEnd)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid periodEnd")
		return
	}
	if periodEnd.Before(periodStart) {
		writeError(w, http.StatusBadRequest, "periodEnd must not precede periodStart")
		return
	}
	reportedAt := periodEnd
	if req.ReportedAt != "" {
		reportedAt, err = parseDate(req.ReportedAt)
		if err != nil {
			writeError(w, http.StatusBadRequest, "invalid reportedAt")
			return
		}
	}
	if req.PaymentMethod == "" {
		req.PaymentMethod = "check"
	}
	if !honeyPaymentMethods[req.PaymentMethod] {
		writeError(w, http.StatusBadRequest, "invalid payment method")
		return
	}
	if len(req.Lines) == 0 {
		writeError(w, http.StatusBadRequest, "Add at least one line")
		return
	}
	if req.AmountPaid < 0 {
		writeError(w, http.StatusBadRequest, "amountPaid must not be negative")
		return
	}

	ctx := r.Context()
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	defer tx.Rollback(ctx)

	locations, err := s.stockLoadLocationsTx(ctx, tx, locationID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	if len(locations) == 0 {
		writeError(w, http.StatusNotFound, "location not found")
		return
	}
	location := locations[0]
	if location.IsHome {
		writeError(w, http.StatusBadRequest, "home does not settle with itself")
		return
	}

	result, err := s.stockApplySettlement(ctx, tx, location, req,
		periodStart, periodEnd, reportedAt, actorID(r))
	if err != nil {
		equipWriteError(w, err)
		return
	}
	if err := tx.Commit(ctx); err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	writeJSON(w, http.StatusCreated, result)
}

// stockLoadLocationsTx is stockLoadLocations without the derived counts, for
// use inside a transaction that is about to change them anyway.
func (s *Server) stockLoadLocationsTx(
	ctx context.Context,
	tx pgx.Tx,
	id uuid.UUID,
) ([]stockLocationRow, error) {
	rows, err := tx.Query(ctx, stockLocationSelect+
		` WHERE l.id=$1 AND l.deleted_at IS NULL`, id)
	if err != nil {
		return nil, err
	}
	return stockScanLocations(rows)
}

type stockSettlementResult struct {
	Success       bool       `json:"success"`
	ID            uuid.UUID  `json:"id"`
	SaleID        *uuid.UUID `json:"saleId"`
	OrderNumber   *string    `json:"orderNumber"`
	AmountOwed    money      `json:"amountOwed"`
	AmountPaid    money      `json:"amountPaid"`
	BalanceDue    money      `json:"balanceDue"`
	Commission    money      `json:"commission"`
	SoldUnits     int        `json:"soldUnits"`
	ReturnedUnits int        `json:"returnedUnits"`
	ShrinkUnits   int        `json:"shrinkUnits"`
}

func (s *Server) stockApplySettlement(
	ctx context.Context,
	tx pgx.Tx,
	location stockLocationRow,
	req stockSettlementRequest,
	periodStart, periodEnd, reportedAt time.Time,
	actor *uuid.UUID,
) (stockSettlementResult, error) {
	var result stockSettlementResult

	jarIDs := make([]uuid.UUID, 0, len(req.Lines))
	productIDs := make([]uuid.UUID, 0, len(req.Lines))
	for _, line := range req.Lines {
		if (line.JarSizeID == nil) == (line.ProductID == nil) {
			return result, stockBadRequest("each line needs exactly one of jarSizeId or productId")
		}
		if line.QuantitySold < 0 || line.QuantityReturned < 0 {
			return result, stockBadRequest("quantities must not be negative")
		}
		if line.CountOnShelf != nil && *line.CountOnShelf < 0 {
			return result, stockBadRequest("countOnShelf must not be negative")
		}
		if line.JarSizeID != nil {
			jarIDs = append(jarIDs, *line.JarSizeID)
		} else {
			productIDs = append(productIDs, *line.ProductID)
		}
	}
	if len(jarIDs) > 0 {
		if _, _, unknown, err := honeyLockJarSizes(ctx, tx, jarIDs); err != nil {
			return result, err
		} else if unknown {
			return result, stockBadRequest("invalid jarSizeId")
		}
	}
	if len(productIDs) > 0 {
		unknown, err := stockLockProducts(ctx, tx, productIDs)
		if err != nil {
			return result, err
		}
		if unknown {
			return result, stockBadRequest("invalid productId")
		}
	}

	shelf, catalog, err := s.stockLocationShelf(ctx, tx, location.ID)
	if err != nil {
		return result, err
	}
	onShelf := make(map[string]int, len(shelf))
	labels := make(map[string]string, len(shelf))
	for _, row := range shelf {
		onShelf[row.key()] = row.OnHand
		labels[row.key()] = row.Label
	}

	wholesale, err := stockWholesalePrices(ctx, tx, location.WholesalePriceListID)
	if err != nil {
		return result, err
	}

	settlementID := uuid.New()
	saleID := uuid.New()
	saleLines := make([]saleConsignmentLine, 0, len(req.Lines))
	returns := make([]stockTransferLine, 0, len(req.Lines))
	type shrinkLine struct {
		JarSizeID *uuid.UUID
		ProductID *uuid.UUID
		Quantity  int
	}
	shrinks := make([]shrinkLine, 0)
	var owed, commission money

	for _, line := range req.Lines {
		key := stockLineKey(stockTransferLine{JarSizeID: line.JarSizeID, ProductID: line.ProductID})
		label, ok := labels[key]
		if !ok {
			label = "units"
		}
		have := onShelf[key]
		if line.QuantitySold+line.QuantityReturned > have {
			return result, stockBadRequest(
				"%s: the report accounts for %d but only %d are on their shelf",
				label, line.QuantitySold+line.QuantityReturned, have)
		}
		if line.QuantityReturned > 0 {
			returns = append(returns, stockTransferLine{
				JarSizeID: line.JarSizeID, ProductID: line.ProductID,
				Quantity: line.QuantityReturned,
			})
		}
		if line.QuantitySold > 0 {
			retail := money(0)
			switch {
			case line.UnitPrice != nil:
				retail = *line.UnitPrice
			case line.JarSizeID != nil:
				if price := catalog.JarPrices[*line.JarSizeID]; price != nil {
					retail = *price
				}
			case line.ProductID != nil:
				retail = catalog.ProductPrice[*line.ProductID]
			}
			if retail <= 0 {
				return result, stockBadRequest(
					"%s: a unit price is required to recognise revenue", label)
			}
			var listPrice *money
			if line.JarSizeID != nil {
				if price, ok := wholesale[*line.JarSizeID]; ok {
					value := price
					listPrice = &value
				}
			}
			unitOwed, unitCommission := stockOwedSplit(location, retail, listPrice)
			if unitOwed <= 0 {
				return result, stockBadRequest(
					"%s: the commission leaves nothing to recognise as revenue", label)
			}
			kind := saleKindJar
			if line.ProductID != nil {
				kind = catalog.ProductKinds[*line.ProductID]
			}
			saleLines = append(saleLines, saleConsignmentLine{
				JarSizeID: line.JarSizeID, ProductID: line.ProductID, Kind: kind,
				Quantity: line.QuantitySold, UnitPrice: unitOwed,
			})
			owed += unitOwed.mulQuantity(line.QuantitySold)
			commission += unitCommission.mulQuantity(line.QuantitySold)
			result.SoldUnits += line.QuantitySold
		}
		result.ReturnedUnits += line.QuantityReturned

		if line.CountOnShelf != nil {
			expected := have - line.QuantitySold - line.QuantityReturned
			difference := expected - *line.CountOnShelf
			if difference != 0 {
				if line.ProductID != nil {
					// Catalog SKUs derive on-hand from batches minus sales, with
					// no adjustment ledger to absorb a loss. Writing the shop's
					// half alone would hand the missing unit back to home.
					return result, stockBadRequest(
						"%s: catalog products have no adjustment ledger yet, so a "+
							"count difference cannot be recorded. Return the units "+
							"instead, or leave countOnShelf unset.", label)
				}
				shrinks = append(shrinks, shrinkLine{
					JarSizeID: line.JarSizeID, ProductID: line.ProductID,
					Quantity: difference,
				})
				result.ShrinkUnits += difference
			}
		}
	}

	if req.AmountPaid > owed {
		return result, stockBadRequest(
			"the payment is larger than the $%.2f this report owes", owed.Dollars())
	}

	if _, err := tx.Exec(ctx, `
		INSERT INTO consignment_settlements
			(id, location_id, period_start, period_end, reported_at,
			 amount_owed_cents, amount_paid_cents, commission_cents, notes, created_by)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
		settlementID, location.ID, periodStart, periodEnd, reportedAt,
		owed, req.AmountPaid, commission, inspectionTrimPtr(req.Notes), actor); err != nil {
		if pgErrCode(err) == "23505" {
			return result, equipFail(http.StatusConflict,
				"this period has already been settled for this location")
		}
		return result, err
	}
	result.ID = settlementID

	if len(saleLines) > 0 {
		orderNumber, err := saleRecordConsignmentReport(ctx, tx, saleConsignmentInput{
			SaleID:        saleID,
			LocationID:    location.ID,
			LocationName:  location.Name,
			CustomerID:    location.CustomerID,
			Date:          reportedAt,
			PaymentMethod: req.PaymentMethod,
			TotalAmount:   owed,
			AmountPaid:    req.AmountPaid,
			OrderNumber:   inspectionTrimPtr(req.OrderNumber),
			Notes:         inspectionTrimPtr(req.Notes),
			Lines:         saleLines,
			Actor:         actor,
		})
		if err != nil {
			return result, err
		}
		if _, err := tx.Exec(ctx,
			`UPDATE consignment_settlements SET sale_id=$2 WHERE id=$1`,
			settlementID, saleID); err != nil {
			return result, err
		}
		result.SaleID = &saleID
		result.OrderNumber = orderNumber
	}

	if len(returns) > 0 {
		homeID, err := stockHomeLocationID(ctx, tx)
		if err != nil {
			return result, err
		}
		reason := "returned on settlement"
		key := "settlement:" + settlementID.String()
		if err := s.stockWriteMovements(ctx, tx, stockWriteInput{
			Kind: "return", TransferID: ptrUUID(uuid.New()),
			Source: location.ID, Destination: homeID, Date: reportedAt,
			Lines: returns, Reason: &reason, IdempotencyKey: &key,
			SettlementID: &settlementID, Actor: actor,
		}); err != nil {
			return result, err
		}
	}

	for index, shrink := range shrinks {
		reason := "shrink at " + location.Name
		if shrink.Quantity < 0 {
			reason = "extra stock counted at " + location.Name
		}
		key := fmt.Sprintf("settlement:%s:shrink:%d", settlementID, index)
		if _, err := tx.Exec(ctx, `
			INSERT INTO stock_movements
				(date, kind, location_id, jar_size_id, product_id, quantity,
				 settlement_id, idempotency_key, reason, created_by)
			VALUES ($1,'adjustment',$2,$3,$4,$5,$6,$7,$8,$9)`,
			reportedAt, location.ID, shrink.JarSizeID, shrink.ProductID,
			-shrink.Quantity, settlementID, key, reason, actor); err != nil {
			return result, err
		}
		// The global half. Without it the missing jar would come back to home
		// as the residual and the shrink would cost nothing.
		if _, err := tx.Exec(ctx, `
			INSERT INTO honey_movements
				(date, kind, jar_size_id, quantity, reason, settlement_id)
			VALUES ($1, 'jar_adjustment', $2, $3, $4, $5)`,
			reportedAt, shrink.JarSizeID, -shrink.Quantity, reason,
			settlementID); err != nil {
			return result, err
		}
	}

	result.Success = true
	result.AmountOwed = owed
	result.AmountPaid = req.AmountPaid
	result.BalanceDue = owed - req.AmountPaid
	result.Commission = commission
	return result, nil
}

func ptrUUID(id uuid.UUID) *uuid.UUID { return &id }

// stockWholesalePrices reads a location's wholesale list into a lookup, so a
// wholesale-basis settlement prices each jar size the way the list says.
func stockWholesalePrices(
	ctx context.Context,
	q inspectionQuerier,
	priceListID *uuid.UUID,
) (map[uuid.UUID]money, error) {
	prices := make(map[uuid.UUID]money)
	if priceListID == nil {
		return prices, nil
	}
	rows, err := q.Query(ctx, `
		SELECT jar_size_id, unit_price_cents FROM wholesale_price_list_items
		WHERE price_list_id=$1`, *priceListID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var id uuid.UUID
		var price money
		if err := rows.Scan(&id, &price); err != nil {
			return nil, err
		}
		prices[id] = price
	}
	return prices, rows.Err()
}

// POST /consignment-settlements/{id}/void — unwind a mis-entered report.
//
// Everything the settlement wrote is reversed rather than deleted: the return
// movements, the shrink at the location, its global counterpart, and the sale
// that recognised the revenue. Voiding twice is a 409.
func (s *Server) stockSettlementVoid(w http.ResponseWriter, r *http.Request) {
	id, err := uuidParam(r, "id")
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	var req struct {
		Reason *string `json:"reason"`
	}
	_ = decodeJSON(r, &req)

	ctx := r.Context()
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	defer tx.Rollback(ctx)

	var saleID *uuid.UUID
	var voidedAt *time.Time
	err = tx.QueryRow(ctx, `
		SELECT sale_id, voided_at FROM consignment_settlements WHERE id=$1 FOR UPDATE`, id).
		Scan(&saleID, &voidedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		writeError(w, http.StatusNotFound, "settlement not found")
		return
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	if voidedAt != nil {
		writeError(w, http.StatusConflict, "this settlement is already voided")
		return
	}

	actor := actorID(r)
	reason := inspectionTrimPtr(req.Reason)
	movementIDs, err := stockSettlementMovementIDs(ctx, tx, id)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	if len(movementIDs) > 0 {
		if _, err := stockReverseMovements(ctx, tx, movementIDs, reason, actor); err != nil {
			equipWriteError(w, err)
			return
		}
	}
	// The global half of any shrink, reversed the same way honey movements are
	// reversed everywhere else: a negating row that points at the original.
	if _, err := tx.Exec(ctx, `
		INSERT INTO honey_movements
			(date, kind, jar_size_id, quantity, reason, reverses_movement_id, settlement_id)
		SELECT now(), m.kind, m.jar_size_id, -m.quantity,
		       COALESCE($2, 'settlement voided'), m.id, m.settlement_id
		FROM honey_movements m
		WHERE m.settlement_id=$1 AND m.reverses_movement_id IS NULL
		ON CONFLICT DO NOTHING`, id, reason); err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	if saleID != nil {
		if _, err := tx.Exec(ctx, `
			UPDATE sales
			SET order_status='cancelled',
			    physical_applied_at=NULL,
			    cancelled_at=COALESCE(cancelled_at, now()),
			    cancelled_by=COALESCE(cancelled_by, $2),
			    cancellation_reason=COALESCE($3, cancellation_reason)
			WHERE id=$1`, *saleID, actor, reason); err != nil {
			writeError(w, http.StatusInternalServerError, "database error")
			return
		}
	}
	if _, err := tx.Exec(ctx, `
		UPDATE consignment_settlements
		SET voided_at=now(), voided_by=$2, void_reason=$3
		WHERE id=$1`, id, actor, reason); err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	if err := tx.Commit(ctx); err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"success": true, "id": id, "voided": true})
}

func stockSettlementMovementIDs(
	ctx context.Context,
	tx pgx.Tx,
	settlementID uuid.UUID,
) ([]uuid.UUID, error) {
	rows, err := tx.Query(ctx, `
		SELECT id FROM stock_movements
		WHERE settlement_id=$1 AND reverses_movement_id IS NULL
		ORDER BY id FOR UPDATE`, settlementID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	ids := make([]uuid.UUID, 0)
	for rows.Next() {
		var id uuid.UUID
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		ids = append(ids, id)
	}
	return ids, rows.Err()
}

// --- selling from a location other than home -------------------------------

type stockSaleLineInput struct {
	JarSizeID *uuid.UUID `json:"jarSizeId"`
	ProductID *uuid.UUID `json:"productId"`
	Quantity  int        `json:"quantity"`
	UnitPrice money      `json:"unitPrice"`
}

type stockSaleRequest struct {
	Date           string               `json:"date"`
	Channel        string               `json:"channel"`
	PaymentMethod  string               `json:"paymentMethod"`
	CustomerID     *uuid.UUID           `json:"customerId"`
	CustomerName   *string              `json:"customerName"`
	Location       *string              `json:"location"`
	DiscountAmount money                `json:"discountAmount"`
	AmountPaid     *money               `json:"amountPaid"`
	OrderNumber    *string              `json:"orderNumber"`
	Notes          *string              `json:"notes"`
	Lines          []stockSaleLineInput `json:"lines"`
}

// POST /stock-locations/{id}/sales — record a sale that came off THIS
// location's shelf rather than home's.
//
// Market day sells from home through /sales, which validates against home
// on-hand; this is its counterpart for a second farm stand, or anywhere the
// money is handed over on the spot. The lines decrement the named location
// because the sale carries stock_location_id, so home is untouched.
//
// A consignment shop that pays as it sells does NOT come through here. Its
// revenue is recognised by the settlement, which reconciles counts and payment
// in one action; letting a report also be entered as a plain sale would
// recognise the same jars twice.
func (s *Server) stockLocationSaleCreate(w http.ResponseWriter, r *http.Request) {
	locationID, err := uuidParam(r, "id")
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	var req stockSaleRequest
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
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
	if len(req.Lines) == 0 {
		writeError(w, http.StatusBadRequest, "Add at least one line")
		return
	}
	if req.PaymentMethod == "" {
		req.PaymentMethod = "cash"
	}
	if req.Channel == "" {
		req.Channel = "direct"
	}
	if !honeyPaymentMethods[req.PaymentMethod] || !honeySaleChannels[req.Channel] {
		writeError(w, http.StatusBadRequest, "invalid channel or payment method")
		return
	}
	if req.DiscountAmount < 0 {
		writeError(w, http.StatusBadRequest, "discount must not be negative")
		return
	}

	ctx := r.Context()
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	defer tx.Rollback(ctx)

	locations, err := s.stockLoadLocationsTx(ctx, tx, locationID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	if len(locations) == 0 {
		writeError(w, http.StatusNotFound, "location not found")
		return
	}
	location := locations[0]
	if location.IsHome {
		writeError(w, http.StatusBadRequest,
			"home sells through /sales, which validates against home stock")
		return
	}
	if location.IsConsignment {
		writeError(w, http.StatusConflict,
			"this is a consignment location: record their report instead, so the "+
				"counts and the payment land together")
		return
	}

	jarIDs := make([]uuid.UUID, 0, len(req.Lines))
	productIDs := make([]uuid.UUID, 0, len(req.Lines))
	for _, line := range req.Lines {
		if (line.JarSizeID == nil) == (line.ProductID == nil) {
			writeError(w, http.StatusBadRequest,
				"each line needs exactly one of jarSizeId or productId")
			return
		}
		if line.Quantity <= 0 || line.UnitPrice <= 0 {
			writeError(w, http.StatusBadRequest,
				"quantity and unitPrice must be greater than zero")
			return
		}
		if line.JarSizeID != nil {
			jarIDs = append(jarIDs, *line.JarSizeID)
		} else {
			productIDs = append(productIDs, *line.ProductID)
		}
	}
	if len(jarIDs) > 0 {
		if _, _, unknown, err := honeyLockJarSizes(ctx, tx, jarIDs); err != nil {
			writeError(w, http.StatusInternalServerError, "database error")
			return
		} else if unknown {
			writeError(w, http.StatusBadRequest, "invalid jarSizeId")
			return
		}
	}
	if len(productIDs) > 0 {
		unknown, err := stockLockProducts(ctx, tx, productIDs)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "database error")
			return
		}
		if unknown {
			writeError(w, http.StatusBadRequest, "invalid productId")
			return
		}
	}

	shelf, catalog, err := s.stockLocationShelf(ctx, tx, locationID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	available := make(map[string]int, len(shelf))
	labels := make(map[string]string, len(shelf))
	for _, row := range shelf {
		available[row.key()] = row.OnHand
		labels[row.key()] = row.Label
	}
	needed := make(map[string]int, len(req.Lines))
	saleLines := make([]saleConsignmentLine, 0, len(req.Lines))
	subtotal := money(0)
	for _, line := range req.Lines {
		key := stockLineKey(stockTransferLine{
			JarSizeID: line.JarSizeID, ProductID: line.ProductID,
		})
		needed[key] += line.Quantity
		kind := saleKindJar
		if line.ProductID != nil {
			kind = catalog.ProductKinds[*line.ProductID]
		}
		saleLines = append(saleLines, saleConsignmentLine{
			JarSizeID: line.JarSizeID, ProductID: line.ProductID, Kind: kind,
			Quantity: line.Quantity, UnitPrice: line.UnitPrice,
		})
		subtotal += line.UnitPrice.mulQuantity(line.Quantity)
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
			writeError(w, http.StatusBadRequest, fmt.Sprintf(
				"Not enough %s at %s: need %d, have %d",
				label, location.Name, needed[key], available[key]))
			return
		}
	}
	if req.DiscountAmount > subtotal {
		writeError(w, http.StatusBadRequest,
			"discount must be between zero and the subtotal")
		return
	}
	total := subtotal - req.DiscountAmount
	amountPaid := total
	if req.AmountPaid != nil {
		amountPaid = *req.AmountPaid
	}
	if amountPaid < 0 || amountPaid > total {
		writeError(w, http.StatusBadRequest,
			"amountPaid must be between zero and the total")
		return
	}

	saleID := uuid.New()
	orderNumber, err := saleRecordConsignmentReport(ctx, tx, saleConsignmentInput{
		SaleID:         saleID,
		LocationID:     location.ID,
		LocationName:   location.Name,
		CustomerID:     req.CustomerID,
		CustomerName:   inspectionTrimPtr(req.CustomerName),
		Location:       inspectionTrimPtr(req.Location),
		Date:           date,
		Channel:        req.Channel,
		PaymentMethod:  req.PaymentMethod,
		TotalAmount:    total,
		DiscountAmount: req.DiscountAmount,
		AmountPaid:     amountPaid,
		OrderNumber:    inspectionTrimPtr(req.OrderNumber),
		Notes:          inspectionTrimPtr(req.Notes),
		Lines:          saleLines,
		Actor:          actorID(r),
	})
	if err != nil {
		equipWriteError(w, err)
		return
	}
	if err := tx.Commit(ctx); err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{
		"success": true, "id": saleID, "orderNumber": orderNumber,
		"subtotal": subtotal, "discountAmount": req.DiscountAmount,
		"totalAmount": total, "amountPaid": amountPaid,
		"balanceDue": total - amountPaid,
	})
}
