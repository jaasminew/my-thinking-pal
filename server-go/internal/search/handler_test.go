package search_test

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"mythinkingpal/server/internal/auth"
	"mythinkingpal/server/internal/documents"
	"mythinkingpal/server/internal/httpapi"
	"mythinkingpal/server/internal/search"
	"mythinkingpal/server/internal/storage/memory"
)

func newSearchServer(t *testing.T, searcher search.Searcher, meta search.MetaFetcher) *httptest.Server {
	t.Helper()
	store := memory.New()
	authH := auth.NewHandler(store, []byte("access"), []byte("refresh"), 15*time.Minute, 720*time.Hour)
	docsH := documents.NewHandler(store)
	searchH := search.NewHandler(searcher, meta)
	return httptest.NewServer(httpapi.New(httpapi.Deps{
		Auth:       authH,
		Documents:  docsH,
		Search:     searchH,
		CORSOrigin: "*",
	}))
}

func register(t *testing.T, srv *httptest.Server) string {
	t.Helper()
	resp, err := http.Post(srv.URL+"/auth/register", "application/json",
		strings.NewReader(`{"email":"search@example.com","password":"password123"}`))
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

func TestSearchRequiresAuth(t *testing.T) {
	srv := newSearchServer(t, search.FuncSearcher(func(context.Context, string, int) ([]search.UrlCard, error) {
		return []search.UrlCard{{Title: "x", URL: "https://x.com"}}, nil
	}), nil)
	defer srv.Close()

	resp, err := http.Get(srv.URL + "/search?q=test")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("want 401, got %d", resp.StatusCode)
	}
}

func TestSearchHappyPath(t *testing.T) {
	var gotQ string
	var gotN int
	srv := newSearchServer(t, search.FuncSearcher(func(_ context.Context, q string, n int) ([]search.UrlCard, error) {
		gotQ, gotN = q, n
		return []search.UrlCard{{Title: q, URL: "https://example.com", Snippet: "hi"}}, nil
	}), nil)
	defer srv.Close()
	token := register(t, srv)

	req, _ := http.NewRequest(http.MethodGet, srv.URL+"/search?q=thinking&n=99", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		b, _ := io.ReadAll(resp.Body)
		t.Fatalf("status %d: %s", resp.StatusCode, b)
	}
	var body struct {
		Results []search.UrlCard `json:"results"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		t.Fatal(err)
	}
	if gotQ != "thinking" || gotN != 5 {
		t.Fatalf("upstream called with q=%q n=%d", gotQ, gotN)
	}
	if len(body.Results) != 1 || body.Results[0].URL != "https://example.com" {
		t.Fatalf("bad results: %+v", body.Results)
	}
}

func TestSearchSoftFailsUpstream(t *testing.T) {
	srv := newSearchServer(t, search.FuncSearcher(func(context.Context, string, int) ([]search.UrlCard, error) {
		return nil, errors.New("upstream down")
	}), nil)
	defer srv.Close()
	token := register(t, srv)

	req, _ := http.NewRequest(http.MethodGet, srv.URL+"/search?q=test", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("want 200 soft-fail, got %d", resp.StatusCode)
	}
	var body struct {
		Results []search.UrlCard `json:"results"`
		Error   string           `json:"error"`
	}
	_ = json.NewDecoder(resp.Body).Decode(&body)
	if len(body.Results) != 0 || body.Error != "search_unavailable" {
		t.Fatalf("unexpected body: %+v", body)
	}
}

func TestSearchRejectsEmptyQuery(t *testing.T) {
	srv := newSearchServer(t, search.FuncSearcher(func(context.Context, string, int) ([]search.UrlCard, error) {
		t.Fatal("should not call upstream")
		return nil, nil
	}), nil)
	defer srv.Close()
	token := register(t, srv)

	req, _ := http.NewRequest(http.MethodGet, srv.URL+"/search?q=", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("want 400, got %d", resp.StatusCode)
	}
}

func TestURLMetaRequiresAuth(t *testing.T) {
	srv := newSearchServer(t, search.FuncSearcher(func(context.Context, string, int) ([]search.UrlCard, error) {
		return nil, nil
	}), search.FuncMetaFetcher(func(context.Context, string) search.UrlMeta {
		return search.UrlMeta{Description: "d"}
	}))
	defer srv.Close()

	resp, err := http.Get(srv.URL + "/url-meta?url=https://example.com")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("want 401, got %d", resp.StatusCode)
	}
}

func TestURLMetaHappyPath(t *testing.T) {
	srv := newSearchServer(t, search.FuncSearcher(func(context.Context, string, int) ([]search.UrlCard, error) {
		return nil, nil
	}), search.FuncMetaFetcher(func(_ context.Context, raw string) search.UrlMeta {
		if raw != "https://example.com/page" {
			t.Fatalf("unexpected url %q", raw)
		}
		return search.UrlMeta{Description: "About", Image: "https://example.com/i.png"}
	}))
	defer srv.Close()
	token := register(t, srv)

	req, _ := http.NewRequest(http.MethodGet, srv.URL+"/url-meta?url=https%3A%2F%2Fexample.com%2Fpage", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		b, _ := io.ReadAll(resp.Body)
		t.Fatalf("status %d: %s", resp.StatusCode, b)
	}
	var meta search.UrlMeta
	_ = json.NewDecoder(resp.Body).Decode(&meta)
	if meta.Description != "About" || meta.Image != "https://example.com/i.png" {
		t.Fatalf("bad meta: %+v", meta)
	}
}

func TestIsPublicIP(t *testing.T) {
	cases := []struct {
		ip   string
		want bool
	}{
		{"8.8.8.8", true},
		{"127.0.0.1", false},
		{"10.0.0.1", false},
		{"192.168.1.1", false},
		{"169.254.1.1", false},
		{"::1", false},
		{"2001:4860:4860::8888", true},
	}
	for _, c := range cases {
		got := search.IsPublicIP(net.ParseIP(c.ip))
		if got != c.want {
			t.Fatalf("%s: got %v want %v", c.ip, got, c.want)
		}
	}
}
