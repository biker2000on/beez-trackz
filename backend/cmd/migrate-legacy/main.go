// Command migrate-legacy copies data from a legacy Beez Trackz database
// (Next.js/drizzle schema) into the new Go-owned schema, and uploads the
// legacy filesystem media (./data/photos, ./data/audio) into MinIO.
//
// Usage:
//
//	LEGACY_DATABASE_URL=postgres://... DATABASE_URL=postgres://... \
//	LEGACY_DATA_DIR=/path/to/old/data MINIO_* ... go run ./cmd/migrate-legacy
//
// The target database must already be migrated (the API server runs goose on
// boot). The copy is idempotent-ish: it refuses to run when the target
// already contains apiaries, to avoid double-imports.
package main

import (
	"context"
	"fmt"
	"log"
	"mime"
	"os"
	"path/filepath"
	"strings"

	"github.com/jackc/pgx/v5"

	"github.com/biker2000on/beez-trackz/backend/internal/config"
	"github.com/biker2000on/beez-trackz/backend/internal/storage"
)

type copySpec struct {
	table string
	cols  []string
	// selectCols overrides the legacy column list when names differ.
	selectCols []string
}

var specs = []copySpec{
	{table: "apiaries",
		cols:       []string{"id", "name", "latitude", "longitude", "notes", "canvas_layout", "satellite_image_key", "created_at", "updated_at"},
		selectCols: []string{"id", "name", "latitude", "longitude", "notes", "canvas_layout", "satellite_image_url", "created_at", "updated_at"}},
	{table: "hives",
		cols: []string{"id", "apiary_id", "position_label", "stand_id", "slot_row", "slot_col", "placement", "facing_degrees", "status", "installed_date", "is_archived", "deadout_date", "notes", "created_at", "updated_at"}},
	{table: "hive_location_history",
		cols: []string{"id", "hive_id", "apiary_id", "position_label", "date_from", "date_to", "created_at"}},
	{table: "hive_splits",
		cols: []string{"id", "parent_hive_id", "child_hive_id", "split_date", "split_type", "frames_moved", "notes", "created_at"}},
	// queens copied in two passes (self-FK on parent_queen_id).
	{table: "inspections",
		cols: []string{"id", "hive_id", "date", "inspector_name", "queen_seen", "queen_health", "brood_pattern", "stores_honey", "stores_pollen", "temperament", "pests", "treatments", "notes", "source_media", "created_at", "updated_at"}},
	{table: "feedings",
		cols: []string{"id", "hive_id", "date_fed", "type", "quantity", "quantity_unit", "feeder_type", "date_empty", "notes", "created_at"}},
	{table: "harvest_sessions",
		cols: []string{"id", "apiary_id", "date", "total_extracted_weight", "notes", "created_at"}},
	{table: "honey_harvests",
		cols: []string{"id", "session_id", "hive_id", "date", "super_weight_before", "super_weight_after", "calculated_honey_weight", "notes", "created_at"}},
	{table: "honey_sales",
		cols: []string{"id", "date", "customer_name", "location", "total_amount", "notes", "created_at"}},
	{table: "jar_sizes",
		cols: []string{"id", "label", "honey_oz", "default_price", "sort_order", "is_active", "created_at"}},
	{table: "honey_movements",
		cols: []string{"id", "date", "kind", "amount_lbs", "jar_size_id", "quantity", "reason", "notes", "created_at"}},
	{table: "honey_sale_items",
		cols: []string{"id", "sale_id", "jar_size_id", "quantity", "unit_price"}},
	{table: "equipment_types",
		cols: []string{"id", "name", "category", "frames_per_box", "is_default", "created_at"}},
	{table: "equipment_stock",
		cols: []string{"id", "type_id", "total_owned", "frame_condition", "storage_location", "notes", "created_at", "updated_at"}},
	{table: "equipment_stock_adjustments",
		cols: []string{"id", "stock_id", "quantity", "reason", "notes", "date", "created_at"}},
	{table: "equipment_deployments",
		cols: []string{"id", "stock_id", "hive_id", "quantity", "date_deployed", "date_removed", "notes", "created_at"}},
	{table: "bloom_observations",
		cols: []string{"id", "apiary_id", "species", "date_first_seen", "date_last_seen", "year", "abundance", "notes", "created_at"}},
	{table: "ai_recommendations",
		cols: []string{"id", "hive_id", "type", "message", "priority", "dismissed", "created_at"}},
	{table: "user_settings",
		cols: []string{"id", "password_hash", "display_name", "ai_provider_config", "theme", "default_apiary_id", "date_format", "weight_unit", "created_at", "updated_at"}},
	{table: "oidc_identities",
		cols: []string{"id", "issuer", "subject", "display_name", "email", "created_at", "last_login_at"}},
	{table: "photos",
		cols:       []string{"id", "owner_type", "owner_id", "original_key", "thumbnail_key", "medium_key", "taken_date", "caption", "tags", "created_at"},
		selectCols: []string{"id", "owner_type", "owner_id", "original_path", "thumbnail_path", "medium_path", "taken_date", "caption", "tags", "created_at"}},
	{table: "media_files",
		cols:       []string{"id", "audio_key", "transcription_text", "transcription_status", "owner_type", "owner_id", "created_at", "updated_at"},
		selectCols: []string{"id", "original_url", "transcription_text", "transcription_status", "owner_type", "owner_id", "created_at", "updated_at"}},
}

