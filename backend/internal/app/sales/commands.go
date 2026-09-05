package sales

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/biker2000on/beez-trackz/backend/internal/app"
	appequipment "github.com/biker2000on/beez-trackz/backend/internal/app/equipment"
	"github.com/biker2000on/beez-trackz/backend/internal/app/production"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

type Money int64

func (m Money) MarshalJSON() ([]byte, error) {
	sign := ""
	v := int64(m)
	if v < 0 {
		sign = "-"
		v = -v
	}
	return []byte(sign + strconv.FormatInt(v/100, 10) + "." + fmt.Sprintf("%02d", v%100)), nil
}

type SaleLine struct {
	Kind                                                                  string
	JarSizeID, HiveID, ItemID, EquipmentStockID, ProductID, BottlingRunID uuid.UUID
	Quantity                                                              int
	UnitPriceCents                                                        int64
}
type RecordSaleInput struct {
	SaleID                                    uuid.UUID
	Date                                      time.Time
	Location                                  *string
	StockLocationID, CustomerID, HarvestLotID *uuid.UUID
	CustomerName                              *string
	Channel, PaymentMethod, OrderStatus       string
	DiscountAmountCents                       int64
	AmountPaidCents, TaxCents                 *int64
	OrderNumber                               *string
	DueDate                                   *time.Time
	WholesalePriceListID                      *uuid.UUID
	Lines                                     []SaleLine
	Notes                                     *string
}
type RecordSaleResult struct {
	Success        bool      `json:"success"`
	ID             uuid.UUID `json:"id"`
	OrderNumber    *string   `json:"orderNumber"`
	Subtotal       Money     `json:"subtotal"`
	DiscountAmount Money     `json:"discountAmount"`
	TotalAmount    Money     `json:"totalAmount"`
	AmountPaid     Money     `json:"amountPaid"`
	BalanceDue     Money     `json:"balanceDue"`
}
type UpdateSaleInput struct {
	SaleID          uuid.UUID
	OrderStatus     string
	AmountPaidCents *int64
	PaymentMethod   *string
	DueDateSet      bool
	DueDate         *time.Time
	TaxCents        *int64
}
type UpdateSaleResult struct {
	Success     bool   `json:"success"`
	OrderStatus string `json:"orderStatus"`
	AmountPaid  Money  `json:"amountPaid"`
	BalanceDue  Money  `json:"balanceDue"`
}
type CancelSaleInput struct {
	SaleID uuid.UUID
	Reason *string
}
type CancelSaleResult struct {
	Success     bool      `json:"success"`
	Cancelled   bool      `json:"cancelled"`
	OrderStatus string    `json:"orderStatus"`
	ID          uuid.UUID `json:"id"`
	AmountPaid  Money     `json:"amountPaid"`
	BalanceDue  Money     `json:"balanceDue"`
}

type SettlementLine struct {
	JarSizeID, ProductID *uuid.UUID
	// HarvestLotID pins the line to one harvest lot (one varietal): the sold,
	// returned, and shrink movements all draw from that lot and the shelf
	// count is that lot's alone. Nil takes the location's oldest receipts.
	HarvestLotID                   *uuid.UUID
	QuantitySold, QuantityReturned int
	UnitPriceCents                 *int64
	CountOnShelf                   *int
}
type ApplySettlementInput struct {
	LocationID                         uuid.UUID
	PeriodStart, PeriodEnd, ReportedAt time.Time
	Lines                              []SettlementLine
	AmountPaidCents                    int64
	PaymentMethod                      string
	OrderNumber, Notes                 *string
}
type ApplySettlementResult struct {
	Success       bool       `json:"success"`
	ID            uuid.UUID  `json:"id"`
	SaleID        *uuid.UUID `json:"saleId"`
	OrderNumber   *string    `json:"orderNumber"`
	AmountOwed    Money      `json:"amountOwed"`
	AmountPaid    Money      `json:"amountPaid"`
	BalanceDue    Money      `json:"balanceDue"`
	Commission    Money      `json:"commission"`
	SoldUnits     int        `json:"soldUnits"`
	ReturnedUnits int        `json:"returnedUnits"`
	ShrinkUnits   int        `json:"shrinkUnits"`
}

