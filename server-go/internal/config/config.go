// Package config reads 12-factor env vars with sane dev defaults (docs 06.5).
package config

import (
	"os"
	"strconv"
	"time"
)

type Config struct {
	Host               string
	Port               string
	AccountStore       string // memory | sqlite
	AccountDSN         string
	DocStore           string // fs
	DocPath            string
	ProjectMemoryPath  string
	AccessSecret       string
	RefreshSecret      string
	AccessTTL          time.Duration
	RefreshTTL         time.Duration
	STTProvider        string // soniox | tencent | mock
	SonioxAPIKey       string
	SonioxModel        string
	TencentAppID       string
	TencentSecretID    string
	TencentSecretKey   string
	TencentEngineModel string
	TavilyAPIKey       string
	DeepSeekAPIKey     string
	DeepSeekBaseURL    string
	DeepSeekListener   string
	DeepSeekThinker    string
	CORSOrigin         string // allowed web origin ("*" reflects any)
}

func Load() Config {
	return Config{
		Host:               env("HOST", "127.0.0.1"),
		Port:               env("PORT", "8080"),
		AccountStore:       env("ACCOUNT_STORE", "memory"),
		AccountDSN:         env("ACCOUNT_DSN", "file:data/accounts.db?_journal=WAL"),
		DocStore:           env("DOC_STORE", "fs"),
		DocPath:            env("DOC_PATH", "data/docs"),
		ProjectMemoryPath:  env("PROJECT_MEMORY_PATH", "data"),
		AccessSecret:       env("JWT_ACCESS_SECRET", "dev-access-secret-change-me"),
		RefreshSecret:      env("JWT_REFRESH_SECRET", "dev-refresh-secret-change-me"),
		AccessTTL:          dur("ACCESS_TTL", 15*time.Minute),
		RefreshTTL:         dur("REFRESH_TTL", 720*time.Hour),
		STTProvider:        env("STT_PROVIDER", "soniox"),
		SonioxAPIKey:       env("SONIOX_API_KEY", ""),
		SonioxModel:        env("SONIOX_MODEL", "stt-rt-v5"),
		TencentAppID:       envAny([]string{"TENCENT_APPID", "TENCENT_CLOUD_APP_ID"}, ""),
		TencentSecretID:    envAny([]string{"TENCENT_SECRET_ID", "TENCENT_CLOUD_SECRET_ID"}, ""),
		TencentSecretKey:   envAny([]string{"TENCENT_SECRET_KEY", "TENCENT_CLOUD_SECRET_KEY"}, ""),
		TencentEngineModel: env("TENCENT_ENGINE_MODEL", "16k_zh"),
		TavilyAPIKey:       env("TAVILY_API_KEY", ""),
		DeepSeekAPIKey:     env("DEEPSEEK_API_KEY", ""),
		DeepSeekBaseURL:    env("DEEPSEEK_BASE_URL", "https://api.deepseek.com"),
		DeepSeekListener:   env("DEEPSEEK_LISTENER_MODEL", "deepseek-v4-flash"),
		DeepSeekThinker:    env("DEEPSEEK_THINKER_MODEL", "deepseek-v4-pro"),
		CORSOrigin:         env("CORS_ORIGIN", "*"),
	}
}

func env(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}

func envAny(keys []string, def string) string {
	for _, key := range keys {
		if value := os.Getenv(key); value != "" {
			return value
		}
	}
	return def
}

func dur(k string, def time.Duration) time.Duration {
	if v := os.Getenv(k); v != "" {
		if d, err := time.ParseDuration(v); err == nil {
			return d
		}
		if secs, err := strconv.Atoi(v); err == nil {
			return time.Duration(secs) * time.Second
		}
	}
	return def
}
