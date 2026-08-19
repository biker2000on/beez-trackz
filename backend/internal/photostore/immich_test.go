package photostore

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestImmichClientUploadOpenDeleteAndSearch(t *testing.T) {
	var deleted []string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("x-api-key") != "test-key" {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		switch {
		case r.Method == http.MethodGet && r.URL.Path == "/api/server/ping":
			_, _ = w.Write([]byte(`{"res":"pong"}`))
		case r.Method == http.MethodPost && r.URL.Path == "/api/assets":
			if err := r.ParseMultipartForm(1 << 20); err != nil {
				http.Error(w, err.Error(), http.StatusBadRequest)
				return
			}
			if r.FormValue("deviceId") != immichDeviceID {
				http.Error(w, "missing device", http.StatusBadRequest)
				return
			}
			if _, _, err := r.FormFile("assetData"); err != nil {
				http.Error(w, "missing asset", http.StatusBadRequest)
				return
			}
			_ = json.NewEncoder(w).Encode(map[string]any{"id": "asset-1", "duplicate": false})
		case r.Method == http.MethodGet && r.URL.Path == "/api/assets/asset-1/original":
			w.Header().Set("Content-Type", "image/jpeg")
			_, _ = w.Write([]byte("jpeg-bytes"))
		case r.Method == http.MethodGet && r.URL.Path == "/api/assets/asset-1":
			_ = json.NewEncoder(w).Encode(map[string]any{"id": "asset-1"})
		case r.Method == http.MethodDelete && r.URL.Path == "/api/assets":
			var body struct {
				IDs []string `json:"ids"`
			}
			_ = json.NewDecoder(r.Body).Decode(&body)
			deleted = append(deleted, body.IDs...)
			w.WriteHeader(http.StatusNoContent)
		case r.Method == http.MethodPost && r.URL.Path == "/api/search/metadata":
			_ = json.NewEncoder(w).Encode(map[string]any{
				"assets": map[string]any{
					"items": []map[string]any{{
						"id":               "asset-1",
						"originalFileName": "hive.jpg",
						"fileCreatedAt":    time.Date(2026, 6, 1, 12, 0, 0, 0, time.UTC).Format(time.RFC3339),
					}},
					"nextPage": "2",
				},
			})
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(server.Close)

	client := NewImmich(server.URL, "test-key")
	ctx := context.Background()
	if err := client.Health(ctx); err != nil {
		t.Fatalf("health: %v", err)
	}
	id, err := client.Upload(ctx, "hive.jpg", "image/jpeg", bytes.NewReader([]byte("abc")), 3)
	if err != nil {
		t.Fatalf("upload: %v", err)
	}
	if id != "asset-1" {
		t.Fatalf("upload id = %q", id)
	}
	rc, size, ct, err := client.Open(ctx, "asset-1")
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	data, _ := io.ReadAll(rc)
	rc.Close()
	if string(data) != "jpeg-bytes" || !strings.Contains(ct, "image/jpeg") {
		t.Fatalf("open = %q %q size=%d", data, ct, size)
	}
	if err := client.AssetExists(ctx, "asset-1"); err != nil {
		t.Fatalf("exists: %v", err)
	}
	if err := client.Delete(ctx, "asset-1"); err != nil {
		t.Fatalf("delete: %v", err)
	}
	if len(deleted) != 1 || deleted[0] != "asset-1" {
		t.Fatalf("deleted = %#v", deleted)
	}
	items, next, err := client.ListImages(ctx, 1, 24)
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if next != "2" || len(items) != 1 || items[0].OriginalFileName != "hive.jpg" {
		t.Fatalf("list = %#v next=%q", items, next)
	}
}

func TestImmichHealthReportsUnreachable(t *testing.T) {
	client := NewImmich("http://127.0.0.1:1", "key")
	ctx, cancel := context.WithTimeout(context.Background(), 500*time.Millisecond)
	defer cancel()
	if err := client.Health(ctx); err == nil {
		t.Fatal("expected unreachable Immich to fail the probe")
	}
}

func TestImmichUploadErrorDoesNotLookLikeSuccess(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "down", http.StatusBadGateway)
	}))
	t.Cleanup(server.Close)
	client := NewImmich(server.URL, "key")
	_, err := client.Upload(context.Background(), "a.jpg", "image/jpeg", bytes.NewReader([]byte("x")), 1)
	if err == nil {
		t.Fatal("expected upload error")
	}
}

func TestImmichUploadDuplicateIsReportedAsExternal(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodPost && r.URL.Path == "/api/assets" {
			// Immich answers 200 (not 201) with status=duplicate when the
			// checksum already exists in the user's library.
			_ = json.NewEncoder(w).Encode(map[string]any{"id": "lib-asset", "status": "duplicate"})
			return
		}
		http.NotFound(w, r)
	}))
	t.Cleanup(server.Close)

	r := &Resolver{
		minio:  &memStore{},
		immich: NewImmich(server.URL, "key"),
		prefer: BackendImmich,
	}
	backend, ref, fallback, external, err := r.Upload(context.Background(), "hive.jpg", "image/jpeg",
		bytes.NewReader([]byte("abc")), 3, "photos/hive/1.jpg")
	if err != nil {
		t.Fatalf("upload: %v", err)
	}
	if backend != BackendImmich || ref != "lib-asset" || fallback || !external {
		t.Fatalf("backend=%s ref=%s fallback=%v external=%v, want immich duplicate marked external",
			backend, ref, fallback, external)
	}
}
