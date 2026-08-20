package httpapi

import (
	"bytes"
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
	"github.com/biker2000on/beez-trackz/backend/internal/photostore"
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
	r.With(s.requireApiaryParamRole(true)).
		Post("/apiaries/{id}/photos/scan", s.handleApiaryPhotoScan)
	r.With(s.requireApiaryParamRole(false)).
		Get("/apiaries/{id}/photos/timeline", s.handleApiaryPhotoTimeline)
	r.With(s.requireApiaryParamRole(true)).
		Post("/apiaries/{id}/photos/review/{candidateId}", s.handleApiaryPhotoReview)
	r.With(s.requireHiveParamRole(false)).
		Get("/hives/{id}/photos/strip", s.handleHivePhotoStrip)
	r.Route("/photos", func(r chi.Router) {
		r.Post("/", s.handlePhotoUpload)
		r.Get("/", s.handlePhotoList)
		// The Immich library and storage summary are not scoped to any
		// apiary, so gate them the way linking effectively is: only users
		// who can edit somewhere (or admins) may browse the library.
		r.With(s.requireAnyEditor).Get("/storage", s.handlePhotoStorageInfo)
		r.With(s.requireAnyEditor).Get("/library", s.handlePhotoLibrary)
		r.With(s.requireAnyEditor).Get("/library/{assetId}/thumb", s.handlePhotoLibraryThumb)
		r.Post("/link", s.handlePhotoLink)
		r.Get("/file/*", s.handlePhotoFile)
		r.With(s.requireEntityParamRole("photo", false)).Get("/{id}/original", s.handlePhotoOriginal)
		r.With(s.requireEntityParamRole("photo", true)).Post("/{id}/reprocess", s.handlePhotoReprocess)
		r.With(s.requireEntityParamRole("photo", true)).Patch("/{id}", s.handlePhotoUpdate)
		r.With(s.requireEntityParamRole("photo", true)).Delete("/{id}", s.handlePhotoDelete)
	})
}

// requireAnyEditor admits admins and users holding an editor membership on at
// least one apiary. There is no per-apiary scope for the Immich library, and
// linking an asset already requires editor on the target owner, so this is the
// narrowest existing role that makes browsing the library meaningful.
func (s *Server) requireAnyEditor(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		user := principalFrom(r)
		if user == nil {
			writeError(w, http.StatusUnauthorized, "unauthorized")
			return
		}
		if !user.IsAdmin {
			var ok bool
			if err := s.pool.QueryRow(r.Context(), `
				SELECT EXISTS (
					SELECT 1 FROM apiary_memberships
					WHERE user_id=$1 AND role='editor'
				)`, user.ID).Scan(&ok); err != nil {
				writeError(w, http.StatusInternalServerError, "database error")
				return
			}
			if !ok {
				writeError(w, http.StatusForbidden, "editor access required")
				return
			}
		}
		next.ServeHTTP(w, r)
	})
}

type photoResponse struct {
	ID               string     `json:"id"`
	OwnerType        string     `json:"ownerType"`
	OwnerID          string     `json:"ownerId"`
	Caption          *string    `json:"caption"`
	Tags             []string   `json:"tags"`
	TakenDate        *time.Time `json:"takenDate"`
	CreatedAt        time.Time  `json:"createdAt"`
	OriginalURL      *string    `json:"originalUrl"`
	ThumbnailURL     *string    `json:"thumbnailUrl"`
	MediumURL        *string    `json:"mediumUrl"`
	StorageBackend   string     `json:"storageBackend"`
	OriginalExternal bool       `json:"originalExternal"`
	ComparisonAngle  *string    `json:"comparisonAngle"`
}

