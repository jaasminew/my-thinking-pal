import { useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from 'react'
import { Transcript, type TranscriptSync } from './Transcript'
import { KeywordNoteView } from './KeywordNoteView'
import { uid, isBullet, isCard, type KeywordNote, type NoteItem, type BulletItem, type CardItem, type ImageItem, type CanvasImage } from './canvas-types'
import { loadJSON, saveJSON } from './persist'
import { requestCocreate } from '../../../services/llm/cocreate'
import type { CocreateProvider } from '../../../services/llm/cocreate-types'
import { requestCommandChat } from '../../../services/llm/command-chat'
import { InlineCommandBubble } from './InlineCommandBubble'
import { CommandSidePanel } from './CommandSidePanel'
import {
  applyAction,
  buildTurnContext,
  paintContextHighlight,
  clearContextHighlight,
  type SelectionSnapshot,
  type CommandSession,
  type CommandMessage
} from './command-session'
import { Sidebar, BookIcon, CanvasIcon, MemoryIcon, type TreeNode } from './Sidebar'
import { openBoard, type Board } from '../../../packages/core/doc'
import { indexeddbPersistence, hydrateNotes, boardDocId, copyBoard, deleteBoard } from './board-persistence'
import { BoardSync } from '../../../services/sync/board-sync'
import { websocketTransport } from '../../../services/sync/board-sync'
import { BackendSTT } from '../../../services/stt/backend'
import type { STTProvider } from '../../../services/stt/types'
import { apiBaseUrl, wsUrl } from '../../../services/api/config'
import { sharedTokenStore } from '../../../services/api/tokens'
import { useBackend, type SyncParams } from './backend'
import { LlmSettingsPanel, type AiModelConfig, type ModelSelections } from './LlmSettingsPanel'
import { AuthPanel } from './AuthPanel'
import { DocumentsPanel } from './DocumentsPanel'
import { setProviderConfig } from '../../../services/llm/provider-config'
import { useMemoryBucket, useProjectMemory, type ProjectMemoryDeps } from './use-project-memory'
import { ProjectMemoryModal } from './ProjectMemoryModal'
import { createLocalStore } from '../../../services/project-memory/local-store'
import { createMemoryClient } from '../../../services/project-memory/client'
import { extractTextBrowser } from '../../../services/project-memory/ingestion'
import { scopeDisplayName } from '../../../services/project-memory/scope'
import type { MemoryBucket, MemoryScopeSection, ProjectMemoryScope } from '../../../services/project-memory/types'
import { defaultStageACall } from '../../../services/project-memory/retrieve'
import { runLocalPrompt, type LocalRuntime } from '../../../services/llm/local-runtime'
import { ObserverEngine, DEFAULT_COOLDOWN_MS, DEFAULT_MAX_RECENT_TOPICS } from './observer-engine'
import { makeObserverLog } from './observer-log'
import { placeObserverNote, DEFAULT_NOTE_W, DEFAULT_NOTE_H, type PlacedRect } from './observer-placement'
import { requestObserverEvaluate, requestObserverContribute } from '../../../services/llm/observer'
import { resolveCategoryProvider, type CategoryAssignment } from '../../../services/llm/model-roles'
import type {
  ObserverCanvasContext,
  ObserverEmission,
  ObserverLogRecord,
  ObserverOutcome,
  ObserverSignal,
  ObserverState
} from '../../../packages/core/llm/observer-types'
import { reduceAiCursor } from './ai-cursor'
import { createRevealScheduler } from './ai-reveal'
import { initialAiCursorState, type AiCursorState, type BufferedFireEvent, type RevealScheduler, type WorldPoint } from './ai-cursor-types'
import { AiCursorOverlay } from './AiCursorOverlay'
import { useLocale } from './locale'

// DEV-only pretty-printer for observer decisions — see engine.onLog wiring.
// Every gate skip, evaluation, emission, and error prints one clear line so a
// live test shows exactly whether the observer emitted and, if not, why.
function logObserverRecord(rec: ObserverLogRecord): void {
  const tag = '%c[observer]'
  const base = 'font-weight:bold;padding:1px 4px;border-radius:3px;'
  if (rec.kind === 'evaluation' && rec.decision) {
    const d = rec.decision
    const color = d.emit ? 'color:#fff;background:#16a34a' : 'color:#fff;background:#6b7280'
    console.log(
      `${tag} EVALUATE → emit=${d.emit ? 'YES' : 'no'}  "${d.topic ?? ''}"  (conf ${d.confidence ?? '?'}, ${rec.latencyMs}ms)`,
      base + color,
      d.emit ? '' : `\n         reason: ${d.reason ?? '(none)'}`
    )
  } else if (rec.kind === 'emission') {
    console.log(`${tag} EMIT ✓  note placed  (model ${rec.model ?? '?'}, search ${rec.searchPath ?? '?'}, ${rec.sourceCount ?? 0} source${rec.sourceCount === 1 ? '' : 's'})`, base + 'color:#fff;background:#2563eb')
  } else if (rec.kind === 'skip') {
    console.log(`${tag} skip: ${rec.gate}`, base + 'color:#fff;background:#b45309')
  } else if (rec.kind === 'error') {
    console.log(`${tag} ERROR: ${rec.error}`, base + 'color:#fff;background:#dc2626')
  }
}

const OPEN_PROVIDER: CocreateProvider = 'open'
const DEFAULT_MODEL_CONFIGS: AiModelConfig[] = []
const LEGACY_PLACEHOLDER_MODEL_IDS = new Set([
  'groq-llama-3-3-70b',
  'groq-gpt-oss-120b',
  'groq-qwen3-32b',
  'ollama-local'
])
const DEFAULT_MODEL_SELECTIONS: ModelSelections = {
  listener: '',
  thinker: ''
}

export function normalizeModelConfigs(raw: AiModelConfig[] | null | undefined): AiModelConfig[] {
  const byId = new Map<string, AiModelConfig>()
  if (Array.isArray(raw)) {
    for (const cfg of raw) {
      if (!cfg?.id || !cfg?.runtime) continue
      // Older builds persisted four starter entries even though the user had
      // never configured them. Remove those misleading placeholders once.
      if (LEGACY_PLACEHOLDER_MODEL_IDS.has(cfg.id)) continue
      byId.set(cfg.id, {
        id: String(cfg.id),
        label: String(cfg.label || cfg.id),
        runtime: cfg.runtime,
        providerId: cfg.providerId,
        model: cfg.model,
        apiKey: cfg.apiKey,
        baseUrl: cfg.baseUrl,
        command: cfg.command
      })
    }
  }
  return [...byId.values()]
}

export function normalizeModelSelections(
  raw: Partial<ModelSelections> | Record<string, unknown> | null | undefined,
  configs: readonly AiModelConfig[]
): ModelSelections {
  const ids = new Set(configs.map((c) => c.id))
  const pick = (value: unknown, fallback: string) => {
    if (typeof value === 'string' && ids.has(value)) return value
    return fallback
  }
  // Migrate legacy per-role selections (contract §5): transcriptionSummary →
  // listener, coCreation → thinker. A differing aiCommand is discarded.
  const raw2 = raw as Record<string, unknown> | null | undefined
  return {
    listener: pick(raw2?.listener ?? raw2?.transcriptionSummary, DEFAULT_MODEL_SELECTIONS.listener),
    thinker: pick(raw2?.thinker ?? raw2?.coCreation, DEFAULT_MODEL_SELECTIONS.thinker)
  }
}

const modelConfigAt = (configs: readonly AiModelConfig[], id: string) =>
  configs.find((cfg) => cfg.id === id) ??
  configs[0] ?? {
    id: '',
    label: 'No model configured',
    runtime: 'api' as const,
    providerId: 'groq'
  }
const GearIcon = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.04.04a2 2 0 0 1-2.83 2.83l-.04-.04a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1.04 1.56V21a2 2 0 0 1-4 0v-.08A1.7 1.7 0 0 0 8.96 19.4a1.7 1.7 0 0 0-1.87.34l-.04.04a2 2 0 0 1-2.83-2.83l.04-.04A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-1.56-1.04H3a2 2 0 0 1 0-4h.08A1.7 1.7 0 0 0 4.6 8.96a1.7 1.7 0 0 0-.34-1.87l-.04-.04a2 2 0 0 1 2.83-2.83l.04.04A1.7 1.7 0 0 0 8.96 4.6 1.7 1.7 0 0 0 10 3.04V3a2 2 0 0 1 4 0v.08a1.7 1.7 0 0 0 1.04 1.52 1.7 1.7 0 0 0 1.87-.34l.04-.04a2 2 0 0 1 2.83 2.83l-.04.04a1.7 1.7 0 0 0-.34 1.87A1.7 1.7 0 0 0 20.96 10H21a2 2 0 0 1 0 4h-.08A1.7 1.7 0 0 0 19.4 15z" />
  </svg>
)
const ProfileIcon = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <circle cx="12" cy="8" r="3.4" />
    <path d="M5.4 20a6.6 6.6 0 0 1 13.2 0" />
  </svg>
)
// Adapt a live MemoryBucket (hook surface) to the modal's presentational
// section shape — the only difference is callback naming and Promise dropping.
const toMemorySection = (b: MemoryBucket | null): MemoryScopeSection | null =>
  b && {
    name: b.name,
    files: b.files,
    instructions: b.instructions,
    instructionsSaved: b.instructionsSaved,
    onUpload: (fs) => void b.uploadFiles(fs),
    onDeleteFile: (id) => void b.deleteFile(id),
    onRetryFile: (id) => void b.retryFile(id),
    onSaveInstructions: (ins) => void b.saveInstructions(ins)
  }

// Project-scope-only Memory modal, opened from a project row's hover toolbox
// in the sidebar. No canvas context — just the project's shared bucket.
function ProjectMemoryHost({
  projectId,
  tree,
  deps,
  onClose
}: {
  projectId: string
  tree: TreeNode[]
  deps: ProjectMemoryDeps
  onClose: () => void
}) {
  const scope = useMemo(() => ({ kind: 'project', projectId }) as const, [projectId])
  const bucket = useMemoryBucket(scope, deps)
  const name = scopeDisplayName(tree, scope)
  return (
    <ProjectMemoryModal
      project={toMemorySection({ scope, name, ...bucket })}
      canvas={null}
      initialScope="project"
      busy={bucket.busy}
      error={bucket.error}
      onClose={onClose}
    />
  )
}

// Ambient fires wait for this much keyboard silence before landing content.
const IDLE_MS = 5000
const AI_CURSOR_NOTE_GAP_PX = 12

// Strip a leading bullet marker ("- ", "• ", "* ") from a model line.
const stripMarker = (l: string) => l.replace(/^[\s\-*•]+/, '').trim()

