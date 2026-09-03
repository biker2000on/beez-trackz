package equipment

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"github.com/biker2000on/beez-trackz/backend/internal/app"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

const (
	HomeLocationID     = "00000000-0000-0000-0000-000000000201"
	DeployedLocationID = "00000000-0000-0000-0000-000000000202"
)

var (
	HomeLocation     = uuid.MustParse(HomeLocationID)
	DeployedLocation = uuid.MustParse(DeployedLocationID)
)

// Item is the ledger identity behind an equipment catalog row. LegacyStockID
// is populated while the Phase-A compatibility tables remain in place.
type Item struct {
	ItemID, TypeID uuid.UUID
	LegacyStockID  *uuid.UUID
	Name, Category string
	FrameIdentity  string
	UnitCostCents  *int
}

// EnsureItem creates the inventory identity for a catalog row. Drawn and
// fresh frames deliberately use different source types so both can coexist
// despite inventory_items' (source_type,source_id) uniqueness constraint.
func EnsureItem(ctx context.Context, uow *app.UnitOfWork, typeID uuid.UUID, frameIdentity string) (Item, error) {
	const action = "ensure equipment inventory item"
	if uow == nil || !uow.Actor().Valid() {
		return Item{}, app.Forbidden(action, "an active unit of work with an actor is required")
	}
	var item Item
	item.TypeID = typeID
	if err := uow.QueryRow(ctx, `SELECT name,category,unit_cost_cents FROM equipment_types WHERE id=$1`, typeID).
		Scan(&item.Name, &item.Category, &item.UnitCostCents); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return Item{}, app.NotFound(action, "equipment type %s does not exist", typeID)
		}
		return Item{}, app.Internal(action, err)
	}
	frameIdentity = strings.ToLower(strings.TrimSpace(frameIdentity))
	if item.Category == "frame" {
		if frameIdentity == "" {
			frameIdentity = "fresh"
		}
		if frameIdentity != "drawn" && frameIdentity != "fresh" {
			return Item{}, app.Invalid(action, "frame identity must be drawn or fresh")
		}
		item.FrameIdentity = frameIdentity
	}
	kind := "equipment"
	sourceType := "equipment_type"
	name := item.Name
	if item.Category == "packaging" {
		kind = "packaging"
	}
	if item.Category == "frame" {
		sourceType = "equipment_type_frame_" + frameIdentity
		name = fmt.Sprintf("%s, %s", item.Name, frameIdentity)
	}
	if err := uow.QueryRow(ctx, `
		INSERT INTO inventory_items
		  (kind,name,canonical_unit,quantity_scale,lot_tracked,condition_tracked,
		   container_tracked,source_type,source_id,created_by)
		VALUES ($1,$2,'count',0,false,true,true,$3,$4,$5)
		ON CONFLICT (source_type,source_id) DO UPDATE SET
		  name=EXCLUDED.name,kind=EXCLUDED.kind,is_active=true
		RETURNING id`, kind, name, sourceType, typeID, auditID(uow)).Scan(&item.ItemID); err != nil {
		return Item{}, app.Internal(action, err)
	}
	// The singular catalog link is the default identity. For frame catalogs it
	// remains the first identity created; both split identities are resolved by
	// source_type/source_id rather than overwriting this link back and forth.
	if _, err := uow.Exec(ctx, `UPDATE equipment_types SET item_id=COALESCE(item_id,$2) WHERE id=$1`, typeID, item.ItemID); err != nil {
		return Item{}, app.Internal(action, err)
	}
	return item, nil
}

// ResolveItem accepts the compatibility stock id, the catalog id, or the new
// inventory item id. This keeps the Phase-A HTTP shape stable while writers
// stop touching equipment_stock.
func ResolveItem(ctx context.Context, uow *app.UnitOfWork, ref uuid.UUID) (Item, error) {
	const action = "resolve equipment inventory item"
	var direct Item
	var sourceType string
	err := uow.QueryRow(ctx, `SELECT i.id,et.id,et.name,et.category,i.source_type,et.unit_cost_cents FROM inventory_items i JOIN equipment_types et ON et.id=i.source_id WHERE i.id=$1 AND i.source_type IN('equipment_type','equipment_type_frame_drawn','equipment_type_frame_fresh')`, ref).
		Scan(&direct.ItemID, &direct.TypeID, &direct.Name, &direct.Category, &sourceType, &direct.UnitCostCents)
	if err == nil {
		direct.FrameIdentity = strings.TrimPrefix(sourceType, "equipment_type_frame_")
		if direct.FrameIdentity == "equipment_type" {
			direct.FrameIdentity = ""
		}
		return direct, nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return Item{}, app.Internal(action, err)
	}
	var typeID uuid.UUID
	var frameIdentity *string
	var stockID *uuid.UUID
	err = uow.QueryRow(ctx, `
		SELECT et.id,es.id,es.frame_condition::text
		FROM equipment_types et
		LEFT JOIN equipment_stock es ON es.type_id=et.id
		LEFT JOIN inventory_items ii ON ii.source_id=et.id
		WHERE es.id=$1 OR et.id=$1 OR ii.id=$1
		ORDER BY CASE WHEN es.id=$1 THEN 0 WHEN ii.id=$1 THEN 1 ELSE 2 END
		LIMIT 1`, ref).Scan(&typeID, &stockID, &frameIdentity)
	if errors.Is(err, pgx.ErrNoRows) {
		return Item{}, app.NotFound(action, "equipment stock %s does not exist", ref)
	}
	if err != nil {
		return Item{}, app.Internal(action, err)
	}
	identity := ""
	if frameIdentity != nil {
		identity = *frameIdentity
	}
	item, err := EnsureItem(ctx, uow, typeID, identity)
	if err != nil {
		return Item{}, err
	}
	item.LegacyStockID = stockID
	return item, nil
}

func auditID(uow *app.UnitOfWork) *uuid.UUID {
	id := uow.Actor().AuditUserID()
	if id == uuid.Nil {
		return nil
	}
	return &id
}
