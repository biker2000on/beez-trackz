package jobs

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"image"
	"image/gif"
	"image/jpeg"
	"image/png"
	"io"
	"log/slog"
	"strings"

	"github.com/disintegration/imaging"
	"github.com/hibiken/asynq"
	"github.com/jackc/pgx/v5"
	"github.com/rwcarlsen/goexif/exif"
	"golang.org/x/image/webp"
)

const (
	imgThumbWidth  = 200
	imgMediumWidth = 1200
	imgJPEGQuality = 85
	// imgMaxPixels bounds decoded size. The 10 MB file cap does not: a small
	// PNG declaring 30000x30000 decodes to ~3.6 GB RGBA — an OOM the retry
	// policy would then repeat at full worker concurrency.
	imgMaxPixels = 50_000_000
)

// handleProcessImage downloads the original photo from MinIO, generates
// thumbnail (200px wide) and medium (1200px wide) variants with EXIF
// auto-orientation, uploads them, and records their keys on the photos row.
func (h *Handlers) handleProcessImage(ctx context.Context, t *asynq.Task) error {
	var payload ProcessImagePayload
	if err := json.Unmarshal(t.Payload(), &payload); err != nil {
		return fmt.Errorf("process image: bad payload: %v: %w", err, asynq.SkipRetry)
	}

	var (
		originalKey *string
		originalRef string
		backend     string
		ownerType   string
		ownerID     string
	)
	err := h.pool.QueryRow(ctx, `
		SELECT original_key, original_ref, storage_backend::text, owner_type::text, owner_id::text
		FROM photos WHERE id = $1`, payload.PhotoID).
		Scan(&originalKey, &originalRef, &backend, &ownerType, &ownerID)
	if errors.Is(err, pgx.ErrNoRows) {
		// Photo deleted before processing ran — nothing to do, don't retry.
		slog.Info("process image: photo row gone, skipping", "photoId", payload.PhotoID)
		return nil
	}
	if err != nil {
		return fmt.Errorf("process image: load photo %s: %w", payload.PhotoID, err)
	}

	data, sourceLabel, err := h.readPhotoOriginal(ctx, backend, originalRef, originalKey)
	if err != nil {
		return fmt.Errorf("process image: get %s: %w", sourceLabel, err)
	}

	if err := imgCheckDimensions(data); err != nil {
		return fmt.Errorf("process image: %s: %v: %w", sourceLabel, err, asynq.SkipRetry)
	}
	src, format, err := imgDecode(data)
	if err != nil {
		return fmt.Errorf("process image: decode %s: %v: %w", sourceLabel, err, asynq.SkipRetry)
	}
	src = imgApplyEXIFOrientation(src, data)

	base, ext := imgRenditionBase(originalKey, ownerType, ownerID, payload.PhotoID)
	encodeFormat := format
	if !imgCanEncode(format) {
		// Formats we can decode but not encode (e.g. webp) fall back to JPEG.
		encodeFormat = "jpeg"
		ext = ".jpg"
	}

	thumbKey := base + "_thumb" + ext
	mediumKey := base + "_medium" + ext
	contentType := imgContentType(encodeFormat)

	thumbBytes, err := imgEncodeResized(src, imgThumbWidth, encodeFormat)
	if err != nil {
		return fmt.Errorf("process image: encode thumbnail for %s: %w", sourceLabel, err)
	}
	mediumBytes, err := imgEncodeResized(src, imgMediumWidth, encodeFormat)
	if err != nil {
		return fmt.Errorf("process image: encode medium for %s: %w", sourceLabel, err)
	}

	if err := h.store.Put(ctx, thumbKey, bytes.NewReader(thumbBytes),
		int64(len(thumbBytes)), contentType); err != nil {
		return fmt.Errorf("process image: upload %s: %w", thumbKey, err)
	}
	if err := h.store.Put(ctx, mediumKey, bytes.NewReader(mediumBytes),
		int64(len(mediumBytes)), contentType); err != nil {
		return fmt.Errorf("process image: upload %s: %w", mediumKey, err)
	}

	if _, err := h.pool.Exec(ctx,
		`UPDATE photos SET thumbnail_key = $1, medium_key = $2 WHERE id = $3`,
		thumbKey, mediumKey, payload.PhotoID); err != nil {
		return fmt.Errorf("process image: update photo %s: %w", payload.PhotoID, err)
	}

	slog.Info("process image: done", "photoId", payload.PhotoID,
		"thumbKey", thumbKey, "mediumKey", mediumKey)
	return nil
}

