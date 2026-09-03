package httpapi

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"net/http"
	"net/url"
	"strings"

	"github.com/biker2000on/beez-trackz/backend/internal/auth"
	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

type ctxKey int

const (
	sessionKey ctxKey = iota
	principalKey
)

type principal struct {
	ID          uuid.UUID `json:"id"`
	AuthSubject string    `json:"-"`
	DisplayName string    `json:"displayName"`
	Email       *string   `json:"email"`
	IsAdmin     bool      `json:"isAdmin"`
	// Memberships is the per-request apiary authorization snapshot. It is
	// loaded in one batched query by requireSession and copied into app.Actor
	// when a handler starts a command.
	Memberships map[uuid.UUID]string `json:"-"`
	// FromAPIToken is set when the principal was resolved from a bt_ API
	// token rather than a browser session; credential changes refuse it.
	FromAPIToken bool `json:"-"`
}

func sessionFrom(r *http.Request) *auth.Session {
	value, _ := r.Context().Value(sessionKey).(*auth.Session)
	return value
}

func principalFrom(r *http.Request) *principal {
	value, _ := r.Context().Value(principalKey).(*principal)
	return value
}

func apiaryMembershipsFrom(r *http.Request) map[uuid.UUID]string {
	if user := principalFrom(r); user != nil {
		return user.Memberships
	}
	return nil
}

// loadPrincipalMemberships snapshots every apiary role for this principal in
// one query. The snapshot lives only for the request: authorization inputs
// travel with app.Actor, while commands never query them or cache them across
// requests.
func (s *Server) loadPrincipalMemberships(ctx context.Context, user *principal) error {
	rows, err := s.pool.Query(ctx, `
		SELECT apiary_id, role::text
		FROM apiary_memberships
		WHERE user_id=$1`, user.ID)
	if err != nil {
		return err
	}
	defer rows.Close()

	memberships := make(map[uuid.UUID]string)
	for rows.Next() {
		var apiaryID uuid.UUID
		var role string
		if err := rows.Scan(&apiaryID, &role); err != nil {
			return err
		}
		memberships[apiaryID] = role
	}
	if err := rows.Err(); err != nil {
		return err
	}
	user.Memberships = memberships
	return nil
}

func apiTokenHash(value string) string {
	sum := sha256.Sum256([]byte(value))
	return hex.EncodeToString(sum[:])
}

func bearerValue(r *http.Request) string {
	value := strings.TrimSpace(r.Header.Get("Authorization"))
	if len(value) < 8 || !strings.EqualFold(value[:7], "Bearer ") {
		return ""
	}
	return strings.TrimSpace(value[7:])
}

func (s *Server) principalFromAPIToken(r *http.Request, token string) (*principal, error) {
	var value principal
	err := s.pool.QueryRow(r.Context(), `
		SELECT user_row.id, COALESCE(user_row.auth_subject, ''),
			COALESCE(user_row.display_name, ''), user_row.email, user_row.is_admin
		FROM api_tokens token
		JOIN app_users user_row ON user_row.id = token.user_id
		WHERE token.token_hash=$1 AND user_row.is_active
			AND (token.expires_at IS NULL OR token.expires_at > now())`,
		apiTokenHash(token)).
		Scan(&value.ID, &value.AuthSubject, &value.DisplayName, &value.Email, &value.IsAdmin)
	if err != nil {
		return nil, err
	}
	_, _ = s.pool.Exec(r.Context(),
		`UPDATE api_tokens SET last_used_at=now()
		 WHERE token_hash=$1
		   AND (last_used_at IS NULL OR last_used_at < now() - interval '5 minutes')`,
		apiTokenHash(token))
	return &value, nil
}

func (s *Server) principalFromSession(r *http.Request, session *auth.Session) (*principal, error) {
	var value principal
	err := s.pool.QueryRow(r.Context(), `
		SELECT user_row.id, COALESCE(user_row.auth_subject, ''),
			COALESCE(user_row.display_name, ''), user_row.email, user_row.is_admin
		FROM app_users user_row
		WHERE user_row.is_active AND (
			user_row.auth_subject=$1
			OR EXISTS (
				SELECT 1 FROM oidc_identities identity
				WHERE identity.user_id=user_row.id AND identity.subject=$1
			)
		)
		ORDER BY (user_row.auth_subject=$1) DESC
		LIMIT 1`, session.Sub).
		Scan(&value.ID, &value.AuthSubject, &value.DisplayName, &value.Email, &value.IsAdmin)
	if err != nil {
		return nil, err
	}
	if value.DisplayName == "" {
		value.DisplayName = session.Name
	}
	return &value, nil
}

