package snapshot

import (
	"fmt"
	"io"
)

// EmitManifest writes the canonical manifest bytes, including the required
// final LF. It does not close the writer.
func EmitManifest(writer io.Writer, manifest Manifest) error {
	return emitCanonicalDocument(writer, manifest)
}

// EmitVerification writes canonical verification.json bytes, including the
// required final LF. It does not close the writer.
func EmitVerification(writer io.Writer, verification Verification) error {
	return emitCanonicalDocument(writer, verification)
}

// EmitMediaManifest writes canonical media-manifest.json bytes, including the
// required final LF. It does not close the writer.
func EmitMediaManifest(writer io.Writer, manifest MediaManifest) error {
	return emitCanonicalDocument(writer, manifest)
}

// EmitRecord writes one canonical JSONL envelope and its final LF.
func EmitRecord(writer io.Writer, record RecordEnvelope) error {
	return emitCanonicalDocument(writer, record)
}

func emitCanonicalDocument(writer io.Writer, value any) error {
	content, err := MarshalCanonical(value)
	if err != nil {
		return err
	}
	content = append(content, '\n')
	if _, err := writer.Write(content); err != nil {
		return fmt.Errorf("write canonical snapshot JSON: %w", err)
	}
	return nil
}
