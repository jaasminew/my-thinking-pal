import { describe, it, expect } from 'vitest'
import { reduceAiCursor } from './ai-cursor'
import { initialAiCursorState, AI_CURSOR_IDLE_FADE_MS } from './ai-cursor-types'
import type { AiCursorState } from './ai-cursor-types'

// ---- helpers --------------------------------------------------------------

const P = (x: number, y: number) => ({ x, y })

// Convenience: start an activity and return the resulting state.
function startAt(state: AiCursorState, id: string, t: number, target = P(0, 0)) {
  return reduceAiCursor(state, { type: 'start', activityId: id, target, at: t })
}

// ---- rule 1: start --------------------------------------------------------

describe('rule: start', () => {
  it('first start becomes current, snaps target/label, sets visible', () => {
    const s = startAt(initialAiCursorState, 'f1', 100, P(10, 20))
    expect(s.currentId).toBe('f1')
    expect(s.target).toEqual(P(10, 20))
    expect(s.label).toBe('thinking')
    expect(s.visible).toBe(true)
    expect(s.lastActivityAt).toBe(100)
    expect(s.activities['f1']).toMatchObject({ activityId: 'f1', startedAt: 100 })
  })

  it('second start does not steal current (sticky)', () => {
    let s = startAt(initialAiCursorState, 'f1', 100, P(10, 20))
    s = startAt(s, 'f2', 200, P(30, 40))
    // Still pointing at f1.
    expect(s.currentId).toBe('f1')
    expect(s.target).toEqual(P(10, 20))
    // f2 is in the map but not current.
    expect(s.activities['f2']).toMatchObject({ activityId: 'f2', startedAt: 200 })
    expect(s.lastActivityAt).toBe(200)
  })

  it('re-appear after fade: start when visible=false sets target directly', () => {
    // Drive to a faded state.
    let s = startAt(initialAiCursorState, 'f1', 100, P(10, 20))
    s = reduceAiCursor(s, { type: 'end', activityId: 'f1', at: 200 })
    // Now lingering: currentId null, visible true, target kept.
    expect(s.currentId).toBeNull()
    expect(s.visible).toBe(true)
    // Tick past the idle window → faded.
    s = reduceAiCursor(s, { type: 'tick', at: 200 + AI_CURSOR_IDLE_FADE_MS })
    expect(s.visible).toBe(false)
    // A new start snaps to the new target (no travel from stale ghost).
    s = startAt(s, 'f2', 300, P(50, 60))
    expect(s.visible).toBe(true)
    expect(s.currentId).toBe('f2')
    expect(s.target).toEqual(P(50, 60))
  })
})

// ---- rule 2: label --------------------------------------------------------

describe('rule: label', () => {
  it('sets the current activity label and mirrors to top-level', () => {
    let s = startAt(initialAiCursorState, 'f1', 100)
    s = reduceAiCursor(s, { type: 'label', activityId: 'f1', label: 'writing', at: 150 })
    expect(s.label).toBe('writing')
    expect(s.activities['f1'].label).toBe('writing')
    expect(s.lastActivityAt).toBe(150)
  })

  it('sets a non-current activity label without mirroring', () => {
    let s = startAt(initialAiCursorState, 'f1', 100)
    s = startAt(s, 'f2', 200)
    s = reduceAiCursor(s, { type: 'label', activityId: 'f2', label: 'found sources', at: 250 })
    expect(s.label).toBe('thinking') // still mirrors f1
    expect(s.activities['f2'].label).toBe('found sources')
  })

  it('unknown id returns same reference', () => {
    const s = startAt(initialAiCursorState, 'f1', 100)
    const s2 = reduceAiCursor(s, { type: 'label', activityId: 'nope', label: 'writing', at: 150 })
    expect(s2).toBe(s)
  })
})

// ---- rule 3: move ---------------------------------------------------------

describe('rule: move', () => {
  it('sets the current activity target and mirrors to top-level', () => {
    let s = startAt(initialAiCursorState, 'f1', 100, P(10, 20))
    s = reduceAiCursor(s, { type: 'move', activityId: 'f1', target: P(70, 80), at: 150 })
    expect(s.target).toEqual(P(70, 80))
    expect(s.activities['f1'].target).toEqual(P(70, 80))
    expect(s.lastActivityAt).toBe(150)
  })

  it('unknown id returns same reference', () => {
    const s = startAt(initialAiCursorState, 'f1', 100)
    const s2 = reduceAiCursor(s, { type: 'move', activityId: 'nope', target: P(1, 1), at: 150 })
    expect(s2).toBe(s)
  })
})

// ---- rule 4: end ----------------------------------------------------------

