package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/biker2000on/beez-trackz/backend/internal/gnucashsync"
)

// DB-backed tests for the live GnuCash sync, against an httptest server that
// plays folio: it holds the link table, enforces the balance rule, and serves
// a paged change feed the way the contract describes.

// --- fake folio -------------------------------------------------------------

type folioTxn struct {
	GUID       string
	EnterDate  time.Time
	Body       gnucashsync.Transaction
	Reconciled bool
}

type folioFake struct {
	mu     sync.Mutex
	server *httptest.Server

	linked   map[string]*folioTxn
	orphaned map[string]bool
	changes  []gnucashsync.Change

	// pageLimit forces the engine through more than one changes page.
	pageLimit int
	clock     time.Time
	seq       int

	// writesFail turns every POST/PUT/DELETE into a 502, the retryable shape.
	writesFail bool
	// stuckCursor makes GET changes claim hasMore while refusing to advance:
	// "" returns no nextCursor at all, "repeat" echoes the one it was given.
	stuckCursor string

	posts, puts, deletes, changeCalls int
	unbalanced                        []gnucashsync.Transaction
}

func newFolioFake(t *testing.T) *folioFake {
	t.Helper()
	fake := &folioFake{
		linked:    map[string]*folioTxn{},
		orphaned:  map[string]bool{},
		pageLimit: 500,
		clock:     time.Date(2026, 8, 20, 12, 0, 0, 0, time.UTC),
	}
	fake.server = httptest.NewServer(http.HandlerFunc(fake.route))
	t.Cleanup(fake.server.Close)
	return fake
}

func (f *folioFake) tick() time.Time {
	f.clock = f.clock.Add(time.Minute)
	return f.clock
}

func (f *folioFake) nextGUID() string {
	f.seq++
	return "gc-" + strconv.Itoa(f.seq)
}

// record appends to the change feed exactly as folio would: every write,
// including the ones beez itself made, shows up for the next puller.
func (f *folioFake) record(change gnucashsync.Change) {
	f.changes = append(f.changes, change)
}

func changeFor(externalID string, txn *folioTxn) gnucashsync.Change {
	id := externalID
	splits := make([]gnucashsync.ChangeSplit, 0, len(txn.Body.Splits))
	for _, split := range txn.Body.Splits {
		splits = append(splits, gnucashsync.ChangeSplit{
			AccountGUID:    split.AccountGUID,
			AmountCents:    split.AmountCents,
			Memo:           split.Memo,
			ReconcileState: "n",
		})
	}
	return gnucashsync.Change{
		TransactionGUID: txn.GUID,
		ExternalID:      &id,
		PostDate:        txn.Body.PostDate,
		EnterDate:       txn.EnterDate.Format(time.RFC3339Nano),
		Description:     txn.Body.Description,
		Splits:          splits,
	}
}

func (f *folioFake) route(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	defer f.mu.Unlock()
	path := strings.TrimPrefix(r.URL.Path, "/api/integrations/beez")
	switch {
	case r.Method == http.MethodGet && path == "/status":
		writeJSON(w, http.StatusOK, map[string]any{
			"ok": true, "bookGuid": "book-1", "bookName": "Yard Books", "rootCurrency": "USD",
		})
	case r.Method == http.MethodGet && path == "/accounts":
		writeJSON(w, http.StatusOK, map[string]any{"accounts": []map[string]any{
			{"guid": "acct-cash", "name": "Cash", "fullName": "Assets:Cash", "type": "ASSET",
				"commodityMnemonic": "USD"},
			{"guid": "acct-revenue-jar", "name": "Honey", "fullName": "Income:Honey",
				"type": "INCOME", "commodityMnemonic": "USD"},
		}})
	case r.Method == http.MethodPost && path == "/transactions":
		if f.writesFail {
			f.posts++
			writeJSON(w, http.StatusBadGateway, map[string]any{
				"error": "bad_gateway", "detail": "folio is restarting",
			})
			return
		}
		f.create(w, r)
	case r.Method == http.MethodPut && strings.HasPrefix(path, "/transactions/"):
		if f.writesFail {
			f.puts++
			writeJSON(w, http.StatusBadGateway, map[string]any{
				"error": "bad_gateway", "detail": "folio is restarting",
			})
			return
		}
		f.update(w, r, strings.TrimPrefix(path, "/transactions/"))
	case r.Method == http.MethodDelete && strings.HasPrefix(path, "/transactions/"):
		if f.writesFail {
			f.deletes++
			writeJSON(w, http.StatusBadGateway, map[string]any{
				"error": "bad_gateway", "detail": "folio is restarting",
			})
			return
		}
		f.remove(w, strings.TrimPrefix(path, "/transactions/"))
	case r.Method == http.MethodGet && path == "/changes":
		f.changesPage(w, r)
	default:
		writeJSON(w, http.StatusNotFound, map[string]any{"error": "not_found"})
	}
}

// checkBalance is the invariant the contract states, enforced on the server
// side so no test can pass with a lopsided entry.
func (f *folioFake) checkBalance(w http.ResponseWriter, txn gnucashsync.Transaction) bool {
	if len(txn.Splits) >= 2 && txn.Sum() == 0 {
		return true
	}
	f.unbalanced = append(f.unbalanced, txn)
	writeJSON(w, http.StatusUnprocessableEntity, map[string]any{
		"error": "unbalanced", "detail": "splits must sum to zero",
	})
	return false
}

func (f *folioFake) create(w http.ResponseWriter, r *http.Request) {
	f.posts++
	var body gnucashsync.Transaction
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "bad_body"})
		return
	}
	if !f.checkBalance(w, body) {
		return
	}
	if f.orphaned[body.ExternalID] {
		writeJSON(w, http.StatusConflict, map[string]any{"error": "link_orphaned"})
		return
	}
	if existing, ok := f.linked[body.ExternalID]; ok {
		writeJSON(w, http.StatusOK, map[string]any{
			"transactionGuid": existing.GUID,
			"enterDate":       existing.EnterDate.Format(time.RFC3339Nano),
			"externalId":      body.ExternalID,
			"alreadyLinked":   true,
		})
		return
	}
	txn := &folioTxn{GUID: f.nextGUID(), EnterDate: f.tick(), Body: body}
	f.linked[body.ExternalID] = txn
	f.record(changeFor(body.ExternalID, txn))
	writeJSON(w, http.StatusCreated, map[string]any{
		"transactionGuid": txn.GUID,
		"enterDate":       txn.EnterDate.Format(time.RFC3339Nano),
		"externalId":      body.ExternalID,
	})
}

func (f *folioFake) update(w http.ResponseWriter, r *http.Request, externalID string) {
	f.puts++
	var body gnucashsync.Transaction
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "bad_body"})
		return
	}
	if !f.checkBalance(w, body) {
		return
	}
	txn, ok := f.linked[externalID]
	if !ok {
		writeJSON(w, http.StatusNotFound, map[string]any{"error": "not_linked"})
		return
	}
	if txn.Reconciled {
		writeJSON(w, http.StatusConflict, map[string]any{"error": "reconciled"})
		return
	}
	txn.Body = body
	txn.EnterDate = f.tick()
	f.record(changeFor(externalID, txn))
	writeJSON(w, http.StatusOK, map[string]any{
		"transactionGuid": txn.GUID,
		"enterDate":       txn.EnterDate.Format(time.RFC3339Nano),
	})
}

func (f *folioFake) remove(w http.ResponseWriter, externalID string) {
	f.deletes++
	if f.orphaned[externalID] {
		delete(f.orphaned, externalID)
		writeJSON(w, http.StatusOK, map[string]any{"deleted": true})
		return
	}
	txn, ok := f.linked[externalID]
	if !ok {
		writeJSON(w, http.StatusNotFound, map[string]any{"error": "not_linked"})
		return
	}
	if txn.Reconciled {
		writeJSON(w, http.StatusConflict, map[string]any{"error": "reconciled"})
		return
	}
	delete(f.linked, externalID)
	id := externalID
	f.record(gnucashsync.Change{ExternalID: &id, Deleted: true})
	writeJSON(w, http.StatusOK, map[string]any{"deleted": true})
}

func (f *folioFake) changesPage(w http.ResponseWriter, r *http.Request) {
	f.changeCalls++
	if f.stuckCursor != "" {
		next := ""
		if f.stuckCursor == "repeat" {
			next = r.URL.Query().Get("since")
		}
		writeJSON(w, http.StatusOK, map[string]any{
			"items": []gnucashsync.Change{}, "nextCursor": next, "hasMore": true,
		})
		return
	}
	start := 0
	if since := r.URL.Query().Get("since"); since != "" {
		parsed, err := strconv.Atoi(since)
		if err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]any{"error": "bad_cursor"})
			return
		}
		start = parsed
	}
	limit := f.pageLimit
	if raw := r.URL.Query().Get("limit"); raw != "" {
		if parsed, err := strconv.Atoi(raw); err == nil && parsed < limit {
			limit = parsed
		}
	}
	end := start + limit
	if end > len(f.changes) {
		end = len(f.changes)
	}
	if start > len(f.changes) {
		start = len(f.changes)
	}
	items := append([]gnucashsync.Change{}, f.changes[start:end]...)
	writeJSON(w, http.StatusOK, map[string]any{
		"items":      items,
		"nextCursor": strconv.Itoa(end),
		"hasMore":    end < len(f.changes),
	})
}

