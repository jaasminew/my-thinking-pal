import { describe, it, expect } from 'vitest'
import { hydrateNotes, boardDocId } from './board-persistence'
import type { PlainNote } from '../../../packages/core/doc'

describe('hydrateNotes', () => {
  it('resets transient flags and prunes empty bullets / empty notes', () => {
    const plain: PlainNote[] = [
      {
        id: 'n1',
        x: 0,
        y: 0,
        keyword: 'Keep',
        kept: [],
        rejected: [],
        lastFiredWords: 0,
        items: [
          { kind: 'bullet', id: 'b1', origin: 'human', text: 'real', status: 'kept' },
          { kind: 'bullet', id: 'b2', origin: 'ai', text: '   ', status: 'pending' }
        ]
      },
      { id: 'empty', x: 0, y: 0, keyword: '   ', kept: [], rejected: [], lastFiredWords: 0, items: [] }
    ]
    const out = hydrateNotes(plain)
    expect(out).toHaveLength(1)
    expect(out[0].keywordEditing).toBe(false)
    expect(out[0].aiRunning).toBe(false)
    expect(out[0].items.map((i) => i.id)).toEqual(['b1'])
    expect((out[0].items[0] as any).editing).toBe(false)
  })
})

describe('boardDocId', () => {
  it('maps the default space and named spaces to stable ids', () => {
    expect(boardDocId('')).toBe('default')
    expect(boardDocId('.abc123')).toBe('abc123')
  })
})
