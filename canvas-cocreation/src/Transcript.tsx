import { useEffect, useRef, useState } from 'react'
import { SonioxSTT } from '../../services/stt/soniox'
import { getAudioStream } from '../../services/stt/audio-source'
import type { STTProvider } from '../../services/stt/types'
import { CleanupEngine } from './cleanup-engine'
import { isImeEvent } from './ime'
import type { Line, Section, EngineStatus } from './cleanup-engine'
import { loadJSON, saveJSON } from './persist'

// Cleanup system prompt: turn rough live STT into concise, written-style thinking
// notes — one idea per line. No highlight marks anymore; structure comes from the
// async segmentation pass, and any transcript text is drag-selectable to the canvas.
const CLEANUP_PROMPT =
  `You turn rough live STT from a brainstorming session into concise structured thinking notes. ` +
  `Do NOT preserve the speaker's wording. Remove fillers, hedges, repeated starts, and conversational phrasing. ` +
  `Rewrite freely into polished, written language while preserving only the user's actual meaning. ` +
  `Match the user's language. If the user mainly speaks Chinese, write Chinese. If they mainly speak English, write English. ` +
  `If they code-switch, preserve that mix only when the mixed wording carries meaning; otherwise use the dominant language. ` +
  `Output one complete idea per line. Do not create keyword-only fragments. Do not repeat the same idea in Chinese and English. ` +
  `If two fragments mean the same thing, merge them into one line. ` +
  `Do not add new claims, examples, or conclusions beyond the raw input. ` +
  `Never use Markdown: no **bold**, no *italics*, no # headings, no backticks, no ==marks==. Plain text lines only.`

const STATUS_CAPTION: Record<EngineStatus, string> = {
  idle: '',
  listening: 'Listening…',
  summarizing: 'Summarizing…',
  organizing: 'Organizing…'
}

