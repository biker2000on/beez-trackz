package config

import (
	"fmt"
	"log/slog"
	"net"
	"os"
	"strings"
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

	// TrustedProxies is the CIDR allowlist of reverse proxies whose
	// X-Forwarded-For / X-Real-IP headers may be used as the client address.
	TrustedProxies []*net.IPNet
}

const defaultTrustedProxies = "10.0.0.0/8,172.16.0.0/12,192.168.0.0/16"

func Load() (*Config, error) {
	cfg := &Config{
		ListenAddr:       getenv("LISTEN_ADDR", ":8080"),
		DatabaseURL:      os.Getenv("DATABASE_URL"),
		RedisURL:         getenv("REDIS_URL", "redis://localhost:6379"),
		MinioEndpoint:    getenv("MINIO_ENDPOINT", "localhost:9000"),
		MinioAccessKey:   os.Getenv("MINIO_ACCESS_KEY"),
		MinioSecretKey:   os.Getenv("MINIO_SECRET_KEY"),
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
	// Storage credentials fail fast like the secrets above — a silent
	// default would ship a guessable credential to any deployment that
	// forgot the variables.
	if cfg.MinioAccessKey == "" || cfg.MinioSecretKey == "" {
		return nil, fmt.Errorf("MINIO_ACCESS_KEY and MINIO_SECRET_KEY are required")
	}
	// Session cookies derive their Secure flag from APP_URL; a TLS
	// deployment that forgot the variable would silently issue 30-day
	// cookies without Secure.
	if !strings.HasPrefix(cfg.AppURL, "https://") &&
		!strings.HasPrefix(cfg.AppURL, "http://localhost") &&
		!strings.HasPrefix(cfg.AppURL, "http://127.0.0.1") {
		slog.Warn("APP_URL is not https; session cookies will be issued without the Secure flag",
			"appUrl", cfg.AppURL)
	}
	proxies, err := parseTrustedProxies(os.Getenv("TRUSTED_PROXIES"))
	if err != nil {
		return nil, err
	}
	cfg.TrustedProxies = proxies
	return cfg, nil
}

// parseTrustedProxies reads a comma-separated CIDR list. A bare IP is treated
// as /32 or /128. Empty input uses the RFC1918 defaults so the TrueNAS /
// traefik docker network is trusted out of the box.
func parseTrustedProxies(raw string) ([]*net.IPNet, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		raw = defaultTrustedProxies
	}
	var nets []*net.IPNet
	for _, part := range strings.Split(raw, ",") {
		part = strings.TrimSpace(part)
		if part == "" {
			continue
		}
		if !strings.Contains(part, "/") {
			ip := net.ParseIP(part)
			if ip == nil {
				return nil, fmt.Errorf("TRUSTED_PROXIES: invalid address %q", part)
			}
			if ip.To4() != nil {
				part += "/32"
			} else {
				part += "/128"
			}
		}
		_, network, err := net.ParseCIDR(part)
		if err != nil {
			return nil, fmt.Errorf("TRUSTED_PROXIES: invalid CIDR %q: %w", part, err)
		}
		nets = append(nets, network)
	}
	if len(nets) == 0 {
		return nil, fmt.Errorf("TRUSTED_PROXIES: no networks provided")
	}
	return nets, nil
}

func getenv(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}
