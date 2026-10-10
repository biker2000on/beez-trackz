package httpapi

import (
	"encoding/base64"
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/biker2000on/beez-trackz/backend/internal/app/production"
	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
)

// The stock movement ledger (Stock › Movements): the same rows as
// /honey/timeline (signed inventory operations on bulk honey and jars, plus
// sales) behind keyset pagination, so the page can scroll the whole ledger
// instead of a capped list.
//
// The interaction model is borrowed from the Folio account ledger: a stable
// order, a cursor per page, and sorting and filters applied on the server so
// every page is a page of the sorted, filtered ledger rather than a sort or
// filter over whatever happened to be loaded.

func (s *Server) mountHoneyActivity(r chi.Router) {
	admin := r.With(s.requireAdmin)
	admin.Get("/honey/activity", s.honeyActivityHandler)
	admin.Get("/honey/activity/facets", s.honeyActivityFacetsHandler)
}

const (
	honeyActivityDefaultLimit = 50
	honeyActivityMaxLimit     = 200
	// honeyActivityBulkItemKey is the ?item= value for bulk honey; jar sizes
	// are "jar:<jar size id>".
	honeyActivityBulkItemKey = "bulk"
	honeyActivityJarItemKey  = "jar:"
)

// honeyActivityTypes are the values ?type= accepts — the wire types the
// timeline has always emitted.
var honeyActivityTypes = map[string]bool{
	"jarring": true, "sale": true, "bulk_use": true, "loss": true,
	"give_away": true, "jar_adjustment": true, "receipt": true,
}

// honeyActivitySortSpec is one ?sort= value: the feed column it orders by and
// the SQL type its cursor key is compared as.
type honeyActivitySortSpec struct {
	column string
	cast   string
}

// honeyActivitySorts are the values ?sort= accepts. Every order is tie-broken
// by id in the same direction, so (key, id) is a total order and a keyset
// cursor on it never skips or repeats a row.
var honeyActivitySorts = map[string]honeyActivitySortSpec{
	"date":     {column: "occurred_at", cast: "timestamptz"},
	"quantity": {column: "qty_sort", cast: "float8"},
	"type":     {column: "type_sort", cast: "text"},
	"item":     {column: "item_sort", cast: "text"},
}

const (
	honeyActivityDefaultSort = "date"
	honeyActivityDefaultDir  = "desc"
)

// honeyActivityEntry is a timeline row plus the columns the movement ledger
// sorts and filters by. The embedded entry keeps the timeline's JSON shape.
type honeyActivityEntry struct {
	honeyTimelineEntry
	// Item is the jar size (or "Bulk honey"; a sale's first line);
	// ItemCount is how many distinct items the row touched.
	Item      string `json:"item"`
	ItemCount int    `json:"itemCount"`
	// Varietal and LotCode name the first harvest lot the row drew on;
	// LotCount is how many distinct lots it touched.
	Varietal *string `json:"varietal"`
	LotCode  *string `json:"lotCode"`
	LotCount int     `json:"lotCount"`
	// FromLocation is where stock left, ToLocation where it arrived (for a
	// sale: the venue).
	FromLocation *string `json:"fromLocation"`
	ToLocation   *string `json:"toLocation"`
	// Qty is the signed stock change the quantity sort orders by: jars when
	// the row moved jars, else pounds of bulk honey; a sale's items leave
	// stock, so its Qty is negative. QtyUnit is "jars", "lbs", "items" or "".
	Qty     float64 `json:"qty"`
	QtyUnit string  `json:"qtyUnit"`
}

type honeyActivityPage struct {
	Entries []honeyActivityEntry `json:"entries"`
	// NextCursor is null on the last page.
	NextCursor *string `json:"nextCursor"`
}

// honeyActivityCursor is the keyset position of the last row of a page under
// one sort: the row's sort key (formatted as text) and its id. A cursor only
// continues the sort it was made for.
type honeyActivityCursor struct {
	Sort string
	Dir  string
	Key  string
	ID   uuid.UUID
}

