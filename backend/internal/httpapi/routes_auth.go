package httpapi

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/coreos/go-oidc/v3/oidc"
	"github.com/go-chi/chi/v5"
	"github.com/golang-jwt/jwt/v5"
	"github.com/jackc/pgx/v5"
	"golang.org/x/crypto/bcrypt"
	"golang.org/x/oauth2"

	"github.com/biker2000on/beez-trackz/backend/internal/auth"
)

const oidcTxnCookie = "beez_oidc_txn"

func (s *Server) mountAuth(r chi.Router) {
	r.Get("/auth/status", s.handleAuthStatus)
	r.Post("/auth/setup", s.handleSetup)
	r.Post("/auth/login", s.handleLogin)
	r.Post("/auth/logout", s.handleLogout)
	r.Get("/auth/oidc/login", s.handleOIDCLogin)
	r.Get("/auth/oidc/callback", s.handleOIDCCallback)
}

func (s *Server) secureCookies() bool {
	return strings.HasPrefix(s.cfg.AppURL, "https://")
}

func (s *Server) oidcEnabled() bool {
	return s.cfg.OIDCIssuer != "" && s.cfg.OIDCClientID != "" && s.cfg.OIDCClientSecret != ""
}

// settingsRow is the subset of user_settings auth cares about.
type settingsRow struct {
	ID           string
	PasswordHash *string
	DisplayName  *string
}

func (s *Server) loadSettings(ctx context.Context) (*settingsRow, error) {
	var row settingsRow
	err := s.pool.QueryRow(ctx,
		`SELECT id, password_hash, display_name FROM user_settings LIMIT 1`).
		Scan(&row.ID, &row.PasswordHash, &row.DisplayName)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &row, nil
}

// GET /auth/status — the login/setup pages probe this.
func (s *Server) handleAuthStatus(w http.ResponseWriter, r *http.Request) {
	row, err := s.loadSettings(r.Context())
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	resp := map[string]any{
		"setupComplete": row != nil && row.PasswordHash != nil,
		"oidcEnabled":   s.oidcEnabled(),
		"passwordLogin": row != nil && row.PasswordHash != nil,
	}
	if sess, err := auth.SessionFromRequest(r, s.cfg.SessionSecret); err == nil {
		resp["authenticated"] = true
		resp["displayName"] = sess.Name
	} else {
		resp["authenticated"] = false
	}
	writeJSON(w, http.StatusOK, resp)
}

// POST /auth/setup {displayName, password, confirmPassword}
func (s *Server) handleSetup(w http.ResponseWriter, r *http.Request) {
	var req struct {
		DisplayName     string `json:"displayName"`
		Password        string `json:"password"`
		ConfirmPassword string `json:"confirmPassword"`
	}
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	req.DisplayName = strings.TrimSpace(req.DisplayName)
	switch {
	case req.DisplayName == "" || req.Password == "":
		writeError(w, http.StatusBadRequest, "Display name and password are required")
		return
	case req.Password != req.ConfirmPassword:
		writeError(w, http.StatusBadRequest, "Passwords do not match")
		return
	case len(req.Password) < 8:
		writeError(w, http.StatusBadRequest, "Password must be at least 8 characters")
		return
	}

	hash, err := bcrypt.GenerateFromPassword([]byte(req.Password), 12)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "hashing failed")
		return
	}

	row, err := s.loadSettings(r.Context())
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	switch {
	case row != nil && row.PasswordHash != nil:
		writeError(w, http.StatusConflict, "Setup already completed")
		return
	case row != nil:
		// OIDC-bootstrapped instance gaining a password. The instance already
		// has an owner, so this MUST NOT be reachable anonymously — otherwise
		// anyone could claim a password on a public SSO-only deployment.
		if _, authErr := auth.SessionFromRequest(r, s.cfg.SessionSecret); authErr != nil {
			writeError(w, http.StatusUnauthorized, "Sign in with SSO first to add a password")
			return
		}
		_, err = s.pool.Exec(r.Context(),
			`UPDATE user_settings SET password_hash = $1, display_name = $2 WHERE id = $3`,
			string(hash), req.DisplayName, row.ID)
	default:
		_, err = s.pool.Exec(r.Context(),
			`INSERT INTO user_settings (password_hash, display_name) VALUES ($1, $2)`,
			string(hash), req.DisplayName)
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"success": true})
}

