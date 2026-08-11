package httpapi

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"path"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/hibiken/asynq"
	"github.com/jackc/pgx/v5"
	"github.com/minio/minio-go/v7"

	"github.com/biker2000on/beez-trackz/backend/internal/jobs"
)

const photoMaxUploadBytes = 10 << 20 // 10MB

var photoOwnerTypes = map[string]bool{"hive": true, "apiary": true, "inspection": true}

var photoFilenameSanitizer = regexp.MustCompile(`[^a-zA-Z0-9._-]`)

// photoSanitizeFilename replaces any character outside [a-zA-Z0-9._-] with "_".
func photoSanitizeFilename(name string) string {
	return photoFilenameSanitizer.ReplaceAllString(name, "_")
}

// photoContentTypes maps lower-case file extensions to MIME types for serving.
var photoContentTypes = map[string]string{
	".jpg":  "image/jpeg",
	".jpeg": "image/jpeg",
	".png":  "image/png",
	".gif":  "image/gif",
	".webp": "image/webp",
	".bmp":  "image/bmp",
}

func photoContentTypeForKey(key string) string {
	if ct, ok := photoContentTypes[strings.ToLower(path.Ext(key))]; ok {
		return ct
	}
	return "application/octet-stream"
}

// photoAllowedContentTypes is the upload whitelist: exactly the types this
// server is willing to serve back. Anything else — most importantly
// text/html — is rejected at upload rather than stored and replayed
// (stored-XSS via a client-controlled Content-Type).
var photoAllowedContentTypes = func() map[string]bool {
	allowed := make(map[string]bool, len(photoContentTypes))
	for _, ct := range photoContentTypes {
		allowed[ct] = true
	}
	return allowed
}()

// photoFileURL builds the API URL that streams a MinIO object key.
func photoFileURL(key *string) *string {
	if key == nil || *key == "" {
		return nil
	}
	u := "/api/v1/photos/file/" + *key
	return &u
}

func (s *Server) mountPhotos(r chi.Router) {
	r.Route("/photos", func(r chi.Router) {
		r.Post("/", s.handlePhotoUpload)
		r.Get("/", s.handlePhotoList)
		r.With(s.requireEntityParamRole("photo", true)).Patch("/{id}", s.handlePhotoUpdate)
		r.With(s.requireEntityParamRole("photo", true)).Delete("/{id}", s.handlePhotoDelete)
		r.Get("/file/*", s.handlePhotoFile)
	})
}

type photoResponse struct {
	ID           string     `json:"id"`
	OwnerType    string     `json:"ownerType"`
	OwnerID      string     `json:"ownerId"`
	Caption      *string    `json:"caption"`
	Tags         []string   `json:"tags"`
	TakenDate    *time.Time `json:"takenDate"`
	CreatedAt    time.Time  `json:"createdAt"`
	OriginalURL  *string    `json:"originalUrl"`
	ThumbnailURL *string    `json:"thumbnailUrl"`
	MediumURL    *string    `json:"mediumUrl"`
}

