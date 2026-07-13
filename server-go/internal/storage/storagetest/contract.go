// Package storagetest holds a reusable AccountStore contract so every backing
// engine (memory, sqlite, …) is verified against identical behavior.
package storagetest

import (
	"context"
	"encoding/json"
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

	t.Run("workspace", func(t *testing.T) {
		s := factory(t)
		if _, err := s.GetWorkspace(ctx, "owner1"); !errors.Is(err, storage.ErrNotFound) {
			t.Fatalf("empty workspace: want ErrNotFound, got %v", err)
		}

		tree1 := json.RawMessage(`[{"id":"s1","kind":"space","name":"A","docId":"d1"}]`)
		ws, err := s.PutWorkspace(ctx, "owner1", tree1)
		if err != nil {
			t.Fatalf("put: %v", err)
		}
		if ws.UpdatedAt.IsZero() || string(ws.Tree) != string(tree1) {
			t.Fatalf("put result: %+v", ws)
		}

		got, err := s.GetWorkspace(ctx, "owner1")
		if err != nil || string(got.Tree) != string(tree1) {
			t.Fatalf("get: %+v %v", got, err)
		}

		// LWW replace
		tree2 := json.RawMessage(`[{"id":"s2","kind":"space","name":"B","docId":"d2"}]`)
		ws2, err := s.PutWorkspace(ctx, "owner1", tree2)
		if err != nil || string(ws2.Tree) != string(tree2) {
			t.Fatalf("replace: %+v %v", ws2, err)
		}
		got, _ = s.GetWorkspace(ctx, "owner1")
		if string(got.Tree) != string(tree2) {
			t.Fatalf("after replace: %s", got.Tree)
		}

		// Other owner is isolated
		if _, err := s.GetWorkspace(ctx, "owner2"); !errors.Is(err, storage.ErrNotFound) {
			t.Fatalf("other owner: want ErrNotFound, got %v", err)
		}
	})

	t.Run("project memory", func(t *testing.T) {
		s := factory(t)
		ctx := context.Background()
		base := time.Date(2026, 1, 1, 12, 0, 0, 0, time.UTC)

		mk := func(owner, id string, title string, at time.Time, blob string) storage.ProjectMemoryFile {
			return storage.ProjectMemoryFile{
				ID: id, OwnerID: owner, ScopeKind: "project", ScopeID: "p1",
				Name: title + ".md", MimeType: "text/markdown", Size: 10,
				Title: title, Description: "desc", Status: "queued", BlobPath: blob,
				CreatedAt: at, UpdatedAt: at,
			}
		}

		f1, err := s.CreatePMFile(ctx, mk("owner1", "", "One", base, "/b1"))
		if err != nil {
			t.Fatalf("create: %v", err)
		}
		if f1.ID == "" || f1.CreatedAt.IsZero() {
			t.Fatalf("create should fill ID/timestamps: %+v", f1)
		}
		f2, err := s.CreatePMFile(ctx, mk("owner1", "", "Two", base.Add(time.Second), "/b2"))
		if err != nil {
			t.Fatalf("create2: %v", err)
		}

		// List is owner-scoped and newest-first.
		list, err := s.ListPMFiles(ctx, "owner1", "project", "p1")
		if err != nil || len(list) != 2 || list[0].ID != f2.ID || list[1].ID != f1.ID {
			t.Fatalf("list owner-scoped DESC: %+v %v", list, err)
		}
		if got, err := s.ListPMFiles(ctx, "owner2", "project", "p1"); err != nil || len(got) != 0 {
			t.Fatalf("other owner list should be empty: %+v %v", got, err)
		}

		// Get round-trips the row (incl. server-only fields).
		got, err := s.GetPMFile(ctx, "owner1", f1.ID)
		if err != nil || got.Title != "One" || got.BlobPath != "/b1" {
			t.Fatalf("get: %+v %v", got, err)
		}
		if _, err := s.GetPMFile(ctx, "owner2", f1.ID); !errors.Is(err, storage.ErrNotFound) {
			t.Fatalf("cross-user get: want ErrNotFound, got %v", err)
		}

		// Text round-trips with the truncation flag.
		if err := s.PutPMText(ctx, "owner1", f1.ID, "hello world", true); err != nil {
			t.Fatalf("put text: %v", err)
		}
		txt, trunc, err := s.GetPMText(ctx, "owner1", f1.ID)
		if err != nil || txt != "hello world" || !trunc {
			t.Fatalf("get text: %q %v %v", txt, trunc, err)
		}
		// No text row yet → ErrNotFound (file exists, text does not).
		if _, _, err := s.GetPMText(ctx, "owner1", f2.ID); !errors.Is(err, storage.ErrNotFound) {
			t.Fatalf("missing text: want ErrNotFound, got %v", err)
		}
		// Cross-user text write is denied.
		if err := s.PutPMText(ctx, "owner2", f1.ID, "x", false); !errors.Is(err, storage.ErrNotFound) {
			t.Fatalf("cross-user put text: want ErrNotFound, got %v", err)
		}

		// Status transitions (full-row overwrite of status + error).
		if err := s.UpdatePMFileStatus(ctx, "owner1", f1.ID, "indexed", ""); err != nil {
			t.Fatalf("update status: %v", err)
		}
		if err := s.UpdatePMFileStatus(ctx, "owner1", f1.ID, "failed", "boom"); err != nil {
			t.Fatalf("update status failed: %v", err)
		}
		got, _ = s.GetPMFile(ctx, "owner1", f1.ID)
		if got.Status != "failed" || got.Error != "boom" {
			t.Fatalf("status not updated: %+v", got)
		}
		if err := s.UpdatePMFileStatus(ctx, "owner2", f1.ID, "queued", ""); !errors.Is(err, storage.ErrNotFound) {
			t.Fatalf("cross-user update: want ErrNotFound, got %v", err)
		}

		// Instructions: zero-value when never saved, upsert on save.
		if ins, err := s.GetPMInstructions(ctx, "owner1", "project", "p1"); err != nil || ins != (storage.ProjectInstructions{}) {
			t.Fatalf("unsaved instructions should be zero-value: %+v %v", ins, err)
		}
		want := storage.ProjectInstructions{TranscriptionSummary: "s", CoCreation: "c", AICommand: "a"}
		if err := s.PutPMInstructions(ctx, "owner1", "project", "p1", want); err != nil {
			t.Fatalf("put instructions: %v", err)
		}
		if ins, err := s.GetPMInstructions(ctx, "owner1", "project", "p1"); err != nil || ins != want {
			t.Fatalf("instructions round-trip: %+v %v", ins, err)
		}
		// Cross-owner instructions are isolated (zero-value).
		if ins, err := s.GetPMInstructions(ctx, "owner2", "project", "p1"); err != nil || ins != (storage.ProjectInstructions{}) {
			t.Fatalf("cross-owner instructions should be zero-value: %+v %v", ins, err)
		}

		// DeleteFile cascades the text row; cross-user delete denied.
		if err := s.DeletePMFile(ctx, "owner1", f1.ID); err != nil {
			t.Fatalf("delete file: %v", err)
		}
		if _, _, err := s.GetPMText(ctx, "owner1", f1.ID); !errors.Is(err, storage.ErrNotFound) {
			t.Fatalf("text after delete: want ErrNotFound, got %v", err)
		}
		if err := s.DeletePMFile(ctx, "owner2", f2.ID); !errors.Is(err, storage.ErrNotFound) {
			t.Fatalf("cross-user delete: want ErrNotFound, got %v", err)
		}

		// DeleteScope wipes files + text + instructions and returns blob paths.
		if err := s.PutPMText(ctx, "owner1", f2.ID, "keep", false); err != nil {
			t.Fatalf("put text before delete scope: %v", err)
		}
		blobs, err := s.DeletePMScope(ctx, "owner1", "project", "p1")
		if err != nil {
			t.Fatalf("delete scope: %v", err)
		}
		if len(blobs) != 1 || blobs[0] != "/b2" {
			t.Fatalf("delete scope blob paths: %+v", blobs)
		}
		if list, _ := s.ListPMFiles(ctx, "owner1", "project", "p1"); len(list) != 0 {
			t.Fatalf("scope files should be gone: %+v", list)
		}
		if ins, _ := s.GetPMInstructions(ctx, "owner1", "project", "p1"); ins != (storage.ProjectInstructions{}) {
			t.Fatalf("scope instructions should be gone: %+v", ins)
		}
	})
}
