package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"sort"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/biker2000on/beez-trackz/backend/internal/app"
	"github.com/biker2000on/beez-trackz/backend/internal/gnucashsync"
)

// Live GnuCash (folio) sync.
//
// Direction of authority: beez is the record of what physically happened in
// the yard and the shop. This engine pushes those facts into folio as
// double-entry transactions and pulls back only enough to notice that a human
// edited the books behind us. It NEVER writes a physical beez record from
// accounting data — the pull half can set a conflict flag and nothing else.
//
// Push identity is external_sync (00005/00041) with the push-state columns
// from 00045. One beez entity maps to exactly one folio externalId:
// "sale:<uuid>" or "expense:<uuid>". Cost of goods rides inside the sale
// transaction rather than a sibling externalId, so revenue and its cost can
// never be half-pushed.

// gnucashMaxPullPages bounds one sync run. Each page is up to 500 items, so
// this drains 10k folio changes per run and picks the rest up on the next.
const gnucashMaxPullPages = 20

// gnucashPullPageSize is the GET changes page size.
const gnucashPullPageSize = 200

func (s *Server) mountGnuCashSync(r chi.Router) {
	admin := r.With(s.requireAdmin)
	admin.Get("/settings/gnucash", s.handleGnuCashSettings)
	admin.Put("/settings/gnucash", s.handleGnuCashSettingsPut)
	admin.Post("/settings/gnucash/test", s.handleGnuCashTest)
	admin.Get("/settings/gnucash/accounts", s.handleGnuCashAccounts)
	admin.Get("/settings/gnucash/rows", s.handleGnuCashRows)
	admin.Post("/settings/gnucash/sync", s.handleGnuCashSyncNow)
	admin.Post("/settings/gnucash/restore", s.handleGnuCashRestore)
	admin.Post("/settings/gnucash/rows/{id}/push", s.handleGnuCashRowPush)
	admin.Post("/settings/gnucash/rows/{id}/ignore", s.handleGnuCashRowIgnore)
}

// --- settings ---------------------------------------------------------------

// gnucashSettings is the singleton gnucash_sync_settings row.
type gnucashSettings struct {
	BaseURL       string
	Token         string
	BookGUID      string
	BookName      string
	RootCurrency  string
	ChangesCursor string
	SyncEnabled   bool
	Mapping       gnucashsync.AccountMapping
	// LastSyncAttemptAt is the singleton gnucash_sync_settings.last_synced_at
	// column, named for what it actually holds: handleGnuCashSyncNow stamps
	// it at the end of every run, including runs whose pull failed and which
	// therefore pushed nothing. Per-record success lives in
	// external_sync.last_synced_at. The snapshot artifact and the restore
	// report both carry it under the attempt name so a restored book is not
	// reconciled against a time nothing was ever synced at.
	LastSyncAttemptAt *time.Time
	// RestoreState is gnucash_sync_settings.restore_state (00049). See the
	// constants below: it is the durable replacement for what used to be
	// guessed from "cursor present and sync off".
	RestoreState string
}

// The three values of gnucash_sync_settings.restore_state (00049).
const (
	// restoreStateNone is ordinary operation: nothing restored, or the
	// restore was finished or deliberately discarded.
	restoreStateNone = "none"
	// restoreStateInstalled is the restore window. The guarded restore proved
	// the credentials open the artifact's book and installed the preserved
	// cursor, book identity, and per-row sync state. Sync stays disabled.
	restoreStateInstalled = "installed"
	// restoreStateReconciled is the admin acknowledgement that the pull-first
	// reconciliation and the no-write push dry run passed. It is the only
	// state from which sync may be re-enabled after a restore.
	restoreStateReconciled = "reconciled"
)

// restorePending reports that a guarded restore installed a book identity and
// a preserved cursor which no reconciliation has signed off yet.
//
// Before 00049 this was derived — book identity present, cursor present, sync
// disabled — which was both a false positive for an operator who had merely
// paused a healthy integration and unclearable except by changing one of its
// three inputs. It is now the stored column, so pausing sync is not a restore
// and the sign-off has somewhere to be recorded.
func (settings gnucashSettings) restorePending() bool {
	return settings.RestoreState == restoreStateInstalled
}

// normalizedRestoreState keeps a zero-valued struct (test fixtures, the
// unconfigured singleton) writable against the 00049 CHECK.
func (settings gnucashSettings) normalizedRestoreState() string {
	switch settings.RestoreState {
	case restoreStateInstalled, restoreStateReconciled:
		return settings.RestoreState
	default:
		return restoreStateNone
	}
}

// loadGnuCashSettings reads the singleton. A missing row is the unconfigured
// zero value, not an error: the settings page must render before setup.
func loadGnuCashSettings(ctx context.Context, q app.Querier) (gnucashSettings, error) {
	return scanGnuCashSettings(ctx, q, "")
}

// loadGnuCashSettingsForUpdate takes a row lock on the singleton. Both the
// settings PUT and the guarded restore use it, which is what serialises them:
// a credential rotation racing a restore either happens first (and the
// restore's identity re-check fails) or second (and legitimately invalidates
// the book it no longer opens). Neither can interleave halfway.
func loadGnuCashSettingsForUpdate(ctx context.Context, q app.Querier) (gnucashSettings, error) {
	return scanGnuCashSettings(ctx, q, " FOR UPDATE")
}

func scanGnuCashSettings(
	ctx context.Context, q app.Querier, lock string,
) (gnucashSettings, error) {
	var (
		out                                         gnucashSettings
		token, bookGUID, bookName, currency, cursor *string
		mappingJSON                                 []byte
	)
	err := q.QueryRow(ctx, `
		SELECT base_url, api_token, book_guid, book_name, root_currency,
			changes_cursor, sync_enabled, account_mapping, last_synced_at,
			restore_state
		FROM gnucash_sync_settings WHERE id = true`+lock).
		Scan(&out.BaseURL, &token, &bookGUID, &bookName, &currency,
			&cursor, &out.SyncEnabled, &mappingJSON, &out.LastSyncAttemptAt,
			&out.RestoreState)
	if errors.Is(err, pgx.ErrNoRows) {
		// The unconfigured singleton is restore_state 'none', not "".
		return gnucashSettings{RestoreState: restoreStateNone}, nil
	}
	if err != nil {
		return gnucashSettings{}, err
	}
	out.Token = derefString(token)
	out.BookGUID = derefString(bookGUID)
	out.BookName = derefString(bookName)
	out.RootCurrency = derefString(currency)
	out.ChangesCursor = derefString(cursor)
	if len(mappingJSON) > 0 {
		if err := json.Unmarshal(mappingJSON, &out.Mapping); err != nil {
			return gnucashSettings{}, fmt.Errorf("decode account mapping: %w", err)
		}
	}
	out.Mapping = out.Mapping.Normalize()
	return out, nil
}

func derefString(v *string) string {
	if v == nil {
		return ""
	}
	return *v
}

// nullIfBlank keeps "unset" as SQL NULL rather than an empty string, so
// "never connected" and "connected to a book with no name" stay distinct.
func nullIfBlank(v string) *string {
	if strings.TrimSpace(v) == "" {
		return nil
	}
	return &v
}

// gnucashClient builds a client from stored settings.
func (settings gnucashSettings) client() (*gnucashsync.Client, error) {
	if !gnucashsync.ValidBaseURL(settings.BaseURL) {
		return nil, app.Precondition("gnucash sync", "GnuCash base URL is not configured")
	}
	if strings.TrimSpace(settings.Token) == "" {
		return nil, app.Precondition("gnucash sync", "GnuCash API token is not configured")
	}
	return gnucashsync.NewClient(settings.BaseURL, settings.Token, nil), nil
}

// writeClient is what every handler that can PUT, POST, or DELETE against
// folio must build its client with — it is the one chokepoint where the
// prerequisites for writing into someone's books are stated.
//
// On top of the configuration check it requires two things:
//
//   - SyncEnabled. Until now the flag was display-only: handleGnuCashSyncNow
//     never looked at it and the browser gated the button on nothing but a
//     pending request, so "sync disabled" stopped exactly nobody. The restore
//     flow depends on it meaning something — a snapshot is restored with sync
//     disabled and stays that way until the reconciliation dry run passes —
//     so the refusal is now server-side, on every write-capable endpoint.
//   - The cached book identity. An empty BookGUID means the credentials have
//     never been proven against a book, or were rotated since, and writing now
//     could land entries in whatever book the new token happens to open.
//     handleGnuCashSettingsPut clears the identity on exactly those changes.
func (settings gnucashSettings) writeClient() (*gnucashsync.Client, error) {
	client, err := settings.client()
	if err != nil {
		return nil, err
	}
	if !settings.SyncEnabled {
		return nil, app.Conflict("gnucash sync",
			"GnuCash sync is disabled. Enable it in settings before pushing to the book.")
	}
	// Belt and braces on top of the flag. Since 00049 the settings PUT will
	// not turn sync on while restore_state is 'installed', so this can only
	// fire if the row was edited outside the API — which is exactly when a
	// restored, unreconciled mapping set must not push.
	if settings.restorePending() {
		return nil, app.Conflict("gnucash sync",
			"A restored GnuCash sync state is still awaiting reconciliation. "+
				"Acknowledge the reconciliation before pushing to the book.")
	}
	if settings.BookGUID == "" {
		return nil, app.Precondition("gnucash sync",
			"Test the connection before syncing so beez knows which book these credentials open")
	}
	return client, nil
}

