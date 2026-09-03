package production

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"github.com/biker2000on/beez-trackz/backend/internal/app"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// Seeded singletons from migration 00050. They are constants rather than
// lookups because the migration writes them by literal id and the backfill
// depends on the same two rows.
var (
	// HoneyBulkItemID is the one bulk-honey item; pounds, lot-tracked.
	HoneyBulkItemID = uuid.MustParse("00000000-0000-0000-0000-000000000101")
	// PropolisItemID is raw propolis; grams, lot-tracked.
	PropolisItemID = uuid.MustParse("00000000-0000-0000-0000-000000000102")
)

// LegacyUnassignedCode names the lot that holds stock whose provenance the
// legacy tables never recorded. Post-reset nothing new lands in it.
const LegacyUnassignedCode = "legacy-unassigned"

// Scales: mass carries four decimals, counts none (decision 4).
const (
	MassScale  = 4
	CountScale = 0
)

// HomeLocationID resolves the one is_home inventory location.
func HomeLocationID(ctx context.Context, q app.Querier) (uuid.UUID, error) {
	var id uuid.UUID
	err := q.QueryRow(ctx, `SELECT id FROM inventory_locations WHERE is_home`).Scan(&id)
	if errors.Is(err, pgx.ErrNoRows) {
		return uuid.Nil, app.Precondition("resolve home location",
			"no inventory location is marked is_home")
	}
	return id, wrapDB("resolve home location", err)
}

// DeployedLocationID resolves the single virtual location deployed gear sits
// at (review A1). It is here rather than in app/equipment because the sales
// command consumes colony gear from it.
func DeployedLocationID(ctx context.Context, q app.Querier) (uuid.UUID, error) {
	var id uuid.UUID
	err := q.QueryRow(ctx, `SELECT id FROM inventory_locations WHERE kind='deployed'`).Scan(&id)
	if errors.Is(err, pgx.ErrNoRows) {
		return uuid.Nil, app.Precondition("resolve deployed location",
			"no virtual deployed inventory location exists")
	}
	return id, wrapDB("resolve deployed location", err)
}

// EnsureLocationForStockLocation accepts either an inventory location id or a
// Phase A stock-location id and returns the inventory location. New Phase B
// consignees are inventory_locations rows in their own right and therefore do
// not carry a legacy source pair.
//
// On a legacy-chain database (stock_locations still exists — Phase A, the
// pre-ledger rollback of runbook 6.5, and the test fixtures) a stock_locations
// row created after migration 00050 seeded the consignees has no twin yet, so
// the twin is created here from the legacy row, exactly as Phase A did.
func EnsureLocationForStockLocation(
	ctx context.Context, uow *app.UnitOfWork, stockLocationID uuid.UUID,
) (uuid.UUID, error) {
	const op = "resolve stock location"
	id, err := ResolveLocationID(ctx, uow, stockLocationID)
	if err == nil || !app.IsKind(err, app.KindNotFound) {
		return id, err
	}
	var legacyPresent bool
	if err := uow.QueryRow(ctx,
		`SELECT to_regclass('public.stock_locations') IS NOT NULL`).Scan(&legacyPresent); err != nil {
		return uuid.Nil, wrapDB(op, err)
	}
	if !legacyPresent {
		return uuid.Nil, app.NotFound(op, "stock location %s does not exist", stockLocationID)
	}
	var (
		name        string
		isHome      bool
		isConsign   bool
		priceBasis  string
		commission  *int
		priceListID *uuid.UUID
		cadence     string
		isActive    bool
	)
	err = uow.QueryRow(ctx,
		// legacy-chain-only
		`SELECT name, is_home, is_consignment, price_basis, commission_bps,
		       wholesale_price_list_id, settlement_cadence, is_active
		FROM stock_locations WHERE id=$1`, stockLocationID).
		Scan(&name, &isHome, &isConsign, &priceBasis, &commission, &priceListID,
			&cadence, &isActive)
	if errors.Is(err, pgx.ErrNoRows) {
		return uuid.Nil, app.NotFound(op, "stock location %s does not exist", stockLocationID)
	}
	if err != nil {
		return uuid.Nil, wrapDB(op, err)
	}
	if isHome {
		return HomeLocationID(ctx, uow)
	}
	kind := "storage_area"
	if isConsign {
		kind = "consignee"
	}
	err = uow.QueryRow(ctx, `
		INSERT INTO inventory_locations
			(kind, name, source_type, source_id, is_consignment, price_basis,
			 commission_bps, wholesale_price_list_id, settlement_cadence, is_active, created_by)
		VALUES ($1,$2,'stock_location',$3,$4,$5,$6,$7,$8,$9,$10)
		ON CONFLICT (source_type, source_id) DO UPDATE SET name=EXCLUDED.name
		RETURNING id`,
		kind, name, stockLocationID, isConsign, priceBasis, commission, priceListID,
		cadence, isActive, actorOrNil(uow)).Scan(&id)
	return id, wrapDB(op, err)
}

