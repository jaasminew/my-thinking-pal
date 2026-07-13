import { useEffect, useRef, useState } from 'react'
import { SonioxSTT } from '../../../services/stt/soniox'
import { getAudioStream, stopAudioStream } from '../../../services/stt/audio-source'
import type { STTProvider } from '../../../services/stt/types'
import { SignalEngine } from './signal-engine'
import { formatProjectInstructions } from '../../../packages/core/llm'
import { isImeEvent } from './ime'
import type { Line, Section, EngineStatus } from './signal-engine'
import { loadJSON, saveJSON } from './persist'
import { useLocale } from './locale'

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
type CaptureState = 'idle' | 'connecting' | 'live' | 'degraded' | 'reconnecting' | 'error'
type CaptureIssue =
  | 'permission'
  | 'no-mic'
  | 'mic-busy'
  | 'tab-cancelled'
  | 'tab-missing'
  | 'tab-unsupported'
  | 'tab-ended'
  | 'mic-reconnecting'
  | 'connection-lost'
  | 'server-unreachable'
  | 'transcription-error'
  | 'stall'
  | 'signed-out'
  | 'dev-key'
  | 'account'
  | 'silence'

function mediaFailure(error: unknown): CaptureIssue {
  const name = error instanceof DOMException ? error.name : (error as { name?: string } | null)?.name
  if (name === 'NotAllowedError' || name === 'SecurityError') return 'permission'
  if (name === 'NotFoundError') return 'no-mic'
  if (name === 'NotReadableError' || name === 'OverconstrainedError') return 'mic-busy'
  return 'server-unreachable'
}

