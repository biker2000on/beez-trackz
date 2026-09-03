package httpapi

import (
	"context"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Default refractometer cutoff. Honey above this ferments; override on
// user_settings.moisture_threshold_pct.
const defaultMoistureThreshold = 18.6

type queryRower interface {
	Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error)
	QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
}

// hiveLockoutJSON is the lockout payload on a hive or lot.
type hiveLockoutJSON struct {
	Locked         bool       `json:"locked"`
	TreatmentOn    bool       `json:"treatmentOn"`
	LockoutUntil   *time.Time `json:"lockoutUntil"`
	Product        *string    `json:"product"`
	DateApplied    *time.Time `json:"dateApplied"`
	DateRemoved    *time.Time `json:"dateRemoved"`
	WithdrawalDays int        `json:"withdrawalDays"`
	Message        string     `json:"message"`
	// TreatmentEventID is the treatment driving the lockout so the UI can
	// end it via PATCH /treatment-events/{id}.
	TreatmentEventID *string `json:"treatmentEventId"`
}

type treatmentLockoutRow struct {
	ID             uuid.UUID
	HiveID         uuid.UUID
	Product        string
	DateApplied    time.Time
	DateRemoved    *time.Time
	WithdrawalDays int
}

type lockoutStatus struct {
	TreatmentID uuid.UUID
	// HiveID is the hive the tainting treatment was applied to, so a refusal
	// can name the box the operator has to go look at.
	HiveID         uuid.UUID
	Locked         bool
	TreatmentOn    bool
	Until          *time.Time
	Product        string
	DateApplied    time.Time
	DateRemoved    *time.Time
	WithdrawalDays int
}

func calendarDate(t time.Time) time.Time {
	// Date-only values are stored as midnight. A timestamptz of
	// 2026-08-10 00:00 UTC (Postgres date literal) is 20:00 the previous
	// evening in America/New_York — using t.Date() in Local shortens every
	// withdrawal window by a day. Treat UTC midnight as that UTC civil date.
	utc := t.UTC()
	if utc.Hour() == 0 && utc.Minute() == 0 && utc.Second() == 0 && utc.Nanosecond() == 0 {
		y, m, d := utc.Date()
		return time.Date(y, m, d, 0, 0, 0, 0, time.UTC)
	}
	y, m, d := t.Date()
	return time.Date(y, m, d, 0, 0, 0, 0, t.Location())
}

// --- future-dating guard -------------------------------------------------
//
// Every lockout rule is evaluated at a client-supplied date: refuseHiveHarvest
// takes the harvest date, refuseLotBottling the bottled date. A date past the
// end of the withdrawal window therefore reports "clear" no matter what is
// actually on the hive today, which turns the whole lockout into an opt-out —
// type next month's date and the tainted honey is extracted, bottled, and
// jarred with no refusal anywhere.
//
// Backdating stays legal: an operator writing up yesterday's extraction is the
// normal case, and a backdated record can only ever be *more* locked. Only
// forward-dating is refused.

// dateIsFuture reports whether a supplied date's calendar day is later than
// the server's today. Today is projected into the supplied date's own location
// before the comparison, so an operator east or west of UTC is not judged
// against a midnight in someone else's zone.
func dateIsFuture(date, now time.Time) bool {
	day := calendarDate(date)
	// Project the instant into the date's zone FIRST. Taking now.Date() and
	// then relabelling those fields with day.Location() keeps UTC's calendar
	// day under another zone's name: at 03:00 UTC on the 25th it is still the
	// 24th in UTC-08, so a submitted local "25th" would be waved through as
	// today — a whole extra bypass day — while east of UTC the operator's real
	// today gets refused as the future.
	y, m, d := now.In(day.Location()).Date()
	today := time.Date(y, m, d, 0, 0, 0, 0, day.Location())
	return day.After(today)
}

// refuseFutureDate returns a user-facing refusal for a forward-dated record,
// or "" when the date is today or earlier. field names the request field so
// the operator knows which box to fix.
func refuseFutureDate(date time.Time, field string) string {
	if !dateIsFuture(date, time.Now()) {
		return ""
	}
	return field + " cannot be in the future: dating a record past a treatment " +
		"withdrawal window would clear a lockout that has not actually ended"
}

func lockoutEndDate(removed time.Time, days int) time.Time {
	return calendarDate(removed).AddDate(0, 0, days)
}

