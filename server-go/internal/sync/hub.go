package sync

import "sync"

// conn is a single websocket connection in a room. Writes go through a buffered
// channel drained by a dedicated writer goroutine, so one slow client never
// blocks broadcasts to others (slow clients are dropped when their queue fills).
type conn struct {
	docID string
	send  chan []byte
}

// Hub keeps the in-memory rooms (docId -> connections) for the broadcast hot
// path. Persistence is separate (cold path via DocStore).
type Hub struct {
	mu    sync.RWMutex
	rooms map[string]map[*conn]struct{}
}

func NewHub() *Hub {
	return &Hub{rooms: map[string]map[*conn]struct{}{}}
}

func (h *Hub) join(c *conn) {
	h.mu.Lock()
	defer h.mu.Unlock()
	room := h.rooms[c.docID]
	if room == nil {
		room = map[*conn]struct{}{}
		h.rooms[c.docID] = room
	}
	room[c] = struct{}{}
}

func (h *Hub) leave(c *conn) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if room := h.rooms[c.docID]; room != nil {
		delete(room, c)
		if len(room) == 0 {
			delete(h.rooms, c.docID)
		}
	}
}

// broadcast sends msg to every connection in the room except `from`.
func (h *Hub) broadcast(docID string, from *conn, msg []byte) {
	h.mu.RLock()
	defer h.mu.RUnlock()
	for c := range h.rooms[docID] {
		if c == from {
			continue
		}
		select {
		case c.send <- msg:
		default:
			// Queue full: drop this frame for the slow client. It will catch up
			// on reconnect via replay.
		}
	}
}

// roomSize is used by tests to assert join/leave bookkeeping.
func (h *Hub) roomSize(docID string) int {
	h.mu.RLock()
	defer h.mu.RUnlock()
	return len(h.rooms[docID])
}