// gnucashHTTPStatus maps an application error kind onto a status code. The
// application layer is deliberately transport-free, so the translation lives
// at the edge that speaks HTTP. A precondition is a 400 because that is what
// this endpoint has always returned for "you have not tested the connection
// yet", and the existing clients read it.
func gnucashHTTPStatus(err error) int {
	switch app.KindOf(err) {
	case app.KindInvalid, app.KindPrecondition:
		return http.StatusBadRequest
	case app.KindNotFound:
		return http.StatusNotFound
	case app.KindConflict:
		return http.StatusConflict
	case app.KindForbidden:
		return http.StatusForbidden
	case app.KindUnsupported:
		return http.StatusUnprocessableEntity
	default:
		return http.StatusInternalServerError
	}
}

// writeAppError renders a typed error, hiding the cause of an internal one.
// The operator-facing message is used bare: the Op prefix is for logs and for
// a report line, not for a toast.
func writeAppError(w http.ResponseWriter, err error) {
	status := gnucashHTTPStatus(err)
	if status == http.StatusInternalServerError {
		writeError(w, status, "database error")
		return
	}
	writeError(w, status, appMessage(err))
}

// appMessage is the operator-facing half of a typed error.
func appMessage(err error) string {
	var typed *app.Error
	if errors.As(err, &typed) && typed.Message != "" {
		return typed.Message
	}
	return err.Error()
}

// GET /settings/gnucash — configuration with the token masked to a boolean.
func (s *Server) handleGnuCashSettings(w http.ResponseWriter, r *http.Request) {
	settings, err := loadGnuCashSettings(r.Context(), s.pool)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"baseUrl":        settings.BaseURL,
		"hasToken":       settings.Token != "",
		"bookGuid":       settings.BookGUID,
		"bookName":       settings.BookName,
		"rootCurrency":   settings.RootCurrency,
		"syncEnabled":    settings.SyncEnabled,
		"accountMapping": settings.Mapping,
		// Two names for one column. lastSyncedAt is what the existing client
		// reads; lastSyncAttemptAt is what the value actually means — the run
		// is stamped even when its pull failed and nothing was pushed. New
		// surfaces should read the attempt name.
		"lastSyncedAt":      settings.LastSyncAttemptAt,
		"lastSyncAttemptAt": settings.LastSyncAttemptAt,
		"hasCursor":         settings.ChangesCursor != "",
		// restorePending: the guarded restore installed a preserved cursor and
		// book identity and the reconciliation has not been signed off.
		// restoreState is the durable column behind it (00049): none,
		// installed, or reconciled.
		"restorePending":    settings.restorePending(),
		"restoreState":      settings.normalizedRestoreState(),
		"saleLineKinds":     gnucashsync.SaleLineKinds,
		"expenseCategories": gnucashsync.ExpenseCategories,
	})
}

// PUT /settings/gnucash — base URL, token, enable flag, account mapping.
// An omitted apiToken keeps the stored one; "" clears it (same masked-secret
// contract as ntfy and the AI provider keys).
//
// It runs inside one unit of work that locks the singleton, so it cannot
// interleave with a guarded restore installing a cursor on the same row.
func (s *Server) handleGnuCashSettingsPut(w http.ResponseWriter, r *http.Request) {
	var req struct {
		BaseURL        *string                     `json:"baseUrl"`
		APIToken       *string                     `json:"apiToken"`
		SyncEnabled    *bool                       `json:"syncEnabled"`
		AccountMapping *gnucashsync.AccountMapping `json:"accountMapping"`
		// DiscardRestore is the operator saying, in as many words, that the
		// restored book identity and cursor on this row are no longer wanted.
		// Without it a credential change that would wipe a pending restore is
		// refused instead of performed.
		DiscardRestore bool `json:"discardRestore"`
	}
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}

	err := app.NewRunner(s.pool).Run(r.Context(), s.gnucashActor(r),
		func(ctx context.Context, uow *app.UnitOfWork) error {
			settings, err := loadGnuCashSettingsForUpdate(ctx, uow)
			if err != nil {
				return app.Internal("load gnucash settings", err)
			}

			// Either half of the credential identifies the book we are talking
			// to: a folio token is bound to one book, so rotating it can land
			// us on a different book at the same host. Whenever either changes,
			// the cached book identity and the changes cursor belong to someone
			// else and are dropped, which also forces a fresh connection test
			// before the next sync.
			identityChanged := false
			if req.BaseURL != nil {
				baseURL := strings.TrimSpace(*req.BaseURL)
				if baseURL != "" && !gnucashsync.ValidBaseURL(baseURL) {
					return app.Invalid("gnucash settings",
						"Base URL must be an absolute http(s) URL with no userinfo, query, or fragment").
						WithField("baseUrl")
				}
				if baseURL != settings.BaseURL {
					identityChanged = true
				}
				settings.BaseURL = baseURL
			}
			if req.APIToken != nil {
				token := strings.TrimSpace(*req.APIToken)
				if token != settings.Token {
					identityChanged = true
				}
				settings.Token = token
			}

			// The restore guard. Dropping the identity is right for ordinary
			// operation and fatal during a restore: the cursor and per-row sync
			// state were installed against a book that was proven to match, and
			// re-entering the (deliberately un-exported) token would silently
			// wipe them. While a restore is pending the credential change is
			// refused with a remedy rather than performed. Ordinary saves —
			// including a token rotation on a normally-running integration —
			// are untouched, which is why
			// TestGnuCashSettingsPutClearsTheBookOnATokenChange still passes.
			if identityChanged && settings.restorePending() && !req.DiscardRestore {
				return app.Conflict("gnucash settings",
					"A restored GnuCash cursor is installed and sync is still disabled. "+
						"Changing the server or token now would discard it. Finish the restore "+
						"reconciliation and enable sync, or send discardRestore to drop the "+
						"restored state on purpose.")
			}
			if identityChanged || req.DiscardRestore {
				settings.BookGUID, settings.BookName, settings.RootCurrency = "", "", ""
				settings.ChangesCursor = ""
				// The restored state went with the identity it belonged to.
				settings.RestoreState = restoreStateNone
			}

			// The reconciliation gate (00049). Enabling sync is the act the
			// whole restore window exists to hold back: the restored mappings
			// and cursor have not been checked against the live book yet, so
			// pushing now could create duplicate transactions or overwrite
			// entries a human edited. Only the acknowledgement endpoint moves
			// the row to 'reconciled', and only from there may sync come back
			// on. Turning sync OFF is always allowed.
			if req.SyncEnabled != nil {
				if *req.SyncEnabled && !settings.SyncEnabled &&
					settings.RestoreState == restoreStateInstalled {
					return app.Conflict("gnucash settings",
						"A restored GnuCash sync state is still awaiting reconciliation. "+
							"Run the pull-first reconciliation and the no-write push dry run, "+
							"then acknowledge it, before enabling sync. Sending discardRestore "+
							"drops the restored state instead.")
				}
				if *req.SyncEnabled && settings.RestoreState == restoreStateReconciled {
					// The restore window closes when sync comes back on: the
					// acknowledgement has been spent and the integration is
					// ordinary again.
					settings.RestoreState = restoreStateNone
				}
				settings.SyncEnabled = *req.SyncEnabled
			}
			if req.AccountMapping != nil {
				settings.Mapping = req.AccountMapping.Normalize()
			}
			return app.Internal("save gnucash settings", saveGnuCashSettings(ctx, uow, settings))
		})
	if err != nil {
		writeAppError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"success": true})
}

// gnucashActor is the application-layer identity for a settings command. It
// is an ordinary user actor: these handlers change configuration, and none of
// them may write preserved audit fields. Only handleGnuCashRestore escalates,
// and only after the identity checks below.
func (s *Server) gnucashActor(r *http.Request) app.Actor {
	if user := principalFrom(r); user != nil && user.ID != uuid.Nil {
		return app.UserActor(user.ID, user.DisplayName)
	}
	// Unreachable behind requireAdmin, but a nil principal must not turn into
	// an invalid actor that fails as a 403 with no explanation.
	return app.SystemJobActor("gnucash-settings")
}