// POST /auth/login {password}
func (s *Server) handleLogin(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Password string `json:"password"`
	}
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	row, err := s.loadSettings(r.Context())
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	if row == nil {
		writeJSON(w, http.StatusPreconditionFailed, map[string]any{"error": "setup required", "setupRequired": true})
		return
	}
	if row.PasswordHash == nil {
		writeError(w, http.StatusUnauthorized, "Password login is not configured; use SSO")
		return
	}
	if bcrypt.CompareHashAndPassword([]byte(*row.PasswordHash), []byte(req.Password)) != nil {
		writeError(w, http.StatusUnauthorized, "Invalid password")
		return
	}
	name := ""
	if row.DisplayName != nil {
		name = *row.DisplayName
	}
	token, err := auth.IssueToken(s.cfg.SessionSecret, "password", name)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "session error")
		return
	}
	http.SetCookie(w, auth.NewSessionCookie(token, s.secureCookies()))
	writeJSON(w, http.StatusOK, map[string]any{"success": true, "token": token, "displayName": name})
}

// POST /auth/logout
func (s *Server) handleLogout(w http.ResponseWriter, r *http.Request) {
	http.SetCookie(w, auth.ClearSessionCookie(s.secureCookies()))
	writeJSON(w, http.StatusOK, map[string]any{"success": true})
}

// --- OIDC ---

type oidcTxnClaims struct {
	State        string `json:"state"`
	Nonce        string `json:"nonce"`
	CodeVerifier string `json:"codeVerifier"`
	jwt.RegisteredClaims
}

func (s *Server) oidcProvider(ctx context.Context) (*oidc.Provider, *oauth2.Config, error) {
	provider, err := oidc.NewProvider(ctx, s.cfg.OIDCIssuer)
	if err != nil {
		return nil, nil, err
	}
	conf := &oauth2.Config{
		ClientID:     s.cfg.OIDCClientID,
		ClientSecret: s.cfg.OIDCClientSecret,
		Endpoint:     provider.Endpoint(),
		RedirectURL:  strings.TrimRight(s.cfg.AppURL, "/") + "/api/v1/auth/oidc/callback",
		Scopes:       []string{oidc.ScopeOpenID, "profile", "email"},
	}
	return provider, conf, nil
}

func randomToken() string {
	b := make([]byte, 32)
	_, _ = rand.Read(b)
	return base64.RawURLEncoding.EncodeToString(b)
}

func (s *Server) loginRedirect(w http.ResponseWriter, r *http.Request, errCode string) {
	url := strings.TrimRight(s.cfg.AppURL, "/") + "/login"
	if errCode != "" {
		url += "?error=" + errCode
	}
	http.Redirect(w, r, url, http.StatusFound)
}

// GET /auth/oidc/login — 404 when unconfigured (login page probes this).
func (s *Server) handleOIDCLogin(w http.ResponseWriter, r *http.Request) {
	if !s.oidcEnabled() {
		writeError(w, http.StatusNotFound, "OIDC not configured")
		return
	}
	_, conf, err := s.oidcProvider(r.Context())
	if err != nil {
		s.loginRedirect(w, r, "oidc_unavailable")
		return
	}
	state, nonce, verifier := randomToken(), randomToken(), oauth2.GenerateVerifier()

	txn := oidcTxnClaims{
		State: state, Nonce: nonce, CodeVerifier: verifier,
		RegisteredClaims: jwt.RegisteredClaims{
			ExpiresAt: jwt.NewNumericDate(time.Now().Add(10 * time.Minute)),
		},
	}
	txnToken, err := jwt.NewWithClaims(jwt.SigningMethodHS256, txn).SignedString([]byte(s.cfg.SessionSecret))
	if err != nil {
		s.loginRedirect(w, r, "oidc_unavailable")
		return
	}
	http.SetCookie(w, &http.Cookie{
		Name: oidcTxnCookie, Value: txnToken, Path: "/", MaxAge: 600,
		HttpOnly: true, Secure: s.secureCookies(), SameSite: http.SameSiteLaxMode,
	})
	authURL := conf.AuthCodeURL(state,
		oauth2.S256ChallengeOption(verifier),
		oidc.Nonce(nonce),
	)
	http.Redirect(w, r, authURL, http.StatusFound)
}

