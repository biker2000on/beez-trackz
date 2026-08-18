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

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/biker2000on/beez-trackz/backend/internal/config"
	"github.com/biker2000on/beez-trackz/backend/internal/storage"
)

type copySpec struct {
	table string
	// destTable overrides the target table when the rewrite renamed it.
	destTable string
	cols      []string
	// selectCols overrides the legacy column list when names differ.
	selectCols []string
	// centsCols marks target columns (by index into cols) that are integer
	// cents in this schema but float dollars in the legacy one. The insert
	// converts them with the same ROUND(x*100) rule as migration 00004.
	centsCols map[int]bool
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
	{table: "honey_sales", destTable: "sales",
		cols:       []string{"id", "date", "customer_name", "location", "total_amount_cents", "notes", "created_at"},
		selectCols: []string{"id", "date", "customer_name", "location", "total_amount", "notes", "created_at"},
		centsCols:  map[int]bool{4: true}},
	{table: "jar_sizes",
		cols:       []string{"id", "label", "honey_oz", "default_price_cents", "sort_order", "is_active", "created_at"},
		selectCols: []string{"id", "label", "honey_oz", "default_price", "sort_order", "is_active", "created_at"},
		centsCols:  map[int]bool{3: true}},
	{table: "honey_movements",
		cols: []string{"id", "date", "kind", "amount_lbs", "jar_size_id", "quantity", "reason", "notes", "created_at"}},
	{table: "honey_sale_items", destTable: "sale_items",
		cols:       []string{"id", "sale_id", "jar_size_id", "quantity", "unit_price_cents"},
		selectCols: []string{"id", "sale_id", "jar_size_id", "quantity", "unit_price"},
		centsCols:  map[int]bool{4: true}},
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
	dataDir := os.Getenv("LEGACY_DATA_DIR") // optional; skip file upload when unset
	mediaOnly := strings.EqualFold(os.Getenv("LEGACY_MEDIA_ONLY"), "true") ||
		os.Getenv("LEGACY_MEDIA_ONLY") == "1"
	if legacyURL == "" && !mediaOnly {
		log.Fatal("LEGACY_DATABASE_URL is required unless LEGACY_MEDIA_ONLY is enabled")
	}

	cfg, err := config.Load()
	if err != nil {
		log.Fatalf("config: %v", err)
	}

	var src *pgx.Conn
	if legacyURL != "" {
		src, err = pgx.Connect(ctx, legacyURL)
		if err != nil {
			log.Fatalf("connect legacy db: %v", err)
		}
		defer src.Close(ctx)

		// Interpret legacy naive timestamps as UTC (they were written by now() in
		// UTC containers).
		if _, err := src.Exec(ctx, "SET TIME ZONE 'UTC'"); err != nil {
			log.Fatalf("set timezone: %v", err)
		}
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
	if existing > 0 && !mediaOnly {
		log.Fatal("target database already contains apiaries — refusing to double-import")
	}

	var store *storage.Store
	if dataDir != "" {
		store, err = storage.New(ctx, cfg)
		if err != nil {
			log.Fatalf("minio: %v", err)
		}
	}

	if !mediaOnly {
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
	} else {
		log.Println("LEGACY_MEDIA_ONLY enabled - preserving operational rows and importing media only")
		if src == nil {
			log.Println("LEGACY_DATABASE_URL not set - discovering photos from the filesystem only")
		} else {
			if n, err := copyLegacyPhotos(ctx, src, dst); err != nil {
				log.Fatalf("copy legacy photo rows: %v", err)
			} else {
				log.Printf("copied %-28s %5d rows", "legacy photo metadata", n)
			}
		}
	}
	if store != nil {
		if n, err := importFilesystemPhotos(ctx, dst, dataDir); err != nil {
			log.Fatalf("discover filesystem photos: %v", err)
		} else {
			log.Printf("discovered %-24s %5d rows", "filesystem-only photos", n)
		}
		if err := uploadMedia(ctx, dst, store, dataDir); err != nil {
			log.Fatalf("upload media: %v", err)
		}
	} else {
		log.Println("LEGACY_DATA_DIR not set — skipped media upload (object keys recorded, files absent)")
	}
	log.Println("migration complete")
}

// copyLegacyPhotos imports photo metadata without requiring an empty target.
// It supports post-cutover repair runs where operational data already exists.
func copyLegacyPhotos(ctx context.Context, src, dst *pgx.Conn) (int, error) {
	rows, err := src.Query(ctx, `
		SELECT id, owner_type, owner_id, original_path, thumbnail_path, medium_path,
			taken_date, caption, tags, created_at
		FROM photos`)
	if err != nil {
		// Some oldest backups predate the photos table. Filesystem discovery
		// below can still recover conventionally named originals.
		log.Printf("warn: legacy photos table unavailable: %v", err)
		return 0, nil
	}
	defer rows.Close()
	n := 0
	for rows.Next() {
		vals, err := rows.Values()
		if err != nil {
			return n, err
		}
		for _, i := range []int{3, 4, 5} {
			if value, ok := vals[i].(string); ok && value != "" {
				vals[i] = pathToKey(value)
			}
		}
		tag, err := dst.Exec(ctx, `
			INSERT INTO photos
				(id, owner_type, owner_id, original_key, original_ref, storage_backend,
				 thumbnail_key, medium_key, taken_date, caption, tags, created_at)
			SELECT $1,$2,$3,$4,$4,'minio',$5,$6,$7,$8,$9,$10
			WHERE NOT EXISTS (SELECT 1 FROM photos WHERE id=$1 OR original_key=$4)`,
			vals...)
		if err != nil {
			return n, err
		}
		if tag.RowsAffected() > 0 {
			n++
		}
	}
	return n, rows.Err()
}

// importFilesystemPhotos recovers originals that were written to disk but
// never received a legacy database row. The durable layout is:
// data/photos/{hive|apiary|inspection}/{owner UUID}/file.ext
func importFilesystemPhotos(ctx context.Context, dst *pgx.Conn, dataDir string) (int, error) {
	root := filepath.Join(dataDir, "photos")
	if _, err := os.Stat(root); err != nil {
		if os.IsNotExist(err) {
			log.Printf("warn: no filesystem photo directory at %s", root)
			return 0, nil
		}
		return 0, err
	}
	n := 0
	err := filepath.WalkDir(root, func(path string, entry os.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if entry.IsDir() {
			return nil
		}
		extension := filepath.Ext(path)
		base := strings.TrimSuffix(path, extension)
		if strings.HasSuffix(base, "_thumb") || strings.HasSuffix(base, "_medium") {
			// Generated variants belong to the original immediately beside
			// them; importing each variant as a separate photo duplicates the
			// gallery and loses the original/thumbnail relationship.
			return nil
		}
		rel, err := filepath.Rel(root, path)
		if err != nil {
			return err
		}
		parts := strings.Split(filepath.ToSlash(rel), "/")
		if len(parts) < 3 {
			log.Printf("warn: cannot infer photo owner from %s", rel)
			return nil
		}
		ownerType := parts[0]
		if ownerType != "hive" && ownerType != "apiary" && ownerType != "inspection" {
			log.Printf("warn: unsupported photo owner type in %s", rel)
			return nil
		}
		ownerID, err := uuid.Parse(parts[1])
		if err != nil {
			log.Printf("warn: invalid photo owner UUID in %s", rel)
			return nil
		}
		table := map[string]string{
			"hive": "hives", "apiary": "apiaries", "inspection": "inspections",
		}[ownerType]
		var ownerExists bool
		if err := dst.QueryRow(ctx,
			"SELECT EXISTS(SELECT 1 FROM "+table+" WHERE id=$1)", ownerID).
			Scan(&ownerExists); err != nil {
			return err
		}
		if !ownerExists {
			log.Printf("warn: photo owner does not exist for %s", rel)
			return nil
		}
		info, err := entry.Info()
		if err != nil {
			return err
		}
		key := "photos/" + filepath.ToSlash(rel)
		var thumbnailKey, mediumKey *string
		for suffix, destination := range map[string]**string{
			"_thumb": &thumbnailKey, "_medium": &mediumKey,
		} {
			variantPath := base + suffix + extension
			if variantInfo, err := os.Stat(variantPath); err == nil && !variantInfo.IsDir() {
				variantRel, err := filepath.Rel(root, variantPath)
				if err != nil {
					return err
				}
				variantKey := "photos/" + filepath.ToSlash(variantRel)
				*destination = &variantKey
			}
		}
		tag, err := dst.Exec(ctx, `
			INSERT INTO photos
				(owner_type, owner_id, original_key, original_ref, storage_backend,
				 thumbnail_key, medium_key, taken_date, created_at)
			SELECT $1,$2,$3,$3,'minio',$4,$5,$6,$6
			WHERE NOT EXISTS (SELECT 1 FROM photos WHERE original_key=$3)`,
			ownerType, ownerID, key, thumbnailKey, mediumKey, info.ModTime())
		if err != nil {
			return err
		}
		if tag.RowsAffected() > 0 {
			n++
		}
		return nil
	})
	return n, err
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
		if spec.centsCols[i] {
			placeholders[i] = fmt.Sprintf("ROUND($%d::numeric * 100)::bigint", i+1)
		}
	}
	dest := spec.destTable
	if dest == "" {
		dest = spec.table
	}
	insert := fmt.Sprintf("INSERT INTO %s (%s) VALUES (%s)",
		dest, strings.Join(spec.cols, ", "), strings.Join(placeholders, ", "))

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
