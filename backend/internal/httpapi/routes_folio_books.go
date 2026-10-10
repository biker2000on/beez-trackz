package httpapi

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/biker2000on/beez-trackz/backend/internal/app"
	"github.com/biker2000on/beez-trackz/backend/internal/gnucashsync"
)

// Folio book connections (00064/00011).
//
// A book connection is one Folio book Atlas has been connected to over time.
// The singleton gnucash_sync_settings is still the live configuration of the
// ACTIVE connection — its credentials, cursors, mapping and the restore
// window — and points at the active gnucash_books row through
// active_book_id. Everything Atlas links to a Folio transaction records the
// book it belongs to: external_sync.book_id for what Atlas pushed,
// folio_imports.book_id for what it imported.
//
// Switching books (POST /settings/gnucash/books/switch) retires the active
// row and starts a new one with fresh credentials, an empty mapping (account
// GUIDs belong to one book), empty cursors, sync disabled and an import start
// date of the switch day unless one is given. Nothing linked to the old book
// moves:
//
//   - a sale or expense already pushed to the old book keeps its
//     external_sync row and its book_id. It is never pushed again — not to
//     the old book (Atlas no longer writes there) and not to the new one
//     (that would put the same money in two books). Editing it in Atlas after
//     the switch changes Atlas only; the reconciliation report lists such
//     entries as belonging to the retired book.
//   - an entry that was never pushed (external_sync.book_id NULL) goes to the
//     new book on its first push, and is pinned to it then.
//   - entries imported from the old book keep their folio_imports row. They
//     stay visible and categorizable; the old book is never pulled again, so
//     they can no longer change or conflict.
//
// A credential change that lands on a different book WITHOUT the switch flow
// (typing another book's token into the ordinary settings) is refused at the
// connection test once the active book has history, because silently
// re-pointing would push old entries into the new book.

// gnucashBook is one gnucash_books row.
type gnucashBook struct {
	ID           uuid.UUID  `json:"id"`
	Label        string     `json:"label"`
	BaseURL      string     `json:"baseUrl"`
	BookGUID     string     `json:"bookGuid"`
	BookName     string     `json:"bookName"`
	RootCurrency string     `json:"rootCurrency"`
	ConnectedAt  time.Time  `json:"connectedAt"`
	RetiredAt    *time.Time `json:"retiredAt"`
}

func scanGnuCashBook(row pgx.Row) (gnucashBook, error) {
	var (
		book                     gnucashBook
		bookGUID, name, currency *string
	)
	err := row.Scan(&book.ID, &book.Label, &book.BaseURL, &bookGUID, &name, &currency,
		&book.ConnectedAt, &book.RetiredAt)
	book.BookGUID = derefString(bookGUID)
	book.BookName = derefString(name)
	book.RootCurrency = derefString(currency)
	return book, err
}

const gnucashBookColumns = `id, label, base_url, book_guid, book_name, root_currency, connected_at, retired_at`

func loadGnuCashBook(ctx context.Context, q app.Querier, id uuid.UUID) (gnucashBook, bool, error) {
	book, err := scanGnuCashBook(q.QueryRow(ctx,
		`SELECT `+gnucashBookColumns+` FROM gnucash_books WHERE id = $1`, id))
	if errors.Is(err, pgx.ErrNoRows) {
		return gnucashBook{}, false, nil
	}
	return book, err == nil, err
}

// gnucashBookHistory counts what is linked to a book: entities pushed to it
// and transactions imported from it.
func gnucashBookHistory(ctx context.Context, q app.Querier, id uuid.UUID) (pushed, imported int, err error) {
	err = q.QueryRow(ctx, `
		SELECT
			(SELECT count(*) FROM external_sync
			 WHERE system = $2 AND book_id = $1
			   AND (external_id IS NOT NULL OR remote_transaction_guid IS NOT NULL)),
			(SELECT count(*) FROM folio_imports WHERE book_id = $1)`,
		id, SyncSystemGnuCashWeb).Scan(&pushed, &imported)
	return pushed, imported, err
}

