package jobs

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"net/http"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/hibiken/asynq"
	"github.com/jackc/pgx/v5"
)

const (
	immichTimelinePageSize = 100
	defaultForageRadiusM   = 2500.0
)

var immichTimelineTerms = []string{"flower", "bloom", "blossom", "hive", "beehive", "bees"}

type immichTimelineAsset struct {
	ID               string
	OriginalFileName string
	TakenDate        *time.Time
	Latitude         *float64
	Longitude        *float64
	Terms            map[string]struct{}
}

type timelineApiary struct {
	ID        uuid.UUID
	Latitude  float64
	Longitude float64
	RadiusM   float64
}

// handleImmichYardScan performs six bounded, one-page smart searches and
// intersects their union with EXIF GPS locally. It never walks the library.
// Candidate upserts and photo adoption are idempotent, so an asynq retry can
// safely resume the persisted scan after a worker restart.
func (h *Handlers) handleImmichYardScan(ctx context.Context, task *asynq.Task) (retErr error) {
	var payload ImmichYardScanPayload
	if err := json.Unmarshal(task.Payload(), &payload); err != nil {
		return fmt.Errorf("immich yard scan: bad payload: %v: %w", err, asynq.SkipRetry)
	}
	apiaryID, err := uuid.Parse(payload.ApiaryID)
	if err != nil {
		return fmt.Errorf("immich yard scan: bad apiary id: %v: %w", err, asynq.SkipRetry)
	}
	scanID, err := uuid.Parse(payload.ScanID)
	if err != nil {
		return fmt.Errorf("immich yard scan: bad scan id: %v: %w", err, asynq.SkipRetry)
	}

	var status string
	if err := h.pool.QueryRow(ctx, `
		UPDATE immich_timeline_scans
		SET status='running', attempts=attempts+1, started_at=COALESCE(started_at, now()),
		    completed_at=NULL, error=NULL
		WHERE id=$1 AND apiary_id=$2 AND status IN ('queued','running','failed')
		RETURNING status`, scanID, apiaryID).Scan(&status); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			var current string
			if qerr := h.pool.QueryRow(ctx,
				`SELECT status FROM immich_timeline_scans WHERE id=$1 AND apiary_id=$2`,
				scanID, apiaryID).Scan(&current); qerr == nil && current == "succeeded" {
				return nil
			}
		}
		return fmt.Errorf("immich yard scan: start scan: %w", err)
	}

	defer func() {
		if retErr == nil {
			return
		}
		failureCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
		defer cancel()
		_, _ = h.pool.Exec(failureCtx, `
			UPDATE immich_timeline_scans
			SET status='failed', error=$2, completed_at=now()
			WHERE id=$1`, scanID, truncateJobError(retErr.Error(), 2000))
	}()

	if h.photos == nil || h.photos.Immich() == nil {
		return fmt.Errorf("immich yard scan: Immich is not configured: %w", asynq.SkipRetry)
	}
	// Reuse the configured Immich client's bounded health request. A down
	// server fails the persisted scan loudly while adopted MinIO thumbs remain.
	if err := h.photos.Immich().Health(ctx); err != nil {
		return fmt.Errorf("immich yard scan: Immich unavailable: %w", err)
	}

	apiaries, err := h.timelineApiaries(ctx)
	if err != nil {
		return fmt.Errorf("immich yard scan: load apiaries: %w", err)
	}
	var target *timelineApiary
	for i := range apiaries {
		if apiaries[i].ID == apiaryID {
			target = &apiaries[i]
			break
		}
	}
	if target == nil {
		return fmt.Errorf("immich yard scan: apiary has no map pin: %w", asynq.SkipRetry)
	}

	assets := make(map[string]*immichTimelineAsset)
	for _, term := range immichTimelineTerms {
		matches, err := h.immichSmartSearch(ctx, term)
		if err != nil {
			return fmt.Errorf("immich yard scan: smart search %q: %w", term, err)
		}
		for _, match := range matches {
			if match.ID == "" {
				continue
			}
			asset := assets[match.ID]
			if asset == nil {
				match.Terms = make(map[string]struct{})
				asset = &match
				assets[match.ID] = asset
			}
			asset.Terms[term] = struct{}{}
			mergeTimelineAsset(asset, match)
		}
	}

	matchedCount := 0
	for _, asset := range assets {
		nearby := nearbyTimelineApiaries(*asset, apiaries)
		insideTarget := false
		for _, id := range nearby {
			if id == apiaryID {
				insideTarget = true
				break
			}
		}
		if asset.Latitude != nil && !insideTarget {
			continue
		}
		matchedCount++

		reason, auto := timelineReviewDecision(*asset, nearby)
		candidateID, state, photoID, needsRendition, err := h.upsertTimelineCandidate(
			ctx, scanID, apiaryID, *asset, nearby, reason)
		if err != nil {
			return fmt.Errorf("immich yard scan: retain candidate %s: %w", asset.ID, err)
		}
		if !auto || state == "rejected" {
			continue
		}
		if photoID == "" {
			photoID, needsRendition, err = h.adoptTimelineCandidate(ctx, candidateID, true)
			if err != nil {
				return fmt.Errorf("immich yard scan: adopt candidate %s: %w", asset.ID, err)
			}
		}
		if needsRendition && photoID != "" {
			imagePayload, _ := json.Marshal(ProcessImagePayload{PhotoID: photoID})
			if err := h.handleProcessImage(ctx, asynq.NewTask(TypeProcessImage, imagePayload)); err != nil {
				return fmt.Errorf("immich yard scan: render candidate %s: %w", asset.ID, err)
			}
		}
	}

	// A moved pin or changed model does not silently delete an adopted photo.
	// Previously pending matches that disappeared are surfaced for review.
	if _, err := h.pool.Exec(ctx, `
		UPDATE immich_timeline_candidates
		SET review_reason='no_longer_matched'
		WHERE apiary_id=$1 AND review_state='pending'
		  AND last_seen_scan_id IS DISTINCT FROM $2`, apiaryID, scanID); err != nil {
		return fmt.Errorf("immich yard scan: reconcile old candidates: %w", err)
	}

	var adopted, review int
	if err := h.pool.QueryRow(ctx, `
		SELECT count(*) FILTER (WHERE review_state='adopted'),
		       count(*) FILTER (WHERE review_state='pending')
		FROM immich_timeline_candidates
		WHERE apiary_id=$1 AND last_seen_scan_id=$2`, apiaryID, scanID).
		Scan(&adopted, &review); err != nil {
		return fmt.Errorf("immich yard scan: count results: %w", err)
	}
	if _, err := h.pool.Exec(ctx, `
		UPDATE immich_timeline_scans
		SET status='succeeded', matched_count=$2, adopted_count=$3,
		    review_count=$4, error=NULL, completed_at=now()
		WHERE id=$1`, scanID, matchedCount, adopted, review); err != nil {
		return fmt.Errorf("immich yard scan: finish scan: %w", err)
	}
	return nil
}

