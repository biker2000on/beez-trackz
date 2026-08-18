package httpapi

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

// mountFeedings wires the feeding endpoints.
func (s *Server) mountFeedings(r chi.Router) {
	r.Post("/feedings", s.handleFeedingCreate)
	r.Post("/feedings/bulk", s.handleFeedingsBulk)
	r.Get("/feedings/active", s.handleFeedingsActive)
	r.Get("/feedings/status", s.handleFeedingsStatus)
	r.With(s.requireEntityParamRole("feeding", true)).
		Post("/feedings/{id}/empty", s.handleFeedingEmpty)
	r.With(s.requireEntityParamRole("feeding", true)).
		Post("/feedings/{id}/close", s.handleFeedingClose)
	r.With(s.requireEntityParamRole("feeding", true)).
		Post("/feedings/{id}/refill", s.handleFeedingRefill)
	r.With(s.requireEntityParamRole("feeding", true)).
		Delete("/feedings/{id}", s.handleFeedingDelete)
	r.With(s.requireHiveParamRole(false)).
		Get("/hives/{id}/feedings", s.handleFeedingsForHive)
}

// --- feeding enums (mirror the Postgres enum types for human 400s) ---

var feedingTypes = map[string]bool{
	"sugar_syrup_1to1": true, "sugar_syrup_2to1": true, "dry_sugar": true,
	"pollen_patty": true, "fondant": true, "other": true,
}

var feedingFeederTypes = map[string]bool{
	"entrance": true, "top": true, "frame": true, "baggie": true,
	"bucket": true, "open": true, "other": true,
}

var feedingQuantityUnits = map[string]bool{
	"lbs": true, "oz": true, "quarts": true, "gallons": true,
}

// --- feeding lifecycle (see migration 00007_feeding_lifecycle.sql) ---
//
// A feeder is active only when its row is explicitly `open`. `unverified` is
// the honest state for the legacy rows that never recorded an end: they are
// not counted as active feeders, and the dashboard asks the beekeeper to
// verify and close them. Refills close their predecessor and open exactly one
// successor, so a feeder chain can never contain two open rows.
const (
	feedingStatusOpen       = "open"
	feedingStatusClosed     = "closed"
	feedingStatusUnverified = "unverified"
)

// feedingCloseReasons are the reasons a human (not the migration) can close a
// feeding. `refilled` is written by the refill path only.
var feedingCloseReasons = map[string]bool{
	// The feeder was found empty / the feed was consumed.
	"emptied": true,
	// The feeder was physically taken off the hive.
	"removed": true,
	// Checked in the field and confirmed the feeder is gone (the fix for the
	// legacy `unverified` records).
	"verified_closed": true,
	// The record was ambiguous: no feeder was ever left on the hive.
	"not_installed": true,
	// Written by a colony sale, not the close dialog.
	"sold_with_hive": true,
}

const feedingCloseReasonRefilled = "refilled"

type feedingJSON struct {
	ID           uuid.UUID  `json:"id"`
	HiveID       uuid.UUID  `json:"hiveId"`
	DateFed      time.Time  `json:"dateFed"`
	Type         string     `json:"type"`
	Quantity     float64    `json:"quantity"`
	QuantityUnit string     `json:"quantityUnit"`
	FeederType   *string    `json:"feederType"`
	DateEmpty    *time.Time `json:"dateEmpty"`
	Notes        *string    `json:"notes"`
	CreatedAt    time.Time  `json:"createdAt"`
	Status       string     `json:"status"`
	ClosedAt     *time.Time `json:"closedAt"`
	ClosedReason *string    `json:"closedReason"`
	RefillOfID   *uuid.UUID `json:"refillOfId"`
}

const feedingSelectCols = `id, hive_id, date_fed, type, quantity, quantity_unit,
	feeder_type, date_empty, notes, created_at,
	status::text, closed_at, closed_reason, refill_of_id`