func encodeHoneyActivityCursor(c honeyActivityCursor) string {
	// The key goes last: a text key may itself contain "|".
	raw := c.Sort + "|" + c.Dir + "|" + c.ID.String() + "|" + c.Key
	return base64.RawURLEncoding.EncodeToString([]byte(raw))
}

func decodeHoneyActivityCursor(value string) (honeyActivityCursor, error) {
	invalid := errors.New("invalid cursor")
	raw, err := base64.RawURLEncoding.DecodeString(value)
	if err != nil {
		return honeyActivityCursor{}, invalid
	}
	parts := strings.SplitN(string(raw), "|", 4)
	if len(parts) != 4 {
		return honeyActivityCursor{}, invalid
	}
	cursor := honeyActivityCursor{Sort: parts[0], Dir: parts[1], Key: parts[3]}
	if _, ok := honeyActivitySorts[cursor.Sort]; !ok {
		return honeyActivityCursor{}, invalid
	}
	if cursor.Dir != "asc" && cursor.Dir != "desc" {
		return honeyActivityCursor{}, invalid
	}
	if cursor.ID, err = uuid.Parse(parts[2]); err != nil {
		return honeyActivityCursor{}, invalid
	}
	if _, err := honeyActivityCursorKey(cursor.Sort, cursor.Key); err != nil {
		return honeyActivityCursor{}, invalid
	}
	return cursor, nil
}

// honeyActivityCursorKey parses a cursor's text key into the Go value bound
// to the sort column's SQL type.
func honeyActivityCursorKey(sort, key string) (any, error) {
	switch honeyActivitySorts[sort].cast {
	case "timestamptz":
		return time.Parse(time.RFC3339Nano, key)
	case "float8":
		return strconv.ParseFloat(key, 64)
	default:
		return key, nil
	}
}

// honeyActivityZeroKey is the placeholder bound when there is no cursor; it
// only has to have the right type.
func honeyActivityZeroKey(sort string) any {
	switch honeyActivitySorts[sort].cast {
	case "timestamptz":
		return time.Time{}
	case "float8":
		return float64(0)
	default:
		return ""
	}
}

// parseHoneyActivitySort reads ?sort= and ?dir=, defaulting to newest first.
func parseHoneyActivitySort(sort, dir string) (string, string, error) {
	sort = strings.TrimSpace(sort)
	dir = strings.ToLower(strings.TrimSpace(dir))
	if sort == "" {
		sort = honeyActivityDefaultSort
	}
	if _, ok := honeyActivitySorts[sort]; !ok {
		return "", "", fmt.Errorf("unknown sort %q", sort)
	}
	switch dir {
	case "":
		if sort == honeyActivityDefaultSort {
			dir = honeyActivityDefaultDir
		} else {
			dir = "asc"
		}
	case "asc", "desc":
	default:
		return "", "", fmt.Errorf("unknown sort direction %q", dir)
	}
	return sort, dir, nil
}

// splitHoneyActivityList reads ?name=a,b (or repeated ?name=) into distinct,
// trimmed values, validating each. The result is never nil: a nil slice
// would reach Postgres as NULL and match nothing.
func splitHoneyActivityList(values []string, valid func(string) error) ([]string, error) {
	out := make([]string, 0)
	seen := map[string]bool{}
	for _, value := range values {
		for _, part := range strings.Split(value, ",") {
			part = strings.TrimSpace(part)
			if part == "" || seen[part] {
				continue
			}
			if err := valid(part); err != nil {
				return nil, err
			}
			seen[part] = true
			out = append(out, part)
		}
	}
	return out, nil
}

// parseHoneyActivityTypes reads ?type=a,b (or repeated ?type=). Unknown
// values are a 400 rather than silently matching nothing.
func parseHoneyActivityTypes(values []string) ([]string, error) {
	return splitHoneyActivityList(values, func(part string) error {
		if !honeyActivityTypes[part] {
			return fmt.Errorf("unknown activity type %q", part)
		}
		return nil
	})
}

