// Package storage defines the two persistence seams from docs module 04:
// AccountStore (small, relational, transactional) and DocStore (binary CRDT
// blobs, append-heavy). Business logic depends only on these interfaces, so the
// engine (in-memory / SQLite / filesystem / object store) can be swapped freely.
package storage

import (
	"context"
	"errors"
	"time"
)

var (
	ErrNotFound   = errors.New("not found")
	ErrEmailTaken = errors.New("email already registered")
	ErrForbidden  = errors.New("forbidden")
)

type User struct {
	ID           string    `json:"id"`
	Email        string    `json:"email"`
	PasswordHash string    `json:"-"`
	CreatedAt    time.Time `json:"createdAt"`
}

type RefreshToken struct {
	UserID    string
	TokenHash string
	ExpiresAt time.Time
	Revoked   bool
}

type Document struct {
	ID        string    `json:"id"`
	OwnerID   string    `json:"ownerId"`
	Title     string    `json:"title"`
	CreatedAt time.Time `json:"createdAt"`
	UpdatedAt time.Time `json:"updatedAt"`
}

// AccountStore: users, refresh tokens, document metadata. MVP = SQLite / memory.
type AccountStore interface {
	CreateUser(ctx context.Context, email, passwordHash string) (User, error)
	GetUserByEmail(ctx context.Context, email string) (User, error)
	GetUserByID(ctx context.Context, id string) (User, error)

	SaveRefreshToken(ctx context.Context, userID, tokenHash string, exp time.Time) error
	GetRefreshToken(ctx context.Context, tokenHash string) (RefreshToken, error)
	RevokeRefreshToken(ctx context.Context, tokenHash string) error

	CreateDocument(ctx context.Context, ownerID, title string) (Document, error)
	ListDocuments(ctx context.Context, ownerID string) ([]Document, error)
	GetDocument(ctx context.Context, id string) (Document, error)
	UpdateDocumentTitle(ctx context.Context, id, title string) error
	DeleteDocument(ctx context.Context, id string) error
	CanAccess(ctx context.Context, userID, docID string) (bool, error)

	Close() error
}

// DocStore: per-doc Yjs update log + snapshots (module 05). The server treats
// updates/snapshots as opaque bytes — it never parses CRDT semantics.
type DocStore interface {
	// AppendUpdate stores one opaque Yjs update and returns its monotonic seq.
	AppendUpdate(ctx context.Context, docID string, update []byte) (seq int64, err error)
	// LoadUpdates returns all currently-stored updates (post latest snapshot) in
	// seq order, plus the max seq seen (for snapshot truncation).
	LoadUpdates(ctx context.Context, docID string) (updates [][]byte, maxSeq int64, err error)
	// PutSnapshot stores a client-computed snapshot (an opaque full-state update).
	PutSnapshot(ctx context.Context, docID string, snap []byte, version int64) error
	// LatestSnapshot returns the newest snapshot (nil if none) and its version.
	LatestSnapshot(ctx context.Context, docID string) (snap []byte, version int64, err error)
	// TruncateUpdates deletes stored updates with seq <= throughSeq.
	TruncateUpdates(ctx context.Context, docID string, throughSeq int64) error
}