func feedingScan(row pgx.Row) (feedingJSON, error) {
	var v feedingJSON
	err := row.Scan(&v.ID, &v.HiveID, &v.DateFed, &v.Type, &v.Quantity, &v.QuantityUnit,
		&v.FeederType, &v.DateEmpty, &v.Notes, &v.CreatedAt,
		&v.Status, &v.ClosedAt, &v.ClosedReason, &v.RefillOfID)
	return v, err
}

// feedingFields is the writable feeding column set shared by single + bulk create.
type feedingFields struct {
	HiveID                    uuid.UUID
	DateFed                   time.Time
	Type                      string
	Quantity                  float64
	QuantityUnit              string
	FeederType                *string
	Notes                     *string
	SourceMediaFileID         *uuid.UUID
	SourceTranscriptVersionID *uuid.UUID
}

// feedingInsert is the single insert path for feedings.
//
// A feeding with no feeder is a feed event — syrup poured, a patty laid on
// the frames — not equipment left on the hive. It is recorded closed with
// reason not_installed ("no feeder was ever left") so it can never surface
// as an open feeder demanding a refill-or-close decision. Only feedings
// that name a feeder open the lifecycle.
func feedingInsert(ctx context.Context, q inspectionQuerier, f feedingFields, actor *uuid.UUID) (uuid.UUID, error) {
	var id uuid.UUID
	if f.FeederType == nil {
		err := q.QueryRow(ctx, `
			INSERT INTO feedings
				(hive_id, date_fed, type, quantity, quantity_unit, feeder_type, notes,
				 status, closed_at, closed_reason, date_empty,
				 status_changed_at, status_changed_by,
				 source_media_file_id, source_transcript_version_id)
			VALUES ($1, $2, $3, $4, $5, NULL, $6,
				'closed', now(), 'not_installed', $2, now(), $7, $8, $9)
			RETURNING id`,
			f.HiveID, f.DateFed, f.Type, f.Quantity, f.QuantityUnit, f.Notes, actor,
			f.SourceMediaFileID, f.SourceTranscriptVersionID).Scan(&id)
		return id, err
	}
	err := q.QueryRow(ctx, `
		INSERT INTO feedings
			(hive_id, date_fed, type, quantity, quantity_unit, feeder_type, notes,
			 source_media_file_id, source_transcript_version_id)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
		RETURNING id`,
		f.HiveID, f.DateFed, f.Type, f.Quantity, f.QuantityUnit, f.FeederType, f.Notes,
		f.SourceMediaFileID, f.SourceTranscriptVersionID).Scan(&id)
	return id, err
}

type feedingCreateReq struct {
	HiveID       string   `json:"hiveId"`
	DateFed      string   `json:"dateFed"`
	Type         string   `json:"type"`
	Quantity     *float64 `json:"quantity"`
	QuantityUnit string   `json:"quantityUnit"`
	FeederType   *string  `json:"feederType"`
	Notes        *string  `json:"notes"`
}

// feedingValidate checks the shared required fields; returns a human message or "".
func feedingValidate(req *feedingCreateReq) string {
	switch {
	case strings.TrimSpace(req.DateFed) == "":
		return "Date is required"
	case req.Type == "":
		return "Feed type is required"
	case !feedingTypes[req.Type]:
		return "Invalid feed type"
	case req.Quantity == nil:
		return "Quantity is required"
	case *req.Quantity <= 0:
		return "Quantity must be greater than zero"
	case req.QuantityUnit == "":
		return "Unit is required"
	case !feedingQuantityUnits[req.QuantityUnit]:
		return "Invalid unit"
	}
	if req.FeederType != nil && *req.FeederType != "" && !feedingFeederTypes[*req.FeederType] {
		return "Invalid feeder type"
	}
	return ""
}

// feedingFeederPtr normalizes an optional feeder type: empty → nil.
func feedingFeederPtr(s *string) *string {
	if s == nil || *s == "" {
		return nil
	}
	return s
}