// GET /auth/oidc/callback
func (s *Server) handleOIDCCallback(w http.ResponseWriter, r *http.Request) {
	if !s.oidcEnabled() {
		writeError(w, http.StatusNotFound, "OIDC not configured")
		return
	}
	// Recover and clear the transaction cookie.
	txnCookie, err := r.Cookie(oidcTxnCookie)
	http.SetCookie(w, &http.Cookie{Name: oidcTxnCookie, Value: "", Path: "/", MaxAge: -1,
		HttpOnly: true, Secure: s.secureCookies(), SameSite: http.SameSiteLaxMode})
	if err != nil {
		s.loginRedirect(w, r, "oidc_state")
		return
	}
	var txn oidcTxnClaims
	parsed, err := jwt.ParseWithClaims(txnCookie.Value, &txn, func(t *jwt.Token) (any, error) {
		return []byte(s.cfg.SessionSecret), nil
	})
	if err != nil || !parsed.Valid {
		s.loginRedirect(w, r, "oidc_state")
		return
	}
	if r.URL.Query().Get("error") != "" {
		s.loginRedirect(w, r, "oidc_cancelled")
		return
	}
	if r.URL.Query().Get("state") != txn.State {
		s.loginRedirect(w, r, "oidc_state")
		return
	}

	provider, conf, err := s.oidcProvider(r.Context())
	if err != nil {
		s.loginRedirect(w, r, "oidc_failed")
		return
	}
	token, err := conf.Exchange(r.Context(), r.URL.Query().Get("code"),
		oauth2.VerifierOption(txn.CodeVerifier))
	if err != nil {
		s.loginRedirect(w, r, "oidc_failed")
		return
	}
	rawIDToken, ok := token.Extra("id_token").(string)
	if !ok {
		s.loginRedirect(w, r, "oidc_failed")
		return
	}
	idToken, err := provider.Verifier(&oidc.Config{ClientID: s.cfg.OIDCClientID}).
		Verify(r.Context(), rawIDToken)
	if err != nil || idToken.Nonce != txn.Nonce {
		s.loginRedirect(w, r, "oidc_failed")
		return
	}
	var idClaims struct {
		Sub               string `json:"sub"`
		Name              string `json:"name"`
		PreferredUsername string `json:"preferred_username"`
		Email             string `json:"email"`
	}
	if err := idToken.Claims(&idClaims); err != nil || idClaims.Sub == "" {
		s.loginRedirect(w, r, "oidc_failed")
		return
	}
	displayName := idClaims.Name
	if displayName == "" {
		displayName = idClaims.PreferredUsername
	}

	ctx := r.Context()
	_, err = s.pool.Exec(ctx, `
		INSERT INTO oidc_identities (issuer, subject, display_name, email)
		VALUES ($1, $2, $3, $4)
		ON CONFLICT (issuer, subject)
		DO UPDATE SET display_name = EXCLUDED.display_name, email = EXCLUDED.email, last_login_at = now()`,
		s.cfg.OIDCIssuer, idClaims.Sub, nullIfEmpty(displayName), nullIfEmpty(idClaims.Email))
	if err != nil {
		s.loginRedirect(w, r, "oidc_failed")
		return
	}
	// Bootstrap the instance settings row on first OIDC login.
	row, err := s.loadSettings(ctx)
	if err != nil {
		s.loginRedirect(w, r, "oidc_failed")
		return
	}
	if row == nil {
		if _, err := s.pool.Exec(ctx,
			`INSERT INTO user_settings (password_hash, display_name) VALUES (NULL, $1)`,
			nullIfEmpty(displayName)); err != nil {
			s.loginRedirect(w, r, "oidc_failed")
			return
		}
	}

	sessionToken, err := auth.IssueToken(s.cfg.SessionSecret, idClaims.Sub, displayName)
	if err != nil {
		s.loginRedirect(w, r, "oidc_failed")
		return
	}
	http.SetCookie(w, auth.NewSessionCookie(sessionToken, s.secureCookies()))
	http.Redirect(w, r, strings.TrimRight(s.cfg.AppURL, "/")+"/dashboard", http.StatusFound)
}

func nullIfEmpty(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}