// ensureActiveBook makes sure the tested identity on settings has an active
// gnucash_books row and that settings.ActiveBookID points at it, creating or
// adopting one when it does not. It writes active_book_id itself; callers
// that later save the whole singleton carry the updated struct.
//
// It refuses — rather than silently re-pointing — when the active book was
// proven to be a different Folio book than the one these credentials open.
func ensureActiveBook(ctx context.Context, q app.Querier, settings *gnucashSettings) (gnucashBook, error) {
	const op = "folio book"
	if settings.BookGUID == "" {
		return gnucashBook{}, app.Precondition(op,
			"Test the connection before syncing so Atlas knows which book these credentials open")
	}
	var (
		book  gnucashBook
		found bool
		err   error
	)
	if settings.ActiveBookID != nil {
		book, found, err = loadGnuCashBook(ctx, q, *settings.ActiveBookID)
		if err != nil {
			return gnucashBook{}, app.Internal(op, err)
		}
		if found && book.RetiredAt != nil {
			return gnucashBook{}, app.Conflict(op,
				"The connected Folio book %q is retired. Switch to a new book to keep syncing.", book.Label)
		}
	}
	if !found {
		// No pointer (a fixture, a pre-00062 restore): adopt the unretired row
		// if it is this book or has not been proven yet.
		book, err = scanGnuCashBook(q.QueryRow(ctx,
			`SELECT `+gnucashBookColumns+` FROM gnucash_books WHERE retired_at IS NULL`))
		switch {
		case errors.Is(err, pgx.ErrNoRows):
			label := strings.TrimSpace(settings.BookName)
			if label == "" {
				label = "Folio book"
			}
			book, err = scanGnuCashBook(q.QueryRow(ctx, `
				INSERT INTO gnucash_books (label, base_url, book_guid, book_name, root_currency)
				VALUES ($1, $2, $3, $4, $5)
				RETURNING `+gnucashBookColumns,
				label, settings.BaseURL, settings.BookGUID, nullIfBlank(settings.BookName),
				nullIfBlank(settings.RootCurrency)))
			if err != nil {
				return gnucashBook{}, app.Internal(op, err)
			}
		case err != nil:
			return gnucashBook{}, app.Internal(op, err)
		}
	}
	if book.BookGUID != "" && book.BookGUID != settings.BookGUID {
		return gnucashBook{}, app.Conflict(op,
			"These credentials open Folio book %q, but the active connection %q is book %q. "+
				"Use \"Switch to a new book\" to connect a different book without disturbing history.",
			settings.BookGUID, book.Label, book.BookGUID)
	}
	if book.BookGUID != settings.BookGUID || book.BookName != settings.BookName ||
		book.RootCurrency != settings.RootCurrency || book.BaseURL != settings.BaseURL {
		book, err = scanGnuCashBook(q.QueryRow(ctx, `
			UPDATE gnucash_books SET book_guid = $2, book_name = $3, root_currency = $4, base_url = $5
			WHERE id = $1
			RETURNING `+gnucashBookColumns,
			book.ID, settings.BookGUID, nullIfBlank(settings.BookName),
			nullIfBlank(settings.RootCurrency), settings.BaseURL))
		if err != nil {
			return gnucashBook{}, app.Internal(op, err)
		}
	}
	if settings.ActiveBookID == nil || *settings.ActiveBookID != book.ID {
		id := book.ID
		settings.ActiveBookID = &id
		if _, err := q.Exec(ctx,
			`UPDATE gnucash_sync_settings SET active_book_id = $1 WHERE id = true`, id); err != nil {
			return gnucashBook{}, app.Internal(op, err)
		}
	}
	return book, nil
}

// pinUnassignedPushedRows attaches every external_sync row that already
// points at a Folio transaction but records no book to bookID. Rows that were
// never pushed stay unassigned and follow the active book.
func pinUnassignedPushedRows(ctx context.Context, q app.Querier, bookID uuid.UUID) error {
	_, err := q.Exec(ctx, `
		UPDATE external_sync SET book_id = $2
		WHERE system = $1 AND book_id IS NULL
		  AND (external_id IS NOT NULL OR remote_transaction_guid IS NOT NULL)`,
		SyncSystemGnuCashWeb, bookID)
	return err
}