describe('rule: end', () => {
  it('FIFO succession: ending current picks smallest startedAt', () => {
    let s = startAt(initialAiCursorState, 'f1', 100, P(10, 10))
    s = startAt(s, 'f2', 200, P(20, 20))
    s = startAt(s, 'f3', 150, P(30, 30)) // started before f2 but after f1
    // f1 is current. End it → survivor with smallest startedAt among f2(200), f3(150) → f3.
    s = reduceAiCursor(s, { type: 'end', activityId: 'f1', at: 300 })
    expect(s.currentId).toBe('f3')
    expect(s.target).toEqual(P(30, 30))
    expect(s.label).toBe('thinking')
    expect(s.lastActivityAt).toBe(300)
  })

  it('ending a non-current activity just drops it', () => {
    let s = startAt(initialAiCursorState, 'f1', 100, P(10, 10))
    s = startAt(s, 'f2', 200, P(20, 20))
    s = reduceAiCursor(s, { type: 'end', activityId: 'f2', at: 300 })
    expect(s.currentId).toBe('f1')
    expect(s.target).toEqual(P(10, 10))
    expect(s.activities['f2']).toBeUndefined()
  })

  it('no survivors: linger — keep target/label/visible, null current', () => {
    let s = startAt(initialAiCursorState, 'f1', 100, P(10, 10))
    s = reduceAiCursor(s, { type: 'label', activityId: 'f1', label: 'writing', at: 150 })
    s = reduceAiCursor(s, { type: 'end', activityId: 'f1', at: 200 })
    expect(s.currentId).toBeNull()
    expect(s.target).toEqual(P(10, 10)) // kept
    expect(s.label).toBe('writing') // kept
    expect(s.visible).toBe(true) // linger
    expect(s.lastActivityAt).toBe(200)
  })

  it('no-output end hides immediately when there is no survivor', () => {
    let s = startAt(initialAiCursorState, 'f1', 100, P(10, 10))
    s = reduceAiCursor(s, { type: 'end', activityId: 'f1', linger: false, at: 200 })
    expect(s.currentId).toBeNull()
    expect(s.visible).toBe(false)
  })

  it('no-output end still promotes the next FIFO activity', () => {
    let s = startAt(initialAiCursorState, 'f1', 100, P(10, 10))
    s = startAt(s, 'f2', 200, P(20, 20))
    s = reduceAiCursor(s, { type: 'end', activityId: 'f1', linger: false, at: 300 })
    expect(s.currentId).toBe('f2')
    expect(s.target).toEqual(P(20, 20))
    expect(s.visible).toBe(true)
  })

  it('a queued no-output activity is removed without disturbing current', () => {
    let s = startAt(initialAiCursorState, 'f1', 100, P(10, 10))
    s = startAt(s, 'f2', 200, P(20, 20))
    s = reduceAiCursor(s, { type: 'end', activityId: 'f2', linger: false, at: 300 })
    expect(s.currentId).toBe('f1')
    expect(s.target).toEqual(P(10, 10))
    expect(s.activities.f2).toBeUndefined()
  })

  it('unknown id returns same reference', () => {
    const s = startAt(initialAiCursorState, 'f1', 100)
    const s2 = reduceAiCursor(s, { type: 'end', activityId: 'nope', at: 200 })
    expect(s2).toBe(s)
  })
})

// ---- rule 5: tick ---------------------------------------------------------

describe('rule: tick', () => {
  it('no-op tick returns same reference', () => {
    const s = startAt(initialAiCursorState, 'f1', 100)
    const s2 = reduceAiCursor(s, { type: 'tick', at: 200 })
    expect(s2).toBe(s)
  })

  it('never hides while an activity is live', () => {
    let s = startAt(initialAiCursorState, 'f1', 100)
    s = reduceAiCursor(s, { type: 'tick', at: 100 + AI_CURSOR_IDLE_FADE_MS + 1000 })
    expect(s.visible).toBe(true)
    expect(s.currentId).toBe('f1')
  })

  it('linger: tick just under idle window stays visible', () => {
    let s = startAt(initialAiCursorState, 'f1', 100)
    s = reduceAiCursor(s, { type: 'end', activityId: 'f1', at: 200 })
    // lastActivityAt is now 200. Tick at 200 + 119999 → still under 120000.
    s = reduceAiCursor(s, { type: 'tick', at: 200 + AI_CURSOR_IDLE_FADE_MS - 1 })
    expect(s.visible).toBe(true)
  })

  it('fade: tick at or past idle window hides', () => {
    let s = startAt(initialAiCursorState, 'f1', 100)
    s = reduceAiCursor(s, { type: 'end', activityId: 'f1', at: 200 })
    s = reduceAiCursor(s, { type: 'tick', at: 200 + AI_CURSOR_IDLE_FADE_MS })
    expect(s.visible).toBe(false)
  })

  it('tick when already hidden and no activity returns same reference', () => {
    let s = startAt(initialAiCursorState, 'f1', 100)
    s = reduceAiCursor(s, { type: 'end', activityId: 'f1', at: 200 })
    s = reduceAiCursor(s, { type: 'tick', at: 200 + AI_CURSOR_IDLE_FADE_MS })
    expect(s.visible).toBe(false)
    const s2 = reduceAiCursor(s, { type: 'tick', at: 200 + AI_CURSOR_IDLE_FADE_MS + 5000 })
    expect(s2).toBe(s)
  })
})
