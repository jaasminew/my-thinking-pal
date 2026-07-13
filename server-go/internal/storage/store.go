// Package storage defines the two persistence seams from docs module 04:
// AccountStore (small, relational, transactional) and DocStore (binary CRDT
// blobs, append-heavy). Business logic depends only on these interfaces, so the
// engine (in-memory / SQLite / filesystem / object store) can be swapped freely.
package storage

import (
	"context"
	"encoding/json"
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

// Workspace is the account-scoped sidebar tree (projects + idea spaces). Tree is
// opaque JSON owned by the client; the server only persists and returns it.
// Document ids for sync rooms live inside space nodes (docId), not here.
type Workspace struct {
	Tree      json.RawMessage `json:"tree"`
	UpdatedAt time.Time       `json:"updatedAt"`
}

// ProjectMemoryFile is a knowledge-base file scoped by (owner, scopeKind, scopeId).
// OwnerID and BlobPath are server-only (json:"-"); the wire shape matches the
// shared-contract ProjectMemoryFile exactly.
type ProjectMemoryFile struct {
	ID          string    `json:"id"`
	OwnerID     string    `json:"-"`
	ScopeKind   string    `json:"scopeKind"`
	ScopeID     string    `json:"scopeId"`
	Name        string    `json:"name"`
	MimeType    string    `json:"mimeType"`
	Size        int64     `json:"size"`
	Title       string    `json:"title"`
	Description string    `json:"description"`
	Status      string    `json:"status"`
	Error       string    `json:"error,omitempty"`
	BlobPath    string    `json:"-"`
	CreatedAt   time.Time `json:"createdAt"`
	UpdatedAt   time.Time `json:"updatedAt"`
}

// ProjectInstructions are per-scope AI guidance fields.
type ProjectInstructions struct {
	TranscriptionSummary string `json:"transcriptionSummary"`
	CoCreation           string `json:"coCreation"`
	AICommand            string `json:"aiCommand"`
}

// AccountStore: users, refresh tokens, document metadata, project memory.
// MVP = SQLite / memory.
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

	// Workspace — one LWW blob per owner (sidebar tree + embedded space.docId).
	GetWorkspace(ctx context.Context, ownerID string) (Workspace, error) // ErrNotFound when never saved
	PutWorkspace(ctx context.Context, ownerID string, tree json.RawMessage) (Workspace, error)

	// Project Memory — dumb persistence mirroring the browser local store. All
	// reads/writes are owner-scoped; a mismatched owner looks like "not found".
	CreatePMFile(ctx context.Context, f ProjectMemoryFile) (ProjectMemoryFile, error) // fills ID/timestamps if empty
	ListPMFiles(ctx context.Context, ownerID, scopeKind, scopeID string) ([]ProjectMemoryFile, error)
	GetPMFile(ctx context.Context, ownerID, fileID string) (ProjectMemoryFile, error)
	UpdatePMFileStatus(ctx context.Context, ownerID, fileID, status, errMsg string) error
	DeletePMFile(ctx context.Context, ownerID, fileID string) error // cascades text row; caller removes the blob file
	PutPMText(ctx context.Context, ownerID, fileID, text string, truncated bool) error
	GetPMText(ctx context.Context, ownerID, fileID string) (text string, truncated bool, err error)
	GetPMInstructions(ctx context.Context, ownerID, scopeKind, scopeID string) (ProjectInstructions, error) // zero-value (not ErrNotFound) when never saved
	PutPMInstructions(ctx context.Context, ownerID, scopeKind, scopeID string, ins ProjectInstructions) error
	DeletePMScope(ctx context.Context, ownerID, scopeKind, scopeID string) (blobPaths []string, err error)

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
