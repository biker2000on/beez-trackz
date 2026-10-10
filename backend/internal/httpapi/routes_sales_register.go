package httpapi

import (
	"context"
	"net/http"
	"sort"
	"strings"
	"time"

	"github.com/biker2000on/beez-trackz/backend/internal/app/production"
	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
)

// The sales register: the Orders & register list on /sales. It is every sale
// plus every zero-revenue jar outflow — jars given away and jars kept for
// the beekeeper's own use — in one date-ordered list, so a give-away stays
// visible after it is recorded instead of vanishing into the inventory
// ledger.
//
// A give-away is never revenue. Its row carries the jars and what they would
// have fetched at each size's default price (retailValue, "value given"), and
// the register's revenue total counts sales only.
//
// The sales list is unpaged (GET /sales returns every sale), so the register
// is too: it is the same rows plus the give-aways, which are far fewer.

func (s *Server) mountSalesRegister(r chi.Router) {
	admin := r.With(s.requireAdmin)
	admin.Get("/sales/register", s.salesRegisterHandler)
}

// Register row types.
const (
	registerTypeSale     = "sale"
	registerTypeGiveAway = "give_away"
	registerTypeOwnUse   = "own_use"
)

// salesRegisterKinds are the values ?kind= accepts.
var salesRegisterKinds = map[string]bool{"all": true, "sales": true, "giveaways": true}

type registerGiveAwayLine struct {
	JarSizeID    uuid.UUID  `json:"jarSizeId"`
	Label        string     `json:"label"`
	HarvestLotID *uuid.UUID `json:"harvestLotId"`
	LotCode      *string    `json:"lotCode"`
	Varietal     *string    `json:"varietal"`
	Quantity     int        `json:"quantity"`
	// UnitRetailPrice is the size's default price; nil when the size has none.
	UnitRetailPrice *money `json:"unitRetailPrice"`
	// RetailValue is quantity × UnitRetailPrice — value given, not revenue.
	RetailValue *money `json:"retailValue"`
}

type registerGiveAway struct {
	ID   uuid.UUID `json:"id"`
	Date time.Time `json:"date"`
	// Purpose is "gift" or "own_use".
	Purpose   string                 `json:"purpose"`
	Recipient *string                `json:"recipient"`
	Notes     *string                `json:"notes"`
	Lines     []registerGiveAwayLine `json:"lines"`
	TotalJars int                    `json:"totalJars"`
	// RetailValue sums the priced lines; UnpricedJars counts jars whose size
	// has no default price, so "≈ $X" can say it is a floor.
	RetailValue  money `json:"retailValue"`
	UnpricedJars int   `json:"unpricedJars"`
	// Reversed is true once the give-away has been undone (DELETE
	// /honey/movements/{id}); the row stays, dimmed, and counts in no total.
	Reversed   bool       `json:"reversed"`
	ReversedAt *time.Time `json:"reversedAt"`
}

type registerEntry struct {
	// Type is "sale", "give_away" or "own_use".
	Type      string            `json:"type"`
	ID        uuid.UUID         `json:"id"`
	Date      time.Time         `json:"date"`
	Sale      *honeySaleRow     `json:"sale"`
	GiveAway  *registerGiveAway `json:"giveAway"`
	createdAt time.Time
}

type registerTotals struct {
	// Revenue is the invoiced total of every sale that is not cancelled.
	// Give-aways and own use never count here.
	Revenue    money `json:"revenue"`
	SalesCount int   `json:"salesCount"`
	// The zero-revenue outflows, reversed ones excluded.
	GivenAwayJars    int   `json:"givenAwayJars"`
	OwnUseJars       int   `json:"ownUseJars"`
	RetailValueGiven money `json:"retailValueGiven"`
}

type salesRegister struct {
	Entries []registerEntry `json:"entries"`
	// Totals cover the whole register whatever ?kind= shows.
	Totals registerTotals `json:"totals"`
}