// POST /photos — multipart upload: file, ownerType, ownerId, caption?, tags? (JSON string array).
func (s *Server) handlePhotoUpload(w http.ResponseWriter, r *http.Request) {
	// Bound the request body a bit above the file limit to leave room for the
	// other multipart fields; the exact file-size check happens below.
	r.Body = http.MaxBytesReader(w, r.Body, photoMaxUploadBytes+(1<<20))
	if err := r.ParseMultipartForm(photoMaxUploadBytes); err != nil {
		var maxErr *http.MaxBytesError
		if errors.As(err, &maxErr) {
			writeError(w, http.StatusBadRequest, "Photo must be under 10MB")
			return
		}
		writeError(w, http.StatusBadRequest, "invalid multipart form")
		return
	}

	file, header, err := r.FormFile("file")
	if err != nil {
		writeError(w, http.StatusBadRequest, "Photo file is required")
		return
	}
	defer file.Close()
	if header.Size == 0 {
		writeError(w, http.StatusBadRequest, "Photo file is required")
		return
	}
	if header.Size > photoMaxUploadBytes {
		writeError(w, http.StatusBadRequest, "Photo must be under 10MB")
		return
	}

	ownerType := r.FormValue("ownerType")
	if ownerType == "" {
		writeError(w, http.StatusBadRequest, "Owner type is required")
		return
	}
	if !photoOwnerTypes[ownerType] {
		writeError(w, http.StatusBadRequest, "Invalid owner type")
		return
	}
	ownerID, err := uuid.Parse(r.FormValue("ownerId"))
	if err != nil {
		writeError(w, http.StatusBadRequest, "Owner ID is required")
		return
	}
	if !s.requireOwnerRole(w, r, ownerType, ownerID, true) {
		return
	}

	var caption *string
	if c := strings.TrimSpace(r.FormValue("caption")); c != "" {
		caption = &c
	}
	var tags []string
	if tagsJSON := r.FormValue("tags"); tagsJSON != "" {
		if err := json.Unmarshal([]byte(tagsJSON), &tags); err != nil {
			tags = nil // legacy behavior: unparseable tags are dropped
		}
	}

	contentType := strings.TrimSpace(
		strings.SplitN(header.Header.Get("Content-Type"), ";", 2)[0])
	if contentType == "" || contentType == "application/octet-stream" {
		contentType = photoContentTypeForKey(header.Filename)
	}
	if !photoAllowedContentTypes[contentType] {
		writeError(w, http.StatusBadRequest,
			"Unsupported photo type; use JPEG, PNG, GIF, WebP, or BMP")
		return
	}

	key := fmt.Sprintf("photos/%s/%s/%d_%s",
		ownerType, ownerID, time.Now().UnixMilli(), photoSanitizeFilename(header.Filename))

	ctx := r.Context()
	if err := s.store.Put(ctx, key, file, header.Size, contentType); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to store photo")
		return
	}

	var photoID string
	err = s.pool.QueryRow(ctx, `
		INSERT INTO photos (owner_type, owner_id, original_key, taken_date, caption, tags)
		VALUES ($1, $2, $3, now(), $4, $5)
		RETURNING id`,
		ownerType, ownerID, key, caption, tags).Scan(&photoID)
	if err != nil {
		_ = s.store.Delete(ctx, key)
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}

	payload, _ := json.Marshal(jobs.ProcessImagePayload{PhotoID: photoID})
	if _, err := s.queue.EnqueueContext(ctx,
		asynq.NewTask(jobs.TypeProcessImage, payload), asynq.MaxRetry(3)); err != nil {
		// Compensate like the insert-failure path above: without this the
		// photo row survives with no thumbnail job (and no repair sweep
		// exists), and the client's retry duplicates the photo.
		_, _ = s.pool.Exec(ctx, `DELETE FROM photos WHERE id = $1`, photoID)
		_ = s.store.Delete(ctx, key)
		writeError(w, http.StatusInternalServerError, "failed to enqueue image processing")
		return
	}

	writeJSON(w, http.StatusOK, map[string]any{"success": true, "photoId": photoID})
}

// GET /photos?ownerType=&ownerId= — list photos for an owner, newest first.
func (s *Server) handlePhotoList(w http.ResponseWriter, r *http.Request) {
	ownerType := r.URL.Query().Get("ownerType")
	if !photoOwnerTypes[ownerType] {
		writeError(w, http.StatusBadRequest, "Invalid owner type")
		return
	}
	ownerID, err := uuid.Parse(r.URL.Query().Get("ownerId"))
	if err != nil {
		writeError(w, http.StatusBadRequest, "Owner ID is required")
		return
	}
	if !s.requireOwnerRole(w, r, ownerType, ownerID, false) {
		return
	}

	rows, err := s.pool.Query(r.Context(), `
		SELECT id, owner_type, owner_id, original_key, thumbnail_key, medium_key,
		       taken_date, caption, tags, created_at
		FROM photos
		WHERE owner_type = $1 AND owner_id = $2
		ORDER BY created_at DESC`,
		ownerType, ownerID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	defer rows.Close()

	list := []photoResponse{}
	for rows.Next() {
		var (
			p            photoResponse
			originalKey  string
			thumbnailKey *string
			mediumKey    *string
		)
		if err := rows.Scan(&p.ID, &p.OwnerType, &p.OwnerID, &originalKey, &thumbnailKey,
			&mediumKey, &p.TakenDate, &p.Caption, &p.Tags, &p.CreatedAt); err != nil {
			writeError(w, http.StatusInternalServerError, "database error")
			return
		}
		p.OriginalURL = photoFileURL(&originalKey)
		p.ThumbnailURL = photoFileURL(thumbnailKey)
		p.MediumURL = photoFileURL(mediumKey)
		list = append(list, p)
	}
	if rows.Err() != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	writeJSON(w, http.StatusOK, list)
}

// PATCH /photos/{id} {caption?, tags?}
func (s *Server) handlePhotoUpdate(w http.ResponseWriter, r *http.Request) {
	id, err := uuidParam(r, "id")
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	var req struct {
		Caption *string   `json:"caption"`
		Tags    *[]string `json:"tags"`
	}
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}

	sets := []string{}
	args := []any{id}
	if req.Caption != nil {
		var caption *string
		if c := strings.TrimSpace(*req.Caption); c != "" {
			caption = &c
		}
		args = append(args, caption)
		sets = append(sets, "caption = $"+strconv.Itoa(len(args)))
	}
	if req.Tags != nil {
		args = append(args, *req.Tags)
		sets = append(sets, "tags = $"+strconv.Itoa(len(args)))
	}
	if len(sets) == 0 {
		writeJSON(w, http.StatusOK, map[string]any{"success": true})
		return
	}

	tag, err := s.pool.Exec(r.Context(),
		"UPDATE photos SET "+strings.Join(sets, ", ")+" WHERE id = $1", args...)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	if tag.RowsAffected() == 0 {
		writeError(w, http.StatusNotFound, "Photo not found")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"success": true})
}