func evaluateTreatment(row treatmentLockoutRow, asOf time.Time) lockoutStatus {
	st := lockoutStatus{
		TreatmentID:    row.ID,
		HiveID:         row.HiveID,
		Product:        row.Product,
		DateApplied:    row.DateApplied,
		DateRemoved:    row.DateRemoved,
		WithdrawalDays: row.WithdrawalDays,
	}
	asOfDay := calendarDate(asOf)
	if row.DateRemoved == nil {
		st.Locked = true
		st.TreatmentOn = true
		return st
	}
	until := lockoutEndDate(*row.DateRemoved, row.WithdrawalDays)
	st.Until = &until
	st.Locked = asOfDay.Before(until)
	return st
}

func lockoutWorse(a, b lockoutStatus) bool {
	if !a.Locked {
		return false
	}
	if !b.Locked {
		return true
	}
	if a.TreatmentOn != b.TreatmentOn {
		return a.TreatmentOn
	}
	if a.Until != nil && b.Until != nil {
		return a.Until.After(*b.Until)
	}
	return a.TreatmentOn
}

func pickLockout(rows []treatmentLockoutRow, asOf time.Time) lockoutStatus {
	var best lockoutStatus
	for _, row := range rows {
		st := evaluateTreatment(row, asOf)
		if lockoutWorse(st, best) {
			best = st
		}
	}
	return best
}

func lockoutMessage(st lockoutStatus) string {
	if !st.Locked {
		return ""
	}
	product := strings.TrimSpace(st.Product)
	if product == "" {
		product = "treatment"
	}
	if st.TreatmentOn {
		if st.WithdrawalDays > 0 {
			return fmt.Sprintf(
				"This honey cannot be extracted/sold until %d days after %s is removed",
				st.WithdrawalDays, product)
		}
		return fmt.Sprintf("This honey cannot be extracted/sold until %s is removed", product)
	}
	if st.Until != nil {
		return fmt.Sprintf(
			"This honey cannot be extracted/sold until %s",
			calendarDate(*st.Until).Format("2006-01-02"))
	}
	return "This honey cannot be extracted/sold until the withdrawal window ends"
}

func (st lockoutStatus) toJSON() *hiveLockoutJSON {
	out := &hiveLockoutJSON{
		Locked:         st.Locked,
		TreatmentOn:    st.TreatmentOn,
		LockoutUntil:   st.Until,
		WithdrawalDays: st.WithdrawalDays,
		Message:        lockoutMessage(st),
	}
	if st.Product != "" {
		p := st.Product
		out.Product = &p
	}
	if !st.DateApplied.IsZero() {
		applied := st.DateApplied
		out.DateApplied = &applied
	}
	out.DateRemoved = st.DateRemoved
	if st.TreatmentID != uuid.Nil {
		tid := st.TreatmentID.String()
		out.TreatmentEventID = &tid
	}
	return out
}

func loadTreatmentsAsOf(ctx context.Context, q queryRower, hiveIDs []uuid.UUID, asOf time.Time) ([]treatmentLockoutRow, error) {
	if len(hiveIDs) == 0 {
		return nil, nil
	}
	rows, err := q.Query(ctx, `
		SELECT id, hive_id, product, date_applied, date_removed, withdrawal_days
		FROM treatment_events
		WHERE hive_id = ANY($1) AND date_applied::date <= $2::date
		  AND deleted_at IS NULL
		ORDER BY date_applied DESC`, hiveIDs, calendarDate(asOf))
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]treatmentLockoutRow, 0)
	for rows.Next() {
		var row treatmentLockoutRow
		if err := rows.Scan(&row.ID, &row.HiveID, &row.Product, &row.DateApplied,
			&row.DateRemoved, &row.WithdrawalDays); err != nil {
			return nil, err
		}
		out = append(out, row)
	}
	return out, rows.Err()
}

func hiveLockoutAsOf(ctx context.Context, q queryRower, hiveID uuid.UUID, asOf time.Time) (lockoutStatus, error) {
	rows, err := loadTreatmentsAsOf(ctx, q, []uuid.UUID{hiveID}, asOf)
	if err != nil {
		return lockoutStatus{}, err
	}
	return pickLockout(rows, asOf), nil
}

func loadHiveLockouts(ctx context.Context, q queryRower, hiveIDs []uuid.UUID, asOf time.Time) (map[uuid.UUID]lockoutStatus, error) {
	out := make(map[uuid.UUID]lockoutStatus, len(hiveIDs))
	for _, id := range hiveIDs {
		out[id] = lockoutStatus{}
	}
	rows, err := loadTreatmentsAsOf(ctx, q, hiveIDs, asOf)
	if err != nil {
		return nil, err
	}
	byHive := make(map[uuid.UUID][]treatmentLockoutRow, len(hiveIDs))
	for _, row := range rows {
		byHive[row.HiveID] = append(byHive[row.HiveID], row)
	}
	for id, list := range byHive {
		out[id] = pickLockout(list, asOf)
	}
	return out, nil
}

