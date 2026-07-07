// Package sqlite is the durable MVP AccountStore (docs module 06): SQLite via
// modernc.org/sqlite (pure Go, no CGO). Schema is applied on open with
// CREATE TABLE IF NOT EXISTS — light enough that a full migration tool isn't
// warranted yet; the same SQL is Postgres-portable when we graduate to pgx.
package sqlite

import (
	"context"
	"database/sql"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"time"

	_ "modernc.org/sqlite"

	"mythinkingpal/server/internal/id"
	"mythinkingpal/server/internal/storage"
)

const schema = `
CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at    TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS refresh_tokens (
  token_hash TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked    INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS documents (
  id         TEXT PRIMARY KEY,
  owner_id   TEXT NOT NULL,
  title      TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_documents_owner ON documents(owner_id);
`

type Store struct {
	db *sql.DB
}

// Open connects to the SQLite file described by dsn (e.g.
// "file:data/accounts.db?_journal=WAL"), creating the parent directory and
// schema if needed. Vendor-specific query params are stripped and applied as
// PRAGMAs so the DSN stays portable across drivers.
func Open(dsn string) (*Store, error) {
	path := filePathFromDSN(dsn)
	driverDSN := "file:" + path // strip vendor query params; pragmas set below
	if path == ":memory:" || path == "" {
		driverDSN = path
	} else if dir := filepath.Dir(path); dir != "" && dir != "." {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			return nil, err
		}
	}
	db, err := sql.Open("sqlite", driverDSN)
	if err != nil {
		return nil, err
	}
	// Single writer + WAL keeps SQLite happy under concurrent HTTP handlers.
	db.SetMaxOpenConns(1)
	for _, pragma := range []string{
		"PRAGMA journal_mode=WAL",
		"PRAGMA busy_timeout=5000",
		"PRAGMA foreign_keys=ON",
	} {
		if _, err := db.Exec(pragma); err != nil {
			_ = db.Close()
			return nil, err
		}
	}
	if _, err := db.Exec(schema); err != nil {
		_ = db.Close()
		return nil, err
	}
	return &Store{db: db}, nil
}

func (s *Store) Close() error { return s.db.Close() }

func (s *Store) CreateUser(ctx context.Context, email, passwordHash string) (storage.User, error) {
	u := storage.User{
		ID:           id.New(),
		Email:        strings.ToLower(strings.TrimSpace(email)),
		PasswordHash: passwordHash,
		CreatedAt:    time.Now().UTC(),
	}
	_, err := s.db.ExecContext(ctx,
		`INSERT INTO users (id, email, password_hash, created_at) VALUES (?, ?, ?, ?)`,
		u.ID, u.Email, u.PasswordHash, u.CreatedAt.Format(time.RFC3339Nano))
	if err != nil {
		if isUniqueViolation(err) {
			return storage.User{}, storage.ErrEmailTaken
		}
		return storage.User{}, err
	}
	return u, nil
}

func (s *Store) GetUserByEmail(ctx context.Context, email string) (storage.User, error) {
	key := strings.ToLower(strings.TrimSpace(email))
	row := s.db.QueryRowContext(ctx,
		`SELECT id, email, password_hash, created_at FROM users WHERE email = ?`, key)
	return scanUser(row)
}

func (s *Store) GetUserByID(ctx context.Context, uid string) (storage.User, error) {
	row := s.db.QueryRowContext(ctx,
		`SELECT id, email, password_hash, created_at FROM users WHERE id = ?`, uid)
	return scanUser(row)
}

func (s *Store) SaveRefreshToken(ctx context.Context, userID, tokenHash string, exp time.Time) error {
	_, err := s.db.ExecContext(ctx,
		`INSERT INTO refresh_tokens (token_hash, user_id, expires_at, revoked) VALUES (?, ?, ?, 0)
		 ON CONFLICT(token_hash) DO UPDATE SET user_id=excluded.user_id, expires_at=excluded.expires_at, revoked=0`,
		tokenHash, userID, exp.UTC().Format(time.RFC3339Nano))
	return err
}

func (s *Store) GetRefreshToken(ctx context.Context, tokenHash string) (storage.RefreshToken, error) {
	row := s.db.QueryRowContext(ctx,
		`SELECT user_id, token_hash, expires_at, revoked FROM refresh_tokens WHERE token_hash = ?`, tokenHash)
	var (
		t       storage.RefreshToken
		expRaw  string
		revoked int
	)
	if err := row.Scan(&t.UserID, &t.TokenHash, &expRaw, &revoked); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return storage.RefreshToken{}, storage.ErrNotFound
		}
		return storage.RefreshToken{}, err
	}
	t.ExpiresAt, _ = time.Parse(time.RFC3339Nano, expRaw)
	t.Revoked = revoked != 0
	return t, nil
}

