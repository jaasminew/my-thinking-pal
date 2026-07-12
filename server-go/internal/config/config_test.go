package config

import "testing"

func TestLoadDefaultsToLoopback(t *testing.T) {
	t.Setenv("HOST", "")
	t.Setenv("PORT", "")
	cfg := Load()
	if cfg.Host != "127.0.0.1" || cfg.Port != "8080" {
		t.Fatalf("unexpected listen address %s:%s", cfg.Host, cfg.Port)
	}
}

func TestLoadAcceptsExplicitListenAddress(t *testing.T) {
	t.Setenv("HOST", "0.0.0.0")
	t.Setenv("PORT", "9000")
	cfg := Load()
	if cfg.Host != "0.0.0.0" || cfg.Port != "9000" {
		t.Fatalf("unexpected listen address %s:%s", cfg.Host, cfg.Port)
	}
}
