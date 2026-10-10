// Package audioformat identifies supported recording containers from their bytes.
// Neither Android's sometimes-empty MIME type nor a browser-supplied filename
// is authoritative. The same detection also repairs legacy .webm object keys
// that contain uploaded M4A recordings.
package audioformat

import (
	"bytes"
	"errors"
)

type Format struct {
	MIME      string
	Extension string
}

// Detect recognizes containers, not codec validity: decoding remains the
// transcription provider's responsibility. Video-capable MP4/WebM containers
// may contain audio-only recordings produced by mobile and browser recorders.
func Detect(data []byte) (Format, error) {
	switch {
	case len(data) >= 12 && bytes.Equal(data[:4], []byte("RIFF")) && bytes.Equal(data[8:12], []byte("WAVE")):
		return Format{"audio/wav", ".wav"}, nil
	case len(data) >= 12 && bytes.Equal(data[4:8], []byte("ftyp")):
		return Format{"audio/mp4", ".m4a"}, nil
	case bytes.HasPrefix(data, []byte{0x1a, 0x45, 0xdf, 0xa3}):
		return Format{"audio/webm", ".webm"}, nil
	case bytes.HasPrefix(data, []byte("OggS")):
		return Format{"audio/ogg", ".ogg"}, nil
	case bytes.HasPrefix(data, []byte("fLaC")):
		return Format{"audio/flac", ".flac"}, nil
	case bytes.HasPrefix(data, []byte("ID3")):
		return Format{"audio/mpeg", ".mp3"}, nil
	case len(data) >= 4 && data[0] == 0xff && data[1]&0xf6 == 0xf0:
		return Format{"audio/aac", ".aac"}, nil
	case len(data) >= 4 && data[0] == 0xff && data[1]&0xe0 == 0xe0 && data[1]&0x06 != 0 && data[2]&0xf0 != 0xf0 && data[2]&0x0c != 0x0c:
		return Format{"audio/mpeg", ".mp3"}, nil
	default:
		return Format{}, errors.New("Unsupported audio file. Choose an M4A, MP3, WAV, OGG, WebM, FLAC, or AAC recording")
	}
}
