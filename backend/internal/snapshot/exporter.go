package snapshot

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type ObjectHasher interface {
	Hash(context.Context, string) (size int64, sha256 string, err error)
}

type ExportOptions struct {
	OutputDirectory  string
	AppCommit        string
	ExporterVersion  string
	BusinessTimezone string
	Currency         string
	ExportedAt       time.Time
	HashMinIO        bool
	ObjectHasher     ObjectHasher
}

type ExportResult struct {
	Manifest     Manifest
	Verification Verification
	Directory    string
}

var currencyPattern = regexp.MustCompile(`^[A-Z]{3}$`)

func Export(ctx context.Context, pool *pgxpool.Pool, options ExportOptions) (*ExportResult, error) {
	if pool == nil {
		return nil, fmt.Errorf("snapshot export: database pool is required")
	}
	if options.OutputDirectory == "" {
		return nil, fmt.Errorf("snapshot export: output directory is required")
	}
	if options.ExporterVersion == "" {
		options.ExporterVersion = ExporterVersion
	}
	if strings.TrimSpace(options.AppCommit) == "" {
		options.AppCommit = "unknown"
	}
	if options.BusinessTimezone == "" {
		options.BusinessTimezone = "UTC"
	}
	if _, err := time.LoadLocation(options.BusinessTimezone); err != nil {
		return nil, fmt.Errorf("snapshot export: invalid business timezone %q: %w", options.BusinessTimezone, err)
	}
	if options.Currency == "" {
		options.Currency = "USD"
	}
	if !currencyPattern.MatchString(options.Currency) {
		return nil, fmt.Errorf("snapshot export: currency must be a three-letter uppercase code")
	}
	if options.ExportedAt.IsZero() {
		options.ExportedAt = time.Now()
	}
	options.ExportedAt = options.ExportedAt.UTC()
	if options.HashMinIO && options.ObjectHasher == nil {
		return nil, fmt.Errorf("snapshot export: MinIO hashing requested without an object hasher")
	}
	if err := os.Mkdir(options.OutputDirectory, 0o700); err != nil {
		return nil, fmt.Errorf("create snapshot directory: %w", err)
	}
	if err := os.Mkdir(filepath.Join(options.OutputDirectory, "domains"), 0o700); err != nil {
		return nil, fmt.Errorf("create domains directory: %w", err)
	}

	tx, err := pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		return nil, fmt.Errorf("begin consistent snapshot: %w", err)
	}
	defer func() { _ = tx.Rollback(context.WithoutCancel(ctx)) }()
	if _, err := tx.Exec(ctx, `SET LOCAL TIME ZONE 'UTC'`); err != nil {
		return nil, fmt.Errorf("set snapshot timezone: %w", err)
	}
	var schemaMigration int64
	if err := tx.QueryRow(ctx, `SELECT COALESCE(MAX(version_id) FILTER (WHERE is_applied),0) FROM goose_db_version`).Scan(&schemaMigration); err != nil {
		return nil, fmt.Errorf("read schema migration: %w", err)
	}

	verification := Verification{
		Version: VerificationVersion, FormatVersion: FormatVersion,
		GeneratedAt: options.ExportedAt, CanonicalizationVersion: CanonicalizationVersion,
		DigestAlgorithm: DigestAlgorithmVersion, RecordCounts: make(map[string]int64),
		AggregateFamilies: make(map[string]AggregateFamily),
	}
	domains, err := domainsPresent(ctx, tx)
	if err != nil {
		return nil, err
	}
	files := make([]FileManifest, 0, len(domains))
	for _, item := range domains {
		file, digests, err := exportDomain(ctx, tx, options.OutputDirectory, item)
		if err != nil {
			return nil, err
		}
		files = append(files, file)
		verification.RecordCounts[item.Name] = file.Records
		verification.RecordDigests = append(verification.RecordDigests, digests...)
	}
	verification.ReferenceChecks, err = referenceChecks(ctx, tx)
	if err != nil {
		return nil, err
	}
	legacyPresent, _, err := legacyState(ctx, tx)
	if err != nil {
		return nil, err
	}
	// Phase A keeps the frozen compatibility tables as the parity oracle.
	// Exporting their family after freeze is what lets the P0 gate prove that
	// a ledger-bearing Phase-A snapshot survives restore byte-for-byte.
	if legacyPresent {
		legacy, err := computeLegacyAggregates(ctx, tx, options.Currency)
		if err != nil {
			return nil, err
		}
		verification.AggregateFamilies["legacy"] = AggregateFamily{Label: "legacy definitions", Version: LegacyAggregateFamily, Definitions: legacy}
	}
	ledger, err := computeNewLedgerFamily(ctx, tx)
	if err != nil {
		return nil, err
	}
	verification.AggregateFamilies["newLedger"] = ledger
	media, mediaVerification, err := collectMedia(ctx, tx, options)
	if err != nil {
		return nil, err
	}
	verification.Media = mediaVerification
	if err := tx.Commit(ctx); err != nil {
		return nil, fmt.Errorf("finish consistent snapshot: %w", err)
	}

	mediaFile, err := writeCanonicalFile(options.OutputDirectory, "media-manifest.json", media)
	if err != nil {
		return nil, err
	}
	mediaFile.MediaKind = "original-boundary-and-derived-index"
	verificationFile, err := writeCanonicalFile(options.OutputDirectory, "verification.json", verification)
	if err != nil {
		return nil, err
	}
	manifest := Manifest{
		FormatVersion: FormatVersion, ExportedAt: options.ExportedAt,
		AppCommit: options.AppCommit, SchemaMigration: schemaMigration,
		ExporterVersion: options.ExporterVersion, Files: files,
		Canonical: CanonicalDeclarations{
			JSON: CanonicalizationVersion, Encoding: "UTF-8 without BOM", LineEnding: "LF",
			Timestamps:          "RFC3339Nano UTC; timestamptz values end in Z; date-only business dates remain YYYY-MM-DD",
			BusinessTimezone:    options.BusinessTimezone,
			Units:               map[string]string{"honeyMass": "lb", "propolisMass": "g", "elevation": "m", "temperature": "degC", "counts": "integer", "currency": options.Currency},
			Money:               "integer minor units (cents) plus the declared ISO 4217 currency",
			DigestAlgorithm:     DigestAlgorithmVersion,
			RecordEnvelope:      "domain + preserved id + normalized semantic data; digest covers data only",
			ExternalIdempotency: "gnucash-write-key-v1 = externalID + contentHash, derived at send time and not stored",
			TreatmentReconcile:  "migration-00034-v1: treatment_events linked by inspection_id are reconciled to edits of inspections.treatments; both stores and treatment_products are preserved independently",
		},
		OmittedDomains: OmittedDomains(), ExcludedConfiguration: excludedConfiguration(),
		MediaManifestVersion: MediaManifestVersion, MediaManifest: mediaFile,
		Verification: verificationFile,
	}
	if _, err := writeCanonicalFile(options.OutputDirectory, "manifest.json", manifest); err != nil {
		return nil, err
	}
	return &ExportResult{Manifest: manifest, Verification: verification, Directory: options.OutputDirectory}, nil
}