func ApplySettlement(ctx context.Context, uow *app.UnitOfWork, in ApplySettlementInput) (ApplySettlementResult, error) {
	const op = "apply consignment settlement"
	out := ApplySettlementResult{AmountPaid: Money(in.AmountPaidCents)}
	if in.LocationID == uuid.Nil || in.PeriodStart.IsZero() || in.PeriodEnd.IsZero() || len(in.Lines) == 0 {
		return out, app.Invalid(op, "location, period, and lines are required")
	}
	if in.PeriodEnd.Before(in.PeriodStart) || in.AmountPaidCents < 0 {
		return out, app.Invalid(op, "invalid period or payment")
	}
	var name, basis string
	var home, consignment bool
	var customer *uuid.UUID
	var commissionBPS *int
	var priceList *uuid.UUID
	var location uuid.UUID
	if err := uow.QueryRow(ctx, `SELECT id,name,is_home,is_consignment,customer_id,price_basis,commission_bps,wholesale_price_list_id FROM inventory_locations WHERE (id=$1 OR (source_type='stock_location' AND source_id=$1)) AND deleted_at IS NULL AND kind='consignee' ORDER BY (id=$1) DESC LIMIT 1 FOR UPDATE`, in.LocationID).Scan(&location, &name, &home, &consignment, &customer, &basis, &commissionBPS, &priceList); errors.Is(err, pgx.ErrNoRows) {
		return out, app.NotFound(op, "location not found")
	} else if err != nil {
		return out, dbError(op, err)
	}
	if home {
		return out, app.Invalid(op, "home does not settle with itself")
	}
	if !consignment {
		return out, app.Precondition(op, "location is not configured for consignment")
	}
	homeLocation, err := production.HomeLocationID(ctx, uow)
	if err != nil {
		return out, err
	}
	type prepared struct {
		item                      uuid.UUID
		kind, label               string
		jar, product              *uuid.UUID
		available, sold, returned int
		price                     int64
		count                     *int
		lot                       *uuid.UUID
		lotCode                   string
	}
	preparedLines := []prepared{}
	seen := map[string]bool{}
	var owed, commission int64
	for _, line := range in.Lines {
		if (line.JarSizeID == nil) == (line.ProductID == nil) || line.QuantitySold < 0 || line.QuantityReturned < 0 || (line.CountOnShelf != nil && *line.CountOnShelf < 0) {
			return out, app.Invalid(op, "each line needs one SKU and non-negative quantities")
		}
		var p prepared
		p.jar, p.product, p.sold, p.returned, p.count = line.JarSizeID, line.ProductID, line.QuantitySold, line.QuantityReturned, line.CountOnShelf
		if p.jar != nil {
			p.item, err = production.EnsureJarItem(ctx, uow, *p.jar)
			p.kind = KindJar
			err2 := uow.QueryRow(ctx, `SELECT label,default_price_cents FROM jar_sizes WHERE id=$1`, *p.jar).Scan(&p.label, &p.price)
			if err == nil {
				err = err2
			}
		} else {
			p.item, err = production.EnsureProductItem(ctx, uow, *p.product)
			err2 := uow.QueryRow(ctx, `SELECT kind,name,default_price_cents FROM product_catalog WHERE id=$1`, *p.product).Scan(&p.kind, &p.label, &p.price)
			if err == nil {
				err = err2
			}
		}
		if err != nil {
			return out, err
		}
		key := p.item.String()
		if line.HarvestLotID != nil {
			if p.jar == nil {
				return out, app.Invalid(op, "%s: catalog products are not tracked by harvest lot", p.label)
			}
			lotID, err := production.EnsureJarLotForHarvestLot(ctx, uow, p.item, *line.HarvestLotID)
			if err != nil {
				return out, err
			}
			p.lot, p.lotCode = &lotID, production.LotCode(ctx, uow, lotID)
			p.label += " (lot " + p.lotCode + ")"
			key += "/" + lotID.String()
		}
		if seen[key] {
			return out, app.Invalid(op, "%s is listed twice; combine it into one line", p.label)
		}
		seen[key] = true
		if err := uow.QueryRow(ctx, `SELECT COALESCE(SUM(available),0)::int FROM inventory_available WHERE item_id=$1 AND location_id=$2 AND ($3::uuid IS NULL OR lot_id=$3)`, p.item, location, p.lot).Scan(&p.available); err != nil {
			return out, dbError(op, err)
		}
		if p.sold+p.returned > p.available {
			return out, app.Precondition(op, "%s: report accounts for %d but only %d are on the shelf", p.label, p.sold+p.returned, p.available)
		}
		if line.UnitPriceCents != nil {
			p.price = *line.UnitPriceCents
		}
		if p.sold > 0 && p.price <= 0 {
			return out, app.Invalid(op, "%s: unit price is required", p.label)
		}
		unitOwed, unitCommission := p.price, int64(0)
		if basis == "commission" && commissionBPS != nil {
			unitCommission = (p.price*int64(*commissionBPS) + 5000) / 10000
			unitOwed = p.price - unitCommission
		} else if basis == "wholesale_list" {
			if p.jar == nil {
				return out, app.Invalid(op, "wholesale price lists do not price catalog products")
			}
			if err := uow.QueryRow(ctx, `SELECT unit_price_cents FROM wholesale_price_list_items WHERE price_list_id=$1 AND jar_size_id=$2`, priceList, *p.jar).Scan(&unitOwed); err != nil {
				return out, app.NotFound(op, "wholesale list does not price %s", p.label)
			}
			if unitOwed > p.price {
				unitOwed = p.price
			}
			unitCommission = p.price - unitOwed
		}
		owed += unitOwed * int64(p.sold)
		commission += unitCommission * int64(p.sold)
		p.price = unitOwed
		out.SoldUnits += p.sold
		out.ReturnedUnits += p.returned
		if p.count != nil {
			out.ShrinkUnits += p.available - p.sold - p.returned - *p.count
		}
		preparedLines = append(preparedLines, p)
	}
	if in.AmountPaidCents > owed {
		return out, app.Invalid(op, "payment is larger than the amount owed")
	}
	settlementID := uuid.New()
	if _, err := uow.Exec(ctx, `INSERT INTO consignment_settlements(id,location_id,period_start,period_end,reported_at,amount_owed_cents,amount_paid_cents,commission_cents,notes,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, settlementID, location, in.PeriodStart, in.PeriodEnd, in.ReportedAt, owed, in.AmountPaidCents, commission, trim(in.Notes), actorValue(uow)); err != nil {
		return out, dbError(op, err)
	}
	out.ID = settlementID
	saleID := uuid.New()
	if out.SoldUnits > 0 {
		order := trim(in.OrderNumber)
		if order == nil {
			v := "BT-" + strings.ToUpper(saleID.String()[:8])
			order = &v
		}
		status := "pending"
		if in.AmountPaidCents >= owed {
			status = "paid"
		}
		if _, err := uow.Exec(ctx, `INSERT INTO sales(id,date,customer_id,customer_name,location,channel,payment_method,total_amount_cents,discount_amount_cents,amount_paid_cents,order_status,order_number,notes,created_by,stock_location_id,physical_applied_at) VALUES($1,$2,$3,$4,$4,'consignment',$5,$6,0,$7,$8,$9,$10,$11,$12,now())`, saleID, in.ReportedAt, customer, name, in.PaymentMethod, owed, in.AmountPaidCents, status, order, trim(in.Notes), actorValue(uow), location); err != nil {
			return out, dbError(op, err)
		}
		pinned := map[uuid.UUID]uuid.UUID{}
		for _, p := range preparedLines {
			if p.sold == 0 {
				continue
			}
			var itemID uuid.UUID
			if err := uow.QueryRow(ctx, `INSERT INTO sale_items(sale_id,kind,jar_size_id,product_id,quantity,unit_price_cents,created_by) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id`, saleID, p.kind, p.jar, p.product, p.sold, p.price, actorValue(uow)).Scan(&itemID); err != nil {
				return out, dbError(op, err)
			}
			if p.lot != nil {
				pinned[itemID] = *p.lot
			}
		}
		svc := New()
		if err := svc.LinkLines(ctx, uow, saleID, location); err != nil {
			return out, err
		}
		// LinkLines guessed a FIFO lot for each line; a line the report pinned
		// to one varietal overrides the guess so Apply draws from that lot.
		for itemID, lotID := range pinned {
			if _, err := uow.Exec(ctx, `UPDATE sale_items SET inventory_lot_id=$2 WHERE id=$1`, itemID, lotID); err != nil {
				return out, dbError(op, err)
			}
		}
		if err := svc.Apply(ctx, uow, ApplyInput{SaleID: saleID, Date: in.ReportedAt, LocationID: location}); err != nil {
			return out, err
		}
		if _, err := uow.Exec(ctx, `UPDATE consignment_settlements SET sale_id=$2 WHERE id=$1`, settlementID, saleID); err != nil {
			return out, dbError(op, err)
		}
		out.SaleID = ptr(saleID)
		out.OrderNumber = order
	}
	for i, p := range preparedLines {
		if p.returned > 0 {
			if _, err := New().Transfer(ctx, uow, TransferInput{TransferID: settlementID, SourceType: "consignment_settlement_return", Returning: true, From: location, To: homeLocation, Date: in.ReportedAt, Lines: []TransferLine{{ItemID: p.item, LotID: p.lot, Quantity: p.returned}}, Notes: trim(in.Notes)}); err != nil {
				return out, err
			}
		}
		if p.count != nil {
			difference := p.available - p.sold - p.returned - *p.count
			if difference != 0 {
				reason := "shrink at " + name
				if difference < 0 {
					reason = "extra stock counted at " + name
				}
				if _, err := New().RecordSettlementShrink(ctx, uow, SettlementShrinkInput{SettlementID: settlementID, LocationID: location, ItemID: p.item, LotID: p.lot, Quantity: difference, Date: in.ReportedAt, Reason: &reason, Index: i}); err != nil {
					return out, err
				}
			}
		}
	}
	out.Success = true
	out.AmountOwed, out.BalanceDue, out.Commission = Money(owed), Money(owed-in.AmountPaidCents), Money(commission)
	return out, nil
}

func RecordSale(ctx context.Context, uow *app.UnitOfWork, in RecordSaleInput) (RecordSaleResult, error) {
	const op = "record sale"
	out := RecordSaleResult{ID: in.SaleID, OrderNumber: in.OrderNumber, DiscountAmount: Money(in.DiscountAmountCents)}
	if in.SaleID == uuid.Nil || in.Date.IsZero() || len(in.Lines) == 0 {
		return out, app.Invalid(op, "sale, date, and at least one line are required")
	}
	if in.OrderStatus == "cancelled" {
		return out, app.Invalid(op, "a sale cannot be created as cancelled")
	}
	if in.TaxCents != nil && *in.TaxCents < 0 {
		return out, app.Invalid(op, "tax must not be negative")
	}
	locationID, stockID, err := resolveSaleLocation(ctx, uow, in.StockLocationID)
	if err != nil {
		return out, err
	}
	productKinds := make(map[uuid.UUID]string)
	productIDs := make([]uuid.UUID, 0)
	for _, line := range in.Lines {
		if line.ProductID != uuid.Nil {
			productIDs = append(productIDs, line.ProductID)
		}
	}
	productIDs = uniqueSortedUUIDs(productIDs)
	for _, id := range productIDs {
		var kind string
		if err := uow.QueryRow(ctx, `SELECT kind FROM product_catalog WHERE id=$1 FOR UPDATE`, id).Scan(&kind); errors.Is(err, pgx.ErrNoRows) {
			return out, app.Invalid(op, "invalid productId")
		} else if err != nil {
			return out, dbError(op, err)
		}
		productKinds[id] = kind
	}
	for i := range in.Lines {
		line := &in.Lines[i]
		if line.Quantity <= 0 {
			return out, app.Invalid(op, "line quantities must be positive")
		}
		if stockID != nil && (line.Kind == KindColony || line.Kind == KindEquipment) {
			return out, app.Invalid(op, "colony and equipment sales come off home")
		}
		if line.ProductID != uuid.Nil {
			kind := productKinds[line.ProductID]
			if line.Kind == "product" {
				line.Kind = kind
			} else if line.Kind != kind {
				return out, app.Invalid(op, "line kind must match the catalog product")
			}
		}
		if line.Kind == KindEquipment && line.ItemID == uuid.Nil {
			item, err := appequipment.ResolveItem(ctx, uow, line.EquipmentStockID)
			if err != nil {
				return out, err
			}
			line.ItemID = item.ItemID
		}
		if line.BottlingRunID != uuid.Nil {
			var lotID uuid.UUID
			var size *uuid.UUID
			var code string
			var voided bool
			if err := uow.QueryRow(ctx, `SELECT b.lot_id,b.jar_size_id,l.lot_code,b.voided_at IS NOT NULL FROM bottling_runs b JOIN harvest_lots l ON l.id=b.lot_id WHERE b.id=$1`, line.BottlingRunID).Scan(&lotID, &size, &code, &voided); errors.Is(err, pgx.ErrNoRows) {
				return out, app.Invalid(op, "invalid bottlingRunId")
			} else if err != nil {
				return out, dbError(op, err)
			}
			if voided {
				return out, app.Conflict(op, "bottling run for lot %s is voided", code)
			}
			if size == nil || *size != line.JarSizeID {
				return out, app.Invalid(op, "bottlingRunId does not match its jar size")
			}
			if refusal, until, err := production.LotRefusal(ctx, uow, lotID, in.Date); err != nil {
				return out, err
			} else if refusal != "" {
				if until != nil {
					return out, app.Conflict(op, "Lot %s: %s (%s)", code, refusal, until.Format("2006-01-02"))
				}
				return out, app.Conflict(op, "Lot %s: %s", code, refusal)
			}
		}
	}
	if in.HarvestLotID != nil {
		if refusal, until, err := production.LotRefusal(ctx, uow, *in.HarvestLotID, in.Date); err != nil {
			return out, err
		} else if refusal != "" {
			if until != nil {
				return out, app.Conflict(op, "%s (%s)", refusal, until.Format("2006-01-02"))
			}
			return out, app.Conflict(op, "%s", refusal)
		}
	}
	if in.WholesalePriceListID != nil {
		if in.Channel != "wholesale" {
			return out, app.Invalid(op, "wholesalePriceListId requires the wholesale channel")
		}
		var minimum int64
		if err := uow.QueryRow(ctx, `SELECT minimum_order_amount_cents FROM wholesale_price_lists WHERE id=$1 AND is_active`, *in.WholesalePriceListID).Scan(&minimum); err != nil {
			return out, app.NotFound(op, "invalid wholesale price list")
		}
		rows, err := uow.Query(ctx, `SELECT jar_size_id,unit_price_cents FROM wholesale_price_list_items WHERE price_list_id=$1`, *in.WholesalePriceListID)
		if err != nil {
			return out, dbError(op, err)
		}
		prices := map[uuid.UUID]int64{}
		for rows.Next() {
			var id uuid.UUID
			var price int64
			if err := rows.Scan(&id, &price); err != nil {
				rows.Close()
				return out, dbError(op, err)
			}
			prices[id] = price
		}
		rows.Close()
		for i := range in.Lines {
			if in.Lines[i].Kind == KindJar {
				price, ok := prices[in.Lines[i].JarSizeID]
				if !ok {
					return out, app.Invalid(op, "wholesale price list does not cover every jar size")
				}
				in.Lines[i].UnitPriceCents = price
			}
		}
		subtotal := int64(0)
		for _, line := range in.Lines {
			subtotal += line.UnitPriceCents * int64(line.Quantity)
		}
		if subtotal-in.DiscountAmountCents < minimum {
			return out, app.Precondition(op, "wholesale minimum is $%.2f", float64(minimum)/100)
		}
	}
	subtotal := int64(0)
	for _, line := range in.Lines {
		if in.Channel != "gift" && line.UnitPriceCents == 0 {
			return out, app.Invalid(op, "unitPrice must be greater than zero unless the channel is gift")
		}
		subtotal += line.UnitPriceCents * int64(line.Quantity)
	}
	if in.DiscountAmountCents < 0 || in.DiscountAmountCents > subtotal {
		return out, app.Invalid(op, "discount must be between zero and the subtotal")
	}
	total := subtotal - in.DiscountAmountCents
	paid := total
	if in.OrderStatus == "draft" || in.OrderStatus == "pending" {
		paid = 0
	}
	if in.AmountPaidCents != nil {
		paid = *in.AmountPaidCents
	}
	if paid < 0 || paid > total {
		return out, app.Invalid(op, "amountPaid must be between zero and the total")
	}
	out.Subtotal, out.TotalAmount, out.AmountPaid, out.BalanceDue = Money(subtotal), Money(total), Money(paid), Money(total-paid)
	if _, err := uow.Exec(ctx, `INSERT INTO sales(id,date,customer_id,harvest_lot_id,customer_name,location,channel,payment_method,total_amount_cents,discount_amount_cents,amount_paid_cents,tax_cents,order_status,order_number,due_date,wholesale_price_list_id,notes,created_by,stock_location_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)`, in.SaleID, in.Date, in.CustomerID, in.HarvestLotID, trim(in.CustomerName), trim(in.Location), in.Channel, in.PaymentMethod, total, in.DiscountAmountCents, paid, in.TaxCents, in.OrderStatus, in.OrderNumber, in.DueDate, in.WholesalePriceListID, trim(in.Notes), actorValue(uow), stockID); err != nil {
		return out, dbError(op, err)
	}
	for _, line := range in.Lines {
		var jar, hive, item, product, run *uuid.UUID
		switch {
		case line.Kind == KindJar:
			jar = ptr(line.JarSizeID)
			if line.BottlingRunID != uuid.Nil {
				run = ptr(line.BottlingRunID)
			}
		case line.Kind == KindColony:
			hive = ptr(line.HiveID)
		case line.Kind == KindEquipment:
			item = ptr(line.ItemID)
		default:
			product = ptr(line.ProductID)
		}
		if _, err := uow.Exec(ctx, `INSERT INTO sale_items(sale_id,kind,jar_size_id,hive_id,item_id,product_id,quantity,unit_price_cents,bottling_run_id,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, in.SaleID, line.Kind, jar, hive, item, product, line.Quantity, line.UnitPriceCents, run, actorValue(uow)); err != nil {
			return out, dbError(op, err)
		}
	}
	svc := New()
	if applies(in.OrderStatus) {
		if _, err := uow.Exec(ctx, `UPDATE sales SET physical_applied_at=now() WHERE id=$1`, in.SaleID); err != nil {
			return out, dbError(op, err)
		}
		if err := applyPhysical(ctx, uow, in.SaleID, in.Date, in.Lines); err != nil {
			return out, err
		}
	} else {
		if err := svc.LinkLines(ctx, uow, in.SaleID, locationID); err != nil {
			return out, err
		}
		needs, err := NeedsForSale(ctx, uow, in.SaleID)
		if err != nil {
			return out, err
		}
		if err := svc.CheckAvailabilityExcluding(ctx, uow, locationID, in.SaleID, needs); err != nil {
			return out, err
		}
		if err := checkHives(ctx, uow, in.Lines, false); err != nil {
			return out, err
		}
	}
	if err := uow.Emit(ctx, app.Event{AggregateType: "sale", AggregateID: in.SaleID, Type: "sale.recorded", Payload: map[string]any{"orderNumber": in.OrderNumber, "status": in.OrderStatus}}); err != nil {
		return out, err
	}
	out.Success = true
	return out, nil
}

