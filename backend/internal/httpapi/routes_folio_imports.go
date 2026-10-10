package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/biker2000on/beez-trackz/backend/internal/app"
	"github.com/biker2000on/beez-trackz/backend/internal/gnucashsync"
)

// Categorizing what the Folio history import brought in, and resolving the
// conflicts it raised. Everything here changes Atlas only: categorizing never
// writes to Folio (see routes_folio_import.go), and an imported entry is
// never pushed back.

// otherIncomeCategories is the other_income.category CHECK list (00064/00011).
//
// sales_deposit is "this money is sales Atlas already recorded": it, and any
// entry linked to a specific sale, is excluded from reported income so the
// same revenue is not counted twice. The *_sales categories are for sales
// Atlas never recorded — history from before Atlas, typically.
//
// There is no "refund" category: a refund from a supplier is a NEGATIVE
// expense (gnucashsync.ClassifyImport), and money paid back to a customer is
// negative other income in whatever category the original income had.
var otherIncomeCategories = []string{
	"uncategorized", "sales_deposit", "honey_sales", "colony_sales",
	"product_sales", "pollination", "services", "grant", "other",
}

// unlinkedIncomeSQL selects, over other_income aliased oi, the deposits that
// may be Atlas sales nobody has linked yet: live, positive, not linked to a
// sale, and either uncategorized or in a sales category (honey, colony,
// product) — the ones that overlap what Atlas records as sales. Grants,
// pollination, services and "other" are the operator's statement that the
// money is not an Atlas sale, and a sales deposit is already excluded from
// income. Reports and the To-categorize list prompt the operator to link
// these, so revenue is not counted twice.
const unlinkedIncomeSQL = `oi.deleted_at IS NULL AND oi.sale_id IS NULL AND oi.amount_cents > 0
	AND oi.category IN ('uncategorized', 'honey_sales', 'colony_sales', 'product_sales')`

func (s *Server) mountFolioImports(r chi.Router) {
	admin := r.With(s.requireAdmin)
	admin.Get("/folio-imports", s.handleFolioEntryList)
	admin.Put("/folio-imports/category", s.handleFolioImportBulkCategory)
	admin.Post("/folio-imports/accept", s.handleFolioImportBulkAccept)
	admin.Post("/folio-imports/keep", s.handleFolioImportBulkKeep)
	admin.Put("/folio-imports/{id}/category", s.handleFolioImportCategory)
	admin.Put("/folio-imports/{id}/sale", s.handleFolioImportSale)
	admin.Get("/folio-imports/{id}/sale-candidates", s.handleFolioEntrySaleCandidates)
	admin.Post("/folio-imports/{id}/accept", s.handleFolioImportAccept)
	admin.Post("/folio-imports/{id}/keep", s.handleFolioImportKeep)
}

// folioImportItem is one imported entry rendered for the UI.
type folioImportItem struct {
	ID              uuid.UUID     `json:"id"`
	BookID          uuid.UUID     `json:"bookId"`
	BookLabel       string        `json:"bookLabel"`
	BookRetired     bool          `json:"bookRetired"`
	TransactionGUID string        `json:"transactionGuid"`
	Direction       string        `json:"direction"`
	EntityID        uuid.UUID     `json:"entityId"`
	Date            time.Time     `json:"date"`
	Description     string        `json:"description"`
	Notes           *string       `json:"notes"`
	Amount          money         `json:"amount"`
	Category        string        `json:"category"`
	SaleID          *uuid.UUID    `json:"saleId"`
	SaleSummary     *string       `json:"saleSummary"`
	State           *string       `json:"state"`
	Message         *string       `json:"message"`
	Pending         *folioPending `json:"pending"`
	Deleted         bool          `json:"deleted"`
}

// folioListDefaultLimit / folioListMaxLimit bound GET /folio-imports. The
// default suits the summary card; the Categorize page asks for the maximum so
// a long history is listed whole. Rows needing attention sort first in every
// view, so a capped list never hides one behind categorized history.
const (
	folioListDefaultLimit = 1000
	folioListMaxLimit     = 20000
)

