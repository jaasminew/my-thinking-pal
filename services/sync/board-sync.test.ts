import { describe, it, expect, vi } from 'vitest'
import * as Y from 'yjs'
import {
  BoardSync,
  MSG_UPDATE,
  MSG_SNAPSHOT_PUT,
  MSG_AWARENESS,
  websocketTransport,
  type SyncTransport
} from './board-sync'

// In-memory relay that mimics the Go server: fan out UPDATE/AWARENESS to peers,
// persist UPDATE payloads, and replay them to a newly-connected transport.
class FakeRelay {
  private peers: FakeTransport[] = []
  stored: Uint8Array[] = []
  snapshots: Uint8Array[] = []

  connect(t: FakeTransport) {
    this.peers.push(t)
    t.triggerOpen()
    for (const u of this.stored) t.deliver(concat(MSG_UPDATE, u))
  }

  publish(from: FakeTransport, data: Uint8Array) {
    const type = data[0]
    const payload = data.subarray(1)
    if (type === MSG_UPDATE) {
      this.stored.push(payload)
      for (const p of this.peers) if (p !== from) p.deliver(data)
    } else if (type === MSG_SNAPSHOT_PUT) {
      this.snapshots.push(payload)
      this.stored = [] // truncate behind the snapshot
    } else if (type === MSG_AWARENESS) {
      for (const p of this.peers) if (p !== from) p.deliver(data)
    }
  }
}

class FakeTransport implements SyncTransport {
  private openCb: (() => void) | null = null
  private msgCb: ((d: Uint8Array) => void) | null = null
  sent: Uint8Array[] = []
  constructor(private relay: FakeRelay) {}
  send(data: Uint8Array) {
    this.sent.push(data)
    this.relay.publish(this, data)
  }
  onOpen(cb: () => void) { this.openCb = cb }
  onMessage(cb: (d: Uint8Array) => void) { this.msgCb = cb }
  close() {}
  triggerOpen() { this.openCb?.() }
  deliver(d: Uint8Array) { this.msgCb?.(d) }
}

function concat(type: number, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(payload.length + 1)
  out[0] = type
  out.set(payload, 1)
  return out
}

describe('BoardSync', () => {
  it('converges two docs through the relay', () => {
    const relay = new FakeRelay()
    const docA = new Y.Doc()
    const docB = new Y.Doc()
    const ta = new FakeTransport(relay)
    const tb = new FakeTransport(relay)
    new BoardSync(docA, ta)
    new BoardSync(docB, tb)
    relay.connect(ta)
    relay.connect(tb)

    docA.getMap('m').set('k', 'v')
    expect(docB.getMap('m').get('k')).toBe('v')

    docB.getArray('notes').push(['hello'])
    expect(docA.getArray('notes').toJSON()).toEqual(['hello'])
  })

  it('replays persisted state to a late joiner', () => {
    const relay = new FakeRelay()
    const docA = new Y.Doc()
    const ta = new FakeTransport(relay)
    new BoardSync(docA, ta)
    relay.connect(ta)
    docA.getMap('m').set('early', 1)

    // C joins after the edit — should catch up via replay.
    const docC = new Y.Doc()
    const tc = new FakeTransport(relay)
    new BoardSync(docC, tc)
    relay.connect(tc)
    expect(docC.getMap('m').get('early')).toBe(1)
  })

  it('does not echo remotely-applied updates', () => {
    const relay = new FakeRelay()
    const docA = new Y.Doc()
    const docB = new Y.Doc()
    const ta = new FakeTransport(relay)
    const tb = new FakeTransport(relay)
    new BoardSync(docA, ta)
    new BoardSync(docB, tb)
    relay.connect(ta)
    relay.connect(tb)

    const before = tb.sent.length
    docA.getMap('m').set('k', 'v') // B receives it but must not resend
    expect(tb.sent.length).toBe(before)
  })

  it('reconnects and re-fires onOpen after the socket drops', () => {
    vi.useFakeTimers()
    const instances: FakeWS[] = []
    class FakeWS {
      static readonly CONNECTING = 0
      static readonly OPEN = 1
      static readonly CLOSED = 3
      readyState = FakeWS.CONNECTING
      binaryType = ''
      onopen: (() => void) | null = null
      onclose: (() => void) | null = null
      onmessage: ((ev: unknown) => void) | null = null
      onerror: (() => void) | null = null
      constructor(readonly url: string) {
        instances.push(this)
      }
      open() {
        this.readyState = FakeWS.OPEN
        this.onopen?.()
      }
      drop() {
        this.readyState = FakeWS.CLOSED
        this.onclose?.()
      }
      send() {}
      close() {
        this.readyState = FakeWS.CLOSED
      }
    }
    const orig = globalThis.WebSocket
    ;(globalThis as unknown as { WebSocket: unknown }).WebSocket = FakeWS
    try {
      const t = websocketTransport('ws://x/sync/1')
      let opens = 0
      t.onOpen(() => opens++)
      expect(instances.length).toBe(1)
      instances[0].open()
      expect(opens).toBe(1)

      instances[0].drop() // network blip / server restart
      vi.advanceTimersByTime(1000) // backoff elapses → a fresh socket is created
      expect(instances.length).toBe(2)
      instances[1].open()
      expect(opens).toBe(2) // BoardSync re-sends full state on every reconnect

      t.close()
      instances[1].drop() // after close, no further reconnects
      vi.advanceTimersByTime(60000)
      expect(instances.length).toBe(2)
    } finally {
      ;(globalThis as unknown as { WebSocket: unknown }).WebSocket = orig
      vi.useRealTimers()
    }
  })

  it('uploads a compacting snapshot that truncates the log', () => {
    const relay = new FakeRelay()
    const docA = new Y.Doc()
    const ta = new FakeTransport(relay)
    const sync = new BoardSync(docA, ta)
    relay.connect(ta)
    docA.getMap('m').set('k', 'v')
    expect(relay.stored.length).toBeGreaterThan(0)

    sync.uploadSnapshot()
    expect(relay.snapshots.length).toBe(1)
    expect(relay.stored.length).toBe(0)

    // A brand-new joiner still converges from the snapshot alone.
    const docD = new Y.Doc()
    const td = new FakeTransport(relay)
    new BoardSync(docD, td)
    // Manually seed replay from the snapshot (relay stores snapshots separately).
    td.deliver(concat(MSG_UPDATE, relay.snapshots[0]))
    expect(docD.getMap('m').get('k')).toBe('v')
  })
})