// pathToKey converts a legacy filesystem path ("./data/photos/hive/x/y.jpg")
// into a MinIO object key ("photos/hive/x/y.jpg").
func pathToKey(p string) string {
	p = strings.ReplaceAll(p, "\\", "/")
	p = strings.TrimPrefix(p, "./")
	p = strings.TrimPrefix(p, "data/")
	return p
}

func main() {
	ctx := context.Background()

	legacyURL := os.Getenv("LEGACY_DATABASE_URL")
	if legacyURL == "" {
		log.Fatal("LEGACY_DATABASE_URL is required")
	}
	dataDir := os.Getenv("LEGACY_DATA_DIR") // optional; skip file upload when unset

	cfg, err := config.Load()
	if err != nil {
		log.Fatalf("config: %v", err)
	}

	src, err := pgx.Connect(ctx, legacyURL)
	if err != nil {
		log.Fatalf("connect legacy db: %v", err)
	}
	defer src.Close(ctx)

	// Interpret legacy naive timestamps as UTC (they were written by now() in
	// UTC containers).
	if _, err := src.Exec(ctx, "SET TIME ZONE 'UTC'"); err != nil {
		log.Fatalf("set timezone: %v", err)
	}

	dst, err := pgx.Connect(ctx, cfg.DatabaseURL)
	if err != nil {
		log.Fatalf("connect target db: %v", err)
	}
	defer dst.Close(ctx)
	if _, err := dst.Exec(ctx, "SET TIME ZONE 'UTC'"); err != nil {
		log.Fatalf("set timezone: %v", err)
	}

	var existing int
	if err := dst.QueryRow(ctx, "SELECT count(*) FROM apiaries").Scan(&existing); err != nil {
		log.Fatalf("target not migrated? %v", err)
	}
	if existing > 0 {
		log.Fatal("target database already contains apiaries — refusing to double-import")
	}

	var store *storage.Store
	if dataDir != "" {
		store, err = storage.New(ctx, cfg)
		if err != nil {
			log.Fatalf("minio: %v", err)
		}
	}

	for _, spec := range specs {
		n, err := copyTable(ctx, src, dst, spec)
		if err != nil {
			log.Fatalf("copy %s: %v", spec.table, err)
		}
		log.Printf("copied %-28s %5d rows", spec.table, n)
	}
	if err := copyQueens(ctx, src, dst); err != nil {
		log.Fatalf("copy queens: %v", err)
	}
	if store != nil {
		if err := uploadMedia(ctx, dst, store, dataDir); err != nil {
			log.Fatalf("upload media: %v", err)
		}
	} else {
		log.Println("LEGACY_DATA_DIR not set — skipped media upload (object keys recorded, files absent)")
	}
	log.Println("migration complete")
}

