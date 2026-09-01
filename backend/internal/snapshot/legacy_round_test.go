package snapshot

import "testing"

// The first real-data rehearsal failed on 1044.0999999999997 vs 1044.1: the
// unassigned-bulk residual is a double-precision SUM whose last bits depend
// on physical row order, which a restore legitimately changes.
func TestRoundAggregateValue(t *testing.T) {
	cases := []struct {
		name string
		in   string
		want string
	}{
		{"float summation noise collapses", `{"on_hand_lbs":1044.0999999999997}`, `{"on_hand_lbs":1044.1}`},
		{"integers untouched", `{"total_amount_cents":123456,"record_count":7}`, `{"record_count":7,"total_amount_cents":123456}`},
		{"nested arrays", `[{"lot":"a","lbs":0.30000000000000004},{"lot":"b","lbs":2}]`, `[{"lbs":0.3,"lot":"a"},{"lbs":2,"lot":"b"}]`},
		{"negative noise", `{"lbs":-0.09999999999999998}`, `{"lbs":-0.1}`},
		{"six decimals kept", `{"g":28.349523}`, `{"g":28.349523}`},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			rounded, err := roundAggregateValue([]byte(tc.in))
			if err != nil {
				t.Fatal(err)
			}
			canonical, err := CanonicalJSON(rounded)
			if err != nil {
				t.Fatal(err)
			}
			if string(canonical) != tc.want {
				t.Fatalf("got %s, want %s", canonical, tc.want)
			}
		})
	}
}