function providerFailure(error: Error): CaptureIssue {
  const msg = error.message
  if (/sign in/i.test(msg)) return 'signed-out'
  if (/No Soniox key/i.test(msg)) return 'dev-key'
  if (/auth|api.?key|quota|billing|credit|account|payment/i.test(msg)) return 'account'
  if (/socket|connect|closed|network|reach/i.test(msg)) return 'connection-lost'
  return 'transcription-error'
}

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
  seedFromLocal = true,
  onSignIn,
  sttBlocked = false
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
  /** Opens the app's authentication panel for a signed-out backend session. */
  onSignIn?: () => void
  /** Backend mode is configured but the current account session is signed out. */
  sttBlocked?: boolean
}) {
  const { tr, chinese } = useLocale()
  const collapseKey = `transcript-collapsed${storageSuffix}`
  const [collapsed, setCollapsed] = useState(() => loadJSON(collapseKey, false))

  useEffect(() => saveJSON(collapseKey, collapsed), [collapseKey, collapsed])
  const k = (key: string) => key + storageSuffix
  // Restored from localStorage so the cleaned transcript survives refreshes.
  // New recording sessions append to this content instead of replacing it.
  const [frozen, setFrozen] = useState<Section[]>(() => loadJSON(k('transcript-frozen'), []))
  const [tail, setTail] = useState<Line[]>(() => loadJSON(k('transcript-tail'), []))
  const [status, setStatus] = useState<EngineStatus>('idle')
  // True once THIS space has recorded at least once. Gates the post-stop "done"
  // line so a freshly-opened doc with restored highlights doesn't claim a
  // recording just ended. Per-space because <CanvasSpace> is keyed by id.
  const [everRecorded, setEverRecorded] = useState(false)
  const [err, setErr] = useState('')
  const [captureState, setCaptureState] = useState<CaptureState>('idle')
  const [captureIssue, setCaptureIssue] = useState<CaptureIssue | null>(null)
  const [captureDetail, setCaptureDetail] = useState('')
  const [captureAttempt, setCaptureAttempt] = useState(0)
  const captureIssueRef = useRef<CaptureIssue | null>(captureIssue)
  captureIssueRef.current = captureIssue
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
  const micReconnectDeadlineRef = useRef<number | null>(null)
  const lastTranscriptAtRef = useRef(Date.now())
  const lastAudibleAtRef = useRef(Date.now())
  const deviceChangedAtRef = useRef<number | null>(null)
  const micReconnectRef = useRef<() => void>(() => {})
  const suppressAudioEventsRef = useRef(false)
  const activeStreamRef = useRef<MediaStream | null>(null)
  const sharedDisplayRef = useRef<MediaStream | null>(null)
  const silenceDismissedRef = useRef(false)
  const silenceShownRef = useRef(false)

  useEffect(() => {
    if (sttBlocked) {
      setCaptureState('error')
      setCaptureIssue('signed-out')
    } else if (!recording) {
      setCaptureState('idle')
      setCaptureIssue((issue) => issue === 'signed-out' ? null : issue)
    }
  }, [sttBlocked, recording])

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

  // The transcript engine follows the user's overall recording session. Capture
  // retries below replace only the provider/stream, preserving engine content.
  useEffect(() => {
    if (!recording) return
    if (sttBlocked) {
      setCaptureState('error')
      setCaptureIssue('signed-out')
      return
    }
    setEverRecorded(true)
    silenceDismissedRef.current = false
    silenceShownRef.current = false
    engineRef.current?.resetCapture()
    setEditing(null)
    setErr('')
    engineRef.current?.start()
    return () => {
      void engineRef.current?.stop()
      setCaptureState('idle')
      setCaptureIssue(null)
      micReconnectDeadlineRef.current = null
    }
  }, [recording, sttBlocked])

  // Provider + browser audio supervisor. Bumping captureAttempt is a retry: it
  // tears down only this capture pass, never the transcript accumulated so far.
  useEffect(() => {
    if (!recording) return
    let cancelled = false
    let retryTimer: ReturnType<typeof setTimeout> | undefined
    let stream: MediaStream | undefined
    let degradedIssue: CaptureIssue | null = null
    let wasLive = false
    const sharedDisplay = sharedDisplayRef.current
    sharedDisplayRef.current = null
    suppressAudioEventsRef.current = false
    silenceShownRef.current = false
    setCaptureState('connecting')
    setCaptureIssue(null)
    setCaptureDetail('')
    lastTranscriptAtRef.current = Date.now()
    lastAudibleAtRef.current = Date.now()

    void (async () => {
      try {
        stream = await getAudioStream('both', {
          displayStream: sharedDisplay ?? undefined,
          onEvent: (event) => {
            if (cancelled || suppressAudioEventsRef.current) return
            if (event.type === 'mic-ended') micReconnectRef.current()
            if (event.type === 'tab-ended') {
              degradedIssue = 'tab-ended'
              setCaptureState('degraded')
              setCaptureIssue('tab-ended')
            }
            if (event.type === 'degraded') {
              degradedIssue = event.reason === 'tab-cancelled'
                ? 'tab-cancelled'
                : event.reason === 'tab-audio-unsupported'
                  ? 'tab-unsupported'
                  : 'tab-missing'
              setCaptureState('degraded')
              setCaptureIssue(degradedIssue)
            }
          }
        })
        activeStreamRef.current = stream
      } catch (e) {
        sharedDisplay?.getTracks().forEach((track) => track.stop())
        if (cancelled) return
        const issue = mediaFailure(e)
        if (issue === 'no-mic' && micReconnectDeadlineRef.current) {
          if (Date.now() < micReconnectDeadlineRef.current) {
            setCaptureState('reconnecting')
            setCaptureIssue('mic-reconnecting')
            retryTimer = setTimeout(() => setCaptureAttempt((n) => n + 1), 1000)
          } else {
            micReconnectDeadlineRef.current = null
            setCaptureState('error')
            setCaptureIssue('connection-lost')
          }
        } else {
          setCaptureState('error')
          setCaptureIssue(issue)
        }
        return
      }
      if (cancelled) {
        stopAudioStream(stream)
        return
      }
      const captureStream = stream

      let stt: STTProvider
      try {
        stt = makeStt ? await makeStt() : new SonioxSTT()
      } catch (e) {
        stopAudioStream(captureStream)
        if (!cancelled) {
          const error = e instanceof Error ? e : new Error(String(e))
          setCaptureState('error')
          setCaptureIssue(providerFailure(error))
          setCaptureDetail(error.message)
        }
        return
      }
      if (cancelled) {
        stopAudioStream(captureStream)
        return
      }
      sttRef.current = stt
      stt.onStatus((next) => {
        if (cancelled) return
        if (next.state === 'live') {
          wasLive = true
          micReconnectDeadlineRef.current = null
          setCaptureState(degradedIssue ? 'degraded' : 'live')
        } else setCaptureState(next.state)
      })
      stt.onAudioLevel?.((level) => {
        if (level > 0.008) {
          lastAudibleAtRef.current = Date.now()
          silenceDismissedRef.current = false
          if (silenceShownRef.current) {
            silenceShownRef.current = false
            setCaptureIssue((issue) => issue === 'silence' ? null : issue)
          }
        }
      })
      stt.onError((e) => {
        if (cancelled) return
        setCaptureState('error')
        const issue = providerFailure(e)
        setCaptureIssue(issue === 'connection-lost' && !wasLive ? 'server-unreachable' : issue)
        setCaptureDetail(e.message)
        suppressAudioEventsRef.current = true
        void stt.stop()
        stopAudioStream(captureStream)
      })
      stt.onTranscript((ev) => {
        lastTranscriptAtRef.current = Date.now()
        setCaptureIssue((current) => current === 'stall' ? null : current)
        if (ev.isFinal) {
          engineRef.current?.pushFinal(ev.text, ev.speaker)
          if (ev.text.trim()) onRawFinalRef.current?.(ev.text.trim(), Date.now())
        } else engineRef.current?.pushInterim(ev.text)
      })
      try {
        await stt.start({ lang: 'auto', stream: captureStream })
      } catch (e) {
        if (!cancelled) {
          const error = e instanceof Error ? e : new Error(String(e))
          setCaptureState('error')
          const issue = providerFailure(error)
          setCaptureIssue(issue === 'connection-lost' && !wasLive ? 'server-unreachable' : issue)
          setCaptureDetail(error.message)
          suppressAudioEventsRef.current = true
          void stt.stop()
          stopAudioStream(captureStream)
        }
      }
    })()

    micReconnectRef.current = () => {
      if (cancelled) return
      micReconnectDeadlineRef.current = Date.now() + 15_000
      setCaptureState('reconnecting')
      setCaptureIssue('mic-reconnecting')
      suppressAudioEventsRef.current = true
      void sttRef.current?.stop()
      if (activeStreamRef.current) stopAudioStream(activeStreamRef.current)
      retryTimer = setTimeout(() => setCaptureAttempt((n) => n + 1), 500)
    }

    return () => {
      cancelled = true
      if (retryTimer) clearTimeout(retryTimer)
      const active = sttRef.current
      const stopping = active?.stop()
      if (stream) stopAudioStream(stream)
      if (activeStreamRef.current === stream) activeStreamRef.current = null
      if (sttRef.current === active) sttRef.current = null
      void Promise.resolve(stopping)
    }
  }, [recording, captureAttempt, makeStt, sttBlocked])

  // A device change can precede a track's ended event. If it is followed by a
  // silent input, reacquire the default input; otherwise leave a healthy stream.
  useEffect(() => {
    if (!recording || !navigator.mediaDevices?.addEventListener) return
    const changed = () => {
      deviceChangedAtRef.current = Date.now()
      if (captureIssue === 'no-mic') setCaptureAttempt((n) => n + 1)
    }
    navigator.mediaDevices.addEventListener('devicechange', changed)
    return () => navigator.mediaDevices.removeEventListener('devicechange', changed)
  }, [recording, captureIssue])

  // Silence and provider-stall watchdogs run above both adapters. Silence is a
  // warning; a sustained audible stream with no transcript is restartable error.
  useEffect(() => {
    if (!recording) return
    const timer = setInterval(() => {
      if (captureState !== 'live' && captureState !== 'degraded') return
      const now = Date.now()
      if (deviceChangedAtRef.current && now - deviceChangedAtRef.current > 3000 &&
          now - lastAudibleAtRef.current > 3000) {
        deviceChangedAtRef.current = null
        micReconnectRef.current()
        return
      }
      if (now - lastAudibleAtRef.current > 10_000) {
        if (!captureIssueRef.current && !silenceDismissedRef.current && !silenceShownRef.current) {
          silenceShownRef.current = true
          setCaptureIssue('silence')
        }
      }
      if (now - lastTranscriptAtRef.current > 20_000 && now - lastAudibleAtRef.current < 2000) {
        setCaptureState('error')
        setCaptureIssue('stall')
        suppressAudioEventsRef.current = true
        void sttRef.current?.stop()
        if (activeStreamRef.current) stopAudioStream(activeStreamRef.current)
      }
    }, 1000)
    return () => clearInterval(timer)
  }, [recording, captureState])

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
  // Capture and signal processing are independent: audio remains live while
  // highlights are extracted/organized, so the Listening cue is rendered
  // separately and must not be replaced by the capture-state pill.
  const caption = status === 'extracting' || status === 'organizing'
    ? chinese ? (status === 'extracting' ? '提取中…' : '整理中…') : STATUS_CAPTION[status]
    : ''
  const listening = recording && (captureState === 'live' || captureState === 'degraded')

  // After the closing organize pass settles (status back to idle) but the user
  // has stopped, acknowledge the stop with a static, non-shimmering line
  // instead of going blank. Distinct from the pre-record placeholder.
  const stopped = everRecorded && !recording && status === 'idle'
  const doneMsg = !hasContent
    ? tr('Stopped — no speech was captured. Check your mic and try again.', '录音已停止——未捕捉到语音。请检查麦克风后重试。')
    : frozen.length > 0
      ? tr(`Recording stopped — ${frozen.length} section${frozen.length === 1 ? '' : 's'} saved.`, `录音已停止——已保存 ${frozen.length} 个分区。`)
      : tr('Recording stopped — highlights saved.', '录音已停止——要点已保存。')

  const retryCapture = () => setCaptureAttempt((n) => n + 1)
  const captureNotice = (() => {
    switch (captureIssue) {
      case 'permission': return { message: tr("Microphone access is blocked. Allow it in your browser's site settings.", '麦克风访问被阻止。请在浏览器的网站设置中允许访问。'), action: tr('Try again', '重试') }
      case 'no-mic': return { message: tr('No microphone found. Connect your mic (e.g. AirPods), then retry.', '未找到麦克风。请连接麦克风（如 AirPods）后重试。'), action: tr('Retry', '重试') }
      case 'mic-busy': return { message: tr('Your microphone is in use by another app. Close it and retry.', '麦克风正被其他应用使用。请关闭后重试。'), action: tr('Retry', '重试') }
      case 'tab-cancelled': return { message: tr("Recording mic only — tab audio wasn't shared.", '仅录制麦克风——未共享标签页音频。'), action: tr('Share tab audio', '共享标签页音频') }
      case 'tab-missing': return { message: tr("Recording mic only — check 'Share tab audio' in the dialog.", '仅录制麦克风——请在对话框中勾选“共享标签页音频”。'), action: tr('Share tab audio', '共享标签页音频') }
      case 'tab-unsupported': return { message: tr('Recording mic only — Safari does not support tab or screen audio capture. Use Chrome to record shared audio.', '仅录制麦克风——Safari 不支持标签页或屏幕音频采集。请使用 Chrome 录制共享音频。') }
      case 'tab-ended': return { message: tr('Tab audio ended — still recording your mic.', '标签页音频已结束——仍在录制麦克风。'), action: tr('Re-share', '重新共享') }
      case 'mic-reconnecting': return { message: tr('Microphone disconnected — reconnecting…', '麦克风已断开——正在重新连接…') }
      case 'connection-lost': return { message: tr('Connection lost. Your transcript so far is saved.', '连接已中断。当前转写内容已保存。'), action: tr('Resume recording', '继续录音') }
      case 'server-unreachable': return { message: tr("Can't reach the transcription server.", '无法连接转写服务器。'), action: tr('Retry', '重试') }
      case 'transcription-error': return { message: tr(`Transcription error${captureDetail ? `: ${captureDetail.replace(/^(Backend STT|Soniox[^:]*):?\s*/i, '')}` : ''}.`, `转写错误${captureDetail ? `：${captureDetail.replace(/^(Backend STT|Soniox[^:]*):?\s*/i, '')}` : '。'}`), action: tr('Restart transcription', '重新开始转写') }
      case 'stall': return { message: tr('Transcription stalled.', '转写已停止响应。'), action: tr('Restart', '重新开始') }
      case 'signed-out': return { message: tr('Sign in to enable transcription.', '请登录以启用转写。'), action: onSignIn ? tr('Sign in', '登录') : undefined }
      case 'dev-key': return { message: tr('Local transcription needs SONIOX_API_KEY in .env. Restart npm run dev after adding it.', '本地转写需要在 .env 中配置 SONIOX_API_KEY。添加后请重启 npm run dev。') }
      case 'account': return { message: tr('Transcription service unavailable (account issue).', '转写服务不可用（账户问题）。') }
      case 'silence': return { message: tr('Not hearing anything — is your mic muted?', '没有检测到声音——麦克风是否静音？') }
      default: return null
    }
  })()

  const onCaptureAction = () => {
    if (captureIssue === 'signed-out') {
      onSignIn?.()
      return
    }
    if (captureIssue === 'tab-cancelled' || captureIssue === 'tab-missing' || captureIssue === 'tab-ended') {
      // getDisplayMedia must be invoked during this click's transient user
      // activation. Deferring it to the retry effect makes Chrome ignore it.
      let request: Promise<MediaStream>
      try {
        request = navigator.mediaDevices.getDisplayMedia({ video: true, audio: true })
      } catch {
        setCaptureIssue('tab-cancelled')
        return
      }
      void request.then((display) => {
        if (!recordingRef.current) {
          display.getTracks().forEach((track) => track.stop())
          return
        }
        sharedDisplayRef.current = display
        retryCapture()
      }).catch(() => {
        // Cancelling the picker keeps the healthy mic-only session running.
        setCaptureState('degraded')
        setCaptureIssue('tab-cancelled')
      })
      return
    }
    retryCapture()
  }

  const stateLabel: Record<CaptureState, string> = {
    idle: tr('Ready', '准备就绪'), connecting: tr('Connecting…', '连接中…'), live: tr('Live', '录音中'),
    degraded: tr('Recording with an issue', '录音异常'), reconnecting: tr('Reconnecting…', '重连中…'), error: tr('Recording paused', '录音已暂停')
  }

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
        aria-label={collapsed ? tr('Expand transcription', '展开转写') : tr('Collapse transcription', '收起转写')}
        title={collapsed ? tr('Expand transcription', '展开转写') : tr('Collapse transcription', '收起转写')}
        aria-expanded={!collapsed}
        onClick={() => setCollapsed((value) => !value)}
      >
        {collapsed ? '›' : '‹'}
      </button>
      <aside className="transcript" ref={scrollRef} onDragStart={attachDragTs}>
        <div className="hint">
          {recording
            ? tr('Speak freely — key signals are distilled from the conversation and organized into sections as you go. Select any text and drag it onto the canvas. Double-click a section to edit it.', '自由说出你的想法——关键内容会从对话中提炼出来并分区整理。选择任意文字并拖到画布上；双击分区即可编辑。')
            : ''}
        </div>

        {frozen.map((sec) => renderSection(sec, sec.lines))}

        {tail.length > 0 && renderSection(null, tail)}

        {!hasContent && !stopped && (
          <div className="placeholder">
            {recording
              ? tr('Highlights appear every ~2 minutes as you talk.', '说话过程中，每约 2 分钟会出现一次要点。')
              : tr('Press ●, allow the mic, and start talking. Key signals — judgments, questions, decisions — appear here, organized into sections.', '点击 ●，允许麦克风访问后开始说话。判断、问题和决定等关键内容会在这里按分区整理。')}
          </div>
        )}

        {listening && <div className="status-caption ai-thinking">{tr('Listening…', '聆听中…')}</div>}
        {caption && <div className="status-caption ai-thinking">{caption}</div>}
        {stopped && <div className="status-caption done">{doneMsg}</div>}
        {err && <div className="placeholder err">{err}</div>}
        {(recording || sttBlocked) && captureNotice && captureIssue !== 'silence' && (
          <div className={`stt-notice ${captureState}`} role={captureState === 'error' ? 'alert' : 'status'}>
            <span>{captureNotice.message}</span>
            {captureNotice.action && <button type="button" onClick={onCaptureAction}>{captureNotice.action}</button>}
          </div>
        )}
      </aside>

      {/* Recording control: bottom-center of the transcript pane, on a white
          gradient (solid at the bottom, fading to transparent) so it reads
          clearly over scrolled-up text without a hard edge. */}
      <div className="transcript-record-dock">
        {recording && (captureIssue === 'silence' ? (
          <div className="stt-state-pill silence" role="status">
            <span>{tr('Not hearing anything — is your mic muted?', '没有检测到声音——麦克风是否静音？')}</span>
            <button
              type="button"
              aria-label={tr('Dismiss microphone silence hint', '关闭麦克风静音提示')}
              onClick={() => {
                silenceDismissedRef.current = true
                silenceShownRef.current = false
                setCaptureIssue(null)
              }}
            >
              ×
            </button>
          </div>
        ) : (
          <div className={`stt-state-pill ${captureState}`}>{stateLabel[captureState]}</div>
        ))}
        <button
          className={`record ${captureState === 'live' || captureState === 'degraded' ? 'on' : ''} ${captureState}`}
          title={sttBlocked ? tr('Sign in to enable transcription', '请登录以启用转写') : recording ? `${stateLabel[captureState]} — ${tr('stop recording', '停止录音')}` : tr('Start recording', '开始录音')}
          onClick={onRecordClick}
          disabled={sttBlocked}
        >
          {collapsed && <span className="record-label">{tr('Record', '录音')}</span>}
          {captureState === 'live' || captureState === 'degraded'
            ? <span className="stop-sq" />
            : <span className="rec-dot" />}
        </button>
      </div>
    </div>
  )
}