func saveGnuCashSettings(ctx context.Context, q app.Querier, settings gnucashSettings) error {
	mappingJSON, err := json.Marshal(settings.Mapping.Normalize())
	if err != nil {
		return err
	}
	_, err = q.Exec(ctx, `
		INSERT INTO gnucash_sync_settings
			(id, base_url, api_token, book_guid, book_name, root_currency,
			 changes_cursor, sync_enabled, account_mapping, last_synced_at,
			 restore_state)
		VALUES (true, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
		ON CONFLICT (id) DO UPDATE SET
			base_url = EXCLUDED.base_url,
			api_token = EXCLUDED.api_token,
			book_guid = EXCLUDED.book_guid,
			book_name = EXCLUDED.book_name,
			root_currency = EXCLUDED.root_currency,
			changes_cursor = EXCLUDED.changes_cursor,
			sync_enabled = EXCLUDED.sync_enabled,
			account_mapping = EXCLUDED.account_mapping,
			last_synced_at = EXCLUDED.last_synced_at,
			restore_state = EXCLUDED.restore_state`,
		settings.BaseURL, nullIfBlank(settings.Token), nullIfBlank(settings.BookGUID),
		nullIfBlank(settings.BookName), nullIfBlank(settings.RootCurrency),
		nullIfBlank(settings.ChangesCursor), settings.SyncEnabled, mappingJSON,
		settings.LastSyncAttemptAt, settings.normalizedRestoreState())
	return err
}

// saveGnuCashCursor persists the pull cursor on its own, after a page has
// been fully processed. A page that fails mid-way leaves the old cursor in
// place so the next run re-reads it.
func saveGnuCashCursor(ctx context.Context, q app.Querier, cursor string) error {
	_, err := q.Exec(ctx, `
		UPDATE gnucash_sync_settings SET changes_cursor = $1 WHERE id = true`,
		nullIfBlank(cursor))
	return err
}

// POST /settings/gnucash/test — call GET status and cache the book identity.
// The browser never talks to folio: the token stays server-side.
func (s *Server) handleGnuCashTest(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	settings, err := loadGnuCashSettings(ctx, s.pool)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	client, err := settings.client()
	if err != nil {
		writeJSON(w, http.StatusOK, map[string]any{"error": appMessage(err)})
		return
	}
	status, err := client.Status(ctx)
	if err != nil {
		writeJSON(w, http.StatusOK, map[string]any{"error": gnucashUserMessage(err)})
		return
	}
	settings.BookGUID = status.BookGUID
	settings.BookName = status.BookName
	settings.RootCurrency = status.RootCurrency
	if err := saveGnuCashSettings(ctx, s.pool, settings); err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"success":      true,
		"bookGuid":     status.BookGUID,
		"bookName":     status.BookName,
		"rootCurrency": status.RootCurrency,
	})
}

// GET /settings/gnucash/accounts — the account list that feeds the mapping
// editor. Read-only on both sides.
func (s *Server) handleGnuCashAccounts(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	settings, err := loadGnuCashSettings(ctx, s.pool)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	client, err := settings.client()
	if err != nil {
		writeAppError(w, err)
		return
	}
	accounts, err := client.Accounts(ctx)
	if err != nil {
		writeError(w, http.StatusBadGateway, gnucashUserMessage(err))
		return
	}
	sort.Slice(accounts, func(i, j int) bool {
		return accounts[i].FullName < accounts[j].FullName
	})
	writeJSON(w, http.StatusOK, map[string]any{"accounts": accounts})
}

// gnucashUserMessage turns a client error into something an operator can act
// on without leaking the token or the raw upstream body.
func gnucashUserMessage(err error) string {
	var apiErr *gnucashsync.APIError
	if errors.As(err, &apiErr) {
		switch {
		case gnucashsync.IsAuth(err):
			return "GnuCash rejected the token (check that it is a folio personal access token bound to the right book)"
		case apiErr.Status == http.StatusNotFound:
			return "GnuCash returned 404 — check the base URL"
		case apiErr.Detail != "":
			return fmt.Sprintf("GnuCash error %s: %s", apiErr.Code, apiErr.Detail)
		case apiErr.Code != "":
			return "GnuCash error " + apiErr.Code
		default:
			return fmt.Sprintf("GnuCash returned HTTP %d", apiErr.Status)
		}
	}
	return "Could not reach GnuCash: " + err.Error()
}

// --- sync row inspection ----------------------------------------------------

// gnucashRow is one external_sync row rendered for the reconciliation UI.
type gnucashRow struct {
	ID              uuid.UUID  `json:"id"`
	EntityType      string     `json:"entityType"`
	EntityID        uuid.UUID  `json:"entityId"`
	ExternalID      string     `json:"externalId"`
	SyncState       string     `json:"syncState"`
	ConflictState   string     `json:"conflictState"`
	LastError       string     `json:"lastError"`
	LastSyncedAt    *time.Time `json:"lastSyncedAt"`
	RemoteEnterDate *time.Time `json:"remoteEnterDate"`
	Summary         string     `json:"summary"`
}

// GET /settings/gnucash/rows — counts by state plus the rows that need a
// human: conflicts first, then failures.
func (s *Server) handleGnuCashRows(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	counts := map[string]int{"pending": 0, "synced": 0, "failed": 0, "ignored": 0}
	rows, err := s.pool.Query(ctx, `
		SELECT sync_state, count(*) FROM external_sync
		WHERE system = $1 GROUP BY sync_state`, SyncSystemGnuCashWeb)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	for rows.Next() {
		var state string
		var count int
		if err := rows.Scan(&state, &count); err != nil {
			rows.Close()
			writeError(w, http.StatusInternalServerError, "database error")
			return
		}
		counts[state] = count
	}
	rows.Close()
	if rows.Err() != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}

	conflicts, err := s.gnucashAttentionRows(ctx, true)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	failures, err := s.gnucashAttentionRows(ctx, false)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"counts":    counts,
		"conflicts": conflicts,
		"failures":  failures,
	})
}

// gnucashAttentionRows lists either the conflicted rows or the failed ones,
// with a human summary of the underlying sale or expense.
func (s *Server) gnucashAttentionRows(ctx context.Context, conflicted bool) ([]gnucashRow, error) {
	const filterConflict = `es.conflict_state IS NOT NULL AND es.conflict_state <> 'none'`
	// A row left pending with last_error set is a transient push failure that
	// will be retried. It still needs to be visible: a folio that is down for
	// a week must not look like a clean sync.
	const filterFailed = `(es.conflict_state IS NULL OR es.conflict_state = 'none')
		AND (es.sync_state = 'failed'
			OR (es.sync_state = 'pending' AND COALESCE(es.last_error, '') <> ''))`
	filter := filterFailed
	if conflicted {
		filter = filterConflict
	}
	query := `
		SELECT es.id, es.entity_type, es.entity_id, es.external_id, es.sync_state,
			es.conflict_state, es.last_error, es.last_synced_at, es.remote_enter_date,
			COALESCE(
				NULLIF(concat_ws(' — ', s.order_number, s.customer_name), ''),
				NULLIF(e.description, ''),
				'')
		FROM external_sync es
		LEFT JOIN sales s ON s.id = es.entity_id AND es.entity_type = 'sale'
		LEFT JOIN expenses e ON e.id = es.entity_id AND es.entity_type = 'expense'
		WHERE es.system = $1 AND ` + filter + `
		ORDER BY es.updated_at DESC
		LIMIT 200`
	rows, err := s.pool.Query(ctx, query, SyncSystemGnuCashWeb)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []gnucashRow{}
	for rows.Next() {
		var (
			row                                gnucashRow
			externalID, conflictState, lastErr *string
		)
		if err := rows.Scan(&row.ID, &row.EntityType, &row.EntityID, &externalID,
			&row.SyncState, &conflictState, &lastErr, &row.LastSyncedAt,
			&row.RemoteEnterDate, &row.Summary); err != nil {
			return nil, err
		}
		row.ExternalID = derefString(externalID)
		row.ConflictState = derefString(conflictState)
		row.LastError = derefString(lastErr)
		out = append(out, row)
	}
	return out, rows.Err()
}

// --- sync run ---------------------------------------------------------------

// gnucashSyncReport is the outcome of one run.
type gnucashSyncReport struct {
	Scanned     int      `json:"scanned"`
	Created     int      `json:"created"`
	Updated     int      `json:"updated"`
	Retired     int      `json:"retired"`
	Failed      int      `json:"failed"`
	Skipped     int      `json:"skipped"`
	PulledItems int      `json:"pulledItems"`
	Conflicts   int      `json:"conflicts"`
	Errors      []string `json:"errors"`
	// LastSyncAttemptAt is when this run finished, successful or not. It is
	// the value that lands in the singleton column, reported under the name
	// that says what it is.
	LastSyncAttemptAt *time.Time `json:"lastSyncAttemptAt,omitempty"`
}

