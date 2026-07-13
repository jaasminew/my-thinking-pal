import { describe, it, expect, vi } from 'vitest'
import {
  ObserverEngine,
  DEFAULT_COOLDOWN_MS,
  DEFAULT_MAX_RECENT_TOPICS
} from './observer-engine'
import type {
  ObserverEngineDeps,
  ObserverCanvasContext,
  ObserverDecision,
  ObserverContributionResult,
  ObserverLogRecord,
  ObserverEmission,
  ObserverSignal,
  ObserverState
} from '../../../packages/core/llm/observer-types'

// ---- helpers --------------------------------------------------------------

const flush = () => new Promise<void>((r) => setTimeout(r, 0))

function makeCtx(overrides: Partial<ObserverCanvasContext> = {}): ObserverCanvasContext {
  return {
    noteTitles: [],
    settledContent: '',
    kept: [],
    rejected: [],
    existingUrls: [],
    ...overrides
  }
}

function makeDeps(opts: Partial<{
  evaluate: ObserverEngineDeps['evaluate']
  contribute: ObserverEngineDeps['contribute']
  getContext: ObserverEngineDeps['getContext']
  isCocreateStreaming: ObserverEngineDeps['isCocreateStreaming']
  now: ObserverEngineDeps['now']
}> = {}): ObserverEngineDeps {
  return {
    evaluate: opts.evaluate ?? (async () => null),
    contribute: opts.contribute ?? (async () => null),
    getContext: opts.getContext ?? (() => makeCtx()),
    isCocreateStreaming: opts.isCocreateStreaming ?? (() => false),
    ...(opts.now ? { now: opts.now } : {})
  }
}

function makeDecision(overrides: Partial<ObserverDecision> = {}): ObserverDecision {
  return { emit: true, confidence: 0.8, opportunityType: 'risk', topic: 'test topic', ...overrides }
}

function makeResult(overrides: Partial<ObserverContributionResult> = {}): ObserverContributionResult {
  return {
    keyword: 'New Topic',
    bullets: ['bullet one', 'bullet two'],
    sources: [],
    searchPath: 'none',
    ...overrides
  }
}

function makeEngine(
  deps: ObserverEngineDeps,
  stateOverrides: Partial<ObserverState> = {},
  configOverrides: { cooldownMs?: number; maxRecentTopics?: number } = {}
) {
  const engine = new ObserverEngine(
    deps,
    { cooldownMs: configOverrides.cooldownMs ?? 1000, maxRecentTopics: configOverrides.maxRecentTopics ?? 8 },
    {
      lastEvaluatedSignalTs: 0,
      recentTopics: [],
      consecutiveRejected: 0,
      postSessionIgnored: 0,
      ...stateOverrides
    }
  )
  engine.start()
  engine.setEnabled(true)
  return engine
}

function wire(
  engine: ObserverEngine
): { logs: ObserverLogRecord[]; emissions: ObserverEmission[] } {
  const logs: ObserverLogRecord[] = []
  const emissions: ObserverEmission[] = []
  engine.onLog = (r) => logs.push(r)
  engine.onEmit = (e) => emissions.push(e)
  return { logs, emissions }
}

const sig = (text: string, ts: number): ObserverSignal => ({ text, ts })

// ---- constants ------------------------------------------------------------

describe('exported constants', () => {
  it('exports the frozen defaults', () => {
    expect(DEFAULT_COOLDOWN_MS).toBe(75_000)
    expect(DEFAULT_MAX_RECENT_TOPICS).toBe(8)
  })
})

// ---- gate order -----------------------------------------------------------

