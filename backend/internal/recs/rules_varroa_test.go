package recs

import (
	"context"
	"os"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/biker2000on/beez-trackz/backend/internal/db"
)

func recsTestPool(t *testing.T) (*pgxpool.Pool, context.Context) {
	t.Helper()
	databaseURL := os.Getenv("TEST_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("TEST_DATABASE_URL is not configured")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	t.Cleanup(cancel)
	pool, err := db.Connect(ctx, databaseURL)
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	return pool, ctx
}

func TestTreatNowAndMiteCheckDue(t *testing.T) {
	pool, ctx := recsTestPool(t)
	suffix := uuid.NewString()
	now := time.Date(2026, time.August, 18, 12, 0, 0, 0, time.UTC)

	var apiaryID, hotHive, coldHive uuid.UUID
	if err := pool.QueryRow(ctx,
		`INSERT INTO apiaries (name) VALUES ($1) RETURNING id`,
		"Varroa recs "+suffix).Scan(&apiaryID); err != nil {
		t.Fatalf("apiary: %v", err)
	}
	if err := pool.QueryRow(ctx,
		`INSERT INTO hives (apiary_id, position_label) VALUES ($1,'Hot') RETURNING id`,
		apiaryID).Scan(&hotHive); err != nil {
		t.Fatalf("hot hive: %v", err)
	}
	if err := pool.QueryRow(ctx,
		`INSERT INTO hives (apiary_id, position_label) VALUES ($1,'Cold') RETURNING id`,
		apiaryID).Scan(&coldHive); err != nil {
		t.Fatalf("cold hive: %v", err)
	}
	t.Cleanup(func() {
		cleanup, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		_, _ = pool.Exec(cleanup, `DELETE FROM mite_counts WHERE hive_id IN ($1,$2)`, hotHive, coldHive)
		_, _ = pool.Exec(cleanup, `DELETE FROM hives WHERE id IN ($1,$2)`, hotHive, coldHive)
		_, _ = pool.Exec(cleanup, `DELETE FROM apiaries WHERE id=$1`, apiaryID)
	})

	if _, err := pool.Exec(ctx, `
		INSERT INTO mite_counts (hive_id, date, method, mites_count, sample_size)
		VALUES ($1,$2,'alcohol_wash',15,300)`,
		hotHive, now.AddDate(0, 0, -2)); err != nil {
		t.Fatalf("insert count: %v", err)
	}

	treat, err := checkTreatNow(ctx, pool, now)
	if err != nil {
		t.Fatalf("treat_now: %v", err)
	}
	foundHot := false
	for _, rec := range treat {
		if rec.HiveID != nil && *rec.HiveID == hotHive.String() {
			foundHot = true
		}
		if rec.HiveID != nil && *rec.HiveID == coldHive.String() {
			t.Fatal("treat_now should not fire for a hive with no count")
		}
	}
	if !foundHot {
		t.Fatalf("treat_now missed the over-threshold hive: %#v", treat)
	}

	due, err := checkMiteCheckDue(ctx, pool, now)
	if err != nil {
		t.Fatalf("mite_check_due: %v", err)
	}
	foundCold := false
	for _, rec := range due {
		if rec.HiveID != nil && *rec.HiveID == coldHive.String() {
			foundCold = true
		}
		if rec.HiveID != nil && *rec.HiveID == hotHive.String() {
			t.Fatal("mite_check_due should not fire 2 days after a count")
		}
	}
	if !foundCold {
		t.Fatalf("mite_check_due missed the never-sampled hive: %#v", due)
	}
}
