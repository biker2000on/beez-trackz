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
		f.create(w, r)
	case r.Method == http.MethodPut && strings.HasPrefix(path, "/transactions/"):
		f.update(w, r, strings.TrimPrefix(path, "/transactions/"))
	case r.Method == http.MethodDelete && strings.HasPrefix(path, "/transactions/"):
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
	if err := saveGnuCashSettings(context.Background(), server.pool, gnucashSettings{
		BaseURL:     fake.server.URL,
		Token:       "gcw_test",
		SyncEnabled: true,
		Mapping:     mapping,
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

	// The transaction is deleted in folio but the link row survives, and the
	// local sale changes so beez wants to write again.
	fake.externalDelete(externalID)
	if _, err := server.pool.Exec(context.Background(), `
		UPDATE external_sync SET conflict_state = NULL, sync_state = 'pending'
		WHERE external_id = $1`, externalID); err != nil {
		t.Fatalf("clear conflict: %v", err)
	}

	runSync(t, server)
	row := syncRowFor(t, server, SyncEntitySale, saleID)
	if row.SyncState != "synced" {
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

	report := runSync(t, server)
	if report["pulledItems"] != float64(3) {
		t.Fatalf("pulled %v items, want 3", report["pulledItems"])
	}
	cursor := storedCursor(t, server)
	if cursor != "3" {
		t.Fatalf("stored cursor %q, want 3", cursor)
	}

	// A second run starts where the first stopped and re-reads nothing.
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
