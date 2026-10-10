package httpapi

import (
	"encoding/base64"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/biker2000on/beez-trackz/backend/internal/app/production"
	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
)

// The honey activity feed: the same rows as /honey/timeline (signed inventory
// operations on bulk honey and jars, plus sales) behind keyset pagination, so
// the Activity page can scroll the whole ledger instead of a capped list.
//
// The interaction model is borrowed from the Folio account ledger: a stable
// newest-first order, a cursor per page, and filters applied on the server so
// every page is a page of the filtered ledger rather than a filter over
// whatever happened to be loaded.

func (s *Server) mountHoneyActivity(r chi.Router) {
	admin := r.With(s.requireAdmin)
	admin.Get("/honey/activity", s.honeyActivityHandler)
}

const (
	honeyActivityDefaultLimit = 50
	honeyActivityMaxLimit     = 200
)

// honeyActivityTypes are the values ?type= accepts — the wire types the
// timeline has always emitted.
var honeyActivityTypes = map[string]bool{
	"jarring": true, "sale": true, "bulk_use": true, "loss": true,
	"give_away": true, "jar_adjustment": true, "receipt": true,
}

type honeyActivityPage struct {
	Entries []honeyTimelineEntry `json:"entries"`
	// NextCursor is null on the last page.
	NextCursor *string `json:"nextCursor"`
}

// honeyActivityCursor is the keyset position of the last row of a page. The
// order is (occurred_at DESC, id DESC), so the next page is every row
// strictly after it in that order.
type honeyActivityCursor struct {
	At time.Time
	ID uuid.UUID
}

func encodeHoneyActivityCursor(c honeyActivityCursor) string {
	raw := c.At.UTC().Format(time.RFC3339Nano) + "|" + c.ID.String()
	return base64.RawURLEncoding.EncodeToString([]byte(raw))
}

func decodeHoneyActivityCursor(value string) (honeyActivityCursor, error) {
	raw, err := base64.RawURLEncoding.DecodeString(value)
	if err != nil {
		return honeyActivityCursor{}, errors.New("invalid cursor")
	}
	at, id, ok := strings.Cut(string(raw), "|")
	if !ok {
		return honeyActivityCursor{}, errors.New("invalid cursor")
	}
	parsedAt, err := time.Parse(time.RFC3339Nano, at)
	if err != nil {
		return honeyActivityCursor{}, errors.New("invalid cursor")
	}
	parsedID, err := uuid.Parse(id)
	if err != nil {
		return honeyActivityCursor{}, errors.New("invalid cursor")
	}
	return honeyActivityCursor{At: parsedAt, ID: parsedID}, nil
}