// GET /folio-imports?view=attention|unlinked|all&limit=N — attention (the
// default) is the "To categorize" list plus every conflict; unlinked is
// imported income not linked to an Atlas sale (unlinkedIncomeSQL); all is
// every imported entry. `total` is how many rows the view holds, so a client
// can tell when `limit` cut the list short.
func (s *Server) handleFolioEntryList(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	view := r.URL.Query().Get("view")
	limit := folioListDefaultLimit
	if raw := r.URL.Query().Get("limit"); raw != "" {
		parsed, err := strconv.Atoi(raw)
		if err != nil || parsed < 1 {
			writeError(w, http.StatusBadRequest, "invalid limit")
			return
		}
		limit = min(parsed, folioListMaxLimit)
	}
	filter := `COALESCE(e.deleted_at, oi.deleted_at) IS NULL
		AND (COALESCE(e.category, oi.category) = 'uncategorized' OR fi.state IS NOT NULL)`
	switch view {
	case "all":
		filter = `(COALESCE(e.deleted_at, oi.deleted_at) IS NULL OR fi.state IS NOT NULL)`
	case "unlinked":
		filter = `fi.direction = 'income' AND ` + unlinkedIncomeSQL
	}
	const fromSQL = `
		FROM folio_imports fi
		JOIN gnucash_books b ON b.id = fi.book_id
		LEFT JOIN expenses e ON e.id = fi.expense_id
		LEFT JOIN other_income oi ON oi.id = fi.income_id
		LEFT JOIN sales s ON s.id = oi.sale_id`
	var total int
	if err := s.pool.QueryRow(ctx, `SELECT count(*) `+fromSQL+` WHERE `+filter).Scan(&total); err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	rows, err := s.pool.Query(ctx, `
		SELECT fi.id, fi.book_id, b.label, b.retired_at IS NOT NULL, fi.transaction_guid,
			fi.direction, COALESCE(fi.expense_id, fi.income_id),
			COALESCE(e.expense_date, oi.income_date), COALESCE(e.description, oi.description),
			COALESCE(e.notes, oi.notes), COALESCE(e.amount_cents, oi.amount_cents),
			COALESCE(e.category, oi.category), oi.sale_id,
			NULLIF(concat_ws(' — ', s.order_number, s.customer_name), ''),
			fi.state, fi.message, fi.pending,
			COALESCE(e.deleted_at, oi.deleted_at) IS NOT NULL
		`+fromSQL+`
		WHERE `+filter+`
		ORDER BY fi.state IS NULL,
			NOT (COALESCE(e.deleted_at, oi.deleted_at) IS NULL
				AND COALESCE(e.category, oi.category) = 'uncategorized'),
			COALESCE(e.expense_date, oi.income_date) DESC, fi.created_at DESC
		LIMIT $1`, limit)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	defer rows.Close()
	items := []folioImportItem{}
	for rows.Next() {
		var (
			item        folioImportItem
			pendingJSON []byte
		)
		if err := rows.Scan(&item.ID, &item.BookID, &item.BookLabel, &item.BookRetired,
			&item.TransactionGUID, &item.Direction, &item.EntityID, &item.Date,
			&item.Description, &item.Notes, &item.Amount, &item.Category, &item.SaleID,
			&item.SaleSummary, &item.State, &item.Message, &pendingJSON, &item.Deleted); err != nil {
			writeError(w, http.StatusInternalServerError, "database error")
			return
		}
		if len(pendingJSON) > 0 {
			var pending folioPending
			if json.Unmarshal(pendingJSON, &pending) == nil {
				item.Pending = &pending
			}
		}
		items = append(items, item)
	}
	if rows.Err() != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	counts, err := folioImportCounts(ctx, s.pool)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"items":                 items,
		"total":                 total,
		"counts":                counts,
		"expenseCategories":     gnucashsync.ExpenseCategories,
		"otherIncomeCategories": otherIncomeCategories,
	})
}