// POST /settings/gnucash/sync — scan, pull, then push. Manual by design: the
// operator watches the first runs before anything is put on a timer.
//
// The pull runs first on purpose. A row whose content changed locally would
// otherwise be PUT over a bookkeeper edit that beez had not seen yet, and the
// pull afterwards would only find our own echo. Consuming the change feed
// first turns that case into a conflict, and the push query skips conflicted
// rows; "Push local again" stays the explicit operator override. For the same
// reason a pull that fails cancels the push: we cannot know what we would be
// overwriting.
func (s *Server) handleGnuCashSyncNow(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	settings, err := loadGnuCashSettings(ctx, s.pool)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	client, err := settings.writeClient()
	if err != nil {
		writeAppError(w, err)
		return
	}
	if !settings.Mapping.Complete() {
		writeError(w, http.StatusBadRequest,
			"Map a cash account before syncing")
		return
	}

	report := &gnucashSyncReport{Errors: []string{}}
	if err := s.gnucashScan(ctx, report); err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	cursor, pullComplete, pullErr := s.gnucashPull(ctx, client, settings.ChangesCursor, report)
	switch {
	case pullErr != nil:
		report.Errors = append(report.Errors,
			"Pull failed, so nothing was pushed this run: "+pullErr.Error())
	case !pullComplete:
		// The page cap stopped the drain early. The advanced cursor is
		// persisted so the next run resumes, but pushing now would write
		// over remote changes nobody has read yet.
		report.Errors = append(report.Errors,
			"pull incomplete - run sync again to continue draining. Nothing was pushed this run.")
	default:
		if err := s.gnucashPush(ctx, client, settings.Mapping, report); err != nil {
			report.Errors = append(report.Errors, err.Error())
		}
	}
	settings.ChangesCursor = cursor
	// Stamped on every run, including one whose pull failed: this is the last
	// ATTEMPT, not the last success. Per-record success is
	// external_sync.last_synced_at.
	now := time.Now()
	settings.LastSyncAttemptAt = &now
	report.LastSyncAttemptAt = &now
	if err := saveGnuCashSettings(ctx, s.pool, settings); err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	writeJSON(w, http.StatusOK, report)
}

// gnucashScan creates pending external_sync rows for everything that belongs
// in the books. It only inserts: an existing row keeps its state, and rows
// whose entity has since been cancelled or deleted are retired by the push.
func (s *Server) gnucashScan(ctx context.Context, report *gnucashSyncReport) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	// A sale enters the books once it is real: not a draft, not cancelled,
	// and physically applied (stock moved, hives handed over).
	const unsyncedSales = `
		SELECT s.id FROM sales s
		WHERE s.cancelled_at IS NULL
		  AND s.order_status NOT IN ('draft', 'cancelled')
		  AND s.physical_applied_at IS NOT NULL
		  AND NOT EXISTS (
			SELECT 1 FROM external_sync es
			WHERE es.system = $1 AND es.entity_type = $2 AND es.entity_id = s.id)`
	if err := gnucashEnsureRows(ctx, tx, unsyncedSales, SyncEntitySale, report); err != nil {
		return err
	}

	const unsyncedExpenses = `
		SELECT e.id FROM expenses e
		WHERE e.deleted_at IS NULL
		  AND NOT EXISTS (
			SELECT 1 FROM external_sync es
			WHERE es.system = $1 AND es.entity_type = $2 AND es.entity_id = e.id)`
	if err := gnucashEnsureRows(ctx, tx, unsyncedExpenses, SyncEntityExpense, report); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func gnucashEnsureRows(
	ctx context.Context, tx pgx.Tx, query, entityType string, report *gnucashSyncReport,
) error {
	rows, err := tx.Query(ctx, query, SyncSystemGnuCashWeb, entityType)
	if err != nil {
		return err
	}
	ids := []uuid.UUID{}
	for rows.Next() {
		var id uuid.UUID
		if err := rows.Scan(&id); err != nil {
			rows.Close()
			return err
		}
		ids = append(ids, id)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return err
	}
	for _, id := range ids {
		if err := ensureSyncRow(ctx, tx, SyncSystemGnuCashWeb, entityType, id); err != nil {
			return err
		}
		report.Scanned++
	}
	return nil
}

// gnucashWorkRow is a push candidate.
type gnucashWorkRow struct {
	ID          uuid.UUID
	EntityType  string
	EntityID    uuid.UUID
	ExternalID  string
	SyncState   string
	ContentHash string
}

// gnucashPush walks every row that is not ignored and not in conflict, and
// makes folio agree with beez. Conflicted rows are deliberately skipped: the
// operator resolves them from the settings page.
func (s *Server) gnucashPush(
	ctx context.Context,
	client *gnucashsync.Client,
	mapping gnucashsync.AccountMapping,
	report *gnucashSyncReport,
) error {
	rows, err := s.pool.Query(ctx, `
		SELECT id, entity_type, entity_id, external_id, sync_state, content_hash
		FROM external_sync
		WHERE system = $1
		  AND entity_type IN ($2, $3)
		  AND sync_state <> 'ignored'
		  AND (conflict_state IS NULL OR conflict_state = 'none')
		ORDER BY created_at`,
		SyncSystemGnuCashWeb, SyncEntitySale, SyncEntityExpense)
	if err != nil {
		return err
	}
	work := []gnucashWorkRow{}
	for rows.Next() {
		var (
			row                     gnucashWorkRow
			externalID, contentHash *string
		)
		if err := rows.Scan(&row.ID, &row.EntityType, &row.EntityID, &externalID,
			&row.SyncState, &contentHash); err != nil {
			rows.Close()
			return err
		}
		row.ExternalID = derefString(externalID)
		row.ContentHash = derefString(contentHash)
		work = append(work, row)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return err
	}

	for _, row := range work {
		if err := ctx.Err(); err != nil {
			return err
		}
		if err := s.gnucashPushRow(ctx, client, mapping, row, false, report); err != nil {
			report.Errors = append(report.Errors,
				fmt.Sprintf("%s %s: %v", row.EntityType, row.EntityID, err))
		}
	}
	return nil
}

// gnucashPushRow syncs one entity. force skips the "unchanged since last
// push" shortcut and is what the conflict resolution button uses.
//
// A transport or 5xx failure leaves the row pending with last_error set, so
// the next run retries. A 4xx is permanent for this body and marks the row
// failed, which is what the settings page surfaces.
func (s *Server) gnucashPushRow(
	ctx context.Context,
	client *gnucashsync.Client,
	mapping gnucashsync.AccountMapping,
	row gnucashWorkRow,
	force bool,
	report *gnucashSyncReport,
) error {
	txn, externalID, live, err := s.gnucashBuild(ctx, mapping, row)
	var buildErr *gnucashBuildError
	switch {
	case errors.As(err, &buildErr):
		report.Failed++
		return s.gnucashMarkFailed(ctx, row.ID, buildErr.Error())
	case err != nil:
		// A database error is transient: leave the row alone and let the
		// caller report it rather than marking the entity unsyncable.
		return err
	}
	if !live {
		// Cancelled, soft-deleted, or hard-deleted since the row was made.
		// Retire it: remove the folio transaction if we ever created one,
		// then stop considering it.
		if row.ExternalID != "" {
			if err := client.DeleteTransaction(ctx, row.ExternalID,
				gnucashsync.DeleteIdempotencyKey(row.ExternalID)); err != nil {
				if gnucashsync.IsReconciled(err) {
					report.Failed++
					return s.gnucashMarkConflict(ctx, row.ID, "diverged",
						"Reconciled in GnuCash — beez no longer has this entry; unreconcile or delete it there")
				}
				if !gnucashsync.IsNotFound(err) {
					if gnucashsync.IsPermanent(err) {
						report.Failed++
						return s.gnucashMarkFailed(ctx, row.ID, gnucashUserMessage(err))
					}
					// Transport or 5xx, handled exactly as on the
					// create/update path: leave the row pending with the
					// error recorded so the retirement is retried and stays
					// on the attention list. Falling through as "synced"
					// would hide an entry beez has already decided does not
					// belong in the books.
					report.Failed++
					if markErr := s.gnucashMarkRetryable(ctx, row.ID,
						gnucashUserMessage(err)); markErr != nil {
						return markErr
					}
					return err
				}
			}
		}
		report.Retired++
		return s.gnucashMarkIgnored(ctx, row.ID)
	}

	hash := gnucashsync.ContentHash(txn)
	if !force && row.SyncState == "synced" && row.ContentHash == hash && row.ExternalID != "" {
		report.Skipped++
		return nil
	}

	result, created, err := s.gnucashWrite(ctx, client, row, externalID, txn, hash)
	if err != nil {
		switch {
		case gnucashsync.IsReconciled(err):
			report.Failed++
			return s.gnucashMarkConflict(ctx, row.ID, "diverged",
				"Reconciled in GnuCash — the local edit was not applied")
		case gnucashsync.IsPermanent(err):
			report.Failed++
			return s.gnucashMarkFailed(ctx, row.ID, gnucashUserMessage(err))
		default:
			// Transport or 5xx: keep it pending so the next run retries, but
			// still report the failure. Swallowing it here would make a dead
			// folio look like a clean sync.
			report.Failed++
			if markErr := s.gnucashMarkRetryable(ctx, row.ID, gnucashUserMessage(err)); markErr != nil {
				return markErr
			}
			return err
		}
	}
	if created {
		report.Created++
	} else {
		report.Updated++
	}
	return s.gnucashMarkSynced(ctx, row.ID, externalID, hash, result)
}