func (h *Handlers) timelineApiaries(ctx context.Context) ([]timelineApiary, error) {
	var hasRadius bool
	if err := h.pool.QueryRow(ctx, `
		SELECT EXISTS (
		  SELECT 1 FROM information_schema.columns
		  WHERE table_schema=current_schema() AND table_name='apiaries'
		    AND column_name='forage_radius_m'
		)`).Scan(&hasRadius); err != nil {
		return nil, err
	}
	radiusExpr := fmt.Sprintf("%g::double precision", defaultForageRadiusM)
	if hasRadius {
		radiusExpr = fmt.Sprintf("COALESCE(forage_radius_m, %g)::double precision", defaultForageRadiusM)
	}
	rows, err := h.pool.Query(ctx, `
		SELECT id, latitude, longitude, `+radiusExpr+`
		FROM apiaries
		WHERE latitude IS NOT NULL AND longitude IS NOT NULL`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []timelineApiary
	for rows.Next() {
		var item timelineApiary
		if err := rows.Scan(&item.ID, &item.Latitude, &item.Longitude, &item.RadiusM); err != nil {
			return nil, err
		}
		if item.RadiusM <= 0 {
			item.RadiusM = defaultForageRadiusM
		}
		out = append(out, item)
	}
	return out, rows.Err()
}

// immichSmartSearch is intentionally a single request rather than another
// library client. The pinned shared client does not yet expose smart search;
// originals, health, and previews still use that existing client/resolver.
func (h *Handlers) immichSmartSearch(ctx context.Context, term string) ([]immichTimelineAsset, error) {
	payload, err := json.Marshal(map[string]any{
		"query": term, "type": "IMAGE", "withExif": true,
		"page": 1, "size": immichTimelinePageSize,
	})
	if err != nil {
		return nil, err
	}
	searchCtx, cancel := context.WithTimeout(ctx, 60*time.Second)
	defer cancel()
	endpoint := strings.TrimRight(h.cfg.ImmichBaseURL, "/") + "/api/search/smart"
	req, err := http.NewRequestWithContext(searchCtx, http.MethodPost, endpoint, bytes.NewReader(payload))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")
	req.Header.Set("x-api-key", h.cfg.ImmichAPIKey)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, 32<<20))
	if err != nil {
		return nil, err
	}
	if resp.StatusCode >= 300 {
		return nil, fmt.Errorf("HTTP %d: %s", resp.StatusCode, truncateJobError(string(body), 200))
	}
	var result struct {
		Assets struct {
			Items []struct {
				ID               string `json:"id"`
				OriginalFileName string `json:"originalFileName"`
				ExifInfo         *struct {
					DateTimeOriginal *string  `json:"dateTimeOriginal"`
					Latitude         *float64 `json:"latitude"`
					Longitude        *float64 `json:"longitude"`
				} `json:"exifInfo"`
			} `json:"items"`
		} `json:"assets"`
	}
	if err := json.Unmarshal(body, &result); err != nil {
		return nil, fmt.Errorf("decode: %w", err)
	}
	out := make([]immichTimelineAsset, 0, len(result.Assets.Items))
	for _, item := range result.Assets.Items {
		asset := immichTimelineAsset{ID: item.ID, OriginalFileName: item.OriginalFileName}
		var original *string
		if item.ExifInfo != nil {
			original = item.ExifInfo.DateTimeOriginal
			asset.Latitude = item.ExifInfo.Latitude
			asset.Longitude = item.ExifInfo.Longitude
		}
		// The seasonal timeline must not silently substitute import/upload time.
		// A missing DateTimeOriginal stays NULL and sorts after dated evidence.
		asset.TakenDate = parseImmichTakenDate(original)
		out = append(out, asset)
	}
	return out, nil
}

