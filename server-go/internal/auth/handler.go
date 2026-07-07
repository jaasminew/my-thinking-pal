package auth

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"

	"mythinkingpal/server/internal/storage"
)

type Handler struct {
	store         storage.AccountStore
	accessSecret  []byte
	refreshSecret []byte
	accessTTL     time.Duration
	refreshTTL    time.Duration
}

func NewHandler(store storage.AccountStore, accessSecret, refreshSecret []byte, accessTTL, refreshTTL time.Duration) *Handler {
	return &Handler{store: store, accessSecret: accessSecret, refreshSecret: refreshSecret, accessTTL: accessTTL, refreshTTL: refreshTTL}
}

type credentials struct {
	Email    string `json:"email"`
	Password string `json:"password"`
}

type tokenPair struct {
	AccessToken  string       `json:"accessToken"`
	RefreshToken string       `json:"refreshToken"`
	User         storage.User `json:"user"`
}

func (h *Handler) Register(w http.ResponseWriter, r *http.Request) {
	var c credentials
	if err := decode(r, &c); err != nil {
		writeError(w, http.StatusBadRequest, "invalid body")
		return
	}
	c.Email = strings.ToLower(strings.TrimSpace(c.Email))
	if !strings.Contains(c.Email, "@") || len(c.Password) < 8 {
		writeError(w, http.StatusBadRequest, "email required and password must be >= 8 chars")
		return
	}
	hash, err := HashPassword(c.Password)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "hash failed")
		return
	}
	u, err := h.store.CreateUser(r.Context(), c.Email, hash)
	if errors.Is(err, storage.ErrEmailTaken) {
		writeError(w, http.StatusConflict, "email already registered")
		return
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, "create failed")
		return
	}
	h.issue(w, r.Context(), u, http.StatusCreated)
}

func (h *Handler) Login(w http.ResponseWriter, r *http.Request) {
	var c credentials
	if err := decode(r, &c); err != nil {
		writeError(w, http.StatusBadRequest, "invalid body")
		return
	}
	u, err := h.store.GetUserByEmail(r.Context(), c.Email)
	if err != nil {
		writeError(w, http.StatusUnauthorized, "invalid credentials")
		return
	}
	if err := VerifyPassword(c.Password, u.PasswordHash); err != nil {
		writeError(w, http.StatusUnauthorized, "invalid credentials")
		return
	}
	h.issue(w, r.Context(), u, http.StatusOK)
}

type refreshReq struct {
	RefreshToken string `json:"refreshToken"`
}

// Refresh rotates the refresh token: the presented one is verified (signature +
// store record not revoked/expired), revoked, and a fresh pair is issued.
func (h *Handler) Refresh(w http.ResponseWriter, r *http.Request) {
	var req refreshReq
	if err := decode(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid body")
		return
	}
	claims, err := Verify(h.refreshSecret, req.RefreshToken, RefreshToken)
	if err != nil {
		writeError(w, http.StatusUnauthorized, "invalid refresh token")
		return
	}
	stored, err := h.store.GetRefreshToken(r.Context(), hashToken(req.RefreshToken))
	if err != nil || stored.Revoked || time.Now().After(stored.ExpiresAt) {
		writeError(w, http.StatusUnauthorized, "refresh token not accepted")
		return
	}
	_ = h.store.RevokeRefreshToken(r.Context(), hashToken(req.RefreshToken))
	u, err := h.store.GetUserByID(r.Context(), claims.Sub)
	if err != nil {
		writeError(w, http.StatusUnauthorized, "user gone")
		return
	}
	h.issue(w, r.Context(), u, http.StatusOK)
}

func (h *Handler) Logout(w http.ResponseWriter, r *http.Request) {
	var req refreshReq
	if err := decode(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid body")
		return
	}
	_ = h.store.RevokeRefreshToken(r.Context(), hashToken(req.RefreshToken))
	w.WriteHeader(http.StatusNoContent)
}

func (h *Handler) Me(w http.ResponseWriter, r *http.Request) {
	u, err := h.store.GetUserByID(r.Context(), UserID(r.Context()))
	if err != nil {
		writeError(w, http.StatusNotFound, "not found")
		return
	}
	writeJSON(w, http.StatusOK, u)
}

func (h *Handler) issue(w http.ResponseWriter, ctx context.Context, u storage.User, code int) {
	access, err := Sign(h.accessSecret, NewClaims(u.ID, u.Email, AccessToken, h.accessTTL))
	if err != nil {
		writeError(w, http.StatusInternalServerError, "sign failed")
		return
	}
	refresh, err := Sign(h.refreshSecret, NewClaims(u.ID, u.Email, RefreshToken, h.refreshTTL))
	if err != nil {
		writeError(w, http.StatusInternalServerError, "sign failed")
		return
	}
	if err := h.store.SaveRefreshToken(ctx, u.ID, hashToken(refresh), time.Now().Add(h.refreshTTL)); err != nil {
		writeError(w, http.StatusInternalServerError, "persist token failed")
		return
	}
	writeJSON(w, code, tokenPair{AccessToken: access, RefreshToken: refresh, User: u})
}

func hashToken(t string) string {
	sum := sha256.Sum256([]byte(t))
	return hex.EncodeToString(sum[:])
}

// ---- small JSON helpers ----
func decode(r *http.Request, v any) error {
	dec := json.NewDecoder(r.Body)
	dec.DisallowUnknownFields()
	return dec.Decode(v)
}

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}

func writeError(w http.ResponseWriter, code int, msg string) {
	writeJSON(w, code, map[string]string{"error": msg})
}