// ResolveLocationID is the read-side form of EnsureLocationForStockLocation.
// It accepts the same two identifier generations without requiring a unit of
// work, so HTTP list/detail readers can normalize path parameters too.
func ResolveLocationID(
	ctx context.Context, q app.Querier, stockLocationID uuid.UUID,
) (uuid.UUID, error) {
	const op = "resolve stock location"
	var id uuid.UUID
	err := q.QueryRow(ctx, `
		SELECT id FROM inventory_locations
		WHERE id=$1 OR (source_type='stock_location' AND source_id=$1)
		ORDER BY (id=$1) DESC
		LIMIT 1`, stockLocationID).Scan(&id)
	if errors.Is(err, pgx.ErrNoRows) {
		return uuid.Nil, app.NotFound(op, "stock location %s does not exist", stockLocationID)
	}
	return id, wrapDB(op, err)
}

// LocationForSale maps a sale's optional stock_location_id onto an inventory
// location; NULL has always meant home.
func LocationForSale(
	ctx context.Context, uow *app.UnitOfWork, stockLocationID *uuid.UUID,
) (uuid.UUID, error) {
	if stockLocationID == nil {
		return HomeLocationID(ctx, uow)
	}
	return EnsureLocationForStockLocation(ctx, uow, *stockLocationID)
}

// EnsureJarItem returns the inventory item for a jar size, creating it and
// stamping jar_sizes.item_id on first use. Idempotent: two concurrent callers
// converge on one row through the (source_type, source_id) unique index.
func EnsureJarItem(ctx context.Context, uow *app.UnitOfWork, jarSizeID uuid.UUID) (uuid.UUID, error) {
	const op = "resolve jar item"
	var (
		existing *uuid.UUID
		label    string
	)
	err := uow.QueryRow(ctx, `SELECT item_id, label FROM jar_sizes WHERE id=$1`, jarSizeID).
		Scan(&existing, &label)
	if errors.Is(err, pgx.ErrNoRows) {
		return uuid.Nil, app.NotFound(op, "jar size %s does not exist", jarSizeID)
	}
	if err != nil {
		return uuid.Nil, wrapDB(op, err)
	}
	if existing != nil {
		return *existing, nil
	}
	return ensureItem(ctx, uow, op, itemSpec{
		Kind: "jar", Name: label, Unit: "count", Scale: CountScale,
		LotTracked: true, SourceType: "jar_size", SourceID: jarSizeID,
		BackfillTable: "jar_sizes",
	})
}

// EnsureProductItem is EnsureJarItem for a catalog SKU.
func EnsureProductItem(ctx context.Context, uow *app.UnitOfWork, productID uuid.UUID) (uuid.UUID, error) {
	const op = "resolve product item"
	var (
		existing  *uuid.UUID
		name      string
		sizeLabel *string
	)
	err := uow.QueryRow(ctx,
		`SELECT item_id, name, size_label FROM product_catalog WHERE id=$1`, productID).
		Scan(&existing, &name, &sizeLabel)
	if errors.Is(err, pgx.ErrNoRows) {
		return uuid.Nil, app.NotFound(op, "product %s does not exist", productID)
	}
	if err != nil {
		return uuid.Nil, wrapDB(op, err)
	}
	if existing != nil {
		return *existing, nil
	}
	label := name
	if sizeLabel != nil && strings.TrimSpace(*sizeLabel) != "" {
		label = name + " - " + strings.TrimSpace(*sizeLabel)
	}
	return ensureItem(ctx, uow, op, itemSpec{
		Kind: "catalog_product", Name: label, Unit: "count", Scale: CountScale,
		LotTracked: true, SourceType: "product_catalog", SourceID: productID,
		BackfillTable: "product_catalog",
	})
}

