package llm_test

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"mythinkingpal/server/internal/auth"
	"mythinkingpal/server/internal/documents"
	"mythinkingpal/server/internal/httpapi"
	"mythinkingpal/server/internal/llm"
	"mythinkingpal/server/internal/storage/memory"
)

func newLLMServer(t *testing.T, upstream http.Handler, apiKey string) *httptest.Server {
	t.Helper()
	up := httptest.NewServer(upstream)
	t.Cleanup(up.Close)

	store := memory.New()
	authH := auth.NewHandler(store, []byte("access"), []byte("refresh"), 15*time.Minute, 720*time.Hour)
	docsH := documents.NewHandler(store)
	llmH := llm.NewHandler(llm.Config{
		APIKey:        apiKey,
		BaseURL:       up.URL,
		ListenerModel: "deepseek-v4-flash",
		ThinkerModel:  "deepseek-v4-pro",
		HTTPClient:    up.Client(),
	})
	return httptest.NewServer(httpapi.New(httpapi.Deps{
		Auth:       authH,
		Documents:  docsH,
		LLM:        llmH,
		CORSOrigin: "*",
	}))
}

func register(t *testing.T, srv *httptest.Server) string {
	t.Helper()
	resp, err := http.Post(srv.URL+"/auth/register", "application/json",
		strings.NewReader(`{"email":"llm@example.com","password":"password123"}`))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusCreated {
		b, _ := io.ReadAll(resp.Body)
		t.Fatalf("register %d: %s", resp.StatusCode, b)
	}
	var tp struct {
		AccessToken string `json:"accessToken"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&tp); err != nil {
		t.Fatal(err)
	}
	return tp.AccessToken
}

func TestLLMRequiresAuth(t *testing.T) {
	srv := newLLMServer(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Fatal("upstream should not be called")
	}), "key")
	defer srv.Close()

	resp, err := http.Post(srv.URL+"/llm/chat/completions", "application/json",
		strings.NewReader(`{"messages":[{"role":"user","content":"hi"}]}`))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("want 401, got %d", resp.StatusCode)
	}
}

func TestLLMMapsListenerRoleToFlash(t *testing.T) {
	var gotModel string
	var gotAuth string
	srv := newLLMServer(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotAuth = r.Header.Get("Authorization")
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		gotModel, _ = body["model"].(string)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"choices":[{"message":{"content":"ok"}}]}`))
	}), "secret-key")
	defer srv.Close()
	token := register(t, srv)

	req, _ := http.NewRequest(http.MethodPost, srv.URL+"/llm/chat/completions",
		strings.NewReader(`{"model":"ignored","messages":[{"role":"user","content":"hi"}],"stream":false}`))
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set(llm.RoleHeader, "listener")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		b, _ := io.ReadAll(resp.Body)
		t.Fatalf("status %d: %s", resp.StatusCode, b)
	}
	if gotModel != "deepseek-v4-flash" {
		t.Fatalf("model=%q", gotModel)
	}
	if gotAuth != "Bearer secret-key" {
		t.Fatalf("upstream auth=%q", gotAuth)
	}
}

func TestLLMMapsThinkerDefaultToPro(t *testing.T) {
	var gotModel string
	srv := newLLMServer(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		gotModel, _ = body["model"].(string)
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = w.Write([]byte("data: {\"choices\":[{\"delta\":{\"content\":\"hi\"}}]}\n\n"))
		_, _ = w.Write([]byte("data: [DONE]\n\n"))
	}), "secret-key")
	defer srv.Close()
	token := register(t, srv)

	req, _ := http.NewRequest(http.MethodPost, srv.URL+"/llm/chat/completions",
		strings.NewReader(`{"messages":[{"role":"user","content":"hi"}],"stream":true}`))
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		b, _ := io.ReadAll(resp.Body)
		t.Fatalf("status %d: %s", resp.StatusCode, b)
	}
	body, _ := io.ReadAll(resp.Body)
	if !strings.Contains(string(body), "[DONE]") {
		t.Fatalf("missing SSE body: %s", body)
	}
	if gotModel != "deepseek-v4-pro" {
		t.Fatalf("model=%q", gotModel)
	}
}

func TestLLMUnavailableWithoutKey(t *testing.T) {
	srv := newLLMServer(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Fatal("should not call upstream")
	}), "")
	defer srv.Close()
	token := register(t, srv)

	req, _ := http.NewRequest(http.MethodPost, srv.URL+"/llm/chat/completions",
		strings.NewReader(`{"messages":[{"role":"user","content":"hi"}]}`))
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusServiceUnavailable {
		t.Fatalf("want 503, got %d", resp.StatusCode)
	}
}
