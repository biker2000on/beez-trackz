package httpapi

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"os"
	"sort"
	"strconv"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/biker2000on/beez-trackz/backend/internal/db"
)

// Equipment ledger integration tests. Every test runs inside a transaction
// that is rolled back, so they share one database without sharing state.
//
// Set TEST_DATABASE_URL to run them, e.g.
//
//	docker run -d --name beez-test-d -p 5444:5432 -e POSTGRES_DB=beez_test \
//	  -e POSTGRES_USER=beez -e POSTGRES_HOST_AUTH_METHOD=trust postgres:16-alpine
//	TEST_DATABASE_URL=postgres://beez@localhost:5444/beez_test?sslmode=disable go test ./...

var (
	equipTestPoolOnce sync.Once
	equipTestPool     *pgxpool.Pool
	equipTestPoolErr  error
)

func equipPool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	databaseURL := os.Getenv("TEST_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("TEST_DATABASE_URL is not configured")
	}
	equipTestPoolOnce.Do(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
		defer cancel()
		equipTestPool, equipTestPoolErr = db.Connect(ctx, databaseURL)
	})
	if equipTestPoolErr != nil {
		t.Fatalf("connect test database: %v", equipTestPoolErr)
	}
	return equipTestPool
}

// equipTx opens a transaction that is always rolled back.
func equipTx(t *testing.T) (context.Context, pgx.Tx) {
	t.Helper()
	pool := equipPool(t)
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	tx, err := pool.Begin(ctx)
	if err != nil {
		cancel()
		t.Fatalf("begin transaction: %v", err)
	}
	t.Cleanup(func() {
		_ = tx.Rollback(context.Background())
		cancel()
	})
	return ctx, tx
}

// --- fixtures ---

func equipFixtureType(t *testing.T, ctx context.Context, tx pgx.Tx, category string) uuid.UUID {
	t.Helper()
	var id uuid.UUID
	name := "Test " + category + " " + uuid.NewString()
	if err := tx.QueryRow(ctx, `
		INSERT INTO equipment_types (name, category) VALUES ($1, $2) RETURNING id`,
		name, category).Scan(&id); err != nil {
		t.Fatalf("insert equipment type: %v", err)
	}
	return id
}

// equipFixtureStock creates a stock row and books its opening count through
// the ledger, the only way quantities are allowed in.
func equipFixtureStock(
	t *testing.T, ctx context.Context, tx pgx.Tx, typeID uuid.UUID, opening int,
) uuid.UUID {
	t.Helper()
	var id uuid.UUID
	if err := tx.QueryRow(ctx, `
		INSERT INTO equipment_stock (type_id, total_owned) VALUES ($1, 0) RETURNING id`,
		typeID).Scan(&id); err != nil {
		t.Fatalf("insert equipment stock: %v", err)
	}
	if opening != 0 {
		if _, err := equipInsertAdjustment(ctx, tx, equipAdjustmentEntry{
			StockID: id, Quantity: opening, Reason: "purchased", Date: time.Now(),
		}); err != nil {
			t.Fatalf("book opening count: %v", err)
		}
	}
	return id
}

func equipFixtureHive(t *testing.T, ctx context.Context, tx pgx.Tx) uuid.UUID {
	t.Helper()
	var apiaryID, hiveID uuid.UUID
	if err := tx.QueryRow(ctx,
		`INSERT INTO apiaries (name) VALUES ($1) RETURNING id`,
		"Equipment test "+uuid.NewString()).Scan(&apiaryID); err != nil {
		t.Fatalf("insert apiary: %v", err)
	}
	if err := tx.QueryRow(ctx,
		`INSERT INTO hives (apiary_id, position_label) VALUES ($1, 'T1') RETURNING id`,
		apiaryID).Scan(&hiveID); err != nil {
		t.Fatalf("insert hive: %v", err)
	}
	return hiveID
}

func equipReadState(
	t *testing.T, ctx context.Context, tx pgx.Tx, stockID uuid.UUID,
) equipStockState {
	t.Helper()
	state, err := equipLockStock(ctx, tx, stockID)
	if err != nil {
		t.Fatalf("read stock state: %v", err)
	}
	return state
}

func equipStatusFor(t *testing.T, ctx context.Context, tx pgx.Tx, stockID uuid.UUID) (int, int) {
	t.Helper()
	var deployed, available int
	if err := tx.QueryRow(ctx,
		`SELECT deployed, available FROM equipment_stock_status WHERE stock_id = $1`,
		stockID).Scan(&deployed, &available); err != nil {
		t.Fatalf("read stock status view: %v", err)
	}
	return deployed, available
}

type equipDeployInput struct {
	StockID        uuid.UUID
	HiveID         uuid.UUID
	Quantity       int
	Notes          *string
	Date           time.Time
	CreatedBy      *uuid.UUID
	IdempotencyKey *string
}

