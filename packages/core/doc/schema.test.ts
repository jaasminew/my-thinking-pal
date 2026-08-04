import { describe, it, expect } from 'vitest'
import * as Y from 'yjs'
import { noteToY, yToNote, itemToY, yToItem, canvasImageToY, yToCanvasImage, patchYMap, type PlainNote, type PlainItem } from './schema'

const fullNote: PlainNote = {
  id: 'n1',
  x: 10,
  y: 20,
  keyword: 'Storage',
  kept: ['a'],
  rejected: ['b'],
  lastFiredWords: 42,
  originTs: 1234,
  sourceText: 'modular blocks',
  originSignalType: 'decision',
  items: [
    { kind: 'bullet', id: 'b1', origin: 'human', text: 'top', status: 'kept', indent: 0, bulleted: true, runs: [{ start: 0, end: 3, weight: 700 }] },
    {
      kind: 'bullet',
      id: 'b2',
      origin: 'ai',
      text: 'child',
      status: 'pending',
      fireId: 'f1',
      fireLine: 0,
      diagnosis: 'needs case',
      indent: 1,
      image: { src: 'https://x/i.png', sourceUrl: 'https://x', title: 'X', w: 260, offsetX: -20, offsetY: -10 }
    },
    { kind: 'card', id: 'c1', title: 'Notion', url: 'https://notion.so', snippet: 's', image: 'https://img', origin: 'ai', status: 'pending', diagnosis: 'd' },
    { kind: 'image', id: 'i1', src: 'data:video/mp4;base64,...', mediaType: 'video', sourceUrl: 'https://y', title: 'clip', w: 220, offsetX: 4, offsetY: -8, origin: 'human', status: 'kept' }
  ]
}

// Put a Y type into a real doc so nested structures integrate.
function inDoc<T extends Y.AbstractType<any>>(build: () => T): T {
  const doc = new Y.Doc()
  const t = build()
  doc.getMap('root').set('v', t as any)
  return t
}

describe('schema round-trip', () => {
  it('preserves every persisted note field, including nested items', () => {
    const y = inDoc(() => noteToY(fullNote))
    expect(yToNote(y)).toEqual(fullNote)
  })

  it('drops transient UI flags on the way in', () => {
    const dirty = { ...fullNote, keywordEditing: true, aiRunning: true, items: [{ ...fullNote.items[0], editing: true }] }
    const y = inDoc(() => noteToY(dirty as any))
    const back = yToNote(y) as any
    expect(back.keywordEditing).toBeUndefined()
    expect(back.aiRunning).toBeUndefined()
    expect(back.items[0].editing).toBeUndefined()
  })

  it('round-trips each item kind', () => {
    for (const it of fullNote.items) {
      const y = inDoc(() => itemToY(it))
      expect(yToItem(y)).toEqual(it)
    }
  })

  it('round-trips a canvas image and defaults missing numeric fields', () => {
    const img = { id: 'g1', x: 1, y: 2, src: 'data:image/gif;base64,...', mediaType: 'gif' as const, w: 300, url: 'https://example.com' }
    const y = inDoc(() => canvasImageToY(img))
    expect(yToCanvasImage(y)).toEqual(img)
  })

  it('yToNote fills defaults for a bare map', () => {
    const doc = new Y.Doc()
    const m = doc.getMap('n') as Y.Map<unknown>
    m.set('id', 'x')
    expect(yToNote(m)).toEqual({ id: 'x', x: 0, y: 0, keyword: '', items: [], kept: [], rejected: [], lastFiredWords: 0 })
  })
})

describe('patchYMap', () => {
  it('sets provided keys and deletes undefined ones without touching siblings', () => {
    const doc = new Y.Doc()
    const m = doc.getMap('m') as Y.Map<unknown>
    m.set('a', 1)
    m.set('b', 2)
    patchYMap(m, { a: 9, b: undefined, c: 3 })
    expect(m.get('a')).toBe(9)
    expect(m.has('b')).toBe(false)
    expect(m.get('c')).toBe(3)
  })
})
