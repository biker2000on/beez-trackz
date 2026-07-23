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
)

// handleProcessImage downloads the original photo from MinIO, generates
// thumbnail (200px wide) and medium (1200px wide) variants with EXIF
// auto-orientation, uploads them, and records their keys on the photos row.
func (h *Handlers) handleProcessImage(ctx context.Context, t *asynq.Task) error {
	var payload ProcessImagePayload
	if err := json.Unmarshal(t.Payload(), &payload); err != nil {
		return fmt.Errorf("process image: bad payload: %v: %w", err, asynq.SkipRetry)
	}

	var originalKey string
	err := h.pool.QueryRow(ctx,
		`SELECT original_key FROM photos WHERE id = $1`, payload.PhotoID).Scan(&originalKey)
	if errors.Is(err, pgx.ErrNoRows) {
		// Photo deleted before processing ran — nothing to do, don't retry.
		slog.Info("process image: photo row gone, skipping", "photoId", payload.PhotoID)
		return nil
	}
	if err != nil {
		return fmt.Errorf("process image: load photo %s: %w", payload.PhotoID, err)
	}

	obj, err := h.store.Get(ctx, originalKey)
	if err != nil {
		return fmt.Errorf("process image: get %s: %w", originalKey, err)
	}
	data, err := io.ReadAll(obj)
	obj.Close()
	if err != nil {
		return fmt.Errorf("process image: download %s: %w", originalKey, err)
	}

	src, format, err := imgDecode(data)
	if err != nil {
		return fmt.Errorf("process image: decode %s: %v: %w", originalKey, err, asynq.SkipRetry)
	}
	src = imgApplyEXIFOrientation(src, data)

	base, ext := imgSplitKey(originalKey)
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
		return fmt.Errorf("process image: encode thumbnail for %s: %w", originalKey, err)
	}
	mediumBytes, err := imgEncodeResized(src, imgMediumWidth, encodeFormat)
	if err != nil {
		return fmt.Errorf("process image: encode medium for %s: %w", originalKey, err)
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
