package auth

import (
	"context"
	"net/http"
	"strings"
)

type ctxKey string

const (
	userIDKey ctxKey = "userID"
	emailKey  ctxKey = "email"
)

// TokenFromRequest pulls the access token from the Authorization header, or a
// `token` query param / websocket subprotocol fallback (docs module 03.4).
func TokenFromRequest(r *http.Request) string {
	if h := r.Header.Get("Authorization"); strings.HasPrefix(h, "Bearer ") {
		return strings.TrimSpace(h[len("Bearer "):])
	}
	if t := r.URL.Query().Get("token"); t != "" {
		return t
	}
	// Subprotocol form: "bearer, <token>"
	if p := r.Header.Get("Sec-WebSocket-Protocol"); p != "" {
		for _, part := range strings.Split(p, ",") {
			part = strings.TrimSpace(part)
			if part != "" && part != "bearer" {
				return part
			}
		}
	}
	return ""
}

// RequireAuth verifies the access token and injects the user id/email into ctx.
func (h *Handler) RequireAuth(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		claims, err := Verify(h.accessSecret, TokenFromRequest(r), AccessToken)
		if err != nil {
			writeError(w, http.StatusUnauthorized, "unauthorized")
			return
		}
		ctx := context.WithValue(r.Context(), userIDKey, claims.Sub)
		ctx = context.WithValue(ctx, emailKey, claims.Email)
		next.ServeHTTP(w, r.WithContext(ctx))
	})
}

// UserID returns the authenticated user id from a RequireAuth-wrapped request.
func UserID(ctx context.Context) string {
	v, _ := ctx.Value(userIDKey).(string)
	return v
}

func Email(ctx context.Context) string {
	v, _ := ctx.Value(emailKey).(string)
	return v
}
