package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/biker2000on/beez-trackz/backend/internal/app"
	"github.com/biker2000on/beez-trackz/backend/internal/gnucashsync"
)

// The Folio history import: Folio transactions Atlas did not write become
// Atlas expenses (category 'uncategorized') and other_income entries, which
// the operator then categorizes in Atlas. It is the pull side's only writer of
// Atlas records, and it writes only those two kinds: never a sale, never an
// inventory movement, never anything physical.
//
// Source. The ACTIVE book's change feed, read with the import's own cursor
// (gnucash_sync_settings.import_cursor). A transaction is imported when it
// posts to an import account (settings, default: the accounts the category
// mapping uses), Atlas did not push it (no beez externalId, and its guid is no
// external_sync row's remote transaction), and its post date is on or after
// "Import history from". Direction and amount follow
// gnucashsync.ClassifyImport.
//
// Idempotency. folio_imports is unique on (book_id, transaction_guid), and
// each row keeps the remote values last applied plus the feed's enterDate. A
// re-emitted item with the same enterDate is a no-op, which is what the feed
// asks of a client (transactionGuid + enterDate is its dedup key).
//
// Edits in Folio. A newer enterDate on an imported transaction is applied to
// the Atlas entry when the entry is still uncategorized, or when only the
// date or description changed (same direction, same amount). Anything else —
// a categorized entry whose amount changed, or one that flipped between
// money out and money in — is flagged 'remote_changed' with the Folio values
// held in folio_imports.pending, for the operator to accept or dismiss.
//
// Deletions in Folio. An imported entry whose Folio transaction was deleted
// is FLAGGED 'remote_deleted' — never deleted silently, whether it was
// categorized or not (an uncategorized, unlinked entry could safely be
// removed outright, but one rule for every entry is easier to trust than two):
// the operator accepts the deletion (the entry is soft-deleted) or keeps it.
// Two ways to learn of a deletion:
//
//   - the deletion stream. A Folio whose status lists the
//     "transaction-deletions" capability is read with include=deletions and
//     reports every deleted transaction as a guid-keyed tombstone, GnuCash
//     desktop deletions included. Tombstones are at-least-once: the same
//     deletion can arrive again, so folio_imports.remote_deleted_at records
//     the deletedAt already handled and a repeat is ignored — in particular
//     after the operator chose "keep".
//   - a FULL scan, the fallback for an older Folio (no capability) and for
//     what the stream cannot see (deletions made before Folio was upgraded or
//     while its trigger was missing). The first import (empty cursor), or one
//     run with full=true, reads the whole book, and every live imported entry
//     whose transaction was not seen, and that was not already reported, is
//     flagged.
//
// A transaction that no longer posts to its import account is flagged the
// same way. Seeing the transaction alive again clears remote_deleted_at.
//
// Changing the start date. Moving it earlier, or adding an import account,
// clears the import cursor so the next run rescans the book; already-imported
// transactions are recognised by guid and not duplicated. Moving it later
// imports nothing new and removes nothing already imported.
//
// Categorizing never writes to Folio. Atlas pushes every category into
// whatever account the mapping names; for a single "Beekeeping" account that
// is the account the transaction already sits in, and for a finer mapping the
// imported transaction simply stays where the bookkeeper put it. Imported
// entries are excluded from the push scan, so they are never echoed back.

const (
	folioImportPageSize    = 500
	folioImportMaxPages    = 40
	folioImportMaxFullPage = 400
)

