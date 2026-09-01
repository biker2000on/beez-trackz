package main

import "testing"

func TestPasswordSetAllowed(t *testing.T) {
	sso := "oidc|abc123"
	empty := ""
	cases := []struct {
		name    string
		subject *string
		hasHash bool
		want    bool
	}{
		{"sso user without password", &sso, false, true},
		{"sso user replacing password", &sso, true, true},
		{"restored account, no credentials at all", nil, false, true},
		{"restored account, empty subject string", &empty, false, true},
		{"password-only account without sso stays refused", nil, true, false},
		{"empty subject with existing password stays refused", &empty, true, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := passwordSetAllowed(tc.subject, tc.hasHash); got != tc.want {
				t.Fatalf("passwordSetAllowed(%v, %v) = %v, want %v", tc.subject, tc.hasHash, got, tc.want)
			}
		})
	}
}
