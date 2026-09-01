package app

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"sort"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

// PortableRecord is the table-independent record shape carried by the
// snapshot envelope. ID may be a scalar UUID or a composite-key object.
type PortableRecord struct {
	Domain string
	Table  string
	ID     json.RawMessage
	Data   json.RawMessage
}

// PortableRepository is a restore repository for one registered snapshot
// domain. Its schema description is read from the migrated target, while its
// input remains the portable domain record rather than an HTTP DTO.
type PortableRepository struct {
	domain      string
	table       string
	primaryKey  []string
	columns     map[string]portableColumn
	timestamps  map[string]bool
	generated   map[string]bool
	excluded    map[string]bool
	renameInput map[string]string
}

type portableColumn struct {
	Name       string
	DataType   string
	Nullable   bool
	HasDefault bool
}

// NewPortableRepository binds a registered domain to the migrated schema.
// It is intentionally constructed inside the restore transaction so schema
// introspection and writes see exactly the same migration state.
func NewPortableRepository(ctx context.Context, uow *UnitOfWork, domain, table string, excluded []string, renames map[string]string) (*PortableRepository, error) {
	op := "restore " + domain
	if err := uow.Actor().requirePreservedAudit(op); err != nil {
		return nil, err
	}
	repo := &PortableRepository{
		domain: domain, table: table, columns: map[string]portableColumn{},
		timestamps: map[string]bool{}, generated: map[string]bool{},
		excluded: map[string]bool{}, renameInput: map[string]string{},
	}
	for _, column := range excluded {
		repo.excluded[column] = true
	}
	// Registry renames are source-column -> portable-field. Import reverses it.
	for source, portable := range renames {
		repo.renameInput[portable] = source
	}
	rows, err := uow.Query(ctx, `
		SELECT column_name, data_type, is_nullable='YES', column_default IS NOT NULL,
		       is_generated='ALWAYS'
		FROM information_schema.columns
		WHERE table_schema='public' AND table_name=$1
		ORDER BY ordinal_position`, table)
	if err != nil {
		return nil, classifyPg(op, err)
	}
	for rows.Next() {
		var c portableColumn
		var generated bool
		if err := rows.Scan(&c.Name, &c.DataType, &c.Nullable, &c.HasDefault, &generated); err != nil {
			rows.Close()
			return nil, classifyPg(op, err)
		}
		repo.columns[c.Name] = c
		repo.timestamps[c.Name] = c.DataType == "timestamp with time zone"
		repo.generated[c.Name] = generated
	}
	if err := rows.Err(); err != nil {
		return nil, classifyPg(op, err)
	}
	rows.Close()
	if len(repo.columns) == 0 {
		return nil, Unsupported(op, "registered table %q is absent from the migrated target", table)
	}
	rows, err = uow.Query(ctx, `
		SELECT a.attname
		FROM pg_index i JOIN pg_class c ON c.oid=i.indrelid
		JOIN pg_namespace n ON n.oid=c.relnamespace
		JOIN LATERAL unnest(i.indkey) WITH ORDINALITY k(attnum,ord) ON true
		JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum=k.attnum
		WHERE n.nspname='public' AND c.relname=$1 AND i.indisprimary
		ORDER BY k.ord`, table)
	if err != nil {
		return nil, classifyPg(op, err)
	}
	for rows.Next() {
		var column string
		if err := rows.Scan(&column); err != nil {
			rows.Close()
			return nil, classifyPg(op, err)
		}
		repo.primaryKey = append(repo.primaryKey, column)
	}
	rows.Close()
	if len(repo.primaryKey) == 0 {
		return nil, Unsupported(op, "registered table has no primary key")
	}
	return repo, nil
}

// Restore applies one portable record under the shared conflict semantics.
func (r *PortableRepository) Restore(ctx context.Context, uow *UnitOfWork, record PortableRecord, opts RestoreOptions) (Outcome, error) {
	op := "restore " + r.domain
	if err := uow.Actor().requirePreservedAudit(op); err != nil {
		return OutcomeFailed, err
	}
	data, id, err := r.validate(record)
	if err != nil {
		return OutcomeFailed, err
	}
	stored, found, err := r.load(ctx, uow, id)
	if err != nil {
		return OutcomeFailed, err
	}
	if found {
		equal, err := r.equal(stored, data)
		if err != nil {
			return OutcomeFailed, err
		}
		if equal {
			return OutcomeUnchanged, nil
		}
		switch opts.OnConflict {
		case ConflictSkip:
			return OutcomeSkipped, nil
		case ConflictOverwrite:
			if uow.DryRun() {
				return OutcomeUpdated, nil
			}
			if err := r.overwrite(ctx, uow, data, id); err != nil {
				return OutcomeFailed, err
			}
			return OutcomeUpdated, nil
		default:
			return OutcomeConflicted, Conflict(op, "%s %s already exists with different content; choose a conflict policy", r.domain, string(record.ID))
		}
	}
	if uow.DryRun() {
		return OutcomeCreated, nil
	}
	if err := r.insert(ctx, uow, data); err != nil {
		return OutcomeFailed, err
	}
	return OutcomeCreated, nil
}