// folioImportReport is the outcome of one import run.
type folioImportReport struct {
	Full         bool `json:"full"`
	ScanComplete bool `json:"scanComplete"`
	// DeletionFeed is true when Folio reported deletions in the change feed
	// (the transaction-deletions capability). False means deletions of Folio
	// transactions are only found by a full rescan.
	DeletionFeed           bool       `json:"deletionFeed"`
	Pulled                 int        `json:"pulled"`
	ImportedExpenses       int        `json:"importedExpenses"`
	ImportedIncome         int        `json:"importedIncome"`
	Updated                int        `json:"updated"`
	Unchanged              int        `json:"unchanged"`
	Conflicts              int        `json:"conflicts"`
	Deleted                int        `json:"deleted"`
	SkippedPushedByAtlas   int        `json:"skippedPushedByAtlas"`
	SkippedBeforeStart     int        `json:"skippedBeforeStart"`
	SkippedTransfers       int        `json:"skippedTransfers"`
	SkippedUnrepresentable int        `json:"skippedUnrepresentable"`
	OutOfScope             int        `json:"outOfScope"`
	Errors                 []string   `json:"errors"`
	LastImportAt           *time.Time `json:"lastImportAt,omitempty"`
}

// folioImportContext is what one run needs for every item.
type folioImportContext struct {
	bookID       uuid.UUID
	start        time.Time
	importSet    map[string]bool
	accountTypes map[string]string
	pushedGUIDs  map[string]bool
	actor        *uuid.UUID
	seen         map[string]bool // non-nil only on a full scan
	deletionFeed bool            // read the feed with include=deletions
}

// effectiveImportAccounts is the configured list, or the mapping's category
// accounts when none is configured.
func (settings gnucashSettings) effectiveImportAccounts() []string {
	if len(settings.ImportAccounts) > 0 {
		return settings.ImportAccounts
	}
	return settings.Mapping.ImportAccountGUIDs()
}

// POST /settings/gnucash/import — run the history import. Body {"full": true}
// rescans the whole book (and detects transactions deleted in Folio).
//
// It reads Folio and never writes to it, so it does not need sync enabled.
// It does need a tested identity that the live connection still matches, and
// it refuses during a restore window like every other sync action.
func (s *Server) handleGnuCashImport(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Full bool `json:"full"`
	}
	if r.ContentLength != 0 {
		if err := decodeJSON(r, &req); err != nil {
			writeError(w, http.StatusBadRequest, "invalid request body")
			return
		}
	}
	ctx := r.Context()
	settings, err := loadGnuCashSettings(ctx, s.pool)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	const op = "folio import"
	client, err := settings.client()
	if err != nil {
		writeAppError(w, err)
		return
	}
	if settings.restorePending() {
		writeAppError(w, app.Conflict(op,
			"A restored Folio sync state is still awaiting reconciliation. Acknowledge it before importing."))
		return
	}
	if settings.ImportStartDate == nil {
		writeAppError(w, app.Precondition(op, "Set \"Import history from\" before importing"))
		return
	}
	accounts := settings.effectiveImportAccounts()
	if len(accounts) == 0 {
		writeAppError(w, app.Precondition(op,
			"Choose the Folio accounts to import from (or map the categories first)"))
		return
	}
	book, err := ensureActiveBook(ctx, s.pool, &settings)
	if err != nil {
		writeAppError(w, err)
		return
	}
	// The token may have been rotated in Folio since the last test; never
	// import another book's history under this book's name.
	status, err := client.Status(ctx)
	if err != nil {
		writeError(w, http.StatusBadGateway, gnucashUserMessage(err))
		return
	}
	if status.BookGUID != book.BookGUID {
		writeAppError(w, app.Conflict(op,
			"The token now opens Folio book %q, not the connected book %q. Test the connection.",
			status.BookGUID, book.BookGUID))
		return
	}
	folioAccounts, err := client.Accounts(ctx)
	if err != nil {
		writeError(w, http.StatusBadGateway, gnucashUserMessage(err))
		return
	}

	run := folioImportContext{
		bookID:       book.ID,
		start:        *settings.ImportStartDate,
		importSet:    map[string]bool{},
		accountTypes: map[string]string{},
		actor:        actorID(r),
		// An older Folio has no capability and gets the plain feed: the full
		// rescan is then the only way deletions are found.
		deletionFeed: status.Has(gnucashsync.CapabilityTransactionDeletions),
	}
	for _, guid := range accounts {
		run.importSet[guid] = true
	}
	for _, account := range folioAccounts {
		run.accountTypes[account.GUID] = account.Type
	}
	if run.pushedGUIDs, err = s.folioPushedGUIDs(ctx); err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}

	report := &folioImportReport{Errors: []string{}, DeletionFeed: run.deletionFeed}
	cursor := settings.ImportCursor
	report.Full = req.Full || cursor == ""
	maxPages := folioImportMaxPages
	if report.Full {
		cursor = ""
		run.seen = map[string]bool{}
		maxPages = folioImportMaxFullPage
	}

	cursor, complete, pullErr := s.folioImportPull(ctx, client, cursor, maxPages, &run, report)
	switch {
	case pullErr != nil:
		report.Errors = append(report.Errors, "Import stopped: "+pullErr.Error())
	case !complete:
		report.Errors = append(report.Errors,
			"Import incomplete - run it again to continue reading the book.")
	}
	report.ScanComplete = pullErr == nil && complete
	if report.Full && report.ScanComplete {
		if err := s.folioFlagMissing(ctx, &run, report); err != nil {
			report.Errors = append(report.Errors, "Deletion check failed: "+err.Error())
		}
	} else if report.Full {
		report.Errors = append(report.Errors,
			"Transactions deleted in Folio are only detected by a complete full scan; this one did not finish.")
	}

	now := time.Now()
	report.LastImportAt = &now
	if _, err := s.pool.Exec(ctx, `
		UPDATE gnucash_sync_settings SET import_cursor = $1, last_import_at = $2 WHERE id = true`,
		nullIfBlank(cursor), now); err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	writeJSON(w, http.StatusOK, report)
}

