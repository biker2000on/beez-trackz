package httpapi

import (
	"io/fs"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
)

// frontendSourceRoot is the Next.js source tree whose API calls must all
// resolve to a route this router registers.
var frontendSourceRoot = filepath.Join("..", "..", "..", "frontend", "src")

// frontendAPICall matches `api.get<T>("/path…"`, `api.post(\`/path/${id}\``
// and friends. The generic argument may nest (`<Paged<Hive>>`).
var frontendAPICall = regexp.MustCompile(
	"\\bapi\\.(get|getWithMeta|post|put|patch|delete)(?:<[^()]*?>)?\\(\\s*" +
		"[\"'`](/[^\"'`]*)[\"'`]")

// frontendRawAPIPath matches absolute `/api/v1/…` literals used outside the
// api client (fetch calls, download/print links). Method is unknown, so these
// are only checked for existence under some method.
var frontendRawAPIPath = regexp.MustCompile("[\"'`](/api/v1/[^\"'`\\s]*)[\"'`]")

// chiParam matches a chi path parameter, with or without a regexp.
var chiParam = regexp.MustCompile(`\{[^/}]+\}`)

// templateExpr matches a `${…}` template-literal substitution.
var templateExpr = regexp.MustCompile(`\$\{[^}]*\}`)

type registeredRoute struct {
	method string
	re     *regexp.Regexp
}

func registeredRoutes(t *testing.T) []registeredRoute {
	t.Helper()
	router, ok := csrfTestRouter().(chi.Routes)
	if !ok {
		t.Fatal("router does not expose chi.Routes")
	}
	var routes []registeredRoute
	err := chi.Walk(router, func(method, route string, _ http.Handler,
		_ ...func(http.Handler) http.Handler) error {
		pattern := regexp.QuoteMeta(strings.TrimSuffix(route, "/"))
		// QuoteMeta escaped the braces; undo that for the param matcher.
		pattern = strings.NewReplacer(`\{`, "{", `\}`, "}").Replace(pattern)
		pattern = chiParam.ReplaceAllString(pattern, `[^/]+`)
		pattern = strings.ReplaceAll(pattern, `/\*`, `(/.*)?`)
		routes = append(routes, registeredRoute{
			method: method,
			re:     regexp.MustCompile("^" + pattern + "/?$"),
		})
		return nil
	})
	if err != nil {
		t.Fatalf("walk router: %v", err)
	}
	return routes
}

// normalizeFrontendPath turns a literal or template path into something a
// route regexp can match: query strings dropped, each `${…}` treated as one
// opaque segment value.
func normalizeFrontendPath(path string) (string, bool) {
	if i := strings.IndexAny(path, "?#"); i >= 0 {
		path = path[:i]
	}
	path = templateExpr.ReplaceAllString(path, "PARAM")
	path = strings.TrimSuffix(path, "/")
	if path == "" {
		return "", false
	}
	return path, true
}

// TestFrontendCallsRegisteredRoutes catches the class of bug where a backend
// route moves (e.g. /settings/gnucash/rows -> /insights/reconciliation) and a
// frontend caller keeps requesting the old path, which then 404s in
// production while every type check stays green.
func TestFrontendCallsRegisteredRoutes(t *testing.T) {
	if _, err := os.Stat(frontendSourceRoot); err != nil {
		t.Skipf("frontend source not present: %v", err)
	}
	routes := registeredRoutes(t)

	type call struct{ method, path, where string }
	var calls []call
	err := filepath.WalkDir(frontendSourceRoot, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() {
			return nil
		}
		ext := filepath.Ext(path)
		if ext != ".ts" && ext != ".tsx" {
			return nil
		}
		if strings.HasSuffix(path, ".generated.ts") {
			return nil
		}
		raw, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		src := string(raw)
		rel, _ := filepath.Rel(frontendSourceRoot, path)
		for _, m := range frontendAPICall.FindAllStringSubmatch(src, -1) {
			method := strings.ToUpper(m[1])
			if method == "GETWITHMETA" {
				method = http.MethodGet
			}
			calls = append(calls, call{method, "/api/v1" + m[2], rel})
		}
		for _, m := range frontendRawAPIPath.FindAllStringSubmatch(src, -1) {
			// Prefix literals (`/api/v1/admin/`) and doc placeholders
			// (`/api/v1/...`) — the service worker's route tables are full
			// of them — name a family of routes, not one route.
			if strings.HasSuffix(m[1], "/") || strings.Contains(m[1], "...") {
				continue
			}
			calls = append(calls, call{"", m[1], rel})
		}
		return nil
	})
	if err != nil {
		t.Fatalf("scan frontend: %v", err)
	}
	if len(calls) < 50 {
		t.Fatalf("found only %d frontend API calls; the scan is not covering the client", len(calls))
	}

	var missing []string
	for _, c := range calls {
		path, ok := normalizeFrontendPath(c.path)
		if !ok || path == "/api/v1" {
			continue
		}
		found := false
		for _, r := range routes {
			if (c.method == "" || r.method == c.method) && r.re.MatchString(path) {
				found = true
				break
			}
		}
		if !found {
			method := c.method
			if method == "" {
				method = "ANY"
			}
			missing = append(missing, method+" "+c.path+"  ("+filepath.ToSlash(c.where)+")")
		}
	}
	sort.Strings(missing)
	for _, m := range missing {
		t.Errorf("frontend calls a route the API does not register: %s", m)
	}
}
