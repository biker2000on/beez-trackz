package inventory

import (
	"fmt"
	"math/big"
	"strings"
	"time"

	"github.com/google/uuid"
)

// Tuple is the complete inventory balance key. Nil dimensions are meaningful
// and compare using SQL's IS NOT DISTINCT FROM semantics.
type Tuple struct {
	ItemID          uuid.UUID
	LocationID      uuid.UUID
	LotID           *uuid.UUID
	Condition       *string
	ContainerHiveID *uuid.UUID
}

func (t Tuple) String() string {
	condition := "-"
	if t.Condition != nil {
		condition = *t.Condition
	}
	return strings.Join([]string{
		t.ItemID.String(), t.LocationID.String(), uuidText(t.LotID), condition, uuidText(t.ContainerHiveID),
	}, "/")
}

// Movement is one immutable signed line. Quantity is a base-10 decimal
// string so callers never pass binary floating point into the ledger.
type Movement struct {
	ID       uuid.UUID
	Tuple    Tuple
	Quantity string
	// QuantityScale lets pure builders reject over-precision before a DB
	// lookup. Service.Record verifies it again against inventory_items.
	QuantityScale int
}

// Operation is the value produced by build and consumed by Service.Record.
type Operation struct {
	ID                  uuid.UUID
	Kind                string
	Reason              string
	OccurredAt          time.Time
	IdempotencyKey      string
	SourceType          string
	SourceID            uuid.UUID
	ReversesOperationID *uuid.UUID
	LegacyRefType       *string
	LegacyRefID         *uuid.UUID
	Details             map[string]any
	Provenance          string
	CreatedBy           *uuid.UUID
	Lines               []Movement
}

type Recorded struct {
	Operation Operation
	Existing  bool
}

type TupleQuantity struct {
	Tuple    Tuple
	Quantity string
}

type Filter struct {
	ItemID          *uuid.UUID
	LocationID      *uuid.UUID
	LotID           *uuid.UUID
	Condition       *string
	ContainerHiveID *uuid.UUID
}

type Balance struct {
	Tuple     Tuple
	OnHand    string
	Reserved  string
	Available string
}

type HistoryEntry struct {
	OperationID uuid.UUID
	Kind        string
	Reason      string
	OccurredAt  time.Time
	SourceType  string
	SourceID    uuid.UUID
	Quantity    string
}

// ParseQuantity accepts ordinary base-10 notation, rejects zero when
// requested, and enforces the caller-supplied number of fractional digits.
func ParseQuantity(value string, scale int, nonzero bool) (*big.Rat, error) {
	if scale < 0 || scale > 4 {
		return nil, fmt.Errorf("quantity scale %d is outside 0..4", scale)
	}
	value = strings.TrimSpace(value)
	if value == "" || strings.ContainsAny(value, "eE/") {
		return nil, fmt.Errorf("quantity %q is not a plain decimal", value)
	}
	unsigned := strings.TrimPrefix(strings.TrimPrefix(value, "+"), "-")
	parts := strings.Split(unsigned, ".")
	if len(parts) > 2 || parts[0] == "" {
		return nil, fmt.Errorf("quantity %q is not a plain decimal", value)
	}
	if len(parts) == 2 && len(parts[1]) > scale {
		return nil, fmt.Errorf("quantity %q has more than %d fractional digits", value, scale)
	}
	r, ok := new(big.Rat).SetString(value)
	if !ok {
		return nil, fmt.Errorf("quantity %q is not numeric", value)
	}
	if nonzero && r.Sign() == 0 {
		return nil, fmt.Errorf("quantity must not be zero")
	}
	return r, nil
}

func decimal(r *big.Rat) string {
	// Every ledger value has at most four decimal places, so this is exact.
	s := r.FloatString(4)
	s = strings.TrimRight(strings.TrimRight(s, "0"), ".")
	if s == "-0" || s == "" {
		return "0"
	}
	return s
}

func negate(value string) (string, error) {
	r, err := ParseQuantity(value, 4, true)
	if err != nil {
		return "", err
	}
	r.Neg(r)
	return decimal(r), nil
}