// imgCheckDimensions reads only the image header and rejects anything whose
// decoded size would exceed imgMaxPixels. An unreadable header is not an
// error here — imgDecode will produce the real one.
func imgCheckDimensions(data []byte) error {
	cfg, _, err := image.DecodeConfig(bytes.NewReader(data))
	if err != nil {
		wcfg, werr := webp.DecodeConfig(bytes.NewReader(data))
		if werr != nil {
			return nil
		}
		cfg = wcfg
	}
	if cfg.Width > 0 && cfg.Height > 0 &&
		int64(cfg.Width)*int64(cfg.Height) > imgMaxPixels {
		return fmt.Errorf("image is %dx%d, over the %d-pixel limit",
			cfg.Width, cfg.Height, imgMaxPixels)
	}
	return nil
}

// imgDecode decodes jpeg/png/gif via image.Decode and webp explicitly.
func imgDecode(data []byte) (image.Image, string, error) {
	img, format, err := image.Decode(bytes.NewReader(data))
	if err == nil {
		return img, format, nil
	}
	// image.Decode only knows registered formats; try webp explicitly.
	if wimg, werr := webp.Decode(bytes.NewReader(data)); werr == nil {
		return wimg, "webp", nil
	}
	return nil, "", err
}

// imgApplyEXIFOrientation rotates/flips the decoded image per the EXIF
// Orientation tag in the original bytes (JPEG only in practice); returns the
// image unchanged when no usable tag is present.
func imgApplyEXIFOrientation(src image.Image, raw []byte) image.Image {
	x, err := exif.Decode(bytes.NewReader(raw))
	if err != nil {
		return src
	}
	tag, err := x.Get(exif.Orientation)
	if err != nil {
		return src
	}
	orientation, err := tag.Int(0)
	if err != nil {
		return src
	}
	switch orientation {
	case 2:
		return imaging.FlipH(src)
	case 3:
		return imaging.Rotate180(src)
	case 4:
		return imaging.FlipV(src)
	case 5:
		return imaging.Transpose(src)
	case 6:
		return imaging.Rotate270(src) // 90° clockwise
	case 7:
		return imaging.Transverse(src)
	case 8:
		return imaging.Rotate90(src) // 90° counter-clockwise
	default:
		return src
	}
}

// imgEncodeResized scales src down to width (never enlarging, preserving
// aspect ratio) and encodes it in the given format.
func imgEncodeResized(src image.Image, width int, format string) ([]byte, error) {
	out := src
	if src.Bounds().Dx() > width {
		out = imaging.Resize(src, width, 0, imaging.Lanczos)
	}
	var buf bytes.Buffer
	switch format {
	case "png":
		if err := png.Encode(&buf, out); err != nil {
			return nil, err
		}
	case "gif":
		if err := gif.Encode(&buf, out, nil); err != nil {
			return nil, err
		}
	default: // jpeg
		if err := jpeg.Encode(&buf, out, &jpeg.Options{Quality: imgJPEGQuality}); err != nil {
			return nil, err
		}
	}
	return buf.Bytes(), nil
}

func imgCanEncode(format string) bool {
	switch format {
	case "jpeg", "png", "gif":
		return true
	}
	return false
}

func imgContentType(format string) string {
	switch format {
	case "png":
		return "image/png"
	case "gif":
		return "image/gif"
	default:
		return "image/jpeg"
	}
}

// imgSplitKey splits an object key into (base-without-extension, extension).
func imgSplitKey(key string) (string, string) {
	slash := strings.LastIndex(key, "/")
	dot := strings.LastIndex(key, ".")
	if dot <= slash {
		return key, ""
	}
	return key[:dot], key[dot:]
}

// imgRenditionBase picks MinIO keys for thumb/medium. Immich-held originals
// have no original_key, so renditions are namespaced by photo id.
func imgRenditionBase(originalKey *string, ownerType, ownerID, photoID string) (string, string) {
	if originalKey != nil && *originalKey != "" {
		return imgSplitKey(*originalKey)
	}
	return fmt.Sprintf("photos/%s/%s/%s", ownerType, ownerID, photoID), ".jpg"
}

func (h *Handlers) readPhotoOriginal(ctx context.Context, backend, ref string, originalKey *string) ([]byte, string, error) {
	label := ref
	if originalKey != nil && *originalKey != "" {
		label = *originalKey
	}
	if h.photos != nil && backend != "" {
		obj, _, _, err := h.photos.OpenOriginal(ctx, backend, ref)
		if err != nil {
			return nil, label, err
		}
		defer obj.Close()
		data, err := io.ReadAll(obj)
		return data, label, err
	}
	if originalKey == nil || *originalKey == "" {
		return nil, label, fmt.Errorf("photo original is not in minio")
	}
	obj, err := h.store.Get(ctx, *originalKey)
	if err != nil {
		return nil, label, err
	}
	data, err := io.ReadAll(obj)
	obj.Close()
	return data, label, err
}
