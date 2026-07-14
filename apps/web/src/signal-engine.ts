import { requestExtractSignals, requestOrganize } from '../../../services/llm/client'
import type { SignalType, OrganizeSection } from '../../../services/llm/types'

// Two-tier pending-signals engine.
//
// Live speech never enters the surface directly (the Wispr-Flow lesson: raw
// realtime voice pollutes the workspace). Instead the transcript pane shows a
// queue of PENDING SIGNALS that crystallizes in two decoupled passes:
//
//  1. Extraction (every 2min): a thinking model reads the raw speech window and
//     keeps ONLY highlights — the rare statements that change how the reader
//     thinks (judgment, objection, example, decision) — discarding everything
//     that merely records the conversation: greetings, logistics, questions,
//     hedges, small talk. A quality filter, not a summarizer: most windows
//     yield zero or one highlight, and an empty window is a correct result.
//     Types and speakers are recorded on each line but never rendered; they
//     feed co-creation as personalization context.
//  2. Organize (every 5min + on stop): a thinking model groups the pending
//     signals into titled sections and may MERGE/REWORD them — but only while
//     they are pending. Once organized, a section is frozen for good, and lines
//     the user hand-edited are never reworded (only regrouped).

export interface Line {
  id: string
  text: string
  /** When the raw speech behind this line was spoken (start of its extraction window). */
  ts: number
  /** Signal classification — recorded and fed to co-creation, never rendered. */
  type?: SignalType
  /** Diarized speaker tag ('S1', 'S2', …) when STT identifies one. */
  speaker?: string
  /** Hand-edited by the user: the organize pass may regroup but never reword it. */
  userEdited?: boolean
}

export interface Section {
  id: string
  header: string
  lines: Line[]
}

export interface SignalEngineConfig {
  provider: string
  /**
   * Backend for the organize pass. Read live in runOrganize so flipping the
   * model mid-session takes effect.
   */
  organizeProvider: string
  /** thinking model for the signal-extraction pass (Groq) */
  extractModel?: string
  /** thinking model for the async organize pass (Groq only) */
  organizeModel?: string
  /** Live Listener assignment for hosted/BYOK resolution (read each pass). */
  listenerAssignment?: () => import('../../../services/llm/model-roles').CategoryAssignment | undefined
  systemPrompt: string
  /** how often the raw buffer is distilled into pending signals */
  extractIntervalMs: number
  /** how often the pending queue is organized into frozen sections */
  organizeIntervalMs: number
  /** skip a near-empty extraction window: need this many latin words OR cjk chars */
  minWords: number
  minCjkChars: number
}

export type EngineStatus = 'idle' | 'listening' | 'extracting' | 'organizing'

// When the organize pass merges lines, the merged line keeps the STRONGEST
// source type — an example folded into a decision reads as the decision.
const TYPE_RANK: Record<SignalType, number> = {
  decision: 4,
  objection: 3,
  judgment: 2,
  example: 1
}

let _seq = 0
const uid = (p: string) => `${p}${Date.now().toString(36)}${(_seq++).toString(36)}`

export class SignalEngine {
  frozenSections: Section[] = []
  tail: Line[] = []
  config: SignalEngineConfig

  onRender: () => void = () => {}
  onStatus: (s: EngineStatus) => void = () => {}
  onError: (msg: string) => void = () => {}
  /** Fired with each batch of freshly extracted signals (for the co-creation log). */
  onSignals: (lines: Line[]) => void = () => {}

  private pendingRaw = ''
  private pendingRawStartTs: number | undefined // when the current raw window began
  private lastRawSpeaker: string | undefined // last [S?] tag written into pendingRaw
  private extractTimer: number | undefined
  private organizeTimer: number | undefined
  private extracting = false
  private organizing = false
  private running = false
  private gen = 0 // bumped on reset so late async results can't write stale state

  constructor(config: SignalEngineConfig) {
    this.config = config
  }