// folioPushedGUIDs is every Folio transaction guid Atlas itself wrote, in any
// book. The feed's externalId already marks them; this is the second fence.
func (s *Server) folioPushedGUIDs(ctx context.Context) (map[string]bool, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT remote_transaction_guid FROM external_sync
		WHERE system = $1 AND remote_transaction_guid IS NOT NULL`, SyncSystemGnuCashWeb)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]bool{}
	for rows.Next() {
		var guid string
		if err := rows.Scan(&guid); err != nil {
			return nil, err
		}
		out[guid] = true
	}
	return out, rows.Err()
}

// folioImportPull drains the feed from cursor, applying each item. The cursor
// it returns is the furthest point fully applied; it is also saved after each
// page so a failure resumes rather than repeats.
func (s *Server) folioImportPull(
	ctx context.Context, client *gnucashsync.Client, cursor string, maxPages int,
	run *folioImportContext, report *folioImportReport,
) (string, bool, error) {
	for page := 0; page < maxPages; page++ {
		if err := ctx.Err(); err != nil {
			return cursor, false, err
		}
		result, err := client.ChangesWith(ctx, cursor, folioImportPageSize, run.deletionFeed)
		if err != nil {
			return cursor, false, fmt.Errorf("read changes: %s", gnucashUserMessage(err))
		}
		if result.HasMore && (result.NextCursor == "" || result.NextCursor == cursor) {
			return cursor, false, errors.New("Folio reported more changes but the cursor does not advance")
		}
		for _, item := range result.Items {
			report.Pulled++
			if err := s.folioApplyItem(ctx, run, item, report); err != nil {
				return cursor, false, err
			}
		}
		if result.NextCursor != "" && result.NextCursor != cursor {
			cursor = result.NextCursor
			if _, err := s.pool.Exec(ctx,
				`UPDATE gnucash_sync_settings SET import_cursor = $1 WHERE id = true`, cursor); err != nil {
				return cursor, false, err
			}
		}
		if !result.HasMore {
			return cursor, true, nil
		}
	}
	return cursor, false, nil
}

// folioImportRow is one folio_imports row with the state of its entry.
type folioImportRow struct {
	ID                uuid.UUID
	Direction         gnucashsync.ImportDirection
	ExpenseID         *uuid.UUID
	IncomeID          *uuid.UUID
	AccountGUIDs      []string
	RemotePostDate    *time.Time
	RemoteEnterDate   *time.Time
	RemoteDescription string
	RemoteAmountCents int64
	RemoteDeletedAt   *time.Time
	State             string
	Pending           []byte
	Category          string
	EntityDeleted     bool
}

func (row folioImportRow) entityID() uuid.UUID {
	if row.ExpenseID != nil {
		return *row.ExpenseID
	}
	if row.IncomeID != nil {
		return *row.IncomeID
	}
	return uuid.Nil
}

const folioImportSelect = `
	SELECT fi.id, fi.direction, fi.expense_id, fi.income_id, fi.account_guids,
		fi.remote_post_date, fi.remote_enter_date, fi.remote_description,
		fi.remote_amount_cents, fi.remote_deleted_at, fi.state, fi.pending,
		COALESCE(e.category, oi.category, ''),
		COALESCE(e.deleted_at, oi.deleted_at) IS NOT NULL
	FROM folio_imports fi
	LEFT JOIN expenses e ON e.id = fi.expense_id
	LEFT JOIN other_income oi ON oi.id = fi.income_id`

func scanFolioImportRow(row pgx.Row) (folioImportRow, error) {
	var (
		out          folioImportRow
		direction    string
		accountsJSON []byte
		state        *string
	)
	err := row.Scan(&out.ID, &direction, &out.ExpenseID, &out.IncomeID, &accountsJSON,
		&out.RemotePostDate, &out.RemoteEnterDate, &out.RemoteDescription,
		&out.RemoteAmountCents, &out.RemoteDeletedAt, &state, &out.Pending, &out.Category,
		&out.EntityDeleted)
	if err != nil {
		return out, err
	}
	out.Direction = gnucashsync.ImportDirection(direction)
	out.State = derefString(state)
	if len(accountsJSON) > 0 {
		_ = json.Unmarshal(accountsJSON, &out.AccountGUIDs)
	}
	return out, nil
}

func loadFolioImport(ctx context.Context, q app.Querier, bookID uuid.UUID, guid string) (folioImportRow, bool, error) {
	row, err := scanFolioImportRow(q.QueryRow(ctx,
		folioImportSelect+` WHERE fi.book_id = $1 AND fi.transaction_guid = $2`, bookID, guid))
	if errors.Is(err, pgx.ErrNoRows) {
		return folioImportRow{}, false, nil
	}
	return row, err == nil, err
}

// folioPending is the remote version held for a 'remote_changed' conflict.
type folioPending struct {
	Direction    gnucashsync.ImportDirection `json:"direction"`
	AmountCents  int64                       `json:"amountCents"`
	PostDate     string                      `json:"postDate"`
	Description  string                      `json:"description"`
	Memo         string                      `json:"memo"`
	AccountGUIDs []string                    `json:"accountGuids"`
}

func pendingFrom(candidate gnucashsync.ImportCandidate, postDate time.Time) folioPending {
	return folioPending{
		Direction:    candidate.Direction,
		AmountCents:  candidate.AmountCents,
		PostDate:     postDate.Format("2006-01-02"),
		Description:  candidate.Description,
		Memo:         candidate.Memo,
		AccountGUIDs: candidate.AccountGUIDs,
	}
}

// folioApplyItem applies one feed item. Each item commits on its own.
func (s *Server) folioApplyItem(
	ctx context.Context, run *folioImportContext, item gnucashsync.Change, report *folioImportReport,
) error {
	if item.Deleted {
		if item.IsGUIDTombstone() {
			return s.folioApplyDeletion(ctx, run.bookID, item, report)
		}
		// An externalId tombstone names a transaction Atlas pushed; the sync
		// pull handles it.
		report.SkippedPushedByAtlas++
		return nil
	}
	guid := item.TransactionGUID
	if guid == "" {
		report.OutOfScope++
		return nil
	}
	if run.seen != nil {
		run.seen[guid] = true
	}
	if (item.ExternalID != nil && *item.ExternalID != "") || run.pushedGUIDs[guid] {
		report.SkippedPushedByAtlas++
		return nil
	}

	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	existing, found, err := loadFolioImport(ctx, tx, run.bookID, guid)
	if err != nil {
		return err
	}
	importSet := run.importSet
	if found && len(existing.AccountGUIDs) > 0 {
		// An account the operator later removed from the import set still
		// owns the transactions imported through it.
		importSet = make(map[string]bool, len(run.importSet)+len(existing.AccountGUIDs))
		for guid := range run.importSet {
			importSet[guid] = true
		}
		for _, guid := range existing.AccountGUIDs {
			importSet[guid] = true
		}
	}
	candidate, skip := gnucashsync.ClassifyImport(item, importSet, run.accountTypes)
	remoteEnter := gnucashParseTime(item.EnterDate)

	switch skip {
	case gnucashsync.ImportSkipNone:
	case gnucashsync.ImportSkipUnrepresentable:
		if !found {
			report.SkippedUnrepresentable++
			return nil
		}
		if existing.State != "unrepresentable" {
			report.Conflicts++
			if err := folioFlag(ctx, tx, existing.ID, "unrepresentable",
				"Edited in Folio into amounts Atlas cannot represent exactly (fractional cents or several currencies). Resolve it in Folio.",
				nil, remoteEnter); err != nil {
				return err
			}
		}
		return tx.Commit(ctx)
	case gnucashsync.ImportSkipNoImportAccount:
		if !found {
			report.OutOfScope++
			return nil
		}
		if existing.State != "remote_deleted" && !existing.EntityDeleted {
			report.Deleted++
			if err := folioFlag(ctx, tx, existing.ID, "remote_deleted",
				"No longer posts to an import account in Folio (moved to another account).",
				nil, remoteEnter); err != nil {
				return err
			}
		}
		return tx.Commit(ctx)
	case gnucashsync.ImportSkipTransfer:
		if !found {
			report.SkippedTransfers++
			return nil
		}
		if existing.State != "remote_deleted" && !existing.EntityDeleted {
			report.Conflicts++
			if err := folioFlag(ctx, tx, existing.ID, "remote_deleted",
				"Now nets to zero on the import accounts in Folio (a transfer), so it is no longer income or an expense.",
				nil, remoteEnter); err != nil {
				return err
			}
		}
		return tx.Commit(ctx)
	default:
		report.OutOfScope++
		return nil
	}

	postDate := candidate.PostDate
	if !candidate.HasPostDate {
		if remoteEnter != nil {
			postDate = time.Date(remoteEnter.Year(), remoteEnter.Month(), remoteEnter.Day(), 0, 0, 0, 0, time.UTC)
		} else {
			postDate = time.Now().UTC()
		}
	}

	if !found {
		if postDate.Before(run.start) {
			report.SkippedBeforeStart++
			return nil
		}
		if err := folioInsertImport(ctx, tx, run.bookID, guid, candidate, postDate, remoteEnter, run.actor); err != nil {
			return err
		}
		if candidate.Direction == gnucashsync.ImportExpense {
			report.ImportedExpenses++
		} else {
			report.ImportedIncome++
		}
		return tx.Commit(ctx)
	}

	if existing.RemoteEnterDate != nil && remoteEnter != nil && existing.RemoteEnterDate.Equal(*remoteEnter) {
		report.Unchanged++
		return nil
	}

	sameDirection := candidate.Direction == existing.Direction
	sameAmount := candidate.AmountCents == existing.RemoteAmountCents
	sameDate := existing.RemotePostDate != nil &&
		existing.RemotePostDate.Format("2006-01-02") == postDate.Format("2006-01-02")
	sameDescription := candidate.Description == existing.RemoteDescription
	pending := pendingFrom(candidate, postDate)

	switch {
	case existing.EntityDeleted:
		// The operator dismissed this entry; keep tracking Folio quietly.
		report.Unchanged++
		err = folioStoreSnapshot(ctx, tx, existing.ID, pending, remoteEnter)
	case sameDirection && sameAmount && sameDate && sameDescription:
		report.Unchanged++
		err = folioStoreSnapshot(ctx, tx, existing.ID, pending, remoteEnter)
	case sameDirection && (sameAmount || existing.Category == "uncategorized"):
		report.Updated++
		err = folioApplyPending(ctx, tx, existing, pending, remoteEnter, run.actor)
	case !sameDirection && existing.Category == "uncategorized":
		report.Updated++
		err = folioApplyPending(ctx, tx, existing, pending, remoteEnter, run.actor)
	default:
		report.Conflicts++
		message := "Amount changed in Folio after you categorized it."
		if !sameDirection {
			message = "Changed in Folio from money " + flowWord(existing.Direction) +
				" to money " + flowWord(candidate.Direction) + " after you categorized it."
		}
		err = folioFlag(ctx, tx, existing.ID, "remote_changed", message, &pending, remoteEnter)
	}
	if err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func flowWord(direction gnucashsync.ImportDirection) string {
	if direction == gnucashsync.ImportIncome {
		return "in"
	}
	return "out"
}

// folioInsertImport creates the Atlas entry and its link row.
func folioInsertImport(
	ctx context.Context, q app.Querier, bookID uuid.UUID, guid string,
	candidate gnucashsync.ImportCandidate, postDate time.Time, remoteEnter *time.Time, actor *uuid.UUID,
) error {
	expenseID, incomeID, err := folioInsertEntity(ctx, q, candidate.Direction,
		postDate, candidate.Description, candidate.Memo, candidate.AmountCents, actor)
	if err != nil {
		return err
	}
	accounts, _ := json.Marshal(candidate.AccountGUIDs)
	_, err = q.Exec(ctx, `
		INSERT INTO folio_imports
			(book_id, transaction_guid, direction, expense_id, income_id, account_guids,
			 remote_post_date, remote_enter_date, remote_description, remote_amount_cents)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
		bookID, guid, string(candidate.Direction), expenseID, incomeID, accounts,
		postDate, remoteEnter, candidate.Description, candidate.AmountCents)
	return err
}

