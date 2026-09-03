package inventory

import (
	"context"
	"fmt"
	"strings"

	"github.com/biker2000on/beez-trackz/backend/internal/app"
	"github.com/google/uuid"
)

func (s *Service) Balances(ctx context.Context, q app.Querier, filter Filter) ([]Balance, error) {
	return readBalances(ctx, q, "inventory_balances", filter)
}

func (s *Service) Available(ctx context.Context, q app.Querier, filter Filter) ([]Balance, error) {
	return readBalances(ctx, q, "inventory_available", filter)
}

func readBalances(ctx context.Context, q app.Querier, relation string, filter Filter) ([]Balance, error) {
	where, args := filterSQL(filter)
	onHand := "on_hand::text"
	reserved, available := "'0'::text", "on_hand::text"
	if relation == "inventory_available" {
		reserved, available = "reserved::text", "available::text"
	}
	rows, err := q.Query(ctx, fmt.Sprintf(`SELECT item_id,location_id,lot_id,condition,container_hive_id,
		%s,%s,%s FROM %s%s ORDER BY item_id,location_id,lot_id,condition,container_hive_id`,
		onHand, reserved, available, relation, where), args...)
	if err != nil {
		return nil, classifyDB("read inventory balances", err)
	}
	defer rows.Close()
	var result []Balance
	for rows.Next() {
		var value Balance
		if err := rows.Scan(&value.Tuple.ItemID, &value.Tuple.LocationID, &value.Tuple.LotID,
			&value.Tuple.Condition, &value.Tuple.ContainerHiveID, &value.OnHand, &value.Reserved, &value.Available); err != nil {
			return nil, classifyDB("read inventory balances", err)
		}
		result = append(result, value)
	}
	return result, classifyDB("read inventory balances", rows.Err())
}

func (s *Service) History(ctx context.Context, q app.Querier, tuple Tuple) ([]HistoryEntry, error) {
	return readHistory(ctx, q, `m.item_id=$1 AND m.location_id=$2
		AND m.lot_id IS NOT DISTINCT FROM $3 AND m.condition IS NOT DISTINCT FROM $4
		AND m.container_hive_id IS NOT DISTINCT FROM $5`,
		tuple.ItemID, tuple.LocationID, tuple.LotID, tuple.Condition, tuple.ContainerHiveID)
}

func (s *Service) LotLedger(ctx context.Context, q app.Querier, lotID uuid.UUID) ([]HistoryEntry, error) {
	return readHistory(ctx, q, `m.lot_id=$1`, lotID)
}

func readHistory(ctx context.Context, q app.Querier, where string, args ...any) ([]HistoryEntry, error) {
	rows, err := q.Query(ctx, `SELECT o.id,o.kind,o.reason,o.occurred_at,o.source_type,o.source_id,m.quantity::text
		FROM inventory_movements m JOIN inventory_operations o ON o.id=m.operation_id
		WHERE `+where+` ORDER BY o.occurred_at DESC,o.id,m.line_no`, args...)
	if err != nil {
		return nil, classifyDB("read inventory history", err)
	}
	defer rows.Close()
	var result []HistoryEntry
	for rows.Next() {
		var entry HistoryEntry
		if err := rows.Scan(&entry.OperationID, &entry.Kind, &entry.Reason, &entry.OccurredAt,
			&entry.SourceType, &entry.SourceID, &entry.Quantity); err != nil {
			return nil, classifyDB("read inventory history", err)
		}
		result = append(result, entry)
	}
	return result, classifyDB("read inventory history", rows.Err())
}

func filterSQL(filter Filter) (string, []any) {
	var clauses []string
	var args []any
	add := func(column string, value any) {
		args = append(args, value)
		clauses = append(clauses, fmt.Sprintf("%s=$%d", column, len(args)))
	}
	if filter.ItemID != nil {
		add("item_id", *filter.ItemID)
	}
	if filter.LocationID != nil {
		add("location_id", *filter.LocationID)
	}
	if filter.LotID != nil {
		add("lot_id", *filter.LotID)
	}
	if filter.Condition != nil {
		add("condition", *filter.Condition)
	}
	if filter.ContainerHiveID != nil {
		add("container_hive_id", *filter.ContainerHiveID)
	}
	if len(clauses) == 0 {
		return "", nil
	}
	return " WHERE " + strings.Join(clauses, " AND "), args
}
