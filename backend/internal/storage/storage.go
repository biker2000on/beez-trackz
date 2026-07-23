package storage

import (
	"context"
	"fmt"
	"io"
	"net/url"
	"time"

	"github.com/minio/minio-go/v7"
	"github.com/minio/minio-go/v7/pkg/credentials"

	"github.com/biker2000on/beez-trackz/backend/internal/config"
)

// Store wraps MinIO access for photo and audio objects.
type Store struct {
	client *minio.Client
	bucket string
}

func New(ctx context.Context, cfg *config.Config) (*Store, error) {
	client, err := minio.New(cfg.MinioEndpoint, &minio.Options{
		Creds:  credentials.NewStaticV4(cfg.MinioAccessKey, cfg.MinioSecretKey, ""),
		Secure: cfg.MinioUseSSL,
	})
	if err != nil {
		return nil, fmt.Errorf("minio client: %w", err)
	}
	s := &Store{client: client, bucket: cfg.MinioBucket}
	exists, err := client.BucketExists(ctx, s.bucket)
	if err != nil {
		return nil, fmt.Errorf("minio bucket check: %w", err)
	}
	if !exists {
		if err := client.MakeBucket(ctx, s.bucket, minio.MakeBucketOptions{}); err != nil {
			return nil, fmt.Errorf("minio make bucket: %w", err)
		}
	}
	return s, nil
}

func (s *Store) Put(ctx context.Context, key string, r io.Reader, size int64, contentType string) error {
	_, err := s.client.PutObject(ctx, s.bucket, key, r, size, minio.PutObjectOptions{ContentType: contentType})
	return err
}

func (s *Store) Get(ctx context.Context, key string) (*minio.Object, error) {
	return s.client.GetObject(ctx, s.bucket, key, minio.GetObjectOptions{})
}

func (s *Store) Stat(ctx context.Context, key string) (minio.ObjectInfo, error) {
	return s.client.StatObject(ctx, s.bucket, key, minio.StatObjectOptions{})
}

func (s *Store) Delete(ctx context.Context, key string) error {
	return s.client.RemoveObject(ctx, s.bucket, key, minio.RemoveObjectOptions{})
}

// PresignedGet returns a time-limited URL for direct download.
func (s *Store) PresignedGet(ctx context.Context, key string, expiry time.Duration) (*url.URL, error) {
	return s.client.PresignedGetObject(ctx, s.bucket, key, expiry, nil)
}
