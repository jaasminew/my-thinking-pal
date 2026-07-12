package projectmemory

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"path/filepath"

	"mythinkingpal/server/internal/auth"
	"mythinkingpal/server/internal/id"
	"mythinkingpal/server/internal/storage"
)

// maxUploadBytes is the per-file upload cap (contract §2: reject > 20 MB → 413).
const maxUploadBytes = 20 << 20

// Handler exposes the Project Memory HTTP routes. It is a dumb store: the only
// compute is deterministic text extraction (H7) at upload time — never AI.
type Handler struct {
	store   storage.AccountStore
	dataDir string // blobs live at <dataDir>/project-memory/<owner>/<file>
}

// NewHandler builds a handler. dataDir is the base directory for original blobs.
func NewHandler(store storage.AccountStore, dataDir string) *Handler {
	return &Handler{store: store, dataDir: dataDir}
}

func (h *Handler) blobPath(ownerID, fileID string) string {
	return filepath.Join(h.dataDir, "project-memory", ownerID, fileID)
}

func validScopeKind(k string) bool { return k == "project" || k == "space" }

// --- Files ---

func (h *Handler) ListFiles(w http.ResponseWriter, r *http.Request) {
	scopeKind, scopeID := r.PathValue("scopeKind"), r.PathValue("scopeId")
	if !validScopeKind(scopeKind) {
		writeError(w, http.StatusBadRequest, "invalid scope kind")
		return
	}
	files, err := h.store.ListPMFiles(r.Context(), auth.UserID(r.Context()), scopeKind, scopeID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "list failed")
		return
	}
	writeJSON(w, http.StatusOK, files)
}

func (h *Handler) UploadFile(w http.ResponseWriter, r *http.Request) {
	scopeKind, scopeID := r.PathValue("scopeKind"), r.PathValue("scopeId")
	if !validScopeKind(scopeKind) {
		writeError(w, http.StatusBadRequest, "invalid scope kind")
		return
	}
	ownerID := auth.UserID(r.Context())

	// Cap the whole body just above 20 MB so oversized uploads fail fast without
	// being fully buffered. The precise per-file check is header.Size below.
	r.Body = http.MaxBytesReader(w, r.Body, maxUploadBytes+1<<20)
	if err := r.ParseMultipartForm(maxUploadBytes + 1<<20); err != nil {
		var maxErr *http.MaxBytesError
		if errors.As(err, &maxErr) {
			writeError(w, http.StatusRequestEntityTooLarge, "file exceeds 20 MB limit")
			return
		}
		writeError(w, http.StatusBadRequest, "invalid multipart form")
		return
	}

	name := r.FormValue("name")
	mimeType := r.FormValue("mimeType")
	title := r.FormValue("title")
	description := r.FormValue("description")
	extractedText := r.FormValue("extractedText")
	if name == "" || mimeType == "" || title == "" || description == "" {
		writeError(w, http.StatusBadRequest, "missing required fields")
		return
	}

	file, header, err := r.FormFile("file")
	if err != nil {
		writeError(w, http.StatusBadRequest, "file required")
		return
	}
	if header.Size > maxUploadBytes {
		writeError(w, http.StatusRequestEntityTooLarge, "file exceeds 20 MB limit")
		return
	}
	data, err := io.ReadAll(file)
	_ = file.Close()
	if err != nil {
		writeError(w, http.StatusBadRequest, "read file failed")
		return
	}

	// Pre-generate the id so the blob path is known before the row is created.
	fileID := id.New()
	blob := h.blobPath(ownerID, fileID)
	if err := os.MkdirAll(filepath.Dir(blob), 0o755); err != nil {
		writeError(w, http.StatusInternalServerError, "persist failed")
		return
	}
	if err := os.WriteFile(blob, data, 0o644); err != nil {
		writeError(w, http.StatusInternalServerError, "persist failed")
		return
	}

	f, err := h.store.CreatePMFile(r.Context(), storage.ProjectMemoryFile{
		ID:          fileID,
		OwnerID:     ownerID,
		ScopeKind:   scopeKind,
		ScopeID:     scopeID,
		Name:        name,
		MimeType:    mimeType,
		Size:        header.Size,
		Title:       title,
		Description: description,
		Status:      "queued",
		BlobPath:    blob,
	})
	if err != nil {
		_ = os.Remove(blob) // roll back the orphaned blob
		writeError(w, http.StatusInternalServerError, "create failed")
		return
	}

	// Extraction (deterministic; no AI). The client never sees a transient
	// queued/extracting status from this endpoint.
	//
	// extractedText PRESENCE (not just non-emptiness) marks browser-side
	// extraction: image OCR can legitimately be an empty string, and the server
	// cannot read pixels — such uploads must still index.
	_, hasExtractedText := r.MultipartForm.Value["extractedText"]
	status := "queued"
	errMsg := ""
	switch {
	case hasExtractedText:
		// Browser already parsed a text format; trust + cap it.
		capped, trunc := capText(extractedText, textCharCap)
		if err := h.store.PutPMText(r.Context(), ownerID, f.ID, capped, trunc); err != nil {
			status, errMsg = "failed", "text store failed"
		} else {
			status = "indexed"
		}
	case Supported(mimeType, name):
		text, trunc, e := ExtractText(data, mimeType, name)
		if e != nil {
			status, errMsg = "failed", e.Error()
		} else if err := h.store.PutPMText(r.Context(), ownerID, f.ID, text, trunc); err != nil {
			status, errMsg = "failed", "text store failed"
		} else {
			status = "indexed"
		}
	default:
		status, errMsg = "failed", "unsupported file type"
	}

	if err := h.store.UpdatePMFileStatus(r.Context(), ownerID, f.ID, status, errMsg); err != nil {
		writeError(w, http.StatusInternalServerError, "status update failed")
		return
	}

	final, err := h.store.GetPMFile(r.Context(), ownerID, f.ID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "fetch failed")
		return
	}
	writeJSON(w, http.StatusCreated, final)
}

