// Tier-3 command sessions: types + helpers for the select-text → bubble →
// side-panel chat flow. Sessions are saved per idea space for local backup;
// everything the AI creates on the canvas goes through applyAction and lands
// as PENDING content, reusing the exact item shapes Tier-2 produces.
import { uid, isBullet, isCard, type KeywordNote, type NoteItem, type BulletItem } from './canvas-types'
import type { CommandChatAction, CommandChatRequest, CommandChatSource } from '../../../services/llm/command-chat-types'

export type { CommandChatAction, CommandChatSource }

// ---- selection snapshot ------------------------------------------------------
// The live browser selection is only used to OPEN the bubble. The moment it
// opens, the selection is frozen into this snapshot — the native selection
// collapsing (when the bubble input takes focus) is expected and ignored.

/** One highlighted stretch inside one bullet, in character offsets. */
export type SelectionSegment = {
  itemId: string
  start: number
  end: number
  /** Bullet text at capture time — if it changes, the highlight drops (v1 rule). */
  textAtCapture: string
}

export type SelectionSnapshot = {
  noteId: string
  selectedText: string
  segments: SelectionSegment[]
  /** Viewport-space rect of the selection at capture time (bubble placement). */
  screenRect: { top: number; left: number; width: number; height: number }
}

export type ImageSelectionSnapshot = {
  kind: 'image'
  imageId: string
  src: string
  url?: string
  noteId?: string
  x?: number
  y?: number
  screenRect: { top: number; left: number; width: number; height: number }
}

export type CommandContextSource = SelectionSnapshot | ImageSelectionSnapshot
export const isImageSelection = (source: CommandContextSource | null | undefined): source is ImageSelectionSnapshot =>
  !!source && 'kind' in source && source.kind === 'image'

// ---- session -----------------------------------------------------------------

export type ProposedAction = {
  id: string
  action: CommandChatAction
  applied?: boolean // button becomes a checkmark once applied
}

export type CommandMessage = {
  id: string
  role: 'user' | 'assistant'
  text: string
  pending?: boolean // assistant message still streaming
  actions?: ProposedAction[]
  sources?: CommandChatSource[]
}

export type SessionCanvasRef = {
  alias: string
  /** Real ids stay client-side and never enter the model prompt. */
  noteId: string
  items: { alias: string; itemId: string }[]
}

export type CommandSession = {
  id: string
  source: CommandContextSource | null
  origin: 'selection' | 'image' | 'canvas'
  title: string
  messages: CommandMessage[]
  createdAt: number
  canvasRefs: SessionCanvasRef[]
  createdNoteCount: number
}

// ---- per-turn context capture --------------------------------------------------
// Mirrors runAi's capture conventions, recomputed FRESH each turn so the model
// sees bullets added mid-conversation. Pending AI suggestions are excluded —
// they may still be rejected, so they aren't part of the note yet.
export function buildTurnContext(
  note: KeywordNote | undefined,
  snapshot: CommandContextSource | null,
  transcriptWindow: string | undefined,
  session: CommandSession,
  notes: KeywordNote[]
): CommandChatRequest['context'] {
  const ctx: CommandChatRequest['context'] = {}
  if (snapshot && !isImageSelection(snapshot) && snapshot.selectedText) ctx.selectedText = snapshot.selectedText
  if (isImageSelection(snapshot)) {
    ctx.hasSelectedImage = true
    if (snapshot.url) ctx.selectedImageUrl = snapshot.url
  }
  if (note) {
    ctx.sourceNoteId = note.id
    ctx.sourceNote = {
      keyword: note.keyword,
      humanBullets: note.items
        .filter((i): i is BulletItem => isBullet(i) && i.origin === 'human' && !!i.text.trim())
        .map((b) => '  '.repeat(b.indent ?? 0) + b.text),
      keptAi: note.items
        .filter((i) => i.origin === 'ai' && i.status === 'kept')
        .map((i) => (isBullet(i) ? i.text : isCard(i) ? i.title : ''))
        .filter(Boolean),
      kept: note.kept,
      rejected: note.rejected
    }
  }
  if (transcriptWindow) ctx.transcriptWindow = transcriptWindow
  const sessionCanvas = session.canvasRefs
    .map((ref) => {
      const liveNote = notes.find((n) => n.id === ref.noteId)
      if (!liveNote) return null
      const lines = ref.items
        .map(({ alias, itemId }) => {
          const item = liveNote.items.find((i) => i.id === itemId)
          if (!item || item.status !== 'pending') return null
          const text = isBullet(item) ? item.text : isCard(item) ? item.title : '(image)'
          return `  [${alias}] ${text}`
        })
        .filter((line): line is string => !!line)
      return `[${ref.alias}] Note "${liveNote.keyword}"${lines.length ? `\n${lines.join('\n')}` : ' (no editable lines left)'}`
    })
    .filter((block): block is string => !!block)
    .join('\n')
  if (sessionCanvas) ctx.sessionCanvas = sessionCanvas
  return ctx
}

