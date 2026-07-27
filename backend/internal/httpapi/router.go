package httpapi

import (
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
	"github.com/hibiken/asynq"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/biker2000on/beez-trackz/backend/internal/config"
	"github.com/biker2000on/beez-trackz/backend/internal/storage"
)

// Server bundles shared dependencies for all HTTP handlers.
type Server struct {
	cfg   *config.Config
	pool  *pgxpool.Pool
	store *storage.Store
	queue *asynq.Client
}

func NewRouter(cfg *config.Config, pool *pgxpool.Pool, store *storage.Store, queue *asynq.Client) http.Handler {
	s := &Server{cfg: cfg, pool: pool, store: store, queue: queue}

	r := chi.NewRouter()
	r.Use(middleware.RequestID)
	r.Use(middleware.RealIP)
	r.Use(middleware.Logger)
	r.Use(middleware.Recoverer)

	r.Get("/healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("ok"))
	})

	r.Route("/api/v1", func(r chi.Router) {
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
