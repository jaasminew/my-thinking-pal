// Package storagetest holds a reusable AccountStore contract so every backing
// engine (memory, sqlite, …) is verified against identical behavior.
package storagetest

import (
	"context"
	"errors"
	"testing"
	"time"

	"mythinkingpal/server/internal/storage"
)

// RunAccountStoreContract exercises the full AccountStore behavior. `factory`
// must return a fresh, empty store per call.
func RunAccountStoreContract(t *testing.T, factory func(t *testing.T) storage.AccountStore) {
	t.Helper()
	ctx := context.Background()

	t.Run("users", func(t *testing.T) {
		s := factory(t)
		u, err := s.CreateUser(ctx, "  Alice@Example.com ", "hash1")
		if err != nil {
			t.Fatalf("create: %v", err)
		}
		if u.ID == "" || u.Email != "alice@example.com" {
			t.Fatalf("email should be normalized: %+v", u)
		}

		// Duplicate (case-insensitive) → ErrEmailTaken.
		if _, err := s.CreateUser(ctx, "ALICE@example.com", "x"); !errors.Is(err, storage.ErrEmailTaken) {
			t.Fatalf("dup email: want ErrEmailTaken, got %v", err)
		}

		byEmail, err := s.GetUserByEmail(ctx, "alice@example.com")
		if err != nil || byEmail.ID != u.ID {
			t.Fatalf("by email: %+v %v", byEmail, err)
		}
		byID, err := s.GetUserByID(ctx, u.ID)
		if err != nil || byID.Email != u.Email {
			t.Fatalf("by id: %+v %v", byID, err)
		}
		if _, err := s.GetUserByEmail(ctx, "nobody@x.com"); !errors.Is(err, storage.ErrNotFound) {
			t.Fatalf("missing email: want ErrNotFound, got %v", err)
		}
		if _, err := s.GetUserByID(ctx, "nope"); !errors.Is(err, storage.ErrNotFound) {
			t.Fatalf("missing id: want ErrNotFound, got %v", err)
		}
	})

	t.Run("refresh tokens", func(t *testing.T) {
		s := factory(t)
		exp := time.Now().Add(time.Hour).UTC().Truncate(time.Second)
		if err := s.SaveRefreshToken(ctx, "user1", "hashA", exp); err != nil {
			t.Fatalf("save: %v", err)
		}
		got, err := s.GetRefreshToken(ctx, "hashA")
		if err != nil || got.UserID != "user1" || got.Revoked {
			t.Fatalf("get: %+v %v", got, err)
		}
		if !got.ExpiresAt.Equal(exp) {
			t.Fatalf("exp roundtrip: want %v got %v", exp, got.ExpiresAt)
		}
		if err := s.RevokeRefreshToken(ctx, "hashA"); err != nil {
			t.Fatalf("revoke: %v", err)
		}
		got, _ = s.GetRefreshToken(ctx, "hashA")
		if !got.Revoked {
			t.Fatal("token should be revoked")
		}
		if _, err := s.GetRefreshToken(ctx, "missing"); !errors.Is(err, storage.ErrNotFound) {
			t.Fatalf("missing token: want ErrNotFound, got %v", err)
		}
		if err := s.RevokeRefreshToken(ctx, "missing"); !errors.Is(err, storage.ErrNotFound) {
			t.Fatalf("revoke missing: want ErrNotFound, got %v", err)
		}
	})

	t.Run("documents", func(t *testing.T) {
		s := factory(t)
		d1, err := s.CreateDocument(ctx, "owner1", "Doc One")
		if err != nil {
			t.Fatalf("create: %v", err)
		}
		if _, err := s.CreateDocument(ctx, "owner2", "Other"); err != nil {
			t.Fatalf("create other: %v", err)
		}

		list, err := s.ListDocuments(ctx, "owner1")
		if err != nil || len(list) != 1 || list[0].ID != d1.ID {
			t.Fatalf("list should be owner-scoped: %+v %v", list, err)
		}

		if err := s.UpdateDocumentTitle(ctx, d1.ID, "Renamed"); err != nil {
			t.Fatalf("rename: %v", err)
		}
		got, _ := s.GetDocument(ctx, d1.ID)
		if got.Title != "Renamed" {
			t.Fatalf("title not updated: %+v", got)
		}

		ok, err := s.CanAccess(ctx, "owner1", d1.ID)
		if err != nil || !ok {
			t.Fatalf("owner should access: %v %v", ok, err)
		}
		ok, _ = s.CanAccess(ctx, "intruder", d1.ID)
		if ok {
			t.Fatal("non-owner must not access")
		}
		if _, err := s.CanAccess(ctx, "owner1", "ghost"); !errors.Is(err, storage.ErrNotFound) {
			t.Fatalf("access missing doc: want ErrNotFound, got %v", err)
		}

		if err := s.DeleteDocument(ctx, d1.ID); err != nil {
			t.Fatalf("delete: %v", err)
		}
		if _, err := s.GetDocument(ctx, d1.ID); !errors.Is(err, storage.ErrNotFound) {
			t.Fatalf("deleted doc: want ErrNotFound, got %v", err)
		}
		if err := s.DeleteDocument(ctx, d1.ID); !errors.Is(err, storage.ErrNotFound) {
			t.Fatalf("delete missing: want ErrNotFound, got %v", err)
		}
		if err := s.UpdateDocumentTitle(ctx, "ghost", "x"); !errors.Is(err, storage.ErrNotFound) {
			t.Fatalf("rename missing: want ErrNotFound, got %v", err)
		}
	})
}
