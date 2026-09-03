package httpapi

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"sort"
	"strings"
	"time"

	"github.com/biker2000on/beez-trackz/backend/internal/app"
	"github.com/biker2000on/beez-trackz/backend/internal/app/sales"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

const (
	saleKindJar       = "jar"
	saleKindColony    = "colony"
	saleKindEquipment = "equipment"
)

// saleApplyPhysical moves what a mixed sale takes with it. Jar, product, and
// equipment quantities are one sale_consume operation; the colony's gear
// leaves at the virtual deployed location carrying container_hive_id, and gear
// the buyer does not take comes home as a return (review A5).
//
// The hive itself is not stock: the sales command marks it sold inside the
// same unit of work, and this function closes its feeders and freezes the
// cost basis afterwards.
func saleApplyPhysical(
	ctx context.Context,
	uow *app.UnitOfWork,
	saleID uuid.UUID,
	date time.Time,
	actor *uuid.UUID,
	lines []honeySaleLine,
) error {
	commands := sales.New()
	location, err := commands.SaleLocation(ctx, uow, saleID)
	if err != nil {
		return err
	}
	if err := commands.LinkLines(ctx, uow, saleID, location); err != nil {
		return err
	}

	needed := make(map[uuid.UUID]int)
	seenHive := make(map[uuid.UUID]bool, len(lines))
	hiveIDs := make([]uuid.UUID, 0, len(lines))
	for _, line := range lines {
		switch line.Kind {
		case saleKindColony:
			if seenHive[line.HiveID] {
				return saleBadRequest("a hive can only appear once on a sale")
			}
			seenHive[line.HiveID] = true
			hiveIDs = append(hiveIDs, line.HiveID)
		case saleKindEquipment:
			if line.ItemID == uuid.Nil {
				return saleBadRequest("equipment lines require an inventory item")
			}
			needed[line.ItemID] += line.Quantity
		}
	}
	// The hive rows are domain locks, taken before any tuple lock, in id order
	// so two concurrent sales of the same pair cannot deadlock.
	sort.Slice(hiveIDs, func(i, j int) bool { return hiveIDs[i].String() < hiveIDs[j].String() })
	for _, hiveID := range hiveIDs {
		if err := saleCheckHiveSellable(ctx, uow, hiveID); err != nil {
			return err
		}
	}

	if err := commands.Apply(ctx, uow, sales.ApplyInput{
		SaleID: saleID, Date: date, LocationID: location, EquipmentByItem: needed,
	}); err != nil {
		return saleApplyError(err)
	}

	for _, hiveID := range hiveIDs {
		if _, err := uow.Exec(ctx, `
			UPDATE feedings
			SET status='closed',
			    closed_at=$2,
			    closed_reason='sold_with_hive',
			    sale_id=$3,
			    status_changed_at=now(),
			    status_changed_by=$4,
			    date_empty=COALESCE(date_empty, $2)
			WHERE hive_id=$1 AND status IN ('open','unverified')`,
			hiveID, date, saleID, actor); err != nil {
			return err
		}
		if err := saleSnapshotColonyCost(ctx, uow, saleID, hiveID); err != nil {
			return err
		}
	}
	return saleSnapshotEquipmentCost(ctx, uow, saleID)
}

// saleApplyError turns the ledger's refusals into the sentences this endpoint
// has always produced.
func saleApplyError(err error) error {
	switch {
	case err == nil:
		return nil
	case app.IsKind(err, app.KindPrecondition):
		return equipFail(http.StatusConflict, "%s", messageOf(err))
	default:
		return err
	}
}

// saleCheckHiveSellable refuses a colony line whose hive is already gone,
// naming the sale that took it so the operator can find it. It locks the hive
// row: a domain lock, before any inventory tuple lock.
func saleCheckHiveSellable(ctx context.Context, uow *app.UnitOfWork, hiveID uuid.UUID) error {
	var status string
	err := uow.QueryRow(ctx,
		`SELECT status::text FROM hives WHERE id=$1 FOR UPDATE`, hiveID).Scan(&status)
	if errors.Is(err, pgx.ErrNoRows) {
		return saleBadRequest("invalid hiveId")
	}
	if err != nil {
		return err
	}
	if status == "sold" {
		var orderNumber *string
		if err := uow.QueryRow(ctx, `
			SELECT s.order_number FROM hives h LEFT JOIN sales s ON s.id=h.sale_id
			WHERE h.id=$1`, hiveID).Scan(&orderNumber); err != nil {
			return err
		}
		if orderNumber != nil {
			return equipFail(http.StatusConflict, "hive was already sold on sale %s", *orderNumber)
		}
		return equipFail(http.StatusConflict, "hive was already sold on another sale")
	}
	if status == "dead" || status == "combined" {
		return saleBadRequest("cannot sell a hive that is already %s", status)
	}
	return nil
}

