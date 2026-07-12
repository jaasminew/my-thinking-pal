import { describe, it, expect } from 'vitest'
import {
  placeObserverNote,
  DEFAULT_NOTE_W,
  DEFAULT_NOTE_H,
  PLACEMENT_STEP,
  PLACEMENT_MARGIN,
  PLACEMENT_MAX_RING
} from './observer-placement'
import type { PlacedRect } from './observer-placement'

// ---- constants ------------------------------------------------------------

describe('exported constants', () => {
  it('exports the frozen geometry constants', () => {
    expect(DEFAULT_NOTE_W).toBe(260)
    expect(DEFAULT_NOTE_H).toBe(160)
    expect(PLACEMENT_STEP).toBe(40)
    expect(PLACEMENT_MARGIN).toBe(24)
    expect(PLACEMENT_MAX_RING).toBe(6)
  })
})

// ---- helpers --------------------------------------------------------------

const anchor = { x: 500, y: 300 }

function rect(x: number, y: number, w = DEFAULT_NOTE_W, h = DEFAULT_NOTE_H): PlacedRect {
  return { x, y, w, h }
}

// A tiny rect (10×10) placed inside a candidate's area but outside the
// expanded (margin-padded) area of adjacent candidates. Used to block one
// specific ring candidate without blocking its neighbours.
function block(x: number, y: number): PlacedRect {
  return { x, y, w: 10, h: 10 }
}

// ---- empty canvas ---------------------------------------------------------

describe('empty canvas', () => {
  it('returns the first candidate (right of anchor)', () => {
    const pos = placeObserverNote([], anchor)
    // Ring 1, right: anchor.x + step, anchor.y
    expect(pos).toEqual({ x: anchor.x + PLACEMENT_STEP, y: anchor.y })
  })
})

// ---- occupied first candidate → next position ----------------------------

describe('occupied first candidate', () => {
  it('a full-size note at the first candidate blocks it → next free ring position', () => {
    // Place a full 260×160 note at ring-1-right.
    const existing = [rect(anchor.x + PLACEMENT_STEP, anchor.y)]
    const pos = placeObserverNote(existing, anchor)
    // Should NOT be the first candidate.
    expect(pos).not.toEqual({ x: anchor.x + PLACEMENT_STEP, y: anchor.y })
    // Should be a valid ring candidate (deterministic).
    expect(pos).toEqual({ x: 500, y: 500 }) // ring 5, bottom
  })

  it('a small blocker on the first candidate → ring 1 bottom', () => {
    // Place a tiny 10×10 rect inside ring-1-right but outside the expanded
    // (margin-padded) area of ring-1-bottom/top. bx must be ≥ 784 so the
    // expanded left edge (bx-24 ≥ 760) clears bottom/top right edge (760).
    const existing = [block(790, anchor.y)] // (790, 300, 10, 10)
    const pos = placeObserverNote(existing, anchor)
    // Ring 1, bottom should be free.
    expect(pos).toEqual({ x: anchor.x, y: anchor.y + PLACEMENT_STEP })
  })
})

// ---- margin respected -----------------------------------------------------

describe('margin respected', () => {
  it('a rect PLACEMENT_MARGIN - 1 px away counts as overlap', () => {
    // Place an existing rect so the gap to ring-1-right is M-1 (23 px).
    const candidateX = anchor.x + PLACEMENT_STEP
    const gap = PLACEMENT_MARGIN - 1 // 23 px
    const existing = [rect(candidateX + DEFAULT_NOTE_W + gap, anchor.y, 50, 50)]
    const pos = placeObserverNote(existing, anchor)
    // ring-1-right should be blocked (gap < M) → not returned.
    expect(pos).not.toEqual({ x: candidateX, y: anchor.y })
  })

  it('a rect exactly PLACEMENT_MARGIN px away does NOT overlap', () => {
    // Gap of exactly M (24 px) → no collision → ring-1-right accepted.
    const candidateX = anchor.x + PLACEMENT_STEP
    const gap = PLACEMENT_MARGIN
    const existing = [rect(candidateX + DEFAULT_NOTE_W + gap, anchor.y, 50, 50)]
    const pos = placeObserverNote(existing, anchor)
    expect(pos).toEqual({ x: candidateX, y: anchor.y })
  })
})