// checkTestedIdentity is the connection test's guard against an implicit
// book switch. status is what the credentials actually open.
func checkTestedIdentity(ctx context.Context, q app.Querier, settings gnucashSettings, status gnucashsync.Status) error {
	const op = "folio connection test"
	var retiredLabel string
	err := q.QueryRow(ctx, `
		SELECT label FROM gnucash_books
		WHERE book_guid = $1 AND retired_at IS NOT NULL
		  AND ($2::uuid IS NULL OR id <> $2)
		ORDER BY retired_at DESC LIMIT 1`, status.BookGUID, settings.ActiveBookID).Scan(&retiredLabel)
	if err == nil {
		return app.Conflict(op,
			"These credentials open %q, which was retired as book connection %q. "+
				"Atlas no longer syncs with a retired book; connect the new book's token instead.",
			status.BookName, retiredLabel)
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return app.Internal(op, err)
	}
	if settings.ActiveBookID == nil {
		return nil
	}
	book, found, err := loadGnuCashBook(ctx, q, *settings.ActiveBookID)
	if err != nil {
		return app.Internal(op, err)
	}
	if !found || book.BookGUID == "" || book.BookGUID == status.BookGUID {
		return nil
	}
	pushed, imported, err := gnucashBookHistory(ctx, q, book.ID)
	if err != nil {
		return app.Internal(op, err)
	}
	if pushed+imported == 0 {
		// Nothing is linked to the old identity, so re-pointing the active
		// connection loses nothing.
		_, err := q.Exec(ctx, `UPDATE gnucash_books SET book_guid = NULL WHERE id = $1`, book.ID)
		return app.Internal(op, err)
	}
	return app.Conflict(op,
		"These credentials open Folio book %q (%s), but the active connection %q is a different book "+
			"with %d pushed and %d imported entries linked to it. Use \"Switch to a new book\" so that "+
			"history stays with the old book.",
		status.BookName, status.BookGUID, book.Label, pushed, imported)
}

// --- handlers ---------------------------------------------------------------

// gnucashBookSummary is one book in GET /settings/gnucash/books.
type gnucashBookSummary struct {
	gnucashBook
	Active   bool `json:"active"`
	Pushed   int  `json:"pushed"`
	Imported int  `json:"imported"`
}

// GET /settings/gnucash/books — every book connection, active first, with
// what is linked to each.
func (s *Server) handleGnuCashBooks(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	settings, err := loadGnuCashSettings(ctx, s.pool)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	rows, err := s.pool.Query(ctx, `
		SELECT `+gnucashBookColumns+` FROM gnucash_books
		ORDER BY retired_at IS NULL DESC, connected_at DESC`)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	books := []gnucashBookSummary{}
	for rows.Next() {
		book, err := scanGnuCashBook(rows)
		if err != nil {
			rows.Close()
			writeError(w, http.StatusInternalServerError, "database error")
			return
		}
		books = append(books, gnucashBookSummary{
			gnucashBook: book,
			Active:      book.RetiredAt == nil && settings.ActiveBookID != nil && *settings.ActiveBookID == book.ID,
		})
	}
	rows.Close()
	if rows.Err() != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	for i := range books {
		books[i].Pushed, books[i].Imported, err = gnucashBookHistory(ctx, s.pool, books[i].ID)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "database error")
			return
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{"books": books})
}

// PUT /settings/gnucash/books/{id} — rename a book connection. The label is
// Atlas's own name for it ("Household book", "Bee business book").
func (s *Server) handleGnuCashBookPut(w http.ResponseWriter, r *http.Request) {
	id, err := uuidParam(r, "id")
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid id")
		return
	}
	var req struct {
		Label string `json:"label"`
	}
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	label := strings.TrimSpace(req.Label)
	if label == "" || len(label) > 120 {
		writeError(w, http.StatusBadRequest, "label is required (at most 120 characters)")
		return
	}
	tag, err := s.pool.Exec(r.Context(), `UPDATE gnucash_books SET label = $2 WHERE id = $1`, id, label)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	if tag.RowsAffected() == 0 {
		writeError(w, http.StatusNotFound, "book connection not found")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"success": true})
}