// folioImportCountsResult is the badge numbers.
type folioImportCountsResult struct {
	Imported             int `json:"imported"`
	ToCategorize         int `json:"toCategorize"`
	ExpensesToCategorize int `json:"expensesToCategorize"`
	IncomeToCategorize   int `json:"incomeToCategorize"`
	Conflicts            int `json:"conflicts"`
	// UnlinkedIncome / UnlinkedIncomeAmount: imported deposits not linked to
	// an Atlas sale (unlinkedIncomeSQL), all years — the "link them" prompt.
	UnlinkedIncome       int   `json:"unlinkedIncome"`
	UnlinkedIncomeAmount money `json:"unlinkedIncomeAmount"`
}

func folioImportCounts(ctx context.Context, q app.Querier) (folioImportCountsResult, error) {
	var out folioImportCountsResult
	err := q.QueryRow(ctx, `
		SELECT
			count(*) FILTER (WHERE live),
			count(*) FILTER (WHERE live AND category = 'uncategorized'),
			count(*) FILTER (WHERE live AND category = 'uncategorized' AND direction = 'expense'),
			count(*) FILTER (WHERE live AND category = 'uncategorized' AND direction = 'income'),
			count(*) FILTER (WHERE state IS NOT NULL),
			count(*) FILTER (WHERE unlinked),
			COALESCE(SUM(amount_cents) FILTER (WHERE unlinked), 0)
		FROM (
			SELECT fi.direction, fi.state,
				COALESCE(e.category, oi.category) AS category,
				COALESCE(e.deleted_at, oi.deleted_at) IS NULL AS live,
				COALESCE(e.amount_cents, oi.amount_cents) AS amount_cents,
				COALESCE(fi.direction = 'income' AND `+unlinkedIncomeSQL+`, false) AS unlinked
			FROM folio_imports fi
			LEFT JOIN expenses e ON e.id = fi.expense_id
			LEFT JOIN other_income oi ON oi.id = fi.income_id
		) imported`).Scan(&out.Imported, &out.ToCategorize, &out.ExpensesToCategorize,
		&out.IncomeToCategorize, &out.Conflicts, &out.UnlinkedIncome, &out.UnlinkedIncomeAmount)
	return out, err
}

func loadFolioImportByID(ctx context.Context, q app.Querier, id uuid.UUID, lock bool) (folioImportRow, error) {
	query := folioImportSelect + ` WHERE fi.id = $1`
	if lock {
		query += ` FOR UPDATE OF fi`
	}
	row, err := scanFolioImportRow(q.QueryRow(ctx, query, id))
	if errors.Is(err, pgx.ErrNoRows) {
		return folioImportRow{}, app.NotFound("folio import", "imported entry not found")
	}
	if err != nil {
		return folioImportRow{}, app.Internal("folio import", err)
	}
	return row, nil
}

// PUT /folio-imports/{id}/category {"category": "..."} — categorize an
// imported expense or income entry. Atlas only; Folio is not written.
func (s *Server) handleFolioImportCategory(w http.ResponseWriter, r *http.Request) {
	id, err := uuidParam(r, "id")
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid id")
		return
	}
	var req struct {
		Category string `json:"category"`
	}
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	err = app.NewRunner(s.pool).Run(r.Context(), s.gnucashActor(r),
		func(ctx context.Context, uow *app.UnitOfWork) error {
			const op = "categorize imported entry"
			row, err := loadFolioImportByID(ctx, uow, id, true)
			if err != nil {
				return err
			}
			if err := folioCheckCategory(op, row, req.Category); err != nil {
				return err
			}
			return folioApplyCategory(ctx, uow, op, row, req.Category)
		})
	if err != nil {
		writeAppError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"success": true})
}

