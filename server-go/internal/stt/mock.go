package stt

import (
	"context"
	"sync"
)

// MockUpstream emits a scripted set of transcripts and records forwarded audio.
// Used for tests and for STT_PROVIDER=mock local development without a real key.
type MockUpstream struct {
	Script   []Transcript
	mu       sync.Mutex
	sessions []*MockSession
}

func (m *MockUpstream) Name() string { return "mock" }

func (m *MockUpstream) Open(_ context.Context, _ Config) (Session, error) {
	s := &MockSession{transcripts: make(chan Transcript, len(m.Script)+1), errs: make(chan error, 1)}
	for _, t := range m.Script {
		s.transcripts <- t
	}
	m.mu.Lock()
	m.sessions = append(m.sessions, s)
	m.mu.Unlock()
	return s, nil
}

// LastSession returns the most recently opened session (test helper).
func (m *MockUpstream) LastSession() *MockSession {
	m.mu.Lock()
	defer m.mu.Unlock()
	if len(m.sessions) == 0 {
		return nil
	}
	return m.sessions[len(m.sessions)-1]
}

type MockSession struct {
	transcripts chan Transcript
	errs        chan error
	mu          sync.Mutex
	audio       [][]byte
	closed      bool
}

func (s *MockSession) SendAudio(_ context.Context, pcm []byte) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	cp := make([]byte, len(pcm))
	copy(cp, pcm)
	s.audio = append(s.audio, cp)
	return nil
}

func (s *MockSession) Transcripts() <-chan Transcript { return s.transcripts }
func (s *MockSession) Errors() <-chan error           { return s.errs }

func (s *MockSession) Close() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if !s.closed {
		s.closed = true
		close(s.transcripts)
		close(s.errs)
	}
	return nil
}

// AudioFrames returns copies of the PCM frames forwarded so far (test helper).
func (s *MockSession) AudioFrames() [][]byte {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([][]byte(nil), s.audio...)
}
