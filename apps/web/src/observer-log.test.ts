import { describe, it, expect, vi } from 'vitest'
import { makeObserverLog, OBSERVER_LOG_CAP } from './observer-log'
import type { ObserverLogRecord } from '../../../packages/core/llm/observer-types'

// ---- helpers --------------------------------------------------------------

function rec(ts: number, kind: ObserverLogRecord['kind'] = 'evaluation'): ObserverLogRecord {
  return { ts, kind }
}

function makeHarness(initial: ObserverLogRecord[] = [], cap?: number) {
  let saved: ObserverLogRecord[] | null = null
  const load = vi.fn(() => initial)
  const save = vi.fn((r: ObserverLogRecord[]) => {
    saved = r
  })
  const log = makeObserverLog(load, save, cap)
  return { log, load, save, getSaved: () => saved }
}

// ---- constant -------------------------------------------------------------

describe('OBSERVER_LOG_CAP', () => {
  it('exports the frozen default cap', () => {
    expect(OBSERVER_LOG_CAP).toBe(500)
  })
})

// ---- load at construction -------------------------------------------------

describe('load at construction', () => {
  it('calls load exactly once at construction', () => {
    const { load } = makeHarness()
    expect(load).toHaveBeenCalledTimes(1)
  })

  it('all() returns loaded records before any append', () => {
    const initial = [rec(1), rec(2), rec(3)]
    const { log } = makeHarness(initial)
    expect(log.all()).toEqual(initial)
  })

  it('starts empty when load returns []', () => {
    const { log } = makeHarness([])
    expect(log.all()).toEqual([])
  })
})

// ---- append persists ------------------------------------------------------

describe('append', () => {
  it('appends a record and calls save with the full array', () => {
    const { log, save, getSaved } = makeHarness()
    log.append(rec(10))
    expect(save).toHaveBeenCalledTimes(1)
    expect(getSaved()).toEqual([rec(10)])
  })

  it('appends after existing records', () => {
    const initial = [rec(1), rec(2)]
    const { log, getSaved } = makeHarness(initial)
    log.append(rec(3))
    expect(getSaved()).toEqual([rec(1), rec(2), rec(3)])
  })

  it('multiple appends each call save', () => {
    const { log, save, getSaved } = makeHarness()
    log.append(rec(1))
    log.append(rec(2))
    log.append(rec(3))
    expect(save).toHaveBeenCalledTimes(3)
    expect(getSaved()).toEqual([rec(1), rec(2), rec(3)])
  })

  it('all() reflects appended records', () => {
    const { log } = makeHarness()
    log.append(rec(1))
    log.append(rec(2))
    expect(log.all()).toEqual([rec(1), rec(2)])
  })
})

// ---- cap drops oldest -----------------------------------------------------

describe('cap', () => {
  it('drops the oldest record when cap is exceeded', () => {
    const { log, getSaved } = makeHarness([rec(1), rec(2)], 2)
    log.append(rec(3))
    // cap = 2, so rec(1) is dropped
    expect(getSaved()).toEqual([rec(2), rec(3)])
  })

  it('drops multiple oldest when several over cap', () => {
    const { log, getSaved } = makeHarness([rec(1), rec(2), rec(3), rec(4)], 3)
    log.append(rec(5))
    // cap = 3, we had 4, now 5 → drop 2 oldest
    expect(getSaved()).toEqual([rec(3), rec(4), rec(5)])
  })

  it('default cap is OBSERVER_LOG_CAP (500)', () => {
    const initial: ObserverLogRecord[] = []
    for (let i = 0; i < 500; i++) initial.push(rec(i))
    const { log, getSaved } = makeHarness(initial)
    log.append(rec(500))
    // Should have 500 records: dropped rec(0), kept rec(1)..rec(500)
    const saved = getSaved()!
    expect(saved).toHaveLength(500)
    expect(saved[0]).toEqual(rec(1))
    expect(saved[499]).toEqual(rec(500))
  })

  it('cap = 1 keeps only the latest', () => {
    const { log, getSaved } = makeHarness([rec(1), rec(2)], 1)
    log.append(rec(3))
    expect(getSaved()).toEqual([rec(3)])
  })
})

// ---- pre-existing loaded records count toward cap ------------------------

describe('pre-existing loaded records', () => {
  it('loaded records are retained', () => {
    const initial = [rec(10), rec(20), rec(30)]
    const { log } = makeHarness(initial, 5)
    log.append(rec(40))
    expect(log.all()).toEqual([rec(10), rec(20), rec(30), rec(40)])
  })

  it('loaded records over cap are NOT trimmed until next append', () => {
    // If load returns 600 records but cap is 500, we keep all 600 initially.
    // The trim happens on the next append.
    const initial: ObserverLogRecord[] = []
    for (let i = 0; i < 600; i++) initial.push(rec(i))
    const { log } = makeHarness(initial, 500)
    // Before append: all 600 are visible
    expect(log.all()).toHaveLength(600)
    // After append: trimmed to 500 (dropped 101 oldest)
    log.append(rec(600))
    expect(log.all()).toHaveLength(500)
    expect(log.all()[0]).toEqual(rec(101))
    expect(log.all()[499]).toEqual(rec(600))
  })

  it('loaded records at exactly cap are retained, next append drops oldest', () => {
    const initial = [rec(1), rec(2), rec(3)]
    const { log, getSaved } = makeHarness(initial, 3)
    log.append(rec(4))
    expect(getSaved()).toEqual([rec(2), rec(3), rec(4)])
  })
})

// ---- all() returns a copy -------------------------------------------------

describe('all() mutation safety', () => {
  it('mutating the returned array does not corrupt internal state', () => {
    const { log } = makeHarness([rec(1), rec(2)])
    const snapshot = log.all()
    snapshot.push(rec(999))
    snapshot.shift()
    // Internal state is unchanged
    expect(log.all()).toEqual([rec(1), rec(2)])
  })

  it('mutating a record inside the returned array does not corrupt internal', () => {
    const initial = [rec(1, 'emission')]
    const { log } = makeHarness(initial)
    const snapshot = log.all()
    snapshot[0].kind = 'error'
    // Internal record is unchanged
    expect(log.all()[0].kind).toBe('emission')
  })
})

// ---- save receives the full capped array ----------------------------------

describe('save contract', () => {
  it('save receives the same array that all() returns', () => {
    const { log, getSaved } = makeHarness([rec(1)], 3)
    log.append(rec(2))
    expect(getSaved()).toEqual(log.all())
  })

  it('save is not called at construction', () => {
    const { save } = makeHarness([rec(1), rec(2)])
    expect(save).not.toHaveBeenCalled()
  })
})
