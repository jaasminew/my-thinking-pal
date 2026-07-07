// Package stt is the backend STT proxy (docs module 07): the ONLY place that
// holds third-party STT keys. The client-facing /stt protocol is fixed; the
// upstream vendor is pluggable behind the Upstream interface so switching
// soniox<->tencent never touches the frontend.
package stt

import "context"

// Config is the per-session upstream setup the client requests via {"type":"config"}.
type Config struct {
	Language    string // "auto" | BCP-47 hint
	SampleRate  int    // e.g. 16000
	NumChannels int    // e.g. 1
}

func (c Config) withDefaults() Config {
	if c.SampleRate == 0 {
		c.SampleRate = 16000
	}
	if c.NumChannels == 0 {
		c.NumChannels = 1
	}
	if c.Language == "" {
		c.Language = "auto"
	}
	return c
}

// Transcript is the vendor-neutral result the handler relays to the client.
type Transcript struct {
	Text     string
	Final    bool
	Language string
	Speaker  string
}

// Session is one live upstream connection for one client. Audio flows in via
// SendAudio; results flow out on Transcripts(); Errors() surfaces upstream
// failures. Both channels are closed when the session ends.
type Session interface {
	SendAudio(ctx context.Context, pcm []byte) error
	Transcripts() <-chan Transcript
	Errors() <-chan error
	Close() error
}

// Upstream is a pluggable STT vendor.
type Upstream interface {
	Name() string
	Open(ctx context.Context, cfg Config) (Session, error)
}
