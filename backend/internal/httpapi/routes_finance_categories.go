package httpapi

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/biker2000on/beez-trackz/backend/internal/app"
)

// Expense and income categories (finance_categories, 00068/00015): the
// operator's own list, not a CHECK constraint. A category's key is the slug
// stored on expenses.category / other_income.category and in the Folio
// account mapping; it is made from the label once, at creation, and never
// changes. The label is renamed freely.
//
// An archived category stays valid on every row that already carries it and
// still displays with its label, but is not offered for — and is refused on —
// new entries. A category is deleted only when no row (soft-deleted ones
// included) names it; otherwise the answer is "archive it instead". System
// categories ('uncategorized', 'sales_deposit', 'bees_queens') are keys the
// code depends on: they can be renamed but never archived or deleted.

const (
	financeKindExpense = "expense"
	financeKindIncome  = "income"
	// financeUncategorized is the system key the Folio history import files
	// new entries under, in both kinds.
	financeUncategorized = "uncategorized"
	financeLabelMaxRunes = 80
)

func (s *Server) mountFinanceCategories(r chi.Router) {
	r.Get("/finance-categories", s.handleFinanceCategoryList)
	admin := r.With(s.requireAdmin)
	admin.Post("/finance-categories", s.handleFinanceCategoryCreate)
	admin.Put("/finance-categories/order", s.handleFinanceCategoryOrder)
	admin.Patch("/finance-categories/{id}", s.handleFinanceCategoryUpdate)
	admin.Delete("/finance-categories/{id}", s.handleFinanceCategoryDelete)
}

// financeCategory is one category as the API renders it.
type financeCategory struct {
	ID         uuid.UUID  `json:"id"`
	Kind       string     `json:"kind"`
	Key        string     `json:"key"`
	Label      string     `json:"label"`
	SortOrder  int        `json:"sortOrder"`
	Archived   bool       `json:"archived"`
	ArchivedAt *time.Time `json:"archivedAt"`
	IsSystem   bool       `json:"isSystem"`
	// UsageCount is the live (not soft-deleted) expenses or income entries
	// filed under the category.
	UsageCount int `json:"usageCount"`
	// Deletable: no row at all names it (soft-deleted rows count, since they
	// still carry the key) and it is not a system category.
	Deletable bool `json:"deletable"`
}

func validFinanceKind(kind string) bool {
	return kind == financeKindExpense || kind == financeKindIncome
}

func financeKindNoun(kind string) string {
	if kind == financeKindIncome {
		return "income"
	}
	return "expense"
}

// GET /finance-categories?kind=expense|income — every category of the kind
// (both kinds when omitted), archived ones included and flagged, in display
// order, with usage counts.
func (s *Server) handleFinanceCategoryList(w http.ResponseWriter, r *http.Request) {
	kind := strings.TrimSpace(r.URL.Query().Get("kind"))
	if kind != "" && !validFinanceKind(kind) {
		writeError(w, http.StatusBadRequest, "kind must be expense or income")
		return
	}
	out, err := listFinanceCategories(r.Context(), s.pool, kind)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	writeJSON(w, http.StatusOK, out)
}

func listFinanceCategories(ctx context.Context, q app.Querier, kind string) ([]financeCategory, error) {
	rows, err := q.Query(ctx, `
		SELECT fc.id, fc.kind, fc.key, fc.label, fc.sort_order, fc.archived_at, fc.is_system,
			COALESCE(u.live, 0)::int, COALESCE(u.total, 0)::int
		FROM finance_categories fc
		LEFT JOIN (
			SELECT 'expense' AS kind, category AS key,
				count(*) FILTER (WHERE deleted_at IS NULL) AS live, count(*) AS total
			FROM expenses GROUP BY category
			UNION ALL
			SELECT 'income', category,
				count(*) FILTER (WHERE deleted_at IS NULL), count(*)
			FROM other_income GROUP BY category
		) u ON u.kind = fc.kind AND u.key = fc.key
		WHERE $1 = '' OR fc.kind = $1
		ORDER BY fc.kind, fc.sort_order, lower(fc.label), fc.key`, kind)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]financeCategory, 0)
	for rows.Next() {
		var row financeCategory
		var total int
		if err := rows.Scan(&row.ID, &row.Kind, &row.Key, &row.Label, &row.SortOrder,
			&row.ArchivedAt, &row.IsSystem, &row.UsageCount, &total); err != nil {
			return nil, err
		}
		row.Archived = row.ArchivedAt != nil
		row.Deletable = !row.IsSystem && total == 0
		out = append(out, row)
	}
	return out, rows.Err()
}

