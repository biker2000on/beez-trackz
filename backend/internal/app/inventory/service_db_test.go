package inventory

import (
	"context"
	"errors"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/biker2000on/beez-trackz/backend/internal/app"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/jackc/pgx/v5/stdlib"
	"github.com/pressly/goose/v3"
)

type ledgerFixture struct {
	pool                         *pgxpool.Pool
	runner                       *app.Runner
	service                      *Service
	home, consignee              uuid.UUID
	countItem, massItem, massLot uuid.UUID
}

func TestServiceRecordAvailabilityAndCheckpoints(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
	defer cancel()
	fixture, cleanup := newLedgerFixture(ctx, t, "beez_inventory_service")
	defer cleanup()
	actor := app.SystemJobActor("inventory-test")

	opening := testOperation("receive", "none", []Movement{{Tuple: Tuple{ItemID: fixture.countItem, LocationID: fixture.home}, Quantity: "10", QuantityScale: 0}})
	if err := fixture.runner.Run(ctx, actor, func(ctx context.Context, uow *app.UnitOfWork) error {
		first, err := fixture.service.Record(ctx, uow, opening)
		if err != nil {
			return err
		}
		if first.Existing {
			t.Error("first record reported existing")
		}
		replay, err := fixture.service.Record(ctx, uow, opening)
		if err != nil {
			return err
		}
		if !replay.Existing || replay.Operation.ID != opening.ID {
			t.Error("replay did not return existing operation")
		}
		return nil
	}); err != nil {
		t.Fatalf("record opening: %v", err)
	}

	different := opening
	different.ID = uuid.New()
	different.Lines = []Movement{{Tuple: opening.Lines[0].Tuple, Quantity: "11", QuantityScale: 0}}
	err := fixture.runner.Run(ctx, actor, func(ctx context.Context, uow *app.UnitOfWork) error {
		_, err := fixture.service.Record(ctx, uow, different)
		return err
	})
	if !app.IsKind(err, app.KindConflict) {
		t.Fatalf("different replay = %v, want conflict", err)
	}

	// Count stock may reach zero but not cross it.
	consume := testOperation("sale_consume", "none", []Movement{{Tuple: opening.Lines[0].Tuple, Quantity: "-10", QuantityScale: 0}})
	if err := recordOne(ctx, fixture, actor, consume); err != nil {
		t.Fatal(err)
	}
	over := testOperation("sale_consume", "none", []Movement{{Tuple: opening.Lines[0].Tuple, Quantity: "-1", QuantityScale: 0}})
	err = recordOne(ctx, fixture, actor, over)
	if !app.IsKind(err, app.KindPrecondition) {
		t.Fatalf("negative count = %v, want precondition", err)
	}

	// Mass stock permits the explicit -0.0001 tolerance boundary only.
	massTuple := Tuple{ItemID: fixture.massItem, LocationID: fixture.home, LotID: &fixture.massLot}
	if err := recordOne(ctx, fixture, actor, testOperation("receive", "none", []Movement{{Tuple: massTuple, Quantity: "1", QuantityScale: 4}})); err != nil {
		t.Fatal(err)
	}
	if err := recordOne(ctx, fixture, actor, testOperation("shrink", "loss", []Movement{{Tuple: massTuple, Quantity: "-1.0001", QuantityScale: 4}})); err != nil {
		t.Fatalf("mass boundary: %v", err)
	}
	err = recordOne(ctx, fixture, actor, testOperation("shrink", "loss", []Movement{{Tuple: massTuple, Quantity: "-0.0001", QuantityScale: 4}}))
	if !app.IsKind(err, app.KindPrecondition) {
		t.Fatalf("below mass boundary = %v", err)
	}

	// Service-level structural validation.
	badTransfer := testOperation("transfer", "none", []Movement{
		{Tuple: Tuple{ItemID: fixture.countItem, LocationID: fixture.home}, Quantity: "-1", QuantityScale: 0},
		{Tuple: Tuple{ItemID: fixture.countItem, LocationID: fixture.consignee}, Quantity: "2", QuantityScale: 0},
	})
	err = recordOne(ctx, fixture, actor, badTransfer)
	if !app.IsKind(err, app.KindInvalid) {
		t.Fatalf("unbalanced transfer = %v", err)
	}
	err = recordOne(ctx, fixture, actor, testOperation("transform", "none", []Movement{{Tuple: massTuple, Quantity: "-0.0001", QuantityScale: 4}}))
	if !app.IsKind(err, app.KindInvalid) {
		t.Fatalf("one-sided transform = %v", err)
	}

	// Scale, reason registry, and composite lot/item failures are typed.
	scaleOp := testOperation("receive", "none", []Movement{{Tuple: Tuple{ItemID: fixture.countItem, LocationID: fixture.home}, Quantity: "0.1", QuantityScale: 1}})
	err = recordOne(ctx, fixture, actor, scaleOp)
	if !app.IsKind(err, app.KindInvalid) {
		t.Fatalf("scale error = %v", err)
	}
	err = recordOne(ctx, fixture, actor, testOperation("receive", "not-a-reason", []Movement{{Tuple: Tuple{ItemID: fixture.countItem, LocationID: fixture.home}, Quantity: "1", QuantityScale: 0}}))
	if !app.IsKind(err, app.KindNotFound) {
		t.Fatalf("reason error = %v", err)
	}
	otherItem := uuid.New()
	mustExecTest(ctx, t, fixture.pool, `INSERT INTO inventory_items(id,kind,name,canonical_unit,quantity_scale,lot_tracked,condition_tracked,container_tracked)
		VALUES($1,'honey_bulk','Other mass','lb',4,true,false,false)`, otherItem)
	err = recordOne(ctx, fixture, actor, testOperation("receive", "none", []Movement{{Tuple: Tuple{ItemID: otherItem, LocationID: fixture.home, LotID: &fixture.massLot}, Quantity: "1", QuantityScale: 4}}))
	if !app.IsKind(err, app.KindNotFound) {
		t.Fatalf("composite lot/item error = %v", err)
	}

	// A negative original can be reversed once; the partial unique index owns
	// the second-reversal race and is mapped to a typed conflict.
	reverseItem := seedCountItem(ctx, t, fixture.pool, "Reverse stock")
	reverseTuple := Tuple{ItemID: reverseItem, LocationID: fixture.home}
	if err := recordOne(ctx, fixture, actor, testOperation("receive", "none", []Movement{{Tuple: reverseTuple, Quantity: "2", QuantityScale: 0}})); err != nil {
		t.Fatal(err)
	}
	original := testOperation("shrink", "loss", []Movement{{Tuple: reverseTuple, Quantity: "-1", QuantityScale: 0}})
	if err := recordOne(ctx, fixture, actor, original); err != nil {
		t.Fatal(err)
	}
	if err := fixture.runner.Run(ctx, actor, func(ctx context.Context, uow *app.UnitOfWork) error {
		_, err := fixture.service.Reverse(ctx, uow, original.ID, "reverse-once", "none")
		return err
	}); err != nil {
		t.Fatalf("first reverse: %v", err)
	}
	err = fixture.runner.Run(ctx, actor, func(ctx context.Context, uow *app.UnitOfWork) error {
		_, err := fixture.service.Reverse(ctx, uow, original.ID, "reverse-twice", "none")
		return err
	})
	if !app.IsKind(err, app.KindConflict) {
		t.Fatalf("second reverse = %v, want conflict", err)
	}

	// Availability checks hold an advisory lock and name the tuple on failure.
	availableItem := seedCountItem(ctx, t, fixture.pool, "Availability stock")
	availableTuple := Tuple{ItemID: availableItem, LocationID: fixture.home}
	if err := recordOne(ctx, fixture, actor, testOperation("receive", "none", []Movement{{Tuple: availableTuple, Quantity: "5", QuantityScale: 0}})); err != nil {
		t.Fatal(err)
	}
	if err := fixture.runner.Run(ctx, actor, func(ctx context.Context, uow *app.UnitOfWork) error {
		if err := fixture.service.CheckAvailable(ctx, uow, []TupleQuantity{{Tuple: availableTuple, Quantity: "5"}}); err != nil {
			return err
		}
		var locks int
		if err := uow.QueryRow(ctx, `SELECT count(*) FROM pg_locks WHERE locktype='advisory' AND pid=pg_backend_pid()`).Scan(&locks); err != nil {
			return err
		}
		if locks == 0 {
			t.Error("CheckAvailable did not retain an advisory lock")
		}
		return nil
	}); err != nil {
		t.Fatalf("available check: %v", err)
	}
	err = fixture.runner.Run(ctx, actor, func(ctx context.Context, uow *app.UnitOfWork) error {
		return fixture.service.CheckAvailable(ctx, uow, []TupleQuantity{{Tuple: availableTuple, Quantity: "6"}})
	})
	if !app.IsKind(err, app.KindPrecondition) || !strings.Contains(err.Error(), availableTuple.String()) {
		t.Fatalf("insufficient check = %v", err)
	}
	firstLocked, releaseFirst := make(chan struct{}), make(chan struct{})
	firstDone, secondDone := make(chan error, 1), make(chan error, 1)
	go func() {
		firstDone <- fixture.runner.Run(ctx, actor, func(ctx context.Context, uow *app.UnitOfWork) error {
			if err := fixture.service.CheckAvailable(ctx, uow, []TupleQuantity{{Tuple: availableTuple, Quantity: "5"}}); err != nil {
				return err
			}
			close(firstLocked)
			<-releaseFirst
			return nil
		})
	}()
	<-firstLocked
	go func() {
		secondDone <- fixture.runner.Run(ctx, actor, func(ctx context.Context, uow *app.UnitOfWork) error {
			return fixture.service.CheckAvailable(ctx, uow, []TupleQuantity{{Tuple: availableTuple, Quantity: "5"}})
		})
	}()
	waitDeadline := time.Now().Add(10 * time.Second)
	for {
		var waiting int
		if err := fixture.pool.QueryRow(ctx, `SELECT count(*) FROM pg_locks WHERE locktype='advisory' AND NOT granted`).Scan(&waiting); err != nil {
			t.Fatal(err)
		}
		if waiting > 0 {
			break
		}
		if time.Now().After(waitDeadline) {
			t.Fatal("second CheckAvailable did not serialize on the tuple lock")
		}
		time.Sleep(10 * time.Millisecond)
	}
	close(releaseFirst)
	if err := <-firstDone; err != nil {
		t.Fatal(err)
	}
	if err := <-secondDone; err != nil {
		t.Fatal(err)
	}

	// Checkpoints equal the raw sum, and the balance view includes later delta.
	if err := fixture.runner.Run(ctx, actor, func(ctx context.Context, uow *app.UnitOfWork) error {
		return fixture.service.RefreshCheckpoints(ctx, uow)
	}); err != nil {
		t.Fatalf("refresh checkpoints: %v", err)
	}
	var mismatches int
	if err := fixture.pool.QueryRow(ctx, `SELECT count(*) FROM inventory_balance_checkpoints c WHERE c.on_hand <>
		(SELECT sum(m.quantity) FROM inventory_movements m JOIN inventory_operations o ON o.id=m.operation_id
		 JOIN inventory_operations anchor ON anchor.id=c.as_of_operation_id
		 WHERE m.item_id=c.item_id AND m.location_id=c.location_id
		 AND m.lot_id IS NOT DISTINCT FROM c.lot_id AND m.condition IS NOT DISTINCT FROM c.condition
		 AND m.container_hive_id IS NOT DISTINCT FROM c.container_hive_id
		 AND (o.created_at<anchor.created_at OR (o.created_at=anchor.created_at AND o.id<=anchor.id)))`).Scan(&mismatches); err != nil {
		t.Fatal(err)
	}
	if mismatches != 0 {
		t.Fatalf("%d checkpoint mismatches", mismatches)
	}
	if err := recordOne(ctx, fixture, actor, testOperation("receive", "none", []Movement{{Tuple: availableTuple, Quantity: "1", QuantityScale: 0}})); err != nil {
		t.Fatal(err)
	}
	balances, err := fixture.service.Balances(ctx, fixture.pool, Filter{ItemID: &availableItem})
	if err != nil {
		t.Fatal(err)
	}
	if len(balances) != 1 || balances[0].OnHand != "6.0000" {
		t.Fatalf("checkpoint + delta balance = %#v", balances)
	}
}