func copyTable(ctx context.Context, src, dst *pgx.Conn, spec copySpec) (int, error) {
	sel := spec.selectCols
	if sel == nil {
		sel = spec.cols
	}
	rows, err := src.Query(ctx, fmt.Sprintf("SELECT %s FROM %s", strings.Join(sel, ", "), spec.table))
	if err != nil {
		return 0, err
	}
	defer rows.Close()

	placeholders := make([]string, len(spec.cols))
	for i := range spec.cols {
		placeholders[i] = fmt.Sprintf("$%d", i+1)
	}
	insert := fmt.Sprintf("INSERT INTO %s (%s) VALUES (%s)",
		spec.table, strings.Join(spec.cols, ", "), strings.Join(placeholders, ", "))

	n := 0
	for rows.Next() {
		vals, err := rows.Values()
		if err != nil {
			return n, err
		}
		// Media path → object key columns.
		if spec.table == "photos" {
			for _, i := range []int{3, 4, 5} {
				if s, ok := vals[i].(string); ok && s != "" {
					vals[i] = pathToKey(s)
				}
			}
		}
		if spec.table == "media_files" {
			if s, ok := vals[1].(string); ok && s != "" {
				vals[1] = pathToKey(s)
			}
		}
		if _, err := dst.Exec(ctx, insert, vals...); err != nil {
			return n, fmt.Errorf("row %d: %w", n, err)
		}
		n++
	}
	return n, rows.Err()
}

// copyQueens inserts queens without parents first, then fills parent links,
// because parent_queen_id is now a real self-FK.
func copyQueens(ctx context.Context, src, dst *pgx.Conn) error {
	cols := []string{"id", "hive_id", "origin", "origin_hive_id", "parent_queen_id", "introduced_date", "status", "notes", "created_at", "updated_at"}
	rows, err := src.Query(ctx, "SELECT "+strings.Join(cols, ", ")+" FROM queens")
	if err != nil {
		return err
	}
	defer rows.Close()

	type parentLink struct{ id, parent any }
	var links []parentLink
	n := 0
	for rows.Next() {
		vals, err := rows.Values()
		if err != nil {
			return err
		}
		if vals[4] != nil {
			links = append(links, parentLink{id: vals[0], parent: vals[4]})
			vals[4] = nil
		}
		if _, err := dst.Exec(ctx,
			`INSERT INTO queens (id, hive_id, origin, origin_hive_id, parent_queen_id, introduced_date, status, notes, created_at, updated_at)
			 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, vals...); err != nil {
			return err
		}
		n++
	}
	if err := rows.Err(); err != nil {
		return err
	}
	for _, l := range links {
		if _, err := dst.Exec(ctx, "UPDATE queens SET parent_queen_id = $1 WHERE id = $2", l.parent, l.id); err != nil {
			// Parent may have been deleted in legacy data (no FK there).
			log.Printf("warn: queen %v parent %v not linkable: %v", l.id, l.parent, err)
		}
	}
	log.Printf("copied %-28s %5d rows (%d parent links)", "queens", n, len(links))
	return nil
}

// uploadMedia pushes legacy photo/audio files into MinIO for every object key
// recorded in the target database.
func uploadMedia(ctx context.Context, dst *pgx.Conn, store *storage.Store, dataDir string) error {
	var keys []string
	rows, err := dst.Query(ctx, `
		SELECT original_key FROM photos
		UNION ALL SELECT thumbnail_key FROM photos WHERE thumbnail_key IS NOT NULL
		UNION ALL SELECT medium_key FROM photos WHERE medium_key IS NOT NULL
		UNION ALL SELECT audio_key FROM media_files`)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var k string
		if err := rows.Scan(&k); err != nil {
			return err
		}
		if k != "" {
			keys = append(keys, k)
		}
	}
	if err := rows.Err(); err != nil {
		return err
	}

	uploaded, missing := 0, 0
	for _, key := range keys {
		local := filepath.Join(dataDir, filepath.FromSlash(key))
		f, err := os.Open(local)
		if err != nil {
			missing++
			log.Printf("warn: missing local file for %s", key)
			continue
		}
		info, err := f.Stat()
		if err != nil {
			f.Close()
			return err
		}
		contentType := mime.TypeByExtension(filepath.Ext(local))
		if contentType == "" {
			contentType = "application/octet-stream"
		}
		if err := store.Put(ctx, key, f, info.Size(), contentType); err != nil {
			f.Close()
			return fmt.Errorf("upload %s: %w", key, err)
		}
		f.Close()
		uploaded++
	}
	log.Printf("media upload: %d uploaded, %d missing", uploaded, missing)
	return nil
}