// lotLockoutAsOf walks a lot back to the hives its honey came from and reports
// the worst withdrawal window covering them.
//
// deleted_at IS NULL below is what makes production.RebaseDerivedLotCeilings
// refuse to soft-delete a harvest behind a bottled lot: a deleted harvest drops out of
// this walk, and with it the treatment that justified or blocked the jars
// already on the shelf. The refusal, not this filter, is what keeps the
// provenance of bottled honey reconstructable.
func lotLockoutAsOf(ctx context.Context, q queryRower, lotID uuid.UUID, asOf time.Time) (lockoutStatus, error) {
	rows, err := q.Query(ctx, `
		SELECT hh.hive_id, hh.date
		FROM harvest_lot_harvests lhh
		JOIN honey_harvests hh ON hh.id = lhh.harvest_id
		WHERE lhh.lot_id = $1 AND hh.deleted_at IS NULL`, lotID)
	if err != nil {
		return lockoutStatus{}, err
	}
	defer rows.Close()
	type source struct {
		hiveID uuid.UUID
		date   time.Time
	}
	sources := make([]source, 0)
	hiveSeen := map[uuid.UUID]bool{}
	hiveIDs := make([]uuid.UUID, 0)
	for rows.Next() {
		var src source
		if err := rows.Scan(&src.hiveID, &src.date); err != nil {
			return lockoutStatus{}, err
		}
		sources = append(sources, src)
		if !hiveSeen[src.hiveID] {
			hiveSeen[src.hiveID] = true
			hiveIDs = append(hiveIDs, src.hiveID)
		}
	}
	if err := rows.Err(); err != nil {
		return lockoutStatus{}, err
	}
	if len(sources) == 0 {
		return lockoutStatus{}, nil
	}
	// Treatments applied after a harvest do not taint that harvest. Load
	// everything applied on or before the latest source date, then filter
	// per harvest.
	var latest time.Time
	for _, src := range sources {
		if latest.IsZero() || src.date.After(latest) {
			latest = src.date
		}
	}
	treatments, err := loadTreatmentsAsOf(ctx, q, hiveIDs, latest)
	if err != nil {
		return lockoutStatus{}, err
	}
	var best lockoutStatus
	for _, src := range sources {
		var forHive []treatmentLockoutRow
		for _, row := range treatments {
			if row.HiveID == src.hiveID && !calendarDate(row.DateApplied).After(calendarDate(src.date)) {
				forHive = append(forHive, row)
			}
		}
		st := pickLockout(forHive, src.date)
		if lockoutWorse(st, best) {
			best = st
		}
	}
	if !best.Locked && best.Until == nil && !best.TreatmentOn {
		return lockoutStatus{}, nil
	}
	// Sale / display as-of: still blocked if the inherited until-date is in
	// the future or the tainting treatment is still on.
	best.Locked = best.TreatmentOn ||
		(best.Until != nil && calendarDate(asOf).Before(*best.Until))
	return best, nil
}

func refuseHiveHarvest(ctx context.Context, q queryRower, hiveID uuid.UUID, asOf time.Time) (string, error) {
	st, err := hiveLockoutAsOf(ctx, q, hiveID, asOf)
	if err != nil {
		return "", err
	}
	if !st.Locked {
		return "", nil
	}
	return lockoutMessage(st), nil
}

func refuseLotSale(ctx context.Context, q queryRower, lotID uuid.UUID, asOf time.Time) (string, error) {
	st, err := lotLockoutAsOf(ctx, q, lotID, asOf)
	if err != nil {
		return "", err
	}
	if !st.Locked {
		return "", nil
	}
	return lockoutMessage(st), nil
}

func (s *Server) attachHiveLockouts(ctx context.Context, items []hiveJSON, asOf time.Time) error {
	if len(items) == 0 {
		return nil
	}
	ids := make([]uuid.UUID, 0, len(items))
	for _, item := range items {
		id, err := uuid.Parse(item.ID)
		if err != nil {
			continue
		}
		ids = append(ids, id)
	}
	byHive, err := loadHiveLockouts(ctx, s.pool, ids, asOf)
	if err != nil {
		return err
	}
	for i := range items {
		id, err := uuid.Parse(items[i].ID)
		if err != nil {
			continue
		}
		items[i].Lockout = byHive[id].toJSON()
	}
	return nil
}