func TestTupleLockOrderDeadlockRegression(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()
	fixture, cleanup := newLedgerFixture(ctx, t, "beez_inventory_deadlock")
	defer cleanup()
	actor := app.SystemJobActor("deadlock-test")
	item := seedCountItem(ctx, t, fixture.pool, "Deadlock stock")
	homeTuple := Tuple{ItemID: item, LocationID: fixture.home}
	awayTuple := Tuple{ItemID: item, LocationID: fixture.consignee}
	if err := recordOne(ctx, fixture, actor, testOperation("receive", "none", []Movement{{Tuple: homeTuple, Quantity: "1000", QuantityScale: 0}})); err != nil {
		t.Fatal(err)
	}

	start := make(chan struct{})
	errs := make(chan error, 2)
	var wg sync.WaitGroup
	worker := func(transfer bool) {
		defer wg.Done()
		<-start
		for i := 0; i < 200; i++ {
			var op Operation
			if transfer {
				op = testOperation("transfer", "none", []Movement{{Tuple: homeTuple, Quantity: "-1", QuantityScale: 0}, {Tuple: awayTuple, Quantity: "1", QuantityScale: 0}})
			} else {
				op = testOperation("sale_consume", "none", []Movement{{Tuple: homeTuple, Quantity: "-1", QuantityScale: 0}})
			}
			if err := recordOne(ctx, fixture, actor, op); err != nil {
				errs <- err
				return
			}
		}
		errs <- nil
	}
	wg.Add(2)
	go worker(true)
	go worker(false)
	close(start)
	wg.Wait()
	close(errs)
	for err := range errs {
		if err != nil {
			var pgErr *pgconn.PgError
			if errors.As(err, &pgErr) && pgErr.Code == "40P01" {
				t.Fatalf("deadlock: %v", err)
			}
			t.Fatalf("worker: %v", err)
		}
	}
}