// folioCheckCategory is the validation every categorize path shares: the
// entry still exists in Atlas and the category is one its direction allows
// (expense categories for expenses and refunds, other-income categories for
// income). "uncategorized" puts an entry back on the list.
func folioCheckCategory(op string, row folioImportRow, category string) error {
	if row.EntityDeleted {
		return app.Conflict(op, "This entry was removed from Atlas")
	}
	if row.Direction == gnucashsync.ImportExpense {
		if row.ExpenseID == nil || (category != "uncategorized" && !expenseCategories[category]) {
			return app.Invalid(op, "unknown expense category %q", category).WithField("category")
		}
		return nil
	}
	if row.IncomeID == nil || !containsString(otherIncomeCategories, category) {
		return app.Invalid(op, "unknown income category %q", category).WithField("category")
	}
	return nil
}

// folioApplyCategory writes a category folioCheckCategory accepted. Atlas
// only; Folio is not written.
func folioApplyCategory(ctx context.Context, uow *app.UnitOfWork, op string, row folioImportRow, category string) error {
	var err error
	if row.Direction == gnucashsync.ImportExpense {
		_, err = uow.Exec(ctx, `UPDATE expenses SET category = $2 WHERE id = $1`, *row.ExpenseID, category)
	} else {
		_, err = uow.Exec(ctx, `UPDATE other_income SET category = $2 WHERE id = $1`, *row.IncomeID, category)
	}
	return app.Internal(op, err)
}

// folioBulkMaxIDs bounds one bulk request.
const folioBulkMaxIDs = 2000

// folioBulkRejection is one id a bulk request refused, and why.
type folioBulkRejection struct {
	ID     uuid.UUID `json:"id"`
	Reason string    `json:"reason"`
}

// folioBulkError carries the per-id refusals out of the transaction, which
// it rolls back: bulk changes are all-or-nothing.
type folioBulkError struct {
	message  string
	rejected []folioBulkRejection
}

func (e *folioBulkError) Error() string { return e.message }

// folioBulkIDs de-duplicates a bulk request's ids, keeping request order.
func folioBulkIDs(raw []uuid.UUID) ([]uuid.UUID, error) {
	if len(raw) > folioBulkMaxIDs {
		return nil, errors.New("too many entries in one request")
	}
	seen := make(map[uuid.UUID]bool, len(raw))
	ids := make([]uuid.UUID, 0, len(raw))
	for _, id := range raw {
		if id == uuid.Nil || seen[id] {
			continue
		}
		seen[id] = true
		ids = append(ids, id)
	}
	if len(ids) == 0 {
		return nil, errors.New("choose at least one entry")
	}
	return ids, nil
}

// loadFolioImportsByIDs locks and loads the given entries, in request order.
// Ids with no entry are returned separately.
func loadFolioImportsByIDs(ctx context.Context, q app.Querier, ids []uuid.UUID) ([]folioImportRow, []uuid.UUID, error) {
	rows, err := q.Query(ctx, folioImportSelect+` WHERE fi.id = ANY($1) ORDER BY fi.id FOR UPDATE OF fi`, ids)
	if err != nil {
		return nil, nil, err
	}
	defer rows.Close()
	byID := make(map[uuid.UUID]folioImportRow, len(ids))
	for rows.Next() {
		row, err := scanFolioImportRow(rows)
		if err != nil {
			return nil, nil, err
		}
		byID[row.ID] = row
	}
	if err := rows.Err(); err != nil {
		return nil, nil, err
	}
	found := make([]folioImportRow, 0, len(byID))
	var missing []uuid.UUID
	for _, id := range ids {
		if row, ok := byID[id]; ok {
			found = append(found, row)
		} else {
			missing = append(missing, id)
		}
	}
	return found, missing, nil
}

