package sales

import (
	"context"
	"errors"
	"time"

	"github.com/biker2000on/beez-trackz/backend/internal/app"
	"github.com/biker2000on/beez-trackz/backend/internal/app/production"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// ErrJarLineNeedsLot is the refusal for a jar line that names no harvest lot.
// Honey is sold by varietal: a jar with no lot is a jar nobody can trace, so a
// sale may not take "some quarts" off the shelf without saying whose honey.
const ErrJarLineNeedsLot = "every jar line needs a varietal / lot: choose the harvest lot the jars come off"

// chooseJarLineLot decides which harvest lot a jar line sells. The line's own
// lot wins; a bottling run names its lot; a sale that names one harvest lot
// lends it to any jar line that did not choose. A line with none of the three
// is refused (problem is non-empty), and a line whose own lot disagrees with
// its bottling run is refused rather than guessed.
func chooseJarLineLot(lineLot, runLot uuid.UUID, saleLot *uuid.UUID) (uuid.UUID, string) {
	switch {
	case lineLot != uuid.Nil:
		if runLot != uuid.Nil && runLot != lineLot {
			return uuid.Nil, "bottlingRunId does not belong to harvestLotId"
		}
		return lineLot, ""
	case runLot != uuid.Nil:
		return runLot, ""
	case saleLot != nil && *saleLot != uuid.Nil:
		return *saleLot, ""
	}
	return uuid.Nil, ErrJarLineNeedsLot
}

// resolveJarLineLot stamps line.HarvestLotID for a jar line and checks the lot
// exists and may be sold on the sale date. Non-jar lines are left alone:
// catalog products, colonies and equipment are not tracked by harvest lot.
func resolveJarLineLot(
	ctx context.Context, uow *app.UnitOfWork, op string, line *SaleLine,
	runLot uuid.UUID, saleLot *uuid.UUID, date time.Time,
) error {
	if line.Kind != KindJar {
		return nil
	}
	lot, problem := chooseJarLineLot(line.HarvestLotID, runLot, saleLot)
	if problem != "" {
		return app.Invalid(op, "%s", problem)
	}
	line.HarvestLotID = lot
	if lot == runLot {
		// The bottling-run branch already read and lockout-checked this lot.
		return nil
	}
	var code string
	if err := uow.QueryRow(ctx, `SELECT lot_code FROM harvest_lots WHERE id=$1`, lot).Scan(&code); errors.Is(err, pgx.ErrNoRows) {
		return app.Invalid(op, "invalid harvestLotId")
	} else if err != nil {
		return dbError(op, err)
	}
	refusal, until, err := production.LotRefusal(ctx, uow, lot, date)
	if err != nil {
		return err
	}
	if refusal != "" {
		if until != nil {
			return app.Conflict(op, "Lot %s: %s (%s)", code, refusal, until.Format("2006-01-02"))
		}
		return app.Conflict(op, "Lot %s: %s", code, refusal)
	}
	return nil
}
