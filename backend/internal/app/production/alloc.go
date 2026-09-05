package production

import (
	"context"
	"fmt"
	"math/big"
	"strconv"
	"strings"
	"time"

	"github.com/biker2000on/beez-trackz/backend/internal/app"
	"github.com/google/uuid"
)

// Allocation is one lot's share of a withdrawal.
type Allocation struct {
	LotID    uuid.UUID
	Quantity int
}

// AllocationMethod records how the lots were chosen, so an inferred
// provenance can never be reported as a recorded one (review A3).
const (
	// MethodRecorded means the caller named the lot (a bottling run, a batch).
	MethodRecorded = "recorded"
	// MethodFIFOInferred means the oldest receipt was assumed.
	MethodFIFOInferred = "fifo-inferred"
)

// LotBalance is one lot's on-hand at one location, oldest receipt first.
type LotBalance struct {
	LotID  uuid.UUID
	OnHand *big.Rat
}

// LotsFIFO lists the lots holding an item at a location, ordered by the
// timestamp of their first receipt there and then by id, so the ordering is
// total and two callers cannot disagree.
//
// relation is "inventory_balances" for a physical withdrawal and
// "inventory_available" when a reservation has to be respected (review OV1).
func LotsFIFO(
	ctx context.Context, q app.Querier, relation string, itemID, locationID uuid.UUID,
) ([]LotBalance, error) {
	const op = "list lots"
	column := "on_hand"
	if relation == "inventory_available" {
		column = "available"
	}
	rows, err := q.Query(ctx, fmt.Sprintf(`
		SELECT b.lot_id, b.%s::text
		FROM %s b
		WHERE b.item_id=$1 AND b.location_id=$2 AND b.lot_id IS NOT NULL AND b.%s > 0
		ORDER BY (
			SELECT MIN(o.occurred_at)
			FROM inventory_movements m
			JOIN inventory_operations o ON o.id = m.operation_id
			WHERE m.item_id = b.item_id AND m.location_id = b.location_id
			  AND m.lot_id = b.lot_id AND m.quantity > 0
		) NULLS LAST, b.lot_id`, column, relation, column), itemID, locationID)
	if err != nil {
		return nil, wrapDB(op, err)
	}
	defer rows.Close()
	out := make([]LotBalance, 0)
	for rows.Next() {
		var entry LotBalance
		var value string
		if err := rows.Scan(&entry.LotID, &value); err != nil {
			return nil, wrapDB(op, err)
		}
		parsed, ok := new(big.Rat).SetString(value)
		if !ok {
			return nil, app.Internal(op, fmt.Errorf("balance %q is not numeric", value))
		}
		entry.OnHand = parsed
		out = append(out, entry)
	}
	return out, wrapDB(op, rows.Err())
}

// AllocateFIFO spreads a whole-unit withdrawal across the lots standing at a
// location, oldest receipt first. It returns the allocation and the method to
// record on the operation.
//
// preferred, when set, is drawn from first: that is the bottling run's lot on
// a traced jar line, which is recorded provenance rather than an inference.
func AllocateFIFO(
	ctx context.Context, q app.Querier, relation string,
	itemID, locationID uuid.UUID, quantity int, preferred *uuid.UUID,
) ([]Allocation, string, error) {
	const op = "allocate lots"
	if quantity <= 0 {
		return nil, "", app.Invalid(op, "quantity must be greater than zero")
	}
	lots, err := LotsFIFO(ctx, q, relation, itemID, locationID)
	if err != nil {
		return nil, "", err
	}
	if preferred != nil {
		for i := range lots {
			if lots[i].LotID == *preferred {
				lots = append([]LotBalance{lots[i]}, append(lots[:i:i], lots[i+1:]...)...)
				break
			}
		}
	}
	remaining := quantity
	method := MethodRecorded
	allocations := make([]Allocation, 0, 2)
	for _, lot := range lots {
		if remaining == 0 {
			break
		}
		available := ratToWholeUnits(lot.OnHand)
		if available <= 0 {
			continue
		}
		take := available
		if take > remaining {
			take = remaining
		}
		if preferred == nil || lot.LotID != *preferred {
			method = MethodFIFOInferred
		}
		allocations = append(allocations, Allocation{LotID: lot.LotID, Quantity: take})
		remaining -= take
	}
	if remaining > 0 {
		return nil, "", app.Precondition(op,
			"only %d of %d units are on hand", quantity-remaining, quantity)
	}
	return allocations, method, nil
}

// AllocateLot draws a whole-unit withdrawal from exactly one lot: the one the
// operator pinned. Nothing spills to another lot — a pinned lot that is short
// is a refusal naming the lot code, so a consignment write can never quietly
// move a different varietal than the one asked for.
func AllocateLot(
	ctx context.Context, q app.Querier, relation string,
	itemID, locationID uuid.UUID, quantity int, lotID uuid.UUID,
) ([]Allocation, error) {
	const op = "allocate lot"
	if quantity <= 0 {
		return nil, app.Invalid(op, "quantity must be greater than zero")
	}
	lots, err := LotsFIFO(ctx, q, relation, itemID, locationID)
	if err != nil {
		return nil, err
	}
	available := 0
	for _, lot := range lots {
		if lot.LotID == lotID {
			available = ratToWholeUnits(lot.OnHand)
			break
		}
	}
	if available < quantity {
		return nil, app.Precondition(op, "lot %s has only %d of the %d units requested at this location",
			LotCode(ctx, q, lotID), available, quantity)
	}
	return []Allocation{{LotID: lotID, Quantity: quantity}}, nil
}

// LotCode is the operator-facing code of an inventory lot, falling back to
// the id when the lot cannot be read, so a refusal can always name it.
func LotCode(ctx context.Context, q app.Querier, lotID uuid.UUID) string {
	var code string
	if err := q.QueryRow(ctx, `SELECT code FROM inventory_lots WHERE id=$1`, lotID).Scan(&code); err != nil || code == "" {
		return lotID.String()
	}
	return code
}

// ratToWholeUnits floors a balance to whole units. Count items always store
// integers, so this only guards against a corrupted row.
func ratToWholeUnits(value *big.Rat) int {
	if value == nil || value.Sign() <= 0 {
		return 0
	}
	whole := new(big.Int).Quo(value.Num(), value.Denom())
	if !whole.IsInt64() {
		return 0
	}
	return int(whole.Int64())
}

// Quantity formats a count as the ledger's decimal string.
func Quantity(units int) string { return strconv.Itoa(units) }

// Pounds formats a measured weight at the mass scale. The ledger stores base
// 10 strings so no binary float ever reaches a numeric(14,4) column.
func Pounds(value float64) string {
	return strings.TrimRight(strings.TrimRight(strconv.FormatFloat(value, 'f', MassScale, 64), "0"), ".")
}

// Negate flips a ledger decimal's sign.
func Negate(value string) string {
	value = strings.TrimSpace(value)
	if strings.HasPrefix(value, "-") {
		return value[1:]
	}
	return "-" + value
}

// OccurredAt anchors an operation to the domain date the operator entered,
// at midnight UTC, which is how every dated row in this schema is stored.
func OccurredAt(date time.Time) time.Time { return date.UTC() }
