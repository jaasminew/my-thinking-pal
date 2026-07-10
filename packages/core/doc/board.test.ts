import { describe, it, expect } from 'vitest'
import * as Y from 'yjs'
import { Board, openBoard } from './board'
import type { PlainNote } from './schema'

const note = (id: string, over: Partial<PlainNote> = {}): PlainNote => ({
  id,
  x: 0,
  y: 0,
  keyword: id,
  items: [],
  kept: [],
  rejected: [],
  lastFiredWords: 0,
  ...over
})

describe('Board bulk + projection', () => {
  it('starts empty and reports content back in order', () => {
    const b = openBoard('d1')
    expect(b.isEmpty()).toBe(true)
    b.setNotes([note('a'), note('b'), note('c')])
    expect(b.notes().map((n) => n.id)).toEqual(['a', 'b', 'c'])
    expect(b.isEmpty()).toBe(false)
  })

  it('replaceContent swaps notes + images atomically', () => {
    const b = openBoard('d1')
    b.setNotes([note('old')])
    b.replaceContent({ notes: [note('x')], images: [{ id: 'g1', x: 1, y: 1, src: 's' }] })
    expect(b.notes().map((n) => n.id)).toEqual(['x'])
    expect(b.images().map((g) => g.id)).toEqual(['g1'])
  })
})

describe('Board granular note ops', () => {
  it('upsertNote inserts then updates in place (preserving order)', () => {
    const b = openBoard('d1')
    b.setNotes([note('a'), note('b')])
    b.upsertNote(note('c', { keyword: 'C' }))
    expect(b.notes().map((n) => n.id)).toEqual(['a', 'b', 'c'])
    b.upsertNote(note('b', { keyword: 'B2', x: 99 }))
    expect(b.notes().map((n) => n.id)).toEqual(['a', 'b', 'c'])
    expect(b.notes()[1]).toMatchObject({ id: 'b', keyword: 'B2', x: 99 })
  })

  it('patchNote changes only given fields', () => {
    const b = openBoard('d1')
    b.setNotes([note('a', { keyword: 'A', x: 1, kept: ['k'] })])
    b.patchNote('a', { x: 50 })
    expect(b.notes()[0]).toMatchObject({ id: 'a', keyword: 'A', x: 50, kept: ['k'] })
  })

  it('removeNote deletes by id', () => {
    const b = openBoard('d1')
    b.setNotes([note('a'), note('b'), note('c')])
    b.removeNote('b')
    expect(b.notes().map((n) => n.id)).toEqual(['a', 'c'])
  })
})

describe('Board granular item ops', () => {
  const seed = () => {
    const b = openBoard('d1')
    b.setNotes([note('n', { items: [{ kind: 'bullet', id: 'b1', origin: 'human', text: 'one', status: 'kept' }] })])
    return b
  }

  it('appends, updates, and removes items', () => {
    const b = seed()
    b.appendItem('n', { kind: 'bullet', id: 'b2', origin: 'ai', text: 'two', status: 'pending' })
    expect(b.notes()[0].items.map((i) => i.id)).toEqual(['b1', 'b2'])

    b.updateItem('n', 'b2', { status: 'kept', text: 'two!' } as any)
    const it = b.notes()[0].items[1]
    expect(it).toMatchObject({ id: 'b2', status: 'kept', text: 'two!' })

    b.removeItem('n', 'b1')
    expect(b.notes()[0].items.map((i) => i.id)).toEqual(['b2'])
  })

  it('setItems replaces the whole ordered list', () => {
    const b = seed()
    b.setItems('n', [
      { kind: 'bullet', id: 'z', origin: 'ai', text: 'z', status: 'pending' },
      { kind: 'card', id: 'c', title: 't', url: 'https://u', origin: 'ai', status: 'pending' }
    ])
    expect(b.notes()[0].items.map((i) => i.id)).toEqual(['z', 'c'])
  })
})

describe('Board canvas images', () => {
  it('upserts and removes free-floating images', () => {
    const b = openBoard('d1')
    b.upsertImage({ id: 'g1', x: 0, y: 0, src: 's1' })
    b.upsertImage({ id: 'g1', x: 5, y: 6, src: 's1', w: 200 })
    expect(b.images()).toEqual([{ id: 'g1', x: 5, y: 6, src: 's1', w: 200 }])
    b.removeImage('g1')
    expect(b.images()).toEqual([])
  })
})

describe('Board transcript', () => {
  it('returns null until set, then round-trips frozen + tail', () => {
    const b = openBoard('d1')
    expect(b.getTranscript()).toBeNull()
    const frozen = [{ id: 's1', header: 'Intro', lines: [{ id: 'l1', ts: 1, text: 'hello' }] }]
    const tail = [{ id: 'l2', ts: 2, text: 'world' }]
    b.setTranscript(frozen, tail)
    expect(b.getTranscript()).toEqual({ frozen, tail })
  })

  it('detaches stored data from the caller (later mutation does not leak in)', () => {
    const b = openBoard('d1')
    const tail = [{ id: 'l1', ts: 1, text: 'a' }]
    b.setTranscript([], tail)
    tail[0].text = 'mutated'
    expect(b.getTranscript()?.tail).toEqual([{ id: 'l1', ts: 1, text: 'a' }])
  })

  it('syncs the transcript across two docs', () => {
    const docA = new Y.Doc()
    const docB = new Y.Doc()
    const a = openBoard('shared', { doc: docA })
    a.setTranscript([{ id: 's1', header: 'H', lines: [] }], [{ id: 'l1', ts: 9, text: 'x' }])
    Y.applyUpdate(docB, Y.encodeStateAsUpdate(docA))
    const b = openBoard('shared', { doc: docB })
    expect(b.getTranscript()).toEqual({
      frozen: [{ id: 's1', header: 'H', lines: [] }],
      tail: [{ id: 'l1', ts: 9, text: 'x' }]
    })
  })
})

describe('Board observe + CRDT sync', () => {
  it('observe fires on mutation and can be unsubscribed', () => {
    const b = openBoard('d1')
    let hits = 0
    const off = b.observe(() => hits++)
    b.setNotes([note('a')])
    expect(hits).toBeGreaterThan(0)
    const after = hits
    off()
    b.setNotes([note('b')])
    expect(hits).toBe(after)
  })

  it('merges concurrent field edits across two docs (no clobber)', () => {
    // Two peers sharing the SAME note; each edits a different field.
    const docA = new Y.Doc()
    const docB = new Y.Doc()
    const a = openBoard('shared', { doc: docA })
    a.setNotes([note('n', { keyword: 'seed', x: 0, y: 0 })])
    Y.applyUpdate(docB, Y.encodeStateAsUpdate(docA))
    const b = openBoard('shared', { doc: docB })

    a.patchNote('n', { x: 100 })
    b.patchNote('n', { y: 200 })
    // Exchange updates both ways.
    Y.applyUpdate(docB, Y.encodeStateAsUpdate(docA))
    Y.applyUpdate(docA, Y.encodeStateAsUpdate(docB))

    for (const board of [a, b]) {
      expect(board.notes()[0]).toMatchObject({ id: 'n', x: 100, y: 200, keyword: 'seed' })
    }
  })

  it('whenSynced awaits injected persistence', async () => {
    let resolved = false
    const b = openBoard('d1', {
      persistence: () => ({
        whenSynced: Promise.resolve().then(() => {
          resolved = true
        }),
        destroy: () => {}
      })
    })
    await b.whenSynced
    expect(resolved).toBe(true)
  })
})
