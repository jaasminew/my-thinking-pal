// ObserverEngine — the deterministic scheduling/gating state machine for the
// transcript-driven observer.
//
// All I/O is injected via ObserverEngineDeps; the engine itself is pure of
// network, DOM, and storage. pushSignals is fire-and-forget: it runs gates
// synchronously, and on pass kicks an internal async cycle that never throws.
//
// See docs/observer/contract.md §2.3 (signature) and §3 (gate semantics).

import type {
  ObserverEngineDeps,
  ObserverEngineConfig,
  ObserverState,
  ObserverSignal,
  ObserverEmission,
  ObserverLogRecord,
  ObserverOutcome,
  ObserverGate,
  ObserverEvaluatorInput,
  ObserverContributorInput,
  ObserverContributionResult
} from '../../../packages/core/llm/observer-types'

// Contract §4 — engine config defaults, exported so tests/Lead can reference.
export const DEFAULT_COOLDOWN_MS = 75_000
export const DEFAULT_MAX_RECENT_TOPICS = 8

// Normalize a topic/keyword for duplicate comparison: lowercase, trimmed,
// whitespace collapsed to single spaces (contract §3: "normalized keyword").
function normalizeTopic(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, ' ')
}

function errToString(err: unknown): string {
  if (err instanceof Error) return err.message
  return String(err)
}

export class ObserverEngine {
  // Public callbacks — the Lead assigns these to wire the engine into the app.
  onEmit: (e: ObserverEmission) => void = () => {}
  onLog: (r: ObserverLogRecord) => void = () => {}
  /** Fires immediately before contribute() is called (never on evaluator-only
   *  passes or gate skips). The AI cursor appears at the future note's spot. */
  onContributeStart: () => void = () => {}
  /** Fires exactly once per contribute call, after it settles. emitted=true
   *  only when onEmit fired for this cycle (the success path). Every other
   *  exit (throw, stale, null, error, dup-title) fires with emitted=false. */
  onContributeSettled: (emitted: boolean) => void = () => {}

  private deps: ObserverEngineDeps
  private config: ObserverEngineConfig
  private state: ObserverState

  private running = false
  private enabled = false
  private evaluating = false
  private lastEvaluatorStartedAt: number | undefined
  // Bumped on reset() so late async results can't write stale state (same
  // pattern as SignalEngine.gen — see apps/web/src/signal-engine.ts:96).
  private gen = 0

  constructor(
    deps: ObserverEngineDeps,
    config: ObserverEngineConfig,
    initialState?: ObserverState
  ) {
    this.deps = deps
    this.config = config
    this.state = initialState
      ? { ...initialState }
      : {
          lastEvaluatedSignalTs: 0,
          recentTopics: [],
          consecutiveRejected: 0,
          postSessionIgnored: 0
        }
  }

  start(): void {
    this.running = true
  }

  stop(): void {
    this.running = false
  }

  // Canvas switch: bump generation, clear volatile progress, drop late results.
  reset(): void {
    this.gen++
    this.evaluating = false
    this.lastEvaluatorStartedAt = undefined
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled
  }

  // Keep/reject/post-session-ignore feedback (drives rejection backoff).
  recordOutcome(outcome: ObserverOutcome): void {
    if (outcome === 'kept') {
      this.state.consecutiveRejected = 0
    } else if (outcome === 'rejected') {
      this.state.consecutiveRejected++
    } else {
      // post-session-ignored: increments its own counter only (no cooldown effect).
      this.state.postSessionIgnored++
    }
  }

  getState(): ObserverState {
    // Shallow copy + clone the recentTopics array so callers can't mutate
    // internal state by pushing into the returned array.
    return { ...this.state, recentTopics: [...this.state.recentTopics] }
  }

