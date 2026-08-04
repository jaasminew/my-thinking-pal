import * as Y from 'yjs'

// CRDT-facing "content" model: the persisted shape of a board, WITHOUT the
// transient UI flags the frontend layers on top (keywordEditing / aiRunning /
// item.editing). The frontend's KeywordNote is structurally a superset — extra
// UI flags are simply dropped on the way in and defaulted on the way out — so
// packages/core never imports from the app.

export type Origin = 'human' | 'ai'
export type ItemStatus = 'pending' | 'kept'

export interface PlainBullet {
  kind: 'bullet'
  id: string
  origin: Origin
  text: string
  status: ItemStatus
  fireId?: string
  fireLine?: number
  diagnosis?: string
  image?: { src: string; sourceUrl?: string; title?: string; w?: number; offsetX?: number; offsetY?: number }
  indent?: number
  bulleted?: boolean
  runs?: Array<{
    start: number
    end: number
    color?: string
    size?: number
    weight?: 400 | 600 | 700
  }>
}

export interface PlainCard {
  kind: 'card'
  id: string
  title: string
  url: string
  snippet?: string
  image?: string
  origin: Origin
  status: ItemStatus
  diagnosis?: string
}

export interface PlainImage {
  kind: 'image'
  id: string
  src: string
  sourceUrl?: string
  title?: string
  w?: number
  offsetX?: number
  offsetY?: number
  origin: Origin
  status: ItemStatus
}

export type PlainItem = PlainBullet | PlainCard | PlainImage

export interface PlainNote {
  id: string
  x: number
  y: number
  keyword: string
  items: PlainItem[]
  kept: string[]
  rejected: string[]
  lastFiredWords: number
  originTs?: number
  sourceText?: string
  originSignalType?: string
}

export interface PlainCanvasImage {
  id: string
  x: number
  y: number
  src: string
  w?: number
  url?: string
}

export interface BoardContent {
  notes: PlainNote[]
  images: PlainCanvasImage[]
}

// UI-only keys that must never enter the CRDT (they're per-session render state,
// not shared content). Stripped on write, defaulted on read by the frontend.
const UI_NOTE_KEYS = new Set(['keywordEditing', 'aiRunning'])
const UI_ITEM_KEYS = new Set(['editing'])

// Detach a JSON-serializable value so it doesn't alias app state once in the doc.
const clone = <T>(v: T): T => (v == null ? v : (JSON.parse(JSON.stringify(v)) as T))

function plainToYMap(obj: Record<string, unknown>, skip: Set<string>): Y.Map<unknown> {
  const m = new Y.Map<unknown>()
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || skip.has(k)) continue
    m.set(k, clone(v))
  }
  return m
}

function yMapToPlain(m: Y.Map<unknown>): Record<string, unknown> {
  const o: Record<string, unknown> = {}
  m.forEach((v, k) => {
    o[k] = v
  })
  return o
}

export function itemToY(item: PlainItem): Y.Map<unknown> {
  return plainToYMap(item as unknown as Record<string, unknown>, UI_ITEM_KEYS)
}

export function yToItem(m: Y.Map<unknown>): PlainItem {
  return yMapToPlain(m) as unknown as PlainItem
}

export function noteToY(note: PlainNote): Y.Map<unknown> {
  const m = plainToYMap(note as unknown as Record<string, unknown>, new Set([...UI_NOTE_KEYS, 'items']))
  const items = new Y.Array<Y.Map<unknown>>()
  items.push((note.items ?? []).map(itemToY))
  m.set('items', items)
  return m
}

export function yToNote(m: Y.Map<unknown>): PlainNote {
  const items = m.get('items') as Y.Array<Y.Map<unknown>> | undefined
  const base = yMapToPlain(m)
  return {
    id: String(base.id ?? ''),
    x: typeof base.x === 'number' ? base.x : 0,
    y: typeof base.y === 'number' ? base.y : 0,
    keyword: typeof base.keyword === 'string' ? base.keyword : '',
    items: items ? items.map(yToItem) : [],
    kept: Array.isArray(base.kept) ? (base.kept as string[]) : [],
    rejected: Array.isArray(base.rejected) ? (base.rejected as string[]) : [],
    lastFiredWords: typeof base.lastFiredWords === 'number' ? base.lastFiredWords : 0,
    originTs: typeof base.originTs === 'number' ? base.originTs : undefined,
    sourceText: typeof base.sourceText === 'string' ? base.sourceText : undefined,
    originSignalType: typeof base.originSignalType === 'string' ? base.originSignalType : undefined
  }
}

export function canvasImageToY(img: PlainCanvasImage): Y.Map<unknown> {
  return plainToYMap(img as unknown as Record<string, unknown>, new Set())
}

export function yToCanvasImage(m: Y.Map<unknown>): PlainCanvasImage {
  const o = yMapToPlain(m)
  return {
    id: String(o.id ?? ''),
    x: typeof o.x === 'number' ? o.x : 0,
    y: typeof o.y === 'number' ? o.y : 0,
    src: typeof o.src === 'string' ? o.src : '',
    w: typeof o.w === 'number' ? o.w : undefined,
    url: typeof o.url === 'string' ? o.url : undefined
  }
}

// Set only the provided keys (undefined → delete), leaving other CRDT fields
// untouched so concurrent edits to sibling fields don't clobber each other.
export function patchYMap(m: Y.Map<unknown>, patch: Record<string, unknown>, skip: Set<string> = new Set()): void {
  for (const [k, v] of Object.entries(patch)) {
    if (skip.has(k)) continue
    if (v === undefined) m.delete(k)
    else m.set(k, clone(v))
  }
}