func TestHiveDeleteGuard(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	fixture, cleanup := newLedgerFixture(ctx, t, "beez_inventory_hive_guard")
	defer cleanup()
	actor := app.SystemJobActor("hive-guard-test")
	apiaryID, hiveID := uuid.New(), uuid.New()
	itemID := uuid.New()
	mustExecTest(ctx, t, fixture.pool, `INSERT INTO apiaries(id,name) VALUES($1,'Guard yard')`, apiaryID)
	mustExecTest(ctx, t, fixture.pool, `INSERT INTO hives(id,apiary_id,position_label) VALUES($1,$2,'G1')`, hiveID, apiaryID)
	mustExecTest(ctx, t, fixture.pool, `INSERT INTO inventory_items
		(id,kind,name,canonical_unit,quantity_scale,lot_tracked,condition_tracked,container_tracked)
		VALUES($1,'equipment','Guard equipment','count',0,false,true,true)`, itemID)
	var deployed uuid.UUID
	if err := fixture.pool.QueryRow(ctx, `SELECT id FROM inventory_locations WHERE kind='deployed'`).Scan(&deployed); err != nil {
		t.Fatal(err)
	}
	condition := "serviceable"
	homeTuple := Tuple{ItemID: itemID, LocationID: fixture.home, Condition: &condition}
	deployedTuple := Tuple{ItemID: itemID, LocationID: deployed, Condition: &condition, ContainerHiveID: &hiveID}
	if err := recordOne(ctx, fixture, actor, testOperation("receive", "none", []Movement{{Tuple: homeTuple, Quantity: "1", QuantityScale: 0}})); err != nil {
		t.Fatal(err)
	}
	if err := recordOne(ctx, fixture, actor, testOperation("deploy", "none", []Movement{
		{Tuple: homeTuple, Quantity: "-1", QuantityScale: 0},
		{Tuple: deployedTuple, Quantity: "1", QuantityScale: 0},
	})); err != nil {
		t.Fatal(err)
	}
	_, err := fixture.pool.Exec(ctx, `DELETE FROM hives WHERE id=$1`, hiveID)
	var pgErr *pgconn.PgError
	if !errors.As(err, &pgErr) || pgErr.Code != "23514" {
		t.Fatalf("delete deployed hive = %v, want 23514", err)
	}
	if err := recordOne(ctx, fixture, actor, testOperation("return", "none", []Movement{
		{Tuple: deployedTuple, Quantity: "-1", QuantityScale: 0},
		{Tuple: homeTuple, Quantity: "1", QuantityScale: 0},
	})); err != nil {
		t.Fatal(err)
	}
	if _, err := fixture.pool.Exec(ctx, `DELETE FROM hives WHERE id=$1`, hiveID); err != nil {
		t.Fatalf("delete returned hive: %v", err)
	}
}

