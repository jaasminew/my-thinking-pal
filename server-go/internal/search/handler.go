package search

import (
	"encoding/json"
	"log/slog"
	"net/http"
	"strconv"
	"strings"

	"mythinkingpal/server/internal/auth"
)

// Handler serves auth-gated /search and /url-meta (STT-style key proxy).
type Handler struct {
	searcher Searcher
	meta     MetaFetcher
}

func NewHandler(searcher Searcher, meta MetaFetcher) *Handler {
	if meta == nil {
		meta = NewURLMetaClient()
	}
	return &Handler{searcher: searcher, meta: meta}
}

func (h *Handler) Search(w http.ResponseWriter, r *http.Request) {
	userID := auth.UserID(r.Context())
	if userID == "" {
		writeError(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	if err := checkQuota(userID); err != nil {
		writeError(w, http.StatusTooManyRequests, "quota exceeded")
		return
	}

	query := strings.TrimSpace(r.URL.Query().Get("q"))
	if query == "" || len(query) > 500 {
		writeJSON(w, http.StatusBadRequest, map[string]any{"results": []UrlCard{}, "error": "invalid_query"})
		return
	}
	n, _ := strconv.Atoi(r.URL.Query().Get("n"))
	if n < 1 {
		n = 1
	}
	if n > 5 {
		n = 5
	}

	results, err := h.searcher.Search(r.Context(), query, n)
	if err != nil {
		slog.Warn("search unavailable", "user", userID, "err", err)
		writeJSON(w, http.StatusOK, map[string]any{"results": []UrlCard{}, "error": "search_unavailable"})
		recordUsage(userID, "search", 0)
		return
	}
	if results == nil {
		results = []UrlCard{}
	}
	writeJSON(w, http.StatusOK, map[string]any{"results": results})
	recordUsage(userID, "search", len(results))
}

func (h *Handler) URLMeta(w http.ResponseWriter, r *http.Request) {
	userID := auth.UserID(r.Context())
	if userID == "" {
		writeError(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	if err := checkQuota(userID); err != nil {
		writeError(w, http.StatusTooManyRequests, "quota exceeded")
		return
	}

	raw := r.URL.Query().Get("url")
	if !strings.HasPrefix(raw, "http://") && !strings.HasPrefix(raw, "https://") {
		writeJSON(w, http.StatusBadRequest, UrlMeta{})
		return
	}
	meta := h.meta.Fetch(r.Context(), raw)
	writeJSON(w, http.StatusOK, meta)
	recordUsage(userID, "url-meta", 1)
}

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}

func writeError(w http.ResponseWriter, code int, msg string) {
	writeJSON(w, code, map[string]string{"error": msg})
}

func checkQuota(_ string) error { return nil }

func recordUsage(userID, kind string, amount int) {
	slog.Info("search usage", "user", userID, "kind", kind, "amount", amount)
}