func domainsPresent(ctx context.Context, tx pgx.Tx) ([]Domain, error) {
	var out []Domain
	for _, item := range RegisteredDomains() {
		var present bool
		if err := tx.QueryRow(ctx, `SELECT to_regclass('public.' || $1) IS NOT NULL`, item.Table).Scan(&present); err != nil {
			return nil, fmt.Errorf("inspect snapshot domain %s: %w", item.Name, err)
		}
		if present {
			out = append(out, item)
		}
	}
	return out, nil
}

func legacyState(ctx context.Context, tx pgx.Tx) (present, frozen bool, err error) {
	if err = tx.QueryRow(ctx, `SELECT to_regclass('public.honey_movements') IS NOT NULL`).Scan(&present); err != nil || !present {
		return present, false, err
	}
	err = tx.QueryRow(ctx, `SELECT EXISTS(
		SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
		WHERE c.relname='honey_movements' AND t.tgname='inventory_legacy_freeze' AND NOT t.tgisinternal)`).Scan(&frozen)
	return
}

func exportDomain(ctx context.Context, tx pgx.Tx, root string, item Domain) (FileManifest, []RecordDigest, error) {
	primaryKey, err := primaryKeyColumns(ctx, tx, item.Table)
	if err != nil {
		return FileManifest{}, nil, err
	}
	if len(primaryKey) == 0 {
		return FileManifest{}, nil, fmt.Errorf("domain %s: table has no primary key", item.Name)
	}
	columnTypes, err := tableColumnTypes(ctx, tx, item.Table)
	if err != nil {
		return FileManifest{}, nil, err
	}
	order := make([]string, len(primaryKey))
	for index, column := range primaryKey {
		order[index] = pgx.Identifier{column}.Sanitize()
	}
	table := pgx.Identifier{item.Table}.Sanitize()
	query := fmt.Sprintf(`SELECT to_jsonb(row_value) FROM %s row_value ORDER BY %s`, table, strings.Join(order, ","))
	rows, err := tx.Query(ctx, query)
	if err != nil {
		return FileManifest{}, nil, fmt.Errorf("domain %s query: %w", item.Name, err)
	}
	defer rows.Close()
	relative := filepath.ToSlash(filepath.Join("domains", item.Name+".jsonl"))
	path := filepath.Join(root, filepath.FromSlash(relative))
	file, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return FileManifest{}, nil, fmt.Errorf("domain %s create: %w", item.Name, err)
	}
	hasher := new(bytes.Buffer)
	writer := bufio.NewWriter(io.MultiWriter(file, hasher))
	var count int64
	digests := make([]RecordDigest, 0)
	for rows.Next() {
		var raw []byte
		if err := rows.Scan(&raw); err != nil {
			_ = file.Close()
			return FileManifest{}, nil, fmt.Errorf("domain %s scan: %w", item.Name, err)
		}
		data, id, err := normalizeRecord(raw, item, primaryKey, columnTypes)
		if err != nil {
			_ = file.Close()
			return FileManifest{}, nil, fmt.Errorf("domain %s record: %w", item.Name, err)
		}
		digest := SHA256Hex(data)
		envelope := RecordEnvelope{Domain: item.Name, ID: id,
			CanonicalizationVersion: CanonicalizationVersion, DigestAlgorithm: DigestAlgorithmVersion,
			Digest: digest, Data: data}
		line, err := MarshalCanonical(envelope)
		if err != nil {
			_ = file.Close()
			return FileManifest{}, nil, fmt.Errorf("domain %s envelope: %w", item.Name, err)
		}
		if _, err := writer.Write(append(line, '\n')); err != nil {
			_ = file.Close()
			return FileManifest{}, nil, fmt.Errorf("domain %s write: %w", item.Name, err)
		}
		digests = append(digests, RecordDigest{Domain: item.Name, ID: id,
			CanonicalizationVersion: CanonicalizationVersion, DigestAlgorithm: DigestAlgorithmVersion, Digest: digest})
		count++
	}
	if err := rows.Err(); err != nil {
		_ = file.Close()
		return FileManifest{}, nil, fmt.Errorf("domain %s rows: %w", item.Name, err)
	}
	if err := writer.Flush(); err != nil {
		_ = file.Close()
		return FileManifest{}, nil, fmt.Errorf("domain %s flush: %w", item.Name, err)
	}
	if err := file.Close(); err != nil {
		return FileManifest{}, nil, fmt.Errorf("domain %s close: %w", item.Name, err)
	}
	content := hasher.Bytes()
	return FileManifest{Domain: item.Name, Path: relative, Records: count, Bytes: int64(len(content)), SHA256: SHA256Hex(content)}, digests, nil
}