func (s *Server) fillHiveLockout(ctx context.Context, hive *hiveJSON) error {
	items := []hiveJSON{*hive}
	if err := s.attachHiveLockouts(ctx, items, time.Now()); err != nil {
		return err
	}
	hive.Lockout = items[0].Lockout
	return nil
}

func (s *Server) resolveWithdrawalDays(ctx context.Context, product string) (int, error) {
	var days int
	err := s.pool.QueryRow(ctx, `
		SELECT withdrawal_days FROM treatment_products
		WHERE name_key = lower(btrim($1))
		   OR EXISTS (
			SELECT 1 FROM unnest(aliases) alias
			WHERE lower(btrim(alias)) = lower(btrim($1))
		   )
		LIMIT 1`, product).Scan(&days)
	if err == nil {
		return days, nil
	}
	if err == pgx.ErrNoRows {
		return 0, nil
	}
	return 0, err
}

func (s *Server) moistureThreshold(ctx context.Context) (float64, error) {
	var threshold *float64
	err := s.pool.QueryRow(ctx, `
		SELECT moisture_threshold_pct FROM user_settings LIMIT 1`).Scan(&threshold)
	if err != nil && err != pgx.ErrNoRows {
		return 0, err
	}
	if threshold == nil {
		return defaultMoistureThreshold, nil
	}
	return *threshold, nil
}

func validateMoisturePct(pct *float64) string {
	if pct == nil {
		return ""
	}
	if *pct < 0 || *pct > 100 {
		return "Moisture must be between 0 and 100"
	}
	return ""
}

func moistureOverThreshold(pct *float64, threshold float64) string {
	if pct == nil {
		return ""
	}
	if *pct > threshold {
		return fmt.Sprintf(
			"Moisture %.1f%% is over the %.1f%% harvest threshold",
			*pct, threshold)
	}
	return ""
}

func (s *Server) refuseHarvestMoisture(ctx context.Context, pct *float64) (string, error) {
	if msg := validateMoisturePct(pct); msg != "" {
		return msg, nil
	}
	if pct == nil {
		return "", nil
	}
	threshold, err := s.moistureThreshold(ctx)
	if err != nil {
		return "", err
	}
	return moistureOverThreshold(pct, threshold), nil
}

// --- bottling lockout ---------------------------------------------------
//
// Jar lines are not traced back to a lot, so a jar sale off a locked lot can
// only be caught at the moment the jars are created. Bottling is lot-traced,
// which makes the bottling run the one chokepoint where the withdrawal window
// can still be enforced: refuse there and the tainted honey never becomes
// untraceable jars.

// bottlingLockoutMessage names the hive, the product, and the date the honey
// clears, which is what the operator needs to decide what to do next.
func bottlingLockoutMessage(st lockoutStatus, lotCode, hiveLabel string) string {
	if !st.Locked {
		return ""
	}
	product := strings.TrimSpace(st.Product)
	if product == "" {
		product = "a treatment"
	}
	where := "the source hive"
	if label := strings.TrimSpace(hiveLabel); label != "" {
		where = "hive " + label
	}
	lot := strings.TrimSpace(lotCode)
	if lot == "" {
		lot = "This lot"
	} else {
		lot = "Lot " + lot
	}
	if st.TreatmentOn {
		if st.WithdrawalDays > 0 {
			return fmt.Sprintf(
				"%s cannot be bottled: %s is still on %s; this honey clears %d days after it is removed",
				lot, product, where, st.WithdrawalDays)
		}
		return fmt.Sprintf(
			"%s cannot be bottled: %s is still on %s; this honey clears once it is removed",
			lot, product, where)
	}
	if st.Until != nil {
		return fmt.Sprintf(
			"%s cannot be bottled: %s was applied to %s; this honey clears %s",
			lot, product, where, calendarDate(*st.Until).Format("2006-01-02"))
	}
	return fmt.Sprintf(
		"%s cannot be bottled: %s was applied to %s and the withdrawal window has not ended",
		lot, product, where)
}

// hiveLabelFor resolves a hive's position label for a refusal message. A
// missing label is not an error — the message falls back to "the source hive".
func hiveLabelFor(ctx context.Context, q queryRower, hiveID uuid.UUID) string {
	if hiveID == uuid.Nil {
		return ""
	}
	var label *string
	if err := q.QueryRow(ctx,
		`SELECT position_label FROM hives WHERE id = $1`, hiveID).Scan(&label); err != nil {
		return ""
	}
	if label == nil {
		return ""
	}
	return *label
}