// folioInsertEntity writes an uncategorized expense or other_income entry.
func folioInsertEntity(
	ctx context.Context, q app.Querier, direction gnucashsync.ImportDirection,
	date time.Time, description, memo string, amountCents int64, actor *uuid.UUID,
) (expenseID, incomeID *uuid.UUID, err error) {
	var notes *string
	if memo != "" && memo != description {
		notes = &memo
	}
	var id uuid.UUID
	if direction == gnucashsync.ImportExpense {
		err = q.QueryRow(ctx, `
			INSERT INTO expenses (expense_date, category, description, amount_cents, notes, created_by)
			VALUES ($1, 'uncategorized', $2, $3, $4, $5) RETURNING id`,
			date, description, amountCents, notes, actor).Scan(&id)
		return &id, nil, err
	}
	err = q.QueryRow(ctx, `
		INSERT INTO other_income (income_date, category, description, amount_cents, notes, created_by)
		VALUES ($1, 'uncategorized', $2, $3, $4, $5) RETURNING id`,
		date, description, amountCents, notes, actor).Scan(&id)
	return nil, &id, err
}

// folioStoreSnapshot records the remote version as seen and clears any flag.
func folioStoreSnapshot(
	ctx context.Context, q app.Querier, id uuid.UUID, remote folioPending, remoteEnter *time.Time,
) error {
	accounts, _ := json.Marshal(remote.AccountGUIDs)
	postDate, _ := gnucashsync.ParsePostDate(remote.PostDate)
	_, err := q.Exec(ctx, `
		UPDATE folio_imports SET
			account_guids = $2, remote_post_date = $3,
			remote_enter_date = COALESCE($4, remote_enter_date),
			remote_description = $5, remote_amount_cents = $6,
			state = NULL, message = NULL, pending = NULL, remote_deleted_at = NULL
		WHERE id = $1`,
		id, accounts, postDate, remoteEnter, remote.Description, remote.AmountCents)
	return err
}