// POST /feedings
func (s *Server) handleFeedingCreate(w http.ResponseWriter, r *http.Request) {
	var req feedingCreateReq
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	hiveID, err := uuid.Parse(req.HiveID)
	if err != nil {
		writeError(w, http.StatusBadRequest, "Hive is required")
		return
	}
	if !s.requireHiveRole(w, r, hiveID, true) {
		return
	}
	if msg := feedingValidate(&req); msg != "" {
		writeError(w, http.StatusBadRequest, msg)
		return
	}
	dateFed, err := parseDate(req.DateFed)
	if err != nil {
		writeError(w, http.StatusBadRequest, "Invalid date")
		return
	}
	id, err := feedingInsert(r.Context(), s.pool, feedingFields{
		HiveID:       hiveID,
		DateFed:      dateFed,
		Type:         req.Type,
		Quantity:     *req.Quantity,
		QuantityUnit: req.QuantityUnit,
		FeederType:   feedingFeederPtr(req.FeederType),
		Notes:        inspectionTrimPtr(req.Notes),
	}, actorID(r))
	if err != nil {
		if inspectionIsFKViolation(err) {
			writeError(w, http.StatusBadRequest, "Hive not found")
			return
		}
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	created, err := feedingScan(s.pool.QueryRow(r.Context(),
		`SELECT `+feedingSelectCols+` FROM feedings WHERE id = $1`, id))
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	writeJSON(w, http.StatusCreated, created)
}

// POST /feedings/bulk {hiveIds[], dateFed, type, quantity, quantityUnit, feederType?, notes?}
func (s *Server) handleFeedingsBulk(w http.ResponseWriter, r *http.Request) {
	var req struct {
		HiveIDs []string `json:"hiveIds"`
		feedingCreateReq
	}
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if len(req.HiveIDs) == 0 {
		writeError(w, http.StatusBadRequest, "Select at least one hive")
		return
	}
	if msg := feedingValidate(&req.feedingCreateReq); msg != "" {
		writeError(w, http.StatusBadRequest, msg)
		return
	}
	dateFed, err := parseDate(req.DateFed)
	if err != nil {
		writeError(w, http.StatusBadRequest, "Invalid date")
		return
	}
	hiveIDs := make([]uuid.UUID, 0, len(req.HiveIDs))
	for _, raw := range req.HiveIDs {
		id, err := uuid.Parse(raw)
		if err != nil {
			writeError(w, http.StatusBadRequest, "invalid hive id: "+raw)
			return
		}
		if !s.requireHiveRole(w, r, id, true) {
			return
		}
		hiveIDs = append(hiveIDs, id)
	}
	fields := feedingFields{
		DateFed:      dateFed,
		Type:         req.Type,
		Quantity:     *req.Quantity,
		QuantityUnit: req.QuantityUnit,
		FeederType:   feedingFeederPtr(req.FeederType),
		Notes:        inspectionTrimPtr(req.Notes),
	}

	ctx := r.Context()
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	defer func() { _ = tx.Rollback(ctx) }()
	for _, hiveID := range hiveIDs {
		fields.HiveID = hiveID
		if _, err := feedingInsert(ctx, tx, fields, actorID(r)); err != nil {
			if inspectionIsFKViolation(err) {
				writeError(w, http.StatusBadRequest, "Hive not found")
				return
			}
			writeError(w, http.StatusInternalServerError, "database error")
			return
		}
	}
	if err := tx.Commit(ctx); err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"success": true, "count": len(hiveIDs)})
}

// --- lifecycle: close + refill -------------------------------------------

// feedingLifecycleRow is the locked feeder state the close/refill paths need.
type feedingLifecycleRow struct {
	ID           uuid.UUID
	HiveID       uuid.UUID
	DateFed      time.Time
	Type         string
	Quantity     float64
	QuantityUnit string
	FeederType   *string
	Status       string
}

// feedingLock reads and row-locks a feeding so two field actions on the same
// feeder cannot interleave.
func feedingLock(
	ctx context.Context,
	q inspectionQuerier,
	id uuid.UUID,
) (feedingLifecycleRow, error) {
	var row feedingLifecycleRow
	err := q.QueryRow(ctx, `
		SELECT id, hive_id, date_fed, type::text, quantity, quantity_unit::text,
		       feeder_type::text, status::text
		FROM feedings WHERE id = $1 FOR UPDATE`, id).
		Scan(&row.ID, &row.HiveID, &row.DateFed, &row.Type, &row.Quantity,
			&row.QuantityUnit, &row.FeederType, &row.Status)
	return row, err
}

