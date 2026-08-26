package gnucashsync

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

// Error codes folio returns in the {error, detail} envelope. They drive
// recovery, so they are matched by value and not by message text.
const (
	ErrLinkOrphaned = "link_orphaned"
	ErrReconciled   = "reconciled"
)

// maxResponseBytes bounds a response body. The largest legitimate reply is a
// full accounts list or a 500-item changes page; anything past this is a
// misconfigured base URL pointed at something that is not folio.
const maxResponseBytes = 8 << 20

// maxChangesLimit is the folio cap on GET changes?limit.
const maxChangesLimit = 500

// integrationPath is the fixed prefix of the contract. A base URL that
// already ends in it is used as-is.
const integrationPath = "/api/integrations/beez"

// APIError is a non-2xx reply. Code is the machine-readable folio error, and
// is empty when the body was not the documented envelope.
type APIError struct {
	Status int
	Code   string
	Detail string
}

func (e *APIError) Error() string {
	switch {
	case e.Code != "" && e.Detail != "":
		return fmt.Sprintf("gnucash %d %s: %s", e.Status, e.Code, e.Detail)
	case e.Code != "":
		return fmt.Sprintf("gnucash %d %s", e.Status, e.Code)
	default:
		return fmt.Sprintf("gnucash %d", e.Status)
	}
}

// codeIs reports whether err is an APIError carrying code.
func codeIs(err error, code string) bool {
	var apiErr *APIError
	return errors.As(err, &apiErr) && apiErr.Code == code
}

// IsLinkOrphaned reports the 409 that means folio still holds a link row for
// this externalId but the transaction behind it was deleted. The link has to
// be acknowledged with DELETE before a new transaction can be created.
func IsLinkOrphaned(err error) bool { return codeIs(err, ErrLinkOrphaned) }

// IsReconciled reports the 409 that means the transaction is frozen in folio.
// Beez must not retry; the operator decides.
func IsReconciled(err error) bool { return codeIs(err, ErrReconciled) }

// IsNotFound reports a 404 — for a write, "this externalId is not linked".
func IsNotFound(err error) bool {
	var apiErr *APIError
	return errors.As(err, &apiErr) && apiErr.Status == http.StatusNotFound
}

// IsAuth reports 401/403: a token that is missing, wrong, or not bound to a
// book the caller may write.
func IsAuth(err error) bool {
	var apiErr *APIError
	return errors.As(err, &apiErr) &&
		(apiErr.Status == http.StatusUnauthorized || apiErr.Status == http.StatusForbidden)
}

// IsPermanent reports a 4xx: retrying the same body cannot succeed, so the row
// is marked failed instead of being left pending forever.
func IsPermanent(err error) bool {
	var apiErr *APIError
	return errors.As(err, &apiErr) && apiErr.Status >= 400 && apiErr.Status < 500
}

// Client calls one folio book. It is safe for concurrent use.
type Client struct {
	baseURL    string
	token      string
	httpClient *http.Client
}

// errRedirect is returned by the redirect policy below. It is deliberately
// not an *APIError: a redirect is a configuration problem, not something a
// row can be marked failed for.
var errRedirect = errors.New("gnucash refused: the server answered with a redirect, which this integration does not follow")

// denyRedirects refuses every 3xx. Folio never redirects its API calls, so a
// redirect means the base URL points at something else — a proxy, a login
// page, or an attacker-controlled hop that would receive the bearer token.
func denyRedirects(req *http.Request, _ []*http.Request) error {
	_ = req
	return errRedirect
}

// ValidBaseURL accepts only absolute http/https URLs with a host and nothing
// else: no userinfo, query, or fragment. The base URL is fetched server-side
// with the API token attached, so anything that could redirect the request,
// smuggle credentials, or graft a query onto every contract path is an
// SSRF-shaped input.
func ValidBaseURL(raw string) bool {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return false
	}
	// Checked on the raw string, before parsing: Go reports an empty
	// fragment ("https://host#") with both Fragment and RawFragment empty,
	// so the parsed-field checks below cannot see it, and endpoint() would
	// then graft the contract path after the marker and send the authed
	// request to the host root. A trailing "?" is the same shape.
	if strings.ContainsAny(raw, "#?") {
		return false
	}
	parsed, err := url.Parse(raw)
	if err != nil {
		return false
	}
	if parsed.Scheme != "http" && parsed.Scheme != "https" {
		return false
	}
	if parsed.Host == "" || parsed.Opaque != "" {
		return false
	}
	// user:pass@host would put a second credential on the wire, and a query
	// or fragment on the base would be re-emitted in front of ours by
	// endpoint(), silently rewriting "changes?since=..." into something else.
	if parsed.User != nil || parsed.RawQuery != "" || parsed.ForceQuery ||
		parsed.Fragment != "" || parsed.RawFragment != "" {
		return false
	}
	return true
}

// NewClient builds a client for baseURL. The caller has already validated the
// URL with ValidBaseURL; httpClient may be nil for a sane default.
//
// Redirects are denied on every client, including a caller-supplied one. The
// supplied client is copied rather than mutated so a shared *http.Client is
// not reconfigured behind its owner's back.
func NewClient(baseURL, token string, httpClient *http.Client) *Client {
	if httpClient == nil {
		httpClient = &http.Client{Timeout: 30 * time.Second}
	}
	transport := *httpClient
	transport.CheckRedirect = denyRedirects
	return &Client{
		baseURL:    strings.TrimRight(strings.TrimSpace(baseURL), "/"),
		token:      strings.TrimSpace(token),
		httpClient: &transport,
	}
}

