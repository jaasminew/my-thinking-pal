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

export type CommandSession = {
  id: string
  source: SelectionSnapshot | null // null = opened from the bottom command bar
  title: string
  messages: CommandMessage[]
  createdAt: number
}

// ---- per-turn context capture --------------------------------------------------
// Mirrors runAi's capture conventions, recomputed FRESH each turn so the model
// sees bullets added mid-conversation. Pending AI suggestions are excluded —
// they may still be rejected, so they aren't part of the note yet.
export function buildTurnContext(
  note: KeywordNote | undefined,
  snapshot: SelectionSnapshot | null,
  transcriptWindow: string | undefined
): CommandChatRequest['context'] {
  const ctx: CommandChatRequest['context'] = {}
  if (snapshot?.selectedText) ctx.selectedText = snapshot.selectedText
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

const appendToNote = (notes: KeywordNote[], noteId: string, items: NoteItem[]): KeywordNote[] =>
  notes.map((n) => (n.id === noteId ? { ...n, items: [...n.items, ...items] } : n))

export function applyAction(
  notes: KeywordNote[],
  action: CommandChatAction,
  /** World-space spot for a created note (near the source note / view center). */
  createAt: { x: number; y: number }
): KeywordNote[] {
  switch (action.type) {
    case 'insert-bullet':
      return appendToNote(notes, action.noteId, [pendingBullet(action.text)])
    case 'append-image':
      // Always a pending BULLET carrying the image — standalone image items
      // have no keep/reject UI, so the image rides its caption's ✓/✕.
      return appendToNote(notes, action.noteId, [
        pendingBullet(action.caption, { src: action.src, sourceUrl: action.sourceUrl, title: action.title })
      ])
    case 'add-card':
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
    case 'create-note': {
      const keyword = action.keyword.trim()
      const words = keyword ? keyword.split(/\s+/).length : 0
      return [
        ...notes,
        {
          id: uid('n'),
          x: createAt.x,
          y: createAt.y,
          keyword,
          keywordEditing: false,
          aiRunning: false,
          kept: [],
          rejected: [],
          // Pre-set so the ambient every-20 trigger doesn't double-fire on it.
          lastFiredWords: words,
          items: action.bullets.filter((t) => t.trim()).map((t) => pendingBullet(t.trim()))
        }
      ]
    }
  }
}

/** Which note an action lands in (create-note has none). */
export const actionNoteId = (a: CommandChatAction): string | undefined =>
  a.type === 'create-note' ? undefined : a.noteId

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
  }
}

// ---- persistent context highlight ---------------------------------------------
// Painted with the CSS Custom Highlight API — no DOM changes inside the
// contentEditable bullets, and the marks live on the real text so they pan /
// zoom / move with the note for free. Ranges are rebuilt from the snapshot
// after each render (React re-renders replace DOM nodes, so stored Range
// objects go stale). Styled via ::highlight(cmd-ctx) in styles.css.

const HIGHLIGHT_NAME = 'cmd-ctx'

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
  if (!hl || typeof (window as any).Highlight !== 'function') return // unsupported browser: degrade silently
  const noteEl = document.querySelector(`[data-noteid="${snapshot.noteId}"]`)
  if (!noteEl || !note) {
    hl.delete(HIGHLIGHT_NAME)
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
  if (ranges.length) hl.set(HIGHLIGHT_NAME, new (window as any).Highlight(...ranges))
  else hl.delete(HIGHLIGHT_NAME)
}

export function clearContextHighlight() {
  ;((CSS as any).highlights as Map<string, unknown> | undefined)?.delete(HIGHLIGHT_NAME)
}
