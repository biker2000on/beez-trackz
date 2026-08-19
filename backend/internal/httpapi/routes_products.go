package httpapi

import (
	"context"
	"errors"
	"fmt"
	"math"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

const (
	saleKindCreamedHoney = "creamed_honey"
	saleKindHotHoney     = "hot_honey"
	saleKindMead         = "mead"
	saleKindPropolis     = "propolis"
	saleKindTincture     = "tincture"

	gramsPerOunce = 28.349523125
)

var saleProductKinds = map[string]bool{
	saleKindCreamedHoney: true,
	saleKindHotHoney:     true,
	saleKindMead:         true,
	saleKindPropolis:     true,
	saleKindTincture:     true,
}

var productBatchKinds = map[string]bool{
	saleKindCreamedHoney: true,
	saleKindHotHoney:     true,
	saleKindMead:         true,
	saleKindTincture:     true,
}

var productCatalogUnits = map[string]bool{
	"bottle": true, "jar": true, "tin": true, "each": true,
}

func saleKindIsProduct(kind string) bool {
	return saleProductKinds[kind]
}

func (s *Server) mountProducts(r chi.Router) {
	admin := r.With(s.requireAdmin)
	admin.Get("/products", s.productList)
	admin.Post("/products", s.productCreate)
	admin.Patch("/products/{id}", s.productUpdate)

	admin.Get("/propolis-harvests", s.propolisHarvestList)
	admin.Post("/propolis-harvests", s.propolisHarvestCreate)
	admin.Delete("/propolis-harvests/{id}", s.propolisHarvestDelete)
	admin.Get("/propolis/on-hand", s.propolisOnHandHandler)

	admin.Get("/product-batches", s.productBatchList)
	admin.Post("/product-batches", s.productBatchCreate)
}

type productInventoryRow struct {
	ID           uuid.UUID `json:"id"`
	Name         string    `json:"name"`
	Kind         string    `json:"kind"`
	Unit         string    `json:"unit"`
	DefaultPrice money     `json:"defaultPrice"`
	SizeLabel    *string   `json:"sizeLabel"`
	NetGrams     *float64  `json:"netGrams"`
	IsActive     bool      `json:"isActive"`
	Made         int       `json:"made"`
	Sold         int       `json:"sold"`
	OnHand       int       `json:"onHand"`
	InStock      bool      `json:"inStock"`
	CreatedAt    time.Time `json:"createdAt"`
	UpdatedAt    time.Time `json:"updatedAt"`
}

func productInventoryQuery(ctx context.Context, q inspectionQuerier) ([]productInventoryRow, error) {
	rows, err := q.Query(ctx, `
		SELECT p.id, p.name, p.kind, p.unit, p.default_price_cents, p.size_label, p.net_grams,
		       p.is_active, p.created_at, p.updated_at,
		       COALESCE(b.made, 0), COALESCE(s.sold, 0)
		FROM product_catalog p
		LEFT JOIN (
			SELECT product_id, SUM(quantity_out) AS made
			FROM product_batches
			GROUP BY product_id
		) b ON b.product_id = p.id
		LEFT JOIN (
			SELECT si.product_id, SUM(si.quantity) AS sold
			FROM sale_items si
			JOIN sales sale ON sale.id = si.sale_id
			WHERE sale.order_status <> 'cancelled' AND si.product_id IS NOT NULL
			GROUP BY si.product_id
		) s ON s.product_id = p.id
		ORDER BY p.kind, p.name, p.size_label NULLS FIRST`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]productInventoryRow, 0)
	for rows.Next() {
		var row productInventoryRow
		if err := rows.Scan(&row.ID, &row.Name, &row.Kind, &row.Unit, &row.DefaultPrice,
			&row.SizeLabel, &row.NetGrams, &row.IsActive, &row.CreatedAt, &row.UpdatedAt,
			&row.Made, &row.Sold); err != nil {
			return nil, err
		}
		row.OnHand = row.Made - row.Sold
		row.InStock = row.OnHand > 0
		out = append(out, row)
	}
	return out, rows.Err()
}

// productCatalogLock is what productLockCatalogInfo reads under row locks:
// per-SKU inventory plus the propolis net weight each SKU carries.
type productCatalogLock struct {
	OnHand   map[uuid.UUID]int
	Labels   map[uuid.UUID]string
	Kinds    map[uuid.UUID]string
	NetGrams map[uuid.UUID]float64
}

