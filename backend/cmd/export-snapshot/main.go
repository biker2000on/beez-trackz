package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"flag"
	"fmt"
	"io"
	"log"
	"os"
	"os/signal"
	"runtime/debug"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/minio/minio-go/v7"
	"github.com/minio/minio-go/v7/pkg/credentials"

	"github.com/biker2000on/beez-trackz/backend/internal/brand"
	"github.com/biker2000on/beez-trackz/backend/internal/config"
	"github.com/biker2000on/beez-trackz/backend/internal/db"
	"github.com/biker2000on/beez-trackz/backend/internal/snapshot"
)

type minioHasher struct {
	client *minio.Client
	bucket string
}

func (h *minioHasher) Hash(ctx context.Context, key string) (int64, string, error) {
	object, err := h.client.GetObject(ctx, h.bucket, key, minio.GetObjectOptions{})
	if err != nil {
		return 0, "", err
	}
	defer object.Close()
	hash := sha256.New()
	size, err := io.Copy(hash, object)
	if err != nil {
		return 0, "", err
	}
	return size, hex.EncodeToString(hash.Sum(nil)), nil
}

func main() {
	config.LoadDotEnv()
	defaultOutput := "snapshot-" + time.Now().UTC().Format("20060102T150405Z")
	databaseURL := flag.String("database-url", os.Getenv("DATABASE_URL"), "Postgres connection URL (or DATABASE_URL)")
	output := flag.String("output", defaultOutput, "new snapshot directory")
	appCommit := flag.String("app-commit", firstNonempty(os.Getenv("APP_COMMIT"), buildCommit()), brand.Product+" source commit")
	exporterVersion := flag.String("exporter-version", snapshot.ExporterVersion, "exporter build/version label")
	businessTimezone := flag.String("business-timezone", firstNonempty(os.Getenv("BUSINESS_TIMEZONE"), "UTC"), "named timezone for date-only business meaning")
	currency := flag.String("currency", firstNonempty(os.Getenv("CURRENCY_CODE"), "USD"), "ISO 4217 currency for integer money values")
	hashMinIO := flag.Bool("hash-minio", false, "read and SHA-256 hash required MinIO originals")
	minioEndpoint := flag.String("minio-endpoint", firstNonempty(os.Getenv("MINIO_ENDPOINT"), "localhost:9000"), "MinIO endpoint")
	minioBucket := flag.String("minio-bucket", firstNonempty(os.Getenv("MINIO_BUCKET"), "beeztrackz-media"), "MinIO bucket")
	minioAccessKey := flag.String("minio-access-key", os.Getenv("MINIO_ACCESS_KEY"), "MinIO access key (or MINIO_ACCESS_KEY)")
	minioSecretKey := flag.String("minio-secret-key", os.Getenv("MINIO_SECRET_KEY"), "MinIO secret key (or MINIO_SECRET_KEY)")
	minioSSL := flag.Bool("minio-use-ssl", envBool("MINIO_USE_SSL"), "connect to MinIO with TLS")
	// The one sanctioned exception to the schema generation guard (design
	// review OV3). It exists so the translate gate can read the database of
	// the previous generation, and it is read only: the pool sets
	// default_transaction_read_only and the guard refuses to grant the
	// exception unless that setting actually took.
	legacySource := flag.Bool("legacy-source", false,
		"read a database of the PREVIOUS schema generation, read only (for the pre-reset export)")
	flag.Parse()
	resolvedBrand, err := brand.Load()
	if err != nil {
		log.Fatalf("brand config: %v", err)
	}

	if strings.TrimSpace(*databaseURL) == "" {
		log.Fatal("DATABASE_URL or -database-url is required")
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	connect := db.ConnectWithoutMigrations
	if *legacySource {
		connect = db.ConnectLegacySource
	}
	pool, err := connect(ctx, *databaseURL)
	if err != nil {
		log.Fatal(err)
	}
	if *legacySource {
		log.Printf("reading %s as a legacy-generation source: the connection is read only", db.LegacyGeneration)
	}
	defer pool.Close()

	var hasher snapshot.ObjectHasher
	if *hashMinIO {
		if *minioAccessKey == "" || *minioSecretKey == "" {
			log.Fatal("-hash-minio requires MINIO_ACCESS_KEY and MINIO_SECRET_KEY (or matching flags)")
		}
		client, err := minio.New(*minioEndpoint, &minio.Options{
			Creds: credentials.NewStaticV4(*minioAccessKey, *minioSecretKey, ""), Secure: *minioSSL,
		})
		if err != nil {
			log.Fatalf("configure MinIO hashing: %v", err)
		}
		hasher = &minioHasher{client: client, bucket: *minioBucket}
	}

	result, err := snapshot.Export(ctx, pool, snapshot.ExportOptions{
		OutputDirectory: *output, AppCommit: firstNonempty(*appCommit, "unknown"),
		ExporterVersion: *exporterVersion, BusinessTimezone: *businessTimezone,
		Currency: strings.ToUpper(*currency), HashMinIO: *hashMinIO, ObjectHasher: hasher,
		Brand: resolvedBrand,
	})
	if err != nil {
		log.Fatal(err)
	}
	fmt.Printf("snapshot written to %s (formatVersion=%d, domains=%d, migration=%d)\n",
		result.Directory, result.Manifest.FormatVersion, len(result.Manifest.Files), result.Manifest.SchemaMigration)
}

func buildCommit() string {
	info, ok := debug.ReadBuildInfo()
	if !ok {
		return ""
	}
	for _, setting := range info.Settings {
		if setting.Key == "vcs.revision" {
			return setting.Value
		}
	}
	return ""
}

func firstNonempty(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return strings.TrimSpace(value)
		}
	}
	return ""
}

func envBool(key string) bool {
	value, err := strconv.ParseBool(os.Getenv(key))
	return err == nil && value
}
