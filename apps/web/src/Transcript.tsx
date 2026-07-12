import { useEffect, useRef, useState } from 'react'
import { SonioxSTT } from '../../../services/stt/soniox'
import { getAudioStream } from '../../../services/stt/audio-source'
import type { STTProvider } from '../../../services/stt/types'
import { SignalEngine } from './signal-engine'
import { formatProjectInstructions } from '../../../packages/core/llm'
import { isImeEvent } from './ime'
import type { Line, Section, EngineStatus } from './signal-engine'
import { loadJSON, saveJSON } from './persist'

// Extraction system prompt: distill a raw multi-speaker speech window into
// MEETING HIGHLIGHTS. This is a strict quality FILTER, not a summarizer — the
// selection criterion comes first (would this still matter later? does it
// change how you think?), and the type label is attached to what survives, as
// metadata for co-creation. Questions and hesitations are NOT highlights and
// are never kept. The server appends the strict JSON output contract.
const EXTRACT_PROMPT =
  `You distill a window of raw live STT from a meeting into MEETING HIGHLIGHTS — the very few ` +
  `statements that would still matter a week later. You are a strict quality filter, NOT a summarizer: ` +
  `do not record what was discussed; select the rare statements worth keeping. A typical 2-minute window ` +
  `yields ZERO, ONE, or TWO highlights — never more than three. An empty result is a normal, correct answer. ` +
  `KEEP a statement only if it changes how the reader thinks rather than informing them what happened. Prefer: ` +
  `universal insights over contextual remarks; counter-intuitive claims over common-sense confirmations; ` +
  `ways of thinking over isolated observations; transferable reasoning over idiosyncratic detail. ` +
  `Committed opinions, sharp disagreements, decisions, and concrete cases that prove a principle can qualify — ` +
  `IF they clear that bar. ` +
  `NEVER output a question — a question is not a highlight. Never output hedges, process talk, or anything ` +
  `that merely records the flow of conversation. Discard greetings, fillers, logistics, scheduling, jokes, ` +
  `back-channel agreement, restarts, and small talk entirely. ` +
  `Rewrite each kept highlight into ONE concise, polished, written-style sentence; do not preserve spoken wording. ` +
  `Label each with the kind of statement it is — "judgment" (a committed opinion or claim), "objection" ` +
  `(a disagreement with a position), "decision" (something settled), or "example" (a concrete case used as ` +
  `evidence). The label is metadata attached AFTER selection — never keep a weak statement just to fill a kind. ` +
  `Attribute the speaker tag ([S1]/[S2]…) the words came from. ` +
  `Do not add claims or conclusions beyond the raw input. Do not emit near-duplicates of already-extracted highlights. ` +
  `Never translate the user's speech into English by default. Write each highlight in the dominant language used in the audio ` +
  `(Chinese speech -> Chinese highlights, Spanish speech -> Spanish highlights, English speech -> English highlights); ` +
  `preserve code-switching only when the mix carries meaning.`

const STATUS_CAPTION: Record<EngineStatus, string> = {
  idle: '',
  listening: 'Listening…',
  extracting: 'Extracting…',
  organizing: 'Organizing…'
}