// runFolioBulk loads and locks the ids, asks check for the rows it refuses,
// and only when none is refused applies apply to each row — all in one
// transaction. Any refusal saves nothing and answers 400 with every
// offending id and its reason.
func (s *Server) runFolioBulk(w http.ResponseWriter, r *http.Request, rawIDs []uuid.UUID, op string,
	check func(rows []folioImportRow) []folioBulkRejection,
	apply func(ctx context.Context, uow *app.UnitOfWork, row folioImportRow) error,
) {
	ids, err := folioBulkIDs(rawIDs)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	err = app.NewRunner(s.pool).Run(r.Context(), s.gnucashActor(r),
		func(ctx context.Context, uow *app.UnitOfWork) error {
			rows, missing, err := loadFolioImportsByIDs(ctx, uow, ids)
			if err != nil {
				return app.Internal(op, err)
			}
			var rejected []folioBulkRejection
			for _, id := range missing {
				rejected = append(rejected, folioBulkRejection{ID: id, Reason: "Imported entry not found"})
			}
			rejected = append(rejected, check(rows)...)
			if len(rejected) > 0 {
				noun := "entries"
				if len(rejected) == 1 {
					noun = "entry"
				}
				return &folioBulkError{
					message: strconv.Itoa(len(rejected)) + " selected " + noun +
						" can't be changed; nothing was saved",
					rejected: rejected,
				}
			}
			for _, row := range rows {
				if err := apply(ctx, uow, row); err != nil {
					return err
				}
			}
			return nil
		})
	var bulk *folioBulkError
	if errors.As(err, &bulk) {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": bulk.message, "rejected": bulk.rejected})
		return
	}
	if err != nil {
		writeAppError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"success": true, "updated": len(ids)})
}

// PUT /folio-imports/category {"ids": [...], "category": "..."} — categorize
// many imported entries at once, in one transaction, with the single-row
// rules (folioCheckCategory). The entries must all be one kind — expenses
// (refunds included) or income — since the two have different categories,
// and an entry deleted in Folio must be settled (accept or keep) first. Any
// refusal saves nothing and answers 400 listing each offending id.
func (s *Server) handleFolioImportBulkCategory(w http.ResponseWriter, r *http.Request) {
	var req struct {
		IDs      []uuid.UUID `json:"ids"`
		Category string      `json:"category"`
	}
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	const op = "categorize imported entries"
	s.runFolioBulk(w, r, req.IDs, op,
		func(rows []folioImportRow) []folioBulkRejection {
			return folioBulkCategoryRejections(op, rows, req.Category)
		},
		func(ctx context.Context, uow *app.UnitOfWork, row folioImportRow) error {
			return folioApplyCategory(ctx, uow, op, row, req.Category)
		})
}

// folioBulkCategoryRejections is the bulk categorize check. In a mixed
// selection the smaller kind is what does not belong (a tie names the
// income); every other row gets the single-row check.
func folioBulkCategoryRejections(op string, rows []folioImportRow, category string) []folioBulkRejection {
	expenses, income := 0, 0
	for _, row := range rows {
		if row.Direction == gnucashsync.ImportExpense {
			expenses++
		} else {
			income++
		}
	}
	var minority gnucashsync.ImportDirection
	if expenses > 0 && income > 0 {
		minority = gnucashsync.ImportIncome
		if expenses < income {
			minority = gnucashsync.ImportExpense
		}
	}
	var rejected []folioBulkRejection
	for _, row := range rows {
		var reason string
		switch {
		case minority != "" && row.Direction == minority:
			reason = "Select only expenses or only income"
		case row.State == "remote_deleted" && !row.EntityDeleted:
			reason = "Deleted in Folio: accept or keep it first"
		default:
			if err := folioCheckCategory(op, row, category); err != nil {
				reason = appMessage(err)
			}
		}
		if reason != "" {
			rejected = append(rejected, folioBulkRejection{ID: row.ID, Reason: reason})
		}
	}
	return rejected
}

func containsString(list []string, value string) bool {
	for _, item := range list {
		if item == value {
			return true
		}
	}
	return false
}

