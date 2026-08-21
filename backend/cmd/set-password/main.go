// Set or replace the password on an existing SSO user (matched by email).
// Reads DATABASE_URL from the environment or nearby .env / .env.local files
// (backend/.env.local when you run from backend/). Prompts on stdin.
package main

import (
	"bufio"
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"github.com/biker2000on/beez-trackz/backend/internal/config"
	"github.com/biker2000on/beez-trackz/backend/internal/db"
	"golang.org/x/crypto/bcrypt"
	"golang.org/x/term"
)

func main() {
	config.LoadDotEnv()
	cfg, err := config.Load()
	if err != nil {
		fmt.Fprintln(os.Stderr, "config:", err)
		os.Exit(1)
	}

	email := strings.TrimSpace(flagValue("email"))
	username := strings.ToLower(strings.TrimSpace(flagValue("username")))
	if username == "" {
		// Never use the process USERNAME — on Windows that is the OS account.
		username = strings.ToLower(strings.TrimSpace(firstNonEmpty(
			os.Getenv("BEEZ_USERNAME"),
			os.Getenv("LOGIN_USERNAME"),
			dotenvValue("BEEZ_USERNAME"),
			dotenvValue("LOGIN_USERNAME"),
			dotenvValue("USERNAME"),
		)))
	}
	if password := strings.TrimSpace(firstNonEmpty(os.Getenv("PASSWORD"), dotenvValue("PASSWORD"))); password != "" {
		_ = os.Setenv("PASSWORD", password)
	}
	if (email == "" || !strings.Contains(email, "@")) && username == "" {
		fmt.Fprintln(os.Stderr, "usage: set-password --email you@example.com")
		fmt.Fprintln(os.Stderr, "   or: set-password --username justin")
		fmt.Fprintln(os.Stderr, "   or set BEEZ_USERNAME / PASSWORD in .env.local")
		os.Exit(2)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	pool, err := db.Connect(ctx, cfg.DatabaseURL)
	if err != nil {
		fmt.Fprintln(os.Stderr, "database:", err)
		os.Exit(1)
	}
	defer pool.Close()

	var (
		id      string
		subject *string
	)
	if email != "" {
		err = pool.QueryRow(ctx, `
			SELECT id::text, auth_subject FROM app_users
			WHERE is_active AND email IS NOT NULL AND lower(email)=lower($1)`,
			email).Scan(&id, &subject)
	} else {
		err = pool.QueryRow(ctx, `
			SELECT id::text, auth_subject FROM app_users
			WHERE is_active AND (
				(username IS NOT NULL AND lower(username)=lower($1))
				OR lower(coalesce(display_name,''))=lower($1)
			)`, username).Scan(&id, &subject)
	}
	if err != nil && username != "" {
		// Local/dev often has a single SSO owner with no email yet.
		err = pool.QueryRow(ctx, `
			SELECT id::text, auth_subject FROM app_users
			WHERE is_active AND auth_subject IS NOT NULL AND auth_subject <> ''
			ORDER BY created_at ASC LIMIT 2`).Scan(&id, &subject)
		var extra string
		if err == nil {
			_ = pool.QueryRow(ctx, `
				SELECT id::text FROM app_users
				WHERE is_active AND auth_subject IS NOT NULL AND auth_subject <> ''
					AND id::text <> $1 LIMIT 1`, id).Scan(&extra)
			if extra != "" {
				err = fmt.Errorf("more than one SSO user; pass --email")
			}
		}
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, "no active SSO user matched")
		os.Exit(1)
	}
	if subject == nil || *subject == "" {
		fmt.Fprintln(os.Stderr, "that user has never signed in with SSO")
		os.Exit(1)
	}

	password := os.Getenv("PASSWORD")
	if password == "" {
		var err error
		password, err = readPassword("New password: ")
		if err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		confirm, err := readPassword("Confirm password: ")
		if err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		if password != confirm {
			fmt.Fprintln(os.Stderr, "passwords do not match")
			os.Exit(1)
		}
	}
	if len(password) < 8 {
		fmt.Fprintln(os.Stderr, "password must be at least 8 characters")
		os.Exit(1)
	}

	hash, err := bcrypt.GenerateFromPassword([]byte(password), 12)
	if err != nil {
		fmt.Fprintln(os.Stderr, "hash:", err)
		os.Exit(1)
	}
	if username != "" {
		if _, err := pool.Exec(ctx,
			`UPDATE app_users SET password_hash=$1, username=$2 WHERE id=$3`,
			string(hash), username, id); err != nil {
			fmt.Fprintln(os.Stderr, "update:", err)
			os.Exit(1)
		}
	} else if _, err := pool.Exec(ctx,
		`UPDATE app_users SET password_hash=$1 WHERE id=$2`,
		string(hash), id); err != nil {
		fmt.Fprintln(os.Stderr, "update:", err)
		os.Exit(1)
	}
	if email != "" {
		fmt.Println("password saved for", email)
	} else {
		fmt.Println("password saved for", username)
	}
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return value
		}
	}
	return ""
}

func dotenvValue(key string) string {
	for _, path := range []string{
		".env.local",
		".env",
		filepath.Join("..", ".env.local"),
		filepath.Join("..", ".env"),
		filepath.Join("backend", ".env.local"),
		filepath.Join("backend", ".env"),
	} {
		file, err := os.Open(path)
		if err != nil {
			continue
		}
		found := ""
		scanner := bufio.NewScanner(file)
		for scanner.Scan() {
			line := strings.TrimSpace(scanner.Text())
			if line == "" || strings.HasPrefix(line, "#") {
				continue
			}
			name, value, ok := strings.Cut(line, "=")
			if !ok || strings.TrimSpace(name) != key {
				continue
			}
			value = strings.TrimSpace(value)
			if len(value) >= 2 {
				if q := value[0]; (q == '"' || q == '\'') && value[len(value)-1] == q {
					value = value[1 : len(value)-1]
				}
			}
			found = value
		}
		file.Close()
		if found != "" {
			return found
		}
	}
	return ""
}

func flagValue(name string) string {
	prefix := "--" + name
	args := os.Args[1:]
	for i := 0; i < len(args); i++ {
		if args[i] == prefix && i+1 < len(args) {
			return args[i+1]
		}
		if strings.HasPrefix(args[i], prefix+"=") {
			return strings.TrimPrefix(args[i], prefix+"=")
		}
	}
	return ""
}

func readPassword(prompt string) (string, error) {
	fmt.Fprint(os.Stderr, prompt)
	fd := int(syscall.Stdin)
	if term.IsTerminal(fd) {
		bytes, err := term.ReadPassword(fd)
		fmt.Fprintln(os.Stderr)
		if err != nil {
			return "", err
		}
		return string(bytes), nil
	}
	reader := bufio.NewReader(os.Stdin)
	line, err := reader.ReadString('\n')
	return strings.TrimRight(line, "\r\n"), err
}
