import { describe, it, expect, vi } from 'vitest'
import { createRevealScheduler } from './ai-reveal'
import type { BufferedFireEvent } from './ai-cursor-types'

// ---- helpers --------------------------------------------------------------

// A minimal fake timer that mimics setTimeout/clearTimeout with vi's fake clock.
// We use vi.useFakeTimers() and pass the global setTimeout/clearTimeout (which
// vitest has patched) so timers are deterministic.
function useFakeTimers() {
  vi.useFakeTimers()
  return {
    setTimeoutFn: setTimeout as typeof setTimeout,
    clearTimeoutFn: clearTimeout as typeof clearTimeout,
    advance: (ms: number) => vi.advanceTimersByTime(ms),
    runAll: () => vi.runAllTimers()
  }
}

const ev = (kind: string, payload?: string): BufferedFireEvent => {
  if (kind === 'text') return { kind: 'text', chunk: payload || 'x' }
  if (kind === 'diagnosis') return { kind: 'diagnosis', text: payload || 'd' }
  if (kind === 'anchor') return { kind: 'anchor', line: Number(payload || 0) }
  return { kind: 'text', chunk: payload || 'x' }
}

// ---- buffered events apply in push order after goLive --------------------

describe('buffered events apply in push order after goLive', () => {
  it('drains the queue in FIFO order, one per chunkMs', () => {
    const timers = useFakeTimers()
    const s = createRevealScheduler({ chunkMs: 100, maxDrainMs: 10_000, ...timers })
    const applied: string[] = []
    s.push(ev('text', 'a'))
    s.push(ev('text', 'b'))
    s.push(ev('text', 'c'))
    expect(applied).toEqual([]) // nothing before goLive

    s.goLive((e) => applied.push((e as { chunk: string }).chunk), () => {})
    // First event fires after one interval (100ms).
    expect(applied).toEqual([])
    timers.advance(100)
    expect(applied).toEqual(['a'])
    timers.advance(100)
    expect(applied).toEqual(['a', 'b'])
    timers.advance(100)
    expect(applied).toEqual(['a', 'b', 'c'])
    vi.useRealTimers()
  })
})

// ---- pacing honors chunkMs and compresses to maxDrainMs ------------------

describe('pacing', () => {
  it('honors chunkMs when backlog fits within maxDrainMs', () => {
    const timers = useFakeTimers()
    const s = createRevealScheduler({ chunkMs: 50, maxDrainMs: 10_000, ...timers })
    const applied: string[] = []
    s.push(ev('text', '1'))
    s.push(ev('text', '2'))
    s.goLive((e) => applied.push((e as { chunk: string }).chunk), () => {})
    timers.advance(50)
    expect(applied).toEqual(['1'])
    timers.advance(50)
    expect(applied).toEqual(['1', '2'])
    vi.useRealTimers()
  })

  it('compresses to maxDrainMs when backlog would exceed it', () => {
    const timers = useFakeTimers()
    // 20 events at chunkMs=100 = 2000ms, but maxDrainMs=400 → compressed to
    // 400/20 = 20ms per event.
    const s = createRevealScheduler({ chunkMs: 100, maxDrainMs: 400, ...timers })
    const applied: string[] = []
    for (let i = 0; i < 20; i++) s.push(ev('text', String(i)))
    s.goLive((e) => applied.push((e as { chunk: string }).chunk), () => {})
    // All 20 should land within 400ms (20ms intervals).
    timers.advance(400)
    expect(applied.length).toBe(20)
    // Verify order preserved.
    expect(applied).toEqual(Array.from({ length: 20 }, (_, i) => String(i)))
    vi.useRealTimers()
  })
})

// ---- live pass-through after drain ---------------------------------------

describe('live pass-through', () => {
  it('after drain completes, push applies synchronously', () => {
    const timers = useFakeTimers()
    const s = createRevealScheduler({ chunkMs: 50, maxDrainMs: 10_000, ...timers })
    const applied: string[] = []
    s.push(ev('text', 'buf'))
    s.goLive((e) => applied.push((e as { chunk: string }).chunk), () => {})
    timers.advance(50) // drain the one buffered event
    expect(applied).toEqual(['buf'])
    // Now live: push applies immediately.
    s.push(ev('text', 'live1'))
    expect(applied).toEqual(['buf', 'live1'])
    s.push(ev('text', 'live2'))
    expect(applied).toEqual(['buf', 'live1', 'live2'])
    vi.useRealTimers()
  })
})

// ---- done() exactly once in both orderings -------------------------------

