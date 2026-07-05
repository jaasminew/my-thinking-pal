import { requestCleanTranscript, requestSegment } from '../../services/llm/client'

// Two-tier structured-transcript engine.
//
// The transcript is a hierarchical, markdown-like document that CRYSTALLIZES
// behind live speech in two decoupled passes:
//
//  1. Cleanup (every 30s): rewrites the last window of raw speech into concise,
//     written-style idea lines and APPENDS them to the open `tail`. One idea per
//     line — lines are the atomic unit of structure.
//  2. Segmentation (every 2min + on stop): a thinking model reads ONLY the open
//     tail, decides where topics break, and FREEZES the closed segments with
//     headers. Frozen sections are final — the model never touches them again,
//     so the layout never flickers. The user can still hand-edit any line/header.

export interface Line {
  id: string
  text: string
  /** When the raw speech behind this line was spoken (start of its cleanup window). */
  ts: number
}

export interface Section {
  id: string
  header: string
  lines: Line[]
}

export interface CleanupConfig {
  provider: string
  /** model for the fast cleanup pass (Groq) */
  cleanupModel?: string
  /** thinking model for the async segmentation pass (Groq) */
  segmentModel?: string
  systemPrompt: string
  /** how often the raw buffer is cleaned into idea lines */
  cleanupIntervalMs: number
  /** how often the tail is scanned for topic boundaries */
  segmentIntervalMs: number
  /** skip a near-empty cleanup window: need this many latin words OR cjk chars */
  minWords: number
  minCjkChars: number
}

export type EngineStatus = 'idle' | 'listening' | 'summarizing' | 'organizing'

let _seq = 0
const uid = (p: string) => `${p}${Date.now().toString(36)}${(_seq++).toString(36)}`

export class CleanupEngine {
  frozenSections: Section[] = []
  tail: Line[] = []
  config: CleanupConfig

  onRender: () => void = () => {}
  onStatus: (s: EngineStatus) => void = () => {}
  onError: (msg: string) => void = () => {}

  private pendingRaw = ''
  private pendingRawStartTs: number | undefined // when the current raw window began
  private cleanupTimer: number | undefined
  private segmentTimer: number | undefined
  private cleaning = false
  private segmenting = false
  private running = false
  private gen = 0 // bumped on reset so late async results can't write stale state

  constructor(config: CleanupConfig) {
    this.config = config
  }

  start() {
    this.running = true
    clearInterval(this.cleanupTimer)
    clearInterval(this.segmentTimer)
    this.cleanupTimer = window.setInterval(() => void this.runCleanup(false), this.config.cleanupIntervalMs)
    this.segmentTimer = window.setInterval(() => void this.runSegment(false), this.config.segmentIntervalMs)
    this.setStatus('listening')
  }

  // Final flush on stop: clean whatever raw is left, then a closing segmentation
  // pass that titles EVERY remaining line so no section ends up untitled.
  async stop() {
    this.running = false
    clearInterval(this.cleanupTimer)
    clearInterval(this.segmentTimer)
    await this.runCleanup(true)
    await this.runSegment(true)
    this.setStatus('idle')
  }

  reset() {
    clearInterval(this.cleanupTimer)
    clearInterval(this.segmentTimer)
    this.gen++
    this.frozenSections = []
    this.tail = []
    this.pendingRaw = ''
    this.pendingRawStartTs = undefined
    this.cleaning = false
    this.segmenting = false
    this.running = false
  }

  pushFinal(text: string) {
    const chunk = text.trim()
    if (!chunk) return
    if (!this.pendingRaw) this.pendingRawStartTs = Date.now()
    this.pendingRaw += (this.pendingRaw ? ' ' : '') + chunk
  }

  // Raw interim STT is deliberately hidden — it never appears in the surface.
  pushInterim(_text: string) {}

  // --- user edits: append-only means the model never overwrites these ---
  editLine(lineId: string, text: string) {
    for (const s of this.frozenSections) {
      const ln = s.lines.find((l) => l.id === lineId)
      if (ln) {
        ln.text = text
        this.onRender()
        return
      }
    }
    const t = this.tail.find((l) => l.id === lineId)
    if (t) {
      t.text = text
      this.onRender()
    }
  }

  editHeader(sectionId: string, text: string) {
    const sec = this.frozenSections.find((s) => s.id === sectionId)
    if (sec) {
      sec.header = text
      this.onRender()
    }
  }

  private setStatus(s: EngineStatus) {
    this.onStatus(s)
  }

  private idleStatus(): EngineStatus {
    return this.running ? 'listening' : 'idle'
  }

