import { useEffect, useRef, useState } from 'react'
import { isBullet, isImage, type BulletItem, type CardItem, type ImageItem, type KeywordNote } from './canvas-types'
import type { SelectionSnapshot, SelectionSegment } from './command-session'
import { isImeEvent } from './ime'
import { useLocale } from './locale'

const hostOf = (u: string) => {
  try { return new URL(u).hostname.replace(/^www\./, '') } catch { return u }
}

// ---- caret helpers for arrow-key navigation across items ----
const placeCaret = (el: HTMLElement, at: 'start' | 'end') => {
  el.focus()
  const r = document.createRange()
  r.selectNodeContents(el)
  r.collapse(at === 'start')
  const s = window.getSelection()
  s?.removeAllRanges()
  s?.addRange(r)
}

// Drop the caret at a character offset inside el (walking its text nodes), so a
// bullet merged into its neighbour lands the caret exactly at the join point.
const placeCaretAtOffset = (el: HTMLElement, offset: number) => {
  el.focus()
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
  let remaining = offset
  let last: Text | null = null
  let target: Text | null = null
  while (walker.nextNode()) {
    last = walker.currentNode as Text
    if (remaining <= last.length) { target = last; break }
    remaining -= last.length
  }
  const r = document.createRange()
  if (target) r.setStart(target, remaining)
  else if (last) r.setStart(last, last.length)
  else { r.selectNodeContents(el); r.collapse(false) }
  r.collapse(true)
  const s = window.getSelection()
  s?.removeAllRanges()
  s?.addRange(r)
}

// The caret position under a screen point (Chrome exposes caretRangeFromPoint,
// Firefox caretPositionFromPoint) — used to drive a drag-selection that spans
// bullets, which the browser won't do on its own across separate editables.
type CaretPos = { node: Node; offset: number }
const caretFromPoint = (x: number, y: number): CaretPos | null => {
  const doc = document as Document & {
    caretRangeFromPoint?: (x: number, y: number) => Range | null
    caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null
  }
  if (doc.caretRangeFromPoint) {
    const r = doc.caretRangeFromPoint(x, y)
    return r ? { node: r.startContainer, offset: r.startOffset } : null
  }
  const p = doc.caretPositionFromPoint?.(x, y)
  return p ? { node: p.offsetNode, offset: p.offset } : null
}

// Character offset of (node, offset) within host's text — sum the text before it.
const textOffsetIn = (host: HTMLElement, node: Node, offset: number): number => {
  if (node === host) return offset <= 0 ? 0 : host.textContent?.length ?? 0
  let total = 0
  const walker = document.createTreeWalker(host, NodeFilter.SHOW_TEXT)
  while (walker.nextNode()) {
    const t = walker.currentNode as Text
    if (t === node) return total + offset
    total += t.length
  }
  return total
}

// Is the collapsed caret at the very first/last character of this element?
// Measured by whether any text sits between the element edge and the caret —
// robust to how the browser represents the boundary (Chrome reports a line-start
// caret as (textNode, 0), which a compareBoundaryPoints check would miss).
const caretAtEdge = (el: HTMLElement, edge: 'start' | 'end') => {
  const sel = window.getSelection()
  if (!sel || sel.rangeCount === 0 || !sel.isCollapsed) return false
  const caret = sel.getRangeAt(0)
  const probe = document.createRange()
  if (edge === 'start') {
    probe.setStart(el, 0)
    probe.setEnd(caret.startContainer, caret.startOffset)
  } else {
    probe.selectNodeContents(el)
    probe.setStart(caret.endContainer, caret.endOffset)
  }
  return probe.toString().length === 0
}

// Is the caret on the first/last VISUAL line of a wrapped bullet? (rect-based;
// an empty or single-line bullet counts as both.)
const caretOnEdgeLine = (el: HTMLElement, edge: 'start' | 'end') => {
  const sel = window.getSelection()
  if (!sel || sel.rangeCount === 0 || !sel.isCollapsed) return false
  const r = sel.getRangeAt(0).cloneRange()
  r.collapse(edge === 'start')
  const rect = r.getClientRects()[0] || r.getBoundingClientRect()
  if (!rect || (rect.width === 0 && rect.height === 0)) return true
  const er = el.getBoundingClientRect()
  const lh = parseFloat(getComputedStyle(el).lineHeight) || 22
  return edge === 'start' ? rect.top - er.top < lh * 0.6 : er.bottom - rect.bottom < lh * 0.6
}