// externalEdit simulates a human editing the transaction inside GnuCash.
func (f *folioFake) externalEdit(externalID, description string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	txn, ok := f.linked[externalID]
	if !ok {
		return
	}
	txn.Body.Description = description
	txn.EnterDate = f.tick()
	f.record(changeFor(externalID, txn))
}

// externalDelete simulates a human deleting the transaction in GnuCash while
// the link row survives.
func (f *folioFake) externalDelete(externalID string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	delete(f.linked, externalID)
	f.orphaned[externalID] = true
	id := externalID
	f.record(gnucashsync.Change{ExternalID: &id, Deleted: true})
}

func (f *folioFake) freeze(externalID string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if txn, ok := f.linked[externalID]; ok {
		txn.Reconciled = true
	}
}

// nativeActivity records a folio-side transaction beez knows nothing about.
func (f *folioFake) nativeActivity() {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.changes = append(f.changes, gnucashsync.Change{
		TransactionGUID: f.nextGUID(),
		ExternalID:      nil,
		PostDate:        "2026-08-19",
		EnterDate:       f.tick().Format(time.RFC3339Nano),
		Description:     "Bank fee entered in GnuCash",
	})
}

// unrepresentable records an item folio cannot express in this contract.
func (f *folioFake) unrepresentable(externalID string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	id := externalID
	f.changes = append(f.changes, gnucashsync.Change{
		TransactionGUID: f.nextGUID(),
		ExternalID:      &id,
		EnterDate:       f.tick().Format(time.RFC3339Nano),
		Unrepresentable: true,
	})
}

func (f *folioFake) changeCallCount() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.changeCalls
}

func (f *folioFake) counts() (posts, puts, deletes int) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.posts, f.puts, f.deletes
}

func (f *folioFake) bodyFor(t *testing.T, externalID string) gnucashsync.Transaction {
	t.Helper()
	f.mu.Lock()
	defer f.mu.Unlock()
	txn, ok := f.linked[externalID]
	if !ok {
		t.Fatalf("no folio transaction linked to %q", externalID)
	}
	return txn.Body
}

// --- fixtures ---------------------------------------------------------------

func gnucashTestServer(t *testing.T, fake *folioFake, mapping gnucashsync.AccountMapping) *Server {
	t.Helper()
	server := honeyTestServer(t)
	if _, err := server.pool.Exec(context.Background(),
		`DELETE FROM gnucash_sync_settings`); err != nil {
		t.Fatalf("reset gnucash settings: %v", err)
	}
	// The book identity is what POST /test caches; sync refuses to run
	// without it, so every fixture starts from a tested connection.
	if err := saveGnuCashSettings(context.Background(), server.pool, gnucashSettings{
		BaseURL:      fake.server.URL,
		Token:        "gcw_test",
		BookGUID:     "book-1",
		BookName:     "Yard Books",
		RootCurrency: "USD",
		SyncEnabled:  true,
		Mapping:      mapping,
	}); err != nil {
		t.Fatalf("save gnucash settings: %v", err)
	}
	return server
}

func fullMapping() gnucashsync.AccountMapping {
	return gnucashsync.AccountMapping{
		Revenue: map[string]string{
			"jar": "acct-revenue-jar", "colony": "acct-revenue-colony",
			"equipment": "acct-revenue-equipment",
		},
		Expenses: map[string]string{
			"feed": "acct-expense-feed", "other": "acct-expense-other",
			"treatments": "acct-expense-treatments",
		},
		Cash:               "acct-cash",
		AccountsReceivable: "acct-ar",
		SalesTax:           "acct-tax",
		Discount:           "acct-discount",
	}
}

// seedAppliedSale writes a physically-applied sale straight to the tables so
// the test controls every cent, without going through the sale handler.
func seedAppliedSale(
	t *testing.T, server *Server, jarSizeID uuid.UUID, quantity int, unitPriceCents int64,
) uuid.UUID {
	t.Helper()
	ctx := context.Background()
	saleID := uuid.New()
	total := int64(quantity) * unitPriceCents
	if _, err := server.pool.Exec(ctx, `
		INSERT INTO sales (id, date, customer_name, order_number, channel, payment_method,
			total_amount_cents, amount_paid_cents, order_status, physical_applied_at)
		VALUES ($1, now(), 'Corner Market', $2, 'direct', 'cash', $3, $3, 'paid', now())`,
		saleID, "BT-"+saleID.String()[:8], total); err != nil {
		t.Fatalf("seed sale: %v", err)
	}
	if _, err := server.pool.Exec(ctx, `
		INSERT INTO sale_items (sale_id, kind, jar_size_id, quantity, unit_price_cents)
		VALUES ($1, 'jar', $2, $3, $4)`,
		saleID, jarSizeID, quantity, unitPriceCents); err != nil {
		t.Fatalf("seed sale item: %v", err)
	}
	return saleID
}

// repriceSale changes a sale the way the sale handler would: the line price
// and the sale totals move together, so the entry still balances and the push
// has real work to do.
func repriceSale(t *testing.T, server *Server, saleID uuid.UUID, unitPriceCents int64) {
	t.Helper()
	ctx := context.Background()
	if _, err := server.pool.Exec(ctx, `
		UPDATE sale_items SET unit_price_cents = $2 WHERE sale_id = $1`,
		saleID, unitPriceCents); err != nil {
		t.Fatalf("edit sale item: %v", err)
	}
	if _, err := server.pool.Exec(ctx, `
		UPDATE sales SET total_amount_cents = line.total, amount_paid_cents = line.total
		FROM (SELECT COALESCE(sum(quantity * unit_price_cents), 0) AS total
			FROM sale_items WHERE sale_id = $1) line
		WHERE sales.id = $1`, saleID); err != nil {
		t.Fatalf("edit sale: %v", err)
	}
}

func seedExpense(t *testing.T, server *Server, category string, amountCents int64) uuid.UUID {
	t.Helper()
	expenseID := uuid.New()
	if _, err := server.pool.Exec(context.Background(), `
		INSERT INTO expenses (id, expense_date, category, description, amount_cents, vendor)
		VALUES ($1, current_date, $2, 'Sugar', $3, 'Feed Store')`,
		expenseID, category, amountCents); err != nil {
		t.Fatalf("seed expense: %v", err)
	}
	return expenseID
}

func runSync(t *testing.T, server *Server) map[string]any {
	t.Helper()
	response, body := call(t, server.handleGnuCashSyncNow,
		adminRequest(http.MethodPost, "/api/v1/settings/gnucash/sync", nil))
	if response.Code != http.StatusOK {
		t.Fatalf("sync now: %d %v", response.Code, body)
	}
	if errs, ok := body["errors"].([]any); ok && len(errs) > 0 {
		t.Fatalf("sync reported errors: %v", errs)
	}
	return body
}

// syncExpectingErrors runs one sync and returns the report without failing on
// report.errors, which is what the failure paths are about.
func syncExpectingErrors(t *testing.T, server *Server) map[string]any {
	t.Helper()
	response, body := call(t, server.handleGnuCashSyncNow,
		adminRequest(http.MethodPost, "/api/v1/settings/gnucash/sync", nil))
	if response.Code != http.StatusOK {
		t.Fatalf("sync now: %d %v", response.Code, body)
	}
	errs, _ := body["errors"].([]any)
	if len(errs) == 0 {
		t.Fatalf("sync reported no errors: %v", body)
	}
	return body
}

type syncRowState struct {
	ID            uuid.UUID
	ExternalID    string
	SyncState     string
	ConflictState string
	LastError     string
	ContentHash   string
}

func syncRowFor(t *testing.T, server *Server, entityType string, entityID uuid.UUID) syncRowState {
	t.Helper()
	var (
		row                                 syncRowState
		externalID, conflict, lastErr, hash *string
	)
	err := server.pool.QueryRow(context.Background(), `
		SELECT id, external_id, sync_state, conflict_state, last_error, content_hash
		FROM external_sync
		WHERE system = $1 AND entity_type = $2 AND entity_id = $3`,
		SyncSystemGnuCashWeb, entityType, entityID).
		Scan(&row.ID, &externalID, &row.SyncState, &conflict, &lastErr, &hash)
	if err != nil {
		t.Fatalf("load sync row for %s %s: %v", entityType, entityID, err)
	}
	row.ExternalID = derefString(externalID)
	row.ConflictState = derefString(conflict)
	row.LastError = derefString(lastErr)
	row.ContentHash = derefString(hash)
	return row
}

func storedCursor(t *testing.T, server *Server) string {
	t.Helper()
	settings, err := loadGnuCashSettings(context.Background(), server.pool)
	if err != nil {
		t.Fatalf("load settings: %v", err)
	}
	return settings.ChangesCursor
}

// --- tests ------------------------------------------------------------------

