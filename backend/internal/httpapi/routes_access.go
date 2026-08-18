package httpapi

import (
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"golang.org/x/crypto/bcrypt"
)

func (s *Server) mountAccess(r chi.Router) {
	r.Get("/access/me", s.accessMe)
	r.Post("/access/me/password", s.accessSetPassword)
	r.Get("/access/tokens", s.accessTokenList)
	r.Post("/access/tokens", s.accessTokenCreate)
	r.Delete("/access/tokens/{id}", s.accessTokenDelete)

	r.With(s.requireAdmin).Get("/access/users", s.accessUserList)
	r.With(s.requireAdmin).Post("/access/users", s.accessUserCreate)
	r.With(s.requireAdmin).Put("/access/users/{id}", s.accessUserUpdate)
	r.With(s.requireAdmin).Delete("/access/users/{id}", s.accessUserDeactivate)
}

type accessMembership struct {
	ApiaryID   uuid.UUID `json:"apiaryId"`
	ApiaryName string    `json:"apiaryName"`
	Role       string    `json:"role"`
}

type accessUser struct {
	ID          uuid.UUID          `json:"id"`
	DisplayName string             `json:"displayName"`
	Email       *string            `json:"email"`
	IsAdmin     bool               `json:"isAdmin"`
	IsActive    bool               `json:"isActive"`
	IsPending   bool               `json:"isPending"`
	Memberships []accessMembership `json:"memberships"`
	CreatedAt   time.Time          `json:"createdAt"`
}