func TestCheckpointRefusesStaleComputation(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	fixture, cleanup := newLedgerFixture(ctx, t, "beez_inventory_checkpoint_race")
	defer cleanup()
	actor := app.SystemJobActor("checkpoint-race-test")
	itemID := seedCountItem(ctx, t, fixture.pool, "Checkpoint race stock")
	tuple := Tuple{ItemID: itemID, LocationID: fixture.home}
	if err := recordOne(ctx, fixture, actor, testOperation("receive", "none", []Movement{{Tuple: tuple, Quantity: "1", QuantityScale: 0}})); err != nil {
		t.Fatal(err)
	}

	locked := make(chan struct{})
	mutate := make(chan struct{})
	blockerDone := make(chan error, 1)
	go func() {
		blockerDone <- fixture.runner.Run(ctx, actor, func(ctx context.Context, uow *app.UnitOfWork) error {
			if err := lockTuples(ctx, uow, []Tuple{tuple}); err != nil {
				return err
			}
			close(locked)
			<-mutate
			opID := uuid.New()
			if _, err := uow.Exec(ctx, `INSERT INTO inventory_operations
				(id,kind,reason,occurred_at,idempotency_key,source_type,source_id,details,provenance)
				VALUES($1,'receive','none',now(),$2,'test',$3,'{}','recorded')`, opID, uuid.NewString(), uuid.New()); err != nil {
				return err
			}
			_, err := uow.Exec(ctx, `INSERT INTO inventory_movements
				(operation_id,line_no,item_id,location_id,quantity) VALUES($1,1,$2,$3,1)`, opID, itemID, fixture.home)
			return err
		})
	}()
	<-locked
	refreshDone := make(chan error, 1)
	go func() {
		refreshDone <- fixture.runner.Run(ctx, actor, func(ctx context.Context, uow *app.UnitOfWork) error {
			return fixture.service.RefreshCheckpoints(ctx, uow)
		})
	}()

	deadline := time.Now().Add(10 * time.Second)
	for {
		var waiting int
		if err := fixture.pool.QueryRow(ctx, `SELECT count(*) FROM pg_locks WHERE locktype='advisory' AND NOT granted`).Scan(&waiting); err != nil {
			t.Fatal(err)
		}
		if waiting > 0 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("checkpoint refresh did not wait on the tuple lock")
		}
		time.Sleep(10 * time.Millisecond)
	}
	close(mutate)
	if err := <-blockerDone; err != nil {
		t.Fatalf("concurrent movement: %v", err)
	}
	if err := <-refreshDone; !app.IsKind(err, app.KindPrecondition) {
		t.Fatalf("stale checkpoint refresh = %v, want precondition", err)
	}
}

