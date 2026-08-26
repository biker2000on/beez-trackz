package gnucashsync

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// recordedRequest is what the fake folio saw.
type recordedRequest struct {
	Method         string
	Path           string
	Query          string
	Authorization  string
	IdempotencyKey string
	Body           string
}

func fakeFolio(t *testing.T, handler func(w http.ResponseWriter, r *http.Request)) (*httptest.Server, *[]recordedRequest) {
	t.Helper()
	seen := &[]recordedRequest{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body := make([]byte, 0)
		if r.Body != nil {
			buf := make([]byte, 1<<16)
			n, _ := r.Body.Read(buf)
			body = buf[:n]
		}
		*seen = append(*seen, recordedRequest{
			Method:         r.Method,
			Path:           r.URL.Path,
			Query:          r.URL.RawQuery,
			Authorization:  r.Header.Get("Authorization"),
			IdempotencyKey: r.Header.Get("Idempotency-Key"),
			Body:           string(body),
		})
		handler(w, r)
	}))
	t.Cleanup(server.Close)
	return server, seen
}

func TestClientSendsBearerTokenAndContractPath(t *testing.T) {
	server, seen := fakeFolio(t, func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{"ok":true,"bookGuid":"b1","bookName":"Yard","rootCurrency":"USD"}`))
	})
	client := NewClient(server.URL, "gcw_token", server.Client())
	status, err := client.Status(context.Background())
	if err != nil {
		t.Fatalf("status: %v", err)
	}
	if status.BookName != "Yard" || status.RootCurrency != "USD" {
		t.Fatalf("status %+v", status)
	}
	got := (*seen)[0]
	if got.Path != "/api/integrations/beez/status" {
		t.Fatalf("path %q", got.Path)
	}
	if got.Authorization != "Bearer gcw_token" {
		t.Fatalf("authorization %q", got.Authorization)
	}
}

// An operator who pastes the full documented URL must not end up calling
// /api/integrations/beez/api/integrations/beez/status.
func TestClientDoesNotDoubleTheIntegrationPrefix(t *testing.T) {
	server, seen := fakeFolio(t, func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{"ok":true}`))
	})
	client := NewClient(server.URL+"/api/integrations/beez/", "t", server.Client())
	if _, err := client.Status(context.Background()); err != nil {
		t.Fatalf("status: %v", err)
	}
	if got := (*seen)[0].Path; got != "/api/integrations/beez/status" {
		t.Fatalf("path %q", got)
	}
}

func TestClientCreateSendsIdempotencyKeyAndFlagsAlreadyLinked(t *testing.T) {
	server, seen := fakeFolio(t, func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK) // 200, not 201: already linked
		_, _ = w.Write([]byte(`{"transactionGuid":"t1","enterDate":"2026-08-20T10:00:00Z","externalId":"sale:1"}`))
	})
	client := NewClient(server.URL, "t", server.Client())
	result, err := client.CreateTransaction(context.Background(), Transaction{
		ExternalID: "sale:1", PostDate: "2026-08-20", Description: "x",
		Splits: []Split{{AccountGUID: "a", AmountCents: 1}, {AccountGUID: "b", AmountCents: -1}},
	}, "sale:1:hash")
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	if !result.AlreadyLinked {
		t.Fatal("a 200 must be reported as alreadyLinked")
	}
	if got := (*seen)[0].IdempotencyKey; got != "sale:1:hash" {
		t.Fatalf("idempotency key %q", got)
	}
	if !strings.Contains((*seen)[0].Body, `"externalId":"sale:1"`) {
		t.Fatalf("body %q", (*seen)[0].Body)
	}
}