// feedingCloseExec ends a feeder episode. It writes the explicit status plus
// the audit trail (reason, actor, timestamp) and, for every reason except
// `not_installed`, records date_empty when the record has none yet — the
// operator is reporting the end of the feeder now, so legacy readers of
// date_empty stay correct. `not_installed` back-dates date_empty to date_fed
// because no feeder was ever left on the hive.
func feedingCloseExec(
	ctx context.Context,
	q inspectionQuerier,
	id uuid.UUID,
	closedAt time.Time,
	reason string,
	actor *uuid.UUID,
	note *string,
) error {
	_, err := q.Exec(ctx, `
		UPDATE feedings
		SET status = 'closed',
			closed_at = $2,
			closed_reason = $3,
			status_changed_at = now(),
			status_changed_by = $4,
			date_empty = CASE
				WHEN $3 = 'not_installed' THEN date_fed
				ELSE COALESCE(date_empty, $2)
			END,
			notes = CASE
				WHEN $5::text IS NULL THEN notes
				WHEN notes IS NULL OR notes = '' THEN $5::text
				ELSE notes || E'\n' || $5::text
			END
		WHERE id = $1`, id, closedAt, reason, actor, note)
	return err
}

func principalID(r *http.Request) *uuid.UUID {
	user := principalFrom(r)
	if user == nil {
		return nil
	}
	id := user.ID
	return &id
}

type feedingCloseReq struct {
	Reason    *string `json:"reason"`
	DateEmpty *string `json:"dateEmpty"`
	Notes     *string `json:"notes"`
}

// POST /feedings/{id}/empty — legacy alias for close with reason `emptied`.
func (s *Server) handleFeedingEmpty(w http.ResponseWriter, r *http.Request) {
	s.closeFeeding(w, r, feedingCloseReq{})
}

// POST /feedings/{id}/close {reason?, dateEmpty?, notes?}
//
// Closing is the explicit half of the active-feeder rule: an open or
// unverified feeder becomes closed, and a closed one is rejected instead of
// being silently re-closed (which is how duplicate status rows appeared).
func (s *Server) handleFeedingClose(w http.ResponseWriter, r *http.Request) {
	var req feedingCloseReq
	if r.Body != nil && r.ContentLength != 0 {
		if err := decodeJSON(r, &req); err != nil {
			writeError(w, http.StatusBadRequest, "invalid request body")
			return
		}
	}
	s.closeFeeding(w, r, req)
}

