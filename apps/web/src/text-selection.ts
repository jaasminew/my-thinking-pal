import { isBullet, type NoteItem } from './canvas-types'
import type { SelectionSnapshot } from './command-session'

export type TextSelectionEndpoint = {
  idx: number
  off: number
}

type SelectionRect = {
  top: number
  left: number
  width: number
  height: number
}

const clamp = (value: number, max: number) => Math.max(0, Math.min(value, max))

/**
 * Builds a frozen selection without relying on a native Range spanning several
 * contentEditable roots (Chromium confines that Range to the first root).
 */
export function buildTextSelectionSnapshot(
  noteId: string,
  items: NoteItem[],
  anchor: TextSelectionEndpoint,
  focus: TextSelectionEndpoint,
  rectForSegment: (idx: number, start: number, end: number) => SelectionRect | null
): SelectionSnapshot | null {
  const anchorBeforeFocus = anchor.idx < focus.idx || (anchor.idx === focus.idx && anchor.off <= focus.off)
  const start = anchorBeforeFocus ? anchor : focus
  const end = anchorBeforeFocus ? focus : anchor
  const segments: SelectionSnapshot['segments'] = []
  const text: string[] = []
  const rects: SelectionRect[] = []

  for (let idx = start.idx; idx <= end.idx; idx++) {
    const item = items[idx]
    if (!item || !isBullet(item)) continue
    const from = clamp(idx === start.idx ? start.off : 0, item.text.length)
    const to = clamp(idx === end.idx ? end.off : item.text.length, item.text.length)
    if (to <= from) continue
    segments.push({ itemId: item.id, start: from, end: to, textAtCapture: item.text })
    text.push(item.text.slice(from, to))
    const rect = rectForSegment(idx, from, to)
    if (rect && (rect.width || rect.height)) rects.push(rect)
  }

  const selectedText = text.join('\n')
  if (!segments.length || !selectedText.trim() || !rects.length) return null
  const left = Math.min(...rects.map((rect) => rect.left))
  const top = Math.min(...rects.map((rect) => rect.top))
  const right = Math.max(...rects.map((rect) => rect.left + rect.width))
  const bottom = Math.max(...rects.map((rect) => rect.top + rect.height))

  return {
    noteId,
    selectedText,
    segments,
    screenRect: { top, left, width: right - left, height: bottom - top }
  }
}