  // Cleanup pass: raw buffer -> concise written idea lines appended to the tail.
  private async runCleanup(force: boolean) {
    const raw = this.pendingRaw.trim()
    if (!raw) return
    if (!force && !this.isMeaningfulChunk(raw)) return
    if (this.cleaning) return

    const gen = this.gen
    const rawTs = this.pendingRawStartTs ?? Date.now()
    this.pendingRaw = ''
    this.pendingRawStartTs = undefined
    this.cleaning = true
    this.setStatus('summarizing')

    const res = await requestCleanTranscript({
      rawText: raw,
      existingNotes: this.recentTailText().slice(-800),
      provider: this.config.provider,
      model: this.config.provider === 'groq' ? this.config.cleanupModel : undefined,
      systemPrompt: this.config.systemPrompt
    })

    if (gen !== this.gen) return
    this.cleaning = false

    const text = (res.markedText || '').trim()
    if (res.error || !text) {
      // No usable output this round — put the raw back so no speech is lost; the
      // next tick retries. Never surfaced as an error to the user.
      this.pendingRaw = raw + (this.pendingRaw ? ` ${this.pendingRaw}` : '')
      this.pendingRawStartTs = rawTs // restored raw is the oldest speech again
      this.setStatus(this.idleStatus())
      return
    }

    for (const line of this.splitLines(text)) {
      this.tail.push({ id: uid('l'), text: line, ts: rawTs })
    }
    this.onRender()
    this.setStatus(this.idleStatus())
  }

  // Segmentation pass: send the tail to the thinking model; freeze closed
  // segments with headers, keep the still-open remainder as the new tail.
  private async runSegment(closing: boolean) {
    if (this.segmenting) return
    if (this.tail.length === 0) return
    if (!closing && this.tail.length < 2) return

    const gen = this.gen
    this.segmenting = true
    this.setStatus('organizing')

    const snapshot = this.tail.slice()
    const numbered = snapshot.map((l, i) => `${i}: ${l.text}`).join('\n')

    const res = await requestSegment({
      lines: numbered,
      closing,
      provider: this.config.provider,
      model: this.config.provider === 'groq' ? this.config.segmentModel : undefined
    })

    if (gen !== this.gen) return
    this.segmenting = false

    const segs = Array.isArray(res.sections) ? res.sections : []
    this.applySegments(snapshot, segs, closing)
    this.setStatus(this.idleStatus())
  }

  // Turn the model's {endLine, header} list into frozen sections. Robust to junk:
  // clamps indices, keeps endLine strictly increasing, drops headerless entries.
  private applySegments(
    snapshot: Line[],
    segs: { endLine: number; header: string }[],
    closing: boolean
  ) {
    const clean: { end: number; header: string }[] = []
    let prevEnd = -1
    for (const s of segs) {
      const end = Math.max(0, Math.min(Math.floor(Number(s.endLine)), snapshot.length - 1))
      const header = (s.header || '').trim()
      if (!Number.isFinite(end) || end <= prevEnd || !header) continue
      clean.push({ end, header })
      prevEnd = end
    }

    if (clean.length === 0) {
      // No boundary this round. On a closing pass, still title the leftover.
      if (closing) this.freezeRemainder()
      this.onRender()
      return
    }

    let start = 0
    for (const c of clean) {
      const lines = snapshot.slice(start, c.end + 1)
      if (lines.length) this.frozenSections.push({ id: uid('s'), header: c.header, lines })
      start = c.end + 1
    }

    // Remove the covered prefix from the live tail. The tail may have grown while
    // the model was thinking (cleanup only appends), so splice from lastEnd+1 to
    // keep any lines added during the call.
    const lastEnd = clean[clean.length - 1].end
    this.tail = this.tail.slice(lastEnd + 1)

    if (closing) this.freezeRemainder()
    this.onRender()
  }

  // Closing fallback: if lines remain after segmentation, freeze them under a
  // derived title so the finished document has no untitled trailing section.
  private freezeRemainder() {
    if (this.tail.length === 0) return
    this.frozenSections.push({ id: uid('s'), header: this.deriveHeader(this.tail), lines: this.tail })
    this.tail = []
  }

  private deriveHeader(lines: Line[]): string {
    const first = (lines[0]?.text || '').replace(/==/g, '').trim()
    if (!first) return 'Notes'
    const words = first.split(/\s+/).slice(0, 6).join(' ')
    return words.length > 48 ? words.slice(0, 48) : words
  }

  private recentTailText(): string {
    return this.tail.map((l) => l.text).join('\n')
  }

  // Cleanup emits one idea per line; split on newlines and strip bullet markers.
  private splitLines(text: string): string[] {
    return text
      .split('\n')
      .map((l) => l.replace(/^[\s\-*•·]+/, '').trim())
      .filter((l) => l.length > 0)
  }

  private isMeaningfulChunk(raw: string): boolean {
    const cjkChars = (raw.match(/[一-鿿]/g) || []).length
    const words = (raw.replace(/[一-鿿]/g, ' ').match(/[A-Za-z0-9']+/g) || []).length
    return words >= this.config.minWords || cjkChars >= this.config.minCjkChars
  }
}