// ---- applying actions ----------------------------------------------------------
// Pure: notes in → notes out. Every produced item is origin 'ai' + status
// 'pending' — the user's ✓ is what settles it, even though they asked for it.

const pendingBullet = (text: string, image?: BulletItem['image']): BulletItem => ({
  kind: 'bullet',
  id: uid('b'),
  origin: 'ai',
  text,
  status: 'pending',
  ...(image ? { image } : {})
})

const appendToNote = (
  notes: KeywordNote[],
  noteId: string,
  items: NoteItem[]
): { notes: KeywordNote[]; created?: { noteId: string; itemIds: string[] } } => {
  if (!notes.some((n) => n.id === noteId)) return { notes }
  return {
    notes: notes.map((n) => (n.id === noteId ? { ...n, items: [...n.items, ...items] } : n)),
    created: { noteId, itemIds: items.map((item) => item.id) }
  }
}

export type ApplyActionResult = {
  notes: KeywordNote[]
  created?: { noteId: string; itemIds: string[] }
}

export function applyAction(
  notes: KeywordNote[],
  action: CommandChatAction,
  /** World-space spot for a created note (near the source note / view center). */
  createAt: { x: number; y: number }
): ApplyActionResult {
  switch (action.type) {
    case 'insert-bullet': {
      if (!action.noteId) return { notes }
      return appendToNote(notes, action.noteId, [pendingBullet(action.text)])
    }
    case 'append-image':
      // Always a pending BULLET carrying the image — standalone image items
      // have no keep/reject UI, so the image rides its caption's ✓/✕.
      return appendToNote(notes, action.noteId, [
        pendingBullet(action.caption, { src: action.src, sourceUrl: action.sourceUrl, title: action.title })
      ])
    case 'add-card': {
      if (!action.noteId) return { notes }
      return appendToNote(notes, action.noteId, [
        {
          kind: 'card',
          id: uid('c'),
          origin: 'ai',
          status: 'pending',
          title: action.title,
          url: action.url,
          snippet: action.snippet,
          image: action.image
        }
      ])
    }
    case 'create-note': {
      const keyword = action.keyword.trim()
      const words = keyword ? keyword.split(/\s+/).length : 0
      const noteId = uid('n')
      const items = action.bullets.filter((t) => t.trim()).map((t) => pendingBullet(t.trim()))
      return {
        notes: [...notes, {
          id: noteId,
          x: createAt.x,
          y: createAt.y,
          keyword,
          keywordEditing: false,
          aiRunning: false,
          kept: [],
          rejected: [],
          // Pre-set so the ambient every-20 trigger doesn't double-fire on it.
          lastFiredWords: words,
          items
        }],
        created: { noteId, itemIds: items.map((item) => item.id) }
      }
    }
    case 'edit-bullet':
    case 'remove-item':
    case 'edit-note':
      return { notes }
  }
}