// listRegisterGiveAways reads every jar give-away (gift or own use), newest
// first, with its lines and whether it has been reversed. Reversing entries
// themselves are not rows: the original carries reversed=true.
func (s *Server) listRegisterGiveAways(ctx context.Context) ([]registerGiveAway, []time.Time, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT o.id, o.occurred_at, o.created_at,
		       COALESCE(NULLIF(o.details ->> 'purpose', ''), 'gift'),
		       NULLIF(o.details ->> 'recipient', ''),
		       NULLIF(o.details ->> 'notes', ''),
		       reversal.created_at
		FROM inventory_operations o
		LEFT JOIN LATERAL (
			SELECT r.created_at FROM inventory_operations r
			WHERE r.reverses_operation_id = o.id
			ORDER BY r.created_at LIMIT 1
		) reversal ON true
		WHERE o.kind = 'shrink' AND o.reason = $1 AND o.reverses_operation_id IS NULL
		  AND EXISTS (
			SELECT 1 FROM inventory_movements m
			JOIN inventory_items i ON i.id = m.item_id
			WHERE m.operation_id = o.id AND i.kind = 'jar')
		ORDER BY o.occurred_at DESC, o.created_at DESC, o.id DESC`, production.ReasonGiveAway)
	if err != nil {
		return nil, nil, err
	}
	out := make([]registerGiveAway, 0)
	created := make([]time.Time, 0)
	index := map[uuid.UUID]int{}
	ids := make([]uuid.UUID, 0)
	for rows.Next() {
		var (
			row        registerGiveAway
			createdAt  time.Time
			reversedAt *time.Time
		)
		if err := rows.Scan(&row.ID, &row.Date, &createdAt, &row.Purpose,
			&row.Recipient, &row.Notes, &reversedAt); err != nil {
			rows.Close()
			return nil, nil, err
		}
		if row.Purpose != production.GiveAwayPurposeOwnUse {
			row.Purpose = production.GiveAwayPurposeGift
		}
		row.Reversed = reversedAt != nil
		row.ReversedAt = reversedAt
		row.Lines = make([]registerGiveAwayLine, 0)
		index[row.ID] = len(out)
		ids = append(ids, row.ID)
		out = append(out, row)
		created = append(created, createdAt)
	}
	rows.Close()
	if rows.Err() != nil {
		return nil, nil, rows.Err()
	}
	if len(ids) == 0 {
		return out, created, nil
	}

	// One line per (size, harvest lot): an allocation that touched two
	// inventory lots of the same harvest lot still reads as one line.
	lineRows, err := s.pool.Query(ctx, `
		SELECT m.operation_id, js.id, js.label, hl.id, hl.lot_code, hv.name,
		       js.default_price_cents, SUM(-m.quantity)::int, MIN(js.sort_order)
		FROM inventory_movements m
		JOIN inventory_items i ON i.id = m.item_id AND i.kind = 'jar'
		JOIN jar_sizes js ON js.item_id = i.id
		LEFT JOIN inventory_lots il ON il.id = m.lot_id
		LEFT JOIN harvest_lots hl ON il.source_type = 'harvest_lot' AND hl.id = il.source_id
		LEFT JOIN honey_varietals hv ON hv.id = hl.varietal_id
		WHERE m.operation_id = ANY($1::uuid[])
		GROUP BY m.operation_id, js.id, js.label, hl.id, hl.lot_code, hv.name, js.default_price_cents
		ORDER BY m.operation_id, MIN(js.sort_order), js.label, hl.lot_code`, ids)
	if err != nil {
		return nil, nil, err
	}
	defer lineRows.Close()
	for lineRows.Next() {
		var (
			operationID uuid.UUID
			line        registerGiveAwayLine
			priceCents  *int64
			sortOrder   *int
		)
		if err := lineRows.Scan(&operationID, &line.JarSizeID, &line.Label,
			&line.HarvestLotID, &line.LotCode, &line.Varietal, &priceCents,
			&line.Quantity, &sortOrder); err != nil {
			return nil, nil, err
		}
		i, ok := index[operationID]
		if !ok {
			continue
		}
		applyRegisterLine(&out[i], line, priceCents)
	}
	if lineRows.Err() != nil {
		return nil, nil, lineRows.Err()
	}
	return out, created, nil
}

// applyRegisterLine prices one line at the size's default price and adds it
// to the give-away's totals.
func applyRegisterLine(row *registerGiveAway, line registerGiveAwayLine, priceCents *int64) {
	if priceCents != nil {
		unit := money(*priceCents)
		value := money(*priceCents * int64(line.Quantity))
		line.UnitRetailPrice = &unit
		line.RetailValue = &value
		row.RetailValue += value
	} else {
		row.UnpricedJars += line.Quantity
	}
	row.TotalJars += line.Quantity
	row.Lines = append(row.Lines, line)
}

// buildSalesRegister merges sales and give-aways newest first and totals
// them. Order is (date DESC, recorded DESC, id DESC); a sale and a give-away
// on the same day sort by when each was recorded.
func buildSalesRegister(
	sales []honeySaleRow, giveAways []registerGiveAway, giveAwayCreated []time.Time, kind string,
) salesRegister {
	register := salesRegister{Entries: make([]registerEntry, 0, len(sales)+len(giveAways))}
	for i := range sales {
		sale := &sales[i]
		if sale.OrderStatus != "cancelled" {
			register.Totals.Revenue += sale.TotalAmount
			register.Totals.SalesCount++
		}
		if kind == "giveaways" {
			continue
		}
		register.Entries = append(register.Entries, registerEntry{
			Type: registerTypeSale, ID: sale.ID, Date: sale.Date, Sale: sale,
			createdAt: sale.CreatedAt,
		})
	}
	for i := range giveAways {
		giveAway := &giveAways[i]
		entryType := registerTypeGiveAway
		if giveAway.Purpose == production.GiveAwayPurposeOwnUse {
			entryType = registerTypeOwnUse
		}
		if !giveAway.Reversed {
			if entryType == registerTypeOwnUse {
				register.Totals.OwnUseJars += giveAway.TotalJars
			} else {
				register.Totals.GivenAwayJars += giveAway.TotalJars
			}
			register.Totals.RetailValueGiven += giveAway.RetailValue
		}
		if kind == "sales" {
			continue
		}
		var created time.Time
		if i < len(giveAwayCreated) {
			created = giveAwayCreated[i]
		}
		register.Entries = append(register.Entries, registerEntry{
			Type: entryType, ID: giveAway.ID, Date: giveAway.Date, GiveAway: giveAway,
			createdAt: created,
		})
	}
	sort.SliceStable(register.Entries, func(a, b int) bool {
		left, right := register.Entries[a], register.Entries[b]
		if !left.Date.Equal(right.Date) {
			return left.Date.After(right.Date)
		}
		if !left.createdAt.Equal(right.createdAt) {
			return left.createdAt.After(right.createdAt)
		}
		return left.ID.String() > right.ID.String()
	})
	return register
}

// GET /sales/register?kind=all|sales|giveaways
//
// Every sale and every give-away / own-use withdrawal, newest first. kind
// narrows the rows ("giveaways" is gifts and own use together); totals always
// cover everything. Give-away rows carry a retail value at each size's
// default price, labelled as value given — revenue counts sales only.
func (s *Server) salesRegisterHandler(w http.ResponseWriter, r *http.Request) {
	kind := strings.TrimSpace(r.URL.Query().Get("kind"))
	if kind == "" {
		kind = "all"
	}
	if !salesRegisterKinds[kind] {
		writeError(w, http.StatusBadRequest, "kind must be all, sales, or giveaways")
		return
	}
	sales, err := s.honeyListSales(r.Context())
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	giveAways, created, err := s.listRegisterGiveAways(r.Context())
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	writeJSON(w, http.StatusOK, buildSalesRegister(sales, giveAways, created, kind))
}