describe('gate order — each gate fires in order', () => {
  it('gate 1: not-running fires when start() not called', () => {
    const deps = makeDeps({ now: () => 100000 })
    const engine = new ObserverEngine(deps, { cooldownMs: 1000, maxRecentTopics: 8 })
    // Don't start.
    const { logs } = wire(engine)
    engine.pushSignals([sig('a', 1)])
    expect(logs.at(-1)).toMatchObject({ kind: 'skip', gate: 'not-running' })
  })

  it('gate 2: disabled fires when not enabled', () => {
    const deps = makeDeps({ now: () => 100000 })
    const engine = new ObserverEngine(deps, { cooldownMs: 1000, maxRecentTopics: 8 })
    engine.start()
    // Don't enable.
    const { logs } = wire(engine)
    engine.pushSignals([sig('a', 1)])
    expect(logs.at(-1)).toMatchObject({ kind: 'skip', gate: 'disabled' })
  })

  it('gate 3: empty-batch fires on zero signals', () => {
    const deps = makeDeps({ now: () => 100000 })
    const engine = makeEngine(deps)
    const { logs } = wire(engine)
    engine.pushSignals([])
    expect(logs.at(-1)).toMatchObject({ kind: 'skip', gate: 'empty-batch' })
  })

  it('gate 4: already-evaluated fires when newest ts <= lastEvaluatedSignalTs', async () => {
    const deps = makeDeps({
      evaluate: async () => makeDecision({ emit: false, confidence: 0 }),
      now: () => 100000
    })
    const engine = makeEngine(deps)
    const { logs } = wire(engine)

    engine.pushSignals([sig('a', 10)])
    await flush()

    // Second push with same ts → already-evaluated.
    engine.pushSignals([sig('b', 10)])
    expect(logs.at(-1)).toMatchObject({ kind: 'skip', gate: 'already-evaluated' })
  })

  it('gate 5: evaluating fires when a cycle is in flight', async () => {
    let resolveEval!: (v: ObserverDecision | null) => void
    const evalPromise = new Promise<ObserverDecision | null>((r) => { resolveEval = r })
    const deps = makeDeps({
      evaluate: () => evalPromise,
      now: () => 100000
    })
    const engine = makeEngine(deps)
    const { logs } = wire(engine)

    engine.pushSignals([sig('a', 10)])
    // While eval is pending, push a newer batch.
    engine.pushSignals([sig('b', 20)])
    expect(logs.at(-1)).toMatchObject({ kind: 'skip', gate: 'evaluating' })

    resolveEval(null)
    await flush()
  })

  it('gate 6: cooldown fires when within cooldown window', () => {
    const deps = makeDeps({ now: () => 100000 })
    const engine = makeEngine(deps, { lastEmittedAt: 99500 }) // 500ms ago, cooldown 1000
    const { logs } = wire(engine)
    engine.pushSignals([sig('a', 10)])
    expect(logs.at(-1)).toMatchObject({ kind: 'skip', gate: 'cooldown' })
  })

  it('gate 7: cocreate-in-flight fires when isCocreateStreaming is true', () => {
    const deps = makeDeps({
      isCocreateStreaming: () => true,
      now: () => 100000
    })
    const engine = makeEngine(deps)
    const { logs } = wire(engine)
    engine.pushSignals([sig('a', 10)])
    expect(logs.at(-1)).toMatchObject({ kind: 'skip', gate: 'cocreate-in-flight' })
  })

  it('earlier gate wins over later gate', () => {
    // not-running + disabled + empty-batch → not-running fires first.
    const deps = makeDeps({ now: () => 100000 })
    const engine = new ObserverEngine(deps, { cooldownMs: 1000, maxRecentTopics: 8 })
    // Not started, not enabled, empty batch.
    const { logs } = wire(engine)
    engine.pushSignals([])
    expect(logs.at(-1)).toMatchObject({ kind: 'skip', gate: 'not-running' })
  })
})

// ---- happy path -----------------------------------------------------------

describe('happy path: evaluate → contribute → emit', () => {
  it('fires onEmit and logs evaluation + emission', async () => {
    const decision = makeDecision({ topic: 'sync conflicts' })
    const result = makeResult({ keyword: 'Sync Conflicts', searchPath: 'relay', model: 'test-model' })
    const deps = makeDeps({
      evaluate: async () => decision,
      contribute: async () => result,
      getContext: () => makeCtx(),
      now: () => 100000
    })
    const engine = makeEngine(deps)
    const { logs, emissions } = wire(engine)

    engine.pushSignals([sig('sig one', 10), sig('sig two', 20)])
    await flush()

    // Evaluation logged.
    const evalLog = logs.find((l) => l.kind === 'evaluation')
    expect(evalLog).toBeDefined()
    expect(evalLog!.decision).toEqual(decision)
    expect(evalLog!.signalTsRange).toEqual([10, 20])
    expect(evalLog!.latencyMs).toBeGreaterThanOrEqual(0)

    // Emission logged.
    const emitLog = logs.find((l) => l.kind === 'emission')
    expect(emitLog).toBeDefined()
    expect(emitLog!.searchPath).toBe('relay')
    expect(emitLog!.model).toBe('test-model')

    // onEmit fired with decision + result + signal range.
    expect(emissions.length).toBe(1)
    expect(emissions[0].decision).toEqual(decision)
    expect(emissions[0].result.keyword).toBe('Sync Conflicts')
    expect(emissions[0].signalTsRange).toEqual([10, 20])

    // State updated.
    const state = engine.getState()
    expect(state.lastEmittedAt).toBe(100000)
    expect(state.recentTopics).toEqual(['sync conflicts'])
    expect(state.lastEvaluatedSignalTs).toBe(20)
  })
})

