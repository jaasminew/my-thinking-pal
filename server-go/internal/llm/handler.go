package llm

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"mythinkingpal/server/internal/auth"
)

const (
	RoleHeader     = "X-Thinking-Pal-Role"
	RoleListener   = "listener"
	RoleThinker    = "thinker"
	maxRequestBody = 2 << 20 // 2 MiB
)

// Config holds DeepSeek upstream settings.
type Config struct {
	APIKey         string
	BaseURL        string // e.g. https://api.deepseek.com
	ListenerModel  string
	ThinkerModel   string
	HTTPClient     *http.Client
}

// Handler proxies OpenAI-compatible chat completions with a server-held key.
type Handler struct {
	cfg Config
}

func NewHandler(cfg Config) *Handler {
	if cfg.BaseURL == "" {
		cfg.BaseURL = "https://api.deepseek.com"
	}
	cfg.BaseURL = strings.TrimRight(cfg.BaseURL, "/")
	if cfg.ListenerModel == "" {
		cfg.ListenerModel = "deepseek-v4-flash"
	}
	if cfg.ThinkerModel == "" {
		cfg.ThinkerModel = "deepseek-v4-pro"
	}
	if cfg.HTTPClient == nil {
		cfg.HTTPClient = &http.Client{
			Timeout:   5 * time.Minute, // streaming can run long
			Transport: &http.Transport{Proxy: http.ProxyFromEnvironment},
		}
	}
	return &Handler{cfg: cfg}
}

func (h *Handler) ChatCompletions(w http.ResponseWriter, r *http.Request) {
	userID := auth.UserID(r.Context())
	if userID == "" {
		writeError(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	if err := checkQuota(userID); err != nil {
		writeError(w, http.StatusTooManyRequests, "quota exceeded")
		return
	}
	if h.cfg.APIKey == "" {
		writeError(w, http.StatusServiceUnavailable, "llm_unavailable")
		return
	}

	body, err := io.ReadAll(io.LimitReader(r.Body, maxRequestBody+1))
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid body")
		return
	}
	if len(body) > maxRequestBody {
		writeError(w, http.StatusRequestEntityTooLarge, "body too large")
		return
	}

	var payload map[string]any
	if err := json.Unmarshal(body, &payload); err != nil {
		writeError(w, http.StatusBadRequest, "invalid json")
		return
	}

	role := strings.ToLower(strings.TrimSpace(r.Header.Get(RoleHeader)))
	if role != RoleListener {
		role = RoleThinker
	}
	model := h.cfg.ThinkerModel
	if role == RoleListener {
		model = h.cfg.ListenerModel
	}
	payload["model"] = model

	upstreamBody, err := json.Marshal(payload)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "encode failed")
		return
	}

	stream, _ := payload["stream"].(bool)
	upstreamURL := h.cfg.BaseURL + "/chat/completions"
	req, err := http.NewRequestWithContext(r.Context(), http.MethodPost, upstreamURL, bytes.NewReader(upstreamBody))
	if err != nil {
		writeError(w, http.StatusInternalServerError, "upstream request failed")
		return
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+h.cfg.APIKey)
	if stream {
		req.Header.Set("Accept", "text/event-stream")
	}

	res, err := h.cfg.HTTPClient.Do(req)
	if err != nil {
		slog.Warn("llm upstream error", "user", userID, "role", role, "err", err)
		writeError(w, http.StatusBadGateway, "llm_unavailable")
		return
	}
	defer res.Body.Close()

	for k, vals := range res.Header {
		lk := strings.ToLower(k)
		if lk == "transfer-encoding" || lk == "connection" || lk == "content-length" {
			continue
		}
		for _, v := range vals {
			w.Header().Add(k, v)
		}
	}
	if ct := res.Header.Get("Content-Type"); ct != "" {
		w.Header().Set("Content-Type", ct)
	} else if stream {
		w.Header().Set("Content-Type", "text/event-stream")
	} else {
		w.Header().Set("Content-Type", "application/json")
	}
	w.WriteHeader(res.StatusCode)

	if stream {
		flusher, _ := w.(http.Flusher)
		buf := make([]byte, 32*1024)
		for {
			n, readErr := res.Body.Read(buf)
			if n > 0 {
				if _, writeErr := w.Write(buf[:n]); writeErr != nil {
					break
				}
				if flusher != nil {
					flusher.Flush()
				}
			}
			if readErr != nil {
				break
			}
		}
	} else {
		_, _ = io.Copy(w, res.Body)
	}

	recordUsage(userID, role, model, stream)
}

func writeError(w http.ResponseWriter, code int, msg string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_, _ = fmt.Fprintf(w, `{"error":%q}`, msg)
}

func checkQuota(_ string) error { return nil }

func recordUsage(userID, role, model string, stream bool) {
	slog.Info("llm usage", "user", userID, "role", role, "model", model, "stream", stream)
}