  // Called with each fresh SignalEngine batch; runs the gate → evaluate →
  // contribute cycle. Fire-and-forget: never throws, never returns a promise
  // the caller must handle.
  pushSignals(lines: ObserverSignal[]): void {
    try {
      const now = this.now()
      const signalTsRange: [number, number] | undefined =
        lines.length > 0
          ? [
              Math.min(...lines.map((l) => l.ts)),
              Math.max(...lines.map((l) => l.ts))
            ]
          : undefined

      // Gate 1: not-running — start() called, stop() not.
      if (!this.running) {
        this.logSkip('not-running', signalTsRange)
        return
      }

      // Gate 2: disabled — setEnabled(true).
      if (!this.enabled) {
        this.logSkip('disabled', signalTsRange)
        return
      }

      // Gate 3: empty-batch — batch has ≥ 1 signal.
      if (lines.length === 0) {
        this.logSkip('empty-batch', signalTsRange)
        return
      }

      // Gate 4: already-evaluated — newest signal ts > lastEvaluatedSignalTs.
      const newestTs = Math.max(...lines.map((l) => l.ts))
      if (newestTs <= this.state.lastEvaluatedSignalTs) {
        this.logSkip('already-evaluated', signalTsRange!)
        return
      }

      // Gate 5: evaluating — no evaluator/contributor call in flight.
      if (this.evaluating) {
        this.logSkip('evaluating', signalTsRange!)
        return
      }

      // Gate 6: cooldown — applies to evaluator calls as well as emissions.
      const effectiveCooldownMs =
        this.state.consecutiveRejected >= 3
          ? this.config.cooldownMs * 2
          : this.config.cooldownMs
      const lastObserverActivityAt = Math.max(
        this.state.lastEmittedAt ?? 0,
        this.lastEvaluatorStartedAt ?? 0
      )
      const elapsed = now - lastObserverActivityAt
      if (elapsed < effectiveCooldownMs) {
        this.logSkip('cooldown', signalTsRange!)
        return
      }

      // Gate 7: cocreate-in-flight — deps.isCocreateStreaming() is false.
      if (this.deps.isCocreateStreaming()) {
        this.logSkip('cocreate-in-flight', signalTsRange!)
        return
      }

      // All gates passed — set lastEvaluatedSignalTs BEFORE awaiting the
      // evaluator (prevents double evaluation), mark evaluating, kick cycle.
      this.state.lastEvaluatedSignalTs = newestTs
      this.lastEvaluatorStartedAt = now
      this.evaluating = true
      const gen = this.gen
      void this.runCycle(lines, signalTsRange!, gen)
    } catch {
      // Safety net — never throw out of pushSignals.
    }
  }