// ---- emit: false ----------------------------------------------------------

describe('emit false — no contribute call', () => {
  it('logs evaluation but does not call contribute or emit', async () => {
    const contribute = vi.fn(async () => makeResult())
    const deps = makeDeps({
      evaluate: async () => makeDecision({ emit: false, confidence: 0.3 }),
      contribute,
      now: () => 100000
    })
    const engine = makeEngine(deps)
    const { logs, emissions } = wire(engine)

    engine.pushSignals([sig('a', 10)])
    await flush()

    expect(contribute).not.toHaveBeenCalled()
    expect(emissions.length).toBe(0)
    const evalLog = logs.find((l) => l.kind === 'evaluation')
    expect(evalLog).toBeDefined()
    expect(evalLog!.decision!.emit).toBe(false)
  })
})

// ---- duplicate-title ------------------------------------------------------

describe('duplicate-title gate', () => {
  it('skips when normalized keyword matches a noteTitle', async () => {
    const deps = makeDeps({
      evaluate: async () => makeDecision({ topic: 'x' }),
      contribute: async () => makeResult({ keyword: 'Existing  Topic' }), // normalizes to 'existing topic'
      getContext: () => makeCtx({ noteTitles: ['existing topic'] }),
      now: () => 100000
    })
    const engine = makeEngine(deps)
    const { logs, emissions } = wire(engine)

    engine.pushSignals([sig('a', 10)])
    await flush()

    expect(emissions.length).toBe(0)
    expect(logs.at(-1)).toMatchObject({ kind: 'skip', gate: 'duplicate-title' })
  })

  it('skips when normalized keyword matches a recentTopic', async () => {
    const deps = makeDeps({
      evaluate: async () => makeDecision({ topic: 'x' }),
      contribute: async () => makeResult({ keyword: 'Already Covered' }),
      getContext: () => makeCtx(),
      now: () => 100000
    })
    const engine = makeEngine(deps, { recentTopics: ['already covered'] })
    const { logs, emissions } = wire(engine)

    engine.pushSignals([sig('a', 10)])
    await flush()

    expect(emissions.length).toBe(0)
    expect(logs.at(-1)).toMatchObject({ kind: 'skip', gate: 'duplicate-title' })
  })
})

// ---- source-URL dedup -----------------------------------------------------

describe('source-card dedup', () => {
  it('drops sources whose URL is already on canvas, still emits', async () => {
    const result = makeResult({
      keyword: 'New Angle',
      sources: [
        { title: 'New', url: 'https://new.com' },
        { title: 'Old', url: 'https://old.com' }
      ],
      searchPath: 'relay'
    })
    const deps = makeDeps({
      evaluate: async () => makeDecision({ topic: 'x' }),
      contribute: async () => result,
      getContext: () => makeCtx({ existingUrls: ['https://old.com'] }),
      now: () => 100000
    })
    const engine = makeEngine(deps)
    const { emissions } = wire(engine)

    engine.pushSignals([sig('a', 10)])
    await flush()

    expect(emissions.length).toBe(1)
    expect(emissions[0].result.sources.length).toBe(1)
    expect(emissions[0].result.sources[0].url).toBe('https://new.com')
  })
})

// ---- cooldown -------------------------------------------------------------

