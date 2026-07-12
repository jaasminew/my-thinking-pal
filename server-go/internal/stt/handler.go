package stt

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"time"

	"github.com/coder/websocket"

	"mythinkingpal/server/internal/auth"
)

// Handler is the /stt WebSocket proxy. It owns the fixed client protocol
// (module 07.5) and delegates to a pluggable Upstream.
type Handler struct {
	upstream Upstream
	origins  []string
}

func NewHandler(upstream Upstream, origins ...string) *Handler {
	return &Handler{upstream: upstream, origins: origins}
}

// Uplink client messages.
type clientMsg struct {
	Type       string `json:"type"` // "config" | "stop"
	Language   string `json:"language"`
	SampleRate int    `json:"sampleRate"`
}

// Downlink server messages.
type transcriptMsg struct {
	Type     string `json:"type"` // "transcript"
	Text     string `json:"text"`
	Final    bool   `json:"final"`
	Language string `json:"language,omitempty"`
	Speaker  string `json:"speaker,omitempty"`
}

type errorMsg struct {
	Type  string `json:"type"` // "error"
	Error string `json:"error"`
}

func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	userID := auth.UserID(r.Context())
	if userID == "" {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	// Quota/billing hook (module 07.6): first version always allows.
	if err := checkQuota(userID); err != nil {
		http.Error(w, "quota exceeded", http.StatusTooManyRequests)
		return
	}

	ws, err := websocket.Accept(w, r, &websocket.AcceptOptions{
		Subprotocols:   []string{"bearer"},
		OriginPatterns: h.origins,
	})
	if err != nil {
		return
	}
	defer ws.CloseNow()
	ws.SetReadLimit(4 << 20)

	ctx := r.Context()
	start := time.Now()

	var (
		sess Session
		cfg  Config
	)
	defer func() {
		if sess != nil {
			_ = sess.Close()
		}
		recordUsage(userID, time.Since(start)) // module 07.6 accounting
	}()

	openIfNeeded := func() bool {
		if sess != nil {
			return true
		}
		s, err := h.upstream.Open(ctx, cfg)
		if err != nil {
			_ = writeJSON(ctx, ws, errorMsg{Type: "error", Error: err.Error()})
			return false
		}
		sess = s
		go h.pump(ctx, ws, sess)
		return true
	}

	for {
		typ, data, err := ws.Read(ctx)
		if err != nil {
			return
		}
		switch typ {
		case websocket.MessageText:
			var m clientMsg
			if json.Unmarshal(data, &m) != nil {
				continue
			}
			switch m.Type {
			case "config":
				if sess == nil { // config only matters before the upstream opens
					cfg = Config{Language: m.Language, SampleRate: m.SampleRate}
				}
			case "stop":
				return
			}
		case websocket.MessageBinary:
			if len(data) == 0 {
				continue
			}
			if !openIfNeeded() {
				return
			}
			if err := sess.SendAudio(ctx, data); err != nil {
				_ = writeJSON(ctx, ws, errorMsg{Type: "error", Error: err.Error()})
				return
			}
		}
	}
}

// pump is the sole writer to the client socket: it relays upstream transcripts
// and errors downstream until the session ends or the client disconnects.
func (h *Handler) pump(ctx context.Context, ws *websocket.Conn, sess Session) {
	for {
		select {
		case <-ctx.Done():
			return
		case t, ok := <-sess.Transcripts():
			if !ok {
				return
			}
			if err := writeJSON(ctx, ws, transcriptMsg{
				Type: "transcript", Text: t.Text, Final: t.Final, Language: t.Language, Speaker: t.Speaker,
			}); err != nil {
				return
			}
		case err, ok := <-sess.Errors():
			if !ok {
				continue
			}
			_ = writeJSON(ctx, ws, errorMsg{Type: "error", Error: err.Error()})
			return
		}
	}
}

func writeJSON(ctx context.Context, ws *websocket.Conn, v any) error {
	b, err := json.Marshal(v)
	if err != nil {
		return err
	}
	wctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	return ws.Write(wctx, websocket.MessageText, b)
}

// checkQuota is the per-account rate/billing gate (module 07.6). Stubbed to
// always allow; wire real quotas once usage accounting is persisted.
func checkQuota(_ string) error { return nil }

// recordUsage logs STT duration for future usage_events accounting (module 07.6).
func recordUsage(userID string, dur time.Duration) {
	slog.Info("stt usage", "user", userID, "seconds", dur.Seconds())
}
