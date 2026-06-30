import { requestCleanTranscript } from '../../services/llm/client'
import type { LatencySample } from './latency'

export interface CleanupConfig {
  provider: string
  model?: string
  systemPrompt: string
  pauseMs: number
  minWords: number
  minCjkChars: number
}

// Owns the new Unit 1 flow:
// raw STT stays hidden -> pause snapshots unseen raw text -> LLM returns cleaned
// text with ==highlight markers== -> UI appends only the cleaned segment.
export class CleanupEngine {
  segments: string[] = []
  config: CleanupConfig

  onRender: (latestIndex: number | null, busy: boolean) => void = () => {}
  onLatency: (s: LatencySample) => void = () => {}
  onError: (msg: string) => void = () => {}

  private pendingRaw = ''
  private latestRawTs = 0
  private pauseTimer: number | undefined
  private inFlight = false
  private queuedAfterFlight = false

  constructor(config: CleanupConfig) {
    this.config = config
  }

  pushFinal(text: string, ts: number) {
    const chunk = text.trim()
    if (!chunk) return
    this.pendingRaw += (this.pendingRaw ? ' ' : '') + chunk
    this.latestRawTs = ts
    this.schedulePause()
  }

  pushInterim(_text: string) {
    // Deliberately hidden: raw STT should not appear in the transcript surface.
  }

  flush() {
    clearTimeout(this.pauseTimer)
    void this.fire(true)
  }

  reset() {
    this.segments = []
    this.pendingRaw = ''
    this.latestRawTs = 0
    this.inFlight = false
    this.queuedAfterFlight = false
    clearTimeout(this.pauseTimer)
  }

  private schedulePause() {
    clearTimeout(this.pauseTimer)
    this.pauseTimer = window.setTimeout(() => void this.fire(false), this.config.pauseMs)
  }

  private async fire(force: boolean) {
    const raw = this.pendingRaw.trim()
    if (!raw) return
    if (!force && !this.isMeaningfulChunk(raw)) {
      this.schedulePause()
      return
    }
    if (this.inFlight) {
      this.queuedAfterFlight = true
      return
    }

    // Snapshot and clear before the model call. New STT words accumulate in a
    // fresh buffer, so no raw word is sent through the model twice.
    this.pendingRaw = ''
    this.inFlight = true
    this.queuedAfterFlight = false
    const tRaw = this.latestRawTs
    const tFire = performance.now()
    this.onRender(null, true)

    const res = await requestCleanTranscript({
      rawText: raw,
      existingNotes: this.segments.join('\n\n'),
      provider: this.config.provider,
      model: this.config.provider === 'groq' ? this.config.model : undefined,
      systemPrompt: this.config.systemPrompt
    })

    this.inFlight = false
    if (res.error) {
      // Put the raw snapshot back at the front so a transient model error does
      // not silently drop words. It is still hidden from the UI.
      this.pendingRaw = raw + (this.pendingRaw ? ` ${this.pendingRaw}` : '')
      this.onError(res.error)
      this.onRender(null, false)
      return
    }

    if (res.markedText.trim()) {
      this.segments = [res.markedText.trim()]
      const tRender = performance.now()
      this.onLatency({
        total: tRender - tRaw,
        cadenceWait: tFire - tRaw,
        llm: res.serverMs,
        model: res.model
      })
      this.onRender(0, false)
    } else {
      this.onRender(null, false)
    }

    if (this.queuedAfterFlight || this.pendingRaw.trim()) this.schedulePause()
  }

  private isMeaningfulChunk(raw: string): boolean {
    const cjkChars = (raw.match(/[一-鿿]/g) || []).length
    const words = (raw.replace(/[一-鿿]/g, ' ').match(/[A-Za-z0-9']+/g) || []).length
    return words >= this.config.minWords || cjkChars >= this.config.minCjkChars
  }
}
