package jobs

import (
	"context"
	"log/slog"

	"github.com/hibiken/asynq"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/biker2000on/beez-trackz/backend/internal/config"
	"github.com/biker2000on/beez-trackz/backend/internal/photostore"
	"github.com/biker2000on/beez-trackz/backend/internal/storage"
)

// Handlers holds worker-side dependencies.
type Handlers struct {
	cfg      *config.Config
	pool     *pgxpool.Pool
	store    *storage.Store
	photos   *photostore.Resolver
	postRecs func(context.Context)
}

// NewWorker builds the asynq server and task mux for the worker binary.
// postRecs, when non-nil, runs after each successful recommendation pass —
// the ntfy dispatch hook lives there so pushes are hands-free. It must be
// fail-soft; its errors cannot fail the task.
func NewWorker(cfg *config.Config, pool *pgxpool.Pool, store *storage.Store, postRecs func(context.Context)) (*asynq.Server, *asynq.ServeMux, error) {
	opt, err := redisOpt(cfg.RedisURL)
	if err != nil {
		return nil, nil, err
	}
	srv := asynq.NewServer(opt, asynq.Config{
		Concurrency: 4,
		Logger:      asynqLogger{},
	})

	h := &Handlers{cfg: cfg, pool: pool, store: store, photos: photostore.New(cfg, store), postRecs: postRecs}
	mux := asynq.NewServeMux()
	mux.HandleFunc(TypeProcessImage, h.handleProcessImage)
	mux.HandleFunc(TypeImmichYardScan, h.handleImmichYardScan)
	mux.HandleFunc(TypeTranscribeAudio, h.handleTranscribeAudio)
	mux.HandleFunc(TypeGenerateRecs, h.handleGenerateRecs)
	mux.HandleFunc(TypeCleanupReceipts, h.handleCleanupReceipts)
	return srv, mux, nil
}

type asynqLogger struct{}

func (asynqLogger) Debug(args ...any) { slog.Debug("asynq", "msg", args) }
func (asynqLogger) Info(args ...any)  { slog.Info("asynq", "msg", args) }
func (asynqLogger) Warn(args ...any)  { slog.Warn("asynq", "msg", args) }
func (asynqLogger) Error(args ...any) { slog.Error("asynq", "msg", args) }
func (asynqLogger) Fatal(args ...any) { slog.Error("asynq fatal", "msg", args) }