// productLockCatalog is the legacy wrapper around productLockCatalogInfo.
func productLockCatalog(
	ctx context.Context,
	tx inspectionQuerier,
	ids []uuid.UUID,
) (onHand map[uuid.UUID]int, labels map[uuid.UUID]string, kinds map[uuid.UUID]string, unknown bool, err error) {
	info, unknown, err := productLockCatalogInfo(ctx, tx, ids)
	if err != nil || unknown {
		return nil, nil, nil, unknown, err
	}
	return info.OnHand, info.Labels, info.Kinds, false, nil
}

func productLockCatalogInfo(
	ctx context.Context,
	tx inspectionQuerier,
	ids []uuid.UUID,
) (info productCatalogLock, unknown bool, err error) {
	sorted := append([]uuid.UUID(nil), ids...)
	sort.Slice(sorted, func(i, j int) bool { return sorted[i].String() < sorted[j].String() })
	unique := make([]uuid.UUID, 0, len(sorted))
	for i, id := range sorted {
		if i == 0 || sorted[i-1] != id {
			unique = append(unique, id)
		}
	}
	rows, err := tx.Query(ctx, `
		SELECT id FROM product_catalog WHERE id = ANY($1) ORDER BY id FOR UPDATE`, unique)
	if err != nil {
		return info, false, err
	}
	locked := 0
	for rows.Next() {
		locked++
	}
	lockErr := rows.Err()
	rows.Close()
	if lockErr != nil {
		return info, false, lockErr
	}
	if locked != len(unique) {
		return info, true, nil
	}
	inventory, err := productInventoryQuery(ctx, tx)
	if err != nil {
		return info, false, err
	}
	info.OnHand = make(map[uuid.UUID]int, len(inventory))
	info.Labels = make(map[uuid.UUID]string, len(inventory))
	info.Kinds = make(map[uuid.UUID]string, len(inventory))
	info.NetGrams = make(map[uuid.UUID]float64, len(inventory))
	for _, row := range inventory {
		info.OnHand[row.ID] = row.OnHand
		label := row.Name
		if row.SizeLabel != nil && *row.SizeLabel != "" {
			label = row.Name + " · " + *row.SizeLabel
		}
		info.Labels[row.ID] = label
		info.Kinds[row.ID] = row.Kind
		if row.NetGrams != nil {
			info.NetGrams[row.ID] = *row.NetGrams
		}
	}
	return info, false, nil
}

// productCheckAvailability refuses lines that exceed what is on hand.
//
// Raw propolis SKUs are sold straight off propolis_harvests, not out of a
// packaged batch, so their per-SKU onHand (made - sold) is meaningless. Since
// migration 00022 product_catalog.net_grams records the grams each propolis
// unit carries (required for kind=propolis), so a propolis line needs
// quantity × net_grams of harvested propolis — counted after every earlier
// propolis line in the same sale — against propolisGrams (harvested minus
// tincture batches minus already-sold propolis lines). A propolis SKU with no
// net weight falls back to "any harvest remains at all".
//
// The legacy five-argument form has no per-SKU weights; callers that know them
// should use productCheckAvailabilityGrams.
func productCheckAvailability(
	onHand map[uuid.UUID]int,
	labels map[uuid.UUID]string,
	kinds map[uuid.UUID]string,
	needed map[uuid.UUID]int,
	propolisGrams float64,
) string {
	return productCheckAvailabilityGrams(onHand, labels, kinds, nil, needed, propolisGrams)
}

func productCheckAvailabilityGrams(
	onHand map[uuid.UUID]int,
	labels map[uuid.UUID]string,
	kinds map[uuid.UUID]string,
	netGrams map[uuid.UUID]float64,
	needed map[uuid.UUID]int,
	propolisGrams float64,
) string {
	ids := make([]uuid.UUID, 0, len(needed))
	for id := range needed {
		ids = append(ids, id)
	}
	sort.Slice(ids, func(i, j int) bool { return ids[i].String() < ids[j].String() })
	remaining := propolisGrams
	for _, id := range ids {
		if kinds[id] == saleKindPropolis && onHand[id] <= 0 {
			label := labels[id]
			if label == "" {
				label = "propolis"
			}
			grams := netGrams[id]
			if grams <= 0 {
				if remaining <= honeyPoundTolerance {
					return fmt.Sprintf("No propolis on hand for %s", label)
				}
				continue
			}
			want := float64(needed[id]) * grams
			if want > remaining+honeyPoundTolerance {
				return fmt.Sprintf("Not enough propolis for %s: need %s g, have %s g",
					label, formatGrams(want), formatGrams(math.Max(remaining, 0)))
			}
			remaining -= want
			continue
		}
		if needed[id] > onHand[id] {
			label := labels[id]
			if label == "" {
				label = "product"
			}
			return fmt.Sprintf("Not enough %s: need %d, have %d", label, needed[id], onHand[id])
		}
	}
	return ""
}