  // Internal async cycle: evaluate → contribute → emit. Never throws; all
  // errors are caught and logged. Stale-generation results are discarded.
  private async runCycle(
    lines: ObserverSignal[],
    signalTsRange: [number, number],
    gen: number
  ): Promise<void> {
    // Declared outside the try so the finally block can read them (block scope).
    let contribStarted = false
    let emitted = false
    try {
      // --- Evaluator phase ---
      const ctx = this.deps.getContext()
      const evalInput: ObserverEvaluatorInput = {
        signals: lines,
        transcriptWindow: ctx.transcriptWindow,
        canvasSummary: ctx.settledContent,
        recentObserverTopics: this.state.recentTopics,
        kept: ctx.kept,
        rejected: ctx.rejected,
        ...(ctx.dominantLanguage ? { dominantLanguage: ctx.dominantLanguage } : {})
      }

      const evalStart = this.now()
      let decision
      try {
        decision = await this.deps.evaluate(evalInput)
      } catch (err) {
        if (gen === this.gen) {
          this.logError(signalTsRange, errToString(err))
        }
        return
      }

      // Stale check after evaluator await.
      if (gen !== this.gen) {
        this.logSkip('stale-generation', signalTsRange)
        return
      }

      // Evaluator null → error, no emission.
      if (decision === null) {
        this.logError(signalTsRange, 'evaluator returned null')
        return
      }

      // Log the evaluation with decision and latency.
      const evalLatency = this.now() - evalStart
      this.onLog({
        ts: this.now(),
        kind: 'evaluation',
        decision,
        signalTsRange,
        latencyMs: evalLatency
      })

      // emit:false → done (no contribute call).
      if (!decision.emit) return

      // --- Contributor phase ---
      // onContributeStart fires ONLY when contribute is reached (never on
      // evaluator-only passes or gate skips). onContributeSettled fires once
      // on every exit path after this point, via the finally block below.
      const contribInput: ObserverContributorInput = {
        decision,
        signals: lines,
        transcriptWindow: ctx.transcriptWindow,
        canvasSummary: ctx.settledContent,
        ...(ctx.dominantLanguage ? { dominantLanguage: ctx.dominantLanguage } : {})
      }

      this.onContributeStart()
      contribStarted = true

      let result: ObserverContributionResult | null
      try {
        result = await this.deps.contribute(contribInput)
      } catch (err) {
        if (gen === this.gen) {
          this.logError(signalTsRange, errToString(err))
        }
        return
      }

      // Stale check after contributor await.
      if (gen !== this.gen) {
        this.logSkip('stale-generation', signalTsRange)
        return
      }

      // Contributor null or error → error, no emission.
      if (result === null) {
        this.logError(signalTsRange, 'contributor returned null')
        return
      }
      if (result.error) {
        this.logError(signalTsRange, result.error, result.model)
        return
      }

      // --- Duplicate-title gate ---
      const normalizedKeyword = normalizeTopic(result.keyword)
      const freshCtx = this.deps.getContext()
      const normalizedTitles = freshCtx.noteTitles.map(normalizeTopic)
      if (
        normalizedTitles.includes(normalizedKeyword) ||
        this.state.recentTopics.includes(normalizedKeyword)
      ) {
        this.logSkip('duplicate-title', signalTsRange)
        return
      }

      // --- Source-card dedup (never blocks the emission) ---
      const dedupedSources = result.sources.filter(
        (s) => !freshCtx.existingUrls.includes(s.url)
      )
      const dedupedResult: ObserverContributionResult = {
        ...result,
        sources: dedupedSources
      }

      // --- Emit ---
      this.onEmit({
        decision,
        result: dedupedResult,
        signalTsRange
      })
      emitted = true
      this.state.lastEmittedAt = this.now()
      this.state.recentTopics.push(normalizedKeyword)
      while (this.state.recentTopics.length > this.config.maxRecentTopics) {
        this.state.recentTopics.shift() // drop oldest
      }
      this.onLog({
        ts: this.now(),
        kind: 'emission',
        signalTsRange,
        ...(result.searchPath ? { searchPath: result.searchPath } : {}),
        ...(result.model ? { model: result.model } : {})
      })
    } catch (err) {
      // Safety net — never throw out of the cycle.
      if (gen === this.gen) {
        this.logError(signalTsRange, errToString(err))
      }
    } finally {
      // Only clear the flag if this cycle still owns the current generation.
      if (gen === this.gen) {
        this.evaluating = false
      }
      // onContributeSettled fires exactly once on every exit path after
      // contribute started — covers throw, stale, null, error, dup-title,
      // and success. emitted is true only on the success path.
      if (contribStarted) {
        this.onContributeSettled(emitted)
      }
    }
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now()
  }

  private logSkip(gate: ObserverGate, signalTsRange?: [number, number]): void {
    this.onLog({
      ts: this.now(),
      kind: 'skip',
      gate,
      ...(signalTsRange ? { signalTsRange } : {})
    })
  }

  private logError(
    signalTsRange: [number, number],
    error: string,
    model?: string
  ): void {
    this.onLog({
      ts: this.now(),
      kind: 'error',
      signalTsRange,
      error,
      ...(model ? { model } : {})
    })
  }
}