func (h *Handler) DeleteFile(w http.ResponseWriter, r *http.Request) {
	ownerID := auth.UserID(r.Context())
	fileID := r.PathValue("id")

	f, err := h.store.GetPMFile(r.Context(), ownerID, fileID)
	if err != nil {
		writeError(w, http.StatusNotFound, "not found")
		return
	}
	if err := h.store.DeletePMFile(r.Context(), ownerID, fileID); err != nil {
		writeError(w, http.StatusInternalServerError, "delete failed")
		return
	}
	if f.BlobPath != "" {
		_ = os.Remove(f.BlobPath) // best-effort; ignore missing
	}
	w.WriteHeader(http.StatusNoContent)
}

func (h *Handler) GetText(w http.ResponseWriter, r *http.Request) {
	ownerID := auth.UserID(r.Context())
	fileID := r.PathValue("id")
	text, truncated, err := h.store.GetPMText(r.Context(), ownerID, fileID)
	if err != nil {
		writeError(w, http.StatusNotFound, "not found")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"text": text, "truncated": truncated})
}

// GetBlob serves the original uploaded bytes (used by the browser to re-attach
// image files to AI calls). Ownership is enforced by the store lookup.
func (h *Handler) GetBlob(w http.ResponseWriter, r *http.Request) {
	ownerID := auth.UserID(r.Context())
	fileID := r.PathValue("id")
	f, err := h.store.GetPMFile(r.Context(), ownerID, fileID)
	if err != nil || f.BlobPath == "" {
		writeError(w, http.StatusNotFound, "not found")
		return
	}
	data, err := os.ReadFile(f.BlobPath)
	if err != nil {
		writeError(w, http.StatusNotFound, "not found")
		return
	}
	if f.MimeType != "" {
		w.Header().Set("Content-Type", f.MimeType)
	} else {
		w.Header().Set("Content-Type", "application/octet-stream")
	}
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(data)
}

// --- Instructions ---

func (h *Handler) GetInstructions(w http.ResponseWriter, r *http.Request) {
	scopeKind, scopeID := r.PathValue("scopeKind"), r.PathValue("scopeId")
	if !validScopeKind(scopeKind) {
		writeError(w, http.StatusBadRequest, "invalid scope kind")
		return
	}
	ins, err := h.store.GetPMInstructions(r.Context(), auth.UserID(r.Context()), scopeKind, scopeID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "load failed")
		return
	}
	writeJSON(w, http.StatusOK, ins)
}

func (h *Handler) PutInstructions(w http.ResponseWriter, r *http.Request) {
	scopeKind, scopeID := r.PathValue("scopeKind"), r.PathValue("scopeId")
	if !validScopeKind(scopeKind) {
		writeError(w, http.StatusBadRequest, "invalid scope kind")
		return
	}
	var ins storage.ProjectInstructions
	if err := json.NewDecoder(r.Body).Decode(&ins); err != nil {
		writeError(w, http.StatusBadRequest, "invalid body")
		return
	}
	if err := h.store.PutPMInstructions(r.Context(), auth.UserID(r.Context()), scopeKind, scopeID, ins); err != nil {
		writeError(w, http.StatusInternalServerError, "save failed")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (h *Handler) DeleteScope(w http.ResponseWriter, r *http.Request) {
	scopeKind, scopeID := r.PathValue("scopeKind"), r.PathValue("scopeId")
	if !validScopeKind(scopeKind) {
		writeError(w, http.StatusBadRequest, "invalid scope kind")
		return
	}
	blobs, err := h.store.DeletePMScope(r.Context(), auth.UserID(r.Context()), scopeKind, scopeID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "delete failed")
		return
	}
	for _, b := range blobs {
		if b != "" {
			_ = os.Remove(b)
		}
	}
	w.WriteHeader(http.StatusNoContent) // idempotent: 204 even when empty
}

// --- helpers ---

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}

func writeError(w http.ResponseWriter, code int, msg string) {
	writeJSON(w, code, map[string]string{"error": msg})
}