func formatGrams(g float64) string {
	return strconv.FormatFloat(math.Round(g*100)/100, 'f', -1, 64)
}

func (s *Server) productList(w http.ResponseWriter, r *http.Request) {
	items, err := productInventoryQuery(r.Context(), s.pool)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	grams, err := propolisOnHandGrams(r.Context(), s.pool)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	// Raw propolis SKUs are sellable whenever enough harvest remains for one
	// unit (net_grams), even with no packaging batch. Market day uses inStock
	// to grow product buttons.
	for i := range items {
		if items[i].Kind != saleKindPropolis || !items[i].IsActive {
			continue
		}
		need := 0.0
		if items[i].NetGrams != nil {
			need = *items[i].NetGrams
		}
		if grams > honeyPoundTolerance && grams+honeyPoundTolerance >= need {
			items[i].InStock = true
		}
	}
	inStockOnly := r.URL.Query().Get("inStock") == "1" || r.URL.Query().Get("inStock") == "true"
	if inStockOnly {
		filtered := make([]productInventoryRow, 0, len(items))
		for _, item := range items {
			if item.InStock && (item.IsActive || item.OnHand > 0) {
				filtered = append(filtered, item)
			}
		}
		items = filtered
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"items":               items,
		"propolisOnHandGrams": grams,
	})
}

