package httpapi

import (
	"encoding/json"
	"io"
	"net/http"
	"strconv"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/hibiken/asynq"

	"github.com/biker2000on/beez-trackz/backend/internal/jobs"
	"github.com/biker2000on/beez-trackz/backend/internal/photostore"
)

// GET /photos/storage — default backend + whether Immich is configured.
// Not admin-only: editors need this to show "Link from library".
func (s *Server) handlePhotoStorageInfo(w http.ResponseWriter, r *http.Request) {
	defaultBackend := photostore.BackendMinio
	configured := false
	if s.cfg != nil {
		defaultBackend = s.cfg.ResolvedPhotoBackend()
		configured = s.cfg.ImmichConfigured()
	} else if s.photos != nil {
		defaultBackend = s.photos.Preferred()
		configured = s.photos.ImmichConfigured()
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"defaultBackend":   defaultBackend,
		"fallbackBackend":  photostore.BackendMinio,
		"immichConfigured": configured,
	})
}

// GET /photos/library?page=&size= — one page of Immich images. Does not walk
// the library.
func (s *Server) handlePhotoLibrary(w http.ResponseWriter, r *http.Request) {
	client := s.immichClient()
	if client == nil {
		writeError(w, http.StatusNotFound, "Immich is not configured")
		return
	}
	page, _ := strconv.Atoi(r.URL.Query().Get("page"))
	size, _ := strconv.Atoi(r.URL.Query().Get("size"))
	items, next, err := client.ListImages(r.Context(), page, size)
	if err != nil {
		writeError(w, http.StatusBadGateway, "could not list Immich library")
		return
	}
	list := make([]map[string]any, 0, len(items))
	for _, item := range items {
		list = append(list, map[string]any{
			"id":               item.ID,
			"originalFileName": item.OriginalFileName,
			"takenAt":          item.TakenAt,
			"thumbnailUrl":     "/api/v1/photos/library/" + item.ID + "/thumb",
		})
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": list, "nextPage": next})
}

// GET /photos/library/{assetId}/thumb — proxy an Immich thumbnail so the
// browser never sees an Immich URL.
func (s *Server) handlePhotoLibraryThumb(w http.ResponseWriter, r *http.Request) {
	client := s.immichClient()
	if client == nil {
		writeError(w, http.StatusNotFound, "Immich is not configured")
		return
	}
	assetID := strings.TrimSpace(chi.URLParam(r, "assetId"))
	if _, err := uuid.Parse(assetID); err != nil {
		writeError(w, http.StatusBadRequest, "invalid assetId")
		return
	}
	obj, size, contentType, err := client.OpenThumbnail(r.Context(), assetID)
	if err != nil {
		writeError(w, http.StatusBadGateway, "could not load Immich thumbnail")
		return
	}
	defer obj.Close()
	if contentType == "" || strings.Contains(contentType, "json") {
		contentType = "image/jpeg"
	}
	w.Header().Set("Content-Type", contentType)
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Content-Security-Policy", "sandbox")
	w.Header().Set("Cache-Control", "private, max-age=3600")
	if size > 0 {
		w.Header().Set("Content-Length", strconv.FormatInt(size, 10))
	}
	w.WriteHeader(http.StatusOK)
	_, _ = io.Copy(w, obj)
}

// POST /photos/link {assetId, ownerType, ownerId, caption?, tags?} — adopt an
// Immich asset. Deleting the Beez row will not delete the library original.
func (s *Server) handlePhotoLink(w http.ResponseWriter, r *http.Request) {
	client := s.immichClient()
	if client == nil {
		writeError(w, http.StatusNotFound, "Immich is not configured")
		return
	}
	var req struct {
		AssetID   string   `json:"assetId"`
		OwnerType string   `json:"ownerType"`
		OwnerID   string   `json:"ownerId"`
		Caption   *string  `json:"caption"`
		Tags      []string `json:"tags"`
	}
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	assetID, err := uuid.Parse(strings.TrimSpace(req.AssetID))
	if err != nil {
		writeError(w, http.StatusBadRequest, "assetId is required")
		return
	}
	if !photoOwnerTypes[req.OwnerType] {
		writeError(w, http.StatusBadRequest, "Invalid owner type")
		return
	}
	ownerID, err := uuid.Parse(req.OwnerID)
	if err != nil {
		writeError(w, http.StatusBadRequest, "Owner ID is required")
		return
	}
	if !s.requireOwnerRole(w, r, req.OwnerType, ownerID, true) {
		return
	}
	if err := client.AssetExists(r.Context(), assetID.String()); err != nil {
		writeError(w, http.StatusBadRequest, "Immich asset not found")
		return
	}
	var caption *string
	if req.Caption != nil {
		if c := strings.TrimSpace(*req.Caption); c != "" {
			caption = &c
		}
	}
	var photoID string
	err = s.pool.QueryRow(r.Context(), `
		INSERT INTO photos
			(owner_type, owner_id, original_key, original_ref, storage_backend, original_external,
			 taken_date, caption, tags)
		VALUES ($1, $2, NULL, $3, 'immich', true, now(), $4, $5)
		RETURNING id`,
		req.OwnerType, ownerID, assetID.String(), caption, req.Tags).Scan(&photoID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	if s.queue != nil {
		payload, _ := json.Marshal(jobs.ProcessImagePayload{PhotoID: photoID})
		if _, err := s.queue.EnqueueContext(r.Context(),
			asynq.NewTask(jobs.TypeProcessImage, payload), asynq.MaxRetry(3)); err != nil {
			_, _ = s.pool.Exec(r.Context(), `DELETE FROM photos WHERE id = $1`, photoID)
			writeError(w, http.StatusInternalServerError, "failed to enqueue image processing")
			return
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{"success": true, "photoId": photoID})
}

// GET /photos/{id}/original — resolve the row's backend and stream bytes.
func (s *Server) handlePhotoOriginal(w http.ResponseWriter, r *http.Request) {
	id, err := uuidParam(r, "id")
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	var backend, ref string
	var originalKey *string
	err = s.pool.QueryRow(r.Context(), `
		SELECT storage_backend::text, original_ref, original_key FROM photos WHERE id = $1`, id).
		Scan(&backend, &ref, &originalKey)
	if err != nil {
		writeError(w, http.StatusNotFound, "Photo not found")
		return
	}
	s.servePhotoOriginal(w, r, backend, ref, originalKey)
}

// POST /photos/{id}/reprocess — rebuild MinIO renditions from the original.
func (s *Server) handlePhotoReprocess(w http.ResponseWriter, r *http.Request) {
	id, err := uuidParam(r, "id")
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	var exists bool
	if err := s.pool.QueryRow(r.Context(), `SELECT EXISTS(SELECT 1 FROM photos WHERE id=$1)`, id).
		Scan(&exists); err != nil || !exists {
		writeError(w, http.StatusNotFound, "Photo not found")
		return
	}
	if s.queue == nil {
		writeError(w, http.StatusInternalServerError, "queue is not configured")
		return
	}
	payload, err := json.Marshal(jobs.ProcessImagePayload{PhotoID: id.String()})
	if err != nil {
		writeError(w, http.StatusInternalServerError, "encoding error")
		return
	}
	if _, err := s.queue.EnqueueContext(r.Context(),
		asynq.NewTask(jobs.TypeProcessImage, payload), asynq.MaxRetry(3)); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to enqueue image processing")
		return
	}
	writeJSON(w, http.StatusAccepted, map[string]any{"queued": true})
}

func (s *Server) immichClient() *photostore.Immich {
	if s.photos != nil {
		return s.photos.Immich()
	}
	return nil
}

func (s *Server) servePhotoOriginal(w http.ResponseWriter, r *http.Request, backend, ref string, originalKey *string) {
	if backend == photostore.BackendMinio || backend == "" {
		key := ref
		if originalKey != nil && *originalKey != "" {
			key = *originalKey
		}
		if key == "" {
			writeError(w, http.StatusNotFound, "File not found")
			return
		}
		s.servePhotoKey(w, r, key)
		return
	}
	if s.photos == nil {
		writeError(w, http.StatusBadGateway, "photo backend is not configured")
		return
	}
	obj, size, contentType, err := s.photos.OpenOriginal(r.Context(), backend, ref)
	if err != nil {
		writeError(w, http.StatusBadGateway, "could not load original photo")
		return
	}
	defer obj.Close()
	if contentType == "" || strings.Contains(contentType, "json") {
		contentType = "application/octet-stream"
		if originalKey != nil {
			contentType = photoContentTypeForKey(*originalKey)
		}
	}
	w.Header().Set("Content-Type", contentType)
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Content-Security-Policy", "sandbox")
	w.Header().Set("Cache-Control", "private, max-age=3600")
	if size > 0 {
		w.Header().Set("Content-Length", strconv.FormatInt(size, 10))
	}
	w.WriteHeader(http.StatusOK)
	_, _ = io.Copy(w, obj)
}

func (s *Server) servePhotoPreferred(w http.ResponseWriter, r *http.Request, backend, ref string, originalKey, mediumKey, thumbKey *string) {
	if mediumKey != nil && *mediumKey != "" {
		s.servePhotoKey(w, r, *mediumKey)
		return
	}
	if thumbKey != nil && *thumbKey != "" {
		s.servePhotoKey(w, r, *thumbKey)
		return
	}
	s.servePhotoOriginal(w, r, backend, ref, originalKey)
}
