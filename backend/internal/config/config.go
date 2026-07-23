package config

import (
	"fmt"
	"os"
)

// Config holds all runtime configuration, sourced from environment variables.
type Config struct {
	// HTTP
	ListenAddr string

	// Postgres
	DatabaseURL string

	// Redis (asynq worker queue)
	RedisURL string

	// MinIO / S3 media storage
	MinioEndpoint  string
	MinioAccessKey string
	MinioSecretKey string
	MinioUseSSL    bool
	MinioBucket    string

	// Auth
	SessionSecret string
	// Base URL the app is served from, e.g. https://beez.example.com.
	// Used for OIDC redirect URIs and absolute links.
	AppURL string

	// OIDC (optional — local login always available)
	OIDCIssuer       string
	OIDCClientID     string
	OIDCClientSecret string
}

func Load() (*Config, error) {
	cfg := &Config{
		ListenAddr:       getenv("LISTEN_ADDR", ":8080"),
		DatabaseURL:      os.Getenv("DATABASE_URL"),
		RedisURL:         getenv("REDIS_URL", "redis://localhost:6379"),
		MinioEndpoint:    getenv("MINIO_ENDPOINT", "localhost:9000"),
		MinioAccessKey:   getenv("MINIO_ACCESS_KEY", "beeztrackz"),
		MinioSecretKey:   getenv("MINIO_SECRET_KEY", "beeztrackz"),
		MinioUseSSL:      os.Getenv("MINIO_USE_SSL") == "true",
		MinioBucket:      getenv("MINIO_BUCKET", "beeztrackz-media"),
		SessionSecret:    os.Getenv("SESSION_SECRET"),
		AppURL:           getenv("APP_URL", "http://localhost:3000"),
		OIDCIssuer:       os.Getenv("OIDC_ISSUER"),
		OIDCClientID:     os.Getenv("OIDC_CLIENT_ID"),
		OIDCClientSecret: os.Getenv("OIDC_CLIENT_SECRET"),
	}
	if cfg.DatabaseURL == "" {
		return nil, fmt.Errorf("DATABASE_URL is required")
	}
	if cfg.SessionSecret == "" {
		return nil, fmt.Errorf("SESSION_SECRET is required")
	}
	return cfg, nil
}

func getenv(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}