// parseHoneyActivityTypes reads ?type=a,b (or repeated ?type=). Unknown
// values are a 400 rather than silently matching nothing.
func parseHoneyActivityTypes(values []string) ([]string, error) {
	out := make([]string, 0)
	seen := map[string]bool{}
	for _, value := range values {
		for _, part := range strings.Split(value, ",") {
			part = strings.TrimSpace(part)
			if part == "" || seen[part] {
				continue
			}
			if !honeyActivityTypes[part] {
				return nil, fmt.Errorf("unknown activity type %q", part)
			}
			seen[part] = true
			out = append(out, part)
		}
	}
	return out, nil
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

// honeyActivityQuery is the merged feed. Operations whose source is a sale
// row are left out: the sale itself is the activity entry (with its total,
// customer and cancel action), and listing its stock consumption as a second
// "Sold …" row duplicated every sale — with a cancel button that could not
// work, because an operation id is not a sale id. Consignment settlements
// consume stock without a sale row, so they stay.
//
// $1 bulk honey item, $2 has cursor, $3 cursor time, $4 cursor id,
// $5 type filter (empty = all), $6 search terms (empty = all), $7 limit.
var honeyActivityQuery = `
	WITH ops AS (
		SELECT o.id, o.occurred_at,
		       COALESCE(original.kind, o.kind) AS kind,
		       COALESCE(original.reason, o.reason) AS reason,
		       o.reverses_operation_id,
		       COALESCE(SUM(m.quantity) FILTER (WHERE m.item_id = $1), 0)::float8 AS bulk_lbs,
		       COALESCE(SUM(m.quantity) FILTER (WHERE i.kind = 'jar'), 0)::int AS jars,
		       MIN(js.label) FILTER (WHERE i.kind = 'jar') AS jar_label,
		       o.details ->> 'notes' AS notes
		FROM inventory_operations o
		LEFT JOIN inventory_operations original ON original.id = o.reverses_operation_id
		JOIN inventory_movements m ON m.operation_id = o.id
		JOIN inventory_items i ON i.id = m.item_id
		LEFT JOIN jar_sizes js ON js.item_id = i.id
		WHERE (i.id = $1 OR i.kind = 'jar')
		  AND NOT (COALESCE(original.kind, o.kind) = 'sale_consume'
		           AND COALESCE(original.source_type, o.source_type) = 'sale')
		GROUP BY o.id, original.id
	),
	typed_ops AS (
		SELECT ops.*, ` + honeyActivityTypeSQL + ` AS entry_type FROM ops
	),
	sale_rows AS (
		SELECT s.id, s.date AS occurred_at, s.total_amount_cents, s.order_status,
		       s.notes, s.location, s.order_number,
		       COALESCE(` + customerDisplayNameSQL("c") + `, s.customer_name) AS customer_name,
		       items.summary, COALESCE(items.jar_count, 0)::int AS jar_count
		FROM sales s
		LEFT JOIN customers c ON c.id = s.customer_id
		LEFT JOIN LATERAL (
			SELECT string_agg(si.quantity::text || ' × ' || COALESCE(js.label,
			         CASE WHEN si.kind = 'colony' THEN h.position_label || ' · ' || a.name END,
			         et.name,
			         NULLIF(CONCAT_WS(' · ', pc.name, pc.size_label), ''),
			         si.kind), ', ' ORDER BY si.id) AS summary,
			       SUM(si.quantity) AS jar_count
			FROM sale_items si
			LEFT JOIN jar_sizes js ON js.id = si.jar_size_id
			LEFT JOIN hives h ON h.id = si.hive_id
			LEFT JOIN apiaries a ON a.id = h.apiary_id
			LEFT JOIN equipment_types et ON et.item_id = si.item_id
			LEFT JOIN product_catalog pc ON pc.id = si.product_id
			WHERE si.sale_id = s.id
		) items ON true
	),
	feed AS (
		SELECT 'op' AS source, id, occurred_at, entry_type, kind, reason,
		       reverses_operation_id, bulk_lbs, jars, jar_label, notes,
		       NULL::bigint AS total_cents, NULL::text AS order_status,
		       NULL::text AS location, NULL::text AS customer_name,
		       NULL::text AS summary,
		       lower(CONCAT_WS(' ', entry_type, replace(entry_type, '_', ' '),
		             CASE entry_type
		               WHEN 'jarring' THEN 'jarred'
		               WHEN 'give_away' THEN 'gave away gift'
		               WHEN 'jar_adjustment' THEN 'adjusted adjustment'
		               WHEN 'bulk_use' THEN 'used bulk'
		               WHEN 'receipt' THEN 'received'
		               WHEN 'sale' THEN 'sold'
		             END,
		             jar_label, reason, notes,
		             CASE WHEN reverses_operation_id IS NOT NULL THEN 'reversed reversal' END)) AS haystack
		FROM typed_ops
		UNION ALL
		SELECT 'sale', id, occurred_at, 'sale', 'sale', NULL,
		       NULL, 0, jar_count, NULL, notes,
		       total_amount_cents, order_status, location, customer_name, summary,
		       lower(CONCAT_WS(' ', 'sale sold', summary, location, customer_name,
		             order_number, notes,
		             CASE WHEN order_status = 'cancelled' THEN 'cancelled' END))
		FROM sale_rows
	)
	SELECT source, id, occurred_at, kind, COALESCE(reason, ''), reverses_operation_id,
	       bulk_lbs, jars, jar_label, notes, total_cents, order_status, location,
	       customer_name, summary
	FROM feed
	WHERE (NOT $2::boolean OR (occurred_at, id) < ($3::timestamptz, $4::uuid))
	  AND (cardinality($5::text[]) = 0 OR entry_type = ANY($5::text[]))
	  AND NOT EXISTS (
		SELECT 1 FROM unnest($6::text[]) AS term WHERE strpos(haystack, term) = 0
	  )
	ORDER BY occurred_at DESC, id DESC
	LIMIT $7`

// GET /honey/activity?cursor=&limit=&type=&q=
//
// One page of the honey ledger, newest first, ordered by (occurred_at DESC,
// id DESC). Pass the previous page's nextCursor to continue; nextCursor is
// null on the last page. type (comma-separated or repeated) and q (every
// whitespace-separated term must match) filter on the server, so paging a
// filtered view never skips or repeats a row.
func (s *Server) honeyActivityHandler(w http.ResponseWriter, r *http.Request) {
	query := r.URL.Query()
	limit := parseBoundedLimit(query.Get("limit"), honeyActivityDefaultLimit, honeyActivityMaxLimit)

	var cursor honeyActivityCursor
	hasCursor := false
	if raw := strings.TrimSpace(query.Get("cursor")); raw != "" {
		parsed, err := decodeHoneyActivityCursor(raw)
		if err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
		cursor, hasCursor = parsed, true
	}
	types, err := parseHoneyActivityTypes(query["type"])
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	terms := honeyActivitySearchTerms(query.Get("q"))

	rows, err := s.pool.Query(r.Context(), honeyActivityQuery,
		production.HoneyBulkItemID, hasCursor, cursor.At, cursor.ID,
		types, terms, limit+1)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	defer rows.Close()

	entries := make([]honeyTimelineEntry, 0, limit)
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
		)
		if err := rows.Scan(&source, &id, &occurredAt, &kind, &reason, &reversesID,
			&bulkLbs, &jars, &jarLabel, &notes, &totalCents, &orderStatus, &location,
			&customer, &summary); err != nil {
			writeError(w, http.StatusInternalServerError, "database error")
			return
		}
		if source == "sale" {
			entries = append(entries, honeyActivitySaleEntry(
				id, occurredAt, jars, totalCents, orderStatus, location, customer, summary, notes))
			continue
		}
		entries = append(entries, honeyActivityOperationEntry(
			id, occurredAt, kind, reason, reversesID, bulkLbs, jars, jarLabel, notes))
	}
	if rows.Err() != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}

	page := honeyActivityPage{Entries: entries}
	if len(entries) > limit {
		page.Entries = entries[:limit]
		last := page.Entries[limit-1]
		next := encodeHoneyActivityCursor(honeyActivityCursor{At: last.Date, ID: last.ID})
		page.NextCursor = &next
	}
	writeJSON(w, http.StatusOK, page)
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