// equipDeployTx retains the legacy deployment setup only for compatibility
// tests. Production deployment commands write the inventory ledger.
func equipDeployTx(ctx context.Context, tx pgx.Tx, in equipDeployInput) (uuid.UUID, bool, error) {
	state, err := equipLockStock(ctx, tx, in.StockID)
	if err != nil {
		return uuid.Nil, false, err
	}
	if id, found, err := equipLookupIdempotent(ctx, tx, "equipment_deployments", in.IdempotencyKey, "stock_id", in.StockID); err != nil {
		return uuid.Nil, false, err
	} else if found {
		return id, true, nil
	}
	if available := state.Available(); in.Quantity > available {
		return uuid.Nil, false, equipBadRequest("Not enough %s available: need %d, have %d", state.TypeName, in.Quantity, available)
	}
	var id uuid.UUID
	err = tx.QueryRow(ctx, `
		INSERT INTO equipment_deployments
			(stock_id,hive_id,quantity,date_deployed,notes,created_by,idempotency_key)
		VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
		in.StockID, in.HiveID, in.Quantity, in.Date, in.Notes, in.CreatedBy, in.IdempotencyKey).Scan(&id)
	if err != nil {
		if equipPgErrCode(err, "23503") {
			return uuid.Nil, false, equipBadRequest("invalid stockId or hiveId")
		}
		return uuid.Nil, false, err
	}
	return id, false, nil
}

func equipHTTPStatus(t *testing.T, err error) int {
	t.Helper()
	var known equipError
	if !errors.As(err, &known) {
		t.Fatalf("error is not an equipError: %v", err)
	}
	return known.status
}

// --- migration 00006: duplicate stock rows ---

// One equipment type used to be able to split across several stock rows, which
// made per-row availability meaningless. The migration merges them; this
// exercises the same maintenance function the migration calls.
func TestEquipmentMergeDuplicateStockRows(t *testing.T) {
	ctx, tx := equipTx(t)

	// The unique constraint the migration added is what normally makes
	// duplicates impossible, so recreate the pre-migration shape first.
	if _, err := tx.Exec(ctx,
		`ALTER TABLE equipment_stock DROP CONSTRAINT equipment_stock_type_id_key`); err != nil {
		t.Fatalf("drop unique constraint: %v", err)
	}

	typeID := equipFixtureType(t, ctx, tx, "box")
	keep := equipFixtureStock(t, ctx, tx, typeID, 10)
	dup := equipFixtureStock(t, ctx, tx, typeID, 4)
	if _, err := tx.Exec(ctx,
		`UPDATE equipment_stock SET storage_location = 'Barn' WHERE id = $1`, dup); err != nil {
		t.Fatalf("set duplicate location: %v", err)
	}

	hiveID := equipFixtureHive(t, ctx, tx)
	if _, _, err := equipDeployTx(ctx, tx, equipDeployInput{
		StockID: dup, HiveID: hiveID, Quantity: 3, Date: time.Now(),
	}); err != nil {
		t.Fatalf("deploy from duplicate row: %v", err)
	}

	var merged int
	if err := tx.QueryRow(ctx, `SELECT equipment_merge_duplicate_stock()`).Scan(&merged); err != nil {
		t.Fatalf("merge duplicates: %v", err)
	}
	if merged != 1 {
		t.Fatalf("merged %d rows, want 1", merged)
	}

	var remaining int
	if err := tx.QueryRow(ctx,
		`SELECT count(*) FROM equipment_stock WHERE type_id = $1`, typeID).Scan(&remaining); err != nil {
		t.Fatalf("count surviving rows: %v", err)
	}
	if remaining != 1 {
		t.Fatalf("%d stock rows survived, want 1", remaining)
	}

	state := equipReadState(t, ctx, tx, keep)
	if state.TotalOwned != 14 {
		t.Fatalf("merged totalOwned = %d, want 14 (quantities must be summed)", state.TotalOwned)
	}
	if state.Deployed != 3 {
		t.Fatalf("merged deployed = %d, want 3 (deployments must follow the merge)", state.Deployed)
	}
	if state.Available() != 11 {
		t.Fatalf("merged available = %d, want 11", state.Available())
	}

	// Adjustment history must survive the merge, not be collapsed into a total.
	var adjustments int
	if err := tx.QueryRow(ctx,
		`SELECT count(*) FROM equipment_stock_adjustments WHERE stock_id = $1`,
		keep).Scan(&adjustments); err != nil {
		t.Fatalf("count adjustments: %v", err)
	}
	if adjustments != 2 {
		t.Fatalf("%d adjustments on the surviving row, want both originals", adjustments)
	}
	var location *string
	if err := tx.QueryRow(ctx,
		`SELECT storage_location FROM equipment_stock WHERE id = $1`, keep).Scan(&location); err != nil {
		t.Fatalf("read merged location: %v", err)
	}
	if location == nil || *location != "Barn" {
		t.Fatalf("merged storage location = %v, want the duplicate's value to be kept", location)
	}
}

func TestEquipmentStockTypeIDIsUnique(t *testing.T) {
	ctx, tx := equipTx(t)
	typeID := equipFixtureType(t, ctx, tx, "cover")
	equipFixtureStock(t, ctx, tx, typeID, 1)

	_, err := tx.Exec(ctx,
		`INSERT INTO equipment_stock (type_id, total_owned) VALUES ($1, 0)`, typeID)
	if err == nil {
		t.Fatal("a second stock row for the same type was accepted")
	}
	if !equipPgErrCode(err, "23505") {
		t.Fatalf("duplicate stock row error = %v, want a unique violation", err)
	}
}

// --- total_owned reconciliation ---

func TestEquipmentTotalOwnedCannotDriftFromLedger(t *testing.T) {
	ctx, tx := equipTx(t)
	typeID := equipFixtureType(t, ctx, tx, "box")
	stockID := equipFixtureStock(t, ctx, tx, typeID, 6)

	// The old failure mode: application code moves the column on its own. Run
	// it inside a savepoint so the outer transaction survives the rejection.
	savepoint, err := tx.Begin(ctx)
	if err != nil {
		t.Fatalf("begin savepoint: %v", err)
	}
	if _, err := savepoint.Exec(ctx,
		`UPDATE equipment_stock SET total_owned = total_owned + 5 WHERE id = $1`,
		stockID); err == nil {
		t.Fatal("total_owned was allowed to drift away from the adjustment ledger")
	}
	if err := savepoint.Rollback(ctx); err != nil {
		t.Fatalf("rollback savepoint: %v", err)
	}

	var reconciled bool
	if err := tx.QueryRow(ctx,
		`SELECT reconciled FROM equipment_stock_reconciliation WHERE stock_id = $1`,
		stockID).Scan(&reconciled); err != nil {
		t.Fatalf("read reconciliation view: %v", err)
	}
	if !reconciled {
		t.Fatal("stock row did not reconcile with its ledger")
	}

	// The supported path moves the ledger, and the column follows.
	if _, err := equipAdjustTx(ctx, tx, equipParsedRequest{
		StockID: stockID, Quantity: 5, Reason: "purchased",
		Date: time.Now(), From: "serviceable",
	}); err != nil {
		t.Fatalf("receive stock: %v", err)
	}
	if state := equipReadState(t, ctx, tx, stockID); state.TotalOwned != 11 {
		t.Fatalf("totalOwned = %d, want 11", state.TotalOwned)
	}
}

// --- deployments and returns ---

func TestEquipmentDeployRejectsNegativeStock(t *testing.T) {
	ctx, tx := equipTx(t)
	typeID := equipFixtureType(t, ctx, tx, "box")
	stockID := equipFixtureStock(t, ctx, tx, typeID, 2)
	hiveID := equipFixtureHive(t, ctx, tx)

	_, _, err := equipDeployTx(ctx, tx, equipDeployInput{
		StockID: stockID, HiveID: hiveID, Quantity: 3, Date: time.Now(),
	})
	if err == nil {
		t.Fatal("deploying more than is available succeeded")
	}
	if status := equipHTTPStatus(t, err); status != 400 {
		t.Fatalf("status = %d, want 400: %v", status, err)
	}

	// Deploying exactly what is available is still allowed, and consumes it.
	if _, _, err := equipDeployTx(ctx, tx, equipDeployInput{
		StockID: stockID, HiveID: hiveID, Quantity: 2, Date: time.Now(),
	}); err != nil {
		t.Fatalf("deploying the full available quantity failed: %v", err)
	}
	if _, available := equipStatusFor(t, ctx, tx, stockID); available != 0 {
		t.Fatalf("available = %d, want 0", available)
	}
	if _, _, err := equipDeployTx(ctx, tx, equipDeployInput{
		StockID: stockID, HiveID: hiveID, Quantity: 1, Date: time.Now(),
	}); err == nil {
		t.Fatal("deploying with nothing available succeeded")
	}
}

func TestEquipmentAdjustRejectsNegativeStock(t *testing.T) {
	ctx, tx := equipTx(t)
	typeID := equipFixtureType(t, ctx, tx, "frame")
	stockID := equipFixtureStock(t, ctx, tx, typeID, 4)
	hiveID := equipFixtureHive(t, ctx, tx)
	if _, _, err := equipDeployTx(ctx, tx, equipDeployInput{
		StockID: stockID, HiveID: hiveID, Quantity: 3, Date: time.Now(),
	}); err != nil {
		t.Fatalf("deploy: %v", err)
	}

	// Only one is on the shelf, so removing two must fail even though
	// total_owned would stay positive.
	remove := equipParsedRequest{
		StockID: stockID, Quantity: -2, Reason: "discarded",
		Date: time.Now(), From: "serviceable",
	}
	if _, err := equipAdjustTx(ctx, tx, remove); err == nil {
		t.Fatal("an adjustment that drives available stock negative succeeded")
	} else if status := equipHTTPStatus(t, err); status != 400 {
		t.Fatalf("status = %d, want 400: %v", status, err)
	}

	remove.Quantity = -1
	if _, err := equipAdjustTx(ctx, tx, remove); err != nil {
		t.Fatalf("removing the last available unit failed: %v", err)
	}
	state := equipReadState(t, ctx, tx, stockID)
	if state.TotalOwned != 3 || state.Available() != 0 {
		t.Fatalf("owned=%d available=%d, want 3 and 0", state.TotalOwned, state.Available())
	}

	// Retired units can still leave the books through an explicit from state.
	retire := equipParsedRequest{
		StockID: stockID, Quantity: 1, Reason: "purchased", Date: time.Now(),
		From: "serviceable",
	}
	if _, err := equipAdjustTx(ctx, tx, retire); err != nil {
		t.Fatalf("receive one back: %v", err)
	}
	retireState := equipParsedRequest{
		StockID: stockID, Quantity: 1, Reason: "obsolete", Date: time.Now(),
		From: "serviceable",
	}
	if _, err := equipMoveState(ctx, tx, retireState, "retired"); err != nil {
		t.Fatalf("retire: %v", err)
	}
	dispose := equipParsedRequest{
		StockID: stockID, Quantity: -1, Reason: "discarded", Date: time.Now(),
		From: "retired",
	}
	if _, err := equipAdjustTx(ctx, tx, dispose); err != nil {
		t.Fatalf("dispose of a retired unit: %v", err)
	}
	final := equipReadState(t, ctx, tx, stockID)
	if final.Retired != 0 || final.TotalOwned != 3 {
		t.Fatalf("after disposal retired=%d owned=%d, want 0 and 3",
			final.Retired, final.TotalOwned)
	}
}

func TestEquipmentDoubleReturnIsRejected(t *testing.T) {
	ctx, tx := equipTx(t)
	typeID := equipFixtureType(t, ctx, tx, "box")
	stockID := equipFixtureStock(t, ctx, tx, typeID, 5)
	hiveID := equipFixtureHive(t, ctx, tx)

	deploymentID, _, err := equipDeployTx(ctx, tx, equipDeployInput{
		StockID: stockID, HiveID: hiveID, Quantity: 3, Date: time.Now(),
	})
	if err != nil {
		t.Fatalf("deploy: %v", err)
	}

	first, err := equipReturnTx(ctx, tx, equipReturnInput{
		DeploymentID: deploymentID, Reason: "season_end", Condition: "good",
		Date: time.Now(),
	})
	if err != nil {
		t.Fatalf("first return: %v", err)
	}
	if !first.FullyReturned || first.Quantity != 3 {
		t.Fatalf("first return = %+v, want all 3 returned", first)
	}

	var removedAt *time.Time
	if err := tx.QueryRow(ctx,
		`SELECT date_removed FROM equipment_deployments WHERE id = $1`,
		deploymentID).Scan(&removedAt); err != nil {
		t.Fatalf("read date_removed: %v", err)
	}
	if removedAt == nil {
		t.Fatal("date_removed was not set by a full return")
	}

	// The bug: a second call used to overwrite the first return date.
	_, err = equipReturnTx(ctx, tx, equipReturnInput{
		DeploymentID: deploymentID, Reason: "season_end", Condition: "good",
		Date: time.Now().Add(48 * time.Hour),
	})
	if err == nil {
		t.Fatal("a second return of the same deployment succeeded")
	}
	if status := equipHTTPStatus(t, err); status != 409 {
		t.Fatalf("second return status = %d, want 409: %v", status, err)
	}

	var after *time.Time
	if err := tx.QueryRow(ctx,
		`SELECT date_removed FROM equipment_deployments WHERE id = $1`,
		deploymentID).Scan(&after); err != nil {
		t.Fatalf("re-read date_removed: %v", err)
	}
	if after == nil || !after.Equal(*removedAt) {
		t.Fatalf("date_removed changed from %v to %v", removedAt, after)
	}
}

func TestEquipmentPartialReturnCapturesReasonAndCondition(t *testing.T) {
	ctx, tx := equipTx(t)
	typeID := equipFixtureType(t, ctx, tx, "box")
	stockID := equipFixtureStock(t, ctx, tx, typeID, 10)
	hiveID := equipFixtureHive(t, ctx, tx)

	deploymentID, _, err := equipDeployTx(ctx, tx, equipDeployInput{
		StockID: stockID, HiveID: hiveID, Quantity: 5, Date: time.Now(),
	})
	if err != nil {
		t.Fatalf("deploy: %v", err)
	}

	notes := "Wax moth damage"
	two := 2
	partial, err := equipReturnTx(ctx, tx, equipReturnInput{
		DeploymentID: deploymentID, Quantity: &two, Reason: "damaged",
		Condition: "damaged", Notes: &notes, Date: time.Now(),
	})
	if err != nil {
		t.Fatalf("partial return: %v", err)
	}
	if partial.FullyReturned {
		t.Fatal("a partial return closed the deployment")
	}
	if partial.Outstanding != 3 {
		t.Fatalf("outstanding = %d, want 3", partial.Outstanding)
	}

	var reason, condition string
	var storedNotes *string
	if err := tx.QueryRow(ctx, `
		SELECT reason, condition, notes FROM equipment_deployment_returns
		WHERE deployment_id = $1`, deploymentID).
		Scan(&reason, &condition, &storedNotes); err != nil {
		t.Fatalf("read return ledger: %v", err)
	}
	if reason != "damaged" || condition != "damaged" || storedNotes == nil || *storedNotes != notes {
		t.Fatalf("return recorded as reason=%q condition=%q notes=%v", reason, condition, storedNotes)
	}

	// Damaged units come back into a real damaged state, not into availability.
	state := equipReadState(t, ctx, tx, stockID)
	if state.Damaged != 2 {
		t.Fatalf("damaged = %d, want 2", state.Damaged)
	}
	if state.Deployed != 3 {
		t.Fatalf("deployed = %d, want 3", state.Deployed)
	}
	if state.Available() != 5 {
		t.Fatalf("available = %d, want 5 (10 owned − 3 deployed − 2 damaged)", state.Available())
	}

	// Over-returning the remainder is refused before anything is written.
	four := 4
	if _, err := equipReturnTx(ctx, tx, equipReturnInput{
		DeploymentID: deploymentID, Quantity: &four, Reason: "season_end",
		Condition: "good", Date: time.Now(),
	}); err == nil {
		t.Fatal("returning more than is still deployed succeeded")
	}

	rest, err := equipReturnTx(ctx, tx, equipReturnInput{
		DeploymentID: deploymentID, Reason: "season_end", Condition: "good",
		Date: time.Now(),
	})
	if err != nil {
		t.Fatalf("final return: %v", err)
	}
	if !rest.FullyReturned || rest.Quantity != 3 {
		t.Fatalf("final return = %+v, want the remaining 3", rest)
	}
	if _, err := equipReturnTx(ctx, tx, equipReturnInput{
		DeploymentID: deploymentID, Reason: "season_end", Condition: "good",
		Date: time.Now(),
	}); err == nil {
		t.Fatal("returning a closed deployment succeeded")
	}
}

// --- physical count ---

func TestEquipmentPhysicalCountRecordsSignedAdjustments(t *testing.T) {
	ctx, tx := equipTx(t)
	typeID := equipFixtureType(t, ctx, tx, "box")
	stockID := equipFixtureStock(t, ctx, tx, typeID, 10)
	hiveID := equipFixtureHive(t, ctx, tx)
	if _, _, err := equipDeployTx(ctx, tx, equipDeployInput{
		StockID: stockID, HiveID: hiveID, Quantity: 4, Date: time.Now(),
	}); err != nil {
		t.Fatalf("deploy: %v", err)
	}

	counted := 5 // one fewer on the shelf than the books claim
	id := stockID.String()
	results, lineErrors, err := equipPhysicalCountTx(ctx, tx, equipCountInput{
		Lines: []equipCountRequestLine{{StockID: &id, CountedQuantity: &counted}},
		Date:  time.Now(),
	})
	if err != nil {
		t.Fatalf("physical count: %v", err)
	}
	if len(lineErrors) != 0 {
		t.Fatalf("unexpected line errors: %+v", lineErrors)
	}
	if len(results) != 1 || results[0].Delta != -1 {
		t.Fatalf("count result = %+v, want a delta of -1", results)
	}

	var quantity int
	if err := tx.QueryRow(ctx, `
		SELECT quantity FROM equipment_stock_adjustments
		WHERE stock_id = $1 AND reason = 'physical_count'`, stockID).
		Scan(&quantity); err != nil {
		t.Fatalf("read the physical_count adjustment: %v", err)
	}
	if quantity != -1 {
		t.Fatalf("physical_count adjustment = %d, want -1", quantity)
	}

	state := equipReadState(t, ctx, tx, stockID)
	if state.TotalOwned != 9 || state.Available() != 5 {
		t.Fatalf("after count: owned=%d available=%d, want 9 and 5",
			state.TotalOwned, state.Available())
	}
}

// bulk-adjust used to skip rows it could not resolve without telling anyone.
func TestEquipmentPhysicalCountReportsUnresolvableLines(t *testing.T) {
	ctx, tx := equipTx(t)
	typeID := equipFixtureType(t, ctx, tx, "box")
	stockID := equipFixtureStock(t, ctx, tx, typeID, 8)

	good := 6
	bad := 3
	negative := -1
	missing := uuid.NewString()
	id := stockID.String()
	garbage := "not-a-uuid"

	results, lineErrors, err := equipPhysicalCountTx(ctx, tx, equipCountInput{
		Lines: []equipCountRequestLine{
			{StockID: &id, CountedQuantity: &good},
			{StockID: &missing, CountedQuantity: &bad},
			{StockID: &garbage, CountedQuantity: &bad},
			{StockID: &id, CountedQuantity: &bad},
			{CountedQuantity: &bad},
			{StockID: &id, CountedQuantity: &negative},
		},
		Date: time.Now(),
	})
	if err != nil {
		t.Fatalf("physical count: %v", err)
	}
	if results != nil {
		t.Fatalf("results returned alongside errors: %+v", results)
	}
	if len(lineErrors) != 5 {
		t.Fatalf("%d line errors, want 5: %+v", len(lineErrors), lineErrors)
	}
	for _, lineError := range lineErrors {
		if lineError.Message == "" {
			t.Fatalf("line %d has no message", lineError.Index)
		}
	}

	// Nothing may be applied when any line fails.
	state := equipReadState(t, ctx, tx, stockID)
	if state.TotalOwned != 8 {
		t.Fatalf("totalOwned = %d, want 8 (a rejected count must change nothing)",
			state.TotalOwned)
	}
}

// --- damaged / retired states and the loss report ---

func TestEquipmentDamageRetireAndLossReport(t *testing.T) {
	ctx, tx := equipTx(t)
	typeID := equipFixtureType(t, ctx, tx, "box")
	stockID := equipFixtureStock(t, ctx, tx, typeID, 12)
	if _, err := tx.Exec(ctx,
		`UPDATE equipment_stock SET unit_cost_cents = 2500 WHERE id = $1`, stockID); err != nil {
		t.Fatalf("set unit cost: %v", err)
	}

	base := equipParsedRequest{StockID: stockID, Date: time.Now(), From: "serviceable"}

	damage := base
	damage.Quantity = 3
	damage.Reason = "broken"
	if _, err := equipMoveState(ctx, tx, damage, "damaged"); err != nil {
		t.Fatalf("mark damaged: %v", err)
	}

	retire := base
	retire.Quantity = 2
	retire.Reason = "worn_out"
	if _, err := equipMoveState(ctx, tx, retire, "retired"); err != nil {
		t.Fatalf("retire: %v", err)
	}

	state := equipReadState(t, ctx, tx, stockID)
	if state.Damaged != 3 || state.Retired != 2 {
		t.Fatalf("damaged=%d retired=%d, want 3 and 2", state.Damaged, state.Retired)
	}
	if state.Available() != 7 {
		t.Fatalf("available = %d, want 7 (damaged and retired are not deployable)",
			state.Available())
	}

	// Repair returns units to service.
	repair := base
	repair.From = "damaged"
	repair.Quantity = 1
	repair.Reason = "repaired"
	if _, err := equipMoveState(ctx, tx, repair, "serviceable"); err != nil {
		t.Fatalf("repair: %v", err)
	}
	state = equipReadState(t, ctx, tx, stockID)
	if state.Damaged != 2 || state.Available() != 8 {
		t.Fatalf("after repair damaged=%d available=%d, want 2 and 8",
			state.Damaged, state.Available())
	}

	// Marking more damaged than is on the shelf is refused.
	tooMuch := base
	tooMuch.Quantity = 99
	tooMuch.Reason = "broken"
	if _, err := equipMoveState(ctx, tx, tooMuch, "damaged"); err == nil {
		t.Fatal("marking more units damaged than are available succeeded")
	}

	var damaged, retired, valueCents int
	if err := tx.QueryRow(ctx, `
		SELECT COALESCE(SUM(quantity) FILTER (WHERE kind = 'damaged'), 0)::int,
		       COALESCE(SUM(quantity) FILTER (WHERE kind = 'retired'), 0)::int,
		       COALESCE(SUM(value_cents), 0)::int
		FROM equipment_loss_events WHERE stock_id = $1`, stockID).
		Scan(&damaged, &retired, &valueCents); err != nil {
		t.Fatalf("read loss report view: %v", err)
	}
	if damaged != 3 || retired != 2 {
		t.Fatalf("loss report damaged=%d retired=%d, want 3 and 2", damaged, retired)
	}
	if valueCents != 5*2500 {
		t.Fatalf("loss value = %d cents, want %d", valueCents, 5*2500)
	}
}

func TestEquipmentReceiveIdempotencyKeyDoesNotDoubleApply(t *testing.T) {
	ctx, tx := equipTx(t)
	typeID := equipFixtureType(t, ctx, tx, "box")
	stockID := equipFixtureStock(t, ctx, tx, typeID, 4)
	key := "recv-" + uuid.NewString()

	entry := equipAdjustmentEntry{
		StockID: stockID, Quantity: 3, Reason: "purchased", Date: time.Now(),
		IdempotencyKey: &key,
	}
	replayed, err := equipInsertAdjustment(ctx, tx, entry)
	if err != nil || replayed {
		t.Fatalf("first receive: replayed=%v err=%v", replayed, err)
	}
	replayed, err = equipInsertAdjustment(ctx, tx, entry)
	if err != nil {
		t.Fatalf("second receive: %v", err)
	}
	if !replayed {
		t.Fatal("second receive with the same key was treated as a new write")
	}

	state := equipReadState(t, ctx, tx, stockID)
	if state.TotalOwned != 7 {
		t.Fatalf("totalOwned = %d, want 7 (4 opening + 3 once)", state.TotalOwned)
	}
	var rows int
	if err := tx.QueryRow(ctx, `
		SELECT COUNT(*) FROM equipment_stock_adjustments
		WHERE stock_id = $1 AND idempotency_key = $2`, stockID, key).Scan(&rows); err != nil {
		t.Fatalf("count keyed adjustments: %v", err)
	}
	if rows != 1 {
		t.Fatalf("keyed adjustments = %d, want 1", rows)
	}
}

func TestEquipmentDeployIdempotencyKeyReturnsExisting(t *testing.T) {
	ctx, tx := equipTx(t)
	typeID := equipFixtureType(t, ctx, tx, "box")
	stockID := equipFixtureStock(t, ctx, tx, typeID, 5)
	hiveID := equipFixtureHive(t, ctx, tx)
	key := "deploy-" + uuid.NewString()

	first, replayed, err := equipDeployTx(ctx, tx, equipDeployInput{
		StockID: stockID, HiveID: hiveID, Quantity: 2, Date: time.Now(),
		IdempotencyKey: &key,
	})
	if err != nil || replayed {
		t.Fatalf("first deploy: id=%s replayed=%v err=%v", first, replayed, err)
	}

	second, replayed, err := equipDeployTx(ctx, tx, equipDeployInput{
		StockID: stockID, HiveID: hiveID, Quantity: 2, Date: time.Now(),
		IdempotencyKey: &key,
	})
	if err != nil {
		t.Fatalf("second deploy: %v", err)
	}
	if !replayed {
		t.Fatal("second deploy with the same key was not marked replayed")
	}
	if second != first {
		t.Fatalf("replay id = %s, want existing %s", second, first)
	}

	deployed, available := equipStatusFor(t, ctx, tx, stockID)
	if deployed != 2 || available != 3 {
		t.Fatalf("deployed/available = %d/%d, want 2/3", deployed, available)
	}
}

func TestEquipmentAdjustIdempotencyKeyDoesNotDoubleApply(t *testing.T) {
	ctx, tx := equipTx(t)
	typeID := equipFixtureType(t, ctx, tx, "frame")
	stockID := equipFixtureStock(t, ctx, tx, typeID, 8)
	key := "adj-" + uuid.NewString()
	parsed := equipParsedRequest{
		StockID: stockID, Quantity: -3, Reason: "discarded",
		Date: time.Now(), From: "serviceable", IdempotencyKey: &key,
	}
	if _, err := equipAdjustTx(ctx, tx, parsed); err != nil {
		t.Fatalf("first adjust: %v", err)
	}
	if _, err := equipAdjustTx(ctx, tx, parsed); err != nil {
		t.Fatalf("second adjust: %v", err)
	}
	state := equipReadState(t, ctx, tx, stockID)
	if state.TotalOwned != 5 {
		t.Fatalf("totalOwned = %d, want 5", state.TotalOwned)
	}
}

func TestEquipmentStateChangeIdempotencyKeyDoesNotDoubleApply(t *testing.T) {
	ctx, tx := equipTx(t)
	typeID := equipFixtureType(t, ctx, tx, "box")
	stockID := equipFixtureStock(t, ctx, tx, typeID, 6)
	key := "dmg-" + uuid.NewString()
	parsed := equipParsedRequest{
		StockID: stockID, Quantity: 2, Reason: "broken",
		Date: time.Now(), From: "serviceable", IdempotencyKey: &key,
	}
	if _, err := equipMoveState(ctx, tx, parsed, "damaged"); err != nil {
		t.Fatalf("first damage: %v", err)
	}
	if _, err := equipMoveState(ctx, tx, parsed, "damaged"); err != nil {
		t.Fatalf("second damage: %v", err)
	}
	state := equipReadState(t, ctx, tx, stockID)
	if state.Damaged != 2 {
		t.Fatalf("damaged = %d, want 2", state.Damaged)
	}
}

func TestEquipmentReturnIdempotencyKeyDoesNotDoubleApply(t *testing.T) {
	ctx, tx := equipTx(t)
	typeID := equipFixtureType(t, ctx, tx, "box")
	stockID := equipFixtureStock(t, ctx, tx, typeID, 8)
	hiveID := equipFixtureHive(t, ctx, tx)
	deploymentID, _, err := equipDeployTx(ctx, tx, equipDeployInput{
		StockID: stockID, HiveID: hiveID, Quantity: 4, Date: time.Now(),
	})
	if err != nil {
		t.Fatalf("deploy: %v", err)
	}
	key := "ret-" + uuid.NewString()
	qty := 2
	first, err := equipReturnTx(ctx, tx, equipReturnInput{
		DeploymentID: deploymentID, Quantity: &qty, Reason: "season_end",
		Condition: "good", Date: time.Now(), IdempotencyKey: &key,
	})
	if err != nil {
		t.Fatalf("first return: %v", err)
	}
	second, err := equipReturnTx(ctx, tx, equipReturnInput{
		DeploymentID: deploymentID, Quantity: &qty, Reason: "season_end",
		Condition: "good", Date: time.Now(), IdempotencyKey: &key,
	})
	if err != nil {
		t.Fatalf("second return: %v", err)
	}
	if !second.Replayed {
		t.Fatal("second return with the same key was not marked replayed")
	}
	if second.ID != first.ID {
		t.Fatalf("replay id = %s, want existing %s", second.ID, first.ID)
	}
	if second.TotalReturned != 2 || second.Outstanding != 2 {
		t.Fatalf("replay total/outstanding = %d/%d, want 2/2",
			second.TotalReturned, second.Outstanding)
	}
}

func TestEquipmentPhysicalCountIdempotencyKeyDoesNotDoubleApply(t *testing.T) {
	ctx, tx := equipTx(t)
	typeID := equipFixtureType(t, ctx, tx, "box")
	stockID := equipFixtureStock(t, ctx, tx, typeID, 10)
	counted := 7
	id := stockID.String()
	key := "count-" + uuid.NewString()
	in := equipCountInput{
		Lines:          []equipCountRequestLine{{StockID: &id, CountedQuantity: &counted}},
		Date:           time.Now(),
		IdempotencyKey: &key,
	}
	if _, lineErrors, err := equipPhysicalCountTx(ctx, tx, in); err != nil || len(lineErrors) > 0 {
		t.Fatalf("first count: err=%v errors=%v", err, lineErrors)
	}
	if _, lineErrors, err := equipPhysicalCountTx(ctx, tx, in); err != nil || len(lineErrors) > 0 {
		t.Fatalf("second count: err=%v errors=%v", err, lineErrors)
	}
	state := equipReadState(t, ctx, tx, stockID)
	if state.TotalOwned != 7 {
		t.Fatalf("totalOwned = %d, want 7 (count applied once)", state.TotalOwned)
	}
	var rows int
	if err := tx.QueryRow(ctx, `
		SELECT COUNT(*) FROM equipment_stock_adjustments
		WHERE stock_id = $1 AND reason = 'physical_count'`, stockID).Scan(&rows); err != nil {
		t.Fatalf("count physical_count rows: %v", err)
	}
	if rows != 1 {
		t.Fatalf("physical_count adjustments = %d, want 1", rows)
	}
}

func TestEquipmentIdempotencyKeyDifferentTargetConflicts(t *testing.T) {
	ctx, tx := equipTx(t)
	typeA := equipFixtureType(t, ctx, tx, "box")
	typeB := equipFixtureType(t, ctx, tx, "frame")
	stockA := equipFixtureStock(t, ctx, tx, typeA, 8)
	stockB := equipFixtureStock(t, ctx, tx, typeB, 8)
	hiveID := equipFixtureHive(t, ctx, tx)

	t.Run("receive", func(t *testing.T) {
		key := "recv-cross-" + uuid.NewString()
		entryA := equipAdjustmentEntry{
			StockID: stockA, Quantity: 1, Reason: "purchased", Date: time.Now(),
			IdempotencyKey: &key,
		}
		if replayed, err := equipInsertAdjustment(ctx, tx, entryA); err != nil || replayed {
			t.Fatalf("first receive: replayed=%v err=%v", replayed, err)
		}
		entryB := entryA
		entryB.StockID = stockB
		_, err := equipInsertAdjustment(ctx, tx, entryB)
		if err == nil {
			t.Fatal("same key on a different stock succeeded")
		}
		if status := equipHTTPStatus(t, err); status != 409 {
			t.Fatalf("status = %d, want 409: %v", status, err)
		}
	})

	t.Run("adjust", func(t *testing.T) {
		key := "adj-cross-" + uuid.NewString()
		parsedA := equipParsedRequest{
			StockID: stockA, Quantity: -1, Reason: "discarded",
			Date: time.Now(), From: "serviceable", IdempotencyKey: &key,
		}
		if _, err := equipAdjustTx(ctx, tx, parsedA); err != nil {
			t.Fatalf("first adjust: %v", err)
		}
		parsedB := parsedA
		parsedB.StockID = stockB
		_, err := equipAdjustTx(ctx, tx, parsedB)
		if err == nil {
			t.Fatal("same key on a different stock succeeded")
		}
		if status := equipHTTPStatus(t, err); status != 409 {
			t.Fatalf("status = %d, want 409: %v", status, err)
		}
	})

	t.Run("state change", func(t *testing.T) {
		key := "dmg-cross-" + uuid.NewString()
		parsedA := equipParsedRequest{
			StockID: stockA, Quantity: 1, Reason: "broken",
			Date: time.Now(), From: "serviceable", IdempotencyKey: &key,
		}
		if _, err := equipMoveState(ctx, tx, parsedA, "damaged"); err != nil {
			t.Fatalf("first damage: %v", err)
		}
		parsedB := parsedA
		parsedB.StockID = stockB
		_, err := equipMoveState(ctx, tx, parsedB, "damaged")
		if err == nil {
			t.Fatal("same key on a different stock succeeded")
		}
		if status := equipHTTPStatus(t, err); status != 409 {
			t.Fatalf("status = %d, want 409: %v", status, err)
		}
	})

	t.Run("deploy", func(t *testing.T) {
		key := "deploy-cross-" + uuid.NewString()
		if _, replayed, err := equipDeployTx(ctx, tx, equipDeployInput{
			StockID: stockA, HiveID: hiveID, Quantity: 1, Date: time.Now(),
			IdempotencyKey: &key,
		}); err != nil || replayed {
			t.Fatalf("first deploy: replayed=%v err=%v", replayed, err)
		}
		_, _, err := equipDeployTx(ctx, tx, equipDeployInput{
			StockID: stockB, HiveID: hiveID, Quantity: 1, Date: time.Now(),
			IdempotencyKey: &key,
		})
		if err == nil {
			t.Fatal("same key on a different stock succeeded")
		}
		if status := equipHTTPStatus(t, err); status != 409 {
			t.Fatalf("status = %d, want 409: %v", status, err)
		}
	})

	t.Run("return", func(t *testing.T) {
		depA, _, err := equipDeployTx(ctx, tx, equipDeployInput{
			StockID: stockA, HiveID: hiveID, Quantity: 1, Date: time.Now(),
		})
		if err != nil {
			t.Fatalf("deploy A: %v", err)
		}
		depB, _, err := equipDeployTx(ctx, tx, equipDeployInput{
			StockID: stockB, HiveID: hiveID, Quantity: 1, Date: time.Now(),
		})
		if err != nil {
			t.Fatalf("deploy B: %v", err)
		}
		key := "ret-cross-" + uuid.NewString()
		qty := 1
		if _, err := equipReturnTx(ctx, tx, equipReturnInput{
			DeploymentID: depA, Quantity: &qty, Reason: "season_end",
			Condition: "good", Date: time.Now(), IdempotencyKey: &key,
		}); err != nil {
			t.Fatalf("first return: %v", err)
		}
		_, err = equipReturnTx(ctx, tx, equipReturnInput{
			DeploymentID: depB, Quantity: &qty, Reason: "season_end",
			Condition: "good", Date: time.Now(), IdempotencyKey: &key,
		})
		if err == nil {
			t.Fatal("same key on a different deployment succeeded")
		}
		if status := equipHTTPStatus(t, err); status != 409 {
			t.Fatalf("status = %d, want 409: %v", status, err)
		}
	})
}

// --- Phase A legacy scaffolding ---
//
// Everything below used to live in routes_equipment.go and
// routes_equipment_ledger.go. No endpoint reaches it any more: receive,
// adjust, damage/repair/retire, deploy, return, and physical count all run
// through app/equipment on the inventory ledger. What it still does is read
// and write the legacy quantity tables, which Phase B drops (spec section 8),
// so keeping it in the production files would leave readers of
// equipment_stock that a baseline database cannot serve (spec 12.1 open
// item 3).
//
// It stays here rather than being deleted because the tests in this file are
// the Phase A regression suite for those tables and their 00006 triggers, and
// those tables are still in place on every live database. The suite runs on
// the legacy chain only; the ledger endpoints are covered against a baseline
// database in routes_equipment_baseline_test.go.
// --- stock state (the one availability formula) ---

// equipStockState is a stock row plus everything derived from its ledgers.
type equipStockState struct {
	ID            uuid.UUID
	TypeID        uuid.UUID
	TypeName      string
	TotalOwned    int
	Damaged       int
	Retired       int
	Deployed      int
	UnitCostCents *int
}

// Available is the only definition of "ready to deploy" in the backend.
func (s equipStockState) Available() int {
	return s.TotalOwned - s.Damaged - s.Retired - s.Deployed
}

// equipLockStock takes a row lock on the stock row and reads its derived
// counts inside the caller's transaction. Callers that will consume stock must
// use this before validating, so a concurrent writer cannot spend the same
// units between the check and the insert.
func equipLockStock(ctx context.Context, tx pgx.Tx, stockID uuid.UUID) (equipStockState, error) {
	var state equipStockState
	err := tx.QueryRow(ctx, `
		SELECT es.id, es.type_id, et.name, es.total_owned, es.damaged_quantity,
		       es.retired_quantity, es.unit_cost_cents,
		       COALESCE((
		         SELECT SUM(d.quantity - d.quantity_returned)::int
		         FROM equipment_deployments d WHERE d.stock_id = es.id), 0)
		FROM equipment_stock es
		JOIN equipment_types et ON et.id = es.type_id
		WHERE es.id = $1
		FOR UPDATE OF es`, stockID).
		Scan(&state.ID, &state.TypeID, &state.TypeName, &state.TotalOwned,
			&state.Damaged, &state.Retired, &state.UnitCostCents, &state.Deployed)
	if errors.Is(err, pgx.ErrNoRows) {
		return state, equipFail(http.StatusNotFound, "stock not found")
	}
	return state, err
}

// --- ledger writes ---

type equipAdjustmentEntry struct {
	StockID        uuid.UUID
	Quantity       int
	Reason         string
	Notes          *string
	UnitCostCents  *int
	Date           time.Time
	CreatedBy      *uuid.UUID
	IdempotencyKey *string
}

// equipInsertAdjustment appends an ownership-ledger row. A duplicate
// idempotency key returns (true, nil) so the caller can surface the
// previously-created row instead of applying the quantity twice.
// Serialization is the stock row lock (FOR UPDATE), not a 23505 retry.
func equipInsertAdjustment(ctx context.Context, q inspectionQuerier, e equipAdjustmentEntry) (bool, error) {
	if _, found, err := equipLookupIdempotent(ctx, q, "equipment_stock_adjustments", e.IdempotencyKey, "stock_id", e.StockID); err != nil {
		return false, err
	} else if found {
		return true, nil
	}
	_, err := q.Exec(ctx, `
		INSERT INTO equipment_stock_adjustments
			(stock_id, quantity, reason, notes, unit_cost_cents, date, created_by,
			 idempotency_key)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
		e.StockID, e.Quantity, e.Reason, e.Notes, e.UnitCostCents, e.Date, e.CreatedBy,
		e.IdempotencyKey)
	return false, err
}