describe('cooldown blocks then unblocks', () => {
  it('blocks within the window, passes after now advances', () => {
    let now = 100000
    const deps = makeDeps({ now: () => now })
    const engine = makeEngine(deps, { lastEmittedAt: 99600 }) // 400ms ago, cooldown 1000
    const { logs } = wire(engine)

    engine.pushSignals([sig('a', 10)])
    expect(logs.at(-1)).toMatchObject({ kind: 'skip', gate: 'cooldown' })

    // Advance past cooldown.
    now += 700 // now 100700, 1100ms since lastEmittedAt
    logs.length = 0
    engine.pushSignals([sig('b', 20)])
    // Should NOT be a cooldown skip (will start evaluating instead).
    const cooldownSkips = logs.filter((l) => l.kind === 'skip' && l.gate === 'cooldown')
    expect(cooldownSkips.length).toBe(0)
  })

  it('also throttles evaluator calls when the last decision did not emit', async () => {
    let now = 100000
    const evaluate = vi.fn(async () => makeDecision({ emit: false, confidence: 0.2 }))
    const deps = makeDeps({ evaluate, now: () => now })
    const engine = makeEngine(deps)
    const { logs } = wire(engine)

    engine.pushSignals([sig('first', 10)])
    await flush()
    expect(evaluate).toHaveBeenCalledTimes(1)

    now += 500
    engine.pushSignals([sig('second', 20)])

    expect(logs.at(-1)).toMatchObject({ kind: 'skip', gate: 'cooldown' })
    expect(evaluate).toHaveBeenCalledTimes(1)
  })
})

// ---- rejection backoff ----------------------------------------------------

describe('rejection backoff', () => {
  it('doubles effective cooldown at 3 consecutive rejects', () => {
    let now = 100000
    const deps = makeDeps({
      evaluate: async () => makeDecision({ emit: false, confidence: 0 }),
      now: () => now
    })
    const engine = makeEngine(deps, {
      consecutiveRejected: 3,
      lastEmittedAt: 98600 // 1400ms ago: past normal (1000), within doubled (2000)
    })
    const { logs } = wire(engine)

    engine.pushSignals([sig('a', 10)])
    // 1400 < 2000 → still in doubled cooldown.
    expect(logs.at(-1)).toMatchObject({ kind: 'skip', gate: 'cooldown' })
  })

  it('a keep resets backoff to normal cooldown', () => {
    let now = 100000
    const deps = makeDeps({
      evaluate: async () => makeDecision({ emit: false, confidence: 0 }),
      now: () => now
    })
    const engine = makeEngine(deps, {
      consecutiveRejected: 3,
      lastEmittedAt: 98600 // 1400ms ago
    })
    const { logs } = wire(engine)

    // With backoff: 1400 < 2000 → cooldown.
    engine.pushSignals([sig('a', 10)])
    expect(logs.at(-1)).toMatchObject({ kind: 'skip', gate: 'cooldown' })

    // Reset backoff.
    engine.recordOutcome('kept')
    expect(engine.getState().consecutiveRejected).toBe(0)

    // Without backoff: 1400 >= 1000 → passes cooldown.
    logs.length = 0
    engine.pushSignals([sig('b', 20)])
    const cooldownSkips = logs.filter((l) => l.kind === 'skip' && l.gate === 'cooldown')
    expect(cooldownSkips.length).toBe(0)
  })

  it('recordOutcome rejected increments, kept resets, post-session-ignored increments separately', () => {
    const engine = makeEngine(makeDeps({ now: () => 100000 }))

    engine.recordOutcome('rejected')
    expect(engine.getState().consecutiveRejected).toBe(1)
    engine.recordOutcome('rejected')
    expect(engine.getState().consecutiveRejected).toBe(2)
    engine.recordOutcome('rejected')
    expect(engine.getState().consecutiveRejected).toBe(3)

    engine.recordOutcome('kept')
    expect(engine.getState().consecutiveRejected).toBe(0)

    engine.recordOutcome('post-session-ignored')
    engine.recordOutcome('post-session-ignored')
    expect(engine.getState().postSessionIgnored).toBe(2)
    expect(engine.getState().consecutiveRejected).toBe(0)
  })
})

// ---- stale generation -----------------------------------------------------