// gnucashWrite performs the create/update dance, including the two recoveries
// the contract requires: a PUT against an unlinked externalId falls back to a
// POST, and a POST that hits an orphaned link acknowledges it with DELETE and
// retries exactly once.
func (s *Server) gnucashWrite(
	ctx context.Context,
	client *gnucashsync.Client,
	row gnucashWorkRow,
	externalID string,
	txn gnucashsync.Transaction,
	hash string,
) (gnucashsync.WriteResult, bool, error) {
	key := gnucashsync.IdempotencyKey(externalID, hash)
	if row.ExternalID != "" {
		result, err := client.UpdateTransaction(ctx, externalID, txn, key)
		if err == nil {
			return result, false, nil
		}
		if !gnucashsync.IsNotFound(err) {
			return gnucashsync.WriteResult{}, false, err
		}
		// Not linked upstream any more; fall through and create it.
	}
	result, err := client.CreateTransaction(ctx, txn, key)
	if err == nil {
		return result, true, nil
	}
	if !gnucashsync.IsLinkOrphaned(err) {
		return gnucashsync.WriteResult{}, true, err
	}
	// The link survived a transaction that was deleted in folio. Acknowledge
	// the tombstone, then create once more.
	if delErr := client.DeleteTransaction(ctx, externalID,
		gnucashsync.DeleteIdempotencyKey(externalID)); delErr != nil &&
		!gnucashsync.IsNotFound(delErr) {
		return gnucashsync.WriteResult{}, true, delErr
	}
	result, err = client.CreateTransaction(ctx, txn, key)
	return result, true, err
}

// gnucashBuildError is a failure the operator has to fix — an unmapped
// account or an entity whose own numbers do not add up. It is distinct from a
// database error, which is transient and must not burn the row.
type gnucashBuildError struct{ err error }

func (e *gnucashBuildError) Error() string { return e.err.Error() }
func (e *gnucashBuildError) Unwrap() error { return e.err }

// gnucashBuild loads the entity behind a sync row and renders its
// transaction. live is false when the entity no longer belongs in the books,
// in which case the transaction is meaningless and must not be pushed.
func (s *Server) gnucashBuild(
	ctx context.Context, mapping gnucashsync.AccountMapping, row gnucashWorkRow,
) (txn gnucashsync.Transaction, externalID string, live bool, err error) {
	switch row.EntityType {
	case SyncEntitySale:
		externalID = gnucashsync.SaleExternalID(row.EntityID.String())
		sale, found, err := s.gnucashLoadSale(ctx, row.EntityID)
		if err != nil || !found {
			return gnucashsync.Transaction{}, externalID, false, err
		}
		txn, err := gnucashsync.BuildSale(sale, mapping)
		if err != nil {
			return gnucashsync.Transaction{}, externalID, true, &gnucashBuildError{err}
		}
		return txn, externalID, true, nil
	case SyncEntityExpense:
		externalID = gnucashsync.ExpenseExternalID(row.EntityID.String())
		expense, found, err := s.gnucashLoadExpense(ctx, row.EntityID)
		if err != nil || !found {
			return gnucashsync.Transaction{}, externalID, false, err
		}
		txn, err := gnucashsync.BuildExpense(expense, mapping)
		if err != nil {
			return gnucashsync.Transaction{}, externalID, true, &gnucashBuildError{err}
		}
		return txn, externalID, true, nil
	default:
		return gnucashsync.Transaction{}, "", false, &gnucashBuildError{
			fmt.Errorf("entity type %q is not pushed to GnuCash", row.EntityType)}
	}
}

// gnucashLoadSale reads a sale and its lines. found is false when the sale is
// gone or no longer qualifies (draft, cancelled, or not physically applied).
func (s *Server) gnucashLoadSale(
	ctx context.Context, id uuid.UUID,
) (gnucashsync.Sale, bool, error) {
	sale := gnucashsync.Sale{ID: id.String()}
	var (
		customerName, orderNumber, location *string
		tax                                 *int64
	)
	err := s.pool.QueryRow(ctx, `
		SELECT date, customer_name, order_number, location,
			total_amount_cents, discount_amount_cents, amount_paid_cents, tax_cents
		FROM sales
		WHERE id = $1
		  AND cancelled_at IS NULL
		  AND order_status NOT IN ('draft', 'cancelled')
		  AND physical_applied_at IS NOT NULL`, id).
		Scan(&sale.Date, &customerName, &orderNumber, &location,
			&sale.TotalCents, &sale.DiscountCents, &sale.AmountPaidCents, &tax)
	if errors.Is(err, pgx.ErrNoRows) {
		return gnucashsync.Sale{}, false, nil
	}
	if err != nil {
		return gnucashsync.Sale{}, false, err
	}
	sale.CustomerName = derefString(customerName)
	sale.OrderNumber = derefString(orderNumber)
	sale.Location = derefString(location)
	if tax != nil {
		sale.TaxCents = *tax
	}

	rows, err := s.pool.Query(ctx, `
		SELECT si.kind, si.quantity, si.unit_price_cents, si.cost_basis_cents,
			COALESCE(js.label, pc.name, et.name, h.position_label, '')
		FROM sale_items si
		LEFT JOIN jar_sizes js ON js.id = si.jar_size_id
		LEFT JOIN product_catalog pc ON pc.id = si.product_id
		LEFT JOIN equipment_stock es ON es.id = si.equipment_stock_id
		LEFT JOIN equipment_types et ON et.id = es.type_id
		LEFT JOIN hives h ON h.id = si.hive_id
		WHERE si.sale_id = $1
		ORDER BY si.kind, si.id`, id)
	if err != nil {
		return gnucashsync.Sale{}, false, err
	}
	defer rows.Close()
	for rows.Next() {
		var line gnucashsync.SaleLine
		if err := rows.Scan(&line.Kind, &line.Quantity, &line.UnitPriceCents,
			&line.CostBasisCents, &line.Label); err != nil {
			return gnucashsync.Sale{}, false, err
		}
		sale.Lines = append(sale.Lines, line)
	}
	if err := rows.Err(); err != nil {
		return gnucashsync.Sale{}, false, err
	}
	return sale, true, nil
}

// gnucashLoadExpense reads a live expense. A soft-deleted one is not found,
// which retires its sync row.
func (s *Server) gnucashLoadExpense(
	ctx context.Context, id uuid.UUID,
) (gnucashsync.Expense, bool, error) {
	expense := gnucashsync.Expense{ID: id.String()}
	var vendor *string
	err := s.pool.QueryRow(ctx, `
		SELECT expense_date, category, description, vendor, amount_cents
		FROM expenses WHERE id = $1 AND deleted_at IS NULL`, id).
		Scan(&expense.Date, &expense.Category, &expense.Description, &vendor,
			&expense.AmountCents)
	if errors.Is(err, pgx.ErrNoRows) {
		return gnucashsync.Expense{}, false, nil
	}
	if err != nil {
		return gnucashsync.Expense{}, false, err
	}
	expense.Vendor = derefString(vendor)
	return expense, true, nil
}

// --- row state transitions --------------------------------------------------

func (s *Server) gnucashMarkSynced(
	ctx context.Context, rowID uuid.UUID, externalID, hash string,
	result gnucashsync.WriteResult,
) error {
	_, err := s.pool.Exec(ctx, `
		UPDATE external_sync SET
			external_id = $2,
			sync_state = 'synced',
			conflict_state = NULL,
			last_error = NULL,
			content_hash = $3,
			remote_transaction_guid = $4,
			remote_enter_date = $5,
			last_synced_at = now()
		WHERE id = $1`,
		rowID, externalID, hash, nullIfBlank(result.TransactionGUID),
		gnucashParseTime(result.EnterDate))
	return err
}

func (s *Server) gnucashMarkFailed(ctx context.Context, rowID uuid.UUID, message string) error {
	_, err := s.pool.Exec(ctx, `
		UPDATE external_sync SET sync_state = 'failed', last_error = $2
		WHERE id = $1`, rowID, truncateError(message))
	return err
}

// gnucashMarkRetryable records a transient failure without burning the row:
// the state stays pending so the next run tries again.
func (s *Server) gnucashMarkRetryable(ctx context.Context, rowID uuid.UUID, message string) error {
	_, err := s.pool.Exec(ctx, `
		UPDATE external_sync SET sync_state = 'pending', last_error = $2
		WHERE id = $1`, rowID, truncateError(message))
	return err
}

func (s *Server) gnucashMarkIgnored(ctx context.Context, rowID uuid.UUID) error {
	_, err := s.pool.Exec(ctx, `
		UPDATE external_sync SET
			sync_state = 'ignored', conflict_state = NULL, last_error = NULL,
			external_id = NULL, content_hash = NULL,
			remote_transaction_guid = NULL, remote_enter_date = NULL
		WHERE id = $1`, rowID)
	return err
}

func (s *Server) gnucashMarkConflict(
	ctx context.Context, rowID uuid.UUID, state, message string,
) error {
	_, err := s.pool.Exec(ctx, `
		UPDATE external_sync SET conflict_state = $2, last_error = $3
		WHERE id = $1`, rowID, state, truncateError(message))
	return err
}

// truncateError keeps a pathological upstream message out of the column.
func truncateError(message string) string {
	const limit = 500
	message = strings.TrimSpace(message)
	if len(message) <= limit {
		return message
	}
	runes := []rune(message)
	if len(runes) <= limit {
		return string(runes)
	}
	return string(runes[:limit])
}