func TestGnuCashSyncPushesSalesAndExpenses(t *testing.T) {
	fake := newFolioFake(t)
	server := gnucashTestServer(t, fake, fullMapping())
	jarSizeID := seedJarSize(t, server, "Pint", 16, 1200)
	saleID := seedAppliedSale(t, server, jarSizeID, 2, 1200)
	expenseID := seedExpense(t, server, "feed", 4599)

	report := runSync(t, server)
	if report["created"] != float64(2) {
		t.Fatalf("created %v, want 2 (report %v)", report["created"], report)
	}

	saleRow := syncRowFor(t, server, SyncEntitySale, saleID)
	if saleRow.SyncState != "synced" || saleRow.ExternalID != "sale:"+saleID.String() {
		t.Fatalf("sale row %+v", saleRow)
	}
	expenseRow := syncRowFor(t, server, SyncEntityExpense, expenseID)
	if expenseRow.SyncState != "synced" || expenseRow.ExternalID != "expense:"+expenseID.String() {
		t.Fatalf("expense row %+v", expenseRow)
	}

	saleTxn := fake.bodyFor(t, saleRow.ExternalID)
	if saleTxn.Sum() != 0 {
		t.Fatalf("pushed sale is unbalanced: %+v", saleTxn.Splits)
	}
	if len(fake.unbalanced) != 0 {
		t.Fatalf("folio rejected %d unbalanced bodies", len(fake.unbalanced))
	}
	var cash, revenue int64
	for _, split := range saleTxn.Splits {
		switch split.AccountGUID {
		case "acct-cash":
			cash = split.AmountCents
		case "acct-revenue-jar":
			revenue = split.AmountCents
		}
	}
	if cash != 2400 || revenue != -2400 {
		t.Fatalf("cash %d revenue %d, want 2400 / -2400", cash, revenue)
	}
}

func TestGnuCashSyncIsIdempotentAndFollowsLocalEdits(t *testing.T) {
	fake := newFolioFake(t)
	server := gnucashTestServer(t, fake, fullMapping())
	jarSizeID := seedJarSize(t, server, "Pint", 16, 1200)
	saleID := seedAppliedSale(t, server, jarSizeID, 2, 1200)

	runSync(t, server)
	posts, puts, _ := fake.counts()
	if posts != 1 || puts != 0 {
		t.Fatalf("first run: %d posts, %d puts", posts, puts)
	}
	firstHash := syncRowFor(t, server, SyncEntitySale, saleID).ContentHash

	// Nothing changed: the second run must not touch folio at all.
	report := runSync(t, server)
	posts, puts, _ = fake.counts()
	if posts != 1 || puts != 0 {
		t.Fatalf("re-push: %d posts, %d puts", posts, puts)
	}
	if report["skipped"] != float64(1) {
		t.Fatalf("skipped %v, want 1", report["skipped"])
	}

	// A local price correction must reach folio as an update, not a duplicate.
	if _, err := server.pool.Exec(context.Background(), `
		UPDATE sale_items SET unit_price_cents = 1300 WHERE sale_id = $1`, saleID); err != nil {
		t.Fatalf("edit sale item: %v", err)
	}
	if _, err := server.pool.Exec(context.Background(), `
		UPDATE sales SET total_amount_cents = 2600, amount_paid_cents = 2600 WHERE id = $1`,
		saleID); err != nil {
		t.Fatalf("edit sale: %v", err)
	}
	report = runSync(t, server)
	posts, puts, _ = fake.counts()
	if posts != 1 || puts != 1 {
		t.Fatalf("after local edit: %d posts, %d puts", posts, puts)
	}
	if report["updated"] != float64(1) {
		t.Fatalf("updated %v, want 1", report["updated"])
	}
	row := syncRowFor(t, server, SyncEntitySale, saleID)
	if row.ContentHash == firstHash {
		t.Fatal("the content hash must move with the local edit")
	}
	if row.SyncState != "synced" || row.ConflictState != "" {
		t.Fatalf("row after update %+v", row)
	}
	if fake.bodyFor(t, row.ExternalID).Sum() != 0 {
		t.Fatal("updated transaction is unbalanced")
	}
}

func TestGnuCashSyncFailsLoudlyOnAnUnmappedKind(t *testing.T) {
	fake := newFolioFake(t)
	mapping := fullMapping()
	delete(mapping.Revenue, "jar")
	server := gnucashTestServer(t, fake, mapping)
	jarSizeID := seedJarSize(t, server, "Pint", 16, 1200)
	saleID := seedAppliedSale(t, server, jarSizeID, 1, 1200)
	seedExpense(t, server, "feed", 100)

	report := runSync(t, server)
	if report["failed"] != float64(1) {
		t.Fatalf("failed %v, want 1", report["failed"])
	}
	row := syncRowFor(t, server, SyncEntitySale, saleID)
	if row.SyncState != "failed" {
		t.Fatalf("sync state %q", row.SyncState)
	}
	if !strings.Contains(row.LastError, "jar") {
		t.Fatalf("last error %q does not name the missing mapping", row.LastError)
	}
	if posts, _, _ := fake.counts(); posts != 1 {
		t.Fatalf("%d posts: only the expense should have been pushed", posts)
	}
}

func TestGnuCashSyncRecoversFromAnOrphanedLink(t *testing.T) {
	fake := newFolioFake(t)
	server := gnucashTestServer(t, fake, fullMapping())
	jarSizeID := seedJarSize(t, server, "Pint", 16, 1200)
	saleID := seedAppliedSale(t, server, jarSizeID, 1, 1200)
	runSync(t, server)
	externalID := syncRowFor(t, server, SyncEntitySale, saleID).ExternalID

	// The transaction is deleted in folio but the link row survives. The pull
	// surfaces that as a conflict; the operator answers "push local again",
	// which is where the orphaned link has to be recovered from.
	fake.externalDelete(externalID)
	runSync(t, server)
	row := syncRowFor(t, server, SyncEntitySale, saleID)
	if row.ConflictState == "" {
		t.Fatalf("a remote deletion must surface as a conflict: %+v", row)
	}

	response, body := call(t, server.handleGnuCashRowPush,
		adminRequest(http.MethodPost, "/api/v1/settings/gnucash/rows/x/push", nil,
			"id", row.ID.String()))
	if response.Code != http.StatusOK {
		t.Fatalf("push local again: %d %v", response.Code, body)
	}
	row = syncRowFor(t, server, SyncEntitySale, saleID)
	if row.SyncState != "synced" || row.ConflictState != "" {
		t.Fatalf("row after orphan recovery %+v", row)
	}
	if _, _, deletes := fake.counts(); deletes == 0 {
		t.Fatal("an orphaned link must be acknowledged with DELETE")
	}
	if fake.bodyFor(t, externalID).Sum() != 0 {
		t.Fatal("recreated transaction is unbalanced")
	}
}

func TestGnuCashSyncSurfacesAReconciledTransactionAsAConflict(t *testing.T) {
	fake := newFolioFake(t)
	server := gnucashTestServer(t, fake, fullMapping())
	jarSizeID := seedJarSize(t, server, "Pint", 16, 1200)
	saleID := seedAppliedSale(t, server, jarSizeID, 1, 1200)
	runSync(t, server)
	externalID := syncRowFor(t, server, SyncEntitySale, saleID).ExternalID

	fake.freeze(externalID)
	if _, err := server.pool.Exec(context.Background(), `
		UPDATE sales SET total_amount_cents = 1500, amount_paid_cents = 1500 WHERE id = $1`,
		saleID); err != nil {
		t.Fatalf("edit sale: %v", err)
	}
	if _, err := server.pool.Exec(context.Background(), `
		UPDATE sale_items SET unit_price_cents = 1500 WHERE sale_id = $1`, saleID); err != nil {
		t.Fatalf("edit sale item: %v", err)
	}

	runSync(t, server)
	row := syncRowFor(t, server, SyncEntitySale, saleID)
	if row.ConflictState != "diverged" {
		t.Fatalf("conflict state %q, want diverged", row.ConflictState)
	}
	if !strings.Contains(strings.ToLower(row.LastError), "reconciled") {
		t.Fatalf("last error %q", row.LastError)
	}
}

func TestGnuCashSyncRetiresACancelledSale(t *testing.T) {
	fake := newFolioFake(t)
	server := gnucashTestServer(t, fake, fullMapping())
	jarSizeID := seedJarSize(t, server, "Pint", 16, 1200)
	saleID := seedAppliedSale(t, server, jarSizeID, 1, 1200)
	expenseID := seedExpense(t, server, "feed", 500)
	runSync(t, server)
	saleExternalID := syncRowFor(t, server, SyncEntitySale, saleID).ExternalID

	ctx := context.Background()
	if _, err := server.pool.Exec(ctx, `
		UPDATE sales SET order_status = 'cancelled', cancelled_at = now(),
			physical_applied_at = NULL WHERE id = $1`, saleID); err != nil {
		t.Fatalf("cancel sale: %v", err)
	}
	if _, err := server.pool.Exec(ctx, `
		UPDATE expenses SET deleted_at = now() WHERE id = $1`, expenseID); err != nil {
		t.Fatalf("delete expense: %v", err)
	}

	report := runSync(t, server)
	if report["retired"] != float64(2) {
		t.Fatalf("retired %v, want 2", report["retired"])
	}
	row := syncRowFor(t, server, SyncEntitySale, saleID)
	if row.SyncState != "ignored" || row.ExternalID != "" {
		t.Fatalf("cancelled sale row %+v", row)
	}
	fake.mu.Lock()
	_, stillLinked := fake.linked[saleExternalID]
	fake.mu.Unlock()
	if stillLinked {
		t.Fatal("a cancelled sale must be removed from the books")
	}

	// And it must not come back on the next scan.
	report = runSync(t, server)
	if report["created"] != float64(0) {
		t.Fatalf("a retired sale was recreated: %v", report)
	}
}

