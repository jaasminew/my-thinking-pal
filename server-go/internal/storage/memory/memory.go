// Package memory is an in-memory AccountStore for tests and a zero-dependency
// dev default. Thread-safe; data is lost on restart (SQLite is the durable MVP).
package memory

import (
	"context"
	"strings"
	"sync"
	"time"

	"mythinkingpal/server/internal/id"
	"mythinkingpal/server/internal/storage"
)

type Store struct {
	mu        sync.RWMutex
	users     map[string]storage.User         // id -> user
	byEmail   map[string]string               // lower(email) -> id
	refresh   map[string]storage.RefreshToken // tokenHash -> token
	documents map[string]storage.Document     // id -> document
}

func New() *Store {
	return &Store{
		users:     map[string]storage.User{},
		byEmail:   map[string]string{},
		refresh:   map[string]storage.RefreshToken{},
		documents: map[string]storage.Document{},
	}
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
