// AiCursorOverlay — the single FigJam-style AI cursor rendered in screen
// space. Constant pixel size at any zoom; travels smoothly between notes on
// target change; pans/zooms instantly (no travel animation). Never interactive.
//
// Canvas overlay for the AI pal cursor.
import { useEffect, useRef, useState } from 'react'
import type { AiCursorState } from './ai-cursor-types'
import { AI_CURSOR_NAME } from './ai-cursor-types'
import './ai-cursor.css'

export interface AiCursorOverlayProps {
  state: AiCursorState
  view: { x: number; y: number; scale: number }
}

// Screen-px threshold: below this, snap; at/above, animate the travel.
const TRAVEL_THRESHOLD_PX = 24
const TRAVEL_MS = 600
const FADE_IN_MS = 200
const FADE_OUT_MS = 400

export function AiCursorOverlay(props: AiCursorOverlayProps): JSX.Element | null {
  const { state, view } = props
  const { target, label, visible } = state

  // When the cursor fades out fully, unmount the DOM (so it can't be hit).
  const [mounted, setMounted] = useState(false)

  // Fade management: mount when visible flips true, unmount after fade-out.
  useEffect(() => {
    if (visible) {
      setMounted(true)
    } else {
      const t = setTimeout(() => setMounted(false), FADE_OUT_MS)
      return () => clearTimeout(t)
    }
  }, [visible])

  // Travel vs snap must be decided DURING render — the transition has to be on
  // the element in the same commit that changes left/top, or the browser never
  // animates (deciding in an effect is one commit too late: the position moves
  // with transition:none, then the transition arrives after the teleport).
  // Default is transition ON; it's disabled exactly when:
  //  - only the view changed (pan/zoom must track instantly, never animate),
  //  - the cursor is (re)appearing (no travel from a stale ghost position),
  //  - the world move is below the snap threshold (a note growing a line).
  // A render where nothing changed (e.g. a label update mid-travel) keeps the
  // same transition + same left/top, so an in-flight travel is undisturbed.
  const prevRef = useRef<{
    view: { x: number; y: number; scale: number }
    visible: boolean
    target: { x: number; y: number } | null
  }>({ view, visible, target: null })
  const prev = prevRef.current
  const viewChanged =
    prev.view.x !== view.x || prev.view.y !== view.y || prev.view.scale !== view.scale
  const appearing = visible && !prev.visible
  let smallMove = false
  if (target && prev.target && (prev.target.x !== target.x || prev.target.y !== target.y)) {
    const dx = (target.x - prev.target.x) * view.scale
    const dy = (target.y - prev.target.y) * view.scale
    smallMove = Math.sqrt(dx * dx + dy * dy) < TRAVEL_THRESHOLD_PX
  }
  const firstPosition = !prev.target
  const snap = viewChanged || appearing || smallMove || firstPosition
  useEffect(() => {
    prevRef.current = { view, visible, target: target ? { x: target.x, y: target.y } : null }
  })

  if (!target || !mounted) return null

  const left = target.x * view.scale + view.x
  const top = target.y * view.scale + view.y

  return (
    <div
      className={`ai-cursor-overlay ${visible ? 'visible' : ''}`}
      style={{
        left: `${left}px`,
        top: `${top}px`,
        transition: snap
          ? 'none'
          : `left ${TRAVEL_MS}ms ease-in-out, top ${TRAVEL_MS}ms ease-in-out`
      }}
      data-testid="ai-cursor-overlay"
    >
      <svg
        className="ai-cursor-glyph"
        width="20"
        height="20"
        viewBox="0 0 20 20"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
      >
        {/* FigJam-style pointer: a plain kite shape, no tail/handle. Tip at (2,2). */}
        <path
          d="M2 2L17.5 8.8L10.6 10.6L8.8 17.5L2 2Z"
          fill="var(--accent)"
          stroke="white"
          strokeWidth="1"
          strokeLinejoin="round"
        />
      </svg>
      <span className="ai-cursor-pill">
        <span>{`${AI_CURSOR_NAME} · ${label}`}</span>
        {label === 'thinking' && (
          <span className="ai-cursor-thinking-dots" data-testid="ai-cursor-thinking-dots" aria-hidden="true">
            <span>.</span>
            <span className="ai-cursor-thinking-dot-2">.</span>
            <span className="ai-cursor-thinking-dot-3">.</span>
          </span>
        )}
      </span>
    </div>
  )
}