// folioFlag records a conflict without touching the Atlas entry. The
// enterDate is stored so the same remote version re-emitted is not re-judged.
func folioFlag(
	ctx context.Context, q app.Querier, id uuid.UUID, state, message string,
	pending *folioPending, remoteEnter *time.Time,
) error {
	var pendingJSON []byte
	if pending != nil {
		pendingJSON, _ = json.Marshal(pending)
	}
	_, err := q.Exec(ctx, `
		UPDATE folio_imports SET state = $2, message = $3, pending = $4,
			remote_enter_date = COALESCE($5, remote_enter_date)
		WHERE id = $1`,
		id, state, truncateError(message), pendingJSON, remoteEnter)
	return err
}

// folioApplyPending makes the Atlas entry match a remote version: in place
// when the direction is unchanged (the category is kept), otherwise by
// soft-deleting the old entry and creating an uncategorized one of the other
// kind.
func folioApplyPending(
	ctx context.Context, q app.Querier, row folioImportRow, remote folioPending,
	remoteEnter *time.Time, actor *uuid.UUID,
) error {
	postDate, ok := gnucashsync.ParsePostDate(remote.PostDate)
	if !ok {
		return fmt.Errorf("folio import %s: pending version has no post date", row.ID)
	}
	if remote.Direction == row.Direction {
		var err error
		if row.ExpenseID != nil {
			_, err = q.Exec(ctx, `
				UPDATE expenses SET expense_date = $2, description = $3, amount_cents = $4
				WHERE id = $1`, *row.ExpenseID, postDate, remote.Description, remote.AmountCents)
		} else if row.IncomeID != nil {
			_, err = q.Exec(ctx, `
				UPDATE other_income SET income_date = $2, description = $3, amount_cents = $4
				WHERE id = $1`, *row.IncomeID, postDate, remote.Description, remote.AmountCents)
		}
		if err != nil {
			return err
		}
		return folioStoreSnapshot(ctx, q, row.ID, remote, remoteEnter)
	}

	reason := "Moved to " + string(remote.Direction) + " by an edit in Folio"
	if err := folioSoftDeleteEntity(ctx, q, row, reason, actor); err != nil {
		return err
	}
	expenseID, incomeID, err := folioInsertEntity(ctx, q, remote.Direction, postDate,
		remote.Description, remote.Memo, remote.AmountCents, actor)
	if err != nil {
		return err
	}
	if _, err := q.Exec(ctx, `
		UPDATE folio_imports SET direction = $2, expense_id = $3, income_id = $4
		WHERE id = $1`, row.ID, string(remote.Direction), expenseID, incomeID); err != nil {
		return err
	}
	return folioStoreSnapshot(ctx, q, row.ID, remote, remoteEnter)
}