func (s *Store) RevokeRefreshToken(ctx context.Context, tokenHash string) error {
	res, err := s.db.ExecContext(ctx,
		`UPDATE refresh_tokens SET revoked = 1 WHERE token_hash = ?`, tokenHash)
	if err != nil {
		return err
	}
	return requireAffected(res)
}

func (s *Store) CreateDocument(ctx context.Context, ownerID, title string) (storage.Document, error) {
	now := time.Now().UTC()
	d := storage.Document{ID: id.New(), OwnerID: ownerID, Title: title, CreatedAt: now, UpdatedAt: now}
	_, err := s.db.ExecContext(ctx,
		`INSERT INTO documents (id, owner_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
		d.ID, d.OwnerID, d.Title, d.CreatedAt.Format(time.RFC3339Nano), d.UpdatedAt.Format(time.RFC3339Nano))
	if err != nil {
		return storage.Document{}, err
	}
	return d, nil
}

func (s *Store) ListDocuments(ctx context.Context, ownerID string) ([]storage.Document, error) {
	rows, err := s.db.QueryContext(ctx,
		`SELECT id, owner_id, title, created_at, updated_at FROM documents WHERE owner_id = ? ORDER BY updated_at DESC`, ownerID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []storage.Document{}
	for rows.Next() {
		d, err := scanDocument(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, d)
	}
	return out, rows.Err()
}

func (s *Store) GetDocument(ctx context.Context, docID string) (storage.Document, error) {
	row := s.db.QueryRowContext(ctx,
		`SELECT id, owner_id, title, created_at, updated_at FROM documents WHERE id = ?`, docID)
	return scanDocument(row)
}

func (s *Store) UpdateDocumentTitle(ctx context.Context, docID, title string) error {
	res, err := s.db.ExecContext(ctx,
		`UPDATE documents SET title = ?, updated_at = ? WHERE id = ?`,
		title, time.Now().UTC().Format(time.RFC3339Nano), docID)
	if err != nil {
		return err
	}
	return requireAffected(res)
}

func (s *Store) DeleteDocument(ctx context.Context, docID string) error {
	res, err := s.db.ExecContext(ctx, `DELETE FROM documents WHERE id = ?`, docID)
	if err != nil {
		return err
	}
	return requireAffected(res)
}

func (s *Store) CanAccess(ctx context.Context, userID, docID string) (bool, error) {
	d, err := s.GetDocument(ctx, docID)
	if err != nil {
		return false, err
	}
	return d.OwnerID == userID, nil
}

// --- helpers ---

type scanner interface {
	Scan(dest ...any) error
}

func scanUser(row scanner) (storage.User, error) {
	var (
		u          storage.User
		createdRaw string
	)
	if err := row.Scan(&u.ID, &u.Email, &u.PasswordHash, &createdRaw); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return storage.User{}, storage.ErrNotFound
		}
		return storage.User{}, err
	}
	u.CreatedAt, _ = time.Parse(time.RFC3339Nano, createdRaw)
	return u, nil
}

func scanDocument(row scanner) (storage.Document, error) {
	var (
		d                  storage.Document
		createdRaw, updRaw string
	)
	if err := row.Scan(&d.ID, &d.OwnerID, &d.Title, &createdRaw, &updRaw); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return storage.Document{}, storage.ErrNotFound
		}
		return storage.Document{}, err
	}
	d.CreatedAt, _ = time.Parse(time.RFC3339Nano, createdRaw)
	d.UpdatedAt, _ = time.Parse(time.RFC3339Nano, updRaw)
	return d, nil
}

func requireAffected(res sql.Result) error {
	n, err := res.RowsAffected()
	if err != nil {
		return err
	}
	if n == 0 {
		return storage.ErrNotFound
	}
	return nil
}

func isUniqueViolation(err error) bool {
	return strings.Contains(err.Error(), "UNIQUE constraint failed")
}

// filePathFromDSN extracts the on-disk path from a "file:...?params" DSN so we
// can ensure its directory exists.
func filePathFromDSN(dsn string) string {
	s := strings.TrimPrefix(dsn, "file:")
	if i := strings.IndexByte(s, '?'); i >= 0 {
		s = s[:i]
	}
	return s
}