// gnucashParseTime parses a contract timestamp. An unparseable value yields
// nil rather than a wrong instant: a missing remote_enter_date only means the
// next pull cannot compare, which is safe.
func gnucashParseTime(raw string) *time.Time {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return nil
	}
	for _, layout := range []string{time.RFC3339Nano, time.RFC3339, "2006-01-02 15:04:05Z07:00", "2006-01-02T15:04:05"} {
		if parsed, err := time.Parse(layout, raw); err == nil {
			return &parsed
		}
	}
	return nil
}

// --- pull / reconcile -------------------------------------------------------

// gnucashPull drains GET changes from the stored cursor and flags anything
// that touched a transaction beez owns. It never writes a beez record: the
// only effect is external_sync.conflict_state and last_error.
//
// The returned cursor is the furthest point that was fully processed, and is
// what the caller persists.
func (s *Server) gnucashPull(
	ctx context.Context,
	client *gnucashsync.Client,
	cursor string,
	report *gnucashSyncReport,
) (string, bool, error) {
	for page := 0; page < gnucashMaxPullPages; page++ {
		if err := ctx.Err(); err != nil {
			return cursor, false, err
		}
		result, err := client.Changes(ctx, cursor, gnucashPullPageSize)
		if err != nil {
			return cursor, false, fmt.Errorf("pull changes: %s", gnucashUserMessage(err))
		}
		// A page that claims more but cannot say where to resume would replay
		// itself until the page cap, every run, forever. That is a broken
		// server, not a state beez can recover from: stop with the cursor
		// where it was and tell the operator.
		if result.HasMore {
			switch result.NextCursor {
			case "":
				return cursor, false, errors.New(
					"pull changes: GnuCash reported more changes without a nextCursor")
			case cursor:
				return cursor, false, errors.New(
					"pull changes: GnuCash returned the same nextCursor twice, so the change feed cannot advance")
			}
		}
		for _, item := range result.Items {
			report.PulledItems++
			flagged, err := s.gnucashReconcileItem(ctx, item)
			if err != nil {
				// Stop before advancing the cursor so the unprocessed part
				// of this page is re-read next run.
				return cursor, false, err
			}
			if flagged {
				report.Conflicts++
			}
		}
		if result.NextCursor != "" && result.NextCursor != cursor {
			cursor = result.NextCursor
			if err := saveGnuCashCursor(ctx, s.pool, cursor); err != nil {
				return cursor, false, err
			}
		}
		if !result.HasMore {
			return cursor, true, nil
		}
	}
	// The page cap ran out with the feed still claiming more. The cursor we
	// reached is real and worth keeping, but everything past it is still
	// unread, so as far as the push is concerned this run is no better
	// informed than a pull that failed outright.
	return cursor, false, nil
}

// gnucashReconcileItem applies one change item. Items whose externalId beez
// does not own are folio-native activity and are ignored by design.
func (s *Server) gnucashReconcileItem(
	ctx context.Context, item gnucashsync.Change,
) (bool, error) {
	if item.ExternalID == nil || *item.ExternalID == "" {
		return false, nil
	}
	var (
		rowID     uuid.UUID
		syncState string
		stored    *time.Time
	)
	err := s.pool.QueryRow(ctx, `
		SELECT id, sync_state, remote_enter_date FROM external_sync
		WHERE system = $1 AND external_id = $2`,
		SyncSystemGnuCashWeb, *item.ExternalID).Scan(&rowID, &syncState, &stored)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	// An ignored row was deliberately retired; folio activity on it is not a
	// conflict beez has an opinion about.
	if syncState == "ignored" {
		return false, nil
	}

	if item.Deleted {
		return true, s.gnucashMarkConflict(ctx, rowID, "remote_newer",
			"Deleted in GnuCash. Beez still has this entry — push it again to recreate it, or ignore it here.")
	}
	if item.Unrepresentable {
		return true, s.gnucashMarkConflict(ctx, rowID, "remote_newer",
			"Edited in GnuCash into a shape beez cannot represent (multi-currency or similar). Resolve it in GnuCash.")
	}

	remote := gnucashParseTime(item.EnterDate)
	if remote == nil {
		return false, nil
	}
	if stored != nil && stored.Equal(*remote) {
		// Our own push echoing back.
		return false, nil
	}
	// pending means beez also has an unpushed local change.
	state := "remote_newer"
	message := "Edited in GnuCash since the last push. Push the beez version again to overwrite it, or ignore it here."
	if syncState == "pending" {
		state = "diverged"
		message = "Edited in GnuCash AND changed in beez since the last push. Push the beez version to overwrite GnuCash, or ignore it here."
	}
	if _, err := s.pool.Exec(ctx, `
		UPDATE external_sync SET conflict_state = $2, last_error = $3,
			remote_enter_date = $4, remote_transaction_guid = COALESCE($5, remote_transaction_guid)
		WHERE id = $1`,
		rowID, state, truncateError(message), remote,
		nullIfBlank(item.TransactionGUID)); err != nil {
		return false, err
	}
	return true, nil
}

// --- conflict resolution ----------------------------------------------------

// POST /settings/gnucash/rows/{id}/push — overwrite folio with the beez
// version of this entity, clearing the conflict. Beez is authoritative for
// what physically happened, so this is the ordinary resolution.
func (s *Server) handleGnuCashRowPush(w http.ResponseWriter, r *http.Request) {
	rowID, err := uuidParam(r, "id")
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid id")
		return
	}
	ctx := r.Context()
	settings, err := loadGnuCashSettings(ctx, s.pool)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	// A manual override is still a write into a book, so it carries the same
	// tested-identity prerequisite as the scheduled run, checked before any
	// state is touched.
	client, err := settings.writeClient()
	if err != nil {
		writeAppError(w, err)
		return
	}

	var (
		row                     gnucashWorkRow
		externalID, contentHash *string
	)
	err = s.pool.QueryRow(ctx, `
		SELECT id, entity_type, entity_id, external_id, sync_state, content_hash
		FROM external_sync WHERE id = $1 AND system = $2`,
		rowID, SyncSystemGnuCashWeb).
		Scan(&row.ID, &row.EntityType, &row.EntityID, &externalID,
			&row.SyncState, &contentHash)
	if errors.Is(err, pgx.ErrNoRows) {
		writeError(w, http.StatusNotFound, "sync row not found")
		return
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	row.ExternalID = derefString(externalID)
	row.ContentHash = derefString(contentHash)

	// Clear the conflict first: the push either succeeds (and clears it for
	// good) or records the new failure, and either way the stale flag must
	// not survive.
	if _, err := s.pool.Exec(ctx, `
		UPDATE external_sync SET conflict_state = NULL WHERE id = $1`, rowID); err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}

	report := &gnucashSyncReport{Errors: []string{}}
	if err := s.gnucashPushRow(ctx, client, settings.Mapping, row, true, report); err != nil {
		writeError(w, http.StatusBadGateway, gnucashUserMessage(err))
		return
	}
	writeJSON(w, http.StatusOK, report)
}

// POST /settings/gnucash/rows/{id}/ignore — stop syncing this entity. It
// leaves whatever is in folio alone; beez simply stops having an opinion.
func (s *Server) handleGnuCashRowIgnore(w http.ResponseWriter, r *http.Request) {
	rowID, err := uuidParam(r, "id")
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid id")
		return
	}
	tag, err := s.pool.Exec(r.Context(), `
		UPDATE external_sync SET sync_state = 'ignored', conflict_state = 'none',
			last_error = NULL
		WHERE id = $1 AND system = $2`, rowID, SyncSystemGnuCashWeb)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	if tag.RowsAffected() == 0 {
		writeError(w, http.StatusNotFound, "sync row not found")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"success": true})
}

// --- guarded restore --------------------------------------------------------

// The GnuCash half of the P0 snapshot restore.
//
// A snapshot carries every non-secret value needed to recognise already
// synchronised work: the per-row external_sync projection (external IDs,
// sync and conflict state, content_hash, remote_transaction_guid,
// remote_enter_date, per-row last_synced_at) and the singleton's bounded
// change-feed cursor and book identity. It does NOT carry the folio token —
// credentials are excluded from the artifact by contract — which is exactly
// why installing the cursor is dangerous: the operator has to type the token
// back in, and an ordinary settings save treats a token change as "this is a
// different book" and clears the cursor.
//
// So the restore is one guarded command with the steps in the only safe
// order:
//
//  1. the operator configures the base URL and token normally, and tests;
//  2. this endpoint is called with the book identity the artifact expects;
//  3. it re-tests the live connection itself and requires an EXACT match on
//     both bookGuid and rootCurrency — the expectation from the artifact is
//     held separately from the stored identity, so a token that opens a
//     different book is caught here rather than after the first push;
//  4. only then does it install the cursor, the book identity, and the
//     per-row sync state, atomically, with sync still disabled.
//
// Sync stays disabled afterwards on purpose. The pull-first reconciliation
// and the no-write push dry run come before re-enabling it, and writeClient
// now refuses every write-capable endpoint while the flag is off.
//
// The pending signal is durable, not derived. This endpoint sets
// gnucash_sync_settings.restore_state to 'installed' (00049); the
// acknowledgement below — the same endpoint with {"markReconciled": true} -
// moves it to 'reconciled', and that is the only route by which the settings
// PUT will let sync be enabled again. Before 00049 the signal was guessed
// from "book identity present, cursor present, sync disabled", which called a
// merely-paused integration a pending restore and had nowhere to record the
// sign-off.

