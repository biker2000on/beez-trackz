package photostore

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/biker2000on/beez-trackz/backend/internal/config"
)

type memStore struct {
	objects map[string][]byte
	fail    bool
}

func (m *memStore) Name() string { return BackendMinio }

func (m *memStore) Upload(_ context.Context, name, _ string, r io.Reader, _ int64) (string, error) {
	if m.fail {
		return "", fmt.Errorf("minio down")
	}
	data, err := io.ReadAll(r)
	if err != nil {
		return "", err
	}
	if m.objects == nil {
		m.objects = map[string][]byte{}
	}
	m.objects[name] = data
	return name, nil
}

func (m *memStore) Open(_ context.Context, ref string) (io.ReadCloser, int64, string, error) {
	data, ok := m.objects[ref]
	if !ok {
		return nil, 0, "", fmt.Errorf("missing")
	}
	return io.NopCloser(bytes.NewReader(data)), int64(len(data)), "image/jpeg", nil
}

func (m *memStore) Delete(_ context.Context, ref string) error {
	delete(m.objects, ref)
	return nil
}

func (m *memStore) Health(context.Context) error { return nil }

func TestResolverUploadFallsBackToMinioWhenImmichDown(t *testing.T) {
	immich := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "down", http.StatusBadGateway)
	}))
	t.Cleanup(immich.Close)

	minio := &memStore{}
	r := &Resolver{
		minio:  minio,
		immich: NewImmich(immich.URL, "key"),
		prefer: BackendImmich,
	}
	backend, ref, fallback, err := r.Upload(context.Background(), "hive.jpg", "image/jpeg",
		bytes.NewReader([]byte("abc")), 3, "photos/hive/1.jpg")
	if err != nil {
		t.Fatalf("upload: %v", err)
	}
	if backend != BackendMinio || !fallback || ref != "photos/hive/1.jpg" {
		t.Fatalf("backend=%s ref=%s fallback=%v", backend, ref, fallback)
	}
	if string(minio.objects[ref]) != "abc" {
		t.Fatalf("minio object = %q", minio.objects[ref])
	}
}

func TestResolvedPhotoBackendDecision(t *testing.T) {
	cfg := &config.Config{}
	if cfg.ResolvedPhotoBackend() != BackendMinio {
		t.Fatal("empty config should be minio")
	}
	cfg.ImmichBaseURL = "https://photos.example"
	cfg.ImmichAPIKey = "k"
	if cfg.ResolvedPhotoBackend() != BackendImmich {
		t.Fatal("configured immich should be the default")
	}
	cfg.PhotoStorageBackend = BackendMinio
	if cfg.ResolvedPhotoBackend() != BackendMinio {
		t.Fatal("explicit minio should win")
	}
}
