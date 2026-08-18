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
}

type treatmentLockoutRow struct {
	HiveID         uuid.UUID
	Product        string
	DateApplied    time.Time
	DateRemoved    *time.Time
	WithdrawalDays int
}

type lockoutStatus struct {
	Locked         bool
	TreatmentOn    bool
	Until          *time.Time
	Product        string
	DateApplied    time.Time
	DateRemoved    *time.Time
	WithdrawalDays int
}

func calendarDate(t time.Time) time.Time {
	y, m, d := t.In(time.Local).Date()
	return time.Date(y, m, d, 0, 0, 0, 0, time.Local)
}

func lockoutEndDate(removed time.Time, days int) time.Time {
	return calendarDate(removed).AddDate(0, 0, days)
}

func evaluateTreatment(row treatmentLockoutRow, asOf time.Time) lockoutStatus {
	st := lockoutStatus{
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
	return out
}

func loadTreatmentsAsOf(ctx context.Context, q queryRower, hiveIDs []uuid.UUID, asOf time.Time) ([]treatmentLockoutRow, error) {
	if len(hiveIDs) == 0 {
		return nil, nil
	}
	rows, err := q.Query(ctx, `
		SELECT hive_id, product, date_applied, date_removed, withdrawal_days
		FROM treatment_events
		WHERE hive_id = ANY($1) AND date_applied::date <= $2::date
		ORDER BY date_applied DESC`, hiveIDs, calendarDate(asOf))
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]treatmentLockoutRow, 0)
	for rows.Next() {
		var row treatmentLockoutRow
		if err := rows.Scan(&row.HiveID, &row.Product, &row.DateApplied,
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

// compile-time check that the pool satisfies queryRower
var _ queryRower = (*pgxpool.Pool)(nil)
