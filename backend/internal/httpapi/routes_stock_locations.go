package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"regexp"
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

// Stock locations: finished goods that live somewhere other than home.
//
// The bike shop sells jars on the operator's behalf and pays as they sell, so
// handing them 24 jars is neither a sale nor shrink. It is a TRANSFER: stock
// moves, revenue does not. The jars stay the operator's inventory but stop
// being available at market day, and when the shop reports "we sold 9, here is
// $X" that report is an ordinary sale — location-scoped, channel consignment,
// with the money a receivable until it lands.
//
// Nothing here is a second ledger. Quantities derive from inventory movements
// and reservations, and home is an ordinary inventory location. The three
// rules the roadmap set out are enforced in exactly one place each:
//
//   - never recognise revenue on a transfer  -> stockTransfer writes movements
//     and nothing else; no sale row, no money column is touched.
//   - never let home stock-validation count consigned jars -> honeyLockJarSizes
//     subtracts stockAwayJarTotals.
//   - every movement idempotent and reversible -> inventory_operations carries
//     a unique idempotency key and reversal pointer whose negation nets the
//     pair to zero.

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
	SELECT l.id, l.name, COALESCE(l.slug, ''), l.is_home, l.is_consignment, l.customer_id, c.name,
	       l.price_basis, l.commission_bps, l.wholesale_price_list_id, w.name,
	       l.settlement_cadence, l.address, l.notes, l.is_active, l.created_at, l.updated_at
	FROM inventory_locations l
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

	rows, err = s.pool.Query(ctx, `
		SELECT location_id, COALESCE(SUM(on_hand), 0)::int
		FROM inventory_balances
		GROUP BY location_id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	units := make(map[uuid.UUID]int)
	for rows.Next() {
		var id uuid.UUID
		var quantity int
		if err := rows.Scan(&id, &quantity); err != nil {
			return nil, err
		}
		units[id] = quantity
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}

	balances, err := stockOutstandingByLocation(ctx, s.pool)
	if err != nil {
		return nil, err
	}
	for i := range locations {
		locations[i].OnHandUnits = units[locations[i].ID]
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
		SELECT l.id,
		       COALESCE(SUM(total_amount_cents - amount_paid_cents), 0)
		FROM sales s
		JOIN inventory_locations l
		  ON l.id=s.stock_location_id
		  OR (l.source_type='stock_location' AND l.source_id=s.stock_location_id)
		WHERE s.stock_location_id IS NOT NULL AND s.order_status <> 'cancelled'
		GROUP BY l.id`)
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
		`WHERE l.deleted_at IS NULL AND (l.kind='consignee' OR l.is_home)
		 ORDER BY l.is_home DESC, lower(l.name)`)
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
		INSERT INTO inventory_locations
			(kind, name, slug, is_consignment, customer_id, price_basis, commission_bps,
			 wholesale_price_list_id, settlement_cadence, address, notes, is_active, created_by)
		VALUES ('consignee',$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
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
	// This endpoint replaces the whole location. Defaulting an omitted
	// priceBasis/cadence/isActive here would silently convert a commission
	// location to retail (handing the shop's cut to revenue), so a partial
	// body is refused loudly instead.
	if payload.PriceBasis == "" || payload.SettlementCadence == "" || payload.IsActive == nil {
		writeError(w, http.StatusBadRequest,
			"priceBasis, settlementCadence, and isActive are required: this endpoint replaces the whole location")
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
	isActive := *payload.IsActive
	// Home cannot become a consignment location: its stock is the operator's
	// own by definition, and the database CHECK says so too.
	var updatedID uuid.UUID
	err = s.pool.QueryRow(r.Context(), `
		UPDATE inventory_locations
		SET name=$2, is_consignment=$3, customer_id=$4, price_basis=$5, commission_bps=$6,
		    wholesale_price_list_id=$7, settlement_cadence=$8, address=$9, notes=$10,
		    is_active=$11
		WHERE (id=$1 OR (source_type='stock_location' AND source_id=$1))
		  AND deleted_at IS NULL AND kind='consignee' AND NOT is_home
		RETURNING id`,
		id, payload.Name, payload.IsConsignment, payload.CustomerID, payload.PriceBasis,
		bps, payload.WholesalePriceListID, payload.SettlementCadence,
		inspectionTrimPtr(payload.Address), inspectionTrimPtr(payload.Notes), isActive).Scan(&updatedID)
	if errors.Is(err, pgx.ErrNoRows) {
		writeError(w, http.StatusNotFound, "location not found, or home cannot be edited")
		return
	}
	if err != nil {
		writeDBError(w, err, "a location with that name already exists",
			"invalid customer or wholesale price list")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"success": true, "id": updatedID})
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
	resolvedID, err := production.ResolveLocationID(ctx, s.pool, id)
	if app.IsKind(err, app.KindNotFound) {
		writeError(w, http.StatusNotFound, "location not found")
		return
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	onHand, _, err := s.stockLocationShelf(ctx, s.pool, resolvedID)
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
	var deletedID uuid.UUID
	err = s.pool.QueryRow(ctx, `
		UPDATE inventory_locations SET deleted_at=now(), is_active=false
		WHERE id=$1 AND deleted_at IS NULL AND kind='consignee' AND NOT is_home
		RETURNING id`, resolvedID).Scan(&deletedID)
	if errors.Is(err, pgx.ErrNoRows) {
		writeError(w, http.StatusNotFound, "location not found, or home cannot be deleted")
		return
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"success": true, "id": deletedID})
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

// GET /stock-locations/inventory — every SKU across every location.
//
// The away-from-home ledger already answers all of it in ONE pass
// (stockAwayQuantities returns per-location, per-SKU quantities for every
// location at once), so this builds the matrix from that plus the two global
// inventory formulas. It used to call stockLocationShelf once per location,
// which re-read the whole ledger each time — fine at two locations, quadratic
// at twenty.
func (s *Server) stockInventoryHandler(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	locations, err := s.stockLoadLocations(ctx,
		`WHERE l.deleted_at IS NULL AND (l.kind='consignee' OR l.is_home)
		 ORDER BY l.is_home DESC, lower(l.name)`)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	catalog, err := stockLoadSKUs(ctx, s.pool)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	globalJars, err := honeyJarInventoryWithQuerier(ctx, s.pool)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	globalProducts, err := productInventoryQuery(ctx, s.pool)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	away, err := stockAwayQuantities(ctx, s.pool)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	var homeID uuid.UUID
	for _, location := range locations {
		if location.IsHome {
			homeID = location.ID
		}
	}

	// Home is the residual: the global count minus everything standing away.
	homeJars := make(map[uuid.UUID]int, len(globalJars))
	for _, row := range globalJars {
		homeJars[row.JarSizeID] = row.OnHand
	}
	homeProducts := make(map[uuid.UUID]int, len(globalProducts))
	for _, row := range globalProducts {
		homeProducts[row.ID] = row.OnHand
	}
	awayJars := make(map[uuid.UUID]map[string]int)
	awayProducts := make(map[uuid.UUID]map[string]int)
	for _, row := range away {
		if row.Quantity == 0 {
			continue
		}
		if row.JarSizeID != nil {
			if awayJars[*row.JarSizeID] == nil {
				awayJars[*row.JarSizeID] = map[string]int{}
			}
			awayJars[*row.JarSizeID][row.LocationID.String()] += row.Quantity
			homeJars[*row.JarSizeID] -= row.Quantity
		}
		if row.ProductID != nil {
			if awayProducts[*row.ProductID] == nil {
				awayProducts[*row.ProductID] = map[string]int{}
			}
			awayProducts[*row.ProductID][row.LocationID.String()] += row.Quantity
			homeProducts[*row.ProductID] -= row.Quantity
		}
	}

	// Catalog order, jars then products — the order stockLocationShelf reports,
	// so the matrix and a single shelf agree about what comes first.
	items := make([]stockInventoryRow, 0, len(catalog.JarOrder)+len(catalog.ProductOrder))
	appendRow := func(row stockInventoryRow, home int, elsewhere map[string]int) {
		if home != 0 {
			row.ByLocation[homeID.String()] = home
			row.Total += home
		}
		for locationID, quantity := range elsewhere {
			if quantity == 0 {
				continue
			}
			row.ByLocation[locationID] += quantity
			row.Total += quantity
		}
		if len(row.ByLocation) == 0 {
			return
		}
		items = append(items, row)
	}
	for _, id := range catalog.JarOrder {
		jarID := id
		appendRow(stockInventoryRow{
			JarSizeID: &jarID, Label: catalog.JarLabels[id], Kind: saleKindJar,
			UnitPrice: catalog.JarPrices[id], ByLocation: map[string]int{},
		}, homeJars[id], awayJars[id])
	}
	for _, id := range catalog.ProductOrder {
		productID := id
		price := catalog.ProductPrice[id]
		appendRow(stockInventoryRow{
			ProductID: &productID, Label: catalog.ProductNames[id],
			Kind: catalog.ProductKinds[id], UnitPrice: &price,
			ByLocation: map[string]int{},
		}, homeProducts[id], awayProducts[id])
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
	locations, err := s.stockLoadLocations(ctx, `
		WHERE (l.id=$1 OR (l.source_type='stock_location' AND l.source_id=$1))
		  AND l.deleted_at IS NULL AND (l.kind='consignee' OR l.is_home)`, id)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	if len(locations) == 0 {
		writeError(w, http.StatusNotFound, "location not found")
		return
	}
	locationID := locations[0].ID
	shelf, _, err := s.stockLocationShelf(ctx, s.pool, locationID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}

	// Unsettled = reported sold but not yet paid for. Straight off the sale's
	// invoiced-vs-collected columns; consignment adds no payment table.
	saleRows, err := s.pool.Query(ctx, `
		SELECT s.id, s.date, s.order_number, s.order_status,
		       s.total_amount_cents, s.amount_paid_cents
		FROM sales s
		JOIN inventory_locations l
		  ON l.id=s.stock_location_id
		  OR (l.source_type='stock_location' AND l.source_id=s.stock_location_id)
		WHERE l.id=$1 AND s.order_status <> 'cancelled'
		  AND s.amount_paid_cents < s.total_amount_cents
		ORDER BY s.date DESC, s.created_at DESC
		LIMIT 100`, locationID)
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

	movements, err := s.stockMovementHistory(ctx, locationID, 100)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	settlements, err := s.stockSettlementRows(ctx, locationID)
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

// stockMovementHistory is one location's operation history. The row id is
// inventory_operations.id since the ledger landed (spec 8.1, R10), and "is
// this reversed" is an EXISTS over reverses_operation_id rather than a stored
// back-pointer (review Q3).
func (s *Server) stockMovementHistory(
	ctx context.Context,
	locationID uuid.UUID,
	limit int,
) ([]stockMovementRow, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT o.id, o.occurred_at,
		       CASE
		         WHEN o.kind = 'transfer' AND SUM(m.quantity) > 0 THEN 'transfer'
		         WHEN o.kind = 'transfer' THEN 'transfer'
		         WHEN o.kind = 'return' THEN 'return'
		         WHEN o.kind IN ('shrink', 'count_adjust') THEN 'adjustment'
		         WHEN o.kind = 'sale_consume' THEN 'sale'
		         ELSE o.kind
		       END,
		       COALESCE(MIN(js.label), MIN(pc.name), 'unknown'),
		       SUM(m.quantity)::int,
		       MIN(counterparty.name),
		       MIN(hl.lot_code),
		       NULLIF(o.details ->> 'reason_text', ''),
		       NULLIF(o.details ->> 'notes', ''),
		       o.reverses_operation_id IS NOT NULL,
		       (SELECT rev.id FROM inventory_operations rev
		        WHERE rev.reverses_operation_id = o.id),
		       NULLIF(o.details ->> 'settlement_id', '')::uuid
		FROM inventory_operations o
		JOIN inventory_movements m ON m.operation_id = o.id
		JOIN inventory_locations loc ON loc.id = m.location_id
		LEFT JOIN jar_sizes js ON js.item_id = m.item_id
		LEFT JOIN product_catalog pc ON pc.item_id = m.item_id
		LEFT JOIN inventory_lots lot ON lot.id = m.lot_id
		LEFT JOIN harvest_lots hl ON hl.id = lot.source_id AND lot.source_type = 'harvest_lot'
		LEFT JOIN inventory_locations counterparty
		       ON counterparty.id <> loc.id
		      AND counterparty.id IN (
			SELECT other.location_id FROM inventory_movements other
			WHERE other.operation_id = o.id AND other.location_id <> loc.id)
		WHERE loc.id = $1
		GROUP BY o.id
		ORDER BY o.occurred_at DESC, o.created_at DESC
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

	transferID := uuid.New()
	var source, destination uuid.UUID
	err = s.runInUnitOfWork(r, func(ctx context.Context, uow *app.UnitOfWork) error {
		homeID, err := stockHomeLocationID(ctx, uow)
		if err != nil {
			return equipFail(http.StatusInternalServerError, "database error")
		}
		// A transfer sends stock TO the named location; a return sends it back.
		// Either way the counterparty defaults to home, and shop-to-shop is a
		// plain transfer with an explicit fromLocationId.
		source, destination = homeID, locationID
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
			return equipFail(http.StatusBadRequest, "a transfer needs two different locations")
		}
		if err := stockRequireLive(ctx, uow, source); err != nil {
			return err
		}
		if err := stockRequireLive(ctx, uow, destination); err != nil {
			return err
		}
		return s.stockWriteMovements(ctx, uow, stockWriteInput{
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
		})
	})
	if err != nil {
		writeCommandError(w, err)
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

// stockWriteMovements moves stock between two locations as ONE transfer
// operation whose lines net to zero per (item, lot, condition, container).
//
// It takes no SKU row locks any more. Review A4 made the inventory service the
// only quantity locker: it takes the tuple advisory locks in a documented
// order inside Record, which is the same guarantee honeyLockJarSizes and
// stockLockProducts used to give and one discipline instead of two.
func (s *Server) stockWriteMovements(
	ctx context.Context,
	uow *app.UnitOfWork,
	input stockWriteInput,
) error {
	lines := make([]sales.TransferLine, 0, len(input.Lines))
	for _, line := range input.Lines {
		if line.Quantity <= 0 {
			return stockBadRequest("quantity must be greater than zero")
		}
		if (line.JarSizeID == nil) == (line.ProductID == nil) {
			return stockBadRequest("each line needs exactly one of jarSizeId or productId")
		}
		var itemID uuid.UUID
		var err error
		if line.JarSizeID != nil {
			itemID, err = production.EnsureJarItem(ctx, uow, *line.JarSizeID)
			if app.IsKind(err, app.KindNotFound) {
				return stockBadRequest("invalid jarSizeId")
			}
		} else {
			itemID, err = production.EnsureProductItem(ctx, uow, *line.ProductID)
			if app.IsKind(err, app.KindNotFound) {
				return stockBadRequest("invalid productId")
			}
		}
		if err != nil {
			return err
		}
		// A line that names a bottling run travels on that run's lot, so
		// Honey Story still answers after the jars have moved.
		var lotID *uuid.UUID
		if line.BottlingRunID != nil && line.JarSizeID != nil {
			var harvestLotID uuid.UUID
			if err := uow.QueryRow(ctx,
				`SELECT lot_id FROM bottling_runs WHERE id=$1`, line.BottlingRunID).
				Scan(&harvestLotID); err != nil {
				if errors.Is(err, pgx.ErrNoRows) {
					return stockBadRequest("invalid bottlingRunId")
				}
				return err
			}
			resolved, err := production.EnsureJarLotForHarvestLot(ctx, uow, itemID, harvestLotID)
			if err != nil {
				return err
			}
			lotID = &resolved
		}
		lines = append(lines, sales.TransferLine{
			ItemID: itemID, LotID: lotID, Quantity: line.Quantity,
		})
	}

	sourceType := "stock_transfer"
	sourceID := uuid.New()
	if input.TransferID != nil {
		sourceID = *input.TransferID
	}
	if input.SettlementID != nil {
		sourceType = "consignment_settlement_" + input.Kind
		sourceID = *input.SettlementID
	}
	sourceLocation, err := production.EnsureLocationForStockLocation(ctx, uow, input.Source)
	if err != nil {
		return err
	}
	destination, err := production.EnsureLocationForStockLocation(ctx, uow, input.Destination)
	if err != nil {
		return err
	}
	_, err = sales.New().Transfer(ctx, uow, sales.TransferInput{
		TransferID: sourceID, SourceType: sourceType, Returning: input.Kind == "return",
		From: sourceLocation, To: destination, Date: input.Date,
		Lines: lines, Reason: input.Reason, Notes: input.Notes,
	})
	if app.IsKind(err, app.KindPrecondition) {
		// The shelf could not cover the move. Name the SKU the way the
		// operator sees it rather than by tuple identity.
		return stockBadRequest("Not enough stock at the source location: %s", messageOf(err))
	}
	return err
}

// messageOf reports an application error's operator-facing sentence.
func messageOf(err error) string {
	var typed *app.Error
	if errors.As(err, &typed) && typed.Message != "" {
		return typed.Message
	}
	if err != nil {
		return err.Error()
	}
	return ""
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

func stockRequireLive(ctx context.Context, q inspectionQuerier, id uuid.UUID) error {
	var deleted *time.Time
	err := q.QueryRow(ctx,
		`SELECT deleted_at FROM inventory_locations
		 WHERE (id=$1 OR (source_type='stock_location' AND source_id=$1))
		   AND (kind='consignee' OR is_home)
		 ORDER BY (id=$1) DESC LIMIT 1`, id).Scan(&deleted)
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
// the transfer's operation is negated line for line, so the pair still nets to
// zero and the history keeps both. Reversing twice is refused by the ledger's
// partial unique index on reverses_operation_id (review Q3), not by a race in
// application code.
//
// The {id} is an inventory_operations id since the ledger landed; the
// stock_movements table it used to name is being retired (spec 8.1, R10).
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

	commands := sales.New()
	var reversed int
	err = s.runInUnitOfWork(r, func(ctx context.Context, uow *app.UnitOfWork) error {
		var sourceType string
		var sourceID uuid.UUID
		var reverses *uuid.UUID
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
			return equipFail(http.StatusConflict, "already reversed")
		}
		if strings.HasPrefix(sourceType, "consignment_settlement") {
			// A settlement's movements move with its sale; unwinding one half
			// would leave revenue recognised against stock that came back.
			return equipFail(http.StatusConflict,
				"this movement belongs to a settlement; void the settlement instead")
		}
		if sourceType != "stock_transfer" {
			return equipFail(http.StatusConflict,
				"this movement is not a stock transfer; undo it where it was recorded")
		}
		// Reverse the whole transfer, not one leg: both halves are lines of
		// one operation, so there is no half-reversed state to reach.
		reversed, err = commands.ReverseSource(ctx, uow, sourceType, sourceID)
		if err != nil {
			return err
		}
		if reversed == 0 {
			return equipFail(http.StatusConflict, "already reversed")
		}
		return nil
	})
	if err != nil {
		writeCommandError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"success": true, "reversed": reversed, "id": id,
	})
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

	// Opening: the location's balance before the period. Every location owns
	// its movements now, so this is one read of the ledger rather than
	// "movements here minus sales scoped here".
	openingRows, err := q.Query(ctx, `
		SELECT js.id, pc.id, SUM(m.quantity)::int
		FROM inventory_movements m
		JOIN inventory_operations o ON o.id = m.operation_id
		JOIN inventory_locations loc ON loc.id = m.location_id
		LEFT JOIN jar_sizes js ON js.item_id = m.item_id
		LEFT JOIN product_catalog pc ON pc.item_id = m.item_id
		WHERE loc.id = $1
		  AND o.occurred_at < $2
		  AND (js.id IS NOT NULL OR pc.id IS NOT NULL)
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

	// Movements inside the period, split by what they mean to the shop. A
	// reversal is classified through the operation it negates, so a reversed
	// transfer nets out of both columns instead of appearing as its own move.
	movementRows, err := q.Query(ctx, `
		SELECT js.id, pc.id,
		       COALESCE(SUM(m.quantity) FILTER (WHERE k.kind='transfer' AND m.quantity > 0), 0)::int,
		       COALESCE(SUM(-m.quantity) FILTER (WHERE k.kind='transfer' AND m.quantity < 0), 0)::int,
		       COALESCE(SUM(-m.quantity) FILTER (WHERE k.kind='return'), 0)::int,
		       COALESCE(SUM(-m.quantity) FILTER (WHERE k.kind IN ('shrink','count_adjust')), 0)::int
		FROM inventory_movements m
		JOIN inventory_operations o ON o.id = m.operation_id
		LEFT JOIN inventory_operations orig ON orig.id = o.reverses_operation_id
		CROSS JOIN LATERAL (SELECT COALESCE(orig.kind, o.kind) AS kind) k
		JOIN inventory_locations loc ON loc.id = m.location_id
		LEFT JOIN jar_sizes js ON js.item_id = m.item_id
		LEFT JOIN product_catalog pc ON pc.item_id = m.item_id
		WHERE loc.id = $1
		  AND o.occurred_at >= $2 AND o.occurred_at < $3
		  AND (js.id IS NOT NULL OR pc.id IS NOT NULL)
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
		FROM sale_items si
		JOIN sales s ON s.id = si.sale_id
		JOIN inventory_locations loc
		  ON loc.id=s.stock_location_id
		  OR (loc.source_type='stock_location' AND loc.source_id=s.stock_location_id)
		WHERE loc.id=$1 AND s.order_status <> 'cancelled'
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
		FROM sales s
		JOIN inventory_locations loc
		  ON loc.id=s.stock_location_id
		  OR (loc.source_type='stock_location' AND loc.source_id=s.stock_location_id)
		WHERE loc.id=$1 AND s.order_status <> 'cancelled'
		  AND date >= $2 AND date < $3`, location.ID, start, end).
		Scan(&statement.AmountInvoiced, &statement.AmountCollected); err != nil {
		return stockStatement{}, err
	}
	statement.AmountOwed = statement.AmountInvoiced - statement.AmountCollected
	if err := q.QueryRow(ctx, `
		SELECT COALESCE(SUM(cs.commission_cents), 0)
		FROM consignment_settlements cs
		JOIN inventory_locations loc
		  ON loc.id=cs.location_id
		  OR (loc.source_type='stock_location' AND loc.source_id=cs.location_id)
		WHERE loc.id=$1 AND cs.voided_at IS NULL
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
	locations, err := s.stockLoadLocations(ctx, `
		WHERE (l.id=$1 OR (l.source_type='stock_location' AND l.source_id=$1))
		  AND l.deleted_at IS NULL AND l.kind='consignee'`, id)
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
	shelf, _, err := s.stockLocationShelf(ctx, s.pool, locations[0].ID)
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
		JOIN inventory_locations loc
		  ON loc.id=cs.location_id
		  OR (loc.source_type='stock_location' AND loc.source_id=cs.location_id)
		LEFT JOIN sales s ON s.id = cs.sale_id
		WHERE loc.id=$1
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
	resolvedID, err := production.ResolveLocationID(r.Context(), s.pool, id)
	if app.IsKind(err, app.KindNotFound) {
		writeError(w, http.StatusNotFound, "location not found")
		return
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	settlements, err := s.stockSettlementRows(r.Context(), resolvedID)
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

	commandLines := make([]sales.SettlementLine, 0, len(req.Lines))
	for _, line := range req.Lines {
		var unitPrice *int64
		if line.UnitPrice != nil {
			value := int64(*line.UnitPrice)
			unitPrice = &value
		}
		commandLines = append(commandLines, sales.SettlementLine{
			JarSizeID: line.JarSizeID, ProductID: line.ProductID,
			QuantitySold: line.QuantitySold, QuantityReturned: line.QuantityReturned,
			UnitPriceCents: unitPrice, CountOnShelf: line.CountOnShelf,
		})
	}
	var result sales.ApplySettlementResult
	err = s.runInUnitOfWork(r, func(ctx context.Context, uow *app.UnitOfWork) error {
		var err error
		result, err = sales.ApplySettlement(ctx, uow, sales.ApplySettlementInput{
			LocationID: locationID, PeriodStart: periodStart, PeriodEnd: periodEnd,
			ReportedAt: reportedAt, Lines: commandLines, AmountPaidCents: int64(req.AmountPaid),
			PaymentMethod: req.PaymentMethod, OrderNumber: req.OrderNumber, Notes: req.Notes,
		})
		return err
	})
	if err != nil {
		writeCommandError(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, result)
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

	commands := sales.New()
	err = s.runInUnitOfWork(r, func(ctx context.Context, uow *app.UnitOfWork) error {
		var saleID *uuid.UUID
		var voidedAt *time.Time
		err := uow.QueryRow(ctx, `
			SELECT sale_id, voided_at FROM consignment_settlements WHERE id=$1 FOR UPDATE`, id).
			Scan(&saleID, &voidedAt)
		if errors.Is(err, pgx.ErrNoRows) {
			return equipFail(http.StatusNotFound, "settlement not found")
		}
		if err != nil {
			return err
		}
		if voidedAt != nil {
			return equipFail(http.StatusConflict, "this settlement is already voided")
		}

		actor := actorID(r)
		reason := inspectionTrimPtr(req.Reason)
		// Everything the settlement wrote is reversed rather than deleted: the
		// return transfer, the shrink at the consignee, and the sale that
		// recognised the revenue. Each is an operation this settlement is the
		// source of, so the undo is one sweep rather than four table-specific
		// unwinds.
		for _, sourceType := range []string{
			"consignment_settlement_return",
			"consignment_settlement",
		} {
			if _, err := commands.ReverseSource(ctx, uow, sourceType, id); err != nil {
				return err
			}
		}
		if saleID != nil {
			if err := commands.Unapply(ctx, uow, *saleID); err != nil {
				return err
			}
			if _, err := uow.Exec(ctx, `
				UPDATE sales
				SET order_status='cancelled',
				    physical_applied_at=NULL,
				    cancelled_at=COALESCE(cancelled_at, now()),
				    cancelled_by=COALESCE(cancelled_by, $2),
				    cancellation_reason=COALESCE($3, cancellation_reason)
				WHERE id=$1`, *saleID, actor, reason); err != nil {
				return err
			}
		}
		_, err = uow.Exec(ctx, `
			UPDATE consignment_settlements
			SET voided_at=now(), voided_by=$2, void_reason=$3
			WHERE id=$1`, id, actor, reason)
		return err
	})
	if err != nil {
		writeCommandError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"success": true, "id": id, "voided": true})
}

// A settlement's movements are inventory operations whose source is the
// settlement, so undoing them is sales.Service.ReverseSource rather than a
// hand-rolled list of stock_movements ids.

// --- selling from a location other than home -------------------------------
//
// There is now ONE way to record a sale: POST /sales, which takes an optional
// stockLocationId and validates the lines against that location's shelf
// (omitted or home means home stock). Two endpoints doing the same arithmetic
// is how the two of them drift apart, so the location-scoped one is retired.
//
// POST /stock-locations/{id}/sales survives for one release as a thin delegate
// that names the location from the URL and hands the request to /sales
// unchanged. It is marked Deprecated in the response headers; delete it once
// no client calls it.

// stockSaleDeprecation is the sunset window announced to callers. RFC 8594
// asks for a date, and one release is what the roadmap promised.
const stockSaleDeprecationNote = `deprecated: POST /sales accepts stockLocationId; ` +
	`this route will be removed after the next release`

// POST /stock-locations/{id}/sales
//
// Deprecated: use POST /sales with stockLocationId. The body is identical
// apart from that field, so this rewrites the decoded body to carry the id
// from the path and re-dispatches. Every rule — the shelf check, the
// consignment refusal, the line kinds, the money arithmetic — then lives in
// exactly one handler.
func (s *Server) stockLocationSaleCreate(w http.ResponseWriter, r *http.Request) {
	locationID, err := uuidParam(r, "id")
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	// Decoded loosely on purpose: /sales still validates every field with
	// DisallowUnknownFields, so a typo is refused there rather than twice.
	var body map[string]any
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if body == nil {
		body = map[string]any{}
	}
	// The path is the authority. A body naming a different location would make
	// the URL a lie.
	body["stockLocationId"] = locationID.String()
	encoded, err := json.Marshal(body)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	w.Header().Set("Deprecation", "true")
	w.Header().Set("Warning", `299 - "`+stockSaleDeprecationNote+`"`)
	w.Header().Set("Link", `</api/v1/sales>; rel="successor-version"`)

	delegated := r.Clone(r.Context())
	delegated.Body = io.NopCloser(bytes.NewReader(encoded))
	delegated.ContentLength = int64(len(encoded))
	s.honeyRecordSale(w, delegated)
}