export type ApplySessionActionResult = {
  notes: KeywordNote[]
  session: CommandSession
  applied: boolean
}

const withRegisteredItems = (
  session: CommandSession,
  refAlias: string,
  itemIds: string[]
): CommandSession => ({
  ...session,
  canvasRefs: session.canvasRefs.map((ref) => {
    if (ref.alias !== refAlias) return ref
    const start = ref.items.length
    return {
      ...ref,
      items: [
        ...ref.items,
        ...itemIds.map((itemId, i) => ({ alias: `${ref.alias}.${start + i + 1}`, itemId }))
      ]
    }
  })
})

/** Apply one validated action through the session-only alias ledger. */
export function applySessionAction(
  notes: KeywordNote[],
  session: CommandSession,
  action: CommandChatAction,
  createAt: { x: number; y: number }
): ApplySessionActionResult {
  if (action.type === 'create-note') {
    const result = applyAction(notes, action, createAt)
    if (!result.created) return { notes, session, applied: false }
    const alias = `n${session.canvasRefs.length + 1}`
    const ref: SessionCanvasRef = {
      alias,
      noteId: result.created.noteId,
      items: result.created.itemIds.map((itemId, i) => ({ alias: `${alias}.${i + 1}`, itemId }))
    }
    return {
      notes: result.notes,
      session: {
        ...session,
        canvasRefs: [...session.canvasRefs, ref],
        createdNoteCount: session.createdNoteCount + 1
      },
      applied: true
    }
  }

  if (action.type === 'insert-bullet' || action.type === 'add-card') {
    const targetRef = action.ref ? session.canvasRefs.find((ref) => ref.alias === action.ref) : undefined
    const noteId = targetRef?.noteId ?? action.noteId
    if (!noteId || (action.ref && !targetRef)) return { notes, session, applied: false }
    const result = applyAction(notes, { ...action, noteId, ref: undefined }, createAt)
    if (!result.created) return { notes, session, applied: false }
    return {
      notes: result.notes,
      session: targetRef
        ? withRegisteredItems(session, targetRef.alias, result.created.itemIds)
        : session,
      applied: true
    }
  }

  if (action.type === 'append-image') {
    const result = applyAction(notes, action, createAt)
    return { notes: result.notes, session, applied: !!result.created }
  }

  if (action.type === 'edit-note') {
    const ref = session.canvasRefs.find((entry) => entry.alias === action.ref)
    const liveNote = ref ? notes.find((n) => n.id === ref.noteId) : undefined
    if (!ref || !liveNote) return { notes, session, applied: false }
    // A removed/rejected line no longer exists and must not block a rename;
    // only a line the user KEPT locks the note's identity.
    const anyKept = ref.items.some(({ itemId }) => {
      const item = liveNote.items.find((i) => i.id === itemId)
      return !!item && item.status !== 'pending'
    })
    if (anyKept) return { notes, session, applied: false }
    return {
      notes: notes.map((n) => (n.id === liveNote.id ? { ...n, keyword: action.keyword.trim() } : n)),
      session,
      applied: true
    }
  }

  const itemRef = session.canvasRefs
    .flatMap((entry) => entry.items.map((item) => ({ entry, item })))
    .find(({ item }) => item.alias === action.ref)
  if (!itemRef) return { notes, session, applied: false }
  const liveNote = notes.find((n) => n.id === itemRef.entry.noteId)
  const liveItem = liveNote?.items.find((item) => item.id === itemRef.item.itemId)
  if (!liveNote || !liveItem || liveItem.status !== 'pending') return { notes, session, applied: false }

  if (action.type === 'edit-bullet') {
    if (!isBullet(liveItem)) return { notes, session, applied: false }
    return {
      notes: notes.map((n) => n.id === liveNote.id
        ? { ...n, items: n.items.map((item) => item.id === liveItem.id ? { ...item, text: action.text } : item) }
        : n),
      session,
      applied: true
    }
  }

  return {
    notes: notes.map((n) => n.id === liveNote.id
      ? { ...n, items: n.items.filter((item) => item.id !== liveItem.id) }
      : n),
    session,
    applied: true
  }
}