func (r *PortableRepository) validate(record PortableRecord) (map[string]any, map[string]json.RawMessage, error) {
	op := "restore " + r.domain
	if record.Domain != r.domain || record.Table != r.table {
		return nil, nil, Invalid(op, "record domain/table does not match repository")
	}
	var data map[string]any
	decoder := json.NewDecoder(bytes.NewReader(record.Data))
	decoder.UseNumber()
	if err := decoder.Decode(&data); err != nil || data == nil {
		return nil, nil, Invalid(op, "data must be one JSON object")
	}
	id, err := decodePortableID(record.ID, r.primaryKey)
	if err != nil {
		return nil, nil, Invalid(op, "%v", err).WithField("id")
	}
	for portable, source := range r.renameInput {
		if value, ok := data[portable]; ok {
			data[source] = value
			delete(data, portable)
		}
	}
	for column := range data {
		if _, ok := r.columns[column]; !ok {
			return nil, nil, Invalid(op, "unknown field %q", column).WithField(column)
		}
		if r.excluded[column] {
			return nil, nil, Invalid(op, "excluded configuration field %q is present", column).WithField(column)
		}
	}
	for column, rawID := range id {
		value, exists := data[column]
		if !exists {
			return nil, nil, Invalid(op, "primary-key field %q is absent from data", column).WithField(column)
		}
		actual, _ := json.Marshal(value)
		left, leftErr := canonicalJSON(actual)
		right, rightErr := canonicalJSON(rawID)
		if leftErr != nil || rightErr != nil || left != right {
			return nil, nil, Invalid(op, "preserved id disagrees with data field %q", column).WithField(column)
		}
	}
	// Credentials never become active as an import side effect.
	if r.domain == "gnucash_sync_settings" {
		data["sync_enabled"] = false
		delete(data, "api_token")
	}
	return data, id, nil
}

func decodePortableID(raw json.RawMessage, primaryKey []string) (map[string]json.RawMessage, error) {
	if len(primaryKey) == 1 {
		if len(bytes.TrimSpace(raw)) == 0 || bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
			return nil, fmt.Errorf("preserved id is required")
		}
		return map[string]json.RawMessage{primaryKey[0]: append(json.RawMessage(nil), raw...)}, nil
	}
	var object map[string]json.RawMessage
	if err := json.Unmarshal(raw, &object); err != nil {
		return nil, fmt.Errorf("composite preserved id must be an object")
	}
	if len(object) != len(primaryKey) {
		return nil, fmt.Errorf("composite preserved id has %d fields, expected %d", len(object), len(primaryKey))
	}
	for _, column := range primaryKey {
		if len(object[column]) == 0 || bytes.Equal(bytes.TrimSpace(object[column]), []byte("null")) {
			return nil, fmt.Errorf("composite preserved id lacks %q", column)
		}
	}
	return object, nil
}

func (r *PortableRepository) load(ctx context.Context, uow *UnitOfWork, id map[string]json.RawMessage) ([]byte, bool, error) {
	where, args := r.whereID(id, 1)
	query := fmt.Sprintf("SELECT to_jsonb(t) FROM %s t WHERE %s", pgx.Identifier{r.table}.Sanitize(), where)
	var raw []byte
	found, err := loadOne("restore "+r.domain, func() error { return uow.QueryRow(ctx, query, args...).Scan(&raw) })
	return raw, found, err
}

func (r *PortableRepository) equal(stored []byte, incoming map[string]any) (bool, error) {
	var object map[string]any
	decoder := json.NewDecoder(bytes.NewReader(stored))
	decoder.UseNumber()
	if err := decoder.Decode(&object); err != nil {
		return false, Internal("restore "+r.domain, err)
	}
	r.normalizeStored(object)
	incomingRaw, _ := json.Marshal(incoming)
	storedRaw, _ := json.Marshal(object)
	left, err := canonicalJSON(storedRaw)
	if err != nil {
		return false, Internal("restore "+r.domain, err)
	}
	right, err := canonicalJSON(incomingRaw)
	if err != nil {
		return false, Invalid("restore "+r.domain, "record is not canonicalizable")
	}
	return left == right, nil
}

func (r *PortableRepository) normalizeStored(data map[string]any) {
	for column := range r.excluded {
		delete(data, column)
	}
	for portable, source := range r.renameInput {
		if value, ok := data[source]; ok {
			data[portable] = value
			delete(data, source)
		}
	}
	// Match exporter timestamp normalization exactly.
	for source := range r.timestamps {
		field := source
		for portable, original := range r.renameInput {
			if original == source {
				field = portable
			}
		}
		value, ok := data[field].(string)
		if !ok {
			continue
		}
		if parsed, err := time.Parse(time.RFC3339Nano, value); err == nil {
			data[field] = parsed.UTC().Format(time.RFC3339Nano)
		}
	}
	if r.domain == "user_settings" {
		removeNested(data["ai_provider_config"], []string{"apiKeys", "anthropic"})
		removeNested(data["ai_provider_config"], []string{"apiKeys", "google"})
	}
	if r.domain == "gnucash_sync_settings" {
		data["sync_enabled"] = false
	}
}