// EnsureEquipmentItem is the equipment counterpart. Equipment is
// condition-tracked (serviceable / damaged / retired) and container-tracked,
// because gear deploys into a hive.
//
// app/equipment owns the equipment producers; this helper exists so a sale
// line can name an item without waiting for gear to be received first. Both
// packages converge on the same row through the source unique index.
func EnsureEquipmentItem(ctx context.Context, uow *app.UnitOfWork, typeID uuid.UUID) (uuid.UUID, error) {
	const op = "resolve equipment item"
	var (
		existing *uuid.UUID
		name     string
		category string
	)
	err := uow.QueryRow(ctx,
		`SELECT item_id, name, category::text FROM equipment_types WHERE id=$1`, typeID).
		Scan(&existing, &name, &category)
	if errors.Is(err, pgx.ErrNoRows) {
		return uuid.Nil, app.NotFound(op, "equipment type %s does not exist", typeID)
	}
	if err != nil {
		return uuid.Nil, wrapDB(op, err)
	}
	if existing != nil {
		return *existing, nil
	}
	kind := "equipment"
	if category == "packaging" {
		kind = "packaging"
	}
	return ensureItem(ctx, uow, op, itemSpec{
		Kind: kind, Name: name, Unit: "count", Scale: CountScale,
		ConditionTracked: true, ContainerTracked: true,
		SourceType: "equipment_type", SourceID: typeID,
		BackfillTable: "equipment_types",
	})
}

type itemSpec struct {
	Kind             string
	Name             string
	Unit             string
	Scale            int
	LotTracked       bool
	ConditionTracked bool
	ContainerTracked bool
	SourceType       string
	SourceID         uuid.UUID
	// BackfillTable is the catalog table whose item_id column is stamped.
	BackfillTable string
}

func ensureItem(ctx context.Context, uow *app.UnitOfWork, op string, spec itemSpec) (uuid.UUID, error) {
	var id uuid.UUID
	err := uow.QueryRow(ctx, `
		INSERT INTO inventory_items
			(kind, name, canonical_unit, quantity_scale, lot_tracked,
			 condition_tracked, container_tracked, source_type, source_id, created_by)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
		ON CONFLICT (source_type, source_id) DO UPDATE SET name=EXCLUDED.name
		RETURNING id`,
		spec.Kind, spec.Name, spec.Unit, spec.Scale, spec.LotTracked,
		spec.ConditionTracked, spec.ContainerTracked, spec.SourceType, spec.SourceID,
		actorOrNil(uow)).Scan(&id)
	if err != nil {
		return uuid.Nil, wrapDB(op, err)
	}
	if spec.BackfillTable != "" {
		if _, err := uow.Exec(ctx, fmt.Sprintf(
			`UPDATE %s SET item_id=$2 WHERE id=$1 AND item_id IS NULL`, spec.BackfillTable),
			spec.SourceID, id); err != nil {
			return uuid.Nil, wrapDB(op, err)
		}
	}
	return id, nil
}

// EnsureLot returns the lot with this code for this item, creating it when it
// is missing. Codes are unique per item, so the jar-size item and the bulk
// honey item can both carry a lot named after the same harvest lot.
func EnsureLot(
	ctx context.Context, uow *app.UnitOfWork,
	itemID uuid.UUID, code, sourceType string, sourceID *uuid.UUID, legacyUnassigned bool,
) (uuid.UUID, error) {
	const op = "resolve inventory lot"
	if itemID == uuid.Nil || strings.TrimSpace(code) == "" {
		return uuid.Nil, app.Invalid(op, "item and lot code are required")
	}
	var id uuid.UUID
	err := uow.QueryRow(ctx, `SELECT id FROM inventory_lots WHERE item_id=$1 AND code=$2`,
		itemID, code).Scan(&id)
	if err == nil {
		return id, nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return uuid.Nil, wrapDB(op, err)
	}
	var srcType *string
	if sourceType != "" && sourceID != nil {
		srcType = &sourceType
	} else {
		sourceID = nil
	}
	err = uow.QueryRow(ctx, `
		INSERT INTO inventory_lots (item_id, code, source_type, source_id, is_legacy_unassigned, created_by)
		VALUES ($1,$2,$3,$4,$5,$6)
		ON CONFLICT (item_id, code) DO UPDATE SET code=EXCLUDED.code
		RETURNING id`,
		itemID, code, srcType, sourceID, legacyUnassigned, actorOrNil(uow)).Scan(&id)
	return id, wrapDB(op, err)
}

// LegacyUnassignedLot is the per-item bucket for stock with no recorded
// provenance. Jar count corrections and give-aways of untraced jars land here.
func LegacyUnassignedLot(ctx context.Context, uow *app.UnitOfWork, itemID uuid.UUID) (uuid.UUID, error) {
	return EnsureLot(ctx, uow, itemID, LegacyUnassignedCode, "", nil, true)
}