  start() {
    this.running = true
    clearInterval(this.extractTimer)
    clearInterval(this.organizeTimer)
    this.extractTimer = window.setInterval(() => void this.runExtract(false), this.config.extractIntervalMs)
    this.organizeTimer = window.setInterval(() => void this.runOrganize(false), this.config.organizeIntervalMs)
    this.setStatus('listening')
  }

  // Final flush on stop: extract whatever raw is left, then a closing organize
  // pass that sections EVERY remaining signal so nothing ends up untitled.
  async stop() {
    this.running = false
    clearInterval(this.extractTimer)
    clearInterval(this.organizeTimer)
    await this.runExtract(true)
    await this.runOrganize(true)
    this.setStatus('idle')
  }

  reset() {
    this.resetCapture()
    this.frozenSections = []
    this.tail = []
  }

  /** Start a fresh audio-capture session without erasing highlights produced by
   *  earlier sessions. This also invalidates any in-flight closing pass from
   *  the previous session, so a late response cannot overwrite new speech. */
  resetCapture() {
    clearInterval(this.extractTimer)
    clearInterval(this.organizeTimer)
    this.gen++
    this.pendingRaw = ''
    this.pendingRawStartTs = undefined
    this.lastRawSpeaker = undefined
    this.extracting = false
    this.organizing = false
    this.running = false
  }

  pushFinal(text: string, speaker?: string) {
    const chunk = text.trim()
    if (!chunk) return
    if (!this.pendingRaw) this.pendingRawStartTs = Date.now()
    // Inline speaker tags on turn change, so the extraction model can attribute
    // signals ("[S1] I think we should ship. [S2] I'm not sure about that.").
    const tag = speaker && speaker !== this.lastRawSpeaker ? `[${speaker}] ` : ''
    if (speaker) this.lastRawSpeaker = speaker
    this.pendingRaw += (this.pendingRaw ? ' ' : '') + tag + chunk
  }

  // Raw interim STT does not enter highlights. Transcript.tsx shows it in a
  // separate live strip for "system is listening" feedback.
  pushInterim(_text: string) {}

