package inventory

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"math/big"
	"sort"
	"time"

	"github.com/biker2000on/beez-trackz/backend/internal/app"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

type Service struct{}

func NewService() *Service { return &Service{} }

type itemRules struct {
	scale            int
	lotTracked       bool
	conditionTracked bool
	containerTracked bool
}

// Record writes op inside uow after taking every affected tuple lock in the
// global order documented by this package.
func (s *Service) Record(ctx context.Context, uow *app.UnitOfWork, op Operation) (Recorded, error) {
	const action = "record inventory operation"
	if uow == nil || !uow.Actor().Valid() {
		return Recorded{}, app.Forbidden(action, "an active unit of work with an actor is required")
	}
	if err := validateOperation(op); err != nil {
		return Recorded{}, app.Invalid(action, "%v", err)
	}
	if !sameOptionalUUID(op.CreatedBy, actorID(uow.Actor())) {
		return Recorded{}, app.Forbidden(action, "operation actor does not match the unit of work actor")
	}
	hash, err := payloadHash(op.Lines)
	if err != nil {
		return Recorded{}, app.Invalid(action, "%v", err)
	}
	if existing, found, err := loadByKey(ctx, uow, op.IdempotencyKey); err != nil {
		return Recorded{}, classifyDB(action, err)
	} else if found {
		return compareReplay(existing, hash)
	}

	deltas, err := aggregate(op.Lines)
	if err != nil {
		return Recorded{}, app.Invalid(action, "%v", err)
	}
	if err := lockTuples(ctx, uow, mapKeys(deltas)); err != nil {
		return Recorded{}, classifyDB(action, err)
	}
	// A replay may have committed while this transaction waited on a tuple.
	if existing, found, err := loadByKey(ctx, uow, op.IdempotencyKey); err != nil {
		return Recorded{}, classifyDB(action, err)
	} else if found {
		return compareReplay(existing, hash)
	}
	if err := s.checkResultingBalances(ctx, uow, op.Lines, deltas); err != nil {
		return Recorded{}, err
	}

	details := cloneMap(op.Details)
	details["_payload_hash"] = hash
	detailsJSON, err := json.Marshal(details)
	if err != nil {
		return Recorded{}, app.Invalid(action, "details are not JSON: %v", err)
	}
	var inserted uuid.UUID
	err = uow.QueryRow(ctx, `
		INSERT INTO inventory_operations
		  (id, kind, reason, occurred_at, idempotency_key, source_type, source_id,
		   reverses_operation_id, legacy_ref_type, legacy_ref_id, details, provenance, created_by)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
		ON CONFLICT (idempotency_key) DO NOTHING
		RETURNING id`,
		op.ID, op.Kind, op.Reason, op.OccurredAt, op.IdempotencyKey, op.SourceType, op.SourceID,
		op.ReversesOperationID, op.LegacyRefType, op.LegacyRefID, detailsJSON, op.Provenance, op.CreatedBy,
	).Scan(&inserted)
	if errors.Is(err, pgx.ErrNoRows) {
		existing, found, loadErr := loadByKey(ctx, uow, op.IdempotencyKey)
		if loadErr != nil {
			return Recorded{}, classifyDB(action, loadErr)
		}
		if !found {
			return Recorded{}, app.Internal(action, errors.New("idempotency conflict row disappeared"))
		}
		return compareReplay(existing, hash)
	}
	if err != nil {
		return Recorded{}, classifyDB(action, err)
	}
	for i, line := range op.Lines {
		id := line.ID
		if id == uuid.Nil {
			id = uuid.New()
		}
		if _, err := uow.Exec(ctx, `
			INSERT INTO inventory_movements
			  (id, operation_id, line_no, item_id, location_id, lot_id, condition,
			   container_hive_id, quantity, created_by)
			VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
			id, inserted, i+1, line.Tuple.ItemID, line.Tuple.LocationID, line.Tuple.LotID,
			line.Tuple.Condition, line.Tuple.ContainerHiveID, line.Quantity, op.CreatedBy); err != nil {
			return Recorded{}, classifyDB(action, err)
		}
	}
	op.Details = details
	return Recorded{Operation: op}, nil
}

func (s *Service) Reverse(ctx context.Context, uow *app.UnitOfWork, originalID uuid.UUID, key, reason string) (Recorded, error) {
	const action = "reverse inventory operation"
	if uow == nil || !uow.Actor().Valid() {
		return Recorded{}, app.Forbidden(action, "an active unit of work with an actor is required")
	}
	if originalID == uuid.Nil || key == "" || reason == "" {
		return Recorded{}, app.Invalid(action, "original id, idempotency key, and reason are required")
	}
	original, found, err := loadOperation(ctx, uow, originalID)
	if err != nil {
		return Recorded{}, classifyDB(action, err)
	}
	if !found {
		return Recorded{}, app.NotFound(action, "operation %s does not exist", originalID)
	}
	lines := make([]Movement, len(original.Lines))
	for i, line := range original.Lines {
		q, err := negate(line.Quantity)
		if err != nil {
			return Recorded{}, app.Internal(action, err)
		}
		lines[i] = line
		lines[i].ID = uuid.New()
		lines[i].Quantity = q
	}
	createdBy := actorID(uow.Actor())
	op := Operation{
		ID: uuid.New(), Kind: "reversal", Reason: reason, OccurredAt: time.Now().UTC(),
		IdempotencyKey: key, SourceType: "inventory_operation", SourceID: originalID,
		ReversesOperationID: &originalID, Provenance: "recorded", CreatedBy: createdBy, Lines: lines,
	}
	return s.Record(ctx, uow, op)
}

// CheckAvailable locks needs and verifies the reservation-aware projection.
func (s *Service) CheckAvailable(ctx context.Context, uow *app.UnitOfWork, needs []TupleQuantity) error {
	const action = "check inventory availability"
	if uow == nil || !uow.Actor().Valid() {
		return app.Forbidden(action, "an active unit of work with an actor is required")
	}
	aggregated := make(map[string]*tupleDelta)
	for _, need := range needs {
		q, err := ParseQuantity(need.Quantity, 4, true)
		if err != nil || q.Sign() <= 0 {
			return app.Invalid(action, "need for %s must be a positive decimal", need.Tuple)
		}
		key := need.Tuple.String()
		if aggregated[key] == nil {
			aggregated[key] = &tupleDelta{tuple: need.Tuple, quantity: new(big.Rat)}
		}
		aggregated[key].quantity.Add(aggregated[key].quantity, q)
	}
	if err := lockTuples(ctx, uow, mapKeys(aggregated)); err != nil {
		return classifyDB(action, err)
	}
	for _, entry := range aggregated {
		var available string
		err := uow.QueryRow(ctx, `
			SELECT COALESCE((SELECT available::text FROM inventory_available
			 WHERE item_id=$1 AND location_id=$2 AND lot_id IS NOT DISTINCT FROM $3
			   AND condition IS NOT DISTINCT FROM $4
			   AND container_hive_id IS NOT DISTINCT FROM $5), '0')`,
			entry.tuple.ItemID, entry.tuple.LocationID, entry.tuple.LotID,
			entry.tuple.Condition, entry.tuple.ContainerHiveID).Scan(&available)
		if err != nil {
			return classifyDB(action, err)
		}
		got, err := ParseQuantity(available, 4, false)
		if err != nil {
			return app.Internal(action, err)
		}
		if got.Cmp(entry.quantity) < 0 {
			return app.Precondition(action, "tuple %s has %s available; %s required",
				entry.tuple, decimal(got), decimal(entry.quantity))
		}
	}
	return nil
}

func validateOperation(op Operation) error {
	if op.ID == uuid.Nil || op.Kind == "" || op.Reason == "" || op.OccurredAt.IsZero() ||
		op.IdempotencyKey == "" || op.SourceType == "" || op.SourceID == uuid.Nil || len(op.Lines) == 0 {
		return errors.New("id, kind, reason, occurred_at, idempotency key, source, and lines are required")
	}
	if op.Provenance == "" {
		return errors.New("provenance is required")
	}
	for _, line := range op.Lines {
		if line.Tuple.ItemID == uuid.Nil || line.Tuple.LocationID == uuid.Nil {
			return errors.New("every line requires item and location")
		}
		if _, err := ParseQuantity(line.Quantity, 4, true); err != nil {
			return err
		}
	}
	switch op.Kind {
	case "transfer":
		groups := make(map[string]*big.Rat)
		for _, line := range op.Lines {
			key := transferIdentity(line.Tuple)
			if groups[key] == nil {
				groups[key] = new(big.Rat)
			}
			q, _ := ParseQuantity(line.Quantity, 4, true)
			groups[key].Add(groups[key], q)
		}
		for key, total := range groups {
			if total.Sign() != 0 {
				return fmt.Errorf("transfer does not net to zero for %s", key)
			}
		}
	case "transform":
		input, output := false, false
		for _, line := range op.Lines {
			q, _ := ParseQuantity(line.Quantity, 4, true)
			input = input || q.Sign() < 0
			output = output || q.Sign() > 0
		}
		if !input || !output {
			return errors.New("transform requires at least one input and one output")
		}
	}
	return nil
}

type tupleDelta struct {
	tuple    Tuple
	quantity *big.Rat
}

func aggregate(lines []Movement) (map[string]*tupleDelta, error) {
	result := make(map[string]*tupleDelta)
	for _, line := range lines {
		q, err := ParseQuantity(line.Quantity, 4, true)
		if err != nil {
			return nil, err
		}
		key := line.Tuple.String()
		if result[key] == nil {
			result[key] = &tupleDelta{tuple: line.Tuple, quantity: new(big.Rat)}
		}
		result[key].quantity.Add(result[key].quantity, q)
	}
	return result, nil
}

func (s *Service) checkResultingBalances(ctx context.Context, uow *app.UnitOfWork, lines []Movement, deltas map[string]*tupleDelta) error {
	const action = "record inventory operation"
	rules := make(map[uuid.UUID]itemRules)
	for _, line := range lines {
		rule, ok := rules[line.Tuple.ItemID]
		if !ok {
			err := uow.QueryRow(ctx, `SELECT quantity_scale, lot_tracked, condition_tracked, container_tracked
				FROM inventory_items WHERE id=$1`, line.Tuple.ItemID).
				Scan(&rule.scale, &rule.lotTracked, &rule.conditionTracked, &rule.containerTracked)
			if errors.Is(err, pgx.ErrNoRows) {
				return app.NotFound(action, "item %s does not exist", line.Tuple.ItemID)
			}
			if err != nil {
				return classifyDB(action, err)
			}
			rules[line.Tuple.ItemID] = rule
		}
		if _, err := ParseQuantity(line.Quantity, rule.scale, true); err != nil {
			return app.Invalid(action, "tuple %s: %v", line.Tuple, err)
		}
		if rule.lotTracked != (line.Tuple.LotID != nil) {
			return app.Invalid(action, "tuple %s does not match item's lot tracking", line.Tuple)
		}
		if rule.conditionTracked != (line.Tuple.Condition != nil) {
			return app.Invalid(action, "tuple %s does not match item's condition tracking", line.Tuple)
		}
		if !rule.containerTracked && line.Tuple.ContainerHiveID != nil {
			return app.Invalid(action, "tuple %s uses a container for an untracked item", line.Tuple)
		}
	}
	for _, delta := range deltas {
		if delta.quantity.Sign() == 0 {
			continue
		}
		var current string
		err := uow.QueryRow(ctx, `SELECT COALESCE((SELECT on_hand::text FROM inventory_balances
			WHERE item_id=$1 AND location_id=$2 AND lot_id IS NOT DISTINCT FROM $3
			AND condition IS NOT DISTINCT FROM $4 AND container_hive_id IS NOT DISTINCT FROM $5), '0')`,
			delta.tuple.ItemID, delta.tuple.LocationID, delta.tuple.LotID,
			delta.tuple.Condition, delta.tuple.ContainerHiveID).Scan(&current)
		if err != nil {
			return classifyDB(action, err)
		}
		balance, err := ParseQuantity(current, 4, false)
		if err != nil {
			return app.Internal(action, err)
		}
		balance.Add(balance, delta.quantity)
		minimum := new(big.Rat)
		if rules[delta.tuple.ItemID].scale > 0 {
			minimum.SetFrac64(-1, 10000)
		}
		if balance.Cmp(minimum) < 0 {
			return app.Precondition(action, "tuple %s would have negative balance %s", delta.tuple, decimal(balance))
		}
	}
	return nil
}

func payloadHash(lines []Movement) (string, error) {
	type canonical struct{ Item, Location, Lot, Condition, Container, Quantity string }
	values := make([]canonical, 0, len(lines))
	for _, line := range lines {
		q, err := ParseQuantity(line.Quantity, 4, true)
		if err != nil {
			return "", err
		}
		values = append(values, canonical{
			Item: line.Tuple.ItemID.String(), Location: line.Tuple.LocationID.String(),
			Lot: uuidText(line.Tuple.LotID), Condition: stringText(line.Tuple.Condition),
			Container: uuidText(line.Tuple.ContainerHiveID), Quantity: decimal(q),
		})
	}
	sort.Slice(values, func(i, j int) bool { return fmt.Sprint(values[i]) < fmt.Sprint(values[j]) })
	b, err := json.Marshal(values)
	if err != nil {
		return "", err
	}
	sum := sha256.Sum256(b)
	return hex.EncodeToString(sum[:]), nil
}

func compareReplay(existing Operation, hash string) (Recorded, error) {
	stored, _ := existing.Details["_payload_hash"].(string)
	if stored != hash {
		return Recorded{}, app.Conflict("record inventory operation", "idempotency key %q is bound to a different payload", existing.IdempotencyKey)
	}
	return Recorded{Operation: existing, Existing: true}, nil
}

func loadByKey(ctx context.Context, q app.Querier, key string) (Operation, bool, error) {
	var id uuid.UUID
	err := q.QueryRow(ctx, `SELECT id FROM inventory_operations WHERE idempotency_key=$1`, key).Scan(&id)
	if errors.Is(err, pgx.ErrNoRows) {
		return Operation{}, false, nil
	}
	if err != nil {
		return Operation{}, false, err
	}
	return loadOperation(ctx, q, id)
}

func loadOperation(ctx context.Context, q app.Querier, id uuid.UUID) (Operation, bool, error) {
	var op Operation
	var details []byte
	err := q.QueryRow(ctx, `SELECT id,kind,reason,occurred_at,idempotency_key,source_type,source_id,
		reverses_operation_id,legacy_ref_type,legacy_ref_id,details,provenance,created_by
		FROM inventory_operations WHERE id=$1`, id).Scan(
		&op.ID, &op.Kind, &op.Reason, &op.OccurredAt, &op.IdempotencyKey, &op.SourceType, &op.SourceID,
		&op.ReversesOperationID, &op.LegacyRefType, &op.LegacyRefID, &details, &op.Provenance, &op.CreatedBy)
	if errors.Is(err, pgx.ErrNoRows) {
		return Operation{}, false, nil
	}
	if err != nil {
		return Operation{}, false, err
	}
	if err := json.Unmarshal(details, &op.Details); err != nil {
		return Operation{}, false, err
	}
	rows, err := q.Query(ctx, `SELECT m.id,m.item_id,m.location_id,m.lot_id,m.condition,m.container_hive_id,
		m.quantity::text,i.quantity_scale FROM inventory_movements m JOIN inventory_items i ON i.id=m.item_id
		WHERE m.operation_id=$1 ORDER BY m.line_no`, id)
	if err != nil {
		return Operation{}, false, err
	}
	defer rows.Close()
	for rows.Next() {
		var line Movement
		if err := rows.Scan(&line.ID, &line.Tuple.ItemID, &line.Tuple.LocationID, &line.Tuple.LotID,
			&line.Tuple.Condition, &line.Tuple.ContainerHiveID, &line.Quantity, &line.QuantityScale); err != nil {
			return Operation{}, false, err
		}
		op.Lines = append(op.Lines, line)
	}
	return op, true, rows.Err()
}

type lockKey struct {
	hash int64
	text string
}

func lockTuples(ctx context.Context, q app.Querier, tuples []Tuple) error {
	locks := make([]lockKey, 0, len(tuples))
	seen := make(map[string]bool)
	for _, tuple := range tuples {
		text := tuple.String()
		if seen[text] {
			continue
		}
		seen[text] = true
		var hash int64
		if err := q.QueryRow(ctx, `SELECT hashtext($1)::bigint`, text).Scan(&hash); err != nil {
			return err
		}
		locks = append(locks, lockKey{hash: hash, text: text})
	}
	sort.Slice(locks, func(i, j int) bool {
		if locks[i].hash == locks[j].hash {
			return locks[i].text < locks[j].text
		}
		return locks[i].hash < locks[j].hash
	})
	var previous *int64
	for _, lock := range locks {
		if previous != nil && *previous == lock.hash {
			continue
		}
		if _, err := q.Exec(ctx, `SELECT pg_advisory_xact_lock($1)`, lock.hash); err != nil {
			return err
		}
		h := lock.hash
		previous = &h
	}
	return nil
}

func mapKeys(values map[string]*tupleDelta) []Tuple {
	result := make([]Tuple, 0, len(values))
	for _, value := range values {
		result = append(result, value.tuple)
	}
	return result
}

func transferIdentity(t Tuple) string {
	return t.ItemID.String() + "/" + uuidText(t.LotID) + "/" + stringText(t.Condition) + "/" + uuidText(t.ContainerHiveID)
}
func uuidText(v *uuid.UUID) string {
	if v == nil {
		return "-"
	}
	return v.String()
}
func stringText(v *string) string {
	if v == nil {
		return "-"
	}
	return *v
}
func cloneMap(in map[string]any) map[string]any {
	out := make(map[string]any, len(in)+1)
	for k, v := range in {
		out[k] = v
	}
	return out
}
func actorID(a app.Actor) *uuid.UUID {
	id := a.AuditUserID()
	if id == uuid.Nil {
		return nil
	}
	return &id
}
func sameOptionalUUID(a, b *uuid.UUID) bool {
	return a == nil && b == nil || a != nil && b != nil && *a == *b
}

func classifyDB(action string, err error) error {
	if err == nil {
		return nil
	}
	var pgErr *pgconn.PgError
	if !errors.As(err, &pgErr) {
		return app.Internal(action, err)
	}
	message := pgErr.Message
	if pgErr.Detail != "" {
		message += ": " + pgErr.Detail
	}
	switch pgErr.Code {
	case "23505":
		return &app.Error{Kind: app.KindConflict, Op: action, Field: pgErr.ConstraintName, Message: message, Err: err}
	case "23503":
		return &app.Error{Kind: app.KindNotFound, Op: action, Field: pgErr.ConstraintName, Message: message, Err: err}
	case "23514", "23502":
		return &app.Error{Kind: app.KindInvalid, Op: action, Field: pgErr.ConstraintName, Message: message, Err: err}
	case "P0001":
		return &app.Error{Kind: app.KindPrecondition, Op: action, Field: pgErr.ConstraintName, Message: message, Err: err}
	default:
		return app.Internal(action, err)
	}
}
