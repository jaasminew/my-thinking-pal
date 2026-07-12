import { useEffect, useRef, useState } from 'react'
import type { SelectionSnapshot } from './command-session'
import { isImeEvent } from './ime'

// Floating AI command input, anchored just below the frozen selection rect.
// Viewport-space (position: fixed) — it lives OUTSIDE the scaled canvas layer,
// so pan/zoom transforms never distort it (the canvas dismisses it on any view
// change instead). Enter submits, Escape dismisses; click-outside dismissal is
// handled by the canvas via a document listener — this root only marks itself
// so that listener can recognize inside-clicks.
export function InlineCommandBubble({
  snapshot,
  onSubmit,
  onDismiss
}: {
  snapshot: SelectionSnapshot
  onSubmit: (command: string) => void
  onDismiss: () => void
}) {
  const [value, setValue] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  const submit = () => {
    const v = value.trim()
    if (!v) return
    onSubmit(v)
  }

  // Below the selection, clamped into the viewport (384px wide, see CSS).
  const W = 384
  const left = Math.max(8, Math.min(snapshot.screenRect.left, window.innerWidth - W - 8))
  const top = Math.min(snapshot.screenRect.top + snapshot.screenRect.height + 10, window.innerHeight - 64)

  return (
    <div
      className="cmd-bubble"
      style={{ left, top }}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <svg className="spark" viewBox="0 0 16 16" aria-hidden="true">
        <defs>
          <linearGradient id="cmd-spark-gradient" x1="0" y1="16" x2="16" y2="0" gradientUnits="userSpaceOnUse">
            <stop stopColor="var(--muted)" />
            <stop offset="1" stopColor="var(--ink-secondary)" />
          </linearGradient>
        </defs>
        <path fill="url(#cmd-spark-gradient)" d="M8 0c.48 4.13 1.87 5.52 6 6-4.13.48-5.52 1.87-6 6-.48-4.13-1.87-5.52-6-6 4.13-.48 5.52-1.87 6-6Z" />
      </svg>
      <input
        ref={inputRef}
        value={value}
        placeholder="Ask AI about this…"
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (isImeEvent(e)) return
          if (e.key === 'Enter') submit()
          else if (e.key === 'Escape') onDismiss()
        }}
      />
      <button className="send" title="Send" onClick={submit}>↑</button>
    </div>
  )
}