func folioSoftDeleteEntity(ctx context.Context, q app.Querier, row folioImportRow, reason string, actor *uuid.UUID) error {
	var err error
	if row.ExpenseID != nil {
		_, err = q.Exec(ctx, `
			UPDATE expenses SET deleted_at = now(), deleted_by = $2, deletion_reason = $3
			WHERE id = $1 AND deleted_at IS NULL`, *row.ExpenseID, actor, reason)
	} else if row.IncomeID != nil {
		_, err = q.Exec(ctx, `
			UPDATE other_income SET deleted_at = now(), deleted_by = $2, deletion_reason = $3
			WHERE id = $1 AND deleted_at IS NULL`, *row.IncomeID, actor, reason)
	}
	return err
}

// folioFlagMissing runs after a complete full scan: every live imported entry
// of this book whose transaction the scan did not see was deleted in Folio.
func (s *Server) folioFlagMissing(ctx context.Context, run *folioImportContext, report *folioImportReport) error {
	rows, err := s.pool.Query(ctx, `
		SELECT fi.id, fi.transaction_guid
		FROM folio_imports fi
		LEFT JOIN expenses e ON e.id = fi.expense_id
		LEFT JOIN other_income oi ON oi.id = fi.income_id
		WHERE fi.book_id = $1
		  AND (fi.state IS NULL OR fi.state <> 'remote_deleted')
		  AND fi.remote_deleted_at IS NULL
		  AND COALESCE(e.deleted_at, oi.deleted_at) IS NULL`, run.bookID)
	if err != nil {
		return err
	}
	missing := []uuid.UUID{}
	for rows.Next() {
		var (
			id   uuid.UUID
			guid string
		)
		if err := rows.Scan(&id, &guid); err != nil {
			rows.Close()
			return err
		}
		if !run.seen[guid] {
			missing = append(missing, id)
		}
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return err
	}
	now := time.Now()
	for _, id := range missing {
		if err := folioFlagDeleted(ctx, s.pool, id,
			"Deleted in Folio (not found in a full scan of the book). Accept to remove it from Atlas, or keep it.",
			now); err != nil {
			return err
		}
		report.Deleted++
	}
	return nil
}