// ---- dense cluster → fallback --------------------------------------------

describe('dense cluster exhausting all rings', () => {
  it('places below the bottom-most rect at anchor.x', () => {
    // Occupy ALL 24 ring candidate positions with full-size notes.
    const existing: PlacedRect[] = []
    for (let ring = 1; ring <= PLACEMENT_MAX_RING; ring++) {
      for (const dir of [
        { dx: 1, dy: 0 },
        { dx: 0, dy: 1 },
        { dx: -1, dy: 0 },
        { dx: 0, dy: -1 }
      ]) {
        existing.push(
          rect(
            anchor.x + dir.dx * ring * PLACEMENT_STEP,
            anchor.y + dir.dy * ring * PLACEMENT_STEP
          )
        )
      }
    }
    // Add a rect far below to set the bottom-most edge.
    const farBelow = rect(anchor.x, anchor.y + 1000, DEFAULT_NOTE_W, DEFAULT_NOTE_H)
    existing.push(farBelow)

    const pos = placeObserverNote(existing, anchor)
    const bottomMost = anchor.y + 1000 + DEFAULT_NOTE_H
    expect(pos).toEqual({ x: anchor.x, y: bottomMost + PLACEMENT_MARGIN })
  })
})

// ---- determinism ----------------------------------------------------------

describe('determinism', () => {
  it('same inputs → same output', () => {
    const existing = [
      rect(100, 100),
      rect(500, 200),
      rect(300, 400, 200, 100)
    ]
    const a = placeObserverNote(existing, anchor)
    const b = placeObserverNote(existing, anchor)
    expect(a).toEqual(b)
  })

  it('different anchor → different position', () => {
    const existing = [rect(anchor.x + PLACEMENT_STEP, anchor.y)]
    const pos1 = placeObserverNote(existing, { x: 500, y: 300 })
    const pos2 = placeObserverNote(existing, { x: 600, y: 300 })
    expect(pos1).not.toEqual(pos2)
  })
})

// ---- clockwise ordering ---------------------------------------------------

describe('clockwise order: right → bottom → left → top', () => {
  // Each blocker is a 10×10 rect whose margin-padded footprint (58×58) hits
  // ONLY its intended ring-1 candidate. Coordinates chosen so the expanded
  // area does not bleed into adjacent candidates.
  //
  // Ring-1 candidates (anchor 500,300, note 260×160):
  //   right:  [540,800] × [300,460]
  //   bottom: [500,760] × [340,500]
  //   left:   [460,720] × [300,460]
  //   top:    [500,760] × [260,420]

  // Right blocker (790,300): expanded [766,824]×[276,334].
  //   Hits right (540<824, 766<800). Misses bottom/top (766≥760 → no x-overlap).
  const BLOCK_RIGHT = block(790, 300)

  // Bottom blocker (750,450): expanded [726,784]×[426,484].
  //   Hits bottom (500<784, 726<760, 340<484, 426<500).
  //   Misses left (726≥720 → no x-overlap). Misses top (426≥420 → no y-overlap).
  const BLOCK_BOTTOM = block(750, 450)

  // Left blocker (440,400): expanded [416,474]×[376,434].
  //   Hits left (460<474, 416<720, 300<434, 376<460).
  //   Misses top/bottom/right (500≥474 → no x-overlap).
  const BLOCK_LEFT = block(440, 400)

  it('blocking right → bottom is returned', () => {
    const existing = [BLOCK_RIGHT]
    expect(placeObserverNote(existing, anchor)).toEqual({
      x: anchor.x,
      y: anchor.y + PLACEMENT_STEP
    })
  })

  it('blocking right + bottom → left is returned', () => {
    const existing = [BLOCK_RIGHT, BLOCK_BOTTOM]
    expect(placeObserverNote(existing, anchor)).toEqual({
      x: anchor.x - PLACEMENT_STEP,
      y: anchor.y
    })
  })

  it('blocking right + bottom + left → top is returned', () => {
    const existing = [BLOCK_RIGHT, BLOCK_BOTTOM, BLOCK_LEFT]
    expect(placeObserverNote(existing, anchor)).toEqual({
      x: anchor.x,
      y: anchor.y - PLACEMENT_STEP
    })
  })
})
