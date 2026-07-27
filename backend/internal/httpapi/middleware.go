package httpapi

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"net/http"
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
}

func sessionFrom(r *http.Request) *auth.Session {
	value, _ := r.Context().Value(sessionKey).(*auth.Session)
	return value
}

func principalFrom(r *http.Request) *principal {
	value, _ := r.Context().Value(principalKey).(*principal)
	return value
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
		`UPDATE api_tokens SET last_used_at=now() WHERE token_hash=$1`,
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
		ctx := context.WithValue(r.Context(), sessionKey, session)
		ctx = context.WithValue(ctx, principalKey, user)
		next.ServeHTTP(w, r.WithContext(ctx))
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
	var role string
	err := s.pool.QueryRow(r.Context(), `
		SELECT role::text FROM apiary_memberships
		WHERE user_id=$1 AND apiary_id=$2`, user.ID, apiaryID).Scan(&role)
	return role, err
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
		"recommendation": `SELECT hive.apiary_id FROM ai_recommendations item
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

func (s *Server) requireEntityParamRole(kind string, edit bool) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			id, err := uuid.Parse(chi.URLParam(r, "id"))
			if err != nil {
				writeError(w, http.StatusBadRequest, "invalid resource id")
				return
			}
			apiaryID, err := s.entityApiaryID(r, kind, id)
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
