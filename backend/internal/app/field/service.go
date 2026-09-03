package field

import (
	"context"
	"fmt"
	"time"

	"github.com/biker2000on/beez-trackz/backend/internal/app"
	"github.com/biker2000on/beez-trackz/backend/internal/app/equipment"
	"github.com/google/uuid"
)

type EquipmentLine struct {
	Reference     uuid.UUID
	Quantity      int
	FrameIdentity string
}

// RecordColonyIntake receives only the physical equipment included with a
// package/nuc and immediately deploys it to the new hive. The colony itself is
// a hive domain record and never becomes an inventory item.
func RecordColonyIntake(ctx context.Context, uow *app.UnitOfWork, intakeID, hiveID uuid.UUID, occurredAt time.Time, lines []EquipmentLine) error {
	service := equipment.NewService()
	for i, line := range lines {
		prefix := fmt.Sprintf("colony-intake:%s:%d", intakeID, i)
		cmd := equipment.Command{Reference: line.Reference, Quantity: line.Quantity, OccurredAt: occurredAt, IdempotencyKey: prefix + ":receive", Reason: "colony_intake", FrameIdentity: line.FrameIdentity}
		if _, err := service.Receive(ctx, uow, cmd); err != nil {
			return err
		}
		if _, err := service.Deploy(ctx, uow, equipment.DeployCommand{Command: equipment.Command{Reference: line.Reference, Quantity: line.Quantity, OccurredAt: occurredAt, IdempotencyKey: prefix + ":deploy", Reason: "colony_intake", FrameIdentity: line.FrameIdentity}, HiveID: hiveID}); err != nil {
			return err
		}
	}
	return nil
}

// Deadout intentionally emits no movement: gear stays in the deployed tuple
// for the dead hive until an explicit return command is recorded.
func Deadout(context.Context, *app.UnitOfWork, uuid.UUID) error { return nil }