// financeCategoryKeys lists the keys of one kind in display order. activeOnly
// leaves out archived categories (what a picker offers for a new value).
func financeCategoryKeys(ctx context.Context, q app.Querier, kind string, activeOnly bool) ([]string, error) {
	rows, err := q.Query(ctx, `
		SELECT key FROM finance_categories
		WHERE kind = $1 AND (NOT $2 OR archived_at IS NULL)
		ORDER BY sort_order, lower(label), key`, kind, activeOnly)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]string, 0)
	for rows.Next() {
		var key string
		if err := rows.Scan(&key); err != nil {
			return nil, err
		}
		out = append(out, key)
	}
	return out, rows.Err()
}

// withoutKey drops one key from a list, keeping order.
func withoutKey(keys []string, drop string) []string {
	out := make([]string, 0, len(keys))
	for _, key := range keys {
		if key != drop {
			out = append(out, key)
		}
	}
	return out
}

// requireFinanceCategory is the check every write path that stores a
// category runs, inside its transaction: key must name an active category of
// kind. The row is locked FOR KEY SHARE, so a concurrent delete of the
// category waits for this write to commit (and then sees it in use).
func requireFinanceCategory(ctx context.Context, q app.Querier, op, kind, key string) error {
	var label string
	var archivedAt *time.Time
	err := q.QueryRow(ctx, `
		SELECT label, archived_at FROM finance_categories
		WHERE kind = $1 AND key = $2 FOR KEY SHARE`, kind, key).Scan(&label, &archivedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return app.Invalid(op, "unknown %s category %q", financeKindNoun(kind), key).WithField("category")
	}
	if err != nil {
		return app.Internal(op, err)
	}
	if archivedAt != nil {
		return app.Invalid(op, "The %s category %q is archived; choose another or unarchive it in Operation setup",
			financeKindNoun(kind), label).WithField("category")
	}
	return nil
}

// financeCategoryKey makes a key from a label: lowercase ASCII letters and
// digits, everything else one underscore, starting with a letter.
func financeCategoryKey(label string) string {
	var b strings.Builder
	separator := true
	for _, r := range strings.ToLower(label) {
		if (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') {
			b.WriteRune(r)
			separator = false
			continue
		}
		if !separator {
			b.WriteByte('_')
			separator = true
		}
	}
	key := strings.Trim(b.String(), "_")
	if key == "" || key[0] < 'a' || key[0] > 'z' {
		key = strings.TrimSuffix("category_"+key, "_")
	}
	if len(key) > 48 {
		key = strings.TrimRight(key[:48], "_")
	}
	return key
}

// cleanFinanceLabel trims a label and checks it fits the column.
func cleanFinanceLabel(op, raw string) (string, error) {
	label := strings.Join(strings.Fields(raw), " ")
	if label == "" {
		return "", app.Invalid(op, "Name is required").WithField("label")
	}
	if utf8.RuneCountInString(label) > financeLabelMaxRunes {
		return "", app.Invalid(op, "Name must be %d characters or fewer", financeLabelMaxRunes).WithField("label")
	}
	return label, nil
}

// financeCategoryWriteError turns a constraint violation into the
// operator-facing answer; anything else is internal.
func financeCategoryWriteError(op string, err error) error {
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) {
		switch {
		case pgErr.ConstraintName == "finance_categories_label_key":
			return app.Conflict(op, "A category with that name already exists")
		case pgErr.ConstraintName == "finance_categories_kind_key_key":
			return app.Conflict(op, "A category with that key was just created; try again")
		case pgErr.Code == "23503":
			return app.Conflict(op, "This category is in use; archive it instead")
		}
	}
	return app.Internal(op, err)
}