// gnucashRestoreRow is one preserved external_sync row from the artifact.
type gnucashRestoreRow struct {
	// ID is the preserved external_sync primary key. Optional: the row is
	// identified by (system, entityType, entityId), but preserving it keeps
	// the restored database digest-identical to the exported one.
	ID                    *uuid.UUID `json:"id"`
	EntityType            string     `json:"entityType"`
	EntityID              uuid.UUID  `json:"entityId"`
	ExternalID            string     `json:"externalId"`
	SyncState             string     `json:"syncState"`
	ConflictState         string     `json:"conflictState"`
	LastError             string     `json:"lastError"`
	ContentHash           string     `json:"contentHash"`
	RemoteTransactionGUID string     `json:"remoteTransactionGuid"`
	RemoteEnterDate       *time.Time `json:"remoteEnterDate"`
	// LastSyncedAt is per-row and IS a success time: it is written only by
	// gnucashMarkSynced. That is the opposite of the singleton column.
	LastSyncedAt *time.Time `json:"lastSyncedAt"`
	CreatedAt    *time.Time `json:"createdAt"`
}

type gnucashRestoreRequest struct {
	// ExpectedBookGUID and ExpectedRootCurrency come from the artifact and
	// are compared against a live connection test. They are held separately
	// from the stored identity on purpose: comparing the stored value against
	// itself would prove nothing.
	ExpectedBookGUID     string `json:"expectedBookGuid"`
	ExpectedRootCurrency string `json:"expectedRootCurrency"`
	ChangesCursor        string `json:"changesCursor"`
	// LastSyncAttemptAt is the singleton column under its true name.
	LastSyncAttemptAt *time.Time          `json:"lastSyncAttemptAt"`
	Rows              []gnucashRestoreRow `json:"rows"`
	// ReplaceExisting is the explicit conflict policy. A restore expects an
	// empty sync state; finding rows is reported, not silently merged.
	ReplaceExisting bool `json:"replaceExisting"`
	// DryRun validates everything, including the live identity match and the
	// database constraints, and keeps nothing.
	DryRun bool `json:"dryRun"`
	// MarkReconciled is the admin acknowledgement, not a restore: it carries
	// no artifact and takes this same endpoint because it is the other half
	// of one operator flow. It closes the restore window opened by an earlier
	// call, and it is the only thing that lets sync be enabled afterwards.
	// Every other field is ignored when it is set.
	MarkReconciled bool `json:"markReconciled"`
}

// gnucashSyncStates and gnucashConflictStates mirror the 00005 CHECKs so a
// bad artifact fails with a message instead of a SQLSTATE.
var (
	gnucashSyncStates = map[string]bool{
		"pending": true, "synced": true, "failed": true, "ignored": true}
	gnucashConflictStates = map[string]bool{
		"": true, "none": true, "local_newer": true, "remote_newer": true, "diverged": true}
)

// validateGnuCashRestore checks the payload without touching folio or the
// database, so a malformed artifact is rejected before anything is contacted.
func validateGnuCashRestore(req gnucashRestoreRequest) error {
	const op = "gnucash restore"
	if strings.TrimSpace(req.ExpectedBookGUID) == "" {
		return app.Invalid(op,
			"expectedBookGuid is required: the restore has to know which book the artifact came from").
			WithField("expectedBookGuid")
	}
	if strings.TrimSpace(req.ExpectedRootCurrency) == "" {
		return app.Invalid(op, "expectedRootCurrency is required").WithField("expectedRootCurrency")
	}
	entityTypes := map[string]bool{}
	for _, entityType := range syncEntityTypes {
		entityTypes[entityType] = true
	}
	seenEntity := map[string]bool{}
	seenExternal := map[string]bool{}
	for i, row := range req.Rows {
		where := fmt.Sprintf("rows[%d]", i)
		if !entityTypes[row.EntityType] {
			return app.Invalid(op, "%s: entity type %q is not a known external_sync entity type",
				where, row.EntityType).WithField("entityType")
		}
		if row.EntityID == uuid.Nil {
			return app.Invalid(op, "%s: entityId is required", where).WithField("entityId")
		}
		if !gnucashSyncStates[row.SyncState] {
			return app.Invalid(op, "%s: sync state %q is not one of pending, synced, failed, ignored",
				where, row.SyncState).WithField("syncState")
		}
		if !gnucashConflictStates[row.ConflictState] {
			return app.Invalid(op,
				"%s: conflict state %q is not one of none, local_newer, remote_newer, diverged",
				where, row.ConflictState).WithField("conflictState")
		}
		// The external ID is derived from the entity, not stored freely
		// (gnucashsync.SaleExternalID / ExpenseExternalID). A mismatch means
		// the artifact was re-keyed incorrectly, which would push a beez
		// entity onto some other folio transaction.
		if row.ExternalID != "" {
			var want string
			switch row.EntityType {
			case SyncEntitySale:
				want = gnucashsync.SaleExternalID(row.EntityID.String())
			case SyncEntityExpense:
				want = gnucashsync.ExpenseExternalID(row.EntityID.String())
			}
			if want != "" && row.ExternalID != want {
				return app.Invalid(op, "%s: external id %q does not match %q for this entity",
					where, row.ExternalID, want).WithField("externalId")
			}
			if seenExternal[row.ExternalID] {
				return app.Invalid(op, "%s: external id %q appears twice", where, row.ExternalID).
					WithField("externalId")
			}
			seenExternal[row.ExternalID] = true
		}
		key := row.EntityType + ":" + row.EntityID.String()
		if seenEntity[key] {
			return app.Invalid(op, "%s: %s appears twice", where, key).WithField("entityId")
		}
		seenEntity[key] = true
		if row.SyncState == "synced" && row.ExternalID == "" {
			return app.Invalid(op, "%s: a synced row must carry the external id it is synced to",
				where).WithField("externalId")
		}
	}
	return nil
}

// gnucashRestoreResult is the restore report for this domain.
type gnucashRestoreResult struct {
	Success           bool       `json:"success"`
	DryRun            bool       `json:"dryRun"`
	BookGUID          string     `json:"bookGuid"`
	BookName          string     `json:"bookName"`
	RootCurrency      string     `json:"rootCurrency"`
	CursorInstalled   bool       `json:"cursorInstalled"`
	RowsRestored      int        `json:"rowsRestored"`
	RowsReplaced      int        `json:"rowsReplaced"`
	SyncEnabled       bool       `json:"syncEnabled"`
	RestorePending    bool       `json:"restorePending"`
	RestoreState      string     `json:"restoreState"`
	LastSyncAttemptAt *time.Time `json:"lastSyncAttemptAt"`
	ExcludedConfig    []string   `json:"excludedConfig"`
	NextSteps         []string   `json:"nextSteps"`
}

// POST /settings/gnucash/restore — install a preserved cursor, book identity,
// and per-row sync state after proving the credentials open the same book.
func (s *Server) handleGnuCashRestore(w http.ResponseWriter, r *http.Request) {
	var req gnucashRestoreRequest
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if req.MarkReconciled {
		s.gnucashAcknowledgeReconciliation(w, r)
		return
	}
	if err := validateGnuCashRestore(req); err != nil {
		writeAppError(w, err)
		return
	}

	ctx := r.Context()
	settings, err := loadGnuCashSettings(ctx, s.pool)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	// Credentials first. The artifact never carried them, so the operator has
	// already had to enter them; a restore that ran before that would install
	// a cursor for a connection nobody can test.
	client, err := settings.client()
	if err != nil {
		writeAppError(w, err)
		return
	}
	if settings.SyncEnabled {
		writeAppError(w, app.Conflict("gnucash restore",
			"Disable GnuCash sync before restoring. The restored mappings have to pass a "+
				"pull-first reconciliation before anything is pushed."))
		return
	}

	// The identity proof: a live status call, compared against what the
	// artifact says, not against what is already stored.
	status, err := client.Status(ctx)
	if err != nil {
		writeError(w, http.StatusBadGateway, gnucashUserMessage(err))
		return
	}
	if status.BookGUID != req.ExpectedBookGUID || status.RootCurrency != req.ExpectedRootCurrency {
		writeAppError(w, app.Conflict("gnucash restore",
			"These credentials open book %q (%s), but the snapshot was taken from book %q (%s). "+
				"Point beez at the original book before restoring its sync state.",
			status.BookGUID, status.RootCurrency, req.ExpectedBookGUID, req.ExpectedRootCurrency))
		return
	}

	result := gnucashRestoreResult{
		DryRun:            req.DryRun,
		BookGUID:          status.BookGUID,
		BookName:          status.BookName,
		RootCurrency:      status.RootCurrency,
		LastSyncAttemptAt: req.LastSyncAttemptAt,
	}
	// The privileged actor: this command writes preserved external_sync ids
	// and created_at values, which no user command may do. It is escalated
	// only here, only after the identity proof above, and the id of the
	// operator rides along as the fallback attribution.
	actor := app.SystemRestoreActor(s.gnucashOperatorID(r))
	runner := app.NewRunner(s.pool)
	install := func(ctx context.Context, uow *app.UnitOfWork) error {
		return s.gnucashInstallRestore(ctx, uow, req, status, settings, &result)
	}
	// A dry run runs the same statements inside a transaction that is always
	// rolled back, which is what makes the CHECK constraints and the unique
	// indexes actually evaluate. Nothing survives it.
	if req.DryRun {
		err = runner.DryRun(ctx, actor, install)
	} else {
		err = runner.Run(ctx, actor, install)
	}
	if err != nil {
		writeAppError(w, err)
		return
	}

	result.Success = true
	result.SyncEnabled = false
	result.RestorePending = true
	// A dry run rolled the install back, so the row is still whatever it was.
	if req.DryRun {
		result.RestoreState = settings.normalizedRestoreState()
		result.RestorePending = settings.restorePending()
	}
	result.ExcludedConfig = []string{
		"gnucash_sync_settings.api_token — never exported; entered by the operator before this restore",
	}
	result.NextSteps = []string{
		"Run the pull-first reconciliation and the no-write push dry run against the restored mappings.",
		"Resolve anything quarantined as a conflict.",
		"Acknowledge the reconciliation: POST /settings/gnucash/restore with markReconciled.",
		"Only then enable GnuCash sync; the settings PUT refuses to enable it until you do.",
	}
	writeJSON(w, http.StatusOK, result)
}

