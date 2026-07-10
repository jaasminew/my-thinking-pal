package httpapi_test

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"mythinkingpal/server/internal/auth"
	"mythinkingpal/server/internal/documents"
	"mythinkingpal/server/internal/httpapi"
	"mythinkingpal/server/internal/storage/memory"
)

type tokenPair struct {
	AccessToken  string `json:"accessToken"`
	RefreshToken string `json:"refreshToken"`
	User         struct {
		ID    string `json:"id"`
		Email string `json:"email"`
	} `json:"user"`
}

type doc struct {
	ID    string `json:"id"`
	Title string `json:"title"`
}

func newServer() *httptest.Server {
	store := memory.New()
	authH := auth.NewHandler(store, []byte("access"), []byte("refresh"), 15*time.Minute, 720*time.Hour)
	docsH := documents.NewHandler(store)
	return httptest.NewServer(httpapi.New(httpapi.Deps{Auth: authH, Documents: docsH, CORSOrigin: "*"}))
}

func do(t *testing.T, srv *httptest.Server, method, path, token string, body any) (*http.Response, []byte) {
	t.Helper()
	var r io.Reader
	if body != nil {
		b, _ := json.Marshal(body)
		r = bytes.NewReader(b)
	}
	req, _ := http.NewRequest(method, srv.URL+path, r)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("%s %s: %v", method, path, err)
	}
	defer resp.Body.Close()
	data, _ := io.ReadAll(resp.Body)
	return resp, data
}

func register(t *testing.T, srv *httptest.Server, email string) tokenPair {
	t.Helper()
	resp, data := do(t, srv, "POST", "/auth/register", "", map[string]string{"email": email, "password": "password123"})
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("register status %d: %s", resp.StatusCode, data)
	}
	var tp tokenPair
	if err := json.Unmarshal(data, &tp); err != nil {
		t.Fatalf("decode: %v", err)
	}
	return tp
}

func TestAuthFlow(t *testing.T) {
	srv := newServer()
	defer srv.Close()

	tp := register(t, srv, "alice@example.com")
	if tp.AccessToken == "" || tp.User.Email != "alice@example.com" {
		t.Fatalf("bad register response: %+v", tp)
	}

	// /me with token
	resp, data := do(t, srv, "GET", "/me", tp.AccessToken, nil)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("/me status %d: %s", resp.StatusCode, data)
	}
	if resp, data := do(t, srv, "GET", "/auth/me", tp.AccessToken, nil); resp.StatusCode != http.StatusOK {
		t.Fatalf("/auth/me status %d: %s", resp.StatusCode, data)
	}

	// /me without token → 401
	if resp, _ := do(t, srv, "GET", "/me", "", nil); resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("/me without token should be 401, got %d", resp.StatusCode)
	}

	// duplicate email → 409
	if resp, _ := do(t, srv, "POST", "/auth/register", "", map[string]string{"email": "alice@example.com", "password": "password123"}); resp.StatusCode != http.StatusConflict {
		t.Fatalf("duplicate register should be 409, got %d", resp.StatusCode)
	}

	// wrong password → 401
	if resp, _ := do(t, srv, "POST", "/auth/login", "", map[string]string{"email": "alice@example.com", "password": "nope"}); resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("wrong password should be 401, got %d", resp.StatusCode)
	}
}

func TestRefreshRotation(t *testing.T) {
	srv := newServer()
	defer srv.Close()
	tp := register(t, srv, "bob@example.com")

	resp, data := do(t, srv, "POST", "/auth/refresh", "", map[string]string{"refreshToken": tp.RefreshToken})
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("refresh status %d: %s", resp.StatusCode, data)
	}
	// The old refresh token is now revoked (rotation) → reuse rejected.
	if resp, _ := do(t, srv, "POST", "/auth/refresh", "", map[string]string{"refreshToken": tp.RefreshToken}); resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("reused refresh token should be 401, got %d", resp.StatusCode)
	}
}

func TestDocumentsOwnership(t *testing.T) {
	srv := newServer()
	defer srv.Close()
	alice := register(t, srv, "a@x.com")
	bob := register(t, srv, "b@x.com")

	// Alice creates a doc.
	resp, data := do(t, srv, "POST", "/documents", alice.AccessToken, map[string]string{"title": "My Board"})
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("create status %d: %s", resp.StatusCode, data)
	}
	var d doc
	_ = json.Unmarshal(data, &d)

	// Alice lists → sees it.
	_, data = do(t, srv, "GET", "/documents", alice.AccessToken, nil)
	var list []doc
	_ = json.Unmarshal(data, &list)
	if len(list) != 1 || list[0].ID != d.ID {
		t.Fatalf("alice should see her doc, got %s", data)
	}

	// Bob lists → sees nothing.
	_, data = do(t, srv, "GET", "/documents", bob.AccessToken, nil)
	_ = json.Unmarshal(data, &list)
	if len(list) != 0 {
		t.Fatalf("bob should see no docs, got %s", data)
	}

	// Bob cannot patch Alice's doc → 403.
	if resp, _ := do(t, srv, "PATCH", "/documents/"+d.ID, bob.AccessToken, map[string]string{"title": "hijack"}); resp.StatusCode != http.StatusForbidden {
		t.Fatalf("bob patch should be 403, got %d", resp.StatusCode)
	}

	// Alice patches → 204.
	if resp, _ := do(t, srv, "PATCH", "/documents/"+d.ID, alice.AccessToken, map[string]string{"title": "Renamed"}); resp.StatusCode != http.StatusNoContent {
		t.Fatalf("alice patch should be 204, got %d", resp.StatusCode)
	}

	// Alice deletes → 204, then list empty.
	if resp, _ := do(t, srv, "DELETE", "/documents/"+d.ID, alice.AccessToken, nil); resp.StatusCode != http.StatusNoContent {
		t.Fatalf("alice delete should be 204, got %d", resp.StatusCode)
	}
	_, data = do(t, srv, "GET", "/documents", alice.AccessToken, nil)
	_ = json.Unmarshal(data, &list)
	if len(list) != 0 {
		t.Fatalf("doc should be gone, got %s", data)
	}
}
