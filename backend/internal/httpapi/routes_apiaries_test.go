package httpapi

import (
	"math"
	"testing"
)

func TestApiaryNormalizeElevation(t *testing.T) {
	t.Parallel()

	if m, src, err := apiaryNormalizeElevation(nil, nil); err != nil || m != nil || src != nil {
		t.Fatalf("nil elevation = %v %v %v, want null pair", m, src, err)
	}

	zero := 0.0
	m, src, err := apiaryNormalizeElevation(&zero, strPtr(elevationSourceTerrain))
	if err != nil || m == nil || *m != 0 || src == nil || *src != elevationSourceTerrain {
		t.Fatalf("sea-level 0 = %v %v %v", m, src, err)
	}

	ridge := 640.16
	m, src, err = apiaryNormalizeElevation(&ridge, nil)
	if err != nil || m == nil || *m != 640.2 || src == nil || *src != elevationSourceOverride {
		t.Fatalf("typed elevation without source = %v %v %v", deref(m), deref(src), err)
	}

	if _, _, err = apiaryNormalizeElevation(floatPtr(100), strPtr("moon")); err == nil {
		t.Fatal("expected invalid source error")
	}
	if _, _, err = apiaryNormalizeElevation(floatPtr(20000), strPtr(elevationSourceOverride)); err == nil {
		t.Fatal("expected out-of-range error")
	}
	if _, _, err = apiaryNormalizeElevation(floatPtr(math.NaN()), nil); err != nil {
		t.Fatalf("NaN should be treated as unset, got %v", err)
	}
}

func strPtr(v string) *string     { return &v }
func floatPtr(v float64) *float64 { return &v }

func deref[T any](v *T) any {
	if v == nil {
		return nil
	}
	return *v
}