// gnucashReconcileResult is the acknowledgement report.
type gnucashReconcileResult struct {
	Success        bool     `json:"success"`
	RestoreState   string   `json:"restoreState"`
	RestorePending bool     `json:"restorePending"`
	SyncEnabled    bool     `json:"syncEnabled"`
	NextSteps      []string `json:"nextSteps"`
}

// gnucashAcknowledgeReconciliation is POST /settings/gnucash/restore with
// {"markReconciled": true}: the admin states that the pull-first
// reconciliation and the no-write push dry run passed against the restored
// mappings. It moves restore_state from 'installed' to 'reconciled' (00049)
// and does nothing else — in particular it does NOT enable sync. Enabling is
// a separate, deliberate act through the settings PUT, which this state is
// the precondition for.
//
// It refuses from any other state so an acknowledgement cannot be banked
// ahead of a restore: 'none' has nothing to acknowledge, and 'reconciled' is
// already signed off.
func (s *Server) gnucashAcknowledgeReconciliation(w http.ResponseWriter, r *http.Request) {
	const op = "gnucash restore reconciliation"
	var result gnucashReconcileResult
	err := app.NewRunner(s.pool).Run(r.Context(), s.gnucashActor(r),
		func(ctx context.Context, uow *app.UnitOfWork) error {
			settings, err := loadGnuCashSettingsForUpdate(ctx, uow)
			if err != nil {
				return app.Internal(op, err)
			}
			switch settings.normalizedRestoreState() {
			case restoreStateInstalled:
			case restoreStateReconciled:
				return app.Conflict(op,
					"The restored GnuCash sync state has already been acknowledged. "+
						"Enable sync when you are ready.")
			default:
				return app.Conflict(op,
					"There is no restored GnuCash sync state awaiting reconciliation.")
			}
			if settings.SyncEnabled {
				// Unreachable through the API — the PUT will not enable sync
				// from 'installed' — but a hand-edited row must not have its
				// restore acknowledged while it is already pushing.
				return app.Conflict(op,
					"GnuCash sync is already enabled; the reconciliation is acknowledged "+
						"before sync is turned on, not after.")
			}
			settings.RestoreState = restoreStateReconciled
			if err := saveGnuCashSettings(ctx, uow, settings); err != nil {
				return app.Internal(op, err)
			}
			result.RestoreState = restoreStateReconciled
			result.SyncEnabled = settings.SyncEnabled
			return nil
		})
	if err != nil {
		writeAppError(w, err)
		return
	}
	result.Success = true
	result.RestorePending = false
	result.NextSteps = []string{
		"Enable GnuCash sync in settings when you are ready for beez to push again.",
	}
	writeJSON(w, http.StatusOK, result)
}

// gnucashOperatorID is the human who launched the restore. It is recorded as
// the fallback attribution of the restore actor, not as authorization: being
// an admin does not grant the preserved-audit privilege, the command does.
func (s *Server) gnucashOperatorID(r *http.Request) uuid.UUID {
	if user := principalFrom(r); user != nil {
		return user.ID
	}
	return uuid.Nil
}

// gnucashInstallRestore is the whole transactional half: lock, re-verify,
// clear if allowed, install.
func (s *Server) gnucashInstallRestore(
	ctx context.Context,
	uow *app.UnitOfWork,
	req gnucashRestoreRequest,
	status gnucashsync.Status,
	tested gnucashSettings,
	result *gnucashRestoreResult,
) error {
	const op = "gnucash restore"
	settings, err := loadGnuCashSettingsForUpdate(ctx, uow)
	if err != nil {
		return app.Internal(op, err)
	}
	// The row lock is held from here to commit, so a settings PUT cannot slip
	// between the identity proof and the install. If one got in first, its
	// credential change invalidated the connection just tested and the restore
	// has to start over rather than install a cursor for a book it no longer
	// opens.
	if settings.BaseURL != tested.BaseURL || settings.Token != tested.Token {
		return app.Conflict(op,
			"The GnuCash credentials changed while this restore was being verified. "+
				"Test the connection again and re-run the restore.")
	}
	if settings.SyncEnabled {
		return app.Conflict(op, "GnuCash sync was enabled while this restore was being verified.")
	}

	var existing int
	if err := uow.QueryRow(ctx,
		`SELECT count(*) FROM external_sync WHERE system = $1`, SyncSystemGnuCashWeb).
		Scan(&existing); err != nil {
		return app.Internal(op, err)
	}
	if existing > 0 && !req.ReplaceExisting {
		return app.Conflict(op,
			"%d GnuCash sync rows already exist. A restore installs the sync state of the artifact "+
				"into an empty one; send replaceExisting to discard what is there on purpose.",
			existing)
	}
	if existing > 0 {
		if _, err := uow.Exec(ctx,
			`DELETE FROM external_sync WHERE system = $1`, SyncSystemGnuCashWeb); err != nil {
			return app.Internal(op, err)
		}
		result.RowsReplaced = existing
	}

	for i, row := range req.Rows {
		if err := gnucashInsertRestoredRow(ctx, uow, row); err != nil {
			return fmt.Errorf("rows[%d] %s %s: %w", i, row.EntityType, row.EntityID, err)
		}
		result.RowsRestored++
	}

	settings.BookGUID = status.BookGUID
	settings.BookName = status.BookName
	settings.RootCurrency = status.RootCurrency
	settings.ChangesCursor = req.ChangesCursor
	settings.LastSyncAttemptAt = req.LastSyncAttemptAt
	settings.SyncEnabled = false
	// The restore window opens here and is closed only by the acknowledgement
	// or by an explicit discardRestore (00049).
	settings.RestoreState = restoreStateInstalled
	result.RestoreState = restoreStateInstalled
	if err := saveGnuCashSettings(ctx, uow, settings); err != nil {
		return app.Internal(op, err)
	}
	result.CursorInstalled = strings.TrimSpace(req.ChangesCursor) != ""
	return nil
}

// gnucashInsertRestoredRow writes one preserved external_sync row, including
// its id and created_at. This is the restore-repository convention applied to
// a sync-state table: preserved identity written directly, everything the
// database would have generated supplied instead.
func gnucashInsertRestoredRow(
	ctx context.Context, uow *app.UnitOfWork, row gnucashRestoreRow,
) error {
	const op = "gnucash restore row"
	if !uow.Actor().MayWritePreservedAudit() {
		return app.Forbidden(op, "only the system restore actor may write preserved sync rows")
	}
	id := uuid.New()
	if row.ID != nil && *row.ID != uuid.Nil {
		id = *row.ID
	}
	createdAt := time.Now()
	if row.CreatedAt != nil {
		createdAt = *row.CreatedAt
	}
	tag, err := uow.Exec(ctx, `
		INSERT INTO external_sync
			(id, system, entity_type, entity_id, external_id, sync_state,
			 conflict_state, last_error, content_hash, remote_transaction_guid,
			 remote_enter_date, last_synced_at, created_at, updated_at)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $13)
		ON CONFLICT DO NOTHING`,
		id, SyncSystemGnuCashWeb, row.EntityType, row.EntityID,
		nullIfBlank(row.ExternalID), row.SyncState, nullIfBlank(row.ConflictState),
		nullIfBlank(row.LastError), nullIfBlank(row.ContentHash),
		nullIfBlank(row.RemoteTransactionGUID), row.RemoteEnterDate,
		row.LastSyncedAt, createdAt)
	if err != nil {
		return app.Internal(op, err)
	}
	if tag.RowsAffected() == 0 {
		return app.Conflict(op, "a sync row for this entity or external id already exists")
	}
	return nil
}
