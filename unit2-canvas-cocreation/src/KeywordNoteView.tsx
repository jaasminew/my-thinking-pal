import { useEffect, useRef } from 'react'
import { isBullet, type BulletItem, type CardItem, type KeywordNote } from './canvas-types'

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

// Is the collapsed caret at the very first/last character of this element?
const caretAtEdge = (el: HTMLElement, edge: 'start' | 'end') => {
  const sel = window.getSelection()
  if (!sel || sel.rangeCount === 0 || !sel.isCollapsed) return false
  const r = sel.getRangeAt(0)
  const full = document.createRange()
  full.selectNodeContents(el)
  return edge === 'start'
    ? r.compareBoundaryPoints(Range.START_TO_START, full) <= 0
    : r.compareBoundaryPoints(Range.END_TO_END, full) >= 0
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
  onNavigate
}: {
  text: string
  editing?: boolean
  title?: string
  onInput: (text: string) => void
  onEnter: () => void
  onBlur: () => void
  onClick?: () => void
  onNavigate: (dir: 'prev' | 'next') => boolean
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
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      onEnter()
      return
    }
    const el = ref.current
    if (!el) return
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

// Renders one free-floating keyword note: keyword header → an ordered flow of
// bullets and inline URL cards. All data logic lives in App; focus/caret
// navigation between items is handled here in the DOM.
export function KeywordNoteView({
  note,
  selected,
  onPointerDownNote,
  onKeywordChange,
  onKeywordCommit,
  onBulletChange,
  onBulletEnter,
  onBulletBlur,
  onKeepBullet,
  onRejectBullet,
  onKeepCard,
  onRemoveCard,
  onInsertAfter
}: {
  note: KeywordNote
  selected: boolean
  onPointerDownNote: (e: React.PointerEvent) => void
  onKeywordChange: (text: string) => void
  onKeywordCommit: () => void
  onBulletChange: (bulletId: string, text: string) => void
  onBulletEnter: (bulletId: string) => void
  onBulletBlur: (bulletId: string) => void
  onKeepBullet: (bulletId: string) => void
  onRejectBullet: (bulletId: string) => void
  onKeepCard: (cardId: string) => void
  onRemoveCard: (cardId: string) => void
  onInsertAfter: (itemId: string) => void
}) {
  const itemsRef = useRef<HTMLDivElement>(null)

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
    return (
      <div key={b.id} data-idx={i} className={`bullet ${b.origin} ${b.status}`}>
        <span className="dot">•</span>
        <BulletText
          text={b.text}
          editing={b.editing}
          title={pendingAi ? 'Click to accept & edit' : undefined}
          onInput={(t) => onBulletChange(b.id, t)}
          onEnter={() => onBulletEnter(b.id)}
          onBlur={() => onBulletBlur(b.id)}
          onClick={pendingAi ? () => onKeepBullet(b.id) : undefined}
          onNavigate={(dir) => focusIdx(dir === 'next' ? i + 1 : i - 1, dir === 'next' ? 'start' : 'end')}
        />
        {pendingAi && (
          <span className="accept">
            <button className="ok" title="Keep" onClick={() => onKeepBullet(b.id)}>✓</button>
            <button className="no" title="Reject" onClick={() => onRejectBullet(b.id)}>✕</button>
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
      <div className="thumb" style={c.image ? { backgroundImage: `url(${c.image})` } : undefined} />
      <a
        className="meta"
        href={c.url}
        target="_blank"
        rel="noreferrer"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="t">{c.title}</div>
        <div className="d">{c.snippet || c.url}</div>
      </a>
      {c.status === 'pending' && (
        <div className="accept">
          <button className="ok" title="Keep" onClick={() => onKeepCard(c.id)}>✓</button>
          <button className="no" title="Reject" onClick={() => onRemoveCard(c.id)}>✕</button>
        </div>
      )}
    </div>
  )

  return (
    <div
      className={`knote ${selected ? 'selected' : ''}`}
      data-noteid={note.id}
      style={{ left: note.x, top: note.y }}
      onPointerDown={onPointerDownNote}
    >
      {/* keyword header (hand-circled in the design) */}
      <div className="kw-header">
        {note.keywordEditing ? (
          <input
            className="kw-input"
            autoFocus
            value={note.keyword}
            onChange={(e) => onKeywordChange(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); onKeywordCommit() } }}
            onBlur={onKeywordCommit}
          />
        ) : (
          <span className="kw-text">{note.keyword || 'untitled'}</span>
        )}
      </div>

      {/* one ordered flow: bullets and inline URL cards */}
      <div className="items" ref={itemsRef}>
        {note.items.map((item, i) => (isBullet(item) ? bulletRow(item, i) : cardRow(item, i)))}
      </div>
    </div>
  )
}