func TestGnuCashPullFlagsRemoteEditsAndTombstones(t *testing.T) {
	fake := newFolioFake(t)
	server := gnucashTestServer(t, fake, fullMapping())
	jarSizeID := seedJarSize(t, server, "Pint", 16, 1200)
	editedID := seedAppliedSale(t, server, jarSizeID, 1, 1200)
	deletedID := seedAppliedSale(t, server, jarSizeID, 2, 1200)
	runSync(t, server)

	// Our own writes echo back through the change feed and must not be
	// mistaken for someone else's edit.
	editedRow := syncRowFor(t, server, SyncEntitySale, editedID)
	if editedRow.ConflictState != "" {
		t.Fatalf("self-echo flagged a conflict: %+v", editedRow)
	}

	deletedRow := syncRowFor(t, server, SyncEntitySale, deletedID)
	fake.externalEdit(editedRow.ExternalID, "Edited by the bookkeeper")
	fake.externalDelete(deletedRow.ExternalID)
	fake.nativeActivity()

	report := runSync(t, server)
	if report["conflicts"] != float64(2) {
		t.Fatalf("conflicts %v, want 2 (report %v)", report["conflicts"], report)
	}
	editedRow = syncRowFor(t, server, SyncEntitySale, editedID)
	if editedRow.ConflictState != "remote_newer" {
		t.Fatalf("edited row %+v", editedRow)
	}
	deletedRow = syncRowFor(t, server, SyncEntitySale, deletedID)
	if deletedRow.ConflictState != "remote_newer" ||
		!strings.Contains(deletedRow.LastError, "Deleted in GnuCash") {
		t.Fatalf("deleted row %+v", deletedRow)
	}

	// A conflicted row is not auto-pushed: the operator decides.
	posts, puts, _ := fake.counts()
	runSync(t, server)
	postsAfter, putsAfter, _ := fake.counts()
	if postsAfter != posts || putsAfter != puts {
		t.Fatalf("a conflicted row was pushed anyway (%d/%d -> %d/%d)",
			posts, puts, postsAfter, putsAfter)
	}
}

func TestGnuCashPullFlagsUnrepresentableItems(t *testing.T) {
	fake := newFolioFake(t)
	server := gnucashTestServer(t, fake, fullMapping())
	jarSizeID := seedJarSize(t, server, "Pint", 16, 1200)
	saleID := seedAppliedSale(t, server, jarSizeID, 1, 1200)
	runSync(t, server)

	fake.unrepresentable(syncRowFor(t, server, SyncEntitySale, saleID).ExternalID)
	runSync(t, server)
	row := syncRowFor(t, server, SyncEntitySale, saleID)
	if row.ConflictState != "remote_newer" || !strings.Contains(row.LastError, "cannot represent") {
		t.Fatalf("unrepresentable row %+v", row)
	}
}

func TestGnuCashPullPersistsTheCursorAcrossPages(t *testing.T) {
	fake := newFolioFake(t)
	fake.pageLimit = 1 // force one item per page
	server := gnucashTestServer(t, fake, fullMapping())
	jarSizeID := seedJarSize(t, server, "Pint", 16, 1200)
	seedAppliedSale(t, server, jarSizeID, 1, 1200)
	seedAppliedSale(t, server, jarSizeID, 2, 1200)
	seedExpense(t, server, "feed", 700)

	// The first run pulls an empty feed (nothing has been pushed yet) and
	// then creates the three transactions.
	report := runSync(t, server)
	if report["pulledItems"] != float64(0) {
		t.Fatalf("pulled %v items before anything was pushed", report["pulledItems"])
	}

	// The second run drains the three echoes, one page at a time.
	report = runSync(t, server)
	if report["pulledItems"] != float64(3) {
		t.Fatalf("pulled %v items, want 3", report["pulledItems"])
	}
	cursor := storedCursor(t, server)
	if cursor != "3" {
		t.Fatalf("stored cursor %q, want 3", cursor)
	}

	// A third run starts where the second stopped and re-reads nothing.
	report = runSync(t, server)
	if report["pulledItems"] != float64(0) {
		t.Fatalf("re-pulled %v items; the cursor was not honoured", report["pulledItems"])
	}
	fake.nativeActivity()
	report = runSync(t, server)
	if report["pulledItems"] != float64(1) {
		t.Fatalf("pulled %v items after new activity, want 1", report["pulledItems"])
	}
	if storedCursor(t, server) != "4" {
		t.Fatalf("cursor %q, want 4", storedCursor(t, server))
	}
}

func TestGnuCashConflictActionsPushAgainAndIgnore(t *testing.T) {
	fake := newFolioFake(t)
	server := gnucashTestServer(t, fake, fullMapping())
	jarSizeID := seedJarSize(t, server, "Pint", 16, 1200)
	pushAgainID := seedAppliedSale(t, server, jarSizeID, 1, 1200)
	ignoreID := seedAppliedSale(t, server, jarSizeID, 3, 1200)
	runSync(t, server)

	pushRow := syncRowFor(t, server, SyncEntitySale, pushAgainID)
	ignoreRow := syncRowFor(t, server, SyncEntitySale, ignoreID)
	fake.externalEdit(pushRow.ExternalID, "Bookkeeper edit")
	fake.externalEdit(ignoreRow.ExternalID, "Bookkeeper edit")
	runSync(t, server)

	// The reconciliation list must show both.
	response, body := call(t, server.handleGnuCashRows,
		adminRequest(http.MethodGet, "/api/v1/settings/gnucash/rows", nil))
	if response.Code != http.StatusOK {
		t.Fatalf("rows: %d %v", response.Code, body)
	}
	conflicts, _ := body["conflicts"].([]any)
	if len(conflicts) != 2 {
		t.Fatalf("conflict list has %d rows, want 2", len(conflicts))
	}

	pushRow = syncRowFor(t, server, SyncEntitySale, pushAgainID)
	response, body = call(t, server.handleGnuCashRowPush,
		adminRequest(http.MethodPost, "/api/v1/settings/gnucash/rows/x/push", nil,
			"id", pushRow.ID.String()))
	if response.Code != http.StatusOK {
		t.Fatalf("push again: %d %v", response.Code, body)
	}
	pushRow = syncRowFor(t, server, SyncEntitySale, pushAgainID)
	if pushRow.ConflictState != "" || pushRow.SyncState != "synced" {
		t.Fatalf("row after push again %+v", pushRow)
	}
	if got := fake.bodyFor(t, pushRow.ExternalID).Description; strings.Contains(got, "Bookkeeper") {
		t.Fatalf("the beez version did not overwrite folio: %q", got)
	}

	ignoreRow = syncRowFor(t, server, SyncEntitySale, ignoreID)
	response, body = call(t, server.handleGnuCashRowIgnore,
		adminRequest(http.MethodPost, "/api/v1/settings/gnucash/rows/x/ignore", nil,
			"id", ignoreRow.ID.String()))
	if response.Code != http.StatusOK {
		t.Fatalf("ignore: %d %v", response.Code, body)
	}
	ignoreRow = syncRowFor(t, server, SyncEntitySale, ignoreID)
	if ignoreRow.SyncState != "ignored" || ignoreRow.ConflictState != "none" {
		t.Fatalf("row after ignore %+v", ignoreRow)
	}
}

func TestGnuCashSettingsMaskTheTokenAndTestCachesTheBook(t *testing.T) {
	fake := newFolioFake(t)
	server := gnucashTestServer(t, fake, fullMapping())

	response, body := call(t, server.handleGnuCashTest,
		adminRequest(http.MethodPost, "/api/v1/settings/gnucash/test", nil))
	if response.Code != http.StatusOK || body["success"] != true {
		t.Fatalf("test connection: %d %v", response.Code, body)
	}
	if body["bookName"] != "Yard Books" {
		t.Fatalf("book name %v", body["bookName"])
	}

	response, body = call(t, server.handleGnuCashSettings,
		adminRequest(http.MethodGet, "/api/v1/settings/gnucash", nil))
	if response.Code != http.StatusOK {
		t.Fatalf("settings: %d %v", response.Code, body)
	}
	if body["hasToken"] != true {
		t.Fatal("hasToken must report the stored token")
	}
	if strings.Contains(response.Body.String(), "gcw_test") {
		t.Fatal("the API token must never be returned")
	}
	if body["bookGuid"] != "book-1" {
		t.Fatalf("book guid %v was not cached", body["bookGuid"])
	}
}

// Changing the server invalidates a cursor that belongs to another book.
func TestGnuCashSettingsPutClearsTheCursorOnANewServer(t *testing.T) {
	fake := newFolioFake(t)
	server := gnucashTestServer(t, fake, fullMapping())
	if err := saveGnuCashCursor(context.Background(), server.pool, "42"); err != nil {
		t.Fatalf("save cursor: %v", err)
	}

	response, body := call(t, server.handleGnuCashSettingsPut,
		adminRequest(http.MethodPut, "/api/v1/settings/gnucash", map[string]any{
			"baseUrl": "https://other.example.com",
		}))
	if response.Code != http.StatusOK {
		t.Fatalf("put settings: %d %v", response.Code, body)
	}
	if cursor := storedCursor(t, server); cursor != "" {
		t.Fatalf("cursor %q survived a server change", cursor)
	}

	response, body = call(t, server.handleGnuCashSettingsPut,
		adminRequest(http.MethodPut, "/api/v1/settings/gnucash", map[string]any{
			"baseUrl": "not-a-url",
		}))
	if response.Code != http.StatusBadRequest {
		t.Fatalf("a bad base URL returned %d %v", response.Code, body)
	}
}