describe('reset mid-evaluate discards late result', () => {
  it('logs stale-generation and does not emit', async () => {
    let resolveEval!: (v: ObserverDecision | null) => void
    const evalPromise = new Promise<ObserverDecision | null>((r) => { resolveEval = r })
    const contribute = vi.fn(async () => makeResult({ keyword: 'Late Topic' }))
    const deps = makeDeps({
      evaluate: () => evalPromise,
      contribute,
      now: () => 100000
    })
    const engine = makeEngine(deps)
    const { logs, emissions } = wire(engine)

    engine.pushSignals([sig('a', 10)])

    // Reset mid-evaluate.
    engine.reset()

    // Now resolve the evaluator.
    resolveEval(makeDecision({ topic: 'late' }))
    await flush()

    expect(contribute).not.toHaveBeenCalled()
    expect(emissions.length).toBe(0)
    const staleLogs = logs.filter((l) => l.kind === 'skip' && l.gate === 'stale-generation')
    expect(staleLogs.length).toBe(1)
  })
})

// ---- error handling -------------------------------------------------------

describe('error handling — null / error results', () => {
  it('evaluator null → error log, no emission', async () => {
    const contribute = vi.fn(async () => makeResult())
    const deps = makeDeps({
      evaluate: async () => null,
      contribute,
      now: () => 100000
    })
    const engine = makeEngine(deps)
    const { logs, emissions } = wire(engine)

    engine.pushSignals([sig('a', 10)])
    await flush()

    expect(contribute).not.toHaveBeenCalled()
    expect(emissions.length).toBe(0)
    expect(logs.at(-1)).toMatchObject({ kind: 'error' })
  })

  it('structured evaluator failure → reason and model in error log', async () => {
    const contribute = vi.fn(async () => makeResult())
    const deps = makeDeps({
      evaluate: async () => ({ decision: null, error: 'LLM 429: rate limited', model: 'deepseek-v4-flash' }),
      contribute,
      now: () => 100000
    })
    const engine = makeEngine(deps)
    const { logs } = wire(engine)

    engine.pushSignals([sig('a', 10)])
    await flush()

    expect(contribute).not.toHaveBeenCalled()
    expect(logs.at(-1)).toMatchObject({
      kind: 'error',
      error: 'evaluator: LLM 429: rate limited',
      model: 'deepseek-v4-flash'
    })
  })

  it('contributor returns error → error log, no emission', async () => {
    const deps = makeDeps({
      evaluate: async () => makeDecision({ topic: 'x' }),
      contribute: async () => makeResult({ error: 'model overloaded' }),
      now: () => 100000
    })
    const engine = makeEngine(deps)
    const { logs, emissions } = wire(engine)

    engine.pushSignals([sig('a', 10)])
    await flush()

    expect(emissions.length).toBe(0)
    expect(logs.at(-1)).toMatchObject({ kind: 'error', error: 'model overloaded' })
  })

  it('logs a threaded contributor parse reason and model', async () => {
    const deps = makeDeps({
      evaluate: async () => makeDecision({ topic: 'x' }),
      contribute: async () => makeResult({
        error: 'contributor: unparseable-response (finish_reason=length, reasoning_content=present)',
        model: 'deepseek-v4-flash'
      }),
      now: () => 100000
    })
    const engine = makeEngine(deps)
    const { logs, emissions } = wire(engine)

    engine.pushSignals([sig('a', 10)])
    await flush()

    expect(emissions).toHaveLength(0)
    expect(logs.at(-1)).toMatchObject({
      kind: 'error',
      error: 'contributor: unparseable-response (finish_reason=length, reasoning_content=present)',
      model: 'deepseek-v4-flash'
    })
  })

  it('evaluator throws → error log, no emission, no throw', async () => {
    const deps = makeDeps({
      evaluate: async () => { throw new Error('network down') },
      now: () => 100000
    })
    const engine = makeEngine(deps)
    const { logs, emissions } = wire(engine)

    // Should not throw.
    engine.pushSignals([sig('a', 10)])
    await flush()

    expect(emissions.length).toBe(0)
    expect(logs.at(-1)).toMatchObject({ kind: 'error', error: 'network down' })
  })

  it('contributor throws → error log, no emission', async () => {
    const deps = makeDeps({
      evaluate: async () => makeDecision({ topic: 'x' }),
      contribute: async () => { throw new Error('contributor crashed') },
      now: () => 100000
    })
    const engine = makeEngine(deps)
    const { logs, emissions } = wire(engine)

    engine.pushSignals([sig('a', 10)])
    await flush()

    expect(emissions.length).toBe(0)
    expect(logs.at(-1)).toMatchObject({ kind: 'error', error: 'contributor crashed' })
  })
})

