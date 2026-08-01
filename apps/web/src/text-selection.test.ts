import { describe, expect, it } from 'vitest'
import type { BulletItem, NoteItem } from './canvas-types'
import { buildTextSelectionSnapshot } from './text-selection'

const bullet = (id: string, text: string): BulletItem => ({
  kind: 'bullet',
  id,
  text,
  origin: 'human',
  status: 'kept'
})

describe('buildTextSelectionSnapshot', () => {
  it('captures every text line between drag endpoints as one selection', () => {
    const items: NoteItem[] = [
      bullet('b1', 'first line'),
      bullet('b2', 'second line'),
      bullet('b3', 'third line')
    ]
    const snapshot = buildTextSelectionSnapshot(
      'n1',
      items,
      { idx: 0, off: 6 },
      { idx: 2, off: 5 },
      (idx) => ({ top: 20 + idx * 24, left: 100, width: 80, height: 18 })
    )

    expect(snapshot?.selectedText).toBe('line\nsecond line\nthird')
    expect(snapshot?.segments).toEqual([
      { itemId: 'b1', start: 6, end: 10, textAtCapture: 'first line' },
      { itemId: 'b2', start: 0, end: 11, textAtCapture: 'second line' },
      { itemId: 'b3', start: 0, end: 5, textAtCapture: 'third line' }
    ])
    expect(snapshot?.screenRect).toEqual({ top: 20, left: 100, width: 80, height: 66 })
  })

  it('normalizes a backwards drag', () => {
    const items: NoteItem[] = [bullet('b1', 'alpha'), bullet('b2', 'bravo')]
    const snapshot = buildTextSelectionSnapshot(
      'n1',
      items,
      { idx: 1, off: 4 },
      { idx: 0, off: 2 },
      (idx) => ({ top: idx * 20, left: 0, width: 30, height: 16 })
    )

    expect(snapshot?.selectedText).toBe('pha\nbrav')
    expect(snapshot?.segments.map(({ itemId, start, end }) => ({ itemId, start, end }))).toEqual([
      { itemId: 'b1', start: 2, end: 5 },
      { itemId: 'b2', start: 0, end: 4 }
    ])
  })
})