// DELETE /photos/{id} — remove MinIO objects (ignoring missing) then the row.
func (s *Server) handlePhotoDelete(w http.ResponseWriter, r *http.Request) {
	id, err := uuidParam(r, "id")
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	ctx := r.Context()

	var originalKey string
	var thumbnailKey, mediumKey *string
	err = s.pool.QueryRow(ctx,
		`SELECT original_key, thumbnail_key, medium_key FROM photos WHERE id = $1`, id).
		Scan(&originalKey, &thumbnailKey, &mediumKey)
	if errors.Is(err, pgx.ErrNoRows) {
		writeError(w, http.StatusNotFound, "Photo not found")
		return
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}

	keys := []string{originalKey}
	for _, k := range []*string{thumbnailKey, mediumKey} {
		if k != nil && *k != "" {
			keys = append(keys, *k)
		}
	}
	for _, k := range keys {
		// RemoveObject is a no-op for missing keys; other errors are ignored
		// on purpose so a half-deleted photo can still be cleaned up.
		_ = s.store.Delete(ctx, k)
	}

	if _, err := s.pool.Exec(ctx, `DELETE FROM photos WHERE id = $1`, id); err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"success": true})
}

// GET /photos/file/* — stream an object from MinIO.
func (s *Server) handlePhotoFile(w http.ResponseWriter, r *http.Request) {
	key := chi.URLParam(r, "*")
	if unescaped, err := url.PathUnescape(key); err == nil {
		key = unescaped
	}
	if !strings.HasPrefix(key, "photos/") || strings.Contains(key, "..") {
		writeError(w, http.StatusForbidden, "Invalid path")
		return
	}
	var photoID uuid.UUID
	err := s.pool.QueryRow(r.Context(), `
		SELECT id FROM photos
		WHERE original_key=$1 OR thumbnail_key=$1 OR medium_key=$1`, key).Scan(&photoID)
	if errors.Is(err, pgx.ErrNoRows) {
		writeError(w, http.StatusNotFound, "File not found")
		return
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	apiaryID, err := s.entityApiaryID(r, "photo", photoID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	if !s.requireApiaryRole(w, r, apiaryID, false) {
		return
	}

	s.servePhotoKey(w, r, key)
}

func (s *Server) servePhotoKey(w http.ResponseWriter, r *http.Request, key string) {
	ctx := r.Context()
	info, err := s.store.Stat(ctx, key)
	if err != nil {
		errResp := minio.ToErrorResponse(err)
		if errResp.StatusCode == http.StatusNotFound || errResp.Code == "NoSuchKey" {
			writeError(w, http.StatusNotFound, "File not found")
			return
		}
		writeError(w, http.StatusInternalServerError, "storage error")
		return
	}

	obj, err := s.store.Get(ctx, key)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "storage error")
		return
	}
	defer obj.Close()

	// The Content-Type comes solely from the key's extension, never from the
	// stored (client-supplied) object metadata, and nosniff + a sandboxed CSP
	// stop the browser from executing anything that slipped through anyway.
	contentType := photoContentTypeForKey(key)
	cacheControl := "private, max-age=3600"
	if strings.Contains(key, "_thumb") || strings.Contains(key, "_medium") {
		cacheControl = "private, max-age=31536000, immutable"
	}

	w.Header().Set("Content-Type", contentType)
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Content-Security-Policy", "sandbox")
	w.Header().Set("Cache-Control", cacheControl)
	if info.Size > 0 {
		w.Header().Set("Content-Length", strconv.FormatInt(info.Size, 10))
	}
	w.WriteHeader(http.StatusOK)
	_, _ = io.Copy(w, obj)
}
