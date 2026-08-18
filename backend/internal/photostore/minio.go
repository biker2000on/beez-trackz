package photostore

import (
	"context"
	"fmt"
	"io"

	"github.com/biker2000on/beez-trackz/backend/internal/storage"
)

// minioStore writes originals (and is reused for Beez-owned renditions).
type minioStore struct {
	store *storage.Store
}

func newMinioStore(store *storage.Store) *minioStore {
	return &minioStore{store: store}
}

func (m *minioStore) Name() string { return BackendMinio }

func (m *minioStore) Upload(ctx context.Context, name, contentType string, r io.Reader, size int64) (string, error) {
	if err := m.PutKey(ctx, name, r, size, contentType); err != nil {
		return "", err
	}
	return name, nil
}

func (m *minioStore) PutKey(ctx context.Context, key string, r io.Reader, size int64, contentType string) error {
	if m == nil || m.store == nil {
		return fmt.Errorf("minio is not configured")
	}
	return m.store.Put(ctx, key, r, size, contentType)
}

func (m *minioStore) Open(ctx context.Context, ref string) (io.ReadCloser, int64, string, error) {
	if m == nil || m.store == nil {
		return nil, 0, "", fmt.Errorf("minio is not configured")
	}
	info, err := m.store.Stat(ctx, ref)
	if err != nil {
		return nil, 0, "", err
	}
	obj, err := m.store.Get(ctx, ref)
	if err != nil {
		return nil, 0, "", err
	}
	return obj, info.Size, info.ContentType, nil
}

func (m *minioStore) Delete(ctx context.Context, ref string) error {
	if m == nil || m.store == nil || ref == "" {
		return nil
	}
	return m.store.Delete(ctx, ref)
}

func (m *minioStore) Health(ctx context.Context) error {
	if m == nil || m.store == nil {
		return fmt.Errorf("minio is not configured")
	}
	return nil
}
