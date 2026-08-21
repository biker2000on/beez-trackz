package httpapi

import (
	"context"
	"errors"
	"fmt"
	"html/template"
	"io"
	"log/slog"
	"math"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/biker2000on/beez-trackz/backend/internal/config"
	"github.com/biker2000on/beez-trackz/backend/internal/notify"
)

// mountOps wires units-adjacent operations: ntfy dispatch, yard-visit labor
// minutes, and the authenticated compliance packet. Distinct from
// mountOperations (treatments / varroa / yard queue).
func (s *Server) mountOps(r chi.Router) {
	r.Get("/ops/units", s.handleUnitsGet)
	r.Get("/ops/labor/current", s.handleLaborCurrent)
	r.Get("/ops/labor", s.handleLaborList)
	r.Post("/ops/labor/start", s.handleLaborStart)
	r.Post("/ops/labor/stop", s.handleLaborStop)

	admin := r.With(s.requireAdmin)
	admin.Get("/ops/compliance-packet", s.handleCompliancePacket)
	admin.Get("/ops/compliance-packet/print", s.handleCompliancePacket)
	admin.Post("/ops/ntfy/dispatch", s.handleNtfyDispatch)
	admin.Post("/ops/ntfy/test", s.handleNtfyTest)
}

// GET /ops/units — canonical display preference for any authenticated user.
// Admin settings remains the writer; API payloads stay in storage units.
func (s *Server) handleUnitsGet(w http.ResponseWriter, r *http.Request) {
	var units, temperature *string
	err := s.pool.QueryRow(r.Context(), `
		SELECT units, temperature_unit FROM user_settings LIMIT 1`).
		Scan(&units, &temperature)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"units":           units,
		"temperatureUnit": temperature,
	})
}

func laborElapsedMinutes(started time.Time, stopped *time.Time, now time.Time) int {
	end := now
	if stopped != nil {
		end = *stopped
	}
	d := end.Sub(started)
	if d < 0 {
		return 0
	}
	return int(math.Round(d.Minutes()))
}

type laborSessionJSON struct {
	ID         uuid.UUID  `json:"id"`
	ApiaryID   *uuid.UUID `json:"apiaryId"`
	ApiaryName *string    `json:"apiaryName"`
	StartedAt  time.Time  `json:"startedAt"`
	StoppedAt  *time.Time `json:"stoppedAt"`
	Minutes    int        `json:"minutes"`
	Notes      *string    `json:"notes"`
	Open       bool       `json:"open"`
}

func laborScan(row pgx.Row, now time.Time) (laborSessionJSON, error) {
	var v laborSessionJSON
	err := row.Scan(&v.ID, &v.ApiaryID, &v.ApiaryName, &v.StartedAt, &v.StoppedAt, &v.Notes)
	if err != nil {
		return v, err
	}
	v.Open = v.StoppedAt == nil
	v.Minutes = laborElapsedMinutes(v.StartedAt, v.StoppedAt, now)
	return v, nil
}

const laborSelectSQL = `
	SELECT s.id, s.apiary_id, a.name, s.started_at, s.stopped_at, s.notes
	FROM yard_labor_sessions s
	LEFT JOIN apiaries a ON a.id = s.apiary_id`

func (s *Server) laborTrackingOn(ctx context.Context) (bool, error) {
	var enabled bool
	err := s.pool.QueryRow(ctx, `
		SELECT labor_tracking_enabled FROM user_settings LIMIT 1`).Scan(&enabled)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, nil
	}
	return enabled, err
}

func (s *Server) laborOpenFor(ctx context.Context, userID uuid.UUID, now time.Time) (*laborSessionJSON, error) {
	v, err := laborScan(s.pool.QueryRow(ctx, laborSelectSQL+`
		WHERE s.deleted_at IS NULL AND s.stopped_at IS NULL AND s.created_by = $1
		ORDER BY s.started_at DESC LIMIT 1`, userID), now)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &v, nil
}

func (s *Server) handleLaborCurrent(w http.ResponseWriter, r *http.Request) {
	user := principalFrom(r)
	now := time.Now()
	session, err := s.laborOpenFor(r.Context(), user.ID, now)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	enabled, err := s.laborTrackingOn(r.Context())
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"enabled": enabled,
		"current": session,
	})
}

