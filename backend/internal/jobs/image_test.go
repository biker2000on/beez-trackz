package jobs

import (
	"bytes"
	"encoding/binary"
	"hash/crc32"
	"image"
	"image/png"
	"testing"
)

// pngWithDeclaredSize hand-crafts a PNG signature + IHDR chunk declaring the
// given dimensions. DecodeConfig reads only the header, so no pixel data is
// needed — exactly how a decompression bomb ships huge dimensions in a tiny
// file.
func pngWithDeclaredSize(width, height uint32) []byte {
	buf := &bytes.Buffer{}
	buf.Write([]byte{0x89, 'P', 'N', 'G', 0x0d, 0x0a, 0x1a, 0x0a})
	ihdr := make([]byte, 13)
	binary.BigEndian.PutUint32(ihdr[0:], width)
	binary.BigEndian.PutUint32(ihdr[4:], height)
	ihdr[8] = 8 // bit depth
	ihdr[9] = 2 // color type: RGB
	var length [4]byte
	binary.BigEndian.PutUint32(length[:], uint32(len(ihdr)))
	buf.Write(length[:])
	buf.WriteString("IHDR")
	buf.Write(ihdr)
	crc := crc32.NewIEEE()
	crc.Write([]byte("IHDR"))
	crc.Write(ihdr)
	var sum [4]byte
	binary.BigEndian.PutUint32(sum[:], crc.Sum32())
	buf.Write(sum[:])
	return buf.Bytes()
}

// ASI-6-001: a small file declaring enormous dimensions must be rejected from
// the header alone, before image.Decode allocates gigabytes.
func TestImgCheckDimensionsRejectsDecompressionBomb(t *testing.T) {
	t.Parallel()
	if err := imgCheckDimensions(pngWithDeclaredSize(30000, 30000)); err == nil {
		t.Error("a 900-megapixel PNG header passed the dimension guard")
	}

	var buf bytes.Buffer
	if err := png.Encode(&buf, image.NewRGBA(image.Rect(0, 0, 10, 10))); err != nil {
		t.Fatalf("encode small png: %v", err)
	}
	if err := imgCheckDimensions(buf.Bytes()); err != nil {
		t.Errorf("a 10x10 PNG failed the dimension guard: %v", err)
	}

	// Undecodable data is not this guard's problem — imgDecode owns that error.
	if err := imgCheckDimensions([]byte("not an image")); err != nil {
		t.Errorf("garbage input errored in the guard instead of imgDecode: %v", err)
	}
}