// The push must never run against a change feed beez has not read yet: a
// local edit would silently overwrite the bookkeeper's.
func TestGnuCashSyncPullsBeforePushingSoARemoteEditIsNotOverwritten(t *testing.T) {
	fake := newFolioFake(t)
	server := gnucashTestServer(t, fake, fullMapping())
	jarSizeID := seedJarSize(t, server, "Pint", 16, 1200)
	editedID := seedAppliedSale(t, server, jarSizeID, 2, 1200)
	deletedID := seedAppliedSale(t, server, jarSizeID, 3, 1200)
	runSync(t, server)

	editedRow := syncRowFor(t, server, SyncEntitySale, editedID)
	deletedRow := syncRowFor(t, server, SyncEntitySale, deletedID)
	postsBefore, putsBefore, deletesBefore := fake.counts()

	// Both are edited locally, so the push wants to write both...
	for _, id := range []uuid.UUID{editedID, deletedID} {
		repriceSale(t, server, id, 1900)
	}
	// ...while the bookkeeper has already touched both in GnuCash, and beez
	// has not consumed either change yet.
	fake.externalEdit(editedRow.ExternalID, "Recategorised by the bookkeeper")
	fake.externalDelete(deletedRow.ExternalID)

	report := runSync(t, server)
	if report["conflicts"] != float64(2) {
		t.Fatalf("conflicts %v, want 2 (report %v)", report["conflicts"], report)
	}
	posts, puts, deletes := fake.counts()
	if posts != postsBefore || puts != putsBefore || deletes != deletesBefore {
		t.Fatalf("an unseen remote change was overwritten (%d/%d/%d -> %d/%d/%d)",
			postsBefore, putsBefore, deletesBefore, posts, puts, deletes)
	}

	editedRow = syncRowFor(t, server, SyncEntitySale, editedID)
	if editedRow.ConflictState == "" || editedRow.ConflictState == "none" {
		t.Fatalf("locally edited row was pushed over a remote edit: %+v", editedRow)
	}
	deletedRow = syncRowFor(t, server, SyncEntitySale, deletedID)
	if deletedRow.ConflictState == "" || deletedRow.ConflictState == "none" ||
		!strings.Contains(deletedRow.LastError, "Deleted in GnuCash") {
		t.Fatalf("locally edited row was pushed over a remote deletion: %+v", deletedRow)
	}

	// The bookkeeper's version is still what GnuCash holds.
	if got := fake.bodyFor(t, editedRow.ExternalID).Description; !strings.Contains(got, "bookkeeper") {
		t.Fatalf("GnuCash description %q — the local edit was pushed over it", got)
	}

	// Both are on the reconciliation list, where the operator can override.
	response, body := call(t, server.handleGnuCashRows,
		adminRequest(http.MethodGet, "/api/v1/settings/gnucash/rows", nil))
	if response.Code != http.StatusOK {
		t.Fatalf("rows: %d %v", response.Code, body)
	}
	if conflicts, _ := body["conflicts"].([]any); len(conflicts) != 2 {
		t.Fatalf("conflict list has %d rows, want 2", len(conflicts))
	}
}

// A 502 is retryable, but it is still a failure: it has to reach the operator
// instead of being reported as a clean run.
func TestGnuCashPushReportsRetryableFailures(t *testing.T) {
	fake := newFolioFake(t)
	server := gnucashTestServer(t, fake, fullMapping())
	jarSizeID := seedJarSize(t, server, "Pint", 16, 1200)
	saleID := seedAppliedSale(t, server, jarSizeID, 1, 1200)

	fake.mu.Lock()
	fake.writesFail = true
	fake.mu.Unlock()

	report := syncExpectingErrors(t, server)
	if report["failed"] != float64(1) {
		t.Fatalf("failed %v, want 1 (report %v)", report["failed"], report)
	}
	if report["created"] != float64(0) {
		t.Fatalf("created %v after a 502", report["created"])
	}

	// The row stays pending so the next run retries, but it carries the error.
	row := syncRowFor(t, server, SyncEntitySale, saleID)
	if row.SyncState != "pending" {
		t.Fatalf("sync state %q, want pending", row.SyncState)
	}
	if row.LastError == "" {
		t.Fatalf("row %+v has no last_error", row)
	}

	// And it is visible on the reconciliation list rather than hidden.
	response, body := call(t, server.handleGnuCashRows,
		adminRequest(http.MethodGet, "/api/v1/settings/gnucash/rows", nil))
	if response.Code != http.StatusOK {
		t.Fatalf("rows: %d %v", response.Code, body)
	}
	failures, _ := body["failures"].([]any)
	if len(failures) != 1 {
		t.Fatalf("failure list has %d rows, want 1 (%v)", len(failures), body)
	}

	// The manual override must not claim success either.
	response, body = call(t, server.handleGnuCashRowPush,
		adminRequest(http.MethodPost, "/api/v1/settings/gnucash/rows/x/push", nil,
			"id", row.ID.String()))
	if response.Code == http.StatusOK {
		t.Fatalf("manual push returned 200 on a 502: %v", body)
	}

	// Once folio is back, the retry succeeds and the error clears.
	fake.mu.Lock()
	fake.writesFail = false
	fake.mu.Unlock()
	runSync(t, server)
	row = syncRowFor(t, server, SyncEntitySale, saleID)
	if row.SyncState != "synced" || row.LastError != "" {
		t.Fatalf("row after recovery %+v", row)
	}
}

// A change feed that cannot advance must stop the run, not replay a page up
// to the page cap on every sync forever.
func TestGnuCashPullRejectsANonAdvancingCursor(t *testing.T) {
	for _, testCase := range []struct {
		name, mode, cursor, want string
	}{
		{"no cursor at all", "empty", "", "without a nextCursor"},
		{"the same cursor twice", "repeat", "77", "cannot advance"},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			fake := newFolioFake(t)
			server := gnucashTestServer(t, fake, fullMapping())
			jarSizeID := seedJarSize(t, server, "Pint", 16, 1200)
			seedAppliedSale(t, server, jarSizeID, 1, 1200)
			if testCase.cursor != "" {
				if err := saveGnuCashCursor(context.Background(), server.pool,
					testCase.cursor); err != nil {
					t.Fatalf("save cursor: %v", err)
				}
			}
			fake.mu.Lock()
			fake.stuckCursor = testCase.mode
			fake.mu.Unlock()

			report := syncExpectingErrors(t, server)
			errs, _ := report["errors"].([]any)
			joined := ""
			for _, entry := range errs {
				joined += entry.(string)
			}
			if !strings.Contains(joined, testCase.want) {
				t.Fatalf("errors %v do not name the broken cursor (%q)", errs, testCase.want)
			}
			if calls := fake.changeCallCount(); calls != 1 {
				t.Fatalf("%d changes calls: the run replayed the page", calls)
			}
			if got := storedCursor(t, server); got != testCase.cursor {
				t.Fatalf("cursor %q, want %q — a broken page must not move it",
					got, testCase.cursor)
			}
			// A pull that failed must not be followed by a push.
			if posts, _, _ := fake.counts(); posts != 0 {
				t.Fatalf("%d posts after a failed pull", posts)
			}
		})
	}
}

// A new token can open a different book on the same host, so it invalidates
// the cached identity and the cursor exactly like a new base URL does.
// Kept as it was, deliberately: clearing the book and the cursor on a
// credential change is right for ordinary operation. The restore path does
// not weaken it — handleGnuCashRestore installs the cursor only AFTER the
// token is in place and proven against the expected book, and while that
// restore is pending the PUT refuses a credential change instead of
// performing this clear (TestGnuCashSettingsPutCannotWipeAPendingRestore).
// Here sync is enabled, so no restore is pending and the clear stands.
func TestGnuCashSettingsPutClearsTheBookOnATokenChange(t *testing.T) {
	fake := newFolioFake(t)
	server := gnucashTestServer(t, fake, fullMapping())
	if err := saveGnuCashCursor(context.Background(), server.pool, "42"); err != nil {
		t.Fatalf("save cursor: %v", err)
	}

	// Same host, rotated token.
	response, body := call(t, server.handleGnuCashSettingsPut,
		adminRequest(http.MethodPut, "/api/v1/settings/gnucash", map[string]any{
			"baseUrl": fake.server.URL, "apiToken": "gcw_rotated",
		}))
	if response.Code != http.StatusOK {
		t.Fatalf("put settings: %d %v", response.Code, body)
	}
	if cursor := storedCursor(t, server); cursor != "" {
		t.Fatalf("cursor %q survived a token rotation", cursor)
	}
	response, body = call(t, server.handleGnuCashSettings,
		adminRequest(http.MethodGet, "/api/v1/settings/gnucash", nil))
	if response.Code != http.StatusOK || body["bookGuid"] != "" {
		t.Fatalf("book identity %v survived a token rotation", body["bookGuid"])
	}

	// Sync refuses to run until the connection is tested again.
	response, body = call(t, server.handleGnuCashSyncNow,
		adminRequest(http.MethodPost, "/api/v1/settings/gnucash/sync", nil))
	if response.Code != http.StatusBadRequest {
		t.Fatalf("sync ran with an uncached book identity: %d %v", response.Code, body)
	}
	if posts, _, _ := fake.counts(); posts != 0 {
		t.Fatalf("%d posts before the connection was re-tested", posts)
	}

	// Re-testing caches the book again and unblocks the sync.
	if response, body = call(t, server.handleGnuCashTest,
		adminRequest(http.MethodPost, "/api/v1/settings/gnucash/test", nil)); body["success"] != true {
		t.Fatalf("test connection: %d %v", response.Code, body)
	}
	runSync(t, server)

	// An unchanged token is not a rotation and must not reset anything.
	if err := saveGnuCashCursor(context.Background(), server.pool, "9"); err != nil {
		t.Fatalf("save cursor: %v", err)
	}
	response, body = call(t, server.handleGnuCashSettingsPut,
		adminRequest(http.MethodPut, "/api/v1/settings/gnucash", map[string]any{
			"baseUrl": fake.server.URL, "apiToken": "gcw_rotated", "syncEnabled": true,
		}))
	if response.Code != http.StatusOK {
		t.Fatalf("put settings: %d %v", response.Code, body)
	}
	if cursor := storedCursor(t, server); cursor != "9" {
		t.Fatalf("cursor %q was reset by a no-op settings save", cursor)
	}
}