// folioShouldFlagDeletion decides what a deletion-stream tombstone does to
// an imported entry. Not when the operator already removed the entry, and
// not when this deletion (or a later one) was already reported — the stream
// is at-least-once, and a repeat after the operator kept the entry must not
// raise it again. A deletion with no usable timestamp is judged as new only
// if nothing was reported before.
func folioShouldFlagDeletion(row folioImportRow, deletedAt *time.Time) bool {
	if row.EntityDeleted {
		return false
	}
	if row.RemoteDeletedAt != nil && (deletedAt == nil || !deletedAt.After(*row.RemoteDeletedAt)) {
		return false
	}
	return true
}

// folioApplyDeletion applies a guid tombstone from the deletion stream. A
// transaction this book never imported is out of scope; an imported entry is
// flagged 'remote_deleted' — categorized or not, it is never deleted here.
func (s *Server) folioApplyDeletion(
	ctx context.Context, bookID uuid.UUID, item gnucashsync.Change, report *folioImportReport,
) error {
	existing, found, err := loadFolioImport(ctx, s.pool, bookID, item.TransactionGUID)
	if err != nil {
		return err
	}
	if !found {
		report.OutOfScope++
		return nil
	}
	deletedAt := gnucashParseTime(item.DeletedAt)
	if !folioShouldFlagDeletion(existing, deletedAt) {
		report.Unchanged++
		return nil
	}
	stamp := time.Now()
	if deletedAt != nil {
		stamp = *deletedAt
	}
	report.Deleted++
	return folioFlagDeleted(ctx, s.pool, existing.ID,
		"Deleted in Folio. Accept to remove it from Atlas, or keep it.", stamp)
}

// folioFlagDeleted flags an entry 'remote_deleted' and records which
// deletion was reported, so the same deletion is not raised twice.
func folioFlagDeleted(ctx context.Context, q app.Querier, id uuid.UUID, message string, deletedAt time.Time) error {
	_, err := q.Exec(ctx, `
		UPDATE folio_imports SET state = 'remote_deleted', message = $2, pending = NULL,
			remote_deleted_at = $3
		WHERE id = $1`, id, truncateError(message), deletedAt)
	return err
}