func removeNested(value any, path []string) {
	object, ok := value.(map[string]any)
	if !ok || len(path) == 0 {
		return
	}
	if len(path) == 1 {
		delete(object, path[0])
		return
	}
	removeNested(object[path[0]], path[1:])
}

func (r *PortableRepository) insert(ctx context.Context, uow *UnitOfWork, data map[string]any) error {
	op := "restore " + r.domain
	insertData := cloneObject(data)
	if r.domain == "equipment_stock" {
		insertData["total_owned"] = json.Number("0")
		insertData["damaged_quantity"] = json.Number("0")
		insertData["retired_quantity"] = json.Number("0")
	}
	columns := r.writableColumns(insertData, false)
	if len(columns) == 0 {
		return Invalid(op, "record has no writable fields")
	}
	raw, _ := json.Marshal(insertData)
	quoted := quoteColumns(columns)
	selects := make([]string, len(columns))
	for i, column := range columns {
		selects[i] = "r." + pgx.Identifier{column}.Sanitize()
	}
	query := fmt.Sprintf("INSERT INTO %s (%s) SELECT %s FROM jsonb_populate_record(NULL::%s,$1::jsonb) r ON CONFLICT (%s) DO NOTHING",
		pgx.Identifier{r.table}.Sanitize(), strings.Join(quoted, ","), strings.Join(selects, ","),
		pgx.Identifier{r.table}.Sanitize(), strings.Join(quoteColumns(r.primaryKey), ","))
	return insertPreserved(ctx, uow, op, query, raw)
}

func (r *PortableRepository) overwrite(ctx context.Context, uow *UnitOfWork, data map[string]any, id map[string]json.RawMessage) error {
	columns := r.writableColumns(data, true)
	assignments := make([]string, 0, len(columns))
	for _, column := range columns {
		assignments = append(assignments, fmt.Sprintf("%s=r.%s", pgx.Identifier{column}.Sanitize(), pgx.Identifier{column}.Sanitize()))
	}
	raw, _ := json.Marshal(data)
	where, args := r.whereID(id, 2)
	query := fmt.Sprintf("UPDATE %s t SET %s FROM jsonb_populate_record(NULL::%s,$1::jsonb) r WHERE %s",
		pgx.Identifier{r.table}.Sanitize(), strings.Join(assignments, ","), pgx.Identifier{r.table}.Sanitize(), where)
	allArgs := append([]any{raw}, args...)
	tag, err := uow.Exec(ctx, query, allArgs...)
	if err != nil {
		return classifyPg("restore "+r.domain, err)
	}
	if tag.RowsAffected() != 1 {
		return NotFound("restore "+r.domain, "record disappeared mid-restore")
	}
	return nil
}

func (r *PortableRepository) writableColumns(data map[string]any, overwrite bool) []string {
	pk := map[string]bool{}
	for _, column := range r.primaryKey {
		pk[column] = true
	}
	columns := make([]string, 0, len(data))
	for column := range data {
		if r.generated[column] || r.excluded[column] || (overwrite && (pk[column] || column == "updated_at")) {
			continue
		}
		columns = append(columns, column)
	}
	sort.Strings(columns)
	return columns
}

func (r *PortableRepository) whereID(id map[string]json.RawMessage, firstArg int) (string, []any) {
	parts := make([]string, 0, len(r.primaryKey))
	args := make([]any, 0, len(r.primaryKey))
	for index, column := range r.primaryKey {
		parts = append(parts, fmt.Sprintf("to_jsonb(t.%s)=$%d::jsonb", pgx.Identifier{column}.Sanitize(), firstArg+index))
		args = append(args, []byte(id[column]))
	}
	return strings.Join(parts, " AND "), args
}

func quoteColumns(columns []string) []string {
	out := make([]string, len(columns))
	for i, column := range columns {
		out[i] = pgx.Identifier{column}.Sanitize()
	}
	return out
}

func cloneObject(input map[string]any) map[string]any {
	out := make(map[string]any, len(input))
	for key, value := range input {
		out[key] = value
	}
	return out
}

// SeededRowsYieldToSnapshot removes migration seed identities inside the
// restore transaction. It must run before any snapshot row is inserted.
func SeededRowsYieldToSnapshot(ctx context.Context, uow *UnitOfWork) error {
	if err := uow.Actor().requirePreservedAudit("restore seeds"); err != nil {
		return err
	}
	if uow.DryRun() {
		return nil
	}
	if _, err := uow.Exec(ctx, `DELETE FROM stock_locations WHERE slug='home'`); err != nil {
		return classifyPg("restore stock location seed", err)
	}
	if _, err := uow.Exec(ctx, `DELETE FROM treatment_products`); err != nil {
		return classifyPg("restore treatment product seeds", err)
	}
	return nil
}
