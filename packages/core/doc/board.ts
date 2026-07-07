import * as Y from 'yjs'
import {
  type BoardContent,
  type PlainCanvasImage,
  type PlainItem,
  type PlainNote,
  canvasImageToY,
  itemToY,
  noteToY,
  patchYMap,
  yToCanvasImage,
  yToItem,
  yToNote
} from './schema'

// A local-first persistence provider (e.g. y-indexeddb). Injected so the core is
// environment-free: tests run with no provider (pure in-memory Y.Doc); the
// browser passes an IndexedDB-backed one (see the app's board-persistence glue).
export interface BoardPersistence {
  whenSynced: Promise<unknown>
  destroy: () => void | Promise<void>
}

export interface OpenBoardOptions {
  /** Reuse an existing doc (tests, or a shared doc across boards). */
  doc?: Y.Doc
  /** Create the persistence provider bound to this doc. */
  persistence?: (doc: Y.Doc, docId: string) => BoardPersistence
}

// One board = one Y.Doc. Notes and canvas images are ORDERED (Y.Array of Y.Map),
// so the projection preserves the frontend's array semantics exactly (stacking /
// deterministic iteration); per-note/per-item fields merge concurrently. UI-only
// flags are excluded by the schema layer.
export class Board {
  readonly doc: Y.Doc
  readonly docId: string
  private readonly notesArr: Y.Array<Y.Map<unknown>>
  private readonly imagesArr: Y.Array<Y.Map<unknown>>
  private readonly meta: Y.Map<unknown>
  private readonly persistence?: BoardPersistence
  private readonly ownsDoc: boolean

  constructor(docId: string, opts: OpenBoardOptions = {}) {
    this.docId = docId
    this.ownsDoc = !opts.doc
    this.doc = opts.doc ?? new Y.Doc()
    this.notesArr = this.doc.getArray('notes')
    this.imagesArr = this.doc.getArray('images')
    this.meta = this.doc.getMap('meta')
    if (opts.persistence) this.persistence = opts.persistence(this.doc, docId)
  }

  /** Resolves once local persistence (if any) has loaded prior state. */
  get whenSynced(): Promise<unknown> {
    return this.persistence?.whenSynced ?? Promise.resolve()
  }

  isEmpty(): boolean {
    return this.notesArr.length === 0 && this.imagesArr.length === 0
  }

  // ---- projection (CRDT → plain) ----
  notes(): PlainNote[] {
    return this.notesArr.map(yToNote)
  }

  images(): PlainCanvasImage[] {
    return this.imagesArr.map(yToCanvasImage)
  }

  content(): BoardContent {
    return { notes: this.notes(), images: this.images() }
  }

  export(): BoardContent {
    return this.content()
  }

  // Re-project on ANY change (local or remote). Returns an unsubscribe fn.
  observe(cb: () => void): () => void {
    const handler = () => cb()
    this.doc.on('update', handler)
    return () => this.doc.off('update', handler)
  }

  private tx(fn: () => void) {
    this.doc.transact(fn, 'local')
  }

  private noteAt(id: string): { ymap: Y.Map<unknown>; index: number } | undefined {
    for (let i = 0; i < this.notesArr.length; i++) {
      const m = this.notesArr.get(i)
      if (m.get('id') === id) return { ymap: m, index: i }
    }
    return undefined
  }

  // ---- bulk (migration / import / coarse sync) ----
  setNotes(notes: PlainNote[]): void {
    this.tx(() => {
      if (this.notesArr.length) this.notesArr.delete(0, this.notesArr.length)
      this.notesArr.push(notes.map(noteToY))
    })
  }

  setImages(images: PlainCanvasImage[]): void {
    this.tx(() => {
      if (this.imagesArr.length) this.imagesArr.delete(0, this.imagesArr.length)
      this.imagesArr.push(images.map(canvasImageToY))
    })
  }

