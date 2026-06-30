// A free-floating "keyword note" on the canvas. Internally an outline: a keyword
// header, a list of bullets (human first, then AI), and AI-found URL cards.
// The whole note is draggable and drops anywhere.
export type Origin = 'human' | 'ai'

export interface Bullet {
  id: string
  origin: Origin
  text: string
  status: 'pending' | 'kept' // pending = AI awaiting ✓/✕; kept = settled (human is always kept)
  editing?: boolean // currently being edited inline (click-to-edit); orthogonal to status
  fireId?: string // which AI increment produced this bullet (for append-not-replace)
}

export interface Card {
  id: string
  title: string
  url: string
  snippet?: string
  image?: string
  status: 'pending' | 'kept'
}

export interface KeywordNote {
  id: string
  x: number
  y: number
  keyword: string
  keywordEditing: boolean
  bullets: Bullet[]
  cards: Card[]
  aiRunning: boolean
  // Reaction memory + the human word count at which the AI last fired.
  kept: string[]
  rejected: string[]
  lastFiredWords: number
}

let _id = 0
export const uid = (p: string) => `${p}${++_id}`