func (h *Handlers) upsertTimelineCandidate(
	ctx context.Context,
	scanID, apiaryID uuid.UUID,
	asset immichTimelineAsset,
	nearby []uuid.UUID,
	reason string,
) (candidateID uuid.UUID, state, photoID string, needsRendition bool, err error) {
	terms := timelineTermList(asset.Terms)
	var storedPhotoID *uuid.UUID
	err = h.pool.QueryRow(ctx, `
		INSERT INTO immich_timeline_candidates
		  (apiary_id, immich_asset_id, original_filename, taken_date, latitude, longitude,
		   matched_terms, nearby_apiary_ids, review_reason, last_seen_scan_id)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
		ON CONFLICT (apiary_id, immich_asset_id) DO UPDATE SET
		  original_filename=EXCLUDED.original_filename,
		  taken_date=EXCLUDED.taken_date,
		  latitude=EXCLUDED.latitude,
		  longitude=EXCLUDED.longitude,
		  matched_terms=EXCLUDED.matched_terms,
		  nearby_apiary_ids=EXCLUDED.nearby_apiary_ids,
		  review_reason=EXCLUDED.review_reason,
		  review_state=CASE
		    WHEN immich_timeline_candidates.review_state='rejected' THEN 'rejected'
		    WHEN immich_timeline_candidates.photo_id IS NOT NULL THEN 'adopted'
		    ELSE 'pending'
		  END,
		  last_seen_at=now(),
		  last_seen_scan_id=EXCLUDED.last_seen_scan_id
		RETURNING id, review_state, photo_id`,
		apiaryID, asset.ID, nullIfBlank(asset.OriginalFileName), asset.TakenDate,
		asset.Latitude, asset.Longitude, terms, nearby, reason, scanID).
		Scan(&candidateID, &state, &storedPhotoID)
	if err != nil {
		return uuid.Nil, "", "", false, err
	}
	if storedPhotoID != nil {
		var thumbnailKey *string
		if err := h.pool.QueryRow(ctx, `SELECT thumbnail_key FROM photos WHERE id=$1`, *storedPhotoID).
			Scan(&thumbnailKey); err != nil {
			return uuid.Nil, "", "", false, err
		}
		photoID = storedPhotoID.String()
		needsRendition = thumbnailKey == nil || *thumbnailKey == ""
	}
	return candidateID, state, photoID, needsRendition, nil
}

