package main

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"syscall"
	"time"

	"mythinkingpal/server/internal/auth"
	"mythinkingpal/server/internal/config"
	"mythinkingpal/server/internal/documents"
	"mythinkingpal/server/internal/httpapi"
	"mythinkingpal/server/internal/projectmemory"
	"mythinkingpal/server/internal/search"
	"mythinkingpal/server/internal/llm"
	"mythinkingpal/server/internal/storage"
	"mythinkingpal/server/internal/storage/fsdoc"
	"mythinkingpal/server/internal/storage/memory"
	"mythinkingpal/server/internal/storage/sqlite"
	"mythinkingpal/server/internal/stt"
	syncsvc "mythinkingpal/server/internal/sync"
	"mythinkingpal/server/internal/workspace"
)

func main() {
	cfg := config.Load()
	slog.SetDefault(slog.New(slog.NewJSONHandler(os.Stdout, nil)))

	var account storage.AccountStore
	switch cfg.AccountStore {
	case "memory":
		account = memory.New()
	case "sqlite":
		s, err := sqlite.Open(cfg.AccountDSN)
		if err != nil {
			slog.Error("open sqlite account store", "err", err)
			os.Exit(1)
		}
		account = s
	default:
		slog.Warn("unknown account store, using memory", "requested", cfg.AccountStore)
		account = memory.New()
	}
	defer account.Close()

	docStore := fsdoc.New(cfg.DocPath)

	authH := auth.NewHandler(account, []byte(cfg.AccessSecret), []byte(cfg.RefreshSecret), cfg.AccessTTL, cfg.RefreshTTL)
	docsH := documents.NewHandler(account)
	wsH := workspace.NewHandler(account)
	pmH := projectmemory.NewHandler(account, cfg.ProjectMemoryPath)
	origins := websocketOrigins(cfg.CORSOrigin)
	syncH := syncsvc.NewHandler(docStore, account, origins...)
	sttH := stt.NewHandler(buildUpstream(cfg), origins...)
	searchH := search.NewHandler(search.NewTavily(cfg.TavilyAPIKey), search.NewURLMetaClient())
	llmH := llm.NewHandler(llm.Config{
		APIKey:        cfg.DeepSeekAPIKey,
		BaseURL:       cfg.DeepSeekBaseURL,
		ListenerModel: cfg.DeepSeekListener,
		ThinkerModel:  cfg.DeepSeekThinker,
	})

	handler := httpapi.New(httpapi.Deps{
		Auth:          authH,
		Documents:     docsH,
		Workspace:     wsH,
		ProjectMemory: pmH,
		Sync:          syncH,
		STT:           sttH,
		Search:        searchH,
		LLM:           llmH,
		CORSOrigin:    cfg.CORSOrigin,
	})

	srv := &http.Server{
		Addr:              cfg.Host + ":" + cfg.Port,
		Handler:           handler,
		ReadHeaderTimeout: 10 * time.Second,
	}

	go func() {
		slog.Info("server listening", "host", cfg.Host, "port", cfg.Port)
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			slog.Error("server error", "err", err)
			os.Exit(1)
		}
	}()

	stop := make(chan os.Signal, 1)
	signal.Notify(stop, os.Interrupt, syscall.SIGTERM)
	<-stop
	slog.Info("shutting down")
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_ = srv.Shutdown(ctx)
}

func websocketOrigins(corsOrigin string) []string {
	if corsOrigin == "*" {
		return []string{"*"}
	}
	parsed, err := url.Parse(corsOrigin)
	if err != nil || parsed.Host == "" {
		slog.Warn("invalid CORS origin; WebSocket requests will require same-origin", "origin", corsOrigin)
		return nil
	}
	return []string{parsed.Host}
}

// buildUpstream selects the pluggable STT vendor (module 07.2). The client-facing
// /stt protocol is identical regardless of choice.
func buildUpstream(cfg config.Config) stt.Upstream {
	switch cfg.STTProvider {
	case "tencent":
		return stt.NewTencent(cfg.TencentAppID, cfg.TencentSecretID, cfg.TencentSecretKey, cfg.TencentEngineModel)
	case "mock":
		return &stt.MockUpstream{}
	default:
		return stt.NewSoniox(cfg.SonioxAPIKey, cfg.SonioxModel)
	}
}