func normalizeRecord(raw []byte, item Domain, primaryKey []string, columnTypes map[string]string) (json.RawMessage, json.RawMessage, error) {
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	var record map[string]any
	if err := decoder.Decode(&record); err != nil {
		return nil, nil, err
	}
	for _, column := range item.ExcludedColumns {
		delete(record, column)
	}
	for source, target := range item.RenameColumns {
		if value, exists := record[source]; exists {
			record[target] = value
			delete(record, source)
		}
	}
	for column, paths := range item.JSONSecretPaths {
		for _, path := range paths {
			removeJSONPath(record[column], path)
		}
	}
	for column, dataType := range columnTypes {
		if dataType != "timestamp with time zone" {
			continue
		}
		normalizedColumn := column
		if renamed, exists := item.RenameColumns[column]; exists {
			normalizedColumn = renamed
		}
		value, ok := record[normalizedColumn].(string)
		if !ok {
			continue
		}
		parsed, err := time.Parse(time.RFC3339Nano, value)
		if err != nil {
			return nil, nil, fmt.Errorf("normalize %s timestamp %q: %w", column, value, err)
		}
		record[normalizedColumn] = parsed.UTC().Format(time.RFC3339Nano)
	}
	idValue := any(nil)
	if len(primaryKey) == 1 {
		var exists bool
		idValue, exists = record[primaryKey[0]]
		if !exists {
			return nil, nil, fmt.Errorf("primary key %s excluded or absent", primaryKey[0])
		}
	} else {
		composite := make(map[string]any, len(primaryKey))
		for _, column := range primaryKey {
			value, exists := record[column]
			if !exists {
				return nil, nil, fmt.Errorf("primary key %s excluded or absent", column)
			}
			composite[column] = value
		}
		idValue = composite
	}
	data, err := MarshalCanonical(record)
	if err != nil {
		return nil, nil, err
	}
	id, err := MarshalCanonical(idValue)
	if err != nil {
		return nil, nil, err
	}
	return json.RawMessage(data), json.RawMessage(id), nil
}