func newLedgerFixture(ctx context.Context, t *testing.T, name string) (ledgerFixture, func()) {
	t.Helper()
	url := os.Getenv("TEST_DATABASE_URL")
	if url == "" {
		t.Skip("TEST_DATABASE_URL is not configured")
	}
	admin, err := pgxpool.New(ctx, url)
	if err != nil {
		t.Fatalf("connect admin: %v", err)
	}
	if _, err = admin.Exec(ctx, "DROP DATABASE IF EXISTS "+name); err != nil {
		admin.Close()
		t.Fatal(err)
	}
	if _, err = admin.Exec(ctx, "CREATE DATABASE "+name); err != nil {
		admin.Close()
		t.Fatal(err)
	}
	pool, err := pgxpool.New(ctx, replaceTestDatabase(url, name))
	if err != nil {
		admin.Close()
		t.Fatal(err)
	}
	goose.SetBaseFS(os.DirFS("../../db"))
	if err := goose.SetDialect("postgres"); err != nil {
		t.Fatal(err)
	}
	sqlDB := stdlib.OpenDBFromPool(pool)
	if err := goose.Up(sqlDB, "migrations"); err != nil {
		sqlDB.Close()
		pool.Close()
		admin.Close()
		t.Fatalf("migrate: %v", err)
	}
	sqlDB.Close()
	var home uuid.UUID
	if err := pool.QueryRow(ctx, `SELECT id FROM inventory_locations WHERE is_home`).Scan(&home); err != nil {
		t.Fatal(err)
	}
	consignee := uuid.New()
	mustExecTest(ctx, t, pool, `INSERT INTO inventory_locations(id,kind,name,is_consignment) VALUES($1,'consignee','Test consignee',true)`, consignee)
	countItem := seedCountItem(ctx, t, pool, "Count stock")
	massItem := uuid.MustParse("00000000-0000-0000-0000-000000000101")
	massLot := uuid.New()
	mustExecTest(ctx, t, pool, `INSERT INTO inventory_lots(id,item_id,code) VALUES($1,$2,'test-mass')`, massLot, massItem)
	cleanup := func() {
		pool.Close()
		_, _ = admin.Exec(context.Background(), "DROP DATABASE IF EXISTS "+name)
		admin.Close()
	}
	return ledgerFixture{pool: pool, runner: app.NewRunner(pool), service: NewService(), home: home, consignee: consignee, countItem: countItem, massItem: massItem, massLot: massLot}, cleanup
}

