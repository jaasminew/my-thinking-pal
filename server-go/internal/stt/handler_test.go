package stt_test

import (
	"context"
	"encoding/json"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"

	"mythinkingpal/server/internal/auth"
	"mythinkingpal/server/internal/documents"
	"mythinkingpal/server/internal/httpapi"
	"mythinkingpal/server/internal/storage/memory"
	"mythinkingpal/server/internal/stt"
	syncsvc "mythinkingpal/server/internal/sync"
)

const secret = "test-secret"

func newSTTServer(t *testing.T, up stt.Upstream) (*httptest.Server, string) {
	t.Helper()
	account := memory.New()
	u, _ := account.CreateUser(context.Background(), "u@x.com", "hash")
	authH := auth.NewHandler(account, []byte(secret), []byte(secret), time.Hour, time.Hour)
	handler := httpapi.New(httpapi.Deps{
		Auth:       authH,
		Documents:  documents.NewHandler(account),
		Sync:       syncsvc.NewHandler(nil, account),
		STT:        stt.NewHandler(up),
		CORSOrigin: "*",
	})
	srv := httptest.NewServer(handler)
	token, _ := auth.Sign([]byte(secret), auth.NewClaims(u.ID, u.Email, auth.AccessToken, time.Hour))
	return srv, token
}

func dialSTT(t *testing.T, srv *httptest.Server, token string) *websocket.Conn {
	t.Helper()
	url := strings.Replace(srv.URL, "http://", "ws://", 1) + "/stt?token=" + token
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	c, _, err := websocket.Dial(ctx, url, nil)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	return c
}

func readMsg(t *testing.T, c *websocket.Conn) map[string]any {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	_, data, err := c.Read(ctx)
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	var m map[string]any
	if err := json.Unmarshal(data, &m); err != nil {
		t.Fatalf("bad json: %v (%s)", err, data)
	}
	return m
}

func TestSTTRequiresToken(t *testing.T) {
	srv, _ := newSTTServer(t, &stt.MockUpstream{})
	defer srv.Close()
	url := strings.Replace(srv.URL, "http://", "ws://", 1) + "/stt"
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	if _, _, err := websocket.Dial(ctx, url, nil); err == nil {
		t.Fatal("dial without token should fail")
	}
}

func TestSTTForwardsTranscriptsAndAudio(t *testing.T) {
	up := &stt.MockUpstream{Script: []stt.Transcript{
		{Text: "你好", Final: false, Language: "zh"},
		{Text: "你好世界", Final: true, Language: "zh", Speaker: "S1"},
	}}
	srv, token := newSTTServer(t, up)
	defer srv.Close()

	c := dialSTT(t, srv, token)
	defer c.CloseNow()

	writeCtx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	// Config, then an audio frame (which opens the upstream).
	_ = c.Write(writeCtx, websocket.MessageText, []byte(`{"type":"config","language":"auto","sampleRate":16000}`))
	_ = c.Write(writeCtx, websocket.MessageBinary, []byte{0x01, 0x02, 0x03, 0x04})

	interim := readMsg(t, c)
	if interim["type"] != "transcript" || interim["text"] != "你好" || interim["final"] != false {
		t.Fatalf("interim wrong: %+v", interim)
	}
	final := readMsg(t, c)
	if final["type"] != "transcript" || final["text"] != "你好世界" || final["final"] != true || final["speaker"] != "S1" {
		t.Fatalf("final wrong: %+v", final)
	}

	// The audio frame reached the upstream.
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		if s := up.LastSession(); s != nil && len(s.AudioFrames()) > 0 {
			if got := s.AudioFrames()[0]; len(got) == 4 && got[0] == 0x01 {
				return
			}
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatal("upstream never received the audio frame")
}

func TestSTTReportsUpstreamOpenError(t *testing.T) {
	// Soniox with no key fails to open → client gets an error frame.
	srv, token := newSTTServer(t, stt.NewSoniox("", ""))
	defer srv.Close()
	c := dialSTT(t, srv, token)
	defer c.CloseNow()

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	_ = c.Write(ctx, websocket.MessageBinary, []byte{0x01})

	msg := readMsg(t, c)
	if msg["type"] != "error" {
		t.Fatalf("expected error frame, got %+v", msg)
	}
}