// saleSnapshotColonyCost freezes the hive's recorded acquisition cost onto
// the colony line. SUM of zero matching expenses is NULL (no recorded
// basis), which is distinct from a basis of zero.
func saleSnapshotColonyCost(
	ctx context.Context,
	uow *app.UnitOfWork,
	saleID, hiveID uuid.UUID,
) error {
	var basis *int64
	if err := uow.QueryRow(ctx, `
		SELECT SUM(amount_cents)::bigint
		FROM expenses
		WHERE hive_id = $1
		  AND category = 'bees_queens'
		  AND deleted_at IS NULL`, hiveID).Scan(&basis); err != nil {
		return err
	}
	_, err := uow.Exec(ctx, `
		UPDATE sale_items
		SET cost_basis_cents = $3
		WHERE sale_id = $1 AND kind = 'colony' AND hive_id = $2`,
		saleID, hiveID, basis)
	return err
}

// saleSnapshotEquipmentCost freezes each equipment line's cost basis from
// equipment_types.unit_cost_cents. The cost moved onto the type when
// equipment_stock dissolved (review OV2); the snapshot itself is unchanged, so
// a later price edit still cannot rewrite a past sale's margin.
func saleSnapshotEquipmentCost(
	ctx context.Context,
	uow *app.UnitOfWork,
	saleID uuid.UUID,
) error {
	_, err := uow.Exec(ctx, `
		UPDATE sale_items si
		SET cost_basis_cents = si.quantity::bigint * et.unit_cost_cents::bigint
		FROM inventory_items i
		JOIN equipment_types et ON et.item_id = i.id
		WHERE si.sale_id = $1 AND si.kind = 'equipment'
		  AND i.id = si.item_id AND et.unit_cost_cents IS NOT NULL`, saleID)
	return err
}

// saleCheckHivesSellable refuses colony lines whose hive is already sold,
// dead, or combined without selling anything. Draft/pending sales run this
// instead of saleApplyPhysical: the hive is not reserved (two open drafts may
// name it) but a hive that is already gone cannot be drafted either.
func saleCheckHivesSellable(ctx context.Context, q inspectionQuerier, lines []honeySaleLine) error {
	seen := make(map[uuid.UUID]bool, len(lines))
	for _, line := range lines {
		if line.Kind != saleKindColony {
			continue
		}
		if seen[line.HiveID] {
			return saleBadRequest("a hive can only appear once on a sale")
		}
		seen[line.HiveID] = true
		var status string
		err := q.QueryRow(ctx,
			`SELECT status::text FROM hives WHERE id=$1`, line.HiveID).Scan(&status)
		if errors.Is(err, pgx.ErrNoRows) {
			return saleBadRequest("invalid hiveId")
		}
		if err != nil {
			return err
		}
		if status == "sold" || status == "dead" || status == "combined" {
			return saleBadRequest("cannot sell a hive that is already %s", status)
		}
	}
	return nil
}

