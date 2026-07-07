// Package documents exposes CRUD over a user's board metadata. The CRDT content
// itself syncs over /sync (module 05); this is just the ownership/title index.
package documents

import (
	"encoding/json"
	"net/http"

	"mythinkingpal/server/internal/auth"
	"mythinkingpal/server/internal/storage"
)

type Handler struct {
	store storage.AccountStore
}

func NewHandler(store storage.AccountStore) *Handler { return &Handler{store: store} }

func (h *Handler) List(w http.ResponseWriter, r *http.Request) {
	docs, err := h.store.ListDocuments(r.Context(), auth.UserID(r.Context()))
	if err != nil {
		writeError(w, http.StatusInternalServerError, "list failed")
		return
	}
	writeJSON(w, http.StatusOK, docs)
}

type titleReq struct {
	Title string `json:"title"`
}

func (h *Handler) Create(w http.ResponseWriter, r *http.Request) {
	var req titleReq
	_ = json.NewDecoder(r.Body).Decode(&req)
	if req.Title == "" {
		req.Title = "Untitled"
	}
	d, err := h.store.CreateDocument(r.Context(), auth.UserID(r.Context()), req.Title)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "create failed")
		return
	}
	writeJSON(w, http.StatusCreated, d)
}

func (h *Handler) Patch(w http.ResponseWriter, r *http.Request) {
	docID := r.PathValue("id")
	if !h.owns(w, r, docID) {
		return
	}
	var req titleReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.Title == "" {
		writeError(w, http.StatusBadRequest, "title required")
		return
	}
	if err := h.store.UpdateDocumentTitle(r.Context(), docID, req.Title); err != nil {
		writeError(w, http.StatusInternalServerError, "update failed")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (h *Handler) Delete(w http.ResponseWriter, r *http.Request) {
	docID := r.PathValue("id")
	if !h.owns(w, r, docID) {
		return
	}
	if err := h.store.DeleteDocument(r.Context(), docID); err != nil {
		writeError(w, http.StatusInternalServerError, "delete failed")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// owns writes the appropriate 404/403 and returns false when access is denied.
func (h *Handler) owns(w http.ResponseWriter, r *http.Request, docID string) bool {
	ok, err := h.store.CanAccess(r.Context(), auth.UserID(r.Context()), docID)
	if err != nil {
		writeError(w, http.StatusNotFound, "not found")
		return false
	}
	if !ok {
		writeError(w, http.StatusForbidden, "forbidden")
		return false
	}
	return true
}

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}

func writeError(w http.ResponseWriter, code int, msg string) {
	writeJSON(w, code, map[string]string{"error": msg})
}
