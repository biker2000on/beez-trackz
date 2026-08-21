package httpapi

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/biker2000on/beez-trackz/backend/internal/recs"
)

// Comparable mite rate: washes/rolls stay mites per 100 bees; board/visual
// become mites per day once days_on_board is known.
const varroaComparableRateSQL = `
	CASE
		WHEN method IN ('alcohol_wash', 'sugar_roll') THEN mites_per_100
		WHEN method IN ('sticky_board', 'visual') THEN mites_per_day
	END`

const varroaRateKindSQL = `
	CASE
		WHEN method IN ('alcohol_wash', 'sugar_roll') AND mites_per_100 IS NOT NULL THEN 'per_100'
		WHEN method IN ('sticky_board', 'visual') AND mites_per_day IS NOT NULL THEN 'per_day'
	END`

const miteCountSelectCols = `id, hive_id, date, method, mites_count, sample_size, days_on_board,
	mites_per_100, mites_per_day, notes`

// varroaEfficacySQL pairs each treatment with bounded before/after counts.
//
// Before: last comparable count in the 21 days up to date_applied.
// After: first comparable count of the *same method* after the treatment
// ends (date_removed, or date_applied when there is no removal), within 42
// days, and before the next treatment on the same hive. Soft-deleted rows
// are ignored. $1 is an optional hive filter (NULL = every hive).
const varroaEfficacySQL = `
WITH treatments AS (
	SELECT t.id, t.hive_id, t.date_applied, t.date_removed, t.product, t.method,
		COALESCE(t.date_removed, t.date_applied) AS ended_at,
		LEAD(t.date_applied) OVER (
			PARTITION BY t.hive_id ORDER BY t.date_applied, t.id
		) AS next_applied
	FROM treatment_events t
	WHERE ($1::uuid IS NULL OR t.hive_id = $1)
)
SELECT t.id, t.hive_id, t.date_applied, t.product, t.method, t.date_removed,
	before_count.rate, after_count.rate,
	before_count.rate_kind, after_count.rate_kind
FROM treatments t
LEFT JOIN LATERAL (
	SELECT ` + varroaComparableRateSQL + ` AS rate,
		` + varroaRateKindSQL + ` AS rate_kind,
		method
	FROM mite_counts
	WHERE hive_id = t.hive_id
		AND deleted_at IS NULL
		AND date <= t.date_applied
		AND date >= t.date_applied - interval '21 days'
		AND (` + varroaRateKindSQL + `) IS NOT NULL
	ORDER BY date DESC
	LIMIT 1
) before_count ON true
LEFT JOIN LATERAL (
	SELECT ` + varroaComparableRateSQL + ` AS rate,
		` + varroaRateKindSQL + ` AS rate_kind
	FROM mite_counts
	WHERE hive_id = t.hive_id
		AND deleted_at IS NULL
		AND date > t.ended_at
		AND date <= t.ended_at + interval '42 days'
		AND (t.next_applied IS NULL OR date < t.next_applied)
		AND (` + varroaRateKindSQL + `) IS NOT NULL
		AND method = before_count.method
	ORDER BY date
	LIMIT 1
) after_count ON true
ORDER BY t.date_applied, t.id`

type varroaEfficacyRow struct {
	ID          uuid.UUID
	HiveID      uuid.UUID
	DateApplied time.Time
	Product     string
	Method      *string
	DateRemoved *time.Time
	Before      *float64
	After       *float64
	BeforeKind  *string
	AfterKind   *string
}

func (row varroaEfficacyRow) efficacyPercent() *float64 {
	if row.Before == nil || row.After == nil || row.BeforeKind == nil ||
		row.AfterKind == nil || *row.BeforeKind != *row.AfterKind || *row.Before <= 0 {
		return nil
	}
	v := (*row.Before - *row.After) / *row.Before * 100
	return &v
}

func queryVarroaEfficacy(
	ctx context.Context,
	pool *pgxpool.Pool,
	hiveID *uuid.UUID,
) ([]varroaEfficacyRow, error) {
	rows, err := pool.Query(ctx, varroaEfficacySQL, hiveID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]varroaEfficacyRow, 0)
	for rows.Next() {
		var row varroaEfficacyRow
		if err := rows.Scan(
			&row.ID, &row.HiveID, &row.DateApplied, &row.Product, &row.Method,
			&row.DateRemoved, &row.Before, &row.After, &row.BeforeKind, &row.AfterKind,
		); err != nil {
			return nil, err
		}
		out = append(out, row)
	}
	return out, rows.Err()
}

