package main

// passwordSetAllowed decides whether this CLI may set a password on the
// matched account. Two cases are legitimate:
//
//   - the account has signed in with SSO (the original contract: the CLI
//     attaches a password to a known operator), or
//   - the account has neither an SSO subject nor a password hash. That is
//     the post-restore state: the portable snapshot excludes password_hash
//     and auth_subject by design (docs/snapshot-format.md, security
//     exclusions), so a password-only installation would otherwise be
//     locked out of its own restored database. This CLI runs locally with
//     direct database access, so it is the trusted recovery path.
//
// An account with a password but no SSO subject stays refused: overwriting
// an existing credential still requires the SSO-verified identity.
func passwordSetAllowed(subject *string, hasPasswordHash bool) bool {
	if subject != nil && *subject != "" {
		return true
	}
	return !hasPasswordHash
}
