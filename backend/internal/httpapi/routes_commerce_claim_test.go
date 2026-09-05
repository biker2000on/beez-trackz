package httpapi

import "testing"

func TestFormatClaimElevationKeepsIntegerZeros(t *testing.T) {
	t.Parallel()
	cases := []struct {
		meters float64
		units  string
		want   string
	}{
		{320, "us", "1050 ft"},
		{320, "metric", "320 m"},
		{640.1, "us", "2100 ft"},
		{640.1, "metric", "640.1 m"},
		{3000, "metric", "3000 m"},
		{0, "us", "0 ft"},
	}
	for _, c := range cases {
		if got := formatClaimElevation(c.meters, c.units); got != c.want {
			t.Errorf("formatClaimElevation(%v, %q) = %q, want %q", c.meters, c.units, got, c.want)
		}
	}
}