func (s *Server) closeFeeding(w http.ResponseWriter, r *http.Request, req feedingCloseReq) {
	id, err := uuidParam(r, "id")
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	reason := "emptied"
	if req.Reason != nil && *req.Reason != "" {
		reason = *req.Reason
	}
	if !feedingCloseReasons[reason] {
		writeError(w, http.StatusBadRequest, "Invalid close reason")
		return
	}
	closedAt := time.Now()
	if parsed, err := parseDatePtr(req.DateEmpty); err != nil {
		writeError(w, http.StatusBadRequest, "Invalid date")
		return
	} else if parsed != nil {
		closedAt = *parsed
	}

	ctx := r.Context()
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	defer func() { _ = tx.Rollback(ctx) }()

	current, err := feedingLock(ctx, tx, id)
	if errors.Is(err, pgx.ErrNoRows) {
		writeError(w, http.StatusNotFound, "Feeding not found")
		return
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	if current.Status == feedingStatusClosed {
		writeError(w, http.StatusConflict, "This feeding is already closed")
		return
	}
	if err := feedingCloseExec(ctx, tx, id, closedAt, reason, principalID(r),
		inspectionTrimPtr(req.Notes)); err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	closed, err := feedingScan(tx.QueryRow(ctx,
		`SELECT `+feedingSelectCols+` FROM feedings WHERE id = $1`, id))
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	if err := tx.Commit(ctx); err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	writeJSON(w, http.StatusOK, closed)
}

type feedingRefillReq struct {
	DateFed      *string  `json:"dateFed"`
	Type         *string  `json:"type"`
	Quantity     *float64 `json:"quantity"`
	QuantityUnit *string  `json:"quantityUnit"`
	FeederType   *string  `json:"feederType"`
	Notes        *string  `json:"notes"`
}

// POST /feedings/{id}/refill {dateFed?, type?, quantity?, quantityUnit?, feederType?, notes?}
//
// A refill closes the feeder episode it tops up (reason `refilled`) and opens
// exactly one successor linked by refill_of_id, inside one transaction. The
// unique index on refill_of_id means a feeder chain can never hold two open
// rows, and both rows stay in the hive timeline.
func (s *Server) handleFeedingRefill(w http.ResponseWriter, r *http.Request) {
	id, err := uuidParam(r, "id")
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	var req feedingRefillReq
	if r.Body != nil && r.ContentLength != 0 {
		if err := decodeJSON(r, &req); err != nil {
			writeError(w, http.StatusBadRequest, "invalid request body")
			return
		}
	}
	dateFed := time.Now()
	if parsed, err := parseDatePtr(req.DateFed); err != nil {
		writeError(w, http.StatusBadRequest, "Invalid date")
		return
	} else if parsed != nil {
		dateFed = *parsed
	}
	if req.Quantity != nil && *req.Quantity <= 0 {
		writeError(w, http.StatusBadRequest, "Quantity must be greater than zero")
		return
	}
	if req.Type != nil && *req.Type != "" && !feedingTypes[*req.Type] {
		writeError(w, http.StatusBadRequest, "Invalid feed type")
		return
	}
	if req.QuantityUnit != nil && *req.QuantityUnit != "" &&
		!feedingQuantityUnits[*req.QuantityUnit] {
		writeError(w, http.StatusBadRequest, "Invalid unit")
		return
	}
	if req.FeederType != nil && *req.FeederType != "" &&
		!feedingFeederTypes[*req.FeederType] {
		writeError(w, http.StatusBadRequest, "Invalid feeder type")
		return
	}

	ctx := r.Context()
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	defer func() { _ = tx.Rollback(ctx) }()

	source, err := feedingLock(ctx, tx, id)
	if errors.Is(err, pgx.ErrNoRows) {
		writeError(w, http.StatusNotFound, "Feeding not found")
		return
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	if source.Status == feedingStatusClosed {
		writeError(w, http.StatusConflict,
			"This feeder is already closed — record a new feeding instead")
		return
	}
	if err := feedingCloseExec(ctx, tx, id, dateFed, feedingCloseReasonRefilled,
		principalID(r), nil); err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}

	next := feedingFields{
		HiveID:       source.HiveID,
		DateFed:      dateFed,
		Type:         source.Type,
		Quantity:     source.Quantity,
		QuantityUnit: source.QuantityUnit,
		FeederType:   source.FeederType,
		Notes:        inspectionTrimPtr(req.Notes),
	}
	if req.Type != nil && *req.Type != "" {
		next.Type = *req.Type
	}
	if req.Quantity != nil {
		next.Quantity = *req.Quantity
	}
	if req.QuantityUnit != nil && *req.QuantityUnit != "" {
		next.QuantityUnit = *req.QuantityUnit
	}
	if req.FeederType != nil {
		next.FeederType = feedingFeederPtr(req.FeederType)
	}

	var newID uuid.UUID
	err = tx.QueryRow(ctx, `
		INSERT INTO feedings
			(hive_id, date_fed, type, quantity, quantity_unit, feeder_type, notes,
			 status, refill_of_id, status_changed_at, status_changed_by)
		VALUES ($1,$2,$3,$4,$5,$6,$7,'open',$8,now(),$9)
		RETURNING id`,
		next.HiveID, next.DateFed, next.Type, next.Quantity, next.QuantityUnit,
		next.FeederType, next.Notes, id, principalID(r)).Scan(&newID)
	if feedingIsUniqueViolation(err) {
		writeError(w, http.StatusConflict, "This feeder has already been refilled")
		return
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	created, err := feedingScan(tx.QueryRow(ctx,
		`SELECT `+feedingSelectCols+` FROM feedings WHERE id = $1`, newID))
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	if err := tx.Commit(ctx); err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	writeJSON(w, http.StatusCreated, created)
}

// feedingIsUniqueViolation reports a Postgres unique violation (23505).
func feedingIsUniqueViolation(err error) bool {
	var pgErr *pgconn.PgError
	return errors.As(err, &pgErr) && pgErr.Code == "23505"
}

// DELETE /feedings/{id}
func (s *Server) handleFeedingDelete(w http.ResponseWriter, r *http.Request) {
	id, err := uuidParam(r, "id")
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	var hasRefill bool
	if err := s.pool.QueryRow(r.Context(),
		`SELECT EXISTS (SELECT 1 FROM feedings WHERE refill_of_id = $1)`, id).
		Scan(&hasRefill); err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	if hasRefill {
		writeError(w, http.StatusConflict,
			"This feeding was refilled — delete the refill first")
		return
	}
	tag, err := s.pool.Exec(r.Context(), `DELETE FROM feedings WHERE id = $1`, id)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	if tag.RowsAffected() == 0 {
		writeError(w, http.StatusNotFound, "Feeding not found")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"success": true})
}

// GET /hives/{id}/feedings — full rows, date_fed desc.
func (s *Server) handleFeedingsForHive(w http.ResponseWriter, r *http.Request) {
	hiveID, err := uuidParam(r, "id")
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	rows, err := s.pool.Query(r.Context(),
		`SELECT `+feedingSelectCols+` FROM feedings WHERE hive_id = $1 ORDER BY date_fed DESC`,
		hiveID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	defer rows.Close()
	list := []feedingJSON{}
	for rows.Next() {
		v, err := feedingScan(rows)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "database error")
			return
		}
		list = append(list, v)
	}
	if rows.Err() != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	writeJSON(w, http.StatusOK, list)
}

