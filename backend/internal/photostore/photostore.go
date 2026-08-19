// Package photostore resolves photo originals across pluggable backends.
// MinIO is always present. Immich is optional. Renditions stay in MinIO.
package photostore

import (
	"context"
	"fmt"
	"io"
	"time"

	"github.com/biker2000on/beez-trackz/backend/internal/config"
	"github.com/biker2000on/beez-trackz/backend/internal/storage"
)

const (
	BackendMinio  = config.PhotoBackendMinio
	BackendImmich = config.PhotoBackendImmich
)

// OriginalStore holds original photo bytes. Implementations must not be
// contacted at construction time.
type OriginalStore interface {
	Name() string
	Upload(ctx context.Context, name, contentType string, r io.Reader, size int64) (ref string, err error)
	Open(ctx context.Context, ref string) (io.ReadCloser, int64, string, error)
	Delete(ctx context.Context, ref string) error
	Health(ctx context.Context) error
}

// LibraryAsset is one Immich image as shown in the "link from library" picker.
type LibraryAsset struct {
	ID               string     `json:"id"`
	OriginalFileName string     `json:"originalFileName"`
	TakenAt          *time.Time `json:"takenAt,omitempty"`
}

// Resolver picks a backend for new uploads and opens existing originals.
type Resolver struct {
	minio  OriginalStore
	immich *Immich
	prefer string
}

// New builds a resolver from config. It never dials Immich.
func New(cfg *config.Config, store *storage.Store) *Resolver {
	r := &Resolver{
		minio:  newMinioStore(store),
		prefer: cfg.ResolvedPhotoBackend(),
	}
	if cfg.ImmichConfigured() {
		r.immich = NewImmich(cfg.ImmichBaseURL, cfg.ImmichAPIKey)
	}
	return r
}

func (r *Resolver) Preferred() string {
	if r == nil || r.prefer == "" {
		return BackendMinio
	}
	return r.prefer
}

func (r *Resolver) Fallback() string { return BackendMinio }

func (r *Resolver) ImmichConfigured() bool { return r != nil && r.immich != nil }

func (r *Resolver) Immich() *Immich {
	if r == nil {
		return nil
	}
	return r.immich
}

func (r *Resolver) Minio() OriginalStore {
	if r == nil {
		return nil
	}
	return r.minio
}

// OpenOriginal streams the original for a stored (backend, ref) pair.
func (r *Resolver) OpenOriginal(ctx context.Context, backend, ref string) (io.ReadCloser, int64, string, error) {
	if r == nil {
		return nil, 0, "", fmt.Errorf("photo store is not configured")
	}
	switch backend {
	case BackendMinio, "":
		if r.minio == nil {
			return nil, 0, "", fmt.Errorf("minio photo store is not configured")
		}
		return r.minio.Open(ctx, ref)
	case BackendImmich:
		if r.immich == nil {
			return nil, 0, "", fmt.Errorf("immich is not configured")
		}
		return r.immich.Open(ctx, ref)
	default:
		return nil, 0, "", fmt.Errorf("unknown photo backend %q", backend)
	}
}

// Upload tries preferred, then MinIO. fallback is true when Immich was
// preferred but the bytes landed in MinIO. external is true when Immich
// reported a checksum duplicate: the ref points at an asset that already lived
// in the user's library, so it must be treated as linked (never force-deleted).
func (r *Resolver) Upload(ctx context.Context, name, contentType string, body io.Reader, size int64, minioKey string) (backend, ref string, fallback, external bool, err error) {
	if r == nil {
		return "", "", false, false, fmt.Errorf("photo store is not configured")
	}
	if r.minio == nil {
		return "", "", false, false, fmt.Errorf("minio is not configured")
	}
	if r.Preferred() == BackendImmich && r.immich != nil {
		ref, duplicate, err := r.immich.UploadAsset(ctx, name, contentType, body, size)
		if err == nil {
			return BackendImmich, ref, false, duplicate, nil
		}
		if body, err = rewindUpload(body); err != nil {
			return "", "", true, false, fmt.Errorf("immich upload failed and the file could not be retried: %w", err)
		}
		if _, err := r.minio.Upload(ctx, minioKey, contentType, body, size); err != nil {
			return "", "", true, false, fmt.Errorf("immich upload failed and minio fallback failed: %w", err)
		}
		return BackendMinio, minioKey, true, false, nil
	}
	if _, err := r.minio.Upload(ctx, minioKey, contentType, body, size); err != nil {
		return "", "", false, false, err
	}
	return BackendMinio, minioKey, false, false, nil
}

// DeleteOriginal removes a Beez-owned original. Link-from-library rows must
// not call this for the Immich asset.
func (r *Resolver) DeleteOriginal(ctx context.Context, backend, ref string) error {
	if r == nil || ref == "" {
		return nil
	}
	switch backend {
	case BackendMinio, "":
		if r.minio == nil {
			return nil
		}
		return r.minio.Delete(ctx, ref)
	case BackendImmich:
		if r.immich == nil {
			return fmt.Errorf("immich is not configured")
		}
		return r.immich.Delete(ctx, ref)
	default:
		return fmt.Errorf("unknown photo backend %q", backend)
	}
}

func rewindUpload(r io.Reader) (io.Reader, error) {
	if seeker, ok := r.(io.Seeker); ok {
		if _, err := seeker.Seek(0, io.SeekStart); err != nil {
			return nil, err
		}
		return r, nil
	}
	return nil, fmt.Errorf("reader is not seekable")
}