// requireSession accepts the signed session cookie, its bearer-token form, or
// an API token. It resolves the authenticated subject to an active app user so
// every downstream request has one stable authorization principal.
func (s *Server) requireSession(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var (
			session *auth.Session
			user    *principal
			err     error
			bearer  = bearerValue(r)
		)
		if strings.HasPrefix(bearer, "bt_") {
			user, err = s.principalFromAPIToken(r, bearer)
			if err == nil {
				user.FromAPIToken = true
				session = &auth.Session{Sub: user.AuthSubject, Name: user.DisplayName}
			}
		} else {
			session, err = auth.SessionFromRequest(r, s.cfg.SessionSecret)
			if err == nil {
				user, err = s.principalFromSession(r, session)
			}
		}
		if errors.Is(err, pgx.ErrNoRows) {
			writeError(w, http.StatusForbidden, "account is not authorized")
			return
		}
		if err != nil || session == nil || user == nil {
			writeError(w, http.StatusUnauthorized, "unauthorized")
			return
		}
		if err := s.loadPrincipalMemberships(r.Context(), user); err != nil {
			writeError(w, http.StatusInternalServerError, "database error")
			return
		}
		ctx := context.WithValue(r.Context(), sessionKey, session)
		ctx = context.WithValue(ctx, principalKey, user)
		next.ServeHTTP(w, r.WithContext(ctx))
	})
}

// --- CSRF (SEAM-021) ---------------------------------------------------
//
// The session cookie is ambient authority: a browser attaches it to any
// cross-site form post or fetch. Every mutating REST route is therefore
// gated on the request proving it came from this app's own origin.
//
// The frontend calls the API through the Next.js proxy, which forwards the
// browser's Origin (APP_URL), and the service worker's replayed
// mutations are same-origin fetches that also carry Origin. Non-browser
// clients authenticate with a Bearer API token, which is not ambient and so
// needs no origin proof.

// originAllowed reports whether raw (an Origin header value, or the origin
// half of a Referer) is one of this deployment's own origins: APP_URL, plus
// PUBLIC_STORY_BASE_URL when configured (the apex domain whose proxy fronts
// the public Honey Story pages — its subscribe POST arrives with that
// Origin). Both are operator-set values, never request-derived. The
// request's own Host header is deliberately NOT accepted as a second
// allowlist entry: an attacker controls Host as easily as Origin, so trusting
// it would give away both the CSRF and the MCP DNS-rebinding guarantee.
func (s *Server) originAllowed(raw string) bool {
	if s.cfg == nil {
		return false
	}
	requestOrigin, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || requestOrigin.Host == "" {
		return false
	}
	for _, allowed := range []string{s.cfg.AppURL, s.cfg.PublicStoryBaseURL} {
		if allowed == "" {
			continue
		}
		appOrigin, err := url.Parse(allowed)
		if err != nil || appOrigin.Host == "" {
			continue
		}
		if strings.EqualFold(requestOrigin.Scheme, appOrigin.Scheme) &&
			strings.EqualFold(requestOrigin.Host, appOrigin.Host) {
			return true
		}
	}
	return false
}

// requestOrigin returns the Origin header, falling back to the origin of the
// Referer. An empty result means the client sent neither.
func requestOrigin(r *http.Request) string {
	if origin := strings.TrimSpace(r.Header.Get("Origin")); origin != "" &&
		origin != "null" {
		return origin
	}
	referer := strings.TrimSpace(r.Header.Get("Referer"))
	if referer == "" {
		return ""
	}
	parsed, err := url.Parse(referer)
	if err != nil || parsed.Host == "" {
		// A malformed Referer is not "absent" — fail closed with a value
		// that cannot match any allowed origin.
		return "invalid://referer"
	}
	return parsed.Scheme + "://" + parsed.Host
}

// requireSameOrigin 403s cross-site mutating requests that rely on the
// session cookie.
func (s *Server) requireSameOrigin(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !mutationMethod(r.Method) || strings.HasPrefix(bearerValue(r), "bt_") {
			next.ServeHTTP(w, r)
			return
		}
		origin := requestOrigin(r)
		if origin == "" {
			// No Origin and no Referer. Browsers always send Origin on
			// mutating requests, so this is a non-browser client; it is only
			// a CSRF vector if it also presented the ambient cookie.
			if _, err := r.Cookie(auth.SessionCookieName); err != nil {
				next.ServeHTTP(w, r)
				return
			}
			writeError(w, http.StatusForbidden,
				"cookie-authenticated writes must send an Origin header")
			return
		}
		if !s.originAllowed(origin) {
			writeError(w, http.StatusForbidden, "untrusted request origin")
			return
		}
		next.ServeHTTP(w, r)
	})
}

