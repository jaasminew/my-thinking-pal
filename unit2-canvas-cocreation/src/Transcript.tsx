import { useEffect, useRef, useState } from 'react'
import { SonioxSTT } from '../../services/stt/soniox'
import { getAudioStream } from '../../services/stt/audio-source'
import type { STTProvider } from '../../services/stt/types'
import { CleanupEngine } from './cleanup-engine'
import type { Line, Section, EngineStatus } from './cleanup-engine'

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

// The transcript handed to the AI: section headers + lines + the open tail.
function aiContext(frozen: Section[], tail: Line[]): string {
  const secs = frozen.map((s) => `${s.header}\n${s.lines.map((l) => l.text).join('\n')}`)
  const tailText = tail.map((l) => l.text).join('\n')
  return [...secs, tailText].join('\n\n').replace(/==/g, '').trim()
}

// Shallow snapshots so React sees new refs after the engine mutates in place.
const snapFrozen = (f: Section[]): Section[] => f.map((s) => ({ ...s, lines: s.lines.map((l) => ({ ...l })) }))
const snapTail = (t: Line[]): Line[] => t.map((l) => ({ ...l }))

type EditTarget = { kind: 'line'; lineId: string } | { kind: 'header'; sid: string } | null

export function Transcript({
  recording,
  onTranscriptChange
}: {
  recording: boolean
  onTranscriptChange?: (text: string) => void
}) {
  const [frozen, setFrozen] = useState<Section[]>([])
  const [tail, setTail] = useState<Line[]>([])
  const [status, setStatus] = useState<EngineStatus>('idle')
  const [err, setErr] = useState('')
  const [editing, setEditing] = useState<EditTarget>(null)
  const [draft, setDraft] = useState('')

  const engineRef = useRef<CleanupEngine | null>(null)
  const sttRef = useRef<STTProvider | null>(null)
  const scrollRef = useRef<HTMLElement | null>(null)
  const onChangeRef = useRef(onTranscriptChange)
  useEffect(() => {
    onChangeRef.current = onTranscriptChange
  }, [onTranscriptChange])

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
      onChangeRef.current?.(aiContext(engine.frozenSections, engine.tail))
    }
    engine.onStatus = (s) => setStatus(s)
    engine.onError = (msg) => setErr(`⚠ ${msg}`)
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
        stream = await getAudioStream('mic')
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
        if (ev.isFinal) engineRef.current?.pushFinal(ev.text)
        else engineRef.current?.pushInterim(ev.text)
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

  // Keep the newest content in view.
  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [frozen, tail, status])

  function startEdit(target: EditTarget, current: string) {
    setEditing(target)
    setDraft(current)
  }
  function commitEdit() {
    const t = editing
    const eng = engineRef.current
    if (t && eng) {
      if (t.kind === 'line') eng.editLine(t.lineId, draft)
      else eng.editHeader(t.sid, draft)
    }
    setEditing(null)
  }

  function renderHeader(sec: Section) {
    if (editing?.kind === 'header' && editing.sid === sec.id) {
      return (
        <input
          className="section-header-input"
          value={draft}
          autoFocus
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commitEdit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commitEdit()
            if (e.key === 'Escape') setEditing(null)
          }}
        />
      )
    }
    return (
      <h4
        className="section-header"
        title="Click to rename this section"
        onClick={() => startEdit({ kind: 'header', sid: sec.id }, sec.header)}
      >
        {sec.header}
      </h4>
    )
  }

  // A single idea line. Double-click to edit — single click / drag-select stays
  // free so any phrase can be selected and dragged onto the canvas. `open` = a
  // still-in-progress tail line (rendered fainter, not yet organized).
  function renderLine(line: Line, open: boolean) {
    if (editing?.kind === 'line' && editing.lineId === line.id) {
      return (
        <textarea
          key={line.id}
          className="block-edit"
          value={draft}
          autoFocus
          rows={Math.max(2, draft.split('\n').length)}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commitEdit}
          onKeyDown={(e) => {
            if (e.key === 'Escape') setEditing(null)
          }}
        />
      )
    }
    return (
      <div
        key={line.id}
        className={`clean-block${open ? ' tail' : ''}`}
        title="Double-click to edit"
        onDoubleClick={() => startEdit({ kind: 'line', lineId: line.id }, line.text)}
      >
        {cleanText(line.text)}
      </div>
    )
  }

  const hasContent = frozen.length > 0 || tail.length > 0
  const caption = STATUS_CAPTION[status]

  return (
    <aside className="transcript" ref={scrollRef}>
      <div className="hint">
        {recording
          ? 'Speak freely — thoughts are cleaned and organized into sections as you go. Select any text and drag it onto the canvas. Double-click a line to edit, click a header to rename.'
          : 'Press ● (bottom of the canvas) to start capture. Speech is cleaned and grouped into titled sections.'}
      </div>

      {frozen.map((sec) => (
        <section className="tsection" key={sec.id}>
          {renderHeader(sec)}
          {sec.lines.map((l) => renderLine(l, false))}
        </section>
      ))}

      {tail.length > 0 && (
        <section className="tsection open">
          {tail.map((l) => renderLine(l, true))}
        </section>
      )}

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