func (s *Server) accessUsers(r *http.Request, where string, args ...any) ([]accessUser, error) {
	rows, err := s.pool.Query(r.Context(), `
		SELECT user_row.id, COALESCE(user_row.display_name,''), user_row.email,
			user_row.is_admin, user_row.is_active, user_row.auth_subject IS NULL,
			user_row.created_at,
			COALESCE(jsonb_agg(jsonb_build_object(
				'apiaryId', apiary.id,
				'apiaryName', apiary.name,
				'role', membership.role
			) ORDER BY apiary.name) FILTER (WHERE membership.apiary_id IS NOT NULL), '[]'::jsonb)
		FROM app_users user_row
		LEFT JOIN apiary_memberships membership ON membership.user_id=user_row.id
		LEFT JOIN apiaries apiary ON apiary.id=membership.apiary_id
		`+where+`
		GROUP BY user_row.id
		ORDER BY user_row.is_admin DESC, lower(COALESCE(user_row.display_name,user_row.email,''))`,
		args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := []accessUser{}
	for rows.Next() {
		var item accessUser
		var memberships []byte
		if err := rows.Scan(&item.ID, &item.DisplayName, &item.Email, &item.IsAdmin,
			&item.IsActive, &item.IsPending, &item.CreatedAt, &memberships); err != nil {
			return nil, err
		}
		if err := json.Unmarshal(memberships, &item.Memberships); err != nil {
			return nil, err
		}
		items = append(items, item)
	}
	return items, rows.Err()
}

func (s *Server) accessUserList(w http.ResponseWriter, r *http.Request) {
	items, err := s.accessUsers(r, "")
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	writeJSON(w, http.StatusOK, items)
}

type accessUserPayload struct {
	DisplayName string `json:"displayName"`
	Email       string `json:"email"`
	IsActive    *bool  `json:"isActive"`
	Memberships []struct {
		ApiaryID uuid.UUID `json:"apiaryId"`
		Role     string    `json:"role"`
	} `json:"memberships"`
}

func validateAccessUserPayload(value *accessUserPayload) error {
	value.DisplayName = strings.TrimSpace(value.DisplayName)
	value.Email = strings.ToLower(strings.TrimSpace(value.Email))
	if value.DisplayName == "" || value.Email == "" || len(value.Email) > 254 ||
		!strings.Contains(value.Email, "@") {
		return errors.New("display name and valid email are required")
	}
	seen := map[uuid.UUID]bool{}
	for _, membership := range value.Memberships {
		if membership.ApiaryID == uuid.Nil ||
			(membership.Role != "viewer" && membership.Role != "editor") {
			return errors.New("every membership needs an apiary and viewer or editor role")
		}
		if seen[membership.ApiaryID] {
			return errors.New("an apiary can only be assigned once")
		}
		seen[membership.ApiaryID] = true
	}
	if len(value.Memberships) == 0 {
		return errors.New("assign at least one apiary")
	}
	return nil
}

func (s *Server) accessSaveMemberships(
	r *http.Request,
	tx pgx.Tx,
	userID uuid.UUID,
	memberships []struct {
		ApiaryID uuid.UUID `json:"apiaryId"`
		Role     string    `json:"role"`
	},
) error {
	if _, err := tx.Exec(r.Context(),
		`DELETE FROM apiary_memberships WHERE user_id=$1`, userID); err != nil {
		return err
	}
	for _, membership := range memberships {
		if _, err := tx.Exec(r.Context(), `
			INSERT INTO apiary_memberships (user_id,apiary_id,role)
			VALUES ($1,$2,$3)`,
			userID, membership.ApiaryID, membership.Role); err != nil {
			return err
		}
	}
	return nil
}

func (s *Server) accessUserCreate(w http.ResponseWriter, r *http.Request) {
	var req accessUserPayload
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if err := validateAccessUserPayload(&req); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	tx, err := s.pool.Begin(r.Context())
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	defer tx.Rollback(r.Context())
	var id uuid.UUID
	err = tx.QueryRow(r.Context(), `
		INSERT INTO app_users (display_name,email,is_admin,is_active)
		VALUES ($1,$2,false,true)
		RETURNING id`, req.DisplayName, req.Email).Scan(&id)
	if err != nil {
		writeError(w, http.StatusConflict, "a user with that email already exists")
		return
	}
	if err := s.accessSaveMemberships(r, tx, id, req.Memberships); err != nil {
		writeError(w, http.StatusBadRequest, "one or more apiaries were not found")
		return
	}
	if err := tx.Commit(r.Context()); err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	items, err := s.accessUsers(r, "WHERE user_row.id=$1", id)
	if err != nil || len(items) != 1 {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	writeJSON(w, http.StatusCreated, items[0])
}

func (s *Server) accessUserUpdate(w http.ResponseWriter, r *http.Request) {
	id, err := uuidParam(r, "id")
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	var req accessUserPayload
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if err := validateAccessUserPayload(&req); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	active := true
	if req.IsActive != nil {
		active = *req.IsActive
	}
	tx, err := s.pool.Begin(r.Context())
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	defer tx.Rollback(r.Context())
	tag, err := tx.Exec(r.Context(), `
		UPDATE app_users SET display_name=$1,email=$2,is_active=$3
		WHERE id=$4 AND is_admin=false`, req.DisplayName, req.Email, active, id)
	if err != nil {
		writeError(w, http.StatusConflict, "a user with that email already exists")
		return
	}
	if tag.RowsAffected() == 0 {
		writeError(w, http.StatusNotFound, "editable user not found")
		return
	}
	if err := s.accessSaveMemberships(r, tx, id, req.Memberships); err != nil {
		writeError(w, http.StatusBadRequest, "one or more apiaries were not found")
		return
	}
	if err := tx.Commit(r.Context()); err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	items, err := s.accessUsers(r, "WHERE user_row.id=$1", id)
	if err != nil || len(items) != 1 {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	writeJSON(w, http.StatusOK, items[0])
}

func (s *Server) accessUserDeactivate(w http.ResponseWriter, r *http.Request) {
	id, err := uuidParam(r, "id")
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	tag, err := s.pool.Exec(r.Context(), `
		UPDATE app_users SET is_active=false
		WHERE id=$1 AND is_admin=false`, id)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	if tag.RowsAffected() == 0 {
		writeError(w, http.StatusNotFound, "editable user not found")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"success": true})
}

func (s *Server) accessMe(w http.ResponseWriter, r *http.Request) {
	user := principalFrom(r)
	if user == nil {
		writeError(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	rows, err := s.pool.Query(r.Context(), `
		SELECT apiary.id,apiary.name,membership.role::text
		FROM apiary_memberships membership
		JOIN apiaries apiary ON apiary.id=membership.apiary_id
		WHERE membership.user_id=$1 ORDER BY apiary.name`, user.ID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	defer rows.Close()
	memberships := []accessMembership{}
	for rows.Next() {
		var item accessMembership
		if err := rows.Scan(&item.ApiaryID, &item.ApiaryName, &item.Role); err != nil {
			writeError(w, http.StatusInternalServerError, "database error")
			return
		}
		memberships = append(memberships, item)
	}
	var (
		hasPassword bool
		username    *string
	)
	if err := s.pool.QueryRow(r.Context(),
		`SELECT password_hash IS NOT NULL, username FROM app_users WHERE id=$1`,
		user.ID).Scan(&hasPassword, &username); err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"id": user.ID, "displayName": user.DisplayName, "email": user.Email,
		"username": username, "isAdmin": user.IsAdmin, "hasPassword": hasPassword,
		"memberships": memberships,
	})
}

func (s *Server) accessSetPassword(w http.ResponseWriter, r *http.Request) {
	user := principalFrom(r)
	if user == nil {
		writeError(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	var req struct {
		Username        string `json:"username"`
		CurrentPassword string `json:"currentPassword"`
		Password        string `json:"password"`
		ConfirmPassword string `json:"confirmPassword"`
	}
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	req.Username = strings.ToLower(strings.TrimSpace(req.Username))
	req.Password = strings.TrimSpace(req.Password)
	req.ConfirmPassword = strings.TrimSpace(req.ConfirmPassword)
	email := ""
	if user.Email != nil {
		email = strings.TrimSpace(*user.Email)
	}
	switch {
	case email == "" && req.Username == "":
		writeError(w, http.StatusBadRequest, "Choose a username so you can sign in without SSO")
		return
	case req.Username != "" && (strings.ContainsAny(req.Username, " \t") || len(req.Username) < 3 || len(req.Username) > 64):
		writeError(w, http.StatusBadRequest, "Username must be 3–64 characters with no spaces")
		return
	case req.Password == "":
		writeError(w, http.StatusBadRequest, "Password is required")
		return
	case req.Password != req.ConfirmPassword:
		writeError(w, http.StatusBadRequest, "Passwords do not match")
		return
	case len(req.Password) < 8:
		writeError(w, http.StatusBadRequest, "Password must be at least 8 characters")
		return
	}

	var (
		subject string
		hash    *string
	)
	err := s.pool.QueryRow(r.Context(),
		`SELECT COALESCE(auth_subject, ''), password_hash FROM app_users WHERE id=$1`,
		user.ID).Scan(&subject, &hash)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	if subject == "" {
		writeError(w, http.StatusBadRequest, "Sign in with SSO once before adding a password")
		return
	}
	if hash != nil {
		if req.CurrentPassword == "" {
			writeError(w, http.StatusBadRequest, "Current password is required")
			return
		}
		if bcrypt.CompareHashAndPassword([]byte(*hash), []byte(req.CurrentPassword)) != nil {
			writeError(w, http.StatusUnauthorized, "Current password is incorrect")
			return
		}
	}

	next, err := bcrypt.GenerateFromPassword([]byte(req.Password), 12)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "hashing failed")
		return
	}
	if req.Username != "" {
		if _, err := s.pool.Exec(r.Context(),
			`UPDATE app_users SET password_hash=$1, username=$2 WHERE id=$3`,
			string(next), req.Username, user.ID); err != nil {
			writeError(w, http.StatusConflict, "That username is already in use")
			return
		}
	} else if _, err := s.pool.Exec(r.Context(),
		`UPDATE app_users SET password_hash=$1 WHERE id=$2`,
		string(next), user.ID); err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"success": true, "hasPassword": true})
}

type accessTokenRow struct {
	ID         uuid.UUID  `json:"id"`
	Name       string     `json:"name"`
	LastUsedAt *time.Time `json:"lastUsedAt"`
	ExpiresAt  *time.Time `json:"expiresAt"`
	CreatedAt  time.Time  `json:"createdAt"`
}

func (s *Server) accessTokenList(w http.ResponseWriter, r *http.Request) {
	user := principalFrom(r)
	rows, err := s.pool.Query(r.Context(), `
		SELECT id,name,last_used_at,expires_at,created_at
		FROM api_tokens WHERE user_id=$1 ORDER BY created_at DESC`, user.ID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	defer rows.Close()
	items := []accessTokenRow{}
	for rows.Next() {
		var item accessTokenRow
		if err := rows.Scan(&item.ID, &item.Name, &item.LastUsedAt, &item.ExpiresAt,
			&item.CreatedAt); err != nil {
			writeError(w, http.StatusInternalServerError, "database error")
			return
		}
		items = append(items, item)
	}
	writeJSON(w, http.StatusOK, items)
}

func (s *Server) accessTokenCreate(w http.ResponseWriter, r *http.Request) {
	user := principalFrom(r)
	var req struct {
		Name string `json:"name"`
	}
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	req.Name = strings.TrimSpace(req.Name)
	if req.Name == "" || len(req.Name) > 100 {
		writeError(w, http.StatusBadRequest, "token name is required")
		return
	}
	random := make([]byte, 32)
	if _, err := rand.Read(random); err != nil {
		writeError(w, http.StatusInternalServerError, "token generation failed")
		return
	}
	token := "bt_" + base64.RawURLEncoding.EncodeToString(random)
	var row accessTokenRow
	err := s.pool.QueryRow(r.Context(), `
		INSERT INTO api_tokens (user_id,name,token_hash)
		VALUES ($1,$2,$3)
		RETURNING id,name,last_used_at,expires_at,created_at`,
		user.ID, req.Name, apiTokenHash(token)).
		Scan(&row.ID, &row.Name, &row.LastUsedAt, &row.ExpiresAt, &row.CreatedAt)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{
		"id": row.ID, "name": row.Name, "createdAt": row.CreatedAt, "token": token,
	})
}

func (s *Server) accessTokenDelete(w http.ResponseWriter, r *http.Request) {
	user := principalFrom(r)
	id, err := uuidParam(r, "id")
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	tag, err := s.pool.Exec(r.Context(),
		`DELETE FROM api_tokens WHERE id=$1 AND user_id=$2`, id, user.ID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	if tag.RowsAffected() == 0 {
		writeError(w, http.StatusNotFound, "token not found")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"success": true})
}