func seedCountItem(ctx context.Context, t *testing.T, pool *pgxpool.Pool, name string) uuid.UUID {
	t.Helper()
	id := uuid.New()
	mustExecTest(ctx, t, pool, `INSERT INTO inventory_items(id,kind,name,canonical_unit,quantity_scale,lot_tracked,condition_tracked,container_tracked) VALUES($1,'jar',$2,'count',0,false,false,false)`, id, name)
	return id
}
func testOperation(kind, reason string, lines []Movement) Operation {
	return Operation{ID: uuid.New(), Kind: kind, Reason: reason, OccurredAt: time.Now().UTC(), IdempotencyKey: uuid.NewString(), SourceType: "test", SourceID: uuid.New(), Provenance: "recorded", Lines: lines}
}
func recordOne(ctx context.Context, f ledgerFixture, actor app.Actor, op Operation) error {
	return f.runner.Run(ctx, actor, func(ctx context.Context, uow *app.UnitOfWork) error {
		_, err := f.service.Record(ctx, uow, op)
		return err
	})
}
func mustExecTest(ctx context.Context, t *testing.T, pool *pgxpool.Pool, sql string, args ...any) {
	t.Helper()
	if _, err := pool.Exec(ctx, sql, args...); err != nil {
		t.Fatalf("exec: %v", err)
	}
}
func replaceTestDatabase(url, name string) string {
	base, query, ok := strings.Cut(url, "?")
	slash := strings.LastIndex(base, "/")
	result := base[:slash+1] + name
	if ok {
		return result + "?" + query
	}
	return result
}
