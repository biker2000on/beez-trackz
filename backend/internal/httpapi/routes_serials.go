package httpapi

import (
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// Serialized jar traceability. A serial printed on a jar lid is the only thing
// a customer (or the beekeeper holding a returned jar) has in hand, so it is
// the lookup key for the whole chain:
//
//	serial -> bottling run -> harvest lot -> sale
//
// Migration 00009 added the sale half of that chain; these endpoints are the
// read and write surface for it.
func (s *Server) mountSerials(r chi.Router) {
	r.Get("/honey/serials/{serialNumber}", s.jarSerialLookup)
	r.Get("/honey/sales/{id}/serials", s.saleSerialList)
	r.Post("/honey/sales/{id}/serials", s.saleSerialLink)
	r.Delete("/honey/sales/{id}/serials/{serialNumber}", s.saleSerialUnlink)
	r.Get("/sales/{id}/serials", s.saleSerialList)
	r.Post("/sales/{id}/serials", s.saleSerialLink)
	r.Delete("/sales/{id}/serials/{serialNumber}", s.saleSerialUnlink)
}

type jarSerialRunJSON struct {
	ID           uuid.UUID `json:"id"`
	BottledDate  time.Time `json:"bottledDate"`
	JarSizeLabel *string   `json:"jarSizeLabel"`
	Quantity     int       `json:"quantity"`
}

type jarSerialLotJSON struct {
	ID         uuid.UUID `json:"id"`
	LotCode    string    `json:"lotCode"`
	Variety    *string   `json:"variety"`
	Season     *string   `json:"season"`
	PublicSlug string    `json:"publicSlug"`
}

type jarSerialSaleJSON struct {
	ID           uuid.UUID  `json:"id"`
	Date         time.Time  `json:"date"`
	CustomerName *string    `json:"customerName"`
	OrderStatus  string     `json:"orderStatus"`
	SoldAt       *time.Time `json:"soldAt"`
	LinkedByName *string    `json:"linkedByName"`
}

type jarSerialLookupJSON struct {
	SerialNumber string             `json:"serialNumber"`
	CreatedAt    time.Time          `json:"createdAt"`
	BottlingRun  jarSerialRunJSON   `json:"bottlingRun"`
	HarvestLot   jarSerialLotJSON   `json:"harvestLot"`
	Sale         *jarSerialSaleJSON `json:"sale"`
}

// jarSerialLinkJSON is the compact per-sale row: enough to show what shipped
// without a second round trip for the lot code or jar size.
type jarSerialLinkJSON struct {
	SerialNumber string     `json:"serialNumber"`
	LotCode      string     `json:"lotCode"`
	JarSizeLabel *string    `json:"jarSizeLabel"`
	SoldAt       *time.Time `json:"soldAt"`
}

// normalizeSerial trims a user-supplied serial. Matching is case-insensitive
// (see the lower(serial_number) index) because these are read off a jar lid.
func normalizeSerial(value string) string {
	return strings.TrimSpace(value)
}

// GET /honey/serials/{serialNumber} — the full traceability chain for one jar.
func (s *Server) jarSerialLookup(w http.ResponseWriter, r *http.Request) {
	serial := normalizeSerial(chi.URLParam(r, "serialNumber"))
	if serial == "" {
		writeError(w, http.StatusBadRequest, "serial number is required")
		return
	}

	var item jarSerialLookupJSON
	var saleID *uuid.UUID
	var saleDate *time.Time
	var customerName *string
	var orderStatus *string
	var soldAt *time.Time
	var linkedByName *string

	err := s.pool.QueryRow(r.Context(), `
		SELECT js.serial_number, js.created_at,
			br.id, br.bottled_date, jz.label, br.quantity,
			lot.id, lot.lot_code, lot.honey_variety, lot.season, lot.public_slug,
			sale.id, sale.date, COALESCE(c.name, sale.customer_name),
			sale.order_status, js.sold_at, linker.display_name
		FROM jar_serials js
		JOIN bottling_runs br ON br.id = js.bottling_run_id
		JOIN harvest_lots lot ON lot.id = br.lot_id
		LEFT JOIN jar_sizes jz ON jz.id = br.jar_size_id
		LEFT JOIN sales sale ON sale.id = js.sale_id
		LEFT JOIN customers c ON c.id = sale.customer_id
		LEFT JOIN app_users linker ON linker.id = js.linked_by
		WHERE lower(js.serial_number) = lower($1)`, serial).
		Scan(&item.SerialNumber, &item.CreatedAt,
			&item.BottlingRun.ID, &item.BottlingRun.BottledDate,
			&item.BottlingRun.JarSizeLabel, &item.BottlingRun.Quantity,
			&item.HarvestLot.ID, &item.HarvestLot.LotCode, &item.HarvestLot.Variety,
			&item.HarvestLot.Season, &item.HarvestLot.PublicSlug,
			&saleID, &saleDate, &customerName, &orderStatus, &soldAt, &linkedByName)
	if errors.Is(err, pgx.ErrNoRows) {
		writeError(w, http.StatusNotFound, "no jar carries that serial number")
		return
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	if saleID != nil && saleDate != nil && orderStatus != nil {
		item.Sale = &jarSerialSaleJSON{
			ID: *saleID, Date: *saleDate, CustomerName: customerName,
			OrderStatus: *orderStatus, SoldAt: soldAt, LinkedByName: linkedByName,
		}
	}
	writeJSON(w, http.StatusOK, item)
}

// saleSerialRows lists the serials linked to a sale, newest link first.
func (s *Server) saleSerialRows(r *http.Request, saleID uuid.UUID) ([]jarSerialLinkJSON, error) {
	rows, err := s.pool.Query(r.Context(), `
		SELECT js.serial_number, lot.lot_code, jz.label, js.sold_at
		FROM jar_serials js
		JOIN bottling_runs br ON br.id = js.bottling_run_id
		JOIN harvest_lots lot ON lot.id = br.lot_id
		LEFT JOIN jar_sizes jz ON jz.id = br.jar_size_id
		WHERE js.sale_id = $1
		ORDER BY js.serial_number`, saleID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := make([]jarSerialLinkJSON, 0)
	for rows.Next() {
		var item jarSerialLinkJSON
		if err := rows.Scan(&item.SerialNumber, &item.LotCode, &item.JarSizeLabel, &item.SoldAt); err != nil {
			return nil, err
		}
		items = append(items, item)
	}
	return items, rows.Err()
}

// GET /honey/sales/{id}/serials
func (s *Server) saleSerialList(w http.ResponseWriter, r *http.Request) {
	saleID, err := uuidParam(r, "id")
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	items, err := s.saleSerialRows(r, saleID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	writeJSON(w, http.StatusOK, items)
}

type saleSerialLinkPayload struct {
	SerialNumbers []string `json:"serialNumbers"`
}

// POST /honey/sales/{id}/serials — link jars to a sale.
//
// All-or-nothing on purpose: a half-applied batch would leave the operator
// guessing which jars actually got recorded, so any bad serial rejects the
// whole request with a message naming it. Re-linking a serial that is already
// on this sale is a no-op rather than an error, which makes the endpoint safe
// to retry after a flaky connection.
func (s *Server) saleSerialLink(w http.ResponseWriter, r *http.Request) {
	saleID, err := uuidParam(r, "id")
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	var req saleSerialLinkPayload
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid JSON body")
		return
	}

	// Trim, drop blanks, and de-duplicate case-insensitively so "ABC, abc"
	// is one jar rather than a self-conflict.
	seen := make(map[string]struct{}, len(req.SerialNumbers))
	serials := make([]string, 0, len(req.SerialNumbers))
	for _, raw := range req.SerialNumbers {
		serial := normalizeSerial(raw)
		if serial == "" {
			continue
		}
		key := strings.ToLower(serial)
		if _, dup := seen[key]; dup {
			continue
		}
		seen[key] = struct{}{}
		serials = append(serials, serial)
	}
	if len(serials) == 0 {
		writeError(w, http.StatusBadRequest, "at least one serial number is required")
		return
	}

	ctx := r.Context()
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	defer tx.Rollback(ctx)

	// Lock the sale so a concurrent cancellation cannot slip in between the
	// status check and the links.
	var orderStatus string
	err = tx.QueryRow(ctx,
		`SELECT order_status FROM sales WHERE id=$1 FOR UPDATE`, saleID).Scan(&orderStatus)
	if errors.Is(err, pgx.ErrNoRows) {
		writeError(w, http.StatusNotFound, "sale not found")
		return
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	if orderStatus == "cancelled" {
		writeError(w, http.StatusBadRequest, "this sale is cancelled; jars cannot be linked to it")
		return
	}

	actor := actorID(r)
	for _, serial := range serials {
		var existing *uuid.UUID
		err := tx.QueryRow(ctx, `
			SELECT sale_id FROM jar_serials
			WHERE lower(serial_number) = lower($1) FOR UPDATE`, serial).Scan(&existing)
		if errors.Is(err, pgx.ErrNoRows) {
			writeError(w, http.StatusBadRequest, "unknown jar serial "+serial)
			return
		}
		if err != nil {
			writeError(w, http.StatusInternalServerError, "database error")
			return
		}
		if existing != nil && *existing != saleID {
			writeError(w, http.StatusBadRequest,
				"jar serial "+serial+" is already linked to a different sale")
			return
		}
		if existing != nil {
			// Already on this sale: keep the original sold_at so the audit
			// trail records when the jar actually went out.
			continue
		}
		if _, err := tx.Exec(ctx, `
			UPDATE jar_serials SET sale_id=$1, sold_at=now(), linked_by=$2
			WHERE lower(serial_number) = lower($3)`, saleID, actor, serial); err != nil {
			writeError(w, http.StatusInternalServerError, "database error")
			return
		}
	}

	if err := tx.Commit(ctx); err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	items, err := s.saleSerialRows(r, saleID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	writeJSON(w, http.StatusOK, items)
}

// DELETE /honey/sales/{id}/serials/{serialNumber} — unlink one jar.
func (s *Server) saleSerialUnlink(w http.ResponseWriter, r *http.Request) {
	saleID, err := uuidParam(r, "id")
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	serial := normalizeSerial(chi.URLParam(r, "serialNumber"))
	if serial == "" {
		writeError(w, http.StatusBadRequest, "serial number is required")
		return
	}
	tag, err := s.pool.Exec(r.Context(), `
		UPDATE jar_serials SET sale_id=NULL, sold_at=NULL, linked_by=NULL
		WHERE lower(serial_number) = lower($1) AND sale_id = $2`, serial, saleID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	if tag.RowsAffected() == 0 {
		writeError(w, http.StatusNotFound, "that jar serial is not linked to this sale")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"success": true})
}