export const spreadCreateAt = (anchor: { x: number; y: number }, index: number) => ({
  x: anchor.x + (index % 3) * 340,
  y: anchor.y + Math.floor(index / 3) * 320
})

// Rough world-space footprint of a note: width from CSS, height estimated from
// line count (wrapped bullets undercount a little, which the 320px row pitch
// absorbs). Good enough to tell an occupied grid slot from a free one.
const NOTE_W = 320
const noteWorldBox = (n: KeywordNote) => ({ x: n.x, y: n.y, w: NOTE_W, h: 72 + 28 * n.items.length })
const boxesOverlap = (
  a: { x: number; y: number; w: number; h: number },
  b: { x: number; y: number; w: number; h: number }
) => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y

/**
 * First grid slot (spreadCreateAt order) whose footprint hits no existing
 * note — so auto-created notes never stack on earlier sessions' output or the
 * user's own notes near the view center.
 */
export function freeCreateSpot(
  anchor: { x: number; y: number },
  notes: KeywordNote[],
  bulletCount = 3
): { x: number; y: number } {
  const occupied = notes.map(noteWorldBox)
  const h = 72 + 28 * Math.max(1, bulletCount)
  for (let k = 0; k < 60; k++) {
    const spot = spreadCreateAt(anchor, k)
    if (!occupied.some((b) => boxesOverlap({ x: spot.x, y: spot.y, w: NOTE_W, h }, b))) return spot
  }
  return spreadCreateAt(anchor, 60) // pathological density — just go far down
}

// A LOOSE action (insert-bullet / add-card with neither noteId nor ref) has
// nowhere to land by itself — models sometimes emit these for "create/add …"
// asks on the open canvas. Instead of losing the content, give it a home: the
// model's most recent session note, else (bullets only) a fresh note titled
// from the bullet's first words. Selection sessions never produce loose
// actions (the service injects the source note id).
export function salvageLooseAction(
  action: CommandChatAction,
  session: CommandSession
): CommandChatAction | null {
  if (action.type !== 'insert-bullet' && action.type !== 'add-card') return action
  if (action.noteId || action.ref) return action
  const last = session.canvasRefs[session.canvasRefs.length - 1]
  if (last) return { ...action, ref: last.alias }
  if (action.type === 'insert-bullet') {
    const keyword = action.text.split(/\s+/).slice(0, 4).join(' ')
    return { type: 'create-note', keyword, bullets: [action.text], ...(action.apply ? { apply: true as const } : {}) }
  }
  return null // a loose card with no note to hold it — nothing sane to do
}

export const actionAutoApplies = (action: CommandChatAction): boolean =>
  action.type === 'edit-bullet' || action.type === 'remove-item' || action.type === 'edit-note' ||
  ('apply' in action && action.apply === true)

/** Which note an action lands in (create-note has none). */
export const actionNoteId = (a: CommandChatAction): string | undefined =>
  'noteId' in a ? a.noteId : undefined

/** Short human label for an action button. */
export function actionLabel(a: CommandChatAction): string {
  switch (a.type) {
    case 'insert-bullet':
      return `Add bullet: ${a.text.length > 40 ? a.text.slice(0, 40) + '…' : a.text}`
    case 'append-image':
      return `Add image: ${a.title || a.caption}`
    case 'add-card':
      return `Add link card: ${a.title}`
    case 'create-note':
      return `New note: ${a.keyword}`
    case 'edit-bullet':
      return `Edited: ${a.text.length > 40 ? a.text.slice(0, 40) + '…' : a.text}`
    case 'remove-item':
      return 'Removed a line'
    case 'edit-note':
      return `Renamed note: ${a.keyword}`
  }
}