func uniqueSortedUUIDs(ids []uuid.UUID) []uuid.UUID {
	set := make(map[uuid.UUID]struct{}, len(ids))
	for _, id := range ids {
		if id != uuid.Nil {
			set[id] = struct{}{}
		}
	}
	out := make([]uuid.UUID, 0, len(set))
	for id := range set {
		out = append(out, id)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].String() < out[j].String() })
	return out
}

func UpdateSale(ctx context.Context, uow *app.UnitOfWork, in UpdateSaleInput) (UpdateSaleResult, error) {
	const op = "update sale"
	out := UpdateSaleResult{Success: true, OrderStatus: in.OrderStatus}
	if in.SaleID == uuid.Nil {
		return out, app.Invalid(op, "sale is required")
	}
	if in.TaxCents != nil && *in.TaxCents < 0 {
		return out, app.Invalid(op, "tax must not be negative")
	}
	var total, current int64
	var payment string
	var date time.Time
	var applied *time.Time
	if err := uow.QueryRow(ctx, `SELECT total_amount_cents,amount_paid_cents,payment_method,date,physical_applied_at FROM sales WHERE id=$1 AND order_status<>'cancelled' FOR UPDATE`, in.SaleID).Scan(&total, &current, &payment, &date, &applied); errors.Is(err, pgx.ErrNoRows) {
		return out, app.NotFound(op, "sale not found")
	} else if err != nil {
		return out, dbError(op, err)
	}
	paid := current
	if in.AmountPaidCents != nil {
		paid = *in.AmountPaidCents
	} else if applies(in.OrderStatus) {
		paid = total
	}
	if paid < 0 || paid > total {
		return out, app.Invalid(op, "amountPaid must be between zero and the total")
	}
	if in.PaymentMethod != nil {
		payment = *in.PaymentMethod
	}
	if _, err := uow.Exec(ctx, `UPDATE sales SET order_status=$2,amount_paid_cents=$3,payment_method=$4,due_date=CASE WHEN $5 THEN $6 ELSE due_date END,tax_cents=COALESCE($7,tax_cents) WHERE id=$1`, in.SaleID, in.OrderStatus, paid, payment, in.DueDateSet, in.DueDate, in.TaxCents); err != nil {
		return out, dbError(op, err)
	}
	switch {
	case applies(in.OrderStatus) && applied == nil:
		lines, err := loadCommandLines(ctx, uow, in.SaleID)
		if err != nil {
			return out, err
		}
		if _, err := uow.Exec(ctx, `UPDATE sales SET physical_applied_at=now() WHERE id=$1`, in.SaleID); err != nil {
			return out, dbError(op, err)
		}
		if err := applyPhysical(ctx, uow, in.SaleID, date, lines); err != nil {
			return out, err
		}
	case !applies(in.OrderStatus) && applied != nil:
		if err := revertPhysical(ctx, uow, in.SaleID); err != nil {
			return out, err
		}
		if _, err := uow.Exec(ctx, `UPDATE sales SET physical_applied_at=NULL WHERE id=$1`, in.SaleID); err != nil {
			return out, dbError(op, err)
		}
	}
	if err := uow.Emit(ctx, app.Event{AggregateType: "sale", AggregateID: in.SaleID, Type: "sale.updated", Payload: map[string]any{"status": in.OrderStatus}}); err != nil {
		return out, err
	}
	out.AmountPaid, out.BalanceDue = Money(paid), Money(total-paid)
	return out, nil
}