// One bullet line, always contentEditable (not an <input>): long text wraps at
// the note's fixed width, the rendered paragraph never swaps element on click,
// and a click puts the caret exactly where the user clicked.
function BulletText({
  text,
  editing,
  title,
  onInput,
  onEnter,
  onBlur,
  onClick,
  onNavigate,
  onEdgeDelete,
  onIndent
}: {
  text: string
  editing?: boolean
  title?: string
  onInput: (text: string) => void
  onEnter: () => void
  onBlur: () => void
  onClick?: () => void
  onNavigate: (dir: 'prev' | 'next') => boolean
  onEdgeDelete: (edge: 'start' | 'end') => boolean
  onIndent: (delta: number) => void
}) {
  const ref = useRef<HTMLSpanElement>(null)

  // Push external text (AI streaming / URL extraction) into the DOM — but never
  // while the user is typing in this line, so the caret doesn't jump. Runs on
  // every render (not [text]): a change skipped while focused still lands on
  // the next render after focus has moved on.
  useEffect(() => {
    const el = ref.current
    if (el && document.activeElement !== el && el.innerText !== text) el.innerText = text
  })

  // editing = "focus me" (fresh bullet from ⏎ or keyword commit). A plain click
  // already focuses natively with the caret at the click point — don't move it.
  useEffect(() => {
    const el = ref.current
    if (!editing || !el || document.activeElement === el) return
    placeCaret(el, 'end')
  }, [editing])

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (isImeEvent(e)) return // ⏎/arrows aimed at the IME candidate panel, not us
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      onEnter()
      return
    }
    if (e.key === 'Tab') {
      e.preventDefault()
      onIndent(e.shiftKey ? -1 : 1)
      return
    }
    const el = ref.current
    if (!el) return
    // ⌫ at the very start / ⌦ at the very end reach across into the neighbouring
    // bullet (each bullet is its own contentEditable, so the browser can't). A
    // non-collapsed selection fails caretAtEdge, so native delete still runs.
    if (e.key === 'Backspace' && caretAtEdge(el, 'start')) {
      if (onEdgeDelete('start')) e.preventDefault()
      return
    }
    if (e.key === 'Delete' && caretAtEdge(el, 'end')) {
      if (onEdgeDelete('end')) e.preventDefault()
      return
    }
    if (
      (e.key === 'ArrowRight' && caretAtEdge(el, 'end')) ||
      (e.key === 'ArrowDown' && caretOnEdgeLine(el, 'end'))
    ) {
      if (onNavigate('next')) e.preventDefault()
    } else if (
      (e.key === 'ArrowLeft' && caretAtEdge(el, 'start')) ||
      (e.key === 'ArrowUp' && caretOnEdgeLine(el, 'start'))
    ) {
      if (onNavigate('prev')) e.preventDefault()
    }
  }

  return (
    <span
      ref={ref}
      className="bullet-text"
      contentEditable
      suppressContentEditableWarning
      spellCheck={false}
      title={title}
      onInput={(e) => onInput((e.currentTarget as HTMLElement).innerText.replace(/\n$/, ''))}
      onKeyDown={onKeyDown}
      onBlur={onBlur}
      onClick={onClick}
    />
  )
}

// Keyword header editor: contentEditable (not an <input>) so a long keyword
// wraps onto new lines at the note width instead of collapsing into one row.
function KeywordEditor({
  value,
  onChange,
  onCommit
}: {
  value: string
  onChange: (text: string) => void
  onCommit: () => void
}) {
  const ref = useRef<HTMLSpanElement>(null)

  // Seed the DOM once on mount and focus with the caret at the end; after that
  // the DOM is the source of truth while the user types (no caret jumps).
  useEffect(() => {
    const el = ref.current
    if (!el) return
    if (el.innerText !== value) el.innerText = value
    placeCaret(el, 'end')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <span
      ref={ref}
      className="kw-input"
      contentEditable
      suppressContentEditableWarning
      spellCheck={false}
      onInput={(e) => onChange((e.currentTarget as HTMLElement).innerText.replace(/\n$/, ''))}
      onKeyDown={(e) => {
        if (isImeEvent(e)) return
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault()
          onCommit()
        }
      }}
      onBlur={onCommit}
    />
  )
}