func photoOriginalURL(id string) *string {
	u := "/api/v1/photos/" + id + "/original"
	return &u
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

	filename := header.Filename
	if filename == "" {
		filename = "photo.jpg"
	}
	key := fmt.Sprintf("photos/%s/%s/%d_%s",
		ownerType, ownerID, time.Now().UnixMilli(), photoSanitizeFilename(filename))

	ctx := r.Context()
	data, err := io.ReadAll(io.LimitReader(file, photoMaxUploadBytes+1))
	if err != nil || len(data) == 0 {
		writeError(w, http.StatusBadRequest, "Photo file is required")
		return
	}
	if len(data) > photoMaxUploadBytes {
		writeError(w, http.StatusBadRequest, "Photo must be under 10MB")
		return
	}

	backend := photostore.BackendMinio
	ref := key
	var originalKey *string
	originalExternal := false
	fellBack := false
	if s.photos != nil {
		backend, ref, fellBack, originalExternal, err = s.photos.Upload(ctx, filename, contentType,
			bytes.NewReader(data), int64(len(data)), key)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "failed to store photo")
			return
		}
	} else if s.store != nil {
		if err := s.store.Put(ctx, key, bytes.NewReader(data), int64(len(data)), contentType); err != nil {
			writeError(w, http.StatusInternalServerError, "failed to store photo")
			return
		}
	} else {
		writeError(w, http.StatusInternalServerError, "failed to store photo")
		return
	}
	if backend == photostore.BackendMinio {
		originalKey = &key
		ref = key
	}

	var photoID string
	err = s.pool.QueryRow(ctx, `
		INSERT INTO photos
			(owner_type, owner_id, original_key, original_ref, storage_backend, original_external,
			 taken_date, caption, tags)
		VALUES ($1, $2, $3, $4, $5, $6, NULL, $7, $8)
		RETURNING id`,
		ownerType, ownerID, originalKey, ref, backend, originalExternal, caption, tags).Scan(&photoID)
	if err != nil {
		if backend == photostore.BackendMinio && s.store != nil {
			_ = s.store.Delete(ctx, key)
		} else if s.photos != nil && !originalExternal {
			_ = s.photos.DeleteOriginal(ctx, backend, ref)
		}
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
		if backend == photostore.BackendMinio && s.store != nil {
			_ = s.store.Delete(ctx, key)
		} else if s.photos != nil && !originalExternal {
			_ = s.photos.DeleteOriginal(ctx, backend, ref)
		}
		writeError(w, http.StatusInternalServerError, "failed to enqueue image processing")
		return
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"success": true, "photoId": photoID, "storageBackend": backend, "fellBackToMinio": fellBack,
	})
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
		       taken_date, caption, tags, created_at, storage_backend::text, original_external,
		       comparison_angle
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
			originalKey  *string
			thumbnailKey *string
			mediumKey    *string
		)
		if err := rows.Scan(&p.ID, &p.OwnerType, &p.OwnerID, &originalKey, &thumbnailKey,
			&mediumKey, &p.TakenDate, &p.Caption, &p.Tags, &p.CreatedAt,
			&p.StorageBackend, &p.OriginalExternal, &p.ComparisonAngle); err != nil {
			writeError(w, http.StatusInternalServerError, "database error")
			return
		}
		p.OriginalURL = photoOriginalURL(p.ID)
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
		Caption         *string   `json:"caption"`
		Tags            *[]string `json:"tags"`
		ComparisonAngle *string   `json:"comparisonAngle"`
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
	if req.ComparisonAngle != nil {
		var angle *string
		if value := strings.TrimSpace(*req.ComparisonAngle); value != "" {
			if len(value) > 80 {
				writeError(w, http.StatusBadRequest, "Comparison angle must be 80 characters or fewer")
				return
			}
			angle = &value
		}
		args = append(args, angle)
		sets = append(sets, "comparison_angle = $"+strconv.Itoa(len(args)))
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

	var (
		originalKey      *string
		thumbnailKey     *string
		mediumKey        *string
		backend          string
		originalRef      string
		originalExternal bool
	)
	err = s.pool.QueryRow(ctx, `
		SELECT original_key, thumbnail_key, medium_key, storage_backend::text,
		       original_ref, original_external
		FROM photos WHERE id = $1`, id).
		Scan(&originalKey, &thumbnailKey, &mediumKey, &backend, &originalRef, &originalExternal)
	if errors.Is(err, pgx.ErrNoRows) {
		writeError(w, http.StatusNotFound, "Photo not found")
		return
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}

	var inUse bool
	if err := s.pool.QueryRow(ctx,
		`SELECT EXISTS(SELECT 1 FROM harvest_lot_photos WHERE photo_id = $1)`, id).
		Scan(&inUse); err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	if inUse {
		writeError(w, http.StatusConflict, "photo is still used by a honey lot")
		return
	}

	if !originalExternal && backend == photostore.BackendImmich {
		if s.photos == nil || s.photos.Immich() == nil {
			writeError(w, http.StatusBadGateway, "immich is not configured")
			return
		}
		if err := s.photos.DeleteOriginal(ctx, backend, originalRef); err != nil {
			writeError(w, http.StatusBadGateway, "failed to delete Immich original")
			return
		}
	}

	keys := []*string{originalKey, thumbnailKey, mediumKey}
	for _, k := range keys {
		if k == nil || *k == "" || s.store == nil {
			continue
		}
		// RemoveObject is a no-op for missing keys; other errors are ignored
		// on purpose so a half-deleted photo can still be cleaned up.
		_ = s.store.Delete(ctx, *k)
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

type photoScanResponse struct {
	ID           string     `json:"id"`
	Status       string     `json:"status"`
	MatchedCount int        `json:"matchedCount"`
	AdoptedCount int        `json:"adoptedCount"`
	ReviewCount  int        `json:"reviewCount"`
	Error        *string    `json:"error"`
	RequestedAt  time.Time  `json:"requestedAt"`
	StartedAt    *time.Time `json:"startedAt"`
	CompletedAt  *time.Time `json:"completedAt"`
}

type timelinePhotoResponse struct {
	photoResponse
	MatchedTerms []string `json:"matchedTerms"`
}

type timelineCandidateResponse struct {
	ID               string      `json:"id"`
	ImmichAssetID    string      `json:"immichAssetId"`
	OriginalFilename *string     `json:"originalFilename"`
	TakenDate        *time.Time  `json:"takenDate"`
	Latitude         *float64    `json:"latitude"`
	Longitude        *float64    `json:"longitude"`
	MatchedTerms     []string    `json:"matchedTerms"`
	NearbyApiaryIDs  []uuid.UUID `json:"nearbyApiaryIds"`
	ReviewReason     string      `json:"reviewReason"`
	ThumbnailURL     string      `json:"thumbnailUrl"`
}

// POST /apiaries/{id}/photos/scan queues (or resumes) one persisted scan.
func (s *Server) handleApiaryPhotoScan(w http.ResponseWriter, r *http.Request) {
	apiaryID, err := uuidParam(r, "id")
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	if s.queue == nil {
		writeError(w, http.StatusInternalServerError, "queue is not configured")
		return
	}
	if s.immichClient() == nil {
		writeError(w, http.StatusNotFound, "Immich is not configured")
		return
	}
	var hasPin bool
	if err := s.pool.QueryRow(r.Context(), `
		SELECT latitude IS NOT NULL AND longitude IS NOT NULL
		FROM apiaries WHERE id=$1`, apiaryID).Scan(&hasPin); err != nil {
		writeError(w, http.StatusNotFound, "Apiary not found")
		return
	}
	if !hasPin {
		writeError(w, http.StatusConflict, "Set the apiary map pin before scanning Immich")
		return
	}

	var scanID uuid.UUID
	created := true
	err = s.pool.QueryRow(r.Context(), `
		INSERT INTO immich_timeline_scans (apiary_id)
		VALUES ($1)
		ON CONFLICT DO NOTHING
		RETURNING id`, apiaryID).Scan(&scanID)
	if errors.Is(err, pgx.ErrNoRows) {
		created = false
		err = s.pool.QueryRow(r.Context(), `
			SELECT id FROM immich_timeline_scans
			WHERE apiary_id=$1 AND status IN ('queued','running')
			ORDER BY requested_at DESC LIMIT 1`, apiaryID).Scan(&scanID)
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	task, err := jobs.NewImmichYardScanTask(apiaryID.String(), scanID.String())
	if err != nil {
		writeError(w, http.StatusInternalServerError, "encoding error")
		return
	}
	info, enqueueErr := s.queue.EnqueueContext(r.Context(), task, asynq.MaxRetry(3))
	if enqueueErr != nil && !errors.Is(enqueueErr, asynq.ErrTaskIDConflict) {
		if created {
			_, _ = s.pool.Exec(r.Context(), `
				UPDATE immich_timeline_scans
				SET status='failed', error=$2, completed_at=now() WHERE id=$1`,
				scanID, "failed to enqueue Immich scan")
		}
		writeError(w, http.StatusInternalServerError, "failed to enqueue Immich scan")
		return
	}
	taskID := "immich-yard-scan:" + scanID.String()
	if info != nil {
		taskID = info.ID
	}
	_, _ = s.pool.Exec(r.Context(),
		`UPDATE immich_timeline_scans SET task_id=$2 WHERE id=$1`, scanID, taskID)
	writeJSON(w, http.StatusAccepted, map[string]any{
		"queued": true, "scanId": scanID, "alreadyActive": !created,
	})
}

// GET /apiaries/{id}/photos/timeline returns only adopted scan matches plus
// the pending review tray. All adopted image URLs resolve to Beez renditions.
func (s *Server) handleApiaryPhotoTimeline(w http.ResponseWriter, r *http.Request) {
	apiaryID, err := uuidParam(r, "id")
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}

	photos := []timelinePhotoResponse{}
	rows, err := s.pool.Query(r.Context(), `
		SELECT p.id, p.owner_type, p.owner_id, p.original_key, p.thumbnail_key, p.medium_key,
		       p.taken_date, p.caption, p.tags, p.created_at, p.storage_backend::text,
		       p.original_external, p.comparison_angle, c.matched_terms
		FROM immich_timeline_candidates c
		JOIN photos p ON p.id=c.photo_id
		WHERE c.apiary_id=$1 AND c.review_state='adopted'
		ORDER BY p.taken_date ASC NULLS LAST, p.created_at ASC`, apiaryID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	defer rows.Close()
	for rows.Next() {
		var item timelinePhotoResponse
		var originalKey, thumbnailKey, mediumKey *string
		if err := rows.Scan(&item.ID, &item.OwnerType, &item.OwnerID, &originalKey,
			&thumbnailKey, &mediumKey, &item.TakenDate, &item.Caption, &item.Tags,
			&item.CreatedAt, &item.StorageBackend, &item.OriginalExternal,
			&item.ComparisonAngle, &item.MatchedTerms); err != nil {
			writeError(w, http.StatusInternalServerError, "database error")
			return
		}
		item.OriginalURL = photoOriginalURL(item.ID)
		item.ThumbnailURL = photoFileURL(thumbnailKey)
		item.MediumURL = photoFileURL(mediumKey)
		photos = append(photos, item)
	}
	if rows.Err() != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}

	candidates := []timelineCandidateResponse{}
	candidateRows, err := s.pool.Query(r.Context(), `
		SELECT id, immich_asset_id, original_filename, taken_date, latitude, longitude,
		       matched_terms, nearby_apiary_ids, review_reason
		FROM immich_timeline_candidates
		WHERE apiary_id=$1 AND review_state='pending'
		ORDER BY taken_date ASC NULLS LAST, last_seen_at DESC`, apiaryID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	defer candidateRows.Close()
	for candidateRows.Next() {
		var item timelineCandidateResponse
		if err := candidateRows.Scan(&item.ID, &item.ImmichAssetID, &item.OriginalFilename,
			&item.TakenDate, &item.Latitude, &item.Longitude, &item.MatchedTerms,
			&item.NearbyApiaryIDs, &item.ReviewReason); err != nil {
			writeError(w, http.StatusInternalServerError, "database error")
			return
		}
		item.ThumbnailURL = "/api/v1/photos/library/" + item.ImmichAssetID + "/thumb"
		candidates = append(candidates, item)
	}
	if candidateRows.Err() != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}

	var latest *photoScanResponse
	var scan photoScanResponse
	err = s.pool.QueryRow(r.Context(), `
		SELECT id, status, matched_count, adopted_count, review_count, error,
		       requested_at, started_at, completed_at
		FROM immich_timeline_scans WHERE apiary_id=$1
		ORDER BY requested_at DESC LIMIT 1`, apiaryID).
		Scan(&scan.ID, &scan.Status, &scan.MatchedCount, &scan.AdoptedCount,
			&scan.ReviewCount, &scan.Error, &scan.RequestedAt, &scan.StartedAt, &scan.CompletedAt)
	if err == nil {
		latest = &scan
	} else if !errors.Is(err, pgx.ErrNoRows) {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"photos": photos, "review": candidates, "latestScan": latest,
	})
}

// POST /apiaries/{id}/photos/review/{candidateId} {action:"adopt"|"reject"}
func (s *Server) handleApiaryPhotoReview(w http.ResponseWriter, r *http.Request) {
	apiaryID, err := uuidParam(r, "id")
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	candidateID, err := uuid.Parse(chi.URLParam(r, "candidateId"))
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid candidate id")
		return
	}
	var req struct {
		Action string `json:"action"`
	}
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	switch req.Action {
	case "reject":
		tag, err := s.pool.Exec(r.Context(), `
			UPDATE immich_timeline_candidates
			SET review_state='rejected', review_reason='operator_rejected', reviewed_at=now()
			WHERE id=$1 AND apiary_id=$2 AND review_state<>'adopted'`, candidateID, apiaryID)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "database error")
			return
		}
		if tag.RowsAffected() == 0 {
			writeError(w, http.StatusConflict, "candidate is already adopted or no longer exists")
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"success": true})
		return
	case "adopt":
		// Continue below.
	default:
		writeError(w, http.StatusBadRequest, "action must be adopt or reject")
		return
	}
	if s.queue == nil {
		writeError(w, http.StatusInternalServerError, "queue is not configured")
		return
	}
	client := s.immichClient()
	if client == nil {
		writeError(w, http.StatusNotFound, "Immich is not configured")
		return
	}
	var assetID string
	if err := s.pool.QueryRow(r.Context(), `
		SELECT immich_asset_id FROM immich_timeline_candidates
		WHERE id=$1 AND apiary_id=$2`, candidateID, apiaryID).Scan(&assetID); err != nil {
		writeError(w, http.StatusNotFound, "candidate not found")
		return
	}
	if err := client.AssetExists(r.Context(), assetID); err != nil {
		writeError(w, http.StatusBadGateway, "Immich asset is unavailable")
		return
	}

	tx, err := s.pool.Begin(r.Context())
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	defer tx.Rollback(r.Context())
	var filename *string
	var takenDate *time.Time
	var terms []string
	var existingPhoto *uuid.UUID
	if err := tx.QueryRow(r.Context(), `
		SELECT immich_asset_id, original_filename, taken_date, matched_terms, photo_id
		FROM immich_timeline_candidates
		WHERE id=$1 AND apiary_id=$2 FOR UPDATE`, candidateID, apiaryID).
		Scan(&assetID, &filename, &takenDate, &terms, &existingPhoto); err != nil {
		writeError(w, http.StatusNotFound, "candidate not found")
		return
	}
	if existingPhoto != nil {
		if err := tx.Commit(r.Context()); err != nil {
			writeError(w, http.StatusInternalServerError, "database error")
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"success": true, "photoId": existingPhoto})
		return
	}
	tags := append([]string{"immich-timeline"}, terms...)
	var photoID uuid.UUID
	var thumbnailKey *string
	photoCreated := false
	err = tx.QueryRow(r.Context(), `
		SELECT id, thumbnail_key FROM photos
		WHERE owner_type='apiary' AND owner_id=$1
		  AND storage_backend='immich' AND original_ref=$2
		ORDER BY created_at ASC LIMIT 1`, apiaryID, assetID).Scan(&photoID, &thumbnailKey)
	if errors.Is(err, pgx.ErrNoRows) {
		err = tx.QueryRow(r.Context(), `
			INSERT INTO photos
			  (owner_type, owner_id, original_key, original_ref, storage_backend,
			   original_external, taken_date, caption, tags)
			VALUES ('apiary',$1,NULL,$2,'immich',true,$3,$4,$5)
			RETURNING id`, apiaryID, assetID, takenDate, filename, tags).Scan(&photoID)
		photoCreated = err == nil
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	if _, err := tx.Exec(r.Context(), `
		UPDATE immich_timeline_candidates
		SET review_state='adopted', review_reason='adopted', auto_adopted=false,
		    photo_id=$2, reviewed_at=now()
		WHERE id=$1`, candidateID, photoID); err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	if err := tx.Commit(r.Context()); err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	if thumbnailKey != nil && *thumbnailKey != "" {
		writeJSON(w, http.StatusOK, map[string]any{"success": true, "photoId": photoID})
		return
	}
	payload, _ := json.Marshal(jobs.ProcessImagePayload{PhotoID: photoID.String()})
	if _, err := s.queue.EnqueueContext(r.Context(),
		asynq.NewTask(jobs.TypeProcessImage, payload), asynq.MaxRetry(3)); err != nil {
		// Keep candidate and photo state coherent so the operator can retry.
		cleanupTx, cleanupErr := s.pool.Begin(r.Context())
		if cleanupErr == nil {
			_, _ = cleanupTx.Exec(r.Context(), `
				UPDATE immich_timeline_candidates
				SET review_state='pending', review_reason='rendition_enqueue_failed',
				    photo_id=NULL, reviewed_at=NULL WHERE id=$1`, candidateID)
			if photoCreated {
				_, _ = cleanupTx.Exec(r.Context(), `DELETE FROM photos WHERE id=$1`, photoID)
			}
			_ = cleanupTx.Commit(r.Context())
		}
		writeError(w, http.StatusInternalServerError, "failed to enqueue image processing")
		return
	}
	writeJSON(w, http.StatusAccepted, map[string]any{"success": true, "photoId": photoID})
}