func (s *Server) productCreate(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Name         string   `json:"name"`
		Kind         string   `json:"kind"`
		Unit         string   `json:"unit"`
		DefaultPrice money    `json:"defaultPrice"`
		SizeLabel    *string  `json:"sizeLabel"`
		NetGrams     *float64 `json:"netGrams"`
	}
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	name := strings.TrimSpace(req.Name)
	kind := strings.TrimSpace(req.Kind)
	unit := strings.TrimSpace(req.Unit)
	if name == "" {
		writeError(w, http.StatusBadRequest, "name is required")
		return
	}
	if !saleProductKinds[kind] {
		writeError(w, http.StatusBadRequest, "kind must be creamed_honey, hot_honey, mead, propolis, or tincture")
		return
	}
	if !productCatalogUnits[unit] {
		writeError(w, http.StatusBadRequest, "unit must be bottle, jar, tin, or each")
		return
	}
	if req.DefaultPrice < 0 {
		writeError(w, http.StatusBadRequest, "defaultPrice must be non-negative")
		return
	}
	if msg := productValidateNetGrams(kind, req.NetGrams); msg != "" {
		writeError(w, http.StatusBadRequest, msg)
		return
	}
	var id uuid.UUID
	err := s.pool.QueryRow(r.Context(), `
		INSERT INTO product_catalog
			(name, kind, unit, default_price_cents, size_label, net_grams, created_by)
		VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
		name, kind, unit, req.DefaultPrice, honeyTrimPtr(req.SizeLabel), req.NetGrams, actorID(r)).Scan(&id)
	if err != nil {
		writeDBError(w, err, "a product with that name, kind, and size already exists",
			"database error")
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"id": id})
}

// productValidateNetGrams enforces the net weight rule: propolis SKUs must
// carry a positive net_grams (sales decrement the harvest ledger by it);
// tincture may; other kinds must not.
func productValidateNetGrams(kind string, netGrams *float64) string {
	if netGrams != nil {
		if math.IsNaN(*netGrams) || math.IsInf(*netGrams, 0) || *netGrams <= 0 {
			return "netGrams must be greater than zero"
		}
		if kind != saleKindPropolis && kind != saleKindTincture {
			return "netGrams only applies to propolis and tincture products"
		}
		return ""
	}
	if kind == saleKindPropolis {
		return "netGrams is required for propolis products"
	}
	return ""
}

func (s *Server) productUpdate(w http.ResponseWriter, r *http.Request) {
	id, err := uuidParam(r, "id")
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	var req struct {
		Name         *string  `json:"name"`
		Unit         *string  `json:"unit"`
		DefaultPrice *money   `json:"defaultPrice"`
		SizeLabel    *string  `json:"sizeLabel"`
		IsActive     *bool    `json:"isActive"`
		NetGrams     *float64 `json:"netGrams"`
		// ClearNetGrams drops the weight (tincture only; propolis must keep one).
		ClearNetGrams bool `json:"clearNetGrams"`
	}
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	sets := make([]string, 0, 6)
	args := make([]any, 0, 7)
	n := 1
	if req.Name != nil {
		name := strings.TrimSpace(*req.Name)
		if name == "" {
			writeError(w, http.StatusBadRequest, "name is required")
			return
		}
		sets = append(sets, fmt.Sprintf("name=$%d", n))
		args = append(args, name)
		n++
	}
	if req.Unit != nil {
		unit := strings.TrimSpace(*req.Unit)
		if !productCatalogUnits[unit] {
			writeError(w, http.StatusBadRequest, "unit must be bottle, jar, tin, or each")
			return
		}
		sets = append(sets, fmt.Sprintf("unit=$%d", n))
		args = append(args, unit)
		n++
	}
	if req.DefaultPrice != nil {
		if *req.DefaultPrice < 0 {
			writeError(w, http.StatusBadRequest, "defaultPrice must be non-negative")
			return
		}
		sets = append(sets, fmt.Sprintf("default_price_cents=$%d", n))
		args = append(args, *req.DefaultPrice)
		n++
	}
	if req.SizeLabel != nil {
		sets = append(sets, fmt.Sprintf("size_label=$%d", n))
		args = append(args, honeyTrimPtr(req.SizeLabel))
		n++
	}
	if req.IsActive != nil {
		sets = append(sets, fmt.Sprintf("is_active=$%d", n))
		args = append(args, *req.IsActive)
		n++
	}
	if req.NetGrams != nil || req.ClearNetGrams {
		var kind string
		if err := s.pool.QueryRow(r.Context(),
			`SELECT kind FROM product_catalog WHERE id=$1`, id).Scan(&kind); err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				writeError(w, http.StatusNotFound, "product not found")
				return
			}
			writeError(w, http.StatusInternalServerError, "database error")
			return
		}
		if msg := productValidateNetGrams(kind, req.NetGrams); msg != "" {
			writeError(w, http.StatusBadRequest, msg)
			return
		}
		sets = append(sets, fmt.Sprintf("net_grams=$%d", n))
		args = append(args, req.NetGrams)
		n++
	}
	if len(sets) == 0 {
		writeError(w, http.StatusBadRequest, "no fields to update")
		return
	}
	args = append(args, id)
	tag, err := s.pool.Exec(r.Context(),
		`UPDATE product_catalog SET `+strings.Join(sets, ", ")+fmt.Sprintf(` WHERE id=$%d`, n),
		args...)
	if err != nil {
		writeDBError(w, err, "a product with that name, kind, and size already exists",
			"database error")
		return
	}
	if tag.RowsAffected() == 0 {
		writeError(w, http.StatusNotFound, "product not found")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"success": true})
}

// --- propolis harvests ---

type propolisHarvestRow struct {
	ID         uuid.UUID  `json:"id"`
	HiveID     *uuid.UUID `json:"hiveId"`
	ApiaryID   *uuid.UUID `json:"apiaryId"`
	Date       time.Time  `json:"date"`
	Amount     float64    `json:"amount"`
	Unit       string     `json:"unit"`
	Notes      *string    `json:"notes"`
	HiveName   *string    `json:"hiveName"`
	ApiaryName *string    `json:"apiaryName"`
	CreatedAt  time.Time  `json:"createdAt"`
}

func propolisToGrams(amount float64, unit string) float64 {
	if unit == "ounces" {
		return amount * gramsPerOunce
	}
	return amount
}

// propolisOnHandGrams is harvested propolis minus what tincture batches
// consumed minus raw propolis sold (sale_items kind=propolis on non-cancelled
// sales, quantity × product_catalog.net_grams).
func propolisOnHandGrams(ctx context.Context, q inspectionQuerier) (float64, error) {
	var harvested, consumed, sold float64
	err := q.QueryRow(ctx, `
		SELECT
			COALESCE((
				SELECT SUM(CASE WHEN unit='ounces' THEN amount * $1 ELSE amount END)
				FROM propolis_harvests WHERE deleted_at IS NULL
			), 0),
			COALESCE((
				SELECT SUM(CASE WHEN propolis_unit='ounces' THEN propolis_amount * $1 ELSE propolis_amount END)
				FROM product_batches WHERE kind='tincture'
			), 0),
			COALESCE((
				SELECT SUM(si.quantity * p.net_grams)
				FROM sale_items si
				JOIN sales sale ON sale.id = si.sale_id
				JOIN product_catalog p ON p.id = si.product_id
				WHERE si.kind = 'propolis' AND p.net_grams IS NOT NULL
				  AND sale.order_status <> 'cancelled'
			), 0)`, gramsPerOunce).Scan(&harvested, &consumed, &sold)
	if err != nil {
		return 0, err
	}
	return harvested - consumed - sold, nil
}

func propolisHarvestRemainingGrams(ctx context.Context, q inspectionQuerier, harvestID uuid.UUID) (float64, error) {
	var amount float64
	var unit string
	err := q.QueryRow(ctx, `
		SELECT amount, unit FROM propolis_harvests
		WHERE id=$1 AND deleted_at IS NULL`, harvestID).Scan(&amount, &unit)
	if errors.Is(err, pgx.ErrNoRows) {
		return 0, saleBadRequest("invalid propolisHarvestId")
	}
	if err != nil {
		return 0, err
	}
	var consumed float64
	if err := q.QueryRow(ctx, `
		SELECT COALESCE(SUM(
			CASE WHEN propolis_unit='ounces' THEN propolis_amount * $2 ELSE propolis_amount END
		), 0)
		FROM product_batches WHERE propolis_harvest_id=$1`, harvestID, gramsPerOunce).
		Scan(&consumed); err != nil {
		return 0, err
	}
	return propolisToGrams(amount, unit) - consumed, nil
}

func (s *Server) propolisHarvestList(w http.ResponseWriter, r *http.Request) {
	rows, err := s.pool.Query(r.Context(), `
		SELECT ph.id, ph.hive_id, ph.apiary_id, ph.date, ph.amount, ph.unit, ph.notes,
		       h.position_label, COALESCE(a_hive.name, a_yard.name), ph.created_at
		FROM propolis_harvests ph
		LEFT JOIN hives h ON h.id = ph.hive_id
		LEFT JOIN apiaries a_hive ON a_hive.id = h.apiary_id
		LEFT JOIN apiaries a_yard ON a_yard.id = ph.apiary_id
		WHERE ph.deleted_at IS NULL
		ORDER BY ph.date DESC, ph.created_at DESC`)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	defer rows.Close()
	out := make([]propolisHarvestRow, 0)
	for rows.Next() {
		var row propolisHarvestRow
		if err := rows.Scan(&row.ID, &row.HiveID, &row.ApiaryID, &row.Date, &row.Amount,
			&row.Unit, &row.Notes, &row.HiveName, &row.ApiaryName, &row.CreatedAt); err != nil {
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

func (s *Server) propolisHarvestCreate(w http.ResponseWriter, r *http.Request) {
	var req struct {
		HiveID   *uuid.UUID `json:"hiveId"`
		ApiaryID *uuid.UUID `json:"apiaryId"`
		Date     string     `json:"date"`
		Amount   float64    `json:"amount"`
		Unit     string     `json:"unit"`
		Notes    *string    `json:"notes"`
	}
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if req.HiveID == nil && req.ApiaryID == nil {
		writeError(w, http.StatusBadRequest, "hive or yard is required")
		return
	}
	if req.Amount <= 0 {
		writeError(w, http.StatusBadRequest, "amount must be greater than zero")
		return
	}
	unit := strings.TrimSpace(req.Unit)
	if unit != "grams" && unit != "ounces" {
		writeError(w, http.StatusBadRequest, "unit must be grams or ounces")
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
	// If both are set, keep both. A hive harvest still names the yard for
	// listings even when the operator picked the hive.
	var id uuid.UUID
	err = s.pool.QueryRow(r.Context(), `
		INSERT INTO propolis_harvests
			(hive_id, apiary_id, date, amount, unit, notes, created_by)
		VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
		req.HiveID, req.ApiaryID, date, req.Amount, unit, honeyTrimPtr(req.Notes), actorID(r)).
		Scan(&id)
	if err != nil {
		if honeyIsFKViolation(err) {
			writeError(w, http.StatusBadRequest, "invalid hive or yard")
			return
		}
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"id": id})
}

