// Package build contains the pure, shared definitions of ledger operation
// shapes. It performs no I/O.
package build

import (
	"fmt"
	"math/big"
	"time"

	"github.com/biker2000on/beez-trackz/backend/internal/app"
	"github.com/biker2000on/beez-trackz/backend/internal/app/inventory"
	"github.com/google/uuid"
)

type Base struct {
	ID             uuid.UUID
	OccurredAt     time.Time
	IdempotencyKey string
	SourceType     string
	SourceID       uuid.UUID
	Reason         string
	Actor          app.Actor
	Details        map[string]any
	Provenance     string
	LegacyRefType  *string
	LegacyRefID    *uuid.UUID
}

type SingleParams struct {
	Base Base
	Line inventory.Movement
}

type TransferParams struct {
	Base          Base
	From, To      inventory.Tuple
	Quantity      string
	QuantityScale int
	FromLineID    uuid.UUID
	ToLineID      uuid.UUID
}

type TransformParams struct {
	Base            Base
	Inputs, Outputs []inventory.Movement
}

type ConditionChangeParams struct {
	Base                 Base
	Tuple                inventory.Tuple
	FromCondition        string
	ToCondition          string
	Quantity             string
	QuantityScale        int
	FromLineID, ToLineID uuid.UUID
}

func Receive(p SingleParams) (inventory.Operation, error) { return positive("receive", p) }
func OpeningBalance(p SingleParams) (inventory.Operation, error) {
	return positive("opening_balance", p)
}
func SaleReturn(p SingleParams) (inventory.Operation, error) { return positive("sale_return", p) }

func SaleConsume(p SingleParams) (inventory.Operation, error) { return negative("sale_consume", p) }
func Shrink(p SingleParams) (inventory.Operation, error)      { return negative("shrink", p) }

func CountAdjust(p SingleParams) (inventory.Operation, error) {
	if err := validateLine(p.Line); err != nil {
		return inventory.Operation{}, err
	}
	return operation(p.Base, "count_adjust", []inventory.Movement{p.Line})
}

func Transfer(p TransferParams) (inventory.Operation, error) { return paired("transfer", p, false) }
func Deploy(p TransferParams) (inventory.Operation, error)   { return paired("deploy", p, false) }
func Return(p TransferParams) (inventory.Operation, error)   { return paired("return", p, false) }

func Transform(p TransformParams) (inventory.Operation, error) {
	if len(p.Inputs) == 0 || len(p.Outputs) == 0 {
		return inventory.Operation{}, fmt.Errorf("transform requires at least one input and one output")
	}
	lines := make([]inventory.Movement, 0, len(p.Inputs)+len(p.Outputs))
	for _, line := range p.Inputs {
		r, err := validateLineRat(line)
		if err != nil {
			return inventory.Operation{}, err
		}
		if r.Sign() >= 0 {
			return inventory.Operation{}, fmt.Errorf("transform input quantity must be negative")
		}
		lines = append(lines, line)
	}
	for _, line := range p.Outputs {
		r, err := validateLineRat(line)
		if err != nil {
			return inventory.Operation{}, err
		}
		if r.Sign() <= 0 {
			return inventory.Operation{}, fmt.Errorf("transform output quantity must be positive")
		}
		lines = append(lines, line)
	}
	return operation(p.Base, "transform", lines)
}

func BottlingTransform(p TransformParams) (inventory.Operation, error) { return Transform(p) }
func BatchTransform(p TransformParams) (inventory.Operation, error)    { return Transform(p) }
func Assembly(p TransformParams) (inventory.Operation, error)          { return Transform(p) }

func ConditionChange(p ConditionChangeParams) (inventory.Operation, error) {
	if p.FromCondition == "" || p.ToCondition == "" || p.FromCondition == p.ToCondition {
		return inventory.Operation{}, fmt.Errorf("condition change requires two different conditions")
	}
	from, to := p.Tuple, p.Tuple
	from.Condition, to.Condition = &p.FromCondition, &p.ToCondition
	tp := TransferParams{Base: p.Base, From: from, To: to, Quantity: p.Quantity,
		QuantityScale: p.QuantityScale, FromLineID: p.FromLineID, ToLineID: p.ToLineID}
	return paired("condition_change", tp, true)
}

func Reversal(base Base, original inventory.Operation) (inventory.Operation, error) {
	if original.ID == uuid.Nil || len(original.Lines) == 0 {
		return inventory.Operation{}, fmt.Errorf("reversal requires a recorded operation with lines")
	}
	lines := make([]inventory.Movement, len(original.Lines))
	for i, source := range original.Lines {
		quantity, err := negate(source.Quantity)
		if err != nil {
			return inventory.Operation{}, err
		}
		lines[i] = source
		lines[i].ID = uuid.Nil
		lines[i].Quantity = quantity
	}
	op, err := operation(base, "reversal", lines)
	if err != nil {
		return inventory.Operation{}, err
	}
	op.ReversesOperationID = &original.ID
	return op, nil
}