// ---- lastEvaluatedSignalTs ------------------------------------------------

describe('lastEvaluatedSignalTs prevents re-evaluation', () => {
  it('second push with older ts is skipped', async () => {
    const evaluate = vi.fn(async () => makeDecision({ emit: false, confidence: 0 }))
    const deps = makeDeps({ evaluate, now: () => 100000 })
    const engine = makeEngine(deps)
    const { logs } = wire(engine)

    engine.pushSignals([sig('a', 50)])
    await flush()

    // Push with older ts.
    evaluate.mockClear()
    engine.pushSignals([sig('b', 40)])
    await flush()

    expect(logs.at(-1)).toMatchObject({ kind: 'skip', gate: 'already-evaluated' })
    expect(evaluate).not.toHaveBeenCalled()
  })
})

// ---- recentTopics cap -----------------------------------------------------

describe('recentTopics cap', () => {
  it('caps at maxRecentTopics, drops oldest', async () => {
    const maxRecentTopics = 3
    const deps = makeDeps({
      evaluate: async () => makeDecision({ topic: 'x' }),
      contribute: async (input) => makeResult({ keyword: input.signals[0].text }),
      getContext: () => makeCtx(),
      now: () => 100000
    })
    const engine = makeEngine(deps, {}, { cooldownMs: 0, maxRecentTopics })

    // Emit 4 times (cooldown 0 allows back-to-back).
    for (let i = 0; i < 4; i++) {
      const { logs } = wire(engine)
      engine.pushSignals([sig(`topic-${i}`, 10 + i)])
      await flush()
    }

    const topics = engine.getState().recentTopics
    expect(topics.length).toBe(3)
    // Oldest ('topic-0') dropped, most recent 3 kept.
    expect(topics).toEqual(['topic-1', 'topic-2', 'topic-3'])
  })
})

// ---- getState / initialState ---------------------------------------------

describe('getState and initialState', () => {
  it('returns a shallow copy (mutation does not corrupt internal state)', () => {
    const engine = makeEngine(makeDeps({ now: () => 100000 }))
    const state = engine.getState()
    state.recentTopics.push('hacked')
    state.consecutiveRejected = 99
    expect(engine.getState().recentTopics).toEqual([])
    expect(engine.getState().consecutiveRejected).toBe(0)
  })

  it('uses default initialState when not provided', () => {
    const engine = new ObserverEngine(makeDeps({ now: () => 100000 }), {
      cooldownMs: 1000,
      maxRecentTopics: 8
    })
    const state = engine.getState()
    expect(state).toEqual({
      lastEvaluatedSignalTs: 0,
      recentTopics: [],
      consecutiveRejected: 0,
      postSessionIgnored: 0
    })
  })

  it('stop() causes not-running gate to fire', () => {
    const engine = makeEngine(makeDeps({ now: () => 100000 }))
    engine.stop()
    const { logs } = wire(engine)
    engine.pushSignals([sig('a', 10)])
    expect(logs.at(-1)).toMatchObject({ kind: 'skip', gate: 'not-running' })
  })

  it('setEnabled(false) causes disabled gate to fire', () => {
    const engine = makeEngine(makeDeps({ now: () => 100000 }))
    engine.setEnabled(false)
    const { logs } = wire(engine)
    engine.pushSignals([sig('a', 10)])
    expect(logs.at(-1)).toMatchObject({ kind: 'skip', gate: 'disabled' })
  })
})

// ---- onContributeStart / onContributeSettled -----------------------------