func (s *Server) requireAdmin(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		user := principalFrom(r)
		if user == nil || !user.IsAdmin {
			writeError(w, http.StatusForbidden, "administrator access required")
			return
		}
		next.ServeHTTP(w, r)
	})
}

func (s *Server) apiaryRole(r *http.Request, apiaryID uuid.UUID) (string, error) {
	user := principalFrom(r)
	if user == nil {
		return "", pgx.ErrNoRows
	}
	if user.IsAdmin {
		return "editor", nil
	}
	// A nil map means an internal caller bypassed requireSession. Keep the
	// direct-handler test and job path compatible; authenticated HTTP requests
	// always carry a non-nil snapshot, including for a non-member, and never
	// take this per-entity fallback.
	if user.Memberships == nil {
		var role string
		err := s.pool.QueryRow(r.Context(), `
			SELECT role::text FROM apiary_memberships
			WHERE user_id=$1 AND apiary_id=$2`, user.ID, apiaryID).Scan(&role)
		return role, err
	}
	role, ok := user.Memberships[apiaryID]
	if !ok {
		return "", pgx.ErrNoRows
	}
	return role, nil
}

func (s *Server) requireApiaryRole(
	w http.ResponseWriter,
	r *http.Request,
	apiaryID uuid.UUID,
	edit bool,
) bool {
	role, err := s.apiaryRole(r, apiaryID)
	if errors.Is(err, pgx.ErrNoRows) {
		writeError(w, http.StatusForbidden, "apiary access denied")
		return false
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return false
	}
	if edit && role != "editor" {
		writeError(w, http.StatusForbidden, "editor access required")
		return false
	}
	return true
}

func (s *Server) requireHiveRole(
	w http.ResponseWriter,
	r *http.Request,
	hiveID uuid.UUID,
	edit bool,
) bool {
	var apiaryID uuid.UUID
	err := s.pool.QueryRow(r.Context(),
		`SELECT apiary_id FROM hives WHERE id=$1`, hiveID).Scan(&apiaryID)
	if errors.Is(err, pgx.ErrNoRows) {
		writeError(w, http.StatusNotFound, "hive not found")
		return false
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return false
	}
	return s.requireApiaryRole(w, r, apiaryID, edit)
}

func (s *Server) ownerApiaryID(
	r *http.Request,
	ownerType string,
	ownerID uuid.UUID,
) (uuid.UUID, error) {
	switch ownerType {
	case "apiary":
		var exists bool
		if err := s.pool.QueryRow(r.Context(),
			`SELECT EXISTS (SELECT 1 FROM apiaries WHERE id=$1)`, ownerID).
			Scan(&exists); err != nil {
			return uuid.Nil, err
		}
		if !exists {
			return uuid.Nil, pgx.ErrNoRows
		}
		return ownerID, nil
	case "hive":
		var apiaryID uuid.UUID
		err := s.pool.QueryRow(r.Context(),
			`SELECT apiary_id FROM hives WHERE id=$1`, ownerID).Scan(&apiaryID)
		return apiaryID, err
	case "inspection":
		var apiaryID uuid.UUID
		err := s.pool.QueryRow(r.Context(), `
			SELECT hive.apiary_id FROM inspections inspection
			JOIN hives hive ON hive.id=inspection.hive_id
			WHERE inspection.id=$1`, ownerID).Scan(&apiaryID)
		return apiaryID, err
	default:
		return uuid.Nil, errors.New("invalid owner type")
	}
}

func (s *Server) requireOwnerRole(
	w http.ResponseWriter,
	r *http.Request,
	ownerType string,
	ownerID uuid.UUID,
	edit bool,
) bool {
	apiaryID, err := s.ownerApiaryID(r, ownerType, ownerID)
	if errors.Is(err, pgx.ErrNoRows) {
		writeError(w, http.StatusNotFound, "owner not found")
		return false
	}
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid owner")
		return false
	}
	return s.requireApiaryRole(w, r, apiaryID, edit)
}

func (s *Server) requireApiaryParamRole(edit bool) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			id, err := uuid.Parse(chi.URLParam(r, "id"))
			if err != nil {
				writeError(w, http.StatusBadRequest, "invalid apiary id")
				return
			}
			if !s.requireApiaryRole(w, r, id, edit) {
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}