func (s *Server) propolisHarvestDelete(w http.ResponseWriter, r *http.Request) {
	id, err := uuidParam(r, "id")
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	var used int
	if err := s.pool.QueryRow(r.Context(),
		`SELECT COUNT(*) FROM product_batches WHERE propolis_harvest_id=$1`, id).
		Scan(&used); err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	if used > 0 {
		writeError(w, http.StatusConflict, "this harvest was used in a tincture batch")
		return
	}
	tag, err := s.pool.Exec(r.Context(), `
		UPDATE propolis_harvests
		SET deleted_at=now(), deleted_by=$2
		WHERE id=$1 AND deleted_at IS NULL`, id, actorID(r))
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	if tag.RowsAffected() == 0 {
		writeError(w, http.StatusNotFound, "propolis harvest not found")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"success": true})
}

func (s *Server) propolisOnHandHandler(w http.ResponseWriter, r *http.Request) {
	grams, err := propolisOnHandGrams(r.Context(), s.pool)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"grams": grams})
}

// --- batches ---

type productBatchRow struct {
	ID                uuid.UUID   `json:"id"`
	Kind              string      `json:"kind"`
	ProductID         uuid.UUID   `json:"productId"`
	ProductName       string      `json:"productName"`
	HarvestLotID      *uuid.UUID  `json:"harvestLotId"`
	HarvestLotCode    *string     `json:"harvestLotCode"`
	StartedAt         time.Time   `json:"startedAt"`
	FinishedAt        *time.Time  `json:"finishedAt"`
	HoneyLbs          *float64    `json:"honeyLbs"`
	WaterLiters       *float64    `json:"waterLiters"`
	Yeast             *string     `json:"yeast"`
	Vessel            *string     `json:"vessel"`
	PropolisHarvestID *uuid.UUID  `json:"propolisHarvestId"`
	PropolisAmount    *float64    `json:"propolisAmount"`
	PropolisUnit      *string     `json:"propolisUnit"`
	QuantityOut       int         `json:"quantityOut"`
	Notes             *string     `json:"notes"`
	ExpenseIDs        []uuid.UUID `json:"expenseIds"`
	CreatedAt         time.Time   `json:"createdAt"`
}

