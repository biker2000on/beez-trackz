package equipment

import (
	"context"
	"errors"
	"strconv"
	"strings"
	"time"

	"github.com/biker2000on/beez-trackz/backend/internal/app"
	"github.com/biker2000on/beez-trackz/backend/internal/app/inventory"
	"github.com/biker2000on/beez-trackz/backend/internal/app/inventory/build"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

type Service struct{ inventory *inventory.Service }

func NewService() *Service { return &Service{inventory: inventory.NewService()} }

type Command struct {
	Reference                                    uuid.UUID
	Quantity                                     int
	OccurredAt                                   time.Time
	IdempotencyKey, Reason, Notes, FrameIdentity string
	UnitCostCents                                *int
	LegacyRefType                                *string
	LegacyRefID                                  *uuid.UUID
	Provenance                                   string
}

type DeployCommand struct {
	Command
	HiveID uuid.UUID
}

type ConditionCommand struct {
	Command
	From, To        string
	LocationID      uuid.UUID
	ContainerHiveID *uuid.UUID
}

type AssemblyCommand struct {
	TypeID                uuid.UUID
	Quantity              int
	Disassemble           bool
	OccurredAt            time.Time
	IdempotencyKey, Notes string
	LegacyRefType         *string
	LegacyRefID           *uuid.UUID
	Provenance            string
}

func (s *Service) Receive(ctx context.Context, uow *app.UnitOfWork, c Command) (inventory.Recorded, error) {
	item, err := resolveCommandItem(ctx, uow, c)
	if err != nil {
		return inventory.Recorded{}, err
	}
	if c.Quantity <= 0 {
		return inventory.Recorded{}, app.Invalid("receive equipment", "quantity must be positive")
	}
	if c.UnitCostCents != nil {
		if *c.UnitCostCents < 0 {
			return inventory.Recorded{}, app.Invalid("receive equipment", "unit cost cannot be negative")
		}
		if _, err := uow.Exec(ctx, `UPDATE equipment_types SET unit_cost_cents=$2 WHERE id=$1`, item.TypeID, *c.UnitCostCents); err != nil {
			return inventory.Recorded{}, app.Internal("receive equipment", err)
		}
	}
	op, err := build.Receive(build.SingleParams{Base: base(uow, c, item.TypeID, "equipment_type"), Line: movement(item.ItemID, HomeLocation, "serviceable", nil, c.Quantity)})
	if err != nil {
		return inventory.Recorded{}, app.Invalid("receive equipment", "%v", err)
	}
	return s.inventory.Record(ctx, uow, op)
}

// OpeningBalance records legacy quantity that predates reconstructable
// equipment history. It is intentionally separate from Receive: the operation
// kind and details make the import-only residual visible to reconciliation.
func (s *Service) OpeningBalance(ctx context.Context, uow *app.UnitOfWork, c Command) (inventory.Recorded, error) {
	item, err := resolveCommandItem(ctx, uow, c)
	if err != nil {
		return inventory.Recorded{}, err
	}
	if c.Quantity <= 0 {
		return inventory.Recorded{}, app.Invalid("open equipment balance", "quantity must be positive")
	}
	b := base(uow, c, item.TypeID, "equipment_type")
	b.Reason = "none"
	delete(b.Details, "legacy_reason")
	b.Details["reason"] = "equipment-opening-residual"
	op, err := build.OpeningBalance(build.SingleParams{Base: b, Line: movement(item.ItemID, HomeLocation, "serviceable", nil, c.Quantity)})
	if err != nil {
		return inventory.Recorded{}, app.Invalid("open equipment balance", "%v", err)
	}
	return s.inventory.Record(ctx, uow, op)
}

// Adjust records an explicit count correction for positive deltas and a
// shrink for negative deltas. The selected condition is part of the tuple,
// so disposing damaged/retired units never routes through serviceable stock.
func (s *Service) Adjust(ctx context.Context, uow *app.UnitOfWork, c Command, condition string) (inventory.Recorded, error) {
	item, err := resolveCommandItem(ctx, uow, c)
	if err != nil {
		return inventory.Recorded{}, err
	}
	if c.Quantity == 0 {
		return inventory.Recorded{}, app.Invalid("adjust equipment", "quantity must be non-zero")
	}
	if condition == "" {
		condition = "serviceable"
	}
	if !validCondition(condition) {
		return inventory.Recorded{}, app.Invalid("adjust equipment", "invalid condition %q", condition)
	}
	line := movement(item.ItemID, HomeLocation, condition, nil, c.Quantity)
	b := base(uow, c, item.TypeID, "equipment_type")
	var op inventory.Operation
	if c.Quantity > 0 || normalizeReason(c.Reason) == "count" {
		b.Reason = "count"
		op, err = build.CountAdjust(build.SingleParams{Base: b, Line: line})
	} else {
		b.Reason = shrinkReason(c.Reason)
		op, err = build.Shrink(build.SingleParams{Base: b, Line: line})
	}
	if err != nil {
		return inventory.Recorded{}, app.Invalid("adjust equipment", "%v", err)
	}
	return s.inventory.Record(ctx, uow, op)
}

func (s *Service) ConditionChange(ctx context.Context, uow *app.UnitOfWork, c ConditionCommand) (inventory.Recorded, error) {
	item, err := resolveCommandItem(ctx, uow, c.Command)
	if err != nil {
		return inventory.Recorded{}, err
	}
	if c.Quantity <= 0 || !validCondition(c.From) || !validCondition(c.To) || c.From == c.To {
		return inventory.Recorded{}, app.Invalid("change equipment condition", "positive quantity and distinct valid conditions are required")
	}
	location := c.LocationID
	if location == uuid.Nil {
		location = HomeLocation
	}
	b := base(uow, c.Command, item.TypeID, "equipment_type")
	b.Reason = conditionReason(c.From, c.To)
	op, err := build.ConditionChange(build.ConditionChangeParams{Base: b,
		Tuple:         inventory.Tuple{ItemID: item.ItemID, LocationID: location, ContainerHiveID: c.ContainerHiveID},
		FromCondition: c.From, ToCondition: c.To, Quantity: strconv.Itoa(c.Quantity), QuantityScale: 0})
	if err != nil {
		return inventory.Recorded{}, app.Invalid("change equipment condition", "%v", err)
	}
	return s.inventory.Record(ctx, uow, op)
}

func (s *Service) Deploy(ctx context.Context, uow *app.UnitOfWork, c DeployCommand) (inventory.Recorded, error) {
	item, err := resolveCommandItem(ctx, uow, c.Command)
	if err != nil {
		return inventory.Recorded{}, err
	}
	if c.Quantity <= 0 || c.HiveID == uuid.Nil {
		return inventory.Recorded{}, app.Invalid("deploy equipment", "positive quantity and hive are required")
	}
	var exists bool
	if err := uow.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM hives WHERE id=$1)`, c.HiveID).Scan(&exists); err != nil {
		return inventory.Recorded{}, app.Internal("deploy equipment", err)
	}
	if !exists {
		return inventory.Recorded{}, app.NotFound("deploy equipment", "hive %s does not exist", c.HiveID)
	}
	toHive := c.HiveID
	b := base(uow, c.Command, c.HiveID, "hive")
	op, err := build.Deploy(build.TransferParams{Base: b,
		From:     inventory.Tuple{ItemID: item.ItemID, LocationID: HomeLocation, Condition: stringPtr("serviceable")},
		To:       inventory.Tuple{ItemID: item.ItemID, LocationID: DeployedLocation, Condition: stringPtr("serviceable"), ContainerHiveID: &toHive},
		Quantity: strconv.Itoa(c.Quantity), QuantityScale: 0})
	if err != nil {
		return inventory.Recorded{}, app.Invalid("deploy equipment", "%v", err)
	}
	return s.inventory.Record(ctx, uow, op)
}

func (s *Service) Return(ctx context.Context, uow *app.UnitOfWork, deploymentID uuid.UUID, quantity int, c Command) (inventory.Recorded, error) {
	const action = "return equipment"
	var itemID, hiveID uuid.UUID
	var deployedText string
	err := uow.QueryRow(ctx, `
		SELECT m.item_id,m.container_hive_id,m.quantity::text
		FROM inventory_operations o JOIN inventory_movements m ON m.operation_id=o.id
		WHERE o.id=$1 AND o.kind='deploy' AND m.quantity>0`, deploymentID).Scan(&itemID, &hiveID, &deployedText)
	if errors.Is(err, pgx.ErrNoRows) {
		return inventory.Recorded{}, app.NotFound(action, "deployment %s does not exist", deploymentID)
	}
	if err != nil {
		return inventory.Recorded{}, app.Internal(action, err)
	}
	var returned int
	if err := uow.QueryRow(ctx, `SELECT COALESCE(SUM(m.quantity),0)::int FROM inventory_operations o JOIN inventory_movements m ON m.operation_id=o.id WHERE o.kind='return' AND o.source_type='inventory_operation' AND o.source_id=$1 AND m.quantity>0`, deploymentID).Scan(&returned); err != nil {
		return inventory.Recorded{}, app.Internal(action, err)
	}
	deployed, err := strconv.Atoi(strings.Split(deployedText, ".")[0])
	if err != nil {
		return inventory.Recorded{}, app.Internal(action, err)
	}
	outstanding := deployed - returned
	if quantity == 0 {
		quantity = outstanding
	}
	if quantity <= 0 || quantity > outstanding {
		return inventory.Recorded{}, app.Precondition(action, "only %d remain deployed", outstanding)
	}
	c.Reference = itemID
	c.Quantity = quantity
	b := base(uow, c, deploymentID, "inventory_operation")
	op, err := build.Return(build.TransferParams{Base: b,
		From:     inventory.Tuple{ItemID: itemID, LocationID: DeployedLocation, Condition: stringPtr("serviceable"), ContainerHiveID: &hiveID},
		To:       inventory.Tuple{ItemID: itemID, LocationID: HomeLocation, Condition: stringPtr("serviceable")},
		Quantity: strconv.Itoa(quantity), QuantityScale: 0})
	if err != nil {
		return inventory.Recorded{}, app.Invalid(action, "%v", err)
	}
	return s.inventory.Record(ctx, uow, op)
}

func (s *Service) Assembly(ctx context.Context, uow *app.UnitOfWork, c AssemblyCommand) (inventory.Recorded, error) {
	const action = "assemble equipment"
	if c.Quantity <= 0 {
		return inventory.Recorded{}, app.Invalid(action, "quantity must be positive")
	}
	parent, err := EnsureItem(ctx, uow, c.TypeID, "")
	if err != nil {
		return inventory.Recorded{}, err
	}
	rows, err := uow.Query(ctx, `SELECT ct.id,x.quantity,ct.unit_cost_cents FROM equipment_type_components x JOIN equipment_types ct ON ct.id=x.component_type_id WHERE x.parent_type_id=$1 ORDER BY ct.id`, c.TypeID)
	if err != nil {
		return inventory.Recorded{}, app.Internal(action, err)
	}
	type componentRow struct {
		typeID uuid.UUID
		qty    int
		cost   *int
	}
	var componentRows []componentRow
	for rows.Next() {
		var row componentRow
		if err := rows.Scan(&row.typeID, &row.qty, &row.cost); err != nil {
			rows.Close()
			return inventory.Recorded{}, app.Internal(action, err)
		}
		componentRows = append(componentRows, row)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return inventory.Recorded{}, app.Internal(action, err)
	}
	type component struct {
		item Item
		qty  int
		cost *int
	}
	components := make([]component, 0, len(componentRows))
	for _, row := range componentRows {
		item, err := EnsureItem(ctx, uow, row.typeID, "")
		if err != nil {
			return inventory.Recorded{}, err
		}
		components = append(components, component{item: item, qty: row.qty, cost: row.cost})
	}
	if len(components) == 0 {
		return inventory.Recorded{}, app.Precondition(action, "equipment type has no BOM")
	}
	var inputs, outputs []inventory.Movement
	parentLine := movement(parent.ItemID, HomeLocation, "serviceable", nil, c.Quantity)
	if c.Disassemble {
		parentLine.Quantity = "-" + parentLine.Quantity
		inputs = append(inputs, parentLine)
	} else {
		outputs = append(outputs, parentLine)
	}
	for _, line := range components {
		m := movement(line.item.ItemID, HomeLocation, "serviceable", nil, line.qty*c.Quantity)
		if c.Disassemble {
			outputs = append(outputs, m)
		} else {
			m.Quantity = "-" + m.Quantity
			inputs = append(inputs, m)
		}
	}
	cmd := Command{OccurredAt: c.OccurredAt, IdempotencyKey: c.IdempotencyKey, Reason: "none", Notes: c.Notes, LegacyRefType: c.LegacyRefType, LegacyRefID: c.LegacyRefID, Provenance: c.Provenance}
	b := base(uow, cmd, c.TypeID, "equipment_type")
	var assembledCost *int
	if !c.Disassemble {
		total := 0
		for _, line := range components {
			if line.cost == nil {
				total = 0
				assembledCost = nil
				break
			}
			total += *line.cost * line.qty
			assembledCost = &total
		}
		if assembledCost != nil {
			b.Details["assembled_unit_cost_cents"] = *assembledCost
		}
	}
	op, err := build.Assembly(build.TransformParams{Base: b, Inputs: inputs, Outputs: outputs})
	if err != nil {
		return inventory.Recorded{}, app.Invalid(action, "%v", err)
	}
	// Catalog rows are domain state and must be written before Record takes
	// inventory tuple locks (the global lock order documented in inventory).
	if assembledCost != nil {
		if _, err := uow.Exec(ctx, `UPDATE equipment_types SET unit_cost_cents=$2 WHERE id=$1`, c.TypeID, *assembledCost); err != nil {
			return inventory.Recorded{}, app.Internal(action, err)
		}
	}
	return s.inventory.Record(ctx, uow, op)
}

func base(uow *app.UnitOfWork, c Command, sourceID uuid.UUID, sourceType string) build.Base {
	id := uuid.New()
	key := strings.TrimSpace(c.IdempotencyKey)
	if key == "" {
		key = id.String()
	}
	occurred := c.OccurredAt
	if occurred.IsZero() {
		occurred = time.Now().UTC()
	}
	details := map[string]any{}
	if c.Notes != "" {
		details["notes"] = c.Notes
	}
	if c.Reason != "" {
		details["legacy_reason"] = c.Reason
	}
	return build.Base{ID: id, OccurredAt: occurred, IdempotencyKey: key, SourceType: sourceType, SourceID: sourceID, Reason: "none", Actor: uow.Actor(), Details: details, Provenance: c.Provenance, LegacyRefType: c.LegacyRefType, LegacyRefID: c.LegacyRefID}
}

func movement(item, location uuid.UUID, condition string, container *uuid.UUID, quantity int) inventory.Movement {
	return inventory.Movement{Tuple: inventory.Tuple{ItemID: item, LocationID: location, Condition: stringPtr(condition), ContainerHiveID: container}, Quantity: strconv.Itoa(quantity), QuantityScale: 0}
}
func stringPtr(v string) *string      { return &v }
func validCondition(v string) bool    { return v == "serviceable" || v == "damaged" || v == "retired" }
func normalizeReason(v string) string { return strings.ToLower(strings.TrimSpace(v)) }
func shrinkReason(v string) string {
	switch normalizeReason(v) {
	case "gifted", "give_away":
		return "give_away"
	default:
		return "loss"
	}
}
func conditionReason(from, to string) string {
	if to == "damaged" {
		return "damage"
	}
	if to == "retired" {
		return "retire"
	}
	return "repair"
}

func resolveCommandItem(ctx context.Context, uow *app.UnitOfWork, c Command) (Item, error) {
	item, err := ResolveItem(ctx, uow, c.Reference)
	if err != nil {
		return Item{}, err
	}
	wanted := normalizeReason(c.FrameIdentity)
	if wanted != "" && item.Category == "frame" && item.FrameIdentity != wanted {
		return EnsureItem(ctx, uow, item.TypeID, wanted)
	}
	return item, nil
}

// InventoryService exposes read-model operations to domain-adjacent handlers.
func (s *Service) InventoryService() *inventory.Service { return s.inventory }