func (s *Server) requireHiveParamRole(edit bool) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			id, err := uuid.Parse(chi.URLParam(r, "id"))
			if err != nil {
				writeError(w, http.StatusBadRequest, "invalid hive id")
				return
			}
			if !s.requireHiveRole(w, r, id, edit) {
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}

func (s *Server) entityApiaryID(r *http.Request, kind string, id uuid.UUID) (uuid.UUID, error) {
	if kind == "recommendation" {
		var apiaryID *uuid.UUID
		err := s.pool.QueryRow(r.Context(), `
			SELECT hive.apiary_id FROM ai_recommendations item
			LEFT JOIN hives hive ON hive.id=item.hive_id
			WHERE item.id=$1`, id).Scan(&apiaryID)
		if err != nil {
			return uuid.Nil, err
		}
		if apiaryID == nil {
			return uuid.Nil, errEntityRequiresAdmin
		}
		return *apiaryID, nil
	}

	var apiaryID uuid.UUID
	queries := map[string]string{
		"inspection": `SELECT hive.apiary_id FROM inspections item
			JOIN hives hive ON hive.id=item.hive_id WHERE item.id=$1`,
		"feeding": `SELECT hive.apiary_id FROM feedings item
			JOIN hives hive ON hive.id=item.hive_id WHERE item.id=$1`,
		"bloom": `SELECT apiary_id FROM bloom_observations WHERE id=$1`,
		"queen": `SELECT hive.apiary_id FROM queens item
			JOIN hives hive ON hive.id=item.hive_id WHERE item.id=$1`,
		"split": `SELECT hive.apiary_id FROM hive_splits item
			JOIN hives hive ON hive.id=item.parent_hive_id WHERE item.id=$1`,
		"mite": `SELECT hive.apiary_id FROM mite_counts item
			JOIN hives hive ON hive.id=item.hive_id WHERE item.id=$1`,
		"treatment": `SELECT hive.apiary_id FROM treatment_events item
			JOIN hives hive ON hive.id=item.hive_id WHERE item.id=$1`,
		"queen_event": `SELECT hive.apiary_id FROM queen_events item
			JOIN hives hive ON hive.id=item.hive_id WHERE item.id=$1`,
		"photo": `SELECT CASE item.owner_type::text
				WHEN 'apiary' THEN item.owner_id
				WHEN 'hive' THEN (SELECT apiary_id FROM hives WHERE id=item.owner_id)
				WHEN 'inspection' THEN (
					SELECT hive.apiary_id FROM inspections inspection
					JOIN hives hive ON hive.id=inspection.hive_id
					WHERE inspection.id=item.owner_id
				)
			END
			FROM photos item WHERE item.id=$1`,
		"transcription": `SELECT CASE item.owner_type::text
				WHEN 'apiary' THEN item.owner_id
				WHEN 'hive' THEN (SELECT apiary_id FROM hives WHERE id=item.owner_id)
				WHEN 'inspection' THEN (
					SELECT hive.apiary_id FROM inspections inspection
					JOIN hives hive ON hive.id=inspection.hive_id
					WHERE inspection.id=item.owner_id
				)
			END
			FROM media_files item WHERE item.id=$1`,
		"harvest_session": `SELECT apiary_id FROM harvest_sessions WHERE id=$1`,
		"harvest_entry": `SELECT session.apiary_id FROM honey_harvests item
			JOIN harvest_sessions session ON session.id=item.session_id WHERE item.id=$1`,
	}
	query, ok := queries[kind]
	if !ok {
		return uuid.Nil, errors.New("unknown authorization resource")
	}
	err := s.pool.QueryRow(r.Context(), query, id).Scan(&apiaryID)
	return apiaryID, err
}

var errEntityRequiresAdmin = errors.New("resource requires administrator access")

func (s *Server) requireEntityParamRole(kind string, edit bool) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			id, err := uuid.Parse(chi.URLParam(r, "id"))
			if err != nil {
				writeError(w, http.StatusBadRequest, "invalid resource id")
				return
			}
			apiaryID, err := s.entityApiaryID(r, kind, id)
			if errors.Is(err, errEntityRequiresAdmin) {
				user := principalFrom(r)
				if user == nil || !user.IsAdmin {
					writeError(w, http.StatusForbidden, "administrator access required")
					return
				}
				next.ServeHTTP(w, r)
				return
			}
			if errors.Is(err, pgx.ErrNoRows) {
				writeError(w, http.StatusNotFound, "resource not found")
				return
			}
			if err != nil {
				writeError(w, http.StatusInternalServerError, "database error")
				return
			}
			if !s.requireApiaryRole(w, r, apiaryID, edit) {
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}