// Strip any stray markdown / leftover marks so raw formatting never leaks in.
function cleanText(t: string): string {
  return t.replace(/==/g, '').replace(/[*_`]/g, '').replace(/^#{1,6}\s+/gm, '')
}

// On a selection drag, find the first selected cleaned line and attach its
// spoken-at timestamp, so a dropped keyword note can anchor its ±1min verbatim
// transcript window (rule B) to when the idea was actually said.
function attachDragTs(e: React.DragEvent) {
  const sel = window.getSelection()
  if (!sel || sel.rangeCount === 0) return
  const start = sel.getRangeAt(0).startContainer
  const el = start instanceof Element ? start : start.parentElement
  const ts = el?.closest('[data-ts]')?.getAttribute('data-ts')
  if (ts) e.dataTransfer.setData('application/x-transcript-ts', ts)
}

// Shallow snapshots so React sees new refs after the engine mutates in place.
const snapFrozen = (f: Section[]): Section[] => f.map((s) => ({ ...s, lines: s.lines.map((l) => ({ ...l })) }))
const snapTail = (t: Line[]): Line[] => t.map((l) => ({ ...l }))

type EditTarget = { kind: 'section'; sid: string } | { kind: 'tail' } | null

/** A dragged-out phrase to faintly mark in the transcript, linked to its note. */
export type Highlight = { noteId: string; ts: number; text: string }

export function Transcript({
  recording,
  onRawFinal,
  storageSuffix = '',
  highlights = [],
  onHoverNote
}: {
  recording: boolean
  /** Every final verbatim STT segment, timestamped — feeds the AI context window. */
  onRawFinal?: (text: string, ts: number) => void
  /** Per-idea-space persistence: '' keeps the original keys, '.<id>' scopes new spaces. */
  storageSuffix?: string
  /** Phrases already dragged onto the canvas — each gets a faint orange mark. */
  highlights?: Highlight[]
  /** Hovering a marked phrase reports its note id (null on leave) so the canvas
   *  can fade that note's header to orange. */
  onHoverNote?: (noteId: string | null) => void
}) {
  const k = (key: string) => key + storageSuffix
  // Restored from localStorage so the cleaned transcript survives refreshes;
  // starting a NEW recording still resets it (existing semantics).
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

  const engineRef = useRef<CleanupEngine | null>(null)
  const sttRef = useRef<STTProvider | null>(null)
  const scrollRef = useRef<HTMLElement | null>(null)
  const onRawFinalRef = useRef(onRawFinal)
  useEffect(() => {
    onRawFinalRef.current = onRawFinal
  }, [onRawFinal])

  // One engine for the component's life. Cleanup (30s) appends idea lines to the
  // tail; segmentation (2min + on stop) freezes them into titled sections.
  useEffect(() => {
    const engine = new CleanupEngine({
      provider: 'groq',
      cleanupModel: 'openai/gpt-oss-20b',
      segmentModel: 'openai/gpt-oss-120b',
      systemPrompt: CLEANUP_PROMPT,
      cleanupIntervalMs: 30000,
      segmentIntervalMs: 120000,
      minWords: 8,
      minCjkChars: 8
    })
    engine.onRender = () => {
      setFrozen(snapFrozen(engine.frozenSections))
      setTail(snapTail(engine.tail))
    }
    engine.onStatus = (s) => setStatus(s)
    engine.onError = (msg) => setErr(`⚠ ${msg}`)
    // Seed the engine with the restored transcript so editing a restored line
    // or header still works. A new recording resets this, as before.
    engine.frozenSections = snapFrozen(frozen)
    engine.tail = snapTail(tail)
    engineRef.current = engine
    return () => engine.reset()
  }, [])

  // Start/stop live capture from Unit 2's existing record button (App.recording).
  useEffect(() => {
    if (!recording) return
    let cancelled = false

    void (async () => {
      engineRef.current?.reset()
      setEditing(null)
      setErr('')
      setFrozen([])
      setTail([])
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

      const stt = new SonioxSTT()
      sttRef.current = stt
      stt.onError((e) => setErr(`⚠ ${e.message}`))
      stt.onTranscript((ev) => {
        if (ev.isFinal) {
          engineRef.current?.pushFinal(ev.text)
          if (ev.text.trim()) onRawFinalRef.current?.(ev.text.trim(), Date.now())
        } else engineRef.current?.pushInterim(ev.text)
      })
      try {
        await stt.start({ lang: 'en-US', stream })
      } catch (e: any) {
        setErr(`⚠ ${e.message}`)
      }
    })()

    return () => {
      cancelled = true
      sttRef.current?.stop()
      sttRef.current = null
      void engineRef.current?.stop() // final cleanup + closing segmentation pass
    }
  }, [recording])

  // Autosave the cleaned transcript (debounced — it re-renders per STT chunk).
  useEffect(() => {
    const t = setTimeout(() => {
      saveJSON(k('transcript-frozen'), frozen)
      saveJSON(k('transcript-tail'), tail)
    }, 300)
    return () => clearTimeout(t)
  }, [frozen, tail])

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

  return (
    <aside className="transcript" ref={scrollRef} onDragStart={attachDragTs}>
      <div className="hint">
        {recording
          ? 'Speak freely — thoughts are cleaned and organized into sections as you go. Select any text and drag it onto the canvas. Double-click a section to edit it.'
          : ''}
      </div>

      {frozen.map((sec) => renderSection(sec, sec.lines))}

      {tail.length > 0 && renderSection(null, tail)}

      {!hasContent && (
        <div className="placeholder">
          {recording
            ? 'Listening… cleaned thoughts will appear here after a few seconds.'
            : 'Press ●, allow the mic, and start speaking. Cleaned, sectioned notes appear here.'}
        </div>
      )}

      {caption && <div className="status-caption">{caption}</div>}
      {err && <div className="placeholder err">{err}</div>}
    </aside>
  )
}
