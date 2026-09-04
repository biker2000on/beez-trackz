package main

import (
	"context"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/biker2000on/beez-trackz/backend/internal/config"
	"github.com/biker2000on/beez-trackz/backend/internal/db"
	"github.com/biker2000on/beez-trackz/backend/internal/httpapi"
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
	slog.Info("brand resolved", "displayName", cfg.Brand.DisplayName)

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

	queue, err := jobs.NewClient(cfg.RedisURL)
	if err != nil {
		slog.Error("queue", "err", err)
		os.Exit(1)
	}
	defer queue.Close()

	srv := &http.Server{
		Addr:              cfg.ListenAddr,
		Handler:           httpapi.NewRouter(cfg, pool, store, queue),
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       30 * time.Second,
		WriteTimeout:      60 * time.Second,
		IdleTimeout:       120 * time.Second,
		MaxHeaderBytes:    1 << 20,
	}

	go func() {
		slog.Info("api listening", "addr", cfg.ListenAddr)
		if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			slog.Error("serve", "err", err)
			stop()
		}
	}()

	<-ctx.Done()
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	_ = srv.Shutdown(shutdownCtx)
}