// saleLoadLines reads a sale's stored line items back in the shape
// saleApplyPhysical expects, for sales whose physical effects are applied
// after creation (draft/pending -> paid).
func saleLoadLines(ctx context.Context, q inspectionQuerier, saleID uuid.UUID) ([]honeySaleLine, error) {
	rows, err := q.Query(ctx, `
		SELECT kind, jar_size_id, hive_id, item_id, product_id,
		       quantity, unit_price_cents
		FROM sale_items WHERE sale_id=$1 ORDER BY id`, saleID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	lines := make([]honeySaleLine, 0)
	for rows.Next() {
		var line honeySaleLine
		var jarSizeID, hiveID, itemID, productID *uuid.UUID
		if err := rows.Scan(&line.Kind, &jarSizeID, &hiveID, &itemID, &productID,
			&line.Quantity, &line.UnitPrice); err != nil {
			return nil, err
		}
		if jarSizeID != nil {
			line.JarSizeID = *jarSizeID
		}
		if hiveID != nil {
			line.HiveID = *hiveID
		}
		if itemID != nil {
			line.ItemID = *itemID
		}
		if productID != nil {
			line.ProductID = *productID
		}
		lines = append(lines, line)
	}
	return lines, rows.Err()
}

// saleRestorePhysical undoes the physical effects of a cancelled sale that
// had them applied (physical_applied_at IS NOT NULL).
func saleRestorePhysical(
	ctx context.Context,
	uow *app.UnitOfWork,
	saleID uuid.UUID,
	actor *uuid.UUID,
) error {
	return saleRevertPhysical(ctx, uow, saleID, actor)
}

// saleUnapplyPhysical undoes the physical effects of a sale that moves from
// paid/fulfilled back to draft/pending. It is the same reversal a cancel
// records: the ledger is append-only, so "remove the rows" is not an option
// and is not needed — a later apply records a fresh consumption under its own
// idempotency key.
func saleUnapplyPhysical(
	ctx context.Context,
	uow *app.UnitOfWork,
	saleID uuid.UUID,
	actor *uuid.UUID,
) error {
	return saleRevertPhysical(ctx, uow, saleID, actor)
}

func saleRevertPhysical(
	ctx context.Context,
	uow *app.UnitOfWork,
	saleID uuid.UUID,
	actor *uuid.UUID,
) error {
	// Reversing the sale's operations puts the gear back on its hive and the
	// jars back on their shelf, in one sweep and in reverse order, so no
	// intermediate balance goes negative.
	if err := sales.New().Unapply(ctx, uow, saleID); err != nil {
		return err
	}

	if _, err := uow.Exec(ctx, `
		UPDATE feedings
		SET status='open',
		    closed_at=NULL,
		    date_empty=NULL,
		    closed_reason=NULL,
		    sale_id=NULL,
		    status_changed_at=now(),
		    status_changed_by=$2
		WHERE sale_id=$1 AND closed_reason='sold_with_hive'`,
		saleID, actor); err != nil {
		return err
	}

	if _, err := uow.Exec(ctx, `
		UPDATE hives SET status='active', sale_id=NULL WHERE sale_id=$1`,
		saleID); err != nil {
		return err
	}

	// Clear frozen COGS so a later apply resnapshots from live type prices
	// and bees_queens expenses rather than keeping a stale basis.
	_, err := uow.Exec(ctx, `
		UPDATE sale_items SET cost_basis_cents = NULL WHERE sale_id = $1`, saleID)
	return err
}

func saleBadRequest(format string, args ...any) error {
	return equipBadRequest(format, args...)
}

// --- location-scoped sales -------------------------------------------------
//
// Every sale comes off a stock location. sales.stock_location_id NULL means
// home, which is what every sale was before locations existed, so nothing had
// to be backfilled. A sale scoped to a location decrements THAT shelf: the
// derivation in honey_ledger.go subtracts its lines from the location's net
// instead of from home.
//
// Consignment is the one channel that must carry a location. The shop does not
// buy the stock up front, so nothing is recognised when the jars go over
// there; revenue appears here, at the shop's report, and the money is a
// receivable until amount_paid_cents catches up with total_amount_cents. That
// is the collected-vs-invoiced pair the rest of the app already reads — no
// consignment payment table.

// saleConsignmentLine is one SKU on a shop's report, priced at what the
// operator is owed for it (the shop's commission is already taken out).
type saleConsignmentLine struct {
	JarSizeID *uuid.UUID
	ProductID *uuid.UUID
	Kind      string
	Quantity  int
	UnitPrice money
}

type saleConsignmentInput struct {
	SaleID       uuid.UUID
	LocationID   uuid.UUID
	LocationName string
	CustomerID   *uuid.UUID
	Date         time.Time
	// Defaults to consignment: the shop's report. A location that is simply a
	// second place the operator sells from (a farm stand) names its own.
	Channel        string
	PaymentMethod  string
	TotalAmount    money
	DiscountAmount money
	AmountPaid     money
	OrderNumber    *string
	CustomerName   *string
	Location       *string
	Notes          *string
	Lines          []saleConsignmentLine
	Actor          *uuid.UUID
}

// saleRecordConsignmentReport writes the sale a consignment settlement
// recognises. It is a plain sale row — no new table, no second ledger — and it
// is the only place revenue enters the consignment flow. Transfers never come
// through here, which is how "never recognise revenue on a transfer" is kept.
func saleRecordConsignmentReport(
	ctx context.Context,
	tx inspectionQuerier,
	input saleConsignmentInput,
) (*string, error) {
	if len(input.Lines) == 0 {
		return nil, saleBadRequest("a consignment report needs at least one sold line")
	}
	orderNumber := input.OrderNumber
	if orderNumber == nil {
		value := "BT-" + strings.ToUpper(strings.ReplaceAll(input.SaleID.String()[:8], "-", ""))
		orderNumber = &value
	}
	// Paid in full or not, the revenue is recognised now; the unpaid part is
	// the receivable.
	orderStatus := "pending"
	if input.AmountPaid >= input.TotalAmount {
		orderStatus = "paid"
	}
	channel := input.Channel
	if channel == "" {
		channel = "consignment"
	}
	if !honeySaleChannels[channel] {
		return nil, saleBadRequest("invalid channel")
	}
	customerName := input.CustomerName
	if customerName == nil {
		name := input.LocationName
		customerName = &name
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO sales
			(id, date, customer_id, customer_name, location, channel, payment_method,
			 total_amount_cents, discount_amount_cents, amount_paid_cents, order_status,
			 order_number, stock_location_id, notes, created_by, physical_applied_at)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,now())`,
		input.SaleID, input.Date, input.CustomerID, customerName, input.Location, channel,
		input.PaymentMethod, input.TotalAmount, input.DiscountAmount, input.AmountPaid,
		orderStatus, orderNumber, input.LocationID, input.Notes, input.Actor); err != nil {
		if pgErrCode(err) == "23505" {
			return nil, equipFail(http.StatusConflict, "order number already exists")
		}
		if pgErrCode(err) == "23503" {
			return nil, saleBadRequest("invalid customer or stock location")
		}
		return nil, err
	}
	for _, line := range input.Lines {
		if line.Quantity <= 0 {
			return nil, saleBadRequest("quantity must be greater than zero")
		}
		if line.UnitPrice <= 0 {
			return nil, saleBadRequest("unitPrice must be greater than zero")
		}
		if _, err := tx.Exec(ctx, `
			INSERT INTO sale_items
				(sale_id, kind, jar_size_id, product_id, quantity, unit_price_cents, created_by)
			VALUES ($1,$2,$3,$4,$5,$6,$7)`,
			input.SaleID, line.Kind, line.JarSizeID, line.ProductID, line.Quantity,
			line.UnitPrice, input.Actor); err != nil {
			if honeyIsFKViolation(err) {
				return nil, saleBadRequest("invalid jar size or product target")
			}
			return nil, err
		}
	}
	return orderNumber, nil
}

// GET /hives/{id}/sale-offer — deployments and feeder count the sale dialog
// default-offers when the operator adds this hive as a colony line.
func (s *Server) hiveSaleOffer(w http.ResponseWriter, r *http.Request) {
	hiveID, err := uuidParam(r, "id")
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	hive, err := s.hiveFetch(r.Context(), hiveID)
	if errors.Is(err, pgx.ErrNoRows) {
		writeError(w, http.StatusNotFound, "hive not found")
		return
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}

	var openFeeders int
	if err := s.pool.QueryRow(r.Context(), `
		SELECT COUNT(*) FROM feedings
		WHERE hive_id=$1 AND status IN ('open','unverified')`, hiveID).
		Scan(&openFeeders); err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}

	// Outstanding deployed gear IS the balance at the virtual deployed
	// location for this hive's container (review A1/A5): there is no
	// deployment row to read, and the unit cost comes from the equipment type
	// now that equipment_stock has dissolved (review OV2).
	rows, err := s.pool.Query(r.Context(), `
		SELECT b.item_id, et.name, et.category::text, b.on_hand::int, et.unit_cost_cents
		FROM inventory_balances b
		JOIN inventory_locations loc ON loc.id = b.location_id AND loc.kind = 'deployed'
		JOIN inventory_items i ON i.id = b.item_id
		JOIN equipment_types et ON et.item_id = i.id
		WHERE b.container_hive_id = $1 AND b.on_hand > 0
		ORDER BY et.category, et.name`, hiveID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	defer rows.Close()

	type depOffer struct {
		// ItemID replaces the deployment and stock ids: the ledger has no
		// deployment row, and an item is what a sale line consumes.
		ItemID        uuid.UUID `json:"itemId"`
		TypeName      string    `json:"typeName"`
		TypeCategory  string    `json:"typeCategory"`
		Outstanding   int       `json:"outstanding"`
		UnitCostCents *int      `json:"unitCostCents"`
	}
	deployments := make([]depOffer, 0)
	for rows.Next() {
		var d depOffer
		if err := rows.Scan(&d.ItemID, &d.TypeName, &d.TypeCategory,
			&d.Outstanding, &d.UnitCostCents); err != nil {
			writeError(w, http.StatusInternalServerError, "database error")
			return
		}
		deployments = append(deployments, d)
	}
	if rows.Err() != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}

	sellable := hive.Status != "sold" && hive.Status != "dead" && hive.Status != "combined"
	reason := ""
	if !sellable {
		reason = fmt.Sprintf("this hive is already %s", hive.Status)
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"hiveId":      hive.ID,
		"hiveLabel":   hive.PositionLabel,
		"apiaryName":  hive.ApiaryName,
		"status":      hive.Status,
		"sellable":    sellable,
		"reason":      reason,
		"openFeeders": openFeeders,
		"deployments": deployments,
	})
}
