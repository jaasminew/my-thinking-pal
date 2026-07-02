// A free-floating "keyword note" on the canvas. Internally an outline: a keyword
// header and ONE ordered sequence of items — text bullets and URL cards — so a
// card is an inline line in the flow (arrow keys walk onto it, Enter continues
// below it), not an appendix at the bottom. The whole note is draggable.
export type Origin = 'human' | 'ai'

export interface BulletItem {
  kind: 'bullet'
  id: string
  origin: Origin
  text: string
  status: 'pending' | 'kept' // pending = AI awaiting ✓/✕; kept = settled (human is always kept)
  editing?: boolean // "focus me": set on freshly created bullets; orthogonal to status
  fireId?: string // which AI increment produced this bullet (for append-not-replace)
}

export interface CardItem {
  kind: 'card'
  id: string
  title: string
  url: string
  snippet?: string
  image?: string
  origin: Origin // ai = found by a fire; human = URL typed/pasted into a bullet
  status: 'pending' | 'kept'
}

export type NoteItem = BulletItem | CardItem

export interface KeywordNote {
  id: string
  x: number
  y: number
  keyword: string
  keywordEditing: boolean
  items: NoteItem[]
  aiRunning: boolean
  // Reaction memory + the human word count at which the AI last fired.
  kept: string[]
  rejected: string[]
  lastFiredWords: number
}

export const isBullet = (i: NoteItem): i is BulletItem => i.kind === 'bullet'
export const isCard = (i: NoteItem): i is CardItem => i.kind === 'card'

let _id = 0
export const uid = (p: string) => `${p}${++_id}`
