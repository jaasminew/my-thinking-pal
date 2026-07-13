// Package workspace exposes GET/PUT for the account-scoped sidebar tree.
// Board CRDT content still syncs over /sync; this is only the Project / Idea
// Space hierarchy (with embedded space.docId for sync-room binding).
package workspace

import (
	"encoding/json"
	"errors"
	"net/http"

	"mythinkingpal/server/internal/auth"
	"mythinkingpal/server/internal/storage"
)

type Handler struct {
	store storage.AccountStore
}

func NewHandler(store storage.AccountStore) *Handler { return &Handler{store: store} }

func (h *Handler) Get(w http.ResponseWriter, r *http.Request) {
	ws, err := h.store.GetWorkspace(r.Context(), auth.UserID(r.Context()))
	if err != nil {
		if errors.Is(err, storage.ErrNotFound) {
			writeJSON(w, http.StatusOK, storage.Workspace{
				Tree: json.RawMessage("[]"),
			})
			return
		}
		writeError(w, http.StatusInternalServerError, "get failed")
		return
	}
	writeJSON(w, http.StatusOK, ws)
}

type putReq struct {
	Tree json.RawMessage `json:"tree"`
}

func (h *Handler) Put(w http.ResponseWriter, r *http.Request) {
	var req putReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid json")
		return
	}
	if len(req.Tree) == 0 {
		writeError(w, http.StatusBadRequest, "tree required")
		return
	}
	// Reject non-array trees early so we don't persist garbage.
	if !json.Valid(req.Tree) || req.Tree[0] != '[' {
		writeError(w, http.StatusBadRequest, "tree must be a JSON array")
		return
	}
	ws, err := h.store.PutWorkspace(r.Context(), auth.UserID(r.Context()), req.Tree)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "put failed")
		return
	}
	writeJSON(w, http.StatusOK, ws)
}

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}

func writeError(w http.ResponseWriter, code int, msg string) {
	writeJSON(w, code, map[string]string{"error": msg})
}