// The page cap can stop a drain with the feed still claiming more. Pushing
// after that would put local rows over remote changes this run never read, so
// the run must skip the push entirely, keep the cursor it reached, and say so.
func TestGnuCashPullCapSkipsThePushUntilTheFeedIsDrained(t *testing.T) {
	fake := newFolioFake(t)
	fake.pageLimit = 1 // one item per page, so the cap bites at 20
	server := gnucashTestServer(t, fake, fullMapping())
	jarSizeID := seedJarSize(t, server, "Pint", 16, 1200)
	saleID := seedAppliedSale(t, server, jarSizeID, 2, 1200)

	// One more page of folio-native activity than a single run can drain.
	for i := 0; i < gnucashMaxPullPages+1; i++ {
		fake.nativeActivity()
	}

	report := syncExpectingErrors(t, server)
	errs, _ := report["errors"].([]any)
	joined := ""
	for _, entry := range errs {
		joined += entry.(string)
	}
	if !strings.Contains(joined, "pull incomplete") {
		t.Fatalf("errors %v do not report the incomplete pull", errs)
	}
	if posts, puts, deletes := fake.counts(); posts != 0 || puts != 0 || deletes != 0 {
		t.Fatalf("%d posts, %d puts, %d deletes over unread remote changes",
			posts, puts, deletes)
	}
	if report["pulledItems"] != float64(gnucashMaxPullPages) {
		t.Fatalf("pulled %v items, want %d", report["pulledItems"], gnucashMaxPullPages)
	}
	// The cursor still advances: the pages that were read are read for good.
	if got, want := storedCursor(t, server), strconv.Itoa(gnucashMaxPullPages); got != want {
		t.Fatalf("cursor %q, want %q", got, want)
	}
	if row := syncRowFor(t, server, SyncEntitySale, saleID); row.SyncState != "pending" {
		t.Fatalf("sale row %+v; the push must simply not have run", row)
	}

	// The second run finishes the feed and only then pushes.
	report = runSync(t, server)
	if report["pulledItems"] != float64(1) {
		t.Fatalf("second run pulled %v items, want 1", report["pulledItems"])
	}
	if report["created"] != float64(1) {
		t.Fatalf("second run created %v, want 1 (report %v)", report["created"], report)
	}
	if row := syncRowFor(t, server, SyncEntitySale, saleID); row.SyncState != "synced" {
		t.Fatalf("sale row after the drain %+v", row)
	}
}

// "Push local again" writes into a book just like the scheduled run, so it
// carries the same prerequisite: a token rotation clears the cached identity
// and nothing may be written until the connection is tested again.
func TestGnuCashRowPushRequiresATestedIdentity(t *testing.T) {
	fake := newFolioFake(t)
	server := gnucashTestServer(t, fake, fullMapping())
	jarSizeID := seedJarSize(t, server, "Pint", 16, 1200)
	saleID := seedAppliedSale(t, server, jarSizeID, 1, 1200)
	runSync(t, server)
	row := syncRowFor(t, server, SyncEntitySale, saleID)
	before, beforePuts, beforeDeletes := fake.counts()

	// Same host, rotated token: handleGnuCashSettingsPut drops the book.
	response, body := call(t, server.handleGnuCashSettingsPut,
		adminRequest(http.MethodPut, "/api/v1/settings/gnucash", map[string]any{
			"baseUrl": fake.server.URL, "apiToken": "gcw_rotated",
		}))
	if response.Code != http.StatusOK {
		t.Fatalf("put settings: %d %v", response.Code, body)
	}

	response, body = call(t, server.handleGnuCashRowPush,
		adminRequest(http.MethodPost, "/api/v1/settings/gnucash/rows/x/push", nil,
			"id", row.ID.String()))
	if response.Code != http.StatusBadRequest {
		t.Fatalf("manual push ran with an uncached book identity: %d %v",
			response.Code, body)
	}
	if message, _ := body["error"].(string); !strings.Contains(message, "Test the connection") {
		t.Fatalf("error %v does not name the missing identity", body)
	}
	if posts, puts, deletes := fake.counts(); posts != before ||
		puts != beforePuts || deletes != beforeDeletes {
		t.Fatalf("folio was written to before the connection was re-tested: "+
			"%d/%d/%d, want %d/%d/%d", posts, puts, deletes, before, beforePuts, beforeDeletes)
	}

	// Re-testing caches the book again and unblocks the same call.
	if response, body = call(t, server.handleGnuCashTest,
		adminRequest(http.MethodPost, "/api/v1/settings/gnucash/test", nil)); body["success"] != true {
		t.Fatalf("test connection: %d %v", response.Code, body)
	}
	response, body = call(t, server.handleGnuCashRowPush,
		adminRequest(http.MethodPost, "/api/v1/settings/gnucash/rows/x/push", nil,
			"id", row.ID.String()))
	if response.Code != http.StatusOK {
		t.Fatalf("push after re-testing: %d %v", response.Code, body)
	}
}

// A retirement is a DELETE, and a 5xx on it is as retryable as one on a
// create. The row must not stay "synced" while a transaction beez has
// disowned is still sitting in the books.
func TestGnuCashRetirementReportsRetryableDeleteFailures(t *testing.T) {
	fake := newFolioFake(t)
	server := gnucashTestServer(t, fake, fullMapping())
	jarSizeID := seedJarSize(t, server, "Pint", 16, 1200)
	saleID := seedAppliedSale(t, server, jarSizeID, 1, 1200)
	runSync(t, server)
	externalID := syncRowFor(t, server, SyncEntitySale, saleID).ExternalID

	if _, err := server.pool.Exec(context.Background(), `
		UPDATE sales SET order_status = 'cancelled', cancelled_at = now(),
			physical_applied_at = NULL WHERE id = $1`, saleID); err != nil {
		t.Fatalf("cancel sale: %v", err)
	}
	fake.mu.Lock()
	fake.writesFail = true
	fake.mu.Unlock()

	report := syncExpectingErrors(t, server)
	if report["failed"] != float64(1) {
		t.Fatalf("failed %v, want 1 (report %v)", report["failed"], report)
	}
	if report["retired"] != float64(0) {
		t.Fatalf("retired %v after a 502 DELETE", report["retired"])
	}

	row := syncRowFor(t, server, SyncEntitySale, saleID)
	if row.SyncState != "pending" {
		t.Fatalf("sync state %q after a 502 DELETE, want pending", row.SyncState)
	}
	if row.LastError == "" {
		t.Fatalf("row %+v has no last_error", row)
	}
	if row.ExternalID != externalID {
		t.Fatalf("row %+v lost the link that still has to be deleted", row)
	}

	// And the operator can see it rather than it looking like a clean sync.
	response, body := call(t, server.handleGnuCashRows,
		adminRequest(http.MethodGet, "/api/v1/settings/gnucash/rows", nil))
	if response.Code != http.StatusOK {
		t.Fatalf("rows: %d %v", response.Code, body)
	}
	failures, _ := body["failures"].([]any)
	if len(failures) != 1 {
		t.Fatalf("failure list has %d rows, want 1 (%v)", len(failures), body)
	}

	// Once folio is back the retirement completes on its own.
	fake.mu.Lock()
	fake.writesFail = false
	fake.mu.Unlock()
	report = runSync(t, server)
	if report["retired"] != float64(1) {
		t.Fatalf("retired %v after recovery, want 1", report["retired"])
	}
	row = syncRowFor(t, server, SyncEntitySale, saleID)
	if row.SyncState != "ignored" || row.LastError != "" || row.ExternalID != "" {
		t.Fatalf("row after recovery %+v", row)
	}
	fake.mu.Lock()
	_, stillLinked := fake.linked[externalID]
	fake.mu.Unlock()
	if stillLinked {
		t.Fatal("the cancelled sale is still in the books")
	}
}

// --- server-enforced sync gate and guarded restore --------------------------