func positive(kind string, p SingleParams) (inventory.Operation, error) {
	r, err := validateLineRat(p.Line)
	if err != nil {
		return inventory.Operation{}, err
	}
	if r.Sign() <= 0 {
		return inventory.Operation{}, fmt.Errorf("%s quantity must be positive", kind)
	}
	return operation(p.Base, kind, []inventory.Movement{p.Line})
}

func negative(kind string, p SingleParams) (inventory.Operation, error) {
	r, err := validateLineRat(p.Line)
	if err != nil {
		return inventory.Operation{}, err
	}
	if r.Sign() >= 0 {
		return inventory.Operation{}, fmt.Errorf("%s quantity must be negative", kind)
	}
	return operation(p.Base, kind, []inventory.Movement{p.Line})
}

func paired(kind string, p TransferParams, conditionChange bool) (inventory.Operation, error) {
	q, err := inventory.ParseQuantity(p.Quantity, p.QuantityScale, true)
	if err != nil {
		return inventory.Operation{}, err
	}
	if q.Sign() < 0 {
		return inventory.Operation{}, fmt.Errorf("%s quantity must be positive", kind)
	}
	amount := decimal(q)
	if p.From.ItemID != p.To.ItemID || !sameUUID(p.From.LotID, p.To.LotID) ||
		!sameString(p.From.Condition, p.To.Condition) && !conditionChange ||
		!sameUUID(p.From.ContainerHiveID, p.To.ContainerHiveID) && kind == "transfer" {
		return inventory.Operation{}, fmt.Errorf("%s endpoints do not carry the same stock identity", kind)
	}
	from := inventory.Movement{ID: p.FromLineID, Tuple: p.From, Quantity: "-" + amount, QuantityScale: p.QuantityScale}
	to := inventory.Movement{ID: p.ToLineID, Tuple: p.To, Quantity: amount, QuantityScale: p.QuantityScale}
	return operation(p.Base, kind, []inventory.Movement{from, to})
}

func operation(base Base, kind string, lines []inventory.Movement) (inventory.Operation, error) {
	if base.ID == uuid.Nil || base.OccurredAt.IsZero() || base.IdempotencyKey == "" ||
		base.SourceType == "" || base.SourceID == uuid.Nil || !base.Actor.Valid() {
		return inventory.Operation{}, fmt.Errorf("operation requires explicit id, timestamp, key, source, and actor")
	}
	reason := base.Reason
	if reason == "" {
		reason = "none"
	}
	provenance := base.Provenance
	if provenance == "" {
		provenance = "recorded"
	}
	var createdBy *uuid.UUID
	if id := base.Actor.AuditUserID(); id != uuid.Nil {
		createdBy = &id
	}
	return inventory.Operation{ID: base.ID, Kind: kind, Reason: reason,
		OccurredAt: base.OccurredAt, IdempotencyKey: base.IdempotencyKey,
		SourceType: base.SourceType, SourceID: base.SourceID, Details: base.Details,
		Provenance: provenance, CreatedBy: createdBy, Lines: lines,
		LegacyRefType: base.LegacyRefType, LegacyRefID: base.LegacyRefID}, nil
}

func validateLine(line inventory.Movement) error {
	_, err := validateLineRat(line)
	return err
}

func validateLineRat(line inventory.Movement) (*big.Rat, error) {
	if line.Tuple.ItemID == uuid.Nil || line.Tuple.LocationID == uuid.Nil {
		return nil, fmt.Errorf("movement requires item and location")
	}
	return inventory.ParseQuantity(line.Quantity, line.QuantityScale, true)
}

func sameUUID(a, b *uuid.UUID) bool {
	return a == nil && b == nil || a != nil && b != nil && *a == *b
}

func sameString(a, b *string) bool {
	return a == nil && b == nil || a != nil && b != nil && *a == *b
}

func negate(value string) (string, error) {
	r, err := inventory.ParseQuantity(value, 4, true)
	if err != nil {
		return "", err
	}
	r.Neg(r)
	return decimal(r), nil
}

func decimal(r *big.Rat) string {
	s := r.FloatString(4)
	for len(s) > 0 && s[len(s)-1] == '0' {
		s = s[:len(s)-1]
	}
	if len(s) > 0 && s[len(s)-1] == '.' {
		s = s[:len(s)-1]
	}
	return s
}
