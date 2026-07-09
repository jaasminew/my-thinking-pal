// Package memory is an in-memory AccountStore for tests and a zero-dependency
// dev default. Thread-safe; data is lost on restart (SQLite is the durable MVP).
package memory

import (
	"context"
	"sort"
	"strings"
	"sync"
	"time"

	"mythinkingpal/server/internal/id"
	"mythinkingpal/server/internal/storage"
)

type Store struct {
	mu             sync.RWMutex
	users          map[string]storage.User                // id -> user
	byEmail        map[string]string                      // lower(email) -> id
	refresh        map[string]storage.RefreshToken        // tokenHash -> token
	documents      map[string]storage.Document            // id -> document
	pmFiles        map[string]storage.ProjectMemoryFile   // id -> file
	pmTexts        map[string]pmTextEntry                 // fileID -> {text, truncated}
	pmInstructions map[string]storage.ProjectInstructions // "owner|kind|id" -> ins
}

// pmTextEntry holds extracted text + its truncation flag.
type pmTextEntry struct {
	text      string
	truncated bool
}

func New() *Store {
	return &Store{
		users:          map[string]storage.User{},
		byEmail:        map[string]string{},
		refresh:        map[string]storage.RefreshToken{},
		documents:      map[string]storage.Document{},
		pmFiles:        map[string]storage.ProjectMemoryFile{},
		pmTexts:        map[string]pmTextEntry{},
		pmInstructions: map[string]storage.ProjectInstructions{},
	}
}

// pmInsKey is the composite key for per-scope instructions.
func pmInsKey(ownerID, scopeKind, scopeID string) string {
	return ownerID + "|" + scopeKind + "|" + scopeID
}

func (s *Store) Close() error { return nil }

func (s *Store) CreateUser(_ context.Context, email, passwordHash string) (storage.User, error) {
	key := strings.ToLower(strings.TrimSpace(email))
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, ok := s.byEmail[key]; ok {
		return storage.User{}, storage.ErrEmailTaken
	}
	u := storage.User{ID: id.New(), Email: key, PasswordHash: passwordHash, CreatedAt: time.Now().UTC()}
	s.users[u.ID] = u
	s.byEmail[key] = u.ID
	return u, nil
}

func (s *Store) GetUserByEmail(_ context.Context, email string) (storage.User, error) {
	key := strings.ToLower(strings.TrimSpace(email))
	s.mu.RLock()
	defer s.mu.RUnlock()
	uid, ok := s.byEmail[key]
	if !ok {
		return storage.User{}, storage.ErrNotFound
	}
	return s.users[uid], nil
}

func (s *Store) GetUserByID(_ context.Context, uid string) (storage.User, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	u, ok := s.users[uid]
	if !ok {
		return storage.User{}, storage.ErrNotFound
	}
	return u, nil
}

func (s *Store) SaveRefreshToken(_ context.Context, userID, tokenHash string, exp time.Time) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.refresh[tokenHash] = storage.RefreshToken{UserID: userID, TokenHash: tokenHash, ExpiresAt: exp}
	return nil
}

func (s *Store) GetRefreshToken(_ context.Context, tokenHash string) (storage.RefreshToken, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	t, ok := s.refresh[tokenHash]
	if !ok {
		return storage.RefreshToken{}, storage.ErrNotFound
	}
	return t, nil
}

func (s *Store) RevokeRefreshToken(_ context.Context, tokenHash string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	t, ok := s.refresh[tokenHash]
	if !ok {
		return storage.ErrNotFound
	}
	t.Revoked = true
	s.refresh[tokenHash] = t
	return nil
}

func (s *Store) CreateDocument(_ context.Context, ownerID, title string) (storage.Document, error) {
	now := time.Now().UTC()
	d := storage.Document{ID: id.New(), OwnerID: ownerID, Title: title, CreatedAt: now, UpdatedAt: now}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.documents[d.ID] = d
	return d, nil
}

func (s *Store) ListDocuments(_ context.Context, ownerID string) ([]storage.Document, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := []storage.Document{}
	for _, d := range s.documents {
		if d.OwnerID == ownerID {
			out = append(out, d)
		}
	}
	return out, nil
}

func (s *Store) GetDocument(_ context.Context, docID string) (storage.Document, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	d, ok := s.documents[docID]
	if !ok {
		return storage.Document{}, storage.ErrNotFound
	}
	return d, nil
}