// PUT /folio-imports/{id}/sale {"saleId": "..." | null} — say which Atlas sale
// an imported deposit is. A linked entry is excluded from reported income, so
// the sale's revenue is counted once. Linking an uncategorized entry also
// categorizes it as a sales deposit.
func (s *Server) handleFolioImportSale(w http.ResponseWriter, r *http.Request) {
	id, err := uuidParam(r, "id")
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid id")
		return
	}
	var req struct {
		SaleID *uuid.UUID `json:"saleId"`
	}
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	err = app.NewRunner(s.pool).Run(r.Context(), s.gnucashActor(r),
		func(ctx context.Context, uow *app.UnitOfWork) error {
			const op = "link imported income to a sale"
			row, err := loadFolioImportByID(ctx, uow, id, true)
			if err != nil {
				return err
			}
			if row.Direction != gnucashsync.ImportIncome || row.IncomeID == nil {
				return app.Invalid(op, "Only imported income can be linked to a sale")
			}
			if req.SaleID != nil && row.RemoteAmountCents < 0 {
				// Money paid back out is not a sale's deposit.
				return app.Invalid(op, "A reversal (negative income) cannot be linked to a sale")
			}
			if req.SaleID == nil {
				_, err = uow.Exec(ctx, `UPDATE other_income SET sale_id = NULL WHERE id = $1`, *row.IncomeID)
				return app.Internal(op, err)
			}
			var exists bool
			if err := uow.QueryRow(ctx, `
				SELECT EXISTS (SELECT 1 FROM sales WHERE id = $1 AND order_status <> 'cancelled'
					AND cancelled_at IS NULL)`, *req.SaleID).Scan(&exists); err != nil {
				return app.Internal(op, err)
			}
			if !exists {
				return app.NotFound(op, "sale not found")
			}
			_, err = uow.Exec(ctx, `
				UPDATE other_income SET sale_id = $2,
					category = CASE WHEN category = 'uncategorized' THEN 'sales_deposit' ELSE category END
				WHERE id = $1`, *row.IncomeID, *req.SaleID)
			return app.Internal(op, err)
		})
	if err != nil {
		writeAppError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"success": true})
}

// GET /folio-imports/{id}/sale-candidates — sales near an imported deposit's
// date, closest amount first, for the "this deposit is sale X" picker.
func (s *Server) handleFolioEntrySaleCandidates(w http.ResponseWriter, r *http.Request) {
	id, err := uuidParam(r, "id")
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid id")
		return
	}
	ctx := r.Context()
	var (
		date   time.Time
		amount int64
	)
	err = s.pool.QueryRow(ctx, `
		SELECT oi.income_date, oi.amount_cents FROM folio_imports fi
		JOIN other_income oi ON oi.id = fi.income_id WHERE fi.id = $1`, id).Scan(&date, &amount)
	if errors.Is(err, pgx.ErrNoRows) {
		writeError(w, http.StatusNotFound, "imported income not found")
		return
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	rows, err := s.pool.Query(ctx, `
		SELECT s.id, s.date, s.order_number, s.customer_name,
			s.total_amount_cents + COALESCE(s.tax_cents, 0), s.amount_paid_cents
		FROM sales s
		WHERE s.cancelled_at IS NULL AND s.order_status NOT IN ('draft', 'cancelled')
		  AND s.date::date BETWEEN $1::date - 45 AND $1::date + 15
		ORDER BY abs(s.amount_paid_cents - $2), abs(s.date::date - $1::date)
		LIMIT 25`, date, amount)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	defer rows.Close()
	out := []map[string]any{}
	for rows.Next() {
		var (
			saleID          uuid.UUID
			saleDate        time.Time
			order, customer *string
			total, paid     money
		)
		if err := rows.Scan(&saleID, &saleDate, &order, &customer, &total, &paid); err != nil {
			writeError(w, http.StatusInternalServerError, "database error")
			return
		}
		out = append(out, map[string]any{
			"id": saleID, "date": saleDate, "orderNumber": order, "customerName": customer,
			"total": total, "amountPaid": paid,
		})
	}
	writeJSON(w, http.StatusOK, map[string]any{"sales": out})
}

// POST /folio-imports/{id}/accept — take Folio's side of a conflict: apply
// the changed version, or remove (soft-delete) an entry deleted in Folio.
func (s *Server) handleFolioImportAccept(w http.ResponseWriter, r *http.Request) {
	s.resolveFolioImport(w, r, true)
}

// POST /folio-imports/{id}/keep — keep the Atlas entry as it is and dismiss
// the flag. The Folio version is recorded as seen, so it is not raised again.
func (s *Server) handleFolioImportKeep(w http.ResponseWriter, r *http.Request) {
	s.resolveFolioImport(w, r, false)
}

