package brand

import (
	"bufio"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// TestBrandLegacyNameScan is the presentation-boundary gate. It scans only
// non-test application source for legacy human-facing spellings. Stable machine
// identifiers remain explicitly permitted by policy: beez-trackz compose/image
// names and Go module path; the beeztrackz database role and MinIO bucket; bt_
// token prefixes; X-Beez-Cache; and /api/integrations/beez. Historical prose is
// permitted only below docs/, which is deliberately outside these scan roots.
func TestBrandLegacyNameScan(t *testing.T) {
	repositoryRoot, err := filepath.Abs(filepath.Join("..", "..", ".."))
	if err != nil {
		t.Fatal(err)
	}
	var hits []string
	for _, relativeRoot := range []string{"backend", filepath.Join("frontend", "src")} {
		root := filepath.Join(repositoryRoot, relativeRoot)
		err := filepath.WalkDir(root, func(path string, entry os.DirEntry, walkErr error) error {
			if walkErr != nil {
				return walkErr
			}
			if entry.IsDir() {
				if entry.Name() == "node_modules" || entry.Name() == ".next" {
					return filepath.SkipDir
				}
				return nil
			}
			if strings.HasSuffix(entry.Name(), "_test.go") || strings.Contains(entry.Name(), ".test.") ||
				strings.Contains(entry.Name(), ".spec.") {
				return nil
			}
			file, err := os.Open(path)
			if err != nil {
				return err
			}
			defer file.Close()
			scanner := bufio.NewScanner(file)
			lineNumber := 0
			for scanner.Scan() {
				lineNumber++
				line := scanner.Text()
				if strings.Contains(line, "Beez Trackz") || strings.Contains(line, "BeezTrackz") {
					relative, _ := filepath.Rel(repositoryRoot, path)
					hits = append(hits, fmt.Sprintf("%s:%d", filepath.ToSlash(relative), lineNumber))
				}
			}
			return scanner.Err()
		})
		if err != nil {
			t.Fatalf("scan %s: %v", relativeRoot, err)
		}
	}
	if len(hits) > 0 {
		t.Fatalf("legacy user-facing brand found outside the documented machine-identifier allowlist:\n%s", strings.Join(hits, "\n"))
	}
}