// POST /finance-categories {kind, label} — a new category at the end of its
// list. Its key is made from the label (suffixed _2, _3… when taken).
func (s *Server) handleFinanceCategoryCreate(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Kind  string `json:"kind"`
		Label string `json:"label"`
	}
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	const op = "create category"
	var created financeCategory
	err := app.NewRunner(s.pool).Run(r.Context(), s.gnucashActor(r),
		func(ctx context.Context, uow *app.UnitOfWork) error {
			if !validFinanceKind(req.Kind) {
				return app.Invalid(op, "kind must be expense or income").WithField("kind")
			}
			label, err := cleanFinanceLabel(op, req.Label)
			if err != nil {
				return err
			}
			base := financeCategoryKey(label)
			taken := map[string]bool{}
			rows, err := uow.Query(ctx, `SELECT key FROM finance_categories WHERE kind = $1 AND (key = $2 OR key LIKE $2 || '\_%')`, req.Kind, base)
			if err != nil {
				return app.Internal(op, err)
			}
			for rows.Next() {
				var key string
				if err := rows.Scan(&key); err != nil {
					rows.Close()
					return app.Internal(op, err)
				}
				taken[key] = true
			}
			rows.Close()
			if err := rows.Err(); err != nil {
				return app.Internal(op, err)
			}
			key := base
			for n := 2; taken[key]; n++ {
				key = base + "_" + strconv.Itoa(n)
			}
			err = uow.QueryRow(ctx, `
				INSERT INTO finance_categories (kind, key, label, sort_order, created_by)
				VALUES ($1, $2, $3,
					(SELECT COALESCE(MAX(sort_order), 0) + 10 FROM finance_categories WHERE kind = $1), $4)
				RETURNING id, kind, key, label, sort_order, archived_at, is_system`,
				req.Kind, key, label, actorID(r)).
				Scan(&created.ID, &created.Kind, &created.Key, &created.Label, &created.SortOrder,
					&created.ArchivedAt, &created.IsSystem)
			if err != nil {
				return financeCategoryWriteError(op, err)
			}
			created.Deletable = true
			return nil
		})
	if err != nil {
		writeAppError(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, created)
}

// lockFinanceCategory loads one category for a change.
func lockFinanceCategory(ctx context.Context, q app.Querier, op string, id uuid.UUID) (financeCategory, error) {
	var row financeCategory
	err := q.QueryRow(ctx, `
		SELECT id, kind, key, label, sort_order, archived_at, is_system
		FROM finance_categories WHERE id = $1 FOR UPDATE`, id).
		Scan(&row.ID, &row.Kind, &row.Key, &row.Label, &row.SortOrder, &row.ArchivedAt, &row.IsSystem)
	if errors.Is(err, pgx.ErrNoRows) {
		return row, app.NotFound(op, "category not found")
	}
	if err != nil {
		return row, app.Internal(op, err)
	}
	row.Archived = row.ArchivedAt != nil
	return row, nil
}

// PATCH /finance-categories/{id} {label?, sortOrder?, archived?} — rename,
// move, archive or unarchive. The key never changes.
func (s *Server) handleFinanceCategoryUpdate(w http.ResponseWriter, r *http.Request) {
	id, err := uuidParam(r, "id")
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid id")
		return
	}
	var req struct {
		Label     *string `json:"label"`
		SortOrder *int    `json:"sortOrder"`
		Archived  *bool   `json:"archived"`
	}
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	const op = "update category"
	err = app.NewRunner(s.pool).Run(r.Context(), s.gnucashActor(r),
		func(ctx context.Context, uow *app.UnitOfWork) error {
			row, err := lockFinanceCategory(ctx, uow, op, id)
			if err != nil {
				return err
			}
			sets := []string{}
			args := []any{id}
			if req.Label != nil {
				label, err := cleanFinanceLabel(op, *req.Label)
				if err != nil {
					return err
				}
				args = append(args, label)
				sets = append(sets, fmt.Sprintf("label = $%d", len(args)))
			}
			if req.SortOrder != nil {
				args = append(args, *req.SortOrder)
				sets = append(sets, fmt.Sprintf("sort_order = $%d", len(args)))
			}
			if req.Archived != nil && *req.Archived != row.Archived {
				if *req.Archived && row.IsSystem {
					return app.Invalid(op, "%q is built in — Atlas relies on it — so it can be renamed but not archived", row.Label)
				}
				if *req.Archived {
					sets = append(sets, "archived_at = now()")
				} else {
					sets = append(sets, "archived_at = NULL")
				}
			}
			if len(sets) == 0 {
				return nil
			}
			_, err = uow.Exec(ctx, "UPDATE finance_categories SET "+strings.Join(sets, ", ")+" WHERE id = $1", args...)
			if err != nil {
				return financeCategoryWriteError(op, err)
			}
			return nil
		})
	if err != nil {
		writeAppError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"success": true})
}

