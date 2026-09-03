package httpapi

import (
	"context"
	"errors"
	"os"
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
