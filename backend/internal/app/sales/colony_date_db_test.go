package sales

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/biker2000on/beez-trackz/backend/internal/app"
	"github.com/google/uuid"
)

// TestBackdatedColonySaleCannotSellTheSuccessor records a colony sale dated
// before the hive at that label was installed, the way sale BT-4A8A1055 was
// recorded against the successor A1/C2 colonies. RecordSale (POST /sales)
// must refuse it as invalid input, so the API answers 400 with the message,
// and the successor must stay active with no sale attached. A sale dated
// after installation still goes through.
func TestBackdatedColonySaleCannotSellTheSuccessor(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Minute)
	defer cancel()
	fixture, cleanup := newReservationFixture(ctx, t, "beez_sales_colony_date")
	defer cleanup()

	var apiaryID, successor, predecessor uuid.UUID
	if err := fixture.pool.QueryRow(ctx,
		`INSERT INTO apiaries (name) VALUES ('Label yard') RETURNING id`).Scan(&apiaryID); err != nil {
		t.Fatalf("seed apiary: %v", err)
	}
	// The colony sold on 2026-04-25 and the swarm that took A1 two days later.
	if err := fixture.pool.QueryRow(ctx, `
		INSERT INTO hives (apiary_id, position_label, installed_date)
		VALUES ($1,'A1','2026-03-22T00:00:00Z') RETURNING id`, apiaryID).Scan(&predecessor); err != nil {
		t.Fatalf("seed predecessor: %v", err)
	}
	if err := fixture.pool.QueryRow(ctx, `
		INSERT INTO hives (apiary_id, position_label, installed_date)
		VALUES ($1,'A1','2026-04-27T00:00:00Z') RETURNING id`, apiaryID).Scan(&successor); err != nil {
		t.Fatalf("seed successor: %v", err)
	}

	record := func(hiveID uuid.UUID, date time.Time) error {
		paid := int64(22500)
		return fixture.runner.Run(ctx, fixture.actor, func(ctx context.Context, uow *app.UnitOfWork) error {
			_, err := RecordSale(ctx, uow, RecordSaleInput{
				SaleID: uuid.New(), Date: date,
				Channel: "direct", PaymentMethod: "cash", OrderStatus: "paid",
				AmountPaidCents: &paid,
				Lines:           []SaleLine{{Kind: KindColony, HiveID: hiveID, Quantity: 1, UnitPriceCents: 22500}},
			})
			return err
		})
	}
	saleDate := time.Date(2026, 4, 25, 0, 0, 0, 0, time.UTC)

	err := record(successor, saleDate)
	if !app.IsKind(err, app.KindInvalid) {
		t.Fatalf("backdated sale of the successor = %v (kind %q), want invalid", err, app.KindOf(err))
	}
	want := "A1 was installed 2026-04-27, after the 2026-04-25 sale date; pick the colony that was in A1 on that date."
	var typed *app.Error
	if !errors.As(err, &typed) || typed.Message != want {
		t.Errorf("refusal = %v, want message %q", err, want)
	}
	var status string
	var saleID *uuid.UUID
	if err := fixture.pool.QueryRow(ctx,
		`SELECT status::text, sale_id FROM hives WHERE id=$1`, successor).Scan(&status, &saleID); err != nil {
		t.Fatal(err)
	}
	if status != "active" || saleID != nil {
		t.Errorf("successor after refused sale: status=%s sale_id=%v, want active and none", status, saleID)
	}

	// The colony that really was at A1 on the sale date sells normally.
	if err := record(predecessor, saleDate); err != nil {
		t.Fatalf("sale of the predecessor: %v", err)
	}
	if err := fixture.pool.QueryRow(ctx,
		`SELECT status::text, sale_id FROM hives WHERE id=$1`, predecessor).Scan(&status, &saleID); err != nil {
		t.Fatal(err)
	}
	if status != "sold" || saleID == nil {
		t.Errorf("predecessor after sale: status=%s sale_id=%v, want sold with a sale", status, saleID)
	}
}