// ---- persistent context highlight ---------------------------------------------
// Painted with the CSS Custom Highlight API — no DOM changes inside the
// contentEditable bullets, and the marks live on the real text so they pan /
// zoom / move with the note for free. Ranges are rebuilt from the snapshot
// after each render (React re-renders replace DOM nodes, so stored Range
// objects go stale). Styled via ::highlight(cmd-ctx) in styles.css.

const HIGHLIGHT_NAME = 'cmd-ctx'
const HIGHLIGHT_LAYER_CLASS = 'cmd-context-highlight-layer'

const clearHighlightLayer = () => {
  document.querySelectorAll(`.${HIGHLIGHT_LAYER_CLASS}`).forEach((el) => el.remove())
}

/** Build a Range over chars [start, end) of a bullet-text host element. */
const rangeOver = (host: HTMLElement, start: number, end: number): Range | null => {
  const r = document.createRange()
  const walker = document.createTreeWalker(host, NodeFilter.SHOW_TEXT)
  let pos = 0
  let placedStart = false
  while (walker.nextNode()) {
    const t = walker.currentNode as Text
    const next = pos + t.length
    if (!placedStart && start <= next) {
      r.setStart(t, Math.max(0, start - pos))
      placedStart = true
    }
    if (placedStart && end <= next) {
      r.setEnd(t, Math.max(0, end - pos))
      return r
    }
    pos = next
  }
  if (!placedStart) return null
  r.setEnd(host, host.childNodes.length)
  return r
}

export function paintContextHighlight(snapshot: SelectionSnapshot, note: KeywordNote | undefined) {
  const hl = (CSS as any).highlights as Map<string, unknown> | undefined
  const noteEl = document.querySelector(`[data-noteid="${snapshot.noteId}"]`)
  if (!noteEl || !note) {
    hl?.delete(HIGHLIGHT_NAME)
    clearHighlightLayer()
    return
  }
  const ranges: Range[] = []
  for (const seg of snapshot.segments) {
    const idx = note.items.findIndex((it) => it.id === seg.itemId)
    if (idx < 0) continue
    const item = note.items[idx]
    // v1 rule: the bullet's text changed since capture → offsets are stale →
    // drop the highlight on this bullet (the panel's context chip still shows
    // what was selected).
    if (!isBullet(item) || item.text !== seg.textAtCapture) continue
    const host = noteEl.querySelector<HTMLElement>(`[data-idx="${idx}"] .bullet-text`)
    if (!host) continue
    const r = rangeOver(host, seg.start, seg.end)
    if (r && !r.collapsed) ranges.push(r)
  }
  if (hl && typeof (window as any).Highlight === 'function') {
    if (ranges.length) hl.set(HIGHLIGHT_NAME, new (window as any).Highlight(...ranges))
    else hl.delete(HIGHLIGHT_NAME)
  }

  // The overlay keeps the context visibly highlighted in embedded browsers
  // that register custom highlights but stop painting them when the input
  // takes focus. The prompt closes before canvas movement, so fixed viewport
  // rectangles remain aligned for their complete lifetime.
  clearHighlightLayer()
  for (const range of ranges) {
    Array.from(range.getClientRects()).forEach((rect) => {
      if (!rect.width || !rect.height) return
      const mark = document.createElement('span')
      mark.className = HIGHLIGHT_LAYER_CLASS
      mark.style.left = `${rect.left}px`
      mark.style.top = `${rect.top}px`
      mark.style.width = `${rect.width}px`
      mark.style.height = `${rect.height}px`
      document.body.appendChild(mark)
    })
  }
}

export function clearContextHighlight() {
  ;((CSS as any).highlights as Map<string, unknown> | undefined)?.delete(HIGHLIGHT_NAME)
  clearHighlightLayer()
}