  // --- user edits: a hand-edited line is LOCKED — the organize pass may regroup
  // it but never reword it, so corrections can't silently un-correct. ---
  editLine(lineId: string, text: string) {
    for (const s of this.frozenSections) {
      const ln = s.lines.find((l) => l.id === lineId)
      if (ln) {
        ln.text = text
        ln.userEdited = true
        this.onRender()
        return
      }
    }
    const t = this.tail.find((l) => l.id === lineId)
    if (t) {
      t.text = text
      t.userEdited = true
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

  /** Apply a whole-section edit (contentEditable blur). Entries arrive in DOM
   *  order; ones carrying a known line id keep that line's ts/type/speaker, and
   *  changed or new lines are marked userEdited. An emptied frozen section is
   *  removed. `sectionId` null targets the open tail. */
  applyBlockEdit(sectionId: string | null, header: string | null, entries: { id?: string; text: string }[]) {
    const sec = sectionId ? this.frozenSections.find((s) => s.id === sectionId) : null
    if (sectionId && !sec) return
    const old = sec ? sec.lines : this.tail
    const byId = new Map(old.map((l) => [l.id, l]))
    const next: Line[] = []
    let lastTs = old[0]?.ts ?? Date.now()
    for (const e of entries) {
      const text = e.text.trim()
      if (!text) continue
      const existing = e.id ? byId.get(e.id) : undefined
      if (existing) {
        if (existing.text !== text) {
          existing.text = text
          existing.userEdited = true
        }
        next.push(existing)
        lastTs = existing.ts
      } else {
        next.push({ id: uid('l'), text, ts: lastTs, userEdited: true })
      }
    }
    if (sec) {
      sec.lines = next
      if (header != null && header.trim()) sec.header = header.trim()
      if (next.length === 0) this.frozenSections = this.frozenSections.filter((s) => s.id !== sec.id)
    } else {
      this.tail = next
    }
    this.onRender()
  }

  private setStatus(s: EngineStatus) {
    this.onStatus(s)
  }

  private idleStatus(): EngineStatus {
    return this.running ? 'listening' : 'idle'
  }

  // Extraction pass: raw window -> typed pending signals appended to the tail.
  // Precision-first: a parsed empty result DISCARDS the raw (correct output for
  // small talk); only transport/parse failures put the raw back for retry. The
  // verbatim speech is never lost from the system — it flows to the raw log
  // separately (onRawFinal in the Transcript component).
  private async runExtract(force: boolean) {
    const raw = this.pendingRaw.trim()
    if (!raw) return
    if (!force && !this.isMeaningfulChunk(raw)) return
    if (this.extracting) return

    const gen = this.gen
    const rawTs = this.pendingRawStartTs ?? Date.now()
    this.pendingRaw = ''
    this.pendingRawStartTs = undefined
    this.extracting = true
    this.setStatus('extracting')

    const res = await requestExtractSignals(
      {
        rawText: raw,
        existingSignals: this.recentTailText().slice(-1200),
        provider: this.config.provider,
        model: this.config.extractModel,
        systemPrompt: this.config.systemPrompt
      },
      { category: 'listener', assignment: this.config.listenerAssignment?.() }
    )

    if (gen !== this.gen) return
    this.extracting = false

    if (res.error || res.skipped) {
      // No usable output this round — put the raw back so no speech is lost; the
      // next tick retries during live capture. On a forced flush (stop), surface
      // the failure so a missing Listener key/config isn't silent empty UI.
      this.pendingRaw = raw + (this.pendingRaw ? ` ${this.pendingRaw}` : '')
      this.pendingRawStartTs = rawTs // restored raw is the oldest speech again
      if (force) {
        this.onError(
          res.error ||
            'Could not extract signals from the recording. Configure a Listener model with an API key in Settings.'
        )
      }
      this.setStatus(this.idleStatus())
      return
    }

    const fresh: Line[] = []
    for (const s of res.signals || []) {
      const text = (s.text || '').trim()
      if (!text) continue
      fresh.push({ id: uid('l'), text, ts: rawTs, type: s.type, speaker: s.speaker })
    }
    if (fresh.length) {
      this.tail.push(...fresh)
      this.onSignals(fresh)
      this.onRender()
    }
    this.setStatus(this.idleStatus())
  }

  // Organize pass: send the pending tail to the thinking model; it groups the
  // signals into titled sections and may merge/reword unlocked lines. Applied
  // sections are FROZEN — the model never touches them again.
  private async runOrganize(closing: boolean) {
    if (this.organizing) return
    if (this.tail.length === 0) return
    if (!closing && this.tail.length < 2) return

    const gen = this.gen
    this.organizing = true
    this.setStatus('organizing')

    const snapshot = this.tail.slice()
    const numbered = snapshot
      .map((l, i) => {
        const tags = `[${l.type || 'judgment'}]${l.userEdited ? ' [LOCKED]' : ''}`
        return `${i} ${tags}: ${l.text}`
      })
      .join('\n')

    const op = this.config.organizeProvider || this.config.provider
    const res = await requestOrganize(
      {
        lines: numbered,
        closing,
        provider: op,
        model: this.config.organizeModel
      },
      { category: 'listener', assignment: this.config.listenerAssignment?.() }
    )

    if (gen !== this.gen) return
    this.organizing = false

    // Organize errors (e.g. a CLI backend not set up) would otherwise no-op
    // silently every 5min — surface them so a misconfiguration is visible.
    if (res.error) this.onError(res.error)
    const secs = Array.isArray(res.sections) ? res.sections : []
    this.applyOrganize(snapshot, secs, closing)
    this.setStatus(this.idleStatus())
  }

  // Turn the model's sections (items referencing input lines by index, with
  // optional rewrites) into frozen sections. Robust to junk: out-of-range or
  // reused indices are dropped, locked lines keep their wording verbatim, and
  // any unclaimed line at or below the highest claimed index is emitted
  // verbatim in order — the model can merge signals, but never silently drop
  // one. Rewrites keep the earliest source ts (drag-anchoring) and the
  // strongest source type.
  private applyOrganize(snapshot: Line[], secs: OrganizeSection[], closing: boolean) {
    type PlacedItem = { firstSrc: number; line: Line; secIdx: number }
    const placed: PlacedItem[] = []
    const claimed = new Set<number>()
    const headers: string[] = []

    for (const sec of secs) {
      const header = (sec?.header || '').trim()
      const items = Array.isArray(sec?.items) ? sec.items : []
      if (!header || items.length === 0) continue
      const secIdx = headers.length
      let used = false
      for (const it of items) {
        const src = (Array.isArray(it?.src) ? it.src : [])
          .map((n) => Math.floor(Number(n)))
          .filter((n) => Number.isFinite(n) && n >= 0 && n < snapshot.length && !claimed.has(n))
          .sort((a, b) => a - b)
        if (src.length === 0) continue
        src.forEach((n) => claimed.add(n))
        const srcLines = src.map((n) => snapshot[n])
        const locked = srcLines.filter((l) => l.userEdited)
        const rewrite = typeof it.text === 'string' ? it.text.trim() : ''

        if (locked.length > 0 || !rewrite) {
          // Locked content (or no rewrite offered): keep every source line
          // verbatim, ids and all.
          srcLines.forEach((l, j) => placed.push({ firstSrc: src[j], line: l, secIdx }))
        } else {
          const strongest = srcLines.reduce<SignalType | undefined>(
            (best, l) => (l.type && (!best || TYPE_RANK[l.type] > TYPE_RANK[best]) ? l.type : best),
            undefined
          )
          placed.push({
            firstSrc: src[0],
            line: {
              id: src.length === 1 ? srcLines[0].id : uid('l'),
              text: rewrite,
              ts: Math.min(...srcLines.map((l) => l.ts)),
              type: strongest,
              speaker: srcLines[0].speaker
            },
            secIdx
          })
        }
        used = true
      }
      if (used) headers.push(header)
      // (a section whose every item was invalid contributes nothing)
    }

    if (placed.length === 0) {
      // No usable grouping this round. On a closing pass, still title the leftover.
      if (closing) this.freezeRemainder()
      this.onRender()
      return
    }

    // Everything up to the highest claimed index is being organized; unclaimed
    // lines in that range ride along verbatim, attached to the section of the
    // nearest preceding placed line (or the first section).
    const cutoff = closing ? snapshot.length - 1 : Math.max(...Array.from(claimed))
    placed.sort((a, b) => a.firstSrc - b.firstSrc)
    const bySection: Line[][] = headers.map(() => [])
    let p = 0
    let curSec = placed[0].secIdx
    for (let i = 0; i <= cutoff; i++) {
      if (p < placed.length && placed[p].firstSrc === i) {
        curSec = placed[p].secIdx
        bySection[curSec].push(placed[p].line)
        p++
      } else if (!claimed.has(i)) {
        bySection[curSec].push(snapshot[i])
      }
    }

    for (let s = 0; s < headers.length; s++) {
      if (bySection[s].length) {
        this.frozenSections.push({ id: uid('s'), header: headers[s], lines: bySection[s] })
      }
    }

    // Remove the covered prefix from the live tail. The tail may have grown
    // while the model was thinking (extraction only appends), so slice from
    // cutoff+1 to keep any lines added during the call.
    this.tail = this.tail.slice(cutoff + 1)

    if (closing) this.freezeRemainder()
    this.onRender()
  }

  // Closing fallback: if signals remain after organizing, freeze them under a
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
    return this.tail.map((l) => `[${l.type || 'judgment'}] ${l.text}`).join('\n')
  }

  private isMeaningfulChunk(raw: string): boolean {
    const cjkChars = (raw.match(/[一-鿿]/g) || []).length
    const words = (raw.replace(/[一-鿿]/g, ' ').match(/[A-Za-z0-9']+/g) || []).length
    return words >= this.config.minWords || cjkChars >= this.config.minCjkChars
  }
}