func (s *Server) productBatchList(w http.ResponseWriter, r *http.Request) {
	rows, err := s.pool.Query(r.Context(), `
		SELECT b.id, b.kind, b.product_id, p.name, b.harvest_lot_id, lot.lot_code,
		       b.started_at, b.finished_at, b.honey_lbs, b.water_liters, b.yeast, b.vessel,
		       b.propolis_harvest_id, b.propolis_amount, b.propolis_unit,
		       b.quantity_out, b.notes, b.created_at
		FROM product_batches b
		JOIN product_catalog p ON p.id = b.product_id
		LEFT JOIN harvest_lots lot ON lot.id = b.harvest_lot_id
		ORDER BY b.started_at DESC, b.created_at DESC`)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	defer rows.Close()
	out := make([]productBatchRow, 0)
	ids := make([]uuid.UUID, 0)
	index := make(map[uuid.UUID]int)
	for rows.Next() {
		var row productBatchRow
		if err := rows.Scan(&row.ID, &row.Kind, &row.ProductID, &row.ProductName,
			&row.HarvestLotID, &row.HarvestLotCode, &row.StartedAt, &row.FinishedAt,
			&row.HoneyLbs, &row.WaterLiters, &row.Yeast, &row.Vessel,
			&row.PropolisHarvestID, &row.PropolisAmount, &row.PropolisUnit,
			&row.QuantityOut, &row.Notes, &row.CreatedAt); err != nil {
			writeError(w, http.StatusInternalServerError, "database error")
			return
		}
		row.ExpenseIDs = []uuid.UUID{}
		index[row.ID] = len(out)
		ids = append(ids, row.ID)
		out = append(out, row)
	}
	if rows.Err() != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	if len(ids) > 0 {
		expRows, err := s.pool.Query(r.Context(), `
			SELECT batch_id, expense_id FROM product_batch_expenses
			WHERE batch_id = ANY($1) ORDER BY expense_id`, ids)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "database error")
			return
		}
		for expRows.Next() {
			var batchID, expenseID uuid.UUID
			if err := expRows.Scan(&batchID, &expenseID); err != nil {
				expRows.Close()
				writeError(w, http.StatusInternalServerError, "database error")
				return
			}
			if i, ok := index[batchID]; ok {
				out[i].ExpenseIDs = append(out[i].ExpenseIDs, expenseID)
			}
		}
		expErr := expRows.Err()
		expRows.Close()
		if expErr != nil {
			writeError(w, http.StatusInternalServerError, "database error")
			return
		}
	}
	writeJSON(w, http.StatusOK, out)
}