// refuseLotBottling applies the same rule refuseLotSale applies to sales: if
// any hive that fed the lot was inside a treatment withdrawal window when the
// honey was pulled, the honey cannot be bottled. Empty message = allowed.
func refuseLotBottling(ctx context.Context, q queryRower, lotID uuid.UUID, lotCode string, asOf time.Time) (string, error) {
	st, err := lotLockoutAsOf(ctx, q, lotID, asOf)
	if err != nil {
		return "", err
	}
	if !st.Locked {
		return "", nil
	}
	return bottlingLockoutMessage(st, lotCode, hiveLabelFor(ctx, q, st.HiveID)), nil
}

// --- moisture override ---------------------------------------------------

// maxMoistureOverrideReason bounds the free-text reason so a stray paste
// cannot become an unbounded column write.
const maxMoistureOverrideReason = 500

// moistureOverrideReq is the request-side shape of the override. Embed it in a
// handler's request struct so every moisture entry point spells it the same
// way.
type moistureOverrideReq struct {
	MoistureOverride       bool    `json:"moistureOverride"`
	MoistureOverrideReason *string `json:"moistureOverrideReason"`
}

// moistureOverrideDecision is the pure rule behind the override tier. It
// returns a refusal message (empty = accept) and, on an accepted override, the
// trimmed reason to record. Under threshold the override is dropped: there is
// nothing to justify, so no reason is stamped.
func moistureOverrideDecision(pct *float64, threshold float64, ov moistureOverrideReq) (string, *string) {
	if msg := validateMoisturePct(pct); msg != "" {
		return msg, nil
	}
	over := moistureOverThreshold(pct, threshold)
	if over == "" {
		return "", nil
	}
	if !ov.MoistureOverride {
		// Unchanged behaviour: without an explicit override this is a hard
		// reject, so nobody drifts past the threshold by accident.
		return over, nil
	}
	reason := ""
	if ov.MoistureOverrideReason != nil {
		reason = strings.TrimSpace(*ov.MoistureOverrideReason)
	}
	if reason == "" {
		return over + ". Set moistureOverrideReason to record why it is being accepted anyway", nil
	}
	if len(reason) > maxMoistureOverrideReason {
		return fmt.Sprintf("moistureOverrideReason cannot exceed %d characters",
			maxMoistureOverrideReason), nil
	}
	return "", &reason
}

// refuseLotMoisture is the server-side wrapper: it reads the operator's
// threshold and applies moistureOverrideDecision.
func (s *Server) refuseLotMoisture(ctx context.Context, pct *float64, ov moistureOverrideReq) (string, *string, error) {
	if msg := validateMoisturePct(pct); msg != "" {
		return msg, nil, nil
	}
	if pct == nil {
		return "", nil, nil
	}
	threshold, err := s.moistureThreshold(ctx)
	if err != nil {
		return "", nil, err
	}
	msg, reason := moistureOverrideDecision(pct, threshold, ov)
	return msg, reason, nil
}

// stampMoistureOverride records an accepted override on the lot, or clears a
// previous one when reason is nil. Writing the whole triple together keeps the
// "reason present iff overridden" invariant the table CHECK enforces.
func stampMoistureOverride(ctx context.Context, q inspectionQuerier, lotID uuid.UUID, reason *string, actor *uuid.UUID) error {
	if reason == nil {
		_, err := q.Exec(ctx, `
			UPDATE harvest_lots
			SET moisture_override_reason = NULL,
			    moisture_override_by = NULL,
			    moisture_override_at = NULL
			WHERE id = $1`, lotID)
		return err
	}
	// Re-stamp who/when only when the justification actually changed; an
	// unrelated edit that re-submits the same reason must not replace the
	// original attribution the audit tier exists to keep.
	_, err := q.Exec(ctx, `
		UPDATE harvest_lots
		SET moisture_override_by = CASE
				WHEN moisture_override_reason IS DISTINCT FROM $2 THEN $3
				ELSE moisture_override_by END,
		    moisture_override_at = CASE
				WHEN moisture_override_reason IS DISTINCT FROM $2 THEN now()
				ELSE moisture_override_at END,
		    moisture_override_reason = $2
		WHERE id = $1`, lotID, *reason, actor)
	return err
}

// compile-time check that the pool satisfies queryRower
var _ queryRower = (*pgxpool.Pool)(nil)
