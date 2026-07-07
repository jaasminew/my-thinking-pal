// Package sync is the "dumb relay" (docs module 05): the server broadcasts and
// persists opaque Yjs updates without ever parsing CRDT semantics.
package sync

// Binary frame = 1 type byte + opaque payload. Only the relay-relevant subset of
// the module-05 protocol is needed for a truly dumb server:
//
//	0x03 UPDATE       incremental update — broadcast to peers + append to DocStore
//	0x04 SNAPSHOT_PUT client-computed full-state snapshot — store + truncate log
//	0x05 AWARENESS    cursors/selection — broadcast only, never persisted
//
// SYNC_STEP1/2 (state-vector diffing) are intentionally omitted: they require
// CRDT understanding. Instead, on connect the server replays the snapshot + all
// stored updates; Yjs updates are idempotent/commutative so the client converges.
const (
	MsgUpdate      byte = 0x03
	MsgSnapshotPut byte = 0x04
	MsgAwareness   byte = 0x05
)

func frame(typ byte, payload []byte) []byte {
	out := make([]byte, 1+len(payload))
	out[0] = typ
	copy(out[1:], payload)
	return out
}
