package config

import (
	"net"
	"testing"
)

// ASI-2-001 seed / ASI-3-008: config had zero tests, and MinIO credentials
// silently fell back to a guessable default instead of failing fast.
func TestLoadRequiresCoreSecrets(t *testing.T) {
	t.Setenv("DATABASE_URL", "postgres://example/db")
	t.Setenv("SESSION_SECRET", "test-secret")
	t.Setenv("MINIO_ACCESS_KEY", "")
	t.Setenv("MINIO_SECRET_KEY", "")

	if _, err := Load(); err == nil {
		t.Fatal("missing MinIO credentials were accepted")
	}

	t.Setenv("MINIO_ACCESS_KEY", "access")
	t.Setenv("MINIO_SECRET_KEY", "secret")
	cfg, err := Load()
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	if cfg.MinioAccessKey != "access" || cfg.MinioSecretKey != "secret" {
		t.Errorf("minio credentials = %q/%q", cfg.MinioAccessKey, cfg.MinioSecretKey)
	}

	t.Setenv("DATABASE_URL", "")
	if _, err := Load(); err == nil {
		t.Error("missing DATABASE_URL was accepted")
	}
}

func TestLoadDefaultTrustedProxiesAreRFC1918(t *testing.T) {
	t.Setenv("DATABASE_URL", "postgres://example/db")
	t.Setenv("SESSION_SECRET", "test-secret")
	t.Setenv("MINIO_ACCESS_KEY", "access")
	t.Setenv("MINIO_SECRET_KEY", "secret")
	t.Setenv("TRUSTED_PROXIES", "")

	cfg, err := Load()
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	for _, ip := range []string{"10.1.2.3", "172.18.0.5", "192.168.4.1"} {
		if !ipInTrusted(cfg.TrustedProxies, ip) {
			t.Errorf("%s should be a default trusted proxy", ip)
		}
	}
	if ipInTrusted(cfg.TrustedProxies, "203.0.113.9") {
		t.Error("public documentation IP was treated as a trusted proxy")
	}
}

func TestLoadParsesCustomTrustedProxies(t *testing.T) {
	t.Setenv("DATABASE_URL", "postgres://example/db")
	t.Setenv("SESSION_SECRET", "test-secret")
	t.Setenv("MINIO_ACCESS_KEY", "access")
	t.Setenv("MINIO_SECRET_KEY", "secret")
	t.Setenv("TRUSTED_PROXIES", "127.0.0.1,2001:db8::/32")

	cfg, err := Load()
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	if !ipInTrusted(cfg.TrustedProxies, "127.0.0.1") {
		t.Error("bare IPv4 was not treated as /32")
	}
	if !ipInTrusted(cfg.TrustedProxies, "2001:db8::1") {
		t.Error("IPv6 CIDR was not trusted")
	}
	if ipInTrusted(cfg.TrustedProxies, "10.0.0.1") {
		t.Error("default RFC1918 range leaked into a custom allowlist")
	}
}

func TestLoadRejectsInvalidTrustedProxies(t *testing.T) {
	t.Setenv("DATABASE_URL", "postgres://example/db")
	t.Setenv("SESSION_SECRET", "test-secret")
	t.Setenv("MINIO_ACCESS_KEY", "access")
	t.Setenv("MINIO_SECRET_KEY", "secret")
	t.Setenv("TRUSTED_PROXIES", "not-a-cidr")

	if _, err := Load(); err == nil {
		t.Fatal("invalid TRUSTED_PROXIES was accepted")
	}
}

func ipInTrusted(nets []*net.IPNet, raw string) bool {
	ip := net.ParseIP(raw)
	if ip == nil {
		return false
	}
	for _, network := range nets {
		if network.Contains(ip) {
			return true
		}
	}
	return false
}