func (h *Handlers) adoptTimelineCandidate(ctx context.Context, candidateID uuid.UUID, automatic bool) (string, bool, error) {
	tx, err := h.pool.Begin(ctx)
	if err != nil {
		return "", false, err
	}
	defer tx.Rollback(ctx)
	var apiaryID uuid.UUID
	var assetID string
	var filename *string
	var takenDate *time.Time
	var terms []string
	var state string
	var existingPhoto *uuid.UUID
	err = tx.QueryRow(ctx, `
		SELECT apiary_id, immich_asset_id, original_filename, taken_date,
		       matched_terms, review_state, photo_id
		FROM immich_timeline_candidates WHERE id=$1 FOR UPDATE`, candidateID).
		Scan(&apiaryID, &assetID, &filename, &takenDate, &terms, &state, &existingPhoto)
	if err != nil {
		return "", false, err
	}
	if state == "rejected" {
		return "", false, nil
	}
	if existingPhoto != nil {
		var thumbnail *string
		if err := tx.QueryRow(ctx, `SELECT thumbnail_key FROM photos WHERE id=$1`, *existingPhoto).Scan(&thumbnail); err != nil {
			return "", false, err
		}
		return existingPhoto.String(), thumbnail == nil || *thumbnail == "", tx.Commit(ctx)
	}
	// A library asset may already have been linked from the existing picker.
	// Reuse that owner/ref association instead of creating a duplicate photo.
	var linkedPhoto uuid.UUID
	var linkedThumbnail *string
	err = tx.QueryRow(ctx, `
		SELECT id, thumbnail_key
		FROM photos
		WHERE owner_type='apiary' AND owner_id=$1
		  AND storage_backend='immich' AND original_ref=$2
		ORDER BY created_at ASC LIMIT 1`, apiaryID, assetID).
		Scan(&linkedPhoto, &linkedThumbnail)
	if err == nil {
		if _, err := tx.Exec(ctx, `
			UPDATE immich_timeline_candidates
			SET review_state='adopted', review_reason='adopted', auto_adopted=$2,
			    photo_id=$3, reviewed_at=now()
			WHERE id=$1`, candidateID, automatic, linkedPhoto); err != nil {
			return "", false, err
		}
		if err := tx.Commit(ctx); err != nil {
			return "", false, err
		}
		return linkedPhoto.String(), linkedThumbnail == nil || *linkedThumbnail == "", nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return "", false, err
	}
	tags := append([]string{"immich-timeline"}, terms...)
	var photoID uuid.UUID
	err = tx.QueryRow(ctx, `
		INSERT INTO photos
		  (owner_type, owner_id, original_key, original_ref, storage_backend,
		   original_external, taken_date, caption, tags)
		VALUES ('apiary',$1,NULL,$2,'immich',true,$3,$4,$5)
		RETURNING id`, apiaryID, assetID, takenDate, filename, tags).Scan(&photoID)
	if err != nil {
		return "", false, err
	}
	if _, err := tx.Exec(ctx, `
		UPDATE immich_timeline_candidates
		SET review_state='adopted', review_reason='adopted', auto_adopted=$2,
		    photo_id=$3, reviewed_at=now()
		WHERE id=$1`, candidateID, automatic, photoID); err != nil {
		return "", false, err
	}
	if err := tx.Commit(ctx); err != nil {
		return "", false, err
	}
	return photoID.String(), true, nil
}

