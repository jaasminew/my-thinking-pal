package sqlite_test

import (
	"context"
	"path/filepath"
	"testing"

	"mythinkingpal/server/internal/storage"
	"mythinkingpal/server/internal/storage/sqlite"
	"mythinkingpal/server/internal/storage/storagetest"
)

func TestSQLiteStoreContract(t *testing.T) {
	storagetest.RunAccountStoreContract(t, func(t *testing.T) storage.AccountStore {
		s, err := sqlite.Open(filepath.Join(t.TempDir(), "accounts.db"))
		if err != nil {
			t.Fatalf("open: %v", err)
		}
		t.Cleanup(func() { _ = s.Close() })
		return s
	})
}

// TestSQLiteDurability verifies data survives a close + reopen on the same file
// (the whole point of choosing SQLite over the memory store).
func TestSQLiteDurability(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "accounts.db")

	s1, err := sqlite.Open(path)
	if err != nil {
		t.Fatalf("open1: %v", err)
	}
	u, err := s1.CreateUser(ctx, "durable@x.com", "hash")
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	d, err := s1.CreateDocument(ctx, u.ID, "Persisted")
	if err != nil {
		t.Fatalf("create doc: %v", err)
	}
	_ = s1.Close()

	s2, err := sqlite.Open(path)
	if err != nil {
		t.Fatalf("open2: %v", err)
	}
	defer s2.Close()
	got, err := s2.GetUserByEmail(ctx, "durable@x.com")
	if err != nil || got.ID != u.ID {
		t.Fatalf("user should survive reopen: %+v %v", got, err)
	}
	gotDoc, err := s2.GetDocument(ctx, d.ID)
	if err != nil || gotDoc.Title != "Persisted" {
		t.Fatalf("doc should survive reopen: %+v %v", gotDoc, err)
	}
}

// TestSQLiteDSNWithParams ensures a vendor-style DSN (file: + query params) is
// accepted (params stripped, pragmas applied internally).
func TestSQLiteDSNWithParams(t *testing.T) {
	path := filepath.Join(t.TempDir(), "accounts.db")
	s, err := sqlite.Open("file:" + path + "?_journal=WAL")
	if err != nil {
		t.Fatalf("open with params: %v", err)
	}
	defer s.Close()
	if _, err := s.CreateUser(context.Background(), "a@b.com", "h"); err != nil {
		t.Fatalf("create: %v", err)
	}
}
