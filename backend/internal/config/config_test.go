package config

import "testing"

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