func (s *Server) productBatchCreate(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Kind              string      `json:"kind"`
		ProductID         string      `json:"productId"`
		HarvestLotID      *uuid.UUID  `json:"harvestLotId"`
		StartedAt         string      `json:"startedAt"`
		FinishedAt        *string     `json:"finishedAt"`
		HoneyLbs          *float64    `json:"honeyLbs"`
		WaterLiters       *float64    `json:"waterLiters"`
		Yeast             *string     `json:"yeast"`
		Vessel            *string     `json:"vessel"`
		PropolisHarvestID *uuid.UUID  `json:"propolisHarvestId"`
		PropolisAmount    *float64    `json:"propolisAmount"`
		PropolisUnit      *string     `json:"propolisUnit"`
		QuantityOut       int         `json:"quantityOut"`
		Notes             *string     `json:"notes"`
		ExpenseIDs        []uuid.UUID `json:"expenseIds"`
	}
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	kind := strings.TrimSpace(req.Kind)
	if !productBatchKinds[kind] {
		writeError(w, http.StatusBadRequest, "kind must be creamed_honey, hot_honey, mead, or tincture")
		return
	}
	productID, err := uuid.Parse(strings.TrimSpace(req.ProductID))
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid productId")
		return
	}
	if req.QuantityOut <= 0 {
		writeError(w, http.StatusBadRequest, "quantityOut must be greater than zero")
		return
	}
	if req.StartedAt == "" {
		writeError(w, http.StatusBadRequest, "startedAt is required")
		return
	}
	startedAt, err := parseDate(req.StartedAt)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid startedAt")
		return
	}
	finishedAt, err := parseDatePtr(req.FinishedAt)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid finishedAt")
		return
	}

	honeyConsuming := kind == saleKindCreamedHoney || kind == saleKindHotHoney || kind == saleKindMead
	if honeyConsuming {
		if req.HoneyLbs == nil || *req.HoneyLbs <= 0 {
			writeError(w, http.StatusBadRequest, "honeyLbs is required for this batch")
			return
		}
		if kind == saleKindCreamedHoney && req.HarvestLotID == nil {
			writeError(w, http.StatusBadRequest, "creamed honey requires a harvest lot")
			return
		}
		req.PropolisHarvestID = nil
		req.PropolisAmount = nil
		req.PropolisUnit = nil
	} else {
		if req.PropolisHarvestID == nil || req.PropolisAmount == nil || *req.PropolisAmount <= 0 {
			writeError(w, http.StatusBadRequest, "tincture requires a propolis harvest and amount")
			return
		}
		unit := ""
		if req.PropolisUnit != nil {
			unit = strings.TrimSpace(*req.PropolisUnit)
		}
		if unit != "grams" && unit != "ounces" {
			writeError(w, http.StatusBadRequest, "propolisUnit must be grams or ounces")
			return
		}
		req.PropolisUnit = &unit
		req.HoneyLbs = nil
	}

	ctx := r.Context()
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	defer tx.Rollback(ctx)

	var productKind, productName string
	if err := tx.QueryRow(ctx, `
		SELECT kind, name FROM product_catalog WHERE id=$1 FOR UPDATE`, productID).
		Scan(&productKind, &productName); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			writeError(w, http.StatusBadRequest, "invalid productId")
			return
		}
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	if productKind != kind {
		writeError(w, http.StatusBadRequest, "batch kind must match the catalog product")
		return
	}

	if honeyConsuming {
		bulk, err := honeyLockBulk(ctx, tx)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "database error")
			return
		}
		if message := honeyBulkShortfall(*req.HoneyLbs, bulk.BulkOnHandLbs); message != "" {
			writeError(w, http.StatusBadRequest, message)
			return
		}
	} else {
		remaining, err := propolisHarvestRemainingGrams(ctx, tx, *req.PropolisHarvestID)
		if err != nil {
			equipWriteError(w, err)
			return
		}
		need := propolisToGrams(*req.PropolisAmount, *req.PropolisUnit)
		if need > remaining+honeyPoundTolerance {
			writeError(w, http.StatusBadRequest, fmt.Sprintf(
				"Not enough propolis: need %.1f g, have %.1f g", need, remaining))
			return
		}
	}

	if err := productValidateExpenses(ctx, tx, req.ExpenseIDs); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}

	var lotCode *string
	if req.HarvestLotID != nil {
		if err := tx.QueryRow(ctx, `SELECT lot_code FROM harvest_lots WHERE id=$1`,
			*req.HarvestLotID).Scan(&lotCode); err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				writeError(w, http.StatusBadRequest, "invalid harvestLotId")
				return
			}
			writeError(w, http.StatusInternalServerError, "database error")
			return
		}
		// Same treatment lockout as a jar sale off the lot: honey from a lot
		// still inside a withdrawal window cannot be converted either.
		if msg, err := refuseLotSale(ctx, tx, *req.HarvestLotID, startedAt); err != nil {
			writeError(w, http.StatusInternalServerError, "database error")
			return
		} else if msg != "" {
			writeError(w, http.StatusConflict, msg)
			return
		}
	}

	batchID := uuid.New()
	actor := actorID(r)
	if _, err := tx.Exec(ctx, `
		INSERT INTO product_batches
			(id, kind, product_id, harvest_lot_id, started_at, finished_at,
			 honey_lbs, water_liters, yeast, vessel,
			 propolis_harvest_id, propolis_amount, propolis_unit,
			 quantity_out, notes, created_by)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
		batchID, kind, productID, req.HarvestLotID, startedAt, finishedAt,
		req.HoneyLbs, req.WaterLiters, honeyTrimPtr(req.Yeast), honeyTrimPtr(req.Vessel),
		req.PropolisHarvestID, req.PropolisAmount, req.PropolisUnit,
		req.QuantityOut, honeyTrimPtr(req.Notes), actor); err != nil {
		if honeyIsFKViolation(err) {
			writeError(w, http.StatusBadRequest, "invalid product, harvest lot, or propolis harvest")
			return
		}
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	for _, expenseID := range req.ExpenseIDs {
		if _, err := tx.Exec(ctx, `
			INSERT INTO product_batch_expenses (batch_id, expense_id) VALUES ($1,$2)`,
			batchID, expenseID); err != nil {
			if honeyIsFKViolation(err) {
				writeError(w, http.StatusBadRequest, "invalid expenseId")
				return
			}
			writeError(w, http.StatusInternalServerError, "database error")
			return
		}
	}

	if honeyConsuming {
		reason := productBatchHoneyReason(kind, productName, lotCode)
		if _, err := tx.Exec(ctx, `
			INSERT INTO honey_movements
				(date, kind, amount_lbs, reason, notes, product_batch_id, created_by)
			VALUES ($1, 'bulk_use', $2, $3, $4, $5, $6)`,
			startedAt, *req.HoneyLbs, reason, honeyTrimPtr(req.Notes), batchID, actor); err != nil {
			writeError(w, http.StatusInternalServerError, "database error")
			return
		}
	}

	if err := tx.Commit(ctx); err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"id": batchID})
}

func productBatchHoneyReason(kind, productName string, lotCode *string) string {
	label := strings.ReplaceAll(kind, "_", " ")
	reason := label + " " + productName
	if lotCode != nil && *lotCode != "" {
		reason += " (" + *lotCode + ")"
	}
	return reason
}

func productValidateExpenses(ctx context.Context, tx inspectionQuerier, ids []uuid.UUID) error {
	if len(ids) == 0 {
		return nil
	}
	seen := make(map[uuid.UUID]bool, len(ids))
	unique := make([]uuid.UUID, 0, len(ids))
	for _, id := range ids {
		if seen[id] {
			continue
		}
		seen[id] = true
		unique = append(unique, id)
	}
	var found int
	if err := tx.QueryRow(ctx, `
		SELECT COUNT(*) FROM expenses WHERE id = ANY($1) AND deleted_at IS NULL`, unique).
		Scan(&found); err != nil {
		return err
	}
	if found != len(unique) {
		return errors.New("invalid expenseId")
	}
	return nil
}