func (s *Server) resolveFolioImport(w http.ResponseWriter, r *http.Request, accept bool) {
	id, err := uuidParam(r, "id")
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid id")
		return
	}
	actor := actorID(r)
	err = app.NewRunner(s.pool).Run(r.Context(), s.gnucashActor(r),
		func(ctx context.Context, uow *app.UnitOfWork) error {
			const op = "resolve imported entry"
			row, err := loadFolioImportByID(ctx, uow, id, true)
			if err != nil {
				return err
			}
			if row.State == "" {
				return app.Conflict(op, "This entry has nothing to resolve")
			}
			return folioResolveRow(ctx, uow, op, row, accept, actor)
		})
	if err != nil {
		writeAppError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"success": true})
}

// folioResolveRow settles one flagged entry: accept takes Folio's side
// (apply the changed version, or remove an entry deleted in Folio); keep
// leaves Atlas as it is and records the Folio version as seen. Shared by the
// single-row and bulk routes.
func folioResolveRow(ctx context.Context, uow *app.UnitOfWork, op string, row folioImportRow,
	accept bool, actor *uuid.UUID) error {
	var pending *folioPending
	if len(row.Pending) > 0 {
		var decoded folioPending
		if json.Unmarshal(row.Pending, &decoded) == nil {
			pending = &decoded
		}
	}
	switch {
	case accept && row.State == "remote_deleted":
		if err := folioSoftDeleteEntity(ctx, uow, row, "Deleted in Folio", actor); err != nil {
			return app.Internal(op, err)
		}
	case accept && row.State == "remote_changed" && pending != nil:
		if err := folioApplyPending(ctx, uow, row, *pending, nil, actor); err != nil {
			return app.Internal(op, err)
		}
		return nil
	case !accept && pending != nil:
		// Keep Atlas's entry; acknowledge the Folio values as seen.
		return app.Internal(op, folioStoreSnapshot(ctx, uow, row.ID, *pending, nil))
	}
	_, err := uow.Exec(ctx, `
		UPDATE folio_imports SET state = NULL, message = NULL, pending = NULL WHERE id = $1`, row.ID)
	return app.Internal(op, err)
}

// POST /folio-imports/accept {"ids": [...]} — "Accept Folio" for many flagged
// entries in one transaction: apply each changed version, remove each entry
// deleted in Folio. Every entry must be flagged, with a Folio version Atlas
// can take ("unrepresentable" ones can only be kept). All-or-nothing.
func (s *Server) handleFolioImportBulkAccept(w http.ResponseWriter, r *http.Request) {
	s.resolveFolioImports(w, r, true)
}

// POST /folio-imports/keep {"ids": [...]} — "Keep Atlas version" for many
// flagged entries in one transaction. All-or-nothing.
func (s *Server) handleFolioImportBulkKeep(w http.ResponseWriter, r *http.Request) {
	s.resolveFolioImports(w, r, false)
}

func (s *Server) resolveFolioImports(w http.ResponseWriter, r *http.Request, accept bool) {
	var req struct {
		IDs []uuid.UUID `json:"ids"`
	}
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	actor := actorID(r)
	const op = "resolve imported entries"
	s.runFolioBulk(w, r, req.IDs, op,
		func(rows []folioImportRow) []folioBulkRejection {
			var rejected []folioBulkRejection
			for _, row := range rows {
				switch {
				case row.State == "":
					rejected = append(rejected, folioBulkRejection{ID: row.ID, Reason: "Nothing to resolve"})
				case accept && row.State == "unrepresentable":
					rejected = append(rejected, folioBulkRejection{ID: row.ID,
						Reason: "Atlas can't take the Folio version of this entry: keep it instead"})
				}
			}
			return rejected
		},
		func(ctx context.Context, uow *app.UnitOfWork, row folioImportRow) error {
			return folioResolveRow(ctx, uow, op, row, accept, actor)
		})
}