func (s *Store) UpdateDocumentTitle(_ context.Context, docID, title string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	d, ok := s.documents[docID]
	if !ok {
		return storage.ErrNotFound
	}
	d.Title = title
	d.UpdatedAt = time.Now().UTC()
	s.documents[docID] = d
	return nil
}

func (s *Store) DeleteDocument(_ context.Context, docID string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, ok := s.documents[docID]; !ok {
		return storage.ErrNotFound
	}
	delete(s.documents, docID)
	return nil
}

func (s *Store) CanAccess(_ context.Context, userID, docID string) (bool, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	d, ok := s.documents[docID]
	if !ok {
		return false, storage.ErrNotFound
	}
	return d.OwnerID == userID, nil
}

// --- Project Memory ---

func (s *Store) CreatePMFile(_ context.Context, f storage.ProjectMemoryFile) (storage.ProjectMemoryFile, error) {
	if f.ID == "" {
		f.ID = id.New()
	}
	now := time.Now().UTC()
	if f.CreatedAt.IsZero() {
		f.CreatedAt = now
	}
	if f.UpdatedAt.IsZero() {
		f.UpdatedAt = now
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.pmFiles[f.ID] = f
	return f, nil
}

func (s *Store) ListPMFiles(_ context.Context, ownerID, scopeKind, scopeID string) ([]storage.ProjectMemoryFile, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := []storage.ProjectMemoryFile{}
	for _, f := range s.pmFiles {
		if f.OwnerID == ownerID && f.ScopeKind == scopeKind && f.ScopeID == scopeID {
			out = append(out, f)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].CreatedAt.After(out[j].CreatedAt) })
	return out, nil
}

func (s *Store) GetPMFile(_ context.Context, ownerID, fileID string) (storage.ProjectMemoryFile, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	f, ok := s.pmFiles[fileID]
	if !ok || f.OwnerID != ownerID {
		return storage.ProjectMemoryFile{}, storage.ErrNotFound
	}
	return f, nil
}

func (s *Store) UpdatePMFileStatus(_ context.Context, ownerID, fileID, status, errMsg string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	f, ok := s.pmFiles[fileID]
	if !ok || f.OwnerID != ownerID {
		return storage.ErrNotFound
	}
	f.Status = status
	f.Error = errMsg
	f.UpdatedAt = time.Now().UTC()
	s.pmFiles[fileID] = f
	return nil
}

func (s *Store) DeletePMFile(_ context.Context, ownerID, fileID string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	f, ok := s.pmFiles[fileID]
	if !ok || f.OwnerID != ownerID {
		return storage.ErrNotFound
	}
	delete(s.pmFiles, fileID)
	delete(s.pmTexts, fileID)
	return nil
}

func (s *Store) PutPMText(ctx context.Context, ownerID, fileID, text string, truncated bool) error {
	if _, err := s.GetPMFile(ctx, ownerID, fileID); err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.pmTexts[fileID] = pmTextEntry{text: text, truncated: truncated}
	return nil
}

func (s *Store) GetPMText(ctx context.Context, ownerID, fileID string) (string, bool, error) {
	if _, err := s.GetPMFile(ctx, ownerID, fileID); err != nil {
		return "", false, err
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	e, ok := s.pmTexts[fileID]
	if !ok {
		return "", false, storage.ErrNotFound
	}
	return e.text, e.truncated, nil
}

func (s *Store) GetPMInstructions(_ context.Context, ownerID, scopeKind, scopeID string) (storage.ProjectInstructions, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.pmInstructions[pmInsKey(ownerID, scopeKind, scopeID)], nil // zero-value when missing
}

func (s *Store) PutPMInstructions(_ context.Context, ownerID, scopeKind, scopeID string, ins storage.ProjectInstructions) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.pmInstructions[pmInsKey(ownerID, scopeKind, scopeID)] = ins
	return nil
}

func (s *Store) DeletePMScope(_ context.Context, ownerID, scopeKind, scopeID string) ([]string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	var blobPaths []string
	for id, f := range s.pmFiles {
		if f.OwnerID == ownerID && f.ScopeKind == scopeKind && f.ScopeID == scopeID {
			if f.BlobPath != "" {
				blobPaths = append(blobPaths, f.BlobPath)
			}
			delete(s.pmFiles, id)
			delete(s.pmTexts, id)
		}
	}
	delete(s.pmInstructions, pmInsKey(ownerID, scopeKind, scopeID))
	return blobPaths, nil
}