func normalizeMiteCount(req *miteCountPayload) error {
	if !miteMethods[req.Method] || req.MitesCount < 0 ||
		(req.SampleSize != nil && *req.SampleSize <= 0) ||
		(req.DaysOnBoard != nil && *req.DaysOnBoard <= 0) {
		return errors.New("invalid mite count")
	}
	switch req.Method {
	case "alcohol_wash", "sugar_roll":
		req.DaysOnBoard = nil
	case "sticky_board":
		req.SampleSize = nil
		if req.DaysOnBoard == nil {
			one := 1
			req.DaysOnBoard = &one
		}
	case "visual":
		req.SampleSize = nil
	}
	return nil
}

func miteCountIsUniqueViolation(err error) bool {
	var pgErr *pgconn.PgError
	return errors.As(err, &pgErr) && pgErr.Code == "23505"
}

func miteCountUpsertSQL(inspectionLinked bool) string {
	// Predicate must match 00036's live unique indexes.
	conflict := `(hive_id, date, method) WHERE inspection_id IS NULL AND deleted_at IS NULL`
	if inspectionLinked {
		conflict = `(inspection_id, method) WHERE inspection_id IS NOT NULL AND deleted_at IS NULL`
	}
	return `
		INSERT INTO mite_counts
			(hive_id, inspection_id, date, method, mites_count, sample_size, days_on_board, notes)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
		ON CONFLICT ` + conflict + ` DO UPDATE SET
			hive_id = EXCLUDED.hive_id,
			date = EXCLUDED.date,
			method = EXCLUDED.method,
			mites_count = EXCLUDED.mites_count,
			sample_size = EXCLUDED.sample_size,
			days_on_board = EXCLUDED.days_on_board,
			notes = EXCLUDED.notes
		RETURNING id, mites_per_100, mites_per_day`
}

func upsertMiteCount(
	ctx context.Context,
	q inspectionQuerier,
	req miteCountPayload,
	date time.Time,
) (uuid.UUID, *float64, *float64, error) {
	if err := normalizeMiteCount(&req); err != nil {
		return uuid.Nil, nil, nil, err
	}
	var id uuid.UUID
	var per100, perDay *float64
	err := q.QueryRow(ctx, miteCountUpsertSQL(req.InspectionID != nil),
		req.HiveID, req.InspectionID, date, req.Method, req.MitesCount,
		req.SampleSize, req.DaysOnBoard, honeyTrimPtr(req.Notes),
	).Scan(&id, &per100, &perDay)
	return id, per100, perDay, err
}

func insertMiteCount(
	ctx context.Context,
	q inspectionQuerier,
	req miteCountPayload,
	date time.Time,
	createdBy *uuid.UUID,
) (uuid.UUID, *float64, *float64, error) {
	var id uuid.UUID
	var per100, perDay *float64
	err := q.QueryRow(ctx, `
		INSERT INTO mite_counts
			(hive_id, inspection_id, date, method, mites_count, sample_size,
			 days_on_board, notes, created_by)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
		RETURNING id, mites_per_100, mites_per_day`,
		req.HiveID, req.InspectionID, date, req.Method, req.MitesCount,
		req.SampleSize, req.DaysOnBoard, honeyTrimPtr(req.Notes), createdBy,
	).Scan(&id, &per100, &perDay)
	return id, per100, perDay, err
}

func overwriteLiveMiteCount(
	ctx context.Context,
	q inspectionQuerier,
	req miteCountPayload,
	date time.Time,
) (uuid.UUID, *float64, *float64, bool, error) {
	var (
		id             uuid.UUID
		per100, perDay *float64
		err            error
	)
	if req.InspectionID != nil {
		err = q.QueryRow(ctx, `
			UPDATE mite_counts
			SET hive_id = $2, date = $3, mites_count = $4, sample_size = $5,
				days_on_board = $6, notes = $7
			WHERE inspection_id = $1 AND method = $8 AND deleted_at IS NULL
			RETURNING id, mites_per_100, mites_per_day`,
			*req.InspectionID, req.HiveID, date, req.MitesCount, req.SampleSize,
			req.DaysOnBoard, honeyTrimPtr(req.Notes), req.Method,
		).Scan(&id, &per100, &perDay)
	} else {
		err = q.QueryRow(ctx, `
			UPDATE mite_counts
			SET mites_count = $4, sample_size = $5, days_on_board = $6, notes = $7
			WHERE hive_id = $1 AND date = $2 AND method = $3
				AND inspection_id IS NULL AND deleted_at IS NULL
			RETURNING id, mites_per_100, mites_per_day`,
			req.HiveID, date, req.Method, req.MitesCount, req.SampleSize,
			req.DaysOnBoard, honeyTrimPtr(req.Notes),
		).Scan(&id, &per100, &perDay)
	}
	if errors.Is(err, pgx.ErrNoRows) {
		return uuid.Nil, nil, nil, false, nil
	}
	if err != nil {
		return uuid.Nil, nil, nil, false, err
	}
	return id, per100, perDay, true, nil
}

