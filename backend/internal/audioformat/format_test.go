package audioformat

import "testing"

func TestDetectRecorderContainers(t *testing.T) {
	for _, tc := range []struct {
		name string
		data []byte
		want Format
	}{
		{"Android M4A", []byte("\x00\x00\x00\x18ftypM4A \x00\x00\x00\x00isommp42"), Format{"audio/mp4", ".m4a"}},
		{"MP4", []byte("\x00\x00\x00\x18ftypisom\x00\x00\x00\x00isommp42"), Format{"audio/mp4", ".m4a"}},
		{"browser WebM", []byte{0x1a, 0x45, 0xdf, 0xa3, 0x9f}, Format{"audio/webm", ".webm"}},
		{"WAV", []byte("RIFF\x24\x00\x00\x00WAVEfmt "), Format{"audio/wav", ".wav"}},
		{"Ogg Opus", []byte("OggS\x00\x02OpusHead"), Format{"audio/ogg", ".ogg"}},
		{"FLAC", []byte("fLaC\x00\x00\x00\x22"), Format{"audio/flac", ".flac"}},
		{"MP3 with ID3", []byte("ID3\x04\x00\x00\x00\x00\x00\x00"), Format{"audio/mpeg", ".mp3"}},
		{"MP3 frame", []byte{0xff, 0xfb, 0x90, 0x00}, Format{"audio/mpeg", ".mp3"}},
		{"AAC ADTS", []byte{0xff, 0xf1, 0x50, 0x80}, Format{"audio/aac", ".aac"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got, err := Detect(tc.data)
			if err != nil || got != tc.want {
				t.Fatalf("Detect = %+v, %v; want %+v", got, err, tc.want)
			}
		})
	}
}

func TestDetectRejectsNonAudioAndIncompleteHeaders(t *testing.T) {
	for _, data := range [][]byte{nil, {}, []byte("<html>not audio</html>"), []byte("plain text"), []byte("RIFF\x00\x00\x00\x00WEBP"), {0xff, 0xff, 0xff, 0xff}, {0xff}, []byte("ftyp")} {
		if got, err := Detect(data); err == nil {
			t.Errorf("accepted %x as %+v", data, got)
		}
	}
}
