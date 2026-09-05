package sales

import (
	"context"
	"errors"

	"github.com/biker2000on/beez-trackz/backend/internal/app"
	"github.com/biker2000on/beez-trackz/backend/internal/app/inventory"
	"github.com/biker2000on/beez-trackz/backend/internal/app/production"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// Kinds a sale line can carry. Catalog product kinds (creamed_honey, mead, …)
// are open-ended registry values, so they are matched by exclusion.
const (
	KindJar       = "jar"
	KindColony    = "colony"
	KindEquipment = "equipment"
	KindPropolis  = "propolis"
)

// Service is the sale command surface.
type Service struct {
	inventory  *inventory.Service
	production *production.Service
}

func New() *Service {
	return &Service{inventory: inventory.NewService(), production: production.New()}
}

// Line is one stored sale line, read back with the identities the ledger
// needs. It is the shape both the reservation check and the apply command
// work from, so the two can never disagree about what a sale is asking for.
type Line struct {
	ID        uuid.UUID
	Kind      string
	Quantity  int
	JarSizeID *uuid.UUID
	ProductID *uuid.UUID
	HiveID    *uuid.UUID
	ItemID    *uuid.UUID
	LotID     *uuid.UUID
	// BottlingRunID is the recorded provenance of a jar line; when it is set
	// the lot is a fact rather than a FIFO inference (review A3).
	BottlingRunID *uuid.UUID
	// SaleHarvestLotID is the harvest lot the sale itself names. When that
	// lot holds jars at the sale's location it pins every jar line that has
	// no bottling run; otherwise it is a story reference only.
	SaleHarvestLotID *uuid.UUID
	// NetGrams is the propolis weight one unit of a raw-propolis SKU carries.
	NetGrams *float64
}

// Pinned reports whether the line's lot is recorded provenance rather than
// the reservation's FIFO guess: a bottling run always is; a sale-level harvest
// lot is when the line's lot is that harvest lot's jar lot (LinkLines only
// assigns it when the lot holds stock at the location).
func (l Line) Pinned(ctx context.Context, q app.Querier) (bool, error) {
	if l.LotID == nil {
		return false, nil
	}
	if l.BottlingRunID != nil {
		return true, nil
	}
	if l.SaleHarvestLotID == nil || l.Kind != KindJar {
		return false, nil
	}
	var pinned bool
	if err := q.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM inventory_lots WHERE id=$1 AND source_type='harvest_lot' AND source_id=$2)`,
		*l.LotID, *l.SaleHarvestLotID).Scan(&pinned); err != nil {
		return false, app.Wrap(app.KindInternal, "resolve pinned lot", err)
	}
	return pinned, nil
}

// LoadLines reads a sale's lines with everything the ledger needs.
func LoadLines(ctx context.Context, q app.Querier, saleID uuid.UUID) ([]Line, error) {
	rows, err := q.Query(ctx, `
		SELECT si.id, si.kind, si.quantity, si.jar_size_id, si.product_id, si.hive_id,
		       si.item_id, si.inventory_lot_id, si.bottling_run_id, s.harvest_lot_id,
		       pc.net_grams
		FROM sale_items si
		JOIN sales s ON s.id = si.sale_id
		LEFT JOIN product_catalog pc ON pc.id = si.product_id
		WHERE si.sale_id=$1
		ORDER BY si.id`, saleID)
	if err != nil {
		return nil, app.Wrap(app.KindInternal, "load sale lines", err)
	}
	defer rows.Close()
	lines := make([]Line, 0)
	for rows.Next() {
		var line Line
		if err := rows.Scan(&line.ID, &line.Kind, &line.Quantity, &line.JarSizeID,
			&line.ProductID, &line.HiveID, &line.ItemID, &line.LotID,
			&line.BottlingRunID, &line.SaleHarvestLotID, &line.NetGrams); err != nil {
			return nil, app.Wrap(app.KindInternal, "load sale lines", err)
		}
		lines = append(lines, line)
	}
	return lines, app.Wrap(app.KindInternal, "load sale lines", rows.Err())
}

// LinkLines stamps sale_items.item_id and inventory_lot_id for every line of
// a sale (spec 3.7). It runs on create and on every edit, before the
// reservation is validated, so inventory_reservations sees the line the
// moment it is saved.
//
// A jar line that names a bottling run takes that run's lot. Any other jar or
// product line takes the location's oldest-receipt lot that still has stock,
// which is a FIFO inference; the operation that finally consumes it records
// the inference explicitly (review A3), and this column is only the
// reservation's best guess about where the units will come from.
func (s *Service) LinkLines(
	ctx context.Context, uow *app.UnitOfWork, saleID, locationID uuid.UUID,
) error {
	lines, err := LoadLines(ctx, uow, saleID)
	if err != nil {
		return err
	}
	for _, line := range lines {
		itemID, err := s.itemForLine(ctx, uow, line)
		if err != nil {
			return err
		}
		if itemID == nil {
			continue
		}
		lotID, err := s.reservationLot(ctx, uow, *itemID, locationID, line)
		if err != nil {
			return err
		}
		if _, err := uow.Exec(ctx,
			`UPDATE sale_items SET item_id=$2, inventory_lot_id=$3 WHERE id=$1`,
			line.ID, itemID, lotID); err != nil {
			return app.Wrap(app.KindInternal, "link sale line", err)
		}
	}
	return nil
}

// itemForLine resolves the inventory item a line consumes, creating the
// catalog item on demand. Colony lines have none — a hive is not stock. Raw
// propolis lines consume the singleton propolis item, whose canonical unit is
// grams; inventory_reservations translates their packaged SKU quantities.
func (s *Service) itemForLine(ctx context.Context, uow *app.UnitOfWork, line Line) (*uuid.UUID, error) {
	switch {
	case line.Kind == KindColony:
		return nil, nil
	case line.Kind == KindPropolis:
		id := production.PropolisItemID
		return &id, nil
	case line.Kind == KindJar && line.JarSizeID != nil:
		id, err := production.EnsureJarItem(ctx, uow, *line.JarSizeID)
		return &id, err
	case line.Kind == KindEquipment:
		if line.ItemID != nil {
			return line.ItemID, nil
		}
		return nil, nil
	case line.ProductID != nil:
		id, err := production.EnsureProductItem(ctx, uow, *line.ProductID)
		return &id, err
	}
	return nil, nil
}

func (s *Service) reservationLot(
	ctx context.Context, uow *app.UnitOfWork, itemID, locationID uuid.UUID, line Line,
) (*uuid.UUID, error) {
	if line.Kind == KindEquipment || line.Kind == KindPropolis {
		// Equipment is condition-tracked, not lot-tracked. Raw propolis
		// reservations span the harvested lots and are held at item level.
		return nil, nil
	}
	if line.BottlingRunID != nil {
		lotID, err := s.runLot(ctx, uow, itemID, *line.BottlingRunID)
		if err != nil {
			return nil, err
		}
		if lotID != nil {
			return lotID, nil
		}
	}
	lots, err := production.LotsFIFO(ctx, uow, "inventory_balances", itemID, locationID)
	if err != nil {
		return nil, err
	}
	// A sale-level harvest lot (the consignee sale form's "which varietal")
	// pins a jar line to that lot's jars when some stand at the location.
	// A sale that names a lot with no jars here is using it as the story
	// reference it always was, and the line falls back to the FIFO guess.
	if line.SaleHarvestLotID != nil && line.Kind == KindJar {
		lotID, err := production.EnsureJarLotForHarvestLot(ctx, uow, itemID, *line.SaleHarvestLotID)
		if err != nil {
			return nil, err
		}
		for _, lot := range lots {
			if lot.LotID == lotID {
				return &lotID, nil
			}
		}
	}
	if len(lots) == 0 {
		return nil, nil
	}
	primary := lots[0].LotID
	return &primary, nil
}

// runLot maps a bottling run onto the jar-size lot its jars landed in.
func (s *Service) runLot(
	ctx context.Context, uow *app.UnitOfWork, jarItemID, runID uuid.UUID,
) (*uuid.UUID, error) {
	var harvestLotID uuid.UUID
	err := uow.QueryRow(ctx, `SELECT lot_id FROM bottling_runs WHERE id=$1`, runID).Scan(&harvestLotID)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, app.NotFound("resolve bottling run", "bottling run %s does not exist", runID)
	}
	if err != nil {
		return nil, app.Wrap(app.KindInternal, "resolve bottling run", err)
	}
	lotID, err := production.EnsureJarLotForHarvestLot(ctx, uow, jarItemID, harvestLotID)
	if err != nil {
		return nil, err
	}
	return &lotID, nil
}

// trimSign drops a leading minus so a stored negative movement can be handed
// to a paired builder, which takes a positive magnitude.
func trimSign(quantity string) string {
	if len(quantity) > 0 && quantity[0] == '-' {
		return quantity[1:]
	}
	return quantity
}