func scanMiteCount(row pgx.Row) (miteCountJSON, error) {
	var v miteCountJSON
	err := row.Scan(&v.ID, &v.HiveID, &v.Date, &v.Method, &v.MitesCount,
		&v.SampleSize, &v.DaysOnBoard, &v.MitesPer100, &v.MitesPerDay, &v.Notes)
	return v, err
}

func loadLiveMiteCountConflict(
	ctx context.Context,
	q inspectionQuerier,
	req miteCountPayload,
	date time.Time,
) (miteCountJSON, error) {
	if req.InspectionID != nil {
		return scanMiteCount(q.QueryRow(ctx, `
			SELECT `+miteCountSelectCols+`
			FROM mite_counts
			WHERE inspection_id = $1 AND method = $2 AND deleted_at IS NULL`,
			*req.InspectionID, req.Method))
	}
	return scanMiteCount(q.QueryRow(ctx, `
		SELECT `+miteCountSelectCols+`
		FROM mite_counts
		WHERE hive_id = $1 AND date = $2 AND method = $3
			AND inspection_id IS NULL AND deleted_at IS NULL`,
		req.HiveID, date, req.Method))
}

func writeMiteCountConflict(w http.ResponseWriter, existing miteCountJSON) {
	writeJSON(w, http.StatusConflict, map[string]any{
		"error":    "a mite count already exists for this hive, date, and method",
		"existing": existing,
	})
}

type miteCountJSON struct {
	ID          uuid.UUID  `json:"id"`
	HiveID      uuid.UUID  `json:"hiveId"`
	Date        time.Time  `json:"date"`
	Method      string     `json:"method"`
	MitesCount  int        `json:"mitesCount"`
	SampleSize  *int       `json:"sampleSize"`
	DaysOnBoard *int       `json:"daysOnBoard"`
	MitesPer100 *float64   `json:"mitesPer100"`
	MitesPerDay *float64   `json:"mitesPerDay"`
	Notes       *string    `json:"notes"`
	HiveName    *string    `json:"hiveName,omitempty"`
	ApiaryID    *uuid.UUID `json:"apiaryId,omitempty"`
	ApiaryName  *string    `json:"apiaryName,omitempty"`
}

func miteCountResponse(id uuid.UUID, per100, perDay *float64) map[string]any {
	return map[string]any{"id": id, "mitesPer100": per100, "mitesPerDay": perDay}
}

func treatmentJSON(row varroaEfficacyRow) map[string]any {
	return map[string]any{
		"id":                row.ID,
		"hiveId":            row.HiveID,
		"dateApplied":       row.DateApplied,
		"dateRemoved":       row.DateRemoved,
		"product":           row.Product,
		"method":            row.Method,
		"beforeRate":        row.Before,
		"afterRate":         row.After,
		"beforeRateKind":    row.BeforeKind,
		"afterRateKind":     row.AfterKind,
		"beforeMitesPer100": per100FromRate(row.Before, row.BeforeKind),
		"afterMitesPer100":  per100FromRate(row.After, row.AfterKind),
		"efficacyPercent":   row.efficacyPercent(),
	}
}

// per100FromRate keeps the existing frontend field populated when the paired
// rate is a wash/roll. Board pairings use beforeRate/afterRate instead.
func per100FromRate(rate *float64, kind *string) *float64 {
	if rate == nil || kind == nil || *kind != "per_100" {
		return nil
	}
	return rate
}