// Renders one free-floating keyword note: keyword header → an ordered flow of
// bullets and inline URL cards. All data logic lives in App; focus/caret
// navigation between items is handled here in the DOM.
export function KeywordNoteView({
  note,
  selected,
  hovered,
  onPointerDownNote,
  onContextMenuNote,
  onKeywordEdit,
  onKeywordChange,
  onKeywordCommit,
  onBulletChange,
  onBulletEnter,
  onBulletBlur,
  onMergeBullet,
  onDeleteNote,
  onDeleteRange,
  onKeepBullet,
  onRejectBullet,
  onKeepNote,
  onRejectNote,
  onKeepCard,
  onRemoveCard,
  onRemoveImage,
  onInsertAfter,
  onIndentBullet,
  onOpenImage,
  onTextSelection
}: {
  note: KeywordNote
  selected: boolean
  /** The transcript phrase this note came from is hovered → fade header orange. */
  hovered: boolean
  onPointerDownNote: (e: React.PointerEvent) => void
  onContextMenuNote: (e: React.MouseEvent) => void
  onKeywordEdit: () => void
  onKeywordChange: (text: string) => void
  onKeywordCommit: () => void
  onBulletChange: (bulletId: string, text: string) => void
  onBulletEnter: (bulletId: string) => void
  onBulletBlur: (bulletId: string) => void
  onMergeBullet: (bulletId: string, dir: 'prev' | 'next') => void
  onDeleteNote: () => void
  onDeleteRange: (startId: string, startOffset: number, endId: string, endOffset: number) => void
  onIndentBullet: (bulletId: string, delta: number) => void
  onKeepBullet: (bulletId: string) => void
  onRejectBullet: (bulletId: string) => void
  /** Keep the whole observer note (all its pending items) as one unit. */
  onKeepNote: () => void
  /** Dismiss the whole observer note as one unit. */
  onRejectNote: () => void
  onKeepCard: (cardId: string) => void
  onRemoveCard: (cardId: string) => void
  onRemoveImage: (imageId: string) => void
  onInsertAfter: (itemId: string) => void
  onOpenImage: (img: { src: string; sourceUrl?: string; title?: string; originRect?: DOMRect }) => void
  /**
   * A text selection inside this note's bullets settled (drag or double-click).
   * The payload is already snapshot-shaped: per-bullet segments + a viewport-
   * space rect. Fires only for non-empty selections — dismissal is the
   * canvas's business (click-outside / Escape), not this view's.
   */
  onTextSelection?: (sel: SelectionSnapshot) => void
}) {
  const { tr } = useLocale()
  const itemsRef = useRef<HTMLDivElement>(null)
  const rootRef = useRef<HTMLDivElement>(null)

  // ⌘A/Ctrl+A anywhere inside the note selects the WHOLE note (keyword +
  // every bullet/card) as one text block, not just the focused bullet. The
  // .select-all class temporarily re-enables user-select on the note so the
  // cross-element selection paints and copies.
  const [selectAllOn, setSelectAllOn] = useState(false)
  // A cross-bullet drag selection is painted the same way as ⌘A, but is a
  // partial range (not the whole note) — kept separate so ⌫ knows to trim the
  // range rather than delete the note.
  const [dragSelOn, setDragSelOn] = useState(false)

  // A purely AI-generated observer note is judged as ONE unit: gray header, no
  // per-item ✓/✕, a single keep/dismiss control at the bottom-right. `hasPending`
  // drives whether that control still shows (it vanishes once the note is kept).
  const isObserver = !!note.observerMeta
  // Bullets and cards carry a status; images never do (they're always settled).
  const hasPending = note.items.some((x) => !isImage(x) && x.status === 'pending')

  // Map a DOM point in a selection to the bullet it lands in: which item (index
  // + id) and the character offset within that bullet's text. null for the
  // keyword header, a card/image, or anything outside this note's bullets.
  const bulletLocate = (node: Node | null, offset: number) => {
    if (!node) return null
    const el = node.nodeType === Node.TEXT_NODE ? node.parentElement : (node as HTMLElement)
    const host = el?.closest<HTMLElement>('.bullet-text')
    const bullet = el?.closest<HTMLElement>('.bullet')
    if (!host || !bullet || !itemsRef.current?.contains(bullet)) return null
    const idx = Number(bullet.getAttribute('data-idx'))
    const item = note.items[idx]
    if (!Number.isInteger(idx) || !item || !isBullet(item)) return null
    return { id: item.id, idx, off: textOffsetIn(host, node, offset) }
  }

  const onNoteKeyDown = (e: React.KeyboardEvent) => {
    // With the whole note selected (⌘A), ⌫/⌦ deletes the entire note as one
    // block. preventDefault flags the event so the canvas-level mass-delete
    // (which bails on contentEditable focus) leaves it alone.
    if (selectAllOn && (e.key === 'Backspace' || e.key === 'Delete')) {
      e.preventDefault()
      onDeleteNote()
      return
    }
    // A drag selection spanning two different bullets: delete the whole span
    // (trim the end bullets, drop the middle, merge into one). A selection
    // inside a single bullet falls through to native delete.
    if (e.key === 'Backspace' || e.key === 'Delete') {
      const s = window.getSelection()
      if (s && s.rangeCount && !s.isCollapsed) {
        const a = bulletLocate(s.anchorNode, s.anchorOffset)
        const f = bulletLocate(s.focusNode, s.focusOffset)
        if (a && f && a.idx !== f.idx) {
          e.preventDefault()
          const [start, end] = a.idx < f.idx ? [a, f] : [f, a]
          pendingCaret.current = { idx: start.idx, offset: start.off }
          onDeleteRange(start.id, start.off, end.id, end.off)
          setDragSelOn(false)
          return
        }
      }
    }
    if (e.key.toLowerCase() !== 'a' || !(e.metaKey || e.ctrlKey)) return
    e.preventDefault()
    setSelectAllOn(true)
    // setTimeout, not rAF: the selection must be set AFTER the .select-all
    // class lands in the DOM, and rAF doesn't fire in backgrounded tabs.
    setTimeout(() => {
      const root = rootRef.current
      if (!root) return
      const r = document.createRange()
      r.selectNodeContents(root)
      const s = window.getSelection()
      s?.removeAllRanges()
      s?.addRange(r)
    }, 0)
  }

  // Read the CURRENT browser selection and, if it lives inside this note's
  // bullets, report it upward in snapshot shape (per-bullet character segments
  // + viewport rect). The canvas freezes this into the Tier-3 command bubble's
  // SelectionSnapshot — after that, the native selection collapsing is
  // irrelevant. Keyword header / card / image selections are not reported.
  const reportSelection = () => {
    if (!onTextSelection) return
    const s = window.getSelection()
    if (!s || s.rangeCount === 0 || s.isCollapsed) return
    const a = bulletLocate(s.anchorNode, s.anchorOffset)
    const f = bulletLocate(s.focusNode, s.focusOffset)
    if (!a || !f) return
    const [start, end] = a.idx <= f.idx ? [a, f] : [f, a]
    const segments: SelectionSegment[] = []
    for (let i = start.idx; i <= end.idx; i++) {
      const item = note.items[i]
      if (!item || !isBullet(item)) continue // cards/images inside the span are skipped
      const sameBullet = start.idx === end.idx
      const from = i === start.idx ? (sameBullet ? Math.min(start.off, end.off) : start.off) : 0
      const to = i === end.idx ? (sameBullet ? Math.max(start.off, end.off) : end.off) : item.text.length
      if (to > from) segments.push({ itemId: item.id, start: from, end: to, textAtCapture: item.text })
    }
    const selectedText = s.toString().trim()
    if (!segments.length || !selectedText) return
    const rect = s.getRangeAt(0).getBoundingClientRect()
    // Empty range rect (rare) → fall back to the note's own rect.
    const rr = rect.width || rect.height ? rect : rootRef.current?.getBoundingClientRect()
    if (!rr) return
    onTextSelection({
      noteId: note.id,
      selectedText,
      segments,
      screenRect: { top: rr.top, left: rr.left, width: rr.width, height: rr.height }
    })
  }

  // Drag across bullets to select text: the browser confines a native drag to
  // the one contentEditable it began in, so we extend the selection ourselves
  // from the press point to wherever the pointer is. Plain clicks (no movement)
  // never enter here, so click-to-edit is untouched.
  const onItemsPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return
    const anchor = caretFromPoint(e.clientX, e.clientY)
    if (!anchor) return
    const downX = e.clientX, downY = e.clientY
    let moved = false
    const move = (ev: PointerEvent) => {
      if (!moved && Math.abs(ev.clientX - downX) < 4 && Math.abs(ev.clientY - downY) < 4) return
      const focus = caretFromPoint(ev.clientX, ev.clientY)
      const fEl = focus && (focus.node.nodeType === Node.TEXT_NODE ? focus.node.parentElement : (focus.node as HTMLElement))
      if (!focus || !fEl || !rootRef.current?.contains(fEl)) return // stay within this note
      moved = true
      setDragSelOn(true)
      try {
        window.getSelection()?.setBaseAndExtent(anchor.node, anchor.offset, focus.node, focus.offset)
      } catch { /* nodes went stale mid-drag — ignore this frame */ }
      ev.preventDefault()
    }
    const up = () => {
      document.removeEventListener('pointermove', move)
      document.removeEventListener('pointerup', up)
      // Let the selection settle before reading it (same tick it can lag the
      // final setBaseAndExtent). Only drags report — plain clicks never moved.
      if (moved) setTimeout(reportSelection, 0)
    }
    document.addEventListener('pointermove', move)
    document.addEventListener('pointerup', up)
  }

  // Clear the paint mode once the selection collapses or leaves this note.
  useEffect(() => {
    if (!selectAllOn && !dragSelOn) return
    const onSel = () => {
      const s = window.getSelection()
      const root = rootRef.current
      if (!s || s.isCollapsed || !root || !s.containsNode(root, true)) {
        setSelectAllOn(false)
        setDragSelOn(false)
      }
    }
    document.addEventListener('selectionchange', onSel)
    return () => document.removeEventListener('selectionchange', onSel)
  }, [selectAllOn, dragSelOn])

  // After a cross-bullet merge the target bullet is a different DOM node (state
  // re-rendered), so we stash where the caret should land and restore it once
  // the new items have painted.
  const pendingCaret = useRef<{ idx: number; offset: number } | null>(null)
  useEffect(() => {
    const p = pendingCaret.current
    if (!p) return
    pendingCaret.current = null
    const span = itemsRef.current?.querySelector<HTMLElement>(`[data-idx="${p.idx}"] .bullet-text`)
    const item = note.items[p.idx]
    if (!span || !item || !isBullet(item)) return
    // Force the merged text in: when the merge target keeps focus (⌦ pulling the
    // next bullet up), BulletText's text-push effect skips the focused node, so
    // we sync it here before positioning the caret at the seam.
    if (span.innerText !== item.text) span.innerText = item.text
    placeCaretAtOffset(span, p.offset)
  }, [note.items])

  // ⌫ at the start of a bullet merges it into the bullet above (caret lands at
  // the seam); ⌦ at the end pulls the bullet below up into it. Only bullet
  // neighbours merge — a card/image edge or the outline's end is a no-op.
  const onEdgeDelete = (i: number, edge: 'start' | 'end'): boolean => {
    const cur = note.items[i]
    if (!isBullet(cur)) return false
    if (edge === 'start') {
      const prev = note.items[i - 1]
      if (!prev || !isBullet(prev)) return false
      pendingCaret.current = { idx: i - 1, offset: prev.text.length }
      onMergeBullet(cur.id, 'prev')
    } else {
      const next = note.items[i + 1]
      if (!next || !isBullet(next)) return false
      pendingCaret.current = { idx: i, offset: cur.text.length }
      onMergeBullet(cur.id, 'next')
    }
    return true
  }

  // Focus item #i: a bullet gets the caret (at start when arriving from above,
  // at end from below); a card just gets focus. Returns false past either end.
  const focusIdx = (i: number, at: 'start' | 'end') => {
    const root = itemsRef.current
    if (!root) return false
    const el = root.querySelector<HTMLElement>(`[data-idx="${i}"]`)
    if (!el) return false
    const span = el.querySelector<HTMLElement>('.bullet-text')
    if (span) placeCaret(span, at)
    else el.focus()
    return true
  }

  const bulletRow = (b: BulletItem, i: number) => {
    const pendingAi = b.origin === 'ai' && b.status === 'pending'
    // Observer notes are kept/dismissed as a whole, so their bullets show no
    // per-line ✓/✕ and don't accept on click.
    const itemAccept = pendingAi && !isObserver
    const indent = b.indent ?? 0
    const next = note.items[i + 1]
    const hasIndentedChild = next && isBullet(next) && (next.indent ?? 0) > indent
    const style = indent ? ({ '--indent-offset': `${indent * 24}px` } as React.CSSProperties) : undefined
    return (
      <div key={b.id} data-idx={i} className={`bullet ${b.origin} ${b.status}`} style={style}>
        {/* Obsidian-style indentation guides: one vertical segment per ancestor
            level. A parent with children draws the first segment below its own
            dot; child rows only continue that thread through their own height. */}
        {hasIndentedChild && <span className="indent-guide indent-guide-parent" />}
        {indent > 0 && Array.from({ length: indent }, (_, lvl) => (
          <span
            key={`g${lvl}`}
            className="indent-guide"
            style={{ '--guide-offset': `${(lvl - indent) * 24}px` } as React.CSSProperties}
          />
        ))}
        <span className="dot">{indent ? '◦' : '•'}</span>
        <div className="bullet-body">
          <BulletText
            text={b.text}
            editing={b.editing}
            title={itemAccept ? tr('Click to accept & edit', '点击接受并编辑') : undefined}
            onInput={(t) => onBulletChange(b.id, t)}
            onEnter={() => onBulletEnter(b.id)}
            onBlur={() => onBulletBlur(b.id)}
            onClick={itemAccept ? () => onKeepBullet(b.id) : undefined}
            onNavigate={(dir) => focusIdx(dir === 'next' ? i + 1 : i - 1, dir === 'next' ? 'start' : 'end')}
            onEdgeDelete={(edge) => onEdgeDelete(i, edge)}
            onIndent={(delta) => onIndentBullet(b.id, delta)}
          />
          {/* Inline image: PART of the bullet — no controls of its own, it is
              kept/rejected with its text. Click = expand into the previewer
              (source url shown there). A broken src removes itself. */}
          {b.image && (
            <img
              className="bullet-img"
              src={b.image.src}
              alt=""
              title={tr('Click to expand', '点击展开')}
              draggable={false}
              onClick={(e) => onOpenImage({ ...b.image!, originRect: e.currentTarget.getBoundingClientRect() })}
              onError={(e) => { e.currentTarget.style.display = 'none' }}
            />
          )}
        </div>
        {itemAccept && (
          <span className="accept">
            <button className="ok" title={tr('Keep', '保留')} onClick={() => onKeepBullet(b.id)}>✓</button>
            <button className="no" title={tr('Reject', '拒绝')} onClick={() => onRejectBullet(b.id)}>✕</button>
          </span>
        )}
      </div>
    )
  }

  const cardRow = (c: CardItem, i: number) => (
    <div
      key={c.id}
      data-idx={i}
      tabIndex={0}
      className={`url-card ${c.status}`}
      onPointerDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault()
          onInsertAfter(c.id)
        } else if (e.key === 'ArrowDown' || e.key === 'ArrowRight') {
          if (focusIdx(i + 1, 'start')) e.preventDefault()
        } else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') {
          if (focusIdx(i - 1, 'end')) e.preventDefault()
        } else if (e.key === 'Backspace' || e.key === 'Delete') {
          // Delete the card line; don't let the canvas-level mass-delete see it.
          e.preventDefault()
          e.stopPropagation()
          focusIdx(i - 1, 'end')
          onRemoveCard(c.id)
        }
      }}
    >
      {/* no image → no image area; a broken image URL removes itself onError */}
      {c.image && (
        <img
          className="thumb"
          src={c.image}
          alt=""
          onError={(e) => { e.currentTarget.style.display = 'none' }}
        />
      )}
      <a
        className="meta"
        href={c.url}
        target="_blank"
        rel="noreferrer"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="t">{c.title}</div>
        <div className="d">{c.snippet || hostOf(c.url)}</div>
      </a>
      {c.status === 'pending' && !isObserver && (
        <div className="accept">
          <button className="ok" title={tr('Keep', '保留')} onClick={() => onKeepCard(c.id)}>✓</button>
          <button className="no" title={tr('Reject', '拒绝')} onClick={() => onRemoveCard(c.id)}>✕</button>
        </div>
      )}
    </div>
  )

  // An image the user dropped/pasted into the note: its own focusable line (like
  // a url card), so the caret navigates onto it, Enter opens a line after it,
  // and Backspace deletes just the image. Same picture style as an AI bullet's.
  const imageRow = (im: ImageItem, i: number) => (
    <div
      key={im.id}
      data-idx={i}
      tabIndex={0}
      className="note-image"
      onPointerDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault()
          onInsertAfter(im.id)
        } else if (e.key === 'ArrowDown' || e.key === 'ArrowRight') {
          if (focusIdx(i + 1, 'start')) e.preventDefault()
        } else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') {
          if (focusIdx(i - 1, 'end')) e.preventDefault()
        } else if (e.key === 'Backspace' || e.key === 'Delete') {
          // Delete just this image; don't let the canvas-level mass-delete see it.
          e.preventDefault()
          e.stopPropagation()
          focusIdx(i - 1, 'end')
          onRemoveImage(im.id)
        }
      }}
    >
      <img
        className="bullet-img"
        src={im.src}
        alt=""
        title={tr('Click to expand', '点击展开')}
        draggable={false}
        onClick={(e) => onOpenImage({ src: im.src, sourceUrl: im.sourceUrl, title: im.title, originRect: e.currentTarget.getBoundingClientRect() })}
        onError={(e) => { e.currentTarget.style.display = 'none' }}
      />
    </div>
  )

  return (
    <div
      ref={rootRef}
      className={`knote ${isObserver ? 'observer' : ''} ${selected ? 'selected' : ''} ${selectAllOn || dragSelOn ? 'select-all' : ''}`}
      data-noteid={note.id}
      style={{ left: note.x, top: note.y }}
      onPointerDown={onPointerDownNote}
      onContextMenu={onContextMenuNote}
      onKeyDown={onNoteKeyDown}
    >
      {/* Figma-style selection: rectangle border + square handles at the corners */}
      {selected && (
        <>
          <i className="handle tl" /><i className="handle tr" />
          <i className="handle bl" /><i className="handle br" />
        </>
      )}
      {/* keyword header — plain black text; fades to orange only while its
          transcript source phrase is hovered */}
      {/* Observer gray marks a note still awaiting judgment; once kept (✓) the
          header settles to black together with the body text. */}
      <div className={`kw-header ${isObserver && hasPending ? 'observer' : ''} ${hovered ? 'hovered' : ''}`}>
        {note.keywordEditing ? (
          <KeywordEditor value={note.keyword} onChange={onKeywordChange} onCommit={onKeywordCommit} />
        ) : (
          <span className="kw-text" title={tr('Click to edit', '点击编辑')} onClick={onKeywordEdit}>
            {note.keyword || 'untitled'}
          </span>
        )}
      </div>

      {/* one ordered flow: bullets and inline URL cards */}
      {/* onDoubleClick: a dbl-click word-selection is a selection too — report it. */}
      <div
        className="items"
        ref={itemsRef}
        onPointerDown={onItemsPointerDown}
        onDoubleClick={() => setTimeout(reportSelection, 0)}
      >
        {note.items.map((item, i) => (isBullet(item) ? bulletRow(item, i) : isImage(item) ? imageRow(item, i) : cardRow(item, i)))}
      </div>

      {/* Observer note: one keep/dismiss control for the whole note, bottom-right.
          stopPropagation so a click doesn't start a note drag. */}
      {isObserver && hasPending && (
        <div className="note-accept" onPointerDown={(e) => e.stopPropagation()}>
          <button className="ok" title={tr('Keep this note', '保留此笔记')} onClick={onKeepNote}>✓</button>
          <button className="no" title={tr('Dismiss this note', '忽略此笔记')} onClick={onRejectNote}>✕</button>
        </div>
      )}
    </div>
  )
}
