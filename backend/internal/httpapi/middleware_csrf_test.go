package httpapi

import (
	"net/http"
	"net/http/httptest"
	"reflect"
	"regexp"
	"runtime"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"

	"github.com/biker2000on/beez-trackz/backend/internal/auth"
	"github.com/biker2000on/beez-trackz/backend/internal/config"
)

func csrfTestRouter() http.Handler {
	return NewRouter(&config.Config{
		SessionSecret: "test", AppURL: "https://beez.example.com",
	}, nil, nil, nil)
}

// TestCSRFOriginCheck (SEAM-021) pins which mutating requests are allowed
// through. A 403 with the CSRF message means the middleware rejected it;
// anything else means the request reached routing (nil pool panics later).
func TestCSRFOriginCheck(t *testing.T) {
	handler := csrfTestRouter()
	cases := []struct {
		name     string
		method   string
		origin   string
		referer  string
		bearer   string
		cookie   bool
		rejected bool
	}{
		{name: "same origin post", method: http.MethodPost,
			origin: "https://beez.example.com"},
		{name: "same origin referer only", method: http.MethodPost,
			referer: "https://beez.example.com/login"},
		{name: "cross site post", method: http.MethodPost,
			origin: "https://evil.example.com", rejected: true},
		{name: "cross site referer", method: http.MethodPost,
			referer: "https://evil.example.com/attack", rejected: true},
		{name: "opaque origin", method: http.MethodPost,
			origin: "null", referer: "https://evil.example.com", rejected: true},
		{name: "no origin without cookie", method: http.MethodPost},
		{name: "no origin with session cookie", method: http.MethodPost,
			cookie: true, rejected: true},
		{name: "api token ignores origin", method: http.MethodPost,
			origin: "https://evil.example.com", bearer: "bt_token"},
		{name: "get is never checked", method: http.MethodGet,
			origin: "https://evil.example.com"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			// A path with no handler: the middleware verdict is the only
			// thing that can produce a 403 here, and GET falls through to
			// chi's 404 instead of a pool-less handler.
			request := httptest.NewRequest(tc.method,
				"/api/v1/csrf-probe", strings.NewReader("{}"))
			if tc.origin != "" {
				request.Header.Set("Origin", tc.origin)
			}
			if tc.referer != "" {
				request.Header.Set("Referer", tc.referer)
			}
			if tc.bearer != "" {
				request.Header.Set("Authorization", "Bearer "+tc.bearer)
			}
			if tc.cookie {
				request.AddCookie(&http.Cookie{
					Name: auth.SessionCookieName, Value: "opaque"})
			}
			response := httptest.NewRecorder()
			handler.ServeHTTP(response, request)
			blocked := response.Code == http.StatusForbidden &&
				strings.Contains(strings.ToLower(response.Body.String()), "origin")
			if blocked != tc.rejected {
				t.Fatalf("blocked = %v (status %d, %s), want blocked = %v",
					blocked, response.Code, response.Body.String(), tc.rejected)
			}
		})
	}
}

// mutatingHandlerName matches handler names that describe a state change.
// The CSRF middleware only inspects POST/PUT/PATCH/DELETE, so a GET or HEAD
// handler that writes would be unprotected — and would also be replayed by
// the offline cache. TestNoMutatingGetRoutes enforces the convention.
var mutatingHandlerName = regexp.MustCompile(
	`(?i)(create|update|delete|remove|cancel|save|insert|upsert|` +
		`archive|restore|apply|assign|reset|revoke|subscribe|unsubscribe|` +
		`import|merge|move|record|run|start|stop|complete|send)`)

// Case-sensitive so "settings" is not read as the verb "set".
var setterHandlerName = regexp.MustCompile(`(^set[A-Z]|Set[A-Z])`)

// readOnlyExceptions are GET handlers whose names trip the pattern above but
// that only read. Add to this list only with a reason.
// (empty today: no read-only handler currently trips the pattern).
var readOnlyExceptions = map[string]string{}

func TestNoMutatingGetRoutes(t *testing.T) {
	router, ok := csrfTestRouter().(chi.Routes)
	if !ok {
		t.Fatal("router does not expose chi.Routes")
	}
	walked := 0
	err := chi.Walk(router, func(method, route string, handler http.Handler,
		_ ...func(http.Handler) http.Handler) error {
		walked++
		if method != http.MethodGet && method != http.MethodHead {
			return nil
		}
		full := runtime.FuncForPC(reflect.ValueOf(handler).Pointer()).Name()
		name := full[strings.LastIndex(full, ".")+1:]
		name = strings.TrimSuffix(name, "-fm")
		if _, allowed := readOnlyExceptions[name]; allowed {
			return nil
		}
		if mutatingHandlerName.MatchString(name) || setterHandlerName.MatchString(name) {
			t.Errorf("GET %s is served by %s, which reads as a mutation; "+
				"GET/HEAD must never change state (the CSRF middleware does "+
				"not guard them)", route, name)
		}
		return nil
	})
	if err != nil {
		t.Fatalf("walk router: %v", err)
	}
	if walked < 50 {
		t.Fatalf("walked only %d routes; the walk is not covering the API", walked)
	}
}