func (s *Server) loadVarroaSettings(r *http.Request) recs.VarroaSettings {
	settings, err := recs.LoadVarroaSettings(r.Context(), s.pool, time.Now())
	if err != nil {
		return recs.VarroaSettings{
			ThresholdPer100:   recs.SeasonalWashThreshold(time.Now()),
			ThresholdPerDay:   recs.DefaultBoardThresholdPerDay,
			CheckIntervalDays: recs.SeasonalMiteCheckDays(time.Now()),
		}
	}
	return settings
}

func countOverThreshold(method string, per100, perDay *float64, settings recs.VarroaSettings) bool {
	return recs.OverThreshold(method, per100, perDay, settings)
}

func (s *Server) miteCountList(w http.ResponseWriter, r *http.Request) {
	rawInspection := strings.TrimSpace(r.URL.Query().Get("inspectionId"))
	rawHive := strings.TrimSpace(r.URL.Query().Get("hiveId"))
	if rawInspection == "" && rawHive == "" {
		writeError(w, http.StatusBadRequest, "hiveId or inspectionId is required")
		return
	}
	var hiveID uuid.UUID
	var inspectionID *uuid.UUID
	if rawHive != "" {
		id, err := uuid.Parse(rawHive)
		if err != nil {
			writeError(w, http.StatusBadRequest, "invalid hiveId")
			return
		}
		hiveID = id
	}
	if rawInspection != "" {
		id, err := uuid.Parse(rawInspection)
		if err != nil {
			writeError(w, http.StatusBadRequest, "invalid inspectionId")
			return
		}
		inspectionID = &id
		var inspectionHive uuid.UUID
		err = s.pool.QueryRow(r.Context(),
			`SELECT hive_id FROM inspections WHERE id=$1`, id).Scan(&inspectionHive)
		if errors.Is(err, pgx.ErrNoRows) {
			writeError(w, http.StatusNotFound, "inspection not found")
			return
		}
		if err != nil {
			writeError(w, http.StatusInternalServerError, "database error")
			return
		}
		if hiveID == uuid.Nil {
			hiveID = inspectionHive
		} else if hiveID != inspectionHive {
			writeError(w, http.StatusBadRequest, "inspectionId does not belong to hiveId")
			return
		}
	}
	if !s.requireHiveRole(w, r, hiveID, false) {
		return
	}

	query := `
		SELECT ` + miteCountSelectCols + `
		FROM mite_counts
		WHERE deleted_at IS NULL AND hive_id = $1`
	args := []any{hiveID}
	if inspectionID != nil {
		query += ` AND inspection_id = $2`
		args = append(args, *inspectionID)
	}
	query += ` ORDER BY date, method`

	rows, err := s.pool.Query(r.Context(), query, args...)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	defer rows.Close()
	out := make([]miteCountJSON, 0)
	for rows.Next() {
		row, err := scanMiteCount(rows)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "database error")
			return
		}
		out = append(out, row)
	}
	if rows.Err() != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	writeJSON(w, http.StatusOK, out)
}