// disableGnuCashSync turns the flag off without going through the PUT, which
// is what the operator does before a restore.
func disableGnuCashSync(t *testing.T, server *Server) {
	t.Helper()
	if _, err := server.pool.Exec(context.Background(),
		`UPDATE gnucash_sync_settings SET sync_enabled = false WHERE id = true`); err != nil {
		t.Fatalf("disable sync: %v", err)
	}
}

func gnucashSettingsOf(t *testing.T, server *Server) gnucashSettings {
	t.Helper()
	settings, err := loadGnuCashSettings(context.Background(), server.pool)
	if err != nil {
		t.Fatalf("load settings: %v", err)
	}
	return settings
}

// restoreRowPayload builds one artifact row for a sale that beez had already
// pushed before the reset.
func restoreRowPayload(rowID, saleID uuid.UUID) map[string]any {
	return map[string]any{
		"id":                    rowID.String(),
		"entityType":            SyncEntitySale,
		"entityId":              saleID.String(),
		"externalId":            "sale:" + saleID.String(),
		"syncState":             "synced",
		"conflictState":         "none",
		"contentHash":           "hash-abc",
		"remoteTransactionGuid": "gc-77",
		"remoteEnterDate":       "2026-08-20T12:05:00Z",
		"lastSyncedAt":          "2026-08-20T12:05:01Z",
		"createdAt":             "2026-07-01T09:00:00Z",
	}
}

func restorePayload(rows ...map[string]any) map[string]any {
	if rows == nil {
		rows = []map[string]any{}
	}
	return map[string]any{
		"expectedBookGuid":     "book-1",
		"expectedRootCurrency": "USD",
		"changesCursor":        "cursor-42",
		"lastSyncAttemptAt":    "2026-08-31T23:59:00Z",
		"rows":                 rows,
	}
}

func postRestore(t *testing.T, server *Server, payload map[string]any) (int, map[string]any) {
	t.Helper()
	response, body := call(t, server.handleGnuCashRestore,
		adminRequest(http.MethodPost, "/api/v1/settings/gnucash/restore", payload))
	return response.Code, body
}

// Until now sync_enabled was decoration: handleGnuCashSyncNow never read it
// and the browser gated the button on nothing but a pending request. The
// restore flow depends on it meaning something, so the refusal is server-side
// on every write-capable endpoint.
func TestGnuCashSyncRefusesWhileSyncIsDisabled(t *testing.T) {
	fake := newFolioFake(t)
	server := gnucashTestServer(t, fake, fullMapping())
	jarSizeID := seedJarSize(t, server, "Pint", 16, 1200)
	saleID := seedAppliedSale(t, server, jarSizeID, 1, 1200)
	runSync(t, server) // create the row while sync is still enabled
	row := syncRowFor(t, server, SyncEntitySale, saleID)
	postsBefore, putsBefore, deletesBefore := fake.counts()

	disableGnuCashSync(t, server)

	response, body := call(t, server.handleGnuCashSyncNow,
		adminRequest(http.MethodPost, "/api/v1/settings/gnucash/sync", nil))
	if response.Code != http.StatusConflict {
		t.Fatalf("sync ran with sync disabled: %d %v", response.Code, body)
	}
	if message, _ := body["error"].(string); !strings.Contains(message, "disabled") {
		t.Fatalf("error %v does not say the integration is disabled", body)
	}

	// The manual per-row override is a write into the book too.
	response, body = call(t, server.handleGnuCashRowPush,
		adminRequest(http.MethodPost, "/api/v1/settings/gnucash/rows/x/push", nil,
			"id", row.ID.String()))
	if response.Code != http.StatusConflict {
		t.Fatalf("force push ran with sync disabled: %d %v", response.Code, body)
	}

	if posts, puts, deletes := fake.counts(); posts != postsBefore || puts != putsBefore ||
		deletes != deletesBefore {
		t.Fatalf("folio was written to while sync was disabled: %d/%d/%d, want %d/%d/%d",
			posts, puts, deletes, postsBefore, putsBefore, deletesBefore)
	}

	// Re-enabling through the ordinary settings PUT unblocks it again.
	response, body = call(t, server.handleGnuCashSettingsPut,
		adminRequest(http.MethodPut, "/api/v1/settings/gnucash", map[string]any{
			"syncEnabled": true,
		}))
	if response.Code != http.StatusOK {
		t.Fatalf("re-enable: %d %v", response.Code, body)
	}
	runSync(t, server)
}

// The happy path: credentials configured, the live book matches what the
// artifact expects, and the cursor plus per-row state land atomically with
// their preserved ids and created_at values.
func TestGnuCashRestoreInstallsCursorAndRowsAfterAnIdentityMatch(t *testing.T) {
	fake := newFolioFake(t)
	server := gnucashTestServer(t, fake, fullMapping())
	disableGnuCashSync(t, server)

	rowID, saleID := uuid.New(), uuid.New()
	code, body := postRestore(t, server, restorePayload(restoreRowPayload(rowID, saleID)))
	if code != http.StatusOK {
		t.Fatalf("restore: %d %v", code, body)
	}
	if body["rowsRestored"] != float64(1) || body["cursorInstalled"] != true {
		t.Fatalf("restore report %v", body)
	}
	if body["syncEnabled"] != false || body["restorePending"] != true {
		t.Fatalf("restore left sync enabled: %v", body)
	}
	// The report has to tell the operator what was deliberately not restored.
	if excluded, _ := body["excludedConfig"].([]any); len(excluded) == 0 {
		t.Fatalf("the report does not name the excluded configuration: %v", body)
	}

	settings := gnucashSettingsOf(t, server)
	if settings.ChangesCursor != "cursor-42" {
		t.Fatalf("cursor %q", settings.ChangesCursor)
	}
	if settings.BookGUID != "book-1" || settings.RootCurrency != "USD" {
		t.Fatalf("book identity %+v", settings)
	}
	if settings.SyncEnabled {
		t.Fatal("the restore enabled sync")
	}
	if settings.LastSyncAttemptAt == nil ||
		!settings.LastSyncAttemptAt.Equal(time.Date(2026, 8, 31, 23, 59, 0, 0, time.UTC)) {
		t.Fatalf("last sync attempt %v", settings.LastSyncAttemptAt)
	}

	var (
		storedID                    uuid.UUID
		externalID, hash, guid      *string
		syncState                   string
		createdAt, remote, syncedAt time.Time
	)
	if err := server.pool.QueryRow(context.Background(), `
		SELECT id, external_id, sync_state, content_hash, remote_transaction_guid,
			created_at, remote_enter_date, last_synced_at
		FROM external_sync WHERE system = $1 AND entity_type = $2 AND entity_id = $3`,
		SyncSystemGnuCashWeb, SyncEntitySale, saleID).
		Scan(&storedID, &externalID, &syncState, &hash, &guid, &createdAt, &remote,
			&syncedAt); err != nil {
		t.Fatalf("load restored row: %v", err)
	}
	if storedID != rowID {
		t.Fatalf("row id %s was not preserved (want %s)", storedID, rowID)
	}
	if !createdAt.Equal(time.Date(2026, 7, 1, 9, 0, 0, 0, time.UTC)) {
		t.Fatalf("created_at %s was not preserved", createdAt)
	}
	if derefString(externalID) != "sale:"+saleID.String() || syncState != "synced" {
		t.Fatalf("row %s / %s", derefString(externalID), syncState)
	}
	if derefString(hash) != "hash-abc" || derefString(guid) != "gc-77" {
		t.Fatalf("replay state hash=%q guid=%q", derefString(hash), derefString(guid))
	}
	if !remote.Equal(time.Date(2026, 8, 20, 12, 5, 0, 0, time.UTC)) {
		t.Fatalf("remote_enter_date %s", remote)
	}

	// Restored, and still refusing to write anything until the operator has
	// reconciled and enabled sync.
	response, syncBody := call(t, server.handleGnuCashSyncNow,
		adminRequest(http.MethodPost, "/api/v1/settings/gnucash/sync", nil))
	if response.Code != http.StatusConflict {
		t.Fatalf("sync ran straight after a restore: %d %v", response.Code, syncBody)
	}

	// The settings page shows the pending restore.
	response, settingsBody := call(t, server.handleGnuCashSettings,
		adminRequest(http.MethodGet, "/api/v1/settings/gnucash", nil))
	if response.Code != http.StatusOK || settingsBody["restorePending"] != true ||
		settingsBody["hasCursor"] != true {
		t.Fatalf("settings do not show the pending restore: %v", settingsBody)
	}
	if settingsBody["lastSyncAttemptAt"] != settingsBody["lastSyncedAt"] {
		t.Fatalf("the attempt time is reported inconsistently: %v", settingsBody)
	}
}

