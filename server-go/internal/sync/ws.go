package sync

import (
	"context"
	"log/slog"
	"net/http"
	"time"

	"github.com/coder/websocket"

	"mythinkingpal/server/internal/auth"
	"mythinkingpal/server/internal/storage"
)

type Handler struct {
	hub      *Hub
	docs     storage.DocStore
	accounts storage.AccountStore
	origins  []string
}

func NewHandler(docs storage.DocStore, accounts storage.AccountStore, origins ...string) *Handler {
	return &Handler{hub: NewHub(), docs: docs, accounts: accounts, origins: origins}
}

const sendQueue = 256

// ServeHTTP handles GET /sync/{docId}. RequireAuth has already validated the
// token and put the user id in ctx; here we additionally check document
// ownership.
func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	docID := r.PathValue("docId")
	if docID == "" {
		http.Error(w, "missing docId", http.StatusBadRequest)
		return
	}
	userID := auth.UserID(r.Context())
	if !h.authorize(r.Context(), userID, docID) {
		http.Error(w, "forbidden", http.StatusForbidden)
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
	ws.SetReadLimit(16 << 20) // 16 MiB: snapshots of large boards

	ctx := r.Context()
	c := &conn{docID: docID, send: make(chan []byte, sendQueue)}
	h.hub.join(c)
	defer h.hub.leave(c)

	// Writer goroutine: drains the send queue to the socket.
	writerCtx, cancelWriter := context.WithCancel(ctx)
	defer cancelWriter()
	go func() {
		for {
			select {
			case <-writerCtx.Done():
				return
			case msg := <-c.send:
				wctx, cancel := context.WithTimeout(writerCtx, 10*time.Second)
				err := ws.Write(wctx, websocket.MessageBinary, msg)
				cancel()
				if err != nil {
					return
				}
			}
		}
	}()

	// Replay persisted state to the newly joined client (snapshot + updates).
	if err := h.replay(ctx, c); err != nil {
		slog.Warn("sync replay failed", "doc", docID, "err", err)
	}

	// Read loop.
	for {
		typ, data, err := ws.Read(ctx)
		if err != nil {
			return
		}
		if typ != websocket.MessageBinary || len(data) == 0 {
			continue
		}
		switch data[0] {
		case MsgUpdate:
			payload := data[1:]
			// Hot path: broadcast to peers first (don't block on storage).
			h.hub.broadcast(docID, c, data)
			if _, err := h.docs.AppendUpdate(ctx, docID, payload); err != nil {
				slog.Warn("append update failed", "doc", docID, "err", err)
			}
		case MsgSnapshotPut:
			h.applySnapshot(ctx, docID, data[1:])
		case MsgAwareness:
			h.hub.broadcast(docID, c, data) // ephemeral, never persisted
		}
	}
}

func (h *Handler) replay(ctx context.Context, c *conn) error {
	snap, _, err := h.docs.LatestSnapshot(ctx, c.docID)
	if err != nil {
		return err
	}
	if len(snap) > 0 {
		c.send <- frame(MsgUpdate, snap)
	}
	updates, _, err := h.docs.LoadUpdates(ctx, c.docID)
	if err != nil {
		return err
	}
	for _, u := range updates {
		c.send <- frame(MsgUpdate, u)
	}
	return nil
}

// applySnapshot stores the client-computed snapshot and truncates the update log
// it supersedes. The truncation base is the max seq present BEFORE the snapshot
// was stored, so updates arriving concurrently survive.
func (h *Handler) applySnapshot(ctx context.Context, docID string, snap []byte) {
	if len(snap) == 0 {
		return
	}
	_, baseSeq, err := h.docs.LoadUpdates(ctx, docID)
	if err != nil {
		slog.Warn("snapshot preflight failed", "doc", docID, "err", err)
		return
	}
	_, ver, _ := h.docs.LatestSnapshot(ctx, docID)
	if err := h.docs.PutSnapshot(ctx, docID, snap, ver+1); err != nil {
		slog.Warn("put snapshot failed", "doc", docID, "err", err)
		return
	}
	if err := h.docs.TruncateUpdates(ctx, docID, baseSeq); err != nil {
		slog.Warn("truncate failed", "doc", docID, "err", err)
	}
}

// authorize only allows an account that can access a registered document.
func (h *Handler) authorize(ctx context.Context, userID, docID string) bool {
	if userID == "" {
		return false
	}
	ok, err := h.accounts.CanAccess(ctx, userID, docID)
	return err == nil && ok
}
