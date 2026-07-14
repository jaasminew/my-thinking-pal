// Deterministic, collision-safe placement for a new observer note.
//
// Given the existing note rects and an anchor point (typically the note that
// triggered the observer), finds a position for a new DEFAULT_NOTE_W ×
// DEFAULT_NOTE_H note. Candidates are tried in an expanding clockwise ring
// around the anchor; the first non-colliding position wins. When all rings
// are exhausted, the note drops below the bottom-most existing rect.
//
// Pure: no DOM, no app state, no randomness. Same inputs → same output.
// Observer note placement geometry.

// Contract §4 — geometry constants, exported so tests can reference them.
export const DEFAULT_NOTE_W = 260
export const DEFAULT_NOTE_H = 160
export const PLACEMENT_STEP = 40
export const PLACEMENT_MARGIN = 24
export const PLACEMENT_MAX_RING = 6

export interface PlacedRect {
  x: number
  y: number
  w: number
  h: number
}

// The four cardinal directions, ordered clockwise starting from right (3
// o'clock). In screen coordinates y increases downward, so "clockwise" goes
// right → bottom → left → top.
const RING_DIRECTIONS = [
  { dx: 1, dy: 0 }, // right
  { dx: 0, dy: 1 }, // bottom
  { dx: -1, dy: 0 }, // left
  { dx: 0, dy: -1 } // top
] as const

// Check whether a candidate rect at (cx, cy) with size (cw, ch) overlaps any
// existing rect, expanding each existing rect by PLACEMENT_MARGIN on every
// side. A rect PLACEMENT_MARGIN - 1 px away counts as overlap.
function collides(
  cx: number,
  cy: number,
  cw: number,
  ch: number,
  existing: PlacedRect[]
): boolean {
  const m = PLACEMENT_MARGIN
  for (const r of existing) {
    // Expand existing rect by margin on each side, then standard AABB overlap.
    if (
      cx < r.x + r.w + m &&
      r.x - m < cx + cw &&
      cy < r.y + r.h + m &&
      r.y - m < cy + ch
    ) {
      return true
    }
  }
  return false
}

/**
 * Deterministic, collision-safe position for a new observer note.
 * Assume the new note is DEFAULT_NOTE_W x DEFAULT_NOTE_H. Try candidate
 * positions in an expanding clockwise ring around `anchor` (step
 * PLACEMENT_STEP, starting right of the anchor); return the first whose
 * rect overlaps no existing rect (with PLACEMENT_MARGIN padding). If none
 * within PLACEMENT_MAX_RING rings, place below the bottom-most existing
 * rect, left-aligned to anchor.x.
 */
export function placeObserverNote(
  existing: PlacedRect[],
  anchor: { x: number; y: number }
): { x: number; y: number } {
  // Try each ring (1..MAX_RING), each direction clockwise from right.
  for (let ring = 1; ring <= PLACEMENT_MAX_RING; ring++) {
    for (const dir of RING_DIRECTIONS) {
      const x = anchor.x + dir.dx * ring * PLACEMENT_STEP
      const y = anchor.y + dir.dy * ring * PLACEMENT_STEP
      if (!collides(x, y, DEFAULT_NOTE_W, DEFAULT_NOTE_H, existing)) {
        return { x, y }
      }
    }
  }

  // Fallback: below the bottom-most existing rect, left-aligned to anchor.x.
  if (existing.length === 0) {
    // Shouldn't happen (empty canvas → ring 1 succeeds), but stay defensive.
    return { x: anchor.x + PLACEMENT_STEP, y: anchor.y }
  }
  const bottomMost = Math.max(...existing.map((r) => r.y + r.h))
  return { x: anchor.x, y: bottomMost + PLACEMENT_MARGIN }
}