// PUT /finance-categories/order {kind, ids} — the categories of one kind in
// their new display order (ids not listed keep their place after them).
func (s *Server) handleFinanceCategoryOrder(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Kind string      `json:"kind"`
		IDs  []uuid.UUID `json:"ids"`
	}
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	const op = "reorder categories"
	err := app.NewRunner(s.pool).Run(r.Context(), s.gnucashActor(r),
		func(ctx context.Context, uow *app.UnitOfWork) error {
			if !validFinanceKind(req.Kind) {
				return app.Invalid(op, "kind must be expense or income").WithField("kind")
			}
			if len(req.IDs) == 0 {
				return app.Invalid(op, "list at least one category").WithField("ids")
			}
			seen := map[uuid.UUID]bool{}
			for _, id := range req.IDs {
				if seen[id] {
					return app.Invalid(op, "a category is listed twice").WithField("ids")
				}
				seen[id] = true
			}
			// Listed ids first, in request order; the rest after, in their
			// current order.
			_, err := uow.Exec(ctx, `
				WITH listed AS (
					SELECT id, ord FROM unnest($2::uuid[]) WITH ORDINALITY AS t(id, ord)
				), ranked AS (
					SELECT fc.id,
						row_number() OVER (ORDER BY l.ord NULLS LAST, fc.sort_order, lower(fc.label), fc.key) AS position
					FROM finance_categories fc
					LEFT JOIN listed l ON l.id = fc.id
					WHERE fc.kind = $1
				)
				UPDATE finance_categories fc SET sort_order = ranked.position * 10
				FROM ranked WHERE ranked.id = fc.id AND fc.sort_order <> ranked.position * 10`,
				req.Kind, req.IDs)
			if err != nil {
				return app.Internal(op, err)
			}
			var matched int
			if err := uow.QueryRow(ctx, `SELECT count(*) FROM finance_categories WHERE kind = $1 AND id = ANY($2)`,
				req.Kind, req.IDs).Scan(&matched); err != nil {
				return app.Internal(op, err)
			}
			if matched != len(req.IDs) {
				return app.Invalid(op, "every id must be a %s category", financeKindNoun(req.Kind)).WithField("ids")
			}
			return nil
		})
	if err != nil {
		writeAppError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"success": true})
}

// DELETE /finance-categories/{id} — only a category nothing uses. One in use
// (by any expense or income row, soft-deleted ones included) is refused with
// 409 and should be archived instead. A deleted expense category's Folio
// account mapping goes with it.
func (s *Server) handleFinanceCategoryDelete(w http.ResponseWriter, r *http.Request) {
	id, err := uuidParam(r, "id")
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid id")
		return
	}
	const op = "delete category"
	err = app.NewRunner(s.pool).Run(r.Context(), s.gnucashActor(r),
		func(ctx context.Context, uow *app.UnitOfWork) error {
			row, err := lockFinanceCategory(ctx, uow, op, id)
			if err != nil {
				return err
			}
			if row.IsSystem {
				return app.Invalid(op, "%q is built in — Atlas relies on it — so it cannot be deleted", row.Label)
			}
			var used int
			table := "expenses"
			if row.Kind == financeKindIncome {
				table = "other_income"
			}
			if err := uow.QueryRow(ctx, "SELECT count(*) FROM "+table+" WHERE category = $1", row.Key).
				Scan(&used); err != nil {
				return app.Internal(op, err)
			}
			if used > 0 {
				noun := "entries use"
				if used == 1 {
					noun = "entry uses"
				}
				return app.Conflict(op, "%d %s %q; archive it instead so it stops being offered", used, noun, row.Label)
			}
			if _, err := uow.Exec(ctx, `DELETE FROM finance_categories WHERE id = $1`, id); err != nil {
				return financeCategoryWriteError(op, err)
			}
			if row.Kind == financeKindExpense {
				if _, err := uow.Exec(ctx, `
					UPDATE gnucash_sync_settings
					SET account_mapping = account_mapping #- ARRAY['expenses', $1::text]
					WHERE account_mapping -> 'expenses' ? $1::text`, row.Key); err != nil {
					return app.Internal(op, err)
				}
			}
			return nil
		})
	if err != nil {
		writeAppError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"success": true, "deleted": true})
}
