package photostore

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"net/url"
	"path"
	"strings"
	"time"

	"github.com/google/uuid"
)

const (
	immichMaxResponseBytes = 32 << 20
	immichDeviceID         = "beez-trackz"
)

// Immich is a small client for the Immich REST API we actually call.
type Immich struct {
	baseURL    string
	apiKey     string
	httpClient *http.Client
}

// NewImmich constructs a client. It does not contact the server.
func NewImmich(baseURL, apiKey string) *Immich {
	return &Immich{
		baseURL: strings.TrimRight(strings.TrimSpace(baseURL), "/"),
		apiKey:  strings.TrimSpace(apiKey),
		httpClient: &http.Client{
			Timeout: 60 * time.Second,
		},
	}
}

func (c *Immich) Name() string { return BackendImmich }

func (c *Immich) url(p string) string {
	return c.baseURL + p
}

func (c *Immich) setAuth(req *http.Request) {
	req.Header.Set("x-api-key", c.apiKey)
	req.Header.Set("Accept", "application/json")
}

func (c *Immich) do(req *http.Request) (*http.Response, error) {
	c.setAuth(req)
	return c.httpClient.Do(req)
}

func (c *Immich) Health(ctx context.Context) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.url("/api/server/ping"), nil)
	if err != nil {
		return err
	}
	resp, err := c.do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 300 {
		return fmt.Errorf("immich ping: HTTP %d", resp.StatusCode)
	}
	return nil
}

func (c *Immich) Upload(ctx context.Context, name, contentType string, r io.Reader, size int64) (string, error) {
	if name == "" {
		name = "photo.jpg"
	}
	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	now := time.Now().UTC().Format(time.RFC3339)
	for _, field := range [][2]string{
		{"deviceAssetId", "beez-" + uuid.NewString()},
		{"deviceId", immichDeviceID},
		{"fileCreatedAt", now},
		{"fileModifiedAt", now},
	} {
		if err := writer.WriteField(field[0], field[1]); err != nil {
			return "", err
		}
	}
	part, err := writer.CreatePart(mapHeader(name, contentType))
	if err != nil {
		return "", err
	}
	if size >= 0 {
		if _, err := io.CopyN(part, r, size); err != nil && err != io.EOF {
			return "", err
		}
	} else if _, err := io.Copy(part, r); err != nil {
		return "", err
	}
	if err := writer.Close(); err != nil {
		return "", err
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.url("/api/assets"), &body)
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", writer.FormDataContentType())
	resp, err := c.do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	payload, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return "", err
	}
	if resp.StatusCode >= 300 {
		return "", fmt.Errorf("immich upload: HTTP %d: %s", resp.StatusCode, truncate(string(payload), 200))
	}
	var out struct {
		ID string `json:"id"`
	}
	if err := json.Unmarshal(payload, &out); err != nil || out.ID == "" {
		return "", fmt.Errorf("immich upload: missing asset id")
	}
	return out.ID, nil
}

func mapHeader(name, contentType string) map[string][]string {
	if contentType == "" {
		contentType = "application/octet-stream"
	}
	return map[string][]string{
		"Content-Disposition": {`form-data; name="assetData"; filename="` + escapeQuotes(path.Base(name)) + `"`},
		"Content-Type":        {contentType},
	}
}

func escapeQuotes(s string) string {
	return strings.ReplaceAll(s, `"`, `\"`)
}

func (c *Immich) Open(ctx context.Context, ref string) (io.ReadCloser, int64, string, error) {
	return c.openPath(ctx, "/api/assets/"+url.PathEscape(ref)+"/original")
}

func (c *Immich) OpenThumbnail(ctx context.Context, ref string) (io.ReadCloser, int64, string, error) {
	return c.openPath(ctx, "/api/assets/"+url.PathEscape(ref)+"/thumbnail")
}

func (c *Immich) openPath(ctx context.Context, p string) (io.ReadCloser, int64, string, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.url(p), nil)
	if err != nil {
		return nil, 0, "", err
	}
	req.Header.Set("Accept", "*/*")
	resp, err := c.do(req)
	if err != nil {
		return nil, 0, "", err
	}
	if resp.StatusCode >= 300 {
		defer resp.Body.Close()
		return nil, 0, "", fmt.Errorf("immich fetch: HTTP %d", resp.StatusCode)
	}
	ct := resp.Header.Get("Content-Type")
	if ct == "" {
		ct = "application/octet-stream"
	}
	return resp.Body, resp.ContentLength, ct, nil
}

func (c *Immich) Delete(ctx context.Context, ref string) error {
	payload, err := json.Marshal(map[string]any{"ids": []string{ref}, "force": true})
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodDelete, c.url("/api/assets"), bytes.NewReader(payload))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := c.do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 300 {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
		return fmt.Errorf("immich delete: HTTP %d: %s", resp.StatusCode, truncate(string(body), 200))
	}
	return nil
}

// AssetExists reports whether Immich knows this asset id.
func (c *Immich) AssetExists(ctx context.Context, ref string) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.url("/api/assets/"+url.PathEscape(ref)), nil)
	if err != nil {
		return err
	}
	resp, err := c.do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusNotFound {
		return fmt.Errorf("immich asset not found")
	}
	if resp.StatusCode >= 300 {
		return fmt.Errorf("immich asset: HTTP %d", resp.StatusCode)
	}
	return nil
}

// ListImages returns one page of Immich images. It does not walk the library.
func (c *Immich) ListImages(ctx context.Context, page, size int) ([]LibraryAsset, string, error) {
	if page < 1 {
		page = 1
	}
	if size < 1 || size > 100 {
		size = 24
	}
	payload, err := json.Marshal(map[string]any{
		"type": "IMAGE",
		"page": page,
		"size": size,
	})
	if err != nil {
		return nil, "", err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.url("/api/search/metadata"), bytes.NewReader(payload))
	if err != nil {
		return nil, "", err
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := c.do(req)
	if err != nil {
		return nil, "", err
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, immichMaxResponseBytes))
	if err != nil {
		return nil, "", err
	}
	if resp.StatusCode >= 300 {
		return nil, "", fmt.Errorf("immich search: HTTP %d: %s", resp.StatusCode, truncate(string(body), 200))
	}
	var out struct {
		Assets struct {
			Items []struct {
				ID               string  `json:"id"`
				OriginalFileName string  `json:"originalFileName"`
				FileCreatedAt    *string `json:"fileCreatedAt"`
				LocalDateTime    *string `json:"localDateTime"`
			} `json:"items"`
			NextPage *string `json:"nextPage"`
		} `json:"assets"`
	}
	if err := json.Unmarshal(body, &out); err != nil {
		return nil, "", fmt.Errorf("immich search: decode: %w", err)
	}
	items := make([]LibraryAsset, 0, len(out.Assets.Items))
	for _, item := range out.Assets.Items {
		asset := LibraryAsset{ID: item.ID, OriginalFileName: item.OriginalFileName}
		if raw := firstNonEmpty(item.LocalDateTime, item.FileCreatedAt); raw != nil {
			if t, err := time.Parse(time.RFC3339, *raw); err == nil {
				asset.TakenAt = &t
			}
		}
		items = append(items, asset)
	}
	next := ""
	if out.Assets.NextPage != nil {
		next = *out.Assets.NextPage
	}
	return items, next, nil
}

func firstNonEmpty(values ...*string) *string {
	for _, v := range values {
		if v != nil && *v != "" {
			return v
		}
	}
	return nil
}

func truncate(s string, n int) string {
	s = strings.TrimSpace(s)
	if len(s) <= n {
		return s
	}
	return s[:n]
}