func (s *Server) miteCountCreate(w http.ResponseWriter, r *http.Request) {
	var req miteCountPayload
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	date, err := parseDate(req.Date)
	if err != nil || req.HiveID == uuid.Nil {
		writeError(w, http.StatusBadRequest, "hiveId, date, method, and a non-negative mite count are required")
		return
	}
	if err := normalizeMiteCount(&req); err != nil {
		writeError(w, http.StatusBadRequest, "hiveId, date, method, and a non-negative mite count are required")
		return
	}
	if !s.requireHiveRole(w, r, req.HiveID, true) {
		return
	}
	if req.InspectionID != nil {
		var ok bool
		if err := s.pool.QueryRow(r.Context(), `
			SELECT EXISTS (SELECT 1 FROM inspections WHERE id = $1 AND hive_id = $2)`,
			*req.InspectionID, req.HiveID).Scan(&ok); err != nil {
			writeError(w, http.StatusInternalServerError, "database error")
			return
		}
		if !ok {
			writeError(w, http.StatusBadRequest, "inspectionId does not belong to hiveId")
			return
		}
	}

	if req.Overwrite {
		id, per100, perDay, found, err := overwriteLiveMiteCount(r.Context(), s.pool, req, date)
		if err != nil {
			if honeyIsFKViolation(err) {
				writeError(w, http.StatusBadRequest, "invalid hiveId or inspectionId")
				return
			}
			writeError(w, http.StatusInternalServerError, "database error")
			return
		}
		if found {
			writeJSON(w, http.StatusOK, miteCountResponse(id, per100, perDay))
			return
		}
	}

	id, per100, perDay, err := insertMiteCount(r.Context(), s.pool, req, date, actorID(r))
	if err != nil {
		if honeyIsFKViolation(err) {
			writeError(w, http.StatusBadRequest, "invalid hiveId or inspectionId")
			return
		}
		if miteCountIsUniqueViolation(err) {
			existing, loadErr := loadLiveMiteCountConflict(r.Context(), s.pool, req, date)
			if loadErr != nil && !errors.Is(loadErr, pgx.ErrNoRows) {
				writeError(w, http.StatusInternalServerError, "database error")
				return
			}
			writeMiteCountConflict(w, existing)
			return
		}
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	writeJSON(w, http.StatusCreated, miteCountResponse(id, per100, perDay))
}

func (s *Server) miteCountUpdate(w http.ResponseWriter, r *http.Request) {
	id, err := uuidParam(r, "id")
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	var body struct {
		// The UI echoes hiveId back; it is validated against the row, never changed.
		HiveID      *uuid.UUID `json:"hiveId"`
		Date        *string    `json:"date"`
		Method      *string    `json:"method"`
		MitesCount  *int       `json:"mitesCount"`
		SampleSize  *int       `json:"sampleSize"`
		DaysOnBoard *int       `json:"daysOnBoard"`
		Notes       *string    `json:"notes"`
	}
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}

	var current miteCountPayload
	var currentDate time.Time
	err = s.pool.QueryRow(r.Context(), `
		SELECT hive_id, inspection_id, date, method, mites_count, sample_size, days_on_board, notes
		FROM mite_counts WHERE id = $1 AND deleted_at IS NULL`, id).Scan(
		&current.HiveID, &current.InspectionID, &currentDate, &current.Method,
		&current.MitesCount, &current.SampleSize, &current.DaysOnBoard, &current.Notes)
	if errors.Is(err, pgx.ErrNoRows) {
		writeError(w, http.StatusNotFound, "mite count not found")
		return
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	if body.HiveID != nil && *body.HiveID != current.HiveID {
		writeError(w, http.StatusBadRequest, "hiveId cannot be changed")
		return
	}
	date := currentDate
	if body.Date != nil {
		parsed, err := parseDate(*body.Date)
		if err != nil {
			writeError(w, http.StatusBadRequest, "invalid date")
			return
		}
		date = parsed
	}
	if body.Method != nil {
		current.Method = *body.Method
	}
	if body.MitesCount != nil {
		current.MitesCount = *body.MitesCount
	}
	if body.SampleSize != nil {
		current.SampleSize = body.SampleSize
	}
	if body.DaysOnBoard != nil {
		current.DaysOnBoard = body.DaysOnBoard
	}
	if body.Notes != nil {
		current.Notes = body.Notes
	}
	if err := normalizeMiteCount(&current); err != nil {
		writeError(w, http.StatusBadRequest, "invalid mite count")
		return
	}

	var per100, perDay *float64
	err = s.pool.QueryRow(r.Context(), `
		UPDATE mite_counts
		SET date = $2, method = $3, mites_count = $4, sample_size = $5,
			days_on_board = $6, notes = $7
		WHERE id = $1 AND deleted_at IS NULL
		RETURNING mites_per_100, mites_per_day`,
		id, date, current.Method, current.MitesCount, current.SampleSize,
		current.DaysOnBoard, honeyTrimPtr(current.Notes)).Scan(&per100, &perDay)
	if errors.Is(err, pgx.ErrNoRows) {
		writeError(w, http.StatusNotFound, "mite count not found")
		return
	}
	if err != nil {
		writeDBError(w, err,
			"a mite count already exists for this hive, date, and method",
			"invalid mite count")
		return
	}
	writeJSON(w, http.StatusOK, miteCountResponse(id, per100, perDay))
}

func (s *Server) miteCountDelete(w http.ResponseWriter, r *http.Request) {
	id, err := uuidParam(r, "id")
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	tag, err := s.pool.Exec(r.Context(), `
		UPDATE mite_counts
		SET deleted_at = now(), deleted_by = $2
		WHERE id = $1 AND deleted_at IS NULL`, id, actorID(r))
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	if tag.RowsAffected() == 0 {
		writeError(w, http.StatusNotFound, "mite count not found")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"success": true})
}
