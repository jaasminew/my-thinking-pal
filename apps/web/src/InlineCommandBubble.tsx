import { useEffect, useRef, useState } from 'react'
import { isImeEvent } from './ime'
import { useLocale } from './locale'

// Floating AI command input, anchored above contextual selections/images and
// below ordinary canvas-origin clicks.
// Viewport-space (position: fixed) — it lives OUTSIDE the scaled canvas layer,
// so pan/zoom transforms never distort it (the canvas dismisses it on any view
// change instead). Enter submits, Escape dismisses; click-outside dismissal is
// handled by the canvas via a document listener — this root only marks itself
// so that listener can recognize inside-clicks.
export function InlineCommandBubble({
  anchor,
  placement = 'below',
  placeholder,
  onSubmit,
  onDismiss
}: {
  anchor: { top: number; left: number; width: number; height: number }
  placement?: 'above' | 'below'
  placeholder: string
  onSubmit: (command: string) => void
  onDismiss: () => void
}) {
  const { tr } = useLocale()
  const [value, setValue] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  // Focus on open AND on reposition (a second right-click moves the mounted
  // bubble without remounting it). The 0-timeout retake matters for real right
  // clicks: contextmenu fires DURING mousedown, so the browser's mousedown
  // default focus action runs after this effect and would steal focus back.
  useEffect(() => {
    inputRef.current?.focus()
    const t = setTimeout(() => inputRef.current?.focus(), 0)
    return () => clearTimeout(t)
  }, [anchor.left, anchor.top])

  const submit = () => {
    const v = value.trim()
    if (!v) return
    onSubmit(v)
  }

  // Contextual bubbles occupy the toolbar's position above the source. Canvas
  // right-click bubbles retain their below-the-click placement.
  const W = 384
  const H = 46
  const preferredLeft = placement === 'above'
    ? anchor.left + anchor.width / 2 - W / 2
    : anchor.left
  const left = Math.max(8, Math.min(preferredLeft, window.innerWidth - W - 8))
  const below = Math.min(anchor.top + anchor.height + 10, window.innerHeight - H - 8)
  const above = anchor.top - H - 10
  const top = placement === 'above' && above >= 8 ? above : below

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
        placeholder={placeholder}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (isImeEvent(e)) return
          if (e.key === 'Enter') submit()
          else if (e.key === 'Escape') onDismiss()
        }}
      />
      <button className="send" title={tr('Send', '发送')} onClick={submit}>↑</button>
    </div>
  )
}