// GET /hives/{id}/photos/strip is chronological by taken_date. Unlabelled
// photos are returned so the UI can assign an angle, but only labelled groups
// are presented as same-angle comparisons.
func (s *Server) handleHivePhotoStrip(w http.ResponseWriter, r *http.Request) {
	hiveID, err := uuidParam(r, "id")
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	rows, err := s.pool.Query(r.Context(), `
		SELECT id, owner_type, owner_id, original_key, thumbnail_key, medium_key,
		       taken_date, caption, tags, created_at, storage_backend::text,
		       original_external, comparison_angle
		FROM photos
		WHERE owner_type='hive' AND owner_id=$1 AND taken_date IS NOT NULL
		ORDER BY comparison_angle ASC NULLS LAST, taken_date ASC`, hiveID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	defer rows.Close()
	list := []photoResponse{}
	for rows.Next() {
		var item photoResponse
		var originalKey, thumbnailKey, mediumKey *string
		if err := rows.Scan(&item.ID, &item.OwnerType, &item.OwnerID, &originalKey,
			&thumbnailKey, &mediumKey, &item.TakenDate, &item.Caption, &item.Tags,
			&item.CreatedAt, &item.StorageBackend, &item.OriginalExternal,
			&item.ComparisonAngle); err != nil {
			writeError(w, http.StatusInternalServerError, "database error")
			return
		}
		item.OriginalURL = photoOriginalURL(item.ID)
		item.ThumbnailURL = photoFileURL(thumbnailKey)
		item.MediumURL = photoFileURL(mediumKey)
		list = append(list, item)
	}
	if rows.Err() != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	writeJSON(w, http.StatusOK, list)
}
