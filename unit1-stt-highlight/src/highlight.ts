import { requestHighlights } from '../../services/llm/client'
import type { LatencySample } from './latency'

export interface EngineConfig {
  provider: string
  /** Optional model override (Groq picker); falls back to provider .env default. */
  model?: string
  systemPrompt: string
  mode: 'words' | 'pause'
  /** N words between calls (mode 'words') */
  n: number
  /** how many trailing words to send to the model */
  windowWords: number
  /** hard cap on NEW highlights accepted per model call (density control) */
  maxPerCall: number
}

// Reject over-long spans so highlights stay tight cores, not whole clauses.
// Word count catches English; char count catches CJK (no spaces).
const MAX_PHRASE_WORDS = 6
const MAX_PHRASE_CHARS = 30
function isTooLong(phrase: string): boolean {
  const p = phrase.trim()
  return p.split(/\s+/).length > MAX_PHRASE_WORDS || p.length > MAX_PHRASE_CHARS
}

// Owns transcript state + the cadence loop that fires Tier-1 highlight calls.
export class HighlightEngine {
  finalized = ''
  interim = ''
  phrases = new Set<string>()
  config: EngineConfig

  onRender: (latest: Set<string>) => void = () => {}
  onLatency: (s: LatencySample) => void = () => {}
  onError: (msg: string) => void = () => {}

  private wordsSinceCall = 0
  private lastFinalTs = 0
  private pauseTimer: number | undefined
  private inFlight = false

  constructor(config: EngineConfig) {
    this.config = config
  }

  pushFinal(text: string, ts: number) {
    const chunk = text.trim()
    if (!chunk) return
    this.finalized += (this.finalized ? ' ' : '') + chunk
    this.interim = ''
    this.lastFinalTs = ts
    this.wordsSinceCall += chunk.split(/\s+/).length
    this.onRender(new Set())
    this.maybeFire()
  }

  pushInterim(text: string) {
    this.interim = text
    this.onRender(new Set())
  }

  private maybeFire() {
    if (this.config.mode === 'words') {
      if (this.wordsSinceCall >= this.config.n) this.fire()
    } else {
      // on-pause: fire after a brief silence following the latest final.
      clearTimeout(this.pauseTimer)
      this.pauseTimer = window.setTimeout(() => this.fire(), 500)
    }
  }

  private async fire() {
    if (this.inFlight) return // avoid overlapping calls; next final re-triggers
    this.inFlight = true
    const tFinal = this.lastFinalTs
    const tFire = performance.now()
    this.wordsSinceCall = 0

    const windowText = lastWords(this.finalized, this.config.windowWords)
    const res = await requestHighlights({
      systemPrompt: this.config.systemPrompt,
      text: windowText,
      provider: this.config.provider,
      // Model override is Groq-only; let other providers use their .env default.
      model: this.config.provider === 'groq' ? this.config.model : undefined
    })
    this.inFlight = false

    if (res.error) {
      this.onError(res.error)
      return
    }

    const latest = new Set<string>()
    for (const p of res.phrases) {
      if (latest.size >= this.config.maxPerCall) break // density cap
      if (isTooLong(p)) continue // skip whole-clause spans
      const actual = this.findActual(p)
      if (actual && !this.phrases.has(actual)) {
        this.phrases.add(actual)
        latest.add(actual)
      }
    }

    const tRender = performance.now()
    this.onRender(latest)
    if (latest.size > 0) {
      this.onLatency({
        total: tRender - tFinal,
        cadenceWait: tFire - tFinal,
        llm: res.serverMs,
        model: res.model
      })
    }
  }

  // Match a model-returned phrase against the real transcript case-insensitively,
  // returning the verbatim slice so highlighting lands on real text.
  private findActual(phrase: string): string | null {
    const p = phrase.trim()
    if (p.length < 2) return null
    const idx = this.finalized.toLowerCase().indexOf(p.toLowerCase())
    return idx === -1 ? null : this.finalized.slice(idx, idx + p.length)
  }

  reset() {
    this.finalized = ''
    this.interim = ''
    this.phrases.clear()
    this.wordsSinceCall = 0
    this.lastFinalTs = 0
    clearTimeout(this.pauseTimer)
  }
}

function lastWords(text: string, n: number): string {
  const w = text.trim().split(/\s+/)
  return w.slice(Math.max(0, w.length - n)).join(' ')
}
