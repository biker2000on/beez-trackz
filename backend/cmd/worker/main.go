package main

import (
	"context"
	"log/slog"
	"os"
	"os/signal"
	"syscall"

	"github.com/hibiken/asynq"

	"github.com/biker2000on/beez-trackz/backend/internal/config"
	"github.com/biker2000on/beez-trackz/backend/internal/db"
	"github.com/biker2000on/beez-trackz/backend/internal/jobs"
	"github.com/biker2000on/beez-trackz/backend/internal/storage"
)

func main() {
	logger := slog.New(slog.NewTextHandler(os.Stderr, nil))
	slog.SetDefault(logger)

	cfg, err := config.Load()
	if err != nil {
		slog.Error("config", "err", err)
		os.Exit(1)
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	pool, err := db.Connect(ctx, cfg.DatabaseURL)
	if err != nil {
		slog.Error("database", "err", err)
		os.Exit(1)
	}
	defer pool.Close()

	store, err := storage.New(ctx, cfg)
	if err != nil {
		slog.Error("storage", "err", err)
		os.Exit(1)
	}

	srv, mux, err := jobs.NewWorker(cfg, pool, store)
	if err != nil {
		slog.Error("worker", "err", err)
		os.Exit(1)
	}

	redisOpt, err := asynq.ParseRedisURI(cfg.RedisURL)
	if err != nil {
		slog.Error("redis", "err", err)
		os.Exit(1)
	}
	scheduler := asynq.NewScheduler(redisOpt, nil)
	if err := jobs.RegisterPeriodic(scheduler); err != nil {
		slog.Error("scheduler", "err", err)
		os.Exit(1)
	}

	go func() {
		<-ctx.Done()
		scheduler.Shutdown()
		srv.Shutdown()
	}()

	go func() {
		if err := scheduler.Run(); err != nil {
			slog.Error("scheduler run", "err", err)
		}
	}()

	slog.Info("worker started")
	if err := srv.Run(mux); err != nil {
		slog.Error("worker run", "err", err)
		os.Exit(1)
	}
}
