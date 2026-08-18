package httpapi

import (
	"context"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
	"github.com/hibiken/asynq"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/biker2000on/beez-trackz/backend/internal/config"
	"github.com/biker2000on/beez-trackz/backend/internal/photostore"
	"github.com/biker2000on/beez-trackz/backend/internal/storage"
)

const apiJSONBodyLimit = 1 << 20 // 1MB; photo/transcription uploads opt out.

// Server bundles shared dependencies for all HTTP handlers.
type Server struct {
	cfg    *config.Config
	pool   *pgxpool.Pool
	store  *storage.Store
	queue  *asynq.Client
	photos *photostore.Resolver
}

func NewRouter(cfg *config.Config, pool *pgxpool.Pool, store *storage.Store, queue *asynq.Client) http.Handler {
	s := &Server{cfg: cfg, pool: pool, store: store, queue: queue, photos: photostore.New(cfg, store)}

	r := chi.NewRouter()
	r.Use(middleware.RequestID)
	r.Use(s.trustedRealIP)
	r.Use(middleware.Logger)
	r.Use(middleware.Recoverer)

	// Container healthcheck target. It pings the database because "process
	// up but DB unreachable" is exactly the state a restart-or-alert should
	// catch; an unconditional "ok" checked nothing.
	r.Get("/healthz", func(w http.ResponseWriter, req *http.Request) {
		ctx, cancel := context.WithTimeout(req.Context(), 2*time.Second)
		defer cancel()
		if err := pool.Ping(ctx); err != nil {
			writeError(w, http.StatusServiceUnavailable, "database unavailable")
			return
		}
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("ok"))
	})

	r.Route("/api/v1", func(r chi.Router) {
		r.Use(limitAPIBody)
		s.mountAuth(r)
		s.mountPublicCommerce(r)
		// Authenticated API routes are mounted by domain in routes_*.go files.
		r.Group(func(r chi.Router) {
			r.Use(s.requireSession)
			r.Use(s.offlineMutations)
			s.mountDomains(r)
		})
	})

	return r
}

// limitAPIBody caps JSON request bodies. Photo and transcription uploads
// already apply their own larger MaxBytesReader and must be excluded.
func limitAPIBody(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if apiUploadExempt(r) {
			next.ServeHTTP(w, r)
			return
		}
		r.Body = http.MaxBytesReader(w, r.Body, apiJSONBodyLimit)
		next.ServeHTTP(w, r)
	})
}

func apiUploadExempt(r *http.Request) bool {
	if r.Method != http.MethodPost {
		return false
	}
	path := strings.TrimRight(r.URL.Path, "/")
	return path == "/api/v1/photos" || path == "/api/v1/transcriptions"
}
