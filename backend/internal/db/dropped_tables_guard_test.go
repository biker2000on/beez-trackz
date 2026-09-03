package db

import (
	"go/ast"
	"go/parser"
	"go/token"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"testing"
)

// TestProductionSQLDoesNotReadBaselineDroppedObjects keeps a baseline build
// from compiling successfully while retaining a query that can only fail at
// runtime. Legacy-profile branches are deliberately visible exceptions: the
// SQL literal must be marked at its start with legacy-chain-only.
func TestProductionSQLDoesNotReadBaselineDroppedObjects(t *testing.T) {
	t.Helper()
	root := filepath.Clean(filepath.Join("..", ".."))
	objects := append(BaselineDroppedTables(), BaselineDroppedViews()...)
	patterns := make(map[string]*regexp.Regexp, len(objects))
	for _, object := range objects {
		patterns[object] = regexp.MustCompile(`(?i)\b(?:from|join|update|into|truncate(?:\s+table)?|delete\s+from)\s+(?:public\.)?` + regexp.QuoteMeta(object) + `\b`)
	}

	for _, tree := range []string{"internal", "cmd"} {
		err := filepath.WalkDir(filepath.Join(root, tree), func(path string, entry os.DirEntry, walkErr error) error {
			if walkErr != nil {
				return walkErr
			}
			if entry.IsDir() {
				if filepath.ToSlash(path) == filepath.ToSlash(filepath.Join(root, "internal", "app", "backfill")) {
					return filepath.SkipDir
				}
				return nil
			}
			if !strings.HasSuffix(path, ".go") || strings.HasSuffix(path, "_test.go") {
				return nil
			}
			// The legacy aggregate family is the pre-ledger export vocabulary by
			// definition; the exporter only computes it when those tables exist.
			if filepath.ToSlash(path) == filepath.ToSlash(filepath.Join(root, "internal", "snapshot", "legacy.go")) {
				return nil
			}

			source, err := os.ReadFile(path)
			if err != nil {
				return err
			}
			fileset := token.NewFileSet()
			file, err := parser.ParseFile(fileset, path, source, 0)
			if err != nil {
				return err
			}
			lines := strings.Split(string(source), "\n")
			ast.Inspect(file, func(node ast.Node) bool {
				literal, ok := node.(*ast.BasicLit)
				if !ok || literal.Kind != token.STRING {
					return true
				}
				value, err := strconv.Unquote(literal.Value)
				if err != nil {
					return true
				}
				line := fileset.Position(literal.Pos()).Line
				if legacyOnly(lines, line) {
					return true
				}
				for object, pattern := range patterns {
					if pattern.MatchString(value) {
						t.Errorf("%s:%d: SQL names baseline-dropped object %s", filepath.ToSlash(path), line, object)
					}
				}
				return true
			})
			return nil
		})
		if err != nil {
			t.Fatalf("walk %s: %v", tree, err)
		}
	}
}

func legacyOnly(lines []string, oneBasedLine int) bool {
	for _, line := range []int{oneBasedLine, oneBasedLine - 1} {
		if line > 0 && strings.Contains(lines[line-1], "// legacy-chain-only") {
			return true
		}
	}
	return false
}
