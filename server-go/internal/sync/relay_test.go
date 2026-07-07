package sync_test

import (
	"context"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"

	"mythinkingpal/server/internal/auth"
	"mythinkingpal/server/internal/documents"
	"mythinkingpal/server/internal/httpapi"
	"mythinkingpal/server/internal/storage/fsdoc"
	"mythinkingpal/server/internal/storage/memory"
	syncsvc "mythinkingpal/server/internal/sync"
)

const secret = "test-secret"

func newSyncServer(t *testing.T) (*httptest.Server, string) {
	t.Helper()
	account := memory.New()
	u, _ := account.CreateUser(context.Background(), "u@x.com", "hash")
	docStore := fsdoc.New(t.TempDir())
	authH := auth.NewHandler(account, []byte(secret), []byte(secret), time.Hour, time.Hour)
	syncH := syncsvc.NewHandler(docStore, account)
	handler := httpapi.New(httpapi.Deps{
		Auth:       authH,
		Documents:  documents.NewHandler(account),
		Sync:       syncH,
		CORSOrigin: "*",
	})
	srv := httptest.NewServer(handler)
	token, _ := auth.Sign([]byte(secret), auth.NewClaims(u.ID, u.Email, auth.AccessToken, time.Hour))
	return srv, token
}

func dial(t *testing.T, srv *httptest.Server, token, docID string) *websocket.Conn {
	t.Helper()
	url := strings.Replace(srv.URL, "http://", "ws://", 1) + "/sync/" + docID + "?token=" + token
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	c, _, err := websocket.Dial(ctx, url, nil)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	return c
}

func readFrame(t *testing.T, c *websocket.Conn) []byte {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	typ, data, err := c.Read(ctx)
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	if typ != websocket.MessageBinary {
		t.Fatalf("expected binary frame, got %v", typ)
	}
	return data
}

func writeFrame(t *testing.T, c *websocket.Conn, b []byte) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	if err := c.Write(ctx, websocket.MessageBinary, b); err != nil {
		t.Fatalf("write: %v", err)
	}
}

func TestRequiresToken(t *testing.T) {
	srv, _ := newSyncServer(t)
	defer srv.Close()
	url := strings.Replace(srv.URL, "http://", "ws://", 1) + "/sync/doc1"
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	if _, _, err := websocket.Dial(ctx, url, nil); err == nil {
		t.Fatal("dial without token should fail")
	}
}

func TestBroadcastReplayAndSnapshot(t *testing.T) {
	srv, token := newSyncServer(t)
	defer srv.Close()

	// A and B in the same room; A's UPDATE reaches B.
	a := dial(t, srv, token, "doc1")
	b := dial(t, srv, token, "doc1")
	defer a.CloseNow()

	update := []byte{syncsvc.MsgUpdate, 1, 2, 3}
	writeFrame(t, a, update)

	got := readFrame(t, b)
	if len(got) != 4 || got[0] != syncsvc.MsgUpdate || got[1] != 1 || got[3] != 3 {
		t.Fatalf("B should receive the broadcast update, got %v", got)
	}
	b.CloseNow()
	time.Sleep(200 * time.Millisecond) // let the append persist

	// C reconnects → gets the persisted update replayed.
	c := dial(t, srv, token, "doc1")
	replay := readFrame(t, c)
	if replay[0] != syncsvc.MsgUpdate || replay[1] != 1 || replay[3] != 3 {
		t.Fatalf("C replay should be the stored update, got %v", replay)
	}

	// C uploads a snapshot → the update log is truncated.
	writeFrame(t, c, append([]byte{syncsvc.MsgSnapshotPut}, 9, 9))
	c.CloseNow()
	time.Sleep(200 * time.Millisecond)

	// D reconnects → gets ONLY the snapshot (as an UPDATE), not the old update.
	d := dial(t, srv, token, "doc1")
	defer d.CloseNow()
	frame := readFrame(t, d)
	if frame[0] != syncsvc.MsgUpdate || len(frame) != 3 || frame[1] != 9 || frame[2] != 9 {
		t.Fatalf("D should receive only the snapshot payload, got %v", frame)
	}
}