func nearbyTimelineApiaries(asset immichTimelineAsset, apiaries []timelineApiary) []uuid.UUID {
	if asset.Latitude == nil || asset.Longitude == nil {
		return []uuid.UUID{}
	}
	nearby := make([]uuid.UUID, 0, 2)
	for _, apiary := range apiaries {
		if haversineMeters(*asset.Latitude, *asset.Longitude, apiary.Latitude, apiary.Longitude) <= apiary.RadiusM {
			nearby = append(nearby, apiary.ID)
		}
	}
	return nearby
}

func timelineReviewDecision(asset immichTimelineAsset, nearby []uuid.UUID) (string, bool) {
	if asset.Latitude == nil || asset.Longitude == nil {
		return "missing_gps", false
	}
	if len(nearby) > 1 {
		return "multiple_apiaries", false
	}
	if _, hive := asset.Terms["hive"]; hive {
		return "unique_location_hive_match", true
	}
	if _, beehive := asset.Terms["beehive"]; beehive {
		return "unique_location_hive_match", true
	}
	// Flora and generic "bees" can be houseplants or macro shots. Without a
	// reliable indoor signal, surface them rather than guessing.
	return "flora_or_bees_needs_review", false
}

func haversineMeters(lat1, lon1, lat2, lon2 float64) float64 {
	const earthRadiusM = 6_371_000.0
	toRad := math.Pi / 180
	dLat := (lat2 - lat1) * toRad
	dLon := (lon2 - lon1) * toRad
	a := math.Sin(dLat/2)*math.Sin(dLat/2) +
		math.Cos(lat1*toRad)*math.Cos(lat2*toRad)*math.Sin(dLon/2)*math.Sin(dLon/2)
	return earthRadiusM * 2 * math.Atan2(math.Sqrt(a), math.Sqrt(1-a))
}

func parseImmichTakenDate(values ...*string) *time.Time {
	for _, value := range values {
		if value == nil || strings.TrimSpace(*value) == "" {
			continue
		}
		raw := strings.TrimSpace(*value)
		for _, layout := range []string{
			time.RFC3339Nano,
			"2006-01-02T15:04:05.999999",
			"2006-01-02T15:04:05",
			"2006-01-02 15:04:05",
		} {
			var parsed time.Time
			var err error
			if layout == time.RFC3339Nano {
				parsed, err = time.Parse(layout, raw)
			} else {
				parsed, err = time.ParseInLocation(layout, raw, time.UTC)
			}
			if err == nil {
				return &parsed
			}
		}
	}
	return nil
}

func mergeTimelineAsset(dst *immichTimelineAsset, src immichTimelineAsset) {
	if dst.OriginalFileName == "" {
		dst.OriginalFileName = src.OriginalFileName
	}
	if dst.TakenDate == nil {
		dst.TakenDate = src.TakenDate
	}
	if dst.Latitude == nil && dst.Longitude == nil {
		dst.Latitude, dst.Longitude = src.Latitude, src.Longitude
	}
}

func timelineTermList(terms map[string]struct{}) []string {
	out := make([]string, 0, len(terms))
	for _, term := range immichTimelineTerms {
		if _, ok := terms[term]; ok {
			out = append(out, term)
		}
	}
	return out
}

func nullIfBlank(value string) *string {
	value = strings.TrimSpace(value)
	if value == "" {
		return nil
	}
	return &value
}

func truncateJobError(value string, limit int) string {
	value = strings.TrimSpace(value)
	if len(value) <= limit {
		return value
	}
	return value[:limit]
}