// POST /settings/gnucash/books/switch — retire the active book connection and
// start a new one. See the file comment for what happens to history.
func (s *Server) handleGnuCashBookSwitch(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Label           string `json:"label"`
		BaseURL         string `json:"baseUrl"`
		APIToken        string `json:"apiToken"`
		ImportStartDate string `json:"importStartDate"`
	}
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	var result struct {
		Success        bool         `json:"success"`
		RetiredBook    *gnucashBook `json:"retiredBook"`
		ActiveBook     gnucashBook  `json:"activeBook"`
		NextSteps      []string     `json:"nextSteps"`
		ImportFromDate string       `json:"importStartDate"`
	}
	err := app.NewRunner(s.pool).Run(r.Context(), s.gnucashActor(r),
		func(ctx context.Context, uow *app.UnitOfWork) error {
			const op = "folio book switch"
			label := strings.TrimSpace(req.Label)
			if label == "" || len(label) > 120 {
				return app.Invalid(op, "Name the new book connection (at most 120 characters)").WithField("label")
			}
			baseURL := strings.TrimSpace(req.BaseURL)
			if !gnucashsync.ValidBaseURL(baseURL) {
				return app.Invalid(op,
					"Base URL must be an absolute http(s) URL with no userinfo, query, or fragment").
					WithField("baseUrl")
			}
			token := strings.TrimSpace(req.APIToken)
			if token == "" {
				return app.Invalid(op, "The new book's Folio API token is required").WithField("apiToken")
			}
			start := time.Now()
			if strings.TrimSpace(req.ImportStartDate) != "" {
				parsed, err := parseDate(req.ImportStartDate)
				if err != nil {
					return app.Invalid(op, "importStartDate must be YYYY-MM-DD").WithField("importStartDate")
				}
				start = parsed
			}
			start = time.Date(start.Year(), start.Month(), start.Day(), 0, 0, 0, 0, time.UTC)

			settings, err := loadGnuCashSettingsForUpdate(ctx, uow)
			if err != nil {
				return app.Internal(op, err)
			}
			if settings.restorePending() {
				return app.Conflict(op,
					"A restored Folio sync state is awaiting reconciliation. Finish or discard the "+
						"restore before switching books.")
			}

			// Give the current book a row first if it never got one, so its
			// history has something to stay attached to.
			if settings.ActiveBookID == nil && settings.BookGUID != "" {
				if _, err := ensureActiveBook(ctx, uow, &settings); err != nil {
					return err
				}
			}
			if settings.ActiveBookID != nil {
				if err := pinUnassignedPushedRows(ctx, uow, *settings.ActiveBookID); err != nil {
					return app.Internal(op, err)
				}
				retired, err := scanGnuCashBook(uow.QueryRow(ctx, `
					UPDATE gnucash_books SET retired_at = now()
					WHERE id = $1 AND retired_at IS NULL
					RETURNING `+gnucashBookColumns, *settings.ActiveBookID))
				if err == nil {
					result.RetiredBook = &retired
				} else if !errors.Is(err, pgx.ErrNoRows) {
					return app.Internal(op, err)
				}
			}
			// A stray unretired row (no pointer to it) would block the new one.
			if _, err := uow.Exec(ctx,
				`UPDATE gnucash_books SET retired_at = now() WHERE retired_at IS NULL`); err != nil {
				return app.Internal(op, err)
			}
			active, err := scanGnuCashBook(uow.QueryRow(ctx, `
				INSERT INTO gnucash_books (label, base_url) VALUES ($1, $2)
				RETURNING `+gnucashBookColumns, label, baseURL))
			if err != nil {
				return app.Internal(op, err)
			}
			result.ActiveBook = active

			activeID := active.ID
			settings.ActiveBookID = &activeID
			settings.BaseURL = baseURL
			settings.Token = token
			settings.BookGUID, settings.BookName, settings.RootCurrency = "", "", ""
			settings.ChangesCursor = ""
			settings.ImportCursor = ""
			settings.SyncEnabled = false
			// Account GUIDs belong to one book: the old mapping is meaningless
			// against the new one.
			settings.Mapping = gnucashsync.AccountMapping{}
			settings.ImportAccounts = nil
			settings.ImportStartDate = &start
			settings.LastImportAt = nil
			settings.LastSyncAttemptAt = nil
			settings.RestoreState = restoreStateNone
			if err := saveGnuCashSettings(ctx, uow, settings); err != nil {
				return app.Internal(op, err)
			}
			result.ImportFromDate = start.Format("2006-01-02")
			return nil
		})
	if err != nil {
		writeAppError(w, err)
		return
	}
	result.Success = true
	result.NextSteps = []string{
		"Test the connection so Atlas records which book the new token opens.",
		"Load the new book's accounts and map them (or use one account for every category).",
		"Choose the import accounts, check the import start date, then import.",
		"Enable sync when the mapping is complete.",
	}
	writeJSON(w, http.StatusOK, result)
}