// Strip any stray markdown / leftover marks so raw formatting never leaks in.
function cleanText(t: string): string {
  return t.replace(/==/g, '').replace(/[*_`]/g, '').replace(/^#{1,6}\s+/gm, '')
}

// On a selection drag, find the first selected signal line and attach its
// spoken-at timestamp (so a dropped keyword note can anchor its ±1min verbatim
// transcript window, rule B) plus its signal type (so co-creation knows what
// KIND of thought the seed was — a decision, an objection…).
function attachDragTs(e: React.DragEvent) {
  const sel = window.getSelection()
  if (!sel || sel.rangeCount === 0) return
  const start = sel.getRangeAt(0).startContainer
  const el = start instanceof Element ? start : start.parentElement
  const block = el?.closest('[data-ts]')
  const ts = block?.getAttribute('data-ts')
  if (ts) e.dataTransfer.setData('application/x-transcript-ts', ts)
  const type = block?.getAttribute('data-signal-type')
  if (type) e.dataTransfer.setData('application/x-signal-type', type)
}

// Shallow snapshots so React sees new refs after the engine mutates in place.
const snapFrozen = (f: Section[]): Section[] => f.map((s) => ({ ...s, lines: s.lines.map((l) => ({ ...l })) }))
const snapTail = (t: Line[]): Line[] => t.map((l) => ({ ...l }))

type EditTarget = { kind: 'section'; sid: string } | { kind: 'tail' } | null

/** A dragged-out phrase to faintly mark in the transcript, linked to its note. */
export type Highlight = { noteId: string; ts: number; text: string }

/** Cross-device transcript sync seam, backed by the space's CRDT board.
 *  `read` returns null until the doc has ever carried a transcript; `observe`
 *  fires on REMOTE (and local-persistence load) changes only — never on our own
 *  writes — so the component can reflect a peer's recording without ping-pong. */
export interface TranscriptSync {
  read(): { frozen: Section[]; tail: Line[] } | null
  write(frozen: Section[], tail: Line[]): void
  observe(cb: () => void): () => void
}

export function Transcript({
  recording,
  onToggleRecord,
  onRawFinal,
  onSignals,
  organizeProvider = 'groq',
  summaryModel,
  storageSuffix = '',
  highlights = [],
  onHoverNote,
  makeStt,
  projectInstructions,
  transcriptSync,
  seedFromLocal = true
}: {
  recording: boolean
  onToggleRecord: () => void
  /** Every final verbatim STT segment, timestamped — feeds the AI context window. */
  onRawFinal?: (text: string, ts: number) => void
  /** Each batch of freshly extracted typed signals — feeds the co-creation signal log. */
  onSignals?: (lines: Line[]) => void
  /** Backend for the organize pass, following the global provider choice:
   *  'groq' | 'claude-code' | 'codex'. Extraction always stays on Groq. */
  organizeProvider?: string
  /** Model/provider choice used by extraction and organization. */
  summaryModel?: { providerId: string; model?: string }
  /** Per-idea-space persistence: '' keeps the original keys, '.<id>' scopes new spaces. */
  storageSuffix?: string
  /** Phrases already dragged onto the canvas — each gets a faint orange mark. */
  highlights?: Highlight[]
  /** Hovering a marked phrase reports its note id (null on leave) so the canvas
   *  can fade that note's header to orange. */
  onHoverNote?: (noteId: string | null) => void
  /** STT provider factory. Defaults to browser-direct Soniox; when signed in the
   *  app injects a backend-proxied provider (docs module 07). */
  makeStt?: () => STTProvider | Promise<STTProvider>
  /** Project Memory: the scope's transcriptionSummary instructions, appended to
   *  the extraction system prompt (knowledge excerpts are deliberately NOT
   *  injected here — bias/latency risk). */
  projectInstructions?: string
  /** Cross-device transcript sync (present only when signed in + this space is
   *  bound to a server document). Absent → local-only, as before. */
  transcriptSync?: TranscriptSync
  /** Adopting an existing server doc (false) means the doc — not this device's
   *  local transcript — is the source of truth: an empty remote clears local. */
  seedFromLocal?: boolean
}) {
  const collapseKey = `transcript-collapsed${storageSuffix}`
  const [collapsed, setCollapsed] = useState(() => loadJSON(collapseKey, false))

  useEffect(() => saveJSON(collapseKey, collapsed), [collapseKey, collapsed])
  const k = (key: string) => key + storageSuffix
  // Restored from localStorage so the cleaned transcript survives refreshes.
  // New recording sessions append to this content instead of replacing it.
  const [frozen, setFrozen] = useState<Section[]>(() => loadJSON(k('transcript-frozen'), []))
  const [tail, setTail] = useState<Line[]>(() => loadJSON(k('transcript-tail'), []))
  const [status, setStatus] = useState<EngineStatus>('idle')
  const [err, setErr] = useState('')
  const [editing, setEditing] = useState<EditTarget>(null)
  // Bumped when an edit ends so the section remounts and React re-owns the DOM
  // the browser mutated while it was contentEditable.
  const [editEpoch, setEditEpoch] = useState(0)
  const cancelEditRef = useRef(false)
  const editElRef = useRef<HTMLElement | null>(null)

  const engineRef = useRef<SignalEngine | null>(null)
  const sttRef = useRef<STTProvider | null>(null)
  const scrollRef = useRef<HTMLElement | null>(null)
  const onRawFinalRef = useRef(onRawFinal)
  useEffect(() => {
    onRawFinalRef.current = onRawFinal
  }, [onRawFinal])
  const onSignalsRef = useRef(onSignals)
  useEffect(() => {
    onSignalsRef.current = onSignals
  }, [onSignals])
  const summaryModelRef = useRef(summaryModel)
  useEffect(() => {
    summaryModelRef.current = summaryModel
  }, [summaryModel])
  const projectInstructionsRef = useRef(projectInstructions)
  useEffect(() => {
    projectInstructionsRef.current = projectInstructions
  }, [projectInstructions])
  // Latest values read inside the CRDT sync callbacks without re-subscribing.
  const frozenRef = useRef(frozen)
  frozenRef.current = frozen
  const tailRef = useRef(tail)
  tailRef.current = tail
  const recordingRef = useRef(recording)
  recordingRef.current = recording
  // Set right before we apply a peer's transcript so the autosave below mirrors
  // it to localStorage but does NOT echo it back to the board (ping-pong guard).
  const remoteTranscriptRef = useRef(false)

  // One engine for the component's life. Extraction (2min) distills raw speech
  // into typed pending signals appended to the tail; the organize pass (5min +
  // on stop) freezes them into titled sections. Both are thinking-model tasks.
  useEffect(() => {
    const engine = new SignalEngine({
      provider: summaryModelRef.current?.providerId || 'groq',
      organizeProvider: summaryModelRef.current?.providerId || organizeProvider,
      extractModel: summaryModelRef.current?.model || 'openai/gpt-oss-120b',
      organizeModel: summaryModelRef.current?.model || 'openai/gpt-oss-120b',
      systemPrompt: EXTRACT_PROMPT + formatProjectInstructions(projectInstructionsRef.current),
      extractIntervalMs: 120000,
      organizeIntervalMs: 300000,
      minWords: 8,
      minCjkChars: 8
    })
    engine.onRender = () => {
      setFrozen(snapFrozen(engine.frozenSections))
      setTail(snapTail(engine.tail))
    }
    engine.onStatus = (s) => setStatus(s)
    engine.onError = (msg) => setErr(`⚠ ${msg}`)
    engine.onSignals = (lines) => onSignalsRef.current?.(lines)
    // Seed the engine with the restored transcript so editing a restored line
    // or header still works and later recording sessions can append to it.
    engine.frozenSections = snapFrozen(frozen)
    engine.tail = snapTail(tail)
    engineRef.current = engine
    return () => engine.reset()
  }, [])

  // Keep the organize backend in sync with the global provider choice (the
  // engine lives across renders, so flipping the button mid-session applies to
  // the next organize round).
  useEffect(() => {
    if (!engineRef.current) return
    engineRef.current.config.provider = summaryModel?.providerId || 'groq'
    engineRef.current.config.organizeProvider = summaryModel?.providerId || organizeProvider
    engineRef.current.config.extractModel = summaryModel?.model || 'openai/gpt-oss-120b'
    engineRef.current.config.organizeModel = summaryModel?.model || 'openai/gpt-oss-120b'
  }, [organizeProvider, summaryModel])

  // Project Memory: keep the extraction prompt in sync when the scope's
  // transcription instructions change (applies from the next extract round).
  useEffect(() => {
    if (!engineRef.current) return
    engineRef.current.config.systemPrompt = EXTRACT_PROMPT + formatProjectInstructions(projectInstructions)
  }, [projectInstructions])

  // Start/stop live capture from Unit 2's existing record button (App.recording).
  useEffect(() => {
    if (!recording) return
    let cancelled = false

    void (async () => {
      engineRef.current?.resetCapture()
      setEditing(null)
      setErr('')
      engineRef.current?.start()

      let stream: MediaStream
      try {
        stream = await getAudioStream('both')
      } catch (e: any) {
        setErr(`⚠ ${e.message}`)
        return
      }
      if (cancelled) {
        stream.getTracks().forEach((t) => t.stop())
        return
      }

      let stt: STTProvider
      try {
        stt = makeStt ? await makeStt() : new SonioxSTT()
      } catch (e: any) {
        stream.getTracks().forEach((t) => t.stop())
        if (!cancelled) setErr(`⚠ ${e.message}`)
        return
      }
      if (cancelled) {
        stream.getTracks().forEach((t) => t.stop())
        return
      }
      sttRef.current = stt
      stt.onError((e) => setErr(`⚠ ${e.message}`))
      stt.onTranscript((ev) => {
        if (ev.isFinal) {
          engineRef.current?.pushFinal(ev.text, ev.speaker)
          if (ev.text.trim()) onRawFinalRef.current?.(ev.text.trim(), Date.now())
        } else engineRef.current?.pushInterim(ev.text)
      })
      try {
        await stt.start({ lang: 'auto', stream })
      } catch (e: any) {
        if (!cancelled) setErr(`⚠ ${e.message}`)
      }
    })()

    return () => {
      cancelled = true
      const stopping = sttRef.current?.stop()
      sttRef.current = null
      // Backend STT may receive a provider's final transcript only after its
      // stop frame. Wait for that graceful close before extracting/organizing.
      void Promise.resolve(stopping).finally(() => engineRef.current?.stop())
    }
  }, [recording])

  // Autosave the cleaned transcript (debounced — it re-renders per STT chunk).
  // localStorage stays the local mirror; when this space is synced, the same
  // debounce pushes the transcript into the CRDT board so peers see it too. A
  // change that arrived FROM a peer is mirrored locally but not echoed back.
  useEffect(() => {
    const t = setTimeout(() => {
      saveJSON(k('transcript-frozen'), frozen)
      saveJSON(k('transcript-tail'), tail)
      if (remoteTranscriptRef.current) remoteTranscriptRef.current = false
      else transcriptSync?.write(frozen, tail)
    }, 300)
    return () => clearTimeout(t)
  }, [frozen, tail, transcriptSync])

  // Cross-device transcript: reflect a peer's recording (or this device's own
  // IndexedDB-restored transcript for a bound doc) into the view + engine. Our
  // own writes carry a 'local' origin and never reach here. While THIS device is
  // recording we ignore inbound transcript so a peer can't clobber the live pass.
  useEffect(() => {
    if (!transcriptSync) return
    const apply = () => {
      const remote = transcriptSync.read()
      if (remote == null) {
        // Doc never carried a transcript. Seed it from our local content when
        // we own the seed; when adopting an existing doc, an empty remote means
        // start clean (mirror how the canvas adopts a server doc).
        if (recordingRef.current) return
        if (seedFromLocal) {
          if (frozenRef.current.length || tailRef.current.length)
            transcriptSync.write(frozenRef.current, tailRef.current)
        } else if (frozenRef.current.length || tailRef.current.length) {
          remoteTranscriptRef.current = true
          setFrozen([])
          setTail([])
          if (engineRef.current) {
            engineRef.current.frozenSections = []
            engineRef.current.tail = []
          }
        }
        return
      }
      if (recordingRef.current) return
      const f = snapFrozen(remote.frozen)
      const tl = snapTail(remote.tail)
      remoteTranscriptRef.current = true
      setFrozen(f)
      setTail(tl)
      if (engineRef.current) {
        engineRef.current.frozenSections = snapFrozen(f)
        engineRef.current.tail = snapTail(tl)
      }
    }
    const off = transcriptSync.observe(apply)
    apply() // pick up whatever is already loaded / seed on first attach
    return off
  }, [transcriptSync, seedFromLocal])

  // Keep the newest content in view.
  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [frozen, tail, status])

  // Focus the section once it turns contentEditable so the caret starts blinking
  // right where the user double-clicked (the browser keeps that selection).
  useEffect(() => {
    if (editing && editElRef.current) editElRef.current.focus()
  }, [editing])

  // Read the edited DOM back into the engine: the header (if any) plus every
  // line block in order. Blocks the browser cloned on Enter can carry a
  // duplicate line id — only the first occurrence keeps it, the rest count as
  // new lines.
  function commitSectionEdit(el: HTMLElement, target: Exclude<EditTarget, null>) {
    const eng = engineRef.current
    if (eng) {
      const header = target.kind === 'section' ? (el.querySelector('.section-header')?.textContent ?? null) : null
      const seen = new Set<string>()
      const entries = Array.from(el.querySelectorAll<HTMLElement>('.clean-block')).map((b) => {
        const id = b.dataset.lineId
        const text = b.textContent ?? ''
        if (id && !seen.has(id)) {
          seen.add(id)
          return { id, text }
        }
        return { text }
      })
      eng.applyBlockEdit(target.kind === 'section' ? target.sid : null, header, entries)
    }
    endEdit()
  }
  function endEdit() {
    setEditing(null)
    setEditEpoch((n) => n + 1)
  }

  // Split a cleaned line into plain text + faintly-marked spans for every
  // dragged-out phrase anchored to this line (matched by the line's ts, then by
  // substring). Overlaps are skipped; unmatched phrases (line edited since the
  // drag) simply don't mark. Hovering a mark links back to its note.
  function renderLineText(text: string, lineTs: number) {
    const hits = highlights
      .filter((h) => h.ts === lineTs && h.text)
      .map((h) => ({ ...h, at: text.indexOf(h.text) }))
      .filter((h) => h.at >= 0)
      .sort((a, b) => a.at - b.at)
    if (hits.length === 0) return text

    const out: React.ReactNode[] = []
    let cursor = 0
    for (const h of hits) {
      if (h.at < cursor) continue // overlaps a previous mark — skip
      if (h.at > cursor) out.push(text.slice(cursor, h.at))
      out.push(
        <mark
          key={h.noteId}
          className="kw-hl"
          onMouseEnter={() => onHoverNote?.(h.noteId)}
          onMouseLeave={() => onHoverNote?.(null)}
        >
          {text.slice(h.at, h.at + h.text.length)}
        </mark>
      )
      cursor = h.at + h.text.length
    }
    if (cursor < text.length) out.push(text.slice(cursor))
    return out
  }

  // A single idea line. Plain text — single click / drag-select stays free so
  // any phrase can be selected and dragged onto the canvas. `open` = a
  // still-in-progress tail line (rendered fainter, not yet organized).
  function renderLine(line: Line, open: boolean) {
    return (
      <div
        key={line.id}
        className={`clean-block${open ? ' tail' : ''}`}
        data-ts={line.ts}
        data-line-id={line.id}
        data-signal-type={line.type}
      >
        {renderLineText(cleanText(line.text), line.ts)}
      </div>
    )
  }

  // A section reads as one text block. Double-click makes the whole section
  // (header + lines) contentEditable in place — same layout, text turns from
  // gray to ink with a live caret. Blur commits, Escape discards. `sec` null =
  // the open tail.
  function renderSection(sec: Section | null, lines: Line[]) {
    const target: Exclude<EditTarget, null> = sec ? { kind: 'section', sid: sec.id } : { kind: 'tail' }
    const isEditing =
      sec ? editing?.kind === 'section' && editing.sid === sec.id : editing?.kind === 'tail'
    return (
      <section
        key={`${sec ? sec.id : 'tail'}:${editEpoch}`}
        className={`tsection${sec ? '' : ' open'}${isEditing ? ' editing' : ''}`}
        ref={isEditing ? (el) => (editElRef.current = el) : undefined}
        contentEditable={isEditing}
        suppressContentEditableWarning
        onDoubleClick={() => {
          if (!isEditing) {
            cancelEditRef.current = false
            setEditing(target)
          }
        }}
        onBlur={(e) => {
          if (!isEditing) return
          if (e.currentTarget.contains(e.relatedTarget as Node)) return
          if (cancelEditRef.current) endEdit()
          else commitSectionEdit(e.currentTarget, target)
        }}
        onKeyDown={(e) => {
          if (!isEditing || isImeEvent(e)) return
          if (e.key === 'Escape') {
            cancelEditRef.current = true
            e.currentTarget.blur()
          }
        }}
      >
        {sec && <h4 className="section-header">{sec.header}</h4>}
        {lines.map((l) => renderLine(l, !sec))}
      </section>
    )
  }

  const hasContent = frozen.length > 0 || tail.length > 0
  const caption = STATUS_CAPTION[status]

  const onRecordClick = () => {
    if (collapsed) {
      setCollapsed(false)
      if (!recording) onToggleRecord()
      return
    }
    onToggleRecord()
  }

  return (
    <div className={`transcript-pane${collapsed ? ' collapsed' : ''}`}>
      <button
        className="transcript-collapse"
        type="button"
        aria-label={collapsed ? 'Expand transcription' : 'Collapse transcription'}
        title={collapsed ? 'Expand transcription' : 'Collapse transcription'}
        aria-expanded={!collapsed}
        onClick={() => setCollapsed((value) => !value)}
      >
        {collapsed ? '›' : '‹'}
      </button>
      <aside className="transcript" ref={scrollRef} onDragStart={attachDragTs}>
        <div className="hint">
          {recording
            ? 'Speak freely — key signals are distilled from the conversation and organized into sections as you go. Select any text and drag it onto the canvas. Double-click a section to edit it.'
            : ''}
        </div>

        {frozen.map((sec) => renderSection(sec, sec.lines))}

        {tail.length > 0 && renderSection(null, tail)}

        {!hasContent && (
          <div className="placeholder">
            {recording
              ? 'Listening… key signals from the conversation will appear here every couple of minutes.'
              : 'Press ●, allow the mic, and start talking. Key signals — judgments, questions, decisions — appear here, organized into sections.'}
          </div>
        )}

        {caption && <div className="status-caption ai-thinking">{caption}</div>}
        {err && <div className="placeholder err">{err}</div>}
      </aside>

      {/* Recording control: bottom-center of the transcript pane, on a white
          gradient (solid at the bottom, fading to transparent) so it reads
          clearly over scrolled-up text without a hard edge. */}
      <div className="transcript-record-dock">
        <button
          className={`record ${recording ? 'on' : ''}`}
          title={recording ? 'Stop recording' : 'Start recording'}
          onClick={onRecordClick}
        >
          {collapsed && <span className="record-label">Record</span>}
          {recording ? <span className="stop-sq" /> : <span className="rec-dot" />}
        </button>
      </div>
    </div>
  )
}
