package config

import (
	"bufio"
	"fmt"
	"log/slog"
	"net"
	"net/url"
	"os"
	"path/filepath"
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
	// Base URL printed into public Honey Story links and QR codes when the
	// stories are fronted by a different origin than the app (e.g. the apex
	// marketing domain proxying /honey/* to the app). Empty means AppURL.
	// Only public story URLs use this; auth, cookies, and internal links
	// stay on AppURL.
	PublicStoryBaseURL string

	// OIDC (optional — local login always available)
	OIDCIssuer       string
	OIDCClientID     string
	OIDCClientSecret string

	// TrustedProxies is the CIDR allowlist of reverse proxies whose
	// X-Forwarded-For / X-Real-IP headers may be used as the client address.
	TrustedProxies []*net.IPNet

	// Photo originals. MinIO is always present. Immich is optional.
	// PHOTO_STORAGE_BACKEND unset means Immich if configured, else MinIO.
	// Startup validates the shape of these values and never contacts Immich.
	PhotoStorageBackend string
	ImmichBaseURL       string
	ImmichAPIKey        string
}

const defaultTrustedProxies = "10.0.0.0/8,172.16.0.0/12,192.168.0.0/16"

func Load() (*Config, error) {
	cfg := &Config{
		ListenAddr:          getenv("LISTEN_ADDR", ":8080"),
		DatabaseURL:         os.Getenv("DATABASE_URL"),
		RedisURL:            getenv("REDIS_URL", "redis://localhost:6379"),
		MinioEndpoint:       getenv("MINIO_ENDPOINT", "localhost:9000"),
		MinioAccessKey:      os.Getenv("MINIO_ACCESS_KEY"),
		MinioSecretKey:      os.Getenv("MINIO_SECRET_KEY"),
		MinioUseSSL:         os.Getenv("MINIO_USE_SSL") == "true",
		MinioBucket:         getenv("MINIO_BUCKET", "beeztrackz-media"),
		SessionSecret:       os.Getenv("SESSION_SECRET"),
		AppURL:              getenv("APP_URL", "http://localhost:3000"),
		PublicStoryBaseURL:  strings.TrimSpace(os.Getenv("PUBLIC_STORY_BASE_URL")),
		OIDCIssuer:          os.Getenv("OIDC_ISSUER"),
		OIDCClientID:        os.Getenv("OIDC_CLIENT_ID"),
		OIDCClientSecret:    os.Getenv("OIDC_CLIENT_SECRET"),
		PhotoStorageBackend: strings.TrimSpace(strings.ToLower(os.Getenv("PHOTO_STORAGE_BACKEND"))),
		ImmichBaseURL:       strings.TrimSpace(os.Getenv("IMMICH_BASE_URL")),
		ImmichAPIKey:        strings.TrimSpace(os.Getenv("IMMICH_API_KEY")),
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
	if cfg.PublicStoryBaseURL != "" && !validHTTPBaseURL(cfg.PublicStoryBaseURL) {
		return nil, fmt.Errorf("PUBLIC_STORY_BASE_URL is not a valid http(s) URL")
	}
	if err := validatePhotoStorage(cfg); err != nil {
		return nil, err
	}
	return cfg, nil
}

// StoryBaseURL is the origin public Honey Story URLs are minted against:
// PublicStoryBaseURL when set, otherwise AppURL. Trailing slash stripped.
func (c *Config) StoryBaseURL() string {
	base := c.AppURL
	if c.PublicStoryBaseURL != "" {
		base = c.PublicStoryBaseURL
	}
	return strings.TrimRight(base, "/")
}

const (
	PhotoBackendMinio  = "minio"
	PhotoBackendImmich = "immich"
)

// ImmichConfigured is true when both the base URL and API key are set.
// It does not mean Immich is reachable.
func (c *Config) ImmichConfigured() bool {
	return c != nil && c.ImmichBaseURL != "" && c.ImmichAPIKey != ""
}

// ResolvedPhotoBackend is the backend new uploads try first. Explicit
// PHOTO_STORAGE_BACKEND always wins; otherwise Immich if configured, else MinIO.
func (c *Config) ResolvedPhotoBackend() string {
	if c == nil {
		return PhotoBackendMinio
	}
	switch c.PhotoStorageBackend {
	case PhotoBackendMinio, PhotoBackendImmich:
		return c.PhotoStorageBackend
	}
	if c.ImmichConfigured() {
		return PhotoBackendImmich
	}
	return PhotoBackendMinio
}

// validatePhotoStorage checks config shape only. Unreachable Immich is not a
// boot failure; a bad URL or a key without a URL is.
func validatePhotoStorage(cfg *Config) error {
	switch cfg.PhotoStorageBackend {
	case "", PhotoBackendMinio, PhotoBackendImmich:
	default:
		return fmt.Errorf("PHOTO_STORAGE_BACKEND must be minio, immich, or unset")
	}
	if cfg.ImmichAPIKey != "" && cfg.ImmichBaseURL == "" {
		return fmt.Errorf("IMMICH_API_KEY requires IMMICH_BASE_URL")
	}
	if cfg.ImmichBaseURL != "" {
		if !validHTTPBaseURL(cfg.ImmichBaseURL) {
			return fmt.Errorf("IMMICH_BASE_URL is not a valid http(s) URL")
		}
		if cfg.ImmichAPIKey == "" {
			return fmt.Errorf("IMMICH_BASE_URL requires IMMICH_API_KEY")
		}
	}
	if cfg.PhotoStorageBackend == PhotoBackendImmich && !cfg.ImmichConfigured() {
		return fmt.Errorf("PHOTO_STORAGE_BACKEND=immich requires IMMICH_BASE_URL and IMMICH_API_KEY")
	}
	return nil
}

func validHTTPBaseURL(raw string) bool {
	parsed, err := url.Parse(raw)
	return err == nil && (parsed.Scheme == "http" || parsed.Scheme == "https") && parsed.Host != ""
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

// LoadDotEnv fills unset process env from nearby .env files so local CLI
// tools can run from backend/ or the repo root without a manual export.
// Existing environment variables always win, including empty values set by
// tests. The production server and worker do not call this — they take env
// from the process (compose / systemd), never a cwd .env.
func LoadDotEnv() {
	for _, path := range []string{
		filepath.Join("..", ".env"),
		filepath.Join("..", ".env.local"),
		filepath.Join("backend", ".env"),
		filepath.Join("backend", ".env.local"),
		".env",
		".env.local",
	} {
		applyEnvFile(path)
	}
}

func applyEnvFile(path string) {
	file, err := os.Open(path)
	if err != nil {
		return
	}
	defer file.Close()
	scanner := bufio.NewScanner(file)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		key, value, ok := strings.Cut(line, "=")
		if !ok {
			continue
		}
		key = strings.TrimSpace(key)
		if key == "" {
			continue
		}
		if _, exists := os.LookupEnv(key); exists {
			continue
		}
		value = strings.TrimSpace(value)
		if len(value) >= 2 {
			if q := value[0]; (q == '"' || q == '\'') && value[len(value)-1] == q {
				value = value[1 : len(value)-1]
			}
		}
		_ = os.Setenv(key, value)
	}
}
