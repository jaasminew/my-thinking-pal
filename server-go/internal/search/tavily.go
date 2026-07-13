package search

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

const tavilyURL = "https://api.tavily.com/search"

// UrlCard matches the frontend web-search / Node relay result shape.
type UrlCard struct {
	Title   string `json:"title"`
	URL     string `json:"url"`
	Snippet string `json:"snippet,omitempty"`
}

// Searcher calls an upstream web-search provider (Tavily by default).
type Searcher interface {
	Search(ctx context.Context, query string, max int) ([]UrlCard, error)
}

type Tavily struct {
	apiKey string
	client *http.Client
}

func NewTavily(apiKey string) *Tavily {
	return &Tavily{
		apiKey: apiKey,
		client: &http.Client{
			Timeout:   10 * time.Second,
			Transport: &http.Transport{Proxy: http.ProxyFromEnvironment},
		},
	}
}

func (t *Tavily) Search(ctx context.Context, query string, max int) ([]UrlCard, error) {
	if t.apiKey == "" {
		return nil, errors.New("TAVILY_API_KEY not set")
	}
	if max < 1 {
		max = 1
	}
	if max > 5 {
		max = 5
	}

	body, err := json.Marshal(map[string]any{
		"api_key":      t.apiKey,
		"query":        query,
		"max_results":  max,
		"search_depth": "basic",
	})
	if err != nil {
		return nil, err
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, tavilyURL, bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")

	res, err := t.client.Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(res.Body, 1<<20))
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		msg := strings.TrimSpace(string(raw))
		if len(msg) > 200 {
			msg = msg[:200]
		}
		return nil, fmt.Errorf("Tavily %d: %s", res.StatusCode, msg)
	}

	var parsed struct {
		Results []struct {
			Title   string `json:"title"`
			URL     string `json:"url"`
			Content string `json:"content"`
		} `json:"results"`
	}
	if err := json.Unmarshal(raw, &parsed); err != nil {
		return nil, err
	}

	out := make([]UrlCard, 0, max)
	for _, r := range parsed.Results {
		if len(out) >= max {
			break
		}
		title := r.Title
		if title == "" {
			title = r.URL
		}
		card := UrlCard{Title: title, URL: r.URL}
		if r.Content != "" {
			snippet := r.Content
			if len(snippet) > 180 {
				snippet = snippet[:180]
			}
			card.Snippet = snippet
		}
		out = append(out, card)
	}
	return out, nil
}

// FuncSearcher adapts a function to Searcher (tests).
type FuncSearcher func(ctx context.Context, query string, max int) ([]UrlCard, error)

func (f FuncSearcher) Search(ctx context.Context, query string, max int) ([]UrlCard, error) {
	return f(ctx, query, max)
}