// The point of holding the expected identity separately: a token that opens
// some other book must be caught before the cursor is installed, not after
// the first push lands in the wrong ledger.
func TestGnuCashRestoreRefusesAMismatchedBook(t *testing.T) {
	fake := newFolioFake(t)
	server := gnucashTestServer(t, fake, fullMapping())
	disableGnuCashSync(t, server)

	payload := restorePayload(restoreRowPayload(uuid.New(), uuid.New()))
	payload["expectedBookGuid"] = "book-from-the-old-server"
	code, body := postRestore(t, server, payload)
	if code != http.StatusConflict {
		t.Fatalf("restore against the wrong book: %d %v", code, body)
	}
	if message, _ := body["error"].(string); !strings.Contains(message, "book-from-the-old-server") {
		t.Fatalf("error %v does not name both books", body)
	}
	if settings := gnucashSettingsOf(t, server); settings.ChangesCursor != "" {
		t.Fatalf("a cursor was installed anyway: %q", settings.ChangesCursor)
	}

	// A currency mismatch is the same class of failure.
	payload = restorePayload()
	payload["expectedRootCurrency"] = "CAD"
	if code, body = postRestore(t, server, payload); code != http.StatusConflict {
		t.Fatalf("restore against the wrong currency: %d %v", code, body)
	}
	if count := externalSyncCount(t, server); count != 0 {
		t.Fatalf("%d sync rows were installed by a refused restore", count)
	}
}

func externalSyncCount(t *testing.T, server *Server) int {
	t.Helper()
	var count int
	if err := server.pool.QueryRow(context.Background(),
		`SELECT count(*) FROM external_sync WHERE system = $1`, SyncSystemGnuCashWeb).
		Scan(&count); err != nil {
		t.Fatalf("count sync rows: %v", err)
	}
	return count
}

// Credentials before identity before install: a restore cannot run against a
// connection that has not been configured, and cannot run while sync is live.
func TestGnuCashRestoreRequiresConfiguredCredentialsAndDisabledSync(t *testing.T) {
	fake := newFolioFake(t)
	server := gnucashTestServer(t, fake, fullMapping())

	// Sync is still enabled from the fixture.
	code, body := postRestore(t, server, restorePayload())
	if code != http.StatusConflict {
		t.Fatalf("restore ran with sync enabled: %d %v", code, body)
	}

	disableGnuCashSync(t, server)
	if _, err := server.pool.Exec(context.Background(),
		`UPDATE gnucash_sync_settings SET api_token = NULL WHERE id = true`); err != nil {
		t.Fatalf("clear token: %v", err)
	}
	code, body = postRestore(t, server, restorePayload())
	if code != http.StatusBadRequest {
		t.Fatalf("restore ran without a token: %d %v", code, body)
	}
	if message, _ := body["error"].(string); !strings.Contains(message, "token") {
		t.Fatalf("error %v does not name the missing credential", body)
	}
	if fake.changeCallCount() != 0 {
		t.Fatal("folio was contacted before the credentials were checked")
	}
}

// The dry run proves the artifact would install — identity match, CHECK
// constraints, unique indexes — and keeps nothing.
func TestGnuCashRestoreDryRunKeepsNothing(t *testing.T) {
	fake := newFolioFake(t)
	server := gnucashTestServer(t, fake, fullMapping())
	disableGnuCashSync(t, server)

	payload := restorePayload(restoreRowPayload(uuid.New(), uuid.New()))
	payload["dryRun"] = true
	code, body := postRestore(t, server, payload)
	if code != http.StatusOK {
		t.Fatalf("dry run: %d %v", code, body)
	}
	if body["dryRun"] != true || body["rowsRestored"] != float64(1) {
		t.Fatalf("dry run report %v", body)
	}
	if count := externalSyncCount(t, server); count != 0 {
		t.Fatalf("the dry run committed %d rows", count)
	}
	if settings := gnucashSettingsOf(t, server); settings.ChangesCursor != "" {
		t.Fatalf("the dry run installed cursor %q", settings.ChangesCursor)
	}
}

// The hazard the roadmap names: entering the re-excluded token after a
// restore would clear the cursor the restore just installed. While a restore
// is pending the credential change is refused, with a deliberate way out.
func TestGnuCashSettingsPutCannotWipeAPendingRestore(t *testing.T) {
	fake := newFolioFake(t)
	server := gnucashTestServer(t, fake, fullMapping())
	disableGnuCashSync(t, server)
	if code, body := postRestore(t, server, restorePayload()); code != http.StatusOK {
		t.Fatalf("restore: %d %v", code, body)
	}

	response, body := call(t, server.handleGnuCashSettingsPut,
		adminRequest(http.MethodPut, "/api/v1/settings/gnucash", map[string]any{
			"apiToken": "gcw_typed_again",
		}))
	if response.Code != http.StatusConflict {
		t.Fatalf("a token change wiped a pending restore: %d %v", response.Code, body)
	}
	if cursor := storedCursor(t, server); cursor != "cursor-42" {
		t.Fatalf("cursor %q did not survive the refused change", cursor)
	}

	// Changes that are not credential changes still work.
	response, body = call(t, server.handleGnuCashSettingsPut,
		adminRequest(http.MethodPut, "/api/v1/settings/gnucash", map[string]any{
			"accountMapping": fullMapping(),
		}))
	if response.Code != http.StatusOK {
		t.Fatalf("mapping save during a restore: %d %v", response.Code, body)
	}
	if cursor := storedCursor(t, server); cursor != "cursor-42" {
		t.Fatalf("a mapping save cleared the cursor: %q", cursor)
	}

	// And the operator can still walk away from the restore on purpose.
	response, body = call(t, server.handleGnuCashSettingsPut,
		adminRequest(http.MethodPut, "/api/v1/settings/gnucash", map[string]any{
			"apiToken": "gcw_typed_again", "discardRestore": true,
		}))
	if response.Code != http.StatusOK {
		t.Fatalf("explicit discard: %d %v", response.Code, body)
	}
	if cursor := storedCursor(t, server); cursor != "" {
		t.Fatalf("cursor %q survived an explicit discard", cursor)
	}
	if settings := gnucashSettingsOf(t, server); settings.BookGUID != "" {
		t.Fatalf("book identity %q survived an explicit discard", settings.BookGUID)
	}
}

// A malformed artifact fails with a message naming the row and the field,
// before folio is contacted and before anything is written.
func TestGnuCashRestoreRejectsAMalformedArtifact(t *testing.T) {
	fake := newFolioFake(t)
	server := gnucashTestServer(t, fake, fullMapping())
	disableGnuCashSync(t, server)
	saleID := uuid.New()

	cases := []struct {
		name   string
		mutate func(row map[string]any, payload map[string]any)
		want   string
	}{
		{"unknown entity type", func(row, _ map[string]any) {
			row["entityType"] = "unicorn"
		}, "entity type"},
		{"unknown sync state", func(row, _ map[string]any) {
			row["syncState"] = "half_done"
		}, "sync state"},
		{"external id does not match the entity", func(row, _ map[string]any) {
			row["externalId"] = "sale:" + uuid.NewString()
		}, "does not match"},
		{"synced row with no external id", func(row, _ map[string]any) {
			row["externalId"] = ""
		}, "external id"},
		{"missing expected book", func(_, payload map[string]any) {
			payload["expectedBookGuid"] = ""
		}, "expectedBookGuid"},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			row := restoreRowPayload(uuid.New(), saleID)
			payload := restorePayload(row)
			testCase.mutate(row, payload)
			code, body := postRestore(t, server, payload)
			if code != http.StatusBadRequest {
				t.Fatalf("malformed artifact accepted: %d %v", code, body)
			}
			message, _ := body["error"].(string)
			if !strings.Contains(message, testCase.want) {
				t.Fatalf("error %q does not mention %q", message, testCase.want)
			}
			if count := externalSyncCount(t, server); count != 0 {
				t.Fatalf("%d rows written by a rejected restore", count)
			}
		})
	}

	// The same entity twice in one artifact is a re-key bug, not a merge.
	row := restoreRowPayload(uuid.New(), saleID)
	twin := restoreRowPayload(uuid.New(), saleID)
	code, body := postRestore(t, server, restorePayload(row, twin))
	if code != http.StatusBadRequest {
		t.Fatalf("duplicate entity accepted: %d %v", code, body)
	}
}

// Existing sync rows are reported, not silently merged: the restore expects
// an empty sync state and says so.
func TestGnuCashRestoreRefusesToMergeIntoExistingSyncRows(t *testing.T) {
	fake := newFolioFake(t)
	server := gnucashTestServer(t, fake, fullMapping())
	jarSizeID := seedJarSize(t, server, "Pint", 16, 1200)
	seedAppliedSale(t, server, jarSizeID, 1, 1200)
	runSync(t, server)
	if externalSyncCount(t, server) == 0 {
		t.Fatal("the fixture produced no sync rows")
	}
	disableGnuCashSync(t, server)

	rowID, saleID := uuid.New(), uuid.New()
	code, body := postRestore(t, server, restorePayload(restoreRowPayload(rowID, saleID)))
	if code != http.StatusConflict {
		t.Fatalf("restore merged into a populated sync state: %d %v", code, body)
	}
	if message, _ := body["error"].(string); !strings.Contains(message, "replaceExisting") {
		t.Fatalf("error %v does not name the resolution", body)
	}

	payload := restorePayload(restoreRowPayload(rowID, saleID))
	payload["replaceExisting"] = true
	code, body = postRestore(t, server, payload)
	if code != http.StatusOK {
		t.Fatalf("explicit replace: %d %v", code, body)
	}
	if body["rowsReplaced"] == float64(0) {
		t.Fatalf("the report does not say what was discarded: %v", body)
	}
	if count := externalSyncCount(t, server); count != 1 {
		t.Fatalf("%d rows after the replace, want exactly the artifact's 1", count)
	}
}
