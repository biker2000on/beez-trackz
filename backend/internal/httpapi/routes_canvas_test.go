package httpapi

import (
	"encoding/json"
	"math"
	"testing"

	"github.com/google/uuid"
)

func TestCanvasValidLatLng(t *testing.T) {
	t.Parallel()
	cases := []struct {
		name     string
		lat, lng *float64
		want     bool
	}{
		{"both nil", nil, nil, true},
		{"in range", floatPtr(35.595), floatPtr(-82.551), true},
		{"edges", floatPtr(-90), floatPtr(180), true},
		{"lat too big", floatPtr(90.0001), floatPtr(0), false},
		{"lng too small", floatPtr(0), floatPtr(-180.5), false},
		{"half pair", floatPtr(10), nil, false},
		{"nan", floatPtr(math.NaN()), floatPtr(0), false},
		{"inf", floatPtr(0), floatPtr(math.Inf(1)), false},
	}
	for _, tc := range cases {
		if got := canvasValidLatLng(tc.lat, tc.lng); got != tc.want {
			t.Errorf("%s: canvasValidLatLng = %v, want %v", tc.name, got, tc.want)
		}
	}
}

// Integration: slot moves keep hive GPS in step with the stored stand geometry
// and never touch the apiary pin. Skips without TEST_DATABASE_URL.
func TestCanvasSyncHiveGps(t *testing.T) {
	ctx, tx := equipTx(t)

	stand := canvasStand{ID: "s1", Label: "A", Rows: 1, Cols: 2,
		Latitude: floatPtr(35.5), Longitude: floatPtr(-82.5)}
	layout, _ := json.Marshal(canvasLayoutJSON{Stands: []canvasStand{stand}})
	var apiaryID uuid.UUID
	if err := tx.QueryRow(ctx, `
		INSERT INTO apiaries (name, latitude, longitude, canvas_layout)
		VALUES ('gps test', 36, -83, $1) RETURNING id`, layout).Scan(&apiaryID); err != nil {
		t.Fatalf("insert apiary: %v", err)
	}
	var hiveID uuid.UUID
	if err := tx.QueryRow(ctx, `
		INSERT INTO hives (apiary_id, position_label, stand_id, slot_row, slot_col)
		VALUES ($1, 'A1', 's1', 0, 0) RETURNING id`, apiaryID).Scan(&hiveID); err != nil {
		t.Fatalf("insert hive: %v", err)
	}

	readHive := func() (lat, lng *float64, source *string) {
		t.Helper()
		if err := tx.QueryRow(ctx, `SELECT latitude, longitude, gps_source FROM hives WHERE id = $1`, hiveID).
			Scan(&lat, &lng, &source); err != nil {
			t.Fatalf("read hive: %v", err)
		}
		return lat, lng, source
	}

	if err := canvasSyncHiveGps(ctx, tx, hiveID); err != nil {
		t.Fatalf("sync hive: %v", err)
	}
	wantLat, wantLng, _ := canvasSlotGPS(stand, 0, 0)
	lat, lng, source := readHive()
	if lat == nil || lng == nil || math.Abs(*lat-wantLat) > 1e-9 || math.Abs(*lng-wantLng) > 1e-9 {
		t.Fatalf("placed hive gps = %v,%v want %v,%v", deref(lat), deref(lng), wantLat, wantLng)
	}
	if source == nil || *source != "layout" {
		t.Fatalf("placed hive gps_source = %v, want layout", source)
	}

	// Layout-managed rows are rederived whenever the yard geometry changes.
	movedStand := stand
	movedStand.Latitude = floatPtr(35.6)
	movedStand.Longitude = floatPtr(-82.6)
	if err := canvasSyncYardGps(ctx, tx, apiaryID, []canvasStand{movedStand}); err != nil {
		t.Fatalf("yard rederive: %v", err)
	}
	wantLat, wantLng, _ = canvasSlotGPS(movedStand, 0, 0)
	lat, lng, source = readHive()
	if lat == nil || lng == nil || math.Abs(*lat-wantLat) > 1e-9 || math.Abs(*lng-wantLng) > 1e-9 {
		t.Fatalf("rederived hive gps = %v,%v want %v,%v", deref(lat), deref(lng), wantLat, wantLng)
	}
	if source == nil || *source != "layout" {
		t.Fatalf("rederived hive gps_source = %v, want layout", source)
	}

	// A manually captured pair remains authoritative across yard saves.
	if _, err := tx.Exec(ctx, `
		UPDATE hives SET latitude = 34.1, longitude = -81.2, gps_source = 'manual'
		WHERE id = $1`, hiveID); err != nil {
		t.Fatal(err)
	}
	if err := canvasSyncYardGps(ctx, tx, apiaryID, []canvasStand{stand}); err != nil {
		t.Fatalf("yard sync with manual hive: %v", err)
	}
	lat, lng, source = readHive()
	if lat == nil || lng == nil || *lat != 34.1 || *lng != -81.2 {
		t.Fatalf("manual hive gps changed to %v,%v", deref(lat), deref(lng))
	}
	if source == nil || *source != "manual" {
		t.Fatalf("manual hive gps_source = %v, want manual", source)
	}

	// Unplacing the hive clears GPS — no invented coordinates.
	if _, err := tx.Exec(ctx, `
		UPDATE hives SET stand_id = NULL, slot_row = NULL, slot_col = NULL, gps_source = 'layout'
		WHERE id = $1`, hiveID); err != nil {
		t.Fatal(err)
	}
	if err := canvasSyncHiveGps(ctx, tx, hiveID); err != nil {
		t.Fatalf("sync unplaced: %v", err)
	}
	if lat, lng, source = readHive(); lat != nil || lng != nil || source != nil {
		t.Fatalf("unplaced hive gps = %v,%v want NULL", deref(lat), deref(lng))
	}

	// Yard sync with a stand that lost GPS also clears, and leaves the pin alone.
	if _, err := tx.Exec(ctx, `UPDATE hives SET stand_id = 's1', slot_row = 0, slot_col = 1 WHERE id = $1`, hiveID); err != nil {
		t.Fatal(err)
	}
	if err := canvasSyncYardGps(ctx, tx, apiaryID, []canvasStand{{ID: "s1", Rows: 1, Cols: 2}}); err != nil {
		t.Fatalf("yard sync: %v", err)
	}
	if lat, lng, source = readHive(); lat != nil || lng != nil || source != nil {
		t.Fatalf("hive on stand without gps = %v,%v want NULL", deref(lat), deref(lng))
	}
	var pinLat, pinLng float64
	if err := tx.QueryRow(ctx, `SELECT latitude, longitude FROM apiaries WHERE id = $1`, apiaryID).
		Scan(&pinLat, &pinLng); err != nil {
		t.Fatal(err)
	}
	if pinLat != 36 || pinLng != -83 {
		t.Fatalf("apiary pin moved to %v,%v", pinLat, pinLng)
	}
}