func (s *Server) handleLaborList(w http.ResponseWriter, r *http.Request) {
	user := principalFrom(r)
	now := time.Now()
	rows, err := s.pool.Query(r.Context(), laborSelectSQL+`
		WHERE s.deleted_at IS NULL
		  AND (
			$1::boolean
			OR s.created_by = $2
			OR (s.apiary_id IS NOT NULL AND EXISTS (
				SELECT 1 FROM apiary_memberships membership
				WHERE membership.user_id = $2 AND membership.apiary_id = s.apiary_id
			))
		  )
		ORDER BY s.started_at DESC
		LIMIT 100`, user.IsAdmin, user.ID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	defer rows.Close()
	items := make([]laborSessionJSON, 0)
	for rows.Next() {
		item, err := laborScan(rows, now)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "database error")
			return
		}
		items = append(items, item)
	}
	if rows.Err() != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": items})
}

func (s *Server) handleLaborStart(w http.ResponseWriter, r *http.Request) {
	enabled, err := s.laborTrackingOn(r.Context())
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	if !enabled {
		writeError(w, http.StatusBadRequest, "labor tracking is off")
		return
	}
	var req struct {
		ApiaryID *string `json:"apiaryId"`
		Notes    *string `json:"notes"`
	}
	if err := decodeJSON(r, &req); err != nil && !errors.Is(err, io.EOF) {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	var apiaryID *uuid.UUID
	if req.ApiaryID != nil && strings.TrimSpace(*req.ApiaryID) != "" {
		id, err := uuid.Parse(strings.TrimSpace(*req.ApiaryID))
		if err != nil {
			writeError(w, http.StatusBadRequest, "invalid apiaryId")
			return
		}
		if !s.requireApiaryRole(w, r, id, true) {
			return
		}
		apiaryID = &id
	}
	user := principalFrom(r)
	now := time.Now()
	open, err := s.laborOpenFor(r.Context(), user.ID, now)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	if open != nil {
		writeError(w, http.StatusConflict, "a yard visit is already running")
		return
	}
	session, err := laborScan(s.pool.QueryRow(r.Context(), `
		INSERT INTO yard_labor_sessions (apiary_id, started_at, notes, created_by)
		VALUES ($1, $2, $3, $4)
		RETURNING id, apiary_id,
			(SELECT name FROM apiaries WHERE id = $1),
			started_at, stopped_at, notes`,
		apiaryID, now, honeyTrimPtr(req.Notes), user.ID), now)
	if err != nil {
		if inspectionIsFKViolation(err) {
			writeError(w, http.StatusBadRequest, "Apiary not found")
			return
		}
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	writeJSON(w, http.StatusCreated, session)
}

func (s *Server) handleLaborStop(w http.ResponseWriter, r *http.Request) {
	var req struct {
		ID    *string `json:"id"`
		Notes *string `json:"notes"`
	}
	if err := decodeJSON(r, &req); err != nil && !errors.Is(err, io.EOF) {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	user := principalFrom(r)
	now := time.Now()
	var id uuid.UUID
	if req.ID != nil && strings.TrimSpace(*req.ID) != "" {
		parsed, err := uuid.Parse(strings.TrimSpace(*req.ID))
		if err != nil {
			writeError(w, http.StatusBadRequest, "invalid id")
			return
		}
		id = parsed
	} else {
		open, err := s.laborOpenFor(r.Context(), user.ID, now)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "database error")
			return
		}
		if open == nil {
			writeError(w, http.StatusNotFound, "no running yard visit")
			return
		}
		id = open.ID
	}
	session, err := laborScan(s.pool.QueryRow(r.Context(), `
		UPDATE yard_labor_sessions
		SET stopped_at = $2,
			notes = COALESCE($3, notes)
		WHERE id = $1 AND deleted_at IS NULL AND stopped_at IS NULL
		  AND ($4::boolean OR created_by = $5)
		RETURNING id, apiary_id,
			(SELECT name FROM apiaries WHERE id = yard_labor_sessions.apiary_id),
			started_at, stopped_at, notes`,
		id, now, honeyTrimPtr(req.Notes), user.IsAdmin, user.ID), now)
	if errors.Is(err, pgx.ErrNoRows) {
		writeError(w, http.StatusNotFound, "running yard visit not found")
		return
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	writeJSON(w, http.StatusOK, session)
}

type ntfySettings struct {
	cfg     notify.Config
	enabled bool
	kinds   map[string]bool
}

func (s *Server) loadNtfySettings(ctx context.Context) (ntfySettings, error) {
	var (
		out                        ntfySettings
		server, topic, accessToken *string
		kinds                      []string
	)
	err := s.pool.QueryRow(ctx, `
		SELECT ntfy_server_url, ntfy_topic, ntfy_access_token,
			ntfy_enabled, ntfy_event_kinds
		FROM user_settings LIMIT 1`).
		Scan(&server, &topic, &accessToken, &out.enabled, &kinds)
	if errors.Is(err, pgx.ErrNoRows) {
		return out, nil
	}
	if err != nil {
		return out, err
	}
	out.cfg.ServerURL = prefsOr(server, "")
	out.cfg.Topic = prefsOr(topic, "")
	out.cfg.AccessToken = prefsOr(accessToken, "")
	out.kinds = map[string]bool{}
	if len(kinds) == 0 {
		if out.enabled {
			for _, kind := range notify.KnownKinds {
				out.kinds[kind] = true
			}
		}
		return out, nil
	}
	for _, kind := range kinds {
		if notify.ValidKind(kind) {
			out.kinds[kind] = true
		}
	}
	return out, nil
}

func (s *Server) ntfyClient() *notify.Client {
	return notify.New(nil)
}

type ntfyCandidate struct {
	Kind     string
	Key      string
	Title    string
	Body     string
	Priority int
	Tags     string
}

func ntfyPriority(recPriority string) int {
	switch recPriority {
	case "urgent":
		return 5
	case "high":
		return 4
	default:
		return 3
	}
}

// collectNtfyCandidates is the same event set the yard queue surfaces:
// mite check due, feeder empty, treatment off-date, flow started.
func (s *Server) collectNtfyCandidates(ctx context.Context, now time.Time) ([]ntfyCandidate, error) {
	out := make([]ntfyCandidate, 0)

	recRows, err := s.pool.Query(ctx, `
		SELECT rec.id, rec.message, rec.priority, h.position_label, a.name
		FROM ai_recommendations rec
		LEFT JOIN hives h ON h.id = rec.hive_id
		LEFT JOIN apiaries a ON a.id = h.apiary_id
		WHERE `+recPendingWhere+`
		  AND rec.type = 'mite_check_due'`)
	if err != nil {
		return nil, err
	}
	for recRows.Next() {
		var (
			id       uuid.UUID
			message  string
			priority string
			hiveName *string
			apiary   *string
		)
		if err := recRows.Scan(&id, &message, &priority, &hiveName, &apiary); err != nil {
			recRows.Close()
			return nil, err
		}
		body := message
		if hiveName != nil && *hiveName != "" {
			body = *hiveName + " — " + message
		}
		if apiary != nil && *apiary != "" {
			body = *apiary + ": " + body
		}
		out = append(out, ntfyCandidate{
			Kind: notify.KindMiteCheckDue, Key: id.String(),
			Title: "Sample for mites", Body: body,
			Priority: ntfyPriority(priority), Tags: "bee,warning",
		})
	}
	recErr := recRows.Err()
	recRows.Close()
	if recErr != nil {
		return nil, recErr
	}

	user := &principal{IsAdmin: true}
	feedRows, err := s.listFeedingStatus(ctx, user)
	if err != nil {
		return nil, err
	}
	for _, row := range feedRows {
		if row.State == feedingStateOK || row.Action == "" {
			continue
		}
		key := row.HiveID.String()
		if row.OldestOpenAt != nil {
			key += ":" + row.OldestOpenAt.UTC().Format("2006-01-02")
		}
		title := row.Action
		if title == "" {
			title = "Check feeder"
		}
		body := row.ApiaryName + " / " + row.HiveName
		if row.Evidence != "" {
			body += " — " + row.Evidence
		}
		priority := 4
		if row.State == feedingStateAttention {
			priority = 5
		}
		out = append(out, ntfyCandidate{
			Kind: notify.KindFeederEmpty, Key: key,
			Title: title, Body: body, Priority: priority, Tags: "bee,droplet",
		})
	}

	treatRows, err := s.pool.Query(ctx, `
		SELECT t.id, t.product, t.date_removed, h.position_label, a.name
		FROM treatment_events t
		JOIN hives h ON h.id = t.hive_id
		JOIN apiaries a ON a.id = h.apiary_id
		WHERE t.date_removed IS NOT NULL`)
	if err != nil {
		return nil, err
	}
	today := calendarDate(now)
	yesterday := today.AddDate(0, 0, -1)
	for treatRows.Next() {
		var (
			id       uuid.UUID
			product  string
			removed  time.Time
			hiveName string
			apiary   string
		)
		if err := treatRows.Scan(&id, &product, &removed, &hiveName, &apiary); err != nil {
			treatRows.Close()
			return nil, err
		}
		off := calendarDate(removed)
		if off.Before(yesterday) || off.After(today) {
			continue
		}
		if product == "" {
			product = "Treatment"
		}
		out = append(out, ntfyCandidate{
			Kind: notify.KindTreatmentOffDate, Key: id.String(),
			Title:    "Treatment off-date",
			Body:     fmt.Sprintf("%s / %s — %s off %s", apiary, hiveName, product, off.Format("2006-01-02")),
			Priority: 4, Tags: "bee,pill",
		})
	}
	treatErr := treatRows.Err()
	treatRows.Close()
	if treatErr != nil {
		return nil, treatErr
	}

	bloomRows, err := s.pool.Query(ctx, `
		SELECT b.id, b.species, b.date_first_seen, a.name
		FROM bloom_observations b
		JOIN apiaries a ON a.id = b.apiary_id
		WHERE b.date_last_seen IS NULL
		  AND b.date_first_seen >= $1::date`, today.AddDate(0, 0, -2))
	if err != nil {
		return nil, err
	}
	for bloomRows.Next() {
		var (
			id      uuid.UUID
			species string
			first   time.Time
			apiary  string
		)
		if err := bloomRows.Scan(&id, &species, &first, &apiary); err != nil {
			bloomRows.Close()
			return nil, err
		}
		out = append(out, ntfyCandidate{
			Kind: notify.KindFlowStarted, Key: id.String(),
			Title:    "Flow started",
			Body:     fmt.Sprintf("Flow started at %s (%s)", apiary, species),
			Priority: 3, Tags: "bee,blossom",
		})
	}
	bloomErr := bloomRows.Err()
	bloomRows.Close()
	if bloomErr != nil {
		return nil, bloomErr
	}

	return out, nil
}

type ntfyDispatchResult struct {
	Published int      `json:"published"`
	Skipped   int      `json:"skipped"`
	Errors    []string `json:"errors"`
	Reason    string   `json:"reason,omitempty"`
}

// runNtfyDispatch is the shared core behind POST /ops/ntfy/dispatch and the
// worker's post-recommendation hook. Deduplication is the ntfy_dispatches
// receipt insert; a failed publish drops its receipt so a later run retries.
func (s *Server) runNtfyDispatch(ctx context.Context, now time.Time) (ntfyDispatchResult, error) {
	result := ntfyDispatchResult{Errors: []string{}}
	settings, err := s.loadNtfySettings(ctx)
	if err != nil {
		return result, err
	}
	if !settings.enabled || !settings.cfg.Configured() {
		result.Reason = "ntfy is not configured"
		return result, nil
	}
	candidates, err := s.collectNtfyCandidates(ctx, now)
	if err != nil {
		return result, err
	}
	client := s.ntfyClient()
	for _, item := range candidates {
		if !settings.kinds[item.Kind] {
			result.Skipped++
			continue
		}
		var dispatchID uuid.UUID
		err := s.pool.QueryRow(ctx, `
			INSERT INTO ntfy_dispatches (event_kind, event_key, title, body)
			VALUES ($1, $2, $3, $4)
			ON CONFLICT (event_kind, event_key) DO NOTHING
			RETURNING id`,
			item.Kind, item.Key, item.Title, item.Body).Scan(&dispatchID)
		if errors.Is(err, pgx.ErrNoRows) {
			result.Skipped++
			continue
		}
		if err != nil {
			result.Errors = append(result.Errors, err.Error())
			continue
		}
		if pubErr := client.Publish(ctx, settings.cfg, notify.Message{
			Title: item.Title, Body: item.Body,
			Priority: item.Priority, Tags: item.Tags, Kind: item.Kind,
		}); pubErr != nil {
			// Drop the receipt so a later dispatch retries; fail-soft here.
			_, _ = s.pool.Exec(ctx, `DELETE FROM ntfy_dispatches WHERE id = $1`, dispatchID)
			slog.Warn("ntfy publish failed", "kind", item.Kind, "err", pubErr)
			result.Errors = append(result.Errors, item.Kind+": "+pubErr.Error())
			continue
		}
		result.Published++
	}
	return result, nil
}

func (s *Server) handleNtfyDispatch(w http.ResponseWriter, r *http.Request) {
	result, err := s.runNtfyDispatch(r.Context(), time.Now())
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	writeJSON(w, http.StatusOK, result)
}

// NewBackgroundDispatcher returns a Server wired only for background ntfy
// dispatch — no routes are mounted. The worker binary hangs it after the
// recommendation run so pushes are hands-free.
func NewBackgroundDispatcher(cfg *config.Config, pool *pgxpool.Pool) *Server {
	return &Server{cfg: cfg, pool: pool}
}

// DispatchNtfy publishes due notifications, deduplicated by the receipt
// table, and is safe to run repeatedly. Fail-soft: a push failure is logged,
// never returned, so it cannot fail the job that triggered it.
func (s *Server) DispatchNtfy(ctx context.Context) {
	result, err := s.runNtfyDispatch(ctx, time.Now())
	if err != nil {
		slog.Warn("ntfy dispatch", "err", err)
		return
	}
	if result.Published > 0 || len(result.Errors) > 0 {
		slog.Info("ntfy dispatch",
			"published", result.Published,
			"skipped", result.Skipped,
			"errors", len(result.Errors))
	}
}

func (s *Server) handleNtfyTest(w http.ResponseWriter, r *http.Request) {
	settings, err := s.loadNtfySettings(r.Context())
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	if !settings.cfg.Configured() {
		writeJSON(w, http.StatusOK, map[string]any{
			"success": false,
			"error":   "ntfy is not configured",
		})
		return
	}
	err = s.ntfyClient().Publish(r.Context(), settings.cfg, notify.Message{
		Title:    "Beez Trackz",
		Body:     "Test notification from Beez Trackz.",
		Priority: 3,
		Tags:     "bee",
	})
	if err != nil {
		writeJSON(w, http.StatusOK, map[string]any{
			"success": false,
			"error":   err.Error(),
		})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"success": true})
}

type complianceHive struct {
	ID            uuid.UUID  `json:"id"`
	ApiaryID      uuid.UUID  `json:"apiaryId"`
	ApiaryName    string     `json:"apiaryName"`
	PositionLabel string     `json:"positionLabel"`
	Status        string     `json:"status"`
	InstalledDate *time.Time `json:"installedDate"`
	DeadoutDate   *time.Time `json:"deadoutDate"`
	IsArchived    bool       `json:"isArchived"`
}

type complianceTreatment struct {
	ID             uuid.UUID  `json:"id"`
	HiveID         uuid.UUID  `json:"hiveId"`
	HiveName       string     `json:"hiveName"`
	ApiaryName     string     `json:"apiaryName"`
	Product        string     `json:"product"`
	Method         *string    `json:"method"`
	DateApplied    time.Time  `json:"dateApplied"`
	DateRemoved    *time.Time `json:"dateRemoved"`
	WithdrawalDays int        `json:"withdrawalDays"`
}

type complianceLot struct {
	ID             uuid.UUID `json:"id"`
	LotCode        string    `json:"lotCode"`
	ExtractionDate time.Time `json:"extractionDate"`
	HoneyWeightLbs float64   `json:"honeyWeightLbs"`
	HoneyVariety   *string   `json:"honeyVariety"`
	Season         *string   `json:"season"`
	MoisturePct    *float64  `json:"moisturePct"`
	IsPublic       bool      `json:"isPublic"`
}

type complianceSaleLine struct {
	Kind      string `json:"kind"`
	Quantity  int    `json:"quantity"`
	Label     string `json:"label"`
	UnitPrice money  `json:"unitPrice"`
}

type complianceSale struct {
	ID          uuid.UUID            `json:"id"`
	Date        time.Time            `json:"date"`
	Channel     string               `json:"channel"`
	OrderNumber *string              `json:"orderNumber"`
	OrderStatus string               `json:"orderStatus"`
	Customer    *string              `json:"customerName"`
	LotCode     *string              `json:"harvestLotCode"`
	TotalAmount money                `json:"totalAmount"`
	AmountPaid  money                `json:"amountPaid"`
	Lines       []complianceSaleLine `json:"lines"`
}

type complianceWindow struct {
	HiveID         uuid.UUID  `json:"hiveId"`
	HiveName       string     `json:"hiveName"`
	ApiaryName     string     `json:"apiaryName"`
	Product        string     `json:"product"`
	TreatmentOn    bool       `json:"treatmentOn"`
	Locked         bool       `json:"locked"`
	DateApplied    time.Time  `json:"dateApplied"`
	DateRemoved    *time.Time `json:"dateRemoved"`
	LockoutUntil   *time.Time `json:"lockoutUntil"`
	WithdrawalDays int        `json:"withdrawalDays"`
	Message        string     `json:"message"`
}

type compliancePacket struct {
	ExportedAt        time.Time             `json:"exportedAt"`
	Hives             []complianceHive      `json:"hives"`
	Treatments        []complianceTreatment `json:"treatments"`
	Lots              []complianceLot       `json:"lots"`
	Sales             []complianceSale      `json:"sales"`
	WithdrawalWindows []complianceWindow    `json:"withdrawalWindows"`
}

func complianceDate(value any) string {
	var date time.Time
	switch typed := value.(type) {
	case time.Time:
		date = typed
	case *time.Time:
		if typed == nil {
			return "—"
		}
		date = *typed
	default:
		return "—"
	}
	if date.IsZero() {
		return "—"
	}
	return date.Format("2006-01-02")
}

func complianceText(value *string) string {
	if value == nil || strings.TrimSpace(*value) == "" {
		return "—"
	}
	return *value
}

func complianceDecimal(value *float64) string {
	if value == nil {
		return "—"
	}
	return fmt.Sprintf("%.2f", *value)
}

var compliancePrintTemplate = template.Must(template.New("compliance").Funcs(template.FuncMap{
	"date":    complianceDate,
	"text":    complianceText,
	"decimal": complianceDecimal,
	"money": func(value money) string {
		return fmt.Sprintf("$%.2f", value.Dollars())
	},
	"yesno": func(value bool) string {
		if value {
			return "Yes"
		}
		return "No"
	},
}).Parse(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Beez Trackz compliance packet</title>
<style>
  :root { color-scheme: light; font-family: Arial, sans-serif; font-size: 10pt; }
  body { margin: 0 auto; max-width: 11in; color: #111; }
  header { border-bottom: 2px solid #111; margin-bottom: 1.2rem; padding-bottom: .7rem; }
  h1 { font-size: 22pt; margin: 0 0 .2rem; }
  h2 { break-after: avoid; font-size: 14pt; margin: 1.4rem 0 .4rem; }
  p { margin: .2rem 0; }
  table { border-collapse: collapse; font-size: 8pt; width: 100%; }
  th, td { border: 1px solid #bbb; padding: .25rem .3rem; text-align: left; vertical-align: top; }
  th { background: #eee; }
  tr { break-inside: avoid; }
  .muted { color: #555; }
  .print { margin-bottom: 1rem; }
  .lines { margin: .2rem 0 0; padding-left: 1rem; }
  @page { margin: .55in; size: landscape; }
  @media print { body { max-width: none; } .print { display: none; } }
</style>
</head>
<body>
<button class="print" onclick="window.print()">Print / save as PDF</button>
<header><h1>Beez Trackz compliance packet</h1><p class="muted">Exported {{.ExportedAt.UTC.Format "2006-01-02 15:04 MST"}}</p></header>

<h2>Hives ({{len .Hives}})</h2>
<table><thead><tr><th>Record ID</th><th>Apiary</th><th>Hive</th><th>Status</th><th>Installed</th><th>Deadout</th><th>Archived</th></tr></thead><tbody>
{{range .Hives}}<tr><td>{{.ID}}</td><td>{{.ApiaryName}}<br><span class="muted">{{.ApiaryID}}</span></td><td>{{.PositionLabel}}</td><td>{{.Status}}</td><td>{{date .InstalledDate}}</td><td>{{date .DeadoutDate}}</td><td>{{yesno .IsArchived}}</td></tr>{{else}}<tr><td colspan="7">No hives</td></tr>{{end}}
</tbody></table>

<h2>Treatments ({{len .Treatments}})</h2>
<table><thead><tr><th>Record ID</th><th>Apiary / hive</th><th>Product / method</th><th>Applied</th><th>Removed</th><th>Withdrawal days</th></tr></thead><tbody>
{{range .Treatments}}<tr><td>{{.ID}}</td><td>{{.ApiaryName}} / {{.HiveName}}<br><span class="muted">{{.HiveID}}</span></td><td>{{.Product}} / {{text .Method}}</td><td>{{date .DateApplied}}</td><td>{{date .DateRemoved}}</td><td>{{.WithdrawalDays}}</td></tr>{{else}}<tr><td colspan="6">No treatments</td></tr>{{end}}
</tbody></table>

<h2>Harvest lots ({{len .Lots}})</h2>
<table><thead><tr><th>Record ID</th><th>Lot</th><th>Extraction date</th><th>Weight (canonical lb)</th><th>Variety</th><th>Season</th><th>Moisture %</th><th>Public</th></tr></thead><tbody>
{{range .Lots}}<tr><td>{{.ID}}</td><td>{{.LotCode}}</td><td>{{date .ExtractionDate}}</td><td>{{printf "%.2f" .HoneyWeightLbs}}</td><td>{{text .HoneyVariety}}</td><td>{{text .Season}}</td><td>{{decimal .MoisturePct}}</td><td>{{yesno .IsPublic}}</td></tr>{{else}}<tr><td colspan="8">No harvest lots</td></tr>{{end}}
</tbody></table>

<h2>Sales ({{len .Sales}})</h2>
<table><thead><tr><th>Record ID / date</th><th>Channel / status</th><th>Order / customer / lot</th><th>Lines</th><th>Total</th><th>Paid</th></tr></thead><tbody>
{{range .Sales}}<tr><td>{{.ID}}<br>{{date .Date}}</td><td>{{.Channel}} / {{.OrderStatus}}</td><td>{{text .OrderNumber}}<br>{{text .Customer}}<br>{{text .LotCode}}</td><td>{{range .Lines}}<div>{{.Quantity}} × {{.Label}} ({{.Kind}}) @ {{money .UnitPrice}}</div>{{else}}—{{end}}</td><td>{{money .TotalAmount}}</td><td>{{money .AmountPaid}}</td></tr>{{else}}<tr><td colspan="6">No sales</td></tr>{{end}}
</tbody></table>

<h2>Withdrawal windows ({{len .WithdrawalWindows}})</h2>
<table><thead><tr><th>Hive</th><th>Product</th><th>Applied</th><th>Removed</th><th>Lockout until</th><th>Treatment on</th><th>Locked</th><th>Withdrawal days</th><th>Status</th></tr></thead><tbody>
{{range .WithdrawalWindows}}<tr><td>{{.ApiaryName}} / {{.HiveName}}<br><span class="muted">{{.HiveID}}</span></td><td>{{.Product}}</td><td>{{date .DateApplied}}</td><td>{{date .DateRemoved}}</td><td>{{date .LockoutUntil}}</td><td>{{yesno .TreatmentOn}}</td><td>{{yesno .Locked}}</td><td>{{.WithdrawalDays}}</td><td>{{.Message}}</td></tr>{{else}}<tr><td colspan="9">No withdrawal windows</td></tr>{{end}}
</tbody></table>
</body></html>`))

func (s *Server) handleCompliancePacket(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	now := time.Now().UTC()

	hiveRows, err := s.pool.Query(ctx, `
		SELECT h.id, h.apiary_id, a.name, h.position_label, h.status::text,
			h.installed_date, h.deadout_date, h.is_archived
		FROM hives h
		JOIN apiaries a ON a.id = h.apiary_id
		ORDER BY a.name, h.position_label`)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	hives := make([]complianceHive, 0)
	hiveIDs := make([]uuid.UUID, 0)
	for hiveRows.Next() {
		var hive complianceHive
		if err := hiveRows.Scan(&hive.ID, &hive.ApiaryID, &hive.ApiaryName,
			&hive.PositionLabel, &hive.Status, &hive.InstalledDate,
			&hive.DeadoutDate, &hive.IsArchived); err != nil {
			hiveRows.Close()
			writeError(w, http.StatusInternalServerError, "database error")
			return
		}
		hives = append(hives, hive)
		hiveIDs = append(hiveIDs, hive.ID)
	}
	hiveErr := hiveRows.Err()
	hiveRows.Close()
	if hiveErr != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}

	treatRows, err := s.pool.Query(ctx, `
		SELECT t.id, t.hive_id, h.position_label, a.name, t.product, t.method,
			t.date_applied, t.date_removed, t.withdrawal_days
		FROM treatment_events t
		JOIN hives h ON h.id = t.hive_id
		JOIN apiaries a ON a.id = h.apiary_id
		ORDER BY t.date_applied DESC, h.position_label`)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	treatments := make([]complianceTreatment, 0)
	for treatRows.Next() {
		var item complianceTreatment
		if err := treatRows.Scan(&item.ID, &item.HiveID, &item.HiveName, &item.ApiaryName,
			&item.Product, &item.Method, &item.DateApplied, &item.DateRemoved,
			&item.WithdrawalDays); err != nil {
			treatRows.Close()
			writeError(w, http.StatusInternalServerError, "database error")
			return
		}
		treatments = append(treatments, item)
	}
	treatErr := treatRows.Err()
	treatRows.Close()
	if treatErr != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}

	lotRows, err := s.pool.Query(ctx, `
		SELECT id, lot_code, extraction_date, honey_weight_lbs, honey_variety,
			season, moisture_pct, is_public
		FROM harvest_lots
		ORDER BY extraction_date DESC, lot_code`)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	lots := make([]complianceLot, 0)
	for lotRows.Next() {
		var lot complianceLot
		if err := lotRows.Scan(&lot.ID, &lot.LotCode, &lot.ExtractionDate,
			&lot.HoneyWeightLbs, &lot.HoneyVariety, &lot.Season,
			&lot.MoisturePct, &lot.IsPublic); err != nil {
			lotRows.Close()
			writeError(w, http.StatusInternalServerError, "database error")
			return
		}
		lots = append(lots, lot)
	}
	lotErr := lotRows.Err()
	lotRows.Close()
	if lotErr != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}

	saleRows, err := s.pool.Query(ctx, `
		SELECT s.id, s.date, s.channel, s.order_number, s.order_status,
			COALESCE(c.name, s.customer_name), lot.lot_code,
			s.total_amount_cents, s.amount_paid_cents
		FROM sales s
		LEFT JOIN customers c ON c.id = s.customer_id
		LEFT JOIN harvest_lots lot ON lot.id = s.harvest_lot_id
		WHERE s.order_status <> 'cancelled'
		ORDER BY s.date DESC, s.created_at DESC`)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	sales := make([]complianceSale, 0)
	saleIndex := map[uuid.UUID]int{}
	for saleRows.Next() {
		var sale complianceSale
		if err := saleRows.Scan(&sale.ID, &sale.Date, &sale.Channel, &sale.OrderNumber,
			&sale.OrderStatus, &sale.Customer, &sale.LotCode,
			&sale.TotalAmount, &sale.AmountPaid); err != nil {
			saleRows.Close()
			writeError(w, http.StatusInternalServerError, "database error")
			return
		}
		sale.Lines = []complianceSaleLine{}
		saleIndex[sale.ID] = len(sales)
		sales = append(sales, sale)
	}
	saleErr := saleRows.Err()
	saleRows.Close()
	if saleErr != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}

	lineRows, err := s.pool.Query(ctx, `
		SELECT i.sale_id, i.kind, i.quantity, i.unit_price_cents,
			COALESCE(js.label, p.name, h.position_label, 'line')
		FROM sale_items i
		JOIN sales s ON s.id = i.sale_id AND s.order_status <> 'cancelled'
		LEFT JOIN jar_sizes js ON js.id = i.jar_size_id
		LEFT JOIN product_catalog p ON p.id = i.product_id
		LEFT JOIN hives h ON h.id = i.hive_id
		ORDER BY i.sale_id, i.id`)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	for lineRows.Next() {
		var (
			saleID uuid.UUID
			line   complianceSaleLine
		)
		if err := lineRows.Scan(&saleID, &line.Kind, &line.Quantity, &line.UnitPrice, &line.Label); err != nil {
			lineRows.Close()
			writeError(w, http.StatusInternalServerError, "database error")
			return
		}
		idx, ok := saleIndex[saleID]
		if !ok {
			continue
		}
		sales[idx].Lines = append(sales[idx].Lines, line)
	}
	lineErr := lineRows.Err()
	lineRows.Close()
	if lineErr != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}

	lockouts, err := loadHiveLockouts(ctx, s.pool, hiveIDs, now)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	windows := make([]complianceWindow, 0)
	for _, hive := range hives {
		st := lockouts[hive.ID]
		if !st.Locked && st.Product == "" {
			continue
		}
		windows = append(windows, complianceWindow{
			HiveID: hive.ID, HiveName: hive.PositionLabel, ApiaryName: hive.ApiaryName,
			Product: st.Product, TreatmentOn: st.TreatmentOn, Locked: st.Locked,
			DateApplied: st.DateApplied, DateRemoved: st.DateRemoved,
			LockoutUntil: st.Until, WithdrawalDays: st.WithdrawalDays,
			Message: lockoutMessage(st),
		})
	}

	packet := compliancePacket{
		ExportedAt: now, Hives: hives, Treatments: treatments, Lots: lots,
		Sales: sales, WithdrawalWindows: windows,
	}
	if strings.HasSuffix(r.URL.Path, "/print") {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.Header().Set("Content-Disposition", "inline")
		w.Header().Set("Content-Security-Policy",
			"default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'")
		if err := compliancePrintTemplate.Execute(w, packet); err != nil {
			slog.Error("render compliance packet", "err", err)
		}
		return
	}
	w.Header().Set("Content-Disposition",
		`attachment; filename="beez-trackz-compliance-`+now.Format("2006-01-02")+`.json"`)
	writeJSON(w, http.StatusOK, packet)
}