describe('done() exactly once', () => {
  it('drain-then-finish: done fires after finish when queue already empty', () => {
    const timers = useFakeTimers()
    const s = createRevealScheduler({ chunkMs: 50, maxDrainMs: 10_000, ...timers })
    const applied: string[] = []
    let doneCount = 0
    s.push(ev('text', 'a'))
    s.goLive((e) => applied.push((e as { chunk: string }).chunk), () => { doneCount++ })
    timers.advance(50) // drain
    expect(applied).toEqual(['a'])
    expect(doneCount).toBe(0) // not finished yet
    s.finish()
    expect(doneCount).toBe(1)
    vi.useRealTimers()
  })

  it('finish-then-drain: done fires after drain when already finished', () => {
    const timers = useFakeTimers()
    const s = createRevealScheduler({ chunkMs: 50, maxDrainMs: 10_000, ...timers })
    const applied: string[] = []
    let doneCount = 0
    s.push(ev('text', 'a'))
    s.finish() // finish before goLive
    s.goLive((e) => applied.push((e as { chunk: string }).chunk), () => { doneCount++ })
    expect(doneCount).toBe(0) // queue not empty yet
    timers.advance(50) // drain
    expect(applied).toEqual(['a'])
    expect(doneCount).toBe(1)
    vi.useRealTimers()
  })

  it('empty buffer + already finished at goLive → done once immediately', () => {
    const timers = useFakeTimers()
    const s = createRevealScheduler({ chunkMs: 50, maxDrainMs: 10_000, ...timers })
    let doneCount = 0
    s.finish()
    s.goLive(() => {}, () => { doneCount++ })
    expect(doneCount).toBe(1)
    vi.useRealTimers()
  })

  it('done never fires more than once', () => {
    const timers = useFakeTimers()
    const s = createRevealScheduler({ chunkMs: 50, maxDrainMs: 10_000, ...timers })
    let doneCount = 0
    s.push(ev('text', 'a'))
    s.goLive(() => {}, () => { doneCount++ })
    timers.advance(50)
    s.finish()
    expect(doneCount).toBe(1)
    // Extra finish calls don't re-fire.
    s.finish()
    s.finish()
    expect(doneCount).toBe(1)
    vi.useRealTimers()
  })
})

// ---- cancel() mid-drain ---------------------------------------------------

describe('cancel()', () => {
  it('mid-drain stops all further apply/done', () => {
    const timers = useFakeTimers()
    const s = createRevealScheduler({ chunkMs: 50, maxDrainMs: 10_000, ...timers })
    const applied: string[] = []
    let doneCount = 0
    s.push(ev('text', 'a'))
    s.push(ev('text', 'b'))
    s.push(ev('text', 'c'))
    s.goLive((e) => applied.push((e as { chunk: string }).chunk), () => { doneCount++ })
    timers.advance(50) // 'a' applied
    expect(applied).toEqual(['a'])
    s.cancel()
    timers.advance(200) // would have applied b, c
    expect(applied).toEqual(['a']) // no more
    expect(doneCount).toBe(0) // done never fires
    vi.useRealTimers()
  })

  it('push/finish after cancel are no-ops (no throw)', () => {
    const timers = useFakeTimers()
    const s = createRevealScheduler({ chunkMs: 50, maxDrainMs: 10_000, ...timers })
    s.cancel()
    expect(() => {
      s.push(ev('text', 'x'))
      s.finish()
      s.goLive(() => {}, () => {})
    }).not.toThrow()
    vi.useRealTimers()
  })

  it('goLive called twice is a no-op (no throw)', () => {
    const timers = useFakeTimers()
    const s = createRevealScheduler({ chunkMs: 50, maxDrainMs: 10_000, ...timers })
    const applied: string[] = []
    s.goLive((e) => applied.push((e as { chunk: string }).chunk), () => {})
    expect(() => {
      s.goLive(() => {}, () => {})
    }).not.toThrow()
    // First goLive's apply is still active.
    s.push(ev('text', 'z'))
    expect(applied).toEqual(['z'])
    vi.useRealTimers()
  })

  it('isLive: false before goLive, true after, false after cancel', () => {
    const timers = useFakeTimers()
    const s = createRevealScheduler({ chunkMs: 50, maxDrainMs: 10_000, ...timers })
    expect(s.isLive()).toBe(false)
    s.goLive(() => {}, () => {})
    expect(s.isLive()).toBe(true)
    s.cancel()
    expect(s.isLive()).toBe(false)
    vi.useRealTimers()
  })
})

// ---- pushes during drain don't jump the queue ----------------------------

describe('pushes during drain', () => {
  it('events pushed mid-drain append to the queue (never jump ahead)', () => {
    const timers = useFakeTimers()
    const s = createRevealScheduler({ chunkMs: 50, maxDrainMs: 10_000, ...timers })
    const applied: string[] = []
    s.push(ev('text', 'a'))
    s.push(ev('text', 'b'))
    s.goLive((e) => applied.push((e as { chunk: string }).chunk), () => {})
    timers.advance(50) // 'a' applied
    // Push a new event mid-drain — it must come AFTER 'b', not before.
    s.push(ev('text', 'c'))
    timers.advance(50) // 'b' applied
    expect(applied).toEqual(['a', 'b'])
    timers.advance(50) // 'c' applied
    expect(applied).toEqual(['a', 'b', 'c'])
    vi.useRealTimers()
  })
})