// EnsureHarvestLot returns the bulk-honey lot behind a harvest_lots row and
// stamps harvest_lots.inventory_lot_id.
func EnsureHarvestLot(ctx context.Context, uow *app.UnitOfWork, harvestLotID uuid.UUID) (uuid.UUID, error) {
	const op = "resolve harvest lot"
	var (
		existing *uuid.UUID
		code     string
	)
	err := uow.QueryRow(ctx,
		`SELECT inventory_lot_id, lot_code FROM harvest_lots WHERE id=$1`, harvestLotID).
		Scan(&existing, &code)
	if errors.Is(err, pgx.ErrNoRows) {
		return uuid.Nil, app.NotFound(op, "harvest lot %s does not exist", harvestLotID)
	}
	if err != nil {
		return uuid.Nil, wrapDB(op, err)
	}
	if existing != nil {
		return *existing, nil
	}
	id, err := EnsureLot(ctx, uow, HoneyBulkItemID, code, "harvest_lot", &harvestLotID, false)
	if err != nil {
		return uuid.Nil, err
	}
	if _, err := uow.Exec(ctx,
		`UPDATE harvest_lots SET inventory_lot_id=$2 WHERE id=$1 AND inventory_lot_id IS NULL`,
		harvestLotID, id); err != nil {
		return uuid.Nil, wrapDB(op, err)
	}
	return id, nil
}

// EnsureJarLotForHarvestLot is the jar-side twin of a harvest lot: the jars a
// bottling run fills carry their harvest lot's code on the jar-size item, so
// "which lot is in this jar" is a balance rather than a join through runs.
func EnsureJarLotForHarvestLot(
	ctx context.Context, uow *app.UnitOfWork, jarItemID, harvestLotID uuid.UUID,
) (uuid.UUID, error) {
	const op = "resolve jar lot"
	var code string
	err := uow.QueryRow(ctx, `SELECT lot_code FROM harvest_lots WHERE id=$1`, harvestLotID).Scan(&code)
	if errors.Is(err, pgx.ErrNoRows) {
		return uuid.Nil, app.NotFound(op, "harvest lot %s does not exist", harvestLotID)
	}
	if err != nil {
		return uuid.Nil, wrapDB(op, err)
	}
	return EnsureLot(ctx, uow, jarItemID, code, "harvest_lot", &harvestLotID, false)
}

// EnsureBatchLot is the catalog-product lot a product batch outputs into, and
// stamps product_batches.inventory_lot_id.
func EnsureBatchLot(
	ctx context.Context, uow *app.UnitOfWork, productItemID, batchID uuid.UUID,
) (uuid.UUID, error) {
	const op = "resolve product batch lot"
	var existing *uuid.UUID
	err := uow.QueryRow(ctx, `SELECT inventory_lot_id FROM product_batches WHERE id=$1`, batchID).
		Scan(&existing)
	if errors.Is(err, pgx.ErrNoRows) {
		return uuid.Nil, app.NotFound(op, "product batch %s does not exist", batchID)
	}
	if err != nil {
		return uuid.Nil, wrapDB(op, err)
	}
	if existing != nil {
		return *existing, nil
	}
	id, err := EnsureLot(ctx, uow, productItemID, "batch-"+batchID.String(),
		"product_batch", &batchID, false)
	if err != nil {
		return uuid.Nil, err
	}
	if _, err := uow.Exec(ctx,
		`UPDATE product_batches SET inventory_lot_id=$2 WHERE id=$1 AND inventory_lot_id IS NULL`,
		batchID, id); err != nil {
		return uuid.Nil, wrapDB(op, err)
	}
	return id, nil
}

// EnsurePropolisLot is the raw-propolis lot behind one propolis harvest.
func EnsurePropolisLot(ctx context.Context, uow *app.UnitOfWork, harvestID uuid.UUID) (uuid.UUID, error) {
	return EnsureLot(ctx, uow, PropolisItemID, "propolis-"+harvestID.String(),
		"propolis_harvest", &harvestID, false)
}

func actorOrNil(uow *app.UnitOfWork) *uuid.UUID {
	if id := uow.Actor().AuditUserID(); id != uuid.Nil {
		return &id
	}
	return nil
}

func wrapDB(op string, err error) error {
	if err == nil {
		return nil
	}
	return app.Wrap(app.KindInternal, op, err)
}