// GET /feedings/active — explicitly open feeders only, joined hive + apiary
// (oldest first, matching the legacy dashboard ordering). Unverified legacy
// records are deliberately excluded: they are surfaced by /feedings/status
// with the evidence needed to resolve them.
func (s *Server) handleFeedingsActive(w http.ResponseWriter, r *http.Request) {
	rows, err := s.pool.Query(r.Context(), `
		SELECT f.id, f.hive_id, f.date_fed, f.type, f.quantity, f.quantity_unit,
		       f.feeder_type, h.position_label, a.name
		FROM feedings f
		JOIN hives h ON h.id = f.hive_id
		JOIN apiaries a ON a.id = h.apiary_id
		WHERE f.status = 'open'
		  AND ($1::boolean OR EXISTS (
			SELECT 1 FROM apiary_memberships membership
			WHERE membership.user_id=$2 AND membership.apiary_id=a.id
		  ))
		ORDER BY f.date_fed`, principalFrom(r).IsAdmin, principalFrom(r).ID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	defer rows.Close()
	type activeJSON struct {
		ID           uuid.UUID `json:"id"`
		HiveID       uuid.UUID `json:"hiveId"`
		DateFed      time.Time `json:"dateFed"`
		Type         string    `json:"type"`
		Quantity     float64   `json:"quantity"`
		QuantityUnit string    `json:"quantityUnit"`
		FeederType   *string   `json:"feederType"`
		HiveName     string    `json:"hiveName"`
		ApiaryName   string    `json:"apiaryName"`
	}
	list := []activeJSON{}
	for rows.Next() {
		var v activeJSON
		if err := rows.Scan(&v.ID, &v.HiveID, &v.DateFed, &v.Type, &v.Quantity,
			&v.QuantityUnit, &v.FeederType, &v.HiveName, &v.ApiaryName); err != nil {
			writeError(w, http.StatusInternalServerError, "database error")
			return
		}
		list = append(list, v)
	}
	if rows.Err() != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	writeJSON(w, http.StatusOK, list)
}