func removeJSONPath(value any, path []string) {
	if len(path) == 0 {
		return
	}
	object, ok := value.(map[string]any)
	if !ok {
		return
	}
	if len(path) == 1 {
		delete(object, path[0])
		return
	}
	removeJSONPath(object[path[0]], path[1:])
}

func primaryKeyColumns(ctx context.Context, tx pgx.Tx, table string) ([]string, error) {
	rows, err := tx.Query(ctx, `SELECT a.attname FROM pg_index i JOIN pg_class c ON c.oid=i.indrelid JOIN pg_namespace n ON n.oid=c.relnamespace JOIN LATERAL unnest(i.indkey) WITH ORDINALITY keys(attnum,ord) ON true JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum=keys.attnum WHERE n.nspname='public' AND c.relname=$1 AND i.indisprimary ORDER BY keys.ord`, table)
	if err != nil {
		return nil, fmt.Errorf("domain %s primary key: %w", table, err)
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var column string
		if err := rows.Scan(&column); err != nil {
			return nil, err
		}
		out = append(out, column)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, nil
}

func tableColumnTypes(ctx context.Context, tx pgx.Tx, table string) (map[string]string, error) {
	rows, err := tx.Query(ctx, `SELECT column_name,data_type FROM information_schema.columns WHERE table_schema='public' AND table_name=$1`, table)
	if err != nil {
		return nil, fmt.Errorf("domain %s columns: %w", table, err)
	}
	defer rows.Close()
	out := make(map[string]string)
	for rows.Next() {
		var column, dataType string
		if err := rows.Scan(&column, &dataType); err != nil {
			return nil, err
		}
		out[column] = dataType
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if len(out) == 0 {
		return nil, fmt.Errorf("domain %s: table does not exist in public schema", table)
	}
	return out, nil
}

func writeCanonicalFile(root, relative string, value any) (FileManifest, error) {
	content, err := MarshalCanonical(value)
	if err != nil {
		return FileManifest{}, fmt.Errorf("encode %s: %w", relative, err)
	}
	content = append(content, '\n')
	path := filepath.Join(root, filepath.FromSlash(relative))
	if err := os.WriteFile(path, content, 0o600); err != nil {
		return FileManifest{}, fmt.Errorf("write %s: %w", relative, err)
	}
	return FileManifest{Path: relative, Records: 1, Bytes: int64(len(content)), SHA256: SHA256Hex(content)}, nil
}

type fkDescription struct {
	name, fromTable, toTable string
	fromFields, toFields     []string
	required                 bool
}

func referenceChecks(ctx context.Context, tx pgx.Tx) ([]ReferenceCheck, error) {
	rows, err := tx.Query(ctx, `SELECT c.conname,child.relname,array_agg(ca.attname ORDER BY keys.ord),parent.relname,array_agg(pa.attname ORDER BY keys.ord),bool_and(ca.attnotnull) FROM pg_constraint c JOIN pg_class child ON child.oid=c.conrelid JOIN pg_namespace ns ON ns.oid=child.relnamespace JOIN pg_class parent ON parent.oid=c.confrelid CROSS JOIN LATERAL unnest(c.conkey,c.confkey) WITH ORDINALITY keys(child_att,parent_att,ord) JOIN pg_attribute ca ON ca.attrelid=child.oid AND ca.attnum=keys.child_att JOIN pg_attribute pa ON pa.attrelid=parent.oid AND pa.attnum=keys.parent_att WHERE c.contype='f' AND ns.nspname='public' GROUP BY c.conname,child.relname,parent.relname ORDER BY child.relname,c.conname`)
	if err != nil {
		return nil, fmt.Errorf("reference registry: %w", err)
	}
	registered := domainByTable()
	var descriptions []fkDescription
	for rows.Next() {
		var item fkDescription
		if err := rows.Scan(&item.name, &item.fromTable, &item.fromFields, &item.toTable, &item.toFields, &item.required); err != nil {
			rows.Close()
			return nil, err
		}
		if _, fromOK := registered[item.fromTable]; fromOK {
			if _, toOK := registered[item.toTable]; toOK {
				descriptions = append(descriptions, item)
			}
		}
	}
	rows.Close()
	out := make([]ReferenceCheck, 0, len(descriptions)+8)
	for _, item := range descriptions {
		check, err := executeReferenceCheck(ctx, tx, item, registered[item.fromTable], registered[item.toTable])
		if err != nil {
			return nil, err
		}
		out = append(out, check)
	}
	semantic, err := semanticReferenceChecks(ctx, tx)
	if err != nil {
		return nil, err
	}
	out = append(out, semantic...)
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out, nil
}

func executeReferenceCheck(ctx context.Context, tx pgx.Tx, item fkDescription, fromDomain, toDomain string) (ReferenceCheck, error) {
	fromTable := pgx.Identifier{item.fromTable}.Sanitize()
	toTable := pgx.Identifier{item.toTable}.Sanitize()
	nonnull := make([]string, len(item.fromFields))
	joins := make([]string, len(item.fromFields))
	for index := range item.fromFields {
		from := pgx.Identifier{item.fromFields[index]}.Sanitize()
		to := pgx.Identifier{item.toFields[index]}.Sanitize()
		nonnull[index] = "f." + from + " IS NOT NULL"
		joins[index] = "f." + from + "=t." + to
	}
	query := fmt.Sprintf(`SELECT COUNT(*) FILTER(WHERE %s),COUNT(*) FILTER(WHERE %s AND t.%s IS NOT NULL) FROM %s f LEFT JOIN %s t ON %s`, strings.Join(nonnull, " AND "), strings.Join(nonnull, " AND "), pgx.Identifier{item.toFields[0]}.Sanitize(), fromTable, toTable, strings.Join(joins, " AND "))
	var populated, resolved int64
	if err := tx.QueryRow(ctx, query).Scan(&populated, &resolved); err != nil {
		return ReferenceCheck{}, fmt.Errorf("reference %s: %w", item.name, err)
	}
	return ReferenceCheck{Name: item.name, FromDomain: fromDomain, FromFields: item.fromFields,
		ToDomain: toDomain, ToFields: item.toFields, Required: item.required,
		PopulatedCount: populated, ResolvedCount: resolved, DanglingCount: populated - resolved}, nil
}

func semanticReferenceChecks(ctx context.Context, tx pgx.Tx) ([]ReferenceCheck, error) {
	type semantic struct {
		name, from, field, to, toField, predicate string
		required                                  bool
	}
	items := []semantic{{"media_files_current_transcript_version", "media_files", "current_transcript_version_id", "transcript_versions", "id", "", false}}
	for _, from := range []string{"photos", "media_files"} {
		for ownerType, to := range map[string]string{"apiary": "apiaries", "hive": "hives", "inspection": "inspections"} {
			items = append(items, semantic{from + "_owner_" + ownerType, from, "owner_id", to, "id", "f.owner_type=" + quoteLiteral(ownerType), true})
		}
	}
	for entityType, to := range map[string]string{
		"sale": "sales", "sale_item": "sale_items", "expense": "expenses", "customer": "customers", "harvest_lot": "harvest_lots", "jar_size": "jar_sizes", "honey_movement": "honey_movements", "bottling_run": "bottling_runs", "stock_location": "stock_locations", "stock_movement": "stock_movements", "consignment_settlement": "consignment_settlements", "hive": "hives", "equipment_stock": "equipment_stock", "equipment_stock_adjustment": "equipment_stock_adjustments", "product_catalog": "product_catalog", "product_batch": "product_batches", "product_adjustment": "product_adjustments",
	} {
		items = append(items, semantic{"external_sync_entity_" + entityType, "external_sync", "entity_id", to, "id", "f.entity_type=" + quoteLiteral(entityType), true})
	}
	sort.Slice(items, func(i, j int) bool { return items[i].name < items[j].name })
	out := make([]ReferenceCheck, 0, len(items))
	for _, item := range items {
		predicate := item.predicate
		if predicate == "" {
			predicate = "TRUE"
		}
		query := fmt.Sprintf(`SELECT COUNT(*) FILTER(WHERE %s AND f.%s IS NOT NULL),COUNT(*) FILTER(WHERE %s AND f.%s IS NOT NULL AND t.%s IS NOT NULL) FROM %s f LEFT JOIN %s t ON f.%s=t.%s`, predicate, pgx.Identifier{item.field}.Sanitize(), predicate, pgx.Identifier{item.field}.Sanitize(), pgx.Identifier{item.toField}.Sanitize(), pgx.Identifier{item.from}.Sanitize(), pgx.Identifier{item.to}.Sanitize(), pgx.Identifier{item.field}.Sanitize(), pgx.Identifier{item.toField}.Sanitize())
		var populated, resolved int64
		if err := tx.QueryRow(ctx, query).Scan(&populated, &resolved); err != nil {
			return nil, fmt.Errorf("semantic reference %s: %w", item.name, err)
		}
		out = append(out, ReferenceCheck{Name: item.name, FromDomain: item.from, FromFields: []string{item.field}, ToDomain: item.to, ToFields: []string{item.toField}, Required: item.required, PopulatedCount: populated, ResolvedCount: resolved, DanglingCount: populated - resolved})
	}
	return out, nil
}

func quoteLiteral(value string) string { return "'" + strings.ReplaceAll(value, "'", "''") + "'" }

func collectMedia(ctx context.Context, tx pgx.Tx, options ExportOptions) (MediaManifest, []MediaVerification, error) {
	// apiaries.satellite_image_key was dropped by migration 00032 (Leaflet
	// tiles replaced the stored satellite overlay); apiary map imagery is
	// deliberately not part of the restoration boundary.
	objects := make([]MediaObject, 0)
	rows, err := tx.Query(ctx, `SELECT id::text,owner_type::text,owner_id::text,storage_backend::text,original_ref,original_external,thumbnail_key,medium_key FROM photos ORDER BY id`)
	if err != nil {
		return MediaManifest{}, nil, fmt.Errorf("media photos: %w", err)
	}
	for rows.Next() {
		var id, ownerType, ownerID, backend, ref string
		var external bool
		var thumbnail, medium *string
		if err := rows.Scan(&id, &ownerType, &ownerID, &backend, &ref, &external, &thumbnail, &medium); err != nil {
			rows.Close()
			return MediaManifest{}, nil, err
		}
		derived := nonNilStrings(thumbnail, medium)
		disposition := "external-reference"
		if external || backend == "immich" {
			disposition = "external-original-reference"
		}
		object := MediaObject{RecordDomain: "photos", RecordID: id, OwnerDomain: ownerType, OwnerID: ownerID, MediaType: "image", OriginalFilename: filepath.Base(ref), Role: "original", StorageBackend: backend, Disposition: disposition, Reference: ref, Required: true, HashState: "unhashed", DerivedRenditions: derived}
		hashMediaObject(ctx, options, &object)
		objects = append(objects, object)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return MediaManifest{}, nil, err
	}
	rows.Close()
	rows, err = tx.Query(ctx, `SELECT id::text,owner_type::text,owner_id::text,audio_key FROM media_files ORDER BY id`)
	if err != nil {
		return MediaManifest{}, nil, fmt.Errorf("media audio: %w", err)
	}
	for rows.Next() {
		var id, ownerType, ownerID, ref string
		if err := rows.Scan(&id, &ownerType, &ownerID, &ref); err != nil {
			rows.Close()
			return MediaManifest{}, nil, err
		}
		object := MediaObject{RecordDomain: "media_files", RecordID: id, OwnerDomain: ownerType, OwnerID: ownerID, MediaType: "audio", OriginalFilename: filepath.Base(ref), Role: "original", StorageBackend: "minio", Disposition: "external-reference", Reference: ref, Required: true, HashState: "unhashed"}
		hashMediaObject(ctx, options, &object)
		objects = append(objects, object)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return MediaManifest{}, nil, err
	}
	rows.Close()
	sort.Slice(objects, func(i, j int) bool {
		if objects[i].RecordDomain != objects[j].RecordDomain {
			return objects[i].RecordDomain < objects[j].RecordDomain
		}
		return objects[i].RecordID < objects[j].RecordID
	})
	verification := make([]MediaVerification, 0, len(objects))
	for _, object := range objects {
		verification = append(verification, MediaVerification{RecordDomain: object.RecordDomain, RecordID: object.RecordID, OwnerDomain: object.OwnerDomain, OwnerID: object.OwnerID, Reference: object.Reference, HashState: object.HashState, SHA256: object.SHA256, Bytes: object.Bytes})
	}
	return MediaManifest{Version: MediaManifestVersion, Objects: objects}, verification, nil
}

func hashMediaObject(ctx context.Context, options ExportOptions, object *MediaObject) {
	if object.StorageBackend != "minio" || !options.HashMinIO {
		if object.StorageBackend != "minio" {
			object.HashState = "external-unverified"
		}
		return
	}
	size, digest, err := options.ObjectHasher.Hash(ctx, object.Reference)
	if err != nil {
		object.HashState = "missing-or-unreadable"
		object.OmissionReason = err.Error()
		return
	}
	object.Bytes, object.SHA256, object.HashState = size, digest, "verified"
}

func nonNilStrings(values ...*string) []string {
	var out []string
	for _, value := range values {
		if value != nil && *value != "" {
			out = append(out, *value)
		}
	}
	return out
}