// parseHoneyActivityItems reads ?item=: "bulk" or "jar:<jar size id>".
func parseHoneyActivityItems(values []string) ([]string, error) {
	return splitHoneyActivityList(values, func(part string) error {
		if part == honeyActivityBulkItemKey {
			return nil
		}
		if id, ok := strings.CutPrefix(part, honeyActivityJarItemKey); ok {
			if _, err := uuid.Parse(id); err == nil {
				return nil
			}
		}
		return fmt.Errorf("unknown item %q", part)
	})
}

// parseHoneyActivityIDs reads a list of uuids (?varietal=, ?location=),
// normalised to their canonical text so they compare with ::text ids.
func parseHoneyActivityIDs(name string, values []string) ([]string, error) {
	ids, err := splitHoneyActivityList(values, func(part string) error {
		if _, err := uuid.Parse(part); err != nil {
			return fmt.Errorf("invalid %s %q", name, part)
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	for i, id := range ids {
		ids[i] = uuid.MustParse(id).String()
	}
	return ids, nil
}

// honeyActivitySearchTerms splits ?q= into lower-cased terms; every term must
// appear somewhere in the row (the same rule as the DataGrid search box).
func honeyActivitySearchTerms(q string) []string {
	terms := strings.Fields(strings.ToLower(q))
	if len(terms) > 8 {
		terms = terms[:8]
	}
	return terms
}

// honeyActivityTypeSQL mirrors honeyTimelineDescribe so ?type= filters on the
// same type the row is labelled with. Keep the two in step.
const honeyActivityTypeSQL = `CASE
		WHEN kind = 'transform' AND jars <> 0 THEN 'jarring'
		WHEN kind = 'shrink' AND reason = 'give_away' THEN 'give_away'
		WHEN kind = 'count_adjust' AND jars <> 0 THEN 'jar_adjustment'
		WHEN kind = 'shrink' AND reason = 'loss' THEN 'loss'
		WHEN kind IN ('shrink', 'transform') THEN 'bulk_use'
		WHEN kind = 'sale_consume' THEN 'sale'
		WHEN kind IN ('receive', 'opening_balance') THEN 'receipt'
		ELSE kind
	END`

// honeyActivityTypeSortSQL orders types by the label the page shows (the
// frontend's KIND_STYLES), not by the wire value.
const honeyActivityTypeSortSQL = `CASE entry_type
		WHEN 'jar_adjustment' THEN 'adjustment'
		WHEN 'bulk_use' THEN 'bulk use'
		WHEN 'give_away' THEN 'give-away'
		ELSE entry_type
	END`

// honeyActivityLotSQL resolves one movement's lot to its harvest lot and
// varietal — directly for a harvest lot, through the bottling run for a
// product batch lot. At most one row per movement, so the aggregates over
// movements are not multiplied.
const honeyActivityLotSQL = `LEFT JOIN LATERAL (
			SELECT hl.id AS lot_id, hl.lot_code, hv.id AS varietal_id, hv.name AS varietal
			FROM inventory_lots lot
			JOIN harvest_lots hl ON hl.id = COALESCE(
			       CASE WHEN lot.source_type = 'harvest_lot' THEN lot.source_id END,
			       (SELECT pb.harvest_lot_id FROM product_batches pb
			        WHERE pb.inventory_lot_id = lot.id LIMIT 1))
			LEFT JOIN honey_varietals hv ON hv.id = hl.varietal_id
			WHERE lot.id = m.lot_id
		) lotinfo ON true`

// honeyActivityLotAggregates are the per-row lot and location aggregates
// shared by operation rows and a sale's stock consumption.
const honeyActivityLotAggregates = `
		       MIN(loc.name) FILTER (WHERE m.quantity < 0) AS from_location,
		       COALESCE(array_agg(DISTINCT m.location_id::text), '{}') AS location_keys,
		       MIN(lotinfo.varietal) AS varietal,
		       MIN(lotinfo.lot_code) AS lot_code,
		       COUNT(DISTINCT lotinfo.lot_id)::int AS lot_count,
		       COALESCE(array_agg(DISTINCT lotinfo.varietal_id::text)
		                FILTER (WHERE lotinfo.varietal_id IS NOT NULL), '{}') AS varietal_keys`

// honeyActivityFeedSQL is the merged feed as a CTE chain ending in `feed`.
// Operations whose source is a sale row are left out: the sale itself is the
// activity entry (with its total, customer and cancel action), and listing
// its stock consumption as a second "Sold …" row duplicated every sale — with
// a cancel button that could not work, because an operation id is not a sale
// id. The sale row borrows that consumption's locations and lots instead.
// Consignment settlements consume stock without a sale row, so they stay.
//
// $1 is the bulk honey item.
var honeyActivityFeedSQL = `
	WITH ops AS (
		SELECT o.id, o.occurred_at,
		       COALESCE(original.kind, o.kind) AS kind,
		       COALESCE(original.reason, o.reason) AS reason,
		       o.reverses_operation_id,
		       COALESCE(SUM(m.quantity) FILTER (WHERE m.item_id = $1), 0)::float8 AS bulk_lbs,
		       COALESCE(SUM(m.quantity) FILTER (WHERE i.kind = 'jar'), 0)::int AS jars,
		       MIN(js.label) FILTER (WHERE i.kind = 'jar') AS jar_label,
		       o.details ->> 'notes' AS notes,
		       COALESCE(original.details, o.details) ->> 'purpose' AS purpose,
		       COALESCE(bool_or(m.item_id = $1), false) AS has_bulk,
		       COUNT(DISTINCT js.id)::int AS jar_size_count,
		       COALESCE(array_agg(DISTINCT 'jar:' || js.id::text)
		                FILTER (WHERE js.id IS NOT NULL), '{}') AS jar_keys,
		       MIN(loc.name) FILTER (WHERE m.quantity > 0) AS to_location,` +
	honeyActivityLotAggregates + `
		FROM inventory_operations o
		LEFT JOIN inventory_operations original ON original.id = o.reverses_operation_id
		JOIN inventory_movements m ON m.operation_id = o.id
		JOIN inventory_items i ON i.id = m.item_id
		JOIN inventory_locations loc ON loc.id = m.location_id
		LEFT JOIN jar_sizes js ON js.item_id = i.id
		` + honeyActivityLotSQL + `
		WHERE (i.id = $1 OR i.kind = 'jar')
		  AND NOT (COALESCE(original.kind, o.kind) = 'sale_consume'
		           AND COALESCE(original.source_type, o.source_type) = 'sale')
		GROUP BY o.id, original.id
	),
	typed_ops AS (
		SELECT ops.*, ` + honeyActivityTypeSQL + ` AS entry_type,
		       COALESCE(jar_label, CASE WHEN has_bulk THEN 'Bulk honey' END, '') AS item_label,
		       jar_size_count + CASE WHEN has_bulk AND jar_size_count = 0 THEN 1 ELSE 0 END AS item_count,
		       jar_keys || CASE WHEN has_bulk THEN ARRAY['bulk'] ELSE '{}'::text[] END AS item_keys,
		       CASE WHEN jars <> 0 THEN jars::float8 ELSE bulk_lbs END AS qty_sort,
		       CASE WHEN jars <> 0 THEN 'jars' WHEN bulk_lbs <> 0 THEN 'lbs' ELSE '' END AS qty_unit
		FROM ops
	),
	sale_rows AS (
		SELECT s.id, s.date AS occurred_at, s.total_amount_cents, s.order_status,
		       s.notes, s.location, s.order_number,
		       COALESCE(` + customerDisplayNameSQL("c") + `, s.customer_name) AS customer_name,
		       items.summary, COALESCE(items.jar_count, 0)::int AS jar_count,
		       COALESCE(items.first_label, '') AS item_label,
		       COALESCE(items.item_count, 0)::int AS item_count,
		       COALESCE(items.item_keys, '{}') AS item_keys,
		       COALESCE(items.all_jars, false) AS all_jars,
		       stock.from_location, stock.location_keys, stock.varietal, stock.lot_code,
		       stock.lot_count, stock.varietal_keys
		FROM sales s
		LEFT JOIN customers c ON c.id = s.customer_id
		LEFT JOIN LATERAL (
			SELECT string_agg(si.quantity::text || ' × ' || line.label, ', ' ORDER BY si.id) AS summary,
			       SUM(si.quantity) AS jar_count,
			       MIN(line.label) AS first_label,
			       COUNT(DISTINCT line.label) AS item_count,
			       array_agg(DISTINCT 'jar:' || si.jar_size_id::text)
			         FILTER (WHERE si.jar_size_id IS NOT NULL) AS item_keys,
			       bool_and(si.jar_size_id IS NOT NULL) AS all_jars
			FROM sale_items si
			LEFT JOIN jar_sizes js ON js.id = si.jar_size_id
			LEFT JOIN hives h ON h.id = si.hive_id
			LEFT JOIN apiaries a ON a.id = h.apiary_id
			LEFT JOIN equipment_types et ON et.item_id = si.item_id
			LEFT JOIN product_catalog pc ON pc.id = si.product_id
			CROSS JOIN LATERAL (
				SELECT COALESCE(js.label,
				         CASE WHEN si.kind = 'colony' THEN h.position_label || ' · ' || a.name END,
				         et.name,
				         NULLIF(CONCAT_WS(' · ', pc.name, pc.size_label), ''),
				         si.kind) AS label
			) line
			WHERE si.sale_id = s.id
		) items ON true
		LEFT JOIN LATERAL (
			SELECT ` + honeyActivityLotAggregates + `
			FROM inventory_operations so
			JOIN inventory_movements m ON m.operation_id = so.id
			JOIN inventory_locations loc ON loc.id = m.location_id
			` + honeyActivityLotSQL + `
			WHERE so.source_type = 'sale' AND so.source_id = s.id
			  AND so.kind = 'sale_consume' AND so.reverses_operation_id IS NULL
		) stock ON true
	),
	merged AS (
		SELECT 'op' AS source, id, occurred_at, entry_type, kind, reason,
		       reverses_operation_id, bulk_lbs, jars, jar_label, notes,
		       NULL::bigint AS total_cents, NULL::text AS order_status,
		       NULL::text AS location, NULL::text AS customer_name,
		       -- An operation has no sale summary; the slot carries a give-away's
		       -- purpose (gift / own_use) so own use reads as such.
		       purpose AS summary,
		       item_label, item_count, item_keys,
		       varietal, lot_code, lot_count, varietal_keys,
		       from_location, to_location, location_keys,
		       qty_sort, qty_unit,
		       lower(CONCAT_WS(' ', entry_type, replace(entry_type, '_', ' '),
		             CASE entry_type
		               WHEN 'jarring' THEN 'jarred'
		               WHEN 'give_away' THEN 'gave away gift'
		               WHEN 'jar_adjustment' THEN 'adjusted adjustment'
		               WHEN 'bulk_use' THEN 'used bulk'
		               WHEN 'receipt' THEN 'received'
		               WHEN 'sale' THEN 'sold'
		             END,
		             jar_label, item_label, reason, notes, varietal, lot_code,
		             from_location, to_location,
		             CASE WHEN reverses_operation_id IS NOT NULL THEN 'reversed reversal' END)) AS haystack
		FROM typed_ops
		UNION ALL
		SELECT 'sale', id, occurred_at, 'sale', 'sale', NULL,
		       NULL, 0, jar_count, NULL, notes,
		       total_amount_cents, order_status, location, customer_name, summary,
		       item_label, item_count, item_keys,
		       varietal, lot_code, COALESCE(lot_count, 0), COALESCE(varietal_keys, '{}'),
		       from_location, NULLIF(location, ''), COALESCE(location_keys, '{}'),
		       -jar_count::float8, CASE WHEN jar_count = 0 THEN '' WHEN all_jars THEN 'jars' ELSE 'items' END,
		       lower(CONCAT_WS(' ', 'sale sold', summary, location, customer_name,
		             order_number, notes, varietal, lot_code, from_location,
		             CASE WHEN order_status = 'cancelled' THEN 'cancelled' END))
		FROM sale_rows
	),
	feed AS (
		SELECT merged.*, ` + honeyActivityTypeSortSQL + ` AS type_sort,
		       lower(item_label) AS item_sort
		FROM merged
	)`

// honeyActivityQuery is one page of the feed under a sort. The sort column
// and direction come from honeyActivitySorts and a fixed asc/desc, never from
// the request text.
//
// $1 bulk honey item, $2 type filter, $3 search terms, $4 item filter,
// $5 varietal filter, $6 location filter (each empty = all), $7 limit,
// $8 has cursor, $9 cursor key, $10 cursor id.
func honeyActivityQuery(sort, dir string) string {
	spec := honeyActivitySorts[sort]
	order, compare := "DESC", "<"
	if dir == "asc" {
		order, compare = "ASC", ">"
	}
	return honeyActivityFeedSQL + `
	SELECT source, id, occurred_at, kind, COALESCE(reason, ''), reverses_operation_id,
	       bulk_lbs, jars, jar_label, notes, total_cents, order_status, location,
	       customer_name, summary, item_label, item_count, varietal, lot_code,
	       lot_count, from_location, to_location, qty_sort, qty_unit,
	       type_sort, item_sort
	FROM feed
	WHERE (cardinality($2::text[]) = 0 OR entry_type = ANY($2::text[]))
	  AND NOT EXISTS (
		SELECT 1 FROM unnest($3::text[]) AS term WHERE strpos(haystack, term) = 0
	  )
	  AND (cardinality($4::text[]) = 0 OR item_keys && $4::text[])
	  AND (cardinality($5::text[]) = 0 OR varietal_keys && $5::text[])
	  AND (cardinality($6::text[]) = 0 OR location_keys && $6::text[])
	  AND (NOT $8::boolean OR (` + spec.column + `, id) ` + compare + ` ($9::` + spec.cast + `, $10::uuid))
	ORDER BY ` + spec.column + ` ` + order + `, id ` + order + `
	LIMIT $7`
}

// GET /honey/activity?cursor=&limit=&sort=&dir=&type=&item=&varietal=&location=&q=
//
// One page of the stock movement ledger. sort is date (default, newest
// first), quantity, type or item; dir is asc or desc. Every order is
// tie-broken by id, so a page's nextCursor (null on the last page) continues
// exactly where it ended; a cursor made under another sort is a 400. type,
// item ("bulk" or "jar:<id>"), varietal and location (ids) take
// comma-separated or repeated values; q needs every whitespace-separated term
// to match. All are applied on the server, so paging a filtered view never
// skips or repeats a row.
func (s *Server) honeyActivityHandler(w http.ResponseWriter, r *http.Request) {
	query := r.URL.Query()
	limit := parseBoundedLimit(query.Get("limit"), honeyActivityDefaultLimit, honeyActivityMaxLimit)

	sort, dir, err := parseHoneyActivitySort(query.Get("sort"), query.Get("dir"))
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	hasCursor := false
	cursorKey := honeyActivityZeroKey(sort)
	cursorID := uuid.Nil
	if raw := strings.TrimSpace(query.Get("cursor")); raw != "" {
		cursor, err := decodeHoneyActivityCursor(raw)
		if err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
		if cursor.Sort != sort || cursor.Dir != dir {
			writeError(w, http.StatusBadRequest, "cursor belongs to a different sort")
			return
		}
		key, _ := honeyActivityCursorKey(cursor.Sort, cursor.Key)
		hasCursor, cursorKey, cursorID = true, key, cursor.ID
	}
	types, err := parseHoneyActivityTypes(query["type"])
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	items, err := parseHoneyActivityItems(query["item"])
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	varietals, err := parseHoneyActivityIDs("varietal", query["varietal"])
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	locations, err := parseHoneyActivityIDs("location", query["location"])
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	terms := honeyActivitySearchTerms(query.Get("q"))

	rows, err := s.pool.Query(r.Context(), honeyActivityQuery(sort, dir),
		production.HoneyBulkItemID, types, terms, items, varietals, locations,
		limit+1, hasCursor, cursorKey, cursorID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	defer rows.Close()

	entries := make([]honeyActivityEntry, 0, limit)
	// The text form of each row's sort key, for the next cursor.
	keys := make([]string, 0, limit)
	for rows.Next() {
		var (
			source, kind, reason string
			id                   uuid.UUID
			occurredAt           time.Time
			reversesID           *uuid.UUID
			bulkLbs              float64
			jars                 int
			jarLabel, notes      *string
			totalCents           *int64
			orderStatus          *string
			location, customer   *string
			summary              *string
			itemLabel            string
			itemCount, lotCount  int
			varietal, lotCode    *string
			fromLocation, toLoc  *string
			qty                  float64
			qtyUnit              string
			typeSort, itemSort   string
		)
		if err := rows.Scan(&source, &id, &occurredAt, &kind, &reason, &reversesID,
			&bulkLbs, &jars, &jarLabel, &notes, &totalCents, &orderStatus, &location,
			&customer, &summary, &itemLabel, &itemCount, &varietal, &lotCode,
			&lotCount, &fromLocation, &toLoc, &qty, &qtyUnit,
			&typeSort, &itemSort); err != nil {
			writeError(w, http.StatusInternalServerError, "database error")
			return
		}
		var base honeyTimelineEntry
		if source == "sale" {
			base = honeyActivitySaleEntry(
				id, occurredAt, jars, totalCents, orderStatus, location, customer, summary, notes)
		} else {
			base = honeyActivityOperationEntry(
				id, occurredAt, kind, reason, reversesID, bulkLbs, jars, jarLabel, notes)
			if base.Type == "give_away" && summary != nil && *summary == production.GiveAwayPurposeOwnUse {
				base.Description = strings.Replace(base.Description, "Gave away", "Kept for own use", 1)
			}
		}
		entries = append(entries, honeyActivityEntry{
			honeyTimelineEntry: base,
			Item:               itemLabel,
			ItemCount:          itemCount,
			Varietal:           varietal,
			LotCode:            lotCode,
			LotCount:           lotCount,
			FromLocation:       fromLocation,
			ToLocation:         toLoc,
			Qty:                qty,
			QtyUnit:            qtyUnit,
		})
		keys = append(keys, honeyActivitySortKeyText(sort, occurredAt, qty, typeSort, itemSort))
	}
	if rows.Err() != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}

	page := honeyActivityPage{Entries: entries}
	if len(entries) > limit {
		page.Entries = entries[:limit]
		last := page.Entries[limit-1]
		next := encodeHoneyActivityCursor(honeyActivityCursor{
			Sort: sort, Dir: dir, Key: keys[limit-1], ID: last.ID,
		})
		page.NextCursor = &next
	}
	writeJSON(w, http.StatusOK, page)
}

// honeyActivitySortKeyText formats a row's key under the given sort exactly
// as honeyActivityCursorKey parses it back: the timestamp to the nanosecond,
// the float in its shortest round-tripping form, text as is.
func honeyActivitySortKeyText(sort string, at time.Time, qty float64, typeSort, itemSort string) string {
	switch sort {
	case "quantity":
		return strconv.FormatFloat(qty, 'g', -1, 64)
	case "type":
		return typeSort
	case "item":
		return itemSort
	default:
		return at.UTC().Format(time.RFC3339Nano)
	}
}

// honeyActivityFacet is one choice of a ledger column filter.
type honeyActivityFacet struct {
	Value string `json:"value"`
	Label string `json:"label"`
}

type honeyActivityFacets struct {
	Items     []honeyActivityFacet `json:"items"`
	Varietals []honeyActivityFacet `json:"varietals"`
	Locations []honeyActivityFacet `json:"locations"`
}

// GET /honey/activity/facets
//
// The choices of the ledger's Item, Varietal and Location filters, as the
// values GET /honey/activity accepts. Only items, varietals and locations
// that some movement of bulk honey or jars actually touched are listed.
func (s *Server) honeyActivityFacetsHandler(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	facets := honeyActivityFacets{
		Items:     []honeyActivityFacet{},
		Varietals: []honeyActivityFacet{},
		Locations: []honeyActivityFacet{},
	}
	read := func(target *[]honeyActivityFacet, sql string, args ...any) error {
		rows, err := s.pool.Query(ctx, sql, args...)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var facet honeyActivityFacet
			if err := rows.Scan(&facet.Value, &facet.Label); err != nil {
				return err
			}
			*target = append(*target, facet)
		}
		return rows.Err()
	}
	// Bulk honey first, then jar sizes in their configured order.
	if err := read(&facets.Items, `
		SELECT value, label FROM (
			SELECT 'bulk' AS value, 'Bulk honey' AS label, -1 AS sort_order
			WHERE EXISTS (SELECT 1 FROM inventory_movements WHERE item_id = $1)
			UNION ALL
			SELECT 'jar:' || js.id::text, js.label, js.sort_order
			FROM jar_sizes js
			WHERE js.item_id IS NOT NULL
			  AND (js.is_active OR EXISTS (
				SELECT 1 FROM inventory_movements m WHERE m.item_id = js.item_id))
		) choices
		ORDER BY sort_order, label`, production.HoneyBulkItemID); err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	if err := read(&facets.Varietals, `
		SELECT hv.id::text, hv.name
		FROM honey_varietals hv
		WHERE EXISTS (SELECT 1 FROM harvest_lots hl WHERE hl.varietal_id = hv.id)
		ORDER BY lower(hv.name), hv.id`); err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	if err := read(&facets.Locations, `
		SELECT loc.id::text, loc.name
		FROM inventory_locations loc
		WHERE EXISTS (
			SELECT 1 FROM inventory_movements m
			JOIN inventory_items i ON i.id = m.item_id
			WHERE m.location_id = loc.id AND (i.id = $1 OR i.kind = 'jar'))
		ORDER BY loc.is_home DESC, lower(loc.name), loc.id`, production.HoneyBulkItemID); err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	writeJSON(w, http.StatusOK, facets)
}

// honeyActivityOperationEntry builds an operation row exactly as
// /honey/timeline does.
func honeyActivityOperationEntry(
	id uuid.UUID, occurredAt time.Time, kind, reason string, reversesID *uuid.UUID,
	bulkLbs float64, jars int, jarLabel, notes *string,
) honeyTimelineEntry {
	label := "?"
	if jarLabel != nil {
		label = *jarLabel
	}
	entryType, description := honeyTimelineDescribe(kind, reason, label, jars, bulkLbs)
	if reversesID != nil {
		description = "Reversed: " + description
	}
	entry := honeyTimelineEntry{
		ID: id, Date: occurredAt, Type: entryType, Description: description,
		Notes: notes, IsReversal: reversesID != nil, ReversesID: reversesID,
	}
	if jars != 0 {
		quantity := jars
		entry.Quantity = &quantity
	}
	if bulkLbs != 0 {
		lbs := bulkLbs
		entry.AmountLbs = &lbs
	}
	return entry
}

// honeyActivitySaleEntry builds a sale row with the timeline's sentence:
// "Sold 2 × Pint @ Market to Pat".
func honeyActivitySaleEntry(
	id uuid.UUID, date time.Time, jars int, totalCents *int64,
	orderStatus, location, customer, summary, notes *string,
) honeyTimelineEntry {
	items := "items"
	if summary != nil && *summary != "" {
		items = *summary
	}
	description := "Sold " + items
	if location != nil && *location != "" {
		description += " @ " + *location
	}
	if customer != nil && *customer != "" {
		description += " to " + *customer
	}
	cancelled := orderStatus != nil && *orderStatus == "cancelled"
	if cancelled {
		description = "Cancelled: " + description
	}
	quantity := jars
	var total money
	if totalCents != nil {
		total = money(*totalCents)
	}
	return honeyTimelineEntry{
		ID: id, Date: date, Type: "sale", Description: description,
		Quantity: &quantity, TotalAmount: &total, Notes: notes, Cancelled: cancelled,
	}
}
