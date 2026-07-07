// Package httpapi assembles the route table (Go 1.22+ ServeMux patterns) and the
// shared middleware (CORS + request logging). Kept dependency-free.
package httpapi

import (
	"bufio"
	"errors"
	"log/slog"
	"net"
	"net/http"
	"time"

	"mythinkingpal/server/internal/auth"
	"mythinkingpal/server/internal/documents"
	"mythinkingpal/server/internal/stt"
	syncsvc "mythinkingpal/server/internal/sync"
)

type Deps struct {
	Auth       *auth.Handler
	Documents  *documents.Handler
	Sync       *syncsvc.Handler
	STT        *stt.Handler
	CORSOrigin string
}

func New(d Deps) http.Handler {
	mux := http.NewServeMux()

	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("ok"))
	})

	// Auth (public)
	mux.HandleFunc("POST /auth/register", d.Auth.Register)
	mux.HandleFunc("POST /auth/login", d.Auth.Login)
	mux.HandleFunc("POST /auth/refresh", d.Auth.Refresh)
	mux.HandleFunc("POST /auth/logout", d.Auth.Logout)

	// Authenticated
	mux.Handle("GET /me", d.Auth.RequireAuth(http.HandlerFunc(d.Auth.Me)))
	mux.Handle("GET /documents", d.Auth.RequireAuth(http.HandlerFunc(d.Documents.List)))
	mux.Handle("POST /documents", d.Auth.RequireAuth(http.HandlerFunc(d.Documents.Create)))
	mux.Handle("PATCH /documents/{id}", d.Auth.RequireAuth(http.HandlerFunc(d.Documents.Patch)))
	mux.Handle("DELETE /documents/{id}", d.Auth.RequireAuth(http.HandlerFunc(d.Documents.Delete)))

	// Sync relay (WebSocket) — token via subprotocol/query (module 03.4).
	if d.Sync != nil {
		mux.Handle("GET /sync/{docId}", d.Auth.RequireAuth(http.HandlerFunc(d.Sync.ServeHTTP)))
	}
	// STT proxy (WebSocket) — backend holds the vendor key (module 07).
	if d.STT != nil {
		mux.Handle("GET /stt", d.Auth.RequireAuth(http.HandlerFunc(d.STT.ServeHTTP)))
	}

	return logging(cors(d.CORSOrigin, mux))
}

// cors reflects the configured origin (or any when "*") and short-circuits
// preflight. Credentials aren't used (tokens travel in the Authorization header).
func cors(origin string, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		allow := origin
		if origin == "*" {
			if o := r.Header.Get("Origin"); o != "" {
				allow = o
			}
		}
		h := w.Header()
		h.Set("Access-Control-Allow-Origin", allow)
		h.Set("Vary", "Origin")
		h.Set("Access-Control-Allow-Methods", "GET,POST,PATCH,DELETE,OPTIONS")
		h.Set("Access-Control-Allow-Headers", "Authorization,Content-Type")
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func logging(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		sr := &statusRecorder{ResponseWriter: w, status: 200}
		next.ServeHTTP(sr, r)
		slog.Info("http", "method", r.Method, "path", r.URL.Path, "status", sr.status, "dur", time.Since(start).String())
	})
}

type statusRecorder struct {
	http.ResponseWriter
	status int
}

func (s *statusRecorder) WriteHeader(code int) {
	s.status = code
	s.ResponseWriter.WriteHeader(code)
}

// Unwrap lets http.ResponseController reach the underlying writer, and Hijack
// forwards the WebSocket upgrade — without these the wrapper would hide the
// http.Hijacker and /sync upgrades would 501.
func (s *statusRecorder) Unwrap() http.ResponseWriter { return s.ResponseWriter }

func (s *statusRecorder) Hijack() (net.Conn, *bufio.ReadWriter, error) {
	if h, ok := s.ResponseWriter.(http.Hijacker); ok {
		return h.Hijack()
	}
	return nil, nil, errors.New("underlying ResponseWriter is not a http.Hijacker")
}