func TestClientUpdateDropsTheExternalIdFromTheBody(t *testing.T) {
	server, seen := fakeFolio(t, func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{"transactionGuid":"t1","enterDate":"2026-08-21T10:00:00Z"}`))
	})
	client := NewClient(server.URL, "t", server.Client())
	if _, err := client.UpdateTransaction(context.Background(), "sale:1", Transaction{
		ExternalID: "sale:1", PostDate: "2026-08-20", Description: "x",
		Splits: []Split{{AccountGUID: "a", AmountCents: 1}, {AccountGUID: "b", AmountCents: -1}},
	}, "key"); err != nil {
		t.Fatalf("update: %v", err)
	}
	got := (*seen)[0]
	if got.Method != http.MethodPut || got.Path != "/api/integrations/beez/transactions/sale:1" {
		t.Fatalf("%s %s", got.Method, got.Path)
	}
	if strings.Contains(got.Body, "externalId") {
		t.Fatalf("PUT body must not carry externalId: %q", got.Body)
	}
}

func TestClientClassifiesContractErrors(t *testing.T) {
	cases := []struct {
		name   string
		status int
		body   string
		check  func(error) bool
	}{
		{"orphaned link", http.StatusConflict, `{"error":"link_orphaned"}`, IsLinkOrphaned},
		{"reconciled", http.StatusConflict, `{"error":"reconciled","detail":"frozen"}`, IsReconciled},
		{"not linked", http.StatusNotFound, `{"error":"not_found"}`, IsNotFound},
		{"bad token", http.StatusUnauthorized, `{"error":"unauthorized"}`, IsAuth},
		{"unprocessable", http.StatusUnprocessableEntity, `{"error":"unbalanced"}`, IsPermanent},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			server, _ := fakeFolio(t, func(w http.ResponseWriter, _ *http.Request) {
				w.WriteHeader(testCase.status)
				_, _ = w.Write([]byte(testCase.body))
			})
			client := NewClient(server.URL, "t", server.Client())
			_, err := client.CreateTransaction(context.Background(), Transaction{}, "k")
			if err == nil {
				t.Fatal("expected an error")
			}
			if !testCase.check(err) {
				t.Fatalf("error %v not classified", err)
			}
		})
	}
}

// A 5xx is not permanent: the engine keeps such a row pending and retries.
func TestClientTreatsServerErrorsAsRetryable(t *testing.T) {
	server, _ := fakeFolio(t, func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusBadGateway)
	})
	client := NewClient(server.URL, "t", server.Client())
	_, err := client.CreateTransaction(context.Background(), Transaction{}, "k")
	if err == nil || IsPermanent(err) {
		t.Fatalf("a 502 must not be permanent: %v", err)
	}
}

func TestClientChangesSendsCursorAndClampsTheLimit(t *testing.T) {
	server, seen := fakeFolio(t, func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{"items":[],"nextCursor":"c2","hasMore":false}`))
	})
	client := NewClient(server.URL, "t", server.Client())
	page, err := client.Changes(context.Background(), "c1", 100000)
	if err != nil {
		t.Fatalf("changes: %v", err)
	}
	if page.NextCursor != "c2" || page.HasMore {
		t.Fatalf("page %+v", page)
	}
	query := (*seen)[0].Query
	if !strings.Contains(query, "since=c1") || !strings.Contains(query, "limit=500") {
		t.Fatalf("query %q", query)
	}

	// An empty cursor means "from the beginning" and must not be sent.
	if _, err := client.Changes(context.Background(), "", 50); err != nil {
		t.Fatalf("changes: %v", err)
	}
	if strings.Contains((*seen)[1].Query, "since=") {
		t.Fatalf("query %q sends an empty cursor", (*seen)[1].Query)
	}
}

func TestValidBaseURLRejectsNonHTTPSchemes(t *testing.T) {
	for _, raw := range []string{"", "   ", "file:///etc/passwd", "folio.example.com", "gopher://x"} {
		if ValidBaseURL(raw) {
			t.Fatalf("%q must be rejected", raw)
		}
	}
	for _, raw := range []string{"http://localhost:8080", "https://folio.example.com/api/integrations/beez"} {
		if !ValidBaseURL(raw) {
			t.Fatalf("%q must be accepted", raw)
		}
	}
}

// The base URL is fetched server-side with the API token attached, so the
// parts of a URL that could carry a second credential or rewrite the query of
// every contract call are rejected outright.
func TestValidBaseURLRejectsUserinfoQueryAndFragment(t *testing.T) {
	for _, raw := range []string{
		"https://user:pass@folio.example.com",
		"https://user@folio.example.com/api/integrations/beez",
		"https://folio.example.com/api/integrations/beez?token=leak",
		"https://folio.example.com/api/integrations/beez?",
		"https://folio.example.com/api/integrations/beez#frag",
		"https://folio.example.com?",
		// Go parses a bare trailing marker with Fragment and RawQuery both
		// empty, so these only fail on the raw string.
		"https://folio.example.com#",
		"https://folio.example.com/api/integrations/beez#",
		"https://folio.example.com/api/integrations/beez?",
		"https://folio.example.com/api#/integrations/beez",
		"http:opaque",
	} {
		if ValidBaseURL(raw) {
			t.Fatalf("%q must be rejected", raw)
		}
	}
}

// Folio never redirects an API call. Following one would hand the bearer
// token to whatever host the redirect names, so every 3xx fails closed.
func TestClientRefusesToFollowRedirects(t *testing.T) {
	target, targetSeen := fakeFolio(t, func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{"ok":true}`))
	})
	for _, status := range []int{http.StatusMovedPermanently, http.StatusFound,
		http.StatusTemporaryRedirect, http.StatusPermanentRedirect} {
		redirector, _ := fakeFolio(t, func(w http.ResponseWriter, _ *http.Request) {
			http.Redirect(w, &http.Request{}, target.URL+"/api/integrations/beez/status", status)
		})
		client := NewClient(redirector.URL, "gcw_token", redirector.Client())
		if _, err := client.Status(context.Background()); err == nil {
			t.Fatalf("HTTP %d was followed", status)
		} else if !IsRedirect(err) {
			t.Fatalf("HTTP %d gave %v, want a redirect refusal", status, err)
		}
		if len(*targetSeen) != 0 {
			t.Fatalf("HTTP %d leaked the request to the redirect target", status)
		}
	}
}

// A caller-supplied client is copied, not reconfigured behind its owner.
func TestNewClientDoesNotMutateTheSuppliedHTTPClient(t *testing.T) {
	server, _ := fakeFolio(t, func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{"ok":true}`))
	})
	supplied := server.Client()
	NewClient(server.URL, "gcw_token", supplied)
	if supplied.CheckRedirect != nil {
		t.Fatal("NewClient rewrote the redirect policy of the caller's client")
	}
}