// IsRedirect reports the fail-closed redirect refusal.
func IsRedirect(err error) bool { return errors.Is(err, errRedirect) }

// endpoint joins the configured base URL with a contract path. The base URL
// may already end in the integration prefix, in which case it is not
// appended twice.
func (c *Client) endpoint(path string) string {
	base := c.baseURL
	if !strings.HasSuffix(base, integrationPath) {
		base += integrationPath
	}
	return base + "/" + strings.TrimPrefix(path, "/")
}

// do performs one request. body is marshaled when non-nil, out is decoded
// when non-nil, and idempotencyKey is sent when non-empty.
func (c *Client) do(
	ctx context.Context,
	method, path, idempotencyKey string,
	body, out any,
) (int, error) {
	var reader io.Reader
	if body != nil {
		encoded, err := json.Marshal(body)
		if err != nil {
			return 0, fmt.Errorf("encode request: %w", err)
		}
		reader = bytes.NewReader(encoded)
	}
	request, err := http.NewRequestWithContext(ctx, method, c.endpoint(path), reader)
	if err != nil {
		return 0, fmt.Errorf("build request: %w", err)
	}
	request.Header.Set("Accept", "application/json")
	if body != nil {
		request.Header.Set("Content-Type", "application/json")
	}
	if c.token != "" {
		request.Header.Set("Authorization", "Bearer "+c.token)
	}
	if idempotencyKey != "" {
		request.Header.Set("Idempotency-Key", idempotencyKey)
	}

	response, err := c.httpClient.Do(request)
	if err != nil {
		return 0, fmt.Errorf("call gnucash: %w", err)
	}
	defer response.Body.Close()

	payload, err := io.ReadAll(io.LimitReader(response.Body, maxResponseBytes))
	if err != nil {
		return response.StatusCode, fmt.Errorf("read gnucash response: %w", err)
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		apiErr := &APIError{Status: response.StatusCode}
		var envelope struct {
			Error  string `json:"error"`
			Detail string `json:"detail"`
		}
		if json.Unmarshal(payload, &envelope) == nil {
			apiErr.Code = envelope.Error
			apiErr.Detail = envelope.Detail
		}
		return response.StatusCode, apiErr
	}
	if out != nil && len(payload) > 0 {
		if err := json.Unmarshal(payload, out); err != nil {
			return response.StatusCode, fmt.Errorf("decode gnucash response: %w", err)
		}
	}
	return response.StatusCode, nil
}

// Status fetches the book the token is bound to. It is the "test connection"
// call and the cheapest liveness probe.
func (c *Client) Status(ctx context.Context) (Status, error) {
	var out Status
	_, err := c.do(ctx, http.MethodGet, "status", "", nil, &out)
	return out, err
}

// Accounts lists the accounts of the book for the mapping editor.
func (c *Client) Accounts(ctx context.Context) ([]Account, error) {
	var out struct {
		Accounts []Account `json:"accounts"`
	}
	if _, err := c.do(ctx, http.MethodGet, "accounts", "", nil, &out); err != nil {
		return nil, err
	}
	return out.Accounts, nil
}

// CreateTransaction posts a new transaction. A 200 (rather than 201) means
// folio already had this externalId linked and returned the stored answer;
// AlreadyLinked is set so the caller can tell the two apart.
func (c *Client) CreateTransaction(
	ctx context.Context, txn Transaction, idempotencyKey string,
) (WriteResult, error) {
	var out WriteResult
	status, err := c.do(ctx, http.MethodPost, "transactions", idempotencyKey, txn, &out)
	if err != nil {
		return WriteResult{}, err
	}
	if status == http.StatusOK {
		out.AlreadyLinked = true
	}
	return out, nil
}

// UpdateTransaction replaces the transaction linked to externalID. The body
// carries no externalId; the path does.
func (c *Client) UpdateTransaction(
	ctx context.Context, externalID string, txn Transaction, idempotencyKey string,
) (WriteResult, error) {
	txn.ExternalID = ""
	var out WriteResult
	_, err := c.do(ctx, http.MethodPut,
		"transactions/"+url.PathEscape(externalID), idempotencyKey, txn, &out)
	if err != nil {
		return WriteResult{}, err
	}
	return out, nil
}

// DeleteTransaction removes the linked transaction. It is also how an
// orphaned link is acknowledged, so callers that only want the link cleared
// treat a 404 as success.
func (c *Client) DeleteTransaction(
	ctx context.Context, externalID, idempotencyKey string,
) error {
	_, err := c.do(ctx, http.MethodDelete,
		"transactions/"+url.PathEscape(externalID), idempotencyKey, nil, nil)
	return err
}

// Changes drains folio-side activity from an opaque cursor. An empty cursor
// starts from the beginning of the history of the book.
func (c *Client) Changes(ctx context.Context, cursor string, limit int) (ChangesPage, error) {
	if limit <= 0 || limit > maxChangesLimit {
		limit = maxChangesLimit
	}
	query := url.Values{}
	if cursor != "" {
		query.Set("since", cursor)
	}
	query.Set("limit", strconv.Itoa(limit))
	var out ChangesPage
	_, err := c.do(ctx, http.MethodGet, "changes?"+query.Encode(), "", nil, &out)
	return out, err
}