describe('onContributeStart / onContributeSettled', () => {
  it('start fires only when contribute is reached; settled fires once with emitted=true on success', async () => {
    const deps = makeDeps({
      evaluate: async () => makeDecision({ topic: 'x' }),
      contribute: async () => makeResult({ keyword: 'New' }),
      getContext: () => makeCtx(),
      now: () => 100000
    })
    const engine = makeEngine(deps)
    wire(engine)
    const starts: number[] = []
    const settles: boolean[] = []
    engine.onContributeStart = () => starts.push(Date.now())
    engine.onContributeSettled = (emitted) => settles.push(emitted)

    engine.pushSignals([sig('a', 10)])
    await flush()

    expect(starts.length).toBe(1)
    expect(settles.length).toBe(1)
    expect(settles[0]).toBe(true)
  })

  it('start does NOT fire on gate skips (cooldown)', () => {
    const deps = makeDeps({ now: () => 100000 })
    const engine = makeEngine(deps, { lastEmittedAt: 99500 }) // 500ms ago, cooldown 1000
    wire(engine)
    let startCount = 0
    let settleCount = 0
    engine.onContributeStart = () => startCount++
    engine.onContributeSettled = () => settleCount++

    engine.pushSignals([sig('a', 10)])
    expect(startCount).toBe(0)
    expect(settleCount).toBe(0)
  })

  it('start does NOT fire on emit:false (evaluator-only pass)', async () => {
    const deps = makeDeps({
      evaluate: async () => makeDecision({ emit: false, confidence: 0 }),
      now: () => 100000
    })
    const engine = makeEngine(deps)
    wire(engine)
    let startCount = 0
    let settleCount = 0
    engine.onContributeStart = () => startCount++
    engine.onContributeSettled = () => settleCount++

    engine.pushSignals([sig('a', 10)])
    await flush()

    expect(startCount).toBe(0)
    expect(settleCount).toBe(0)
  })

  it('settled fires once with emitted=false on contribute throw', async () => {
    const deps = makeDeps({
      evaluate: async () => makeDecision({ topic: 'x' }),
      contribute: async () => { throw new Error('boom') },
      now: () => 100000
    })
    const engine = makeEngine(deps)
    wire(engine)
    const settles: boolean[] = []
    engine.onContributeSettled = (emitted) => settles.push(emitted)

    engine.pushSignals([sig('a', 10)])
    await flush()

    expect(settles.length).toBe(1)
    expect(settles[0]).toBe(false)
  })

  it('settled fires once with emitted=false on stale generation (post-contribute)', async () => {
    let resolveContrib!: (v: ObserverContributionResult) => void
    const contribPromise = new Promise<ObserverContributionResult>((r) => { resolveContrib = r })
    const deps = makeDeps({
      evaluate: async () => makeDecision({ topic: 'x' }),
      contribute: () => contribPromise,
      now: () => 100000
    })
    const engine = makeEngine(deps)
    wire(engine)
    const settles: boolean[] = []
    engine.onContributeSettled = (emitted) => settles.push(emitted)

    engine.pushSignals([sig('a', 10)])
    await flush() // let the evaluator resolve and reach contribute
    // Reset mid-contribute → stale when it resolves.
    engine.reset()
    resolveContrib(makeResult({ keyword: 'Late' }))
    await flush()

    expect(settles.length).toBe(1)
    expect(settles[0]).toBe(false)
  })

  it('settled fires once with emitted=false on null result', async () => {
    const deps = makeDeps({
      evaluate: async () => makeDecision({ topic: 'x' }),
      contribute: async () => null,
      now: () => 100000
    })
    const engine = makeEngine(deps)
    wire(engine)
    const settles: boolean[] = []
    engine.onContributeSettled = (emitted) => settles.push(emitted)

    engine.pushSignals([sig('a', 10)])
    await flush()

    expect(settles.length).toBe(1)
    expect(settles[0]).toBe(false)
  })

  it('settled fires once with emitted=false on result.error', async () => {
    const deps = makeDeps({
      evaluate: async () => makeDecision({ topic: 'x' }),
      contribute: async () => makeResult({ error: 'overloaded' }),
      now: () => 100000
    })
    const engine = makeEngine(deps)
    wire(engine)
    const settles: boolean[] = []
    engine.onContributeSettled = (emitted) => settles.push(emitted)

    engine.pushSignals([sig('a', 10)])
    await flush()

    expect(settles.length).toBe(1)
    expect(settles[0]).toBe(false)
  })

  it('settled fires once with emitted=false on duplicate-title', async () => {
    const deps = makeDeps({
      evaluate: async () => makeDecision({ topic: 'x' }),
      contribute: async () => makeResult({ keyword: 'Existing Topic' }),
      getContext: () => makeCtx({ noteTitles: ['existing topic'] }),
      now: () => 100000
    })
    const engine = makeEngine(deps)
    wire(engine)
    const settles: boolean[] = []
    engine.onContributeSettled = (emitted) => settles.push(emitted)

    engine.pushSignals([sig('a', 10)])
    await flush()

    expect(settles.length).toBe(1)
    expect(settles[0]).toBe(false)
  })
})