  replaceContent(content: BoardContent): void {
    this.tx(() => {
      if (this.notesArr.length) this.notesArr.delete(0, this.notesArr.length)
      if (this.imagesArr.length) this.imagesArr.delete(0, this.imagesArr.length)
      this.notesArr.push((content.notes ?? []).map(noteToY))
      this.imagesArr.push((content.images ?? []).map(canvasImageToY))
    })
  }

  import(content: BoardContent): void {
    this.replaceContent(content)
  }

  // ---- granular note ops ----
  upsertNote(note: PlainNote): void {
    this.tx(() => {
      const found = this.noteAt(note.id)
      if (found) {
        patchYMap(found.ymap, note as unknown as Record<string, unknown>, new Set(['items']))
        this.writeItems(found.ymap, note.items ?? [])
      } else {
        this.notesArr.push([noteToY(note)])
      }
    })
  }

  patchNote(id: string, patch: Partial<Omit<PlainNote, 'items'>>): void {
    this.tx(() => {
      const found = this.noteAt(id)
      if (found) patchYMap(found.ymap, patch as Record<string, unknown>, new Set(['items']))
    })
  }

  removeNote(id: string): void {
    this.tx(() => {
      const found = this.noteAt(id)
      if (found) this.notesArr.delete(found.index, 1)
    })
  }

  // ---- granular item ops ----
  private itemsOf(noteYMap: Y.Map<unknown>): Y.Array<Y.Map<unknown>> {
    let items = noteYMap.get('items') as Y.Array<Y.Map<unknown>> | undefined
    if (!items) {
      items = new Y.Array<Y.Map<unknown>>()
      noteYMap.set('items', items)
    }
    return items
  }

  private writeItems(noteYMap: Y.Map<unknown>, items: PlainItem[]): void {
    const arr = this.itemsOf(noteYMap)
    if (arr.length) arr.delete(0, arr.length)
    arr.push(items.map(itemToY))
  }

  setItems(noteId: string, items: PlainItem[]): void {
    this.tx(() => {
      const found = this.noteAt(noteId)
      if (found) this.writeItems(found.ymap, items)
    })
  }

  appendItem(noteId: string, item: PlainItem): void {
    this.tx(() => {
      const found = this.noteAt(noteId)
      if (found) this.itemsOf(found.ymap).push([itemToY(item)])
    })
  }

  updateItem(noteId: string, itemId: string, patch: Partial<PlainItem>): void {
    this.tx(() => {
      const found = this.noteAt(noteId)
      if (!found) return
      const items = this.itemsOf(found.ymap)
      for (let i = 0; i < items.length; i++) {
        const it = items.get(i)
        if (it.get('id') === itemId) {
          patchYMap(it, patch as Record<string, unknown>)
          return
        }
      }
    })
  }

  removeItem(noteId: string, itemId: string): void {
    this.tx(() => {
      const found = this.noteAt(noteId)
      if (!found) return
      const items = this.itemsOf(found.ymap)
      for (let i = 0; i < items.length; i++) {
        if (items.get(i).get('id') === itemId) {
          items.delete(i, 1)
          return
        }
      }
    })
  }

  // ---- canvas image ops ----
  private imageAt(id: string): { index: number } | undefined {
    for (let i = 0; i < this.imagesArr.length; i++) {
      if (this.imagesArr.get(i).get('id') === id) return { index: i }
    }
    return undefined
  }

  upsertImage(img: PlainCanvasImage): void {
    this.tx(() => {
      const found = this.imageAt(img.id)
      if (found) patchYMap(this.imagesArr.get(found.index), img as unknown as Record<string, unknown>)
      else this.imagesArr.push([canvasImageToY(img)])
    })
  }

  removeImage(id: string): void {
    this.tx(() => {
      const found = this.imageAt(id)
      if (found) this.imagesArr.delete(found.index, 1)
    })
  }

  async destroy(): Promise<void> {
    if (this.persistence) await this.persistence.destroy()
    if (this.ownsDoc) this.doc.destroy()
  }
}

export function openBoard(docId: string, opts: OpenBoardOptions = {}): Board {
  return new Board(docId, opts)
}