type equipStateEntry struct {
	StockID        uuid.UUID
	From           string
	To             string
	Quantity       int
	Reason         string
	Notes          *string
	UnitCostCents  *int
	Date           time.Time
	CreatedBy      *uuid.UUID
	IdempotencyKey *string
}

// Serialization is the stock row lock (FOR UPDATE), not a 23505 retry.
func equipInsertStateChange(ctx context.Context, q inspectionQuerier, e equipStateEntry) (bool, error) {
	if _, found, err := equipLookupIdempotent(ctx, q, "equipment_state_changes", e.IdempotencyKey, "stock_id", e.StockID); err != nil {
		return false, err
	} else if found {
		return true, nil
	}
	_, err := q.Exec(ctx, `
		INSERT INTO equipment_state_changes
			(stock_id, from_state, to_state, quantity, reason, notes,
			 unit_cost_cents, date, created_by, idempotency_key)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
		e.StockID, e.From, e.To, e.Quantity, e.Reason, e.Notes,
		e.UnitCostCents, e.Date, e.CreatedBy, e.IdempotencyKey)
	return false, err
}

// equipLookupIdempotent finds a previously-written ledger row by key bound
// to this target (stock_id or deployment_id). A key already used on a
// different resource is a 409, not a replay. Duplicate keys on the same
// target are serialized by the stock row lock (FOR UPDATE): the second
// writer waits, then this lookup finds the existing row. table and
// targetColumn are compile-time identifiers, never request input.
func equipLookupIdempotent(
	ctx context.Context,
	q inspectionQuerier,
	table string,
	key *string,
	targetColumn string,
	targetID uuid.UUID,
) (uuid.UUID, bool, error) {
	if key == nil {
		return uuid.Nil, false, nil
	}
	switch table {
	case "equipment_stock_adjustments", "equipment_state_changes",
		"equipment_deployments", "equipment_deployment_returns":
	default:
		return uuid.Nil, false, fmt.Errorf("invalid idempotency table")
	}
	if targetColumn != "stock_id" && targetColumn != "deployment_id" {
		return uuid.Nil, false, fmt.Errorf("invalid idempotency target")
	}
	var id uuid.UUID
	err := q.QueryRow(ctx,
		`SELECT id FROM `+table+` WHERE idempotency_key = $1 AND `+targetColumn+` = $2`,
		*key, targetID).Scan(&id)
	if err == nil {
		return id, true, nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return uuid.Nil, false, err
	}
	var other uuid.UUID
	err = q.QueryRow(ctx,
		`SELECT id FROM `+table+` WHERE idempotency_key = $1`, *key).Scan(&other)
	if errors.Is(err, pgx.ErrNoRows) {
		return uuid.Nil, false, nil
	}
	if err != nil {
		return uuid.Nil, false, err
	}
	return uuid.Nil, false, equipFail(http.StatusConflict,
		"idempotency key already used on a different resource")
}

// equipReturnInput is the validated form of a (possibly partial) return.
type equipReturnInput struct {
	DeploymentID uuid.UUID
	// Quantity nil means "everything still out".
	Quantity       *int
	Reason         string
	Condition      string
	Notes          *string
	Date           time.Time
	CreatedBy      *uuid.UUID
	SaleID         *uuid.UUID
	IdempotencyKey *string
}

type equipReturnResult struct {
	ID            uuid.UUID
	Quantity      int
	TotalReturned int
	Outstanding   int
	FullyReturned bool
	StockID       uuid.UUID
	DeployedTotal int
	Replayed      bool
}

// equipReturnTx returns equipment from a hive. The `date_removed IS NULL`
// guard is what makes a second return fail loudly instead of silently
// overwriting the first return date. Serialization of a replayed key is
// the stock row lock (FOR UPDATE), not a 23505 retry.
func equipReturnTx(ctx context.Context, tx pgx.Tx, in equipReturnInput) (equipReturnResult, error) {
	var result equipReturnResult

	// Lock the stock row first (and always in that order) so return and
	// deploy cannot deadlock against each other.
	var stockID uuid.UUID
	err := tx.QueryRow(ctx,
		`SELECT stock_id FROM equipment_deployments WHERE id = $1`, in.DeploymentID).
		Scan(&stockID)
	if errors.Is(err, pgx.ErrNoRows) {
		return result, equipFail(http.StatusNotFound, "deployment not found")
	}
	if err != nil {
		return result, err
	}
	if _, err := equipLockStock(ctx, tx, stockID); err != nil {
		return result, err
	}
	if existingID, found, err := equipLookupIdempotent(ctx, tx, "equipment_deployment_returns", in.IdempotencyKey, "deployment_id", in.DeploymentID); err != nil {
		return result, err
	} else if found {
		return equipLoadReturnResult(ctx, tx, existingID, true)
	}

	var deployed, returned int
	err = tx.QueryRow(ctx, `
		SELECT quantity, quantity_returned
		FROM equipment_deployments
		WHERE id = $1 AND date_removed IS NULL
		FOR UPDATE`, in.DeploymentID).Scan(&deployed, &returned)
	if errors.Is(err, pgx.ErrNoRows) {
		return result, equipFail(http.StatusConflict,
			"This deployment has already been returned")
	}
	if err != nil {
		return result, err
	}

	outstanding := deployed - returned
	quantity := outstanding
	if in.Quantity != nil {
		quantity = *in.Quantity
	}
	if quantity < 1 {
		return result, equipBadRequest("Quantity must be at least 1")
	}
	if quantity > outstanding {
		return result, equipBadRequest(
			"Only %d still deployed: cannot return %d", outstanding, quantity)
	}

	var returnID uuid.UUID
	err = tx.QueryRow(ctx, `
		INSERT INTO equipment_deployment_returns
			(deployment_id, quantity, reason, condition, notes, date, created_by,
			 sale_id, idempotency_key)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
		RETURNING id`,
		in.DeploymentID, quantity, in.Reason, in.Condition, in.Notes,
		in.Date, in.CreatedBy, in.SaleID, in.IdempotencyKey).Scan(&returnID)
	if err != nil {
		return result, err
	}

	total := returned + quantity
	full := total >= deployed
	tag, err := tx.Exec(ctx, `
		UPDATE equipment_deployments
		SET quantity_returned = $2,
		    date_removed = CASE WHEN $3 THEN $4::timestamptz ELSE NULL END
		WHERE id = $1 AND date_removed IS NULL`,
		in.DeploymentID, total, full, in.Date)
	if err != nil {
		return result, err
	}
	if tag.RowsAffected() == 0 {
		// Another transaction completed the return between our read and write.
		return result, equipFail(http.StatusConflict,
			"This deployment has already been returned")
	}

	// Equipment that came back broken or worn out does not silently rejoin the
	// serviceable pool: it lands in a real state with a quantity.
	//
	// The return row and this state-change row share the client key. Keys are
	// unique per table, so a later /damage or /repair that reuses the key
	// finds the state-change row and silently no-ops.
	if in.Condition == "damaged" || in.Condition == "retired" {
		if _, err := equipInsertStateChange(ctx, tx, equipStateEntry{
			StockID:        stockID,
			From:           "serviceable",
			To:             in.Condition,
			Quantity:       quantity,
			Reason:         "returned_damaged",
			Notes:          in.Notes,
			Date:           in.Date,
			CreatedBy:      in.CreatedBy,
			IdempotencyKey: in.IdempotencyKey,
		}); err != nil {
			return result, err
		}
	}

	result = equipReturnResult{
		ID:            returnID,
		Quantity:      quantity,
		TotalReturned: total,
		Outstanding:   deployed - total,
		FullyReturned: full,
		StockID:       stockID,
		DeployedTotal: deployed,
	}
	return result, nil
}

func equipLoadReturnResult(
	ctx context.Context,
	tx pgx.Tx,
	returnID uuid.UUID,
	replayed bool,
) (equipReturnResult, error) {
	var result equipReturnResult
	err := tx.QueryRow(ctx, `
		SELECT r.id, r.quantity, d.quantity, d.quantity_returned,
		       d.stock_id, d.date_removed IS NOT NULL
		FROM equipment_deployment_returns r
		JOIN equipment_deployments d ON d.id = r.deployment_id
		WHERE r.id = $1`, returnID).
		Scan(&result.ID, &result.Quantity, &result.DeployedTotal,
			&result.TotalReturned, &result.StockID, &result.FullyReturned)
	if err != nil {
		return result, err
	}
	result.Outstanding = result.DeployedTotal - result.TotalReturned
	result.Replayed = replayed
	return result, nil
}

// equipStateSnapshot reports the counts a caller should see after a write.
func equipStateSnapshot(state equipStockState) map[string]any {
	return map[string]any{
		"totalOwned": state.TotalOwned,
		"deployed":   state.Deployed,
		"damaged":    state.Damaged,
		"retired":    state.Retired,
		"available":  state.Available(),
	}
}

// equipAdjustTx applies a signed correction to what is owned, refusing any
// adjustment that would drive a count below zero.
func equipAdjustTx(
	ctx context.Context,
	tx pgx.Tx,
	parsed equipParsedRequest,
) (map[string]any, error) {
	if parsed.Quantity > 0 && parsed.From != "serviceable" {
		return nil, equipBadRequest("Only negative adjustments can name a from state")
	}
	state, err := equipLockStock(ctx, tx, parsed.StockID)
	if err != nil {
		return nil, err
	}
	if _, found, err := equipLookupIdempotent(ctx, tx, "equipment_stock_adjustments", parsed.IdempotencyKey, "stock_id", parsed.StockID); err != nil {
		return nil, err
	} else if found {
		return equipStateSnapshot(state), nil
	}
	removed := -parsed.Quantity
	switch {
	case parsed.Quantity > 0:
		// Nothing to validate: adding stock cannot go negative.
	case parsed.From == "serviceable":
		if removed > state.Available() {
			return nil, equipBadRequest(
				"Not enough %s available: removing %d would leave %d",
				state.TypeName, removed, state.Available()-removed)
		}
	case parsed.From == "damaged":
		if removed > state.Damaged {
			return nil, equipBadRequest(
				"Only %d %s are marked damaged", state.Damaged, state.TypeName)
		}
	case parsed.From == "retired":
		if removed > state.Retired {
			return nil, equipBadRequest(
				"Only %d %s are retired", state.Retired, state.TypeName)
		}
	}

	replayed, err := equipInsertAdjustment(ctx, tx, equipAdjustmentEntry{
		StockID:        state.ID,
		Quantity:       parsed.Quantity,
		Reason:         parsed.Reason,
		Notes:          parsed.Notes,
		UnitCostCents:  parsed.Cost,
		Date:           parsed.Date,
		CreatedBy:      parsed.CreatedBy,
		IdempotencyKey: parsed.IdempotencyKey,
	})
	if err != nil {
		return nil, err
	}
	if replayed {
		return equipStateSnapshot(state), nil
	}
	// The same client key is written onto both the adjustment and the
	// accompanying state-change row (when disposing from damaged/retired).
	// Keys are unique per table, not per operation, so a later /damage or
	// /repair that reuses this key will find the state-change row and
	// silently no-op. Callers must not reuse a key across ledgers.
	// Disposing of damaged or retired units also empties that pool, so the
	// states keep partitioning what is owned.
	if parsed.Quantity < 0 && parsed.From != "serviceable" {
		if _, err := equipInsertStateChange(ctx, tx, equipStateEntry{
			StockID:        state.ID,
			From:           parsed.From,
			To:             "serviceable",
			Quantity:       removed,
			Reason:         "disposed",
			Notes:          parsed.Notes,
			Date:           parsed.Date,
			CreatedBy:      parsed.CreatedBy,
			IdempotencyKey: parsed.IdempotencyKey,
		}); err != nil {
			return nil, err
		}
		if parsed.From == "damaged" {
			state.Damaged -= removed
		} else {
			state.Retired -= removed
		}
	}
	state.TotalOwned += parsed.Quantity
	return equipStateSnapshot(state), nil
}

// equipMoveState validates and records a movement between condition states.
func equipMoveState(
	ctx context.Context,
	tx pgx.Tx,
	parsed equipParsedRequest,
	to string,
) (map[string]any, error) {
	state, err := equipLockStock(ctx, tx, parsed.StockID)
	if err != nil {
		return nil, err
	}
	if _, found, err := equipLookupIdempotent(ctx, tx, "equipment_state_changes", parsed.IdempotencyKey, "stock_id", parsed.StockID); err != nil {
		return nil, err
	} else if found {
		return equipStateSnapshot(state), nil
	}
	if parsed.From == to {
		return nil, equipBadRequest("Equipment is already %s", to)
	}
	switch parsed.From {
	case "serviceable":
		if parsed.Quantity > state.Available() {
			return nil, equipBadRequest(
				"Only %d %s available: cannot mark %d as %s",
				state.Available(), state.TypeName, parsed.Quantity, to)
		}
	case "damaged":
		if parsed.Quantity > state.Damaged {
			return nil, equipBadRequest(
				"Only %d %s are marked damaged", state.Damaged, state.TypeName)
		}
	case "retired":
		if parsed.Quantity > state.Retired {
			return nil, equipBadRequest(
				"Only %d %s are retired", state.Retired, state.TypeName)
		}
	}

	cost := parsed.Cost
	if cost == nil {
		cost = state.UnitCostCents
	}
	replayed, err := equipInsertStateChange(ctx, tx, equipStateEntry{
		StockID:        state.ID,
		From:           parsed.From,
		To:             to,
		Quantity:       parsed.Quantity,
		Reason:         parsed.Reason,
		Notes:          parsed.Notes,
		UnitCostCents:  cost,
		Date:           parsed.Date,
		CreatedBy:      parsed.CreatedBy,
		IdempotencyKey: parsed.IdempotencyKey,
	})
	if err != nil {
		return nil, err
	}
	if replayed {
		return equipStateSnapshot(state), nil
	}

	switch parsed.From {
	case "damaged":
		state.Damaged -= parsed.Quantity
	case "retired":
		state.Retired -= parsed.Quantity
	}
	switch to {
	case "damaged":
		state.Damaged += parsed.Quantity
	case "retired":
		state.Retired += parsed.Quantity
	}
	return equipStateSnapshot(state), nil
}

// equipPhysicalCountTx applies a physical count. It returns per-line results,
// or the list of lines that could not be resolved — in which case it has
// written nothing and the caller must abandon the transaction. Unresolvable
// lines are never skipped in silence, which was the bug in bulk-adjust.
func equipPhysicalCountTx(
	ctx context.Context,
	tx pgx.Tx,
	in equipCountInput,
) ([]equipCountLineResult, []equipCountLineError, error) {
	lines := make([]equipCountLine, 0, len(in.Lines))
	lineErrors := make([]equipCountLineError, 0)
	seen := make(map[uuid.UUID]int, len(in.Lines))

	for index, raw := range in.Lines {
		fail := func(message string) {
			lineErrors = append(lineErrors, equipCountLineError{
				Index: index, StockID: raw.StockID, TypeID: raw.TypeID, Message: message,
			})
		}
		if raw.CountedQuantity == nil {
			fail("Counted quantity is required")
			continue
		}
		if *raw.CountedQuantity < 0 {
			fail("Counted quantity cannot be negative")
			continue
		}

		var stockID uuid.UUID
		switch {
		case raw.StockID != nil && *raw.StockID != "":
			parsed, err := uuid.Parse(*raw.StockID)
			if err != nil {
				fail("Unrecognised stock row")
				continue
			}
			var exists bool
			if err := tx.QueryRow(ctx,
				`SELECT true FROM equipment_stock WHERE id = $1`, parsed).Scan(&exists); err != nil {
				if errors.Is(err, pgx.ErrNoRows) {
					fail("This stock row no longer exists")
					continue
				}
				return nil, nil, err
			}
			stockID = parsed
		case raw.TypeID != nil && *raw.TypeID != "":
			parsed, err := uuid.Parse(*raw.TypeID)
			if err != nil {
				fail("Unrecognised equipment type")
				continue
			}
			if err := tx.QueryRow(ctx,
				`SELECT id FROM equipment_stock WHERE type_id = $1`, parsed).Scan(&stockID); err != nil {
				if errors.Is(err, pgx.ErrNoRows) {
					fail("This equipment type has no stock row to count")
					continue
				}
				return nil, nil, err
			}
		default:
			fail("A stock row or equipment type is required")
			continue
		}

		if first, duplicate := seen[stockID]; duplicate {
			fail("Counted twice (also on line " + strconv.Itoa(first+1) + ")")
			continue
		}
		seen[stockID] = index
		lines = append(lines, equipCountLine{
			StockID:         stockID,
			CountedQuantity: *raw.CountedQuantity,
			Index:           index,
		})
	}

	if len(lineErrors) > 0 {
		return nil, lineErrors, nil
	}

	// Lock in a stable order so two counts running at once cannot deadlock.
	sort.Slice(lines, func(i, j int) bool {
		return lines[i].StockID.String() < lines[j].StockID.String()
	})

	results := make([]equipCountLineResult, 0, len(lines))
	for _, line := range lines {
		state, err := equipLockStock(ctx, tx, line.StockID)
		if err != nil {
			return nil, nil, err
		}
		delta := line.CountedQuantity - state.Available()
		if delta != 0 {
			var lineKey *string
			if in.IdempotencyKey != nil {
				key := *in.IdempotencyKey + ":" + line.StockID.String()
				lineKey = &key
			}
			replayed, err := equipInsertAdjustment(ctx, tx, equipAdjustmentEntry{
				StockID:        state.ID,
				Quantity:       delta,
				Reason:         "physical_count",
				Notes:          in.Notes,
				Date:           in.Date,
				CreatedBy:      in.CreatedBy,
				IdempotencyKey: lineKey,
			})
			if err != nil {
				return nil, nil, err
			}
			if replayed {
				delta = 0
			}
		}
		results = append(results, equipCountLineResult{
			StockID:           state.ID,
			TypeID:            state.TypeID,
			TypeName:          state.TypeName,
			PreviousAvailable: state.Available(),
			CountedQuantity:   line.CountedQuantity,
			Delta:             delta,
			TotalOwned:        state.TotalOwned + delta,
		})
	}
	return results, nil, nil
}