func CancelSale(ctx context.Context, uow *app.UnitOfWork, in CancelSaleInput) (CancelSaleResult, error) {
	const op = "cancel sale"
	out := CancelSaleResult{Success: true, Cancelled: true, OrderStatus: "cancelled", ID: in.SaleID}
	if in.SaleID == uuid.Nil {
		return out, app.Invalid(op, "sale is required")
	}
	var settled bool
	if err := uow.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM consignment_settlements WHERE sale_id=$1 AND voided_at IS NULL)`, in.SaleID).Scan(&settled); err != nil {
		return out, dbError(op, err)
	}
	if settled {
		return out, app.Conflict(op, "this sale was recognised by a consignment settlement; void the settlement instead")
	}
	var status string
	var applied *time.Time
	if err := uow.QueryRow(ctx, `SELECT order_status,physical_applied_at FROM sales WHERE id=$1 FOR UPDATE`, in.SaleID).Scan(&status, &applied); errors.Is(err, pgx.ErrNoRows) {
		return out, app.NotFound(op, "sale not found")
	} else if err != nil {
		return out, dbError(op, err)
	}
	if status != "cancelled" && applied != nil {
		if err := revertPhysical(ctx, uow, in.SaleID); err != nil {
			return out, err
		}
	}
	var total, paid int64
	if err := uow.QueryRow(ctx, `UPDATE sales SET order_status='cancelled',physical_applied_at=NULL,cancelled_at=COALESCE(cancelled_at,now()),cancelled_by=COALESCE(cancelled_by,$2),cancellation_reason=COALESCE($3,cancellation_reason) WHERE id=$1 RETURNING total_amount_cents,amount_paid_cents`, in.SaleID, actorValue(uow), trim(in.Reason)).Scan(&total, &paid); err != nil {
		return out, dbError(op, err)
	}
	if _, err := uow.Exec(ctx, `UPDATE jar_serials SET sale_id=NULL,sold_at=NULL,linked_by=NULL WHERE sale_id=$1`, in.SaleID); err != nil {
		return out, dbError(op, err)
	}
	if err := uow.Emit(ctx, app.Event{AggregateType: "sale", AggregateID: in.SaleID, Type: "sale.cancelled", Payload: map[string]any{"reason": trim(in.Reason)}}); err != nil {
		return out, err
	}
	out.AmountPaid, out.BalanceDue = Money(paid), Money(total-paid)
	return out, nil
}

func applyPhysical(ctx context.Context, uow *app.UnitOfWork, saleID uuid.UUID, date time.Time, lines []SaleLine) error {
	svc := New()
	location, err := svc.SaleLocation(ctx, uow, saleID)
	if err != nil {
		return err
	}
	if err := svc.LinkLines(ctx, uow, saleID, location); err != nil {
		return err
	}
	needed := map[uuid.UUID]int{}
	for _, l := range lines {
		if l.Kind == KindEquipment {
			needed[l.ItemID] += l.Quantity
		}
	}
	if err := checkHives(ctx, uow, lines, true); err != nil {
		return err
	}
	if err := svc.Apply(ctx, uow, ApplyInput{SaleID: saleID, Date: date, LocationID: location, EquipmentByItem: needed}); err != nil {
		return err
	}
	for _, l := range lines {
		if l.Kind != KindColony {
			continue
		}
		if _, err := uow.Exec(ctx, `UPDATE feedings SET status='closed',closed_at=$2,closed_reason='sold_with_hive',sale_id=$3,status_changed_at=now(),status_changed_by=$4,date_empty=COALESCE(date_empty,$2) WHERE hive_id=$1 AND status IN('open','unverified')`, l.HiveID, date, saleID, actorValue(uow)); err != nil {
			return dbError("close sold hive feeding", err)
		}
		var basis *int64
		if err := uow.QueryRow(ctx, `SELECT SUM(amount_cents)::bigint FROM expenses WHERE hive_id=$1 AND category='bees_queens' AND deleted_at IS NULL`, l.HiveID).Scan(&basis); err != nil {
			return dbError("snapshot colony cost", err)
		}
		if _, err := uow.Exec(ctx, `UPDATE sale_items SET cost_basis_cents=$3 WHERE sale_id=$1 AND kind='colony' AND hive_id=$2`, saleID, l.HiveID, basis); err != nil {
			return dbError("snapshot colony cost", err)
		}
	}
	_, err = uow.Exec(ctx, `UPDATE sale_items si SET cost_basis_cents=si.quantity::bigint*et.unit_cost_cents::bigint FROM inventory_items i JOIN equipment_types et ON et.item_id=i.id WHERE si.sale_id=$1 AND si.kind='equipment' AND i.id=si.item_id AND et.unit_cost_cents IS NOT NULL`, saleID)
	return dbError("snapshot equipment cost", err)
}
func checkHives(ctx context.Context, uow *app.UnitOfWork, lines []SaleLine, lock bool) error {
	ids := []uuid.UUID{}
	for _, l := range lines {
		if l.Kind == KindColony {
			ids = append(ids, l.HiveID)
		}
	}
	sort.Slice(ids, func(i, j int) bool { return ids[i].String() < ids[j].String() })
	seen := map[uuid.UUID]bool{}
	for _, id := range ids {
		if seen[id] {
			return app.Invalid("check sale hives", "a hive can only appear once")
		}
		seen[id] = true
		query := `SELECT status::text FROM hives WHERE id=$1`
		if lock {
			query += ` FOR UPDATE`
		}
		var status string
		if err := uow.QueryRow(ctx, query, id).Scan(&status); errors.Is(err, pgx.ErrNoRows) {
			return app.NotFound("check sale hives", "invalid hiveId")
		} else if err != nil {
			return dbError("check sale hives", err)
		}
		if status == "sold" {
			if !lock {
				return app.Invalid("check sale hives", "cannot sell a hive that is already sold")
			}
			var order *string
			if err := uow.QueryRow(ctx, `SELECT s.order_number FROM hives h LEFT JOIN sales s ON s.id=h.sale_id WHERE h.id=$1`, id).Scan(&order); err != nil {
				return dbError("check sale hives", err)
			}
			if order != nil {
				return app.Conflict("check sale hives", "hive was already sold on sale %s", *order)
			}
			return app.Conflict("check sale hives", "hive was already sold on another sale")
		}
		if status == "dead" || status == "combined" {
			return app.Invalid("check sale hives", "cannot sell a hive that is already %s", status)
		}
	}
	return nil
}
func revertPhysical(ctx context.Context, uow *app.UnitOfWork, id uuid.UUID) error {
	if err := New().Unapply(ctx, uow, id); err != nil {
		return err
	}
	if _, err := uow.Exec(ctx, `UPDATE feedings SET status='open',closed_at=NULL,date_empty=NULL,closed_reason=NULL,sale_id=NULL,status_changed_at=now(),status_changed_by=$2 WHERE sale_id=$1 AND closed_reason='sold_with_hive'`, id, actorValue(uow)); err != nil {
		return dbError("restore feeding", err)
	}
	if _, err := uow.Exec(ctx, `UPDATE hives SET status='active',sale_id=NULL WHERE sale_id=$1`, id); err != nil {
		return dbError("restore hive", err)
	}
	_, err := uow.Exec(ctx, `UPDATE sale_items SET cost_basis_cents=NULL WHERE sale_id=$1`, id)
	return dbError("clear sale costs", err)
}
func loadCommandLines(ctx context.Context, uow *app.UnitOfWork, id uuid.UUID) ([]SaleLine, error) {
	rows, err := uow.Query(ctx, `SELECT kind,jar_size_id,hive_id,item_id,product_id,quantity,unit_price_cents,bottling_run_id FROM sale_items WHERE sale_id=$1 ORDER BY id`, id)
	if err != nil {
		return nil, dbError("load sale lines", err)
	}
	defer rows.Close()
	out := []SaleLine{}
	for rows.Next() {
		var x SaleLine
		var jar, hive, item, product, run *uuid.UUID
		if err := rows.Scan(&x.Kind, &jar, &hive, &item, &product, &x.Quantity, &x.UnitPriceCents, &run); err != nil {
			return nil, dbError("load sale lines", err)
		}
		if jar != nil {
			x.JarSizeID = *jar
		}
		if hive != nil {
			x.HiveID = *hive
		}
		if item != nil {
			x.ItemID = *item
		}
		if product != nil {
			x.ProductID = *product
		}
		if run != nil {
			x.BottlingRunID = *run
		}
		out = append(out, x)
	}
	return out, dbError("load sale lines", rows.Err())
}
func resolveSaleLocation(ctx context.Context, uow *app.UnitOfWork, id *uuid.UUID) (uuid.UUID, *uuid.UUID, error) {
	if id == nil {
		home, err := production.HomeLocationID(ctx, uow)
		return home, nil, err
	}
	var location uuid.UUID
	var active, home, consignment bool
	if err := uow.QueryRow(ctx, `SELECT id,is_active,is_home,is_consignment FROM inventory_locations WHERE (id=$1 OR (source_type='stock_location' AND source_id=$1)) AND deleted_at IS NULL AND (kind='consignee' OR is_home) ORDER BY (id=$1) DESC LIMIT 1`, *id).Scan(&location, &active, &home, &consignment); errors.Is(err, pgx.ErrNoRows) {
		return uuid.Nil, nil, app.NotFound("resolve sale location", "invalid stockLocationId")
	} else if err != nil {
		return uuid.Nil, nil, dbError("resolve sale location", err)
	}
	if !active {
		return uuid.Nil, nil, app.Precondition("resolve sale location", "stock location is not active")
	}
	if consignment {
		return uuid.Nil, nil, app.Conflict("resolve sale location", "record a consignment report for this location")
	}
	if home {
		return location, nil, nil
	}
	return location, &location, nil
}
func applies(status string) bool { return status == "paid" || status == "fulfilled" }
func trim(v *string) *string {
	if v == nil {
		return nil
	}
	s := strings.TrimSpace(*v)
	if s == "" {
		return nil
	}
	return &s
}
func actorValue(uow *app.UnitOfWork) any {
	if id := uow.Actor().AuditUserID(); id != uuid.Nil {
		return id
	}
	return nil
}
func ptr(id uuid.UUID) *uuid.UUID { return &id }
func dbError(op string, err error) error {
	if err == nil {
		return nil
	}
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) {
		switch pgErr.Code {
		case "23505":
			return app.Conflict(op, "a record with the same value already exists")
		case "23503":
			return app.NotFound(op, "a referenced record does not exist")
		case "23514", "23502":
			return app.Invalid(op, "the database rejected a value")
		}
	}
	return app.Internal(op, err)
}
