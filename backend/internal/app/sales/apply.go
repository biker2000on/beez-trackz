package sales

import (
	"context"
	"errors"
	"time"

	"github.com/biker2000on/beez-trackz/backend/internal/app"
	"github.com/biker2000on/beez-trackz/backend/internal/app/inventory"
	"github.com/biker2000on/beez-trackz/backend/internal/app/inventory/build"
	"github.com/biker2000on/beez-trackz/backend/internal/app/production"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// ApplyInput is a sale becoming physical: paid or fulfilled.
type ApplyInput struct {
	SaleID uuid.UUID
	Date   time.Time
	// LocationID is the inventory location the sale comes off — home for an
	// ordinary sale, the consignee for a shop's report.
	LocationID uuid.UUID
	// EquipmentByItem is the loose gear the sale takes, by inventory item.
	// Colony lines draw from it first: gear that leaves on the hive is not
	// also taken out of storage.
	EquipmentByItem map[uuid.UUID]int
}

// Apply records the sale_consume for one sale (spec 6.3).
//
// Jar and product lines consume from the lot their bottling run named, or
// from the location's oldest receipt when they name none — an inference that
// is recorded as details.lot_allocation.method = "fifo-inferred" (review A3)
// and never presented as recorded provenance.
//
// A colony line takes the gear standing on its hive: those lines carry
// container_hive_id at the virtual deployed location (review A5), the hive is
// marked sold in the same unit of work, and gear the buyer does not take
// comes home as a return so the hive's balances reach zero exactly when the
// colony leaves.
func (s *Service) Apply(ctx context.Context, uow *app.UnitOfWork, input ApplyInput) error {
	const op = "apply sale"
	lines, err := LoadLines(ctx, uow, input.SaleID)
	if err != nil {
		return err
	}
	home, err := production.HomeLocationID(ctx, uow)
	if err != nil {
		return err
	}
	location := input.LocationID
	if location == uuid.Nil {
		location = home
	}

	needed := make(map[uuid.UUID]int, len(input.EquipmentByItem))
	for itemID, quantity := range input.EquipmentByItem {
		needed[itemID] = quantity
	}

	consume := make([]inventory.Movement, 0, len(lines))
	returns := make([]inventory.Movement, 0)
	allocations := make([]map[string]any, 0, len(lines))
	inferred := false

	for _, line := range lines {
		switch {
		case line.Kind == KindColony && line.HiveID != nil:
			sold, kept, err := s.colonyGear(ctx, uow, *line.HiveID, home, needed)
			if err != nil {
				return err
			}
			consume = append(consume, sold...)
			returns = append(returns, kept...)
			if err := s.markHiveSold(ctx, uow, *line.HiveID, input.SaleID); err != nil {
				return err
			}
		case line.Kind == KindPropolis:
			grams := 0.0
			if line.NetGrams != nil {
				grams = *line.NetGrams * float64(line.Quantity)
			}
			if grams <= 0 {
				continue
			}
			movements, method, err := s.drawPropolis(ctx, uow, home, grams)
			if err != nil {
				return err
			}
			if method == production.MethodFIFOInferred {
				inferred = true
			}
			consume = append(consume, movements...)
		case line.ItemID != nil && line.Kind == KindEquipment:
			// Loose gear off the storage shelf; a colony line may already have
			// taken part of the request off the hive.
			remaining := needed[*line.ItemID]
			if remaining <= 0 {
				continue
			}
			condition := production.ConditionServiceable
			consume = append(consume, inventory.Movement{
				Tuple: inventory.Tuple{
					ItemID: *line.ItemID, LocationID: home, Condition: &condition,
				},
				Quantity:      production.Negate(production.Quantity(remaining)),
				QuantityScale: production.CountScale,
			})
			needed[*line.ItemID] = 0
		case line.ItemID != nil:
			allocated, method, err := production.AllocateFIFO(ctx, uow, "inventory_balances",
				*line.ItemID, location, line.Quantity, line.LotID)
			if err != nil {
				return err
			}
			if method == production.MethodFIFOInferred {
				inferred = true
			}
			for _, allocation := range allocated {
				lotID := allocation.LotID
				consume = append(consume, inventory.Movement{
					Tuple: inventory.Tuple{
						ItemID: *line.ItemID, LocationID: location, LotID: &lotID,
					},
					Quantity:      production.Negate(production.Quantity(allocation.Quantity)),
					QuantityScale: production.CountScale,
				})
				allocations = append(allocations, map[string]any{
					"sale_item_id": line.ID.String(),
					"lot_id":       lotID.String(),
					"quantity":     allocation.Quantity,
					"method":       method,
				})
			}
		}
	}

	if len(consume) > 0 {
		attempt, err := production.AttemptFor(ctx, uow, "sale", input.SaleID, "consume")
		if err != nil {
			return err
		}
		details := map[string]any{"lot_allocation": map[string]any{
			"method":      production.AllocationMethod(inferred),
			"allocations": allocations,
		}}
		base := production.OperationBase(uow, "sale", input.SaleID, "consume", attempt,
			production.ReasonNone, input.Date, details)
		operation, err := build.SaleConsume(build.SingleParams{Base: base, Line: consume[0]})
		if err != nil {
			return app.Invalid(op, "%v", err)
		}
		for _, line := range consume[1:] {
			if _, err := build.SaleConsume(build.SingleParams{Base: base, Line: line}); err != nil {
				return app.Invalid(op, "%v", err)
			}
		}
		operation.Lines = consume
		if _, err := s.inventory.Record(ctx, uow, operation); err != nil {
			return err
		}
	}
	return s.recordGearReturns(ctx, uow, input, returns)
}

// recordGearReturns brings home the gear a sold hive kept back. It is a
// paired return per item so the deployed balance and the storage balance move
// together.
func (s *Service) recordGearReturns(
	ctx context.Context, uow *app.UnitOfWork, input ApplyInput, kept []inventory.Movement,
) error {
	if len(kept) == 0 {
		return nil
	}
	home, err := production.HomeLocationID(ctx, uow)
	if err != nil {
		return err
	}
	deployed, err := production.DeployedLocationID(ctx, uow)
	if err != nil {
		return err
	}
	for index, line := range kept {
		attempt, err := production.AttemptFor(ctx, uow, "sale", input.SaleID, "gear-return")
		if err != nil {
			return err
		}
		from := line.Tuple
		from.LocationID = deployed
		to := from
		to.LocationID = home
		to.ContainerHiveID = nil
		base := production.OperationBase(uow, "sale", input.SaleID, "gear-return", attempt+index,
			production.ReasonNone, input.Date, nil)
		operation, err := build.Return(build.TransferParams{
			Base: base, From: from, To: to,
			Quantity:      trimSign(line.Quantity),
			QuantityScale: production.CountScale,
		})
		if err != nil {
			return app.Invalid("return colony gear", "%v", err)
		}
		if _, err := s.inventory.Record(ctx, uow, operation); err != nil {
			return err
		}
	}
	return nil
}

// colonyGear splits the gear standing on a hive into what leaves with the
// colony and what comes back to storage.
func (s *Service) colonyGear(
	ctx context.Context, uow *app.UnitOfWork, hiveID, home uuid.UUID, needed map[uuid.UUID]int,
) (sold, kept []inventory.Movement, err error) {
	deployed, err := production.DeployedLocationID(ctx, uow)
	if err != nil {
		return nil, nil, err
	}
	rows, err := uow.Query(ctx, `
		SELECT item_id, condition, on_hand::int
		FROM inventory_balances
		WHERE location_id=$1 AND container_hive_id=$2 AND on_hand > 0
		ORDER BY item_id, condition`, deployed, hiveID)
	if err != nil {
		return nil, nil, app.Wrap(app.KindInternal, "read deployed gear", err)
	}
	defer rows.Close()
	type balance struct {
		itemID    uuid.UUID
		condition *string
		onHand    int
	}
	balances := make([]balance, 0)
	for rows.Next() {
		var entry balance
		if err := rows.Scan(&entry.itemID, &entry.condition, &entry.onHand); err != nil {
			return nil, nil, app.Wrap(app.KindInternal, "read deployed gear", err)
		}
		balances = append(balances, entry)
	}
	if err := rows.Err(); err != nil {
		return nil, nil, app.Wrap(app.KindInternal, "read deployed gear", err)
	}

	hive := hiveID
	for _, entry := range balances {
		take := needed[entry.itemID]
		if take > entry.onHand {
			take = entry.onHand
		}
		tuple := inventory.Tuple{
			ItemID: entry.itemID, LocationID: deployed,
			Condition: entry.condition, ContainerHiveID: &hive,
		}
		if take > 0 {
			sold = append(sold, inventory.Movement{
				Tuple:         tuple,
				Quantity:      production.Negate(production.Quantity(take)),
				QuantityScale: production.CountScale,
			})
			needed[entry.itemID] -= take
		}
		if remainder := entry.onHand - take; remainder > 0 {
			kept = append(kept, inventory.Movement{
				Tuple:         tuple,
				Quantity:      production.Quantity(remainder),
				QuantityScale: production.CountScale,
			})
		}
	}
	return sold, kept, nil
}

func (s *Service) markHiveSold(ctx context.Context, uow *app.UnitOfWork, hiveID, saleID uuid.UUID) error {
	tag, err := uow.Exec(ctx, `
		UPDATE hives SET status='sold', sale_id=$2
		WHERE id=$1 AND status NOT IN ('sold','dead','combined')`, hiveID, saleID)
	if err != nil {
		return app.Wrap(app.KindInternal, "mark hive sold", err)
	}
	if tag.RowsAffected() == 0 {
		return app.Precondition("mark hive sold",
			"cannot sell a hive that is already sold, dead, or combined")
	}
	return nil
}

// drawPropolis consumes raw propolis grams for a raw-propolis SKU line. The
// SKU carries no stock of its own: what leaves is harvested propolis, oldest
// harvest first.
func (s *Service) drawPropolis(
	ctx context.Context, uow *app.UnitOfWork, home uuid.UUID, grams float64,
) ([]inventory.Movement, string, error) {
	lots, err := production.LotsFIFO(ctx, uow, "inventory_balances", production.PropolisItemID, home)
	if err != nil {
		return nil, "", err
	}
	remaining := grams
	movements := make([]inventory.Movement, 0, 1)
	for _, lot := range lots {
		if remaining <= production.PoundTolerance {
			break
		}
		onHand, _ := lot.OnHand.Float64()
		take := onHand
		if take > remaining {
			take = remaining
		}
		if take <= production.PoundTolerance {
			continue
		}
		lotID := lot.LotID
		movements = append(movements, inventory.Movement{
			Tuple: inventory.Tuple{
				ItemID: production.PropolisItemID, LocationID: home, LotID: &lotID,
			},
			Quantity:      production.Negate(production.Pounds(take)),
			QuantityScale: production.MassScale,
		})
		remaining -= take
	}
	if remaining > production.PoundTolerance {
		return nil, "", app.Precondition("consume propolis",
			"only %.2f g of the %.2f g this sale needs are on hand", grams-remaining, grams)
	}
	return movements, production.MethodFIFOInferred, nil
}

// Unapply reverses everything a sale recorded, which is what moving back to
// draft, cancelling, or voiding a settlement's sale means for the ledger.
// The hive comes back too: its gear is restored by the reversal, so leaving
// it sold would strand a live balance on a hive nobody owns.
func (s *Service) Unapply(ctx context.Context, uow *app.UnitOfWork, saleID uuid.UUID) error {
	operations, err := production.LiveOperations(ctx, uow, "sale", saleID)
	if err != nil {
		return err
	}
	// Reverse gear returns before consumption: putting gear back on the hive
	// before the hive's own lines are restored keeps every intermediate
	// balance nonnegative.
	for i := len(operations) - 1; i >= 0; i-- {
		id := operations[i]
		if _, err := s.inventory.Reverse(ctx, uow, id, id.String()+":unapply",
			production.ReasonNone); err != nil {
			return err
		}
	}
	return nil
}

// SaleLocation reads a sale's stock location as an inventory location.
func (s *Service) SaleLocation(
	ctx context.Context, uow *app.UnitOfWork, saleID uuid.UUID,
) (uuid.UUID, error) {
	var stockLocationID *uuid.UUID
	err := uow.QueryRow(ctx, `SELECT stock_location_id FROM sales WHERE id=$1`, saleID).
		Scan(&stockLocationID)
	if errors.Is(err, pgx.ErrNoRows) {
		return uuid.Nil, app.NotFound("resolve sale location", "sale %s does not exist", saleID)
	}
	if err != nil {
		return uuid.Nil, app.Wrap(app.KindInternal, "resolve sale location", err)
	}
	return production.LocationForSale(ctx, uow, stockLocationID)
}
