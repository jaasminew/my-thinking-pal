import * as Y from 'yjs'

// Frontend half of the module-05 "dumb relay" protocol. Mirrors the Go server's
// frame tags. The server never parses CRDT; this provider does all the Yjs work
// and exchanges opaque update bytes.
export const MSG_UPDATE = 0x03
export const MSG_SNAPSHOT_PUT = 0x04
export const MSG_AWARENESS = 0x05

function frame(type: number, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(payload.length + 1)
  out[0] = type
  out.set(payload, 1)
  return out
}

// Transport seam: abstracts the WebSocket so BoardSync is testable with an
// in-memory relay (no server / no browser WebSocket needed).
export interface SyncTransport {
  send(data: Uint8Array): void
  onOpen(cb: () => void): void
  onMessage(cb: (data: Uint8Array) => void): void
  close(): void
}

export interface BoardSyncOptions {
  // If set, upload a compacting snapshot this many ms after the last local edit
  // (server stores it + truncates the update log). 0 disables auto-snapshot.
  snapshotDebounceMs?: number
}

// Connects a Y.Doc to a relay. Sync strategy is update-based (no state-vector
// diffing), which is what lets the server stay dumb: on open we send our full
// state as one update; the relay stores + fans it out; peers' updates arrive as
// updates and are applied. Yjs updates are idempotent/commutative, so everyone
// converges regardless of ordering or replays.
export class BoardSync {
  private readonly doc: Y.Doc
  private readonly transport: SyncTransport
  private readonly snapshotDebounceMs: number
  private snapshotTimer: ReturnType<typeof setTimeout> | null = null
  private destroyed = false

  constructor(doc: Y.Doc, transport: SyncTransport, opts: BoardSyncOptions = {}) {
    this.doc = doc
    this.transport = transport
    this.snapshotDebounceMs = opts.snapshotDebounceMs ?? 0

    doc.on('update', this.onLocalUpdate)
    transport.onMessage(this.onRemoteMessage)
    transport.onOpen(this.onOpen)
  }

  private onOpen = () => {
    // Share everything we have so the relay persists it and peers converge.
    this.transport.send(frame(MSG_UPDATE, Y.encodeStateAsUpdate(this.doc)))
  }

  private onLocalUpdate = (update: Uint8Array, origin: unknown) => {
    if (origin === this) return // came from a remote apply — don't echo it back
    this.transport.send(frame(MSG_UPDATE, update))
    this.scheduleSnapshot()
  }

  private onRemoteMessage = (data: Uint8Array) => {
    if (data.length === 0) return
    const payload = data.subarray(1)
    switch (data[0]) {
      case MSG_UPDATE:
        // origin=this so onLocalUpdate ignores the resulting event (no loop).
        Y.applyUpdate(this.doc, payload, this)
        break
      // SNAPSHOT_PUT / AWARENESS are not expected inbound in this minimal client
      // (the server replays snapshots as UPDATE frames).
    }
  }

  private scheduleSnapshot() {
    if (!this.snapshotDebounceMs || this.destroyed) return
    if (this.snapshotTimer) clearTimeout(this.snapshotTimer)
    this.snapshotTimer = setTimeout(() => this.uploadSnapshot(), this.snapshotDebounceMs)
  }

  // Send a compacting snapshot (full state) the server stores + truncates behind.
  uploadSnapshot() {
    this.transport.send(frame(MSG_SNAPSHOT_PUT, Y.encodeStateAsUpdate(this.doc)))
  }

  destroy() {
    this.destroyed = true
    if (this.snapshotTimer) clearTimeout(this.snapshotTimer)
    this.doc.off('update', this.onLocalUpdate)
    this.transport.close()
  }
}

// Real browser transport: a WebSocket to /sync/{docId}?token=… (module 03.4).
// Untested here (needs a live socket); the protocol logic lives in BoardSync and
// is covered via an in-memory transport.
export function websocketTransport(url: string): SyncTransport {
  const ws = new WebSocket(url)
  ws.binaryType = 'arraybuffer'
  const openCbs: (() => void)[] = []
  const msgCbs: ((d: Uint8Array) => void)[] = []
  ws.onopen = () => openCbs.forEach((cb) => cb())
  ws.onmessage = (ev) => {
    const buf = ev.data instanceof ArrayBuffer ? new Uint8Array(ev.data) : null
    if (buf) msgCbs.forEach((cb) => cb(buf))
  }
  return {
    send: (data) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(data)
    },
    onOpen: (cb) => {
      openCbs.push(cb)
      if (ws.readyState === WebSocket.OPEN) cb()
    },
    onMessage: (cb) => msgCbs.push(cb),
    close: () => ws.close()
  }
}