// Drop model chatter that isn't a real bullet (search preamble, a Sources list,
// a bare markdown link line). Safety net on top of the prompt instructions.
const META = /^(i['’]?ll\b|i will\b|let me\b|i['’]?m going\b|searching\b|here'?s?\b|sources?\b|first[,:]? i)/i
const isContentBullet = (l: string) =>
  l.length > 0 && !META.test(l) && !/^\[.*\]\(https?:\/\//.test(l) && !/^URLS:/i.test(l)

const displayBulletLines = (text: string) =>
  text
    .split('\n')
    .flatMap((l) => l.split(/(?<=[.!?])\s*(?=[-•*]\s)/))
    .map(stripMarker)
    .filter(isContentBullet)
    .slice(0, 3)

// Count "words": each CJK char = 1, each latin run = 1. Drives the every-20 fire.
const countWords = (s: string) => {
  const cjk = (s.match(/[一-鿿]/g) || []).length
  const latin = (s.replace(/[一-鿿]/g, ' ').match(/[A-Za-z0-9']+/g) || []).length
  return cjk + latin
}
// Human words in a note = keyword + the user's bullets (AI output doesn't count).
const humanWords = (n: KeywordNote) =>
  countWords([n.keyword, ...n.items.filter((i): i is BulletItem => isBullet(i) && i.origin === 'human').map((b) => b.text)].join(' '))
// Exact human text of a note — changes on every keystroke (unlike the word
// count), so it's the signal the idle-detection in the trigger watches.
const humanSig = (n: KeywordNote) =>
  [n.keyword, ...n.items.filter((i): i is BulletItem => isBullet(i) && i.origin === 'human').map((b) => b.text)].join(' ')

// Anchored placement: an AI bullet lands as a sub-point directly under the
// human bullet the fire declared it builds on (after that bullet's existing
// subtree, so the user's own sub-points aren't split), not appended after the
// whole note. Later bullets of the same fire stack under the first. Cards
// between bullets belong to the bullet above them — skipped, never split from
// it. No anchor (model said NONE / bullet since deleted) → append at the end.
const insertAnchored = (items: NoteItem[], nb: BulletItem, anchorId?: string): NoteItem[] => {
  for (let j = items.length - 1; j >= 0; j--) {
    const it = items[j]
    if (isBullet(it) && it.fireId === nb.fireId) {
      return [...items.slice(0, j + 1), { ...nb, indent: it.indent }, ...items.slice(j + 1)]
    }
  }
  const a = anchorId ? items.findIndex((it) => it.id === anchorId) : -1
  if (a < 0) return [...items, nb]
  const depth = ((items[a] as BulletItem).indent ?? 0) + 1
  let end = a + 1
  while (end < items.length) {
    const it = items[end]
    if (isCard(it) || (isBullet(it) && (it.indent ?? 0) >= depth)) end++
    else break
  }
  return [...items.slice(0, end), { ...nb, indent: depth }, ...items.slice(end)]
}

// Reaction entries carry the fire's invisible diagnosis, so the model learns
// which KINDS of help land ("she rejects examples on early-stage notes"), not
// just which texts. Format matches what COCREATE_SYSTEM is told to expect.
const withDiag = (text: string, diagnosis?: string) =>
  diagnosis ? `${text} [offered because: ${diagnosis}]` : text

const settledCommandSession = (s: CommandSession | null): CommandSession | null =>
  s
    ? {
        ...s,
        messages: s.messages.map((m) => (m.pending ? { ...m, pending: false } : m))
      }
    : null

// URLs the user types/pastes into a bullet get pulled out into inline cards.
const URL_RE = /https?:\/\/[^\s<>"')\]]+/g
const hostOf = (u: string) => {
  try { return new URL(u).hostname.replace(/^www\./, '') } catch { return u }
}

// Commit a bullet: strip typed URLs into gray cards placed right after it, and
// (on ⏎) continue the outline with a fresh editing bullet below — regardless of
// whether the committed line was human or accepted AI: laid-down text is text.
const commitBullet = (b: BulletItem, continueOutline: boolean): NoteItem[] => {
  const urls = b.text.match(URL_RE) || []
  const text = b.text.replace(URL_RE, ' ').replace(/\s+/g, ' ').trim()
  const out: NoteItem[] = []
  if (text) out.push({ ...b, text, editing: false })
  for (const u of urls) {
    out.push({ kind: 'card', id: uid('c'), origin: 'human', status: 'kept', title: hostOf(u), url: u })
  }
  // ⏎ on an empty bullet ends the outline instead of opening another one. The
  // fresh line continues at the same outline depth.
  if (continueOutline && out.length) {
    out.push({ kind: 'bullet', id: uid('b'), origin: 'human', text: '', status: 'kept', editing: true, indent: b.indent })
  }
  return out
}

// One idea space = one canvas panel: its own transcript (left) + infinite
// canvas (right), with its own saved notes/images/view/transcript. Mounted
// keyed by space id. The original canvas keeps the un-suffixed storage keys.
// Only the ACTIVE space records, fires ambient AI, or answers global keys.
function CanvasSpace({
  spaceId,
  tree,
  memoryDeps,
  memoryOpen,
  onOpenMemory,
  onCloseMemory,
  storageSuffix,
  isActive,
  recording,
  onToggleRecord,
  modelSelections,
  modelConfigs,
  sync,
  makeStt,
  seedFromLocal = true,
  onSignIn,
  sttBlocked = false
}: {
  /** This canvas's tree-node id — resolves the Project Memory scope. */
  spaceId: string
  /** The sidebar tree (scope resolution: nested canvas → parent project's bucket). */
  tree: TreeNode[]
  /** Project Memory storage/extraction seams (inert while null, wired in M5). */
  memoryDeps: ProjectMemoryDeps
  /** Whether THIS canvas's Project Memory modal is open (App owns the state so
   *  the sidebar entry point can open it for the active canvas). */
  memoryOpen: boolean
  onOpenMemory: () => void
  onCloseMemory: () => void
  storageSuffix: string
  isActive: boolean
  recording: boolean
  onToggleRecord: () => void
  modelSelections: ModelSelections
  modelConfigs: readonly AiModelConfig[]
  /** When signed in + this space is mapped to a server doc, attach live sync. */
  sync?: SyncParams | null
  /** STT provider factory (backend proxy when signed in; else browser Soniox). */
  makeStt?: () => STTProvider | Promise<STTProvider>
  /** Seed a fresh board from local canvas content (migrate). False when adopting
   *  an existing/blank server document — that board comes from the server. */
  seedFromLocal?: boolean
  onSignIn?: () => void
  sttBlocked?: boolean
}) {
  const { tr } = useLocale()
  const k = (key: string) => key + storageSuffix
  // Notes are restored from localStorage so testing data survives refreshes.
  // Transient flags (aiRunning, open editors) are reset — a restored note is
  // settled content, not a live session snapshot.
  const [notes, setNotes] = useState<KeywordNote[]>(() =>
    loadJSON<KeywordNote[]>(k('notes'), [])
      .map((n) => ({
        ...n,
        aiRunning: false,
        keywordEditing: false,
        items: n.items.filter((it) => !isBullet(it) || it.text.trim() !== '').map((it) => (isBullet(it) ? { ...it, editing: false } : it))
      }))
      .filter((n) => n.keyword.trim() !== '' || n.items.length > 0)
  )
  // Free-floating pictures on the canvas (dropped onto blank space) — no note
  // wrapper. Share the note selection set (ids are globally unique).
  const [images, setImages] = useState<CanvasImage[]>(() => loadJSON<CanvasImage[]>(k('images'), []))
  // Local-first CRDT persistence (Phase 1): notes + images mirror into a Yjs
  // board backed by IndexedDB. localStorage stays a mirror (instant first paint
  // + backup/export); IndexedDB is authoritative across sessions and the seam
  // Phase 2's y-websocket sync plugs into. Live-editing UI flags never persist.
  const boardRef = useRef<Board | null>(null)
  const boardReadyRef = useRef(false)
  const notesLatestRef = useRef(notes)
  notesLatestRef.current = notes
  const imagesLatestRef = useRef(images)
  imagesLatestRef.current = images
  const seedRef = useRef(seedFromLocal)
  seedRef.current = seedFromLocal
  // Set when React state was just updated FROM a remote board change, so the
  // next autosave skips mirroring it back to the board (which would otherwise
  // ping-pong full-state updates between synced clients).
  const remoteNotesRef = useRef(false)
  const remoteImagesRef = useRef(false)
  // Transcript sync seam: <Transcript> owns its own frozen/tail state, so instead
  // of lifting it we hand it a stable imperative bridge to the board's Y.Doc.
  // Listeners are notified on board-ready and on every REMOTE doc update so the
  // component re-reads the transcript; our own writes use origin 'local' and are
  // filtered out here to avoid a feedback loop.
  const transcriptListenersRef = useRef(new Set<() => void>())
  const notifyTranscript = useCallback(() => {
    for (const cb of transcriptListenersRef.current) cb()
  }, [])
  const transcriptSync = useMemo<TranscriptSync>(
    () => ({
      read: () => (boardRef.current?.getTranscript() ?? null) as ReturnType<TranscriptSync['read']>,
      write: (frozen, tail) => {
        if (boardReadyRef.current) boardRef.current?.setTranscript(frozen, tail)
      },
      observe: (cb) => {
        transcriptListenersRef.current.add(cb)
        return () => transcriptListenersRef.current.delete(cb)
      }
    }),
    []
  )
  // The board's persistence/doc id: a bound server document gets its OWN local
  // store (shared across this account's devices via /sync); otherwise the local
  // per-space id (original behavior, unchanged when signed out).
  const boardKey = sync?.docId ? `${boardDocId('')}.srv.${sync.docId}` : boardDocId(storageSuffix)
  useEffect(() => {
    const board = openBoard(boardKey, { persistence: indexeddbPersistence })
    boardRef.current = board
    let cancelled = false
    void board.whenSynced.then(() => {
      if (cancelled) return
      if (board.isEmpty()) {
        if (seedRef.current) {
          // First run on this device: seed the board from the localStorage restore.
          board.replaceContent({ notes: notesLatestRef.current, images: imagesLatestRef.current })
        } else {
          // Adopting an existing/blank server doc: start from the doc, not this
          // device's canvas. Remote content arrives via BoardSync below.
          setNotes([])
          setImages([])
        }
      } else {
        // Returning session: IndexedDB wins (survives a full localStorage clear).
        setNotes(hydrateNotes(board.notes()))
        setImages(board.images())
      }
      boardReadyRef.current = true
      // Board is loaded — let <Transcript> seed/adopt its transcript now.
      notifyTranscript()
    })
    // Reflect REMOTE updates (from BoardSync) in the UI. Local edits transact with
    // origin 'local' and are skipped here (they already live in React state); the
    // 300ms autosave mirrors React state back to the board.
    const onRemote = (_u: Uint8Array, origin: unknown) => {
      if (origin === 'local' || cancelled) return
      remoteNotesRef.current = true
      remoteImagesRef.current = true
      setNotes(hydrateNotes(board.notes()))
      setImages(board.images())
      // Same doc carries the transcript; let <Transcript> re-read it.
      notifyTranscript()
    }
    board.doc.on('update', onRemote)
    return () => {
      cancelled = true
      boardReadyRef.current = false
      boardRef.current = null
      board.doc.off('update', onRemote)
      void board.destroy()
    }
  }, [boardKey])

  // Live sync (Phase 2): when signed in and this space is mapped to a server
  // document, attach BoardSync to the board's Y.Doc. The relay is a dumb
  // broadcaster (docs module 05); updates converge via CRDT. Runs alongside the
  // IndexedDB local-first store — offline still works, sync is additive.
  useEffect(() => {
    const board = boardRef.current
    if (!board || !sync) return
    const url = wsUrl(sync.baseUrl, `/sync/${encodeURIComponent(sync.docId)}`, sync.token)
    const bs = new BoardSync(board.doc, websocketTransport(url), { snapshotDebounceMs: 15000 })
    return () => bs.destroy()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [boardKey, sync?.baseUrl, sync?.token, sync?.docId])
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [marquee, setMarquee] = useState<{ l: number; t: number; w: number; h: number } | null>(null)
  // Right-click on a note: duplicate/rename/delete. Closes on click-away/Escape.
  const [noteMenu, setNoteMenu] = useState<{ id: string; x: number; y: number } | null>(null)
  // The note whose transcript source phrase is currently hovered — its header
  // fades to orange. null = every header stays plain black.
  const [hoveredNoteId, setHoveredNoteId] = useState<string | null>(null)
  // Expanded view of an inline bullet image (click to open, Esc/click-away to
  // close). Shows the image large over a blurred scrim + its source url below.
  // The open/close uses a FLIP transition: the image grows from the clicked
  // thumbnail's screen rect to its centered size (and shrinks back), while the
  // scrim fades — the classic Apple shared-element expand.
  type PreviewImg = { src: string; sourceUrl?: string; title?: string; originRect?: DOMRect }
  const [imgPreview, setImgPreview] = useState<PreviewImg | null>(null)
  const [previewOpen, setPreviewOpen] = useState(false) // drives the scrim fade-in class
  const previewImgRef = useRef<HTMLImageElement>(null)
  const previewNaturalRect = useRef<{ top: number; left: number; width: number; height: number } | null>(null)

  // PLAY the expand: measure the image's natural (centered) rect, snap it back
  // onto the origin thumbnail with no transition, then release to natural size.
  useLayoutEffect(() => {
    if (!imgPreview) return
    const el = previewImgRef.current
    const origin = imgPreview.originRect
    const play = () => {
      if (!el) return
      const last = el.getBoundingClientRect() // natural centered rect (no transform yet)
      if (!last.width || !last.height) return
      previewNaturalRect.current = { top: last.top, left: last.left, width: last.width, height: last.height }
      if (origin) {
        el.style.transformOrigin = '0 0'
        el.style.transition = 'none'
        el.style.transform =
          `translate(${origin.left - last.left}px, ${origin.top - last.top}px) ` +
          `scale(${origin.width / last.width}, ${origin.height / last.height})`
        void el.offsetWidth // force the FIRST frame to paint before releasing
      }
      requestAnimationFrame(() => {
        el.style.transition = 'transform .34s cubic-bezier(.2,0,0,1)'
        el.style.transform = 'none'
      })
    }
    if (el && (el.complete || !origin)) play()
    else if (el) el.addEventListener('load', play, { once: true })
    requestAnimationFrame(() => setPreviewOpen(true)) // fade the scrim in
  }, [imgPreview])

  // Reverse the FLIP: shrink the image back onto the origin thumbnail, fade the
  // scrim out, then unmount once the image transition ends.
  const closeImgPreview = useCallback(() => {
    const el = previewImgRef.current
    const origin = imgPreview?.originRect
    const nat = previewNaturalRect.current
    setPreviewOpen(false)
    if (el && origin && nat) {
      el.style.transformOrigin = '0 0'
      el.style.transition = 'transform .28s cubic-bezier(.4,0,.2,1)'
      el.style.transform =
        `translate(${origin.left - nat.left}px, ${origin.top - nat.top}px) ` +
        `scale(${origin.width / nat.width}, ${origin.height / nat.height})`
      const done = () => setImgPreview(null)
      el.addEventListener('transitionend', done, { once: true })
      setTimeout(done, 360) // fallback if transitionend is missed
    } else {
      setImgPreview(null)
    }
  }, [imgPreview])

  useEffect(() => {
    if (!imgPreview) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') closeImgPreview() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [imgPreview, closeImgPreview])

  // AI co-creation mode: OFF suppresses ambient fires and cancels in-flight
  // ones. Tier-3 commands stay live — an explicit command is an invitation.
  const [aiEnabled, setAiEnabled] = useState(modelConfigs.length > 0)

  // ---- Tier-3 command sessions: select text → bubble → side-panel chat ----
  // bubbleSel is the FROZEN SelectionSnapshot the bubble was opened from; the
  // live browser selection collapsing afterwards is expected and ignored. One
  // session at a time (demo scope), restored per idea space so local backups
  // include the right-side AI chat.
  const [bubbleSel, setBubbleSel] = useState<SelectionSnapshot | null>(null)
  const [session, setSession] = useState<CommandSession | null>(() =>
    settledCommandSession(loadJSON<CommandSession | null>(k('command-session'), null))
  )
  const [chatStreaming, setChatStreaming] = useState(false)
  const sessionRef = useRef<CommandSession | null>(null)
  useEffect(() => { sessionRef.current = session }, [session])
  const chatAbortRef = useRef<AbortController | null>(null)
  useEffect(() => {
    saveJSON(k('command-session'), settledCommandSession(session))
  }, [session])

  const canvasRef = useRef<HTMLDivElement | null>(null)
  const layerRef = useRef<HTMLDivElement | null>(null)
  // Canvas view transform: pinch = zoom (around the cursor), two-finger swipe
  // = pan. Applied to the notes layer; notes themselves keep world coords.
  const [view, setView] = useState(() => loadJSON(k('view'), { x: 0, y: 0, scale: 1 }))
  const viewRef = useRef(view)
  useEffect(() => { viewRef.current = view }, [view])
  // AI Pal cursor — single screen-space cursor that follows the current AI
  // activity. Serialized reveal: only the current activity's content is
  // applied to the canvas; all others buffer invisibly.
  const [cursor, cursorDispatch] = useReducer(reduceAiCursor, initialAiCursorState)
  const notesRef = useRef<KeywordNote[]>(notes)
  useEffect(() => { notesRef.current = notes }, [notes])
  const imagesRef = useRef<CanvasImage[]>(images)
  useEffect(() => { imagesRef.current = images }, [images])
  const selectedIdsRef = useRef(selectedIds)
  useEffect(() => { selectedIdsRef.current = selectedIds }, [selectedIds])
  const aiBufRef = useRef<Record<string, string>>({})
  const aiEnabledRef = useRef(modelConfigs.length > 0)
  useEffect(() => { aiEnabledRef.current = aiEnabled }, [aiEnabled])
  const isActiveRef = useRef(isActive)
  useEffect(() => { isActiveRef.current = isActive }, [isActive])
  // ---- Observer agent (ambient AI note creation from fresh signals) ----------
  // The engine (deterministic scheduling/gating) lives in observer-engine.ts;
  // this space wires it: pushSignals from onSignals, note conversion on emit,
  // per-space persistence, keep/reject → recordOutcome. Constructed once in a
  // mount effect below. `observerRef` is declared here so onSignals can fan out.
  const observerRef = useRef<ObserverEngine | null>(null)
  const observerLogRef = useRef(
    makeObserverLog(
      () => loadJSON<ObserverLogRecord[]>(k('observer-log'), []),
      (recs) => saveJSON(k('observer-log'), recs)
    )
  )
  // Category assignments (Listener/Thinker) read live inside the engine deps so a
  // mid-session model switch takes effect — mirrors SignalEngine reading provider
  // live. Updated by the effect below.
  const listenerAssignRef = useRef<CategoryAssignment | undefined>(undefined)
  const thinkerAssignRef = useRef<CategoryAssignment | undefined>(undefined)
  // Visible notice when no Listener model can be resolved (observer stays off).
  const [observerNotice, setObserverNotice] = useState<string | null>(null)
  // In-flight fires, so switching AI off can cancel ambient streams immediately.
  const firesRef = useRef(new Map<string, { controller: AbortController; isCommand: boolean }>())
  // Per fire/activity: its reveal scheduler + the deferred-apply local state
  // (diagnosis/anchor are produced early but consumed when text is APPLIED,
  // which may be much later than when they arrived — so they can't be closure
  // locals anymore; they live here).
  const revealRef = useRef(new Map<string, {
    noteId: string
    scheduler: RevealScheduler
    humanBullets: BulletItem[]
    diagnosis?: string
    anchorId?: string
    firstTextApplied: boolean
    hasDisplayOutput: boolean
    receivedText: string
  }>())
  // The current-activity effect is declared before the observer callbacks.
  // This ref lets it promote either kind through one queue without depending
  // on declaration order or maintaining a second observer-only effect.
  const promoteNonCocreateRef = useRef<(activityId: string) => void>(() => {})
  // Bullets rejected mid-stream, per fire (fireId → set of fireLine): the
  // streaming upsert must not recreate them. Cleared when the fire ends.
  const rejectedFireLinesRef = useRef(new Map<string, Set<number>>())
  // Verbatim word-by-word transcript, fed by this space's <Transcript> as
  // timestamped final STT segments — per idea space. The AI never gets all of
  // it; runAi slices a window (rules A/B/C below).
  const rawTranscriptRef = useRef<{ text: string; ts: number }[]>(loadJSON(k('raw-transcript'), []))
  const onRawFinal = useCallback((text: string, ts: number) => {
    rawTranscriptRef.current.push({ text, ts })
    saveJSON(k('raw-transcript'), rawTranscriptRef.current)
  }, [])
  const transcriptSlice = useCallback((from: number, to: number): string | undefined => {
    const parts = rawTranscriptRef.current.filter((e) => e.ts >= from && e.ts <= to).map((e) => e.text)
    return parts.length ? parts.join(' ') : undefined
  }, [])
  // Typed pending signals extracted by the transcript engine (append-only log,
  // per idea space). Types/speakers are never rendered — they exist to make
  // co-creation type-aware: runAi slices this by the same window rules as the
  // verbatim transcript.
  const signalLogRef = useRef<{ text: string; type?: string; speaker?: string; ts: number }[]>(
    loadJSON(k('signal-log'), [])
  )
  const onSignals = useCallback((lines: { text: string; type?: string; speaker?: string; ts: number }[]) => {
    for (const l of lines) signalLogRef.current.push({ text: l.text, type: l.type, speaker: l.speaker, ts: l.ts })
    saveJSON(k('signal-log'), signalLogRef.current)
    // A fresh signal batch IS the observer's trigger (never a timer). The engine
    // applies its own gates; this is fire-and-forget.
    observerRef.current?.pushSignals(lines)
  }, [])
  const signalSlice = useCallback((from: number, to: number): string | undefined => {
    const parts = signalLogRef.current
      .filter((e) => e.ts >= from && e.ts <= to)
      .map((e) => `[${e.type || 'judgment'}]${e.speaker ? ` [${e.speaker}]` : ''} ${e.text}`)
    return parts.length ? parts.join('\n') : undefined
  }, [])

  // Autosave notes + view (debounced — note state churns on every keystroke
  // and during streaming AI fires).
  useEffect(() => {
    const t = setTimeout(() => {
      saveJSON(k('notes'), notes)
      if (boardReadyRef.current) {
        if (remoteNotesRef.current) remoteNotesRef.current = false // came from sync; don't echo back
        else boardRef.current?.setNotes(notes)
      }
    }, 300)
    return () => clearTimeout(t)
  }, [notes])
  useEffect(() => {
    const t = setTimeout(() => {
      saveJSON(k('images'), images)
      if (boardReadyRef.current) {
        if (remoteImagesRef.current) remoteImagesRef.current = false
        else boardRef.current?.setImages(images)
      }
    }, 300)
    return () => clearTimeout(t)
  }, [images])
  useEffect(() => {
    const t = setTimeout(() => saveJSON(k('view'), view), 300)
    return () => clearTimeout(t)
  }, [view])

  // ---- Undo / redo (⌘Z / ⌘⇧Z), WORD-GRANULAR ----
  // One ⌘Z rolls back exactly ONE word, not a whole typing burst. So we record
  // a history step at each BOUNDARY: the human word count changing (a word
  // started or was removed — CJK counts per char, latin per word, matching
  // countWords), or the canvas SHAPE changing (a note / bullet / card / image
  // added or deleted, including AI bullets landing). Between boundaries — the
  // characters within one word — nothing is recorded. A snapshot pairs notes +
  // images because a delete removes both together.
  type Snapshot = { notes: KeywordNote[]; images: CanvasImage[] }
  const canvasWords = (ns: KeywordNote[]) => ns.reduce((a, n) => a + humanWords(n), 0)
  const shapeSig = (ns: KeywordNote[], is: CanvasImage[]) =>
    `${ns.length}|${is.length}|${ns.reduce((a, n) => a + n.items.length, 0)}`
  const historyRef = useRef<Snapshot[]>([]) // past boundary states, oldest → newest
  const futureRef = useRef<Snapshot[]>([]) // undone states, for redo
  const prevRef = useRef<Snapshot>({ notes, images }) // state from the previous render
  const prevWordsRef = useRef(canvasWords(notes)) // word count at the last boundary
  const prevShapeRef = useRef(shapeSig(notes, images)) // shape sig at the last boundary
  const restoringRef = useRef(false) // set while applying undo/redo — skip recording
  const HISTORY_CAP = 300

  useEffect(() => {
    const words = canvasWords(notes)
    const shape = shapeSig(notes, images)
    if (restoringRef.current) {
      // This change came FROM an undo/redo — re-baseline, don't record.
      restoringRef.current = false
      prevRef.current = { notes, images }
      prevWordsRef.current = words
      prevShapeRef.current = shape
      return
    }
    // Boundary crossed → the PREVIOUS render was the end of the last word/action;
    // push it so one ⌘Z returns there. Mid-word keystrokes only advance prevRef.
    if (words !== prevWordsRef.current || shape !== prevShapeRef.current) {
      historyRef.current.push(prevRef.current)
      if (historyRef.current.length > HISTORY_CAP) historyRef.current.shift()
      futureRef.current = [] // a fresh edit invalidates the redo stack
      prevWordsRef.current = words
      prevShapeRef.current = shape
    }
    prevRef.current = { notes, images }
  }, [notes, images])

  const applySnapshot = useCallback((s: Snapshot) => {
    restoringRef.current = true
    setNotes(s.notes)
    setImages(s.images)
    setSelectedIds(new Set()) // stale ids may point at notes that just came/went
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!isActiveRef.current) return // global keys belong to the active canvas
      if (e.key.toLowerCase() !== 'z' && e.key.toLowerCase() !== 'y') return
      if (!e.metaKey && !e.ctrlKey) return
      // Let native undo handle text fields — only drive canvas history otherwise.
      const ae = document.activeElement
      if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' || (ae as HTMLElement).isContentEditable)) return
      const redo = e.key.toLowerCase() === 'y' || (e.key.toLowerCase() === 'z' && e.shiftKey)
      const current: Snapshot = { notes: notesRef.current, images: imagesRef.current }
      if (redo) {
        const next = futureRef.current.pop()
        if (!next) return
        e.preventDefault()
        historyRef.current.push(current)
        applySnapshot(next)
      } else {
        const prev = historyRef.current.pop()
        if (!prev) return
        e.preventDefault()
        futureRef.current.push(current)
        applySnapshot(prev)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [applySnapshot])

  // Mass delete: ⌫/Delete removes all selected notes (unless typing in a field).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!isActiveRef.current) return // global keys belong to the active canvas
      if (e.key !== 'Delete' && e.key !== 'Backspace') return
      if (e.defaultPrevented) return // e.g. ⌫ on a focused url card = delete that card only
      const ae = document.activeElement
      if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' || (ae as HTMLElement).isContentEditable)) return
      if (selectedIdsRef.current.size === 0) return
      e.preventDefault()
      const del = selectedIdsRef.current
      setNotes((ns) => ns.filter((n) => !del.has(n.id)))
      setImages((is) => is.filter((i) => !del.has(i.id)))
      setSelectedIds(new Set())
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // Note context menu: dismiss on Escape, click-away, or scroll (position would go stale).
  useEffect(() => {
    if (!noteMenu) return
    const close = () => setNoteMenu(null)
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close() }
    window.addEventListener('pointerdown', close)
    window.addEventListener('keydown', onKey)
    window.addEventListener('wheel', close)
    return () => {
      window.removeEventListener('pointerdown', close)
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('wheel', close)
    }
  }, [noteMenu])

  const patchNote = useCallback((id: string, fn: (n: KeywordNote) => KeywordNote) => {
    setNotes((ns) => ns.map((n) => (n.id === id ? fn(n) : n)))
  }, [])

  // Cards from the CLI providers arrive as bare title+url — enrich them with the
  // site's own short description (og:description) and thumbnail via /api/url-meta.
  // One attempt per card; missing fields just stay empty (the card renders
  // without an image area / falls back to the hostname as description).
  const metaTriedRef = useRef(new Set<string>())
  useEffect(() => {
    for (const n of notes)
      for (const it of n.items) {
        if (!isCard(it) || (it.snippet && it.image) || metaTriedRef.current.has(it.id)) continue
        metaTriedRef.current.add(it.id)
        const noteId = n.id
        fetch(`/api/url-meta?url=${encodeURIComponent(it.url)}`)
          .then((r) => (r.ok ? r.json() : {}))
          .then((m: { description?: string; image?: string }) => {
            if (!m?.description && !m?.image) return
            patchNote(noteId, (nn) => ({
              ...nn,
              items: nn.items.map((x) =>
                x.id === it.id && isCard(x)
                  ? { ...x, snippet: x.snippet || m.description, image: x.image || m.image }
                  : x
              )
            }))
          })
          .catch(() => {})
      }
  }, [notes, patchNote])

  // Co-creation and commands both run on the Thinker category (contract §5).
  const providerArgs = useCallback(() => {
    const cfg = modelConfigAt(modelConfigs, modelSelections.thinker)
    if (cfg.runtime === 'api' || cfg.runtime === 'ollama') {
      return { provider: OPEN_PROVIDER, openSub: cfg.providerId || 'groq', model: cfg.model || undefined, webSearch: true }
    }
    return { provider: cfg.runtime, model: cfg.model || undefined, runtimeCommand: cfg.command || undefined, webSearch: true }
  }, [modelConfigs, modelSelections.thinker])

  // Project Memory Stage-A selection runs on the Listener category (contract §5):
  // a fast catalog-metadata pass, decoupled from the Thinker that writes the note.
  const memorySelectionCall = useCallback(() => {
    const cfg = modelConfigAt(modelConfigs, modelSelections.listener)
    if (cfg.runtime === 'api' || cfg.runtime === 'ollama') {
      return defaultStageACall(cfg.providerId || (cfg.runtime === 'ollama' ? 'ollama' : 'groq'), cfg.model || undefined)
    }
    return (system: string, user: string) =>
      runLocalPrompt({
        runtime: cfg.runtime as LocalRuntime,
        command: cfg.command || undefined,
        model: cfg.model || undefined,
        system,
        userText: user
      })
  }, [modelConfigs, modelSelections.listener])

  // The SignalEngine (extract + organize) runs on the Listener category.
  const summaryModel = useMemo(() => {
    const cfg = modelConfigAt(modelConfigs, modelSelections.listener)
    return {
      providerId: cfg.runtime === 'api' || cfg.runtime === 'ollama' ? cfg.providerId || 'groq' : cfg.runtime,
      model: cfg.model || undefined
    }
  }, [modelConfigs, modelSelections.listener])

  // ---- Project Memory: per-scope instructions + uploaded-file retrieval.
  // The scope follows the tree (canvas inside a project reads the project's
  // bucket). Inert while memoryDeps holds nulls (pre-M5 wiring): instructions
  // stay empty and buildMemoryContext resolves null — zero cost, zero effect.
  const projectMemory = useProjectMemory(tree, spaceId, memoryDeps)
  const projectMemoryRef = useRef(projectMemory)
  projectMemoryRef.current = projectMemory

  // Screen → world coords (undo the pan/zoom of the notes layer).
  const toWorld = (clientX: number, clientY: number) => {
    const r = canvasRef.current!.getBoundingClientRect()
    const v = viewRef.current
    return { x: (clientX - r.left - v.x) / v.scale, y: (clientY - r.top - v.y) / v.scale }
  }

  // World-space anchor point for the AI cursor: just outside the note's
  // bottom-right corner. Keeping the glyph and its right-growing name pill beyond
  // the note prevents the status from covering text as new bullets appear.
  // Falls back to placement geometry before a new note has rendered.
  const anchorForNote = useCallback((noteId: string): WorldPoint => {
    const el = document.querySelector(`[data-noteid="${noteId}"]`) as HTMLElement | null
    if (el) {
      const r = el.getBoundingClientRect()
      return toWorld(r.right + AI_CURSOR_NOTE_GAP_PX, r.bottom)
    }
    const note = notesRef.current.find((n) => n.id === noteId)
    const gap = AI_CURSOR_NOTE_GAP_PX / viewRef.current.scale
    return note
      ? { x: note.x + DEFAULT_NOTE_W + gap, y: note.y + DEFAULT_NOTE_H }
      : { x: 0, y: 0 }
  }, [])

  // ---- images: drop / paste a picture into the canvas ----
  // Local files can't be referenced by URL, so read them into a base64 data URL
  // — it renders directly and survives a refresh through the localStorage save.
  const fileToDataUrl = (file: File) =>
    new Promise<string>((res, rej) => {
      const r = new FileReader()
      r.onload = () => res(r.result as string)
      r.onerror = rej
      r.readAsDataURL(file)
    })

  // Which item (bullet/card/image) holds focus right now, within the given
  // note? Reads the DOM: notes carry data-noteid, each row carries data-idx.
  const focusedItemIn = (noteId: string): string | undefined => {
    const ae = document.activeElement as HTMLElement | null
    const noteEl = ae?.closest?.('[data-noteid]')
    if (!noteEl || noteEl.getAttribute('data-noteid') !== noteId) return undefined
    const idxEl = ae!.closest('[data-idx]')
    if (!idxEl) return undefined
    return notesRef.current.find((n) => n.id === noteId)?.items[Number(idxEl.getAttribute('data-idx'))]?.id
  }

  // Land an image into a note as its own line item (like a url card): inserted
  // right after the focused item (or at the end). Rendered in the AI inline-
  // image style, but the caret can land on it and Backspace deletes just it.
  const insertImage = useCallback((noteId: string, src: string, afterItemId?: string) =>
    patchNote(noteId, (n) => {
      const img: ImageItem = { kind: 'image', id: uid('img'), src, origin: 'human', status: 'kept' }
      const idx = afterItemId ? n.items.findIndex((it) => it.id === afterItemId) : -1
      const at = idx >= 0 ? idx + 1 : n.items.length
      return { ...n, items: [...n.items.slice(0, at), img, ...n.items.slice(at)] }
    }), [patchNote])

  // ⌘V while editing inside a note: if the clipboard holds an image, insert it
  // into that note at the caret. No image (plain text/URL paste) → default.
  const onPaste = useCallback(async (e: React.ClipboardEvent) => {
    const item = [...(e.clipboardData?.items || [])].find((i) => i.type.startsWith('image/'))
    const file = item?.getAsFile()
    if (!file) return
    const ae = document.activeElement as HTMLElement | null
    const noteId = ae?.closest?.('[data-noteid]')?.getAttribute('data-noteid')
    if (!noteId) return // paste only lands inside a note
    e.preventDefault()
    insertImage(noteId, await fileToDataUrl(file), focusedItemIn(noteId))
  }, [insertImage])

  // Native (non-passive) wheel listener: trackpad pinch arrives as a wheel
  // event with ctrlKey; two-finger swipe as plain deltaX/deltaY.
  useEffect(() => {
    const el = canvasRef.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const rect = el.getBoundingClientRect()
      // Pan/zoom moves the canvas under the bubble's frozen screen-space rect —
      // dismiss it rather than let it float over the wrong spot. (The context
      // HIGHLIGHT lives on the text itself, so it moves correctly and stays.)
      setBubbleSel(null)
      setView((v) => {
        if (e.ctrlKey || e.metaKey) {
          const cx = e.clientX - rect.left, cy = e.clientY - rect.top
          const scale = Math.min(3, Math.max(0.25, v.scale * Math.exp(-e.deltaY * 0.01)))
          const k = scale / v.scale
          return { x: cx - (cx - v.x) * k, y: cy - (cy - v.y) * k, scale }
        }
        return { ...v, x: v.x - e.deltaX, y: v.y - e.deltaY }
      })
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [])

  // Apply a buffered fire event to the canvas. Called by the reveal scheduler
  // when it drains (or passes through live). diagnosis/anchorId are read from
  // the revealRef record (NOT closure locals) because they arrive early but
  // are consumed late — after buffering (§9c).
  const applyFireEvent = useCallback(
    (noteId: string, fireId: string, e: BufferedFireEvent) => {
      const rec = revealRef.current.get(fireId)
      if (!rec) return
      switch (e.kind) {
        case 'diagnosis':
          rec.diagnosis = e.text
          return
        case 'anchor':
          rec.anchorId = rec.humanBullets[e.line]?.id
          return
        case 'text': {
          aiBufRef.current[fireId] = (aiBufRef.current[fireId] || '') + e.chunk
          // First text chunk: the cursor switches from "thinking" to "writing".
          if (!rec.firstTextApplied) {
            rec.firstTextApplied = true
            cursorDispatch({ type: 'label', activityId: fireId, label: 'writing', at: Date.now() })
          }
          // The model decides the amount (1-3 bullets); hard cap at 3.
          const lines = displayBulletLines(aiBufRef.current[fireId])
          setNotes((ns) =>
            ns.map((n) => {
              if (n.id !== noteId) return n
              let items = n.items
              lines.forEach((t, i) => {
                if (rejectedFireLinesRef.current.get(fireId)?.has(i)) return
                const idx = items.findIndex((it) => isBullet(it) && it.fireId === fireId && it.fireLine === i)
                if (idx >= 0) {
                  const cur = items[idx] as BulletItem
                  if (cur.status !== 'pending' || cur.text === t) return
                  items = [...items.slice(0, idx), { ...cur, text: t }, ...items.slice(idx + 1)]
                } else {
                  items = insertAnchored(items, { kind: 'bullet', id: uid('b'), origin: 'ai', fireId, fireLine: i, diagnosis: rec.diagnosis, text: t, status: 'pending' }, rec.anchorId)
                }
              })
              return items === n.items ? n : { ...n, items }
            })
          )
          return
        }
        case 'urls': {
          cursorDispatch({ type: 'label', activityId: fireId, label: 'found sources', at: Date.now() })
          patchNote(noteId, (n) => {
            const cards = e.urls.slice(0, 3).map((u): CardItem => ({ ...u, kind: 'card', id: uid('c'), origin: 'ai', status: 'pending', diagnosis: rec.diagnosis }))
            let at = n.items.length
            for (let j = n.items.length - 1; j >= 0; j--) {
              const it = n.items[j]
              if (isBullet(it) && it.fireId === fireId) { at = j + 1; break }
            }
            return { ...n, items: [...n.items.slice(0, at), ...cards, ...n.items.slice(at)] }
          })
          return
        }
        case 'image': {
          patchNote(noteId, (n) => {
            let idx = n.items.findIndex((it) => isBullet(it) && it.fireId === fireId && it.fireLine === e.line && !it.image)
            if (idx < 0) {
              for (let j = n.items.length - 1; j >= 0; j--) {
                const it = n.items[j]
                if (isBullet(it) && it.fireId === fireId && !it.image) { idx = j; break }
              }
            }
            if (idx < 0) return n
            const cur = n.items[idx] as BulletItem
            const items = [...n.items]
            items[idx] = { ...cur, image: { src: e.src, sourceUrl: e.sourceUrl, title: e.title } }
            return { ...n, items }
          })
          return
        }
      }
    },
    [patchNote]
  )

  // ---- AI co-creation: each fire DIAGNOSES what the note needs most (invisible
  // to the user), then contributes what the diagnosis calls for — 1-3 bullets,
  // or nothing at all (PASS). Appended, never replacing prior suggestions;
  // informed by the transcript, the note, and diagnosis-tagged KEPT / REJECTED
  // reactions. Reads accumulate → the next diagnosis sharpens.
  const runAi = useCallback(
    async (noteId: string, command?: string) => {
      const note = notesRef.current.find((n) => n.id === noteId)
      if (!note) return

      const isCommand = typeof command === 'string' && command.trim().length > 0
      if (!isCommand && !aiEnabledRef.current) return // ambient fires respect the switch

      const humanBullets = note.items.filter((i): i is BulletItem => isBullet(i) && i.origin === 'human' && !!i.text.trim())
      const seed = note.keyword.trim() || humanBullets[0]?.text || ''
      // Only PERMANENT (kept) AI content is context for the next call; pending
      // suggestions are temporary — they may be rejected, so they don't count.
      const existingIdeas = note.items
        .filter((i) => i.origin === 'ai' && i.status === 'kept')
        .map((i) => (isBullet(i) ? i.text : isCard(i) ? i.title : ''))
        .filter(Boolean)
      const fireId = uid('f')
      aiBufRef.current[fireId] = ''
      const controller = new AbortController()
      firesRef.current.set(fireId, { controller, isCommand })
      patchNote(noteId, (n) => ({ ...n, aiRunning: true }))
      // Serialized reveal: events buffer until this activity becomes current,
      // then drain in push order. diagnosis/anchorId are produced early but
      // consumed when text is APPLIED (potentially much later) — so they live
      // in the revealRef record, NOT closure locals (§9c).
      const scheduler = createRevealScheduler()
      revealRef.current.set(fireId, {
        noteId,
        scheduler,
        humanBullets,
        firstTextApplied: false,
        hasDisplayOutput: false,
        receivedText: ''
      })
      cursorDispatch({ type: 'start', activityId: fireId, target: anchorForNote(noteId), at: Date.now() })

      // Rule B (keyword-dragged note) beats rule A (rolling window); an empty
      // slice — nothing recorded, or nothing said in the window — sends none.
      const transcriptWindow =
        note.originTs !== undefined
          ? transcriptSlice(note.originTs - 60_000, note.originTs + 60_000)
          : transcriptSlice(Date.now() - 120_000, Infinity)
      // Typed signals follow the same window rules, except rule A widens to the
      // extraction cadence (signals land every ~2min, so a 2min window is often
      // empty right after a batch).
      const signalWindow =
        note.originTs !== undefined
          ? signalSlice(note.originTs - 60_000, note.originTs + 60_000)
          : signalSlice(Date.now() - 300_000, Infinity)

      // Project Memory: Stage-A selection sees the task (command or seed +
      // note bullets) plus the same windows the main call gets — never file
      // contents. Resolves null (skipped) on empty catalog; never throws.
      const pm = projectMemoryRef.current
      const memoryTask = [
        isCommand ? `Command: ${command!.trim()}` : `Current focus: ${seed}`,
        humanBullets.length ? `Note bullets:\n${humanBullets.map((b) => `- ${b.text}`).join('\n')}` : '',
        transcriptWindow ? `Transcript:\n${transcriptWindow}` : '',
        signalWindow ? `Signals:\n${signalWindow}` : ''
      ]
        .filter(Boolean)
        .join('\n\n')
      const memory = await pm.buildMemoryContext(memoryTask, {
        call: memorySelectionCall(),
        allowWebSearch: isCommand
      })

      const result = await requestCocreate(
        {
          projectInstructions: isCommand ? pm.instructions.aiCommand : pm.instructions.coCreation,
          projectMemory: memory ?? undefined,
          seedText: seed,
          seedType: note.originSignalType,
          command,
          // Leading spaces mirror outline depth so the model sees the structure
          // it anchors into (the server numbers these lines for ANCHOR).
          contextNotes: humanBullets.map((b) => '  '.repeat(b.indent ?? 0) + b.text),
          kept: note.kept,
          rejected: note.rejected,
          existingIdeas,
          transcriptWindow,
          signalWindow,
          ...providerArgs()
        },
        {
          onDiagnosis: (d) => scheduler.push({ kind: 'diagnosis', text: d }),
          onAnchor: (line) => scheduler.push({ kind: 'anchor', line }),
          onText: (chunk) => {
            const rec = revealRef.current.get(fireId)
            if (rec) {
              rec.receivedText += chunk
              if (displayBulletLines(rec.receivedText).length) rec.hasDisplayOutput = true
            }
            scheduler.push({ kind: 'text', chunk })
          },
          onUrls: (urls) => {
            const rec = revealRef.current.get(fireId)
            if (urls.length && rec) rec.hasDisplayOutput = true
            scheduler.push({ kind: 'urls', urls })
          },
          onImage: (img) => {
            const rec = revealRef.current.get(fireId)
            if (rec) rec.hasDisplayOutput = true
            scheduler.push({ kind: 'image', src: img.src, sourceUrl: img.sourceUrl, title: img.title, line: img.line })
          }
        },
        controller.signal
      )

      firesRef.current.delete(fireId)
      rejectedFireLinesRef.current.delete(fireId)
      if (result.aborted) {
        // Cancelled by the switch: discard this fire's partial suggestions and
        // drop any buffered content that was never applied to the canvas.
        scheduler.cancel()
        delete aiBufRef.current[fireId]
        patchNote(noteId, (n) => ({
          ...n,
          aiRunning: false,
          items: n.items.filter((it) => !(isBullet(it) && it.fireId === fireId))
        }))
        cursorDispatch({ type: 'end', activityId: fireId, linger: false, at: Date.now() })
        revealRef.current.delete(fireId)
        return
      }

      const reveal = revealRef.current.get(fireId)
      if (result.error && reveal && !reveal.hasDisplayOutput) {
        // Keep errors in the same serialized reveal path as normal AI output.
        // aiBufRef only tracks APPLIED text, so it is empty while this activity
        // waits behind another one even if the provider already streamed text.
        reveal.hasDisplayOutput = true
        scheduler.push({ kind: 'text', chunk: `⚠ ${result.error}` })
      }
      patchNote(noteId, (n) => ({ ...n, aiRunning: false }))
      if (!result.error && !reveal?.hasDisplayOutput) {
        // PASS (or an otherwise empty successful completion) has no canvas
        // payload to reveal. Remove it from the FIFO immediately so it cannot
        // leave a truthful-but-misleading "thinking" cursor behind or block a
        // queued observer/co-creation activity.
        scheduler.cancel()
        revealRef.current.delete(fireId)
        delete aiBufRef.current[fireId]
        cursorDispatch({ type: 'end', activityId: fireId, linger: false, at: Date.now() })
        return
      }
      // Signal the scheduler that no more events will arrive. The done()
      // callback (wired in the currentId effect) dispatches 'end' once the
      // queue drains — don't dispatch end here.
      scheduler.finish()
    },
    [patchNote, providerArgs, memorySelectionCall, transcriptSlice, anchorForNote]
  )

  // ---- serialized reveal gate: when an activity becomes current, start
  // draining its buffered events in push order. The done() callback dispatches
  // 'end' once the queue is empty AND finish() has been called (§9d).
  useEffect(() => {
    const id = cursor.currentId
    if (!id) return
    const rec = revealRef.current.get(id)
    if (!rec) {
      promoteNonCocreateRef.current(id)
      return
    }
    if (rec.scheduler.isLive()) return // already draining (effect re-fired)
    rec.scheduler.goLive(
      (e) => applyFireEvent(rec.noteId, id, e),
      () => {
        cursorDispatch({ type: 'end', activityId: id, at: Date.now() })
        revealRef.current.delete(id)
      }
    )
  }, [cursor.currentId, applyFireEvent])

  // ---- cursor fade tick: a 5s interval that dispatches 'tick' so the reducer
  // can hide the cursor after the 2-min idle window. Only runs while visible
  // to avoid unnecessary renders when the cursor is already hidden (§9f).
  useEffect(() => {
    if (!cursor.visible) return
    const id = setInterval(() => {
      cursorDispatch({ type: 'tick', at: Date.now() })
    }, 5000)
    return () => clearInterval(id)
  }, [cursor.visible])

  // ---- the trigger: fire once each time human word count grows by 20, but
  // only after ≥5s without a keystroke in that note. Word growth says the note
  // has enough new thought to react to; the idle wait keeps AI content from
  // landing mid-typing and dragging attention away from the thought in flight.
  const lastEditRef = useRef(new Map<string, { sig: string; at: number }>())
  useEffect(() => {
    // Record edit times: any change to a note's human text stamps "now".
    const now = Date.now()
    for (const n of notes) {
      const sig = humanSig(n)
      const rec = lastEditRef.current.get(n.id)
      if (!rec || rec.sig !== sig) lastEditRef.current.set(n.id, { sig, at: now })
    }
    if (!aiEnabled) return
    const check = () => {
      if (!isActiveRef.current) return // ambient fires only on the active canvas
      for (const n of notesRef.current) {
        if (n.aiRunning || n.keywordEditing) continue
        const words = humanWords(n)
        const at = lastEditRef.current.get(n.id)?.at ?? 0
        if (words - n.lastFiredWords >= 20 && Date.now() - at >= IDLE_MS) {
          patchNote(n.id, (x) => ({ ...x, lastFiredWords: words }))
          void runAi(n.id)
        }
      }
    }
    check()
    // Re-check while waiting out the idle window (cleared on every notes change).
    const t = setInterval(check, 1000)
    return () => clearInterval(t)
  }, [notes, aiEnabled, patchNote, runAi])

  // ---- AI co-creation switch. Back ON resets each note's baseline to its
  // CURRENT word count, so writing done while off never triggers a burst of
  // stale suggestions. OFF cancels in-flight ambient fires (commands finish).
  const toggleAi = useCallback(() => {
    if (modelConfigs.length === 0) return
    const next = !aiEnabledRef.current
    if (next) {
      setNotes((ns) => ns.map((n) => ({ ...n, lastFiredWords: humanWords(n) })))
    } else {
      for (const f of firesRef.current.values()) {
        if (!f.isCommand) f.controller.abort()
      }
    }
    setAiEnabled(next)
  }, [modelConfigs.length])

  // ---- Tier-3: persistent context highlight --------------------------------
  // Painted from the frozen snapshot (bubble open or session running), rebuilt
  // after every notes render (React replaces the DOM nodes). It lives on the
  // real text, so pan/zoom/drag move it for free. Clears when the conversation
  // officially ends (panel close / bubble dismissed without submitting).
  const activeSnapshot = session?.source ?? bubbleSel
  useEffect(() => {
    if (!activeSnapshot) {
      clearContextHighlight()
      return
    }
    paintContextHighlight(activeSnapshot, notes.find((n) => n.id === activeSnapshot.noteId))
  }, [activeSnapshot, notes])
  useEffect(() => () => clearContextHighlight(), []) // unmount (space closed)

  // Click anywhere outside the bubble dismisses it (the bubble stops its own
  // pointerdown from reaching the document). No session started → the
  // highlight clears with it via the effect above.
  useEffect(() => {
    if (!bubbleSel) return
    // Belt and braces: the bubble already stops its own pointerdown from
    // bubbling, but ALSO check the target — event-order quirks (touch,
    // synthetic events) must never let a click INSIDE the bubble dismiss it.
    const onDown = (e: PointerEvent) => {
      if ((e.target as HTMLElement | null)?.closest?.('.cmd-bubble')) return
      setBubbleSel(null)
    }
    document.addEventListener('pointerdown', onDown)
    return () => document.removeEventListener('pointerdown', onDown)
  }, [bubbleSel])

  // A settled text selection inside a note summons the bubble (already
  // snapshot-shaped — freezing IS receiving it).
  const onNoteTextSelection = useCallback((sel: SelectionSnapshot) => {
    setBubbleSel(sel)
  }, [])

  // One chat turn: append the user message + a streaming assistant message,
  // send the FULL history plus freshly captured context (the backends are
  // stateless), and stream text/action events into the assistant message.
  const sendTurn = useCallback(async (text: string) => {
    const cur = sessionRef.current
    if (!cur) return
    const userMsg: CommandMessage = { id: uid('m'), role: 'user', text }
    const asstMsg: CommandMessage = { id: uid('m'), role: 'assistant', text: '', pending: true }
    const history = [...cur.messages, userMsg]
    const next = { ...cur, messages: [...history, asstMsg] }
    sessionRef.current = next
    setSession(next)
    setChatStreaming(true)

    const note = cur.source ? notesRef.current.find((n) => n.id === cur.source!.noteId) : undefined
    // 1 min TOTAL of verbatim transcript (Tier-3 window is half of Tier-2's):
    // dragged note → ±30s around when its keyword was spoken; else last 60s.
    const transcriptWindow =
      note?.originTs !== undefined
        ? transcriptSlice(note.originTs - 30_000, note.originTs + 30_000)
        : transcriptSlice(Date.now() - 60_000, Infinity)

    const controller = new AbortController()
    chatAbortRef.current = controller
    const fireId = uid('cf')
    firesRef.current.set(fireId, { controller, isCommand: true })

    const patchAsst = (fn: (m: CommandMessage) => CommandMessage) =>
      setSession((s) => {
        if (!s) return s
        const upd = { ...s, messages: s.messages.map((m) => (m.id === asstMsg.id ? fn(m) : m)) }
        sessionRef.current = upd
        return upd
      })

    // Project Memory: select against the user's message + selected text (the
    // chat's primary referents). Null on empty catalog; never throws.
    const pm = projectMemoryRef.current
    const memoryTask = [
      `Current request: ${text}`,
      cur.source?.selectedText ? `Selected text: ${cur.source.selectedText}` : '',
      note?.keyword ? `Source note keyword: ${note.keyword}` : '',
      note ? `Source note bullets:\n${note.items.flatMap((i) => isBullet(i) && i.origin === 'human' && i.text.trim() ? [`- ${i.text}`] : []).join('\n')}` : '',
      transcriptWindow ? `Transcript:\n${transcriptWindow}` : '',
      history.length > 1 ? `Conversation:\n${history.map((m) => `${m.role}: ${m.text}`).join('\n')}` : ''
    ].filter(Boolean).join('\n\n')
    const memory = await pm.buildMemoryContext(memoryTask, {
      call: memorySelectionCall(),
      allowWebSearch: true
    })

    const result = await requestCommandChat(
      {
        projectInstructions: pm.instructions.aiCommand,
        projectMemory: memory ?? undefined,
        ...providerArgs(),
        messages: history.map((m) => ({ role: m.role, text: m.text })),
        context: buildTurnContext(note, cur.source, transcriptWindow)
      },
      {
        onText: (t) => patchAsst((m) => ({ ...m, text: m.text + t })),
        onSource: (source) => patchAsst((m) => ({ ...m, sources: [...(m.sources || []), source] })),
        onAction: (action) =>
          patchAsst((m) => ({ ...m, actions: [...(m.actions || []), { id: uid('a'), action }] }))
      },
      controller.signal
    )

    firesRef.current.delete(fireId)
    setChatStreaming(false)
    if (result.aborted) return // panel closed / session replaced mid-stream
    patchAsst((m) => ({
      ...m,
      pending: false,
      text: result.error ? (m.text ? `${m.text}\n⚠ ${result.error}` : `⚠ ${result.error}`) : m.text
    }))
  }, [providerArgs, memorySelectionCall, transcriptSlice])

  // Open a session from the bubble (snapshot) or the bottom bar (null source),
  // replacing any previous one — its stream is aborted, its highlight replaced.
  const openCommandSession = useCallback((source: SelectionSnapshot | null, firstCommand: string) => {
    chatAbortRef.current?.abort()
    const title = firstCommand.length > 42 ? firstCommand.slice(0, 42) + '…' : firstCommand
    const s: CommandSession = { id: uid('cs'), source, title, messages: [], createdAt: Date.now() }
    sessionRef.current = s
    setSession(s)
    setBubbleSel(null)
    void sendTurn(firstCommand)
  }, [sendTurn])

  // Officially close the conversation: abort the stream; the highlight clears
  // via the snapshot effect.
  const closeCommandSession = useCallback(() => {
    chatAbortRef.current?.abort()
    sessionRef.current = null
    setSession(null)
    setChatStreaming(false)
  }, [])

  // Apply one proposed action: content lands as PENDING AI items (the user's
  // ✓ is what settles it), and the button locks as applied.
  const onApplyAction = useCallback((messageId: string, actionId: string) => {
    const cur = sessionRef.current
    const msg = cur?.messages.find((m) => m.id === messageId)
    const pa = msg?.actions?.find((a) => a.id === actionId)
    if (!cur || !pa || pa.applied) return
    // Where a create-note action lands: beside the source note, else at a
    // visible spot in the current view.
    const src = cur.source ? notesRef.current.find((n) => n.id === cur.source!.noteId) : undefined
    let createAt = { x: 80, y: 80 }
    if (src) createAt = { x: src.x + 340, y: src.y }
    else if (canvasRef.current) {
      const r = canvasRef.current.getBoundingClientRect()
      const v = viewRef.current
      createAt = { x: (r.width * 0.35 - v.x) / v.scale, y: (r.height * 0.3 - v.y) / v.scale }
    }
    setNotes((ns) => applyAction(ns, pa.action, createAt))
    setSession((s) => {
      if (!s) return s
      const upd = {
        ...s,
        messages: s.messages.map((m) =>
          m.id === messageId
            ? { ...m, actions: m.actions?.map((a) => (a.id === actionId ? { ...a, applied: true } : a)) }
            : m
        )
      }
      sessionRef.current = upd
      return upd
    })
  }, [])

  // ---- canvas: drag blank = marquee-select (框选); plain click = new note ----
  const onCanvasPointerDown = useCallback((e: React.PointerEvent) => {
    if (e.target !== canvasRef.current && e.target !== layerRef.current) return // only on truly blank space
    const startC = { x: e.clientX, y: e.clientY }
    const rect = canvasRef.current!.getBoundingClientRect()
    const start = { x: e.clientX - rect.left, y: e.clientY - rect.top } // screen-space (marquee)
    const startW = toWorld(e.clientX, e.clientY) // world-space (new note)
    let moved = false

    const move = (ev: PointerEvent) => {
      if (Math.abs(ev.clientX - startC.x) > 4 || Math.abs(ev.clientY - startC.y) > 4) moved = true
      const cur = { x: ev.clientX - rect.left, y: ev.clientY - rect.top }
      const l = Math.min(start.x, cur.x), t = Math.min(start.y, cur.y)
      const w = Math.abs(cur.x - start.x), h = Math.abs(cur.y - start.y)
      setMarquee({ l, t, w, h })
      if (!moved) return
      const box = { left: l, top: t, right: l + w, bottom: t + h }
      const sel = new Set<string>()
      const hit = (selector: string, id: string) => {
        const el = document.querySelector(selector) as HTMLElement | null
        if (!el) return
        const r = el.getBoundingClientRect()
        const nb = { left: r.left - rect.left, top: r.top - rect.top, right: r.right - rect.left, bottom: r.bottom - rect.top }
        if (nb.left < box.right && nb.right > box.left && nb.top < box.bottom && nb.bottom > box.top) sel.add(id)
      }
      for (const n of notesRef.current) hit(`[data-noteid="${n.id}"]`, n.id)
      for (const im of imagesRef.current) hit(`[data-imageid="${im.id}"]`, im.id)
      setSelectedIds(sel)
    }
    const up = () => {
      document.removeEventListener('pointermove', move)
      document.removeEventListener('pointerup', up)
      setMarquee(null)
      if (!moved) {
        const id = uid('n')
        // A fresh note starts in typing mode, NOT selected — the selection
        // rectangle is a drag-select (marquee) affordance, not a "new" marker.
        setNotes((ns) => [...ns, { id, x: startW.x, y: startW.y, keyword: '', keywordEditing: true, items: [], aiRunning: false, kept: [], rejected: [], lastFiredWords: 0 }])
        setSelectedIds(new Set())
      }
    }
    document.addEventListener('pointermove', move)
    document.addEventListener('pointerup', up)
  }, [])

  // ---- canvas: drop an image file, or a transcript keyword ----
  const onDrop = useCallback(async (e: React.DragEvent) => {
    // Image file? Land it before the text branch (a file drop carries no
    // text/plain, so the early-return below would let the browser open it).
    const file = [...(e.dataTransfer.files || [])].find((f) => f.type.startsWith('image/'))
    if (file) {
      e.preventDefault()
      // Priority: dropped onto a note → into that note as an image item; else
      // the selected note; else a standalone floating image at the drop point.
      const dropNoteEl = (e.target as HTMLElement).closest('[data-noteid]')
      const targetNoteId = dropNoteEl?.getAttribute('data-noteid') ?? [...selectedIdsRef.current][0] ?? null
      const { x, y } = toWorld(e.clientX, e.clientY)
      const src = await fileToDataUrl(file)
      if (targetNoteId && notesRef.current.some((n) => n.id === targetNoteId)) {
        insertImage(targetNoteId, src, focusedItemIn(targetNoteId))
      } else {
        const id = uid('img')
        setImages((is) => [...is, { id, x, y, src }])
        setSelectedIds(new Set([id]))
      }
      return
    }

    const text = e.dataTransfer.getData('text/plain').trim()
    if (!text) return
    e.preventDefault()
    // When the drag came from the transcript it carries the spoken-at timestamp
    // of its first selected line — the note keeps it for life (rule B anchor).
    const tsData = e.dataTransfer.getData('application/x-transcript-ts')
    const originTs = tsData ? Number(tsData) : undefined
    // The dragged line's signal type rides along (recorded, never rendered) so
    // co-creation knows what kind of thought seeded this note.
    const originSignalType = e.dataTransfer.getData('application/x-signal-type') || undefined
    const { x, y } = toWorld(e.clientX, e.clientY)
    const id = uid('n')
    setNotes((ns) => [
      ...ns,
      {
        id, x, y, keyword: text, keywordEditing: false, aiRunning: false,
        kept: [], rejected: [], lastFiredWords: 0, sourceText: text,
        ...(Number.isFinite(originTs) ? { originTs } : {}),
        ...(originSignalType ? { originSignalType } : {}),
        items: [{ kind: 'bullet', id: uid('b'), origin: 'human', text: '', status: 'kept', editing: true }]
      }
    ])
    setSelectedIds(new Set())
  }, [insertImage])

  // ---- keyword header editing ----
  const onKeywordEdit = (id: string) => () =>
    patchNote(id, (n) => ({ ...n, keywordEditing: true }))

  const onKeywordChange = (id: string) => (text: string) =>
    patchNote(id, (n) => ({ ...n, keyword: text }))

  const onKeywordCommit = (id: string) => () => {
    const n = notesRef.current.find((x) => x.id === id)
    if (!n) return
    if (!n.keyword.trim() && n.items.length === 0) {
      setNotes((ns) => ns.filter((x) => x.id !== id)) // empty click → discard
      return
    }
    patchNote(id, (nn) => ({
      ...nn,
      keywordEditing: false,
      items: nn.items.length
        ? nn.items
        : [{ kind: 'bullet', id: uid('b'), origin: 'human', text: '', status: 'kept', editing: true }]
    }))
  }

  // ---- bullet editing ----
  const onBulletChange = (id: string) => (bulletId: string, text: string) =>
    patchNote(id, (n) => ({ ...n, items: n.items.map((it) => (it.id === bulletId && isBullet(it) ? { ...it, text } : it)) }))

  // Tab / Shift+Tab: push a bullet one outline level deeper / shallower.
  const onIndentBullet = (id: string) => (bulletId: string, delta: number) =>
    patchNote(id, (n) => ({
      ...n,
      items: n.items.map((it) =>
        it.id === bulletId && isBullet(it)
          ? { ...it, indent: Math.max(0, Math.min(3, (it.indent ?? 0) + delta)) }
          : it
      )
    }))

  // Replace one bullet with its committed form (URL cards split out, optional
  // fresh editing bullet after) — splice keeps the item's position in the flow.
  const spliceCommit = (id: string, bulletId: string, continueOutline: boolean) =>
    patchNote(id, (n) => {
      const idx = n.items.findIndex((it) => it.id === bulletId)
      const b = n.items[idx]
      if (!b || !isBullet(b)) return n
      return { ...n, items: [...n.items.slice(0, idx), ...commitBullet(b, continueOutline), ...n.items.slice(idx + 1)] }
    })

  // ⏎ inside any bullet — human or laid-down AI — commits it and opens a fresh
  // bullet right below. ⏎ on an empty bullet removes it (end of the outline).
  const onBulletEnter = (id: string) => (bulletId: string) => spliceCommit(id, bulletId, true)

  // Blur a bullet: commit it (empty → remove). No new bullet on blur. Bullets
  // are always contentEditable, so a click edits in place natively — no
  // separate "enter edit mode" step needed.
  const onBulletBlur = (id: string) => (bulletId: string) => spliceCommit(id, bulletId, false)

  // Merge a bullet into its neighbour (⌫ at start → 'prev', ⌦ at end → 'next'):
  // the two texts join, the emptied-out bullet is dropped, and a lone inline
  // image rides along so it isn't lost. Caret placement is handled in the view.
  const onMergeBullet = (id: string) => (bulletId: string, dir: 'prev' | 'next') =>
    patchNote(id, (n) => {
      const idx = n.items.findIndex((it) => it.id === bulletId)
      if (idx < 0) return n
      const keepIdx = dir === 'prev' ? idx - 1 : idx
      const dropIdx = dir === 'prev' ? idx : idx + 1
      const keep = n.items[keepIdx]
      const drop = n.items[dropIdx]
      if (!keep || !drop || !isBullet(keep) || !isBullet(drop)) return n
      const merged: BulletItem = {
        ...keep,
        text: keep.text + drop.text,
        image: keep.image ?? drop.image
      }
      return { ...n, items: n.items.map((it, i) => (i === keepIdx ? merged : it)).filter((_, i) => i !== dropIdx) }
    })

  // Delete a drag-selected span that crosses bullets: keep the head of the
  // start bullet and the tail of the end bullet, drop everything between, and
  // fuse the two survivors into one bullet (caret lands at the seam — set in
  // the view). A lone inline image on either survivor rides along.
  const onDeleteRange = (id: string) => (startId: string, startOff: number, endId: string, endOff: number) =>
    patchNote(id, (n) => {
      const si = n.items.findIndex((it) => it.id === startId)
      const ei = n.items.findIndex((it) => it.id === endId)
      if (si < 0 || ei < 0 || si >= ei) return n
      const s = n.items[si]
      const e = n.items[ei]
      if (!isBullet(s) || !isBullet(e)) return n
      const merged: BulletItem = {
        ...s,
        text: s.text.slice(0, startOff) + e.text.slice(endOff),
        image: s.image ?? e.image
      }
      return { ...n, items: [...n.items.slice(0, si), merged, ...n.items.slice(ei + 1)] }
    })

  // ⌘A-then-delete: remove the whole note as one block (empty notes are
  // discarded anyway), clearing any canvas selection it was part of.
  const onDeleteNote = (id: string) => () => {
    setNotes((ns) => ns.filter((n) => n.id !== id))
    setSelectedIds((s) => {
      if (!s.has(id)) return s
      const next = new Set(s)
      next.delete(id)
      return next
    })
  }

  // Right-click a note: select it (so the menu clearly targets one note) and
  // open the duplicate/rename/delete menu at the cursor.
  const onNoteContextMenu = (id: string) => (e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setSelectedIds(new Set([id]))
    setNoteMenu({ id, x: e.clientX, y: e.clientY })
  }

  // Clone a note with fresh ids (note + every item) so it doesn't collide with
  // the original in localStorage, offset a bit so the copy is visibly distinct,
  // and select the copy (not the original) since that's what the user just made.
  const onDuplicateNote = (id: string) => {
    const n = notesRef.current.find((x) => x.id === id)
    if (!n) return
    const copy: KeywordNote = {
      ...n,
      id: uid('n'),
      x: n.x + 24,
      y: n.y + 24,
      keywordEditing: false,
      items: n.items.map((it) => ({ ...it, id: uid(it.kind) }))
    }
    setNotes((ns) => [...ns, copy])
    setSelectedIds(new Set([copy.id]))
    setNoteMenu(null)
  }

  const onDeleteNoteFromMenu = (id: string) => {
    onDeleteNote(id)()
    setNoteMenu(null)
  }

  // ⏎ on a focused inline URL card: start a new line right after it.
  const onInsertAfter = (id: string) => (itemId: string) =>
    patchNote(id, (n) => {
      const idx = n.items.findIndex((it) => it.id === itemId)
      if (idx < 0) return n
      const fresh: NoteItem = { kind: 'bullet', id: uid('b'), origin: 'human', text: '', status: 'kept', editing: true }
      return { ...n, items: [...n.items.slice(0, idx + 1), fresh, ...n.items.slice(idx + 1)] }
    })

  // Keep/reject on an observer-created note is clean feedback for the engine's
  // rejection backoff (mid-session ignores deliberately do NOT count). No-op on
  // ordinary human / reactive-co-creation notes.
  const recordObserverOutcome = (id: string, outcome: ObserverOutcome) => {
    if (!notesRef.current.find((n) => n.id === id)?.observerMeta) return
    observerRef.current?.recordOutcome(outcome)
    if (observerRef.current) saveJSON(k('observer-state'), observerRef.current.getState())
  }

  // ---- accept / reject (records reaction signals that sharpen the next fire;
  // each entry carries the fire's diagnosis so the model learns which KINDS of
  // help this user wants) ----
  const keepBullet = (id: string) => (bid: string) => {
    patchNote(id, (n) => {
      const b = n.items.find((x) => x.id === bid)
      return {
        ...n,
        items: n.items.map((x) => (x.id === bid && isBullet(x) ? { ...x, status: 'kept' } : x)),
        kept: b && isBullet(b) ? [...n.kept, withDiag(b.text, b.diagnosis)] : n.kept
      }
    })
    recordObserverOutcome(id, 'kept')
  }
  const rejectBullet = (id: string) => (bid: string) => {
    // Remember the fire-line OUTSIDE the state updater (updaters must stay
    // pure), so a still-streaming fire can't recreate the rejected bullet.
    const rb = notesRef.current.find((n) => n.id === id)?.items.find((x) => x.id === bid)
    if (rb && isBullet(rb) && rb.fireId && rb.fireLine !== undefined) {
      const set = rejectedFireLinesRef.current.get(rb.fireId) || new Set<number>()
      set.add(rb.fireLine)
      rejectedFireLinesRef.current.set(rb.fireId, set)
    }
    patchNote(id, (n) => {
      const b = n.items.find((x) => x.id === bid)
      return {
        ...n,
        items: n.items.filter((x) => x.id !== bid),
        rejected: b && isBullet(b) ? [...n.rejected, withDiag(b.text, b.diagnosis)] : n.rejected
      }
    })
    recordObserverOutcome(id, 'rejected')
  }
  const keepCard = (id: string) => (cid: string) => {
    patchNote(id, (n) => {
      const c = n.items.find((x) => x.id === cid)
      return {
        ...n,
        items: n.items.map((x) => (x.id === cid && isCard(x) ? { ...x, status: 'kept' } : x)),
        kept: c && isCard(c) ? [...n.kept, withDiag(c.title, c.diagnosis)] : n.kept
      }
    })
    recordObserverOutcome(id, 'kept')
  }
  // Removes an in-note image line (⌫ on a focused image, like removing a card).
  const removeImageItem = (id: string) => (imgId: string) =>
    patchNote(id, (n) => ({ ...n, items: n.items.filter((x) => x.id !== imgId) }))

  // Removes a card line. Rejecting a PENDING AI card records a reaction signal;
  // deleting a settled card (⌫ on a focused card) is just deletion.
  const removeCard = (id: string) => (cid: string) => {
    const c0 = notesRef.current.find((n) => n.id === id)?.items.find((x) => x.id === cid)
    const wasPending0 = c0 && isCard(c0) && c0.status === 'pending'
    patchNote(id, (n) => {
      const c = n.items.find((x) => x.id === cid)
      const wasPending = c && isCard(c) && c.status === 'pending'
      return {
        ...n,
        items: n.items.filter((x) => x.id !== cid),
        rejected: wasPending && isCard(c) ? [...n.rejected, withDiag(c.title, c.diagnosis)] : n.rejected
      }
    })
    if (wasPending0) recordObserverOutcome(id, 'rejected')
  }

  // Whole-note keep/dismiss for a purely AI-generated observer note: unlike
  // co-creation bullets (judged line by line), an observer note is accepted or
  // dismissed as ONE unit via its bottom-right ✓/✕, and records a single
  // engine outcome.
  const keepNote = (id: string) => () => {
    patchNote(id, (n) => {
      const keptTexts = n.items
        .map((x) =>
          isBullet(x) && x.status === 'pending'
            ? withDiag(x.text, x.diagnosis)
            : isCard(x) && x.status === 'pending'
              ? withDiag(x.title, x.diagnosis)
              : null
        )
        .filter((t): t is string => t !== null)
      return {
        ...n,
        items: n.items.map((x) =>
          (isBullet(x) || isCard(x)) && x.status === 'pending' ? { ...x, status: 'kept' } : x
        ),
        kept: [...n.kept, ...keptTexts]
      }
    })
    recordObserverOutcome(id, 'kept')
  }
  const rejectNote = (id: string) => () => {
    recordObserverOutcome(id, 'rejected') // read before the note is removed
    onDeleteNote(id)()
  }

  // ---- Observer engine wiring -----------------------------------------------
  // Keep the two category assignments current so a mid-session model switch is
  // honored by the engine deps (which read these refs live).
  useEffect(() => {
    const toAssign = (id: string): CategoryAssignment => {
      const cfg = modelConfigAt(modelConfigs, id)
      return { runtime: cfg.runtime, providerId: cfg.providerId, model: cfg.model || undefined, command: cfg.command || undefined }
    }
    listenerAssignRef.current = toAssign(modelSelections.listener)
    thinkerAssignRef.current = toAssign(modelSelections.thinker)
  }, [modelConfigs, modelSelections])

  // Dominant language of the last ~5 min of speech: CJK-vs-latin char ratio.
  const observerDominantLanguage = useCallback((): string | undefined => {
    const w = transcriptSlice(Date.now() - 300_000, Infinity)
    if (!w) return undefined
    const cjk = (w.match(/[一-鿿]/g) || []).length
    const latin = (w.match(/[A-Za-z]/g) || []).length
    if (cjk === 0 && latin === 0) return undefined
    return cjk >= latin ? 'zh' : 'en'
  }, [transcriptSlice])

  // Canvas context the evaluator/contributor read (contract seam). Note titles +
  // kept content, kept/rejected aggregates, existing card URLs, transcript window.
  const getObserverContext = useCallback((): ObserverCanvasContext => {
    const ns = notesRef.current
    const noteTitles: string[] = []
    const settledParts: string[] = []
    const existingUrls: string[] = []
    const kept: string[] = []
    const rejected: string[] = []
    for (const n of ns) {
      if (n.keyword.trim()) noteTitles.push(n.keyword.trim())
      const keptText = n.items.flatMap((it) => (isBullet(it) && it.status === 'kept' && it.text.trim() ? [it.text] : []))
      if (n.keyword.trim() || keptText.length) {
        settledParts.push([n.keyword.trim(), ...keptText.map((t) => `- ${t}`)].filter(Boolean).join('\n'))
      }
      for (const it of n.items) if (isCard(it) && it.url) existingUrls.push(it.url)
      kept.push(...n.kept)
      rejected.push(...n.rejected)
    }
    return {
      noteTitles,
      settledContent: settledParts.join('\n\n').slice(0, 4000),
      kept,
      rejected,
      existingUrls,
      transcriptWindow: transcriptSlice(Date.now() - 300_000, Infinity),
      dominantLanguage: observerDominantLanguage()
    }
  }, [transcriptSlice, observerDominantLanguage])

  // Observer cursor activity tracking. The activityId is generated in
  // onContributeStart; the emission is HELD when onEmit fires and the note is
  // created only when that activity's turn in the reveal queue comes — so
  // observer notes obey the same one-at-a-time rule as co-creation fires.
  // Held emissions are transient (lost on unmount), like all cursor state.
  const obsCounterRef = useRef(0)
  const obsActivityIdRef = useRef<string | null>(null)
  const heldObserverEmitsRef = useRef(new Map<string, ObserverEmission>())
  // Latest currentId for engine callbacks (they outlive any single render).
  const cursorCurrentIdRef = useRef(cursor.currentId)
  cursorCurrentIdRef.current = cursor.currentId

  // Build + place the observer note: a pending, AI-originated keyword note
  // near the viewport center without overlapping existing notes, whole note
  // at once (bullets uncapped, cards as-is). Human content is never touched
  // (this only appends a new note). Placement is computed fresh at creation
  // time; returns the placed position for the cursor to move to.
  const createObserverNote = useCallback((e: ObserverEmission): WorldPoint => {
    const r = e.result
    const bullets = r.bullets.map((text): BulletItem => ({ kind: 'bullet', id: uid('b'), origin: 'ai', text, status: 'pending' }))
    const cards = r.sources.map((s): CardItem => ({ kind: 'card', id: uid('c'), origin: 'ai', status: 'pending', title: s.title, url: s.url, snippet: s.snippet, image: s.image }))
    const rect = canvasRef.current?.getBoundingClientRect()
    const anchor = rect ? toWorld(rect.left + rect.width / 2, rect.top + rect.height / 2) : { x: 0, y: 0 }
    const existing: PlacedRect[] = notesRef.current.map((n) => ({ x: n.x, y: n.y, w: DEFAULT_NOTE_W, h: DEFAULT_NOTE_H }))
    const pos = placeObserverNote(existing, anchor)
    const note: KeywordNote = {
      id: uid('n'),
      x: pos.x,
      y: pos.y,
      keyword: r.keyword,
      keywordEditing: false,
      items: [...bullets, ...cards],
      aiRunning: false,
      kept: [],
      rejected: [],
      lastFiredWords: 0,
      observerMeta: { opportunityType: e.decision.opportunityType!, reason: e.decision.reason, confidence: e.decision.confidence }
    }
    setNotes((ns) => [...ns, note])
    return {
      x: pos.x + DEFAULT_NOTE_W + AI_CURSOR_NOTE_GAP_PX / viewRef.current.scale,
      y: pos.y + DEFAULT_NOTE_H
    }
  }, [toWorld])

  // Reveal a held emission IF its activity is the cursor's current one — its
  // turn in the queue. Idempotent (the held entry is consumed). Called from
  // emit (already-current case) and the currentId effect (promotion after a
  // fire's reveal finishes).
  const revealHeldObserver = useCallback((activityId: string) => {
    const emission = heldObserverEmitsRef.current.get(activityId)
    if (!emission || activityId !== cursorCurrentIdRef.current) return
    heldObserverEmitsRef.current.delete(activityId)
    const pos = createObserverNote(emission)
    cursorDispatch({ type: 'move', activityId, target: pos, at: Date.now() })
    cursorDispatch({ type: 'end', activityId, at: Date.now() })
  }, [createObserverNote])

  // Approved contribution → hold it for the reveal queue (or create directly
  // if no cursor activity exists to wait on — belt and braces).
  const handleObserverEmit = useCallback((e: ObserverEmission) => {
    if (observerRef.current) saveJSON(k('observer-state'), observerRef.current.getState())
    const activityId = obsActivityIdRef.current
    if (!activityId) {
      createObserverNote(e)
      return
    }
    heldObserverEmitsRef.current.set(activityId, e)
    revealHeldObserver(activityId)
  }, [createObserverNote, revealHeldObserver])

  // Latest emit/context closures held in refs so the once-constructed engine
  // always calls the current versions (its deps read live — never stale).
  const observerEmitRef = useRef(handleObserverEmit)
  observerEmitRef.current = handleObserverEmit
  const revealHeldObserverRef = useRef(revealHeldObserver)
  revealHeldObserverRef.current = revealHeldObserver
  promoteNonCocreateRef.current = revealHeldObserver
  const observerContextRef = useRef(getObserverContext)
  observerContextRef.current = getObserverContext

  // Construct the engine once per space; persist state + tear down on unmount.
  useEffect(() => {
    const engine = new ObserverEngine(
      {
        evaluate: (input) => requestObserverEvaluate(input, { listener: listenerAssignRef.current, relayAvailable: true }),
        contribute: (input) => requestObserverContribute(input, { thinker: thinkerAssignRef.current, relayAvailable: true }),
        getContext: () => observerContextRef.current(),
        isCocreateStreaming: () => firesRef.current.size > 0
      },
      { cooldownMs: DEFAULT_COOLDOWN_MS, maxRecentTopics: DEFAULT_MAX_RECENT_TOPICS },
      loadJSON<ObserverState | null>(k('observer-state'), null) || undefined
    )
    engine.onEmit = (e) => observerEmitRef.current(e)
    engine.onLog = (rec) => {
      observerLogRef.current.append(rec)
      // DEV-only live console trace: prints every observer decision as it happens
      // so real-time testing shows whether/why it emitted. Toggle by unsetting
      // window.__observerTrace (defaults on in DEV).
      if (import.meta.env.DEV) {
        const w = window as unknown as { __observerTrace?: boolean }
        if (w.__observerTrace !== false) logObserverRecord(rec)
      }
    }
    // AI cursor: appear when contribute starts, reveal/linger when it settles.
    engine.onContributeStart = () => {
      const activityId = `obs_${++obsCounterRef.current}`
      obsActivityIdRef.current = activityId
      const rect = canvasRef.current?.getBoundingClientRect()
      const target = rect ? toWorld(rect.left + rect.width / 2, rect.top + rect.height / 2) : { x: 0, y: 0 }
      cursorDispatch({ type: 'start', activityId, target, at: Date.now() })
    }
    engine.onContributeSettled = (emitted: boolean) => {
      const activityId = obsActivityIdRef.current
      obsActivityIdRef.current = null
      if (!activityId) return
      if (emitted) {
        // onEmit may have revealed synchronously when this activity was current;
        // if it was queued, this is a harmless no-op until currentId promotes it.
        revealHeldObserverRef.current(activityId)
        return
      }
      heldObserverEmitsRef.current.delete(activityId)
      cursorDispatch({ type: 'end', activityId, linger: false, at: Date.now() })
    }
    observerRef.current = engine
    // DEV-only manual trigger for smoke-testing without waiting for live speech.
    // In the browser console: __observer.fire([...signals]) — see the reply.
    if (import.meta.env.DEV && isActive) {
      ;(window as unknown as { __observer?: unknown }).__observer = {
        engine,
        fire(signals?: ObserverSignal[]) {
          engine.setEnabled(true)
          engine.start()
          engine.pushSignals(
            signals ?? [
              { text: 'We decided to sync notes across devices with a local-first database.', type: 'decision', ts: Date.now() },
              { text: 'But what happens when two people edit the same note offline?', type: 'objection', ts: Date.now() + 1 }
            ]
          )
          return 'fired — watch the canvas (~a few sec for the LLM). Check __observer.log() for the decision.'
        },
        log: () => observerLogRef.current.all()
      }
    }
    return () => {
      engine.reset()
      engine.stop()
      saveJSON(k('observer-state'), engine.getState())
      observerRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Lifecycle: enabled follows the AI switch; running follows active+recording,
  // gated by a Listener pre-flight. No usable Listener → visible notice + a
  // listener-unavailable log record, and the engine never starts (contract §3).
  useEffect(() => {
    const engine = observerRef.current
    if (!engine) return
    engine.setEnabled(aiEnabled)
    if (!(isActive && recording && aiEnabled)) {
      engine.reset()
      engine.stop()
      return
    }
    let cancelled = false
    void resolveCategoryProvider('listener', listenerAssignRef.current).then((res) => {
      if (cancelled) return
      if (res.error) {
        setObserverNotice(res.error)
        observerLogRef.current.append({ ts: Date.now(), kind: 'skip', gate: 'listener-unavailable', error: res.error })
        return
      }
      setObserverNotice(null)
      engine.start()
    })
    return () => {
      cancelled = true
      engine.stop()
    }
  }, [isActive, recording, aiEnabled, modelConfigs, modelSelections.listener])

  // Which id(s) move when a pointer-drag starts on obj `id`: the whole selection
  // if `id` is part of a multi-select, else just `id` (which becomes the lone
  // selection). Shared by notes and standalone images.
  const dragTargets = (id: string): string[] => {
    if (selectedIdsRef.current.has(id) && selectedIdsRef.current.size > 1) return [...selectedIdsRef.current]
    setSelectedIds(new Set([id]))
    return [id]
  }

  // Drag a set of canvas objects (notes and/or images) together, world-space.
  // A pointerup with no real movement is a click, not a drag → onClick (used by
  // standalone images to expand into the previewer, same as an inline image).
  const beginDrag = (dragIds: string[], startX: number, startY: number, onClick?: () => void) => {
    const origins = dragIds.flatMap((i) => {
      const n = notesRef.current.find((x) => x.id === i)
      if (n) return [{ i, ox: n.x, oy: n.y }]
      const im = imagesRef.current.find((x) => x.id === i)
      return im ? [{ i, ox: im.x, oy: im.y }] : []
    })
    let moved = false
    const move = (ev: PointerEvent) => {
      if (Math.abs(ev.clientX - startX) > 4 || Math.abs(ev.clientY - startY) > 4) moved = true
      const s = viewRef.current.scale
      const dx = (ev.clientX - startX) / s, dy = (ev.clientY - startY) / s
      const shift = <T extends { id: string; x: number; y: number }>(o: T): T => {
        const org = origins.find((g) => g.i === o.id)
        return org ? { ...o, x: org.ox + dx, y: org.oy + dy } : o
      }
      setNotes((ns) => ns.map(shift))
      setImages((is) => is.map(shift))
    }
    const up = () => {
      document.removeEventListener('pointermove', move)
      document.removeEventListener('pointerup', up)
      if (!moved) onClick?.()
    }
    document.addEventListener('pointermove', move)
    document.addEventListener('pointerup', up)
  }

  // Shift/⌘-click toggles an object in/out of the selection (no drag).
  const toggleSelected = (id: string) =>
    setSelectedIds((prev) => {
      const s = new Set(prev)
      s.has(id) ? s.delete(id) : s.add(id)
      return s
    })

  // ---- select + drag keyword note(s); supports multi-select group move ----
  const onNotePointerDown = (id: string) => (e: React.PointerEvent) => {
    e.stopPropagation() // don't let the canvas start a marquee
    const el = e.target as HTMLElement
    const interactive = !!el.closest('input, textarea, button, .accept, .url-card, .bullet-text, .kw-text, .kw-input, .bullet-img, .note-image')

    if (e.shiftKey || e.metaKey) { toggleSelected(id); return }
    const dragIds = dragTargets(id)
    if (interactive) return // editing a field → no drag
    beginDrag(dragIds, e.clientX, e.clientY)
  }

  // ---- select + drag a standalone canvas image; a plain click (no drag)
  // expands it into the previewer, same as clicking an inline image ----
  const onImagePointerDown = (id: string) => (e: React.PointerEvent) => {
    e.stopPropagation()
    if (e.shiftKey || e.metaKey) { toggleSelected(id); return }
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
    const im = imagesRef.current.find((x) => x.id === id)
    beginDrag(dragTargets(id), e.clientX, e.clientY, im ? () => setImgPreview({ src: im.src, originRect: rect }) : undefined)
  }

  // Which transcript phrases to faintly mark: one per note born from a drag
  // (keeps its immutable sourceText + the source line's ts). Deriving from notes
  // means a deleted note's mark disappears on its own.
  const highlights = notes
    .filter((n) => n.sourceText && n.originTs !== undefined)
    .map((n) => ({ noteId: n.id, ts: n.originTs as number, text: n.sourceText as string }))

  return (
    <>
      <Transcript
        recording={recording}
        onToggleRecord={onToggleRecord}
        onRawFinal={onRawFinal}
        onSignals={onSignals}
        organizeProvider={summaryModel.providerId}
        summaryModel={summaryModel}
        storageSuffix={storageSuffix}
        highlights={highlights}
        onHoverNote={setHoveredNoteId}
        makeStt={makeStt}
        projectInstructions={projectMemory.instructions.transcriptionSummary}
        transcriptSync={sync ? transcriptSync : undefined}
        onSignIn={onSignIn}
        sttBlocked={sttBlocked}
        seedFromLocal={seedFromLocal}
      />
      <div
        className="canvas"
          ref={canvasRef}
          onPointerDown={onCanvasPointerDown}
          onDrop={onDrop}
          onPaste={onPaste}
          onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy' }}
          style={{
            backgroundPosition: `${view.x}px ${view.y}px`,
            backgroundSize: `${22 * view.scale}px ${22 * view.scale}px`
          }}
        >
          <div className="ai-switch" onPointerDown={(e) => e.stopPropagation()}>
            <span className="ai-switch-label">{tr('AI co-creation mode', 'AI 共创模式')}</span>
            <button
              className={`switch ${aiEnabled ? 'on' : ''}`}
              role="switch"
              aria-checked={aiEnabled}
              aria-label={tr('AI co-creation mode', 'AI 共创模式')}
              title={modelConfigs.length === 0 ? tr('Configure a model in Settings first', '请先在设置中配置模型') : undefined}
              disabled={modelConfigs.length === 0}
              onClick={toggleAi}
            />
            <button
              className="memory-btn"
              title={
                projectMemory.project
                  ? tr(`Memory — ${projectMemory.project.name} & this canvas`, `记忆 — ${projectMemory.project.name} 与此画布`)
                  : tr(`Memory — ${projectMemory.canvas?.name || 'this canvas'}`, `记忆 — ${projectMemory.canvas?.name || '此画布'}`)
              }
              aria-label={tr('Project memory', '项目记忆')}
              onClick={onOpenMemory}
            >
              <span className="memory-btn-icon">{MemoryIcon}</span>
              <span className="memory-btn-label">{tr('Memory', '记忆')}</span>
            </button>
          </div>

          {observerNotice && (
            <div className="observer-notice" role="status" onPointerDown={(e) => e.stopPropagation()}>
              <span>{tr(`Observer off — ${observerNotice}`, `观察器已关闭 — ${observerNotice}`)}</span>
              <button className="observer-notice-x" aria-label={tr('Dismiss', '关闭')} onClick={() => setObserverNotice(null)}>×</button>
            </div>
          )}

          {notes.length === 0 && images.length === 0 && (
            <div className="canvas-hint">{tr('Click anywhere to sketch your ideas out', '点击任意一处开始记录')}</div>
          )}

          {marquee && (
            <div className="marquee" style={{ left: marquee.l, top: marquee.t, width: marquee.w, height: marquee.h }} />
          )}

          <div
            className="canvas-layer"
            ref={layerRef}
            style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})` }}
          >
          {notes.map((n) => (
            <KeywordNoteView
              key={n.id}
              note={n}
              selected={selectedIds.has(n.id)}
              hovered={hoveredNoteId === n.id}
              onPointerDownNote={onNotePointerDown(n.id)}
              onContextMenuNote={onNoteContextMenu(n.id)}
              onKeywordEdit={onKeywordEdit(n.id)}
              onKeywordChange={onKeywordChange(n.id)}
              onKeywordCommit={onKeywordCommit(n.id)}
              onBulletChange={onBulletChange(n.id)}
              onIndentBullet={onIndentBullet(n.id)}
              onBulletEnter={onBulletEnter(n.id)}
              onBulletBlur={onBulletBlur(n.id)}
              onMergeBullet={onMergeBullet(n.id)}
              onDeleteNote={onDeleteNote(n.id)}
              onDeleteRange={onDeleteRange(n.id)}
              onKeepBullet={keepBullet(n.id)}
              onRejectBullet={rejectBullet(n.id)}
              onKeepNote={keepNote(n.id)}
              onRejectNote={rejectNote(n.id)}
              onKeepCard={keepCard(n.id)}
              onRemoveCard={removeCard(n.id)}
              onInsertAfter={onInsertAfter(n.id)}
              onRemoveImage={removeImageItem(n.id)}
              onOpenImage={setImgPreview}
              onTextSelection={onNoteTextSelection}
            />
          ))}
          {/* standalone floating images — no note wrapper, no header */}
          {images.map((im) => (
            <img
              key={im.id}
              data-imageid={im.id}
              className={`canvas-image ${selectedIds.has(im.id) ? 'selected' : ''}`}
              src={im.src}
              alt=""
              draggable={false}
              style={{ left: im.x, top: im.y }}
              onPointerDown={onImagePointerDown(im.id)}
              onError={(e) => { e.currentTarget.style.display = 'none' }}
            />
          ))}
          </div>
          {/* AI Pal cursor — screen-space, constant size at any zoom (§9f). */}
          <AiCursorOverlay state={cursor} view={view} />
      </div>

      {/* Right-click on a note: duplicate/rename/delete. Viewport-space (fixed),
          same as the click that opened it — not affected by canvas pan/zoom. */}
      {noteMenu && (
        <div
          className="note-menu"
          style={{ left: noteMenu.x, top: noteMenu.y }}
          onPointerDown={(e) => e.stopPropagation()}
          onContextMenu={(e) => e.preventDefault()}
          >
          <button onClick={() => onDuplicateNote(noteMenu.id)}>{tr('Duplicate', '复制')}</button>
          <button className="danger" onClick={() => onDeleteNoteFromMenu(noteMenu.id)}>{tr('Delete', '删除')}</button>
        </div>
      )}

      {/* Tier-3: inline AI bubble at the frozen selection (viewport-space) */}
      {bubbleSel && (
        <InlineCommandBubble
          snapshot={bubbleSel}
          onSubmit={(cmd) => openCommandSession(bubbleSel, cmd)}
          onDismiss={() => setBubbleSel(null)}
        />
      )}

      {/* Tier-3: temporary chat panel — sibling of .canvas inside .panel-body,
          so it overlays only THIS space and never eats the canvas's wheel. */}
      {session && (
        <CommandSidePanel
          session={session}
          streaming={chatStreaming}
          onSend={sendTurn}
          onApplyAction={onApplyAction}
          onClose={closeCommandSession}
        />
      )}

      {/* Expanded image previewer: blurred scrim, image large, source url below. */}
      {imgPreview && (
        <div className={`img-preview ${previewOpen ? 'open' : ''}`} onClick={closeImgPreview}>
          <img ref={previewImgRef} className="img-preview-pic" src={imgPreview.src} alt="" onClick={(e) => e.stopPropagation()} />
          {imgPreview.sourceUrl && (
            <a
              className="img-preview-source"
              href={imgPreview.sourceUrl}
              target="_blank"
              rel="noreferrer"
              onClick={(e) => e.stopPropagation()}
            >
              <img
                className="favicon"
                src={`https://www.google.com/s2/favicons?domain=${hostOf(imgPreview.sourceUrl)}&sz=32`}
                alt=""
                onError={(e) => { e.currentTarget.style.display = 'none' }}
              />
              <span>{imgPreview.title || hostOf(imgPreview.sourceUrl)}</span>
            </a>
          )}
        </div>
      )}

      {/* Project Memory: two-level knowledge base + instructions (M5). The
          canvas button always opens on the canvas tab; the project tab is
          there whenever this canvas lives inside a project. */}
      {memoryOpen && (
        <ProjectMemoryModal
          project={toMemorySection(projectMemory.project)}
          canvas={toMemorySection(projectMemory.canvas)}
          initialScope="canvas"
          busy={projectMemory.busy}
          error={projectMemory.error}
          onClose={onCloseMemory}
        />
      )}
    </>
  )
}

// ---- workspace shell: collapsible nav sidebar + Obsidian-style sliding panels ----

// The pre-existing canvas lives on as the 'default' space (un-suffixed storage
// keys), so nothing saved before this layout change is lost.
const DEFAULT_TREE: TreeNode[] = [{ id: 'default', kind: 'space', name: 'A New Canvas' }]

const findNode = (nodes: TreeNode[], id: string): TreeNode | undefined => {
  for (const n of nodes) {
    if (n.id === id) return n
    const hit = n.children && findNode(n.children, id)
    if (hit) return hit
  }
  return undefined
}
const firstSpace = (nodes: TreeNode[]): TreeNode | undefined => {
  for (const n of nodes) {
    if (n.kind === 'space') return n
    const hit = n.children && firstSpace(n.children)
    if (hit) return hit
  }
  return undefined
}
const mapNodes = (nodes: TreeNode[], fn: (n: TreeNode) => TreeNode): TreeNode[] =>
  nodes.map((n) => fn(n.children ? { ...n, children: mapNodes(n.children, fn) } : { ...n }))

// Pulls a node out of the tree wherever it lives, returning the pruned tree
// alongside the detached node (so a caller can re-insert it elsewhere).
const removeNode = (nodes: TreeNode[], id: string): { nodes: TreeNode[]; found?: TreeNode } => {
  let found: TreeNode | undefined
  const rest = nodes
    .filter((n) => {
      if (n.id === id) {
        found = n
        return false
      }
      return true
    })
    .map((n) => {
      if (found || !n.children) return n
      const r = removeNode(n.children, id)
      if (r.found) found = r.found
      return { ...n, children: r.nodes }
    })
  return { nodes: rest, found }
}

// Find the project (parent) that directly contains the given child id.
const findParent = (nodes: TreeNode[], childId: string): TreeNode | undefined => {
  for (const n of nodes) {
    if (n.children?.some((c) => c.id === childId)) return n
    const hit = n.children && findParent(n.children, childId)
    if (hit) return hit
  }
  return undefined
}

// Insert a node right after the one with `afterId` in the same array.
const insertAfter = (arr: TreeNode[], afterId: string, newNode: TreeNode): TreeNode[] => {
  const idx = arr.findIndex((n) => n.id === afterId)
  if (idx < 0) return [...arr, newNode]
  const out = [...arr]
  out.splice(idx + 1, 0, newNode)
  return out
}

// Handle = the spine strip on a panel's top-left (drag it to slide/resize).
// Its width is what an open-but-buried canvas always keeps visible.
const HANDLE = 44
const MAX_OPEN = 2

// Overlapping paper-stack model (Obsidian-like): every open canvas pins its
// RIGHT edge to the workspace's right edge and keeps its own independent
// width — later-opened panels lie on top, like sheets of paper. Dragging a
// handle resizes ONLY that sheet; the others don't move. Clamps keep every
// sheet's handle visible: a sheet stays at least one HANDLE narrower than the
// sheet beneath it and one HANDLE wider than the sheet on top of it. So the
// widest a sheet can get is workspace − (sheets beneath it × HANDLE).
type OpenPanels = { ids: string[]; fracs: number[] } // fracs: width ÷ workspace width

export function App() {
  const { tr } = useLocale()
  const [collapsed, setCollapsed] = useState(() => loadJSON('sidebar-collapsed', false))
  const [tree, setTree] = useState<TreeNode[]>(() => loadJSON('workspace-tree', DEFAULT_TREE))
  // Open canvases (≤3), bottom→top of the paper stack (= open order).
  // Sanitized against the saved tree so a stale id never renders a dead panel.
  const [open, setOpen] = useState<OpenPanels>(() => {
    const t = loadJSON<TreeNode[]>('workspace-tree', DEFAULT_TREE)
    const saved = loadJSON<OpenPanels>('open-panels', { ids: ['default'], fracs: [1] })
    const pairs = saved.ids
      .map((id, i) => ({ id, f: saved.fracs[i] ?? 1 }))
      .filter((p) => findNode(t, p.id)?.kind === 'space')
      .slice(0, MAX_OPEN)
    if (!pairs.length) {
      const s = firstSpace(t)
      return s ? { ids: [s.id], fracs: [1] } : { ids: [], fracs: [] }
    }
    return { ids: pairs.map((p) => p.id), fracs: pairs.map((p) => Math.min(1, Math.max(0, p.f))) }
  })
  const [activeId, setActiveId] = useState<string>(() => loadJSON('active-space', 'default'))
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [renamingId, setRenamingId] = useState<string | null>(null)
  // Right-click context menu on a sidebar tree node (Duplicate / Rename / Delete).
  const [spaceMenu, setSpaceMenu] = useState<{ id: string; kind: 'project' | 'space'; name: string; x: number; y: number } | null>(null)
  // Delete confirmation modal state.
  const [deleteConfirm, setDeleteConfirm] = useState<{ id: string; name: string } | null>(null)
  // Only ONE canvas records at a time — the id of the recording space, or null.
  const [recordingId, setRecordingId] = useState<string | null>(null)
  const [modelConfigs, setModelConfigs] = useState<AiModelConfig[]>(() =>
    normalizeModelConfigs(loadJSON<AiModelConfig[]>('llm-model-configs', DEFAULT_MODEL_CONFIGS))
  )
  const [modelSelections, setModelSelections] = useState<ModelSelections>(() =>
    normalizeModelSelections(loadJSON<Partial<ModelSelections>>('llm-model-selections', DEFAULT_MODEL_SELECTIONS), modelConfigs)
  )
  const [showLlmSettings, setShowLlmSettings] = useState(false)
  const [showAuth, setShowAuth] = useState(false)
  const [showDocs, setShowDocs] = useState(false)
  const backend = useBackend()

  // Project Memory seams, shared by every open canvas (M5): the helper's
  // IndexedDB store (H1) + browser extractor (H2) always; the backend client
  // (H4) only while signed in — it then takes priority inside the hook.
  const memoryLocalStore = useMemo(() => createLocalStore(), [])
  const memoryClient = useMemo(
    () =>
      backend.enabled && backend.user
        ? createMemoryClient({ baseUrl: apiBaseUrl(), getToken: () => sharedTokenStore().access })
        : null,
    [backend.enabled, backend.user]
  )
  const memoryDeps = useMemo<ProjectMemoryDeps>(
    () => ({ localStore: memoryLocalStore, client: memoryClient, extractText: extractTextBrowser }),
    [memoryLocalStore, memoryClient]
  )
  // Which Memory modal is open (null = closed). Two entry points: a canvas's
  // Memory button (canvas + optional project tabs, rendered inside that
  // canvas), and a project row's hover toolbox in the sidebar (project tab
  // only, rendered at App level — no canvas context needed).
  const [memoryTarget, setMemoryTarget] = useState<
    { kind: 'canvas'; spaceId: string } | { kind: 'project'; projectId: string } | null
  >(null)

  const workspaceRef = useRef<HTMLDivElement>(null)
  const [ww, setWw] = useState(1200)

  // When signed in, back open spaces with a server document so BoardSync has a
  // room to join — but ONLY auto-create for a brand-new account (zero documents).
  // On a device that already has documents (e.g. a second device, fresh docMap),
  // auto-creating would spawn duplicate empty docs; instead the user opens an
  // existing one via the Documents panel ("Open here"). ensureDoc is idempotent.
  const { user: backendUser, docsLoaded, ensureDoc } = backend
  const hasDocs = backend.documents.length > 0
  useEffect(() => {
    if (!backendUser || !docsLoaded || hasDocs) return
    for (const id of open.ids) {
      void ensureDoc(id, findNode(tree, id)?.name ?? 'Untitled')
    }
    // Depend on stable/primitive values, NOT the whole `backend` object (a fresh
    // reference every render would re-run this constantly).
  }, [backendUser, docsLoaded, hasDocs, ensureDoc, open.ids, tree])

  // A backend-proxied STT factory (docs module 07). Force-rotate the access
  // token before every WebSocket handshake because /stt cannot retry a 401
  // during the upgrade. Unexpected disconnects use the same path to reconnect
  // without stopping the microphone stream.
  const makeBackendStt = useCallback(async (): Promise<STTProvider> => {
    const freshUrl = async () => {
      const ok = await backend.refreshAuth()
      if (!ok) throw new Error('Sign in to use backend speech transcription.')
      const url = backend.sttUrl()
      if (!url) throw new Error('Backend speech session is unavailable. Please sign in again.')
      return url
    }
    return new BackendSTT({ url: await freshUrl(), reconnectUrl: freshUrl })
  }, [backend.refreshAuth, backend.sttUrl])
  const makeStt: (() => STTProvider | Promise<STTProvider>) | undefined = backend.enabled
    ? makeBackendStt
    : undefined

  useEffect(() => saveJSON('sidebar-collapsed', collapsed), [collapsed])
  useEffect(() => saveJSON('workspace-tree', tree), [tree])
  useEffect(() => saveJSON('open-panels', open), [open])
  useEffect(() => saveJSON('active-space', activeId), [activeId])
  useEffect(() => saveJSON('llm-model-configs', modelConfigs), [modelConfigs])
  useEffect(() => saveJSON('llm-model-selections', modelSelections), [modelSelections])
  useEffect(() => {
    for (const cfg of modelConfigs) {
      if (cfg.runtime !== 'api' && cfg.runtime !== 'ollama') continue
      const providerId = cfg.providerId || (cfg.runtime === 'ollama' ? 'ollama' : 'groq')
      const providerConfig: { apiKey?: string; model?: string; baseUrl?: string } = {}
      if (cfg.apiKey) providerConfig.apiKey = cfg.apiKey
      if (cfg.model) providerConfig.model = cfg.model
      if (cfg.baseUrl) providerConfig.baseUrl = cfg.baseUrl
      if (Object.keys(providerConfig).length) setProviderConfig(providerId, providerConfig)
    }
  }, [modelConfigs])

  // Escape closes the space context menu and delete confirmation modal.
  useEffect(() => {
    if (!spaceMenu && !deleteConfirm) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setSpaceMenu(null)
        setDeleteConfirm(null)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [spaceMenu, deleteConfirm])

  // The active canvas must be one of the open ones.
  useEffect(() => {
    if (open.ids.length && !open.ids.includes(activeId)) setActiveId(open.ids[open.ids.length - 1])
  }, [open, activeId])

  // Track the workspace's real width — panel fractions are resolved against it.
  useEffect(() => {
    const el = workspaceRef.current
    if (!el) return
    const ro = new ResizeObserver(() => setWw(el.clientWidth))
    ro.observe(el)
    setWw(el.clientWidth)
    return () => ro.disconnect()
  }, [])

  // Resolve fractions to px and enforce the stack invariant: each sheet at
  // least one HANDLE narrower than the one beneath, never below one HANDLE.
  const widths = open.fracs.map((f) => f * ww)
  for (let i = 0; i < widths.length; i++) {
    const max = i === 0 ? ww : widths[i - 1] - HANDLE
    widths[i] = Math.max(HANDLE, Math.min(widths[i], max))
  }

  // Open an idea space as a canvas panel: already open → just activate; room
  // left → a new sheet slides in on top (right edge pinned, one HANDLE
  // narrower than the sheet below); already at MAX_OPEN → the new canvas
  // replaces the ACTIVE one in its slot, keeping that slot's width.
  const openSpace = (id: string) => {
    if (!open.ids.includes(id)) {
      if (open.ids.length < MAX_OPEN) {
        const below = widths.length ? widths[widths.length - 1] : ww
        const w = widths.length
          ? Math.max(HANDLE, Math.min(below - HANDLE, Math.round(ww * 0.62)))
          : ww
        setOpen({ ids: [...open.ids, id], fracs: [...open.fracs, w / ww] })
      } else {
        const idx = Math.max(0, open.ids.indexOf(activeId))
        const replaced = open.ids[idx]
        const ids = [...open.ids]
        ids[idx] = id
        setOpen({ ...open, ids })
        if (recordingId === replaced) setRecordingId(null)
      }
    }
    setActiveId(id)
  }

  // Close a canvas (its ×): the sheet leaves the stack; the space itself stays
  // in the tree and can be reopened. Focus falls to the topmost remaining sheet.
  const closeSpace = (id: string) => {
    const idx = open.ids.indexOf(id)
    if (idx < 0) return
    const ids = open.ids.filter((x) => x !== id)
    const fracs = open.fracs.filter((_, j) => j !== idx)
    setOpen({ ids, fracs })
    if (recordingId === id) setRecordingId(null)
    if (activeId === id && ids.length) setActiveId(ids[ids.length - 1])
  }

  // New Project: expand the sidebar if collapsed, create a folder, and drop
  // straight into renaming it.
  const addProject = () => {
    const id = uid('p')
    setTree((t) => [...t, { id, kind: 'project', name: tr('New Project', '新建项目'), children: [] }])
    setCollapsed(false)
    setSelectedId(id)
    setRenamingId(id)
  }

  // New Idea Space: a fresh canvas (= idea space) that slides in from the
  // right. Nested into the selected project (if any), else at the root.
  const addIdeaSpace = () => {
    const id = uid('s')
    const node: TreeNode = { id, kind: 'space', name: tr('A New Canvas', '新建画布') }
    setTree((t) => {
      const sel = selectedId ? findNode(t, selectedId) : undefined
      if (sel && sel.kind === 'project') {
        return mapNodes(t, (n) => (n.id === sel.id ? { ...n, children: [...(n.children || []), node] } : n))
      }
      return [...t, node]
    })
    openSpace(id)
  }

  const onSelect = (node: TreeNode) => {
    setSelectedId(node.id)
    if (node.kind === 'space') openSpace(node.id)
  }

  // Drag a canvas onto a project row to file it into that project, or onto
  // the sidebar's root drop zone to pull it back out to the top level.
  const onMoveNode = (id: string, targetProjectId: string | null) => {
    if (id === targetProjectId) return
    setTree((t) => {
      const { nodes, found } = removeNode(t, id)
      if (!found) return t
      if (!targetProjectId) return [...nodes, found]
      const target = findNode(nodes, targetProjectId)
      if (!target || target.kind !== 'project') return t
      return mapNodes(nodes, (n) => (n.id === targetProjectId ? { ...n, children: [...(n.children || []), found] } : n))
    })
  }

  const onRename = (id: string, name: string) => {
    const clean = name.trim()
    if (clean) setTree((t) => mapNodes(t, (n) => (n.id === id ? { ...n, name: clean } : n)))
    setRenamingId(null)
  }

  // Right-click on a sidebar node → open the context menu at the cursor.
  const onSpaceContextMenu = (node: TreeNode, x: number, y: number) => {
    setSpaceMenu({ id: node.id, kind: node.kind, name: node.name, x, y })
  }

  // Duplicate a canvas: copy its board (IndexedDB) + localStorage mirror into
  // a brand-new space, add it to the tree right after the source, and open it.
  const onDuplicateSpace = useCallback(async (id: string) => {
    setSpaceMenu(null)
    const srcSuffix = id === 'default' ? '' : `.${id}`
    const srcBoardKey = boardDocId(srcSuffix)
    const newId = uid('s')
    const newSuffix = `.${newId}`
    const newBoardKey = boardDocId(newSuffix)

    // 1. Copy board content (IndexedDB).
    void copyBoard(srcBoardKey, newBoardKey)

    // 2. Copy localStorage mirror keys (notes, images, view, transcript, etc.).
    try {
      const PREFIX = 'thinking-pal-canvas.'
      for (const k of Object.keys(localStorage)) {
        if (!k.startsWith(PREFIX)) continue
        const bareKey = k.slice(PREFIX.length)
        if (srcSuffix === '') {
          // Default space: keys have no suffix — copy only un-suffixed keys.
          if (bareKey.includes('.')) continue
          localStorage.setItem(PREFIX + bareKey + newSuffix, localStorage.getItem(k)!)
        } else {
          // Named space: keys end with the source suffix.
          if (!bareKey.endsWith(srcSuffix)) continue
          const baseKey = bareKey.slice(0, -srcSuffix.length)
          localStorage.setItem(PREFIX + baseKey + newSuffix, localStorage.getItem(k)!)
        }
      }
    } catch {
      // storage disabled — board copy alone is enough
    }

    // 3. Add the new node to the tree next to the source (same parent or root).
    setTree((t) => {
      const src = findNode(t, id)
      const newNode: TreeNode = { id: newId, kind: 'space', name: `${src?.name ?? 'Canvas'} (copy)` }
      // If source is inside a project, insert the copy right after it in the same project.
      if (src) {
        const parent = findParent(t, id)
        if (parent) {
          return mapNodes(t, (n) =>
            n.id === parent.id
              ? { ...n, children: insertAfter(n.children || [], id, newNode) }
              : n
          )
        }
      }
      // Source is at root level — insert after it.
      return insertAfter(t, id, newNode)
    })

    // 4. Open the duplicated canvas.
    openSpace(newId)
  }, [open, openSpace, activeId, recordingId])

  // Rename: trigger the inline rename input in the sidebar.
  const onRenameSpace = (id: string) => {
    setSpaceMenu(null)
    setRenamingId(id)
  }

  // Delete: open the confirmation modal.
  const onDeleteSpace = (id: string, name: string) => {
    setSpaceMenu(null)
    setDeleteConfirm({ id, name })
  }

  // Confirmed delete: remove from tree, close panel if open, wipe IndexedDB +
  // localStorage for that space.
  const confirmDeleteSpace = useCallback(async () => {
    const target = deleteConfirm
    if (!target) return
    const id = target.id
    setDeleteConfirm(null)

    // Close the panel if it's open.
    if (open.ids.includes(id)) closeSpace(id)

    // Project Memory orphan cleanup (best-effort, §4). Two-level model: every
    // canvas owns a space bucket, so deleting a canvas always purges it;
    // deleting a project purges the shared project bucket AND each child
    // canvas's own bucket (the children leave the tree with it).
    const node = findNode(tree, id)
    const memoryScopes: ProjectMemoryScope[] = []
    if (node?.kind === 'project') {
      memoryScopes.push({ kind: 'project', projectId: id })
      for (const c of node.children ?? []) {
        if (c.kind === 'space') memoryScopes.push({ kind: 'space', spaceId: c.id })
      }
    } else if (node) {
      memoryScopes.push({ kind: 'space', spaceId: id })
    }
    if (memoryScopes.length) {
      setMemoryTarget((t) =>
        t && ((t.kind === 'canvas' && t.spaceId === id) || (t.kind === 'project' && t.projectId === id)) ? null : t
      )
      for (const s of memoryScopes) {
        void memoryLocalStore.deleteScope(s).catch(() => {})
        if (memoryClient) void memoryClient.deleteScope(s).catch(() => {})
      }
    }

    // Remove from tree.
    setTree((t) => removeNode(t, id).nodes)

    // Clean up IndexedDB board (skip the 'default' space — its key is 'default').
    const suffix = id === 'default' ? '' : `.${id}`
    const bKey = boardDocId(suffix)
    void deleteBoard(bKey)

    // Clean up localStorage keys for this space.
    try {
      const PREFIX = 'thinking-pal-canvas.'
      for (const k of Object.keys(localStorage)) {
        if (!k.startsWith(PREFIX)) continue
        const bareKey = k.slice(PREFIX.length)
        if (suffix === '') {
          if (!bareKey.includes('.')) localStorage.removeItem(k)
        } else {
          if (bareKey.endsWith(suffix)) localStorage.removeItem(k)
        }
      }
    } catch {
      // storage disabled — nothing to clean
    }
  }, [deleteConfirm, open.ids, closeSpace, tree, memoryLocalStore, memoryClient])

  // Drag a sheet's handle: only THIS sheet's left edge moves (right edge is
  // pinned), clamped so the sheet below keeps its handle visible and this
  // sheet stays visible in front of the sheet above.
  const startPanelDrag = (idx: number) => (e: React.PointerEvent) => {
    setActiveId(open.ids[idx])
    e.preventDefault()
    const startX = e.clientX
    const startW = widths[idx]
    const min = idx === widths.length - 1 ? HANDLE : widths[idx + 1] + HANDLE
    const max = idx === 0 ? ww : widths[idx - 1] - HANDLE
    const move = (ev: PointerEvent) => {
      const w = Math.max(min, Math.min(max, startW - (ev.clientX - startX)))
      setOpen((o) => ({ ...o, fracs: o.fracs.map((f, j) => (j === idx ? w / ww : f)) }))
    }
    const up = () => {
      document.removeEventListener('pointermove', move)
      document.removeEventListener('pointerup', up)
    }
    document.addEventListener('pointermove', move)
    document.addEventListener('pointerup', up)
  }

  const profileLabel = backend.user ? backend.user.email.split('@')[0] || backend.user.email : tr('Sign in', '登录')
  const profileTitle = backend.user
    ? `Signed in as ${backend.user.email} - sync + backend STT active`
    : tr('Sign in to sync boards across devices', '登录以在设备间同步画布')

  return (
    <div className="app-shell">
      <Sidebar
        collapsed={collapsed}
        onToggle={() => setCollapsed((c) => !c)}
        tree={tree}
        activeId={activeId}
        selectedId={selectedId}
        renamingId={renamingId}
        onSelect={onSelect}
        onNewProject={addProject}
        onNewIdeaSpace={addIdeaSpace}
        onStartRename={setRenamingId}
        onRename={onRename}
        onMoveNode={onMoveNode}
        onContextMenu={onSpaceContextMenu}
        onOpenProjectMemory={(projectId) => setMemoryTarget({ kind: 'project', projectId })}
        onOpenCanvasMemory={(spaceId) => setMemoryTarget({ kind: 'canvas', spaceId })}
        footer={
          <div className="side-controls">
            <button className="side-control-row" title={tr('Settings', '设置')} aria-label={tr('Settings', '设置')} onClick={() => setShowLlmSettings(true)}>
              <span className="side-control-icon">{GearIcon}</span>
              {!collapsed && <span className="side-control-label">{tr('Setting', '设置')}</span>}
            </button>
            {backend.enabled && (
              <button
                className="side-control-row"
                title={profileTitle}
                onClick={() => setShowAuth(true)}
              >
                <span className="profile-avatar">{ProfileIcon}</span>
                {!collapsed && <span className="side-control-label">{profileLabel}</span>}
              </button>
            )}
            {backend.user && (
              <button
                className="side-control-row"
                title={tr('Open a synced document on this canvas', '打开此画布的同步文档')}
                onClick={() => setShowDocs(true)}
              >
                <span className="side-control-icon">{BookIcon}</span>
                {!collapsed && <span className="side-control-label">{tr('Documents', '文档')}</span>}
              </button>
            )}
          </div>
        }
      />

      <div className="workspace" ref={workspaceRef}>
        {open.ids.map((id, i) => (
          <section
            key={id}
            className={`panel${i === 0 ? ' base' : ''}${activeId === id ? ' active' : ''}`}
            style={{ width: widths[i], zIndex: i + 1 }}
            onPointerDownCapture={() => setActiveId(id)}
          >
            <div className="panel-spine spine-drag" onPointerDown={startPanelDrag(i)} title={tr('Drag to slide / resize', '拖动以滑动或调整大小')}>
              {open.ids.length > 1 && (
                <button
                  className="panel-close"
                  title={tr('Close this canvas', '关闭此画布')}
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={() => closeSpace(id)}
                >
                  ×
                </button>
              )}
              <span className="spine-canvas-icon">{CanvasIcon}</span>
              <span className="spine-title">{findNode(tree, id)?.name ?? tr('A New Canvas', '新建画布')}</span>
            </div>
            <div className="panel-body">
              <CanvasSpace
                spaceId={id}
                tree={tree}
                memoryDeps={memoryDeps}
                memoryOpen={memoryTarget?.kind === 'canvas' && memoryTarget.spaceId === id}
                onOpenMemory={() => setMemoryTarget({ kind: 'canvas', spaceId: id })}
                onCloseMemory={() => setMemoryTarget(null)}
                storageSuffix={id === 'default' ? '' : `.${id}`}
                isActive={activeId === id}
                recording={recordingId === id}
                onToggleRecord={() => setRecordingId((r) => (r === id ? null : id))}
                modelSelections={modelSelections}
                modelConfigs={modelConfigs}
                sync={backend.syncFor(id)}
                makeStt={makeStt}
                seedFromLocal={!backend.isAdopted(id)}
                onSignIn={() => setShowAuth(true)}
                sttBlocked={backend.enabled && !backend.user}
              />
            </div>
          </section>
        ))}
      </div>

      {showLlmSettings && (
        <LlmSettingsPanel
          configs={modelConfigs}
          selections={modelSelections}
          onSave={(nextSelections, nextConfigs) => {
            const normalizedConfigs = normalizeModelConfigs(nextConfigs)
            setModelConfigs(normalizedConfigs)
            setModelSelections(normalizeModelSelections(nextSelections, normalizedConfigs))
          }}
          onClose={() => setShowLlmSettings(false)}
        />
      )}
      {memoryTarget?.kind === 'project' && (
        <ProjectMemoryHost
          projectId={memoryTarget.projectId}
          tree={tree}
          deps={memoryDeps}
          onClose={() => setMemoryTarget(null)}
        />
      )}
      {showAuth && backend.enabled && <AuthPanel backend={backend} onClose={() => setShowAuth(false)} />}
      {showDocs && backend.user && (
        <DocumentsPanel
          backend={backend}
          activeSpaceId={activeId}
          activeSpaceName={findNode(tree, activeId)?.name ?? tr('canvas', '画布')}
          onClose={() => setShowDocs(false)}
        />
      )}

      {/* Right-click context menu on a sidebar tree node */}
      {spaceMenu && (
        <>
          <div className="ctx-menu-backdrop" onClick={() => setSpaceMenu(null)} onContextMenu={(e) => { e.preventDefault(); setSpaceMenu(null) }} />
          <div
            className="note-menu"
            style={{ left: spaceMenu.x, top: spaceMenu.y }}
            onPointerDown={(e) => e.stopPropagation()}
            onContextMenu={(e) => e.preventDefault()}
          >
            <button onClick={() => onDuplicateSpace(spaceMenu.id)}>{tr('Duplicate', '复制')}</button>
            <button onClick={() => onRenameSpace(spaceMenu.id)}>{tr('Rename', '重命名')}</button>
            <button className="danger" onClick={() => onDeleteSpace(spaceMenu.id, spaceMenu.name)}>{tr('Delete', '删除')}</button>
          </div>
        </>
      )}

      {/* Delete confirmation modal */}
      {deleteConfirm && (
        <div className="confirm-overlay" onClick={() => setDeleteConfirm(null)}>
          <div className="confirm-modal" onClick={(e) => e.stopPropagation()}>
            <p className="confirm-text">
              {tr(`Delete "${deleteConfirm.name}"? This canvas and all its content will be permanently removed.`, `删除“${deleteConfirm.name}”？此画布和所有内容将被永久移除。`)}
            </p>
            <div className="confirm-actions">
              <button className="confirm-cancel" onClick={() => setDeleteConfirm(null)}>{tr('Cancel', '取消')}</button>
              <button className="confirm-delete" onClick={confirmDeleteSpace}>{tr('Delete', '删除')}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
